/**
 * The official invoice PDF.
 *
 * This is the payer's document in a portable, printable form: the same {@link InvoiceViewModel} the on-screen view draws (`ui/presentation.ts`), laid out on US Letter with pdf-lib's base-14 fonts — a serif voice for the document, a sans voice for its tabular data, a monospace voice for addresses.
 * Everything is vector.
 * pdf-lib cannot embed SVG and the export makes no network request of its own, so the letterhead's own mark is drawn rather than loaded: an accent square beside a wordmark and rules, or the payee's own icon in the square's place, rasterized from its data URL by the browser's canvas.
 *
 * The module is three layers:
 * - {@link buildInvoicePages} is the pure layout: the view model and a {@link FontMetrics} become one {@link PdfPageLayout} of {@link DrawOp}s per page with pagination already resolved.
 *   It touches no clock, no DOM and no network, so it is what the tests exercise directly.
 * - {@link renderInvoicePdf} embeds the fonts, runs the layout, and emits the PDF bytes.
 * - {@link downloadPdf} and {@link renderPdf} hand those bytes to the browser, the only layer that touches the outside world.
 *
 * A share string is untrusted, so every string passes through {@link toPdfText} before it is measured or drawn: a base-14 font encodes WinAnsi only, and an unencodable code point would otherwise throw mid-export.
 * Text that cannot be encoded becomes `?` and the document still renders.
 *
 * The payment link's QR symbol is drawn the same way: one filled rectangle per module of the view model's matrix, never an image, a font glyph, or a `data:` URL, so the export still reaches nothing off-origin.
 */

import {
	PDFDocument,
	PageSizes,
	StandardFonts,
	beginText,
	endText,
	popGraphicsState,
	pushGraphicsState,
	rgb,
	setCharacterSqueeze,
	setFillingColor,
	setFontAndSize,
	setTextMatrix,
	showText,
	type PDFFont,
	type PDFPage,
	type RGB,
} from "../../js/vendor/pdf-lib/pdf-lib.esm.js";
import type { Invoice } from "../invoice/model.js";
import {
	buildInvoiceViewModel,
	type InvoiceLabels,
	type InvoiceLineView,
	type InvoicePaymentTermView,
	type InvoiceViewModel,
} from "../ui/presentation.js";
import type { SvgDataUrl } from "../util/data-url.js";
import type { QrMatrix } from "../util/qr.js";

/** The media type the exported artifact's download blob carries. */
export const PDF_MIME = "application/pdf";

/** The name the artifact carries as its producer and creator, so it shows no pdf-lib branding. */
const DOCUMENT_PRODUCER = "Invoicing (on-chain payment invoice)";

/** US Letter, matching the print stylesheet's page. Sourced once so layout and rendering agree. */
export const PAGE = Object.freeze({
	width: PageSizes.Letter[0],
	height: PageSizes.Letter[1],
	marginX: 54,
	marginTop: 54,
	/** The lowest a content baseline may sit, measured from the bottom, so the page footer stays clear. */
	contentFloor: 78,
	/** The hairline above the running footer, measured from the bottom. */
	footerRule: 60,
	/** The running footer's baseline, measured from the bottom. */
	footerBaseline: 46,
});

/** A base-14 face, chosen by the role a run of text plays rather than by its PostScript name. */
export type PdfFontRole = "sans" | "sansBold" | "mono" | "serif" | "serifBold";

/** An RGB color in pdf-lib's shape. */
export type PdfColor = RGB;

/** One primitive the layout emits; the renderer maps it straight onto a pdf-lib page. */
export type DrawOp =
	| {
			readonly kind: "text";
			readonly x: number;
			readonly y: number;
			readonly text: string;
			readonly size: number;
			readonly font: PdfFontRole;
			readonly color: PdfColor;
			/** The run's horizontal scale as a fraction of the width it measures: 1 for a run drawn as it measures, and the scale that holds a copied value to the one line it is drawn as. */
			readonly xScale: number;
	}
	| {
			readonly kind: "rule";
			readonly x1: number;
			readonly y1: number;
			readonly x2: number;
			readonly y2: number;
			readonly thickness: number;
			readonly color: PdfColor;
	}
	| {
			readonly kind: "fill";
			readonly x: number;
			readonly y: number;
			readonly width: number;
			readonly height: number;
			readonly color: PdfColor;
			readonly border?: { readonly color: PdfColor; readonly width: number };
	}
	| {
			readonly kind: "image";
			readonly x: number;
			readonly y: number;
			readonly width: number;
			readonly height: number;
			/** The icon's PNG bytes, as `pdf/rasterize.ts` produced them; the renderer embeds them and draws the result at this box. */
			readonly png: Uint8Array;
	};

/** One page's worth of drawing, in PDF coordinates (origin at the bottom-left). */
export interface PdfPageLayout {
	readonly ops: readonly DrawOp[];
}

/** Text measurement, injected so the layout is pure and testable without embedding a font. */
export interface FontMetrics {
	widthOfText(text: string, size: number, font: PdfFontRole): number;
}

/** The outside world the export touches: a blob URL and a download click, isolated for testing. */
export interface PdfDownloader {
	createObjectUrl(blob: Blob): string;
	revokeObjectUrl(url: string): void;
	save(url: string, fileName: string): void;
}

/**
 * The seam between the export and the browser-only rasterizer, so the renderer is usable where there is no DOM.
 * The default implementation is the browser's own, imported on the first export that carries an icon; the test suite, which has no canvas, substitutes a raster of its own and reads the drawn runs back out of the exported bytes.
 */
export interface IconRasterizer {
	rasterize(dataUrl: SvgDataUrl): Promise<IconRaster>;
}

/**
 * A rasterized icon: the PNG bytes a PDF embeds, and the pixel size they were rasterized at.
 *
 * `width` and `height` are each a positive, finite number of pixels: the renderer divides by them to fit the raster into the letterhead box, so a zero, negative, or non-finite axis would produce undefined box geometry.
 * The shape lives here, beside {@link IconRasterizer}, because it is that seam's output; `pdf/rasterize.ts` names it through a type-only import the compiler erases, so the DOM-free renderer and the browser-only rasterizer share the shape without a static import between them.
 */
export interface IconRaster {
	readonly bytes: Uint8Array;
	readonly width: number;
	readonly height: number;
}

/**
 * The raster the export lays out, refused unless both axes are a positive, finite number of pixels.
 *
 * The icon's box is the raster's own aspect ratio fitted inside the letterhead square, so a zero or non-finite axis would divide to `NaN` or `Infinity` and put undefined geometry into the image op.
 * This is checked at {@link buildInvoicePages}, the single geometric entry point both the export and a direct layout caller reach, so the invariant holds whichever caller supplied the raster; the refusal is a thrown error like the rasterizer's own failures, so a malformed raster leaves no PDF geometry — and no PDF bytes — behind.
 */
function requirePositiveRaster(icon: IconRaster): IconRaster {
	const widthOk = Number.isFinite(icon.width) && icon.width >= 1;
	const heightOk = Number.isFinite(icon.height) && icon.height >= 1;
	if (!widthOk || !heightOk) {
		throw new Error(`pdf: refusing an icon raster of ${icon.width}x${icon.height} pixels, which is not a positive finite size`);
	}
	return icon;
}

const CONTENT_LEFT = PAGE.marginX;
/** The document's right content edge: the x every right-aligned draw and the payment symbol's block align to. */
export const CONTENT_RIGHT = PAGE.width - PAGE.marginX;
const CONTENT_W = CONTENT_RIGHT - CONTENT_LEFT;
const CONTENT_TOP = PAGE.marginTop;
/** The lowest top a block may reach, measured from the page's top edge, so nothing lands in the page footer's strip. */
export const FLOOR_TOP = PAGE.height - PAGE.contentFloor;

/** Fraction of a font's size from its baseline to the top of a capital, near enough for spacing. */
export const BASELINE_ASCENT = 0.72;
/** A multiple of a font's size that leaves a comfortable gap to the next baseline. */
const LEADING = 1.34;
const CELL_PAD = 8;
const TABLE_HEADER_H = 20;
const TABLE_ROW_MIN = 24;
const DESC_W = 228;
const QTY_W = 64;
const PRICE_W = 100;
const AMOUNT_W = CONTENT_W - DESC_W - QTY_W - PRICE_W;
const QTY_RIGHT = CONTENT_LEFT + DESC_W + QTY_W;
const PRICE_RIGHT = QTY_RIGHT + PRICE_W;
const AMOUNT_RIGHT = CONTENT_RIGHT;
const TOTALS_W = 240;
const TOTALS_ROW_H = 19;
const DUE_H = 32;
const PAYMENT_LABEL_W = 120;
const MIN_FIT_SIZE = 7;
/** The gap the running footer keeps between the document number and its right-aligned page label. */
const FOOTER_GAP = 12;
const FILE_STEM_MAX = 64;
/** How long the object URL outlives the click: a synchronous revoke can cancel the download before the browser has read the blob. */
const REVOKE_DELAY_MS = 1000;

/**
 * The vertical gaps between the layout's blocks, in points, so the page's rhythm reads as intent rather than as a bare number inside each block.
 * {@link GAP.afterSectionRule} is one value for the drop from either section rule — the letterhead's and the parties' — to the block that follows it, so the two cannot drift apart.
 */
const GAP = Object.freeze({
	/** From the letterhead's content down to the rule that closes it. */
	letterheadToRule: 16,
	/** From a section's closing rule down to the block that follows it. */
	afterSectionRule: 28,
	/** From the parties grid down to the rule that closes it. */
	partiesToRule: 18,
	/** From the item table down to the totals block. */
	tableToTotals: 18,
	/** From the totals block down to the notes section. */
	totalsToNotes: 20,
	/** From the notes section down to the payment details. */
	notesToPayment: 24,
	/** Between the payment terms' column and the symbol drawn beside it. */
	termsToSymbol: 18,
});

/**
 * The gap between the letterhead icon's box and the wordmark that starts past it, in points: the page's own `.letterhead-brand` gap of 0.9rem through the same CSS reference ratio that turns `--letterhead-mark` into this module's mark square.
 * The page holds that gap in rem rather than in points, so the two surfaces cannot share the literal and are pinned together by a test instead of derived from one another, exactly as {@link LETTERHEAD_MARK} is.
 */
const LETTERHEAD_ICON_GAP = 10.8;

/**
 * The letterhead mark's side, in points: the page's own `--letterhead-mark` of 3rem through the CSS reference ratio of 16 px to the rem and 0.75 pt to the px.
 * The page holds that square in rem rather than in points, so the two surfaces cannot share the literal and are pinned together by a test instead of derived from one another.
 */
const LETTERHEAD_MARK = 36;

/** The type scale, in points; every run of text names one of these. */
const SIZE = Object.freeze({
	brand: 19,
	tagline: 7.5,
	kind: 22,
	documentNumber: 10,
	status: 8,
	roleLabel: 7.5,
	partyName: 11,
	partyDetail: 8.5,
	dateLabel: 7.5,
	dateValue: 9.5,
	tableHeader: 7.5,
	tableCell: 9,
	tableNumber: 9,
	section: 7.5,
	note: 9,
	totalLabel: 9,
	totalValue: 9.5,
	totalDue: 11.5,
	paymentLabel: 7.5,
	paymentValue: 9,
	paymentMono: 8,
	footer: 7.5,
});

/**
 * The QR symbol's geometry, in points: what one module measures, and the quiet zone the standard requires on every side of it.
 *
 * A 2.5-point module makes the widest symbol the link layer can produce — a version-15 grid of 77 modules — 192.5 points square, so with its quiet zone the block is 212.5 points: inside the payment section's 504-point width, and short enough that the whole symbol is checked onto one page before any of it is drawn.
 */
export const QR_SYMBOL = Object.freeze({
	module: 2.5,
	quietModules: 4,
});

/**
 * The document's colors.
 * Each entry traces to a custom property in `invoice.css`, whose names mirror them, with one deliberate exception: `headerBg` is `app.css`'s `--surface-muted`, used here only to fill the item table's header band.
 * `.invoice-items th` never draws that band on screen; this renderer fills it, kept because it reads as intentional print craft.
 */
const PALETTE = Object.freeze({
	ink: hex("#10233f"),
	inkSoft: hex("#4a5a72"),
	muted: hex("#5b6472"),
	rule: hex("#dfe4ec"),
	ruleSoft: hex("#eceff4"),
	accent: hex("#1f5eff"),
	accentSurface: hex("#eef2ff"),
	zebra: hex("#fafbfd"),
	headerBg: hex("#f4f5f7"),
	/** `--inv-paper`, the document's own surface: it fills the symbol's light modules, so the whole grid is drawn rather than left to the paper showing through. */
	paper: hex("#ffffff"),
});

/** The status badge's ink/line/surface per tone, mirroring `invoice.css`'s status classes. */
const STATUS = Object.freeze({
	open: { ink: hex("#41506b"), line: hex("#c7cedb"), surface: hex("#eef1f6") },
	due: { ink: hex("#8a5300"), line: hex("#eccb8f"), surface: hex("#fdf3e2") },
	overdue: { ink: hex("#a3261e"), line: hex("#f0bab4"), surface: hex("#fdeceb") },
});

/**
 * A share string's id cannot be trusted to be a file name: the model allows `/`, `\`, dots and spaces inside an id, so this folds everything but `[A-Za-z0-9._-]` into single dashes, collapses runs of dashes and dots (so no `..` survives), trims the leading and trailing separators, and caps the length.
 * An id that reduces to nothing yields a bare `invoice.pdf`.
 */
export function invoiceFileName(invoice: Invoice): string {
	const stem = sanitizeFileName(invoice.id);
	return stem === "" ? "invoice.pdf" : `invoice-${stem}.pdf`;
}

function sanitizeFileName(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/\.{2,}/g, ".")
		.replace(/^[-._]+/, "")
		.replace(/[-._]+$/, "")
		.slice(0, FILE_STEM_MAX)
		.replace(/[-._]+$/, "");
}

/**
 * Fold a string into the WinAnsi repertoire a base-14 font can encode.
 *
 * Anything unencodable — an emoji, a CJK glyph, a control character — becomes `?`, so a hostile description cannot make `drawText` throw partway through an export.
 * A tab becomes four spaces.
 * Idempotent, so callers may sanitize a string more than once without harm.
 */
export function toPdfText(value: string): string {
	let out = "";
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		if (code === 0x09) {
			out += "    ";
		} else if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || CP1252_EXTRAS.has(code)) {
			out += char;
		} else {
			out += "?";
		}
	}
	return out;
}

/**
 * The characters in code point range 0x80–0x9F that code page 1252 — WinAnsi — actually maps.
 * Range 0xA0–0xFF is Latin-1 and encodes directly.
 */
const CP1252_EXTRAS: ReadonlySet<number> = new Set([
	0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
	0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
	0x0153, 0x017e, 0x0178,
]);

/**
 * Wrap `text` to `maxWidth`, breaking on spaces and hard-breaking any single word wider than the line.
 * The result is always at least one line; an empty string yields one empty line, so a blank notes row survives as a blank line rather than disappearing.
 * A break consumes the whitespace it lands on and a run of spaces between two words collapses to one, which is the shape of the text wrapped here: a name, a table cell, or a note is drawn on a surface that collapses those spaces too, so the wrap and the drawing agree about them.
 * A contact line is the other shape — the page preserves its spaces, so the drawing has them to keep — and {@link wrapContactText} wraps that one.
 */
export function wrapText(
	text: string,
	maxWidth: number,
	size: number,
	font: PdfFontRole,
	metrics: FontMetrics,
): string[] {
	const clean = toPdfText(text);
	if (clean === "") return [""];
	const width = (value: string): number => metrics.widthOfText(value, size, font);
	const lines: string[] = [];
	let current = "";
	for (const word of clean.split(/\s+/)) {
		if (word === "") continue;
		const candidate = current === "" ? word : `${current} ${word}`;
		if (width(candidate) <= maxWidth) {
			current = candidate;
			continue;
		}
		if (current !== "") lines.push(current);
		let rest = word;
		while (rest !== "") {
			// Grow `take` from one glyph so every measurement spans at most one line.
			// Scanning down from the whole word re-measures the remaining text on every break — O(n²) over a long unbroken word — while growing from one glyph bounds each break by what a single line can hold.
			// A glyph wider than the line still advances one character, so the loop always terminates, and a remainder that fits becomes `current` for the following word to join.
			let take = 0;
			while (take < rest.length && width(rest.slice(0, take + 1)) <= maxWidth) take += 1;
			if (take === rest.length) {
				current = rest;
				break;
			}
			if (take === 0) take = 1;
			lines.push(rest.slice(0, take));
			rest = rest.slice(take);
		}
	}
	if (current !== "" || lines.length === 0) lines.push(current);
	return lines;
}

/**
 * Wrap a contact line to `maxWidth`, breaking only at the spaces it carries and keeping every character of it.
 *
 * {@link wrapText} is the wrapper for text whose spaces a surface collapses anyway; this one is for a contact line, which the page draws with its spacing preserved (`.party-detail` in `invoice.css`), so a wrapper that collapsed a run of spaces or dropped the space a break lands on would draw a different value from the page's and from the one the model stores.
 * A run of spaces is broken at any of its own characters, so a line is filled with as much of it as fits and the remainder opens the next line; a token with no space in it is broken only when it cannot fit a line of its own, and then one glyph at a time, exactly as {@link wrapText} breaks an over-wide word.
 * Concatenating the returned lines yields the text they were wrapped from, which is what holds the contact line to the page's own characters.
 */
export function wrapContactText(
	text: string,
	maxWidth: number,
	size: number,
	font: PdfFontRole,
	metrics: FontMetrics,
): string[] {
	const clean = toPdfText(text);
	if (clean === "") return [""];
	const width = (value: string): number => metrics.widthOfText(value, size, font);
	const lines: string[] = [];
	let current = "";
	// One run of spaces or of everything else at a time, in the order the line spells them, so a break can fall at a space without a character of it going missing.
	for (const run of clean.match(/ +|[^ ]+/g) ?? []) {
		let rest = run;
		// A run of spaces breaks between any two of its characters, and a token wider than a whole line has to be broken somewhere; either way the line is filled with as much of the run as fits. A token that would fit a line of its own is moved to the next line whole instead, so a word is never split where it happened to land.
		const fillsInPlace = run.startsWith(" ") || width(run) > maxWidth;
		while (rest !== "") {
			if (width(current + rest) <= maxWidth) {
				current += rest;
				break;
			}
			if (!fillsInPlace && current !== "") {
				lines.push(current);
				current = "";
				continue;
			}
			// Grow `take` from one glyph so every measurement spans at most one line, as the over-wide word case in {@link wrapText} does.
			let take = 0;
			while (take < rest.length && width(current + rest.slice(0, take + 1)) <= maxWidth) take += 1;
			if (take === 0) {
				// Nothing of the run fits past what the line already carries, so the line is done; a glyph wider than the column itself is still drawn, as its own line, rather than dropped.
				if (current !== "") {
					lines.push(current);
					current = "";
					continue;
				}
				take = 1;
			}
			lines.push(current + rest.slice(0, take));
			current = "";
			rest = rest.slice(take);
		}
	}
	if (current !== "" || lines.length === 0) lines.push(current);
	return lines;
}

/**
 * Lay an invoice out into pages of drawing ops, with pagination resolved: the column header repeats on every page, the totals block stays whole, notes and payment terms flow rather than overflow, and no op leaves the page.
 * Pure — the caller supplies the measurement and, for an invoice that carries one, the already-rasterized icon — so the pagination can be asserted without embedding a font, rendering a byte, or owning a canvas.
 * A raster whose width or height is not a positive, finite number is refused here rather than divided into the icon box, so both this exported layout and {@link renderInvoicePdf} are held to the same geometric invariant.
 */
export function buildInvoicePages(view: InvoiceViewModel, metrics: FontMetrics, icon: IconRaster | null = null): readonly PdfPageLayout[] {
	const flow = new Flow(metrics);
	drawLetterhead(flow, view, icon === null ? null : requirePositiveRaster(icon));
	drawParties(flow, view);
	drawTableHeader(flow, view.labels);
	view.lines.forEach((line, index) => drawItemRow(flow, line, index, view.labels));
	drawTotals(flow, view);
	if (view.notes !== null) drawNotes(flow, view.notes, view.labels);
	drawPayment(flow, view);
	appendFooters(flow.pages, view.documentNumber, metrics);
	return flow.pages.map((ops) => Object.freeze({ ops: Object.freeze([...ops]) }));
}

/**
 * Build the PDF bytes for a validated invoice.
 * No clock and no network: the document is created with pdf-lib's automatic metadata stamping off, and every metadata field is written from the invoice itself, so an icon-less invoice always renders to the same bytes.
 * An invoice that carries an icon embeds the browser canvas encoder's own PNG bytes, so its bytes are reproducible for one rasterizer but not guaranteed identical across browsers or versions.
 * The one outside dependency is the icon rasterizer, and only an invoice that carries an icon reaches it: the default is the browser's own — `pdf/rasterize.ts`, imported on the first such export — and a caller with no canvas, the test suite included, substitutes its own.
 * The value it is handed is the view model's own prepared data URL, the same one the on-screen document loads, so the icon is armed once rather than rebuilt here.
 * The icon is rasterized before the document is created, so a rasterizer that fails leaves no half-written artifact behind: the export either produces the whole file or reports the error to its caller.
 */
export async function renderInvoicePdf(invoice: Invoice, today: string, iconRasterizer: IconRasterizer = browserIconRasterizer): Promise<Uint8Array> {
	const view = buildInvoiceViewModel(invoice, today);
	const icon = view.iconDataUrl === null ? null : await iconRasterizer.rasterize(view.iconDataUrl);
	const doc = await PDFDocument.create({ updateMetadata: false });
	const fonts = await embedFonts(doc);
	for (const layout of buildInvoicePages(view, metricsFor(fonts), icon)) {
		await drawOps(doc, doc.addPage([PAGE.width, PAGE.height]), layout.ops, fonts);
	}
	doc.setTitle(toPdfText(`Invoice ${view.documentNumber}`));
	doc.setAuthor(toPdfText(view.from.name));
	doc.setCreator(DOCUMENT_PRODUCER);
	doc.setProducer(DOCUMENT_PRODUCER);
	return doc.save();
}

/**
 * The metrics {@link renderInvoicePdf} measures its layout with: the widths of the faces it embeds.
 * The exported bytes are drawn from that layout, so a caller that has to assert the geometry those bytes carry measures with these rather than with a stand-in of its own.
 */
export async function exportFontMetrics(): Promise<FontMetrics> {
	const doc = await PDFDocument.create({ updateMetadata: false });
	return metricsFor(await embedFonts(doc));
}

/**
 * Hand PDF bytes to the browser as a download and release the object URL.
 * The file name is sanitized here, at the one place a name reaches the download attribute, so every caller — not only {@link invoiceFileName} — can hand the anchor nothing but a name folded to `[A-Za-z0-9._-]` with no path separator.
 */
export function downloadPdf(bytes: Uint8Array, fileName: string, downloader: PdfDownloader = browserDownloader): void {
	const blob = new Blob([new Uint8Array(bytes)], { type: PDF_MIME });
	const url = downloader.createObjectUrl(blob);
	try {
		downloader.save(url, sanitizeFileName(fileName));
	} finally {
		downloader.revokeObjectUrl(url);
	}
}

/** The invoice view's export seam: render the invoice and download it under a safe file name. */
export async function renderPdf(invoice: Invoice, today: string, downloader?: PdfDownloader): Promise<void> {
	const bytes = await renderInvoicePdf(invoice, today);
	downloadPdf(bytes, invoiceFileName(invoice), downloader);
}

/**
 * The default icon rasterizer: the browser-only module, loaded through a dynamic `import()` on the first export that carries an icon.
 * The dynamic form is what keeps `pdf/rasterize.js` — which needs a DOM and a canvas — out of the module graph a page loads until an icon actually has to be drawn; the only static import of it is the test suite's, which installs a stand-in document and canvas of its own.
 */
const browserIconRasterizer: IconRasterizer = {
	async rasterize(dataUrl: SvgDataUrl): Promise<IconRaster> {
		const { rasterizeSvgIcon } = await import("./rasterize.js");
		return rasterizeSvgIcon(dataUrl);
	},
};

const browserDownloader: PdfDownloader = {
	createObjectUrl: (blob) => URL.createObjectURL(blob),
	revokeObjectUrl: (url) => {
		setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
	},
	save: (url, fileName) => {
		const link = document.createElement("a");
		link.setAttribute("href", url);
		link.setAttribute("download", fileName);
		link.setAttribute("rel", "noopener");
		if (document.body !== null) document.body.append(link);
		link.click();
		link.remove();
	},
};

/** Convert a `#rrggbb` literal to the rgb() a pdf-lib call expects. */
function hex(value: string): PdfColor {
	const match = /^#([0-9a-f]{6})$/i.exec(value);
	if (match === null) {
		throw new Error(`pdf: ${value} is not a #rrggbb color`);
	}
	const parsed = Number.parseInt(match[1], 16);
	return rgb(((parsed >> 16) & 0xff) / 255, ((parsed >> 8) & 0xff) / 255, (parsed & 0xff) / 255);
}

function leading(size: number): number {
	return size * LEADING;
}

/** The baseline of a text run whose visual top sits `top` from the page's top edge. */
function baseline(top: number, size: number): number {
	return PAGE.height - top - size * BASELINE_ASCENT;
}

/** The `top` that vertically centers a text run of `size` inside a box of `height` starting at `top`. */
function centerTop(top: number, height: number, size: number): number {
	// A capital's visual middle sits half its ascent above the baseline, so the run is offset by half that ascent from the box's center.
	return top + height / 2 - (size * BASELINE_ASCENT) / 2;
}

interface FittedText {
	/** One or more lines carrying the whole value; wrapping never drops a glyph. */
	readonly lines: readonly string[];
	readonly size: number;
}

/**
 * One value a payer copies out, as it is drawn: the whole value in one run, the size that run is set at, and the horizontal scale it is held to the width it was measured against by.
 *
 * A copy value is never split across lines, because the run is what a PDF hands back when the text is selected: a value broken at the margin reaches a wallet's field with a line break inside it.
 * {@link CopyRun.xScale} is how a value wider than the section is held to one line — 1 when it measures inside the width as it is, and otherwise the fraction of its natural width the width it was given leaves.
 */
interface CopyRun {
	readonly text: string;
	readonly size: number;
	readonly xScale: number;
}

/**
 * Shrink `text` toward {@link MIN_FIT_SIZE} to fit `maxWidth`, then wrap — never elide — it, so every glyph survives.
 * A money or quantity figure the on-screen view shows in full must not be re-drawn here as a different, truncated number: where a tail ellipsis would drop low-order digits and the asset suffix, the value instead flows onto an extra line.
 */
function fitText(
	text: string,
	maxWidth: number,
	size: number,
	font: PdfFontRole,
	metrics: FontMetrics,
): FittedText {
	const clean = toPdfText(text);
	let fitted = size;
	while (fitted > MIN_FIT_SIZE && metrics.widthOfText(clean, fitted, font) > maxWidth) {
		fitted -= 0.5;
	}
	return { lines: wrapText(clean, maxWidth, fitted, font, metrics), size: fitted };
}

/** Draw a right-aligned fitted value, stacking its wrapped lines from `top`. */
function drawRightAligned(
	flow: Flow,
	right: number,
	top: number,
	value: FittedText,
	font: PdfFontRole,
	color: PdfColor,
): void {
	let y = top;
	for (const line of value.lines) {
		flow.textRight(right, y, line, value.size, font, color);
		y += leading(value.size);
	}
}

/** The glyph a shortened value ends in, so an elided identifier reads as elided rather than as the value itself. */
const ELLIPSIS = "…";

/**
 * Shorten `text` to `maxWidth`, ending in {@link ELLIPSIS} when anything was dropped.
 * Where {@link fitText} wraps a money figure so no digit is lost, an identifier has no digits worth keeping, so it is measured against its box and elided rather than allowed to overrun it.
 */
function elideText(
	text: string,
	maxWidth: number,
	size: number,
	font: PdfFontRole,
	metrics: FontMetrics,
): string {
	const clean = toPdfText(text);
	if (metrics.widthOfText(clean, size, font) <= maxWidth) return clean;
	const glyphs = Array.from(clean);
	while (glyphs.length > 0) {
		glyphs.pop();
		const candidate = `${glyphs.join("")}${ELLIPSIS}`;
		if (metrics.widthOfText(candidate, size, font) <= maxWidth) return candidate;
	}
	return "";
}

/**
 * The vertical cursor a block draws against.
 * `top` is a distance from the page's top edge; each draw method converts to PDF coordinates at the edge.
 * New pages start at {@link CONTENT_TOP}, and every block that can fall mid-page checks {@link Flow.fits} — or calls {@link Flow.ensure} — before it draws, so a block that does not fit is started on a fresh page rather than split across a break.
 * The fit checks alone cannot contain a block taller than a whole page: {@link Flow.ensure} moves a block that does not fit onto a fresh page, and a fresh page is no roomier, so the part no page can hold would be drawn past the floor.
 * Every draw is therefore refused past {@link FLOOR_TOP} — a text line or a rule below the floor is dropped and a fill is clamped to what fits — so an over-tall block is clamped to the content floor rather than drawn past it, whatever a future cap or asset family admits.
 * The three blocks that draw the head of a page — the letterhead, the parties and the column header — carry no fit check because they are drawn only at the top of a page, the layout's first or one {@link Flow.newPage} has just reset to {@link CONTENT_TOP}; the floor refusal bounds them too.
 */
class Flow {
	readonly pages: DrawOp[][] = [[]];
	top: number = CONTENT_TOP;
	private ops: DrawOp[] = this.pages[0];

	constructor(readonly metrics: FontMetrics) {}

	width(text: string, size: number, font: PdfFontRole): number {
		return this.metrics.widthOfText(toPdfText(text), size, font);
	}

	advance(height: number): void {
		this.top += height;
	}

	fits(height: number): boolean {
		return this.top + height <= FLOOR_TOP;
	}

	/**
	 * True when a draw reaching `depth` below `top` stays at or above the page's content floor.
	 * This is the last line of containment for a block taller than a whole page: the fit checks start such a block on a fresh page, and this keeps the part no page can hold out of the footer strip.
	 */
	private clearsFloor(top: number, depth: number): boolean {
		return top + depth <= FLOOR_TOP;
	}

	/** Start a fresh page; `before` draws any continuation header directly on it. */
	newPage(before?: () => void): void {
		this.ops = [];
		this.pages.push(this.ops);
		this.top = CONTENT_TOP;
		if (before !== undefined) before();
	}

	ensure(height: number, before?: () => void): void {
		if (!this.fits(height)) this.newPage(before);
	}

	/** Draw one run of text at `top`; `xScale` is the horizontal scale it is drawn at, 1 for a run drawn as it measures. */
	text(x: number, top: number, value: string, size: number, font: PdfFontRole, color: PdfColor, xScale = 1): void {
		if (!this.clearsFloor(top, size * BASELINE_ASCENT)) return;
		this.ops.push({ kind: "text", x, y: baseline(top, size), text: toPdfText(value), size, font, color, xScale });
	}

	textRight(right: number, top: number, value: string, size: number, font: PdfFontRole, color: PdfColor): void {
		const text = toPdfText(value);
		this.text(right - this.metrics.widthOfText(text, size, font), top, text, size, font, color);
	}

	rule(top: number, x1: number, x2: number, thickness: number, color: PdfColor): void {
		if (!this.clearsFloor(top, 0)) return;
		const y = PAGE.height - top;
		this.ops.push({ kind: "rule", x1, y1: y, x2, y2: y, thickness, color });
	}

	fill(
		x: number,
		top: number,
		width: number,
		height: number,
		color: PdfColor,
		border?: { readonly color: PdfColor; readonly width: number },
	): void {
		const bounded = Math.min(height, FLOOR_TOP - top);
		if (bounded <= 0) return;
		this.ops.push({
			kind: "fill",
			x,
			y: PAGE.height - top - bounded,
			width,
			height: bounded,
			color,
			...(border === undefined ? {} : { border }),
		});
	}

	/** Draw an embedded image in the box `width` by `height` at `top`; a box that does not clear the floor is dropped rather than clamped, so the image is never squeezed out of its own proportions. */
	image(x: number, top: number, width: number, height: number, png: Uint8Array): void {
		if (!this.clearsFloor(top, height)) return;
		this.ops.push({ kind: "image", x, y: PAGE.height - top - height, width, height, png });
	}
}

/** One run a contact line is drawn as: its text, and the horizontal scale it is held to its column by. */
interface PartyRun {
	readonly text: string;
	readonly xScale: number;
}

interface PartyLine {
	readonly text: string;
	readonly size: number;
	readonly font: PdfFontRole;
	readonly color: PdfColor;
	/** True for a contact line, which is drawn as fitted runs held to the column — one run where the line fits or compresses no further than {@link MIN_CONTACT_RUN_SCALE}, and its wrapped lines below that floor; false for a name or a date, which wraps at the column's edge as the on-screen block wraps it. */
	readonly contact: boolean;
}

interface PartyBlock {
	readonly label: string;
	readonly lines: readonly PartyLine[];
}

/**
 * The letterhead: the payee's own icon when the invoice carries one and the default accent mark when it does not, the wordmark and tagline, the document kind and number, and the status badge, closed by the heavy rule.
 *
 * The icon takes the accent mark's place at the letterhead's left edge and the wordmark starts past its box, mirroring the on-screen letterhead's own order: a supplied icon replaces the default mark rather than standing beside it, and the wordmark and tagline are drawn either way.
 * Its box is {@link LETTERHEAD_MARK}, the square the on-screen letterhead gives it through `--letterhead-mark`, so the icon letterboxes inside that square when its own aspect does not fill it and the wordmark starts past the same reserve on both surfaces.
 * An invoice with no icon draws exactly what it drew before: no box is reserved, and the accent mark and wordmark start at the content edge.
 */
function drawLetterhead(flow: Flow, view: InvoiceViewModel, icon: IconRaster | null): void {
	const top = flow.top;
	const brandHeight = leading(SIZE.brand) + leading(SIZE.tagline);
	const metaHeight = leading(SIZE.kind) + leading(SIZE.documentNumber) + 3 + 16;

	// The wordmark's left edge sits 18 points past the accent mark's own edge — the mark's 11 points and the 7-point gap to the wordmark — and past the icon's mark-sized square instead when the icon takes the mark's place.
	let markLeft = CONTENT_LEFT + 18;
	if (icon === null) {
		flow.fill(CONTENT_LEFT, top + 1, 11, 11, PALETTE.accent);
	} else {
		// The icon reserves the whole mark-sized square whether or not its aspect fills it, exactly as the on-screen `object-fit: contain` box does, so the wordmark starts at one offset on both surfaces and the page stays a faithful preview of the export.
		const box = fitIconBox(icon, LETTERHEAD_MARK);
		flow.image(
			CONTENT_LEFT + (LETTERHEAD_MARK - box.width) / 2,
			top + (LETTERHEAD_MARK - box.height) / 2,
			box.width,
			box.height,
			icon.bytes,
		);
		markLeft = CONTENT_LEFT + LETTERHEAD_MARK + LETTERHEAD_ICON_GAP;
	}

	flow.text(markLeft, top, view.labels.brand, SIZE.brand, "sansBold", PALETTE.ink);
	flow.text(
		markLeft,
		top + leading(SIZE.brand),
		view.labels.tagline.toUpperCase(),
		SIZE.tagline,
		"sansBold",
		PALETTE.muted,
	);

	flow.textRight(CONTENT_RIGHT, top, view.labels.kind.toUpperCase(), SIZE.kind, "sansBold", PALETTE.ink);
	const documentNumber = elideText(view.documentNumber, CONTENT_W, SIZE.documentNumber, "sans", flow.metrics);
	flow.textRight(
		CONTENT_RIGHT,
		top + leading(SIZE.kind),
		documentNumber,
		SIZE.documentNumber,
		"sans",
		PALETTE.muted,
	);

	const status = STATUS[view.status.tone];
	const label = view.status.label.toUpperCase();
	const badgeWidth = flow.width(label, SIZE.status, "sansBold") + 18;
	const badgeTop = top + leading(SIZE.kind) + leading(SIZE.documentNumber) + 3;
	flow.fill(CONTENT_RIGHT - badgeWidth, badgeTop, badgeWidth, 16, status.surface, {
		color: status.line,
		width: 0.8,
	});
	flow.textRight(CONTENT_RIGHT - 9, centerTop(badgeTop, 16, SIZE.status), label, SIZE.status, "sansBold", status.ink);

	flow.advance(Math.max(LETTERHEAD_MARK, brandHeight, metaHeight) + GAP.letterheadToRule);
	flow.rule(flow.top, CONTENT_LEFT, CONTENT_RIGHT, 2, PALETTE.ink);
	flow.advance(GAP.afterSectionRule);
}

/**
 * The box the letterhead icon is drawn in: the raster's own aspect ratio fitted inside a `side`-point square.
 * The square is the mark-sized reserve both surfaces give the icon, so the fitted box letterboxes inside it rather than sizing the space the wordmark starts after.
 * The raster carries the icon's own pixels, so this box is the only size the document imposes on it, and fitting rather than stretching keeps a non-square icon's proportions — what the on-screen `object-fit: contain` does for the same image.
 */
function fitIconBox(icon: IconRaster, side: number): { readonly width: number; readonly height: number } {
	const scale = Math.min(side / icon.width, side / icon.height);
	return { width: icon.width * scale, height: icon.height * scale };
}

/** A party's contact lines as the document's own line records, one record per line the party's contact info carries, and none for a party that carries none. */
function partyDetailLines(contact: readonly string[] | undefined): readonly PartyLine[] {
	return contact === undefined ? [] : contact.map((line) => ({ text: line, size: SIZE.partyDetail, font: "sans", color: PALETTE.inkSoft, contact: true }));
}

/**
 * The horizontal scale that holds one run to `maxWidth`: 1 when it measures inside it, and otherwise the fraction of its natural width the width leaves.
 */
function fitRunScale(text: string, maxWidth: number, size: number, font: PdfFontRole, metrics: FontMetrics): number {
	const measured = metrics.widthOfText(toPdfText(text), size, font);
	return measured <= maxWidth ? 1 : maxWidth / measured;
}

/**
 * The smallest horizontal scale a contact line is drawn at.
 *
 * A contact line is drawn as one run held to its column by a horizontal scale, which is what a payer selecting the document needs: the value with no break inside it.
 * A line the model accepts can still be far wider than the column — a legacy email spelling is one line of up to 320 characters — and compressing such a line to fit would draw it at a small fraction of its width, too narrow to read.
 * Below this floor the line is wrapped instead, each wrapped line drawn at the size the column holds, so a long value stays legible rather than being squeezed.
 * Exported with the scale it bounds, so a test can assert no contact run is drawn below it.
 */
export const MIN_CONTACT_RUN_SCALE = 0.5;

/**
 * A contact line as the runs it is drawn in, held inside `maxWidth`.
 *
 * A line that measures inside the column, or that needs no more than {@link MIN_CONTACT_RUN_SCALE} compression, is one run held to the width by {@link fitRunScale}.
 * A line wider than that floor allows is wrapped at the column width and each wrapped line drawn as its own run, so the value stays legible rather than squeezed to a fraction of its width.
 * Both paths draw the line as the payee spelled it: the single run is fitted without altering a character, and the wrapped runs come from {@link wrapContactText}, which keeps every space of the line rather than collapsing a run or dropping the one a break lands on.
 */
function contactRuns(text: string, maxWidth: number, size: number, font: PdfFontRole, metrics: FontMetrics): readonly PartyRun[] {
	const measured = metrics.widthOfText(toPdfText(text), size, font);
	if (measured <= maxWidth) return [{ text, xScale: 1 }];
	const scale = maxWidth / measured;
	if (scale >= MIN_CONTACT_RUN_SCALE) return [{ text, xScale: scale }];
	return wrapContactText(text, maxWidth, size, font, metrics).map((line) => ({ text: line, xScale: fitRunScale(line, maxWidth, size, font, metrics) }));
}

function drawParties(flow: Flow, view: InvoiceViewModel): void {
	const blocks: PartyBlock[] = [
		{
			label: view.from.role,
			lines: [
				{ text: view.from.name, size: SIZE.partyName, font: "serifBold", color: PALETTE.ink, contact: false },
				...partyDetailLines(view.from.email),
			],
		},
	];
	if (view.billTo !== null) {
		blocks.push({
			label: view.billTo.role,
			lines: [
				{ text: view.billTo.name, size: SIZE.partyName, font: "serifBold", color: PALETTE.ink, contact: false },
				...partyDetailLines(view.billTo.email),
			],
		});
	}
	blocks.push({
		label: view.labels.dates,
		lines: view.dates.flatMap((date) => [
			{ text: date.label.toUpperCase(), size: SIZE.dateLabel, font: "sansBold", color: PALETTE.muted, contact: false },
			{ text: date.value, size: SIZE.dateValue, font: "sans", color: PALETTE.ink, contact: false },
		]),
	});

	const gap = 20;
	const columnWidth = (CONTENT_W - gap * (blocks.length - 1)) / blocks.length;
	const top = flow.top;
	let rowHeight = 0;
	blocks.forEach((block, index) => {
		const x = CONTENT_LEFT + index * (columnWidth + gap);
		let y = top;
		flow.text(x, y, block.label.toUpperCase(), SIZE.roleLabel, "sansBold", PALETTE.muted);
		y += leading(SIZE.roleLabel) + 3;
		for (const line of block.lines) {
			const runs: readonly PartyRun[] = line.contact
				? contactRuns(line.text, columnWidth - 2, line.size, line.font, flow.metrics)
				: wrapText(line.text, columnWidth - 2, line.size, line.font, flow.metrics).map((text) => ({ text, xScale: 1 }));
			for (const run of runs) {
				flow.text(x, y, run.text, line.size, line.font, line.color, run.xScale);
				y += leading(line.size);
			}
			y += 1;
		}
		rowHeight = Math.max(rowHeight, y - top);
	});
	flow.advance(rowHeight + GAP.partiesToRule);
	flow.rule(flow.top, CONTENT_LEFT, CONTENT_RIGHT, 1, PALETTE.rule);
	flow.advance(GAP.afterSectionRule);
}

function drawTableHeader(flow: Flow, labels: InvoiceLabels): void {
	const top = flow.top;
	flow.fill(CONTENT_LEFT, top, CONTENT_W, TABLE_HEADER_H, PALETTE.headerBg);
	const textTop = centerTop(top, TABLE_HEADER_H, SIZE.tableHeader);
	flow.text(CONTENT_LEFT + CELL_PAD, textTop, labels.description.toUpperCase(), SIZE.tableHeader, "sansBold", PALETTE.muted);
	flow.textRight(QTY_RIGHT, textTop, labels.quantity.toUpperCase(), SIZE.tableHeader, "sansBold", PALETTE.muted);
	flow.textRight(PRICE_RIGHT, textTop, labels.unitPrice.toUpperCase(), SIZE.tableHeader, "sansBold", PALETTE.muted);
	flow.textRight(AMOUNT_RIGHT, textTop, labels.amount.toUpperCase(), SIZE.tableHeader, "sansBold", PALETTE.muted);
	flow.rule(top + TABLE_HEADER_H, CONTENT_LEFT, CONTENT_RIGHT, 1.2, PALETTE.ink);
	flow.advance(TABLE_HEADER_H);
}

function drawItemRow(flow: Flow, line: InvoiceLineView, index: number, labels: InvoiceLabels): void {
	const description = wrapText(line.description, DESC_W - CELL_PAD, SIZE.tableCell, "sans", flow.metrics);
	const qty = fitText(line.quantity, QTY_W - 8, SIZE.tableNumber, "sans", flow.metrics);
	const price = fitText(line.unitPrice, PRICE_W - 8, SIZE.tableNumber, "sans", flow.metrics);
	const amount = fitText(line.amount, AMOUNT_W - 4, SIZE.tableNumber, "sansBold", flow.metrics);
	const rowLines = Math.max(description.length, qty.lines.length, price.lines.length, amount.lines.length);
	const rowHeight = Math.max(TABLE_ROW_MIN, rowLines * leading(SIZE.tableCell) + 10);
	// The row does not fit, so the break is taken: the column header its callback draws on the new page sits above the row, and reserving room for both would bounce a row that fits by up to TABLE_HEADER_H.
	if (!flow.fits(rowHeight)) flow.newPage(() => drawTableHeader(flow, labels));
	const top = flow.top;
	if (index % 2 === 1) flow.fill(CONTENT_LEFT, top, CONTENT_W, rowHeight, PALETTE.zebra);

	const textTop = top + 5;
	let y = textTop;
	for (const entry of description) {
		flow.text(CONTENT_LEFT + CELL_PAD, y, entry, SIZE.tableCell, "sans", PALETTE.ink);
		y += leading(SIZE.tableCell);
	}
	drawRightAligned(flow, QTY_RIGHT, textTop, qty, "sans", PALETTE.ink);
	drawRightAligned(flow, PRICE_RIGHT, textTop, price, "sans", PALETTE.ink);
	drawRightAligned(flow, AMOUNT_RIGHT, textTop, amount, "sansBold", PALETTE.ink);

	flow.rule(top + rowHeight, CONTENT_LEFT, CONTENT_RIGHT, 0.5, PALETTE.ruleSoft);
	flow.advance(rowHeight);
}

function drawTotals(flow: Flow, view: InvoiceViewModel): void {
	const left = CONTENT_RIGHT - TOTALS_W;
	const valueWidth = TOTALS_W - 24;
	const rows: { readonly label: string; readonly value: FittedText }[] = [{ label: view.labels.subtotal, value: fitText(view.subtotal, valueWidth, SIZE.totalValue, "sans", flow.metrics) }];
	if (view.tax !== null) {
		rows.push({ label: view.tax.label, value: fitText(view.tax.value, valueWidth, SIZE.totalValue, "sans", flow.metrics) });
	}
	const due = fitText(view.total, valueWidth, SIZE.totalDue, "sansBold", flow.metrics);
	const rowHeights = rows.map((row) => Math.max(TOTALS_ROW_H, row.value.lines.length * leading(row.value.size) + 4));
	const dueBoxHeight = Math.max(DUE_H, due.lines.length * leading(due.size) + 6);
	const height = rowHeights.reduce((sum, row) => sum + row, 0) + dueBoxHeight;
	flow.advance(GAP.tableToTotals);
	flow.ensure(height + 8);
	const top = flow.top;
	let y = top;
	rows.forEach((row, index) => {
		flow.text(left + 12, y, row.label, SIZE.totalLabel, "sans", PALETTE.muted);
		drawRightAligned(flow, CONTENT_RIGHT - 12, y, row.value, "sans", PALETTE.ink);
		y += rowHeights[index];
	});
	const dueTop = y;
	flow.fill(left, dueTop, TOTALS_W, dueBoxHeight, PALETTE.accentSurface);
	flow.rule(dueTop, left, CONTENT_RIGHT, 1.5, PALETTE.accent);
	flow.text(
		left + 12,
		centerTop(dueTop, dueBoxHeight, SIZE.totalLabel),
		view.labels.totalDue,
		SIZE.totalLabel,
		"sansBold",
		PALETTE.ink,
	);
	// A lone line keeps today's exact centering; a wrapped value centers its whole block in the box.
	const dueValueTop = due.lines.length === 1
		? centerTop(dueTop, dueBoxHeight, due.size)
		: dueTop + (dueBoxHeight - due.lines.length * leading(due.size)) / 2;
	drawRightAligned(flow, CONTENT_RIGHT - 12, dueValueTop, due, "sansBold", PALETTE.accent);
	flow.advance(height + 6);
}

/** From the notes section's rule down to its title's line top. */
const NOTES_RULE_TO_TITLE = 14;
/** The notes section's header: from the rule that opens it down to the first note's line top — the drop to the title, the title's own leading, and the gap below it. */
const NOTES_HEADER_H = NOTES_RULE_TO_TITLE + leading(SIZE.section) + 6;

function drawNotes(flow: Flow, notes: readonly string[], labels: InvoiceLabels): void {
	const lines = notes.flatMap((line) => wrapText(line, CONTENT_W, SIZE.note, "serif", flow.metrics));
	flow.advance(GAP.totalsToNotes);
	flow.ensure(NOTES_HEADER_H + leading(SIZE.note) * 2);
	flow.rule(flow.top, CONTENT_LEFT, CONTENT_RIGHT, 0.8, PALETTE.rule);
	flow.text(CONTENT_LEFT, flow.top + NOTES_RULE_TO_TITLE, labels.notesTitle.toUpperCase(), SIZE.section, "sansBold", PALETTE.muted);
	flow.advance(NOTES_HEADER_H);
	for (const line of lines) {
		flow.ensure(leading(SIZE.note));
		flow.text(CONTENT_LEFT, flow.top, line, SIZE.note, "serif", PALETTE.inkSoft);
		flow.advance(leading(SIZE.note));
	}
}

/** From the payment section's rule down to its title's line top. */
const PAYMENT_RULE_TO_TITLE = 16;
/** The payment section's header: from the rule that opens it down to the block its terms and symbol start at — the drop to the title, the title's own leading, and the gap below it. */
const PAYMENT_HEADER_H = PAYMENT_RULE_TO_TITLE + leading(SIZE.section) + 8;

/**
 * The gap between one copied value's band and the next.
 * The gap separates a band from the one before it, so the block reserves no blank strip below the last of them.
 */
const COPY_BAND_GAP = 8;

/**
 * The smallest size a copied payment value is set at.
 *
 * A value a payer copies is drawn as one text run, so that the run a PDF hands back carries no break inside it, and a value wider than the line is held there by scaling that run horizontally rather than by shrinking its glyphs: below this size the text stops being readable in print, while a run compressed to part of its natural width is still the value, every character in order, to whoever copies it.
 * Exported with the size it bounds, so a test can assert that no copied value is set below the floor to keep it on one line.
 */
export const PAYMENT_VALUE_MIN_SIZE = 6;

/** One term the terms' own column holds: its label, and the line or lines of its value drawn beside that label. */
interface PaymentRow {
	readonly label: string;
	readonly font: PdfFontRole;
	readonly size: number;
	readonly lines: readonly string[];
	/** The horizontal scale the value is drawn at: 1 for every term that measures inside the column, since only a single-run copied value is ever scaled. */
	readonly xScale: number;
	readonly height: number;
}

/** One copy value the terms' own column cannot hold as it stands: its label, drawn on a line of its own above the value, and the single run the value is drawn as across the section's whole content width. */
interface CopyBand {
	readonly label: string;
	readonly run: CopyRun;
	readonly height: number;
}

/**
 * Draw the payment details: the terms that state what is owed beside the symbol of the URI those terms spell, and the values a payer copies out — the amount, the payee address, and the payment link — each drawn as a single unbroken monospace run.
 *
 * A copied value has to survive the copy whole: a value broken at the margin is handed back with a line break inside it, which is not the address or the URI a wallet's field reads.
 * So each copy value is drawn as exactly one run — never wrapped, never elided — set at the largest size from {@link SIZE.paymentMono} down to {@link PAYMENT_VALUE_MIN_SIZE} that holds it as it stands and held to the line by {@link fitCopyValue}'s horizontal scale when even that floor is too narrow.
 * It is fitted first to the width the terms' own column leaves beside its label, because that column's rows sit inside the symbol's block and cost the section no height of their own; only a value that column cannot hold as it stands takes a line of its own across the whole content width below the block, which is what the longest address this app accepts and the link carrying it need, the terms' column being the section's width less the symbol beside it — and that line is the wider of the two, so it is where the widest legal values are compressed least.
 * The terms' block and the symbol are checked onto one page together before either is drawn, so a break can never separate the symbol from the link it encodes.
 */
function drawPayment(flow: Flow, view: InvoiceViewModel): void {
	const symbolSide = qrBlockSize(view.paymentQr);
	const columnWidth = CONTENT_W - symbolSide - GAP.termsToSymbol;
	const besideWidth = columnWidth - PAYMENT_LABEL_W;
	const rows: PaymentRow[] = [];
	const bands: CopyBand[] = [];
	for (const term of view.payment) {
		if (term.verbatim !== true) {
			const lines = wrapText(term.value, besideWidth, SIZE.paymentValue, "sans", flow.metrics);
			rows.push({ label: term.label, font: "sans", size: SIZE.paymentValue, lines, xScale: 1, height: Math.max(leading(SIZE.paymentLabel), lines.length * leading(SIZE.paymentValue)) });
			continue;
		}
		const beside = fitCopyValue(term.value, besideWidth, flow.metrics);
		if (beside.xScale === 1) {
			rows.push({ label: term.label, font: "mono", size: beside.size, lines: [beside.text], xScale: 1, height: Math.max(leading(SIZE.paymentLabel), leading(beside.size)) });
			continue;
		}
		const wide = fitCopyValue(term.value, CONTENT_W, flow.metrics);
		bands.push({ label: term.label, run: wide, height: leading(SIZE.paymentLabel) + leading(wide.size) });
	}
	const blockHeight = Math.max(symbolSide, rows.reduce((total, entry) => total + entry.height + 6, 0));
	const bandHeight = bands.reduce((total, entry, index) => total + entry.height + (index === 0 ? 0 : COPY_BAND_GAP), 0);

	flow.advance(GAP.notesToPayment);
	flow.ensure(PAYMENT_HEADER_H + blockHeight + bandHeight);
	flow.rule(flow.top, CONTENT_LEFT, CONTENT_RIGHT, 2, PALETTE.ink);
	flow.text(CONTENT_LEFT, flow.top + PAYMENT_RULE_TO_TITLE, view.labels.paymentTitle.toUpperCase(), SIZE.section, "sansBold", PALETTE.muted);
	flow.advance(PAYMENT_HEADER_H);

	const blockTop = flow.top;
	let y = blockTop;
	for (const entry of rows) {
		flow.text(CONTENT_LEFT, y, entry.label.toUpperCase(), SIZE.paymentLabel, "sansBold", PALETTE.muted);
		let lineTop = y;
		for (const line of entry.lines) {
			flow.text(CONTENT_LEFT + PAYMENT_LABEL_W, lineTop, line, entry.size, entry.font, PALETTE.ink, entry.xScale);
			lineTop += leading(entry.size);
		}
		y += entry.height + 6;
	}
	drawQrSymbol(flow, view.paymentQr, CONTENT_RIGHT - symbolSide, blockTop);
	flow.advance(blockHeight);

	for (const [index, band] of bands.entries()) {
		if (index > 0) flow.advance(COPY_BAND_GAP);
		flow.text(CONTENT_LEFT, flow.top, band.label.toUpperCase(), SIZE.paymentLabel, "sansBold", PALETTE.muted);
		flow.advance(leading(SIZE.paymentLabel));
		flow.text(CONTENT_LEFT, flow.top, band.run.text, band.run.size, "mono", PALETTE.ink, band.run.xScale);
		flow.advance(leading(band.run.size));
	}
}

/**
 * `text` as the one run it is drawn in: the whole value, the largest size from {@link SIZE.paymentMono} down to {@link PAYMENT_VALUE_MIN_SIZE} that measures inside `maxWidth` as it stands, and — for a value no line at that floor holds — the horizontal scale that fits it to `maxWidth`.
 *
 * One run is what a copy value needs: the run is the text a PDF hands back when the value is selected, so a value broken at the margin reaches a wallet's field with a line break inside it, and the section's widest legal values — a 311-character mainnet unified address, and the 404-byte `zcash:` link carrying it — measure far past the section's width at any size this floor allows.
 * Such a value is compressed rather than broken: the glyphs keep the size the layout chose, which is what a reader of the document needs, and the run's advance is scaled to the width it was given, which is what a copy of it needs.
 */
function fitCopyValue(text: string, maxWidth: number, metrics: FontMetrics): CopyRun {
	const clean = toPdfText(text);
	let size = SIZE.paymentMono;
	while (size > PAYMENT_VALUE_MIN_SIZE && metrics.widthOfText(clean, size, "mono") > maxWidth) {
		size -= 0.5;
	}
	const measured = metrics.widthOfText(clean, size, "mono");
	return { text: clean, size, xScale: measured <= maxWidth ? 1 : maxWidth / measured };
}

/** The block the layout declares for a symbol, in points: its modules at {@link QR_SYMBOL}'s size plus that quiet zone on both sides. */
function qrBlockSize(matrix: QrMatrix): number {
	return matrix.size * QR_SYMBOL.module + QR_SYMBOL.quietModules * QR_SYMBOL.module * 2;
}

/**
 * Draw a symbol's modules at `left`/`top`, offset by the quiet zone the block size already accounts for.
 * Every module is drawn — dark ones in ink, light ones in the document's paper — so the symbol carries its own contrast rather than leaning on what is beneath it, and a scanner reads the same grid every renderer draws.
 */
function drawQrSymbol(flow: Flow, matrix: QrMatrix, left: number, top: number): void {
	const quiet = QR_SYMBOL.quietModules * QR_SYMBOL.module;
	matrix.modules.forEach((row, rowIndex) => {
		row.forEach((dark, columnIndex) => {
			flow.fill(
				left + quiet + columnIndex * QR_SYMBOL.module,
				top + quiet + rowIndex * QR_SYMBOL.module,
				QR_SYMBOL.module,
				QR_SYMBOL.module,
				dark ? PALETTE.ink : PALETTE.paper,
			);
		});
	});
}

function appendFooters(pages: DrawOp[][], documentNumber: string, metrics: FontMetrics): void {
	const total = pages.length;
	// The page numbering right-aligns on the same line, so the id is bounded to what the widest label leaves of the footer's column rather than to the whole of it.
	const numberBox = CONTENT_W - metrics.widthOfText(`Page ${total} of ${total}`, SIZE.footer, "sans") - FOOTER_GAP;
	const number = elideText(documentNumber, numberBox, SIZE.footer, "sans", metrics);
	pages.forEach((ops, index) => {
		ops.push({
			kind: "rule",
			x1: CONTENT_LEFT,
			y1: PAGE.footerRule,
			x2: CONTENT_RIGHT,
			y2: PAGE.footerRule,
			thickness: 0.6,
			color: PALETTE.rule,
		});
		ops.push({
			kind: "text",
			x: CONTENT_LEFT,
			y: PAGE.footerBaseline,
			text: number,
			size: SIZE.footer,
			font: "sans",
			color: PALETTE.muted,
			xScale: 1,
		});
		const label = `Page ${index + 1} of ${total}`;
		ops.push({
			kind: "text",
			x: CONTENT_RIGHT - metrics.widthOfText(label, SIZE.footer, "sans"),
			y: PAGE.footerBaseline,
			text: label,
			size: SIZE.footer,
			font: "sans",
			color: PALETTE.muted,
			xScale: 1,
		});
	});
}

const FONT_FACES: Readonly<Record<PdfFontRole, string>> = Object.freeze({
	sans: StandardFonts.Helvetica,
	sansBold: StandardFonts.HelveticaBold,
	mono: StandardFonts.Courier,
	serif: StandardFonts.TimesRoman,
	serifBold: StandardFonts.TimesRomanBold,
});

async function embedFonts(doc: PDFDocument): Promise<Record<PdfFontRole, PDFFont>> {
	const [sans, sansBold, mono, serif, serifBold] = await Promise.all([
		doc.embedFont(FONT_FACES.sans),
		doc.embedFont(FONT_FACES.sansBold),
		doc.embedFont(FONT_FACES.mono),
		doc.embedFont(FONT_FACES.serif),
		doc.embedFont(FONT_FACES.serifBold),
	]);
	return { sans, sansBold, mono, serif, serifBold };
}

function metricsFor(fonts: Record<PdfFontRole, PDFFont>): FontMetrics {
	return { widthOfText: (text, size, font) => fonts[font].widthOfTextAtSize(text, size) };
}

/**
 * Draw one page's ops onto a pdf-lib page.
 * Asynchronous because an image op is embedded as it is drawn — `embedPng` hands back the image's promise — and an image op exists only where the layout placed one, so a document with no icon awaits nothing new.
 */
async function drawOps(doc: PDFDocument, page: PDFPage, ops: readonly DrawOp[], fonts: Record<PdfFontRole, PDFFont>): Promise<void> {
	for (const op of ops) {
		switch (op.kind) {
			case "text":
				if (op.xScale === 1) {
					page.drawText(op.text, { x: op.x, y: op.y, size: op.size, font: fonts[op.font], color: op.color });
					break;
				}
				drawScaledRun(page, op, fonts[op.font]);
				break;
			case "rule":
				page.drawLine({
					start: { x: op.x1, y: op.y1 },
					end: { x: op.x2, y: op.y2 },
					thickness: op.thickness,
					color: op.color,
				});
				break;
			case "fill":
				page.drawRectangle({
					x: op.x,
					y: op.y,
					width: op.width,
					height: op.height,
					color: op.color,
					...(op.border === undefined ? {} : { borderColor: op.border.color, borderWidth: op.border.width }),
				});
				break;
			case "image": {
				const image = await doc.embedPng(op.png);
				page.drawImage(image, { x: op.x, y: op.y, width: op.width, height: op.height });
				break;
			}
		}
	}
}

/**
 * Draw one text run whose advance is scaled horizontally, which is how a value that must stay a single run is held to the width the layout measured it against.
 *
 * pdf-lib's own `drawText` offers no horizontal scale: it wraps a run at `maxWidth` — which is exactly the break a copied value must not get — and draws it past that width otherwise.
 * The text-state horizontal scale (`Tz`) does neither: the glyphs keep the size the layout chose, and only their advance is scaled, so the run measures inside the width it was given while the text a PDF hands back is the value, character for character.
 * The scale is set between the graphics-state push and pop the run is wrapped in, so a later run drawn at its natural width is unaffected by it.
 */
function drawScaledRun(page: PDFPage, run: Extract<DrawOp, { readonly kind: "text" }>, font: PDFFont): void {
	const { newFontKey } = page.setOrEmbedFont(font);
	page.pushOperators(
		pushGraphicsState(),
		beginText(),
		setFillingColor(run.color),
		setFontAndSize(newFontKey, run.size),
		setCharacterSqueeze(run.xScale * 100),
		setTextMatrix(1, 0, 0, 1, run.x, run.y),
		showText(font.encodeText(run.text)),
		endText(),
		popGraphicsState(),
	);
}
