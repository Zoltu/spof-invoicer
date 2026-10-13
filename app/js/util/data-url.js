/**
 * The `data:` URL leaf for an SVG icon, and the one place in the runtime tree a `data:` literal is spelled.
 *
 * This module is the single boundary that turns validated SVG text into the `data:image/svg+xml;base64,…` URL that an `HTMLImageElement` `src` loads or a `<canvas>` draws.
 * Neither {@link svgDataUrl} nor {@link isSvgDataUrl} makes any sink accept such a value: a caller that gates a `src` on {@link isSvgDataUrl} enforces that rule in its own code, and this leaf neither writes an attribute nor permits one, so sink-side enforcement is outside this module.
 * {@link svgDataUrl} enforces the byte cap the icon validator applies, refusing an empty or over-long value before it encodes, so the leaf does no work proportional to an unbounded input.
 * {@link isSvgDataUrl} is a bounded shape check that recognizes the URL {@link svgDataUrl} builds; it is a shape test rather than a content check, and what makes the result safe to load is the browser's image-context rendering, not this leaf.
 */
import { base64, utf8ToBytes } from "./encoding.js";
import { preview } from "./errors.js";
import { MAX_ICON_SVG_BYTES } from "./icon-capacity.js";
/** The prefix of every SVG data URL this module builds. */
const SVG_DATA_URL_PREFIX = "data:image/svg+xml;base64,";
/**
 * The most base64 characters a payload this module could have built may carry: the encoded length of {@link MAX_ICON_SVG_BYTES} bytes, which is `4 * ceil(bytes / 3)`.
 * A payload longer than this was not built from a byte-capped SVG, so the shape check refuses it without decoding the value.
 * The length alone is not the byte bound, though, because an unpadded payload of this length decodes to one byte more than the cap; {@link isSvgDataUrl} therefore also reads the decoded length the payload's own padding implies and refuses one past {@link MAX_ICON_SVG_BYTES}.
 */
export const MAX_SVG_DATA_URL_PAYLOAD = 4 * Math.ceil(MAX_ICON_SVG_BYTES / 3);
/**
 * A whole number of base64 groups over the standard alphabet, with the padding characters only at the end.
 *
 * The trailing `(?![\\s\\S])` is a negative lookahead for any character, so it succeeds only at the end of the input: the pattern admits no trailing character of any kind, a line terminator included.
 * Under ECMAScript's non-multiline semantics a bare `$` asserts the same position, so the two spellings are equivalent here; the lookahead is written out so the assertion is stated in the pattern rather than left to the reader's recollection of `$`.
 */
const BASE64_PAYLOAD = /^[A-Za-z0-9+/]+={0,2}(?![\s\S])/;
/**
 * The number of bytes a well-shaped payload's spelling implies, read without decoding the payload: three bytes per whole four-character group, less one for each trailing `=` padding character.
 *
 * The predicate admits any well-shaped payload, so this length is the only way to bound the bytes behind a value from the value itself; a length ceiling alone would admit a full-length unpadded payload that decodes to one byte past the cap.
 */
function decodedByteLength(payload) {
    const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
    return (payload.length / 4) * 3 - padding;
}
/**
 * Encode an SVG document as a `data:image/svg+xml;base64,…` URL.
 *
 * The caller must have validated the value with the icon gate (`invoice/icon.ts`) first; that precondition is the caller's, and this function does not check it, so a value that was never validated is armored into a `data:` URL all the same.
 * What this function does enforce is the value's shape and byte size: a value that is not a string throws a `TypeError`, and an empty value or one over the {@link MAX_ICON_SVG_BYTES} byte cap — measured in code units first, so an over-long input is refused before it is encoded — throws a `RangeError`, so the leaf never works on unbounded input and the URL it returns is always one the shape check below admits.
 * It transports the exact text it is given, UTF-8 encoded and base64-armored, so no character of the document needs escaping inside an attribute.
 * The result is an image-sink value, meant for an `HTMLImageElement` `src` or a `<canvas>` draw and never for a navigation target, an inline markup sink, or a fetch.
 */
export function svgDataUrl(svg) {
    if (typeof svg !== "string") {
        throw new TypeError(`data-url: expected an SVG string, got ${preview(svg)}`);
    }
    if (svg.length > MAX_ICON_SVG_BYTES) {
        throw new RangeError(`data-url: refusing ${svg.length} code units, over the ${MAX_ICON_SVG_BYTES}-byte icon cap`);
    }
    const bytes = utf8ToBytes(svg);
    if (bytes.length === 0 || bytes.length > MAX_ICON_SVG_BYTES) {
        throw new RangeError(`data-url: refusing ${bytes.length} UTF-8 bytes, outside 1..${MAX_ICON_SVG_BYTES}`);
    }
    return SVG_DATA_URL_PREFIX + base64.encode(bytes);
}
/**
 * Test whether a value is the shape of an SVG data URL this module produced.
 *
 * The check is a bounded shape test, not a decode: the value must carry the exact prefix and a payload over the base64 alphabet in whole four-character groups with at most two trailing `=` padding characters, no longer than {@link MAX_SVG_DATA_URL_PAYLOAD}, whose spelling implies at most {@link MAX_ICON_SVG_BYTES} decoded bytes, and ending exactly at the last base64 character with no trailing newline or other character.
 * The payload is never decoded, so this predicate's work is linear in the value's length and a hostile caller cannot spend decode time through it; the length ceiling is applied to the value before the payload is copied out, so it bounds that cost for an arbitrarily long input.
 * The check validates the payload's spelling, not that it decodes to a whole SVG: a prefix-matching, well-shaped value such as `QUJD` is recognized, since only a value this module built ever reaches the caller that gates a `src` on this.
 *
 * The predicate is shape-only and non-authoritative — matching says the value looks like a URL this module builds, not that the bytes behind it are a safe SVG — and it is usable *only* to gate a value headed for an image sink (`HTMLImageElement` `src`, a `<canvas>` draw), never as a general-purpose untrusted-URL validator: it admits any well-shaped base64 payload and imposes no content check, and the security boundary for an icon is the browser's image-context rendering, not this predicate.
 */
export function isSvgDataUrl(value) {
    if (typeof value !== "string" || !value.startsWith(SVG_DATA_URL_PREFIX))
        return false;
    if (value.length > SVG_DATA_URL_PREFIX.length + MAX_SVG_DATA_URL_PAYLOAD)
        return false;
    const payload = value.slice(SVG_DATA_URL_PREFIX.length);
    if (payload.length === 0 || payload.length % 4 !== 0)
        return false;
    if (!BASE64_PAYLOAD.test(payload))
        return false;
    return decodedByteLength(payload) <= MAX_ICON_SVG_BYTES;
}
//# sourceMappingURL=data-url.js.map