/**
 * The SVG-to-`data:`-URL encoder: it runs the icon gate on a value and turns the text that gate accepts into the `data:image/svg+xml;base64,…` URL an image sink loads.
 *
 * Running the gate here is what makes this module a validation boundary as well as a transport one: a value the gate refuses — a non-string, an empty or over-cap document, a document whose root `<svg>` element carries no SVG namespace declaration, a document carrying a refused construct — is refused with the gate's own `TypeError` or `InvalidIconError` rather than armored into a `data:` URL, so no future sink can be handed text that was never validated.
 * The branded {@link SvgDataUrl} it returns, the prefix it composes, and the shape check that recognizes the result all live in `util/data-url.ts`, the leaf `util/dom.ts` imports; the base64 encoder this module reads stays on this module's graph alone.
 * It transports the gate's own canonical text — the trimmed, NFC-composed value the gate returns rather than the raw spelling it was handed — UTF-8 encoded and base64-armored, so no character of the document needs escaping inside an attribute.
 * The result is an image-sink value, meant for an `HTMLImageElement` `src` or a `<canvas>` draw and never for a navigation target, an inline markup sink, or a fetch.
 */

import { validateIcon } from "../invoice/icon.js";
import { SVG_DATA_URL_PREFIX, type SvgDataUrl } from "./data-url.js";
import { base64, utf8ToBytes } from "./encoding.js";

/**
 * Encode an SVG icon as a `data:image/svg+xml;base64,…` URL.
 *
 * The value is gated with `invoice/icon.ts`'s `validateIcon` first, so anything the gate refuses throws here with the gate's own error and nothing else is encoded; what is encoded is exactly the canonical text the gate returned.
 * See the module doc for the image-sink contract.
 */
export function svgDataUrl(svg: string): SvgDataUrl {
	const canonical = validateIcon(svg);
	return `${SVG_DATA_URL_PREFIX}${base64.encode(utf8ToBytes(canonical))}` as SvgDataUrl;
}
