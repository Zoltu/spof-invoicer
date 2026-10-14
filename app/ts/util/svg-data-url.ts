/**
 * The SVG-to-`data:`-URL encoder: it turns a validated SVG document into the `data:image/svg+xml;base64,…` URL an image sink loads.
 *
 * The branded {@link SvgDataUrl} it returns, the prefix it composes, and the shape check that recognizes the result all live in `util/data-url.ts`, the leaf `util/dom.ts` imports; this module carries the encoding step separately so the vendored base64 encoder stays off the leaf's static graph and off the graph of every page module that imports `h()`.
 * The caller must have validated the value with the icon gate (`invoice/icon.ts`) first; that precondition is the caller's, and this function does not check it, so a value that was never validated is armored into a `data:` URL all the same.
 * What this function does enforce is the value's shape and byte size: a value that is not a string throws a `TypeError`, and an empty value or one over the {@link MAX_ICON_SVG_BYTES} byte cap — measured in code units first, so an over-long input is refused before it is encoded — throws a `RangeError`, so it never works on unbounded input and the URL it returns is always one the leaf's shape check admits.
 * It transports the exact text it is given, UTF-8 encoded and base64-armored, so no character of the document needs escaping inside an attribute.
 * The result is an image-sink value, meant for an `HTMLImageElement` `src` or a `<canvas>` draw and never for a navigation target, an inline markup sink, or a fetch.
 */

import { SVG_DATA_URL_PREFIX, type SvgDataUrl } from "./data-url.js";
import { base64, utf8ToBytes } from "./encoding.js";
import { preview } from "./errors.js";
import { MAX_ICON_SVG_BYTES } from "./icon-capacity.js";

/**
 * Encode an SVG document as a `data:image/svg+xml;base64,…` URL.
 *
 * See the module doc for the precondition (a validated value), the refusals, and the image-sink contract.
 */
export function svgDataUrl(svg: string): SvgDataUrl {
	if (typeof svg !== "string") {
		throw new TypeError(`svg-data-url: expected an SVG string, got ${preview(svg)}`);
	}
	if (svg.length > MAX_ICON_SVG_BYTES) {
		throw new RangeError(`svg-data-url: refusing ${svg.length} code units, over the ${MAX_ICON_SVG_BYTES}-byte icon cap`);
	}
	const bytes = utf8ToBytes(svg);
	if (bytes.length === 0 || bytes.length > MAX_ICON_SVG_BYTES) {
		throw new RangeError(`svg-data-url: refusing ${bytes.length} UTF-8 bytes, outside 1..${MAX_ICON_SVG_BYTES}`);
	}
	return `${SVG_DATA_URL_PREFIX}${base64.encode(bytes)}` as SvgDataUrl;
}
