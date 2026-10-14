/**
 * The browser-only rasterizer: the invoice's icon as PNG bytes a PDF can embed.
 *
 * This module is the PDF export's second image-context sink, and the only one that needs a browser: it loads the icon leaf's `data:image/svg+xml;base64,…` URL into an `HTMLImageElement`, draws that image into a `<canvas>`, and reads the canvas back as a PNG.
 * The browser renders the SVG through both of those in secure static image mode, so scripts do not run and no external resource is fetched, exactly as for the on-screen `<img>`.
 * Nothing here reaches the network: the image's source is the leaf's own `data:` URL, whose bytes the page already carries, so no image request and no cross-origin response is involved and no `crossOrigin` request is made or needed.
 * What keeps the canvas untainted is that absence of a cross-origin response rather than a same-origin source: a `data:` URL's origin is opaque, and an opaque origin is not what taints a canvas — drawing image bytes that arrived from another origin is — and the behaviour is unaffected either way, because an engine that tainted this canvas would fail the read-back, `toBlob` throwing a `SecurityError` for a canvas that is not origin-clean, and that throw inside {@link canvasBlob}'s promise executor rejecting this module's promise rather than yielding a blank raster.
 *
 * It is deliberately kept out of the renderer's static module graph: `pdf/renderer.ts` reaches it through a dynamic `import()` on the first export that carries an icon, so a page never loads it until an icon actually has to be drawn, and the test suite — which installs a stand-in document and canvas of its own — is the one place that imports it statically.
 * The module touches `document` only inside {@link rasterizeSvgIcon}, so importing it costs nothing beyond its own parse.
 */

import { isSvgDataUrl, type SvgDataUrl } from "../util/data-url.js";
import { preview } from "../util/errors.js";
import { MAX_ICON_DIMENSION } from "../util/icon-capacity.js";
import type { IconRaster } from "./renderer.js";

/** The media type of the bytes this module produces, and the only one the canvas is asked for. */
const RASTER_MIME = "image/png";

/**
 * Rasterize an SVG data URL to PNG bytes, at the icon's own intrinsic size and never past {@link MAX_ICON_DIMENSION} on an axis.
 *
 * The caller hands over the icon leaf's own {@link SvgDataUrl} — the value `ui/presentation.ts`'s view model armed once — so this module neither builds nor re-encodes one, and the on-screen `<img>` and this module's canvas load one prepared value rather than two spellings of it.
 * The parameter's {@link SvgDataUrl} type is a compile-time brand with no runtime force, so the sink re-checks the shape at run time and refuses a value that is not the leaf's own data URL rather than trusting the brand alone, exactly as `util/dom.ts`'s `h()` does for the on-screen sink.
 * The image is fully decoded before it is drawn: `decode()` resolves only once the browser holds the decoded pixels, and drawing an SVG before that — on the `load` event, or straight after setting `src` — yields a blank raster in browsers that rasterize lazily.
 * The raster size is the icon's own: each axis takes the image's `naturalWidth`/`naturalHeight`, floored, and capped at {@link MAX_ICON_DIMENSION}, and an axis that reports no intrinsic size (a `naturalWidth` of 0, or a value that is not finite) falls back to that cap rather than to a size of this module's choosing — so an SVG the validator admitted is rasterized at the size it declares, and one that somehow declares nothing is still bounded by the icon's own dimension cap.
 * The raster's geometry is deterministic for a given icon: it is drawn once, into a canvas of that size, with no clock, no randomness, and no dependence on the page.
 * The PNG bytes themselves are the browser canvas encoder's own, so two browsers — or two versions of one — are not guaranteed to encode the same pixels to the same bytes.
 *
 * Failure is a rejection carrying the reason — a decode the browser refuses, a canvas with no 2d context, or a canvas that produces no blob — so a caller either gets a complete raster or an error it can report, never a blank or half-built image.
 * That promise rests on both waits below settling, which is the assumption this seam works under: `image.decode()` and the `toBlob` callback are relied on to resolve or reject, and no timer bounds either, so an engine that leaves one pending leaves the caller pending instead of producing the rejection above.
 * What this module guarantees is therefore the documented rejections, not a bounded wait, and a caller that needs an answer within a deadline has to supply that deadline itself.
 */
export async function rasterizeSvgIcon(dataUrl: SvgDataUrl): Promise<IconRaster> {
	if (!isSvgDataUrl(dataUrl)) {
		throw new TypeError(`rasterize: refusing the src ${preview(dataUrl)} — only the icon leaf's own data URL may reach an image sink`);
	}
	const image = document.createElement("img");
	image.setAttribute("src", dataUrl);
	await image.decode();
	const width = rasterSide(image.naturalWidth);
	const height = rasterSide(image.naturalHeight);
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d");
	if (context === null) {
		throw new Error(`rasterize: the browser gave no 2d context for a ${width}x${height} icon`);
	}
	context.drawImage(image, 0, 0, width, height);
	const blob = await canvasBlob(canvas);
	return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
}

/**
 * The pixels one axis is rasterized at: the image's own intrinsic size, floored, and never more than {@link MAX_ICON_DIMENSION}.
 * A non-finite or non-positive natural size means the image reported none on that axis, which is what an SVG without an intrinsic size does; the cap is then the raster size, so the fallback is the icon's own bound rather than a fresh number.
 */
function rasterSide(natural: number): number {
	if (!Number.isFinite(natural) || natural < 1) return MAX_ICON_DIMENSION;
	return Math.max(1, Math.min(Math.floor(natural), MAX_ICON_DIMENSION));
}

/**
 * The canvas's PNG blob through the callback `toBlob` exposes; a canvas that produces no blob is refused rather than returned as an empty raster.
 * The callback is assumed to be called: nothing here bounds the wait, so a canvas that never calls it leaves the caller pending rather than rejected.
 */
function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => {
			if (blob === null) {
				reject(new Error("rasterize: the canvas produced no PNG blob"));
				return;
			}
			resolve(blob);
		}, RASTER_MIME);
	});
}
