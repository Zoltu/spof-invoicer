/**
 * The icon data-URL leaf: the `data:image/svg+xml;base64,…` prefix an SVG icon is armed under, the branded {@link SvgDataUrl} type an image sink's `src` accepts, and the bounded shape check beside it.
 *
 * This module is the one place in the runtime tree a `data:` literal is spelled, and it imports no encoder: the step that turns an SVG document into a URL this leaf admits is `svgDataUrl`, in `util/svg-data-url.ts`.
 * `util/dom.ts` imports {@link SvgDataUrl} and {@link isSvgDataUrl} for the one `src` sink `h()` builds, so what reaches this module reaches nearly every page module.
 *
 * {@link SvgDataUrl} is the only type an image sink's `src` accepts, so a bare string cannot reach one by accident, and {@link isSvgDataUrl} is the matching runtime check for a value TypeScript could not narrow.
 * Neither makes any sink accept such a value: a caller that gates a `src` on {@link isSvgDataUrl} enforces that rule in its own code, and this leaf neither writes an attribute nor permits one, so sink-side enforcement is outside this module.
 * {@link isSvgDataUrl} is a bounded shape check that recognizes the URL that encoder builds; it is a shape test rather than a content check, and what makes the result safe to load is the browser's image-context rendering, not this leaf.
 */
import { MAX_ICON_SVG_BYTES } from "./icon-capacity.js";
/** The prefix of every SVG data URL the icon encoder builds, and the one `data:` literal in the runtime tree. */
export const SVG_DATA_URL_PREFIX = "data:image/svg+xml;base64,";
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
 * Test whether a value is the shape of an SVG data URL this module produced.
 *
 * The check is a bounded shape test, not a decode: the value must carry the exact prefix and a payload over the base64 alphabet in whole four-character groups with at most two trailing `=` padding characters, no longer than {@link MAX_SVG_DATA_URL_PAYLOAD}, whose spelling implies at most {@link MAX_ICON_SVG_BYTES} decoded bytes, and ending exactly at the last base64 character with no trailing newline or other character.
 * The payload is never decoded, so this predicate's work is linear in the value's length and a hostile caller cannot spend decode time through it; the length ceiling is applied to the value before the payload is copied out, so it bounds that cost for an arbitrarily long input.
 * The check validates the payload's spelling, not that it decodes to a whole SVG: a prefix-matching, well-shaped value such as `QUJD` is recognized, since only a value this module built ever reaches the caller that gates a `src` on this.
 *
 * The predicate is shape-only and non-authoritative — matching says the value looks like a URL this module builds, not that the bytes behind it are a safe SVG — and it is usable *only* to gate a value headed for an image sink (`HTMLImageElement` `src`, a `<canvas>` draw), never as a general-purpose untrusted-URL validator: it admits any well-shaped base64 payload and imposes no content check, and the security boundary for an icon is the browser's image-context rendering, not this predicate.
 * It narrows to {@link SvgDataUrl}, the type an image sink's `src` accepts, so a value that passed the check reaches the attribute as the branded type rather than as a bare string.
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