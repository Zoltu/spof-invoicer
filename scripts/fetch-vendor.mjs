/**
 * The `bun run vendor` entry point: copy each pinned package's files into `vendor-src/`, from the pin-verified tarball when the run acquires one and from `node_modules` otherwise, guarded by the lock pins, the upstream cross-check, the manifest hash checks, and an entry guard on every path it reads or writes.
 * Importing it never acquires anything, so the tests read `SOURCES` and `expectedVendorFiles` from it.
 */

import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VENDOR_PINS, checkLockPins, pinFor, pinForIntegrity } from "./vendor-pins.mjs";
import {
	MANIFEST_FILE,
	compareManifest,
	hashTree,
	listFiles,
	parseManifest,
	readManifest,
	renderManifest,
	sha256,
} from "./vendor-manifest.mjs";
import {
	TARBALL_BYTE_CAP,
	extractTarballBytes,
	integrityOf,
	missingTarballMessage,
	resolveVerifiedTarball,
	tarballCacheDir,
} from "./vendor-tarball.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The packages `bun run vendor` copies, each from its pin-verified tarball when the run acquires one and from node_modules otherwise, with the files it vendors and the name each takes under vendor-src/. */
export const SOURCES = [
	{
		pkg: "pdf-lib",
		dir: "pdf-lib",
		files: [
			["dist/pdf-lib.esm.js", "pdf-lib.esm.js"],
			["dist/pdf-lib.esm.js.map", "pdf-lib.esm.js.map"],
			["LICENSE.md", "LICENSE.md"],
		],
	},
	{
		pkg: "@noble/hashes",
		dir: "noble-hashes",
		files: [
			["sha3.js", "sha3.js"],
			["sha2.js", "sha2.js"],
			["_md.js", "_md.js"],
			["utils.js", "utils.js"],
			["_u64.js", "_u64.js"],
			["LICENSE", "LICENSE"],
		],
	},
	{
		pkg: "@scure/base",
		dir: "scure-base",
		files: [
			["index.js", "index.js"],
			["LICENSE", "LICENSE"],
		],
	},
];

// Hand-written files that live in vendor-src/ but are never written by `vendor`: the .d.ts shims that sit beside the copied bundles, and our own consolidated third-party notices.
export const HAND_WRITTEN_FILES = [
	"noble-hashes/sha2.d.ts",
	"noble-hashes/sha3.d.ts",
	"noble-hashes/utils.d.ts",
	"pdf-lib/pdf-lib.esm.d.ts",
	"scure-base/index.d.ts",
	"THIRD-PARTY-NOTICES",
];

/** The most bytes a file this run reads may occupy; the vendored bundles and installed manifests it reads are a few megabytes at most, so a larger file at one of those paths is refused before it can be pulled into memory whole. */
export const SOURCE_FILE_BYTE_CAP = 64 * 1024 * 1024;

/** The `vendor-src/`-relative path of every file `SOURCES` acquires, as a set. */
const SOURCED_PATHS = new Set(SOURCES.flatMap(({ dir, files }) => files.map(([, name]) => `${dir}/${name}`)));

// A path the committed manifest does not list is new: writing it is a deliberate act that takes `--add-new` (to acquire a new SOURCES entry) or, when a copy already exists, the per-file overwrite guard's `--force`.
// The ambiguity this closes: an unlisted SOURCES path with no copy yet is indistinguishable from a manifest line deleted together with its vendored file, so a plain run must not silently bless `node_modules` bytes for it.
// The cross-check below still skips a SOURCES path vendor-src/ has no copy of yet — there are no vendored bytes to compare — but that skip decides only whether a missing copy is reported, never whether a path may be written.
/** True when `rel` is a SOURCES path the committed manifest does not list and vendor-src/ has no copy of yet, so the upstream cross-check has no vendored bytes to compare. */
export function hasNoVendoredCopy(rel, blessed, dir) {
	return blessed !== null && !blessed.has(rel) && SOURCED_PATHS.has(rel) && !existsSync(resolve(dir, rel));
}

/** Every path vendor-src/ is expected to hold: the vendored files, the hand-written shims and notices, and the manifest. */
export function expectedVendorFiles() {
	const expected = new Set([...HAND_WRITTEN_FILES, MANIFEST_FILE]);
	for (const source of SOURCES) {
		for (const [, name] of source.files) {
			expected.add(`${source.dir}/${name}`);
		}
	}
	return [...expected].sort();
}

// The pinned integrity lives in scripts/vendor-pins.mjs and is checked against bun.lock before any file is copied, so the provenance chain starts at the lockfile rather than at node_modules.
/** The divergences between the pins in scripts/vendor-pins.mjs and what bun.lock records, so a spoofed lockfile is caught before any copy. */
export async function assertAcquisitionPins() {
	const lockPath = resolve(root, "bun.lock");
	const stats = statOrNull(lockPath);
	if (stats === null) {
		return ["bun.lock is missing — run `bun install` first"];
	}
	const guarded = readGuardProblem(stats, "bun.lock");
	if (guarded !== null) {
		return [`${guarded} — reinstall with \`bun install\` first, or remove the entry by hand`];
	}
	return checkLockPins(await readFile(lockPath, "utf8"));
}

async function blessedManifest(dir = resolve(root, "vendor-src")) {
	const bytes = await readManifest(dir);
	return bytes === null ? null : parseManifest(bytes.toString("utf8"));
}

// The installed tree is consulted only for a package no verified tarball anchors, and its version must equal the pin before its bytes may be compared or copied.
// One owner states that rule so the upstream cross-check and the copy loop report a missing or upgraded node_modules tree the same way.
// A corrupt or hostile package.json is a refusal like any other malformed input rather than a raw SyntaxError, TypeError or EISDIR out of the read and the parse: `stat` follows a symlinked package.json — a layout bun and pnpm both produce — while a directory, a FIFO or a file over the read cap is refused by name before it can abort, block or overload the read.
async function installedTreeProblem(sourceRoot, pkg, pin) {
	const manifest = resolve(sourceRoot, "node_modules", pkg, "package.json");
	const stats = statOrNull(manifest);
	if (stats === null) {
		return `node_modules/${pkg} is not installed — run \`bun install\` first`;
	}
	const guarded = readGuardProblem(stats, `node_modules/${pkg}/package.json`);
	if (guarded !== null) {
		return `${guarded} — reinstall with \`bun install\` first, or remove the entry by hand`;
	}
	let declared;
	try {
		declared = JSON.parse(await readFile(manifest, "utf8"));
	} catch (error) {
		return `node_modules/${pkg}/package.json is not valid JSON (${error.message}) — reinstall with \`bun install\` first`;
	}
	if (typeof declared?.version !== "string") {
		return `node_modules/${pkg}/package.json declares no version string — reinstall with \`bun install\` first`;
	}
	return declared.version === pin.version ? null : `node_modules/${pkg} is version ${declared.version}, pinned ${pin.version}`;
}

// `--tarball <path>` and `--tarball=<path>` are both accepted, and either may repeat: every path is offered to every pin, and the vendored package whose tarball sha512 it matches is the one that reads it.
// A bare `--tarball` with no path, and an empty `--tarball=`, are refused rather than silently ignored.
function tarballArgs(argv) {
	const paths = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg.startsWith("--tarball=")) {
			const value = arg.slice("--tarball=".length);
			if (value === "") throw new Error("vendor: --tarball takes the path of a pinned package tarball");
			paths.push(value);
			continue;
		}
		if (arg !== "--tarball") continue;
		const value = argv[index + 1];
		if (value === undefined || value.startsWith("--")) {
			throw new Error("vendor: --tarball takes the path of a pinned package tarball");
		}
		paths.push(value);
		index += 1;
	}
	return paths;
}

/**
 * Assign each `--tarball` path to the vendored package whose pinned tarball sha512 it matches, keyed by package name and carrying the bytes already read so a caller need not re-read the file.
 * This module owns the whole `--tarball` surface — `tarballArgs` reads the raw paths and this decides which vendored package each names — so the mapping never has to trust a pin table that disagrees with `SOURCES`.
 * A path that is not a regular file, exceeds the tarball byte cap, matches no pin, names a pinned package no `SOURCES` entry vendors (so it could never be read), or is a second path for a package already assigned is refused by name rather than ignored.
 */
export function assignTarballs(paths) {
	const assigned = new Map();
	for (const path of paths) {
		if (!existsSync(path)) throw new Error(`vendor: --tarball ${path} does not exist`);
		const stats = statSync(path);
		if (!stats.isFile()) throw new Error(`vendor: --tarball ${path} is not a regular file — pass the path of a pinned package tarball`);
		if (stats.size > TARBALL_BYTE_CAP) {
			throw new Error(`vendor: --tarball ${path} is ${stats.size} bytes, over the ${TARBALL_BYTE_CAP}-byte cap for a pinned package tarball — refusing to read it`);
		}
		const bytes = readFileSync(path);
		const pin = pinForIntegrity(integrityOf(bytes));
		if (pin === undefined) {
			const known = VENDOR_PINS.map(({ name, version }) => `${name}@${version}`).join(", ");
			throw new Error(`vendor: --tarball ${path} matches none of the pinned tarball sha512s (${known}) — refusing it`);
		}
		if (!SOURCES.some(({ pkg }) => pkg === pin.name)) {
			throw new Error(`vendor: --tarball ${path} matches the pinned ${pin.name}@${pin.version}, which no SOURCES entry vendors — refusing it`);
		}
		if (assigned.has(pin.name)) {
			throw new Error(`vendor: --tarball ${path} matches the same pin as ${assigned.get(pin.name).path} (${pin.name}@${pin.version}) — pass one tarball per package`);
		}
		assigned.set(pin.name, { path, bytes });
	}
	return assigned;
}

/**
 * The `bun run vendor` CLI options read from `argv`: the three boolean overrides and every `--tarball <path>` path.
 * One object holds the whole surface so a caller — a test included — can exercise the flag interactions without spawning the script.
 */
export function parseVendorOptions(argv) {
	return {
		force: argv.includes("--force"),
		allowUpstreamDrift: argv.includes("--allow-upstream-drift"),
		addNew: argv.includes("--add-new"),
		tarballs: tarballArgs(argv),
	};
}

// The extracted file map for a resolution, or null when no tarball was resolved.
function trustedSource(resolved) {
	return resolved === null ? null : { files: extractTarballBytes(resolved.bytes, resolved.path) };
}

/**
 * Resolve the packages a run reads from a verified tarball: the bytes each `--tarball` path carried, plus each package `acquire` names looked up in the tarball cache; every other package resolves to `null` and reads the installed tree under the repository root.
 * Resolution is acquisition-only: only a package this run actually acquires is looked up, so a routine run reads no tarball and its outcome cannot turn on machine-global `~/.bun/install/cache` state, while `--tarball` stays an explicit, pin-verified source that anchors the cross-check.
 * `upstreamProblems` and `vendor` both read this one map, so the cross-check and the copy loop cannot resolve a package against different bytes.
 */
export function resolveTrustedSources({ tarballs = new Map(), acquire = new Set(), cacheDir = tarballCacheDir() } = {}) {
	const byPackage = new Map();
	for (const source of SOURCES) {
		const carried = tarballs.get(source.pkg);
		const wanted = carried !== undefined || acquire.has(source.pkg);
		byPackage.set(source.pkg, wanted ? trustedSource(resolveVerifiedTarball(source.pkg, { carried, cacheDir })) : null);
	}
	return { cacheDir, root, byPackage };
}

// One SOURCES file's trusted bytes, or null when the trusted source does not hold that path.
// The installed copy is read only through the guard family — a directory, a FIFO, a socket, a device or a file over the read cap planted at it is refused by name instead of aborting the read, blocking on it or reading it whole — and the tarball side is already bounded by the archive's own caps.
async function trustedBytes(trusted, source, from) {
	const resolved = trusted.byPackage.get(source.pkg);
	if (resolved !== null) return resolved.files.get(from) ?? null;
	const installed = resolve(trusted.root, "node_modules", source.pkg, from);
	const stats = statOrNull(installed);
	const guarded = readGuardProblem(stats, `node_modules/${source.pkg}/${from}`);
	if (guarded !== null) {
		throw new Error(`vendor: ${guarded} — reinstall with \`bun install\` first, or remove the entry by hand`);
	}
	return stats === null ? null : readFile(installed);
}

/** The guard decisions for one SOURCES package: the files this run would write, each carrying whether the committed manifest lists it and whether a copy already exists. */
export function planCopies(source, blessed, dir = resolve(root, "vendor-src")) {
	return source.files.map(([from, name]) => {
		const rel = `${source.dir}/${name}`;
		const destination = resolve(dir, source.dir, name);
		return { from, rel, destination, listed: blessed !== null && blessed.has(rel), fresh: !existsSync(destination) };
	});
}

/** The refusal the per-file guards imply for `copies`, or null when this run may write them: a copy that exists while the committed manifest does not list it is a removed manifest line unless `force` overwrites it, and a copy that does not exist yet is acquired only with the explicit `addNew`. */
export function copyRefusal(copies, { force, addNew }) {
	for (const { rel, listed, fresh } of copies) {
		if (!listed && !fresh && !force) {
			return `vendor: vendor-src/${rel} exists but the committed ${MANIFEST_FILE} does not list it — a manifest line may have been removed; refusing to overwrite it, re-run with \`bun run vendor -- --force\` if the new bytes are intended`;
		}
		if (!listed && fresh && !addNew) {
			return `vendor: vendor-src/${rel} is not listed in the committed ${MANIFEST_FILE} — acquiring a new SOURCES path writes a path the manifest does not list; re-run with \`bun run vendor -- --add-new\` to acquire and record it`;
		}
	}
	return null;
}

/**
 * Whether a run must source a SOURCES package from a verified tarball rather than the installed tree: any copy the committed manifest does not list while a manifest stands — a first-time acquisition, or a copy whose manifest line was removed — or a path with no vendored copy yet.
 * The one case that reads the installed tree is the manifest-restore run: no committed manifest and every copy already present.
 */
export function requiresVerifiedTarball(copies, blessed) {
	return copies.some((copy) => !copy.listed && (blessed !== null || copy.fresh));
}

// The acquisition policy sits here, beside the manifest it names: a SOURCES path the committed manifest does not list is acquired from the pinned tarball only, so an unlisted path with no manifest hash to check against is never taken from the installed tree.
const ACQUISITION_TARBALL_POLICY = `a SOURCES path the committed ${MANIFEST_FILE} does not list is acquired from the pinned tarball only, never from the installed node_modules tree`;

// `lstat` reports the entry itself rather than the link target, so a symlink — including a broken one, which `exists` would miss — is caught before a byte can be written through it.
function lstatOrNull(path) {
	try {
		return lstatSync(path);
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

// `stat` follows a symlink instead, for a path a legitimately installed tree may reach through one — bun and pnpm both lay node_modules out that way — while still reporting a directory, a FIFO or a device as what it is rather than as a file.
function statOrNull(path) {
	try {
		return statSync(path);
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

// Every path this run reads passes this guard before `readFile`: reading a directory aborts with a raw EISDIR and reading a FIFO blocks until a writer appears, so an entry that is not a regular file is refused by name, and the size cap keeps a planted huge file from being pulled into memory whole.
// The refusal is returned as a problem rather than thrown so a caller reports it the way it reports its other problems; `null` covers both an absent path — whose meaning the caller keeps — and a file the read may proceed on.
function readGuardProblem(stats, label) {
	if (stats === null) return null;
	if (!stats.isFile()) return `${label} is not a regular file — refusing to read it`;
	if (stats.size > SOURCE_FILE_BYTE_CAP) {
		return `${label} is ${stats.size} bytes, over the ${SOURCE_FILE_BYTE_CAP}-byte cap for a file this run reads — refusing to read it`;
	}
	return null;
}

// A symlink planted at any directory a copy is written under would redirect every write beneath it outside the tree, so each component on the way to a destination must be a real directory — or absent, in which case it is created only after its own parent has been checked.
async function ensureRealDirectory(path, label) {
	const stats = lstatOrNull(path);
	if (stats !== null) {
		if (!stats.isDirectory()) {
			throw new Error(`vendor: ${label} is not a directory — refusing to write through it; remove it by hand and re-run`);
		}
		return;
	}
	await mkdir(path);
}

// Every intermediate component of a copy's destination is checked, not just vendor-src/ and the SOURCES directory: a SOURCES name with more than one `/` is written under subdirectories of its own, and a link planted at one of them would redirect the copy out of the tree.
async function ensureDestinationDirectories(dir, rel) {
	const segments = rel.split("/").slice(0, -1);
	let current = dir;
	for (const segment of segments) {
		current = resolve(current, segment);
		await ensureRealDirectory(current, `vendor-src/${relative(dir, current)}`);
	}
}

// A symlink planted at a copy's destination would redirect writeFile outside vendor-src/ to any writable local file, and a directory at it would abort with a raw EISDIR, so the leaf is refused unless it is a regular file or absent.
function assertRegularFileOrAbsent(path, rel) {
	const stats = lstatOrNull(path);
	if (stats !== null && !stats.isFile()) {
		throw new Error(`vendor: vendor-src/${rel} is not a regular file — refusing to write through it; remove it by hand and re-run`);
	}
}

// The hand-written files are never written by a run, so the copy loop's guards never reach them: a symlink planted at one would be hashed through the link, blessing whatever it points at into the manifest as that file's own digest, so the same guard runs over them before the tree is hashed.
function assertHandWrittenEntries(dir) {
	for (const rel of HAND_WRITTEN_FILES) {
		const stats = lstatOrNull(resolve(dir, rel));
		if (stats !== null && !stats.isFile()) {
			throw new Error(`vendor: vendor-src/${rel} is not a regular file — refusing to hash it into ${MANIFEST_FILE}; remove it by hand and re-run`);
		}
	}
}

// Copies a file only when the manifest guards allow it, and only from the trusted source: a file still hashing to what the committed manifest blessed, so a modified or spoofed upstream is rejected before it can overwrite vendor-src/, and only an explicit `--force` (a re-bless) lets new bytes through.
// Any path unlisted by a committed manifest — a first-time acquisition, or a copy whose manifest line was removed — anchors the whole package to a verified tarball, so it is not sourced from the installed tree while that manifest stands; a run resolving none is refused rather than falling back.
// Neither the destination nor any directory above it may be a link: a planted one cannot redirect the copy out of the tree, and the whole directory chain is checked and created before the first copy of the package is written.
async function vendor({ source, copies }, { force, blessed, trusted }) {
	const pin = pinFor(source.pkg);
	const anchored = requiresVerifiedTarball(copies, blessed);
	const resolved = trusted.byPackage.get(source.pkg);
	if (anchored && resolved === null) throw new Error(`vendor: ${ACQUISITION_TARBALL_POLICY} — ${missingTarballMessage(source.pkg, pin, trusted.cacheDir)}`);
	if (resolved === null) {
		const problem = await installedTreeProblem(trusted.root, source.pkg, pin);
		if (problem !== null) {
			throw new Error(`vendor: ${problem} — refusing to vendor an unexpected tree`);
		}
	}
	const dir = resolve(root, "vendor-src");
	await ensureRealDirectory(dir, "vendor-src");
	for (const { rel } of copies) {
		await ensureDestinationDirectories(dir, rel);
	}
	for (const { from, rel, destination } of copies) {
		const bytes = await trustedBytes(trusted, source, from);
		if (bytes === null) {
			throw new Error(`vendor: ${resolved === null ? `node_modules/${source.pkg}/${from} is missing` : `the pinned ${source.pkg}@${pin.version} tarball does not ship ${from}`}`);
		}
		const expected = blessed?.get(rel);
		if (expected !== undefined && !force && sha256(bytes) !== expected) {
			const upstream = resolved === null ? `node_modules/${source.pkg}/${from}` : `the pinned ${source.pkg}@${pin.version} tarball`;
			throw new Error(`vendor: ${upstream} no longer matches the blessed vendor-src/${rel} — refusing to overwrite it; re-bless with \`bun run vendor -- --force\` if the change is intended`);
		}
		assertRegularFileOrAbsent(destination, rel);
		await writeFile(destination, bytes);
		console.log(`vendor: ${source.pkg}@${pin.version}/${from} -> ${relative(root, destination)}`);
	}
}

// Copies never delete, so an unexpected file in vendor-src/ would linger unnoticed: fail on anything SOURCES and the hand-written files do not account for.
async function assertNoStrays() {
	const dir = resolve(root, "vendor-src");
	const expected = new Set(expectedVendorFiles());
	const strays = (await listFiles(dir)).filter((rel) => !expected.has(rel));
	if (strays.length === 0) return;
	throw new Error(`vendor: vendor-src/ contains files that no SOURCES entry or hand-written file accounts for — delete them by hand:\n${strays.map((rel) => `  vendor-src/${rel}`).join("\n")}`);
}

// Re-blesses the committed manifest only when the hashed tree still matches it, unless `force` is set.
// A tree that drifted (a swapped bundle, an edited shim) must be blessed by an explicit human action, never silently rewritten by a routine `bun run vendor`.
// Any file the committed manifest does not list — a new SOURCES path, or a hand-written file — needs the separate, explicit `addNew`; `force` re-blesses a listed file and does not introduce an unlisted one.
/**
 * Rewrite the committed SHA256SUMS from the current vendor-src/ tree.
 * A missing or empty committed manifest is refused without `force` rather than silently replaced.
 * The manifest is written at its own fixed path, so that path is guarded before anything is read or written: a symlink, FIFO, device or directory planted there is refused by name rather than written through.
 * Only the files the manifest already lists are compared against it, and any file it does not list needs the explicit `addNew`; a listed file that changed or vanished needs `force`.
 */
export async function blessManifest({ force = false, addNew = false, dir = resolve(root, "vendor-src") } = {}) {
	const entries = await hashTree(dir);
	const destination = resolve(dir, MANIFEST_FILE);
	assertRegularFileOrAbsent(destination, MANIFEST_FILE);
	const blessed = await blessedManifest(dir);
	if (blessed === null || blessed.size === 0) {
		if (!force) {
			throw new Error(`vendor: vendor-src/${MANIFEST_FILE} is missing or empty — refusing to write a fresh blessing without an explicit \`bun run vendor -- --force\`; restore the committed manifest, or re-run with --force if a fresh one is intended`);
		}
		console.log(`vendor: writing a fresh ${MANIFEST_FILE} over a missing or empty committed manifest (--force)`);
	} else {
		const problems = compareManifest(blessed, entries.filter(([rel]) => blessed.has(rel)));
		if (problems.length > 0) {
			if (!force) {
				throw new Error(`vendor: vendor-src/ no longer matches the committed SHA256SUMS; refusing to re-bless it silently.\n  If the new bytes are intended, re-run with \`bun run vendor -- --force\`:\n  ${problems.join("\n  ")}`);
			}
			console.log(`vendor: re-blessing ${problems.length} manifest change(s) with --force`);
		}
		const added = entries.filter(([rel]) => !blessed.has(rel));
		if (added.length > 0 && !addNew) {
			throw new Error(`vendor: vendor-src/ holds file(s) the committed ${MANIFEST_FILE} does not list — a manifest line may have been removed, or a new file is being introduced; re-run with \`bun run vendor -- --add-new\` if the new bytes are intended:\n  ${added.map(([rel]) => rel).join("\n  ")}`);
		}
		if (added.length > 0) {
			console.log(`vendor: recording ${added.length} new file(s) in ${MANIFEST_FILE}: ${added.map(([rel]) => rel).join(", ")}`);
		}
	}
	const packages = SOURCES.map(({ pkg }) => {
		const { version, integrity } = pinFor(pkg);
		return { name: pkg, version, integrity };
	}).sort((a, b) => a.name.localeCompare(b.name));
	await writeFile(destination, renderManifest(entries, packages));
	console.log(`vendor: wrote ${relative(root, destination)} (${entries.length} files hashed)`);
}

// Independent cross-check against the pinned upstream copies.
// The committed vendor-src/ tree and its SHA256SUMS are a self-referential anchor — the tests re-hash exactly the tree the manifest describes — so a hand-edited file whose manifest hash was re-blessed to match is invisible to verifyTree alone.
// The trusted copy `trusted` resolved — an explicit `--tarball`, or the cache tarball a first-time acquisition reads — and `bun install`'s reconstruction of node_modules otherwise both descend from bun.lock, whose tarball integrity is pinned in scripts/vendor-pins.mjs and checked elsewhere, so byte-comparing each vendored file to its trusted copy anchors vendor-src/ to the lockfile instead of to its own manifest.
// It reads local files only, so the check stays offline.
/**
 * Byte-compare every vendored file against its trusted copy, anchoring vendor-src/ to the lockfile rather than to its own manifest.
 * The trusted copy is the pin-verified tarball for a package `trusted` resolved to one, and the installed node_modules file under `trusted.root` otherwise.
 * Each divergence is `{ message, source }`, where `source` is "tarball" or "node_modules" according to the copy it was compared against.
 * A SOURCES path the committed manifest does not list and vendor-src/ has no copy of yet has no vendored bytes to compare; a listed path that has vanished is still a divergence.
 * The vendored copy is read through the same guard as every other read, so a symlink, FIFO, socket or device planted at it is named rather than followed, blocked on or read unboundedly.
 */
export async function upstreamProblems({ dir = resolve(root, "vendor-src"), trusted } = {}) {
	if (trusted === undefined) {
		throw new Error("vendor: upstreamProblems needs the run's resolved trusted sources — call resolveTrustedSources first");
	}
	const problems = [];
	const blessed = await blessedManifest(dir);
	for (const source of SOURCES) {
		const pin = pinFor(source.pkg);
		const resolved = trusted.byPackage.get(source.pkg);
		if (resolved === null) {
			const problem = await installedTreeProblem(trusted.root, source.pkg, pin);
			if (problem !== null) {
				problems.push({ message: problem, source: "node_modules" });
				continue;
			}
		}
		for (const [from, name] of source.files) {
			const rel = `${source.dir}/${name}`;
			const vendored = resolve(dir, rel);
			const bytes = await trustedBytes(trusted, source, from);
			if (bytes === null) {
				problems.push({
					message: resolved === null ? `missing node_modules/${source.pkg}/${from}` : `the pinned ${source.pkg}@${pin.version} tarball does not ship ${from}`,
					source: resolved === null ? "node_modules" : "tarball",
				});
				continue;
			}
			const vendoredStats = statOrNull(vendored);
			if (vendoredStats === null) {
				// A SOURCES path vendor-src/ has no copy of yet has nothing to compare; a listed path that vanished is reported.
				if (hasNoVendoredCopy(rel, blessed, dir)) continue;
				problems.push({ message: `vendor-src/${rel} is missing`, source: resolved === null ? "node_modules" : "tarball" });
				continue;
			}
			const guarded = readGuardProblem(vendoredStats, `vendor-src/${rel}`);
			if (guarded !== null) {
				problems.push({ message: `${guarded}; remove the entry by hand and re-run`, source: resolved === null ? "node_modules" : "tarball" });
				continue;
			}
			if (!bytes.equals(await readFile(vendored))) {
				problems.push({
					message: resolved === null ? `vendor-src/${rel} does not match its pinned node_modules/${source.pkg}/${from}` : `vendor-src/${rel} does not match the pinned ${source.pkg}@${pin.version} tarball`,
					source: resolved === null ? "node_modules" : "tarball",
				});
			}
		}
	}
	return problems;
}

// Name the source every reported divergence was actually compared against: a run passing `--tarball` for one package must not label a node_modules comparison as a tarball one.
function upstreamSummary(problems) {
	const tarball = problems.some((problem) => problem.source === "tarball");
	const installed = problems.some((problem) => problem.source === "node_modules");
	if (tarball && installed) return "its pinned upstream bytes (for the packages with a verified tarball) and the installed node_modules bytes (for the rest)";
	return tarball ? "its pinned upstream bytes" : "the installed node_modules bytes";
}

// The committed vendor-src/ is anchored to its trusted upstream here, before the copy loop below can replace it with whatever that source holds: a routine run proceeds only while the two agree (a SOURCES path with no vendored copy yet has nothing to compare), so a tampered or version-drifted upstream aborts rather than being blessed.
// `--force` deliberately does not reach this gate — it governs only the two manifest hash checks — so a divergence a developer intends to keep needs the separate, explicit `--allow-upstream-drift`, which warns instead of aborting.
// A diverged copy whose bytes also disagree with the blessed SHA256SUMS still stops at the per-file overwrite guard in `vendor` below, so both flags are named together.
/**
 * Refuse to re-vendor while vendor-src/ disagrees with its trusted upstream bytes, unless `allowDrift` is set.
 * `allowDrift` warns with the affected files instead of aborting; it does not reach the manifest hash checks `force` governs.
 */
export async function assertUpstreamMatches({ allowDrift = false, dir = resolve(root, "vendor-src"), trusted } = {}) {
	const problems = await upstreamProblems({ dir, trusted });
	if (problems.length === 0) return;
	const upstream = upstreamSummary(problems);
	const files = problems.map((problem) => problem.message);
	if (!allowDrift) {
		throw new Error(`vendor: vendor-src/ does not match ${upstream} — refusing to re-vendor and re-bless it; if the divergence is intended, re-run with \`bun run vendor -- --allow-upstream-drift --force\` (the drift override lets this cross-check warn instead of aborting, and --force lets the per-file overwrite guard replace a copy the blessed SHA256SUMS still disagrees with):\n  ${files.join("\n  ")}`);
	}
	console.warn(`vendor: --allow-upstream-drift is set — ${problems.length} vendored file(s) do not match ${upstream} and will be re-blessed (add --force for any copy the blessed SHA256SUMS still disagrees with, which the per-file overwrite guard would otherwise refuse):\n  ${files.join("\n  ")}`);
}

async function main() {
	const { force, allowUpstreamDrift, addNew, tarballs: tarballPaths } = parseVendorOptions(process.argv);
	const tarballs = assignTarballs(tarballPaths);
	const cacheDir = tarballCacheDir();
	const dir = resolve(root, "vendor-src");
	const pinProblems = await assertAcquisitionPins();
	if (pinProblems.length > 0) {
		throw new Error(`vendor: pinned integrity is not satisfied:\n  ${pinProblems.join("\n  ")}`);
	}
	const blessed = await blessedManifest(dir);
	// The per-file guards are decided before the run resolves any cache tarball, so a guard a run would hit is reported rather than a mismatched cache candidate for a package it would never have acquired; the explicit `--tarball` paths were already read up front by `assignTarballs`.
	const plans = SOURCES.map((source) => {
		const copies = planCopies(source, blessed);
		return { source, copies, refusal: copyRefusal(copies, { force, addNew }) };
	});
	const refusal = plans.find((plan) => plan.refusal !== null)?.refusal ?? null;
	const manifestRefused = (blessed === null || blessed.size === 0) && !force;
	// Resolution is acquisition-only: only a package this run will actually acquire from a verified tarball is looked up, so a routine run reads no tarball and cannot turn on machine-global `~/.bun/install/cache` state, and a run a guard or the manifest will refuse resolves nothing either.
	const acquire = new Set();
	if (refusal === null && !manifestRefused) {
		for (const plan of plans) {
			if (requiresVerifiedTarball(plan.copies, blessed)) acquire.add(plan.source.pkg);
		}
	}
	// One resolution of the run's trusted sources feeds both the cross-check and the copy loop, so the two cannot consult a package's tarball and node_modules copies independently.
	const trusted = resolveTrustedSources({ tarballs, acquire, cacheDir });
	// The cross-check runs before the manifest refusal so a diverged upstream is reported as such; a manifest that is absent or holds no entry, then a per-file guard, stops the run before any copy.
	await assertUpstreamMatches({ allowDrift: allowUpstreamDrift, trusted });
	if (manifestRefused) {
		throw new Error(`vendor: vendor-src/${MANIFEST_FILE} is missing or empty — refusing to run without a committed manifest; restore it, or re-run with \`bun run vendor -- --force\` if a fresh one is intended`);
	}
	if (refusal !== null) throw new Error(refusal);
	// The hand-written surface is checked before the copy loop writes anything, so a link planted there is refused by name rather than reaching the tree hash.
	assertHandWrittenEntries(dir);
	for (const plan of plans) {
		await vendor(plan, { force, blessed, trusted });
	}
	await assertNoStrays();
	await blessManifest({ force, addNew });
	console.log("vendor: ok (hand-written .d.ts shims and notices in vendor-src/ are left untouched)");
}

// Importing this module (e.g., from the tests, for SOURCES) must not re-acquire the libraries.
if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
