/** The suite for `app/js/pdf/renderer.js`: that the exported bytes reopen as one US Letter page carrying the project's metadata and every figure the invoice shows. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { encodeInvoice } from "../app/js/invoice/codec.js";
import { createInvoice } from "../app/js/invoice/model.js";
import { PDFDocument } from "../app/js/vendor/pdf-lib/pdf-lib.esm.js";
import { parseHash } from "../app/js/app/router.js";
import { mountShell, renderRoute } from "../app/js/app/shell.js";
import {
	PAGE,
	buildInvoicePages,
	invoiceFileName,
	renderInvoicePdf,
	renderPdf,
	toPdfText,
	wrapText,
} from "../app/js/pdf/renderer.js";
import { buildInvoiceViewModel } from "../app/js/ui/presentation.js";
import { installInteractiveDocument } from "./helpers/dom.mjs";
import { blockNetwork } from "./helpers/network-block.mjs";
import { findButton, textOf } from "./helpers/tree.mjs";
import { waitFor } from "./helpers/wait.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAYEE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

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
	return page.ops.filter((op) => op.kind === "text").map((op) => op.text);
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
	const view = buildInvoiceViewModel(
		invoiceFor({
			payee: { name: "Studio Example", address: "0x1111111111111111111111111111111111111111" },
			items: [line({ quantity: "1", unitPrice: NINES })],
		}),
		"2026-10-03",
	);
	const pages = buildInvoicePages(view, METRICS);
	const entries = pages.flatMap((page) => textOps(page));

	assert.ok(!entries.some((entry) => entry.includes("...")), "no value is re-drawn elided with an ellipsis");
	const nines = entries.join("").split("9").length - 1;
	assert.equal(
		nines,
		NINES.length * 4,
		"every digit of the unit price, amount, subtotal and total survives — the PDF shows the screen's number",
	);
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

test("a large invoice renders to multiple real PDF pages", async () => {
	const small = await renderInvoicePdf(invoiceFor(), "2026-10-03");
	const large = await renderInvoicePdf(invoiceFor({ id: "INV-BIG", items: manyItems(120) }), "2026-10-03");
	assert.equal((await PDFDocument.load(small)).getPageCount(), 1);
	assert.ok((await PDFDocument.load(large)).getPageCount() > 1, "a 120-line invoice spills past one page");
});

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

	for (const page of pages) {
		for (const op of page.ops) {
			if (op.kind === "text") {
				const width = METRICS.widthOfText(op.text, op.size, op.font);
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

test("the renderer references no external resource and no network API", () => {
	const source = readFileSync(join(root, "app/ts/pdf/renderer.ts"), "utf8");
	assert.ok(
		!/\b(fetch|XMLHttpRequest|WebSocket|EventSource|importScripts|sendBeacon)\b/.test(source),
		"the renderer must not reach the network",
	);
	assert.ok(!/https?:\/\//.test(source), "the renderer must not name an absolute URL");
	assert.ok(!/<svg/i.test(source), "the letterhead is drawn, not loaded as SVG");
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
