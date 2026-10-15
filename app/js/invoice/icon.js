/**
 * The icon validator: a bounded, canonicalizing input gate for an untrusted SVG document, plus a construct denylist whose content refusals are best-effort and not the security boundary.
 *
 * The content boundary is the browser's image context, not this module: the returned text is meant to be handed only to an `HTMLImageElement` `src` or drawn to a `<canvas>`, and a browser renders an SVG through either in secure animated image mode, where the document's script does not run and the resources it references are not fetched, while its animation is permitted and runs.
 * That browser-enforced property is what makes the named content bypasses inert — a character-reference URL scheme, `<svg/onload=…>`, a remote `href`, a CSS `image()`, and an external DTD all fail to execute or fetch in image context whatever their raw text says — so the denylist's content refusals do not need to be complete, and no content containment relies on them.
 * The animation that mode permits is the one thing it does not forbid, and the browser will not refuse it: a document carrying an animation element animates continuously in the payer's page and can change what it draws after it has loaded, so {@link DENIED_ELEMENTS} refuses every SMIL and SVG animation element by local name, and that refusal — not the browser — is what keeps an accepted icon still.
 * This module neither performs nor enforces that hand-off: it is an obligation on every consumer to hand the returned text only to one of those two image-context sinks and never to inline markup, a DOM parser, a navigation target, or a fetch, and a consumer that routes the text anywhere else loses the boundary these refusals assume.
 * Resource-exhaustion resistance is a different property, and it rests on three checks: the byte cap bounds the input and the raw path and noise data a document may carry; the dimension cap bounds the root `<svg>` element's intrinsic size to {@link MAX_ICON_DIMENSION} per axis and the declared area it implies to {@link MAX_ICON_PIXELS} pixels — the area check states that bound rather than adding one of its own — so the document is at most {@link MAX_ICON_DIMENSION} squared pixels when it is rendered as it stands, though a consumer that scales the icon up to a larger display size draws it in a viewport this cap does not bound; and the gate refuses the constructs whose cost that intrinsic size does not bound — the SMIL and SVG animation elements (`<animate>`, `<animateColor>`, `<animateMotion>`, `<animateTransform>`, `<discard>`, `<mpath>`, `<set>`) and the amplification element `<use>`, which let a tiny document rasterize a large or recursive target, and every filter construct (`<filter>`, any `fe*` filter primitive, and any `filter` attribute), whose cost follows parameters such as `stdDeviation` and `numOctaves`, or an intermediate surface larger than the icon's intrinsic size, rather than that size.
 * A document cannot sidestep those bounds by embedding a second one or resolving an external reference: the elements that would fetch a nested document or resolve a resource are refused by local name, and every `href`, `xlink:href`, and non-empty `url(…)` a surviving element carries must be a same-document `#` fragment, so an element the denylist does not name still cannot carry a relative or external reference into the render either.
 * Those refusals read the document through the spellings a parser resolves as well as through the text as it is written, so the class of obfuscated spellings is closed rather than the one spelling of each token: a character reference is expanded and a CSS backslash escape is resolved before a refused reference, `style` attribute, event handler, or `filter` attribute is read, which makes `url&#40;https://example.com/x.svg#p)` and `u\72 l(https://example.com/x.svg#p)` the references they become rather than token-free text.
 * Those refusals are relied on; the gate does not bound every remaining rendering parameter, so gradients, patterns, masks, clip paths, text, and arbitrary path data are not individually capped, and the intrinsic size clips what the browser paints but bounds no intermediate computation such constructs drive beyond the byte cap and the browser's own limits.
 * Its main jobs are to bound and canonicalize the value: it enforces the byte cap, canonicalizes the text through `util/icon-canonical-text.ts`'s `canonicalIconText` so one visible document has one encoding, refuses the control, invisible and lone-surrogate bytes that could confuse downstream handling, requires a numeric, pixel-bounded intrinsic size on the root `<svg>` element so the rasterizer's decode stays bounded, and requires that element to declare the SVG namespace so the image sink is never handed a document the browser refuses to decode.
 * The intrinsic size is read from the document's single root `<svg>` element, located by walking the markup in document order — rather than by taking the first `<svg …>` spelling, so a decoy tag inside a comment cannot stand in for the root — recognising a start tag whatever character its name begins with, so an element whose name a narrower reading would skip cannot precede the one the caps are read from, and tracking nesting depth, so a second element at the document level is refused while a nested `<svg>` inside the root is an ordinary SVG element; its `width` and `height` are read by exact attribute name so a same-named substring elsewhere cannot supply them, and a root that declares neither a numeric `width` nor a numeric `height` is refused, because a `viewBox` alone leaves the browser's intrinsic size to its fixed default rather than to a bound this gate can apply. An attribute the gate reads — `width`, `height`, or the namespace declaration it requires — that the root repeats is refused, because a duplicate attribute is a fatal XML error: a first-wins reading would admit a document the browser refuses to decode.
 * The walk assumes well-formed markup: an unterminated quoted attribute or a mismatched end tag can desynchronize it, so its root, single-root and dimension readings hold only for a document a conforming parser reads the same way, and a document it misreads is one the browser then refuses to decode as an image — the failure is closed rather than a bound that silently widens.
 * The construct denylist remains as defense-in-depth against a future change that routes the icon into inline markup, and it is honest about its reach: it is a regex over the text rather than a parse, and a conforming parser reads some spellings it does not, so a value that carries an unrefused content bypass is not thereby safe — the image context is.
 *
 * {@link validateIcon} accepts only a string within the byte cap, canonicalized through `util/icon-canonical-text.ts`'s `canonicalIconText`, and it then applies the construct denylist.
 * The denylist's element refusals read an element's local name after the element name's last colon, so `use`, `svg:use`, `SVG:use`, `śvg:use`, and `svg:Svg:use` are all refused as `use` rather than read as unknown elements, whatever the spelling or count of the namespace prefix they carry.
 * It additionally requires the document to hold a single root `<svg>` element, that element to declare the SVG namespace under the name that binds it — `xmlns` on an unprefixed root, `xmlns:<prefix>` on a prefixed one — so the gate admits no document the browser refuses to decode as an image, and that element to declare numeric `width` and `height` within `1` to {@link MAX_ICON_DIMENSION} and a `width` by `height` area within {@link MAX_ICON_PIXELS}, so a document cannot declare an intrinsic size larger than the cap. Each of those attributes must appear at most once on the root, since a browser refuses to decode a document that repeats one.
 * A value of another type throws a `TypeError`, naming what arrived through the same bounded preview the sibling address validators use; a string that fails any check throws an {@link InvalidIconError}, whose message is the reason alone, with no namespace of this module's own — `invoice/model.ts` publishes the gate's refusal under the icon field's `invoice: icon: ` prefix, once — and wrapping that into a user-facing error is the consumer's enforcement, outside this module.
 */
import { preview } from "../util/errors.js";
import { canonicalIconText } from "../util/icon-canonical-text.js";
import { iconByteLength } from "../util/icon-byte-length.js";
import { MAX_ICON_DIMENSION, MAX_ICON_RAW_CODE_UNITS, MAX_ICON_SVG_BYTES, iconByteCapRefusal, iconRawCodeUnitRefusal } from "../util/icon-capacity.js";
import { INVISIBLE_FORMATTING, LONE_SURROGATE, MULTI_LINE_CONTROL } from "../util/text.js";
/**
 * The two bounds this gate applies, re-exported from `util/icon-capacity.ts` under the names this validator's own bounds are read by: the UTF-8 byte cap and the per-axis dimension cap.
 */
export { MAX_ICON_DIMENSION, MAX_ICON_SVG_BYTES };
/** The largest area an icon's root `<svg>` element may declare, in pixels: {@link MAX_ICON_DIMENSION} squared, so the two caps bound one and the same corner and the area check states a bound the dimension cap already implies rather than narrowing it. */
export const MAX_ICON_PIXELS = MAX_ICON_DIMENSION * MAX_ICON_DIMENSION;
/**
 * The SVG namespace name a root `<svg>` element must declare: the one namespace a browser binds an SVG image to, matched by a parser as a name and never dereferenced.
 * The declaration is required because a root element outside that namespace is one the browser refuses to decode as an image, so the rasterizer's `decode()` rejects and the payer's export fails with an error instead of drawing the icon; the acceptance sweep exempts this one statement from its absolute-URL rule, which keeps the runtime free of references it could resolve, because an XML namespace name is never fetched.
 */
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
/**
 * A comment, a CDATA section, a processing instruction, or a start or end tag, matched in document order so {@link singleRootStartTag} can walk the markup rather than take the first `<svg …>` spelling to appear.
 *
 * A tag's name begins on any XML `NameStartChar` — a letter, `_`, or `:` — read here as any character that is not whitespace, `/`, `<` or `>`, so the walk sees every start tag a conforming parser accepts and no element can stand in front of the root unread.
 * The class is deliberately wider than XML's own, admitting a first character a name may not begin with; that direction only over-refuses, so a document this walk misreads is one a conforming parser refuses to decode.
 * The tag alternative consumes a quoted attribute value whole, so a `>` inside one does not end the tag early and {@link readRootAttributes} receives every attribute a parser would see.
 * The tag alternative still ends at the first `>` outside a quoted value and reads the markup as text rather than parsing it, so this is a heuristic scan of the raw text, not a parse.
 */
const MARKUP_TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[^\s/<>](?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
/** The name of a start tag — `svg` in `<svg>`, or `_p:svg` in `<_p:svg …>` — read as every character up to the first whitespace, `/`, `<` or `>`, so a name that starts on any XML `NameStartChar` is captured whole and its local name and namespace prefix follow from it. */
const START_TAG_NAME = /^<([^\s/<>]+)/;
/** A plain, non-negative decimal — the only `width`/`height` spelling the dimension check accepts. */
const NUMERIC_DIMENSION = /^\d+(?:\.\d+)?$/;
/**
 * Any processing instruction, refused outright: the XML declaration a document may open with, an `xml-stylesheet` instruction naming a stylesheet, and any other `<?…?>` the markup carries.
 * An `xml-stylesheet` instruction names a resource the image context would not fetch, and the XML declaration is one too; refusing the whole class is simpler than reading which instruction was written and admits no spelling of the class.
 */
const PROCESSING_INSTRUCTION = /<\?/;
/**
 * A `href` or `xlink:href` attribute, capturing its value so {@link hasNonFragmentReference} can read it.
 * The value is captured in whichever spelling a tag uses — double-quoted, single-quoted, or bare — and the leading boundary keeps the name from matching inside a longer one (`data-href`), while still matching an `href` a namespace prefix names (`foo:href`), which a parser binds to the same attribute.
 */
const REFERENCE_ATTRIBUTE = /(?:^|[^\w.-])(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`<>]+))/gi;
/**
 * A `url(…)` value with a non-empty argument, capturing that argument in whichever spelling a property uses — double-quoted, single-quoted, or bare — so a paint or mask reference is read as a reference too.
 * An empty argument — `url()` or a quoted `url("")` — names no resource a browser resolves, so it is not read as a reference, and the ordinary prose spelling `url()` in a `<title>` or `<desc>` is admitted.
 * The pattern reads one spelling of the token, so it is matched against every one of {@link parserReadings} rather than against the raw text alone: a `url(` a parser reaches by expanding a character reference or resolving a CSS escape is the reference this pattern reads.
 */
const URL_REFERENCE = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)"'\s]+))/gi;
/**
 * An inline event handler: an `on…` attribute name beginning at an attribute boundary.
 *
 * A name begins after whitespace, after the `/` that separates `<rect x="1" /onload=…>`, or after a stray quote, since a lenient parser reads each of those as an attribute of the element; those are the only boundaries this refusal reads, so a name that merely contains `on` (`data-once`) is an ordinary attribute.
 * The refusal keys on the name rather than on the separator before it and over-refuses a name that begins with `on` without being a handler (`once`, say) rather than miss a spelling.
 * The refusal is read over every one of {@link parserReadings}, so a document whose text spells the name after a rewriting is refused as well; XML resolves no reference and no CSS escape inside an attribute name, so no parser binds a handler from such a spelling — what that reading can reach is a resolved-text spelling the raw text does not carry, and it is read so that every refusal below covers one spelling set rather than one spelling set per construct.
 */
const EVENT_HANDLER = /(?:^|[\s"'/])on[a-z]+\s*=/i;
/**
 * A `style` attribute, read at the same attribute boundary as the event-handler refusal: an attribute genuinely named `style` is refused while a longer name that merely ends in it (`data-style`) is an ordinary attribute.
 * The `<style>` element is a separate refusal, stated with the other denied elements.
 * As with the event-handler refusal, this one is read over {@link parserReadings} although XML binds no attribute name out of a reference or an escape, so the reading reaches only a document whose resolved text spells the name where the raw text does not.
 */
const STYLE_ATTRIBUTE = /(?:^|[\s"'/])style\s*=/i;
/**
 * A `filter` attribute, which names a filter chain and so reaches the filter cost {@link DENIED_ELEMENTS} and {@link isDeniedElement} refuse; the attribute is refused outright rather than by the shape of its value.
 * The refusal reads the raw text alone: a `filter=` attribute is a name XML binds literally, and the reference a filter chain's `url(…)` value carries is read by {@link hasNonFragmentReference} over {@link parserReadings}.
 */
const FILTER_ATTRIBUTE = /\bfilter\s*=/i;
/**
 * The local names of the elements this gate refuses outright.
 *
 * The SMIL and SVG animation elements — `<animate>`, `<animateColor>`, `<animateMotion>`, `<animateTransform>`, `<discard>`, `<set>` — and the `<mpath>` an animation reads its path from are refused for two reasons: each is an amplification primitive a tiny document can point at a large or recursive target, so the render costs far more than its bytes, and each is an animation the image context permits, so a document carrying one animates continuously in the payer's page and can change what it draws after it has loaded.
 * `<use>` joins them as the hyperlink and amplification primitive that renders a target by reference, so a document can draw far more than it spells.
 * Both refusals are relied on: the amplification refusal bounds what a document that spells little can render, and the animation refusal is what keeps an accepted icon still.
 * `<script>`, `<style>`, `<foreignObject>`, `<handler>` and `<listener>` join them because each can carry or reach script in a sink other than an image context — `<handler>` being the element whose whole content is the script it runs when its event fires, and `<listener>` the element that binds an event to the script element its `handler` names.
 * `<filter>` joins them because a filter chain's execution cost is set by its parameters rather than by the icon's intrinsic size, and {@link isDeniedElement} refuses every `fe*` filter primitive for the same reason.
 * The document and subresource loaders — `<image>`, `<img>`, `<iframe>`, `<object>`, `<embed>`, `<link>`, `<audio>`, `<video>`, `<source>`, `<track>`, and the `<animation>` an SVG Tiny document loads a second animation from — join them because each names a resource to fetch and render, and `<image href="data:image/svg+xml;base64,…">` carries a whole second SVG document whose own constructs — a filter chain, an animation element, an unbounded viewport — this text scan never reads; refusing the element by local name closes that embedding whatever spelling its value takes, and keeps the module's external-loads-disabled premise true rather than leaving the nested load to the image context.
 * The reference-carrying elements — `<tref>`, `<cursor>`, `<font-face-uri>`, `<color-profile>`, `<altGlyph>`, `<glyphRef>` — join them for the same reason: each resolves an `href` or `xlink:href` to a resource (a text element, a cursor image, a font file, an ICC profile, or a glyph), so a relative or otherwise scan-invisible value still names a load the element's refusal keeps out.
 */
const DENIED_ELEMENTS = new Set([
    "script",
    "style",
    "foreignobject",
    "handler",
    "listener",
    "filter",
    "animate",
    "animatecolor",
    "animatemotion",
    "animatetransform",
    "discard",
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
    "animation",
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
 * An element name is read from the raw text alone, and no resolved reading of it is taken: XML expands no reference and resolves no escape inside a name, so an element spelled `&lt;use&gt;` is text a parser renders rather than the element this refusal names.
 */
const ELEMENT_TAG = /<\/?([^\s/<>]+)/g;
/**
 * A character reference as an XML parser expands one: a decimal or hexadecimal numeric reference, or one of the five predefined entity names.
 * Only those five names are read, because the image context parses the document as XML with no doctype — this gate refuses a doctype declaration — and an XML processor declares no entity beyond them; a name outside them is left as written rather than guessed at.
 * The semicolon a conforming parser requires is part of the pattern, so a spelling a parser would leave as literal text is left so here as well.
 */
const CHARACTER_REFERENCE = /&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));|&(amp|lt|gt|quot|apos);/g;
/** The character each of the five predefined entity names stands for; every other entity name is unbound in a document this gate admits, since the doctype that could declare one is refused. */
const PREDEFINED_ENTITIES = new Map([
    ["amp", "&"],
    ["lt", "<"],
    ["gt", ">"],
    ["quot", "\""],
    ["apos", "'"],
]);
/**
 * A CSS escape as a CSS parser resolves one in a value: up to six hexadecimal digits, whose single following whitespace is the escape's terminator rather than content, a backslash before a newline, which stands for nothing, or a backslash before any other single character, which stands for that character.
 * These are the escapes of the CSS a presentation attribute or a property value is read as: `u\72 l(https://example.com/x.svg#p)` is the `url(…)` reference a CSS parser reads from it.
 */
const CSS_ESCAPE = /\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|(\r\n|[\n\r\f])|([\s\S]))/g;
/**
 * Raised by {@link validateIcon} for a string that fails a value check — an empty or over-long document or a forbidden construct; a value of another type throws a `TypeError` instead.
 *
 * The message is the reason alone: the `invoice:` namespace belongs to the model layer that wraps this refusal under the icon field's path, so a prefix applied here as well would reach a payer as `invoice: icon: invoice: …`.
 */
export class InvalidIconError extends Error {
    constructor(reason) {
        super(reason);
        this.name = "InvalidIconError";
    }
}
/** The character a numeric reference's code point stands for, or `null` for a code point XML and CSS both refuse — `0`, a surrogate, or one past `0x10FFFF` — which leaves that reference as written. */
function referencedCharacter(point) {
    if (!Number.isInteger(point) || point <= 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff))
        return null;
    return String.fromCodePoint(point);
}
/**
 * `text` with every character reference an XML parser would expand replaced by the character it stands for, read in one pass so a reference is never resolved out of what an earlier one produced.
 * A reference XML does not admit is left as written, which states no spelling a parser reads differently: a document carrying one is one a conforming parser refuses outright.
 */
function resolveCharacterReferences(text) {
    return text.replace(CHARACTER_REFERENCE, (reference, hex, decimal, name) => {
        if (name !== undefined)
            return PREDEFINED_ENTITIES.get(name) ?? reference;
        const point = Number.parseInt(hex ?? decimal ?? "", hex === undefined ? 10 : 16);
        return referencedCharacter(point) ?? reference;
    });
}
/** `text` with every CSS escape a CSS parser would resolve replaced by what it stands for, read in one pass; an escape whose code point CSS does not admit is left as written. */
function resolveCssEscapes(text) {
    return text.replace(CSS_ESCAPE, (escape, hex, lineBreak, character) => {
        if (character !== undefined)
            return character;
        if (lineBreak !== undefined)
            return "";
        return referencedCharacter(Number.parseInt(hex ?? "", 16)) ?? escape;
    });
}
/**
 * The spellings a parser reads `text` through, as an array: the text exactly as it is written, and the text with its character references expanded and then its CSS escapes resolved, which is the order a parser applies the two rewritings — an XML parser expands a reference into the attribute value it hands on, and a CSS parser then resolves the escapes of the value it was given.
 *
 * The reference, style, event-handler and filter refusals each read every spelling here, so a refused construct carried through either rewriting is refused as the construct a parser would read rather than admitted as the token-free text it is written as; the element-name and markup-declaration refusals read the raw text alone, because XML resolves neither a reference nor an escape inside an element name, an attribute name, or a declaration keyword, so a parser binds those constructs only where the text spells them literally.
 * Resolving the two rewritings across the whole text rather than inside the values that carry a reference over-refuses a document whose text or attribute values spell a refused token only once resolved — the direction this gate already errs in for a reference written with a leading space or a separator inside its scheme.
 */
function parserReadings(text) {
    return [text, resolveCssEscapes(resolveCharacterReferences(text))];
}
/**
 * Whether a spelling of the document carries a reference that is not a same-document fragment: a `href`/`xlink:href` value or a `url(…)` value with a non-empty argument that does not begin with `#`.
 *
 * Only a `#`-prefixed value is a same-document reference; every other value — a bare relative path, an absolute URL, a scheme such as `data:` or `javascript:`, or a protocol-relative `//` — names a resource outside the document, so it is refused whatever it resolves to.
 * The value is read as its spelling states it, without stripping a separator or resolving one reference inside it: a value whose literal form does not begin with `#` is refused even where a parser would resolve it to a fragment, which over-refuses a spelling whose visible text already states a reference this gate does not admit.
 * The caller reads this over every one of {@link parserReadings}, so the `url(` token itself is read in the spellings a parser resolves as well as in the raw text: `url&#40;https://example.com/x.svg#p)` and `u\72 l(https://example.com/x.svg#p)` are each the `url(…)` reference this rule refuses, not the token-free text they are written as.
 * The reference check is a regex over a spelling rather than a parse, like the rest of the denylist, so a spelling neither the raw text nor the resolved text states is not thereby admitted by the image context — the render still happens in the browser's secure animated image mode, where no reference is fetched.
 */
function hasNonFragmentReference(text) {
    for (const match of text.matchAll(REFERENCE_ATTRIBUTE)) {
        if (!(match[1] ?? match[2] ?? match[3] ?? "").startsWith("#"))
            return true;
    }
    for (const match of text.matchAll(URL_REFERENCE)) {
        if (!(match[1] ?? match[2] ?? match[3] ?? "").startsWith("#"))
            return true;
    }
    return false;
}
/**
 * The document's single root element start tag, read by walking comments, CDATA sections, processing instructions and tags in document order: the first start tag when its element name's local name is `svg` and no second start tag appears outside it, or `null` otherwise.
 * The local name is read after the element name's last colon, as every other element refusal in this module reads it, so a prefixed root such as `<svg:svg>` is the root rather than an element this gate does not know.
 *
 * A single regex over the raw text can only reach the first `<svg …>` spelling, which a decoy tag in a comment — or markup before the root — can supply; walking the markup in document order reaches the element a parser would treat as the root instead, so the dimension cap below is read from the root rather than from whichever spelling came first.
 * {@link MARKUP_TOKEN} recognizes a tag whatever character its name begins with, so the element this walk reports is the document's first start tag and an element a narrower reading would skip cannot stand in front of the validated one.
 * The walk tracks nesting depth so the document is refused when it closes its root and opens another element: a nested `<svg>` inside the root is an ordinary SVG element and is admitted, while a second element at the document level leaves the value with more than one root and a browser refuses to decode it as an image, which is why the refusal names a single root.
 * A start tag that ends in `/>` leaves the depth unchanged and every other start tag raises it, an end tag lowers it, and comments, CDATA sections and processing instructions are skipped, so a self-closing root or child does not skew the count and a leading or trailing comment is admitted; an unclosed root is left to the browser rather than refused here, since this walk reads nesting rather than well-formedness.
 * A malformed document can desynchronize the walk, since it reads nesting rather than well-formedness; that only fails closed, because the browser then refuses to decode the document as an image.
 */
function singleRootStartTag(svg) {
    let root = null;
    let depth = 0;
    for (const match of svg.matchAll(MARKUP_TOKEN)) {
        const token = match[0];
        if (token.startsWith("<!--") || token.startsWith("<![CDATA[") || token.startsWith("<?"))
            continue;
        if (token.startsWith("</")) {
            if (depth > 0)
                depth -= 1;
            continue;
        }
        const name = START_TAG_NAME.exec(token)?.[1];
        if (root === null) {
            if (name === undefined || localName(name) !== "svg")
                return null;
            root = token;
        }
        else if (depth === 0) {
            return null;
        }
        if (!token.endsWith("/>"))
            depth += 1;
    }
    return root;
}
/**
 * Read a start-tag string's attributes into a map keyed by attribute name, walking them one by one.
 *
 * Each attribute is read by name and its value consumed whole, so a `width` that is a substring of another attribute's name (`stroke-width="64"`) or that sits inside another attribute's quoted value (`title="width=64"`) is never read as the root's own attribute; attribute names match case-sensitively, as XML attribute names do, so a differently-cased spelling a parser would ignore is not read here either. The first spelling of a name wins, as a parser's attribute mapping would have it, and every name the tag declares more than once is reported in `repeated` so {@link requireUniqueReadAttributes} can refuse a root a parser rejects as malformed rather than read it by the first value alone.
 * A tag whose attributes cannot be walked — an unterminated quoted value, or a value or name that runs off the tag's end — is reported `unreadable`, so the caller refuses the icon rather than reading an attribute with a scan it cannot trust.
 * A walk desynchronized by a malformed document can report an attribute it did not read from the root; that too fails closed, since the browser refuses to decode a document a conforming parser cannot read.
 */
function readRootAttributes(tag) {
    const attributes = new Map();
    const repeated = new Set();
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
            return { attributes, repeated, unreadable: true };
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
                    return { attributes, repeated, unreadable: true };
                value = tag.slice(valueStart, index);
                index += 1;
            }
            else {
                const valueStart = index;
                while (index < tag.length && !/[\s>]/.test(tag[index]))
                    index += 1;
                if (index === valueStart)
                    return { attributes, repeated, unreadable: true };
                value = tag.slice(valueStart, index);
            }
        }
        if (attributes.has(name))
            repeated.add(name);
        else
            attributes.set(name, value);
    }
    return { attributes, repeated, unreadable: false };
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
 * The attribute name that binds `elementName` to a namespace: `xmlns` on an unprefixed element and `xmlns:<prefix>` on a prefixed one, the spelling a namespace-aware parser binds the element by.
 */
function namespaceDeclaration(elementName) {
    const prefixEnd = elementName.lastIndexOf(":");
    return prefixEnd === -1 ? "xmlns" : `xmlns:${elementName.slice(0, prefixEnd)}`;
}
/**
 * Refuse a root `<svg>` start tag that does not declare the SVG namespace under the name that binds the element's own prefix.
 *
 * An unprefixed `<svg>` root is bound by a default `xmlns` declaration and a prefixed one (`<svg:svg>`) by `xmlns:svg`, so the requirement is read in the spelling the document itself uses rather than from one fixed attribute name.
 * A document whose root element is not in the SVG namespace is not an SVG image: the browser refuses to decode it in an image context, so the rasterizer's `decode()` rejects and the payer's export fails with an error rather than drawing the icon, and the gate refuses the document here instead of admitting it into that path.
 * A declaration naming another namespace is refused too, whatever else the document carries: a parser binds the root to the one name it is given.
 */
function requireRootNamespace(attributes, elementName) {
    const declaration = namespaceDeclaration(elementName);
    if (attributes.get(declaration) === SVG_NAMESPACE)
        return;
    throw new InvalidIconError(`must declare ${declaration}="${SVG_NAMESPACE}" on its <svg> root element`);
}
/**
 * Refuse a root `<svg>` start tag that declares any attribute the root check reads more than once: `width`, `height`, or the namespace declaration that binds the element's own prefix.
 *
 * A duplicate attribute is a fatal XML error, so a browser refuses to decode such a document as an image while a first-wins attribute reading admits it — the very document this gate's stated invariant forbids it to admit — and refusing the root here keeps the value a caller stores one the image sink renders.
 * The check reads the names the walk recorded as repeated rather than re-reading the tag, so a repeat spelled at any position with any value is refused.
 */
function requireUniqueReadAttributes(root, elementName) {
    for (const name of ["width", "height", namespaceDeclaration(elementName)]) {
        if (root.repeated.has(name)) {
            throw new InvalidIconError(`must not declare ${name} more than once on its <svg> root element`);
        }
    }
}
/**
 * Validate an untrusted value into the canonical SVG text a caller may store.
 *
 * A string longer than {@link MAX_ICON_RAW_CODE_UNITS} is refused before it is composed, with {@link iconRawCodeUnitRefusal}, the one wording of that bound, so the normalization and encoding below never do work proportional to an unbounded input; a spelling handed in through the create form's file read cannot reach that refusal, because that read bounds the file's bytes before decoding it and a UTF-8 file decodes to at most one code unit per byte.
 * Its surrounding whitespace is trimmed rather than refused by `util/icon-canonical-text.ts`'s `canonicalIconText`, so the newline an editor leaves at a file's end is not a fault, and every check below reads the canonical text.
 * That canonicalization is the one definition of canonical icon text this gate and the create form share, so one visible document has a single encoded form and the create form's icon field accepts or refuses a chosen file on the text this gate stores.
 * The byte cap is measured over that canonical text — `util/icon-byte-length.ts`'s `iconByteLength` measures the text it is handed — so the value is canonicalized once at this call site rather than a second time behind the measurement.
 * The canonical text must not be empty and must be at most {@link MAX_ICON_SVG_BYTES} UTF-8 bytes, so the cap bounds the bytes of the value a caller stores rather than the bytes of whatever spelling arrived.
 * An over-cap value is refused with {@link iconByteCapRefusal}, the one wording of that refusal, which the create form shows under the icon field; an empty value is its own fault rather than a cap it exceeded.
 * Control characters other than newlines and tabs, invisible or direction-formatting characters, and lone surrogate code units are refused, exactly as the invoice's own text fields are.
 * The construct denylist then refuses a processing instruction, an embedded script, an inline event handler and a `style` attribute, each read where its name begins at an attribute boundary so `data-once` and `data-style` stay ordinary attribute names, or a `<style>` element, a denied element by its local name read after the element name's last colon whatever the spelling or count of its namespace prefix — including `<image>`, the other document and subresource loaders, and the reference-carrying elements, so a nested document or an external reference cannot be smuggled in behind a value this scan does not read — an entity declaration, an external doctype, a `filter` attribute for the filter chain it names, and every `href`, `xlink:href`, and non-empty `url(…)` value that does not begin with `#`, so a relative or external reference on an element the denylist does not name is refused as well.
 * The reference, `style`, event-handler, and `filter` refusals are read over every one of {@link parserReadings}, so each is refused in the spelling a parser resolves as well as in the raw text, whatever rewriting the document carries that token through.
 * The document must then hold a single root `<svg>` element — a second element at the document level is refused — that element must declare the SVG namespace under the name that binds it, so the value a caller stores is one the browser decodes rather than one the image sink rejects, and it must declare numeric `width` and `height` within `1` to {@link MAX_ICON_DIMENSION} and a `width` by `height` area within {@link MAX_ICON_PIXELS}. Each of those attributes — `width`, `height`, and the declaration — must appear at most once on the root, because a browser refuses to decode a document that repeats one.
 * The content refusals below are a heuristic over the text rather than a parse and are best-effort, so no content containment relies on them; the amplification-primitive, filter, loader, reference, and dimension refusals are relied on to bound the render.
 * A value that is not a string throws a `TypeError`, naming what arrived through a bounded preview; a string that fails any check below throws an {@link InvalidIconError}.
 * Returns the trimmed, NFC-composed text; a caller that stores it stores the canonical form.
 */
export function validateIcon(value) {
    if (typeof value !== "string") {
        throw new TypeError(`expected an SVG string, got ${preview(value)}`);
    }
    if (value.length > MAX_ICON_RAW_CODE_UNITS) {
        throw new InvalidIconError(iconRawCodeUnitRefusal(value.length));
    }
    const svg = canonicalIconText(value);
    const bytes = iconByteLength(svg);
    if (bytes === 0) {
        throw new InvalidIconError("must not be empty");
    }
    if (bytes > MAX_ICON_SVG_BYTES) {
        throw new InvalidIconError(iconByteCapRefusal(bytes));
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
    if (PROCESSING_INSTRUCTION.test(svg)) {
        throw new InvalidIconError("must not contain a processing instruction");
    }
    // The construct denylist below matches each pattern's spelling anywhere in the text, blind to quoting and to which character separates an attribute from its element, so a content spelling no pattern anticipates is not refused here; each reference, style, event-handler, and filter rule is read over the raw text and over the spelling a parser resolves, so a token carried through a character reference or a CSS escape is refused as well; the amplification, filter, reference, loader, and dimension checks that follow are the ones the render's cost and its external-loads-disabled premise depend on.
    const denied = deniedElement(svg);
    if (denied !== null) {
        throw new InvalidIconError(`must not contain a <${denied}> element`);
    }
    for (const reading of parserReadings(svg)) {
        if (EVENT_HANDLER.test(reading)) {
            throw new InvalidIconError("must not contain an inline event handler");
        }
        if (STYLE_ATTRIBUTE.test(reading)) {
            throw new InvalidIconError("must not contain a style attribute");
        }
        if (FILTER_ATTRIBUTE.test(reading)) {
            throw new InvalidIconError("must not contain a filter attribute");
        }
        if (hasNonFragmentReference(reading)) {
            throw new InvalidIconError("must reference only a same-document fragment");
        }
    }
    if (/<!entity\b/i.test(svg)) {
        throw new InvalidIconError("must not contain an entity declaration");
    }
    if (/<!doctype\b/i.test(svg)) {
        throw new InvalidIconError("must not contain a doctype declaration");
    }
    const rootTag = singleRootStartTag(svg);
    if (rootTag === null) {
        throw new InvalidIconError("must contain a single <svg> root element");
    }
    const elementName = START_TAG_NAME.exec(rootTag)?.[1] ?? "";
    const root = readRootAttributes(rootTag);
    if (root.unreadable) {
        throw new InvalidIconError("must carry a root <svg> element whose attributes can be read");
    }
    requireUniqueReadAttributes(root, elementName);
    const width = rootDimension(root.attributes.get("width"), "width");
    const height = rootDimension(root.attributes.get("height"), "height");
    const area = width * height;
    if (area > MAX_ICON_PIXELS) {
        throw new InvalidIconError(`must set a width by height area of at most ${MAX_ICON_PIXELS} pixels, got ${area}`);
    }
    requireRootNamespace(root.attributes, elementName);
    return svg;
}
//# sourceMappingURL=icon.js.map