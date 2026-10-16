/**
 * Focused tests for the comment/regex state machine in `tests/helpers/code-only.mjs`.
 *
 * The machine gates three consumers: `tests/slow/acceptance.test.mjs` masks comments before it looks for network APIs and markup sinks, the style guard exempts comment-continuation lines from the indent rule with the same scan, and `tests/helpers/static-imports.mjs` reads the scan's per-character kinds to find the string spans a module's imports sit in, so a mis-read here hides real code, hides a violation, or reads an import out of a doc comment.
 * Each case pins the behavior those consumers depend on: comments are masked, the mask preserves length and line count, only continuation lines are exempt, and `scanKinds` reports the same scan character by character — a string literal's characters are the `"string"` kind, which `codeOnly` keeps in its mask rather than blanking, while every other character is `"code"` or the comment kind it belongs to.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { codeOnly, commentContinuationLines, languageFor, scanKinds } from "./helpers/code-only.mjs";

/** Mask `text` the way the comment masker must: replace each fragment with spaces of the same length. */
function blanked(text, ...fragments) {
	let out = text;
	for (const fragment of fragments) {
		assert.ok(out.includes(fragment), `the fixture is missing ${JSON.stringify(fragment)}`);
		out = out.replace(fragment, " ".repeat(fragment.length));
	}
	return out;
}

test("languageFor picks the one comment model both consumers share", () => {
	for (const label of ["a.ts", "a.js", "a.mjs", "dir/nested/code.ts"]) assert.equal(languageFor(label), "js", label);
	assert.equal(languageFor("a.css"), "css");
	assert.equal(languageFor("a.html"), "html");
	assert.equal(languageFor("assets/logo.svg"), "html");
	assert.equal(languageFor("a.json"), null);
	assert.equal(languageFor("README.md"), null);
	assert.equal(languageFor("Makefile"), null);
});

test("a `/` after `=` opens a regex, so its escaped slashes are not read as a comment", () => {
	const source = "const url = /a\\/\\/b/; // real\n";
	assert.equal(codeOnly(source), blanked(source, "// real"));
});

test("a `/` between values is division, and a trailing comment is still masked", () => {
	const source = "const half = a / b / c; // real\n";
	assert.equal(codeOnly(source), blanked(source, "// real"));
});

test("a `//` inside a string is not a comment", () => {
	const source = "const s = \"text // still string\"; // real\n";
	assert.equal(codeOnly(source), blanked(source, "// real"));
});

test("a `//` comment does not end at a quote, and the next line stays code", () => {
	const source = "// he said \"hi\nconst x = 1;\n";
	assert.equal(codeOnly(source), blanked(source, "// he said \"hi"));
});

test("a quote inside a block comment does not desync the scanner", () => {
	const source = "/* don't */ const x = 1;\n";
	assert.equal(codeOnly(source), blanked(source, "/* don't */"));
});

test("a division after `}` with no closing slash on the line stays code", () => {
	const source = "const half = { numerator: 1 } / 2;\n// note\n";
	assert.equal(codeOnly(source), blanked(source, "// note"));
});

test("a `/` after `}` reads as a regex start, but the mis-guess only leaves code unmasked", () => {
	// A `}` may close an object literal, so this `/` is really division; the scanner reads it as a regex start and closes it at the trailing comment's first slash, leaving the comment unmasked.
	// The mis-guess cannot mask real code, which is the direction the security sweep depends on: a token inside such a comment is flagged rather than hidden.
	const source = "const half = { numerator: 1 } / 2; // note\n";
	assert.equal(codeOnly(source), source);
});

test("a `//` inside a template literal is not a comment", () => {
	const source = "const t = `a // b`; // real\n";
	assert.equal(codeOnly(source), blanked(source, "// real"));
});

test("a quote inside a template literal does not desync the scanner", () => {
	const source = "const t = `it's // fine`; // real\n";
	assert.equal(codeOnly(source), blanked(source, "// real"));
});

test("a `${}` interpolation is kept as template text", () => {
	const source = "const t = `${a / b}`; // real\n";
	assert.equal(codeOnly(source), blanked(source, "// real"));
});

test("the mask preserves length and line count for the acceptance sweep", () => {
	const source = "const a = 1; // note\n/* two\nlines */ const b = 2;\n";
	const masked = codeOnly(source);
	assert.equal(masked.length, source.length);
	assert.equal(masked.split("\n").length, source.split("\n").length);
	assert.ok(!masked.includes("note"));
	assert.ok(!masked.includes("two"));
	assert.ok(masked.includes("const b = 2;"));
});

test("the acceptance sweep's htmlComments option masks HTML comment prose", () => {
	const source = "<!-- names fetch -->\n<div>code</div>\n";
	assert.equal(codeOnly(source), source);
	assert.ok(!codeOnly(source, { htmlComments: true }).includes("fetch"));
	assert.ok(codeOnly(source, { htmlComments: true }).includes("<div>code</div>"));
});

test("scanKinds reports a string literal's characters as the string kind, one kind per character", () => {
	const source = "const url = \"fetch(/x/)\"; // tail\n";
	const chars = [...source];
	const kinds = scanKinds(source);
	assert.equal(kinds.length, chars.length, "the scan is index-aligned with the code points it read");
	const first = chars.indexOf("\"");
	const last = chars.lastIndexOf("\"");
	for (let index = first; index <= last; index += 1) {
		assert.equal(kinds[index], "string", `character ${index} of the literal is string text`);
	}
	assert.equal(kinds[0], "code", "the declaration around it is code");
	assert.equal(kinds[source.indexOf("//")], "line", "and the trailing comment is a comment, not a string");
	assert.equal(kinds.join("").includes("string"), true, "the string kind is what the static-import scan reads");
});

test("scanKinds keeps the scan in step through an escaped quote and a template literal", () => {
	const escaped = "const s = \"a \\\" b\"; // tail\n";
	const escapedChars = [...escaped];
	const escapedKinds = scanKinds(escaped);
	const first = escapedChars.indexOf("\"");
	const last = escapedChars.lastIndexOf("\"");
	for (let index = first; index <= last; index += 1) {
		assert.equal(escapedKinds[index], "string", `escaped literal, character ${index}`);
	}
	assert.equal(escapedKinds[escaped.indexOf("//")], "line", "the escaped quote does not desync the scanner");

	const template = "const t = `a // b`; // tail\n";
	const templateKinds = scanKinds(template);
	assert.equal(templateKinds[template.indexOf("//")], "string", "the `//` inside the template is string text");
	assert.equal(templateKinds[template.lastIndexOf("//")], "line", "and the `//` after the template is the comment");
});

test("scanKinds reports a quote inside a comment as the comment it is, never as a string", () => {
	const source = "// it's a comment\n";
	const kinds = scanKinds(source);
	assert.deepEqual([...new Set(kinds.slice(0, source.indexOf("\n")))], ["line"]);
	assert.equal(kinds.join("").includes("string"), false, "no character of the comment is string text");
});

test("scanKinds reads the same options codeOnly masks with", () => {
	const html = "<!-- fetch -->\n<div>code</div>\n";
	const htmlKinds = scanKinds(html, { htmlComments: true });
	assert.equal(htmlKinds[html.indexOf("fetch")], "html", "an HTML comment span is its own kind, not code");
	assert.equal(htmlKinds[html.indexOf("<div>")], "code", "and the markup outside it is code");

	// The CSS model recognizes block comments alone, so a `/*` inside a quoted value is not a comment and no character of the value is a string either.
	const css = "a {\n\tcontent: \"/*\";\n}\n";
	assert.deepEqual([...new Set(scanKinds(css, { language: "css" }))], ["code"]);
});

test("commentContinuationLines marks continuation lines only, never the opening line", () => {
	const source = "const a = 1;\n/*\n * doc\n */\nconst b = 2;\n";
	assert.deepEqual([...commentContinuationLines(source)], [2, 3]);
	assert.deepEqual([...commentContinuationLines("const a = 1;\n// c\nconst b = 2;\n")], []);
});

test("commentContinuationLines treats HTML spans as comments only when asked", () => {
	const source = "<!--\n  wrapped\n-->\n<div></div>\n";
	assert.deepEqual([...commentContinuationLines(source)], []);
	assert.deepEqual([...commentContinuationLines(source, { htmlComments: true })], [1, 2]);
});

test("the CSS language model is block-only, so a `//` in a url is not a comment", () => {
	const source = "a {\n\tbackground: url(//host/a.png);\n}\n";
	assert.deepEqual([...commentContinuationLines(source, { language: "css" })], []);
	assert.equal(codeOnly(source, { language: "css" }), source);
	// The default JavaScript model reads the `//` as a line comment and masks the rest of that line.
	assert.ok(codeOnly(source).includes("url( "));
});

test("the CSS language model still exempts a block-comment continuation line", () => {
	const source = "a {\n}\n/*\n * doc\n */\nb {}\n";
	assert.deepEqual([...commentContinuationLines(source, { language: "css" })], [3, 4]);
});

test("the CSS language model does not open a comment inside a quoted string", () => {
	const source = "a {\n\tcontent: \"/*\";\n}\nb {\n}\n";
	assert.deepEqual([...commentContinuationLines(source, { language: "css" })], []);
	assert.equal(codeOnly(source, { language: "css" }), source);
});

test("the CSS language model still opens a block comment after a quoted value", () => {
	const source = "a {\n\tcontent: \"/*\";\n}\n/*\n * doc\n */\n";
	assert.deepEqual([...commentContinuationLines(source, { language: "css" })], [4, 5]);
});
