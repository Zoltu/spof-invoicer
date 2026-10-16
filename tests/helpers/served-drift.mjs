/** Build the served tree into a throwaway root and compare it, byte for byte, against the working-tree `app/`, so the acceptance gate catches a stale or stray file. */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listFiles } from "../../scripts/vendor-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The subtrees a build produces from its inputs: `app/js/**` from `app/ts/**` plus the copied vendor bundles, and `app/images/**` from `assets-src/images/**`.
// Both must be reproduced byte for byte.
const BUILD_OUTPUTS = ["app/js", "app/images"];

// Files the build does not produce but the app ships deliberately: the page shell, and the TypeScript sources and stylesheets under these trees.
// Every other file under app/ is reported.
const AUTHORED_FILES = new Set(["app/index.html"]);
const AUTHORED_TREES = [
	{ dir: "app/ts", extension: ".ts", emitted: "app/js" },
	{ dir: "app/stylesheets", extension: ".css", referencedBy: "app/index.html" },
];

/**
 * Build into a throwaway root and compare the whole served `app/` tree against the working tree.
 * The build outputs (`app/js/**` — our emitted modules, their maps, and the copied vendor bundles — and `app/images/**`) are checked byte for byte, and every other file under `app/` must be one of the authored sources the app ships deliberately.
 * A stale or hand-edited file is reported instead of being quietly overwritten by the next build, and a stray file that would still be pinned to IPFS is reported too.
 * The build itself verifies `vendor-src/` against its SHA256 manifest before copying a byte, so a drifted vendor tree aborts here as well.
 * Resolves to an array of problem strings — `[]` when the working-tree `app/` is exactly a fresh build.
 */
export async function servedTreeProblems() {
	const out = await mkdtemp(join(tmpdir(), "invoice-acceptance-"));
	try {
		const build = spawnSync(process.execPath, [join(root, "build.mjs")], {
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, BUILD_OUT_ROOT: out },
		});
		if (build.status !== 0) {
			return [`a fresh build failed (exit ${build.status}):\n${build.stdout}\n${build.stderr}`];
		}
		const served = await servedFiles();
		const problems = authoredFileProblems(served);
		for (const dir of BUILD_OUTPUTS) {
			problems.push(...(await treeDifferences(dir, join(root, dir), join(out, dir))));
		}
		return problems;
	} finally {
		await rm(out, { recursive: true, force: true });
	}
}

/** Every file under the working-tree `app/`, relative to the repo root; `[]` when `app/` is missing. */
async function servedFiles() {
	try {
		return (await listFiles(join(root, "app"))).map((file) => `app/${file}`);
	} catch {
		return [];
	}
}

/**
 * A file under `app/` that is neither part of a build output nor an authored source would still ship to IPFS, so it is a problem.
 * An authored source must in turn be accounted for: an emitted module behind every `app/ts/**.ts`, and a reference from the shell to every stylesheet.
 */
function authoredFileProblems(served) {
	if (served.length === 0) return ["app/ is missing — run `bun run build`"];
	const problems = [];
	for (const path of served) {
		if (BUILD_OUTPUTS.some((dir) => path.startsWith(`${dir}/`))) continue;
		if (AUTHORED_FILES.has(path)) continue;
		const tree = AUTHORED_TREES.find(({ dir, extension }) => path.startsWith(`${dir}/`) && path.endsWith(extension));
		if (tree === undefined) {
			problems.push(`${path} ships under app/ but is neither a build output nor an authored source`);
			continue;
		}
		if (tree.emitted !== undefined) {
			const emittedPath = join(root, tree.emitted, path.slice(`${tree.dir}/`.length).replace(/\.ts$/, ".js"));
			if (!existsSync(emittedPath)) problems.push(`${path} has no compiled counterpart in ${tree.emitted}/`);
		}
		if (tree.referencedBy !== undefined) {
			const reference = path.slice("app/".length);
			const shell = existsSync(join(root, tree.referencedBy)) ? readFileSync(join(root, tree.referencedBy), "utf8") : "";
			if (!shell.includes(reference)) problems.push(`${path} ships but ${tree.referencedBy} never references it`);
		}
	}
	return problems;
}

async function treeDifferences(label, servedRoot, fresh) {
	let servedTreeFiles;
	let freshFiles;
	try {
		servedTreeFiles = await listFiles(servedRoot);
	} catch {
		return [`${label}/ is missing — run \`bun run build\``];
	}
	try {
		freshFiles = await listFiles(fresh);
	} catch {
		return [`the build produced no ${label}/ tree`];
	}

	const problems = [];
	for (const file of freshFiles) {
		if (!servedTreeFiles.includes(file)) {
			problems.push(`${label}/${file} is missing from the working tree — run \`bun run build\``);
			continue;
		}
		const built = await readFile(join(fresh, file));
		const servedBytes = await readFile(join(servedRoot, file));
		if (file.endsWith(".map")) {
			problems.push(...mapDifferences(label, file, built, servedBytes, join(fresh, file), join(servedRoot, file)));
		} else if (!built.equals(servedBytes)) {
			problems.push(`${label}/${file} differs from a fresh build — run \`bun run build\``);
		}
	}
	for (const file of servedTreeFiles) {
		if (!freshFiles.includes(file)) {
			problems.push(`${label}/${file} is not produced by the build`);
		}
	}
	return problems;
}

/**
 * A source map cannot be compared byte for byte across out roots: `tsc` spells `sources` relative to the `--outDir` it was handed, so the same compile writes `../ts/x.ts` into the repo and a longer path back into `app/ts/` into a scratch root.
 * Every other field — the mappings, the embedded source text, the file name — is out-root independent; `sources` is compared by resolving both sides against their own map file, which pins the same absolute TypeScript files, except for a vendored map, which is copied byte for byte and so has identical `sources` that already compare literally.
 */
function mapDifferences(label, file, builtBytes, servedBytes, builtPath, servedPath) {
	const built = JSON.parse(builtBytes.toString("utf8"));
	const served = JSON.parse(servedBytes.toString("utf8"));
	const problems = [];
	for (const key of ["version", "file", "names", "sourcesContent"]) {
		if (JSON.stringify(built[key]) !== JSON.stringify(served[key])) {
			problems.push(`${label}/${file} has a different ${key} than a fresh build`);
		}
	}
	if (built.mappings !== served.mappings) {
		problems.push(`${label}/${file} has different mappings than a fresh build`);
	}
	// A vendored map is copied byte for byte, so its `sources` are identical and resolve relative to whichever out root holds the copy; only tsc's own maps, whose `sources` differ per out root, need the resolve-both-and-compare treatment.
	const sourcesOf = (map, path) => (map.sources ?? []).map((source) => resolve(dirname(path), source)).join("\n");
	const sameSources = JSON.stringify(built.sources) === JSON.stringify(served.sources);
	if (!sameSources && sourcesOf(built, builtPath) !== sourcesOf(served, servedPath)) {
		problems.push(`${label}/${file} resolves to different sources than a fresh build`);
	}
	return problems;
}
