/**
 * The icon validator: a bounded, canonicalizing input gate for an untrusted SVG document, plus a construct denylist whose content refusals are best-effort and not the security boundary.
 *
 * The content boundary is the browser's image context, not this module: the returned text is meant to be handed only to an `HTMLImageElement` `src` or drawn to a `<canvas>`, and a browser renders an SVG through either in secure static image mode, where scripts do not run and external resources are not fetched.
 * That browser-enforced property is what makes the named content bypasses inert — a character-reference URL scheme, `<svg/onload=…>`, a remote `href`, a CSS `image()`, and an external DTD all fail to execute or fetch in image context whatever their raw text says — so the denylist's content refusals do not need to be complete, and no content containment relies on them.
 * This module neither performs nor enforces that hand-off: it is an obligation on every consumer to hand the returned text only to one of those two image-context sinks and never to inline markup, a DOM parser, a navigation target, or a fetch, and a consumer that routes the text anywhere else loses the boundary these refusals assume.
 * Resource-exhaustion resistance is a different property, and it rests on three checks: the byte cap bounds the input and the raw path and noise data a document may carry; the dimension cap bounds the root `<svg>` element's intrinsic size to {@link MAX_ICON_DIMENSION} per axis and the declared area it implies to {@link MAX_ICON_PIXELS} pixels — the area check states that bound rather than adding one of its own — so the document is at most {@link MAX_ICON_DIMENSION} squared pixels when it is rendered as it stands, though a consumer that scales the icon up to a larger display size draws it in a viewport this cap does not bound; and the gate refuses the constructs whose cost that intrinsic size does not bound — the SMIL and animation elements (`<use>`, `<set>`, `<animate>`, `<animateMotion>`, `<animateTransform>`, `<mpath>`), which let a tiny document rasterize a large or recursive target, and every filter construct (`<filter>`, any `fe*` filter primitive, and any `filter` attribute), whose cost follows parameters such as `stdDeviation` and `numOctaves`, or an intermediate surface larger than the icon's intrinsic size, rather than that size.
 * A document cannot sidestep those bounds by embedding a second one or resolving an external reference: the elements that would fetch a nested document or resolve a resource are refused by local name, so none reaches the render carrying constructs this gate never read.
 * Those refusals are relied on; the gate does not bound every remaining rendering parameter, so gradients, patterns, masks, clip paths, text, and arbitrary path data are not individually capped, and the intrinsic size clips what the browser paints but bounds no intermediate computation such constructs drive beyond the byte cap and the browser's own limits.
 * Its main jobs are to bound and canonicalize the value: it enforces the byte cap, composes the text to NFC so one visible document has one encoding, refuses the control, invisible and lone-surrogate bytes that could confuse downstream handling, and requires a numeric, pixel-bounded intrinsic size on the root `<svg>` element so the rasterizer's decode stays bounded.
 * The intrinsic size is read from the document's root `<svg>` element, located by walking the markup in document order rather than by taking the first `<svg …>` spelling, so a decoy tag inside a comment cannot stand in for the root, and its `width` and `height` are read by exact attribute name so a same-named substring elsewhere cannot supply them; a root that declares neither a numeric `width` nor a numeric `height` is refused, because a `viewBox` alone leaves the browser's intrinsic size to its fixed default rather than to a bound this gate can apply.
 * The construct denylist remains as defense-in-depth against a future change that routes the icon into inline markup, and it is honest about its reach: it is a regex over the raw text, and a conforming parser reads some spellings it does not, so a value that carries an unrefused content bypass is not thereby safe — the image context is.
 *
 * {@link validateIcon} accepts only a string within the byte cap, composed to NFC and free of surrounding whitespace, and it then applies the construct denylist.
 * The denylist's element refusals read an element's local name after the element name's last colon, so `use`, `svg:use`, `SVG:use`, `śvg:use`, and `svg:Svg:use` are all refused as `use` rather than read as unknown elements, whatever the spelling or count of the namespace prefix they carry.
 * It additionally requires the document's root `<svg>` element to declare numeric `width` and `height` within `1` to {@link MAX_ICON_DIMENSION} and a `width` by `height` area within {@link MAX_ICON_PIXELS}, so a document cannot declare an intrinsic size larger than the cap.
 * A value of another type throws a `TypeError`, naming what arrived through the same bounded preview the sibling address validators use; a string that fails any check throws an {@link InvalidIconError}, and wrapping that into a user-facing error is the consumer's enforcement, outside this module.
 */
import { utf8ToBytes } from "../util/encoding.js";
import { preview } from "../util/errors.js";
import { MAX_ICON_DIMENSION, MAX_ICON_SVG_BYTES } from "../util/icon-capacity.js";
import { INVISIBLE_FORMATTING, LONE_SURROGATE, MULTI_LINE_CONTROL } from "../util/text.js";
/**
 * The two bounds this gate applies, re-exported from `util/icon-capacity.ts` under the names this validator's own bounds are read by: the UTF-8 byte cap and the per-axis dimension cap.
 */
export { MAX_ICON_DIMENSION, MAX_ICON_SVG_BYTES };
/**
 * How many code units the raw, not-yet-composed spelling may carry before the validator refuses it without composing.
 *
 * Composition is the first unbounded step, so a caller that hands this gate a multi-megabyte string must be turned back before it; the room is generous enough that the longest canonical decomposition of a within-cap document is never refused, since a canonical decomposition is at most a small multiple of the code points it decomposes.
 */
const MAX_RAW_ICON_CODE_UNITS = MAX_ICON_SVG_BYTES * 8;
/** The largest area an icon's root `<svg>` element may declare, in pixels: {@link MAX_ICON_DIMENSION} squared, so the two caps bound one and the same corner and the area check states a bound the dimension cap already implies rather than narrowing it. */
export const MAX_ICON_PIXELS = MAX_ICON_DIMENSION * MAX_ICON_DIMENSION;
/**
 * A comment, a CDATA section, a processing instruction, or a start or end tag, matched in document order so {@link rootStartTag} can walk the markup rather than take the first `<svg …>` spelling to appear.
 *
 * The tag alternative consumes a quoted attribute value whole, so a `>` inside one does not end the tag early and {@link readRootDimensions} receives every attribute a parser would see.
 * The tag alternative still ends at the first `>` outside a quoted value and reads the markup as text rather than parsing it, so this is a heuristic scan of the raw text, not a parse.
 */
const MARKUP_TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[A-Za-z](?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
/** The name of a start tag, e.g. `svg` in `<svg width="64">`. */
const START_TAG_NAME = /^<([A-Za-z][\w:-]*)/;
/** A plain, non-negative decimal — the only `width`/`height` spelling the dimension check accepts. */
const NUMERIC_DIMENSION = /^\d+(?:\.\d+)?$/;
/** A numeric character reference, in either the hexadecimal or the decimal spelling, captured for expansion by {@link expandCharacterReferences}. */
const CHARACTER_REFERENCE = /&#(?:x([0-9a-f]+)|(\d+));/gi;
/**
 * The remote-reference spellings the scan matches: a literal URL scheme or a protocol-relative `//` after `href`, `xlink:href`, or `url(`, the broader heuristic predicate the module doc describes.
 *
 * Leading whitespace and control characters between the attribute's `=` or opening quote and the value are skipped before the scheme test, because a parser strips them from the URL it resolves while a scan anchored at the quote reads the value as scheme-less and lets it through: `href=" http://…"`, `href="\ndata:…"` and `url(" http://…")` are refused as the references they are.
 * The text handed to this pattern has its backslashes normalized to forward slashes first, because a browser reads `\` as `/` and so reads `\\host` as the protocol-relative `//host` this pattern refuses.
 */
const REMOTE_REFERENCE = /(?:xlink:)?href\s*=\s*["']?[\s\u0000-\u001f]*(?:[a-z][a-z0-9+.-]*:|\/\/)|url\(\s*["']?[\s\u0000-\u001f]*(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
/**
 * An inline event handler: an `on…` attribute name whose preceding character is not itself part of a name.
 *
 * A lenient parser reads a name after whitespace, after the `/` that separates `<rect x="1" /onload=…>`, or after a stray quote as an attribute of the element, so the refusal keys on the handler name rather than on the separator before it and over-refuses a name that merely begins with `on` rather than miss one.
 */
const EVENT_HANDLER = /(?:^|[^\w:-])on[a-z]+\s*=/i;
/** A `filter` attribute, which names a filter chain and so reaches the filter cost {@link DENIED_ELEMENTS} and {@link isDeniedElement} refuse; the attribute is refused outright rather than by the shape of its value. */
const FILTER_ATTRIBUTE = /\bfilter\s*=/i;
/**
 * The local names of the elements this gate refuses outright.
 *
 * The SMIL hyperlink and animation elements — `<use>`, `<set>`, `<mpath>`, `<animate>`, `<animateMotion>`, `<animateTransform>` — are the amplification primitives: a tiny document can point one at a large or recursive target and make the render cost far more than its bytes, so their refusal is relied on for resource-exhaustion resistance.
 * `<script>`, `<style>` and `<foreignObject>` join them because each can carry or reach script in a sink other than an image context.
 * `<filter>` joins them because a filter chain's execution cost is set by its parameters rather than by the icon's intrinsic size, and {@link isDeniedElement} refuses every `fe*` filter primitive for the same reason.
 * The document and subresource loaders — `<image>`, `<img>`, `<iframe>`, `<object>`, `<embed>`, `<link>`, `<audio>`, `<video>`, `<source>`, `<track>` — join them because each names a resource to fetch and render, and `<image href="data:image/svg+xml;base64,…">` carries a whole second SVG document whose own constructs — a filter chain, an animation element, an unbounded viewport — this text scan never reads; refusing the element by local name closes that embedding whatever spelling its value takes, and keeps the module's external-loads-disabled premise true rather than leaving the nested load to the image context.
 * The reference-carrying elements — `<tref>`, `<cursor>`, `<font-face-uri>`, `<color-profile>`, `<altGlyph>`, `<glyphRef>` — join them for the same reason: each resolves an `href` or `xlink:href` to a resource (a text element, a cursor image, a font file, an ICC profile, or a glyph), so a relative or otherwise scan-invisible value still names a load the element's refusal keeps out.
 */
const DENIED_ELEMENTS = new Set([
    "script",
    "style",
    "foreignobject",
    "filter",
    "animate",
    "animatemotion",
    "animatetransform",
    "mpath",
    "set",
    "use",
    "image",
    "img",
    "iframe",
    "object",
    "embed",
    "link",
    "audio",
    "video",
    "source",
    "track",
    "tref",
    "cursor",
    "font-face-uri",
    "color-profile",
    "altglyph",
    "glyphref",
]);
/**
 * A start or end tag, capturing the whole element name up to the first whitespace, `/`, `<`, or `>`, so a name spans every namespace prefix and any Unicode letter or digit it may carry.
 *
 * Capturing the whole name keeps the refusal to the element's local name rather than to an ASCII-letter prefix an attacker can evade: {@link localName} reads the part after the last colon, which is where a namespace-aware parser binds the prefix or prefixes.
 * The pattern matches in the raw text, so it also sees a `<use>` spelling inside a comment or a text node that a parser would not read as an element; over-refusing such a spelling is the safe direction.
 */
const ELEMENT_TAG = /<\/?([^\s/<>]+)/g;
/** The number of character-reference expansion passes; three resolve a scheme hidden behind two re-forming `&#38;` layers (`&#38;#38;#x68;ttp`), and the loop stops early once a pass changes nothing. */
const CHARACTER_REFERENCE_EXPANSION_PASSES = 3;
/** Raised by {@link validateIcon} for a string that fails a value check — an empty or over-long document, a non-canonical spelling, or a forbidden construct; a value of another type throws a `TypeError` instead. */
export class InvalidIconError extends Error {
    constructor(reason) {
        super(`invoice: ${reason}`);
        this.name = "InvalidIconError";
    }
}
/**
 * Expand every numeric character reference in `text` to the character it names, repeating a bounded number of passes so a reference to `&` (`&#38;`) can re-form one a later pass expands.
 *
 * The pass exists only to feed the remote-reference scan: a scheme spelled `&#x68;ttp` or `&#104;ttp`, or hidden behind `&#38;#x68;ttp`, reads as the scheme a parser would see once the references are resolved, so the construct denylist is not blind to that one spelling.
 * The expansion is bounded rather than a fixed point, so a value that expands a reference to a reference indefinitely cannot loop; a reference this pass does not resolve leaves its literal text in place, which the scan then reads as before.
 */
function expandCharacterReferences(text) {
    let current = text;
    for (let pass = 0; pass < CHARACTER_REFERENCE_EXPANSION_PASSES; pass += 1) {
        const next = current.replace(CHARACTER_REFERENCE, (match, hex, decimal) => {
            const codePoint = hex === undefined ? Number(decimal) : Number.parseInt(hex, 16);
            if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff)
                return match;
            return String.fromCodePoint(codePoint);
        });
        if (next === current)
            break;
        current = next;
    }
    return current;
}
/**
 * The text the remote-reference scan reads: every backslash written as a forward slash.
 *
 * A browser reads `\` as `/` in a URL, exactly as `util/dom.ts` assumes when it normalizes backslashes before its own URL check, so `href="\\host/x"` is the protocol-relative `//host/x` the scan must refuse rather than a schemeless reference it reads as safe; normalizing here makes the refusal match the documentation.
 */
function normalizeReferenceSlashes(text) {
    return text.replace(/\\/g, "/");
}
/**
 * The document's root element start tag, read by walking comments, CDATA sections, processing instructions and tags in document order and returning the first start tag, or `null` when the root is not an `<svg>` element.
 *
 * A single regex over the raw text can only reach the first `<svg …>` spelling, which a decoy tag in a comment — or markup before the root — can supply; walking the markup in document order reaches the element a parser would treat as the root instead, so the dimension cap below is read from the root rather than from whichever spelling came first.
 */
function rootStartTag(svg) {
    for (const match of svg.matchAll(MARKUP_TOKEN)) {
        const token = match[0];
        if (token.startsWith("<!--") || token.startsWith("<![CDATA[") || token.startsWith("<?") || token.startsWith("</")) {
            continue;
        }
        const name = START_TAG_NAME.exec(token)?.[1];
        return name !== undefined && name.toLowerCase() === "svg" ? token : null;
    }
    return null;
}
/**
 * Read the `width` and `height` attributes out of a start-tag string by walking its attributes one by one.
 *
 * Each attribute is read by name and its value consumed whole, so a `width` that is a substring of another attribute's name (`stroke-width="64"`) or that sits inside another attribute's quoted value (`title="width=64"`) is never read as the root's own `width`; attribute names match case-sensitively, as XML attribute names do, so a differently-cased spelling a parser would ignore is not read here either.
 * A tag whose attributes cannot be walked — an unterminated quoted value, or a value or name that runs off the tag's end — is reported `unreadable`, so the caller refuses the icon rather than reading a dimension with a scan it cannot trust.
 */
function readRootDimensions(tag) {
    let width;
    let height;
    let index = 1;
    while (index < tag.length && /[\w:.-]/.test(tag[index]))
        index += 1;
    while (index < tag.length) {
        const char = tag[index];
        if (char === ">")
            break;
        if (/\s/.test(char)) {
            index += 1;
            continue;
        }
        if (char === "/") {
            index += 1;
            continue;
        }
        const nameStart = index;
        while (index < tag.length && !/[\s=/>"']/.test(tag[index]))
            index += 1;
        if (index === nameStart)
            return { width, height, unreadable: true };
        const name = tag.slice(nameStart, index);
        while (index < tag.length && /\s/.test(tag[index]))
            index += 1;
        let value;
        if (tag[index] === "=") {
            index += 1;
            while (index < tag.length && /\s/.test(tag[index]))
                index += 1;
            const quote = tag[index];
            if (quote === "\"" || quote === "'") {
                index += 1;
                const valueStart = index;
                while (index < tag.length && tag[index] !== quote)
                    index += 1;
                if (index >= tag.length)
                    return { width, height, unreadable: true };
                value = tag.slice(valueStart, index);
                index += 1;
            }
            else {
                const valueStart = index;
                while (index < tag.length && !/[\s>]/.test(tag[index]))
                    index += 1;
                if (index === valueStart)
                    return { width, height, unreadable: true };
                value = tag.slice(valueStart, index);
            }
        }
        if (name === "width" && width === undefined)
            width = value;
        else if (name === "height" && height === undefined)
            height = value;
    }
    return { width, height, unreadable: false };
}
/** Refuse a dimension outside `1` to {@link MAX_ICON_DIMENSION}, naming the spelling that was read through the same bounded preview the sibling validators use. */
function boundedDimension(value, raw, name) {
    if (!(value >= 1 && value <= MAX_ICON_DIMENSION)) {
        throw new InvalidIconError(`must set ${name} within 1..${MAX_ICON_DIMENSION}, got ${preview(raw)}`);
    }
    return value;
}
/**
 * The `width` or `height` the root `<svg>` element declares, refused unless it is a plain decimal within `1` to {@link MAX_ICON_DIMENSION}.
 *
 * Only the numeric attribute is accepted: a relative or unit-bearing value such as `100%` is refused, and a root that omits the attribute is refused too rather than falling back to its `viewBox`, because a `viewBox` alone leaves the browser's intrinsic size to its fixed default rather than to a bound this gate can check.
 * A `viewBox` alongside a bounded `width` and `height` does not change the intrinsic size the browser rasterizes at, so it needs no cap of its own.
 * The value was read from the root tag by the attribute walk above, not by a substring match, so a same-named substring elsewhere in the tag cannot supply it.
 */
function rootDimension(raw, name) {
    if (raw === undefined || !NUMERIC_DIMENSION.test(raw)) {
        throw new InvalidIconError(`must set a numeric ${name} on its <svg> root element`);
    }
    return boundedDimension(Number(raw), raw, name);
}
/**
 * The local name of an element name: everything after the last colon, which is where a namespace-aware parser binds the prefix or prefixes, lower-cased because this gate reads element names case-insensitively.
 *
 * A name with no colon is its own local name; a name with one or more prefixes (`svg:use`, `SVG:use`, `śvg:use`, `svg:Svg:use`) reduces to the part a parser would bind to the SVG namespace.
 */
function localName(name) {
    return name.slice(name.lastIndexOf(":") + 1).toLowerCase();
}
/**
 * Whether an element's local name is one this gate refuses.
 *
 * Besides the explicitly named {@link DENIED_ELEMENTS}, every `fe*` local name is refused: those are the SVG filter primitives, whose cost follows parameters such as `stdDeviation` and `numOctaves` rather than the icon's intrinsic size, so a permitted one could spend far more time or memory than the byte and dimension caps allow.
 * A non-primitive element whose name merely begins with `fe` is refused too; over-refusing such a name is the safe direction.
 */
function isDeniedElement(local) {
    return DENIED_ELEMENTS.has(local) || (local.startsWith("fe") && local.length > 2);
}
/**
 * The local name of the first element in `svg` whose name {@link isDeniedElement} refuses, or `null` when it carries none.
 *
 * The local name is read after the element name's last colon, so an element a namespace-aware parser binds to the SVG namespace — `svg:use`, `śvg:animate`, `SVG:use`, `svg:Svg:use` — is refused by the name it is bound to rather than treated as an unknown element, whatever the spelling or count of the prefix.
 */
function deniedElement(svg) {
    for (const match of svg.matchAll(ELEMENT_TAG)) {
        const local = localName(match[1]);
        if (isDeniedElement(local))
            return local;
    }
    return null;
}
/**
 * Validate an untrusted value into the canonical SVG text a caller may store.
 *
 * A string longer than {@link MAX_RAW_ICON_CODE_UNITS} is refused before it is composed, so the normalization and encoding below never do work proportional to an unbounded input.
 * The value is composed to NFC so one visible document has a single encoded form; the composed text must be 1 to {@link MAX_ICON_SVG_BYTES} UTF-8 bytes and must have no surrounding whitespace, so the cap bounds the bytes of the value a caller stores rather than the bytes of whatever spelling arrived.
 * Control characters other than newlines and tabs, invisible or direction-formatting characters, and lone surrogate code units are refused, exactly as the invoice's own text fields are.
 * The construct denylist then refuses an embedded script, an inline event handler whatever character separates its name from the element or the attribute before it, a `style=` attribute or `<style>` element, a denied element by its local name read after the element name's last colon whatever the spelling or count of its namespace prefix — including `<image>` and the other document and subresource loaders and the reference-carrying elements, so a nested document or an external reference cannot be smuggled in behind a value this scan does not read — an entity declaration, an external doctype, a `filter` attribute for the filter chain it names, and a remote reference spelled literally, reached by expanding numeric character references, written with a backslash a browser reads as a slash, or preceded by whitespace or control characters in the attribute value.
 * The document's root `<svg>` element must declare numeric `width` and `height` within `1` to {@link MAX_ICON_DIMENSION} and a `width` by `height` area within {@link MAX_ICON_PIXELS}.
 * The content refusals below are a heuristic over the raw text rather than a parse and are best-effort, so no content containment relies on them; the amplification-primitive, filter, loader, and dimension refusals are relied on to bound the render.
 * A value that is not a string throws a `TypeError`, naming what arrived through a bounded preview; a string that fails any check below throws an {@link InvalidIconError}.
 * Returns the NFC-composed text; a caller that stores it stores the canonical form.
 */
export function validateIcon(value) {
    if (typeof value !== "string") {
        throw new TypeError(`invoice: expected an SVG string, got ${preview(value)}`);
    }
    if (value.length > MAX_RAW_ICON_CODE_UNITS) {
        throw new InvalidIconError(`must be at most ${MAX_RAW_ICON_CODE_UNITS} characters before normalization, got ${value.length}`);
    }
    const svg = value.normalize("NFC");
    const bytes = utf8ToBytes(svg).length;
    if (bytes === 0 || bytes > MAX_ICON_SVG_BYTES) {
        throw new InvalidIconError(`must be 1 to ${MAX_ICON_SVG_BYTES} bytes of UTF-8, got ${bytes}`);
    }
    if (svg.trim() !== svg) {
        throw new InvalidIconError("must not start or end with whitespace");
    }
    if (MULTI_LINE_CONTROL.test(svg)) {
        throw new InvalidIconError("must not contain control characters other than newlines and tabs");
    }
    if (INVISIBLE_FORMATTING.test(svg)) {
        throw new InvalidIconError("must not contain invisible or direction-formatting characters");
    }
    if (LONE_SURROGATE.test(svg)) {
        throw new InvalidIconError("must not contain lone surrogate code units");
    }
    // The construct denylist below matches each pattern's spelling anywhere in the text, blind to quoting and to which character separates an attribute from its element, so a content spelling no pattern anticipates is not refused here; the amplification, filter, loader, and dimension checks that follow are the ones the render's cost depends on.
    const denied = deniedElement(svg);
    if (denied !== null) {
        throw new InvalidIconError(`must not contain a <${denied}> element`);
    }
    if (EVENT_HANDLER.test(svg)) {
        throw new InvalidIconError("must not contain an inline event handler");
    }
    if (/\bstyle\s*=/i.test(svg)) {
        throw new InvalidIconError("must not contain a style attribute");
    }
    if (FILTER_ATTRIBUTE.test(svg)) {
        throw new InvalidIconError("must not contain a filter attribute");
    }
    if (/<!entity\b/i.test(svg)) {
        throw new InvalidIconError("must not contain an entity declaration");
    }
    if (/<!doctype\b/i.test(svg)) {
        throw new InvalidIconError("must not contain a doctype declaration");
    }
    const literalReferences = normalizeReferenceSlashes(svg);
    const expandedReferences = normalizeReferenceSlashes(expandCharacterReferences(svg));
    if (REMOTE_REFERENCE.test(literalReferences) || REMOTE_REFERENCE.test(expandedReferences)) {
        throw new InvalidIconError("must not reference a remote resource");
    }
    const rootTag = rootStartTag(svg);
    if (rootTag === null) {
        throw new InvalidIconError("must contain a single <svg> root element");
    }
    const dimensions = readRootDimensions(rootTag);
    if (dimensions.unreadable) {
        throw new InvalidIconError("must carry readable width and height attributes on its <svg> root element");
    }
    const width = rootDimension(dimensions.width, "width");
    const height = rootDimension(dimensions.height, "height");
    const area = width * height;
    if (area > MAX_ICON_PIXELS) {
        throw new InvalidIconError(`must set a width by height area within 1..${MAX_ICON_PIXELS} pixels, got ${area}`);
    }
    return svg;
}
//# sourceMappingURL=icon.js.map