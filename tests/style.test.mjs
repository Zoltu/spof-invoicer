/**
 * The repo's own style gate.
 *
 * The rule set and the file inventory both live in `.editorconfig`; this file drives the resolver in `tests/helpers/style.mjs` against the real tree and against synthetic violations, so a config edit or a scanner regression fails here instead of hiding behind a clean tree.
 * The generated and vendored trees (`app/js/**`, `app/images/**`, `vendor-src/**`, `node_modules/**`) are byte-checked artifacts whose exact bytes the SHA256 sums and the fresh-build comparison hold, which is why `.editorconfig` unsets their rules and why the walk never descends into them.
 * A violation is reported as `path:line — reason`, so a failure names the file and line to fix.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { codeOnly, commentContinuationLines } from "./helpers/code-only.mjs";
import { ENFORCED_KEYS, fileProblems, governedFiles, isIgnored, parseEditorConfig, parseGitignore, resolveProps, styleProblems, unenforcedKeyProblems, unsupportedValueProblems, walk } from "./helpers/style.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configText = readFileSync(join(root, ".editorconfig"), "utf8");
const sections = parseEditorConfig(configText);

/** Check synthetic file content the way the sweep checks a real one, deriving the rules from the real config for that path. */
function check(text, label = "fixture.ts") {
	return fileProblems({ label, props: resolveProps(sections, label), bytes: Buffer.from(text) });
}

/** A throwaway directory holding a synthetic config and tree, cleaned up after the case runs. */
async function fixture(files) {
	const dir = await mkdtemp(join(tmpdir(), "invoice-style-guard-"));
	for (const [path, text] of Object.entries(files)) {
		const target = join(dir, path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, text);
	}
	return dir;
}

/** A governed representative file under `tree` taken from the real tree, or `null` when the tree is absent — a documented state for `assets-src/`, which the build treats as optional. */
async function representativeUnder(root, tree) {
	let entries;
	try {
		entries = await readdir(join(root, tree), { withFileTypes: true });
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		return null;
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (entry.isFile()) return `${tree}/${entry.name}`;
		if (entry.isDirectory()) {
			const deeper = await representativeUnder(root, `${tree}/${entry.name}`);
			if (deeper !== null) return deeper;
		}
	}
	return null;
}

test("the resolver derives the tab rule and the exclusions from the real `.editorconfig`", () => {
	for (const label of ["app/ts/x.ts", "package.json", "tsconfig.json", "assets-src/images/logo.svg", "app/index.html", "tests/x.mjs", "app/stylesheets/app.css", "scripts/x.mjs"]) {
		assert.equal(resolveProps(sections, label).indent_style, "tab", `${label} should be tab-indented`);
	}
	for (const label of ["node_modules/x.js", "vendor-src/x.js", "app/js/x.js", "app/images/x.svg"]) {
		assert.equal(resolveProps(sections, label).indent_style, "unset", `${label} should be excluded`);
		assert.equal(resolveProps(sections, label).charset, "unset", `${label} should be out of scope, charset included`);
	}
	const prose = resolveProps(sections, "README.md");
	assert.equal(prose.charset, "utf-8");
	assert.equal(prose.end_of_line, "lf");
	assert.equal(prose.insert_final_newline, "true");
	assert.equal(prose.trim_trailing_whitespace, "true");
	assert.equal(prose.indent_style, undefined);
	assert.equal(resolveProps(sections, "app/js/x.js").end_of_line, "unset");
});

test("the resolver tracks the tab glob, the `[*]` line rules, and an `unset` section", () => {
	// The tab glob: narrowing it drops the tab rule for a json file.
	assert.equal(resolveProps(sections, "tsconfig.json").indent_style, "tab");
	const narrowedGlob = configText.replace(",json", "");
	assert.equal(resolveProps(parseEditorConfig(narrowedGlob), "tsconfig.json").indent_style, undefined);
	assert.equal(resolveProps(parseEditorConfig(narrowedGlob), "x.ts").indent_style, "tab");

	// The `[*]` line rules are inputs too: changing one changes every governed file's rule.
	const changedLineRule = configText.replace("end_of_line = lf", "end_of_line = crlf");
	assert.equal(resolveProps(sections, "README.md").end_of_line, "lf");
	assert.equal(resolveProps(parseEditorConfig(changedLineRule), "README.md").end_of_line, "crlf");
	assert.equal(resolveProps(parseEditorConfig(changedLineRule), "app/ts/x.ts").indent_style, "tab");

	// So is an `unset` section: dropping one re-governs the tree.
	const synthetic = ["[*]", "end_of_line = lf", "[vendor/**]", "end_of_line = unset"].join("\n");
	assert.equal(resolveProps(parseEditorConfig(synthetic), "vendor/x.ts").end_of_line, "unset");
	assert.equal(resolveProps(parseEditorConfig(synthetic.replace("[vendor/**]\nend_of_line = unset", "")), "vendor/x.ts").end_of_line, "lf");
});

test("the resolver expands a brace group that spans whole globs, keeping inner metacharacters active", () => {
	const spanning = parseEditorConfig(["[{*.ts,*.js}]", "indent_style = tab"].join("\n"));
	assert.equal(resolveProps(spanning, "src/x.ts").indent_style, "tab");
	assert.equal(resolveProps(spanning, "src/x.js").indent_style, "tab");
	assert.equal(resolveProps(spanning, "src/x.css").indent_style, undefined);
	assert.equal(resolveProps(spanning, "src/x.tsx").indent_style, undefined);
});

test("the resolver keeps a suffix brace group working", () => {
	const suffix = parseEditorConfig(["[*.{ts,js}]", "indent_style = tab"].join("\n"));
	assert.equal(resolveProps(suffix, "src/x.ts").indent_style, "tab");
	assert.equal(resolveProps(suffix, "src/x.js").indent_style, "tab");
	assert.equal(resolveProps(suffix, "src/x.css").indent_style, undefined);
});

test("the resolver's `?` matches exactly one character of a path segment", () => {
	const pathGlob = parseEditorConfig(["[dir/file?.ts]", "indent_style = tab"].join("\n"));
	assert.equal(resolveProps(pathGlob, "dir/fileA.ts").indent_style, "tab");
	assert.equal(resolveProps(pathGlob, "dir/file.ts").indent_style, undefined, "`?` needs one character");
	assert.equal(resolveProps(pathGlob, "dir/fileAB.ts").indent_style, undefined, "`?` needs exactly one");
	assert.equal(resolveProps(pathGlob, "dir/sub/fileA.ts").indent_style, undefined, "`?` cannot cross a `/`");
	const basenameGlob = parseEditorConfig(["[file?]", "indent_style = tab"].join("\n"));
	assert.equal(resolveProps(basenameGlob, "nested/fileA").indent_style, "tab", "a glob with no `/` is matched against the basename");
	assert.equal(resolveProps(basenameGlob, "nested/file").indent_style, undefined, "`?` needs one character");
	assert.equal(resolveProps(basenameGlob, "nested/fileAB").indent_style, undefined, "`?` needs exactly one");
});

test("a nested brace group resolves the same way on the resolver and the walk", async () => {
	const nested = parseEditorConfig(["[{*.ts,*.{js,mjs}}]", "indent_style = tab"].join("\n"));
	assert.equal(resolveProps(nested, "src/x.ts").indent_style, "tab");
	assert.equal(resolveProps(nested, "src/x.js").indent_style, "tab");
	assert.equal(resolveProps(nested, "src/x.mjs").indent_style, "tab");
	assert.equal(resolveProps(nested, "src/x.css").indent_style, undefined);

	const dir = await fixture({
		".editorconfig": ["root = true", "", "[*]", "charset = utf-8", "indent_style = tab", "", "[vendor-src/**]", "charset = unset", "indent_style = unset", "end_of_line = unset", "insert_final_newline = unset", "trim_trailing_whitespace = unset", "", "[{*.ts,*.{js,mjs}}]", "indent_style = tab", ""].join("\n"),
		"vendor-src/hand-written.mjs": "const x = 1;\n  const y = 2;\n",
	});
	try {
		const { files } = await governedFiles(dir);
		assert.ok(files.map((file) => file.label).includes("vendor-src/hand-written.mjs"), "a nested brace-group re-enable was pruned away");
		const problems = await styleProblems(dir);
		assert.ok(problems.some((problem) => problem.startsWith("vendor-src/hand-written.mjs:2 —") && problem.includes("indentation uses spaces")), problems.join("\n"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a numeric-range group is matched literally, the same way on both sides", () => {
	// `{1..3}` has no top-level comma, so it is not one of the `{a,b}` groups this glob subset expands: it matches the literal `{1..3}` and never expands to `file1.ts`.
	const range = parseEditorConfig(["[file{1..3}.ts]", "indent_style = tab"].join("\n"));
	assert.equal(resolveProps(range, "file1.ts").indent_style, undefined);
	assert.equal(resolveProps(range, "file2.ts").indent_style, undefined);
	assert.equal(resolveProps(range, "file{1..3}.ts").indent_style, "tab");
});

test("every key the config sets to a value, not `unset`, is one the guard enforces", () => {
	assert.deepEqual(unenforcedKeyProblems(sections), [], "the guard does not enforce a key the config sets to a value");
});

test("a deliberate `unset` in an exclusion section is not flagged as an unenforced key", () => {
	const deliberate = parseEditorConfig(["root = true", "", "[*]", "charset = utf-8", "", "[dist/**]", "charset = unset", "made_up = unset"].join("\n"));
	assert.deepEqual(unenforcedKeyProblems(deliberate), [], "a key deliberately unset in an exclusion section is not a missing rule");
	const withValue = parseEditorConfig(["root = true", "", "[*]", "charset = utf-8", "", "[dist/**]", "max_line_length = 100"].join("\n"));
	const problems = unenforcedKeyProblems(withValue);
	assert.equal(problems.length, 1, problems.join("\n"));
	assert.ok(problems[0].includes("max_line_length"), problems[0]);
});

test("the governed inventory covers every authored tree and no artifact tree", async () => {
	const { files, problems } = await governedFiles(root);
	assert.deepEqual(problems, [], problems.join("\n"));
	const labels = new Set(files.map((file) => file.label));
	for (const label of ["app/ts/main.ts", "tests/style.test.mjs", "scripts/vendor-manifest.mjs", "app/stylesheets/app.css", "package.json", "tsconfig.json"]) {
		assert.ok(labels.has(label), `the governor no longer covers ${label}`);
	}
	// `assets-src/` is documented as removable, so its representative is taken from the tree rather than hard-coded.
	const imageSource = await representativeUnder(root, "assets-src");
	if (imageSource !== null) assert.ok(labels.has(imageSource), `the governor no longer covers ${imageSource}`);
	for (const label of labels) {
		assert.ok(!/^(app\/js|app\/images|vendor-src|node_modules|\.git)\//.test(label), `the governor reached ${label}`);
	}
});

test("the shipped config prunes the four artifact trees at the root", async () => {
	// Pruning is what keeps the sweep affordable: `node_modules/` alone holds tens of thousands of files, so descending into it would make the gate unusably slow, and every byte in those trees is already held by the SHA256 sums and the fresh-build byte comparison.
	const { files } = await governedFiles(root);
	const labels = files.map((file) => file.label);
	for (const tree of ["app/js", "app/images", "vendor-src", "node_modules"]) {
		assert.ok(!labels.some((label) => label === tree || label.startsWith(`${tree}/`)), `the walk descended into ${tree}`);
	}
	// A governed sibling under the same parent proves the walk ran rather than being pruned wholesale.
	assert.ok(labels.includes("app/ts/main.ts"), `the walk was pruned too broadly: ${labels.length} files`);
});

test("a nested `.editorconfig` is reported rather than silently ignored", async () => {
	// The guard reads only the root file, but an editor would honour a nested one, so a nested config must fail loudly instead of sweeping under rules the editor does not use.
	const dir = await fixture({
		".editorconfig": ["root = true", "", "[*]", "charset = utf-8", ""].join("\n"),
		"app/ts/.editorconfig": ["[*.ts]", "indent_style = space", ""].join("\n"),
		"app/ts/main.ts": "const x = 1;\n",
	});
	try {
		const { files, problems } = await governedFiles(dir);
		assert.deepEqual(problems, ["app/ts/.editorconfig — is a nested config, but the guard reads only the root .editorconfig"]);
		assert.ok(!files.some((file) => file.label === "app/ts/.editorconfig"), "the nested config is not swept as a governed file");
		assert.ok(files.some((file) => file.label === "app/ts/main.ts"), "the tree around the nested config is still swept");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a later path-anchored section that re-enables a rule keeps a pruned tree in the sweep", async () => {
	const dir = await fixture({
		".editorconfig": ["root = true", "", "[*]", "charset = utf-8", "indent_style = tab", "", "[vendor-src/**]", "charset = unset", "indent_style = unset", "", "[vendor-src/**/*.d.ts]", "indent_style = tab", ""].join("\n"),
		"vendor-src/hand-written.d.ts": "declare const x: number;\n  declare const y: number;\n",
	});
	try {
		const { files } = await governedFiles(dir);
		const labels = files.map((file) => file.label);
		assert.ok(labels.includes("vendor-src/hand-written.d.ts"), `the walk pruned a tree a later section re-enables: ${labels.join(", ")}`);
		const problems = await styleProblems(dir);
		assert.ok(problems.some((problem) => problem.startsWith("vendor-src/hand-written.d.ts:2 —") && problem.includes("indentation uses spaces")), problems.join("\n"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a path-anchored re-enable reachable only at depth keeps the tree in the sweep", async () => {
	// `[vendor-src/**/Makefile]` re-enables a key for a basename reachable only at depth; the reach predicate sees the pattern's `vendor-src` prefix overlapping the directory and so keeps the tree in the sweep.
	const dir = await fixture({
		".editorconfig": ["root = true", "", "[*]", "charset = utf-8", "end_of_line = lf", "insert_final_newline = true", "trim_trailing_whitespace = true", "indent_style = tab", "", "[vendor-src/**]", "charset = unset", "indent_style = unset", "end_of_line = unset", "insert_final_newline = unset", "trim_trailing_whitespace = unset", "", "[vendor-src/**/Makefile]", "indent_style = tab", ""].join("\n"),
		"vendor-src/pdf-lib/deep/Makefile": "all:\n  echo hi\n",
	});
	try {
		const { files } = await governedFiles(dir);
		const labels = files.map((file) => file.label);
		assert.ok(labels.includes("vendor-src/pdf-lib/deep/Makefile"), `the walk pruned a tree a path-anchored section re-enables: ${labels.join(", ")}`);
		const problems = await styleProblems(dir);
		assert.ok(problems.some((problem) => problem.startsWith("vendor-src/pdf-lib/deep/Makefile:2 —") && problem.includes("indentation uses spaces")), problems.join("\n"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a re-enable whose brace group contains a slash keeps the pruned tree in the sweep", async () => {
	// The brace expands to `package.json` (basename-anchored) and `app/index.html` (path-anchored); reading the raw glob as `{package.json,app` + `index.html}` would mis-read the first segment and prune `app/`, silently dropping the file the tab rule governs.
	const dir = await fixture({
		".editorconfig": ["root = true", "", "[*]", "charset = utf-8", "indent_style = tab", "", "[app/**]", "charset = unset", "indent_style = unset", "end_of_line = unset", "insert_final_newline = unset", "trim_trailing_whitespace = unset", "", "[{package.json,app/index.html}]", "indent_style = tab", ""].join("\n"),
		"app/index.html": "<div></div>\n  <span></span>\n",
	});
	try {
		const { files } = await governedFiles(dir);
		const labels = files.map((file) => file.label);
		assert.ok(labels.includes("app/index.html"), `the walk pruned a tree a brace-expanded path re-enables: ${labels.join(", ")}`);
		const problems = await styleProblems(dir);
		assert.ok(problems.some((problem) => problem.startsWith("app/index.html:2 —") && problem.includes("indentation uses spaces")), problems.join("\n"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a basename-anchored section re-enables a file inside an otherwise-unset tree", async () => {
	const dir = await fixture({
		".editorconfig": ["root = true", "", "[*]", "charset = utf-8", "indent_style = tab", "", "[vendor-src/**]", "charset = unset", "indent_style = unset", "end_of_line = unset", "insert_final_newline = unset", "trim_trailing_whitespace = unset", "", "[*.d.ts]", "indent_style = tab", ""].join("\n"),
		"vendor-src/hand-written.d.ts": "declare const x: number;\n  declare const y: number;\n",
	});
	try {
		const { files } = await governedFiles(dir);
		const labels = files.map((file) => file.label);
		assert.ok(labels.includes("vendor-src/hand-written.d.ts"), `a basename-anchored re-enable was pruned away: ${labels.join(", ")}`);
		const problems = await styleProblems(dir);
		assert.ok(problems.some((problem) => problem.startsWith("vendor-src/hand-written.d.ts:2 —") && problem.includes("indentation uses spaces")), problems.join("\n"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a basename section with no literal suffix re-enables a file inside an unset tree", async () => {
	// `[LICENSE*]` has no literal suffix after its wildcard; a basename-anchored pattern can match under any directory, so the tree must stay in the sweep.
	const dir = await fixture({
		".editorconfig": ["root = true", "", "[*]", "charset = utf-8", "indent_style = tab", "", "[vendor-src/**]", "charset = unset", "indent_style = unset", "end_of_line = unset", "insert_final_newline = unset", "trim_trailing_whitespace = unset", "", "[LICENSE*]", "indent_style = tab", ""].join("\n"),
		"vendor-src/pdf-lib/LICENSE.md": "License\n  indented\n",
	});
	try {
		const { files } = await governedFiles(dir);
		assert.ok(files.map((file) => file.label).includes("vendor-src/pdf-lib/LICENSE.md"), "a basename-anchored re-enable with no literal suffix was pruned away");
		const problems = await styleProblems(dir);
		assert.ok(problems.some((problem) => problem.startsWith("vendor-src/pdf-lib/LICENSE.md:2 —") && problem.includes("indentation uses spaces")), problems.join("\n"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a wildcard-free basename section re-enables a file inside an unset tree", async () => {
	const dir = await fixture({
		".editorconfig": ["root = true", "", "[*]", "charset = utf-8", "indent_style = tab", "", "[vendor-src/**]", "charset = unset", "indent_style = unset", "end_of_line = unset", "insert_final_newline = unset", "trim_trailing_whitespace = unset", "", "[Makefile]", "indent_style = tab", ""].join("\n"),
		"vendor-src/Makefile": "all:\n  echo hi\n",
	});
	try {
		const { files } = await governedFiles(dir);
		assert.ok(files.map((file) => file.label).includes("vendor-src/Makefile"), "a wildcard-free basename re-enable was pruned away");
		const problems = await styleProblems(dir);
		assert.ok(problems.some((problem) => problem.startsWith("vendor-src/Makefile:2 —") && problem.includes("indentation uses spaces")), problems.join("\n"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a brace-group re-enable inside an unset tree keeps the tree in the sweep", async () => {
	const dir = await fixture({
		".editorconfig": ["root = true", "", "[*]", "charset = utf-8", "indent_style = tab", "", "[vendor-src/**]", "charset = unset", "indent_style = unset", "end_of_line = unset", "insert_final_newline = unset", "trim_trailing_whitespace = unset", "", "[{*.ts,*.js}]", "indent_style = tab", ""].join("\n"),
		"vendor-src/hand-written.js": "const x = 1;\n  const y = 2;\n",
	});
	try {
		const { files } = await governedFiles(dir);
		const labels = files.map((file) => file.label);
		assert.ok(labels.includes("vendor-src/hand-written.js"), `a brace-group re-enable was pruned away: ${labels.join(", ")}`);
		const problems = await styleProblems(dir);
		assert.ok(problems.some((problem) => problem.startsWith("vendor-src/hand-written.js:2 —") && problem.includes("indentation uses spaces")), problems.join("\n"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a new universal key does not re-enable the walk into an excluded tree", async () => {
	const dir = await fixture({
		".editorconfig": ["root = true", "", "[*]", "charset = utf-8", "max_line_length = 100", "", "[vendor-src/**]", "charset = unset", "end_of_line = unset", "insert_final_newline = unset", "trim_trailing_whitespace = unset", "indent_style = unset", ""].join("\n"),
		"vendor-src/artifact.js": "\tconst x = 1;\r\n",
		"governed.ts": "const x = 1;\n",
		"nested/deep/governed.ts": "const x = 1;\n",
	});
	try {
		const { files } = await governedFiles(dir);
		const labels = files.map((file) => file.label);
		assert.ok(!labels.includes("vendor-src/artifact.js"), `the walk descended into a pruned tree: ${labels.join(", ")}`);
		assert.ok(labels.includes("governed.ts"), `the walk dropped a governed sibling: ${labels.join(", ")}`);
		assert.ok(labels.includes("nested/deep/governed.ts"), `the walk dropped a deeper governed file: ${labels.join(", ")}`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a shallow unset glob does not prune a tree whose deeper files are still governed", async () => {
	// `[vendor-src/*]` unsets only direct children; `vendor-src/pdf-lib/hand-written.js` resolves the `[*]` tab rule and must still be checked.
	const dir = await fixture({
		".editorconfig": ["root = true", "", "[*]", "charset = utf-8", "end_of_line = lf", "insert_final_newline = true", "trim_trailing_whitespace = true", "indent_style = tab", "", "[vendor-src/*]", "charset = unset", "indent_style = unset", "end_of_line = unset", "insert_final_newline = unset", "trim_trailing_whitespace = unset", ""].join("\n"),
		"vendor-src/pdf-lib/hand-written.js": "const x = 1;\n  const y = 2;\n",
	});
	try {
		const { files } = await governedFiles(dir);
		const labels = files.map((file) => file.label);
		assert.ok(labels.includes("vendor-src/pdf-lib/hand-written.js"), `a one-level unset glob pruned a still-governed subtree: ${labels.join(", ")}`);
		const problems = await styleProblems(dir);
		assert.ok(problems.some((problem) => problem.startsWith("vendor-src/pdf-lib/hand-written.js:2 —") && problem.includes("indentation uses spaces")), problems.join("\n"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a two-level unset glob does not prune a tree whose deeper files are still governed", async () => {
	// `[vendor-src/*/*]` unsets two levels; `vendor-src/pdf-lib/nested/hand-written.js` resolves the `[*]` tab rule and must still be checked.
	const dir = await fixture({
		".editorconfig": ["root = true", "", "[*]", "charset = utf-8", "end_of_line = lf", "insert_final_newline = true", "trim_trailing_whitespace = true", "indent_style = tab", "", "[vendor-src/*/*]", "charset = unset", "indent_style = unset", "end_of_line = unset", "insert_final_newline = unset", "trim_trailing_whitespace = unset", ""].join("\n"),
		"vendor-src/pdf-lib/nested/hand-written.js": "const x = 1;\n  const y = 2;\n",
	});
	try {
		const { files } = await governedFiles(dir);
		const labels = files.map((file) => file.label);
		assert.ok(labels.includes("vendor-src/pdf-lib/nested/hand-written.js"), `a two-level unset glob pruned a still-governed subtree: ${labels.join(", ")}`);
		const problems = await styleProblems(dir);
		assert.ok(problems.some((problem) => problem.startsWith("vendor-src/pdf-lib/nested/hand-written.js:2 —") && problem.includes("indentation uses spaces")), problems.join("\n"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("an extension-scoped exclusion does not prune a directory whose other files are governed", async () => {
	const dir = await fixture({
		".editorconfig": ["root = true", "", "[*]", "charset = utf-8", "", "[**/*.js]", "charset = unset", ""].join("\n"),
		"dist/app.js": "const x = 1;\n",
		"dist/app.css": "a {}\n",
	});
	try {
		const { files } = await governedFiles(dir);
		const labels = files.map((file) => file.label);
		assert.ok(labels.includes("dist/app.css"), `the walk pruned a governed directory: ${labels.join(", ")}`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a partial-key exclusion leaves the rest of the subtree governed", async () => {
	// A `[dist/**]\ncharset = unset` section drops only `charset`; the `[*]` line rules and the tab rule still govern every file under `dist/`, so pruning the tree would silently hide them.
	const dir = await fixture({
		".editorconfig": ["root = true", "", "[*]", "charset = utf-8", "end_of_line = lf", "insert_final_newline = true", "trim_trailing_whitespace = true", "", "[*.{ts,css}]", "indent_style = tab", "", "[dist/**]", "charset = unset", ""].join("\n"),
		"dist/app.ts": "const x = 1;\n  const y = 2;\n",
		"dist/app.css": "a {\n  color: red;\n}\n",
	});
	try {
		const { files } = await governedFiles(dir);
		const labels = files.map((file) => file.label);
		assert.ok(labels.includes("dist/app.ts"), `a partial-key exclusion pruned a still-governed tree: ${labels.join(", ")}`);
		assert.ok(labels.includes("dist/app.css"), `a partial-key exclusion pruned a still-governed tree: ${labels.join(", ")}`);
		const problems = await styleProblems(dir);
		assert.ok(problems.some((problem) => problem.startsWith("dist/app.ts:2 —") && problem.includes("indentation uses spaces")), problems.join("\n"));
		assert.ok(problems.some((problem) => problem.startsWith("dist/app.css:2 —") && problem.includes("indentation uses spaces")), problems.join("\n"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the walk skips `.gitignore`d paths and `.git`", async () => {
	const dir = await fixture({
		".editorconfig": "root = true\n[*]\ncharset = utf-8\n",
		".gitignore": "*.log\nsecrets/\n",
		"keep.ts": "const x = 1;\n",
		"debug.log": "noise\n",
		"secrets/token.ts": "const y = 1;\n",
		".git/HEAD": "ref\n",
	});
	try {
		const { files, problems } = await governedFiles(dir);
		assert.deepEqual(problems, [], problems.join("\n"));
		assert.deepEqual(files.map((file) => file.label).sort(), [".editorconfig", ".gitignore", "keep.ts"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a missing `.gitignore` leaves the sweep unpruned rather than thrown", async () => {
	const dir = await fixture({
		".editorconfig": "root = true\n[*]\ncharset = utf-8\n",
		"keep.ts": "const x = 1;\n",
	});
	try {
		const { files, problems } = await governedFiles(dir);
		assert.deepEqual(problems, []);
		assert.deepEqual(files.map((file) => file.label).sort(), [".editorconfig", "keep.ts"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the `.gitignore` matcher honors the real file, pinning its `.orchestration/` entry", () => {
	const entries = parseGitignore(readFileSync(join(root, ".gitignore"), "utf8"));
	for (const path of ["node_modules/left-pad/index.js", ".orchestration/run.json"]) {
		assert.equal(isIgnored(entries, path, false), true, `${path} should be ignored`);
	}
	assert.equal(isIgnored(entries, ".orchestration", true), true, ".orchestration should be ignored as a directory");
	assert.equal(isIgnored(entries, "app/ts/main.ts", false), false, "a governed file should not be ignored");
});

test("the `.gitignore` matcher handles negation, `**`, and anchored patterns", () => {
	const entries = parseGitignore(["*.log", "!keep.log", "build/", "/root.txt", "docs/**/draft.md", "**/temp/"].join("\n"));
	assert.equal(isIgnored(entries, "debug.log", false), true);
	assert.equal(isIgnored(entries, "keep.log", false), false);
	assert.equal(isIgnored(entries, "a/build/out.js", false), true);
	assert.equal(isIgnored(entries, "root.txt", false), true);
	assert.equal(isIgnored(entries, "sub/root.txt", false), false);
	assert.equal(isIgnored(entries, "docs/a/b/draft.md", false), true);
	assert.equal(isIgnored(entries, "docs/draft.md", false), true);
	assert.equal(isIgnored(entries, "x/temp/file.ts", false), true);
});

test("the `.gitignore` matcher treats a brace group literally, as git does", () => {
	// Git's fnmatch has no brace expansion, so `*.log{,.old}` ignores only a file whose name ends in that literal text, never a tracked `debug.log`.
	const entries = parseGitignore("*.log{,.old}");
	assert.equal(isIgnored(entries, "debug.log", false), false, "git treats the brace group literally, so a tracked file is not ignored");
	assert.equal(isIgnored(entries, "debug.log{,.old}", false), true);
});

test("the `.gitignore` matcher honors a character class", () => {
	const entries = parseGitignore("file[0-9].ts");
	assert.equal(isIgnored(entries, "file1.ts", false), true, "a character class must match the paths it names");
	assert.equal(isIgnored(entries, "filex.ts", false), false);
});

test("the `.gitignore` matcher's `?` matches exactly one character within a path segment", () => {
	const entries = parseGitignore("file?.log");
	assert.equal(isIgnored(entries, "debug/fileA.log", false), true, "a glob with no `/` is matched against the basename at any depth");
	assert.equal(isIgnored(entries, "debug/file.log", false), false, "`?` needs one character");
	assert.equal(isIgnored(entries, "debug/fileAB.log", false), false, "`?` needs exactly one");
	const anchored = parseGitignore("a/b?c");
	assert.equal(isIgnored(anchored, "a/bxc", false), true);
	assert.equal(isIgnored(anchored, "a/b/c", false), false, "`?` cannot cross a `/`");
});

test("the `.gitignore` matcher reads a `**` that is not a whole path segment as plain asterisks", () => {
	// Git's own rule: only a whole-segment `**` crosses `/`; anywhere else the two asterisks match like `*` and stay within one path component.
	const entries = parseGitignore("x/a**b");
	assert.equal(isIgnored(entries, "x/aYb", false), true);
	assert.equal(isIgnored(entries, "x/aY/Zb", false), false, "`a**b` must not cross a `/`");
});

test("a missing root config is reported as a problem, not thrown", async () => {
	const dir = await fixture({});
	try {
		const { files, problems } = await governedFiles(dir);
		assert.deepEqual(files, []);
		assert.deepEqual(problems, [".editorconfig — is missing, so the rules cannot be derived"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the directory walk reports a directory it cannot list instead of throwing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "invoice-style-guard-"));
	try {
		const files = [];
		const problems = [];
		await walk({ dir: join(dir, "gone"), prefix: "gone", sections: [], ignore: [], files, problems });
		assert.deepEqual(files, []);
		assert.deepEqual(problems, ["gone — is missing, so its files cannot be checked"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("every governed file in the real tree follows the resolved rules", async () => {
	const problems = await styleProblems(root);
	assert.deepEqual(problems, [], problems.join("\n"));
});

test("`styleProblems` reports planted violations through the full walk→resolve→check composition", async () => {
	const dir = await fixture({
		".editorconfig": ["root = true", "", "[*]", "charset = utf-8", "end_of_line = lf", "insert_final_newline = true", "trim_trailing_whitespace = true", "", "[*.{ts,css}]", "indent_style = tab", ""].join("\n"),
		"space-indented.ts": "const x = 1;\n  const y = 2;\n",
		"crlf.ts": "const x = 1;\r\n",
		"no-final-newline.ts": "const x = 1;",
		"bom.ts": "\uFEFFconst x = 1;\n",
		"nested/deep/space-indented.css": "a {\n  color: red;\n}\n",
	});
	try {
		const problems = await styleProblems(dir);
		const joined = problems.join("\n");
		assert.ok(problems.some((problem) => problem.startsWith("space-indented.ts:2 —") && problem.includes("indentation uses spaces")), joined);
		assert.ok(problems.some((problem) => problem.startsWith("crlf.ts:1 —") && problem.includes("carriage return")), joined);
		assert.ok(problems.some((problem) => problem.startsWith("no-final-newline.ts —") && problem.includes("no final newline")), joined);
		assert.ok(problems.some((problem) => problem.startsWith("bom.ts:1 —") && problem.includes("byte-order mark")), joined);
		// The nested file is discovered only through the walk, so a missing `resolveProps` wiring or `fileProblems` call makes this assertion fail.
		assert.ok(problems.some((problem) => problem.startsWith("nested/deep/space-indented.css:2 —") && problem.includes("indentation uses spaces")), joined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("`styleProblems` reports a governed file that is not valid UTF-8", async () => {
	const dir = await fixture({
		".editorconfig": ["root = true", "", "[*]", "charset = utf-8", "end_of_line = lf", "insert_final_newline = true", "trim_trailing_whitespace = true", ""].join("\n"),
		"bad.ts": Buffer.from([0x41, 0xff, 0xfe, 0x0a]),
	});
	try {
		const problems = await styleProblems(dir);
		assert.ok(problems.some((problem) => problem.startsWith("bad.ts —") && problem.includes("not valid UTF-8")), problems.join("\n"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("`styleProblems` reports a governed file it cannot read", async () => {
	const dir = await fixture({
		".editorconfig": ["root = true", "", "[*]", "charset = utf-8", ""].join("\n"),
		"unreadable.ts": "const x = 1;\n",
	});
	try {
		// The seam throws EISDIR, a failure the runner's privileges cannot turn into a successful read, so the branch is reached deterministically rather than only under mode enforcement.
		const problems = await styleProblems(dir, {
			read: (path) => {
				if (path.endsWith("unreadable.ts")) throw Object.assign(new Error("EISDIR: illegal operation on a directory"), { code: "EISDIR" });
				return readFileSync(path);
			},
		});
		assert.ok(problems.some((problem) => problem.startsWith("unreadable.ts —") && problem.includes("cannot be read")), problems.join("\n"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a root config without `root = true` is reported", async () => {
	const dir = await fixture({
		".editorconfig": ["[*]", "charset = utf-8", ""].join("\n"),
		"file.ts": "const x = 1;\n",
	});
	try {
		const problems = await styleProblems(dir);
		assert.ok(problems.some((problem) => problem.includes("root = true")), problems.join("\n"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("an unmodelled glob construct is reported rather than silently narrowing the guard", async () => {
	const dir = await fixture({
		".editorconfig": ["root = true", "", "[*]", "charset = utf-8", "indent_style = tab", "", "[file[0-9].ts]", "indent_style = tab", "", "[log{1..3}.txt]", "charset = utf-8", ""].join("\n"),
		"file1.ts": "const x = 1;\n",
		"log2.txt": "x\n",
	});
	try {
		const problems = await styleProblems(dir);
		assert.ok(problems.some((problem) => problem.includes("character class")), problems.join("\n"));
		assert.ok(problems.some((problem) => problem.includes("numeric range")), problems.join("\n"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the guard does not report the brace groups it models", async () => {
	const dir = await fixture({
		".editorconfig": ["root = true", "", "[*]", "charset = utf-8", "", "[*.{ts,js}]", "indent_style = tab", ""].join("\n"),
		"file.ts": "const x = 1;\n",
	});
	try {
		const problems = await styleProblems(dir);
		assert.deepEqual(problems, [], problems.join("\n"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a config value the guard cannot check is reported once, not once per governed file", async () => {
	const dir = await fixture({
		".editorconfig": ["root = true", "", "[*]", "charset = utf-8", "end_of_line = crlf", ""].join("\n"),
		"a.ts": "const x = 1;\n",
		"b.ts": "const x = 2;\n",
		"nested/c.ts": "const x = 3;\n",
	});
	try {
		const problems = await styleProblems(dir);
		const crlf = problems.filter((problem) => problem.includes("cannot enforce end_of_line = crlf"));
		assert.equal(crlf.length, 1, problems.join("\n"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("`styleProblems` reports a config key the guard does not enforce", async () => {
	const dir = await fixture({
		".editorconfig": ["root = true", "", "[*]", "charset = utf-8", "max_line_length = 100", ""].join("\n"),
		"a.ts": "const x = 1;\n",
	});
	try {
		const problems = await styleProblems(dir);
		assert.ok(problems.some((problem) => problem.includes("max_line_length")), problems.join("\n"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the guard reports a byte-order mark", () => {
	const problems = check("\uFEFFconst x = 1;\n");
	assert.ok(problems.some((problem) => problem.includes("byte-order mark")), problems.join("\n"));
});

test("the guard reports a carriage return", () => {
	const problems = check("const x = 1;\r\n");
	assert.ok(problems.some((problem) => problem.startsWith("fixture.ts:1 —") && problem.includes("carriage return")), problems.join("\n"));
});

test("the guard reports a missing final newline", () => {
	assert.deepEqual(check("const x = 1;"), ["fixture.ts — no final newline"]);
});

test("a single trailing newline is required and a blank line after it is not forbidden", () => {
	assert.deepEqual(check("const x = 1;\n\n"), []);
});

test("the guard reports trailing whitespace", () => {
	const problems = check("const x = 1; \n");
	assert.ok(problems.some((problem) => problem.startsWith("fixture.ts:1 —") && problem.includes("trailing whitespace")), problems.join("\n"));
});

test("the guard reports space indentation where the contract is tabs", () => {
	const problems = check("const x = 1;\n  const y = 2;\n");
	assert.ok(problems.some((problem) => problem.includes("indentation uses spaces")), problems.join("\n"));
});

test("a conforming file reports nothing", () => {
	assert.deepEqual(check("const x = 1;\n\tconst y = 2;\n"), []);
});

test("the tab rule reaches `.svg` and `.json`, as `.editorconfig` says", () => {
	assert.ok(check("  indented\n", "assets-src/images/logo.svg").some((problem) => problem.includes("indentation uses spaces")));
	assert.ok(check("  indented\n", "tsconfig.json").some((problem) => problem.includes("indentation uses spaces")));
});

test("the tab rule does not reach prose, but the line rules do", () => {
	assert.deepEqual(check("  indented by spaces\n", "README.md"), []);
	assert.ok(check("x \n", "README.md").some((problem) => problem.includes("trailing whitespace")));
});

test("a key resolved to `unset` is not enforced, including the charset decode", () => {
	assert.deepEqual(fileProblems({ label: "excluded/x.js", props: { charset: "unset", end_of_line: "unset", insert_final_newline: "unset", trim_trailing_whitespace: "unset", indent_style: "unset" }, bytes: Buffer.from([0xff, 0xfe, 0x00]) }), []);
});

test("a JSDoc continuation line is exempt from the tab rule", () => {
	assert.deepEqual(check("/**\n * doc\n */\nconst x = 1;\n"), []);
});

test("a hand-wrapped HTML comment is exempt from the tab rule", () => {
	assert.deepEqual(check("<!--\n  wrapped\n-->\n<div></div>\n", "app/index.html"), []);
});

test("a hand-wrapped SVG comment is exempt from the tab rule, as HTML's is", () => {
	assert.deepEqual(check("<!--\n  wrapped\n-->\n<svg></svg>\n", "assets-src/images/logo.svg"), []);
});

test("a line comment's own indentation is still checked", () => {
	const problems = check("const x = 1;\n  // note\n");
	assert.ok(problems.some((problem) => problem.includes("indentation uses spaces")), problems.join("\n"));
});

test("a `//` inside a CSS `url()` does not open a phantom comment", () => {
	const text = "a {\n\tbackground: url(//host/a.png);\n}\n/*\n * doc\n */\n";
	assert.deepEqual([...commentContinuationLines(text, { language: "css" })], [4, 5]);
	assert.deepEqual(check(text, "app/stylesheets/app.css"), []);
});

test("a regex literal with a quote does not desync the comment scanner", () => {
	const text = "const pattern = /[\"'`]value/;\n/**\n * doc\n */\n";
	assert.deepEqual([...commentContinuationLines(text, { language: "js" })], [2, 3]);
	assert.deepEqual(check(text), []);
});

test("the CSS model keeps a `//` url as code while the default model masks it", () => {
	const text = "background: url(//host/a.png);\n";
	assert.equal(codeOnly(text, { language: "css" }), text);
	assert.ok(codeOnly(text).includes("url( "));
});

test("the guard's enforced keys resolve only to values it can check on the real tree", async () => {
	const { files } = await governedFiles(root);
	assert.deepEqual(unsupportedValueProblems(files), []);
});

test("every key in `ENFORCED_KEYS` has a `fileProblems` branch that reports a violation", () => {
	// Each enforced key must have a fixture that violates it and a `fileProblems` branch that reports it; a key added to `ENFORCED_KEYS` without one fails here instead of passing validation while enforcing nothing.
	const violations = {
		charset: { value: "utf-8", text: "\uFEFFconst x = 1;\n", reason: "byte-order mark" },
		end_of_line: { value: "lf", text: "const x = 1;\r\n", reason: "carriage return" },
		insert_final_newline: { value: "true", text: "const x = 1;", reason: "no final newline" },
		trim_trailing_whitespace: { value: "true", text: "const x = 1; \n", reason: "trailing whitespace" },
		indent_style: { value: "tab", text: "const x = 1;\n  const y = 2;\n", reason: "indentation uses spaces" },
	};
	for (const [key, supported] of Object.entries(ENFORCED_KEYS)) {
		const violation = violations[key];
		assert.ok(violation, `ENFORCED_KEYS names ${key}, but no violating fixture exercises it`);
		assert.ok(supported.includes(violation.value), `the ${key} fixture uses ${violation.value}, which the guard does not claim to check`);
		const problems = fileProblems({ label: "fixture.ts", props: { [key]: violation.value }, bytes: Buffer.from(violation.text) });
		assert.ok(problems.some((problem) => problem.includes(violation.reason)), `${key} is in ENFORCED_KEYS but reports no violation: ${problems.join(", ")}`);
	}
});

test("`unsupportedValueProblems` reports every enforced key set to a value the guard cannot check", () => {
	const files = [{ label: "a.ts", props: { charset: "latin1", end_of_line: "crlf", insert_final_newline: "false", trim_trailing_whitespace: "true", indent_style: "space" } }];
	const problems = unsupportedValueProblems(files);
	for (const key of ["charset", "end_of_line", "insert_final_newline", "indent_style"]) {
		assert.ok(problems.some((problem) => problem.includes(`cannot enforce ${key} =`)), problems.join("\n"));
	}
	assert.ok(!problems.some((problem) => problem.includes("trim_trailing_whitespace")), problems.join("\n"));
});

test("a config value the guard cannot check surfaces through `styleProblems` instead of enforcing nothing", async () => {
	const dir = await fixture({
		".editorconfig": ["root = true", "", "[*]", "charset = utf-8", "end_of_line = crlf", "insert_final_newline = true", "trim_trailing_whitespace = true", ""].join("\n"),
		"file.txt": "hello\n",
	});
	try {
		const problems = await styleProblems(dir);
		assert.ok(problems.some((problem) => problem.includes("cannot enforce end_of_line = crlf")), problems.join("\n"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
