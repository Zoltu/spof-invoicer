/**
 * The shared icon contract the icon validator, the `data:` URL leaf, the SVG-to-`data:`-URL encoder, the create form and the browser-only rasterizer read: the most UTF-8 bytes one optional SVG icon may carry, the largest intrinsic size its root `<svg>` element may declare per axis, the one raw ceiling the create form reads a chosen file under and the icon gate applies before it composes, the same number named as the bytes the form reads, and the one wording of each refusal a bound produces.
 *
 * It is a module of its own rather than a figure in each reader so that the gate that bounds an icon, the leaf that declares its `data:` URL, the encoder that arms such a URL, the create form that reads a chosen file and the rasterizer that caps its canvas read one statement each rather than figures kept in step by hand.
 * The bounds here are plain numbers with no imports, and that is the whole reason the modules around them are split apart: {@link MAX_ICON_SVG_BYTES} is read by `util/data-url.ts`, the `data:` URL leaf `util/dom.ts`'s `h()` imports, and `h()` is imported by nearly every page module, so neither the measurement of a value against the cap (`util/icon-byte-length.ts`) nor the encoding step that arms a value (`util/svg-data-url.ts`) belongs here, where either would put the vendored encoding stack on the graph of every module that reads nothing but a bound.
 * `invoice/icon.ts` re-exports both bounds as its own, `util/data-url.ts` sizes its payload ceiling from {@link MAX_ICON_SVG_BYTES}, and `pdf/rasterize.ts` caps each raster axis at {@link MAX_ICON_DIMENSION} without importing the validator, so the cap a value is validated against and the bounds its readers apply cannot drift apart.
 * {@link MAX_ICON_RAW_CODE_UNITS} is the one raw bound the form's file read and the gate's pre-composition check both derive from, and {@link MAX_ICON_FILE_BYTES} names that same number as the bytes the form reads, so changing one cannot silently make the form and the gate bound different inputs; the wording the gate refuses a spelling past that raw bound with is {@link iconRawCodeUnitRefusal}, and the form's file read refuses a chosen file past that same number of bytes with {@link iconFileSizeRefusal}, each stated here beside {@link iconByteCapRefusal} for the same reason.
 */

/** The icon cap in bytes: the bound one optional SVG icon is held to, which is the 8192 bytes a caller can actually store. */
export const MAX_ICON_SVG_BYTES = 8192;

/**
 * The byte-cap refusal: the one wording of this bound, raised by the icon gate for a value past {@link MAX_ICON_SVG_BYTES} and shown by the create form under the icon field.
 *
 * The gate is the one reader that decides this bound, over the UTF-8 byte length of the canonical icon text, which `util/icon-canonical-text.ts`'s `canonicalIconText` defines, and the create form shows the gate's own refusal for a value past it rather than wording a second copy that could drift out of step.
 * The figure is {@link MAX_ICON_SVG_BYTES}'s and the unit is the one that measurement is in, so stating it here is what lets the gate that refuses an over-cap icon and the create form that shows that refusal say the same thing.
 */
export function iconByteCapRefusal(bytes: number): string {
	return `The icon is ${bytes} bytes, over the ${MAX_ICON_SVG_BYTES}-byte limit.`;
}

/** The largest `width` or `height` an icon's root `<svg>` element may declare, and the most pixels one raster axis is drawn at; a document declaring a larger intrinsic size is refused rather than silently downscaled. */
export const MAX_ICON_DIMENSION = 256;

/**
 * The one raw ceiling the icon gate applies to the raw spelling, and the number {@link MAX_ICON_FILE_BYTES} names as the bytes the create form reads: {@link MAX_ICON_SVG_BYTES} times eight.
 *
 * The byte cap bounds the trimmed, NFC-composed value, but a file's own size is the raw spelling on disk, which a canonical decomposition can make longer, so the read is bounded by a ceiling generous enough that the longest canonical decomposition of a within-cap document is never refused — the at-most-four-code-point decomposition of a single character is far inside eight times the cap.
 * A UTF-8 file decodes to at most one code unit per byte, so a file at this ceiling yields a string no longer than the raw code-unit bound the gate applies before it composes; the form's read and the gate's first check therefore bound the same input from two sides.
 */
export const MAX_ICON_RAW_CODE_UNITS = MAX_ICON_SVG_BYTES * 8;

/** The most bytes the create form reads from a chosen icon file before it decodes the file at all: {@link MAX_ICON_RAW_CODE_UNITS}, the same number the gate applies to a raw spelling. */
export const MAX_ICON_FILE_BYTES = MAX_ICON_RAW_CODE_UNITS;

/**
 * The file-size refusal, worded once for the one reader of {@link MAX_ICON_FILE_BYTES}: the message the create form shows under the icon field for a chosen file past the raw read ceiling.
 *
 * It stands beside {@link iconByteCapRefusal} and {@link iconRawCodeUnitRefusal} for the reason stated there, and it names the file's own declared size rather than the text's length, so a file refused before it is read says so rather than reading as the raw code-unit refusal.
 */
export function iconFileSizeRefusal(bytes: number): string {
	return `The icon file is ${bytes} bytes, over the ${MAX_ICON_FILE_BYTES}-byte read limit.`;
}

/**
 * The raw pre-composition refusal: the reason the icon gate raises for a spelling past {@link MAX_ICON_RAW_CODE_UNITS}.
 *
 * The create form does not reach it from a chosen file, because that path refuses a file past {@link MAX_ICON_FILE_BYTES} bytes before it reads the file, and a UTF-8 file decodes to at most one code unit per byte, so the text of a file that passes that check is never past this bound.
 * Only a caller that hands the gate a longer spelling directly sees this wording, which is the one way to reach the refusal.
 * It is stated in this module beside its own bound, {@link MAX_ICON_RAW_CODE_UNITS}, so the figure a caller is refused against and the reason it is refused with are one statement rather than two kept in step by hand.
 * The clause naming the check that ran before normalization is what tells this refusal apart from the composed-byte one rather than leaving the two to read as the same failure.
 */
export function iconRawCodeUnitRefusal(codeUnits: number): string {
	return `The icon is ${codeUnits} characters before normalization, over the ${MAX_ICON_RAW_CODE_UNITS}-character limit.`;
}
