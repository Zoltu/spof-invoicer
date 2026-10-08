/**
 * The `bun run build` entry point: verify the vendor manifest, copy the vendored files and the images into `app/`, then compile the TypeScript sources under `app/ts/` into `app/js/`.
 * Its scratch-root and vendored-file helpers are exported for the build and vendor tests.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST_FILE, verifyTree } from "./scripts/vendor-manifest.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function isInside(base, target) {
	return target === base || target.startsWith(base + sep);
}

// An out root the build removes `<outRoot>/app/**` beneath must be a directory the build owns: one that does not exist yet, or one that is present and empty.
// A path that already holds files may belong to another process, and the recursive rm would then reach outside this build's output.
function isBuildOwnedScratch(resolved) {
	if (!existsSync(resolved)) return true;
	return statSync(resolved).isDirectory() && readdirSync(resolved).length === 0;
}

// BUILD_OUT_ROOT is env-controlled and the derived target is removed with a recursive rm, so the out root must be the repo itself or a scratch directory the build owns.
// os.tmpdir() itself, a path outside the repo and os.tmpdir(), and any other pre-existing directory are refused with a hard error rather than risk the removal.
/**
 * Resolve the build's output root from BUILD_OUT_ROOT, defaulting to the repo itself.
 * The derived target is removed with a recursive rm, so the root must be the repo or a scratch directory the build owns; anything else is refused with a hard error.
 */
export function resolveOutRoot(configured = process.env.BUILD_OUT_ROOT) {
	if (configured === undefined || configured === "") return root;
	const resolved = resolve(root, configured);
	if (resolved === root) return resolved;
	if (isInside(root, resolved)) {
		if (!isBuildOwnedScratch(resolved)) {
			throw new Error(`build: BUILD_OUT_ROOT=${configured} resolves to ${resolved}, a directory inside the repo that already holds files the build did not create — refusing to remove it`);
		}
		return resolved;
	}
	if (resolved === tmpdir() || !isInside(tmpdir(), resolved)) {
		throw new Error(`build: BUILD_OUT_ROOT=${configured} resolves to ${resolved}, outside the repo (${root}) and ${tmpdir()} — refusing to remove it`);
	}
	if (!isBuildOwnedScratch(resolved)) {
		throw new Error(`build: BUILD_OUT_ROOT=${configured} resolves to ${resolved}, a directory under ${tmpdir()} that already holds files the build did not create — refusing to remove it`);
	}
	return resolved;
}

// Everything under vendor-src/ except the manifest is served: the .js bundles, their shims and licenses, and their .js.map files are copied byte for byte.
// Serving the maps keeps each bundle's `//# sourceMappingURL=` resolvable — pdf-lib's pdf-lib.esm.js ends with one — instead of 404-ing in devtools; the manifest is build-time provenance and stays behind.
/** True for a vendor-src/ file the build serves: everything except the SHA256 provenance manifest. */
export function servedVendorFile(path) {
	return basename(path) !== MANIFEST_FILE;
}

const COPIES = [
	{ from: "vendor-src", to: "app/js/vendor", label: "vendor", filter: servedVendorFile },
	{ from: "assets-src/images", to: "app/images", label: "images" },
];

// The served vendor tree is only as trustworthy as vendor-src/, so verify its committed SHA256 provenance before copying a single byte; a tampered or stale tree aborts the build.
/** The problems that keep the committed vendor-src/ tree from its SHA256 manifest; the build copies no byte while any remain. */
export async function vendorTreeProblems(dir = resolve(root, "vendor-src")) {
	return verifyTree(dir);
}

async function copyInto({ from, to, label, filter }, outRoot) {
	const source = resolve(root, from);
	if (!existsSync(source)) {
		console.log(`build: no ${label} source (${from}/), skipping`);
		return;
	}
	const target = resolve(outRoot, to);
	// Replace rather than merge, so files excluded by the filter cannot linger from a previous build.
	await rm(target, { recursive: true, force: true });
	await mkdir(target, { recursive: true });
	await cp(source, target, { recursive: true, filter });
	console.log(`build: copied ${from}/ -> ${to}/`);
}

function findTsc() {
	try {
		return require.resolve("typescript/bin/tsc");
	} catch {
		const local = resolve(root, "node_modules/typescript/bin/tsc");
		return existsSync(local) ? local : null;
	}
}

function compile(outRoot) {
	const tsc = findTsc();
	if (tsc === null) {
		throw new Error("build: typescript is not installed — run `bun install` first");
	}
	const args = [tsc, "-p", resolve(root, "tsconfig.json")];
	if (outRoot !== root) {
		args.push("--outDir", resolve(outRoot, "app/js"));
	}
	const result = spawnSync(process.execPath, args, {
		cwd: root,
		stdio: "inherit",
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(`build: tsc exited with code ${result.status}`);
	}
	console.log("build: compiled app/ts/**/*.ts -> app/js/**/*.js");
}

// Importing this module (e.g. from the tests, to reuse servedVendorFile) must not run the build.
if (import.meta.main) {
	try {
		const outRoot = resolveOutRoot();
		const problems = await vendorTreeProblems();
		if (problems.length > 0) {
			throw new Error(`build: vendor-src/ failed its SHA256 provenance check — run \`bun run vendor\`:\n  ${problems.join("\n  ")}`);
		}
		for (const job of COPIES) {
			await copyInto(job, outRoot);
		}
		compile(outRoot);
		console.log("build: ok");
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
