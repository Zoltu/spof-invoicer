/**
 * The one measurement of an icon's bytes: the UTF-8 length of canonical icon text, the length `util/icon-capacity.ts`'s `MAX_ICON_SVG_BYTES` bounds.
 *
 * The measurement canonicalizes nothing of its own: its parameter is `util/icon-canonical-text.ts`'s `CanonicalIconText` — the brand `canonicalIconText` mints — so the length reported here is the length of the text the icon gate stores, a call site that already holds canonical text measures it without a second canonicalization hidden behind the call, and a raw spelling handed to it is a compile error rather than a length of text the gate would have canonicalized first.
 * The measurement reads the encoding utility below, which is why it is not a function of the cap module `util/icon-capacity.ts` that a reader of a bound imports.
 */

import { utf8ToBytes } from "./encoding.js";
import type { CanonicalIconText } from "./icon-canonical-text.js";

/**
 * The UTF-8 byte length of `canonicalText` — `util/icon-canonical-text.ts`'s `canonicalIconText` result — which is the length `util/icon-capacity.ts`'s `MAX_ICON_SVG_BYTES` bounds.
 * Its parameter's {@link CanonicalIconText} brand is what enforces that precondition: the measurement trims and composes nothing, and a raw spelling makes the call a compile error rather than a count of the wrong text.
 */
export function iconByteLength(canonicalText: CanonicalIconText): number {
	return utf8ToBytes(canonicalText).length;
}
