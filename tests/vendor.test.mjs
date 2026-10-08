/** The suite for the vendored tree: that `vendor-src/` matches its SHA256 manifest, that the build copies the served files byte for byte, and that every bundle is self-contained and network-free. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { servedVendorFile } from "../build.mjs";
import { expectedVendorFiles } from "../scripts/fetch-vendor.mjs";
import { listFiles, verifyTree } from "../scripts/vendor-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sources = join(root, "vendor-src");
const copied = join(root, "app", "js", "vendor");

const VENDOR_SRC_FILES = expectedVendorFiles();
const SERVED_FILES = VENDOR_SRC_FILES.filter(servedVendorFile);

const BUNDLES = [
	"noble-hashes/sha3.js",
	"noble-hashes/utils.js",
	"noble-hashes/_u64.js",
	"scure-base/index.js",
	"pdf-lib/pdf-lib.esm.js",
];

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
	for (const file of BUNDLES) {
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
