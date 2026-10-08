/**
 * The official invoice PDF.
 *
 * This is the payer's document in a portable, printable form: the same {@link InvoiceViewModel} the on-screen view draws (`ui/presentation.ts`), laid out on US Letter with pdf-lib's base-14 fonts — a serif voice for the document, a sans voice for its tabular data, a monospace voice for addresses.
 * Everything is vector.
 * pdf-lib cannot embed SVG and the export must make no network request for an image, so the letterhead is a drawn wordmark and rules rather than the on-screen logo file.
 *
 * The module is three layers:
 * - {@link buildInvoicePages} is the pure layout: the view model and a {@link FontMetrics} become one {@link PdfPageLayout} of {@link DrawOp}s per page with pagination already resolved.
 *   It touches no clock, no DOM and no network, so it is what the tests exercise directly.
 * - {@link renderInvoicePdf} embeds the fonts, runs the layout, and emits the PDF bytes.
 * - {@link downloadPdf} and {@link renderPdf} hand those bytes to the browser, the only layer that touches the outside world.
 *
 * A share string is untrusted, so every string passes through {@link toPdfText} before it is measured or drawn: a base-14 font encodes WinAnsi only, and an unencodable code point would otherwise throw mid-export.
 * Text that cannot be encoded becomes `?` and the document still renders.
 */

import {
	PDFDocument,
	PageSizes,
	StandardFonts,
	rgb,
	type PDFFont,
	type PDFPage,
	type RGB,
} from "../../js/vendor/pdf-lib/pdf-lib.esm.js";
import type { Invoice } from "../invoice/model.js";
import {
	buildInvoiceViewModel,
	type InvoiceLabels,
	type InvoiceLineView,
	type InvoiceViewModel,
} from "../ui/presentation.js";

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

const CONTENT_LEFT = PAGE.marginX;
const CONTENT_RIGHT = PAGE.width - PAGE.marginX;
const CONTENT_W = CONTENT_RIGHT - CONTENT_LEFT;
const CONTENT_TOP = PAGE.marginTop;
const FLOOR_TOP = PAGE.height - PAGE.contentFloor;

/** Fraction of a font's size from its baseline to the top of a capital, near enough for spacing. */
const ASCENT = 0.72;
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
});

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
 * Lay an invoice out into pages of drawing ops, with pagination resolved: the column header repeats on every page, the totals block stays whole, notes and payment terms flow rather than overflow, and no op leaves the page.
 * Pure — the caller supplies the measurement — so the pagination can be asserted without embedding a font or rendering a byte.
 */
export function buildInvoicePages(view: InvoiceViewModel, metrics: FontMetrics): readonly PdfPageLayout[] {
	const flow = new Flow(metrics);
	drawLetterhead(flow, view);
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
 * No DOM, no clock and no network: the document is created with pdf-lib's automatic metadata stamping off, and every metadata field is written from the invoice itself, so the same invoice always renders to the same bytes.
 */
export async function renderInvoicePdf(invoice: Invoice, today: string): Promise<Uint8Array> {
	const view = buildInvoiceViewModel(invoice, today);
	const doc = await PDFDocument.create({ updateMetadata: false });
	const fonts = await embedFonts(doc);
	for (const layout of buildInvoicePages(view, metricsFor(fonts))) {
		drawOps(doc.addPage([PAGE.width, PAGE.height]), layout.ops, fonts);
	}
	doc.setTitle(toPdfText(`Invoice ${view.documentNumber}`));
	doc.setAuthor(toPdfText(view.from.name));
	doc.setCreator(DOCUMENT_PRODUCER);
	doc.setProducer(DOCUMENT_PRODUCER);
	return doc.save();
}

/** Hand PDF bytes to the browser as a download and release the object URL. */
export function downloadPdf(bytes: Uint8Array, fileName: string, downloader: PdfDownloader = browserDownloader): void {
	const blob = new Blob([new Uint8Array(bytes)], { type: PDF_MIME });
	const url = downloader.createObjectUrl(blob);
	try {
		downloader.save(url, fileName);
	} finally {
		downloader.revokeObjectUrl(url);
	}
}

/** The invoice view's export seam: render the invoice and download it under a safe file name. */
export async function renderPdf(invoice: Invoice, today: string, downloader?: PdfDownloader): Promise<void> {
	const bytes = await renderInvoicePdf(invoice, today);
	downloadPdf(bytes, invoiceFileName(invoice), downloader);
}

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
	return PAGE.height - top - size * ASCENT;
}

/** The `top` that vertically centers a text run of `size` inside a box of `height` starting at `top`. */
function centerTop(top: number, height: number, size: number): number {
	// A capital's visual middle sits half its ascent above the baseline, so the run is offset by half ASCENT from the box's center.
	return top + height / 2 - (size * ASCENT) / 2;
}

interface FittedText {
	/** One or more lines carrying the whole value; wrapping never drops a glyph. */
	readonly lines: readonly string[];
	readonly size: number;
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

/**
 * The vertical cursor a block draws against.
 * `top` is a distance from the page's top edge; each draw method converts to PDF coordinates at the edge.
 * New pages start at {@link CONTENT_TOP} and every block checks {@link Flow.fits} — or calls {@link Flow.ensure} — so nothing lands in the footer strip or past the page.
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

	text(x: number, top: number, value: string, size: number, font: PdfFontRole, color: PdfColor): void {
		this.ops.push({ kind: "text", x, y: baseline(top, size), text: toPdfText(value), size, font, color });
	}

	textRight(right: number, top: number, value: string, size: number, font: PdfFontRole, color: PdfColor): void {
		const text = toPdfText(value);
		this.text(right - this.metrics.widthOfText(text, size, font), top, text, size, font, color);
	}

	rule(top: number, x1: number, x2: number, thickness: number, color: PdfColor): void {
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
		this.ops.push({
			kind: "fill",
			x,
			y: PAGE.height - top - height,
			width,
			height,
			color,
			...(border === undefined ? {} : { border }),
		});
	}
}

interface PartyLine {
	readonly text: string;
	readonly size: number;
	readonly font: PdfFontRole;
	readonly color: PdfColor;
}

interface PartyBlock {
	readonly label: string;
	readonly lines: readonly PartyLine[];
}

function drawLetterhead(flow: Flow, view: InvoiceViewModel): void {
	const top = flow.top;

	flow.fill(CONTENT_LEFT, top + 1, 11, 11, PALETTE.accent);
	flow.text(CONTENT_LEFT + 18, top, view.labels.brand, SIZE.brand, "sansBold", PALETTE.ink);
	flow.text(
		CONTENT_LEFT + 18,
		top + leading(SIZE.brand),
		view.labels.tagline.toUpperCase(),
		SIZE.tagline,
		"sansBold",
		PALETTE.muted,
	);

	flow.textRight(CONTENT_RIGHT, top, view.labels.kind.toUpperCase(), SIZE.kind, "sansBold", PALETTE.ink);
	flow.textRight(
		CONTENT_RIGHT,
		top + leading(SIZE.kind),
		view.documentNumber,
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

	const brandHeight = leading(SIZE.brand) + leading(SIZE.tagline);
	const metaHeight = leading(SIZE.kind) + leading(SIZE.documentNumber) + 3 + 16;
	flow.advance(Math.max(brandHeight, metaHeight) + GAP.letterheadToRule);
	flow.rule(flow.top, CONTENT_LEFT, CONTENT_RIGHT, 2, PALETTE.ink);
	flow.advance(GAP.afterSectionRule);
}

function drawParties(flow: Flow, view: InvoiceViewModel): void {
	const blocks: PartyBlock[] = [
		{
			label: view.from.role,
			lines: [
				{ text: view.from.name, size: SIZE.partyName, font: "serifBold", color: PALETTE.ink },
				...(view.from.email === undefined ? [] : ([{ text: view.from.email, size: SIZE.partyDetail, font: "sans", color: PALETTE.inkSoft }] satisfies readonly PartyLine[])),
			],
		},
	];
	if (view.billTo !== null) {
		blocks.push({
			label: view.billTo.role,
			lines: [
				{ text: view.billTo.name, size: SIZE.partyName, font: "serifBold", color: PALETTE.ink },
				...(view.billTo.email === undefined ? [] : ([{ text: view.billTo.email, size: SIZE.partyDetail, font: "sans", color: PALETTE.inkSoft }] satisfies readonly PartyLine[])),
			],
		});
	}
	blocks.push({
		label: view.labels.dates,
		lines: view.dates.flatMap((date) => [
			{ text: date.label.toUpperCase(), size: SIZE.dateLabel, font: "sansBold", color: PALETTE.muted },
			{ text: date.value, size: SIZE.dateValue, font: "sans", color: PALETTE.ink },
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
			for (const wrapped of wrapText(line.text, columnWidth - 2, line.size, line.font, flow.metrics)) {
				flow.text(x, y, wrapped, line.size, line.font, line.color);
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
	flow.ensure(rowHeight, () => drawTableHeader(flow, labels));
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

function drawNotes(flow: Flow, notes: readonly string[], labels: InvoiceLabels): void {
	const lines = notes.flatMap((line) => wrapText(line, CONTENT_W, SIZE.note, "serif", flow.metrics));
	flow.advance(GAP.totalsToNotes);
	flow.ensure(12 + leading(SIZE.section) + 6 + leading(SIZE.note) * 2);
	flow.rule(flow.top, CONTENT_LEFT, CONTENT_RIGHT, 0.8, PALETTE.rule);
	flow.advance(14);
	flow.text(CONTENT_LEFT, flow.top, labels.notesTitle.toUpperCase(), SIZE.section, "sansBold", PALETTE.muted);
	flow.advance(leading(SIZE.section) + 6);
	for (const line of lines) {
		flow.ensure(leading(SIZE.note));
		flow.text(CONTENT_LEFT, flow.top, line, SIZE.note, "serif", PALETTE.inkSoft);
		flow.advance(leading(SIZE.note));
	}
}

function drawPayment(flow: Flow, view: InvoiceViewModel): void {
	flow.advance(GAP.notesToPayment);
	flow.ensure(14 + leading(SIZE.section) + 6 + leading(SIZE.paymentValue) * 2);
	flow.rule(flow.top, CONTENT_LEFT, CONTENT_RIGHT, 2, PALETTE.ink);
	flow.advance(16);
	flow.text(CONTENT_LEFT, flow.top, view.labels.paymentTitle.toUpperCase(), SIZE.section, "sansBold", PALETTE.muted);
	flow.advance(leading(SIZE.section) + 8);
	for (const term of view.payment) {
		const mono = term.mono === true;
		const size = mono ? SIZE.paymentMono : SIZE.paymentValue;
		const font = mono ? "mono" : "sans";
		const lines = wrapText(term.value, CONTENT_W - PAYMENT_LABEL_W, size, font, flow.metrics);
		const height = Math.max(leading(SIZE.paymentLabel), lines.length * leading(size));
		flow.ensure(height + 6);
		const top = flow.top;
		flow.text(CONTENT_LEFT, top, term.label.toUpperCase(), SIZE.paymentLabel, "sansBold", PALETTE.muted);
		let y = top;
		for (const line of lines) {
			flow.text(CONTENT_LEFT + PAYMENT_LABEL_W, y, line, size, font, PALETTE.ink);
			y += leading(size);
		}
		flow.advance(height + 6);
	}
}

function appendFooters(pages: DrawOp[][], documentNumber: string, metrics: FontMetrics): void {
	const total = pages.length;
	const number = toPdfText(documentNumber);
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

function drawOps(page: PDFPage, ops: readonly DrawOp[], fonts: Record<PdfFontRole, PDFFont>): void {
	for (const op of ops) {
		switch (op.kind) {
			case "text":
				page.drawText(op.text, { x: op.x, y: op.y, size: op.size, font: fonts[op.font], color: op.color });
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
		}
	}
}
