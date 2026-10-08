/**
 * The repo's style guard, kept as a helper so a test can drive the checker against a synthetic violation as well as the real tree.
 *
 * The scope and the rules both derive from the root `.editorconfig` at run time: `parseEditorConfig` reads the ordered sections, `resolveProps` resolves the effective properties for a path, and `governedFiles` walks the tree, pruning a directory only when a section whose brace-expanded pattern is a `ROOT/**` at that directory or one of its ancestors sets every enforced key to `unset` and no later section could match a path under the directory while enforcing a key.
 * The reach predicate behind that pruning is conservative by construction: a basename-anchored pattern could match under any directory, a path-anchored one is compared by its leading literal segments, and anything the predicate cannot pin exactly keeps the directory walked, so a governed subtree is never silently dropped.
 * The single-root-file assumption is enforced, not silent: an editor would honour a nested `.editorconfig`, so the walk reports one as a problem rather than sweeping the tree under rules the editor does not use, and `configProblems` reports when the root file does not declare `root = true`.
 * What this module fixes in code is how each enforced key is checked (`ENFORCED_KEYS`) and where the comment-continuation exemption comes from (`languageFor` and `commentContinuationLines`, both shared with the acceptance sweep); the config supplies which keys a path carries and what value each carries, not how to test for a BOM or a carriage return.
 * A config value the guard cannot check is reported by `unsupportedValueProblems`, a key the config sets that the guard does not enforce by `unenforcedKeyProblems`, and a glob construct the matcher does not model (character classes, numeric ranges) by `unmodelledGlobProblems`, so a config the guard cannot fully honour fails loudly instead of quietly shrinking the guarded set.
 * A violation is reported as `path:line — reason`; a missing root config, directory, or unreadable file is returned as a problem string rather than thrown, so a failure always names what to fix, while any other listing failure surfaces as its own error.
 */

import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { commentContinuationLines, languageFor } from "./code-only.mjs";

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** The keys the guard enforces, each mapped to the `.editorconfig` values it knows how to check; an `unset` or absent key means that path is out of scope for the key. */
export const ENFORCED_KEYS = {
	charset: ["utf-8"],
	end_of_line: ["lf"],
	insert_final_newline: ["true"],
	trim_trailing_whitespace: ["true"],
	indent_style: ["tab"],
};

/**
 * The one character-level glob translator's two modes.
 * `EDITORCONFIG_GLOB` leaves `[` literal, since an EditorConfig glob is only `*`, `?`, `**` and `{a,b}`; `GIT_GLOB` reads `[...]` as a character class, as git's fnmatch does.
 */
const EDITORCONFIG_GLOB = { characterClasses: false };
const GIT_GLOB = { characterClasses: true };

/** Parse `.editorconfig` text into its ordered `{ glob, props }` sections, values lower-cased and trimmed, `#`/`;` comments and blank lines dropped and the `root` preamble ignored. */
export function parseEditorConfig(text) {
	const sections = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
		const header = /^\[(.*)\]$/.exec(line);
		if (header !== null) {
			sections.push({ glob: header[1], props: {} });
			continue;
		}
		const property = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
		if (property === null || sections.length === 0) continue;
		sections[sections.length - 1].props[property[1].trim().toLowerCase()] = property[2].trim().toLowerCase();
	}
	return sections;
}

/** Whether the config declares `root = true` before any section, the assumption the guard's single-config model rests on. */
export function declaresRoot(text) {
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
		if (/^\[.*\]$/.test(line)) return false;
		const property = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
		if (property !== null && property[1].trim().toLowerCase() === "root") return property[2].trim().toLowerCase() === "true";
	}
	return false;
}

/** The effective properties for a repo-relative path, applying each matching section in file order (last match wins per key). */
export function resolveProps(sections, relativePath) {
	const props = {};
	for (const section of sections) {
		if (sectionMatches(section.glob, relativePath)) Object.assign(props, section.props);
	}
	return props;
}

/** EditorConfig glob semantics: a glob with a `/` matches the whole relative path (a leading `/` just anchors it), one without matches the basename. */
function sectionMatches(glob, relativePath) {
	let pattern = glob;
	let full = pattern.includes("/");
	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
		full = true;
	}
	const target = full ? relativePath : relativePath.slice(relativePath.lastIndexOf("/") + 1);
	return matchGlob(pattern, target);
}

/** Whether a glob matches a relative path (either the whole path or just its last segment, as the caller chose), brace groups expanded first so this and the walk's reach test read one expander. */
function matchGlob(glob, target) {
	const targetSegments = target.split("/");
	return expandBraces(glob).some((alternative) => segmentsMatch(alternative.split("/"), 0, targetSegments, 0, EDITORCONFIG_GLOB));
}

/**
 * Match a glob's segments against a path's segments: a segment that is exactly `**` spans any number of path segments — at least one when it is the pattern's last segment, since a trailing `/**` means "everything inside" — and every other segment must match exactly one path segment through `componentMatches`.
 * This and `componentMatches` are the one structural and character-level matcher the resolver, the walk's reach test, and the `.gitignore` translator all read, so a fix to `*`/`?`/`**` semantics reaches every user at once.
 */
function segmentsMatch(patternSegments, patternIndex, targetSegments, targetIndex, options) {
	if (patternIndex === patternSegments.length) return targetIndex === targetSegments.length;
	if (patternSegments[patternIndex] === "**") {
		// A trailing `/**` means everything inside, so it must absorb at least one more segment rather than accept the end of the path.
		if (patternIndex === patternSegments.length - 1) return targetIndex < targetSegments.length;
		if (segmentsMatch(patternSegments, patternIndex + 1, targetSegments, targetIndex, options)) return true;
		return targetIndex < targetSegments.length && segmentsMatch(patternSegments, patternIndex, targetSegments, targetIndex + 1, options);
	}
	if (targetIndex === targetSegments.length) return false;
	if (!componentMatches(patternSegments[patternIndex], targetSegments[targetIndex], options)) return false;
	return segmentsMatch(patternSegments, patternIndex + 1, targetSegments, targetIndex + 1, options);
}

/** Whether one glob segment — a glob with no `/` — matches one path segment, anchored at both ends. */
function componentMatches(globSegment, name, options) {
	return new RegExp(`^${componentToRegexSource(globSegment, options)}$`).test(name);
}

/**
 * Translate one glob segment into a regular-expression source over a single path component: `*` matches any run within the component and `?` one character, neither crossing `/`.
 * `characterClasses` decides what `[` means: with it, a `[...]` body becomes a character class (git's fnmatch); without it, `[` is literal (EditorConfig's glob subset).
 * A `**` never reaches this function as a whole segment — `segmentsMatch` consumes that as its any-depth marker — so the two asterisks here are two ordinary asterisks, which is exactly git's rule that a `**` not forming a whole path segment matches like `*`.
 */
function componentToRegexSource(globSegment, { characterClasses }) {
	let source = "";
	for (let index = 0; index < globSegment.length; index += 1) {
		const char = globSegment[index];
		if (char === "*") {
			source += "[^/]*";
			continue;
		}
		if (char === "?") {
			source += "[^/]";
			continue;
		}
		if (characterClasses && char === "[") {
			const end = globSegment.indexOf("]", index + 1);
			if (end > index + 1) {
				source += characterClassSource(globSegment.slice(index + 1, end));
				index = end;
				continue;
			}
		}
		source += escapeRegExp(char);
	}
	return source;
}

/** A `[...]` body as a regular-expression character class, with a leading `!` or `^` read as git reads it, as an inverted class. */
function characterClassSource(body) {
	const inverted = body.startsWith("!") || body.startsWith("^");
	const members = inverted ? body.slice(1) : body;
	return `[${inverted ? "^" : ""}${members.replace(/\\/g, "\\\\")}]`;
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether a segment carries a construct this matcher treats as a wildcard; `[` counts even where the config does not model a character class, so an unmodelled group is read as reaching rather than as a literal name. */
function hasWildcard(segment) {
	return segment.includes("*") || segment.includes("?") || segment.includes("[");
}

/**
 * Expand `{a,b}` groups into their alternatives, honoring nesting so a group inside an alternative expands too.
 * A brace group with no top-level comma — a numeric range such as `{1..3}`, which this glob subset does not model — is left untouched and matched literally, and so is an unmatched brace; the resolver and the walk's reach test read this one expander, so neither can expand a group the other leaves literal.
 */
function expandBraces(glob) {
	for (let open = glob.indexOf("{"); open !== -1; open = glob.indexOf("{", open + 1)) {
		const close = matchingBrace(glob, open);
		if (close === -1) return [glob];
		const alternatives = splitAlternatives(glob.slice(open + 1, close));
		if (alternatives === null) continue;
		const expanded = [];
		for (const alternative of alternatives) {
			for (const tail of expandBraces(glob.slice(0, open) + alternative + glob.slice(close + 1))) expanded.push(tail);
		}
		return expanded;
	}
	return [glob];
}

/** The index of the `}` matching the `{` at `open`, or -1 when the brace is unmatched. */
function matchingBrace(glob, open) {
	let depth = 0;
	for (let index = open; index < glob.length; index += 1) {
		if (glob[index] === "{") depth += 1;
		else if (glob[index] === "}") {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return -1;
}

/** The top-level comma-separated alternatives of a brace group's content, or `null` when it has no top-level comma, i.e. is not a group this subset expands. */
function splitAlternatives(content) {
	const alternatives = [];
	let depth = 0;
	let current = "";
	for (const char of content) {
		if (char === "{") depth += 1;
		else if (char === "}") depth -= 1;
		if (char === "," && depth === 0) {
			alternatives.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (alternatives.length === 0) return null;
	alternatives.push(current);
	return alternatives;
}

/**
 * The `.gitignore` patterns, each carrying its directory flag, negation, and anchoring; blank lines and `#` comments dropped.
 * Bounded to the forms a repo-local sweep relies on: a pattern with no `/` (a directory's trailing one aside) matches the basename at any depth, a pattern containing `/` is anchored to the `.gitignore` directory, `*`, `?`, and a whole-segment `**` follow git's rules (a `**` that is not a whole path segment matches like `*` and does not cross `/`), `[...]` is a character class, `{}` is literal, and a leading `!` re-includes a path an earlier pattern ignored.
 * A residual difference from git remains: a tracked file is still skipped, since this workspace has no `.git` to consult.
 */
export function parseGitignore(text) {
	const entries = [];
	for (const raw of text.split("\n")) {
		let line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const negated = line.startsWith("!");
		if (negated) line = line.slice(1);
		if (line === "") continue;
		const directory = line.endsWith("/");
		if (directory) line = line.slice(0, -1);
		const anchored = line.includes("/");
		if (line.startsWith("/")) line = line.slice(1);
		entries.push({ glob: line, directory, negated, anchored });
	}
	return entries;
}

/** Whether the repo's `.gitignore` ignores a repo-relative path, applying every matching entry in file order so a later `!` re-includes what an earlier pattern ignored. */
export function isIgnored(entries, relativePath, isDirectory) {
	const segments = relativePath.split("/");
	let ignored = false;
	for (const entry of entries) {
		if (entryMatches(entry, segments, isDirectory)) ignored = !entry.negated;
	}
	return ignored;
}

/** Whether one `.gitignore` entry matches a path, given the path's segments and whether the path is a directory; a directory pattern matches an ancestor component (or the path itself when it is a directory), a basename pattern the last segment, and an anchored pattern the whole joined path. */
function entryMatches(entry, segments, isDirectory) {
	const patternSegments = entry.glob.split("/");
	if (entry.directory) {
		const lastAncestor = isDirectory ? segments.length : segments.length - 1;
		for (let end = 1; end <= lastAncestor; end += 1) {
			const prefix = segments.slice(0, end);
			const target = entry.anchored ? prefix : [prefix[prefix.length - 1]];
			if (segmentsMatch(patternSegments, 0, target, 0, GIT_GLOB)) return true;
		}
		return false;
	}
	const target = entry.anchored ? segments : [segments[segments.length - 1]];
	return segmentsMatch(patternSegments, 0, target, 0, GIT_GLOB);
}

/** Whether a section sets at least one enforced key to a value the guard checks rather than `unset`; only such a section can re-enable a rule inside a tree an `unset` section covers. */
function enforcesAnyKey(props) {
	return Object.keys(ENFORCED_KEYS).some((key) => props[key] !== undefined && props[key] !== "unset");
}

/** Whether a section sets every enforced key to `unset`, so a `/**`-rooted glob it carries leaves no key in scope anywhere beneath its root. */
function unsetsAllEnforcedKeys(props) {
	return Object.keys(ENFORCED_KEYS).every((key) => props[key] === "unset");
}

/**
 * The index of the last section that covers the whole directory with `unset`, or -1.
 * The last one is the only one that matters: an earlier section's values are overridden for every path under the directory by a later `unset` that covers it too, so the last covering section leaves the fewest later sections able to re-enable a key.
 */
function lastUnsetCover(sections, dirSegments) {
	let cover = -1;
	for (let index = 0; index < sections.length; index += 1) {
		if (!unsetsAllEnforcedKeys(sections[index].props)) continue;
		if (sectionCoversDirectory(sections[index], dirSegments)) cover = index;
	}
	return cover;
}

/** Whether one of the section's brace-expanded patterns is `ROOT/**` with `ROOT` matching the directory or one of its ancestors, so every path under the directory resolves the section's `unset` for every enforced key. */
function sectionCoversDirectory(section, dirSegments) {
	return expandBraces(section.glob).some((alternative) => {
		let pattern = alternative;
		if (pattern.startsWith("/")) pattern = pattern.slice(1);
		if (!pattern.endsWith("/**")) return false;
		const root = pattern.slice(0, -"/**".length);
		return root !== "" && rootCoversDirectory(root.split("/"), dirSegments);
	});
}

/** Whether a `ROOT/**` pattern's root matches the directory or one of its ancestors. */
function rootCoversDirectory(rootSegments, dirSegments) {
	for (let end = 1; end <= dirSegments.length; end += 1) {
		if (segmentsMatch(rootSegments, 0, dirSegments.slice(0, end), 0, EDITORCONFIG_GLOB)) return true;
	}
	return false;
}

/**
 * Whether any of the section's brace-expanded patterns could match a file strictly under `directory`.
 * Conservative on purpose: `true` keeps the directory walked, so a pattern the predicate cannot pin exactly costs a little walking rather than a silently unguarded subtree.
 */
function sectionCouldMatchUnder(section, dirSegments) {
	return expandBraces(section.glob).some((alternative) => patternReachesUnder(alternative, dirSegments));
}

/** Whether one pattern could match a file strictly under `directory`: a pattern with no `/` is basename-anchored and could match a file at any depth, so it reaches under any directory. */
function patternReachesUnder(alternative, dirSegments) {
	let pattern = alternative;
	if (pattern.startsWith("/")) pattern = pattern.slice(1);
	else if (!pattern.includes("/")) return true;
	return pathReachesUnder(pattern.split("/"), dirSegments);
}

/**
 * Whether a `/`-anchored pattern could match a file strictly under `directory`.
 * Only a leading run of wildcard-free segments can be compared literally: a leading `**` or a leading wildcard segment could begin anywhere, so it reaches; a literal prefix that diverges from the directory cannot reach under it; and a literal prefix that is the directory (or is under it) reaches, unless the whole pattern is literal and stops at the directory itself.
 */
function pathReachesUnder(patternSegments, dirSegments) {
	if (patternSegments[0] === "**") return true;
	const literalSegments = [];
	for (const segment of patternSegments) {
		if (hasWildcard(segment)) break;
		literalSegments.push(segment);
	}
	if (literalSegments.length === 0) return true;
	const shared = Math.min(literalSegments.length, dirSegments.length);
	for (let index = 0; index < shared; index += 1) {
		if (literalSegments[index] !== dirSegments[index]) return false;
	}
	if (literalSegments.length === patternSegments.length) return literalSegments.length > dirSegments.length;
	return true;
}

/**
 * Whether a directory is out of scope and can be pruned: a section whose brace-expanded `ROOT/**` covers every path under it sets every enforced key to `unset`, and no section after that one could match a path under it while setting an enforced key to a value.
 * Anything the reach test cannot pin exactly — a basename-anchored glob, a leading wildcard, a shallower `/**` that leaves deeper files governed — keeps the directory in the sweep, so a partial exclusion or a later re-enable never silently drops a governed file.
 */
function isExcludedTree(sections, directory) {
	const cover = lastUnsetCover(sections, directory.split("/"));
	if (cover === -1) return false;
	return !sections.slice(cover + 1).some((later) => enforcesAnyKey(later.props) && sectionCouldMatchUnder(later, directory.split("/")));
}

/** Every governed file with its resolved rules, a problem string for the root config when it is missing, and the parsed config (or `null` when it is missing) so `styleProblems` can validate the config itself. */
export async function governedFiles(root) {
	let configText;
	try {
		configText = await readFile(join(root, ".editorconfig"), "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		return { files: [], problems: [".editorconfig — is missing, so the rules cannot be derived"], config: null };
	}
	const sections = parseEditorConfig(configText);
	let ignore = [];
	try {
		ignore = parseGitignore(await readFile(join(root, ".gitignore"), "utf8"));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const files = [];
	const problems = [];
	await walk({ dir: root, prefix: "", sections, ignore, files, problems });
	return { files, problems, config: { text: configText, sections } };
}

/** Walk `dir` recursively, appending each governed file to `files`, a problem for a directory that cannot be listed, and a problem for a nested `.editorconfig`; the single options object keeps a caller from silently swapping two same-typed arguments. */
export async function walk({ dir, prefix, sections, ignore, files, problems }) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		problems.push(`${prefix === "" ? "." : prefix} — is missing, so its files cannot be checked`);
		return;
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		const label = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.name === ".git") continue;
		if (entry.isDirectory()) {
			if (isIgnored(ignore, label, true)) continue;
			if (isExcludedTree(sections, label)) continue;
			await walk({ dir: join(dir, entry.name), prefix: label, sections, ignore, files, problems });
		} else if (entry.isFile()) {
			if (isIgnored(ignore, label, false)) continue;
			if (entry.name === ".editorconfig" && prefix !== "") {
				problems.push(`${label} — is a nested config, but the guard reads only the root .editorconfig`);
				continue;
			}
			files.push({ label, path: join(dir, entry.name), props: resolveProps(sections, label) });
		}
		// A symlink or any other non-regular entry is skipped rather than followed: the guard checks the bytes the repo authors, and following a link could pull an out-of-tree or cyclic target into the sweep.
	}
}

/** Check one governed file's bytes against the values `ENFORCED_KEYS` lists for the keys its props resolve; a value the guard cannot check is left to `unsupportedValueProblems`. Returns one `path:line — reason` string per violation. */
export function fileProblems({ label, bytes, props }) {
	const problems = [];
	if (props.charset === "utf-8" && bytes.subarray(0, 3).equals(BOM)) {
		problems.push(`${label}:1 — starts with a UTF-8 byte-order mark`);
	}
	let text;
	if (props.charset === "utf-8") {
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			problems.push(`${label} — is not valid UTF-8`);
			return problems;
		}
	} else {
		text = new TextDecoder("utf-8").decode(bytes);
	}
	const language = languageFor(label);
	const insideComment = props.indent_style === "tab" && language !== null ? commentContinuationLines(text, { language }) : new Set();
	for (const [index, line] of text.split("\n").entries()) {
		const number = index + 1;
		if (props.end_of_line === "lf" && line.includes("\r")) problems.push(`${label}:${number} — carriage return, but the contract is LF`);
		if (props.trim_trailing_whitespace === "true" && /[ \t]$/.test(line)) problems.push(`${label}:${number} — trailing whitespace`);
		const indentation = line.match(/^[ \t]*/)[0];
		if (props.indent_style === "tab" && !insideComment.has(index) && indentation.includes(" ")) {
			problems.push(`${label}:${number} — indentation uses spaces, but the contract is tabs`);
		}
	}
	if (props.insert_final_newline === "true" && !text.endsWith("\n")) problems.push(`${label} — no final newline`);
	return problems;
}

/** One problem per (key, value) the config sets an enforced key to a value the guard cannot check, so an unsupported config value fails the gate once instead of once per governed file. */
export function unsupportedValueProblems(files) {
	const seen = new Map();
	for (const { props } of files) {
		for (const [key, supported] of Object.entries(ENFORCED_KEYS)) {
			const value = props[key];
			if (value === undefined || value === "unset" || supported.includes(value)) continue;
			const id = `${key}\u0000${value}`;
			if (!seen.has(id)) seen.set(id, { key, value, supported });
		}
	}
	return [...seen.values()].map(({ key, value, supported }) => `cannot enforce ${key} = ${value}; the guard checks ${supported.join(", ")}`);
}

/** One problem per key a section sets to a value the guard does not enforce at all, so a config asking for a rule the gate cannot check fails loudly rather than being silently ignored. */
export function unenforcedKeyProblems(sections) {
	const seen = new Set();
	const problems = [];
	for (const section of sections) {
		for (const [key, value] of Object.entries(section.props)) {
			if (value === "unset" || Object.hasOwn(ENFORCED_KEYS, key) || seen.has(key)) continue;
			seen.add(key);
			problems.push(`.editorconfig [${section.glob}] — sets ${key}, a key the guard does not enforce, so the config asks for a rule the gate cannot check`);
		}
	}
	return problems;
}

/** One problem per section pattern that uses a glob construct the matcher does not model — a `[...]` character class or a `{n..m}` numeric range — so an unmodelled construct cannot silently govern fewer files than an editor would. */
export function unmodelledGlobProblems(sections) {
	const problems = [];
	for (const section of sections) {
		const constructs = [];
		if (/\[[^\]]*\]/.test(section.glob)) constructs.push("a `[...]` character class");
		if (/\{[^{}]*\.\.[^{}]*\}/.test(section.glob)) constructs.push("a `{n..m}` numeric range");
		if (constructs.length > 0) problems.push(`.editorconfig [${section.glob}] — uses ${constructs.join(" and ")}, which the guard's glob matcher does not model, so it could govern fewer files than an editor`);
	}
	return problems;
}

/** Problems about `.editorconfig` itself: the single-config assumption (`root = true`), a key the guard does not enforce, and a glob construct the matcher does not model. */
export function configProblems({ text, sections }) {
	const problems = [];
	if (!declaresRoot(text)) problems.push(".editorconfig — does not declare `root = true`, so settings from a parent directory could leak in");
	problems.push(...unenforcedKeyProblems(sections));
	problems.push(...unmodelledGlobProblems(sections));
	return problems;
}

/** The whole sweep: every governed file's violations, the config's own problems, any config value the guard cannot check, and a problem for the root config or any file that cannot be read. `read` is injectable so a test can reach the unreadable-file branch without depending on the runner's file permissions. */
export async function styleProblems(root, { read = readFileSync } = {}) {
	const { files, problems, config } = await governedFiles(root);
	if (config !== null) problems.push(...configProblems(config));
	problems.push(...unsupportedValueProblems(files));
	for (const file of files) {
		let bytes;
		try {
			bytes = read(file.path);
		} catch (error) {
			problems.push(`${file.label} — cannot be read: ${error.code ?? error.message}`);
			continue;
		}
		problems.push(...fileProblems({ label: file.label, bytes, props: file.props }));
	}
	return problems;
}
