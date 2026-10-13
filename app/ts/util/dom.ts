/**
 * The dynamic-DOM layer: the `h()` builder the whole app builds its markup with, and the attribute allow-list behind it.
 *
 * It is the app's one markup sink by construction: string and number children become text nodes, and an attribute outside {@link ALLOWED_ATTRIBUTES} — or a value the attribute's own gate refuses — throws rather than mutating the element, so no invoice field can become script or an event handler.
 * {@link append} shares the same child handling, and nothing here reaches the network.
 */

import { isSvgDataUrl, type SvgDataUrl } from "./data-url.js";
import { describe, preview } from "./errors.js";

/** Children accepted by {@link h}: real nodes, text, or skipped holes from conditional rendering. */
export type DomChild = Node | string | number | null | undefined | false;

/**
 * The attribute names {@link h} will set, and the single source of truth for both the type and the runtime allow-list.
 * An explicit set — rather than an index signature — keeps a call site that spreads parsed invoice data from introducing event handlers (`onclick`), script-bearing URLs (`srcdoc`, an arbitrary `src`), inline CSS (`style`), or a `javascript:` `href`.
 * The names whose values carry meaning beyond text are gated: `href` through {@link safeUrl}, which admits only a same-origin reference or a `#` target, and `src` through {@link isSvgDataUrl}, which admits only the data URL the icon leaf builds.
 * `accept` and `alt` are free text — a file-picker filter and an image's alternative text — and neither is a sink.
 */
const ALLOWED_ATTRIBUTES = [
	"class",
	"id",
	"title",
	"role",
	"lang",
	"dir",
	"tabindex",
	"hidden",
	"disabled",
	"checked",
	"selected",
	"readonly",
	"required",
	"open",
	"type",
	"name",
	"value",
	"placeholder",
	"accept",
	"alt",
	"for",
	"colspan",
	"rowspan",
	"scope",
	"headers",
	"href",
	"src",
	"aria-label",
	"aria-modal",
	"aria-hidden",
	"aria-describedby",
	"aria-expanded",
] as const;

/** URL-bearing attributes; {@link h} runs each value through {@link safeUrl} before setting it. */
const URL_ATTRIBUTES: ReadonlySet<string> = new Set(["href"]);

const ALLOWED: ReadonlySet<string> = new Set(ALLOWED_ATTRIBUTES);

/** Every attribute name {@link h} will set, one member per entry in its allow-list. */
export type DomAttributeName = (typeof ALLOWED_ATTRIBUTES)[number];

/**
 * The attribute bag {@link h} accepts: allow-listed names mapped to the primitive values it can render.
 * `src` is stated apart from the rest because its value is an image sink rather than text: it accepts only the branded {@link SvgDataUrl} the icon leaf builds, so a bare string is a compile error here and {@link checkedAttributeValue} refuses one at runtime.
 */
export type DomAttributes = Partial<Record<Exclude<DomAttributeName, "src">, string | number | boolean | null | undefined>> & {
	readonly src?: SvgDataUrl | null | undefined;
};

const URL_SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/**
 * Validate a URL before it reaches a URL-bearing attribute.
 *
 * Only a same-origin target passes: a schemeless reference (`#/i/…`, `js/main.js`, `/app/x`, `?open=1`) resolves against this document's origin and is allowed, while an absolute URL of any scheme is refused — `http(s):` names another origin, and `javascript:`, `data:`, `vbscript:`, `blob:`, and `file:` are unsafe outright.
 * A protocol-relative `//host` is refused too, since it resolves against the scheme and so leaves the origin.
 * The rule is deliberately origin-blind: with no base to compare against, the only reliably same-origin references are the schemeless ones, so an absolute URL is rejected even when it happens to name this origin rather than trusted by guesswork.
 * Control characters and backslashes are normalized away before the check, because a browser ignores leading control characters and may read `\` as `/`, so `java\tscript:` and `\/\/host` must not slip through.
 * Returns the normalized value, and {@link h} writes that result rather than the raw string, so the attribute never carries bytes the check did not see.
 * A URL that is only shown (an input's `value`, a copyable link text) is not a navigation target and does not pass through here.
 */
export function safeUrl(value: unknown): string {
	if (typeof value !== "string") {
		throw new TypeError(`dom: a URL must be a string, got ${describe(value)}`);
	}
	const normalized = value.replace(/[\u0000-\u0020]+/g, "").replace(/\\/g, "/");
	const scheme = URL_SCHEME.exec(normalized)?.[1]?.toLowerCase();
	if (scheme !== undefined) {
		throw new TypeError(`dom: refusing an absolute "${scheme}:" URL — only a same-origin reference or a "#" target may reach an href: ${describe(value)}`);
	}
	if (normalized.startsWith("//")) {
		throw new TypeError(`dom: refusing a protocol-relative (cross-origin) URL: ${describe(value)}`);
	}
	return normalized;
}

/**
 * Tags {@link h} refuses to build.
 * A `<script>` built through `h` would take its string children as inline script — the exact execution vector the page's relaxed `script-src-elem` directive permits — so the builder refuses one outright rather than rely on every call site to avoid it.
 */
const FORBIDDEN_TAGS: ReadonlySet<string> = new Set(["script"]);

/**
 * Validate an attribute name, and a gated value, returning the value to write.
 * A URL attribute resolves to {@link safeUrl}'s normalized result, so `h` sets the attribute to exactly the string that passed the check.
 * `src` is the one image sink `h` can build, and it accepts nothing but the icon leaf's own data URL — not a relative path, not a remote reference, and not any other `data:` type — so the attribute carries only what the icon leaf's `svgDataUrl` produced.
 */
function checkedAttributeValue(name: string, value: string | number | boolean): string | number | boolean {
	if (!ALLOWED.has(name)) {
		throw new TypeError(`dom: refusing the attribute ${describe(name)} — it is not on the h() allow-list`);
	}
	if (name === "src") {
		if (!isSvgDataUrl(value)) {
			throw new TypeError(`dom: refusing the src ${preview(value)} — only the icon leaf's own data URL may reach an image sink`);
		}
		return value;
	}
	if (URL_ATTRIBUTES.has(name)) {
		return safeUrl(value);
	}
	return value;
}

/**
 * Build an element without a framework.
 *
 * String and number children become text nodes (never markup), so invoice free text cannot become script; `null`, `undefined` and `false` children are skipped.
 * A `true` attribute value becomes a valueless attribute (e.g. `disabled`), and `null`/`undefined`/`false` attributes are left off.
 * An attribute name outside {@link ALLOWED_ATTRIBUTES}, an unsafe value for a URL-bearing attribute, or a `src` that is not the icon leaf's own data URL throws instead of mutating the element; a URL-bearing attribute is set to {@link safeUrl}'s normalized result, not the raw value.
 * A tag that can carry executable script ({@link FORBIDDEN_TAGS}) throws rather than building one.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attributes: DomAttributes = {},
	...children: readonly DomChild[]
): HTMLElementTagNameMap[K] {
	if (FORBIDDEN_TAGS.has(tag)) {
		throw new TypeError(`dom: refusing to build a <${tag}> element — it can carry executable script`);
	}
	const element = document.createElement(tag);
	for (const [name, value] of Object.entries(attributes)) {
		if (value === null || value === undefined || value === false) {
			continue;
		}
		const checked = checkedAttributeValue(name, value);
		element.setAttribute(name, checked === true ? "" : String(checked));
	}
	append(element, children);
	return element;
}

/** Append {@link DomChild} values to an existing element, skipping nullish and `false` children. */
export function append(parent: Element, children: readonly DomChild[]): void {
	for (const child of children) {
		if (child === null || child === undefined || child === false) {
			continue;
		}
		parent.append(typeof child === "number" ? String(child) : child);
	}
}
