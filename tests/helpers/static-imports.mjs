/**
 * The static-import scan and graph walk the two emitted-tree guards share.
 *
 * `tests/pdf.test.mjs` reads the emitted renderer's static imports to prove the browser-only rasterizer is reached only dynamically, and `tests/util.test.mjs` reads the emitted builder's static graph to prove `h()` carries no encoding or vendored module; both read one scan and one walk here, so the two guards cannot drift apart.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { scanKinds } from "./code-only.mjs";

/** The workspace root: the directory holding `app/`, `tests/`, and the rest, one level above this helper's own directory. */
export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The static import specifiers of a module, in any spelling that would put another module in its graph: a side-effect `import "…"`, a `from "…"` clause on an `import` or `export`, or a `require("…")` call, in either quote.
 * The source is read through the shared scan, so a specifier quoted in a doc comment or an ordinary string adds no edge: only the string an `import`, an `export … from`, or a `require(…)` clause names is read, and a dynamic `import("…")` is deliberately not one of them because it evaluates the module where it is called rather than when the importer is evaluated.
 */
export function staticImportSpecifiers(source) {
	const chars = [...source];
	const kinds = scanKinds(source, { language: "js" });
	const specifiers = [];
	let index = 0;
	while (index < chars.length) {
		if (kinds[index] !== "string") {
			index += 1;
			continue;
		}
		let end = index + 1;
		while (end < chars.length && kinds[end] === "string") end += 1;
		const quote = chars[index];
		const text = chars.slice(index, end).join("");
		if ((quote === "\"" || quote === "'") && text.length >= 2 && text.endsWith(quote) && precedesImportKeyword(chars, index)) {
			specifiers.push(text.slice(1, -1));
		}
		index = end;
	}
	return specifiers;
}

/**
 * Whether the string literal that opens at `index` is named by an `import`/`export … from` clause or a `require(…)` call rather than being an ordinary string.
 * The identifier is read back whole over any whitespace, so `from\n"…"` still counts and a longer name that merely ends in `from` does not.
 */
function precedesImportKeyword(chars, index) {
	let back = index - 1;
	while (back >= 0 && /\s/.test(chars[back])) back -= 1;
	if (back < 0) return false;
	if (chars[back] === "(") {
		back -= 1;
		while (back >= 0 && /\s/.test(chars[back])) back -= 1;
		return identifierEndingAt(chars, back) === "require";
	}
	const word = identifierEndingAt(chars, back);
	return word === "from" || word === "import";
}

/** The identifier whose final character is at `end`, or the empty string when `end` is not an identifier character. */
function identifierEndingAt(chars, end) {
	let start = end;
	while (start >= 0 && /[A-Za-z0-9_$]/.test(chars[start])) start -= 1;
	return chars.slice(start + 1, end + 1).join("");
}

/**
 * The repo-relative path a static specifier names against `importer`'s own directory, or `null` when it names no module of the repo's own tree.
 * Only a relative specifier is a candidate; a bare specifier and a path that escapes the workspace are leaves rather than edges.
 */
export function repoRelativeTarget(importer, specifier) {
	if (!specifier.startsWith(".")) return null;
	const target = relative(root, resolve(dirname(join(root, importer)), specifier)).split(sep).join("/");
	return target.startsWith("..") ? null : target;
}

/**
 * The repo-relative emitted module a static specifier names, or `null` when it names no module of the emitted `app/js/` tree the renderer guard walks.
 * The specifier is resolved against the importer's own directory, so `./rasterize.js` and `../pdf/rasterize.js` from one importer name the same module whatever the spelling; the copied vendor tree is a leaf rather than an edge.
 */
export function emittedStaticTarget(importer, specifier) {
	const target = repoRelativeTarget(importer, specifier);
	return target !== null && target.startsWith("app/js/") && !target.startsWith("app/js/vendor/") ? target : null;
}

/** The source of an emitted module, or `null` when the path is not a readable regular file: an absent path, a directory, or any other non-file a resolved specifier might name. */
export function readEmittedModule(file) {
	const path = join(root, file);
	return existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : null;
}

/**
 * The repo's own modules reachable from `entry` through static imports: each module's static specifiers are resolved with `follow` and followed, so a chain through any module is walked exactly as a direct import is.
 * A dynamic `import()` adds no edge, which is the lazy-loading property the renderer guard protects.
 * The walk fails closed: a reached module whose `read` yields `null` — absent, a directory, or otherwise not a readable file — throws rather than counting as a leaf, so a spelling the resolver does not recognize fails the test instead of passing it vacuously, and a missing entry module fails it too.
 */
export function staticImportReach(entry, read = readEmittedModule, follow = emittedStaticTarget) {
	const reached = new Set();
	const pending = [entry];
	while (pending.length > 0) {
		const file = pending.pop();
		if (reached.has(file)) continue;
		reached.add(file);
		const source = read(file);
		if (source === null) {
			throw new Error(`the static-import walk resolved a static specifier to ${file}, which is not a readable file`);
		}
		for (const specifier of staticImportSpecifiers(source)) {
			const target = follow(file, specifier);
			if (target !== null) pending.push(target);
		}
	}
	return reached;
}
