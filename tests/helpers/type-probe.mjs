/**
 * The compile-probe harness the type-level suites share: a probe's source is written into a throwaway directory and compiled by the project's own `tsc` under the project's own tsconfig.
 *
 * `tests/slow/clipboard-type.test.mjs`, `tests/slow/icon-type.test.mjs`, and `tests/slow/util-type.test.mjs` each assert a type contract with one probe, so the temp directory, the generated `package.json` and `tsconfig.json`, and the `tsc` invocation live here rather than being copied into each suite.
 * The probe source is generated at run time from a string committed in the calling suite, so no untracked path is required for a clean checkout to run either suite; the generated `package.json` makes the probe an ES module and the generated tsconfig extends the root one, so the probe is checked under the project's own configuration — `verbatimModuleSyntax`, `isolatedModules`, `moduleDetection`, `noImplicitOverride`, `noFallthroughCasesInSwitch` and the rest — rather than a hand-copied flag list that can drift.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findTsc } from "../../build.mjs";

/** The workspace root: the directory holding `app/`, `tests/`, and the rest, two levels above this helper's own directory. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The deepest directory that contains every one of `paths`, which is the `rootDir` a probe tsconfig must set to span both the throwaway probe directory and the sources it imports. */
function commonAncestor(...paths) {
	const parts = paths.map((value) => resolve(value).split(sep));
	let end = 0;
	while (end < parts[0].length && parts.every((entry) => entry[end] === parts[0][end])) end += 1;
	return parts[0].slice(0, end).join(sep) || sep;
}

/**
 * Compile one type probe under the project's own tsconfig and assert that `tsc` exits zero, so the probe's `@ts-expect-error` lines are compile errors while its unmarked lines still compile.
 *
 * `source(specifier)` builds the probe's text; it calls `specifier(target)` for each module the probe imports, receiving the target's path relative to the probe's own throwaway directory. The probe is written as `fileName` and its generated tsconfig includes only that file, so the compilation covers the probe and the project sources it reaches. `failureMessage` leads the message a failed compile reports, ahead of `tsc`'s own output.
 */
export function runTypeProbe({ prefix, fileName, source, failureMessage }) {
	const tsc = findTsc();
	assert.notEqual(tsc, null, "typescript is installed");
	const dir = mkdtempSync(join(tmpdir(), prefix));
	try {
		const specifier = (target) => relative(dir, join(root, target)).split(sep).join("/");
		writeFileSync(join(dir, fileName), source(specifier));
		writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
		writeFileSync(
			join(dir, "tsconfig.json"),
			`${JSON.stringify({ extends: join(root, "tsconfig.json"), compilerOptions: { rootDir: commonAncestor(dir, root), noEmit: true }, include: [fileName] }, null, "\t")}\n`,
		);
		const result = spawnSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json"), "--noEmit"], { cwd: root, encoding: "utf8" });
		assert.equal(result.error, undefined, `tsc could not run: ${result.error}`);
		assert.equal(result.status, 0, `${failureMessage}:\n${result.stdout}${result.stderr}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
