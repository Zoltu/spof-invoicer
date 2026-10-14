/** The suite for the invoice icon validator and the `data:` URL leaf: the round trip through `svgDataUrl`/`isSvgDataUrl` and the accept/refuse boundary of `validateIcon`. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidIconError, MAX_ICON_DIMENSION, MAX_ICON_PIXELS, MAX_ICON_SVG_BYTES, validateIcon } from "../app/js/invoice/icon.js";
import { MAX_SVG_DATA_URL_PAYLOAD, isSvgDataUrl } from "../app/js/util/data-url.js";
import { MAX_ICON_FILE_BYTES, MAX_ICON_RAW_CODE_UNITS, iconFileSizeRefusal, iconRawCodeUnitRefusal } from "../app/js/util/icon-capacity.js";
import { svgDataUrl } from "../app/js/util/svg-data-url.js";
import { refusalError, refusalMessage } from "./helpers/refusals.mjs";

const PREFIX = "data:image/svg+xml;base64,";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const SMALL_SVG = "<svg width=\"64\" height=\"64\" xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"64\" height=\"64\"/></svg>";
const BYTE_CAP_HEAD = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"64\">";
const BYTE_CAP_TAIL = "</svg>";
const SVG_AT_BYTE_CAP = BYTE_CAP_HEAD + "x".repeat(MAX_ICON_SVG_BYTES - BYTE_CAP_HEAD.length - BYTE_CAP_TAIL.length) + BYTE_CAP_TAIL;

test("svgDataUrl encodes an SVG and isSvgDataUrl recognizes the result", () => {
	const url = svgDataUrl(SMALL_SVG);
	assert.ok(url.startsWith(PREFIX));
	assert.equal(isSvgDataUrl(url), true);
	assert.equal(Buffer.from(url.slice(PREFIX.length), "base64").toString("utf8"), SMALL_SVG);
});

test("svgDataUrl round-trips a multibyte SVG, composing an NFD spelling to the gate's canonical text", () => {
	// "ü" is one two-byte NFC code point (`Süß`) or a base letter plus a combining diaeresis in NFD; the NFC spelling survives the UTF-8/base64 round trip byte for byte, and the leaf runs the icon gate, so an NFD spelling reaches the URL composed rather than as it was typed.
	const nfc = "<svg width=\"64\" height=\"64\" xmlns=\"http://www.w3.org/2000/svg\"><title>Süß — 日本</title></svg>";
	const nfd = "<svg width=\"64\" height=\"64\" xmlns=\"http://www.w3.org/2000/svg\"><title>Su\u0308ß — 日本</title></svg>";
	assert.equal(isSvgDataUrl(svgDataUrl(nfc)), true, "the NFC spelling is encoded as itself");
	assert.equal(Buffer.from(svgDataUrl(nfc).slice(PREFIX.length), "base64").toString("utf8"), nfc);
	assert.equal(Buffer.from(svgDataUrl(nfd).slice(PREFIX.length), "base64").toString("utf8"), nfc, "and the NFD spelling is encoded as the composed text the gate returns");
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
	assert.throws(() => svgDataUrl(`${SVG_AT_BYTE_CAP}x`), InvalidIconError);
	assert.equal(MAX_SVG_DATA_URL_PAYLOAD, 4 * Math.ceil(MAX_ICON_SVG_BYTES / 3));
});

test("validateIcon accepts a small numeric-sized SVG unchanged", () => {
	assert.equal(validateIcon(SMALL_SVG), SMALL_SVG);
});

test("validateIcon composes its text to NFC", () => {
	const nfd = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"64\"><title>cafe\u0301</title></svg>";
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
	const huge = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">${"x".repeat(MAX_ICON_SVG_BYTES)}</svg>`;
	assert.throws(() => validateIcon(huge), InvalidIconError);
});

test("validateIcon refuses surrounding whitespace, including around NFD text", () => {
	const nfd = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"64\"><title>cafe\u0301</title></svg>";
	assert.throws(() => validateIcon(` ${nfd}`), InvalidIconError);
	assert.throws(() => validateIcon(`${nfd} `), InvalidIconError);
});

test("validateIcon refuses a control character", () => {
	assert.throws(() => validateIcon("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"64\"><title>\u0001</title></svg>"), InvalidIconError);
});

test("validateIcon refuses an invisible formatting character", () => {
	assert.throws(() => validateIcon("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"64\"><title>\u200B</title></svg>"), InvalidIconError);
});

test("validateIcon refuses a lone surrogate code unit", () => {
	assert.throws(() => validateIcon("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"64\"><title>\uD800</title></svg>"), InvalidIconError);
});

test("validateIcon refuses script, event handlers, entities, styles, and foreignObject", () => {
	const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">${inner}</svg>`;
	assert.throws(() => validateIcon(wrap("<script>alert(1)</script>")), InvalidIconError);
	assert.throws(() => validateIcon("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"64\" onload=\"alert(1)\"></svg>"), InvalidIconError);
	// A handler whose preceding separator hides it from a whitespace-anchored reading: the `/` after another attribute, and a stray quote in the same position, both leave a lenient parser reading `onload` as an attribute of the element.
	assert.throws(() => validateIcon(wrap("<rect x=\"1\" /onload=\"alert(1)\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<rect x=\"1\"onload=\"alert(1)\"/>")), InvalidIconError);
	assert.throws(() => validateIcon("<!ENTITY x SYSTEM \"http://example.com/x\">"), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<style>@import url(https://example.com/x.css);</style>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<foreignObject></foreignObject>")), InvalidIconError);
});

test("validateIcon reads the style and event-handler refusals at an attribute boundary, not inside a longer name", () => {
	const wrap = (attrs) => '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" ' + attrs + '></svg>';
	// A longer name that merely ends in `style`, or merely contains `on` (`data-once`, `data.once`), is an ordinary attribute, so the gate admits a document carrying neither inline CSS nor a handler.
	for (const attribute of ['data-style="fill:red"', 'data-once="1"', 'data.once="1"', 'xml:style="fill:red"']) {
		const svgText = wrap(attribute);
		assert.equal(validateIcon(svgText), svgText, "must admit the ordinary attribute " + attribute);
	}
	// The attribute genuinely named `style`, and a name beginning with `on`, stay refused at every separator a lenient parser reads as an attribute boundary.
	for (const attribute of ['style="fill:red"', '/style="fill:red"', 'x="1"style="fill:red"', 'onload="alert(1)"', '/onload="alert(1)"', 'x="1"onload="alert(1)"', 'once="1"']) {
		assert.throws(() => validateIcon(wrap(attribute)), InvalidIconError, "must refuse " + attribute);
	}
});

test("validateIcon refuses the named content-bypass classes as defense-in-depth", () => {
	const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">${inner}</svg>`;
	// A URL scheme spelled as a numeric character reference does not begin with `#` as written, so the value is refused whether or not a parser would resolve the scheme.
	assert.throws(() => validateIcon(wrap("<a href=\"&#x68;ttp://example.com/x.png\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<a href=\"&#104;ttp://example.com/x.png\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<rect fill=\"url(&#x68;ttp://example.com/p.svg#p)\"/>")), InvalidIconError);
	// A nested character reference does not begin with `#` either, so a reference spelled behind one is refused as well.
	assert.throws(() => validateIcon(wrap("<a href=\"&#38;#x68;ttp://example.com/x.png\"/>")), InvalidIconError);
	// The `/` element/attribute separator, where a lenient parser reads `onload` as an attribute of the element.
	assert.throws(() => validateIcon("<svg/onload=\"alert(1)\"></svg>"), InvalidIconError);
	// A SMIL element that can pull a remote hyperlink.
	assert.throws(() => validateIcon(wrap("<animate attributeName=\"href\" href=\"http://example.com/x.svg\"/>")), InvalidIconError);
	// CSS `image()` through a style attribute or a style element.
	assert.throws(() => validateIcon("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"64\" style=\"background-image:image(http://example.com/x.png)\"><rect width=\"64\" height=\"64\"/></svg>"), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<style>rect{fill:url(http://example.com/x.svg#p)}</style>")), InvalidIconError);
	// An external DTD subset.
	assert.throws(() => validateIcon("<!DOCTYPE svg SYSTEM \"http://example.com/svg.dtd\">"), InvalidIconError);
});

test("validateIcon refuses a missing, non-numeric, or over-large dimension", () => {
	assert.throws(() => validateIcon("<svg height=\"64\"></svg>"), InvalidIconError);
	assert.throws(() => validateIcon("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\"></svg>"), InvalidIconError);
	assert.throws(() => validateIcon(`<svg xmlns="http://www.w3.org/2000/svg" width="${MAX_ICON_DIMENSION + 1}" height="64"></svg>`), InvalidIconError);
	assert.throws(() => validateIcon("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"0\"></svg>"), InvalidIconError);
	assert.throws(() => validateIcon("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"100%\"></svg>"), InvalidIconError);
	assert.throws(() => validateIcon("<div></div>"), InvalidIconError);
});

test("validateIcon bounds the dimension echo in its refusal message", () => {
	// An over-cap dimension sits inside the byte cap, so the raw attribute value can be long; the refusal must echo the bounded preview the sibling validators use rather than the whole value.
	const huge = "9".repeat(1000);
	const error = refusalError(() => validateIcon(`<svg xmlns="http://www.w3.org/2000/svg" width="${huge}" height="64"></svg>`));
	assert.ok(error instanceof InvalidIconError, "the over-cap dimension is refused");
	assert.ok(!error.message.includes(huge), "the message does not echo the whole raw value");
	assert.ok(error.message.includes("width"), "the message still names the attribute");
});

test("validateIcon refuses a viewport larger than MAX_ICON_DIMENSION and admits one at the dimension cap", () => {
	assert.throws(() => validateIcon(`<svg xmlns="http://www.w3.org/2000/svg" width="${MAX_ICON_DIMENSION * 2}" height="${MAX_ICON_DIMENSION * 2}"></svg>`), InvalidIconError);
	assert.equal(validateIcon(`<svg xmlns="http://www.w3.org/2000/svg" width="${MAX_ICON_DIMENSION}" height="${MAX_ICON_DIMENSION}"></svg>`), `<svg xmlns="http://www.w3.org/2000/svg" width="${MAX_ICON_DIMENSION}" height="${MAX_ICON_DIMENSION}"></svg>`);
});

test("validateIcon's area cap is subsumed by the dimension cap, which refuses either axis past MAX_ICON_DIMENSION", () => {
	// `MAX_ICON_PIXELS`'s JSDoc states the relationship between the two caps; the assertions below pin that the area branch cannot fire on its own.
	assert.equal(MAX_ICON_PIXELS, MAX_ICON_DIMENSION * MAX_ICON_DIMENSION, "the area cap is the square of the dimension cap");
	const atCorner = `<svg xmlns="http://www.w3.org/2000/svg" width="${MAX_ICON_DIMENSION}" height="${MAX_ICON_DIMENSION}"></svg>`;
	assert.equal(validateIcon(atCorner), atCorner, "the corner sits exactly at the area cap and is accepted");
	const pastWidth = `<svg xmlns="http://www.w3.org/2000/svg" width="${MAX_ICON_DIMENSION + 1}" height="64"></svg>`;
	const pastHeight = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="${MAX_ICON_DIMENSION + 1}"></svg>`;
	assert.throws(() => validateIcon(pastWidth), InvalidIconError, "a width past the dimension cap is refused");
	assert.throws(() => validateIcon(pastHeight), InvalidIconError, "a height past the dimension cap is refused");
	const dimensionBound = new RegExp(`within 1\\.\.${MAX_ICON_DIMENSION}`);
	assert.match(refusalMessage(() => validateIcon(pastWidth)), dimensionBound, "the width refusal names the dimension cap, not the area cap");
	assert.match(refusalMessage(() => validateIcon(pastHeight)), dimensionBound, "the height refusal names the dimension cap, not the area cap");
});

test("validateIcon reads the dimension cap from the real root, not a decoy <svg> tag in a comment", () => {
	// A `<svg>` spelling inside a comment is the first a single regex reaches; the cap must be read from the root element instead, which here declares an unbounded viewport.
	const decoy = "<!-- <svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"64\"></svg> -->";
	assert.throws(() => validateIcon(`${decoy}<svg xmlns="http://www.w3.org/2000/svg" width="99999" height="99999"></svg>`), InvalidIconError);
	assert.throws(() => validateIcon(`${decoy}<svg xmlns="http://www.w3.org/2000/svg" width="${MAX_ICON_DIMENSION + 1}" height="64"></svg>`), InvalidIconError);
	// The decoy does not change the outcome for a root that sits within the cap.
	const withinCap = `${decoy}<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"></svg>`;
	assert.equal(validateIcon(withinCap), withinCap);
});

test("validateIcon refuses a root whose effective dimension it cannot determine", () => {
	// A viewBox alone leaves the browser's intrinsic size to its default, so a root without numeric width and height is refused rather than read as bounded.
	assert.throws(() => validateIcon("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"></svg>"), InvalidIconError);
	assert.throws(() => validateIcon("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" viewBox=\"0 0 64 64\"></svg>"), InvalidIconError);
	// The first start tag is the root: a non-`svg` element before a well-formed `<svg>` is not a root this gate accepts.
	assert.throws(() => validateIcon("<cover></cover><svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"64\"></svg>"), InvalidIconError);
	// The root is read by its element name's local name, as every other element refusal in the module is, so a prefixed root is the root rather than an element the gate does not know.
	const prefixed = "<svg:svg xmlns:svg=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"64\"></svg:svg>";
	assert.equal(validateIcon(prefixed), prefixed);
});

test("validateIcon reads the dimension cap from the element the browser treats as the root, whatever its name begins with", () => {
	const xmlns = 'xmlns:_p="http://www.w3.org/2000/svg"';
	const decoy = '<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg"></svg>';
	// `_p:svg` is an XML name that binds the SVG namespace, so a parser treats it as the document's root and renders it at the 99999-pixel size it declares; reading the nested decoy's bounded size instead would leave the real root unbounded.
	const attack = '<_p:svg ' + xmlns + ' width="99999" height="99999">' + decoy + '</_p:svg>';
	const refusal = refusalError(() => validateIcon(attack));
	assert.ok(refusal instanceof InvalidIconError, "the prefixed root's unbounded size is refused");
	assert.match(refusal.message, new RegExp('within 1\\.\\.' + MAX_ICON_DIMENSION), "and the refusal is the dimension cap, read from the element the browser treats as the root");
	// The wider name reading does not close the gate on that spelling: the same prefixed root within the cap is admitted.
	const withinCap = '<_p:svg ' + xmlns + ' width="64" height="64">' + decoy + '</_p:svg>';
	assert.equal(validateIcon(withinCap), withinCap);
	// An element spelled with a name the ASCII-letter class skipped is the document's first start tag, so it cannot stand in front of the validated root: the document is refused rather than read past it.
	const nonAscii = '<é:cover></é:cover><svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"></svg>';
	assert.throws(() => validateIcon(nonAscii), InvalidIconError, "an element named before the root is refused rather than read past");
});

test("validateIcon requires a single root element and admits a nested <svg> and a trailing comment", () => {
	const root = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"64\"></svg>";
	// A second element at the document level leaves the value with more than one root, which a browser refuses to decode as an image.
	assert.throws(() => validateIcon(`${root}${root}`), InvalidIconError, "a second root element is refused");
	assert.match(refusalMessage(() => validateIcon(`${root}${root}`)), /single <svg> root element/, "the refusal names the single-root requirement");
	// The walk tracks nesting: the inner `<svg>` here is an ordinary element inside the root, and the element after the closed root is a second one.
	const nestedThenSecond = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"64\"><svg width=\"32\" height=\"32\"/></svg><svg width=\"1\" height=\"1\"/>";
	assert.throws(() => validateIcon(nestedThenSecond), InvalidIconError, "an element after a closed root is a second root");
	// A nested `<svg>` is inside the root, so it is not a second root and the document is admitted.
	const nested = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"64\"><svg width=\"32\" height=\"32\"/></svg>";
	assert.equal(validateIcon(nested), nested, "a nested <svg> element is inside the root, not a second root");
	// A leading or trailing comment is not an element at the document level, so a single-root document that carries one is admitted.
	const leading = `<!-- leading note -->${root}`;
	assert.equal(validateIcon(leading), leading, "a leading comment before the root is admitted");
	const trailing = `${root}<!-- trailing note -->`;
	assert.equal(validateIcon(trailing), trailing, "a trailing comment after the root is admitted");
	// Whitespace between the elements is text rather than an element, so it neither closes the root nor opens a second one.
	const spaced = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"64\">\n  <rect width=\"64\" height=\"64\"/>\n</svg>";
	assert.equal(validateIcon(spaced), spaced, "whitespace around the elements is admitted");
});

test("validateIcon refuses a root start tag whose attributes it cannot read", () => {
	// An attribute position holding a bare `=` leaves the attribute walk unable to reach the end of the tag, so the gate refuses rather than read a dimension with a scan it cannot trust.
	assert.throws(() => validateIcon("<svg =\"64\" height=\"64\"></svg>"), InvalidIconError);
	// An unquoted value with nothing in it is the other shape that walk reports unreadable.
	assert.throws(() => validateIcon("<svg xmlns=\"http://www.w3.org/2000/svg\" width=></svg>"), InvalidIconError);
});

test("validateIcon refuses a remote reference", () => {
	const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">${inner}</svg>`;
	// The element carrying the reference is not one the denylist refuses, so each assertion here turns on the reference scan alone.
	assert.throws(() => validateIcon(wrap("<a href=\"http://example.com/x.png\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<a xlink:href=\"//example.com/x.png\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<rect fill=\"url(https://example.com/x.svg#p)\"/>")), InvalidIconError);
	// A value carrying leading whitespace or a control character does not begin with `#`, so the spelling a parser would strip back to a scheme is refused by the same rule.
	assert.throws(() => validateIcon(wrap("<a href=\" http://example.com/x.png\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<a href=\"\thttp://example.com/x.png\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<a href=\"\nhttp://example.com/x.png\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<rect fill=\"url( http://example.com/x.svg#p)\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<rect fill='url(\" http://example.com/x.svg#p\")'/>")), InvalidIconError);
});

test("validateIcon refuses a reference hidden by a separator or a character reference inside its scheme", () => {
	const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">${inner}</svg>`;
	// The separator sits inside the value, so the value as written does not begin with `#` and is refused however a parser would strip the separator before resolving it.
	assert.throws(() => validateIcon(wrap("<a href=\"ht\ttp://example.com/x.png\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<a href=\"ht\ntp://example.com/x.png\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<a href=\"jav\tscript:alert(1)\"/>")), InvalidIconError);
	// A character reference is part of the value as written, so a value carrying one never begins with `#` and is refused whatever it decodes to.
	assert.throws(() => validateIcon(wrap("<a href=\"ht&#x09;tp://example.com/x.png\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<a href=\"ht&#13;tp://example.com/x.png\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<a href=\"jav&#x09;ascript:alert(1)\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<a href=\"&#106;av&#x09;ascript:alert(1)\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<rect fill=\"url(ht&#x0a;tp://example.com/x.svg#p)\"/>")), InvalidIconError);
	// The protocol-relative prefix hides the same way.
	assert.throws(() => validateIcon(wrap("<a href=\"/&#x09;/example.com/x.png\"/>")), InvalidIconError);
	// A separator in ordinary text is not a reference, and a `#`-fragment — the one same-document spelling — is admitted.
	const local = wrap("<a href=\"#local\"/><title>two\twords</title>");
	assert.equal(validateIcon(local), local);
});

test("validateIcon refuses a reference written with backslashes", () => {
	const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">${inner}</svg>`;
	// A backslash is not a `#`, so every reference it appears in is refused whether it reads as protocol-relative or as a schemeless relative path.
	assert.throws(() => validateIcon(wrap("<a href=\"\\\\example.com/x.png\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<rect fill=\"url(\\\\example.com/x.svg#p)\"/>")), InvalidIconError);
	// A mixed spelling and a character-reference spelling of the backslashes resolve to the same protocol-relative reference.
	assert.throws(() => validateIcon(wrap("<a href=\"\\/example.com/x.png\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<a href=\"&#92;&#92;example.com/x.png\"/>")), InvalidIconError);
	// A backslash is not a `#`, so a relative reference spelled with one is refused by the same rule.
	assert.throws(() => validateIcon(wrap("<a href=\"\\logo.svg\"/>")), InvalidIconError, "a relative reference spelled with a backslash is refused");
	assert.throws(() => validateIcon(wrap("<rect fill=\"url(\gradient.svg#g)\"/>")), InvalidIconError);
});

test("validateIcon refuses a reference whose `url(` token is spelled through a character reference", () => {
	const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">${inner}</svg>`;
	// An XML parser expands a character reference into the attribute value it hands on, so each document here reaches a CSS parser as the `url(…)` reference it spells rather than as token-free text.
	assert.throws(() => validateIcon(wrap('<rect fill="url&#40;https://example.com/x.svg#p&#41;"/>')), InvalidIconError, "the escaped parentheses spell the whole token");
	assert.throws(() => validateIcon(wrap('<rect fill="url&#40;https://example.com/x.svg#p)"/>')), InvalidIconError, "the escaped opening parenthesis alone is enough for the value to be read as a url token");
	assert.throws(() => validateIcon(wrap('<rect fill="url&#x28;https://example.com/x.svg#p)"/>')), InvalidIconError, "a hexadecimal reference spells the same token");
	assert.throws(() => validateIcon(wrap('<rect fill="u&#114;l(https://example.com/x.svg#p)"/>')), InvalidIconError, "a letter of the token spelled as a reference is resolved the same way");
	assert.throws(() => validateIcon(wrap('<rect mask="url&#40;https://example.com/x.svg#m)"/>')), InvalidIconError, "the token is refused on any element a property reads a reference from, not only on fill");
	assert.throws(() => validateIcon(wrap('<rect fill="url&#40;gradient.svg#g)"/>')), InvalidIconError, "a relative reference spelled through a reference is refused as well");
});

test("validateIcon refuses a reference whose `url(` token is spelled through a CSS escape", () => {
	const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">${inner}</svg>`;
	// A presentation attribute is read as a CSS value, so the escapes in it are resolved before the value is read: `\72 ` is `r`, `\75 ` is `u`, and `\6c ` is `l`.
	assert.throws(() => validateIcon(wrap('<rect fill="u\\72 l(https://example.com/x.svg#p)"/>')), InvalidIconError, "the `r` of the token spelled as an escape");
	assert.throws(() => validateIcon(wrap('<rect fill="\\75 rl(https://example.com/x.svg#p)"/>')), InvalidIconError, "the `u` of the token spelled as an escape");
	assert.throws(() => validateIcon(wrap('<rect fill="ur\\6c (https://example.com/x.svg#p)"/>')), InvalidIconError, "the `l` of the token spelled as an escape");
	assert.throws(() => validateIcon(wrap('<rect fill="\\00075rl(https://example.com/x.svg#p)"/>')), InvalidIconError, "a zero-padded escape of six digits stands for the same character");
	assert.throws(() => validateIcon(wrap('<rect mask="\\75 rl(//example.com/m.svg#m)"/>')), InvalidIconError, "a protocol-relative reference spelled as an escape is refused too");
	// The two rewritings compose in the order a parser applies them: the reference is expanded into the value, and the escape that expanded value carries is resolved.
	assert.throws(() => validateIcon(wrap('<rect fill="u\\72 l&#40;https://example.com/x.svg#p)"/>')), InvalidIconError);
});

test("validateIcon reads the style and event-handler refusals over the spelling a parser resolves", () => {
	const wrap = (attrs) => '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" ' + attrs + '></svg>';
	// XML resolves neither a reference nor an escape inside an attribute name, so no parser binds the handler or the style attribute these documents appear to spell and each is one a conforming parser refuses to decode; the refusals read the resolved spelling so that every text-level refusal covers one set of spellings, and what that reading reaches here is the resolved text alone.
	assert.throws(() => validateIcon(wrap('title="&#32;onload=1"')), InvalidIconError, "an event-handler spelling resolved out of a reference is refused");
	assert.throws(() => validateIcon(wrap('data-note="&#32;style=fill:red"')), InvalidIconError, "and so is a style-attribute spelling resolved out of one");
	// The resolved spelling does not close the gate on an attribute value that spells no refused token.
	const plain = wrap('title="a &amp; b"');
	assert.equal(validateIcon(plain), plain, "an ordinary `&amp;` reference in an attribute value is admitted");
});

test("validateIcon admits ordinary character references and a same-document paint in every spelling", () => {
	const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">${inner}</svg>`;
	// A character reference outside a refused construct is ordinary text, and its resolved spelling leaves it so.
	const amp = wrap("<title>Bed &amp; Breakfast</title>");
	assert.equal(validateIcon(amp), amp, "the `&` of `&amp;` in a title is admitted");
	const numeric = wrap("<text>&#169; 2026 &#x2192; paid</text>");
	assert.equal(validateIcon(numeric), numeric, "a numeric reference for a copyright sign and an arrow is admitted");
	// A `<use>` that a reference spells is text a parser renders rather than markup it reads as an element, so the element refusal keeps reading the raw text and this document stays admitted.
	const spelledElement = wrap("<title>&lt;use&gt; here is text, not an element</title>");
	assert.equal(validateIcon(spelledElement), spelledElement);
	// A same-document paint and the empty `url()` prose are the same reference, or no reference, in both spellings.
	const paint = wrap('<linearGradient id="g"><stop offset="0"/></linearGradient><rect width="64" height="64" fill="url(#g)"/>');
	assert.equal(validateIcon(paint), paint, "a url(#…) paint still validates after resolution");
	const prose = wrap("<title>url() is a CSS function</title>");
	assert.equal(validateIcon(prose), prose, "the empty url() prose still validates after resolution");
});

test("validateIcon refuses an embedded document whatever value spelling carries it", () => {
	// The nested document sits base64 behind the value, so the outer scan reads no part of its markup; the `<image>` element is what must be refused, whatever its reference looks like.
	const nested = "<svg xmlns=\"http://www.w3.org/2000/svg\"><filter id=\"f\"><feGaussianBlur stdDeviation=\"1000000\"/></filter><animate attributeName=\"href\" href=\"#x\"/></svg>";
	const encoded = Buffer.from(nested, "utf8").toString("base64");
	const wrap = (href) => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><image href="${href}"/></svg>`;
	assert.throws(() => validateIcon(wrap(`data:image/svg+xml;base64,${encoded}`)), InvalidIconError);
	// The leading space changes nothing for the `<image>` refusal, which rests on the element name rather than on the value.
	assert.throws(() => validateIcon(wrap(` data:image/svg+xml;base64,${encoded}`)), InvalidIconError);
	// A relative subresource reference is refused by the gate as well, but the `<image>` element is what keeps the nested load out here.
	assert.throws(() => validateIcon(wrap("logo.svg")), InvalidIconError);
});

test("validateIcon refuses the reference-carrying elements that resolve a subresource", () => {
	const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">${inner}</svg>`;
	// Each of these resolves its `href`/`xlink:href` to a resource — a text element, a cursor image, a font file, an ICC profile, or a glyph — and the value here is a relative reference the element refusal keeps out whatever the reference scan would say about it.
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
	assert.throws(() => validateIcon("<svg xmlns=\"http://www.w3.org/2000/svg\" stroke-width=\"64\" stroke-height=\"64\" width=\"99999\" height=\"99999\"></svg>"), InvalidIconError);
	// A decoy-looking `width=` inside another attribute's quoted value must not stand in for the root's own `width`.
	assert.throws(() => validateIcon("<svg xmlns=\"http://www.w3.org/2000/svg\" aria-label=\"width=64 height=64\" width=\"99999\" height=\"99999\"></svg>"), InvalidIconError);
	assert.throws(() => validateIcon(`<svg xmlns="http://www.w3.org/2000/svg" title="width=64" width="${MAX_ICON_DIMENSION + 1}" height="64"></svg>`), InvalidIconError);
	// The decoy does not change the outcome for a root that declares a bounded viewport of its own.
	const bounded = "<svg xmlns=\"http://www.w3.org/2000/svg\" stroke-width=\"64\" stroke-height=\"64\" width=\"64\" height=\"64\"></svg>";
	assert.equal(validateIcon(bounded), bounded);
	const titled = "<svg xmlns=\"http://www.w3.org/2000/svg\" title=\"width=64\" width=\"64\" height=\"64\"></svg>";
	assert.equal(validateIcon(titled), titled);
});

test("validateIcon refuses an amplification primitive spelled with a namespace prefix", () => {
	const attrs = "xmlns:svg=\"http://www.w3.org/2000/svg\"";
	// `svg:use` is the SMIL `use` element a namespace-aware parser binds, so it must be refused by its local name rather than read as an unknown element.
	assert.throws(() => validateIcon(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" ${attrs}><svg:use href="#x"/></svg>`), InvalidIconError);
	assert.throws(() => validateIcon(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" ${attrs}><svg:animate attributeName="href" href="#x"/></svg>`), InvalidIconError);
	assert.throws(() => validateIcon(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" ${attrs}><svg:script>alert(1)</svg:script></svg>`), InvalidIconError);
});

test("validateIcon refuses a denied element whatever spelling or count of namespace prefix it carries", () => {
	const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" xmlns:svg="http://www.w3.org/2000/svg" xmlns:śvg="http://www.w3.org/2000/svg" xmlns:SVG="http://www.w3.org/2000/svg">${inner}</svg>`;
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
	const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">${inner}</svg>`;
	// A filter element and its primitives carry cost set by parameters rather than by the icon's viewport.
	assert.throws(() => validateIcon(wrap("<filter id=\"f\"><feGaussianBlur stdDeviation=\"1000000\"/></filter>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<feTurbulence type=\"fractalNoise\" numOctaves=\"1000000\"/>")), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<feGaussianBlur stdDeviation=\"1000000\"/>")), InvalidIconError);
	// A `filter` attribute names a filter chain, so it is refused on the root or on any element.
	assert.throws(() => validateIcon("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"64\" filter=\"url(#f)\"></svg>"), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<rect width=\"64\" height=\"64\" filter=\"url(#f)\"/>")), InvalidIconError);
	// Any `fe*` local name is refused, so a non-primitive spelling is over-refused rather than let through.
	assert.throws(() => validateIcon(wrap("<fenced/>")), InvalidIconError);
});

test("validateIcon accepts a filter-free document alongside the refusals", () => {
	const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"64\"><linearGradient id=\"g\"><stop offset=\"0\"/></linearGradient><rect width=\"64\" height=\"64\" fill=\"url(#g)\"/></svg>";
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
	// The leaf runs the icon gate on what it is handed, so each refusal is the gate's own: an empty document and one past the byte cap are `InvalidIconError`s, and a value of another type is a `TypeError`.
	assert.throws(() => svgDataUrl(""), InvalidIconError);
	assert.throws(() => svgDataUrl("x".repeat(MAX_ICON_SVG_BYTES + 1)), InvalidIconError);
	assert.throws(() => svgDataUrl(42), TypeError);
	// A value within the cap still round-trips, so the gate does not close the leaf.
	assert.equal(isSvgDataUrl(svgDataUrl(SMALL_SVG)), true);
});

test("svgDataUrl runs the icon gate, so no unvalidated text is armored into a data URL", () => {
	// Each document below is under the byte cap and every character of it base64-encodes, which is all the leaf's own shape-and-size guard ever read: the refusal is the gate's, so a sink that reaches the leaf cannot be handed text that was never validated.
	const cases = [
		["a root <svg> declaring no XML namespace", '<svg width="64" height="64"><rect width="64" height="64"/></svg>', /must declare xmlns/],
		["an animation element", SMALL_SVG.replace("</svg>", '<animate attributeName="href" href="#x"/></svg>'), /must not contain a <animate> element/],
		["no numeric dimension on the root", `<svg xmlns="${SVG_NAMESPACE}" viewBox="0 0 64 64"></svg>`, /must set a numeric width/],
		["an inline event handler", '<svg xmlns="' + SVG_NAMESPACE + '" width="64" height="64" onload="alert(1)"></svg>', /must not contain an inline event handler/],
	];
	for (const [label, svg, reason] of cases) {
		assert.throws(() => svgDataUrl(svg), (error) => error instanceof InvalidIconError && reason.test(error.message), `the leaf must refuse ${label}`);
	}
	// The gate's own canonical text is what the leaf encodes, so an NFD spelling reaches the URL composed rather than as it was handed over.
	const nfd = `<svg xmlns="${SVG_NAMESPACE}" width="64" height="64"><title>cafe\u0301</title></svg>`;
	assert.equal(Buffer.from(svgDataUrl(nfd).slice(PREFIX.length), "base64").toString("utf8"), nfd.normalize("NFC"));
});

test("validateIcon refuses every SMIL and SVG animation element by local name", () => {
	const wrap = (inner) => `<svg xmlns="${SVG_NAMESPACE}" width="64" height="64">${inner}</svg>`;
	// An image context renders an SVG in secure animated mode, where animation is permitted and runs, so these elements are what would let an accepted icon animate continuously in the payer's page or change what it draws after load.
	const animationElements = [
		"<animate attributeName=\"href\" href=\"#x\"/>",
		"<animateColor attributeName=\"fill\" to=\"#000\"/>",
		"<animateMotion dur=\"1s\"/>",
		"<animateTransform attributeName=\"transform\" type=\"rotate\" to=\"90\"/>",
		"<discard begin=\"0s\"/>",
		"<set attributeName=\"href\" to=\"#x\"/>",
		"<mpath href=\"#p\"/>",
	];
	for (const element of animationElements) {
		const local = /^<([A-Za-z]+)/.exec(element)[1].toLowerCase();
		assert.throws(() => validateIcon(wrap(element)), InvalidIconError, `must refuse ${element}`);
		assert.match(refusalMessage(() => validateIcon(wrap(element))), new RegExp(`must not contain a <${local}> element`), `the refusal names the local name ${local}`);
	}
	// A prefixed or differently-cased spelling is refused by the local name a parser binds rather than read as an unknown element.
	for (const element of ["<svg:animateColor/>", "<SVG:Discard/>", "<é:set/>"]) {
		assert.throws(() => validateIcon(wrap(element)), InvalidIconError, `must refuse ${element}`);
	}
	// `<handler>` carries the script it runs for the event it is bound to rather than animation, and is refused with the other script-carrying elements.
	const handler = wrap('<handler ev:event="load">alert(1)</handler>');
	assert.throws(() => validateIcon(handler), InvalidIconError, "must refuse <handler>");
	assert.match(refusalMessage(() => validateIcon(handler)), /must not contain a <handler> element/);
	// The refusal does not close the gate on a document that carries none of them.
	const staticSvg = wrap('<rect width="64" height="64" fill="url(#g)"/>');
	assert.equal(validateIcon(staticSvg), staticSvg, "a document with no animation element is admitted");
});

test("validateIcon requires the SVG namespace declaration on the root element", () => {
	// A root that declares no namespace is not an SVG image: the browser refuses to decode it, so the rasterizer's decode rejects and the payer's export fails; the gate refuses it here rather than admitting it into that path.
	const bare = '<svg width="64" height="64"><rect width="64" height="64"/></svg>';
	const error = refusalError(() => validateIcon(bare));
	assert.ok(error instanceof InvalidIconError, "a root without a namespace declaration is refused");
	assert.match(error.message, /must declare xmlns=/, "and the refusal names the declaration the root needs");
	// The declaration is read in the spelling that binds the root: a default `xmlns` on an unprefixed root, `xmlns:<prefix>` on a prefixed one.
	const declared = `<svg xmlns="${SVG_NAMESPACE}" width="64" height="64"></svg>`;
	assert.equal(validateIcon(declared), declared, "a declared namespace is admitted");
	const prefixed = `<svg:svg xmlns:svg="${SVG_NAMESPACE}" width="64" height="64"></svg:svg>`;
	assert.equal(validateIcon(prefixed), prefixed, "and a prefixed root declaring its own prefix is admitted too");
	// A declaration naming another namespace, an empty one, and one binding a prefix the root does not use are each refused: a parser binds the root to the one name it is given.
	for (const root of ['<svg xmlns="urn:not-svg" width="64" height="64"></svg>', '<svg xmlns="" width="64" height="64"></svg>', `<svg xmlns:svg="${SVG_NAMESPACE}" width="64" height="64"></svg>`]) {
		assert.throws(() => validateIcon(root), InvalidIconError, `must refuse ${root}`);
	}
	// The declaration's position in the root tag decides nothing.
	const trailing = `<svg width="64" height="64" xmlns="${SVG_NAMESPACE}"></svg>`;
	assert.equal(validateIcon(trailing), trailing, "a declaration after the dimensions is admitted");
});

test("validateIcon refuses a processing instruction", () => {
	const root = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"></svg>';
	// The XML declaration and an `xml-stylesheet` instruction are both processing instructions, and the gate refuses the class rather than reading which one was written.
	for (const instruction of ['<?xml version="1.0" encoding="UTF-8"?>', '<?xml-stylesheet href="x.css"?>', "<?target data?>"]) {
		assert.throws(() => validateIcon(`${instruction}${root}`), InvalidIconError, `must refuse the processing instruction ${instruction}`);
	}
	assert.match(refusalMessage(() => validateIcon(`<?xml-stylesheet href="x.css"?>${root}`)), /processing instruction/);
});

test("validateIcon refuses every href and url reference that is not a same-document fragment", () => {
	const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">${inner}</svg>`;
	// A relative reference names a resource outside the document, so an element the denylist does not name cannot carry one either.
	assert.throws(() => validateIcon(wrap('<a href="logo.svg"/>')), InvalidIconError);
	assert.throws(() => validateIcon(wrap('<a xlink:href="other.svg#t"/>')), InvalidIconError);
	assert.throws(() => validateIcon(wrap("<a href=logo.svg/>")), InvalidIconError, "an unquoted relative reference is refused too");
	assert.throws(() => validateIcon(wrap('<a foo:href="http://example.com/x.png"/>')), InvalidIconError, "a namespace-prefixed href is the attribute a parser binds, so it is read too");
	// A name that merely ends in `href` is not the attribute itself, so a custom `data-href` carrying a relative value is not read as a reference.
	const dataHref = wrap('<rect width="8" height="8" data-href="other.svg"/>');
	assert.equal(validateIcon(dataHref), dataHref);
	assert.throws(() => validateIcon(wrap('<rect width="8" height="8" fill="url(gradient.svg#g)"/>')), InvalidIconError);
	assert.throws(() => validateIcon(wrap('<rect width="8" height="8" fill="url(gradient.svg)"/>')), InvalidIconError);
	// A same-document `#` fragment is admitted in both the href and the url spelling, so a local link or paint reference still validates.
	const local = wrap('<a href="#local"/><rect width="8" height="8" fill="url(#g)"/>');
	assert.equal(validateIcon(local), local);
});

test("validateIcon refuses the external-document loader <animation> and the scripting <listener>, by local name", () => {
	const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">${inner}</svg>`;
	// The reference is a same-document fragment, so the refusal turns on the element name alone.
	const animation = wrap('<animation href="#a"/>');
	assert.throws(() => validateIcon(animation), InvalidIconError, "must refuse <animation>");
	assert.match(refusalMessage(() => validateIcon(animation)), /must not contain a <animation> element/);
	const listener = wrap('<listener event="click" handler="#h"/>');
	assert.throws(() => validateIcon(listener), InvalidIconError, "must refuse <listener>");
	assert.match(refusalMessage(() => validateIcon(listener)), /must not contain a <listener> element/);
	// The local-name reading is case-insensitive and prefix-blind, as for every other denied element.
	assert.throws(() => validateIcon(wrap('<svg:Animation href="#a"/>')), InvalidIconError);
	assert.throws(() => validateIcon(wrap('<SVG:Listener event="click"/>')), InvalidIconError);
});

test("validateIcon refuses a root that declares an attribute the root check reads more than once", () => {
	// A duplicate attribute is a fatal XML error, so the browser refuses to decode the document while a first-wins attribute reading admits it; each attribute the root check reads is refused when the root repeats it.
	const repeatedNamespace = `<svg xmlns="${SVG_NAMESPACE}" xmlns="urn:not-svg" width="64" height="64"></svg>`;
	assert.throws(() => validateIcon(repeatedNamespace), InvalidIconError, "a repeated namespace declaration is refused");
	assert.match(refusalMessage(() => validateIcon(repeatedNamespace)), /must not declare xmlns more than once/);
	// The second `width` here is unbounded, so reading the first alone would satisfy the cap and leave the real root viewport unbounded.
	const repeatedWidth = `<svg xmlns="${SVG_NAMESPACE}" width="64" height="64" width="99999"></svg>`;
	assert.throws(() => validateIcon(repeatedWidth), InvalidIconError, "a repeated width is refused");
	assert.match(refusalMessage(() => validateIcon(repeatedWidth)), /must not declare width more than once/);
	const repeatedHeight = `<svg xmlns="${SVG_NAMESPACE}" width="64" height="64" height="99999"></svg>`;
	assert.throws(() => validateIcon(repeatedHeight), InvalidIconError, "a repeated height is refused");
	assert.match(refusalMessage(() => validateIcon(repeatedHeight)), /must not declare height more than once/);
	// A prefixed root repeats the declaration that binds its own prefix rather than the default declaration.
	const prefixedRepeated = `<svg:svg xmlns:svg="${SVG_NAMESPACE}" xmlns:svg="${SVG_NAMESPACE}" width="64" height="64"></svg:svg>`;
	assert.throws(() => validateIcon(prefixedRepeated), InvalidIconError, "a prefixed root repeating xmlns:<prefix> is refused");
	// The refusal does not close the gate on a legitimate icon.
	const once = `<svg xmlns="${SVG_NAMESPACE}" width="64" height="64" fill="#123456"></svg>`;
	assert.equal(validateIcon(once), once, "a root declaring each attribute the check reads once is admitted");
	assert.equal(validateIcon(SMALL_SVG), SMALL_SVG, "the ordinary small icon keeps validating");
});

test("validateIcon reads a url(…) reference only when its argument is non-empty", () => {
	const wrap = (inner) => `<svg xmlns="${SVG_NAMESPACE}" width="64" height="64">${inner}</svg>`;
	// An empty argument names no resource a browser resolves, so the ordinary prose spelling `url()` in a title or description is admitted rather than refused as a non-fragment reference.
	const prose = wrap("<title>Tap to open</title><desc>see url() in the docs</desc>");
	assert.equal(validateIcon(prose), prose, "the spelling url() in ordinary prose is admitted");
	const quotedEmpty = wrap("<desc>an empty paint is url(\"\") or url('')</desc>");
	assert.equal(validateIcon(quotedEmpty), quotedEmpty, "an empty quoted argument is not a reference either");
	// A non-empty argument that does not begin with `#` still names a resource outside the document, so it stays refused in each spelling.
	assert.throws(() => validateIcon(wrap('<rect width="8" height="8" fill="url(https://example.com/x.svg#p)"/>')), InvalidIconError, "a bare remote url(...) value is refused");
	assert.throws(() => validateIcon(wrap("<rect width=\"8\" height=\"8\" fill=\"url('https://example.com/x.svg#p')\"/>")), InvalidIconError, "a quoted remote url(...) value is refused");
	assert.throws(() => validateIcon(wrap('<rect width="8" height="8" fill="url(gradient.svg#g)"/>')), InvalidIconError, "a relative url(...) value is refused");
	// The one same-document spelling keeps validating.
	const local = wrap('<rect width="8" height="8" fill="url(#g)"/>');
	assert.equal(validateIcon(local), local, "a same-document url(#…) paint still validates");
});
