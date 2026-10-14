/** The suite for the invoice icon validator and the `data:` URL leaf: the round trip through `svgDataUrl`/`isSvgDataUrl` and the accept/refuse boundary of `validateIcon`. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidIconError, MAX_ICON_DIMENSION, MAX_ICON_PIXELS, MAX_ICON_SVG_BYTES, validateIcon } from "../app/js/invoice/icon.js";
import { MAX_SVG_DATA_URL_PAYLOAD, isSvgDataUrl } from "../app/js/util/data-url.js";
import { MAX_ICON_FILE_BYTES, MAX_ICON_RAW_CODE_UNITS, iconFileSizeRefusal, iconRawCodeUnitRefusal } from "../app/js/util/icon-capacity.js";
import { svgDataUrl } from "../app/js/util/svg-data-url.js";
import { refusalError, refusalMessage } from "./helpers/refusals.mjs";

const PREFIX = "data:image/svg+xml;base64,";
const SMALL_SVG = "<svg width=\"64\" height=\"64\" xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"64\" height=\"64\"/></svg>";
const BYTE_CAP_HEAD = "<svg width=\"64\" height=\"64\">";
const BYTE_CAP_TAIL = "</svg>";
const SVG_AT_BYTE_CAP = BYTE_CAP_HEAD + "x".repeat(MAX_ICON_SVG_BYTES - BYTE_CAP_HEAD.length - BYTE_CAP_TAIL.length) + BYTE_CAP_TAIL;

test("svgDataUrl encodes an SVG and isSvgDataUrl recognizes the result", () => {
	const url = svgDataUrl(SMALL_SVG);
	assert.ok(url.startsWith(PREFIX));
	assert.equal(isSvgDataUrl(url), true);
	assert.equal(Buffer.from(url.slice(PREFIX.length), "base64").toString("utf8"), SMALL_SVG);
});

test("svgDataUrl round-trips a multibyte SVG in both NFC and NFD", () => {
	// "ü" is one two-byte NFC code point (`Süß`) or a base letter plus a combining diaeresis in NFD; both spellings must survive the UTF-8/base64 round trip byte for byte, and neither is normalized by the leaf.
	const nfc = "<svg width=\"64\" height=\"64\" xmlns=\"http://www.w3.org/2000/svg\"><title>Süß — 日本</title></svg>";
	const nfd = "<svg width=\"64\" height=\"64\" xmlns=\"http://www.w3.org/2000/svg\"><title>Su\u0308ß — 日本</title></svg>";
	for (const svg of [nfc, nfd]) {
		const url = svgDataUrl(svg);
		assert.equal(isSvgDataUrl(url), true);
		assert.equal(Buffer.from(url.slice(PREFIX.length), "base64").toString("utf8"), svg);
	}
});

test("isSvgDataUrl refuses a non-SVG data URL, a non-data URL, an empty payload, and a non-string", () => {
	assert.equal(isSvgDataUrl("data:text/html;base64,PGgxPmhpPC9oMT4="), false);
	assert.equal(isSvgDataUrl("https://example.com/logo.svg"), false);
	assert.equal(isSvgDataUrl(PREFIX), false);
	assert.equal(isSvgDataUrl(123), false);
});

test("isSvgDataUrl accepts a well-shaped payload without decoding it", () => {
	// `QUJD` is whole-group base64 (`"ABC"`), so the shape check recognizes the value; the check validates the payload's spelling, not that it decodes to a complete document.
	assert.equal(isSvgDataUrl(PREFIX + "QUJD"), true);
	assert.equal(Buffer.from("QUJD", "base64").toString("utf8"), "ABC");
	// A payload whose length is not a whole number of `=`-padded groups is refused on its shape alone.
	assert.equal(isSvgDataUrl(PREFIX + "QUJ"), false);
});

test("isSvgDataUrl refuses a payload carrying any character after its base64 groups", () => {
	// The shape check asserts the end of the input, so a trailing line terminator — which the encoder never emits — is refused rather than read as the end of the payload.
	assert.equal(isSvgDataUrl(PREFIX + "AAA\n"), false);
	assert.equal(isSvgDataUrl(PREFIX + "AA=\n"), false);
	assert.equal(isSvgDataUrl(PREFIX + "AAA\u2028"), false);
	// A payload that is itself well shaped is still recognized with no terminator, so the end-of-input assertion does not close the gate on the values the encoder emits.
	assert.equal(isSvgDataUrl(PREFIX + "AAA"), false, "three characters are not a whole four-character group");
	assert.equal(isSvgDataUrl(PREFIX + "AAAA"), true);
	assert.equal(isSvgDataUrl(PREFIX + "AA=="), true);
});

test("isSvgDataUrl refuses a well-shaped but over-long payload on length alone, without decoding", () => {
	const payload = "A".repeat(MAX_SVG_DATA_URL_PAYLOAD + 4);
	assert.equal(payload.length % 4, 0, "the fixture is a whole number of base64 groups");
	// This payload is valid base64, so a decode would succeed; the refusal is the length ceiling, not a decode failure.
	assert.equal(isSvgDataUrl(PREFIX + payload), false);
	// The ceiling is `4 * ceil(8192 / 3)` = 10 924 characters, so a 10 000-character payload sits under it and decodes to 7 500 bytes: the shape check admits it without decoding it, and a whole group past the ceiling is what it refuses.
	assert.equal(isSvgDataUrl(PREFIX + "A".repeat(10_000)), true);
	assert.equal(Buffer.from("A".repeat(10_000), "base64").length, 7_500);
	// A payload at the ceiling carrying the padding the encoder emits is still recognized, so the gate bounds the cost without demanding an SVG.
	assert.equal(isSvgDataUrl(PREFIX + "A".repeat(MAX_SVG_DATA_URL_PAYLOAD - 1) + "="), true);
});

test("isSvgDataUrl admits exactly the payloads that decode within the byte cap", () => {
	// The ceiling is a length, but the decoded size also depends on the padding: a full-length unpadded payload decodes to one byte past the cap, while the same length with the padding the encoder emits decodes to the cap.
	const atCap = "A".repeat(MAX_SVG_DATA_URL_PAYLOAD - 1) + "=";
	assert.equal(Buffer.from(atCap, "base64").length, MAX_ICON_SVG_BYTES, "the padded fixture decodes to exactly the cap");
	assert.equal(isSvgDataUrl(PREFIX + atCap), true);
	const oneByteOver = "A".repeat(MAX_SVG_DATA_URL_PAYLOAD);
	assert.equal(Buffer.from(oneByteOver, "base64").length, MAX_ICON_SVG_BYTES + 1, "the unpadded fixture decodes one byte past the cap");
	assert.equal(isSvgDataUrl(PREFIX + oneByteOver), false, "a full-length unpadded payload is refused as over the byte cap");
});

test("the `data:` URL leaf caps an SVG at the icon byte cap exactly", () => {
	// The leaf derives its payload ceiling from the shared icon byte-cap contract, so this test pins the boundary the cap sets: a document at the cap is encoded and one byte more is refused.
	// The encoded-length equality alone cannot catch a cap one byte too large, because `4 * ceil(bytes / 3)` is the same for 8192 and 8193 bytes.
	assert.equal(Buffer.byteLength(SVG_AT_BYTE_CAP, "utf8"), MAX_ICON_SVG_BYTES, "the fixture sits exactly at the icon byte cap");
	assert.equal(isSvgDataUrl(svgDataUrl(SVG_AT_BYTE_CAP)), true);
	assert.throws(() => svgDataUrl(`${SVG_AT_BYTE_CAP}x`), RangeError);
	assert.equal(MAX_SVG_DATA_URL_PAYLOAD, 4 * Math.ceil(MAX_ICON_SVG_BYTES / 3));
});

test("validateIcon accepts a small numeric-sized SVG unchanged", () => {
	assert.equal(validateIcon(SMALL_SVG), SMALL_SVG);
});

test("validateIcon composes its text to NFC", () => {
	const nfd = "<svg width=\"64\" height=\"64\"><title>cafe\u0301</title></svg>";
	assert.equal(validateIcon(nfd), nfd.normalize("NFC"));
});

test("validateIcon measures the byte cap on the NFC form it stores, not the NFD spelling it is given", () => {
	const overhead = Buffer.byteLength(BYTE_CAP_HEAD + BYTE_CAP_TAIL, "utf8");
	// Each NFD "é" (`e\u0301`) is three UTF-8 bytes and composes to the two-byte NFC "é", so this document is over the cap as typed yet inside it once composed.
	const count = Math.floor((MAX_ICON_SVG_BYTES - overhead) / 2);
	const nfd = BYTE_CAP_HEAD + "e\u0301".repeat(count) + BYTE_CAP_TAIL;
	const nfc = nfd.normalize("NFC");
	assert.ok(Buffer.byteLength(nfd, "utf8") > MAX_ICON_SVG_BYTES, "the NFD spelling exceeds the cap");
	assert.ok(Buffer.byteLength(nfc, "utf8") <= MAX_ICON_SVG_BYTES, "the NFC form sits within the cap");
	assert.equal(validateIcon(nfd), nfc);
});

test("validateIcon accepts a document exactly at the byte cap and refuses one byte over", () => {
	assert.equal(Buffer.byteLength(SVG_AT_BYTE_CAP, "utf8"), MAX_ICON_SVG_BYTES, "the fixture sits exactly at the cap");
	assert.equal(validateIcon(SVG_AT_BYTE_CAP), SVG_AT_BYTE_CAP);
	const overCap = `${SVG_AT_BYTE_CAP}x`;
	const error = refusalError(() => validateIcon(overCap));
	assert.ok(error instanceof InvalidIconError, "one byte past the cap is refused");
	assert.equal(
		error.message,
		`The icon is ${Buffer.byteLength(overCap, "utf8")} bytes, over the ${MAX_ICON_SVG_BYTES}-byte limit.`,
		"the refusal is the shared byte-cap wording, which the create form shows under the icon field as well",
	);
});

test("validateIcon throws a TypeError for a non-string and refuses an empty or over-cap SVG", () => {
	assert.throws(() => validateIcon(42), TypeError);
	assert.equal(refusalMessage(() => validateIcon("")), "must not be empty", "an empty document is refused as its own fault rather than as a cap it exceeded");
	const huge = `<svg width="64" height="64">${"x".repeat(MAX_ICON_SVG_BYTES)}</svg>`;
	assert.throws(() => validateIcon(huge), InvalidIconError);
});

test("validateIcon refuses surrounding whitespace, including around NFD text", () => {
	const nfd = "<svg width=\"64\" height=\"64\"><title>cafe\u0301</title></svg>";
	assert.throws(() => validateIcon(` ${nfd}`), InvalidIconError);
	assert.throws(() => validateIcon(`${nfd} `), InvalidIconError);
});

test("validateIcon refuses a control character", () => {
	assert.throws(() => validateIcon("<svg width=\"64\" height=\"64\"><title>\u0001</title></svg>"), InvalidIconError);
});

test("validateIcon refuses an invisible formatting character", () => {
	assert.throws(() => validateIcon("<svg width=\"64\" height=\"64\"><title>\u200B</title></svg>"), InvalidIconError);
});

test("validateIcon refuses a lone surrogate code unit", () => {
	assert.throws(() => validateIcon("<svg width=\"64\" height=\"64\"><title>\uD800</title></svg>"), InvalidIconError);
});

test("validateIcon refuses script, event handlers, entities, styles, and foreignObject", () => {
	const wrap = (inner) => `<svg width="64" height="64">${inner}</svg>`;
	assert.throws(() => validateIcon(wrap("<script>alert(1)</script>")), InvalidIconError);
	assert.throws(() => validateIcon("<svg width=\"64\" height=\"64\" onload=\"alert(1)\"></svg>"), InvalidIconError);
	// A handler whose preceding separator hides it from a whitespace-anchored reading: the `/` after another attribute, and a stray quote in the same position, both leave a lenient parser reading `onload` as an attribute of the element.
	assert.throws(() => validateIcon(wrap("<rect x=\"1\" /onload=\"alert(1)\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<rect x=\"1\"onload=\"alert(1)\"/>")), InvalidIconError);
	assert.throws(() => validateIcon("<!ENTITY x SYSTEM \"http://example.com/x\">"), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<style>@import url(https://example.com/x.css);</style>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<foreignObject></foreignObject>")), InvalidIconError);
});

test("validateIcon refuses the named content-bypass classes as defense-in-depth", () => {
	const wrap = (inner) => `<svg width="64" height="64">${inner}</svg>`;
	// A URL scheme spelled as a numeric character reference is invisible to a literal scan but resolved by a parser.
	assert.throws(() => validateIcon(wrap("<a href=\"&#x68;ttp://example.com/x.png\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<a href=\"&#104;ttp://example.com/x.png\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<rect fill=\"url(&#x68;ttp://example.com/p.svg#p)\"/>")), InvalidIconError);
	// A reference to `&` re-forms the reference on a second pass, so a nested spelling resolves too.
	assert.throws(() => validateIcon(wrap("<a href=\"&#38;#x68;ttp://example.com/x.png\"/>")), InvalidIconError);
	// The `/` element/attribute separator, where a lenient parser reads `onload` as an attribute of the element.
	assert.throws(() => validateIcon("<svg/onload=\"alert(1)\"></svg>"), InvalidIconError);
	// A SMIL element that can pull a remote hyperlink.
	assert.throws(() => validateIcon(wrap("<animate attributeName=\"href\" href=\"http://example.com/x.svg\"/>")), InvalidIconError);
	// CSS `image()` through a style attribute or a style element.
	assert.throws(() => validateIcon("<svg width=\"64\" height=\"64\" style=\"background-image:image(http://example.com/x.png)\"><rect width=\"64\" height=\"64\"/></svg>"), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<style>rect{fill:url(http://example.com/x.svg#p)}</style>")), InvalidIconError);
	// An external DTD subset.
	assert.throws(() => validateIcon("<!DOCTYPE svg SYSTEM \"http://example.com/svg.dtd\">"), InvalidIconError);
});

test("validateIcon refuses a missing, non-numeric, or over-large dimension", () => {
	assert.throws(() => validateIcon("<svg height=\"64\"></svg>"), InvalidIconError);
	assert.throws(() => validateIcon("<svg width=\"64\"></svg>"), InvalidIconError);
	assert.throws(() => validateIcon(`<svg width="${MAX_ICON_DIMENSION + 1}" height="64"></svg>`), InvalidIconError);
	assert.throws(() => validateIcon("<svg width=\"64\" height=\"0\"></svg>"), InvalidIconError);
	assert.throws(() => validateIcon("<svg width=\"64\" height=\"100%\"></svg>"), InvalidIconError);
	assert.throws(() => validateIcon("<div></div>"), InvalidIconError);
});

test("validateIcon bounds the dimension echo in its refusal message", () => {
	// An over-cap dimension sits inside the byte cap, so the raw attribute value can be long; the refusal must echo the bounded preview the sibling validators use rather than the whole value.
	const huge = "9".repeat(1000);
	const error = refusalError(() => validateIcon(`<svg width="${huge}" height="64"></svg>`));
	assert.ok(error instanceof InvalidIconError, "the over-cap dimension is refused");
	assert.ok(!error.message.includes(huge), "the message does not echo the whole raw value");
	assert.ok(error.message.includes("width"), "the message still names the attribute");
});

test("validateIcon refuses a viewport larger than MAX_ICON_DIMENSION and admits one at the dimension cap", () => {
	assert.throws(() => validateIcon(`<svg width="${MAX_ICON_DIMENSION * 2}" height="${MAX_ICON_DIMENSION * 2}"></svg>`), InvalidIconError);
	assert.equal(validateIcon(`<svg width="${MAX_ICON_DIMENSION}" height="${MAX_ICON_DIMENSION}"></svg>`), `<svg width="${MAX_ICON_DIMENSION}" height="${MAX_ICON_DIMENSION}"></svg>`);
});

test("validateIcon's area cap is subsumed by the dimension cap, which refuses either axis past MAX_ICON_DIMENSION", () => {
	// `MAX_ICON_PIXELS`'s JSDoc states the relationship between the two caps; the assertions below pin that the area branch cannot fire on its own.
	assert.equal(MAX_ICON_PIXELS, MAX_ICON_DIMENSION * MAX_ICON_DIMENSION, "the area cap is the square of the dimension cap");
	const atCorner = `<svg width="${MAX_ICON_DIMENSION}" height="${MAX_ICON_DIMENSION}"></svg>`;
	assert.equal(validateIcon(atCorner), atCorner, "the corner sits exactly at the area cap and is accepted");
	const pastWidth = `<svg width="${MAX_ICON_DIMENSION + 1}" height="64"></svg>`;
	const pastHeight = `<svg width="64" height="${MAX_ICON_DIMENSION + 1}"></svg>`;
	assert.throws(() => validateIcon(pastWidth), InvalidIconError, "a width past the dimension cap is refused");
	assert.throws(() => validateIcon(pastHeight), InvalidIconError, "a height past the dimension cap is refused");
	const dimensionBound = new RegExp(`within 1\\.\.${MAX_ICON_DIMENSION}`);
	assert.match(refusalMessage(() => validateIcon(pastWidth)), dimensionBound, "the width refusal names the dimension cap, not the area cap");
	assert.match(refusalMessage(() => validateIcon(pastHeight)), dimensionBound, "the height refusal names the dimension cap, not the area cap");
});

test("validateIcon reads the dimension cap from the real root, not a decoy <svg> tag in a comment", () => {
	// A `<svg>` spelling inside a comment is the first a single regex reaches; the cap must be read from the root element instead, which here declares an unbounded viewport.
	const decoy = "<!-- <svg width=\"64\" height=\"64\"></svg> -->";
	assert.throws(() => validateIcon(`${decoy}<svg width="99999" height="99999"></svg>`), InvalidIconError);
	assert.throws(() => validateIcon(`${decoy}<svg width="${MAX_ICON_DIMENSION + 1}" height="64"></svg>`), InvalidIconError);
	// The decoy does not change the outcome for a root that sits within the cap.
	const withinCap = `${decoy}<svg width="64" height="64"></svg>`;
	assert.equal(validateIcon(withinCap), withinCap);
});

test("validateIcon refuses a root whose effective dimension it cannot determine", () => {
	// A viewBox alone leaves the browser's intrinsic size to its default, so a root without numeric width and height is refused rather than read as bounded.
	assert.throws(() => validateIcon("<svg viewBox=\"0 0 64 64\"></svg>"), InvalidIconError);
	assert.throws(() => validateIcon("<svg width=\"64\" viewBox=\"0 0 64 64\"></svg>"), InvalidIconError);
	// The first start tag is the root: a non-`svg` element before a well-formed `<svg>` is not a root this gate accepts.
	assert.throws(() => validateIcon("<cover></cover><svg width=\"64\" height=\"64\"></svg>"), InvalidIconError);
	// The root is read by its element name's local name, as every other element refusal in the module is, so a prefixed root is the root rather than an element the gate does not know.
	const prefixed = "<svg:svg width=\"64\" height=\"64\"></svg:svg>";
	assert.equal(validateIcon(prefixed), prefixed);
});

test("validateIcon requires a single root element and admits a prolog, a nested <svg>, and a trailing comment", () => {
	const root = "<svg width=\"64\" height=\"64\"></svg>";
	// A second element at the document level leaves the value with more than one root, which a browser refuses to decode as an image.
	assert.throws(() => validateIcon(`${root}${root}`), InvalidIconError, "a second root element is refused");
	assert.match(refusalMessage(() => validateIcon(`${root}${root}`)), /single <svg> root element/, "the refusal names the single-root requirement");
	// The walk tracks nesting: the inner `<svg>` here is an ordinary element inside the root, and the element after the closed root is a second one.
	const nestedThenSecond = "<svg width=\"64\" height=\"64\"><svg width=\"32\" height=\"32\"/></svg><svg width=\"1\" height=\"1\"/>";
	assert.throws(() => validateIcon(nestedThenSecond), InvalidIconError, "an element after a closed root is a second root");
	// A nested `<svg>` is inside the root, so it is not a second root and the document is admitted.
	const nested = "<svg width=\"64\" height=\"64\"><svg width=\"32\" height=\"32\"/></svg>";
	assert.equal(validateIcon(nested), nested, "a nested <svg> element is inside the root, not a second root");
	// Neither a prolog nor a trailing comment is an element at the document level, so a single-root document that carries one is admitted.
	const prolog = `<?xml version="1.0" encoding="UTF-8"?>${root}`;
	assert.equal(validateIcon(prolog), prolog, "an XML prolog before the root is admitted");
	const trailing = `${root}<!-- trailing note -->`;
	assert.equal(validateIcon(trailing), trailing, "a trailing comment after the root is admitted");
	// Whitespace between the elements is text rather than an element, so it neither closes the root nor opens a second one.
	const spaced = "<svg width=\"64\" height=\"64\">\n  <rect width=\"64\" height=\"64\"/>\n</svg>";
	assert.equal(validateIcon(spaced), spaced, "whitespace around the elements is admitted");
});

test("validateIcon refuses a root start tag whose attributes it cannot read", () => {
	// An attribute position holding a bare `=` leaves the attribute walk unable to reach the end of the tag, so the gate refuses rather than read a dimension with a scan it cannot trust.
	assert.throws(() => validateIcon("<svg =\"64\" height=\"64\"></svg>"), InvalidIconError);
	// An unquoted value with nothing in it is the other shape that walk reports unreadable.
	assert.throws(() => validateIcon("<svg width=></svg>"), InvalidIconError);
});

test("validateIcon refuses a remote reference", () => {
	const wrap = (inner) => `<svg width="64" height="64">${inner}</svg>`;
	// The element carrying the reference is not one the denylist refuses, so each assertion here turns on the reference scan alone.
	assert.throws(() => validateIcon(wrap("<a href=\"http://example.com/x.png\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<a xlink:href=\"//example.com/x.png\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<rect fill=\"url(https://example.com/x.svg#p)\"/>")), InvalidIconError);
	// A parser strips leading whitespace and control characters from a URL before resolving it, so a scheme spelled behind them is the same reference and must be refused: that leading space is what carried `data:` past the scan.
	assert.throws(() => validateIcon(wrap("<a href=\" http://example.com/x.png\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<a href=\"\thttp://example.com/x.png\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<a href=\"\nhttp://example.com/x.png\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<rect fill=\"url( http://example.com/x.svg#p)\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<rect fill='url(\" http://example.com/x.svg#p\")'/>")), InvalidIconError);
});

test("validateIcon refuses a protocol-relative reference written with backslashes", () => {
	const wrap = (inner) => `<svg width="64" height="64">${inner}</svg>`;
	// A browser reads a backslash in a URL as a forward slash, exactly as the project's own URL helper assumes, so `\\host` is the protocol-relative `//host` the scan must refuse rather than a schemeless reference it reads as safe.
	assert.throws(() => validateIcon(wrap("<a href=\"\\\\example.com/x.png\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<rect fill=\"url(\\\\example.com/x.svg#p)\"/>")), InvalidIconError);
	// A mixed spelling and a character-reference spelling of the backslashes resolve to the same protocol-relative reference.
	assert.throws(() => validateIcon(wrap("<a href=\"\\/example.com/x.png\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<a href=\"&#92;&#92;example.com/x.png\"/>")), InvalidIconError);
	// A single backslash is a schemeless relative reference, not a protocol-relative one, so the reference scan does not refuse it.
	const relative = wrap("<a href=\"\\logo.svg\"/>");
	assert.equal(validateIcon(relative), relative);
});

test("validateIcon refuses an embedded document whatever value spelling carries it", () => {
	// The nested document sits base64 behind the value, so the outer scan reads no part of its markup; the `<image>` element is what must be refused, whatever its reference looks like.
	const nested = "<svg xmlns=\"http://www.w3.org/2000/svg\"><filter id=\"f\"><feGaussianBlur stdDeviation=\"1000000\"/></filter><animate attributeName=\"href\" href=\"#x\"/></svg>";
	const encoded = Buffer.from(nested, "utf8").toString("base64");
	const wrap = (href) => `<svg width="64" height="64"><image href="${href}"/></svg>`;
	assert.throws(() => validateIcon(wrap(`data:image/svg+xml;base64,${encoded}`)), InvalidIconError);
	// The leading space is the spelling that slipped past the reference scan, so the refusal cannot rest on the value at all.
	assert.throws(() => validateIcon(wrap(` data:image/svg+xml;base64,${encoded}`)), InvalidIconError);
	// A relative subresource reference is no scheme the reference scan refuses, so only the element refusal keeps the load out.
	assert.throws(() => validateIcon(wrap("logo.svg")), InvalidIconError);
});

test("validateIcon refuses the reference-carrying elements that resolve a subresource", () => {
	const wrap = (inner) => `<svg width="64" height="64">${inner}</svg>`;
	// Each of these resolves its `href`/`xlink:href` to a resource — a text element, a cursor image, a font file, an ICC profile, or a glyph — and the value here is a relative reference the remote-reference scan does not read as a scheme, so only the element refusal keeps the load out.
	assert.throws(() => validateIcon(wrap("<tref xlink:href=\"other.svg#t\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<cursor xlink:href=\"other.svg#c\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<font-face-uri xlink:href=\"other.svg#f\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<color-profile xlink:href=\"other.svg#p\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<altGlyph xlink:href=\"other.svg#g\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<glyphRef xlink:href=\"other.svg#g\"/>")), InvalidIconError);
	// The local-name reading is case-insensitive and prefix-blind, so a differently-cased or prefixed spelling is refused too.
	assert.throws(() => validateIcon(wrap("<svg:Tref xlink:href=\"other.svg#t\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<GlyphRef xlink:href=\"other.svg#g\"/>")), InvalidIconError);
});

test("validateIcon reads the root width and height by exact attribute name, not as a substring or inside a quoted value", () => {
	// `stroke-width`/`stroke-height` embed `width`/`height` as a substring; reading either as the root's own dimension would satisfy the cap with the wrong number and leave the real root viewport unbounded.
	assert.throws(() => validateIcon("<svg stroke-width=\"64\" stroke-height=\"64\" width=\"99999\" height=\"99999\"></svg>"), InvalidIconError);
	// A decoy-looking `width=` inside another attribute's quoted value must not stand in for the root's own `width`.
	assert.throws(() => validateIcon("<svg aria-label=\"width=64 height=64\" width=\"99999\" height=\"99999\"></svg>"), InvalidIconError);
	assert.throws(() => validateIcon(`<svg title="width=64" width="${MAX_ICON_DIMENSION + 1}" height="64"></svg>`), InvalidIconError);
	// The decoy does not change the outcome for a root that declares a bounded viewport of its own.
	const bounded = "<svg stroke-width=\"64\" stroke-height=\"64\" width=\"64\" height=\"64\"></svg>";
	assert.equal(validateIcon(bounded), bounded);
	const titled = "<svg title=\"width=64\" width=\"64\" height=\"64\"></svg>";
	assert.equal(validateIcon(titled), titled);
});

test("validateIcon refuses an amplification primitive spelled with a namespace prefix", () => {
	const attrs = "xmlns:svg=\"http://www.w3.org/2000/svg\"";
	// `svg:use` is the SMIL `use` element a namespace-aware parser binds, so it must be refused by its local name rather than read as an unknown element.
	assert.throws(() => validateIcon(`<svg width="64" height="64" ${attrs}><svg:use href="#x"/></svg>`), InvalidIconError);
	assert.throws(() => validateIcon(`<svg width="64" height="64" ${attrs}><svg:animate attributeName="href" href="#x"/></svg>`), InvalidIconError);
	assert.throws(() => validateIcon(`<svg width="64" height="64" ${attrs}><svg:script>alert(1)</svg:script></svg>`), InvalidIconError);
});

test("validateIcon refuses a denied element whatever spelling or count of namespace prefix it carries", () => {
	const wrap = (inner) => `<svg width="64" height="64" xmlns:svg="http://www.w3.org/2000/svg" xmlns:śvg="http://www.w3.org/2000/svg" xmlns:SVG="http://www.w3.org/2000/svg">${inner}</svg>`;
	// A non-ASCII XML NameStartChar prefix: a namespace-aware parser binds it to the SVG namespace and reads the local name `use`, so an ASCII-only prefix reader misses the denied element.
	assert.throws(() => validateIcon(wrap("<śvg:use href=\"#x\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<śvg:animate attributeName=\"href\" href=\"#x\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<é:set attributeName=\"href\" href=\"#x\"/>")), InvalidIconError);
	// An upper-case prefix, which the ASCII reader missed by folding only after the prefix.
	assert.throws(() => validateIcon(wrap("<SVG:use href=\"#x\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<Svg:Use href=\"#x\"/>")), InvalidIconError);
	// More than one prefix: the local name follows the last colon.
	assert.throws(() => validateIcon(wrap("<svg:Svg:use href=\"#x\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<a:b:use href=\"#x\"/>")), InvalidIconError);
	// The local-name reading does not close the gate on an element that is not denied.
	const allowed = wrap("<svg:rect width=\"64\" height=\"64\"/>");
	assert.equal(validateIcon(allowed), allowed);
});

test("validateIcon refuses the filter constructs whose cost the viewport does not bound", () => {
	const wrap = (inner) => `<svg width="64" height="64">${inner}</svg>`;
	// A filter element and its primitives carry cost set by parameters rather than by the icon's viewport.
	assert.throws(() => validateIcon(wrap("<filter id=\"f\"><feGaussianBlur stdDeviation=\"1000000\"/></filter>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<feTurbulence type=\"fractalNoise\" numOctaves=\"1000000\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<feGaussianBlur stdDeviation=\"1000000\"/>")), InvalidIconError);
	// A `filter` attribute names a filter chain, so it is refused on the root or on any element.
	assert.throws(() => validateIcon("<svg width=\"64\" height=\"64\" filter=\"url(#f)\"></svg>"), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<rect width=\"64\" height=\"64\" filter=\"url(#f)\"/>")), InvalidIconError);
	// Any `fe*` local name is refused, so a non-primitive spelling is over-refused rather than let through.
	assert.throws(() => validateIcon(wrap("<fenced/>")), InvalidIconError);
});

test("validateIcon accepts a filter-free document alongside the refusals", () => {
	const svg = "<svg width=\"64\" height=\"64\"><linearGradient id=\"g\"><stop offset=\"0\"/></linearGradient><rect width=\"64\" height=\"64\" fill=\"url(#g)\"/></svg>";
	assert.equal(validateIcon(svg), svg);
});

test("validateIcon refuses a raw spelling past the pre-composition bound without normalizing it", () => {
	const raw = "x".repeat(MAX_ICON_RAW_CODE_UNITS + 1);
	const error = refusalError(() => validateIcon(raw));
	assert.ok(error instanceof InvalidIconError, "the raw spelling is refused");
	// The byte-cap check raises the same error class from the same shared contract, so pin the message that distinguishes the pre-composition guard from it: the guard states that bound's one wording, in the unit it counts, and the clause naming the check that ran "before normalization" is what tells the two refusals apart.
	assert.equal(
		error.message,
		`The icon is ${raw.length} characters before normalization, over the ${MAX_ICON_RAW_CODE_UNITS}-character limit.`,
		"the refusal is the shared raw-bound wording, in the code units that bound counts",
	);
});

test("the form's raw read ceiling and the gate's pre-composition bound are one shared number", () => {
	assert.equal(MAX_ICON_RAW_CODE_UNITS, MAX_ICON_SVG_BYTES * 8, "the raw bound states the multiplier once, in the shared contract");
	assert.equal(MAX_ICON_FILE_BYTES, MAX_ICON_RAW_CODE_UNITS, "the form's file read and the gate's raw bound are the same statement, so they cannot drift apart");
	assert.equal(
		iconRawCodeUnitRefusal(MAX_ICON_RAW_CODE_UNITS + 1),
		`The icon is ${MAX_ICON_RAW_CODE_UNITS + 1} characters before normalization, over the ${MAX_ICON_RAW_CODE_UNITS}-character limit.`,
		"and the refusal both readers state for it is one wording, stated here beside the number",
	);
	assert.equal(
		iconFileSizeRefusal(MAX_ICON_FILE_BYTES + 1),
		`The icon file is ${MAX_ICON_FILE_BYTES + 1} bytes, over the ${MAX_ICON_FILE_BYTES}-byte read limit.`,
		"and the file-size refusal the form shows for that same ceiling is one wording too, stated here beside the number",
	);
});

test("svgDataUrl refuses an empty, over-cap, or non-string value rather than encoding unbounded input", () => {
	assert.throws(() => svgDataUrl(""), RangeError);
	assert.throws(() => svgDataUrl("x".repeat(MAX_ICON_SVG_BYTES + 1)), RangeError);
	assert.throws(() => svgDataUrl(42), TypeError);
	// A value within the cap still round-trips, so the guard does not close the leaf.
	assert.equal(isSvgDataUrl(svgDataUrl(SMALL_SVG)), true);
});
