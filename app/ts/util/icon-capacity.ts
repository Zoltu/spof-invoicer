/**
 * The capacity contract the icon validator, the `data:` URL leaf and the browser-only rasterizer share: the most UTF-8 bytes one optional SVG icon may carry, and the largest intrinsic size its root `<svg>` element may declare per axis.
 *
 * It is a module of its own rather than a constant in each reader so that the gate that bounds an icon, the leaf that armors it into a `data:` URL and the rasterizer that caps its canvas read one statement each rather than figures kept in step by hand.
 * `invoice/icon.ts` re-exports both as its own bounds, `util/data-url.ts` sizes its payload ceiling from {@link MAX_ICON_SVG_BYTES}, and `pdf/rasterize.ts` caps each raster axis at {@link MAX_ICON_DIMENSION} without importing the validator, so the cap a value is validated against and the bounds its readers apply cannot drift apart.
 */

/** The icon cap in bytes: the bound one optional SVG icon is held to, which is the 8192 bytes a caller can actually store. */
export const MAX_ICON_SVG_BYTES = 8192;

/** The largest `width` or `height` an icon's root `<svg>` element may declare, and the most pixels one raster axis is drawn at; a document declaring a larger intrinsic size is refused rather than silently downscaled. */
export const MAX_ICON_DIMENSION = 256;
