/**
 * The `bun run vendor` entry point: copy each pinned package's files from `node_modules` into `vendor-src/`, guarded by the lock pins, the upstream cross-check, and the manifest hash checks.
 * Importing it never acquires anything, so the tests read `SOURCES` and `expectedVendorFiles` from it.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLockPins, pinFor } from "./vendor-pins.mjs";
import {
	MANIFEST_FILE,
	compareManifest,
	hashTree,
	listFiles,
	parseManifest,
	renderManifest,
	sha256,
} from "./vendor-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The packages `bun run vendor` copies out of node_modules, each with the files it vendors and the name each takes under vendor-src/. */
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
const HAND_WRITTEN_FILES = [
	"noble-hashes/sha3.d.ts",
	"noble-hashes/utils.d.ts",
	"pdf-lib/pdf-lib.esm.d.ts",
	"scure-base/index.d.ts",
	"THIRD-PARTY-NOTICES",
];

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
	if (!existsSync(lockPath)) {
		return ["bun.lock is missing — run `bun install` first"];
	}
	return checkLockPins(await readFile(lockPath, "utf8"));
}

async function blessedManifest(dir = resolve(root, "vendor-src")) {
	const path = resolve(dir, MANIFEST_FILE);
	return existsSync(path) ? parseManifest(await readFile(path, "utf8")) : null;
}

async function installedVersion(pkg) {
	const manifest = resolve(root, "node_modules", pkg, "package.json");
	if (!existsSync(manifest)) {
		throw new Error(`vendor: ${pkg} is not installed — run \`bun install\` first`);
	}
	return JSON.parse(await readFile(manifest, "utf8")).version;
}

// Copies out of node_modules only when each file still hashes to what the committed manifest blessed; a modified or spoofed installed tree is rejected before it can overwrite vendor-src/, and only an explicit `--force` (a re-bless) lets the new bytes through.
async function vendor(source, { force, blessed }) {
	const pin = pinFor(source.pkg);
	const found = await installedVersion(source.pkg);
	if (found !== pin.version) {
		throw new Error(`vendor: ${source.pkg}@${pin.version} expected in node_modules, found ${found} — refusing to vendor an unexpected tree`);
	}
	const target = resolve(root, "vendor-src", source.dir);
	await mkdir(target, { recursive: true });
	for (const [from, name] of source.files) {
		const file = resolve(root, "node_modules", source.pkg, from);
		if (!existsSync(file)) {
			throw new Error(`vendor: ${source.pkg}@${pin.version} does not ship ${from}`);
		}
		const rel = `${source.dir}/${name}`;
		const expected = blessed?.get(rel);
		if (expected !== undefined && !force && sha256(await readFile(file)) !== expected) {
			throw new Error(`vendor: node_modules/${source.pkg}/${from} no longer matches the blessed vendor-src/${rel} — refusing to overwrite it; re-bless with \`bun run vendor -- --force\` if the change is intended`);
		}
		const destination = resolve(target, name);
		await copyFile(file, destination);
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
/**
 * Rewrite the committed SHA256SUMS from the current vendor-src/ tree.
 * Without `force` it refuses when the tree no longer matches the blessed manifest, so a drifted tree is re-blessed only by an explicit human action.
 */
export async function blessManifest({ force = false, dir = resolve(root, "vendor-src") } = {}) {
	const entries = await hashTree(dir);
	const destination = resolve(dir, MANIFEST_FILE);
	const blessed = await blessedManifest(dir);
	if (blessed !== null) {
		const problems = compareManifest(blessed, entries);
		if (problems.length > 0) {
			if (!force) {
				throw new Error(`vendor: vendor-src/ no longer matches the committed SHA256SUMS; refusing to re-bless it silently.\n  If the new bytes are intended, re-run with \`bun run vendor -- --force\`:\n  ${problems.join("\n  ")}`);
			}
			console.log(`vendor: re-blessing ${problems.length} manifest change(s) with --force`);
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
// `bun install` reconstructs node_modules from bun.lock, whose tarball integrity is pinned in scripts/vendor-pins.mjs and checked elsewhere, so byte-comparing each vendored file to its node_modules copy anchors vendor-src/ to the lockfile instead of to its own manifest.
// It reads local files only, so the check stays offline.
/** Byte-compare every vendored file against its pinned node_modules copy, anchoring vendor-src/ to the lockfile rather than to its own manifest. */
export async function upstreamProblems(dir = resolve(root, "vendor-src")) {
	const problems = [];
	for (const source of SOURCES) {
		const pin = pinFor(source.pkg);
		if (!existsSync(resolve(root, "node_modules", source.pkg))) {
			problems.push(`node_modules/${source.pkg} is not installed — run "bun install" first`);
			continue;
		}
		const found = await installedVersion(source.pkg);
		if (found !== pin.version) {
			problems.push(`node_modules/${source.pkg} is version ${found}, pinned ${pin.version}`);
			continue;
		}
		for (const [from, name] of source.files) {
			const upstream = resolve(root, "node_modules", source.pkg, from);
			const rel = `${source.dir}/${name}`;
			const vendored = resolve(dir, rel);
			if (!existsSync(upstream) || !existsSync(vendored)) {
				problems.push(`missing node_modules/${source.pkg}/${from} or vendor-src/${rel}`);
				continue;
			}
			const [a, b] = await Promise.all([readFile(upstream), readFile(vendored)]);
			if (!a.equals(b)) {
				problems.push(`vendor-src/${rel} does not match its pinned node_modules/${source.pkg}/${from}`);
			}
		}
	}
	return problems;
}

// The committed vendor-src/ is anchored to the installed node_modules bytes here, before the copy loop below can replace it with whatever node_modules holds: a routine run proceeds only while the two agree, so a tampered or version-drifted installed tree aborts rather than being blessed.
// `--force` deliberately does not reach this gate — it governs only the two manifest hash checks — so a divergence a developer intends to keep needs the separate, explicit `--allow-upstream-drift`, which warns instead of aborting.
// A diverged copy whose bytes also disagree with the blessed SHA256SUMS still stops at the per-file overwrite guard in `vendor` below, so both flags are named together.
/**
 * Refuse to re-vendor while vendor-src/ disagrees with the installed node_modules bytes, unless `allowDrift` is set.
 * `allowDrift` warns with the affected files instead of aborting; it does not reach the manifest hash checks `force` governs.
 */
export async function assertUpstreamMatches({ allowDrift = false, dir = resolve(root, "vendor-src") } = {}) {
	const problems = await upstreamProblems(dir);
	if (problems.length === 0) return;
	if (!allowDrift) {
		throw new Error(`vendor: vendor-src/ does not match the installed node_modules bytes — refusing to re-vendor and re-bless it; if the divergence is intended, re-run with \`bun run vendor -- --allow-upstream-drift --force\` (the drift override lets this cross-check warn instead of aborting, and --force lets the per-file overwrite guard replace a copy the blessed SHA256SUMS still disagrees with):\n  ${problems.join("\n  ")}`);
	}
	console.warn(`vendor: --allow-upstream-drift is set — ${problems.length} vendored file(s) do not match the installed node_modules bytes and will be re-blessed (add --force for any copy the blessed SHA256SUMS still disagrees with, which the per-file overwrite guard would otherwise refuse):\n  ${problems.join("\n  ")}`);
}

async function main() {
	const force = process.argv.includes("--force");
	const allowUpstreamDrift = process.argv.includes("--allow-upstream-drift");
	const pinProblems = await assertAcquisitionPins();
	if (pinProblems.length > 0) {
		throw new Error(`vendor: pinned integrity is not satisfied:\n  ${pinProblems.join("\n  ")}`);
	}
	await assertUpstreamMatches({ allowDrift: allowUpstreamDrift });
	const blessed = await blessedManifest();
	for (const source of SOURCES) {
		await vendor(source, { force, blessed });
	}
	await assertNoStrays();
	await blessManifest({ force });
	console.log("vendor: ok (hand-written .d.ts shims and notices in vendor-src/ are left untouched)");
}

// Importing this module (e.g. from the tests, for SOURCES) must not re-acquire the libraries.
if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
