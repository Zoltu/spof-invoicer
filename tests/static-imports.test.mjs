/** Focused tests for the static-import scan and walk in `tests/helpers/static-imports.mjs`. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { emittedStaticTarget, repoRelativeTarget, staticImportReach, staticImportSpecifiers } from "./helpers/static-imports.mjs";

test("the scanner reads every static-import spelling and ignores a dynamic one", () => {
	for (const source of [
		'import { a } from "./a.js";',
		"import { a } from './a.js';",
		'import "./a.js";',
		'export { a } from "./a.js";',
		'const a = require("./a.js");',
	]) {
		assert.deepEqual(staticImportSpecifiers(source), ["./a.js"], source);
	}
	for (const source of ['await import("./a.js")', "const load = () => import('./a.js')"]) {
		assert.deepEqual(staticImportSpecifiers(source), [], source);
	}
});

test("the scanner reads no specifier out of a comment or an ordinary string", () => {
	for (const source of [
		'// see import "./ghost.js" for the old spelling',
		'/* from "./ghost.js" */',
		`const doc = "import './ghost.js'";`,
		`const doc = 'require("./ghost.js")';`,
	]) {
		assert.deepEqual(staticImportSpecifiers(source), [], source);
	}
});

test("the walk follows a real relative edge and is not fooled by a comment-only one", () => {
	const graph = new Map([
		["app/js/a.js", '// import "./ghost.js"\nimport { b } from "./b.js";'],
		["app/js/b.js", "export const b = 1;"],
	]);
	const reached = staticImportReach("app/js/a.js", (file) => graph.get(file) ?? null, repoRelativeTarget);
	assert.deepEqual([...reached].sort(), ["app/js/a.js", "app/js/b.js"]);
});

test("the walk fails closed on a target it cannot read", () => {
	assert.throws(() => staticImportReach("app/js/a.js", () => null), /not a readable file/);
});

test("the target resolvers name a repo module only for a relative specifier", () => {
	assert.equal(emittedStaticTarget("app/js/pdf/renderer.js", "./rasterize.js"), "app/js/pdf/rasterize.js");
	assert.equal(emittedStaticTarget("app/js/pdf/renderer.js", "../pdf/rasterize.js"), "app/js/pdf/rasterize.js");
	assert.equal(emittedStaticTarget("app/js/pdf/renderer.js", "pdf-lib"), null);
	assert.equal(emittedStaticTarget("app/js/pdf/renderer.js", "../../../../escape.js"), null);
	assert.equal(emittedStaticTarget("app/js/pdf/renderer.js", "../../js/vendor/pdf-lib/pdf-lib.esm.js"), null, "the copied vendor tree is a leaf");
	assert.equal(repoRelativeTarget("app/js/util/dom.js", "../../js/vendor/x.js"), "app/js/vendor/x.js", "the util guard still follows the vendor tree so it can report a vendored edge");
});
