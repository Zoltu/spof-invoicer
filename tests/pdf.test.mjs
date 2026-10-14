/** The suite for `app/js/pdf/renderer.js`: that the exported bytes reopen as US Letter pages carrying the project's metadata, its pagination, and every figure the invoice shows. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { encodeInvoice } from "../app/js/invoice/codec.js";
import { MAX_ICON_DIMENSION } from "../app/js/invoice/icon.js";
import { InvalidInvoiceError, MAX_DESCRIPTION_CHARS, MAX_EMAIL_CHARS, MAX_ID_CHARS, MAX_NAME_CHARS, createInvoice } from "../app/js/invoice/model.js";
import { buildPaymentLink } from "../app/js/payment/links.js";
import { UINT256_MAX, fromBaseUnits } from "../app/js/util/decimal.js";
import { svgDataUrl } from "../app/js/util/svg-data-url.js";
import { PDFDocument, decodePDFRawStream } from "../app/js/vendor/pdf-lib/pdf-lib.esm.js";
import { parseHash } from "../app/js/app/router.js";
import { mountShell, renderRoute } from "../app/js/app/shell.js";
import { rasterizeSvgIcon } from "../app/js/pdf/rasterize.js";
import {
	BASELINE_ASCENT,
	CONTENT_RIGHT,
	FLOOR_TOP,
	PAGE,
	PAYMENT_VALUE_MIN_SIZE,
	QR_SYMBOL,
	buildInvoicePages,
	downloadPdf,
	exportFontMetrics,
	invoiceFileName,
	renderInvoicePdf,
	renderPdf,
	toPdfText,
	wrapText,
} from "../app/js/pdf/renderer.js";
import { buildInvoiceViewModel } from "../app/js/ui/presentation.js";
import { installDocument, installInteractiveDocument } from "./helpers/dom.mjs";
import { blockNetwork } from "./helpers/network-block.mjs";
import { imageXObjects } from "./helpers/pdf-images.mjs";
import { PAYEE, XMR_PAYEE, ZEC_PAYEE, ZEC_TRANSPARENT_PAYEE } from "./helpers/payee-vectors.mjs";
import { assertSymbolCells, moduleFills } from "./helpers/qr-symbol.mjs";
import { readEmittedModule, staticImportReach, staticImportSpecifiers } from "./helpers/static-imports.mjs";
import { findButton, textOf } from "./helpers/tree.mjs";
import { unifiedOfBytes } from "./helpers/unified-address.mjs";
import { waitFor } from "./helpers/wait.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// A deterministic stand-in for embedded-font metrics: every glyph is half the point size wide.
// The pure layout only needs consistent widths, so this exercises the pagination without a font.
const METRICS = { widthOfText: (text, size) => text.length * size * 0.5 };

// A single glyph repeated forty times: a uint256-scale money value too wide for its column, so the fixture proves the layout wraps it rather than losing digits.
const NINES = "9".repeat(40);

// The end-to-end export test waits for two pieces of deferred work.
// The download anchor is recorded within a tick or two, while the renderer revokes the object URL only after its 1 s revoke delay, so that wait is sized above the delay.
// Both waits give up rather than hang, leaving the assertion to report the real failure.
const SAVE_WAIT_ATTEMPTS = 200;
const REVOKE_WAIT_ATTEMPTS = 300;

function line(overrides = {}) {
	return { description: "Design work", quantity: "2", unitPrice: "150", ...overrides };
}

function invoiceFor(overrides = {}) {
	return createInvoice({
		id: "INV-1",
		issued: "2026-10-03",
		payee: { name: "Studio Example", address: PAYEE },
		chainId: "0x1",
		asset: "usdc",
		items: [line()],
		...overrides,
	});
}

function zecInvoice(overrides = {}) {
	return createInvoice({
		id: "INV-ZEC",
		issued: "2026-10-03",
		payee: { name: "Studio Example", address: ZEC_PAYEE },
		chainId: "zcash",
		asset: "zec",
		items: [line()],
		...overrides,
	});
}

function xmrInvoice(overrides = {}) {
	return createInvoice({
		id: "INV-XMR",
		issued: "2026-10-03",
		payee: { name: "Studio Example", address: XMR_PAYEE },
		chainId: "monero",
		asset: "xmr",
		items: [line()],
		...overrides,
	});
}

function ethInvoice(overrides = {}) {
	return createInvoice({
		id: "INV-ETH",
		issued: "2026-10-03",
		payee: { name: "Studio Example", address: PAYEE },
		chainId: "0x1",
		asset: "eth",
		items: [line()],
		...overrides,
	});
}

/** The page's text draws, in the order they were emitted. */
function textDraws(page) {
	return page.ops.filter((op) => op.kind === "text");
}

/** Assert two layout figures agree, to a tolerance that absorbs the float noise of adding one module's size a few dozen times. */
function assertClose(actual, expected, message) {
	assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
}

/**
 * The `top` the payment section's own block starts at, measured down from the page's top edge: the line the first payment term's label is drawn on, which is where the terms and the symbol both begin.
 * A text draw records a baseline rather than the line's top, so the line's top is read back through the renderer's own `BASELINE_ASCENT` — the fraction every text draw offsets its baseline by — and never through the metrics of an unrelated draw.
 */
function paymentBlockTop(page, view) {
	const firstTerm = view.payment[0];
	assert.ok(firstTerm !== undefined, "the view model states the term the payment block opens with");
	const label = textDraws(page).find((op) => op.text === firstTerm.label.toUpperCase());
	assert.ok(label !== undefined, `the layout draws the first payment term's label: ${firstTerm.label}`);
	return PAGE.height - label.y - label.size * BASELINE_ASCENT;
}

/** The rule that opens the payment section on `page`: the two-point ink rule drawn nearest above `blockTop`. */
function sectionRuleAbove(page, blockTop) {
	const above = page.ops.filter((op) => op.kind === "rule" && op.thickness === 2 && drawnBottomTop(op) <= blockTop);
	assert.ok(above.length > 0, "the layout draws a rule above the payment block");
	return above.reduce((nearest, op) => (drawnBottomTop(op) > drawnBottomTop(nearest) ? op : nearest));
}

/** True when a text draw lies in the payment section's block: its line's top sits between `blockTop` and the content floor, which is the strip the section's terms occupy. */
function insidePaymentBlock(op, blockTop) {
	const top = PAGE.height - op.y - op.size * BASELINE_ASCENT;
	return top >= blockTop - 1e-9 && top <= FLOOR_TOP + 1e-9;
}

/** The right edge of a right-aligned text draw, as the document itself records it: the op's own x plus the width the layout's own measurement gives that text. */
function drawnRightEdge(page, text) {
	const op = textDraws(page).find((candidate) => candidate.text === text);
	assert.ok(op !== undefined, `the layout draws ${JSON.stringify(text)}`);
	return op.x + METRICS.widthOfText(op.text, op.size, op.font);
}

/** The lowest a drawn op reaches, as a distance from the page's top edge: a rule's line, or a text or fill op's own bottom. */
function drawnBottomTop(op) {
	return PAGE.height - (op.kind === "rule" ? Math.min(op.y1, op.y2) : op.y);
}

/** The bottom edge of each item row a page drew, in the order the rows are drawn, as distances from the page's top edge: the soft rule that closes a row's cells. */
function itemRowBottoms(page) {
	return page.ops.filter((op) => op.kind === "rule" && op.thickness === 0.5).map(drawnBottomTop);
}

/** The top of a row-bearing page's first item row, as a distance from the page's top edge: the column header's closing rule, which that row is drawn directly beneath. */
function firstRowTop(page) {
	const rule = page.ops.find((op) => op.kind === "rule" && op.thickness === 1.2);
	assert.ok(rule !== undefined, "a row-bearing page opens with the repeated column header");
	return drawnBottomTop(rule);
}

/** The height the repeated column header occupies, measured from the band it draws rather than restated from the renderer's own constant. */
function columnHeaderHeight(page) {
	const band = headBlocks(page)[2][1].find((op) => op.kind === "fill");
	assert.ok(band !== undefined, "the column header draws its own band");
	return band.height;
}

function manyItems(count) {
	return Array.from({ length: count }, (_, index) =>
		line({
			description: `Item ${index + 1} — a reasonably long description for wrapping`,
			quantity: "1",
			unitPrice: "10",
		}),
	);
}

function textOps(page) {
	return textDraws(page).map((op) => op.text);
}

test("a small invoice renders to a one-page US Letter PDF", async () => {
	const bytes = await renderInvoicePdf(invoiceFor(), "2026-10-03");
	assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-", "the bytes begin with the PDF header");

	const opened = await PDFDocument.load(bytes);
	assert.equal(opened.getPageCount(), 1);
	const { width, height } = opened.getPage(0).getSize();
	assert.deepEqual([width, height], [612, 792], "the page is US Letter");
});

test("the export is reproducible and carries the project's own metadata, not pdf-lib's", async () => {
	const invoice = invoiceFor({ due: "2026-11-02", items: manyItems(3) });
	const first = await renderInvoicePdf(invoice, "2026-10-03");
	const second = await renderInvoicePdf(invoice, "2026-10-03");
	assert.deepEqual(first, second, "the same invoice renders to identical bytes — no clock was read");

	// The literal bytes carry no pdf-lib branding or third-party URL.
	const raw = new TextDecoder("latin1").decode(first);
	assert.ok(!raw.includes("Hopding"), "the artifact names no pdf-lib producer");
	assert.ok(!/https?:\/\//.test(raw), "the artifact embeds no third-party URL");

	// Read the metadata back without pdf-lib re-stamping it from the clock.
	const opened = await PDFDocument.load(first, { updateMetadata: false });
	assert.equal(opened.getProducer(), "Invoicing (on-chain payment invoice)");
	assert.equal(opened.getCreator(), "Invoicing (on-chain payment invoice)");
	assert.equal(opened.getTitle(), "Invoice #INV-1");
	assert.equal(opened.getAuthor(), "Studio Example");
});

test("the layout carries every figure the on-screen document shows", () => {
	const view = buildInvoiceViewModel(
		invoiceFor({
			due: "2026-11-02",
			payee: { name: "Studio Example", address: PAYEE, email: "billing@example.com" },
			payer: { name: "Client Co" },
			tax: { label: "VAT 19%", rate: "19" },
			notes: "Thanks for your business.",
		}),
		"2026-10-03",
	);
	const pages = buildInvoicePages(view, METRICS);
	assert.equal(pages.length, 1);
	const text = textOps(pages[0]).join("\n");

	for (const fragment of [
		"Invoicing",
		"ON-CHAIN PAYMENT INVOICE",
		"INVOICE",
		"#INV-1",
		"PAYMENT DUE",
		"FROM",
		"Studio Example",
		"billing@example.com",
		"BILL TO",
		"Client Co",
		"ISSUED",
		"3 Oct 2026",
		"DUE",
		"2 Nov 2026",
		"DESCRIPTION",
		"Design work",
		"Subtotal",
		"300 USDC",
		"VAT 19%",
		"57 USDC",
		"Total due",
		"357 USDC",
		"NOTES AND TERMS",
		"Thanks for your business.",
		"PAYMENT DETAILS",
		"USD Coin (USDC)",
		"Ethereum (0x1)",
		PAYEE,
		"Page 1 of 1",
	]) {
		assert.ok(text.includes(fragment), `the layout is missing ${JSON.stringify(fragment)}`);
	}
});

test("a uint256-scale money figure wraps rather than losing digits or the asset suffix", () => {
	const invoice = invoiceFor({
		payee: { name: "Studio Example", address: "0x1111111111111111111111111111111111111111" },
		items: [line({ quantity: "1", unitPrice: NINES })],
	});
	const view = buildInvoiceViewModel(invoice, "2026-10-03");
	const pages = buildInvoicePages(view, METRICS);
	const entries = pages.flatMap((page) => textOps(page));

	assert.ok(!entries.some((entry) => entry.includes("...")), "no value is re-drawn elided with an ellipsis");
	// The document draws five money figures — the line's unit price and amount, the subtotal, the total, and the payment details' own Amount — and every digit of each survives the wrap.
	// The payment link's own digits are counted out: it is the same total spelled in base units inside its URI, drawn as link text rather than as a money figure.
	const linkNines = buildPaymentLink(invoice).uri.split("9").length - 1;
	const figureNines = entries.join("").split("9").length - 1 - linkNines;
	assert.equal(figureNines, NINES.length * 5, "every digit of every money figure survives — the PDF shows the screen's number");
});

test("a long invoice paginates, repeating the column header and numbering each footer", () => {
	const pages = buildInvoicePages(
		buildInvoiceViewModel(invoiceFor({ items: manyItems(120) }), "2026-10-03"),
		METRICS,
	);
	assert.ok(pages.length > 1, `expected a multi-page invoice, got ${pages.length}`);

	// Every page that carries an item row repeats the column header; a trailing page holding only the totals/notes/payment correctly has none.
	const rowPages = pages.filter((page) => textOps(page).some((entry) => entry.startsWith("Item ")));
	assert.ok(rowPages.length > 1, "the rows must span more than one page");
	for (const page of rowPages) {
		const text = textOps(page);
		for (const header of ["DESCRIPTION", "QTY", "UNIT PRICE", "AMOUNT"]) {
			assert.ok(text.includes(header), `a row-bearing page is missing the repeated column header ${header}`);
		}
	}

	for (const [index, page] of pages.entries()) {
		assert.ok(
			textOps(page).includes(`Page ${index + 1} of ${pages.length}`),
			`page ${index + 1} is missing its "Page X of Y" footer`,
		);
	}
});

test("an item row moves to the next page only when it cannot fit the page it would have landed on", () => {
	const pages = buildInvoicePages(
		buildInvoiceViewModel(invoiceFor({ items: manyItems(120) }), "2026-10-03"),
		METRICS,
	);
	// Every break the table takes is read off the layout's own geometry: the row that opens a page is measured from the column header redrawn for it, and the page it left is asked whether a row that tall had room under its last row.
	// A break that reserved the header along with the row fails here only on a page whose spare room below its last row is smaller than that header: there the current rule kept a row the header-reserving rule would have bounced, so the row opening the next page differs and the assertion below moves with it.
	// Whether this fixture holds such a page is asserted rather than assumed, so a letterhead, parties, or row-height change cannot leave the branch exercised by nothing while the loop still passes.
	const headerHeight = columnHeaderHeight(pages[0]);
	let breaks = 0;
	let tightBreaks = 0;
	for (let index = 0; index + 1 < pages.length; index += 1) {
		const kept = itemRowBottoms(pages[index]);
		const bounced = itemRowBottoms(pages[index + 1]);
		if (kept.length === 0 || bounced.length === 0) continue;
		const lastRowBottom = kept[kept.length - 1];
		const spareRoom = FLOOR_TOP - lastRowBottom;
		const bouncedRowHeight = bounced[0] - firstRowTop(pages[index + 1]);
		assert.ok(
			lastRowBottom + bouncedRowHeight > FLOOR_TOP,
			`the ${bouncedRowHeight.toFixed(1)}-point row opening page ${index + 2} had ${spareRoom.toFixed(1)} points below page ${index + 1}'s last row, so it was bounced with room to spare`,
		);
		if (spareRoom < headerHeight) tightBreaks += 1;
		breaks += 1;
	}
	assert.ok(breaks >= 2, `the fixture must break rows across pages for this to mean anything, and it took ${breaks} breaks`);
	assert.ok(
		tightBreaks >= 1,
		`the fixture must bounce a row off a page with less spare room than the ${headerHeight.toFixed(1)}-point column header, or reverting the reservation would leave this test passing`,
	);
});

test("a large invoice renders to multiple real PDF pages", async () => {
	const small = await renderInvoicePdf(invoiceFor(), "2026-10-03");
	const large = await renderInvoicePdf(invoiceFor({ id: "INV-BIG", items: manyItems(120) }), "2026-10-03");
	assert.equal((await PDFDocument.load(small)).getPageCount(), 1);
	assert.ok((await PDFDocument.load(large)).getPageCount() > 1, "a 120-line invoice spills past one page");
});

/**
 * Assert every op of every page stays inside the page's own box: a text run within the extent it is actually drawn at, a rule between its two points, and a filled or image box within its own rectangle.
 */
function assertOpsWithinPage(pages, metrics) {
	for (const page of pages) {
		for (const op of page.ops) {
			if (op.kind === "text") {
				// A value too wide for the line it was given is drawn compressed onto that width, so the extent it occupies is its natural width times its xScale; measuring it at its natural width would report a legal document as leaving the page.
				const width = metrics.widthOfText(op.text, op.size, op.font) * op.xScale;
				assert.ok(op.x >= 0 && op.x + width <= PAGE.width + 0.01, `text escapes horizontally: ${op.text}`);
				assert.ok(op.y >= 0 && op.y <= PAGE.height, `text escapes vertically: ${op.text}`);
			} else if (op.kind === "rule") {
				assert.ok(Math.min(op.x1, op.x2) >= 0 && Math.max(op.x1, op.x2) <= PAGE.width);
				assert.ok(Math.min(op.y1, op.y2) >= 0 && Math.max(op.y1, op.y2) <= PAGE.height);
			} else {
				assert.ok(op.x >= 0 && op.x + op.width <= PAGE.width, "a drawn box escapes horizontally");
				assert.ok(op.y >= 0 && op.y + op.height <= PAGE.height, "a drawn box escapes vertically");
			}
		}
	}
}

test("no draw op leaves the page, even with 200 items and long notes", () => {
	const view = buildInvoiceViewModel(
		invoiceFor({
			id: "INV-HUGE",
			items: manyItems(200),
			tax: { label: "VAT 19%", rate: "19" },
			notes: "A long note that must wrap across many lines. ".repeat(30).trim(),
		}),
		"2026-10-03",
	);
	const pages = buildInvoicePages(view, METRICS);
	assert.ok(pages.length > 1);

	assertOpsWithinPage(pages, METRICS);
});

test("the page bound measures a text run at the scale it is drawn at", () => {
	// The widest values a legal Zcash invoice carries are drawn compressed onto the payment section's own content width, so a bound that measured a run at its natural width would report a document that never leaves the page.
	const widest = zecInvoice({
		payee: { name: "Studio Example", address: unifiedOfBytes(189) },
		items: [line({ quantity: "1", unitPrice: fromBaseUnits(UINT256_MAX, 8) })],
	});
	const view = buildInvoiceViewModel(widest, "2026-10-03");
	const pages = buildInvoicePages(view, METRICS);
	const link = pages.flatMap((page) => page.ops).find((op) => op.kind === "text" && op.text === view.paymentLink);
	assert.ok(link !== undefined, "the widest link this app can build is drawn");
	assert.ok(link.xScale < 1, "and drawn compressed, since the section cannot hold it at the floor");
	assert.ok(
		link.x + METRICS.widthOfText(link.text, link.size, link.font) > PAGE.width,
		"the run measures past the page at its natural width, which is the reading this bound must not apply",
	);

	assertOpsWithinPage(pages, METRICS);

	// The bound still reports a run drawn past the edge, so what it measures is the drawn extent rather than nothing at all.
	const escaping = { kind: "text", x: PAGE.width - 1, y: 100, text: "overflow", size: 6, font: "mono", xScale: 1 };
	assert.throws(() => assertOpsWithinPage([{ ops: [escaping] }], METRICS), /text escapes horizontally/);
});

/** True for the running footer's own draws — its hairline and the two runs under it — which sit deliberately in the strip below the content floor. */
function isFooterOp(op) {
	return (op.kind === "text" && op.y === PAGE.footerBaseline) || (op.kind === "rule" && op.y1 === PAGE.footerRule);
}

test("an over-tall block is clamped to the page's content floor rather than drawn past it", () => {
	// A validated invoice can never reach this: the model's own field caps keep every block well inside a page, so the draw-site bound is exercised with a view model built outside the validators — the shape a loosened cap or a new asset family would land in.
	const base = buildInvoiceViewModel(invoiceFor({ due: "2026-11-02", notes: "Thanks." }), "2026-10-03");
	const overTall = [
		["an over-tall item row", { ...base, lines: [{ ...base.lines[0], description: "n".repeat(20000) }] }],
		["an over-tall head block", { ...base, from: { ...base.from, name: "n".repeat(20000) } }],
		["an over-tall payment block", { ...base, payment: [{ label: "Payment link", value: "l".repeat(20000), verbatim: true }] }],
	];
	for (const [fixture, view] of overTall) {
		const pages = buildInvoicePages(view, METRICS);
		assert.ok(pages.length >= 1, `${fixture}: the layout still produces a page`);
		const drawn = pages.flatMap((page) => page.ops).filter((op) => !isFooterOp(op));
		assert.ok(drawn.length > 0, `${fixture}: the layout still draws the document`);
		for (const op of drawn) {
			const bottom = drawnBottomTop(op);
			assert.ok(bottom <= FLOOR_TOP + 1e-9, `${fixture}: a draw reaches ${bottom.toFixed(1)} from the page's top, past the ${FLOOR_TOP}-point content floor`);
		}
	}
});

test("a maximum-length id of wide glyphs is drawn inside the page on the letterhead and the footer alike", async () => {
	const id = "@".repeat(MAX_ID_CHARS);
	assert.equal(id.length, MAX_ID_CHARS);
	// The stand-in measures every glyph at half an em, so the capped id is only 320 points wide under it; the export's own faces measure `@` at just over an em, which is what lets a capped id of wide glyphs overrun its box.
	const metrics = await exportFontMetrics();
	const view = buildInvoiceViewModel(invoiceFor({ id }), "2026-10-03");
	const pages = buildInvoicePages(view, metrics);
	assert.equal(pages.length, 1);

	for (const page of pages) {
		for (const op of page.ops) {
			if (op.kind === "text") {
				const width = metrics.widthOfText(op.text, op.size, op.font);
				assert.ok(op.x >= 0 && op.x + width <= PAGE.width + 0.01, `text escapes horizontally: ${op.text}`);
				assert.ok(op.y >= 0 && op.y <= PAGE.height, `text escapes vertically: ${op.text}`);
			} else if (op.kind === "rule") {
				assert.ok(Math.min(op.x1, op.x2) >= 0 && Math.max(op.x1, op.x2) <= PAGE.width);
				assert.ok(Math.min(op.y1, op.y2) >= 0 && Math.max(op.y1, op.y2) <= PAGE.height);
			} else {
				assert.ok(op.x >= 0 && op.x + op.width <= PAGE.width, "fill escapes horizontally");
				assert.ok(op.y >= 0 && op.y + op.height <= PAGE.height, "fill escapes vertically");
			}
		}
	}

	// The footer's number and its right-aligned page label share one line, so the bound that keeps the number on the page is the same one that keeps the two from drawing over each other.
	const atFooter = textDraws(pages[0]).filter((op) => op.y === PAGE.footerBaseline);
	assert.equal(atFooter.length, 2, "the footer draws the document number and its page label");
	const [number, label] = atFooter;
	assert.equal(number.text.startsWith("#"), true, `the footer's left run is the document number, got ${JSON.stringify(number.text)}`);
	const numberRight = number.x + metrics.widthOfText(number.text, number.size, number.font);
	assert.ok(numberRight <= label.x, `the footer's number reaches ${numberRight}, into the page label at ${label.x}`);
});

/**
 * The head of a page: the three blocks the layout draws without asking the flow for room, split at the rules that close each of them — the letterhead's, the parties', and the column header's.
 */
function headBlocks(page) {
	const rules = page.ops.flatMap((op, index) => (op.kind === "rule" ? [index] : []));
	assert.ok(rules.length >= 3, "the head blocks each close with a rule, and the item table follows them");
	return [
		["the letterhead", page.ops.slice(0, rules[0] + 1)],
		["the parties", page.ops.slice(rules[0] + 1, rules[1] + 1)],
		["the column header", page.ops.slice(rules[1] + 1, rules[2] + 1)],
	];
}

/** Assert every op of each head block on the page's first page stays above the content floor, naming the fixture that drew it. */
function assertHeadsAboveFloor(fixture, pages) {
	for (const [name, block] of headBlocks(pages[0])) {
		assert.ok(block.length > 0, `${fixture}: ${name} drew no op`);
		for (const op of block) {
			const bottom = drawnBottomTop(op);
			assert.ok(bottom <= FLOOR_TOP, `${fixture}: ${name} reaches the page's content floor: ${bottom} > ${FLOOR_TOP}`);
		}
	}
}

/**
 * A name of exactly `length` characters in the word shape the half-em metric wraps to the most lines: 14-character words are the longest two of which no longer share one narrow column line, so every word takes a line of its own.
 */
function cappedName(length) {
	const words = Array.from({ length: Math.ceil(length / 15) }, () => "n".repeat(14));
	return words.join(" ").slice(0, length).padEnd(length, "n");
}

/**
 * The tallest head a validated invoice can draw: a name and an email at the model's own caps, in the narrowest column the party grid gives, with both party columns filled at once — the payee, the bill-to and the dates make three blocks, so each column is a third of the content width rather than a half.
 */
function capMaxInvoice({ nameLength = MAX_NAME_CHARS, emailLength = MAX_EMAIL_CHARS } = {}) {
	const name = cappedName(nameLength);
	const email = `${"m".repeat(emailLength - "@example.com".length)}@example.com`;
	assert.equal(name.length, nameLength);
	assert.equal(email.length, emailLength);
	return invoiceFor({
		due: "2026-11-02",
		payee: { name, address: PAYEE, email },
		payer: { name, email },
		notes: "Thanks for your business.",
	});
}

test("the blocks the layout draws without a fit check stay above the content floor at the invoice's field caps", async () => {
	// The head blocks carry no fit check because the model's own field caps bound them, so what the bound rests on is the cap-max head — the longest name and email a validated invoice can carry, in the narrowest column three parties give — and a short fixture stands far clear of the floor without saying anything about it.
	const plain = buildInvoicePages(
		buildInvoiceViewModel(invoiceFor({ due: "2026-11-02", notes: "Thanks for your business." }), "2026-10-03"),
		METRICS,
	);
	const capped = buildInvoicePages(buildInvoiceViewModel(capMaxInvoice(), "2026-10-03"), METRICS);
	// The stand-in measures a half em per glyph, while the faces the export embeds measure wider — Helvetica `m` is 0.833 em and Times `n` 0.556 em — so the cap-max head sits higher above the floor here than the head drawn in the exported file; the same invoice is laid out again with the export's own metric source.
	const exported = buildInvoicePages(buildInvoiceViewModel(capMaxInvoice(), "2026-10-03"), await exportFontMetrics());
	assert.equal(plain.length, 1);
	const lowest = (page) => Math.max(...headBlocks(page).flatMap(([, block]) => block.map(drawnBottomTop)));

	for (const [fixture, pages] of [["the plain invoice", plain], ["the cap-max invoice", capped], ["the exported cap-max invoice", exported]]) {
		assertHeadsAboveFloor(fixture, pages);
	}
	assert.ok(lowest(capped[0]) > lowest(plain[0]), "the cap-max head is the taller of the two, so it is the case the unchecked head blocks have to survive");
	// The caps are what keeps the bound true, so the fixture pins the relationship rather than a figure: a name or an email one character past them is refused where the invoice is created.
	assert.throws(() => capMaxInvoice({ nameLength: MAX_NAME_CHARS + 1 }), InvalidInvoiceError, "a name past the cap is refused");
	assert.throws(() => capMaxInvoice({ emailLength: MAX_EMAIL_CHARS + 1 }), InvalidInvoiceError, "an email past the cap is refused");
});

test("the totals block stays whole on one page", () => {
	const pages = buildInvoicePages(
		buildInvoiceViewModel(invoiceFor({ items: manyItems(60), tax: { label: "VAT 19%", rate: "19" } }), "2026-10-03"),
		METRICS,
	);
	const holders = pages.filter((page) => textOps(page).includes("Total due"));
	assert.equal(holders.length, 1, "exactly one page carries the total due");
	const text = textOps(holders[0]);
	assert.ok(text.includes("Subtotal") && text.includes("VAT 19%"), "the whole totals block is together");
});

test("invoiceFileName sanitizes an untrusted id into a safe download name", () => {
	assert.equal(invoiceFileName(invoiceFor({ id: "INV-7" })), "invoice-INV-7.pdf");
	assert.equal(invoiceFileName(invoiceFor({ id: "../../etc/passwd" })), "invoice-etc-passwd.pdf");
	assert.equal(invoiceFileName(invoiceFor({ id: "a/b\\c:d*e?f" })), "invoice-a-b-c-d-e-f.pdf");
	assert.equal(invoiceFileName(invoiceFor({ id: "spaced  name" })), "invoice-spaced-name.pdf");
	assert.equal(invoiceFileName(invoiceFor({ id: "..." })), "invoice.pdf");

	const hostile = invoiceFileName(invoiceFor({ id: "../../../etc/passwd%00.png" }));
	assert.ok(!hostile.includes("/") && !hostile.includes("\\"), `path separator survived: ${hostile}`);
	assert.ok(!hostile.includes(".."), `parent-directory segment survived: ${hostile}`);
	assert.match(hostile, /^invoice-[A-Za-z0-9._-]+\.pdf$/);
});

test("hostile invoice text never breaks generation", async () => {
	const hostile = "<script>alert(1)</script> 😀 日本語 <img src=x onerror=alert(2)>";
	const invoice = invoiceFor({
		payee: { name: hostile, address: PAYEE },
		items: [line({ description: hostile })],
	});
	const bytes = await renderInvoicePdf(invoice, "2026-10-03");
	assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
	assert.ok((await PDFDocument.load(bytes)).getPageCount() >= 1);
});

test("toPdfText folds unencodable characters into the WinAnsi repertoire", () => {
	assert.equal(toPdfText("Café — 5€"), "Café — 5€", "Latin-1, the em dash and the euro all encode");
	assert.equal(toPdfText("hi 🚀"), "hi ?");
	assert.equal(toPdfText("a\u0000b"), "a?b", "a control character cannot reach drawText");
	assert.equal(toPdfText("tab\there"), "tab    here");
});

test("wrapText breaks on spaces and hard-breaks an over-wide word", () => {
	const metrics = { widthOfText: (text, size) => text.length * size };
	assert.deepEqual(wrapText("one two three", 30, 10, "sans", metrics), ["one", "two", "thr", "ee"]);
	assert.deepEqual(wrapText("short", 100, 10, "sans", metrics), ["short"]);
	assert.deepEqual(wrapText("", 100, 10, "sans", metrics), [""], "a blank line survives as a blank line");
});

test("wrapText always consumes at least one glyph, even when a single glyph exceeds the line", () => {
	const metrics = { widthOfText: (text, size) => text.length * size };
	// A maxWidth narrower than one glyph: every character is wider than the line, so the hard-break loop must still make progress instead of spinning on a zero-length take.
	const lines = wrapText("abcdef", 1, 10, "sans", metrics);
	assert.deepEqual(lines, ["a", "b", "c", "d", "e", "f"]);
	assert.equal(lines.join(""), "abcdef", "no glyph is dropped when one glyph overflows the line");
});

test("PDF generation performs zero network I/O", async () => {
	const calls = [];
	const restore = blockNetwork(calls);
	try {
		const bytes = await renderInvoicePdf(invoiceFor({ items: manyItems(60) }), "2026-10-03");
		assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
	} finally {
		restore();
	}
	assert.deepEqual(calls, [], `generation attempted network I/O: ${calls.join(", ")}`);
});

test("renderPdf downloads the bytes under a sanitized name and revokes the object URL", async () => {
	const created = [];
	const saved = [];
	const revoked = [];
	const downloader = {
		createObjectUrl(blob) {
			created.push(blob);
			return "blob:test";
		},
		revokeObjectUrl(url) {
			revoked.push(url);
		},
		save(url, fileName) {
			saved.push([url, fileName]);
		},
	};

	await renderPdf(invoiceFor({ id: "INV-7" }), "2026-10-03", downloader);

	assert.equal(created.length, 1);
	assert.equal(created[0].type, "application/pdf");
	assert.deepEqual(saved, [["blob:test", "invoice-INV-7.pdf"]]);
	assert.deepEqual(revoked, ["blob:test"], "the object URL is always released");
});

test("downloadPdf sanitizes whatever file name a caller hands it, so the download attribute cannot receive an unsanitized name", () => {
	const saved = [];
	const downloader = {
		createObjectUrl: () => "blob:test",
		revokeObjectUrl: () => {},
		save: (url, fileName) => saved.push([url, fileName]),
	};

	downloadPdf(new Uint8Array([1, 2, 3]), "../../etc/passwd%00.png", downloader);

	assert.equal(saved.length, 1);
	const [url, fileName] = saved[0];
	assert.equal(url, "blob:test");
	assert.ok(!fileName.includes("/"), `path separator survived: ${fileName}`);
	assert.ok(!fileName.includes(".."), `parent-directory segment survived: ${fileName}`);
	assert.match(fileName, /^[A-Za-z0-9._-]+$/, `the sink did not fold the name to its safe alphabet: ${fileName}`);
});

test("the shell's real Save as PDF handler runs network-free end to end, deferring the revoke", async () => {
	const calls = [];
	const restoreNetwork = blockNetwork(calls);
	const fake = installInteractiveDocument();
	const created = [];
	const saved = [];
	const revoked = [];
	const originalCreate = URL.createObjectURL;
	const originalRevoke = URL.revokeObjectURL;
	const prototype = globalThis.HTMLElement.prototype;
	URL.createObjectURL = (blob) => {
		created.push(blob);
		return `blob:e2e-${created.length}`;
	};
	URL.revokeObjectURL = (url) => {
		revoked.push(url);
	};
	// The fake document's anchors never navigate; record only the download anchor the renderer builds.
	prototype.click = function click() {
		if (this.hasAttribute("download")) {
			saved.push([this.getAttribute("href"), this.getAttribute("download")]);
		}
	};
	try {
		const shell = mountShell(document.createElement("div"));
		renderRoute(shell, parseHash(`#/i/${encodeInvoice(invoiceFor({ id: "INV-7" }))}`), {
			baseUrl: "https://example.com/app/",
			today: "2026-10-03",
			clipboard: null,
		});
		const save = findButton(shell.content, "Save as PDF");
		assert.ok(save, "the view renders a Save as PDF control");
		save.dispatch("click", { type: "click" });
		await waitFor(() => saved.length > 0 || shell.notice.children.length > 0, SAVE_WAIT_ATTEMPTS);

		assert.deepEqual(saved, [["blob:e2e-1", "invoice-INV-7.pdf"]], "the real renderer downloaded the file");
		assert.equal(created[0].type, "application/pdf");
		assert.deepEqual(revoked, [], "the object URL is not revoked in the same tick as the click");
		await waitFor(() => revoked.length > 0, REVOKE_WAIT_ATTEMPTS);
		assert.deepEqual(revoked, ["blob:e2e-1"], "the object URL is released once the download is under way");
		assert.equal(shell.notice.children.length, 0, "a successful export shows no notice");
	} finally {
		URL.createObjectURL = originalCreate;
		URL.revokeObjectURL = originalRevoke;
		delete prototype.click;
		restoreNetwork();
		fake.restore();
	}
	assert.deepEqual(calls, [], `the real export handler attempted network I/O: ${calls.join(", ")}`);
});

/**
 * The renderer's browser-only module: reached through a dynamic `import()` so a DOM never enters the export's static module graph.
 */
const RENDERER_LAZY_MODULE = "./rasterize.js";

/**
 * The modules the emitted renderer may statically import, each DOM-free: `pdf-lib` writes PDF bytes without a DOM, and the view-model builder reads only the invoice.
 * This is an allow-list rather than a list of the rasterizer's spellings, so any new static import fails whatever its path or spelling — a relative spelling of the rasterizer (`../pdf/rasterize.js` from `app/ts/pdf/renderer.ts` resolves to the same module as `./rasterize.js`), a barrel that re-exports it, or any other module — while the browser-only rasterizer stays out of the renderer's static graph.
 */
const RENDERER_DOM_FREE_STATIC_IMPORTS = [
	"../../js/vendor/pdf-lib/pdf-lib.esm.js",
	"../ui/presentation.js",
];

/** The static import specifiers of `source` that are not on {@link RENDERER_DOM_FREE_STATIC_IMPORTS}: any one of them may reach the browser-only rasterizer. */
function offendingStaticImports(source) {
	const allowed = new Set(RENDERER_DOM_FREE_STATIC_IMPORTS);
	return staticImportSpecifiers(source).filter((specifier) => !allowed.has(specifier));
}

/** The browser-only rasterizer, workspace-relative: the module no static path from the emitted renderer may reach. */
const RASTERIZER_MODULE = "app/js/pdf/rasterize.js";

test("the renderer references no external resource and no network API", () => {
	const source = readFileSync(join(root, "app/ts/pdf/renderer.ts"), "utf8");
	const emitted = readFileSync(join(root, "app/js/pdf/renderer.js"), "utf8");
	assert.ok(
		!/\b(fetch|XMLHttpRequest|WebSocket|EventSource|importScripts|sendBeacon)\b/.test(source),
		"the renderer must not reach the network",
	);
	assert.ok(!/https?:\/\//.test(source), "the renderer must not name an absolute URL");
	assert.ok(!/<svg/i.test(source), "the letterhead is drawn, not loaded as SVG");
	// The emitted module is the authority on the renderer's static graph: the compiler erases every type-only import, so a static value import is exactly what the emitted file would still carry, and the fresh-build comparison is what holds the committed emitted file to the source it came from.
	assert.deepEqual(
		offendingStaticImports(emitted),
		[],
		"the emitted renderer statically imports only DOM-free modules, so no static import — the rasterizer's or any barrel that reaches it — can pull a DOM module into its graph",
	);
	assert.match(emitted, /await import\("\.\/rasterize\.js"\)/, "it is reached through a dynamic import, so it loads only for an export that carries an icon");
	assert.equal(
		staticImportReach("app/js/pdf/renderer.js").has(RASTERIZER_MODULE),
		false,
		"no static path reaches the browser-only rasterizer, directly or through any emitted module the renderer imports, so the dynamic import is its only route",
	);
});

test("the renderer's static-import guard reports any module outside its DOM-free allow-list, whatever the spelling", () => {
	for (const [source, specifier] of [
		[`import { rasterizeSvgIcon } from "${RENDERER_LAZY_MODULE}";`, RENDERER_LAZY_MODULE],
		[`import { rasterizeSvgIcon } from '${RENDERER_LAZY_MODULE}';`, RENDERER_LAZY_MODULE],
		[`import "${RENDERER_LAZY_MODULE}";`, RENDERER_LAZY_MODULE],
		[`export { rasterizeSvgIcon } from "${RENDERER_LAZY_MODULE}";`, RENDERER_LAZY_MODULE],
		[`require("${RENDERER_LAZY_MODULE}")`, RENDERER_LAZY_MODULE],
		// The same module by another path: from `app/ts/pdf/renderer.ts`, `../pdf/rasterize.js` resolves to the same file as `./rasterize.js`, so a guard keyed on one specifier misses it.
		[`import { rasterizeSvgIcon } from "../pdf/rasterize.js";`, "../pdf/rasterize.js"],
		// A barrel that re-exports the rasterizer: the renderer imports only the barrel, so a guard keyed on the rasterizer's own specifier never sees it.
		[`import { rasterizeSvgIcon } from "./icon-raster-barrel.js";`, "./icon-raster-barrel.js"],
	]) {
		assert.deepEqual(offendingStaticImports(source), [specifier], `a static import outside the allow-list is reported: ${source}`);
	}
	assert.deepEqual(
		offendingStaticImports(`import { PDFDocument } from "${RENDERER_DOM_FREE_STATIC_IMPORTS[0]}";`),
		[],
		"an allow-listed module is not reported",
	);
	assert.deepEqual(offendingStaticImports(`await import("${RENDERER_LAZY_MODULE}")`), [], "a dynamic import is not a static one");
	assert.deepEqual(offendingStaticImports(`const load = () => import('${RENDERER_LAZY_MODULE}')`), [], "nor a dynamic import spelled with a single-quoted specifier");
});

test("the renderer's static-import guard reaches a rasterizer hidden behind an allow-listed module", () => {
	// A synthetic emitted graph: the renderer imports only the allow-listed view-model builder, which imports the browser-only rasterizer, so the direct-specifier allow-list stays green while the transitive walk reaches it.
	const graph = new Map([
		["app/js/pdf/renderer.js", "import { buildInvoiceViewModel } from \"../ui/presentation.js\";"],
		["app/js/ui/presentation.js", "import { rasterizeSvgIcon } from \"../pdf/rasterize.js\";"],
		["app/js/pdf/rasterize.js", "export const rasterizeSvgIcon = 1;"],
	]);
	const read = (file) => graph.get(file) ?? null;
	assert.deepEqual(
		offendingStaticImports(graph.get("app/js/pdf/renderer.js")),
		[],
		"the direct-specifier allow-list stays green, which is the gap the closure walk closes",
	);
	assert.ok(
		staticImportReach("app/js/pdf/renderer.js", read).has(RASTERIZER_MODULE),
		"a rasterizer reached through an allow-listed module is still reachable, so the guard fails on it",
	);

	// The same module by a relative spelling resolves to one path, so the walk is not fooled by how the edge is written.
	const spelled = new Map([
		["app/js/pdf/renderer.js", "import { rasterizeSvgIcon } from \"../pdf/rasterize.js\";"],
		["app/js/pdf/rasterize.js", "export const rasterizeSvgIcon = 1;"],
	]);
	assert.ok(
		staticImportReach("app/js/pdf/renderer.js", (file) => spelled.get(file) ?? null).has(RASTERIZER_MODULE),
		"and a relative spelling of the rasterizer resolves to the same module",
	);
});

test("the static-import walk fails closed rather than passing vacuously on a target it cannot read", () => {
	// A missing entry module would otherwise leave the closure empty and let the rasterizer-unreachability assertion hold for the wrong reason.
	assert.throws(
		() => staticImportReach("app/js/pdf/renderer.js", () => null),
		/not a readable file/,
		"an entry the walk cannot read fails the test rather than yielding an empty closure",
	);

	// An extensionless specifier resolves to a path that is not the `.js` module, so the walk must report it rather than treat it as a leaf.
	const extensionless = new Map([
		["app/js/pdf/renderer.js", 'import { rasterizeSvgIcon } from "./rasterize";'],
	]);
	assert.throws(
		() => staticImportReach("app/js/pdf/renderer.js", (file) => extensionless.get(file) ?? null),
		/not a readable file/,
		"an extensionless specifier is resolved and its unreadable target fails the walk instead of reading as a leaf",
	);

	// The real reader refuses a directory target with `null` rather than throwing `EISDIR` incidentally, which the walk then turns into the failure above.
	assert.equal(readEmittedModule("app/js/pdf"), null, "a directory target is refused rather than read");
});

test("a privacy-chain invoice draws its payment link and the symbol of that same URI", () => {
	const invoice = zecInvoice();
	const link = buildPaymentLink(invoice);
	assert.equal(link.uri.startsWith("zcash:"), true, "the invoice's own scheme builds the link");

	const view = buildInvoiceViewModel(invoice, "2026-10-03");
	assert.equal(view.paymentLink, link.uri, "the view model carries that one URI");
	const pages = buildInvoicePages(view, METRICS);
	assert.equal(pages.length, 1);
	assert.equal(textOps(pages[0]).join("").includes(link.uri), true, "the drawn text carries the whole URI, as the one run the address and the link are drawn as");

	assertSymbolCells(pages[0], view);
});

test("the symbol is drawn inside its quiet zone, in the block the layout places it in", () => {
	const view = buildInvoiceViewModel(zecInvoice(), "2026-10-03");
	const pages = buildInvoicePages(view, METRICS);
	assert.equal(pages.length, 1);
	const modules = moduleFills(pages[0]);
	assert.equal(modules.length, view.paymentQr.size * view.paymentQr.size);

	// The block the layout declares: the symbol's own side inside the configured quiet zone, its right edge on the section's content edge, and its top on the line the payment terms start at.
	// The block's own left edge and bottom edge are entailed by those three figures together with the block's side — the symbol's own side plus one quiet zone on each side — so they are not asserted a second time here.
	const quiet = QR_SYMBOL.quietModules * QR_SYMBOL.module;
	const symbolSide = view.paymentQr.size * QR_SYMBOL.module;
	const blockTop = paymentBlockTop(pages[0], view);
	// The drawn symbol, in the same top-down coordinates: the bounding box of its own modules, which is what every figure the layout declares is checked against.
	const drawn = Object.freeze({
		left: Math.min(...modules.map((op) => op.x)),
		right: Math.max(...modules.map((op) => op.x + op.width)),
		top: PAGE.height - Math.max(...modules.map((op) => op.y + op.height)),
	});

	assertClose(drawn.right - drawn.left, symbolSide, "the drawn modules span the symbol's own side");
	assertClose(drawn.right + quiet, CONTENT_RIGHT, "the drawn symbol's right edge stands one quiet zone inside the content edge the layout aligns it to");
	assertClose(drawn.top - quiet, blockTop, "the drawn symbol's top edge stands one quiet zone below the block's top");
	// The insets above read the renderer's own figures, so a change to either would move the drawing and the expectation together; what they have to be is the documented 2.5-point module and the standard's own four-module quiet zone.
	assertClose(
		drawn.right + quiet,
		drawnRightEdge(pages[0], view.labels.amount.toUpperCase()),
		"the drawn symbol's right edge stands one quiet zone inside the column edge the document itself draws — the right-aligned column header — rather than a figure recomputed from the renderer's constants",
	);
	assert.equal(QR_SYMBOL.module, 2.5, "the configured module size is the documented 2.5 points");
	assert.equal(QR_SYMBOL.quietModules, 4, "the configured quiet zone is the standard's four modules");
});

test("the widest symbol the link layer can produce fits the payment section whole", async () => {
	const address = unifiedOfBytes(189);
	const invoice = zecInvoice({
		payee: { name: "Studio Example", address },
		items: [line({ quantity: "1", unitPrice: fromBaseUnits(UINT256_MAX, 8) })],
	});
	const view = buildInvoiceViewModel(invoice, "2026-10-03");
	assert.equal(view.paymentQr.size, 77, "a version-15 symbol is the widest the layout has to carry");

	// The section this fixture measures is mostly the monospace face — the 311-character payee value and the 404-character link — and the stand-in measures a half em per glyph where Courier measures 0.6, so the two metric sets compress those runs to different scales and the section is checked both ways.
	// The export's own metrics are measured here too, so the page count, the single holder, and the bounds below describe the section production renders rather than a narrower one.
	const exported = await exportFontMetrics();
	for (const [fixture, metrics] of [
		["the half-em stand-in", METRICS],
		["the export's own metrics", exported],
	]) {
		const pages = buildInvoicePages(view, metrics);
		// The widest symbol's block together with the copy values drawn below it is taller than the room the page they would otherwise share leaves, so the section is moved whole onto a page of its own and the symbol lands there with it.
		assert.equal(pages.length, 2, `${fixture}: the tall payment section is moved whole onto its own page`);
		const holders = pages.filter((page) => moduleFills(page).length > 0);
		assert.equal(holders.length, 1, `${fixture}: the symbol is measured onto one page, never split across a break`);
		const modules = moduleFills(holders[0]);
		assert.equal(modules.length, 77 * 77, `${fixture}: the whole symbol is drawn`);
		for (const op of modules) {
			assert.ok(op.y + op.height <= PAGE.height, `${fixture}: the symbol escapes the page vertically`);
		}
		// The section's own content column, read off the rule that opens it — the two-point ink rule drawn nearest above the block — rather than recomputed from the renderer's private width constants, so a section drawn elsewhere moves this bound with it.
		const blockTop = paymentBlockTop(holders[0], view);
		const opening = sectionRuleAbove(holders[0], blockTop);
		// The block `drawPayment` reserves for the symbol, in the same top-down coordinates as the drawn modules: the symbol's bounding box grown by one quiet zone on every side.
		const quiet = QR_SYMBOL.quietModules * QR_SYMBOL.module;
		const block = Object.freeze({
			left: Math.min(...modules.map((op) => op.x)) - quiet,
			right: Math.max(...modules.map((op) => op.x + op.width)) + quiet,
		});
		const symbolBlockBottom = PAGE.height - (Math.min(...modules.map((op) => op.y)) - quiet);
		assertClose(block.right, opening.x2, `${fixture}: the widest symbol's block ends on the payment section's own content edge`);
		assert.ok(block.left > opening.x1, `${fixture}: the symbol's block must stay inside the section's content column: ${block.left} <= ${opening.x1}`);
		// The terms column as drawn: the widest text line that shares the symbol's own vertical band, which the block has to clear.
		// A copy value drawn below that band is no part of this bound — it takes the section's whole content width on a line of its own, which is what holds an address or a link on one line, and the symbol has ended by then.
		const sharesSymbolBand = (op) => PAGE.height - op.y - op.size * BASELINE_ASCENT < symbolBlockBottom - 1e-9;
		const terms = textDraws(holders[0]).filter((op) => insidePaymentBlock(op, blockTop) && sharesSymbolBand(op));
		assert.ok(terms.length > 0, `${fixture}: the payment block draws no term line to measure`);
		const termsRight = Math.max(...terms.map((op) => op.x + metrics.widthOfText(op.text, op.size, op.font)));
		assert.ok(termsRight <= block.left, `${fixture}: the terms column reaches ${termsRight} into the symbol's block, which starts at ${block.left}`);
		// What follows is a self-check of the section's own reservation rather than independent coverage: `drawPayment` checks the header and the whole block onto a page before it draws either, so this bound holds by construction and cannot fail without that reservation changing.
		// What pins the bounce is the page count and the single holder asserted above; a fixture tuned to land a point or two above the floor would assert float luck rather than intent.
		assert.ok(symbolBlockBottom <= FLOOR_TOP, `${fixture}: the symbol's block must stay above the page's content floor: ${symbolBlockBottom} > ${FLOOR_TOP}`);
	}
});

test("the values a payer copies out of the payment details are drawn as single unbroken runs", async () => {
	// What a payer copies out of the export is the text run a value was drawn as, so a value broken at the margin reaches a wallet's field with a line break inside it — not the address, and not the URI.
	// Every value the payment details offer for copying is therefore drawn as exactly one run — held to the line by the horizontal scale `fitCopyValue` fits it with when the section's width cannot hold it as it stands — and the values the cases below look for are the invoice's own rather than a wrapper around them.
	for (const [fixture, invoice] of [
		["an Ethereum invoice", ethInvoice()],
		["an ERC-20 invoice", invoiceFor()],
		["a Monero invoice", xmrInvoice()],
		["a transparent Zcash invoice", zecInvoice({ payee: { name: "Studio Example", address: ZEC_TRANSPARENT_PAYEE } })],
	]) {
		const view = buildInvoiceViewModel(invoice, "2026-10-03");
		const pages = buildInvoicePages(view, METRICS);
		const runs = pages.flatMap((page) => textDraws(page));
		const amount = view.payment.find((term) => term.label === view.labels.amount);
		assert.ok(amount !== undefined, `${fixture}: the payment details state the amount`);

		// The amount, the address, and the link are the section's monospace values: each is a value a wallet takes verbatim, drawn as one unbroken run in the one face.
		for (const value of [amount.value, invoice.payee.address, view.paymentLink]) {
			const drawn = runs.filter((op) => op.font === "mono" && op.text === value);
			assert.equal(drawn.length, 1, `${fixture}: ${JSON.stringify(value.slice(0, 16))}… is drawn as one run rather than broken across lines`);
			assert.ok(drawn[0].x >= 0 && drawn[0].x + METRICS.widthOfText(drawn[0].text, drawn[0].size, drawn[0].font) * drawn[0].xScale <= PAGE.width, `${fixture}: and that run, at the scale it is drawn at, stays on the page`);
		}
	}

	// The widest legal values an invoice can carry — the 311-character mainnet unified address this app accepts, and the 404-byte `zcash:` link built from it with a uint256-scale amount — are wider than any line the section holds at a legible size: each is still drawn as exactly one run, compressed horizontally onto the section's own content width, so what a payer copies out of the document is the value itself, character for character and with no break inside it.
	const widest = zecInvoice({
		payee: { name: "Studio Example", address: unifiedOfBytes(189) },
		items: [line({ quantity: "1", unitPrice: fromBaseUnits(UINT256_MAX, 8) })],
	});
	const widestView = buildInvoiceViewModel(widest, "2026-10-03");
	const copyValues = widestView.payment.filter((term) => term.verbatim === true).map((term) => term.value);
	const linkValue = widestView.paymentLink;
	assert.equal(copyValues.length, 3, "the section draws three copy values for this invoice: the amount, the address, and the link");
	assert.equal(copyValues[2], linkValue, "and the widest legal link is the last of them");
	assert.equal(linkValue.length, 404, "the one a 311-character address and a uint256-scale amount build");

	// The scale a value is drawn at is the width the section leaves over the width the value measures, and the stand-in and the export's own metrics measure a monospace glyph differently, so the section is checked under both.
	const exported = await exportFontMetrics();
	for (const [fixture, metrics] of [
		["the half-em stand-in", METRICS],
		["the export's own metrics", exported],
	]) {
		const pages = buildInvoicePages(widestView, metrics);
		const runs = pages.flatMap((page) => textDraws(page)).filter((op) => op.font === "mono");
		assert.deepEqual(runs.map((op) => op.text), copyValues, `${fixture}: each copy value is drawn as one run, in the order the terms state them, and no character is dropped`);
		const page = pages.find((candidate) => textDraws(candidate).some((op) => op.text === linkValue));
		assert.ok(page !== undefined, `${fixture}: the widest link is drawn on a page`);
		const opening = sectionRuleAbove(page, paymentBlockTop(page, widestView));
		const sectionWidth = opening.x2 - opening.x1;
		for (const op of runs) {
			assert.ok(op.size >= PAYMENT_VALUE_MIN_SIZE, `${fixture}: a copy value was set at ${op.size}, below the ${PAYMENT_VALUE_MIN_SIZE}-point floor`);
			assert.ok(op.xScale <= 1, `${fixture}: a copy value is never stretched past its natural width`);
			assertClose(op.x, opening.x1, `${fixture}: a copy value the terms' column cannot hold starts on the payment section's own content edge`);
			const drawn = metrics.widthOfText(op.text, op.size, op.font) * op.xScale;
			assert.ok(drawn <= sectionWidth + 1e-9, `${fixture}: and never overruns that content width`);
			if (op.xScale < 1) assertClose(op.x + drawn, opening.x2, `${fixture}: a value too wide to hold at the floor is compressed to exactly the section's content width`);
		}
		// The address and the link are the two values wider than the section at the floor, so they are the two it compresses; the amount is short enough to be drawn at its natural width.
		assert.deepEqual(runs.filter((op) => op.xScale < 1).map((op) => op.text), [copyValues[0], linkValue], `${fixture}: the address and the link are the compressed values`);
	}

	// The figure itself, for the widest value this app can produce: the 404-byte link measures 1454.4 points at the 6-point floor in Courier's own 0.6-em advance, against the section's 504-point content width, so it is drawn at about 35% of its natural width — the smallest scale any legal invoice asks for, every other family's address and link being shorter.
	const widestLink = buildInvoicePages(widestView, exported)
		.flatMap((page) => textDraws(page))
		.find((op) => op.font === "mono" && op.text === linkValue);
	assert.ok(widestLink !== undefined, "the widest link is drawn with the export's own metrics");
	assert.equal(widestLink.size, PAYMENT_VALUE_MIN_SIZE, "set at the floor, since no larger size holds it as it stands");
	assert.ok(widestLink.xScale > 0.34 && widestLink.xScale < 0.35, `the widest legal link is compressed to ${widestLink.xScale.toFixed(4)} of its natural width`);
});

/**
 * Every page's content stream, decoded, in page order: the operators the exported bytes carry, which is what a PDF reader hands back when the document's text is selected.
 * The artifact holds each stream Flate-compressed, so it is inflated through pdf-lib's own decoder — the library the export wrote it with — rather than through a second implementation of the codec.
 */
async function contentStreams(bytes) {
	const doc = await PDFDocument.load(bytes, { updateMetadata: false });
	return doc.getPages().map((page) => {
		const contents = page.node.Contents();
		const refs = contents === undefined ? [] : contents.array ?? [contents];
		return refs
			.map((ref) => Buffer.from(decodePDFRawStream(doc.context.lookup(ref)).decode()).toString("latin1"))
			.join("");
	});
}

/**
 * Every run of text a decoded content stream shows, with the text object it is shown in: the hex string each text-showing operator carries, decoded, and the operators around it — the size, the horizontal scale and the position the run is drawn at.
 * A PDF hands a selection back one text-showing operator at a time, so a value split over two of them is a value with a break inside it wherever the extractor puts the boundary.
 */
function shownRuns(stream) {
	return stream.split("BT").flatMap((object) =>
		[...object.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((match) => ({
			text: Buffer.from(match[1], "hex").toString("latin1"),
			at: match.index,
			object,
		})),
	);
}

/**
 * The operator tokens of one text object of a content stream, in the order the renderer wrote them: one operator per line, each argument ahead of the operator it belongs to.
 * pdf-lib writes a text run as its own text object — the fill color, the font and size, the horizontal scale, the text matrix, then the run's own showing operator — so the numbers a run is drawn with are read off that object rather than recomputed.
 */
function operatorTokens(object) {
	return object.split("\n").flatMap((line) => line.trim().split(" ")).filter((token) => token.length > 0);
}

/**
 * The number the single-number operator `name` carries in a text object, as the layout set it: `12 Tf` is the size, and `50 Tz` the horizontal scale in percent.
 */
function numberFor(object, name) {
	const tokens = operatorTokens(object);
	const at = tokens.indexOf(name);
	assert.ok(at > 0, `the run's own text object sets ${name}`);
	return Number(tokens[at - 1]);
}

/**
 * The x a run's own text matrix places it at: the first of the two translations `1 0 0 1 x y Tm` carries.
 */
function runLeft(object) {
	const tokens = operatorTokens(object);
	const at = tokens.indexOf("Tm");
	assert.ok(at >= 6 && tokens.slice(at - 6, at - 2).join(" ") === "1 0 0 1", "the run's own text object sets its position with a translation");
	return Number(tokens[at - 2]);
}

test("the exported PDF shows each copied value as one text run, so a copy of it carries no break", async () => {
	// The layout's own ops are only a promise about what the renderer will draw; what a payer copies is the text-showing operator the artifact carries, so the widest legal invoice is rendered to real bytes and the streams are read back.
	const widest = zecInvoice({
		payee: { name: "Studio Example", address: unifiedOfBytes(189) },
		items: [line({ quantity: "1", unitPrice: fromBaseUnits(UINT256_MAX, 8) })],
	});
	const view = buildInvoiceViewModel(widest, "2026-10-03");
	const streams = await contentStreams(await renderInvoicePdf(widest, "2026-10-03"));
	const runs = streams.flatMap((stream) => shownRuns(stream));
	const metrics = await exportFontMetrics();

	const amount = view.payment.find((term) => term.label === view.labels.amount).value;
	for (const value of [view.paymentLink, view.payment.find((term) => term.verbatim === true).value]) {
		const own = runs.filter((run) => run.text === value);
		assert.equal(own.length, 1, `${value.length} characters are shown by exactly one text-showing operator`);
		// No second operator carries a run of that same value: a value broken at the margin would leave its head and its tail in two of them, and the value's own operator above is a prefix of itself.
		const pieces = runs.filter((run) => run.text.length >= 20 && value.startsWith(run.text));
		assert.equal(pieces.length, 1, "and no operator carries a piece of it beside that one");

		// The run is set at a legible size and held to the section's content width by the horizontal scale, so the printed line is inside the page and no glyph was given up to fit it.
		const size = numberFor(own[0].object, "Tf");
		const scale = numberFor(own[0].object, "Tz") / 100;
		const x = runLeft(own[0].object);
		assert.ok(size >= PAYMENT_VALUE_MIN_SIZE, `the run is set at ${size}, below the ${PAYMENT_VALUE_MIN_SIZE}-point floor`);
		assert.ok(scale > 0 && scale < 1, `the run is compressed to ${scale} of its natural width`);
		assertClose(x + metrics.widthOfText(value, size, "mono") * scale, CONTENT_RIGHT, "and spans the section's content width exactly, so it is drawn at the one scale that fits it");
	}

	// The amount is the third value a wallet takes verbatim, so the artifact shows it by exactly one operator too; it is short enough to need no compression, so its own text object carries no squeeze operator at all.
	const amountRuns = runs.filter((run) => run.text === amount);
	assert.equal(amountRuns.length, 1, "the amount is shown by exactly one text-showing operator as well");
	assert.equal(amountRuns.filter((run) => /Tz/.test(run.object)).length, 0, "and at its natural width, unlike the two wide values");

	// The scale the artifact itself carries for the widest legal link: the 404 bytes it shows at the 6-point floor are 1454.4 points of Courier, against the section's 504-point content width.
	const link = runs.find((run) => run.text === view.paymentLink);
	assert.ok(link !== undefined, "the widest link is shown");
	assert.equal(numberFor(link.object, "Tf"), PAYMENT_VALUE_MIN_SIZE);
	assert.ok(Math.abs(numberFor(link.object, "Tz") - 34.65346534653465) < 1e-9, `the widest legal link is shown at ${numberFor(link.object, "Tz")}% of its natural width`);
});

test("the payee's Ethereum address is drawn under Payment details, never in the parties section", () => {
	const view = buildInvoiceViewModel(invoiceFor(), "2026-10-03");
	const pages = buildInvoicePages(view, METRICS);
	assert.equal(pages.length, 1);
	const ops = textOps(pages[0]);
	const paymentAt = ops.indexOf("PAYMENT DETAILS");
	assert.ok(paymentAt >= 0, "the layout labels the payment details section");
	assert.ok(
		!ops.slice(0, paymentAt).join("\n").includes(PAYEE),
		"the Ethereum address must not be drawn before Payment details",
	);
	assert.ok(ops.slice(paymentAt).join("\n").includes(PAYEE), "the Ethereum address is still drawn under Payment details");
});

test("a Monero, a transparent Zcash, and an EIP-681 invoice each draw their own link and the symbol of that same URI", () => {
	for (const [fixture, invoice, scheme, uri] of [
		["a Monero invoice", xmrInvoice(), "monero:", `monero:${XMR_PAYEE}?tx_amount=300`],
		["a transparent Zcash invoice", zecInvoice({ payee: { name: "Studio Example", address: ZEC_TRANSPARENT_PAYEE } }), "zcash:", `zcash:${ZEC_TRANSPARENT_PAYEE}?amount=300`],
		["an Ethereum invoice", ethInvoice(), "ethereum:", `ethereum:${PAYEE}@1?value=300000000000000000000`],
	]) {
		const link = buildPaymentLink(invoice);
		assert.equal(link.uri.startsWith(scheme), true, `${fixture}: the invoice's own scheme builds the link`);
		assert.equal(link.uri, uri, `${fixture}: the link spells its address and its amount in that scheme`);

		const view = buildInvoiceViewModel(invoice, "2026-10-03");
		assert.equal(view.paymentLink, link.uri, `${fixture}: the view model carries that one URI`);
		const pages = buildInvoicePages(view, METRICS);
		assert.equal(pages.length, 1);
		const text = textOps(pages[0]).join("");
		assert.equal(text.includes(link.uri), true, `${fixture}: the drawn text carries the whole URI, however it wrapped`);
		assert.equal(text.includes(invoice.payee.address), true, `${fixture}: and the address the URI pays to is drawn with it`);
		assertSymbolCells(pages[0], view);
	}
});

/**
 * The tallest line item a validated invoice can carry, with every field at the cap the model puts on it: the description at `MAX_DESCRIPTION_CHARS` with no space in it — the shape `wrapText` hard-breaks, which packs that fixed column as tightly per character as any arrangement at the cap can — and a quantity at the uint256 base-unit maximum the asset's decimals allow, with a unit price of `1` so the line's amount stays inside that same maximum.
 */
function capMaxItem() {
	return {
		description: "n".repeat(MAX_DESCRIPTION_CHARS),
		quantity: fromBaseUnits(UINT256_MAX, 6),
		unitPrice: "1",
	};
}

test("the model's own caps bound an item row inside a fresh page's capacity", async () => {
	// `drawItemRow` checks the row against the floor only before it takes its break, so a row that outgrew a fresh page would be drawn past the content floor with nothing left to stop it.
	// What holds that closed is the model's own field caps, and this pins them through the layout the export runs.
	const metrics = await exportFontMetrics();
	const capped = buildInvoicePages(buildInvoiceViewModel(invoiceFor({ items: [capMaxItem()] }), "2026-10-03"), metrics);
	const plain = buildInvoicePages(buildInvoiceViewModel(invoiceFor(), "2026-10-03"), metrics);
	const rowHeight = (page) => {
		const bottoms = itemRowBottoms(page);
		assert.equal(bottoms.length, 1, "the fixture draws one item row on the page it lands on");
		return bottoms[0] - firstRowTop(page);
	};
	const rowPages = capped.filter((page) => itemRowBottoms(page).length > 0);
	assert.equal(rowPages.length, 1, "the one row is drawn on exactly one page");
	const plainPage = plain.find((page) => itemRowBottoms(page).length > 0);
	assert.ok(plainPage !== undefined, "the plain invoice draws its own single row");
	const height = rowHeight(rowPages[0]);
	assert.ok(height > rowHeight(plainPage), "the cap-max row is the taller of the two, so it is the case the unchecked break has to survive");

	// The room a fresh page leaves a row: from the closing rule of the header it repeats, down to the content floor nothing may draw past.
	// It is measured off a page that actually opens with that repeated column header rather than composed from the renderer's own top margin and header height, so a change to where a fresh page starts moves this bound with it.
	const spilled = buildInvoicePages(buildInvoiceViewModel(invoiceFor({ items: manyItems(120) }), "2026-10-03"), metrics);
	const freshRowPage = spilled.slice(1).find((page) => itemRowBottoms(page).length > 0);
	assert.ok(freshRowPage !== undefined, "the fixture must spill rows onto a page that opens with the repeated column header");
	const freshPageRoom = FLOOR_TOP - firstRowTop(freshRowPage);
	assert.ok(height <= freshPageRoom, `the ${height.toFixed(1)}-point cap-max row must fit the ${freshPageRoom.toFixed(1)} points a fresh page leaves under its repeated column header`);
	for (const page of capped) {
		for (const bottom of itemRowBottoms(page)) {
			assert.ok(bottom <= FLOOR_TOP, `an item row reaches the page's content floor: ${bottom} > ${FLOOR_TOP}`);
		}
	}
	// The caps are what keeps the bound true, so the fixture pins the relationship rather than a figure: a longer description or a bigger quantity is refused where the invoice is created.
	assert.throws(
		() => invoiceFor({ items: [{ ...capMaxItem(), description: "n".repeat(MAX_DESCRIPTION_CHARS + 1) }] }),
		InvalidInvoiceError,
		"a description past the cap is refused",
	);
	assert.throws(
		() => invoiceFor({ items: [{ ...capMaxItem(), quantity: fromBaseUnits(UINT256_MAX + 1n, 6) }] }),
		InvalidInvoiceError,
		"a quantity past the uint256 maximum is refused",
	);
});

/** The icon every icon case in this file uses: a 64 by 32 SVG, so its own aspect ratio is not the letterhead box's. */
const ICON_SVG = "<svg width=\"64\" height=\"32\" viewBox=\"0 0 64 32\"><rect width=\"64\" height=\"32\" fill=\"#123456\"/></svg>";

/** A real 1 by 1 PNG, so the embed path parses actual image bytes rather than a stand-in. */
const ICON_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");

/**
 * A fake document for the browser-only rasterizer: an `img` that records the source it is given, reports the intrinsic size it is told to, and decodes when the case releases it, and a `canvas` that records its size and the image drawn into it.
 * The rasterizer is the one module that needs a browser, so this is the stub the suite runs it against; nothing here is a real canvas.
 */
function installRasterDocument({ naturalWidth = 64, naturalHeight = 32, decode = async () => {} } = {}) {
	const created = [];
	const drawn = [];
	const blobTypes = [];
	const image = {
		attributes: {},
		setAttribute(name, value) {
			this.attributes[name] = String(value);
		},
		decode,
		naturalWidth,
		naturalHeight,
	};
	const canvas = {
		width: 0,
		height: 0,
		getContext(kind) {
			assert.equal(kind, "2d", "the rasterizer asks for a 2d context");
			return {
				drawImage(source, x, y, width, height) {
					drawn.push({ source, x, y, width, height });
				},
			};
		},
		toBlob(callback, type) {
			blobTypes.push(type);
			callback(new Blob([ICON_PNG], { type }));
		},
	};
	const handle = installDocument({
		createElement(tag) {
			created.push(tag);
			return tag === "img" ? image : canvas;
		},
	});
	return { handle, image, canvas, created, drawn, blobTypes };
}

function imageDraw(stream) {
	const draw = /\/([\w-]+)\s+Do/.exec(stream);
	assert.ok(draw !== null, "the content stream draws an image XObject");
	const matrices = [...stream.slice(0, draw.index).matchAll(/([\d.-]+) 0 0 ([\d.-]+) ([\d.-]+) ([\d.-]+) cm/g)].map((match) =>
		match.slice(1, 5).map(Number),
	);
	const translate = matrices[0];
	const scale = matrices.find((matrix, index) => index > 0 && (matrix[0] !== 1 || matrix[1] !== 1));
	assert.ok(translate !== undefined && scale !== undefined, "the image draw is placed and sized by its own cm matrices");
	return { name: draw[1], x: translate[2], y: translate[3], width: scale[0], height: scale[1] };
}

test("the rasterizer decodes the icon before drawing it, at the icon's own intrinsic size", async () => {
	const fixture = installRasterDocument({ naturalWidth: 64, naturalHeight: 32 });
	try {
		const raster = await rasterizeSvgIcon(svgDataUrl(ICON_SVG));
		assert.equal(fixture.image.attributes.src, svgDataUrl(ICON_SVG), "the image loads the leaf's own data URL, whose bytes the page already carries, so no cross-origin response is drawn and the canvas is never tainted");
		assert.deepEqual(fixture.created, ["img", "canvas"], "the rasterizer builds an image and a canvas, and nothing else");
		assert.deepEqual([fixture.canvas.width, fixture.canvas.height], [64, 32], "the canvas takes the icon's own width and height");
		assert.deepEqual(
			fixture.drawn.map((entry) => [entry.x, entry.y, entry.width, entry.height]),
			[[0, 0, 64, 32]],
			"the whole image is drawn into the canvas at that size",
		);
		assert.deepEqual([...raster.bytes], [...ICON_PNG], "the PNG bytes come back as the canvas encoded them");
		assert.deepEqual([raster.width, raster.height], [64, 32], "and the raster reports the size it was drawn at");
		assert.deepEqual(fixture.blobTypes, ["image/png"], "the canvas is read back as a PNG");
	} finally {
		fixture.handle.restore();
	}
});

test("the rasterizer draws nothing until the image has decoded", async () => {
	let release;
	const decoded = new Promise((resolve) => {
		release = resolve;
	});
	const fixture = installRasterDocument({ decode: () => decoded });
	try {
		const pending = rasterizeSvgIcon(svgDataUrl(ICON_SVG));
		await Promise.resolve();
		await Promise.resolve();
		assert.deepEqual(fixture.drawn, [], "nothing is drawn while the image is still decoding, which is where a blank raster would come from");
		release();
		const raster = await pending;
		assert.equal(fixture.drawn.length, 1, "the draw happens once the decode resolves");
		assert.equal(raster.bytes.length, ICON_PNG.length);
	} finally {
		fixture.handle.restore();
	}
});

test("a raster size the icon does not declare is bounded by the icon's own dimension cap", async () => {
	const fixture = installRasterDocument({ naturalWidth: 0, naturalHeight: 0 });
	try {
		const raster = await rasterizeSvgIcon(svgDataUrl(ICON_SVG));
		assert.deepEqual([raster.width, raster.height], [MAX_ICON_DIMENSION, MAX_ICON_DIMENSION], "an image that reports no intrinsic size is rasterized at the validator's own cap");
		assert.deepEqual([fixture.canvas.width, fixture.canvas.height], [MAX_ICON_DIMENSION, MAX_ICON_DIMENSION], "so the canvas is bounded by the cap rather than by a size of the rasterizer's choosing");
	} finally {
		fixture.handle.restore();
	}
});

test("a decode the browser refuses is a rejection, never a blank raster", async () => {
	const fixture = installRasterDocument({
		decode: async () => {
			throw new Error("decode failed");
		},
	});
	try {
		await assert.rejects(() => rasterizeSvgIcon(svgDataUrl(ICON_SVG)), /decode failed/);
		assert.deepEqual(fixture.drawn, [], "nothing is drawn and no raster is returned");
	} finally {
		fixture.handle.restore();
	}
});

test("the rasterizer refuses a value that is not the icon leaf data URL before it builds anything", async () => {
	const fixture = installRasterDocument();
	try {
		await assert.rejects(() => rasterizeSvgIcon("data:text/html,<script>alert(1)</script>"), /rasterize:/);
		assert.deepEqual(fixture.created, [], "no image is built for a value the guard refuses");
	} finally {
		fixture.handle.restore();
	}
});

test("an icon invoice embeds one image XObject at the letterhead, and an icon-less export never rasterizes", async () => {
	const raster = { bytes: ICON_PNG, width: 1, height: 1 };
	const asked = [];
	const rasterizer = {
		async rasterize(svg) {
			asked.push(svg);
			return raster;
		},
	};
	const invoice = invoiceFor({ icon: ICON_SVG });

	const bytes = await renderInvoicePdf(invoice, "2026-10-03", rasterizer);
	assert.deepEqual(asked, [svgDataUrl(ICON_SVG)], "the renderer hands the rasterizer the view model's prepared data URL");
	const doc = await PDFDocument.load(bytes, { updateMetadata: false });
	const images = imageXObjects(doc);
	assert.equal(images.length, 1, "the icon is embedded exactly once");
	assert.deepEqual([images[0].width, images[0].height], [1, 1], "the embedded image is the rasterizer's own PNG, read back from the artifact");

	// The artifact draws that image where the layout placed it: the letterhead's own left edge and top, sized to the box the layout reserved, and before the wordmark it stands beside.
	const layout = buildInvoicePages(buildInvoiceViewModel(invoice, "2026-10-03"), METRICS, raster);
	const op = layout[0].ops.find((entry) => entry.kind === "image");
	assert.ok(op !== undefined, "the layout places the icon in the letterhead");
	assert.equal(layout[0].ops[0], op, "the icon is the first thing the letterhead draws");
	const draw = imageDraw((await contentStreams(bytes))[0]);
	assertClose(draw.x, op.x, "the artifact draws the icon at the x the layout placed it at");
	assertClose(draw.y, op.y, "and at the y the layout placed it at");
	assertClose(draw.width, op.width, "in the width the layout reserved");
	assertClose(draw.height, op.height, "and the height it reserved");
	assertClose(op.x, PAGE.marginX, "the icon takes the letterhead's left content edge");
	assertClose(PAGE.height - (op.y + op.height), PAGE.marginTop, "and its top edge is the letterhead's own top");
	const brand = layout[0].ops.find((entry) => entry.kind === "text" && entry.text === "Invoicing");
	assert.ok(brand !== undefined && brand.x >= op.x + op.width, "the wordmark starts after the icon's box rather than under it");

	const plain = await renderInvoicePdf(invoiceFor(), "2026-10-03");
	assert.equal(imageXObjects(await PDFDocument.load(plain, { updateMetadata: false })).length, 0, "an icon-less invoice embeds no image");
	const unused = {
		async rasterize() {
			throw new Error("the icon-less export must not rasterize");
		},
	};
	// Byte stability is asserted for the icon-less case alone: an icon invoice embeds the browser canvas encoder's PNG bytes, which two encoders need not produce identically.
	assert.deepEqual(await renderInvoicePdf(invoiceFor(), "2026-10-03", unused), plain, "an icon-less export never reaches the rasterizer, and it is the case whose bytes are stable, so they are the ones it always produced");
});

test("the embedded-image count covers every page, not the first one", async () => {
	// What the count answers is a statement about the whole artifact — whether the icon is embedded exactly once — so an image on a later page has to be found: an artifact whose only image sits on page 2 reads as an icon-less one to a reader that stops at page 0.
	const doc = await PDFDocument.create({ updateMetadata: false });
	doc.addPage([PAGE.width, PAGE.height]);
	const second = doc.addPage([PAGE.width, PAGE.height]);
	second.drawImage(await doc.embedPng(ICON_PNG), { x: 10, y: 10, width: 1, height: 1 });

	const reopened = await PDFDocument.load(await doc.save(), { updateMetadata: false });
	assert.equal(reopened.getPageCount(), 2, "the fixture really carries two pages");
	assert.equal(imageXObjects(reopened).length, 1, "the image on page 2 is counted rather than passed over as absent");
});

test("an XObject two pages share is one embedded image, not two", async () => {
	// The reader keys its entries by the reference each page's resource dict names, so one embedding referenced from two pages is one image; a reader that counted per page would report this artifact as carrying the image twice.
	const doc = await PDFDocument.create({ updateMetadata: false });
	const png = await doc.embedPng(ICON_PNG);
	const first = doc.addPage([PAGE.width, PAGE.height]);
	const second = doc.addPage([PAGE.width, PAGE.height]);
	first.drawImage(png, { x: 10, y: 10, width: 1, height: 1 });
	second.drawImage(png, { x: 10, y: 10, width: 1, height: 1 });

	const reopened = await PDFDocument.load(await doc.save(), { updateMetadata: false });
	assert.equal(reopened.getPageCount(), 2, "the fixture really carries two pages");
	const images = imageXObjects(reopened);
	assert.equal(images.length, 1, "the one image both pages draw is one embedding");
	assert.deepEqual([images[0].width, images[0].height], [1, 1], "and it is the PNG both pages reference");
});

test("the icon the letterhead draws stays inside the page, as every other op does", async () => {
	// The stub stands in for the browser-only rasterizer, which bun has no canvas for, so the icon draw path is exercised without one.
	const raster = { bytes: ICON_PNG, width: 64, height: 32 };
	const rasterizer = {
		async rasterize() {
			return raster;
		},
	};
	const invoice = invoiceFor({ icon: ICON_SVG });
	const bytes = await renderInvoicePdf(invoice, "2026-10-03", rasterizer);
	assert.equal(imageXObjects(await PDFDocument.load(bytes, { updateMetadata: false })).length, 1, "the seam's raster is the image the export embeds");

	const view = buildInvoiceViewModel(invoice, "2026-10-03");
	const pages = buildInvoicePages(view, METRICS, raster);
	const icons = pages.flatMap((page) => page.ops).filter((op) => op.kind === "image");
	assert.equal(icons.length, 1, "the letterhead draws exactly one icon");
	assertOpsWithinPage(pages, METRICS);
});

test("a rasterizer that fails is a rejection with no PDF bytes behind it", async () => {
	const failing = {
		async rasterize() {
			throw new Error("no canvas");
		},
	};
	await assert.rejects(() => renderInvoicePdf(invoiceFor({ icon: ICON_SVG }), "2026-10-03", failing), /no canvas/);
});

test("a raster with a non-positive or non-finite axis is refused at the layout entry point, for the export and for a direct caller", async () => {
	for (const [width, height] of [
		[0, 32],
		[64, 0],
		[Number.NaN, 32],
		[64, Number.POSITIVE_INFINITY],
	]) {
		const raster = { bytes: ICON_PNG, width, height };
		const rasterizer = {
			async rasterize() {
				return raster;
			},
		};
		await assert.rejects(
			() => renderInvoicePdf(invoiceFor({ icon: ICON_SVG }), "2026-10-03", rasterizer),
			/pixels, which is not a positive finite size/,
			`the export refuses a ${width}x${height} raster rather than dividing the icon box to undefined geometry`,
		);
		// The exported pure layout takes the raster directly, so it must enforce the same invariant without the export's seam.
		const view = buildInvoiceViewModel(invoiceFor({ icon: ICON_SVG }), "2026-10-03");
		assert.throws(
			() => buildInvoicePages(view, METRICS, raster),
			/pixels, which is not a positive finite size/,
			`the direct layout refuses a ${width}x${height} raster rather than dividing the icon box to undefined geometry`,
		);
	}
});
