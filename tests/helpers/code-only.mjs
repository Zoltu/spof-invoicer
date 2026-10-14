/** The comment and regex scanner the two static sweeps share: it masks comments so only executable code is matched, and marks comment-continuation lines for the indent rule. */

import { extname } from "node:path";

/**
 * The comment model to scan a path with, chosen by extension: `"js"` for `.ts`/`.js`/`.mjs`, `"css"` for `.css`, `"html"` for `.html`/`.svg` (its `<!-- -->` spans), and `null` for a file with no comment syntax to exempt.
 * The acceptance sweep and the style guard both call this and pass the result to `scan`, so the two consumers read one model and cannot drift apart.
 */
export function languageFor(label) {
	const extension = extname(label).toLowerCase();
	if (extension === ".ts" || extension === ".js" || extension === ".mjs") return "js";
	if (extension === ".css") return "css";
	if (extension === ".html" || extension === ".svg") return "html";
	return null;
}

/**
 * Mask every comment in `text` with spaces, keeping length and line breaks, so a sweep matches only what a browser would execute: the CSP rationale in index.html names the very APIs the acceptance sweep forbids, and so does the vendored pdf-lib JSDoc.
 * A small state machine rather than a regex, so a `//` or `<!--` inside a string cannot clip the line it sits on; string literals are kept, since a call cannot hide inside one.
 * Regex literals are tracked too: without that, a quote or a `//` inside a pattern such as `/["'`]script/` would flip the machine into a string or comment state and desync the rest of the file.
 * The `language` option (default `"js"`) picks the comment syntax: `"js"` runs the full state machine, `"html"` additionally masks `<!-- … -->` spans, and `"css"` is a block-only model so a `//` inside a declaration value such as `url(//host/a.png)` cannot open a phantom line comment.
 * The `htmlComments` option (default `false`) additionally masks `<!-- … -->` spans for the default JavaScript model; only the index.html sweep sets it, so the policy rationale's prose is never mistaken for code it is not.
 * `scan` is the one model this masker and {@link commentContinuationLines} both read, so the comment-masking sweeps and the style guard cannot drift apart.
 */
export function codeOnly(text, { language = "js", htmlComments = false } = {}) {
	const chars = [...text];
	const kinds = scan(text, { language, htmlComments });
	let masked = "";
	for (let index = 0; index < chars.length; index += 1) {
		masked += kinds[index] === "code" || kinds[index] === "string" || chars[index] === "\n" ? chars[index] : " ";
	}
	return masked;
}

/**
 * Classify each character of `text` as `"code"`, `"string"`, or the comment kind it belongs to (`"line"`, `"block"`, `"html"`), so a caller can tell a string literal from code and skip a comment.
 * It exposes the scan {@link codeOnly} masks with, so a consumer that needs the string spans — the static-import scan — reads one state machine rather than a second one that could drift from it.
 */
export function scanKinds(text, { language = "js", htmlComments = false } = {}) {
	return scan(text, { language, htmlComments });
}

/**
 * The 0-based indices of the lines that begin inside a block, HTML, or CSS block comment opened on an earlier line.
 * Such a line is exempt from the indent rule: JSDoc's ` * ` continuation and a hand-wrapped HTML comment carry alignment spaces that cannot be indentation, and an editor does not reformat either.
 * The line that opens the comment is not exempt, nor is a line that starts in code — a `}` under indentation, or the `//` opening a line comment — so a tab-then-spaces indent is still caught.
 */
export function commentContinuationLines(text, { language = "js", htmlComments = false } = {}) {
	const chars = [...text];
	const kinds = scan(text, { language, htmlComments });
	const inside = new Set();
	let line = 0;
	for (let index = 0; index < chars.length; index += 1) {
		if (chars[index] !== "\n") continue;
		line += 1;
		if (kinds[index] === "block" || kinds[index] === "html") inside.add(line);
	}
	return inside;
}

/**
 * Classify each character as `"code"`, `"string"`, or the comment kind it belongs to (`"line"`, `"block"`, `"html"`), which is all a comment mask or a comment-continuation check needs.
 * The `"js"` model is the state machine below and marks every string literal `"string"`, which {@link codeOnly} keeps and {@link scanKinds} exposes; `"html"` adds HTML-comment spans, and `"css"` is block-only, so it yields `"code"` and `"block"` alone.
 */
function scan(text, { language, htmlComments }) {
	if (language === "css") return scanCss(text);
	return scanJs(text, { htmlComments: htmlComments || language === "html" });
}

/** A newline carries the kind of the comment it is inside, so a caller can tell which line a comment already spanned when it started. */
function scanJs(text, { htmlComments }) {
	const chars = [...text];
	const kinds = new Array(chars.length).fill("code");
	let state = null;
	let inClass = false;
	for (let index = 0; index < chars.length; index += 1) {
		const char = chars[index];
		const next = chars[index + 1];
		if (state === null) {
			if (htmlComments && chars.slice(index, index + 4).join("") === "<!--") {
				kinds[index] = kinds[index + 1] = kinds[index + 2] = kinds[index + 3] = "html";
				state = "html";
				index += 3;
				continue;
			}
			if (char === "/" && next === "/") {
				kinds[index] = "line";
				state = "//";
				continue;
			}
			if (char === "/" && next === "*") {
				kinds[index] = "block";
				state = "/*";
				continue;
			}
			if (char === "/" && regexAllowed(chars, index) && hasClosingSlash(chars, index)) {
				state = "regex";
				inClass = false;
				continue;
			}
			if (char === "\"" || char === "'" || char === "`") state = char;
			if (state === char) kinds[index] = "string";
			continue;
		}
		if (state === "//") {
			if (char === "\n") state = null;
			else kinds[index] = "line";
			continue;
		}
		if (state === "/*") {
			if (char === "*" && next === "/") {
				kinds[index] = "block";
				kinds[index + 1] = "block";
				state = null;
				index += 1;
				continue;
			}
			kinds[index] = "block";
			continue;
		}
		if (state === "html") {
			if (chars.slice(index, index + 3).join("") === "-->") {
				kinds[index] = kinds[index + 1] = kinds[index + 2] = "html";
				state = null;
				index += 2;
				continue;
			}
			kinds[index] = "html";
			continue;
		}
		if (state === "regex") {
			if (char === "\\") {
				index += 1;
				continue;
			}
			if (char === "[") {
				inClass = true;
				continue;
			}
			if (char === "]") {
				inClass = false;
				continue;
			}
			if (char === "/" && !inClass) {
				state = null;
				continue;
			}
			if (char === "\n") state = null;
			continue;
		}
		kinds[index] = "string";
		if (char === "\\") {
			if (index + 1 < chars.length) kinds[index + 1] = "string";
			index += 1;
			continue;
		}
		if (char === state) state = null;
	}
	return kinds;
}

/**
 * CSS's only comment is the block comment, so this model recognizes its opening delimiter and everything up to the closing one, and nothing else.
 * A quoted string is tracked so a `/*` inside one cannot open a comment the language does not have; a URL is not a string in CSS, so a `//` in `url(//host/path)` stays code rather than opening a line comment the language does not have either.
 */
function scanCss(text) {
	const chars = [...text];
	const kinds = new Array(chars.length).fill("code");
	let inBlock = false;
	let quote = null;
	for (let index = 0; index < chars.length; index += 1) {
		const char = chars[index];
		const next = chars[index + 1];
		if (quote !== null) {
			if (char === "\\") {
				index += 1;
				continue;
			}
			if (char === quote) quote = null;
			continue;
		}
		if (inBlock) {
			if (char === "*" && next === "/") {
				kinds[index] = "block";
				kinds[index + 1] = "block";
				inBlock = false;
				index += 1;
				continue;
			}
			kinds[index] = "block";
			continue;
		}
		if (char === "/" && next === "*") {
			kinds[index] = "block";
			kinds[index + 1] = "block";
			inBlock = true;
			index += 1;
			continue;
		}
		if (char === "\"" || char === "'") quote = char;
	}
	return kinds;
}

/** The keywords that may be followed by a regex literal, so a `/` after `return` is not read as division. */
const REGEX_KEYWORDS = new Set(["case", "delete", "do", "else", "in", "instanceof", "new", "of", "return", "typeof", "void", "yield", "await"]);

/**
 * Whether a `/` in code position starts a regex literal rather than a division.
 * A `/` after a value — an identifier, a number, a string, `)` or `]` — is division; after any other token, or a value keyword, it is a regex.
 */
function regexAllowed(chars, index) {
	let back = index - 1;
	while (back >= 0 && chars[back] !== "\n" && /\s/.test(chars[back])) back -= 1;
	if (back < 0 || chars[back] === "\n") return true;
	const previous = chars[back];
	if (!/[A-Za-z0-9_$]/.test(previous)) return !/[)\]"'`]/.test(previous);
	if (/[0-9]/.test(previous)) return false;
	let start = back;
	while (start >= 0 && /[A-Za-z0-9_$]/.test(chars[start])) start -= 1;
	return REGEX_KEYWORDS.has(chars.slice(start + 1, back + 1).join(""));
}

/** Whether an unescaped `/` closes a regex before the line ends; a `/` that does not is read as division, which keeps a mis-guessed start from swallowing the rest of the file. */
function hasClosingSlash(chars, start) {
	let inClass = false;
	for (let index = start + 1; index < chars.length; index += 1) {
		const char = chars[index];
		if (char === "\n") return false;
		if (char === "\\") {
			if (chars[index + 1] === "\n" || chars[index + 1] === undefined) return false;
			index += 1;
			continue;
		}
		if (char === "[") {
			inClass = true;
			continue;
		}
		if (char === "]") {
			inClass = false;
			continue;
		}
		if (char === "/" && !inClass) return true;
	}
	return false;
}
