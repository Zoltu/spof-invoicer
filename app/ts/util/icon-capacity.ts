/**
 * The byte-capacity contract the icon validator and the `data:` URL leaf share: the most UTF-8 bytes one optional SVG icon may carry.
 *
 * It is a module of its own rather than a constant in either reader so that the gate that bounds an icon and the leaf that armors it into a `data:` URL read one statement rather than two figures kept in step by hand.
 * `invoice/icon.ts` re-exports {@link MAX_ICON_SVG_BYTES} as its own bound and `util/data-url.ts` sizes its payload ceiling from it, so the cap a value is validated against and the ceiling the leaf admits cannot drift apart.
 */

/** The icon cap in bytes: the bound one optional SVG icon is held to, which is the 8192 bytes a caller can actually store. */
export const MAX_ICON_SVG_BYTES = 8192;
