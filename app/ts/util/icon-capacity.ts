/**
 * The shared icon contract the icon validator, the `data:` URL leaf, the SVG-to-`data:`-URL encoder, the create form and the browser-only rasterizer read: the most UTF-8 bytes one optional SVG icon may carry, the largest intrinsic size its root `<svg>` element may declare per axis, the one raw ceiling the create form reads a chosen file under and the icon gate applies before it composes, the same number named as the bytes the form reads, and the one wording of each refusal a bound's two readers state.
 *
 * It is a module of its own rather than a figure in each reader so that the gate that bounds an icon, the leaf that declares its `data:` URL, the encoder that arms such a URL, the create form that reads a chosen file and the rasterizer that caps its canvas read one statement each rather than figures kept in step by hand.
 * The bounds here are plain numbers with no imports, so a module that reads one does not acquire an encoding dependency through it: the measurement of a value against {@link MAX_ICON_SVG_BYTES} lives in `util/icon-byte-length.ts`, and the encoding step that arms a value lives in `util/svg-data-url.ts`, both kept off this module's graph.
 * `invoice/icon.ts` re-exports both bounds as its own, `util/data-url.ts` sizes its payload ceiling from {@link MAX_ICON_SVG_BYTES}, and `pdf/rasterize.ts` caps each raster axis at {@link MAX_ICON_DIMENSION} without importing the validator, so the cap a value is validated against and the bounds its readers apply cannot drift apart.
 * {@link MAX_ICON_RAW_CODE_UNITS} is the one raw bound the form's file read and the gate's pre-composition check both derive from, and {@link MAX_ICON_FILE_BYTES} names that same number as the bytes the form reads, so changing one cannot silently make the form and the gate bound different inputs; the wording both of those readers refuse a spelling past the bound with is {@link iconRawCodeUnitRefusal}, stated here beside {@link iconByteCapRefusal} for the same reason.
 */

/** The icon cap in bytes: the bound one optional SVG icon is held to, which is the 8192 bytes a caller can actually store. */
export const MAX_ICON_SVG_BYTES = 8192;

/**
 * The byte-cap refusal, worded once for both of its readers: the message the create form shows under the icon field, and the reason the icon gate raises for the same value.
 *
 * The form's own check and the gate's check decide the same thing about the same measured value — the NFC-composed UTF-8 byte length of the icon text — so one reader wording the refusal and the other wording it again is a pair that has to be kept in step by hand, and the gate's copy of it would be unreachable through the form, which always checks first.
 * The figure is {@link MAX_ICON_SVG_BYTES}'s and the unit is the one both readers measure in, so stating it here is what lets the surfaces that refuse an over-cap icon say the same thing.
 */
export function iconByteCapRefusal(bytes: number): string {
	return `The icon is ${bytes} bytes, over the ${MAX_ICON_SVG_BYTES}-byte limit.`;
}

/** The largest `width` or `height` an icon's root `<svg>` element may declare, and the most pixels one raster axis is drawn at; a document declaring a larger intrinsic size is refused rather than silently downscaled. */
export const MAX_ICON_DIMENSION = 256;

/**
 * The one raw ceiling the icon gate applies to a not-yet-composed spelling, and the number {@link MAX_ICON_FILE_BYTES} names as the bytes the create form reads: {@link MAX_ICON_SVG_BYTES} times eight.
 *
 * The byte cap bounds the NFC-composed value, but a file's own size is the raw spelling on disk, which a canonical decomposition can make longer, so the read is bounded by a ceiling generous enough that the longest canonical decomposition of a within-cap document is never refused — the at-most-four-code-point decomposition of a single character is far inside eight times the cap.
 * A UTF-8 file decodes to at most one code unit per byte, so a file at this ceiling yields a string no longer than the raw code-unit bound the gate applies before it composes; the form's read and the gate's first check therefore bound the same input from two sides.
 */
export const MAX_ICON_RAW_CODE_UNITS = MAX_ICON_SVG_BYTES * 8;

/** The most bytes the create form reads from a chosen icon file before it decodes the file at all: {@link MAX_ICON_RAW_CODE_UNITS}, the same number the gate applies to a raw spelling. */
export const MAX_ICON_FILE_BYTES = MAX_ICON_RAW_CODE_UNITS;

/**
 * The raw pre-composition refusal, worded once for both of its readers: the message the create form shows under the icon field for the text a chosen file yields, and the reason the icon gate raises for a spelling past {@link MAX_ICON_RAW_CODE_UNITS}.
 *
 * The form's own check and the gate's first check decide the same thing about the same value — the length of the raw spelling, before either reader measures or composes it — so one reader wording the refusal and the other wording it again is a pair that has to be kept in step by hand, exactly as for {@link iconByteCapRefusal}.
 * The figure and the unit are {@link MAX_ICON_RAW_CODE_UNITS}'s and the clause naming the check that ran before normalization is what tells this refusal apart from the composed-byte one, so stating it here is what lets the surfaces that refuse an over-long icon say the same thing.
 */
export function iconRawCodeUnitRefusal(codeUnits: number): string {
	return `The icon is ${codeUnits} characters before normalization, over the ${MAX_ICON_RAW_CODE_UNITS}-character limit.`;
}
