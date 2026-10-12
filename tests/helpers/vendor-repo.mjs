/**
 * Fixture-repo helpers shared by the two vendor suites: a throwaway repo whose vendoring scripts and bun.lock are copied from the real tree, the seeding of node_modules and vendor-src for every SOURCES file, and a `bun run vendor` invocation pinned to an empty tarball cache so a pinned tarball on the machine running the tests cannot decide what a gate does.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCES } from "../../scripts/fetch-vendor.mjs";
import { MANIFEST_FILE } from "../../scripts/vendor-manifest.mjs";
import { pinFor } from "../../scripts/vendor-pins.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The fixture must copy every scripts/ module the vendoring entry point imports, transitively, so a new helper module cannot be silently absent from fixture repos; deriving the list from the imports rather than restating it keeps the two in step.
// The regex reads `from "./x.mjs"` specifiers only, so `tests/vendor.test.mjs` additionally checks the set against a broader scan of the scripts, catching a side-effect or dynamic import this narrower walk would miss.
function scriptImports(name) {
	const source = readFileSync(join(root, "scripts", name), "utf8");
	return [...source.matchAll(/from\s+"(\.\/[\w.-]+\.mjs)"/g)].map(([, specifier]) => specifier.slice(2));
}

function scriptClosure(entry) {
	const seen = new Set([entry]);
	const queue = [entry];
	while (queue.length > 0) {
		for (const dependency of scriptImports(queue.shift())) {
			if (seen.has(dependency)) continue;
			seen.add(dependency);
			queue.push(dependency);
		}
	}
	return [...seen];
}

/** The scripts a fixture repo must copy for `scripts/fetch-vendor.mjs` to run: the entry point and every `scripts/` module it imports, transitively. */
export const VENDOR_SCRIPTS = scriptClosure("fetch-vendor.mjs");

/** The directory a fixture repo pins `BUN_INSTALL_CACHE_DIR` to, so no host tarball cache is consulted. */
export function emptyCacheDir(repo) {
	return join(repo, "no-tarball-cache");
}

/** Run the fixture repo's copied `scripts/fetch-vendor.mjs` with `args`, against an empty tarball cache unless `env` names another. */
export function runVendor(repo, args = [], env = {}) {
	return spawnSync(process.execPath, [join(repo, "scripts", "fetch-vendor.mjs"), ...args], {
		cwd: repo,
		encoding: "utf8",
		env: { ...process.env, BUN_INSTALL_CACHE_DIR: emptyCacheDir(repo), ...env },
	});
}

/** Copy the vendoring scripts and bun.lock from the real tree into `repo`. */
export async function copyVendorScripts(repo) {
	await mkdir(join(repo, "scripts"), { recursive: true });
	for (const name of VENDOR_SCRIPTS) {
		await copyFile(join(root, "scripts", name), join(repo, "scripts", name));
	}
	await copyFile(join(root, "bun.lock"), join(repo, "bun.lock"));
}

/**
 * Seed `repo` with an installed `package.json` and a copy of every SOURCES file, under both node_modules/ and vendor-src/.
 * `installed(source, from)` supplies the node_modules bytes and `vendored(source, from, name)` the vendor-src bytes, so a caller states the two sources independently.
 */
export async function seedSources(repo, { installed, vendored }) {
	for (const source of SOURCES) {
		await mkdir(join(repo, "node_modules", source.pkg), { recursive: true });
		await writeFile(join(repo, "node_modules", source.pkg, "package.json"), JSON.stringify({ version: pinFor(source.pkg).version }));
		for (const [from, name] of source.files) {
			await mkdir(dirname(join(repo, "node_modules", source.pkg, from)), { recursive: true });
			await writeFile(join(repo, "node_modules", source.pkg, from), installed(source, from));
			await mkdir(dirname(join(repo, "vendor-src", source.dir, name)), { recursive: true });
			await writeFile(join(repo, "vendor-src", source.dir, name), vendored(source, from, name));
		}
	}
}

/** Drop the manifest line for `rel` from `repo`'s committed SHA256SUMS, returning the resulting text. */
export async function unlistManifestLine(repo, rel) {
	const manifestPath = join(repo, "vendor-src", MANIFEST_FILE);
	const lines = readFileSync(manifestPath, "utf8").split("\n");
	const kept = lines.filter((line) => !line.endsWith(`  ${rel}`));
	assert.notEqual(kept.length, lines.length, `the fixture manifest did not list ${rel}`);
	await writeFile(manifestPath, kept.join("\n"));
	return readFileSync(manifestPath, "utf8");
}
