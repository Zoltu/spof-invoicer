/**
 * The one measurement of an icon value against the shared byte cap: its UTF-8 length once composed to NFC, the length `util/icon-capacity.ts`'s `MAX_ICON_SVG_BYTES` bounds.
 *
 * The measurement reads the encoding utility below, which is why it is not a function of the cap module `util/icon-capacity.ts` that a reader of a bound imports.
 * The icon gate (`invoice/icon.ts`) measures the value it stores with this function, and the create form's file check measures the same way, so the form's accept/reject decision agrees with the gate's rather than with the bytes a file holds on disk, which normalization may shrink or grow.
 * Composing an already-NFC value is a no-op, so a caller that has composed its value measures the same length.
 */
import { utf8ToBytes } from "./encoding.js";
/**
 * The UTF-8 byte length of `svg` once composed to NFC, which is the length `util/icon-capacity.ts`'s `MAX_ICON_SVG_BYTES` bounds.
 */
export function iconByteLength(svg) {
    return utf8ToBytes(svg.normalize("NFC")).length;
}
//# sourceMappingURL=icon-byte-length.js.map