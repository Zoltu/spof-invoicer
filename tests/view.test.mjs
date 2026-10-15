/** The suite for the invoice view, share dialog, and stylesheets: the rendered document and its view model, the dialog's accessibility, and every reference the page makes. */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { installInteractiveDocument } from "./helpers/dom.mjs";
import { PAYEE, XMR_PAYEE, ZEC_PAYEE, ZEC_TRANSPARENT_PAYEE } from "./helpers/payee-vectors.mjs";
import { assertSymbolCellsInDom } from "./helpers/qr-dom.mjs";
import { readSymbol } from "./helpers/qr-reader.mjs";
import { findAll, hasClass, inputValues, paymentValues, walk, textOf } from "./helpers/tree.mjs";
import { unifiedOfBytes } from "./helpers/unified-address.mjs";
import { SUPPORTED_CHAIN_IDS } from "../app/js/assets/registry.js";
import { encodeInvoice } from "../app/js/invoice/codec.js";
import { MAX_EMAIL_CHARS, createInvoice } from "../app/js/invoice/model.js";
import { buildPaymentLink } from "../app/js/payment/links.js";
import { parseHash } from "../app/js/app/router.js";
import { mountShell, renderRoute } from "../app/js/app/shell.js";
import { buildInvoiceViewModel, formatInvoiceDate, invoiceStatus, money } from "../app/js/ui/presentation.js";
import { buildShareBundle, createShareDialog, openShareDialog } from "../app/js/ui/share.js";
import { UNSUPPORTED_WALLET_MESSAGE as FROM_MESSAGES } from "../app/js/ui/messages.js";
import { CHAIN_NAMES, chainName, requireNamedNetworks } from "../app/js/ui/network-labels.js";
import { UNSUPPORTED_WALLET_MESSAGE } from "../app/js/ui/pay.js";
import { renderInvoiceView } from "../app/js/ui/view.js";
import { UINT256_MAX, fromBaseUnits } from "../app/js/util/decimal.js";
import { encodeQr } from "../app/js/util/qr.js";
import { svgDataUrl } from "../app/js/util/svg-data-url.js";
import { MAX_ZCASH_ADDRESS_LENGTH } from "../app/js/wallet/zcash-address.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const VIEW_OPTIONS = { baseUrl: "https://example.com/app/", today: "2026-10-03", clipboard: null };

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

function noticeRecorder() {
	const calls = [];
	return {
		calls,
		showNotice(message, tone) {
			calls.push({ message, tone });
		},
		clearNotice() {
			calls.push(null);
		},
	};
}

function byText(node, tag, text) {
	return findAll(node, (child) => child.tagName === tag && textOf(child) === text);
}

function dialogNode(handle) {
	return findAll(handle.element, (node) => hasClass(node, "dialog"))[0];
}

function drain() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

test("the invoice view renders an official document with id, dates, parties, and totals", () => {
	const fake = installInteractiveDocument();
	try {
		const invoice = invoiceFor({
			id: "INV-7",
			due: "2026-11-02",
			payee: { name: "Studio Example", address: PAYEE, email: "billing@example.com" },
			payer: { name: "Client Co" },
			tax: { label: "VAT 19%", rate: "19" },
			notes: "Thanks for your business.\nPayment due within 30 days.",
		});
		const view = renderInvoiceView(invoice, { ...VIEW_OPTIONS, notice: noticeRecorder() });

		assert.equal(view.tagName, "section");
		assert.ok(hasClass(view, "view-invoice"));
		assert.equal(findAll(view, (node) => hasClass(node, "invoice-document")).length, 1);

		const text = textOf(view);
		for (const fragment of [
			"INV-7",
			"3 Oct 2026",
			"2 Nov 2026",
			"Studio Example",
			"billing@example.com",
			"Client Co",
			"Design work",
			"VAT 19%",
			"Total due",
			"357 USDC",
			"Payment details",
			"Ethereum (0x1)",
			"Thanks for your business.",
		]) {
			assert.ok(text.includes(fragment), `the document is missing ${JSON.stringify(fragment)}`);
		}

		assert.equal(findAll(view, (node) => hasClass(node, "invoice-item-row")).length, 1);
		assert.equal(byText(view, "a", "← New invoice")[0]?.attributes.href, "#/create");

		assert.equal(byText(view, "button", "Save as PDF").length, 1);
		const pay = byText(view, "button", "Pay")[0];
		assert.ok(pay, "the Pay control is present");
		assert.equal(pay.attributes.disabled, "", "Pay is disabled until the wallet flow is wired");

		const badge = findAll(view, (node) => hasClass(node, "status-badge"))[0];
		assert.equal(textOf(badge), "Payment due");
		assert.ok(hasClass(badge, "status-due"));
	} finally {
		fake.restore();
	}
});

test("the invoice document has one top-level heading with section headings nested beneath it", () => {
	const fake = installInteractiveDocument();
	try {
		const view = renderInvoiceView(invoiceFor({ notes: "Thanks." }), { ...VIEW_OPTIONS, notice: noticeRecorder() });
		const document = findAll(view, (node) => hasClass(node, "invoice-document"))[0];
		const headings = findAll(document, (node) => /^h[1-6]$/.test(node.tagName));

		assert.deepEqual(
			headings.map((node) => [node.tagName, textOf(node)]),
			[
				["h1", "Invoice"],
				["h2", "Notes and terms"],
				["h2", "Payment details"],
			],
			"the outline starts at the document kind, with each section nested under it",
		);
	} finally {
		fake.restore();
	}
});

test("the disabled Pay control exposes its reason as visible, described text", () => {
	const fake = installInteractiveDocument();
	try {
		const view = renderInvoiceView(invoiceFor(), { ...VIEW_OPTIONS, notice: noticeRecorder() });
		const pay = byText(view, "button", "Pay")[0];
		assert.equal(pay.attributes.disabled, "");
		assert.ok(!("title" in pay.attributes), "a disabled, unfocusable control cannot rely on a title tooltip");

		const describedBy = pay.attributes["aria-describedby"];
		assert.ok(describedBy, "the control points at its reason");
		const note = findAll(view, (node) => node.attributes.id === describedBy)[0];
		assert.ok(note, `no element carries the described id ${describedBy}`);
		assert.match(textOf(note), /wallet/, "the reason names the missing wallet flow");
	} finally {
		fake.restore();
	}
});

test("the invoice view renders hostile invoice text as inert text children", () => {
	const fake = installInteractiveDocument();
	try {
		const hostile = "<img src=x onerror=\"alert(1)\"><script>alert(2)</script>";
		const invoice = invoiceFor({
			payee: { name: hostile, address: PAYEE },
			items: [line({ description: hostile, quantity: "1", unitPrice: "1" })],
		});
		const view = renderInvoiceView(invoice, { ...VIEW_OPTIONS, notice: noticeRecorder() });

		const tags = [];
		walk(view, (node) => tags.push(node.tagName));
		for (const tag of ["script", "img", "svg"]) {
			assert.ok(!tags.includes(tag), `hostile text produced a <${tag}> element`);
		}
		assert.ok(textOf(view).includes(hostile), "the hostile text is present, unchanged, as text");
		for (const node of findAll(view, () => true)) {
			const handlers = Object.keys(node.attributes).filter((name) => name.startsWith("on"));
			assert.deepEqual(handlers, [], `a hostile attribute reached the DOM: ${handlers.join(", ")}`);
		}
	} finally {
		fake.restore();
	}
});

test("the presentation module derives the shared view model both renderers consume", () => {
	const invoice = invoiceFor({
		due: "2026-11-02",
		payee: { name: "Studio Example", address: PAYEE, email: "billing@example.com" },
		tax: { label: "VAT 19%", rate: "19" },
		notes: "Thanks for your business.\nPayment due within 30 days.",
	});
	const model = buildInvoiceViewModel(invoice, "2026-10-03");

	assert.equal(model.documentNumber, "#INV-1");
	assert.deepEqual(model.status, { label: "Payment due", tone: "due" });
	assert.equal(model.symbol, "USDC");
	assert.equal(model.subtotal, "300 USDC");
	assert.equal(model.tax.value, "57 USDC");
	assert.equal(model.total, "357 USDC");
	assert.deepEqual(model.from.email, ["billing@example.com"], "the party's contact info is exposed as the lines the party block draws, one per line");
	assert.deepEqual(model.dates, [
		{ label: "Issued", value: "3 Oct 2026" },
		{ label: "Due", value: "2 Nov 2026" },
	]);
	assert.equal(model.lines[0].amount, "300 USDC");
	assert.deepEqual(model.notes, ["Thanks for your business.", "Payment due within 30 days."]);
	assert.deepEqual(model.payment[1], { label: "Network", value: "Ethereum (0x1)" });
	assert.deepEqual(model.payment[2], { label: "Pays to", value: PAYEE, verbatim: true }, "the address a wallet takes verbatim is marked by the one flag the screen, the print twin, and the PDF all key on");
	assert.deepEqual(model.payment[3], { label: "Amount", value: "357", verbatim: true }, "the amount is stated as the bare decimal a wallet's amount field takes");
	assert.deepEqual(model.payment[4], { label: "Payment link", value: model.paymentLink, verbatim: true }, "and the link carries that same one flag");
	const link = buildPaymentLink(invoice);
	assert.equal(model.paymentLink, link.uri, "the view model states the URI by name, as the invoice's own scheme builds it");
	assert.equal(
		model.payment.find((term) => term.label === model.labels.paymentLink).value,
		model.paymentLink,
		"and the Payment link term displays that same named value",
	);
	// The amount the link carries is exposed on it, and the document reads that one value rather than recomputing the total: the printed Total due, the Amount term a payer copies, and the figure the URI's own field spells are three readings of one value.
	const carried = link.amount;
	assert.equal(carried.text, "357", "the amount the link carries is the bare decimal the document shows");
	assert.equal(carried.units, 357000000n, "and the same total in the token's own base units");
	assert.equal(model.total, `${carried.text} ${model.symbol}`, "the document's Total due is that value, not a second recomputation of it");
	assert.equal(model.payment[3].value, carried.text, "and so is the Amount term a payer copies");
	assert.equal(model.paymentLink.endsWith(`=${carried.units}`), true, "while the URI's own amount field is that value in the token's base units");
	assert.equal(model.paymentQr.size, encodeQr(link.uri).size, "with the symbol the encoder makes of it");
	assert.deepEqual(model.paymentQr.modules, encodeQr(model.paymentLink).modules, "and the matrix is module for module the one the named URI encodes");
	assert.equal(readSymbol(model.paymentQr).text, model.paymentLink, "an independent decoder reads the named link text back out of the QR payload, so the visible link and the scannable one cannot diverge");
	assert.equal(model.paymentQr.modules.length, model.paymentQr.size, "a symbol is square");
	assert.ok(Object.isFrozen(model), "the view model is frozen so a renderer cannot mutate it");

	assert.equal(chainName("0x89"), "0x89", "an unnamed chain falls back to its id");
	assert.equal(chainName("constructor"), "constructor", "an inherited prototype member is not read as a chain name");
	assert.equal(chainName("toString"), "toString");
	assert.equal(money({ units: 5n, text: "5" }, "ETH"), "5 ETH");
});

test("every chain the registry supports renders under a friendly name, and one the map leaves out is refused at load", () => {
	for (const chainId of SUPPORTED_CHAIN_IDS) {
		assert.ok(
			Object.prototype.hasOwnProperty.call(CHAIN_NAMES, chainId),
			`the registry supports ${chainId}, which has no CHAIN_NAMES entry and would render as its raw id`,
		);
	}
	// The coverage above is the load-time gate's current state rather than a test-only promise: the display layer refuses to run while a network the registry supports has no name here, so a network cannot be added and quietly render as its raw id.
	assert.doesNotThrow(() => requireNamedNetworks(CHAIN_NAMES, SUPPORTED_CHAIN_IDS), "the shipped map names every supported network");
	assert.throws(
		() => requireNamedNetworks({ "0x1": "Ethereum" }, ["0x1", "zcash"]),
		/network-labels: the registry supports the network "zcash"/,
		"a network the registry supports and the map does not name is refused rather than rendered as its slug",
	);
});

test("the network names have one import path: the leaf that loads neither the link builder nor the encoder", async () => {
	// A second path for a naming-only concern is how the coupling `ui/network-labels.ts` was split out to remove comes back: a panel taking a label from the display module loads the link layer's budget gates and the QR encoder on a wallet-facing path that builds no link and no symbol.
	const presentation = await import("../app/js/ui/presentation.js");
	const labels = await import("../app/js/ui/network-labels.js");
	for (const name of ["CHAIN_NAMES", "chainName", "networkLabel", "requireNamedNetworks"]) {
		assert.equal(Object.hasOwn(presentation, name), false, `ui/presentation.ts exposes ${name}, which gives a naming-only concern a second import path`);
		assert.equal(Object.hasOwn(labels, name), true, `ui/network-labels.ts declares ${name}`);
	}
});

test("formatInvoiceDate renders a deterministic human date and invoiceStatus classifies it", () => {
	assert.equal(formatInvoiceDate("2026-10-03"), "3 Oct 2026");
	assert.equal(formatInvoiceDate("2026-01-09"), "9 Jan 2026");
	assert.equal(formatInvoiceDate("not a date"), "not a date");

	assert.deepEqual(invoiceStatus(invoiceFor(), "2026-10-03"), { label: "Open", tone: "open" });
	assert.deepEqual(invoiceStatus(invoiceFor({ due: "2026-11-02" }), "2026-10-03"), {
		label: "Payment due",
		tone: "due",
	});
	assert.deepEqual(invoiceStatus(invoiceFor({ issued: "2026-09-01", due: "2026-09-30" }), "2026-10-03"), {
		label: "Overdue",
		tone: "overdue",
	});
});

test("Save as PDF hands the invoice to the export handler, or notices when none is wired", () => {
	const fake = installInteractiveDocument();
	try {
		const invoice = invoiceFor();
		const notices = noticeRecorder();
		const exported = [];
		const view = renderInvoiceView(invoice, {
			...VIEW_OPTIONS,
			notice: notices,
			exportPdf: (handed) => exported.push(handed.id),
		});
		byText(view, "button", "Save as PDF")[0].dispatch("click", { type: "click" });
		assert.deepEqual(exported, ["INV-1"]);

		const unwired = renderInvoiceView(invoice, { ...VIEW_OPTIONS, notice: notices });
		byText(unwired, "button", "Save as PDF")[0].dispatch("click", { type: "click" });
		const last = notices.calls.at(-1);
		assert.equal(last.tone, "info");
		assert.match(last.message, /PDF/);
	} finally {
		fake.restore();
	}
});

test("a rejected PDF export is reported through the notice, not thrown", async () => {
	const fake = installInteractiveDocument();
	try {
		const notices = noticeRecorder();
		const view = renderInvoiceView(invoiceFor(), {
			...VIEW_OPTIONS,
			notice: notices,
			exportPdf: async () => {
				throw new Error("kaboom");
			},
		});
		byText(view, "button", "Save as PDF")[0].dispatch("click", { type: "click" });
		await drain();
		const last = notices.calls.at(-1);
		assert.equal(last.tone, "error");
		assert.match(last.message, /kaboom/);
	} finally {
		fake.restore();
	}
});

test("the shell forwards the exportPdf and pay seams into the invoice view", () => {
	const fake = installInteractiveDocument();
	try {
		const shell = mountShell(document.createElement("div"));
		const invoice = invoiceFor();
		const exported = [];
		const paid = [];
		renderRoute(shell, parseHash(`#/i/${encodeInvoice(invoice)}`), {
			...VIEW_OPTIONS,
			exportPdf: (handed) => exported.push(handed.id),
			pay: (handed) => paid.push(handed.id),
		});
		const view = shell.content.children[0];
		const pay = byText(view, "button", "Pay")[0];
		assert.ok(!("disabled" in pay.attributes), "a wired Pay handler enables the control");
		byText(view, "button", "Save as PDF")[0].dispatch("click", { type: "click" });
		pay.dispatch("click", { type: "click" });
		assert.deepEqual(exported, ["INV-1"]);
		assert.deepEqual(paid, ["INV-1"]);
	} finally {
		fake.restore();
	}
});

test("the share dialog copies each string and falls back to selectable text", async () => {
	const fake = installInteractiveDocument();
	try {
		const bundle = buildShareBundle(invoiceFor(), "https://example.com/app/");
		const written = [];
		const dialog = createShareDialog(bundle, { clipboard: { writeText: async (text) => written.push(text) } });
		assert.ok(hasClass(dialog.element, "dialog-backdrop"));

		const copyButtons = byText(dialog.element, "button", "Copy");
		assert.equal(copyButtons.length, 2, "one copy button per share string");
		const statuses = findAll(dialog.element, (node) => hasClass(node, "share-status"));

		copyButtons[0].dispatch("click", { type: "click" });
		await drain();
		assert.equal(statuses[0].textContent, "Copied");
		assert.deepEqual(written, [bundle.url]);

		const offline = createShareDialog(bundle, { clipboard: null });
		const offlineButtons = byText(offline.element, "button", "Copy");
		const offlineStatuses = findAll(offline.element, (node) => hasClass(node, "share-status"));
		const field = findAll(offline.element, (node) => node.tagName === "input")[0];
		let selected = 0;
		field.select = () => {
			selected += 1;
		};
		offlineButtons[0].dispatch("click", { type: "click" });
		await drain();
		assert.equal(selected, 1, "the field is selected when the clipboard is unavailable");
		assert.equal(offlineStatuses[0].textContent, "Press Ctrl/Cmd+C to copy");
	} finally {
		fake.restore();
	}
});

test("each share status is a live region so a copy confirmation is announced", () => {
	const fake = installInteractiveDocument();
	try {
		const dialog = createShareDialog(buildShareBundle(invoiceFor(), "https://example.com/app/"), { clipboard: null });
		const statuses = findAll(dialog.element, (node) => hasClass(node, "share-status"));
		assert.equal(statuses.length, 2);
		for (const status of statuses) {
			assert.equal(status.attributes.role, "status", "the copy confirmation must reach assistive tech");
		}
	} finally {
		fake.restore();
	}
});

test("the share dialog labels each value and gives each copy button its own accessible name", () => {
	const fake = installInteractiveDocument();
	try {
		const dialog = createShareDialog(buildShareBundle(invoiceFor(), "https://example.com/app/"), { clipboard: null });
		const node = dialogNode(dialog);
		assert.equal(node.attributes.role, "dialog");
		assert.equal(node.attributes["aria-modal"], "true", "the dialog announces itself as modal");

		const labels = findAll(dialog.element, (entry) => entry.tagName === "label");
		const inputs = findAll(dialog.element, (entry) => entry.tagName === "input");
		assert.equal(labels.length, 2, "one label per share string");
		for (const label of labels) {
			assert.ok(
				inputs.some((input) => input.attributes.id === label.attributes.for),
				`label ${label.attributes.for} does not name an input`,
			);
		}
		const copyButtons = byText(dialog.element, "button", "Copy");
		const names = copyButtons.map((button) => button.attributes["aria-label"]);
		assert.equal(new Set(names).size, 2, `copy buttons share an accessible name: ${names.join(", ")}`);
	} finally {
		fake.restore();
	}
});

test("the share dialog presents two explained options with their copy controls", () => {
	const fake = installInteractiveDocument();
	try {
		const dialog = createShareDialog(buildShareBundle(invoiceFor(), "https://example.com/app/"), { clipboard: null });
		const options = findAll(dialog.element, (node) => hasClass(node, "share-option"));
		assert.equal(options.length, 2, "the dialog presents exactly two options");
		const titles = findAll(dialog.element, (node) => hasClass(node, "share-option-title")).map((node) => textOf(node));
		assert.deepEqual(titles, ["Option 1 — Share the link", "Option 2 — Share the text (the blob)"]);

		const link = textOf(options[0]);
		assert.match(link, /Send this link to the recipient/, "the first option describes sending the link");
		assert.match(link, /your own computer/, "the first option explains the link-only-works-locally caveat");

		const blob = textOf(options[1]);
		assert.match(blob, /pinv1b-/, "the second option names the blob prefix");
		assert.match(blob, /pastes that text into the box at the top of the page/, "and how the recipient uses it");
		assert.match(blob, /with no server in between/, "and why the text keeps working without a server");

		const labels = findAll(dialog.element, (node) => node.tagName === "label").map((node) => textOf(node));
		assert.deepEqual(labels, ["Share link", "Invoice text (blob)"]);
		const inputs = findAll(dialog.element, (node) => node.tagName === "input").map((node) => node.attributes.value);
		assert.ok(inputs[0].includes("#/i/"), "the link option's input holds the URL");
		assert.ok(inputs[1].startsWith("pinv1b-"), "the blob option's input holds the blob");
	} finally {
		fake.restore();
	}
});

test("the share dialog closes on Escape, the close control, and a backdrop click", () => {
	const fake = installInteractiveDocument();
	try {
		const bundle = buildShareBundle(invoiceFor(), "https://example.com/app/");

		let closed = 0;
		const dialog = createShareDialog(bundle, {
			onClose: () => {
				closed += 1;
			},
		});
		dialog.element.dispatch("keydown", { type: "keydown", key: "Escape" });
		assert.equal(closed, 1);
		dialog.element.dispatch("keydown", { type: "keydown", key: "Escape" });
		dialog.close();
		assert.equal(closed, 1, "close is idempotent");

		let closedByKey = 0;
		const other = createShareDialog(bundle, {
			onClose: () => {
				closedByKey += 1;
			},
		});
		other.element.dispatch("keydown", { type: "keydown", key: "a" });
		assert.equal(closedByKey, 0, "only Escape closes");

		let closedByButton = 0;
		const byButton = createShareDialog(bundle, {
			onClose: () => {
				closedByButton += 1;
			},
		});
		findAll(byButton.element, (node) => hasClass(node, "dialog-close"))[0].dispatch("click", { type: "click" });
		assert.equal(closedByButton, 1);

		let closedByBackdrop = 0;
		const byBackdrop = createShareDialog(bundle, {
			onClose: () => {
				closedByBackdrop += 1;
			},
		});
		byBackdrop.element.dispatch("click", { type: "click", target: byBackdrop.element });
		assert.equal(closedByBackdrop, 1);
	} finally {
		fake.restore();
	}
});

test("the share dialog keeps Tab focus inside the modal", () => {
	const fake = installInteractiveDocument();
	try {
		const dialog = createShareDialog(buildShareBundle(invoiceFor(), "https://example.com/app/"), { clipboard: null });
		const close = findAll(dialog.element, (node) => hasClass(node, "dialog-close"))[0];
		const done = byText(dialog.element, "button", "Done")[0];

		done.focus();
		assert.equal(document.activeElement, done);
		dialog.element.dispatch("keydown", { type: "keydown", key: "Tab" });
		assert.equal(document.activeElement, close, "Tab from the last control wraps to the first");

		close.focus();
		dialog.element.dispatch("keydown", { type: "keydown", key: "Tab", shiftKey: true });
		assert.equal(document.activeElement, done, "Shift+Tab from the first control wraps to the last");
	} finally {
		fake.restore();
	}
});

test("openShareDialog mounts over the page, hides the background, and restores focus on close", () => {
	const fake = installInteractiveDocument();
	try {
		const trigger = document.createElement("button");
		document.body.append(trigger);
		trigger.focus();
		assert.equal(document.activeElement, trigger);

		const dialog = openShareDialog(buildShareBundle(invoiceFor(), "https://example.com/app/"), { clipboard: null });
		assert.equal(document.body.children.at(-1), dialog.element, "the overlay is mounted on the body");
		assert.equal(document.activeElement, findAll(dialog.element, (node) => hasClass(node, "dialog-close"))[0]);
		assert.equal(trigger.attributes["aria-hidden"], "true", "the obscured page is hidden from assistive tech");
		assert.ok(trigger.hasAttribute("inert"), "the obscured page cannot receive focus");

		dialog.close();
		assert.ok(!document.body.children.includes(dialog.element), "the overlay is removed on close");
		assert.equal(document.activeElement, trigger, "focus returns to the trigger");
		assert.equal(trigger.getAttribute("aria-hidden"), null, "the background aria-hidden is undone");
		assert.ok(!trigger.hasAttribute("inert"), "the temporary inert is dropped");
	} finally {
		fake.restore();
	}
});

test("the invoice totals styles stay scoped to the payer view", () => {
	const invoiceCss = readFileSync(join(root, "app/stylesheets/invoice.css"), "utf8");
	assert.match(invoiceCss, /\.view-invoice \.totals-table \{/);
	assert.ok(!/^\.totals-table\b/m.test(invoiceCss), "an unscoped .totals-table would override the create view's");
	assert.ok(!/^\.totals-due\b/m.test(invoiceCss), "an unscoped .totals-due would leak into the form chrome");
});

test("app.css defines no share-result or share-title rules", () => {
	const appCss = readFileSync(join(root, "app/stylesheets/app.css"), "utf8");
	assert.ok(!appCss.includes(".share-result"), "app.css must not define .share-result rules");
	assert.ok(!appCss.includes(".share-title"), "app.css must not define a .share-title rule");
});

test("the base .view-invoice rule has no max-width", () => {
	const invoiceCss = readFileSync(join(root, "app/stylesheets/invoice.css"), "utf8").replace(
		/\/\*[\s\S]*?\*\//g,
		"",
	);
	assert.ok(
		!/(?:^|[{};,])\s*\.view-invoice\s*(?:,[^{}]*)?\{[^}]*max-width\s*:/.test(invoiceCss),
		"the base .view-invoice rule must not cap its width, even when shared with another selector",
	);
});

test("the base .dialog rule has no width declaration", () => {
	const appCss = readFileSync(join(root, "app/stylesheets/app.css"), "utf8").replace(
		/\/\*[\s\S]*?\*\//g,
		"",
	);
	assert.ok(
		!/(?:^|[{};,])\s*\.dialog\s*(?:,[^{}]*)?\{[^}]*?(?<![\w-])width\s*:/.test(appCss),
		"the base .dialog rule must not declare a width, even when shared with another selector",
	);
});

test("the share row keeps a fixed label, a flexible input, and a content-sized copy column", () => {
	const appCss = readFileSync(join(root, "app/stylesheets/app.css"), "utf8");
	assert.match(
		appCss,
		/\.share-row \{\s*display: grid;\s*grid-template-columns: 9rem minmax\(0, 1fr\) auto;/,
		"the share row is a fixed label, a shrinkable input, and a content-sized control",
	);
	assert.match(
		appCss,
		/@media \(max-width: 640px\) \{[\s\S]*?\.share-row \{\s*grid-template-columns: minmax\(0, 1fr\);/,
		"the share row collapses to one column on small screens",
	);
});

test("index.html links the local stylesheets and icon with no external reference", () => {
	const html = readFileSync(join(root, "app/index.html"), "utf8");
	assert.match(html, /<link rel="stylesheet" href="stylesheets\/app\.css">/);
	assert.match(html, /<link rel="stylesheet" href="stylesheets\/invoice\.css">/);
	assert.match(html, /<link rel="stylesheet" href="stylesheets\/print\.css">/);
	assert.ok(!/print\.css" media="print"/.test(html), "print.css is gated once, by its own @media print");
	assert.match(html, /<link rel="icon"[^>]*href="images\/favicon\.svg">/);
	assert.ok(!/https?:\/\//.test(html), "the page must not reference an external resource");
});

test("the invoice letterhead uses the local logo image", () => {
	const invoiceCss = readFileSync(join(root, "app/stylesheets/invoice.css"), "utf8");
	assert.match(invoiceCss, /url\("\.\.\/images\/logo\.svg"\)/, "the letterhead uses the local logo");
	assert.match(
		invoiceCss,
		/\.letterhead-icon \{\n\tdisplay: inline-block;\n\twidth: var\(--letterhead-mark\);\n\theight: var\(--letterhead-mark\);\n\tflex: 0 0 auto;\n\tobject-fit: contain;\n\}/,
		"and the payee's own icon is sized by the shared-document stylesheet",
	);
	assert.match(
		invoiceCss,
		/\.invoice-letterhead \{\n\t--letterhead-mark: 3rem;/,
		"at the one size the brand mark beside it draws at too",
	);
});

test("the create form's icon preview is a fixed box with the image fitted inside it", () => {
	const appCss = readFileSync(join(root, "app/stylesheets/app.css"), "utf8");
	assert.match(
		appCss,
		/\.icon-preview-slot \{\n\tdisplay: flex;\n\twidth: 3rem;\n\theight: 3rem;\n\}/,
		"the preview slot is a bounded box whatever size the icon file declares",
	);
	assert.match(
		appCss,
		/\.icon-preview \{\n\twidth: 100%;\n\theight: 100%;\n\tobject-fit: contain;\n\}/,
		"and the preview is scaled to fit inside it rather than rendered at the file's own size",
	);
});

test("print.css gates itself to print and keeps the document whole", () => {
	const printCss = readFileSync(join(root, "app/stylesheets/print.css"), "utf8");
	assert.match(printCss, /@media print/);
	assert.match(printCss, /@page/);
	assert.match(printCss, /break-inside: avoid/);
	assert.ok(!/Cmd\/Ctrl\+P/.test(printCss), "the comment must not mistake Save as PDF for browser print");
});

test("a printed payment value is the whole value, wrapped rather than clipped", () => {
	// The print path is the one surface where a payment value can reach paper shortened: the on-screen value is held on one non-wrapping run, which a print engine clips at the column's edge, and the copy control beside it — the only affordance that hands over the complete string — is chrome print.css hides, so a Zcash unified address or the link carrying it would print as the prefix that fitted.
	const address = unifiedOfBytes(189);
	assert.equal(address.length, MAX_ZCASH_ADDRESS_LENGTH, "the fixture is the widest address the Zcash validator accepts");
	const invoice = zecInvoice({
		payee: { name: "Studio Example", address },
		items: [line({ quantity: "1", unitPrice: fromBaseUnits(UINT256_MAX, 8) })],
	});
	const model = buildInvoiceViewModel(invoice, "2026-10-03");
	assert.equal(model.paymentLink.length, 404, "and the link it pays by is the widest one a legal invoice builds");

	const fake = installInteractiveDocument();
	try {
		const view = renderInvoiceView(invoice, { ...VIEW_OPTIONS, notice: noticeRecorder() });
		const payment = findAll(view, (node) => hasClass(node, "invoice-payment"))[0];
		const printed = findAll(payment, (node) => hasClass(node, "payment-value-print"));
		const amount = model.payment.find((term) => term.label === model.labels.amount).value;
		assert.deepEqual(
			printed.map((node) => textOf(node)),
			[address, amount, model.paymentLink],
			"each value a wallet takes verbatim carries a print presentation of the value itself, the amount, the address, and the link alike",
		);
		const values = paymentValues(payment);
		assert.deepEqual(values, [address, amount, model.paymentLink], "and the values the screen draws hold those same strings, each as text rather than a form control's value");
		assert.deepEqual(inputValues(payment), [], "so no payment value is a form control, and a select-all of the section carries the text a payer reads");
		assert.equal(values.length, printed.length, "and every value the screen draws carries a twin that takes its place in print");
		// A value the print path could not show whole would arrive here shortened, with the clipper's own annotation appended — the failure this presentation exists to prevent.
		printed.forEach((node, index) => {
			assert.doesNotMatch(textOf(node), /\(\d+ characters\)/, "no printed payment value is a clip's annotated prefix");
			assert.equal(textOf(node), values[index], "the print presentation is the value's own string, not a second rendering of it");
		});

		// The swap is the stylesheets' whole contract for the print surface, so both halves are asserted where a print engine reads them: the value is dropped and the twin is shown with a property that lets a value longer than the column break inside itself.
		const printCss = readFileSync(join(root, "app/stylesheets/print.css"), "utf8");
		const dropped = /\.payment-value-verbatim \{([^}]*)\}/.exec(printCss)?.[1];
		assert.ok(dropped !== undefined, "print.css states what happens to the on-screen value a print engine would clip");
		assert.match(dropped, /display:\s*none/, "and drops it, so no printed value is a clipped run");
		assert.doesNotMatch(printCss, /\.payment-value\s*\{/, "while the plain values of terms no wallet takes verbatim stay in the printed document");
		const twin = /\.payment-value-print \{([^}]*)\}/.exec(printCss)?.[1];
		assert.ok(twin !== undefined, "print.css states how the print presentation is shown");
		assert.match(twin, /display:\s*(?:block|inline)/, "and shows it in the dropped value's place");
		assert.match(
			twin,
			/overflow-wrap:\s*(?:anywhere|break-word)|word-break:\s*break-all/,
			"with the property that breaks a value wider than the column inside itself rather than overflowing it",
		);
		assert.doesNotMatch(twin, /white-space:\s*nowrap|overflow(?:-[xy])?\s*:\s*(?:hidden|clip)/, "and with nothing that holds it on one line or clips it");
		const screenTwin = /\.payment-value-print \{([^}]*)\}/.exec(readFileSync(join(root, "app/stylesheets/invoice.css"), "utf8"))?.[1];
		assert.ok(screenTwin !== undefined, "invoice.css declares the print presentation too, so the two are swapped rather than both drawn");
		assert.match(screenTwin, /display:\s*none/, "which is hidden on screen, where the value and its copy control are the presentation");
	} finally {
		fake.restore();
	}
});

/**
 * Every `.payment-qr` rule a stylesheet declares, labelled with the at-rule it sits inside and its own selector, so an invariant named for the symbol's card is checked everywhere the property could be written rather than only in the first matching block.
 */
function paymentQrRules(css, stylesheet) {
	const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const rules = [];
	for (const match of stripped.matchAll(/(@media[^{]*\{\s*)?([^{}]*?\.payment-qr[^{}]*?)\s*\{([^{}]*)\}/g)) {
		const query = (match[1] ?? "").trim().replace(/\{$/, "").trim();
		rules.push({ where: [stylesheet, query, match[2].trim()].filter((part) => part !== "").join(" "), body: match[3] });
	}
	return rules;
}

test("the screen's symbol derives its quiet zone from one declared module size, which the print rules leave alone", () => {
	const invoiceCss = readFileSync(join(root, "app/stylesheets/invoice.css"), "utf8");
	const printCss = readFileSync(join(root, "app/stylesheets/print.css"), "utf8");
	const rules = [...paymentQrRules(invoiceCss, "invoice.css"), ...paymentQrRules(printCss, "print.css")];
	const card = rules.find((rule) => rule.where === "invoice.css .payment-qr")?.body;
	const cell = /\.qr-module \{([^}]*)\}/.exec(invoiceCss)?.[1];
	assert.ok(card !== undefined && cell !== undefined, "the stylesheet declares the symbol's card and its module cells");
	assert.match(card, /--qr-module:\s*3px;/, "the module's size is declared once, on the card its cells inherit it from");
	assert.match(card, /padding:\s*calc\(4 \* var\(--qr-module\)\);/, "the card's padding is the standard's four-module quiet zone, derived from that size");
	assert.match(cell, /width:\s*var\(--qr-module\);/, "a cell takes its width from the declared size");
	assert.match(cell, /height:\s*var\(--qr-module\);/, "and its height");

	// Both invariants are checked against every `.payment-qr` rule in both stylesheets — the screen-scoped step-down and the print rules included — so a clipping overflow, a padding that is not the four-module quiet zone, or a module size raised past the card's is caught wherever it is written rather than only in the first block.
	const base = Number(/--qr-module:\s*([\d.]+)px/.exec(card)?.[1]);
	assert.ok(rules.length >= 3, `both stylesheets' symbol rules are read: ${rules.map((rule) => rule.where).join(", ")}`);
	for (const { where, body } of rules) {
		assert.ok(!/overflow(?:-[xy])?\s*:\s*(?:hidden|clip)\b/.test(body), `${where} must not clip the symbol it holds, so a wider grid grows the card rather than being cut off`);
		const padding = /\bpadding:\s*([^;]+);/.exec(body)?.[1];
		if (padding !== undefined) {
			assert.equal(padding.trim(), "calc(4 * var(--qr-module))", `${where} states the quiet zone as the standard's four modules of the size the card declares`);
		}
		for (const declared of body.matchAll(/--qr-module:\s*([\d.]+)px/g)) {
			assert.ok(Number(declared[1]) <= base, `${where} declares a ${declared[1]}px module, which raises the symbol past the ${base}px the card declares instead of stepping it down`);
		}
	}
	assert.ok(
		rules.some((rule) => rule.where.includes("@media")) && rules.some((rule) => rule.where.startsWith("print.css")),
		`the screen-scoped step-down and the print rules are among the symbol rules read: ${rules.map((rule) => rule.where).join(", ")}`,
	);
	assert.ok(
		!/\.payment-qr[^{}]*\{[^}]*?(?:width|height|padding|--qr-module)\s*:/.test(printCss),
		"print.css must not restate the symbol's geometry, which invoice.css derives from one size",
	);
});

/** The horizontal side padding a one-to-four-value shorthand declares, in rem: the second value is the horizontal one whenever the shorthand has more than one. */
function horizontalRem(rule, where) {
	const declared = /\bpadding:\s*([^;]+);/.exec(rule)?.[1];
	assert.ok(declared !== undefined, `${where} declares a side padding`);
	const values = declared.trim().split(/\s+/);
	assert.ok(values.length <= 4, `${where} declares a side padding this test can read`);
	return remValue(values.length === 1 ? values[0] : values[1], where);
}

/** The number a length in rem declares, with the unit required so that a px or percentage value cannot pass as the column's own figure. */
function remValue(length, where) {
	assert.match(String(length), /^[\d.]+rem$/, `${where} states its length in rem`);
	return Number(String(length).replace(/rem$/, ""));
}

test("the widest symbol the encoder can return fits the document column at the narrowest viewport the stylesheet is laid out for", () => {
	const invoiceCss = readFileSync(join(root, "app/stylesheets/invoice.css"), "utf8");

	// The worst case comes from the encoder rather than from a figure restated here: the version-15 symbol the widest link builds, inside the standard's quiet zone and the card's border.
	const widest = zecInvoice({
		payee: { name: "Studio Example", address: unifiedOfBytes(189) },
		items: [line({ quantity: "1", unitPrice: fromBaseUnits(UINT256_MAX, 8) })],
	});
	const modules = buildInvoiceViewModel(widest, "2026-10-03").paymentQr.size;
	assert.equal(modules, 77, "the worst case is the encoder's own widest symbol");

	// Every `.payment-qr` rule in both stylesheets is read here, so the geometry below cannot be restated behind the card's back: the card is selected by its own label, the step-down by its screen-scoped query, and no other rule may state a module size, the quiet zone, or the border.
	const printCss = readFileSync(join(root, "app/stylesheets/print.css"), "utf8");
	const rules = [...paymentQrRules(invoiceCss, "invoice.css"), ...paymentQrRules(printCss, "print.css")];
	const cardRule = rules.find((rule) => rule.where === "invoice.css .payment-qr");
	assert.ok(cardRule !== undefined, "the stylesheet declares the symbol's card");
	const card = cardRule.body;
	const quietModules = Number(/padding:\s*calc\((\d+) \* var\(--qr-module\)\)/.exec(card)?.[1]);
	const border = Number(/border:\s*(\d+)px solid/.exec(card)?.[1]);
	const base = Number(/--qr-module:\s*([\d.]+)px/.exec(card)?.[1]);
	assert.equal(quietModules, 4, "the card's padding is the standard's four-module quiet zone");
	assert.equal(border, 1, "the card carries a one-pixel border on each side");

	// The module size in force at a viewport: the card's own declaration, narrowed by the screen-scoped small-viewport rule.
	const stepDown = rules.find((rule) => /@media screen and \(max-width: \d+px\)/.test(rule.where) && /--qr-module:/.test(rule.body));
	assert.ok(stepDown !== undefined, "the stylesheet steps the module down for the screen below a declared width");
	const stepDownWidth = Number(/max-width: (\d+)px/.exec(stepDown.where)?.[1]);
	const narrow = Number(/--qr-module:\s*([\d.]+)px/.exec(stepDown.body)?.[1]);
	assert.ok(narrow < base && stepDownWidth >= 320, `the step-down below ${stepDownWidth}px lowers the ${base}px module to ${narrow}px under this test's floor`);
	const moduleAt = (viewport) => (viewport <= stepDownWidth ? narrow : base);
	for (const rule of rules) {
		if (rule === cardRule || rule === stepDown) continue;
		assert.ok(
			!/--qr-module:|\bpadding:|\bborder:\s/.test(rule.body),
			`${rule.where} must not restate the module size, the quiet zone, or the border the arithmetic here reads off the card`,
		);
	}

	// The column the card sits in, read off the two stylesheets' own declarations — the page's max-width and side padding, the document's side padding, and its border — with the browser's 16px root as the rem neither stylesheet restates, so a padding change moves this bound instead of silently narrowing the real column.
	const rem = 16;
	const appCss = readFileSync(join(root, "app/stylesheets/app.css"), "utf8");
	const appRule = /#app \{([^}]*)\}/.exec(appCss)?.[1];
	const documentRule = /\.invoice-document \{([^}]*)\}/.exec(invoiceCss)?.[1];
	const narrowPage = /@media \(max-width: (\d+)px\) \{\s*#app \{([^}]*)\}/.exec(appCss);
	const narrowDocument = /@media \(max-width: (\d+)px\) \{\s*\.invoice-document \{([^}]*)\}/.exec(invoiceCss);
	assert.ok(appRule !== undefined && documentRule !== undefined, "both stylesheets declare the boxes this column is nested in");
	assert.ok(narrowPage !== undefined && narrowDocument !== undefined, "both stylesheets narrow the column's side padding at a small-viewport breakpoint");
	assert.equal(narrowPage[1], narrowDocument[1], "the page and the document narrow their side padding at the same width");
	const paddingBreakpoint = Number(narrowPage[1]);
	const pageMaxWidth = remValue(/max-width:\s*([\d.]+rem)/.exec(appRule)?.[1], "the page's max-width");
	const pagePadding = horizontalRem(appRule, "the page's padding");
	const documentPadding = horizontalRem(documentRule, "the document's padding");
	const narrowPagePadding = horizontalRem(narrowPage[2], "the page's padding below the padding breakpoint");
	const narrowDocumentPadding = horizontalRem(narrowDocument[2], "the document's padding below the padding breakpoint");
	const documentBorder = Number(/border:\s*(\d+)px solid/.exec(documentRule)?.[1]);
	assert.equal(documentBorder, border, "the card's border and the document's are the same declared width");
	const pagePaddingAt = (viewport) => (viewport <= paddingBreakpoint ? narrowPagePadding : pagePadding);
	const documentPaddingAt = (viewport) => (viewport <= paddingBreakpoint ? narrowDocumentPadding : documentPadding);
	const columnAt = (viewport) => Math.min(viewport, pageMaxWidth * rem) - 2 * (pagePaddingAt(viewport) + documentPaddingAt(viewport)) * rem - 2 * documentBorder;

	// 320px is the floor this rests on: neither stylesheet declares a viewport minimum, so the assumption is stated rather than derived — the conventional narrowest mobile width.
	for (const viewport of [320, 360, 361, 480, 640, 641, 1024]) {
		const symbol = (modules + 2 * quietModules) * moduleAt(viewport) + 2 * border;
		assert.ok(
			symbol <= columnAt(viewport),
			`the ${modules}-module symbol measures ${symbol}px at a ${viewport}px viewport, where the document column leaves ${columnAt(viewport)}px`,
		);
	}

	// The step-down earns its place at the floor above: the base module's card is a few pixels wider than the column there, a spill the document's own side padding absorbs rather than clips.
	const baseCard = (modules + 2 * quietModules) * base + 2 * border;
	assert.ok(baseCard > columnAt(320), `the base module's ${baseCard}px card is wider than the ${columnAt(320)}px column a 320px viewport leaves`);
	assert.ok(baseCard - columnAt(320) < documentPaddingAt(320) * rem, `the base module's overshoot stays inside the document's own ${documentPaddingAt(320) * rem}px side padding`);
});

test("the images the page references exist", () => {
	for (const asset of ["logo.svg", "favicon.svg"]) {
		assert.ok(existsSync(join(root, "app/images", asset)), `app/images/${asset} must exist`);
	}
});

test("the itemized table is a named, focusable scroll region", () => {
	const fake = installInteractiveDocument();
	try {
		const view = renderInvoiceView(invoiceFor(), { ...VIEW_OPTIONS, notice: noticeRecorder() });
		const regions = findAll(view, (node) => hasClass(node, "invoice-items-scroll"));
		assert.equal(regions.length, 1);
		const region = regions[0];
		assert.equal(region.attributes.role, "region", "a scrollable region needs a landmark role");
		assert.equal(region.attributes["aria-label"], "Line items", "the region needs an accessible name");
		assert.equal(region.attributes.tabindex, "0", "the region needs a keyboard focus stop");
		assert.equal(
			findAll(region, (node) => hasClass(node, "invoice-items")).length,
			1,
			"the region wraps the itemized table",
		);
	} finally {
		fake.restore();
	}
});

test("the itemized scroll region has a focus ring and the total due uses the accent", () => {
	const invoiceCss = readFileSync(join(root, "app/stylesheets/invoice.css"), "utf8");
	assert.match(
		invoiceCss,
		/\.invoice-items-scroll:focus-visible \{[^}]*outline:/,
		"a focusable region needs a visible focus indicator",
	);
	assert.match(
		invoiceCss,
		/\.view-invoice \.totals-due \.num \{\s*color: var\(--inv-accent\)/,
		"the total due value renders in the accent",
	);
});

test("the payee's Ethereum address renders under Payment details, never under the From party", () => {
	const invoice = invoiceFor({ payee: { name: "Studio Example", address: PAYEE, email: "billing@example.com" } });

	const fake = installInteractiveDocument();
	try {
		const view = renderInvoiceView(invoice, { ...VIEW_OPTIONS, notice: noticeRecorder() });
		const from = findAll(view, (node) => hasClass(node, "party-payee"))[0];
		assert.ok(from, "the From party block is rendered");
		assert.ok(!textOf(from).includes(PAYEE), "the Ethereum address must not render under From");

		const payment = findAll(view, (node) => hasClass(node, "invoice-payment"))[0];
		assert.ok(payment, "the Payment details section is rendered");
		assert.ok(paymentValues(payment).includes(PAYEE), "the Ethereum address still renders under Payment details");
	} finally {
		fake.restore();
	}
});

test("an EVM invoice renders its EIP-681 link and symbol and keeps the wallet Pay control", () => {
	const fake = installInteractiveDocument();
	try {
		const invoice = invoiceFor();
		const view = renderInvoiceView(invoice, { ...VIEW_OPTIONS, notice: noticeRecorder() });
		const link = buildPaymentLink(invoice);
		assert.equal(link.uri.startsWith("ethereum:"), true, "the invoice's own scheme builds the link");
		assert.equal(
			link.uri,
			`ethereum:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48@1/transfer?address=${PAYEE}&uint256=300000000`,
			"the EIP-681 transfer call names the token, the chain, the recipient, and the amount in base units",
		);

		const payment = findAll(view, (node) => hasClass(node, "invoice-payment"))[0];
		assert.ok(paymentValues(payment).includes(link.uri), "the EIP-681 link renders under Payment details");
		const grid = findAll(payment, (node) => hasClass(node, "payment-qr"))[0];
		assert.ok(grid, "the symbol of that same URI is drawn under Payment details");
		assertSymbolCellsInDom(grid, encodeQr(link.uri));
		assert.equal(byText(view, "button", "Pay").length, 1, "and the injected-wallet control is still offered");
		assert.ok(
			!textOf(view).includes(UNSUPPORTED_WALLET_MESSAGE),
			"an invoice the wallet flow can pay is never told there is no wallet to connect",
		);
	} finally {
		fake.restore();
	}
});

/** A native-ETH invoice: the chain's own coin rather than a token, paid to the same payee the other Ethereum fixtures name. */
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

test("a native-ETH invoice renders its own EIP-681 link, the symbol of that URI, and keeps the wallet Pay control", () => {
	const fake = installInteractiveDocument();
	try {
		const invoice = ethInvoice();
		const view = renderInvoiceView(invoice, { ...VIEW_OPTIONS, notice: noticeRecorder() });
		const link = buildPaymentLink(invoice);
		assert.equal(link.uri.startsWith("ethereum:"), true, "the invoice's own scheme builds the link");
		assert.equal(
			link.uri,
			`ethereum:${PAYEE}@1?value=300000000000000000000`,
			"the chain's own coin is asked for as a plain value transfer in wei, not as an ERC-20 transfer call",
		);
		assert.equal(link.uri.includes("/transfer?"), false, "the native spelling carries no transfer call");

		const payment = findAll(view, (node) => hasClass(node, "invoice-payment"))[0];
		assert.ok(payment, "the Payment details section is rendered");
		assert.ok(paymentValues(payment).includes(link.uri), "the EIP-681 link renders under Payment details");

		const model = buildInvoiceViewModel(invoice, "2026-10-03");
		const grid = findAll(payment, (node) => hasClass(node, "payment-qr"))[0];
		assert.ok(grid, "the link's symbol is drawn under Payment details");
		assert.equal(model.paymentQr.size, encodeQr(link.uri).size, "the view model carries the symbol the encoder returns for the same link");
		assert.deepEqual(model.paymentQr.modules, encodeQr(model.paymentLink).modules, "and that matrix is the one the named URI this model displays encodes, module for module");
		assertSymbolCellsInDom(grid, model.paymentQr);
		assert.equal(byText(view, "button", "Pay").length, 1, "and the injected-wallet control is still offered");
	} finally {
		fake.restore();
	}
});

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

test("a privacy-chain invoice offers no wallet Pay control and names its own hand-off", () => {
	const fake = installInteractiveDocument();
	try {
		const view = renderInvoiceView(zecInvoice(), { ...VIEW_OPTIONS, notice: noticeRecorder(), pay: () => {} });
		assert.equal(byText(view, "button", "Pay").length, 0, "no injected-wallet control is offered, even with a handler wired");
		assert.equal(byText(view, "button", "Save as PDF").length, 1, "the rest of the actions are unchanged");

		const hint = findAll(view, (node) => hasClass(node, "field-hint"))[0];
		assert.ok(hint, "the hand-off is named where that control would sit");
		assert.equal(textOf(hint), UNSUPPORTED_WALLET_MESSAGE, "the hint is the message module's own sentence, not a second spelling of it");

		const payment = findAll(view, (node) => hasClass(node, "invoice-payment"))[0];
		assert.ok(paymentValues(payment).includes(ZEC_PAYEE), "the Zcash address renders under Payment details");
		assert.ok(textOf(payment).includes("Zcash"), "and the network renders under its own name");
		assert.equal(textOf(payment).includes("(zcash)"), false, "with no id suffix a wallet would not show, since no wallet reads this app's slug for a privacy chain");

		const link = buildPaymentLink(zecInvoice());
		assert.equal(link.uri.startsWith("zcash:"), true, "the invoice's own scheme builds the link");
		assert.ok(paymentValues(payment).includes(link.uri), "the link renders under Payment details, ready to select and copy");
		assert.ok(paymentValues(payment).includes("300"), "and the amount it asks for sits beside it as its own copyable value");

		const size = encodeQr(link.uri).size;
		const grid = findAll(payment, (node) => hasClass(node, "payment-qr"))[0];
		assert.ok(grid, "the link's symbol is drawn under Payment details");
		assert.equal(grid.attributes["aria-hidden"], "true", "the symbol is decoration beside the link text, not a second statement of it");
		// The grid's DOM cost is read off the view model's own symbol: one element per module, plus one row element per matrix row, so a missing row or a doubled module is visible here rather than only in the stylesheet.
		const model = buildInvoiceViewModel(zecInvoice(), "2026-10-03");
		assert.equal(model.paymentQr.size, size, "the view model carries the symbol the encoder returns for the same link");
		assert.deepEqual(model.paymentQr.modules, encodeQr(model.paymentLink).modules, "and that matrix is the one the named URI this model displays encodes, module for module");
		assert.equal(
			findAll(grid, (node) => hasClass(node, "qr-module")).length,
			model.paymentQr.size ** 2,
			"the grid carries one element per module",
		);
		assert.equal(
			findAll(grid, (node) => hasClass(node, "qr-row")).length,
			model.paymentQr.size,
			"and one row element per matrix row",
		);
		const dark = findAll(grid, (node) => hasClass(node, "qr-module-dark")).length;
		assert.ok(dark > 0 && dark < size * size, "the symbol has dark modules and light ones");
		assertSymbolCellsInDom(grid, model.paymentQr);
		assert.equal(
			findAll(view, (node) => hasClass(node, "field-hint")).length,
			1,
			"the hand-off is stated once, beside the actions whose Pay control this invoice does not get",
		);
		assert.equal(
			findAll(view, (node) => textOf(node) === UNSUPPORTED_WALLET_MESSAGE).length,
			1,
			"the hand-off sentence renders exactly once, so a second inlined copy of it fails here",
		);
	} finally {
		fake.restore();
	}
});

test("the widest symbol the link layer can produce lays out its own matrix, cell for cell", () => {
	const address = unifiedOfBytes(189);
	// Built to the validator's own length bound, which tests/zcash-address.test.mjs pins as the longest address it accepts and one character more as refused, so this is the widest payee address the link layer can be handed.
	assert.equal(address.length, MAX_ZCASH_ADDRESS_LENGTH, "the fixture measures the payout validator's own maximum address length");
	const invoice = zecInvoice({
		payee: { name: "Studio Example", address },
		items: [line({ quantity: "1", unitPrice: fromBaseUnits(UINT256_MAX, 8) })],
	});
	const model = buildInvoiceViewModel(invoice, "2026-10-03");
	assert.equal(model.paymentQr.size, 77, "a version-15 symbol is the widest the layout has to carry");

	const fake = installInteractiveDocument();
	try {
		const view = renderInvoiceView(invoice, { ...VIEW_OPTIONS, notice: noticeRecorder() });
		const grid = findAll(view, (node) => hasClass(node, "payment-qr"))[0];
		assert.ok(grid, "the link's symbol is drawn under Payment details");
		assertSymbolCellsInDom(grid, model.paymentQr);
	} finally {
		fake.restore();
	}
});

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

test("a Monero invoice renders its link and the symbol of that same URI, with no wallet Pay control", () => {
	const fake = installInteractiveDocument();
	try {
		const invoice = xmrInvoice();
		const view = renderInvoiceView(invoice, { ...VIEW_OPTIONS, notice: noticeRecorder(), pay: () => {} });
		assert.equal(byText(view, "button", "Pay").length, 0, "no injected-wallet control is offered, even with a handler wired");
		assert.equal(byText(view, "button", "Save as PDF").length, 1, "the rest of the actions are unchanged");
		const hint = findAll(view, (node) => hasClass(node, "field-hint"))[0];
		assert.ok(hint, "the hand-off is named where that control would sit");
		assert.equal(textOf(hint), UNSUPPORTED_WALLET_MESSAGE, "the hint is the message module's own sentence");

		const payment = findAll(view, (node) => hasClass(node, "invoice-payment"))[0];
		assert.ok(payment, "the Payment details section is rendered");
		assert.ok(paymentValues(payment).includes(XMR_PAYEE), "the Monero address renders under Payment details");
		assert.ok(textOf(payment).includes("Monero"), "and the network renders under its own name");
		assert.equal(textOf(payment).includes("(monero)"), false, "with no id suffix a wallet would not show, since no wallet reads this app's slug for a privacy chain");
		assert.ok(paymentValues(payment).includes("300"), "and the amount it asks for sits beside it as its own copyable value");

		const link = buildPaymentLink(invoice);
		assert.equal(link.uri, `monero:${XMR_PAYEE}?tx_amount=300`, "the Monero link is its own scheme's spelling of the address and the amount");
		assert.ok(paymentValues(payment).includes(link.uri), "and the rendered document carries that whole URI, ready to select and copy");

		const model = buildInvoiceViewModel(invoice, "2026-10-03");
		const grid = findAll(payment, (node) => hasClass(node, "payment-qr"))[0];
		assert.ok(grid, "the link's symbol is drawn under Payment details");
		assert.equal(grid.attributes["aria-hidden"], "true", "the symbol is decoration beside the link text, not a second statement of it");
		assert.equal(model.paymentQr.size, encodeQr(link.uri).size, "the view model carries the symbol the encoder returns for the same link");
		assert.deepEqual(model.paymentQr.modules, encodeQr(model.paymentLink).modules, "and that matrix is the one the named URI this model displays encodes, module for module");
		assertSymbolCellsInDom(grid, model.paymentQr);
	} finally {
		fake.restore();
	}
});
/**
 * The transparent Zcash form the payout validator accepts beside Sapling and unified.
 *
 * An invoice naming one reached no link, view, or PDF assertion before: the shielded and unified spellings carry the other Zcash fixtures, so a transparent payee is rendered here through the same seams.
 */

test("a transparent Zcash payee renders its own ZIP-321 link and the symbol of that same URI, with no wallet Pay control", () => {
	const fake = installInteractiveDocument();
	try {
		const invoice = zecInvoice({ payee: { name: "Studio Example", address: ZEC_TRANSPARENT_PAYEE } });
		const link = buildPaymentLink(invoice);
		assert.equal(link.uri, `zcash:${ZEC_TRANSPARENT_PAYEE}?amount=300`, "a transparent payee reaches the same scheme its family builds");

		const view = renderInvoiceView(invoice, { ...VIEW_OPTIONS, notice: noticeRecorder(), pay: () => {} });
		const payment = findAll(view, (node) => hasClass(node, "invoice-payment"))[0];
		assert.ok(payment, "the Payment details section is rendered");
		assert.ok(paymentValues(payment).includes(ZEC_TRANSPARENT_PAYEE), "the transparent address renders under Payment details");
		assert.ok(paymentValues(payment).includes(link.uri), "beside the link it is paid by, ready to select and copy");

		const model = buildInvoiceViewModel(invoice, "2026-10-03");
		assert.deepEqual(model.paymentQr.modules, encodeQr(link.uri).modules, "and the view model's matrix is the one this displayed URI encodes, module for module");
		const grid = findAll(payment, (node) => hasClass(node, "payment-qr"))[0];
		assert.ok(grid, "the link's symbol is drawn under Payment details");
		assertSymbolCellsInDom(grid, model.paymentQr);
		assert.equal(byText(view, "button", "Pay").length, 0, "a transparent address still gets no injected-wallet control");
	} finally {
		fake.restore();
	}
});

test("the amount, the payee address, and the payment link copy byte for byte, at the widest values a legal invoice carries", async () => {
	// On a Zcash invoice the copy is the payment action: no injected wallet can sign a transfer there, so a value that reached the clipboard clipped or with a line break inside it would be the payment failing rather than a cosmetic slip.
	const address = unifiedOfBytes(189);
	assert.equal(address.length, MAX_ZCASH_ADDRESS_LENGTH, "the fixture is the widest address the Zcash validator accepts");
	const invoice = zecInvoice({
		payee: { name: "Studio Example", address },
		items: [line({ quantity: "1", unitPrice: fromBaseUnits(UINT256_MAX, 8) })],
	});
	const model = buildInvoiceViewModel(invoice, "2026-10-03");
	const written = [];
	const fake = installInteractiveDocument();
	try {
		const view = renderInvoiceView(invoice, {
			...VIEW_OPTIONS,
			notice: noticeRecorder(),
			clipboard: { writeText: async (text) => { written.push(text); } },
		});
		const copies = findAll(view, (node) => hasClass(node, "payment-copy"));
		assert.equal(copies.length, 3, "the amount, the address, and the link each carry a copy control, and no other term does");
		assert.deepEqual(
			copies.map((button) => button.attributes["aria-label"]),
			["Copy Pays to", "Copy Amount", "Copy Payment link"],
			"each control names the term whose value it copies",
		);
		for (const button of copies) button.dispatch("click");
		await drain();

		// The copied string is the value itself rather than a substring of the rendered document: a clip, a strip, or a line break anywhere above the clipboard would show up here as a shorter or altered string.
		assert.deepEqual(written, [address, model.payment[3].value, model.paymentLink], "the clipboard receives each value byte for byte, in the order the terms are shown");
		assert.equal(written[0], model.payment[2].value, "and the first is the very string the address term displays");
		assert.equal(written[1], model.payment[3].value, "the second is the amount term's own wallet-acceptable decimal");
		assert.equal(written[2], model.payment[4].value, "and the third is the string the link term displays");
		assert.equal(written[2], buildPaymentLink(invoice).uri, "so the link a wallet scans and the link the clipboard carries are one string");
		// The copied values are observed against the one value the link carries, so a surface that recomputed what another printed would show up here: the amount is the amount the link asks for, the address is the payee its URI encodes, and the decoded symbol carries the link the clipboard took.
		const link = buildPaymentLink(invoice);
		assert.equal(written[1], link.amount.text, "the copied amount is the amount the link carries");
		assert.equal(model.total, `${link.amount.text} ${model.symbol}`, "which is also the total the document prints");
		assert.equal(written[0], link.payee, "the copied address is the payee the link's URI encodes");
		assert.equal(readSymbol(model.paymentQr).text, written[2], "and an independent decoder reads the copied link back out of the symbol's payload");
		assert.equal(written[2].length, 404, "the widest value a legal ZEC invoice carries: a 311-character address, its scheme prefix, and a uint256-scale amount");
		assert.deepEqual(paymentValues(view), written, "and the values the copy controls read hold those same strings, each as one run of text");
	} finally {
		fake.restore();
	}
});

test("the payment details' terms are labelled from the document's own label set", () => {
	const model = buildInvoiceViewModel(invoiceFor(), "2026-10-03");

	// Each term's label is one of the labels the rest of the document chrome is drawn from, so the section cannot be reworded apart from the label set — and the amount term reads the same label as the item table's column header, which is the label the suite's own lookup of that term goes through.
	assert.deepEqual(
		model.payment.map((term) => term.label),
		[model.labels.asset, model.labels.network, model.labels.paysTo, model.labels.amount, model.labels.paymentLink],
	);
	assert.equal(model.payment[3].label, model.labels.amount, "the section's amount term and the table's Amount column are one label");
	assert.deepEqual(model.payment.map((term) => term.label), ["Asset", "Network", "Pays to", "Amount", "Payment link"], "and the labels a payer reads are unchanged");
});

test("the hand-off sentence is owned by the neutral messages module, not the wallet panel", () => {
	assert.equal(UNSUPPORTED_WALLET_MESSAGE, FROM_MESSAGES, "the panel re-exports the neutral module's own sentence");
	const messages = readFileSync(join(root, "app", "ts", "ui", "messages.ts"), "utf8");
	assert.ok(messages.includes(UNSUPPORTED_WALLET_MESSAGE), "the neutral module is where the sentence is spelled");

	// The document renderer reads the sentence from the neutral module, so its own display text does not depend on the injected-wallet panel's module.
	const view = readFileSync(join(root, "app", "ts", "ui", "view.ts"), "utf8");
	assert.match(view, /from "\.\/messages\.js"/, "the document renderer imports the neutral module");
	assert.ok(!/from "\.\/pay\.js"/.test(view), "and does not import the wallet panel for it");
});

test("the letterhead draws the invoice's own icon, and draws none when it carries none", () => {
	const fake = installInteractiveDocument();
	try {
		const icon = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"48\" height=\"48\"><rect width=\"48\" height=\"48\" fill=\"#0a7\"/></svg>";
		const invoice = invoiceFor({ icon });
		const view = renderInvoiceView(invoice, { ...VIEW_OPTIONS, notice: noticeRecorder() });

		const brand = findAll(view, (node) => hasClass(node, "letterhead-brand"))[0];
		assert.ok(brand, "the letterhead carries its brand block");
		const icons = findAll(brand, (node) => hasClass(node, "letterhead-icon"));
		assert.equal(icons.length, 1, "exactly one icon is drawn there");
		assert.equal(icons[0].tagName, "img");
		assert.equal(icons[0].attributes.src, svgDataUrl(icon), "and it is the leaf's own data URL rather than markup");
		assert.equal(icons[0].attributes.alt, "", "decorative beside the payee's own name");
		assert.equal(buildInvoiceViewModel(invoice, VIEW_OPTIONS.today).iconDataUrl, svgDataUrl(icon), "the view model prepares the value the document draws");

		const bare = renderInvoiceView(invoiceFor(), { ...VIEW_OPTIONS, notice: noticeRecorder() });
		assert.deepEqual(findAll(bare, (node) => hasClass(node, "letterhead-icon")), [], "an icon-less invoice draws none");
		// The icon replaces the default mark rather than accompanying it, so the letterhead draws exactly one of the two, and the wordmark is drawn beside whichever it is.
		assert.deepEqual(findAll(view, (node) => hasClass(node, "invoice-logo")), [], "a supplied icon leaves the default brand mark out of the letterhead");
		assert.equal(
			findAll(brand, (node) => hasClass(node, "letterhead-title")).map((node) => textOf(node))[0],
			"Invoicing",
			"the wordmark is drawn beside the icon",
		);
		const marks = findAll(bare, (node) => hasClass(node, "invoice-logo"));
		assert.equal(marks.length, 1, "an icon-less invoice draws the default brand mark");
		assert.equal(marks[0].tagName, "span", "as the background-image span rather than an image element");
		assert.equal(marks[0].attributes.role, "img");
		assert.equal(marks[0].attributes["aria-label"], "Invoicing brand mark", "and it keeps its accessible name");
		assert.equal(buildInvoiceViewModel(invoiceFor(), VIEW_OPTIONS.today).iconDataUrl, null, "and its view model carries none");
	} finally {
		fake.restore();
	}
});

test("a party's contact info draws one detail line per line, under the party it belongs to", () => {
	const payeeContact = "Studio Example Ltd\n12 Example Street\n+44 20 7946 0000\nbilling@example.com";
	const payerContact = "Accounts\nap@client.example";
	const invoice = invoiceFor({
		payee: { name: "Studio Example", address: PAYEE, email: payeeContact },
		payer: { name: "Client Co", email: payerContact },
	});
	const model = buildInvoiceViewModel(invoice, VIEW_OPTIONS.today);
	assert.deepEqual(model.from.email, payeeContact.split("\n"), "the view model states the payee's contact info as the lines the block draws");
	assert.deepEqual(model.billTo.email, payerContact.split("\n"), "and the bill-to party's the same way");

	const fake = installInteractiveDocument();
	try {
		const view = renderInvoiceView(invoice, { ...VIEW_OPTIONS, notice: noticeRecorder() });
		const payee = findAll(view, (node) => hasClass(node, "party-payee"))[0];
		assert.deepEqual(
			findAll(payee, (node) => hasClass(node, "party-detail")).map((node) => textOf(node)),
			payeeContact.split("\n"),
			"each line is its own detail line rather than one run carrying the line breaks inside it",
		);
		const payer = findAll(view, (node) => hasClass(node, "party-payer"))[0];
		assert.deepEqual(
			findAll(payer, (node) => hasClass(node, "party-detail")).map((node) => textOf(node)),
			payerContact.split("\n"),
			"and the bill-to party's contact lines draw under it",
		);
	} finally {
		fake.restore();
	}

	// The party block is a grid, so each contact line takes a row of its own and the lines stack without a layout rule here; the print path inks them like the rest of the party text.
	const invoiceCss = readFileSync(join(root, "app/stylesheets/invoice.css"), "utf8");
	const party = /^\.party \{([^}]*)\}/m.exec(invoiceCss)?.[1];
	assert.ok(party !== undefined, "invoice.css declares the party block");
	assert.match(party, /display:\s*grid;/, "the party block lays its children out as grid rows, which is what stacks the contact lines");
	assert.match(
		readFileSync(join(root, "app/stylesheets/print.css"), "utf8"),
		/^\t\.party-detail,$/m,
		"print.css forces the contact lines to the same black ink as the rest of the party text",
	);
});

test("a contact line is displayed whole at its widest legal spelling, and the display strip runs line by line", () => {
	// The legacy email spelling is a legal form of the same field, so a line is bounded by that spelling's own cap rather than by the narrower per-line contact bound: a stored address at the cap reaches the document whole.
	const legacy = `${"m".repeat(MAX_EMAIL_CHARS - "@example.com".length)}@example.com`;
	assert.equal(legacy.length, MAX_EMAIL_CHARS);
	const atCap = buildInvoiceViewModel(
		invoiceFor({ payee: { name: "Studio Example", address: PAYEE, email: legacy } }),
		VIEW_OPTIONS.today,
	);
	assert.deepEqual(atCap.from.email, [legacy], "a stored email at the legacy cap is one line, displayed whole");

	// The split comes before the strip, so a format character the validator leaves unrefused is removed from the line that carries it while the line breaks between lines survive.
	const stripped = buildInvoiceViewModel(
		invoiceFor({ payee: { name: "Studio Example", address: PAYEE, email: "Studio \uFFF9Example\nbilling@example.com" } }),
		VIEW_OPTIONS.today,
	);
	assert.deepEqual(
		stripped.from.email,
		["Studio Example", "billing@example.com"],
		"the interlinear-annotation character the validator admits is stripped from its own line",
	);

	const fake = installInteractiveDocument();
	try {
		const view = renderInvoiceView(
			invoiceFor({ payee: { name: "Studio Example", address: PAYEE, email: legacy } }),
			{ ...VIEW_OPTIONS, notice: noticeRecorder() },
		);
		const payee = findAll(view, (node) => hasClass(node, "party-payee"))[0];
		assert.deepEqual(
			findAll(payee, (node) => hasClass(node, "party-detail")).map((node) => textOf(node)),
			[legacy],
			"and the document draws that whole line, with no clip annotation appended to it",
		);
	} finally {
		fake.restore();
	}
});

test("a verbatim payment row is no taller than the value it draws, and an empty status keeps no line", () => {
	// The payment terms are one list, so a row taller than the plain Asset and Network rows around it reads as uneven spacing; the copy control's inherited `.btn` padding and the empty status's reserved full-width line are the two things that would make a verbatim row the taller one.
	const invoiceCss = readFileSync(join(root, "app/stylesheets/invoice.css"), "utf8");
	const appCss = readFileSync(join(root, "app/stylesheets/app.css"), "utf8");
	const value = ruleBody(invoiceCss, ".payment-value");
	const copy = ruleBody(invoiceCss, ".payment-copy");
	const status = ruleBody(invoiceCss, ".payment-status");
	const button = ruleBody(appCss, ".btn");
	assert.ok(
		value !== undefined && copy !== undefined && status !== undefined && button !== undefined,
		"invoice.css declares the value, the copy control, and the status, and app.css the button whose padding the control overrides",
	);

	// The value's line box carries every term in an absolute length, so the mono face of a verbatim term does not compute a shorter line of its own and leave that row below the height of the plain rows.
	const line = declaration(value, "line-height");
	assert.ok(String(line).endsWith("rem"), "the value's line box is stated in rem rather than left to each face's own size");
	const linePx = pxLength(line, ".payment-value line-height");

	// The tallest box on a row sets that row's height, so what has to fit inside the line is the control's whole border box: its face, its leading, its padding, and the border `.btn` declares.
	const face = pxLength(declaration(copy, "font-size"), ".payment-copy font-size");
	const leading = Number(declaration(copy, "line-height"));
	assert.ok(Number.isFinite(leading), "the control's leading is a multiple of its own face, so its box follows from that face");
	const [padding] = String(declaration(copy, "padding")).split(/\s+/);
	const [btnPadding] = String(declaration(button, "padding")).split(/\s+/);
	const [border] = String(declaration(button, "border")).split(/\s+/);
	const control = face * leading + 2 * pxLength(padding, ".payment-copy padding") + 2 * pxLength(border, ".btn border");
	assert.ok(control <= linePx, `the copy control's ${control}px box fits inside the ${linePx}px line its value is drawn on, so it adds no height to its row`);
	assert.ok(
		pxLength(padding, ".payment-copy padding") < pxLength(btnPadding, ".btn padding"),
		"and the padding it is given is shorter than the .btn padding it overrides",
	);

	// The status keeps the full-width line a message needs and gives it up while it is empty, so nothing holds a verbatim row apart from its neighbour before the first copy.
	assert.match(invoiceCss, /\.payment-status \{\n\tflex-basis: 100%;/, "a copied-message states itself on a line of its own rather than reflowing its row");
	assert.match(invoiceCss, /\.payment-status:empty \{\n\tdisplay: none;\n\}/, "and an empty status takes no line at all");

	// Neither affordance is part of the text a payer selects, which is what makes a select-all of the section read one label and one value per line.
	assert.match(
		invoiceCss,
		/\.payment-copy,\n\.payment-status \{\n\tflex: 0 0 auto;\n\tuser-select: none;\n\}/,
		"the copy control and the status are both outside a text selection of the section",
	);
});

/** The declarations of the one rule a stylesheet declares under `selector`, or `undefined` when it declares none: every stylesheet here writes one declaration per line, which is the shape this reads. */
function ruleBody(css, selector) {
	const start = css.indexOf("\n" + selector + " {");
	if (start === -1) return undefined;
	const open = css.indexOf("{", start);
	return css.slice(open + 1, css.indexOf("}", open));
}

/** The value of one `property` declaration in a rule body, or `undefined` when the rule declares none. */
function declaration(body, property) {
	const line = String(body ?? "")
		.split("\n")
		.map((entry) => entry.trim())
		.find((entry) => entry.startsWith(property + ": "));
	return line === undefined ? undefined : line.slice(property.length + 2, -1);
}

/** The 16px root font size a rem resolves against, which the page declares no font size of its own to change. */
const ROOT_FONT_PX = 16;

/** The pixels a stylesheet's `rem` or `px` length states, with the unit required so a length in another unit cannot pass as one. */
function pxLength(length, where) {
	const text = String(length).trim();
	if (text.endsWith("rem")) return Number(text.slice(0, -3)) * ROOT_FONT_PX;
	assert.ok(text.endsWith("px"), `${where} states its length in rem or px, not ${text}`);
	return Number(text.slice(0, -2));
}
