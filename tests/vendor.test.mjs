/** The suite for the vendored tree and the spawned `bun run vendor` guards: that `vendor-src/` matches its SHA256 manifest, that the build copies the served files byte for byte, that every bundle is self-contained and network-free, and — through subprocess runs in a fixture repo — that the run's manifest, overwrite, stray, and acquisition guards each refuse what they must. Direct-call unit tests of the vendoring functions live in `tests/vendor-integrity.test.mjs`. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { servedVendorFile } from "../build.mjs";
import { HAND_WRITTEN_FILES, SOURCES, blessManifest, expectedVendorFiles } from "../scripts/fetch-vendor.mjs";
import { MANIFEST_FILE, listFiles, parseManifest, sha256, verifyTree } from "../scripts/vendor-manifest.mjs";
import { TARBALL_BYTE_CAP } from "../scripts/vendor-tarball.mjs";
import { SERVED_BUNDLES } from "./helpers/vendor-bundles.mjs";
import { VENDOR_SCRIPTS, copyVendorScripts, runVendor, seedSources, unlistManifestLine } from "./helpers/vendor-repo.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sources = join(root, "vendor-src");
const copied = join(root, "app", "js", "vendor");

const VENDOR_SRC_FILES = expectedVendorFiles();
const SERVED_FILES = VENDOR_SRC_FILES.filter(servedVendorFile);

// Regex comment stripping is neither string-, template- nor regex-literal aware, so it cannot be trusted to reveal every dangerous token: a comment marker inside a literal can swallow real code.
// The scan below therefore also reads the RAW source, allowing only these documented, comment-only occurrences (they live in pinned pdf-lib JSDoc).
// The allowance is matched exactly in both directions, so an added or removed token — real or comment — fails until a human updates this record, and the stripped scan must be empty on its own.
const COMMENT_ONLY_ALLOWANCE = new Map([
	[
		"pdf-lib/pdf-lib.esm.js",
		// 12× `require('pako')` and 10× `fetch(url)` inside pdf-lib's JSDoc examples.
		new Map([
			["require(", 12],
			["fetch(", 10],
		]),
	],
]);

function readVendored(file) {
	return readFileSync(join(copied, file)).toString("utf8");
}

function stripComments(source) {
	return source.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function networkReferences(source) {
	const pattern = /(?<![.\w$])fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|(?<![.\w$])require\s*\(|(?<![.\w$])import\s*\(/g;
	return source.match(pattern) ?? [];
}

function referenceCounts(source) {
	const counts = new Map();
	for (const ref of networkReferences(source)) {
		counts.set(ref, (counts.get(ref) ?? 0) + 1);
	}
	return counts;
}

// A throwaway repo whose installed node_modules and vendor-src/ hold identical bytes for every SOURCES file, so the upstream cross-check passes and only the manifest guard under test can stop the run.
async function seedRepo(prefix) {
	const repo = await mkdtemp(join(tmpdir(), prefix));
	await copyVendorScripts(repo);
	await seedSources(repo, {
		installed: (source, from) => `vendored ${source.pkg}/${from}\n`,
		vendored: (source, from) => `vendored ${source.pkg}/${from}\n`,
	});
	return repo;
}

test("build copies the served vendor files into app/js/vendor/ byte for byte", async () => {
	assert.deepEqual(
		await listFiles(sources),
		VENDOR_SRC_FILES,
		"vendor-src/ holds a file that scripts/fetch-vendor.mjs SOURCES and hand-written files do not account for",
	);
	assert.deepEqual(
		await listFiles(copied),
		SERVED_FILES,
		"app/js/vendor/ does not mirror the served subset of vendor-src/",
	);

	for (const file of SERVED_FILES) {
		const original = readFileSync(join(sources, file));
		assert.ok(original.length > 0, `vendor-src/${file} is empty`);
		assert.ok(
			original.equals(readFileSync(join(copied, file))),
			`app/js/vendor/${file} is not byte-identical to vendor-src/${file}`,
		);
	}
});

test("the vendored pdf-lib source map is served beside its bundle", async () => {
	const map = "pdf-lib/pdf-lib.esm.js.map";
	const source = join(sources, map);
	const served = join(copied, map);
	assert.ok(existsSync(source), "vendor-src/ must keep the vendored pdf-lib map");
	assert.ok(
		existsSync(served),
		`app/js/vendor/${map} must be served so its bundle's sourceMappingURL resolves`,
	);
	assert.ok(
		readFileSync(source).equals(readFileSync(served)),
		`app/js/vendor/${map} is not byte-identical to vendor-src/${map}`,
	);
});

test("vendor-src/ matches its committed SHA256 provenance manifest", async () => {
	const problems = await verifyTree(sources);
	assert.deepEqual(problems, [], problems.join("\n"));
});

test("a plain run refuses an existing vendor-src/ file whose SHA256SUMS line was removed, and does not rewrite the manifest", async () => {
	const repo = await seedRepo("invoice-vendor-unlisted-");
	try {
		await blessManifest({ dir: join(repo, "vendor-src"), force: true });
		const manifestPath = join(repo, "vendor-src", MANIFEST_FILE);
		await unlistManifestLine(repo, "pdf-lib/pdf-lib.esm.js");
		const before = readFileSync(manifestPath, "utf8");

		const result = runVendor(repo);
		assert.notEqual(result.status, 0, "a plain run must refuse an unlisted vendor-src/ file that already exists");
		assert.match(result.stderr, /does not list it/, "the abort explains the file is not in the committed manifest");
		assert.equal(readFileSync(manifestPath, "utf8"), before, "the run must not rewrite SHA256SUMS");

		const added = runVendor(repo, ["--add-new"]);
		assert.notEqual(added.status, 0, "--add-new must not overwrite a file whose manifest line was removed");
		assert.match(added.stderr, /does not list it/, "the per-file overwrite guard is unchanged by --add-new");
		assert.equal(readFileSync(manifestPath, "utf8"), before, "the run must not rewrite SHA256SUMS");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("a plain run refuses a checkout whose committed SHA256SUMS is absent", async () => {
	const repo = await seedRepo("invoice-vendor-nomanifest-");
	try {
		const manifestPath = join(repo, "vendor-src", MANIFEST_FILE);
		assert.ok(!existsSync(manifestPath), "the fixture must start with no committed manifest");

		const result = runVendor(repo);
		assert.notEqual(result.status, 0, "a plain run must refuse a missing committed manifest");
		assert.match(result.stderr, /is missing or empty/, "the abort names the missing manifest");
		assert.ok(!existsSync(manifestPath), "the run must not write a fresh manifest");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("a plain run refuses a checkout whose committed SHA256SUMS holds no entry", async () => {
	const repo = await seedRepo("invoice-vendor-emptymanifest-");
	try {
		const manifestPath = join(repo, "vendor-src", MANIFEST_FILE);
		await writeFile(manifestPath, "");
		const before = readFileSync(manifestPath, "utf8");

		const result = runVendor(repo);
		assert.notEqual(result.status, 0, "a plain run must refuse an empty committed manifest");
		assert.match(result.stderr, /is missing or empty/, "the abort names the empty manifest");
		assert.equal(readFileSync(manifestPath, "utf8"), before, "the run must not rewrite the empty manifest");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("a --force restore of a deleted manifest reads the installed tree when no tarball resolves", async () => {
	const repo = await seedRepo("invoice-vendor-restore-");
	try {
		await blessManifest({ dir: join(repo, "vendor-src"), force: true });
		const manifestPath = join(repo, "vendor-src", MANIFEST_FILE);
		await rm(manifestPath);
		assert.ok(!existsSync(manifestPath), "the fixture must start with a deleted manifest");

		// With the manifest gone every copy reads as unlisted, and the fixture's empty cache resolves no tarball: only the installed tree can restore the manifest, so a run that succeeds has taken that documented fallback rather than a missing-tarball refusal.
		const result = runVendor(repo, ["--force"]);
		assert.equal(result.status, 0, result.stderr);
		assert.ok(existsSync(manifestPath), "the run must restore the deleted manifest");
		assert.equal(
			parseManifest(readFileSync(manifestPath, "utf8")).get("pdf-lib/pdf-lib.esm.js"),
			sha256(readFileSync(join(repo, "vendor-src", "pdf-lib", "pdf-lib.esm.js"))),
			"the restored manifest must hash the tree the run read from node_modules",
		);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("a plain run refuses a stray vendor-src/ file no SOURCES entry or hand-written file accounts for, and does not rewrite SHA256SUMS", async () => {
	const repo = await seedRepo("invoice-vendor-stray-");
	try {
		await blessManifest({ dir: join(repo, "vendor-src"), force: true });
		const manifestPath = join(repo, "vendor-src", MANIFEST_FILE);
		await writeFile(join(repo, "vendor-src", "stray.js"), "no SOURCES entry or hand-written file accounts for this\n");
		const before = readFileSync(manifestPath, "utf8");

		const result = runVendor(repo);
		assert.notEqual(result.status, 0, "a plain run must refuse a stray vendor-src/ file");
		assert.match(result.stderr, /no SOURCES entry or hand-written file accounts for/, "the abort names the stray gate");
		assert.match(result.stderr, /vendor-src\/stray\.js/, "the abort names the stray file");
		assert.equal(readFileSync(manifestPath, "utf8"), before, "the run must not rewrite SHA256SUMS");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("a malformed installed package.json is refused by name instead of crashing the run", async () => {
	const repo = await seedRepo("invoice-vendor-package-json-");
	try {
		await blessManifest({ dir: join(repo, "vendor-src"), force: true });
		const manifestPath = join(repo, "vendor-src", MANIFEST_FILE);
		const before = readFileSync(manifestPath, "utf8");
		const packagePath = join(repo, "node_modules", "pdf-lib", "package.json");

		await writeFile(packagePath, "{ not json\n");
		const corrupt = runVendor(repo);
		assert.notEqual(corrupt.status, 0, "a corrupt package.json must abort the run");
		assert.match(corrupt.stderr, /node_modules\/pdf-lib\/package\.json is not valid JSON/, "the abort names the malformed file rather than a bare SyntaxError");
		assert.equal(readFileSync(manifestPath, "utf8"), before, "the run must not rewrite SHA256SUMS");

		await writeFile(packagePath, "null\n");
		const empty = runVendor(repo);
		assert.notEqual(empty.status, 0, "a package.json that holds no version must abort the run");
		assert.match(empty.stderr, /node_modules\/pdf-lib\/package\.json declares no version string/, "a package.json that is not an object is refused rather than dereferenced");

		await rm(packagePath);
		await mkdir(packagePath);
		const directory = runVendor(repo);
		assert.notEqual(directory.status, 0, "a directory at package.json must abort the run");
		assert.match(directory.stderr, /node_modules\/pdf-lib\/package\.json is not a regular file/, "the refusal names the entry rather than aborting on the read");
		assert.ok(!directory.stderr.includes("EISDIR"), "the run must not reach a raw EISDIR");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("a symlink planted at a hand-written file cannot be blessed over its committed hash", async () => {
	const repo = await seedRepo("invoice-vendor-handwritten-link-");
	try {
		const shim = join(repo, "vendor-src", "noble-hashes", "sha2.d.ts");
		const outside = join(repo, "outside.d.ts");
		const outsideBytes = Buffer.from("declare const outside: number;\n");
		await writeFile(outside, outsideBytes);
		// The shim is committed as a regular file first, because a digest can no longer be computed over a link at all.
		await writeFile(shim, "declare const shim: number;\n");
		await blessManifest({ dir: join(repo, "vendor-src"), force: true, addNew: true });
		const manifestPath = join(repo, "vendor-src", MANIFEST_FILE);
		const before = readFileSync(manifestPath, "utf8");
		await rm(shim);
		await symlink(outside, shim);

		// --force is the run that could re-bless the tree: hashing through the link would record the outside file's digest as the shim's own.
		const result = runVendor(repo, ["--force"]);
		assert.notEqual(result.status, 0, "a hand-written symlink must be refused even by a re-blessing run");
		assert.match(result.stderr, /vendor: vendor-src\/noble-hashes\/sha2\.d\.ts is not a regular file/, "the abort names the linked hand-written path");
		const after = readFileSync(manifestPath, "utf8");
		assert.equal(after, before, "the run must not rewrite SHA256SUMS over the link");
		assert.ok(!after.includes(sha256(outsideBytes)), "the link's target must never be blessed as the shim's digest");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("a plain run refuses an installed package whose version differs from its pin, and writes no manifest", async () => {
	const repo = await seedRepo("invoice-vendor-version-");
	try {
		const drifted = "pdf-lib";
		await writeFile(join(repo, "node_modules", drifted, "package.json"), JSON.stringify({ version: "9.9.9" }));
		const manifestPath = join(repo, "vendor-src", MANIFEST_FILE);

		const plain = runVendor(repo);
		assert.notEqual(plain.status, 0, "a plain run must refuse an installed package whose version disagrees with its pin");
		assert.match(plain.stderr, /pdf-lib is version 9\.9\.9, pinned 1\.17\.1/, "the abort names the installed and pinned versions");
		assert.ok(!existsSync(manifestPath), "the run must not write a manifest");

		await blessManifest({ dir: join(repo, "vendor-src"), force: true });
		const drift = runVendor(repo, ["--allow-upstream-drift"]);
		assert.notEqual(drift.status, 0, "the copy loop's installed-version guard still aborts under --allow-upstream-drift");
		assert.match(drift.stderr, /pdf-lib is version 9\.9\.9, pinned 1\.17\.1/, "the copy loop refuses to vendor the unexpected tree");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("a plain run refuses to acquire an unlisted SOURCES path without --add-new", async () => {
	const repo = await seedRepo("invoice-vendor-pending-");
	try {
		await blessManifest({ dir: join(repo, "vendor-src"), force: true });
		const manifestPath = join(repo, "vendor-src", MANIFEST_FILE);
		const target = "noble-hashes/sha3.js";
		await unlistManifestLine(repo, target);
		await rm(join(repo, "vendor-src", target));
		const before = readFileSync(manifestPath, "utf8");

		const plain = runVendor(repo);
		assert.notEqual(plain.status, 0, "a plain run must refuse to acquire an unlisted SOURCES path");
		assert.match(plain.stderr, /--add-new/, "the abort names the explicit flag that acquires a new path");
		assert.ok(!existsSync(join(repo, "vendor-src", target)), "a plain run must not acquire the unlisted path");
		assert.equal(readFileSync(manifestPath, "utf8"), before, "the run must not rewrite SHA256SUMS");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("a plain run refuses a new hand-written file, and --add-new records it", async () => {
	const repo = await seedRepo("invoice-vendor-handwritten-");
	try {
		await blessManifest({ dir: join(repo, "vendor-src"), force: true });
		const manifestPath = join(repo, "vendor-src", MANIFEST_FILE);
		// A genuinely new hand-written file: the fixture declares it in the copied script's HAND_WRITTEN_FILES so the stray gate accounts for it, and the blessed manifest does not list it yet.
		const target = "noble-hashes/extra.d.ts";
		const scriptPath = join(repo, "scripts", "fetch-vendor.mjs");
		await writeFile(scriptPath, readFileSync(scriptPath, "utf8").replace("export const HAND_WRITTEN_FILES = [", `export const HAND_WRITTEN_FILES = [\n\t"${target}",`));
		await writeFile(join(repo, "vendor-src", target), "declare const extra: number;\n");
		const before = readFileSync(manifestPath, "utf8");

		const plain = runVendor(repo);
		assert.notEqual(plain.status, 0, "a plain run must refuse to record an unlisted hand-written file");
		assert.match(plain.stderr, /--add-new/, "the abort names the explicit flag that records a new file");
		assert.equal(readFileSync(manifestPath, "utf8"), before, "the run must not rewrite SHA256SUMS");

		const added = runVendor(repo, ["--add-new"]);
		assert.equal(added.status, 0, added.stderr);
		assert.equal(
			parseManifest(readFileSync(manifestPath, "utf8")).get(target),
			sha256(readFileSync(join(repo, "vendor-src", target))),
			"the run must record the hand-written file's SHA256",
		);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("--add-new does not exempt an already-listed file from the manifest guards", async () => {
	const repo = await seedRepo("invoice-vendor-addnew-listed-");
	try {
		await blessManifest({ dir: join(repo, "vendor-src"), force: true });
		const manifestPath = join(repo, "vendor-src", MANIFEST_FILE);
		// The vendored copy no longer matches either its manifest hash or the node_modules bytes: only the listed-file guards can stop the run, and --add-new must not reach them.
		await writeFile(join(repo, "vendor-src", "pdf-lib", "pdf-lib.esm.js"), "hand-edited\n");
		const before = readFileSync(manifestPath, "utf8");

		const result = runVendor(repo, ["--add-new"]);
		assert.notEqual(result.status, 0, "--add-new must not overwrite a listed file whose bytes diverged");
		assert.match(result.stderr, /does not match the installed node_modules bytes/);
		assert.equal(readFileSync(manifestPath, "utf8"), before, "the run must not rewrite SHA256SUMS");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("every name a hand-written shim declares is an export of the vendored bundle beside it", async () => {
	const shims = HAND_WRITTEN_FILES.filter((file) => file.endsWith(".d.ts"));
	assert.ok(shims.length > 0, "no hand-written shims to cross-check");
	for (const shim of shims) {
		const bundle = shim.replace(/\.d\.ts$/, ".js");
		const declared = [...readFileSync(join(sources, shim), "utf8").matchAll(/^export declare (?:const|function) (\w+)/gm)].map(([, name]) => name);
		assert.ok(declared.length > 0, `vendor-src/${shim} declares no value exports to cross-check`);
		const exported = await import(pathToFileURL(join(sources, bundle)).href);
		for (const name of declared) {
			assert.ok(name in exported, `vendor-src/${shim} declares ${name}, which vendor-src/${bundle} does not export`);
		}
	}
});

test("the vendored pdf-lib bundle is the unminified ESM build with its map", () => {
	const bundle = readVendored("pdf-lib/pdf-lib.esm.js");
	for (const [pattern, expectation] of [
		[/\/\/# sourceMappingURL=pdf-lib\.esm\.js\.map\s*$/, "must point at its own source map"],
		[/^export \{/m, "must be a native ES module"],
		[/^var PDFDocument = /m, "must be the unminified tsc output"],
	]) {
		assert.ok(pattern.test(bundle), `pdf-lib.esm.js ${expectation}`);
	}
	assert.ok(bundle.split("\n").length > 1000, "pdf-lib.esm.js looks minified");

	const map = JSON.parse(readFileSync(join(sources, "pdf-lib/pdf-lib.esm.js.map"), "utf8"));
	assert.equal(map.version, 3);
	assert.equal(map.file, "pdf-lib.esm.js");
	assert.ok(map.sources.length > 0, "pdf-lib.esm.js.map lists no sources");
	assert.equal(map.sourcesContent.length, map.sources.length);
});

test("every served bundle's sourceMappingURL resolves to a map served beside it", () => {
	for (const file of SERVED_FILES) {
		if (!file.endsWith(".js")) continue;
		for (const [, reference] of readFileSync(join(sources, file), "utf8").matchAll(/\/\/#\s*sourceMappingURL=(\S+)/g)) {
			assert.ok(
				existsSync(join(copied, dirname(file), reference)),
				`${file} references ${reference}, which is not served — devtools would 404`,
			);
		}
	}
});

test("every vendored bundle is self-contained and free of network APIs", () => {
	for (const file of SERVED_BUNDLES) {
		const raw = readVendored(file);
		const stripped = stripComments(raw);
		for (const [, specifier] of raw.matchAll(/^[ \t]*(?:import|export)[^;]*?from\s*["']([^"']+)["']/gm)) {
			assert.match(specifier, /^\.{1,2}\//, `${file} imports the bare specifier "${specifier}"`);
		}
		assert.deepEqual(
			[...referenceCounts(stripped)],
			[],
			`${file} references a network API after comment stripping`,
		);
		const allowance = COMMENT_ONLY_ALLOWANCE.get(file) ?? new Map();
		const rawCounts = referenceCounts(raw);
		assert.deepEqual(
			[...rawCounts].filter(([ref, count]) => count > (allowance.get(ref) ?? 0)),
			[],
			`${file} references a network API outside the documented comment-only allowance`,
		);
		for (const [ref, allowed] of allowance) {
			assert.equal(
				rawCounts.get(ref) ?? 0,
				allowed,
				`${file} allowance for ${ref} is stale — update COMMENT_ONLY_ALLOWANCE`,
			);
		}
	}
});

test("the page entry and vendored modules load with every network API blocked", () => {
	const result = spawnSync(process.execPath, [join(root, "tests", "helpers", "vendor-network-smoke.mjs")], {
		cwd: root,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, `smoke failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	assert.match(result.stdout, /vendor-network-smoke: ok/);
});

test("the fixture repo's copied script set covers every relative import the vendoring scripts make", () => {
	const copiedScripts = new Set(VENDOR_SCRIPTS);
	assert.ok(copiedScripts.has("fetch-vendor.mjs"), "the entry point must be in the fixture's script set");
	// The helper recovers the set with a `from "./x.mjs"` regex; this scan is deliberately broader, so a side-effect or dynamic import the narrower walk would miss fails here instead of surfacing as an obscure MODULE_NOT_FOUND in a spawned fixture run.
	const queue = ["fetch-vendor.mjs"];
	const missing = [];
	while (queue.length > 0) {
		const name = queue.pop();
		const source = readFileSync(join(root, "scripts", name), "utf8");
		for (const [, specifier] of source.matchAll(/["'](\.\/[\w.-]+\.mjs)["']/g)) {
			const dependency = specifier.slice(2);
			if (!copiedScripts.has(dependency)) missing.push(`${name} imports ${specifier}`);
			queue.push(dependency);
		}
	}
	assert.deepEqual(missing, [], "the fixture script set must cover every relative import its copied scripts make — widen scriptImports in tests/helpers/vendor-repo.mjs");
});

test("a --force restore of an emptied manifest anchors every copy and refuses without a verified tarball", async () => {
	const repo = await seedRepo("invoice-vendor-emptied-manifest-");
	try {
		await blessManifest({ dir: join(repo, "vendor-src"), force: true });
		const manifestPath = join(repo, "vendor-src", MANIFEST_FILE);
		await writeFile(manifestPath, "");

		// A zero-byte manifest parses to an empty map rather than the `null` an absent one yields, so every copy reads as unlisted while a manifest stands and anchors each package to a verified tarball; with no tarball resolvable (the empty cache) the run refuses, unlike the deleted-manifest restore.
		const result = runVendor(repo, ["--force"]);
		assert.notEqual(result.status, 0, "a zero-byte manifest must not restore from the installed tree");
		assert.match(result.stderr, /no verified tarball/, "the run names the pinned tarball an emptied manifest needs");
		assert.equal(readFileSync(manifestPath, "utf8"), "", "the run must not rewrite the emptied manifest");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("the copy loop refuses to write through a symlinked vendor-src/ destination", async () => {
	const repo = await seedRepo("invoice-vendor-symlink-file-");
	try {
		const target = "pdf-lib/pdf-lib.esm.js";
		const destination = join(repo, "vendor-src", target);
		// The manifest is blessed while the path still holds its regular file, because a digest can no longer be computed over a link.
		await blessManifest({ dir: join(repo, "vendor-src"), force: true });
		// The link then points at the installed copy, so the upstream cross-check still passes and only the copy loop's guard can stop the run; the read follows the link but the write must not.
		const linkTarget = join(repo, "node_modules", "pdf-lib", "dist", "pdf-lib.esm.js");
		const linkContent = readFileSync(linkTarget, "utf8");
		await rm(destination);
		await symlink(linkTarget, destination);

		const result = runVendor(repo);
		assert.notEqual(result.status, 0, "a symlinked destination must be refused");
		assert.match(result.stderr, /vendor-src\/pdf-lib\/pdf-lib\.esm\.js is not a regular file/);
		assert.equal(readFileSync(linkTarget, "utf8"), linkContent, "the run must not write through the symlink into node_modules");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("the copy loop refuses to write through a symlinked vendor-src/<dir>", async () => {
	const repo = await seedRepo("invoice-vendor-symlink-dir-");
	try {
		const pdfLib = SOURCES.find((entry) => entry.pkg === "pdf-lib");
		const outside = join(repo, "outside");
		await mkdir(outside, { recursive: true });
		// A directory that mirrors the installed bytes, so the cross-check passes and only the copy loop's directory guard can stop the run.
		for (const [from, name] of pdfLib.files) {
			await writeFile(join(outside, name), `vendored pdf-lib/${from}\n`);
		}
		await blessManifest({ dir: join(repo, "vendor-src"), force: true });
		await rm(join(repo, "vendor-src", "pdf-lib"), { recursive: true, force: true });
		await symlink(outside, join(repo, "vendor-src", "pdf-lib"));

		const result = runVendor(repo);
		assert.notEqual(result.status, 0, "a symlinked vendor-src/<dir> must be refused");
		assert.match(result.stderr, /vendor-src\/pdf-lib is not a directory/);
		assert.deepEqual(
			await listFiles(outside),
			pdfLib.files.map(([, name]) => name).sort(),
			"the run must not create files through the symlinked directory",
		);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("--tarball refuses a path larger than the pinned-tarball byte cap without reading it", async () => {
	const repo = await seedRepo("invoice-vendor-tarball-oversize-");
	try {
		const oversized = join(repo, "oversized.tgz");
		await writeFile(oversized, "");
		await truncate(oversized, TARBALL_BYTE_CAP + 1);

		const result = runVendor(repo, ["--tarball", oversized]);
		assert.notEqual(result.status, 0, "an oversized --tarball path must be refused");
		assert.match(result.stderr, /over the \d+-byte cap for a pinned package tarball/, "the abort names the byte cap");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});
