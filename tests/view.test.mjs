/** The suite for the invoice view, share dialog, and stylesheets: the rendered document and its view model, the dialog's accessibility, and every reference the page makes. */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { appliedDeclaration, cssRules, declaration, expectedPrintRung, pxLength, ROOT_FONT_PX, ruleBody, selectorWeight } from "./helpers/css.mjs";
import { installDocument, installInteractiveDocument } from "./helpers/dom.mjs";
import { fakeProbe } from "./helpers/layout-probe.mjs";
import { PAYEE, XMR_PAYEE, ZEC_PAYEE, ZEC_TRANSPARENT_PAYEE } from "./helpers/payee-vectors.mjs";
import { assertSymbolCellsInDom } from "./helpers/qr-dom.mjs";
import { readSymbol } from "./helpers/qr-reader.mjs";
import { findAll, hasClass, inputValues, paymentValues, walk, textOf } from "./helpers/tree.mjs";
import { unifiedOfBytes } from "./helpers/unified-address.mjs";
import { ASSETS, SUPPORTED_CHAIN_IDS } from "../app/js/assets/registry.js";
import { encodeInvoice } from "../app/js/invoice/codec.js";
import { MAX_EMAIL_CHARS, createInvoice } from "../app/js/invoice/model.js";
import { buildPaymentLink } from "../app/js/payment/links.js";
import { parseHash } from "../app/js/app/router.js";
import { mountShell, renderRoute } from "../app/js/app/shell.js";
import { FIT_RUNGS } from "../app/js/ui/fit-value.js";
import { UNSUPPORTED_WALLET_MESSAGE as FROM_MESSAGES, VIEW_BUILD_RELEASE_FAILED_MESSAGE } from "../app/js/ui/messages.js";
import { CHAIN_NAMES, chainName, networkLabel, requireNamedNetworks } from "../app/js/ui/network-labels.js";
import { createOverlay, openOverlay } from "../app/js/ui/overlay.js";
import { openPayPanel, UNSUPPORTED_WALLET_MESSAGE } from "../app/js/ui/pay.js";
import { copyControlClick, renderPaymentSection } from "../app/js/ui/payment-section.js";
import { buildInvoiceViewModel, formatInvoiceDate, invoiceStatus, money } from "../app/js/ui/presentation.js";
import { NOTHING_TO_RELEASE, releasable } from "../app/js/ui/release.js";
import { buildShareBundle, createShareDialog, openShareDialog } from "../app/js/ui/share.js";
import { renderInvoiceView } from "../app/js/ui/view.js";
import { UINT256_MAX, fromBaseUnits } from "../app/js/util/decimal.js";
import { h } from "../app/js/util/dom.js";
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

/** The print rungs an element carries, read off its class attribute: the ladder's print rungs, which are their own table rather than the screen's. */
function printRungs(node) {
	return String(node.attributes.class ?? "")
		.split(" ")
		.filter((name) => name.startsWith("print-fit-"));
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
	const reported = [];
	const consoleError = console.error;
	console.error = (...args) => reported.push(args);
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
		// The notice is the surface the payer reads and assistive technology announces, so it carries the app's one fixed sentence for a failed export and none of the renderer's own words.
		assert.equal(last.message, "PDF export failed. Reload the page and try again.", "the payer reads the app's own sentence for an export that failed");
		assert.doesNotMatch(last.message, /kaboom/, "with none of the failure's internal detail in it");
		// The failure itself is not lost: it is reported where a developer can read it, with the renderer's own error rather than a sentence about one.
		assert.equal(reported.length, 1, "the failure is reported once, off the payer's surface");
		assert.equal(reported[0][1]?.message, "kaboom", "carrying the renderer's own error");
	} finally {
		console.error = consoleError;
		fake.restore();
	}
});

test("a render that throws after its payment section is built releases the section's fitting", () => {
	const fake = installInteractiveDocument();
	const probe = fakeProbe(() => ({ content: 120, box: 240 }));
	const createElement = document.createElement;
	// The article is built after the payment section, so a document that refuses it is a render that throws with the section's fitting already taken and nothing ever mounted for a detach to release it.
	document.createElement = (tag) => {
		if (tag === "article") throw new Error("the article was refused");
		return createElement.call(document, tag);
	};
	try {
		assert.throws(() => renderInvoiceView(invoiceFor(), { ...VIEW_OPTIONS, notice: noticeRecorder(), fit: probe }), /the article was refused/);
		assert.ok(probe.targets.length > 0, "the section took a subscription for each value a wallet takes verbatim before the throw");
		assert.deepEqual(probe.unsubscribed, probe.targets, "and the failed render releases every one of them rather than leaving it watching a document it never built");
	} finally {
		document.createElement = createElement;
		fake.restore();
	}
});

test("the invoice view's element releases the payment section's fitting, and leaves no observer behind", () => {
	const fake = installInteractiveDocument();
	const probe = fakeProbe(() => ({ content: 120, box: 240 }));
	try {
		const view = renderInvoiceView(invoiceFor(), { ...VIEW_OPTIONS, notice: noticeRecorder(), fit: probe });
		assert.equal(typeof view.release, "function", "the document carries its release on the element it returns");
		assert.ok(probe.targets.length > 0, "the section took a subscription for each value a wallet takes verbatim");
		assert.deepEqual(probe.unsubscribed, [], "and holds them while the document stands");
		view.release();
		assert.deepEqual(probe.unsubscribed, probe.targets, "the surface that replaces the document releases every one of them, with no layout report to wait for");
	} finally {
		fake.restore();
	}
});

test("every surface that subscribes carries its release on the element it built", () => {
	// The release travels on the element the surface returns, so a surface that forgot to attach one would leave a live subscription nothing points at: each surface below is asked only for its element, and released through that element.
	const fake = installInteractiveDocument();
	const probe = fakeProbe(() => ({ content: 120, box: 240 }));
	const outstanding = () => probe.targets.length - probe.unsubscribed.length;
	const assertReleased = (label, element) => {
		assert.equal(typeof element.release, "function", `${label} carries its release on the element it returns`);
		assert.ok(outstanding() > 0, `${label} took a subscription`);
		element.release();
		assert.equal(outstanding(), 0, `${label}'s release releases every one of them`);
	};
	try {
		const model = buildInvoiceViewModel(invoiceFor(), VIEW_OPTIONS.today);
		assertReleased("the payment section", renderPaymentSection(model, { fit: probe }));

		// The panel latch records a send by invoice content for the whole run, so this case opens a panel for an invoice no other case pays.
		const panel = openPayPanel(invoiceFor({ id: "INV-RELEASE" }), { notice: noticeRecorder(), clipboard: null, fit: probe });
		assert.ok(panel !== null, "the panel opens for an invoice a wallet can pay");
		assertReleased("the payment panel", panel.element);
		panel.close();

		assertReleased("the invoice view", renderInvoiceView(invoiceFor(), { ...VIEW_OPTIONS, notice: noticeRecorder(), fit: probe }));

		const share = createShareDialog(buildShareBundle(invoiceFor(), VIEW_OPTIONS.baseUrl), { clipboard: null });
		assert.equal(share.element.release, NOTHING_TO_RELEASE, "the share dialog subscribes to nothing and states that rather than leaving a release out");
		share.element.release();

		const wrapped = createOverlay(() => releasable(h("div", { class: "dialog" }), NOTHING_TO_RELEASE));
		assert.equal(typeof wrapped.element.release, "function", "an overlay's element carries the release of the dialog it wraps");
	} finally {
		fake.restore();
	}
});

test("the shell releases the document it replaces, so no subscription outlives its route", () => {
	const fake = installInteractiveDocument();
	const probe = fakeProbe(() => ({ content: 120, box: 240 }));
	const outstanding = () => probe.targets.length - probe.unsubscribed.length;
	try {
		const shell = mountShell(document.createElement("div"));
		renderRoute(shell, parseHash(`#/i/${encodeInvoice(invoiceFor())}`), { ...VIEW_OPTIONS, fit: probe });
		assert.ok(probe.targets.length > 0, "the invoice document took a subscription for each value a wallet takes verbatim");
		assert.equal(outstanding(), probe.targets.length, "and holds them while its route is on screen");

		// A render that throws still takes the route container — the shell shows the failure in it — so the document it replaced is released on that path too, and so is the section the failed render built before it threw.
		const createElement = document.createElement;
		document.createElement = (tag) => {
			if (tag === "article") throw new Error("the article was refused");
			return createElement.call(document, tag);
		};
		try {
			renderRoute(shell, parseHash(`#/i/${encodeInvoice(invoiceFor({ id: "INV-2" }))}`), { ...VIEW_OPTIONS, fit: probe });
		} finally {
			document.createElement = createElement;
		}
		assert.ok(probe.targets.length > 3, "the failed render had taken its own subscriptions before it threw");
		assert.equal(outstanding(), 0, "and every subscription either render took is released rather than left on a document the page no longer holds");

		const held = probe.targets.length;
		renderRoute(shell, parseHash(`#/i/${encodeInvoice(invoiceFor({ id: "INV-3" }))}`), { ...VIEW_OPTIONS, fit: probe });
		assert.ok(probe.targets.length > held, "a route rendered after a failure takes its own subscriptions");
		assert.equal(outstanding(), probe.targets.length - held, "and holds them while it is on screen");
		renderRoute(shell, parseHash("#/create"), { ...VIEW_OPTIONS, fit: probe });
		assert.equal(outstanding(), 0, "and the create route releases them as its own document takes the container");
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

test("a route change dismisses the share dialog the dropped document opened", () => {
	// The share dialog offers the document's own share link, so one left standing over the next document offers a link describing an invoice that is no longer on screen. The shell holds the one modal slot, so navigating away from the document that opened it dismisses it there rather than leaving a document's dialog over another document's page.
	const fake = installInteractiveDocument();
	try {
		const shell = mountShell(document.createElement("div"));
		renderRoute(shell, parseHash(`#/i/${encodeInvoice(invoiceFor())}`), VIEW_OPTIONS);
		const share = byText(shell.content.children[0], "button", "Share")[0];
		assert.ok(share !== undefined, "the document offers its Share control");
		share.dispatch("click", { type: "click" });
		const opened = findAll(document.body, (node) => hasClass(node, "dialog"));
		assert.equal(opened.length, 1, "which opens the share dialog over the page");
		assert.match(textOf(opened[0]), /Share this invoice/, "the dialog for this document's own share strings");

		renderRoute(shell, parseHash("#/create"), VIEW_OPTIONS);
		assert.deepEqual(findAll(document.body, (node) => hasClass(node, "dialog")), [], "a route change dismisses it, so no dialog describes a document the shell has replaced");
	} finally {
		fake.restore();
	}
});

test("an open attempt refused while a dialog stands dismisses that dialog rather than dropping its handle", () => {
	// The panel's entry returns `null` when it refuses to open, and a slot that stored that `null` would forget the dialog still standing over the page: its backdrop would cover the next document and the rows it fitted would never be released.
	const fake = installInteractiveDocument();
	try {
		const shell = mountShell(document.createElement("div"));
		const dialog = openOverlay(() => releasable(h("div", { class: "dialog" }, "the share strings"), NOTHING_TO_RELEASE));
		shell.setOpenDialog(dialog);
		assert.equal(findAll(document.body, (node) => hasClass(node, "dialog-backdrop")).length, 1, "the document's dialog stands over the page");
		shell.setOpenDialog(null);
		assert.deepEqual(findAll(document.body, (node) => hasClass(node, "dialog-backdrop")), [], "and the refused open attempt dismisses it instead of leaving it mounted with no handle holding it");
	} finally {
		fake.restore();
	}
});

test("a second dialog opened while one stands is the one dismissed, so the held dialog keeps its backdrop, its release, and the page it hides", () => {
	// Dismissing the older of two mounted dialogs would undo the background hiding the newer one had just applied, so the newcomer is the one that goes: the slot never loses a live handle, and the page behind the dialog that stays is still hidden from assistive tech and from keyboard focus.
	const fake = installInteractiveDocument();
	try {
		const page = document.createElement("div");
		document.body.append(page);
		const shell = mountShell(page);
		const first = openOverlay(() => releasable(h("div", { class: "dialog" }, "first"), NOTHING_TO_RELEASE));
		const second = openOverlay(() => releasable(h("div", { class: "dialog" }, "second"), NOTHING_TO_RELEASE));
		shell.setOpenDialog(first);
		shell.setOpenDialog(second);
		const standing = findAll(document.body, (node) => hasClass(node, "dialog-backdrop"));
		assert.equal(standing.length, 1, "one dialog stands over the page rather than two");
		assert.match(textOf(standing[0]), /first/, "and it is the one the shell holds, so the newcomer's backdrop is gone rather than orphaned");
		// The newcomer recorded the background as the held dialog had already left it, so dismissing the newcomer writes exactly that back: the page stays hidden behind the dialog still standing, and that dialog's own backdrop stops being hidden.
		assert.equal(page.getAttribute("aria-hidden"), "true", "the page behind the surviving dialog is still hidden from assistive tech");
		assert.ok(page.hasAttribute("inert"), "and still cannot take keyboard focus");
		assert.equal(standing[0].getAttribute("aria-hidden"), null, "while the surviving dialog's own backdrop stops being hidden");
		assert.ok(!standing[0].hasAttribute("inert"));
		shell.setContent(releasable(h("section", { class: "view" }), NOTHING_TO_RELEASE));
		assert.deepEqual(findAll(document.body, (node) => hasClass(node, "dialog-backdrop")), [], "and the route change dismisses the dialog the shell still holds");
		assert.equal(page.getAttribute("aria-hidden"), null, "which un-hides the page behind it");
		assert.ok(!page.hasAttribute("inert"), "and drops its temporary inert state");
	} finally {
		fake.restore();
	}
});

test("a superseded dialog's own close report does not take the dialog on screen with it", () => {
	// The share dialog reports its dismissal back to the shell as `onDialog(null)`, so the slot's dismissal of a newcomer re-enters the slot: read as a reason to dismiss, that `null` closes the dialog the payer was using and un-hides a page a modal is still mounted over. Only an embedder can reach it — a modal's backdrop and its inert background block the second entry point a payer would need — so the slot is what has to tell its own dismissal's report from a dialog closing itself.
	const fake = installInteractiveDocument();
	try {
		const page = document.createElement("div");
		document.body.append(page);
		const shell = mountShell(page);
		renderRoute(shell, parseHash(`#/i/${encodeInvoice(invoiceFor())}`), VIEW_OPTIONS);
		const share = () => byText(shell.content.children[0], "button", "Share")[0];
		share().dispatch("click", { type: "click" });
		const first = findAll(document.body, (node) => hasClass(node, "dialog-backdrop"));
		assert.equal(first.length, 1, "the document's Share control opens one dialog");
		assert.equal(page.getAttribute("aria-hidden"), "true", "hiding the page behind it from assistive tech");
		assert.ok(page.hasAttribute("inert"), "and from keyboard focus");

		share().dispatch("click", { type: "click" });
		const standing = findAll(document.body, (node) => hasClass(node, "dialog-backdrop"));
		assert.equal(standing.length, 1, "a second open attempt leaves one dialog standing rather than none");
		assert.equal(standing[0], first[0], "and it is the dialog the shell held, which the payer was using");
		assert.equal(page.getAttribute("aria-hidden"), "true", "so the page behind it stays hidden from assistive tech");
		assert.ok(page.hasAttribute("inert"), "and stays out of the keyboard while a modal is still mounted");

		renderRoute(shell, parseHash("#/create"), VIEW_OPTIONS);
		assert.deepEqual(findAll(document.body, (node) => hasClass(node, "dialog-backdrop")), [], "and the route change still dismisses the dialog the shell holds");
		assert.equal(page.getAttribute("aria-hidden"), null, "which un-hides the page behind it");
		assert.ok(!page.hasAttribute("inert"), "and returns it to the keyboard");
	} finally {
		fake.restore();
	}
});

test("dismissing the payment panel and clicking Pay again opens a panel rather than a dialog cleared away in that same click", () => {
	// The shell's modal slot holds whichever dialog the document opened, and the payer dismissing the panel is a path the slot is not part of; a slot that kept the closed handle would read the next Pay click as a second dialog standing over a live one and dismiss the newcomer inside the click that mounted it, so the payer would see nothing and nothing would say why.
	const fake = installInteractiveDocument();
	try {
		const page = document.createElement("div");
		document.body.append(page);
		const shell = mountShell(page);
		// An invoice no other case pays: the payment latch remembers a send by the invoice's own content for the whole run.
		renderRoute(shell, parseHash(`#/i/${encodeInvoice(invoiceFor({ id: "INV-REOPEN" }))}`), VIEW_OPTIONS);
		const pay = () => byText(shell.content.children[0], "button", "Pay")[0];
		pay().dispatch("click", { type: "click" });
		const opened = findAll(document.body, (node) => hasClass(node, "pay-dialog"));
		assert.equal(opened.length, 1, "the first click opens the payment panel");

		const close = findAll(opened[0], (node) => node.attributes?.["aria-label"] === "Close payment panel")[0];
		assert.ok(close, "the panel offers its own close control");
		close.dispatch("click", { type: "click" });
		assert.deepEqual(findAll(document.body, (node) => hasClass(node, "pay-dialog")), [], "the payer's own dismissal takes the panel off the page without paying");

		pay().dispatch("click", { type: "click" });
		const reopened = findAll(document.body, (node) => hasClass(node, "pay-dialog"));
		assert.equal(reopened.length, 1, "and the next Pay click opens a panel rather than mounting one the shell dismisses in that same click");
		assert.notEqual(reopened[0], opened[0], "which is a fresh dialog, not the one the payer dismissed");
		assert.equal(findAll(reopened[0], (node) => hasClass(node, "pay-connect")).length, 1, "offering the control the payer pays with");
		assert.equal(page.getAttribute("aria-hidden"), "true", "and hiding the page behind it from assistive tech again");
		assert.ok(page.hasAttribute("inert"), "and from keyboard focus");
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

test("the overlay's Tab model counts a declared focus stop and no unreadable tabindex", () => {
	// The Tab ring is the dialog's model of what a browser makes focusable, so a stop a page declares with a non-negative tabindex sits inside it, while a value the platform cannot read is no stop at all.
	const fake = installInteractiveDocument();
	try {
		const overlay = createOverlay(() =>
			releasable(
				h(
					"div",
					{ class: "dialog" },
					h("button", { type: "button", class: "tab-first" }, "First"),
					h("span", { class: "tab-value", role: "group", "aria-label": "A value", tabindex: "0" }, "0xabc"),
					h("button", { type: "button", class: "tab-last" }, "Last"),
				),
				NOTHING_TO_RELEASE,
			),
		);
		const first = findAll(overlay.element, (node) => hasClass(node, "tab-first"))[0];
		const middle = findAll(overlay.element, (node) => hasClass(node, "tab-value"))[0];
		const last = findAll(overlay.element, (node) => hasClass(node, "tab-last"))[0];

		middle.focus();
		overlay.element.dispatch("keydown", { type: "keydown", key: "Tab" });
		assert.equal(document.activeElement, middle, "Tab forward from a declared stop is left to the browser, which is only true while the stop is inside the ring");
		overlay.element.dispatch("keydown", { type: "keydown", key: "Tab", shiftKey: true });
		assert.equal(document.activeElement, middle, "and backward too");
		last.focus();
		overlay.element.dispatch("keydown", { type: "keydown", key: "Tab" });
		assert.equal(document.activeElement, first, "while Tab from the last control still wraps to the first");

		// `tabindex=""` is what this model once read as a stop and a browser does not, and a negative one is programmatically focusable alone: a dialog holding those and one button has that button as its whole ring.
		const unreadable = createOverlay(() =>
			releasable(
				h(
					"div",
					{ class: "dialog" },
					h("button", { type: "button", class: "only-stop" }, "Only"),
					h("span", { class: "empty-tabindex", tabindex: "" }, "no stop"),
					h("span", { class: "negative-tabindex", tabindex: "-1" }, "programmatic only"),
				),
				NOTHING_TO_RELEASE,
			),
		);
		const only = findAll(unreadable.element, (node) => hasClass(node, "only-stop"))[0];
		only.focus();
		unreadable.element.dispatch("keydown", { type: "keydown", key: "Tab", shiftKey: true });
		assert.equal(document.activeElement, only, "an empty or negative tabindex makes no stop, so a backward Tab from the dialog's only control wraps to itself rather than onto a value the browser would never stop at");
	} finally {
		fake.restore();
	}
});

test("closing an overlay runs its dialog's release exactly once, even when the release throws", () => {
	// A dialog's rows are released by the dialog itself, so the builder returns its element carrying that release rather than passing it through a variable the caller assigns to; the overlay runs it once, on every dismissal path, beside the caller's own close.
	const fake = installInteractiveDocument();
	try {
		const released = [];
		const closed = [];
		const overlay = createOverlay(
			() => releasable(
				h("div", { class: "dialog" }, h("button", { type: "button", class: "dialog-close" }, "Close")),
				() => released.push("dialog"),
			),
			{ onClose: () => closed.push("caller") },
		);
		assert.equal(overlay.closed, false, "a dialog on the page reads as open through its handle");
		overlay.element.dispatch("keydown", { type: "keydown", key: "Escape" });
		assert.deepEqual(released, ["dialog"], "the release the dialog carries runs as the dialog closes");
		assert.deepEqual(closed, ["caller"], "beside the caller's own close");
		assert.equal(overlay.closed, true, "and the handle states that the dialog closed, which is what a slot holding it reads");
		overlay.close();
		assert.deepEqual(released, ["dialog"], "and a second dismissal runs nothing a second time");

		const afterThrow = [];
		let runs = 0;
		const failing = createOverlay(
			() => releasable(h("div", { class: "dialog" }), () => {
				runs += 1;
				throw new Error("the release failed");
			}),
			{ onClose: () => afterThrow.push("caller") },
		);
		assert.throws(() => failing.close(), /the release failed/, "a release that fails is not swallowed");
		assert.equal(runs, 1, "and it runs exactly once even though it threw");
		assert.deepEqual(afterThrow, ["caller"], "and the caller's own close still runs behind it, so a dismissal cannot strand the half that unmounts the overlay");
	} finally {
		fake.restore();
	}
});

test("a dismissal the payer triggers reports a release that throws, and a caller holding the handle still takes it", () => {
	// Escape, a backdrop click, and the dialog's own controls are all dismissals with nobody above the listener to hand a failure back to: a throw there reaches the console and no payer. Every one of them reports the failure through the overlay's own hook, and the handle keeps a close for the caller that can act on it.
	const fake = installInteractiveDocument();
	try {
		const dismissThrough = (dismiss) => {
			const reports = [];
			const overlay = createOverlay(
				(close) => {
					const done = h("button", { type: "button", class: "dialog-done" }, "Done");
					done.addEventListener("click", close);
					return releasable(h("div", { class: "dialog" }, done), () => {
						throw new Error("the release failed");
					});
				},
				{ onDismissFailed: () => reports.push("reported") },
			);
			dismiss(overlay);
			return reports;
		};
		const ways = [
			["the dialog's own close control", (overlay) => overlay.element.querySelector(".dialog-done").dispatch("click", { type: "click" })],
			["Escape", (overlay) => overlay.element.dispatch("keydown", { type: "keydown", key: "Escape" })],
			["a click on the backdrop", (overlay) => overlay.element.dispatch("click", { type: "click", target: overlay.element })],
		];
		for (const [where, dismiss] of ways) {
			assert.deepEqual(
				dismissThrough(dismiss),
				["reported"],
				`a dismissal by ${where} reports the release that failed, and throws nothing at the listener that ran it`,
			);
		}

		// A caller that holds the handle is the other half: it takes the failure itself, and the payer is not told twice about one failure.
		const reports = [];
		const failing = createOverlay(
			() => releasable(h("div", { class: "dialog" }), () => {
				throw new Error("the release failed");
			}),
			{ onDismissFailed: () => reports.push("reported") },
		);
		assert.throws(() => failing.close(), /the release failed/, "a caller holding the handle still takes the failure the dismissal raised");
		assert.deepEqual(reports, [], "and the same failure is not reported through the hook as well");
	} finally {
		fake.restore();
	}
});

test("an overlay whose backdrop cannot be built releases the dialog it already built", () => {
	// The dialog exists before the backdrop that wraps it, so a backdrop that cannot be built would leave a dialog nothing ever dismisses: its release runs on that failure rather than on a surface never returned.
	const fake = installInteractiveDocument();
	const createElement = document.createElement;
	let created = 0;
	document.createElement = (tag) => {
		created += 1;
		// The dialog's own element is the first one built; the backdrop that wraps it is the second.
		if (created === 2) throw new Error("the backdrop was refused");
		return createElement.call(document, tag);
	};
	const released = [];
	try {
		assert.throws(() => createOverlay(() => releasable(h("div", { class: "dialog" }), () => released.push("dialog"))), /the backdrop was refused/);
	} finally {
		document.createElement = createElement;
		fake.restore();
	}
	assert.deepEqual(released, ["dialog"], "the dialog's own release runs on the failed build");
});

test("an overlay that cannot mount releases the dialog it built, without reporting a dismissal", () => {
	// A dialog built behind an overlay that never mounted is a dialog no dismissal will ever reach, so the open window runs the release itself; the caller's close is not reported, because no overlay was ever on the page to be dismissed.
	const fake = installInteractiveDocument();
	const released = [];
	let closed = 0;
	const append = document.body.append.bind(document.body);
	document.body.append = () => {
		throw new Error("the body refused the backdrop");
	};
	try {
		assert.throws(
			() => openOverlay(
				(close) => {
					const done = h("button", { type: "button" }, "Done");
					done.addEventListener("click", close);
					return releasable(h("div", { class: "dialog" }, done), () => released.push("dialog"));
				},
				{ onClose: () => { closed += 1; } },
			),
			/the body refused the backdrop/,
		);
	} finally {
		document.body.append = append;
		fake.restore();
	}
	assert.deepEqual(released, ["dialog"], "the dialog's release runs on the failed mount");
	assert.equal(closed, 0, "and the caller's close is not reported for an overlay that never opened");
});

test("a mount that cannot hide the background leaves neither a backdrop over the page nor a hidden background", () => {
	// The mount returns its release only when it returns, so a hide that throws partway hands the open window nothing to undo: the backdrop this call appended is removed, and the writes it had already made are undone, inside the same call.
	const fake = installInteractiveDocument();
	const released = [];
	try {
		const hidden = document.createElement("div");
		const refused = document.createElement("div");
		document.body.append(hidden, refused);
		const setAttribute = refused.setAttribute.bind(refused);
		refused.setAttribute = (name, value) => {
			if (name === "inert") throw new Error("the background refused its inert state");
			return setAttribute(name, value);
		};
		assert.throws(
			() => openOverlay(() => releasable(h("div", { class: "dialog" }), () => released.push("dialog"))),
			/the background refused its inert state/,
			"the caller is told the mount failed",
		);
		assert.deepEqual(findAll(document.body, (node) => hasClass(node, "dialog-backdrop")), [], "no backdrop is left standing over the page");
		assert.equal(hidden.getAttribute("aria-hidden"), null, "the child the hiding had already reached is un-hidden again");
		assert.ok(!hidden.hasAttribute("inert"), "with the temporary inert it was given dropped too");
		assert.equal(refused.getAttribute("aria-hidden"), null, "and the child whose write threw keeps no half-written state");
		assert.ok(!refused.hasAttribute("inert"));
	} finally {
		fake.restore();
	}
	assert.deepEqual(released, ["dialog"], "the dialog's own release still runs on the failed mount");
});

test("a mount whose own release throws still releases the dialog it built", () => {
	// The mount's release and the dialog's release both run through the shared helper, so a window that unwinds cannot strand the dialog's release on a dialog no handle ever returns; the failure that reaches the caller is still the mount's own, which is what it asked to open.
	const fake = installInteractiveDocument();
	const previouslyFocused = document.createElement("button");
	document.body.append(previouslyFocused);
	previouslyFocused.focus();
	const focus = globalThis.HTMLElement.prototype.focus;
	const remove = globalThis.HTMLElement.prototype.remove;
	const released = [];
	// Focus refuses inside the freshly mounted dialog, which is the failure that reaches the open window's catch with a mount release already in hand; the mount's own release then refuses to remove the overlay, so its release throws first.
	globalThis.HTMLElement.prototype.focus = () => {
		throw new Error("focus was refused");
	};
	globalThis.HTMLElement.prototype.remove = () => {
		throw new Error("the overlay could not be removed");
	};
	try {
		assert.throws(
			() => openOverlay(() => releasable(h("div", { class: "dialog" }), () => released.push("dialog"))),
			(error) => {
				assert.match(error.message, /focus was refused/, "the caller is told about the failure that stopped the open, not about the cleanup's");
				assert.match(String(error.cause?.message), /the overlay could not be removed/, "and the release that failed beside it is carried on that failure rather than lost");
				return true;
			},
		);
	} finally {
		globalThis.HTMLElement.prototype.focus = focus;
		globalThis.HTMLElement.prototype.remove = remove;
		fake.restore();
	}
	assert.deepEqual(released, ["dialog"], "the dialog's own release ran even though the mount's release threw before it");
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

test("a printed payment value is the whole value, sized by its length and wrapped only past the floor", () => {
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
		assert.equal(amount.length, 79, "the amount fixture is 79 characters, past what the 9pt rung's column holds and inside the next rung's");
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

		// The swap is the stylesheets' whole contract for the print surface, so both halves are asserted where a print engine reads them: the value is dropped, and the twin is shown in its place on a row of its own.
		const printCss = readFileSync(join(root, "app/stylesheets/print.css"), "utf8");
		assert.match(ruleBody(printCss, ".payment-value-verbatim"), /display:\s*none/, "print.css drops the on-screen value, so no printed value is a clipped run");
		const twin = ruleBody(printCss, ".payment-value-print");
		assert.ok(twin !== undefined, "print.css states how the print presentation is shown");
		assert.match(twin, /display:\s*(?:block|inline)/, "in the dropped value's place");
		assert.doesNotMatch(twin, /white-space|overflow-wrap|word-break/, "with no line rule of its own: the rung the twin carries is what decides whether the value may break");
		assert.doesNotMatch(printCss, /\.payment-value\s*\{/, "while the plain values of terms no wallet takes verbatim stay in the printed document");

		// The ladder: one rule per rung, the sizes descending to the 6pt floor, and no break allowed before it.
		// The rungs and their point sizes are read from the module's table, because a printed value is sized from that table and a rule resized on one side alone would leave the page laying out a rung at a size the choice did not assume.
		const sizedPrint = FIT_RUNGS.print.filter((entry) => !entry.wraps);
		const rungSizes = sizedPrint.map((entry) => [entry.rung, `${entry.points}pt`]);
		const points = [];
		for (const [rung, size] of rungSizes) {
			const body = ruleBody(printCss, `.payment-value-print.${rung}`);
			assert.ok(body !== undefined, `print.css states the ${rung} rung`);
			assert.equal(declaration(body, "font-size"), size, `${rung} is set at ${size}`);
			// The rung's own rule states its size, and the line every sized rung is drawn on is stated once for all four: the printed column is the one this page draws, not one a printed page is guaranteed to give the twin, so the printed value keeps every character it has and continues on the next line instead of running its tail past the paper's margin, where no cue and no copy control could recover it.
			assert.equal(appliedDeclaration(printCss, `.payment-value-print.${rung}`, "white-space"), "pre-wrap", `${rung} preserves every character of the value on the paper, its spacing included`);
			assert.equal(appliedDeclaration(printCss, `.payment-value-print.${rung}`, "overflow-wrap"), "anywhere", `${rung} breaks inside the value rather than clipping its tail when the column is narrower than the rung was priced against`);
			assert.notEqual(declaration(body, "white-space"), "nowrap", `${rung} states no line rule of its own that would cut a value its column does not hold`);
			points.push(Number(size.slice(0, -2)));
		}
		assert.deepEqual(points, [...points].sort((left, right) => right - left), "the rungs descend from the largest to the smallest");
		assert.equal(points[points.length - 1], 6, "and stop at the 6pt floor, ordinary fine print");
		const wrapRung = FIT_RUNGS.print[FIT_RUNGS.print.length - 1];
		const wrap = ruleBody(printCss, `.payment-value-print.${wrapRung.rung}`);
		assert.ok(wrap !== undefined, "and the last rung states what a value past the floor may do");
		assert.equal(declaration(wrap, "white-space"), "normal");
		assert.equal(declaration(wrap, "overflow-wrap"), "anywhere", "which is to break inside itself rather than overflow the page");
		assert.equal(declaration(wrap, "font-size"), `${sizedPrint[sizedPrint.length - 1].points}pt`, "at the floor's own size, so the value breaks at the face both comments promise rather than at whatever face it would inherit");
		// Every line rule in the print stylesheet belongs to a rung, so no other block in the document is held on a line or allowed to break by print.css.
		for (const rule of cssRules(printCss)) {
			for (const property of ["white-space", "overflow-wrap", "word-break"]) {
				if (declaration(rule.body, property) === undefined) continue;
				assert.ok(
					rule.selectors.every((selector) => selector.startsWith(".payment-value-print.print-fit-")),
					`print.css declares ${property} only for a payment value's print rung, not for ${rule.selectors.join(", ")}`,
				);
			}
		}

		// The rungs the twins carry, derived from the stylesheets' own geometry — the @page block print.css declares, less its margin, and then the payment term's own label rail and gap, which is the column a twin is laid out in — rather than from the module's arithmetic, so a units, margin, or rail error on the module's side fails here instead of being transcribed into the expectation.
		const invoiceCss = readFileSync(join(root, "app/stylesheets/invoice.css"), "utf8");
		assert.deepEqual(
			printed.map(printRungs),
			[address, amount, model.paymentLink].map((value) => [expectedPrintRung(printCss, invoiceCss, FIT_RUNGS, [...value].length)]),
			"each twin carries the rung its length earns in the column print.css and invoice.css give it",
		);
		assert.deepEqual(printRungs(printed[0]), ["print-fit-wrap"], "the 311-character address is past the print floor and wraps");
		assert.deepEqual(printRungs(printed[2]), ["print-fit-wrap"], "as is the 404-character link that carries it");
		assert.deepEqual(printRungs(printed[1]), ["print-fit-2"], "while the 79-character amount is past what the 9pt rung's column holds, so it takes the 8pt rung the same geometry earns for it");
		const evm = renderInvoiceView(invoiceFor(), { ...VIEW_OPTIONS, notice: noticeRecorder() });
		const evmTwins = findAll(evm, (node) => hasClass(node, "payment-value-print"));
		assert.deepEqual(
			printRungs(evmTwins[0]),
			[expectedPrintRung(printCss, invoiceCss, FIT_RUNGS, PAYEE.length)],
			"and a 42-character EVM address prints at the rung its length earns on the same page",
		);

		const screenTwin = ruleBody(readFileSync(join(root, "app/stylesheets/invoice.css"), "utf8"), ".payment-value-print");
		assert.ok(screenTwin !== undefined, "invoice.css declares the print presentation too, so the two are swapped rather than both drawn");
		assert.match(screenTwin, /display:\s*none/, "which is hidden on screen, where the value and its copy control are the presentation");
	} finally {
		fake.restore();
	}
});

test("the print twin's printed visibility is decided by the stylesheets' media queries, not by the order the two files load in", () => {
	// The twin is hidden by one file and shown by another, each at the same specificity, so the pair is decided by source order unless the media queries decide it: a `<link>` reorder that let the hiding rule win in print would drop the twin as well as the on-screen value print.css hides, and the page would print an invoice carrying no payout address at all. This reads both files' statements about the twin and resolves them the way the cascade does for each medium, under each load order.
	const invoiceCss = readFileSync(join(root, "app/stylesheets/invoice.css"), "utf8");
	const printCss = readFileSync(join(root, "app/stylesheets/print.css"), "utf8");
	/** Whether a rule's query matches `medium`: a rule outside any query matches every medium, and a query naming the medium matches it. */
	const matches = (at, medium) => at === "" || at.includes(medium);
	/** Every `display` one file states for the twin, with the query it sits under and the file that states it. */
	const stated = (css, file) =>
		cssRules(css)
			.filter((rule) => rule.selectors.includes(".payment-value-print") && declaration(rule.body, "display") !== undefined)
			.map((rule) => ({ file, at: rule.at, display: declaration(rule.body, "display") }));
	const invoice = [invoiceCss, "invoice.css"];
	const print = [printCss, "print.css"];
	const statements = [invoice, print].flatMap(([css, file]) => stated(css, file));
	assert.ok(statements.length >= 2, "both files state how the twin is displayed, so the two are swapped rather than both drawn");

	// The property that has to hold whatever the load order: no statement that hides the twin may be able to match a printed page, or a printed page could be left with the on-screen value hidden by print.css and the twin hidden here, and no second copy of the address on it.
	const hiding = statements.filter((rule) => rule.display === "none");
	assert.ok(hiding.length > 0, "invoice.css still hides the twin on screen, where the value and its copy control are the presentation");
	for (const rule of hiding) {
		assert.ok(!matches(rule.at, "print"), `${rule.file} hides the twin under ${rule.at === "" ? "no query at all" : rule.at}, which can match a printed page`);
	}
	const showing = statements.filter((rule) => matches(rule.at, "print") && rule.display !== "none");
	assert.ok(showing.length > 0, "and print.css shows the twin in the printed page, so the printed document carries the value whole");
	for (const rule of showing) {
		assert.match(rule.display, /^(?:block|inline)$/, `${rule.file} shows the twin as a box of its own on the row it takes under ${rule.at}`);
	}

	// The same answer under either load order, resolved the way the cascade resolves equal-specificity statements: the last matching one wins, which is the order-dependence this pins away.
	for (const order of [[invoice, print], [print, invoice]]) {
		const names = order.map(([, file]) => file).join(" loaded before ");
		/** The `display` the cascade applies to the twin in `medium`, with the files loaded in `order`. */
		const applied = (medium) => order.flatMap(([css, file]) => stated(css, file)).filter((rule) => matches(rule.at, medium)).at(-1);
		assert.equal(applied("screen")?.display, "none", `${names}: the twin is hidden on screen, whichever file loads last`);
		assert.match(String(applied("print")?.display), /^(?:block|inline)$/, `${names}: and shown in print, so no order of the two links can print the document without its payout address`);
	}
});

test("the values no wallet takes verbatim wrap rather than scroll, so none can be clipped and none needs a print twin", () => {
	// The printed page drops only the verbatim values and swaps in a twin, so a plain value has to be safe to print as it stands. Its safety is the wrap: the value is drawn whole on as many lines as it needs rather than held on one scrolling run, so no overlay-scrollbar engine can hand a payer a clipped tail of it with no cue and no focus stop. Verify that the only plain values are the registry's own Asset and Network labels, and that both states of the value box are stated by the stylesheet.
	const hostile = invoiceFor({
		id: "I".repeat(64),
		payee: { name: "N".repeat(200), address: PAYEE },
		notes: "x".repeat(400),
	});
	const model = buildInvoiceViewModel(hostile, VIEW_OPTIONS.today);
	const plain = model.payment.filter((term) => term.verbatim !== true);
	assert.deepEqual(plain.map((term) => term.label), ["Asset", "Network"], "the only values held on one non-wrapping run without a twin are the asset and network labels");
	const assetLabels = new Set(ASSETS.map((asset) => `${asset.name} (${asset.symbol})`));
	const networkLabels = new Set(SUPPORTED_CHAIN_IDS.map((chainId) => networkLabel(chainId)));
	assert.ok(assetLabels.has(plain[0].value), "and the asset value is a registry label, not text an invoice can stretch");
	assert.ok(networkLabels.has(plain[1].value), "as is the network value");

	// The widest value either label can take, read from the registry rather than a transcript, so a new asset or network is held to the same bound.
	const widest = Math.max(
		...ASSETS.map((asset) => `${asset.name} (${asset.symbol})`.length),
		...SUPPORTED_CHAIN_IDS.map((chainId) => networkLabel(chainId).length),
	);
	// The value column at the narrowest viewport the page is laid out for (320px): the document column less the ≤640px rule's 5.5rem label rail and 0.5rem gap. At the value face of 0.9375rem a UI sans averages well under half an em per character over these labels, so the column fits many more than the widest label's characters.
	const valueColumnPx = 256 - 88 - 8;
	const perCharPx = 0.9375 * ROOT_FONT_PX * 0.5;
	assert.ok(
		widest * perCharPx <= valueColumnPx,
		`the widest non-verbatim value is ${widest} characters, which fits the ${valueColumnPx}px column at the value face's half-em average`,
	);

	// The mechanism that makes a clipped tail impossible is the wrap, not the estimate above: every plain value takes the wrapping state of the value box, and that state draws its own lines rather than keeping a scroll container.
	const fake = installInteractiveDocument();
	try {
		const view = renderInvoiceView(hostile, { ...VIEW_OPTIONS, notice: noticeRecorder() });
		const terms = findAll(view, (node) => hasClass(node, "payment-term"));
		const plainTerms = terms.filter((term) => findAll(term, (node) => hasClass(node, "payment-value-verbatim")).length === 0);
		assert.deepEqual(
			plainTerms.map((term) => textOf(term)),
			plain.map((term) => `${term.label}${term.value}`),
			"the terms drawn without a verbatim value are the asset and network terms the model states",
		);
		for (const term of plainTerms) {
			const value = findAll(term, (node) => hasClass(node, "payment-value"))[0];
			assert.ok(value !== undefined, "each plain term draws its value in the payment section's value box");
			assert.ok(hasClass(value, "payment-value-wrapping"), `${String(value.attributes.class)} takes the wrapping state, so a label wider than the column is drawn on the next line instead of scrolling out of sight`);
			assert.equal(value.attributes.tabindex, undefined, "and it is no focus stop: a value that cannot overflow has no tail for a keyboard user to arrow along to");
			assert.equal(value.attributes.role, undefined, "and carries no role a stop would need");
			assert.ok(!hasClass(term, "fit-sized"), "its row is not one the ladder sizes, so nothing cues a value nothing can hide");
		}

		const invoiceCss = readFileSync(join(root, "app/stylesheets/invoice.css"), "utf8");
		const wrapping = ruleBody(invoiceCss, ".payment-value-wrapping");
		assert.ok(wrapping !== undefined, "invoice.css states what a payment value no wallet takes verbatim does instead of taking the scroll box the verbatim values are drawn in");
		assert.equal(declaration(wrapping, "white-space"), "normal", "it wraps, so a longer label is drawn on the next line rather than held on one run");
		assert.equal(declaration(wrapping, "overflow-wrap"), "anywhere", "and a label with no space of its own still breaks inside itself rather than running past the column");
		assert.equal(declaration(wrapping, "overflow"), "visible", "it draws its own lines rather than scrolling, so every line it wraps onto is part of the value a payer sees");
		assert.equal(appliedDeclaration(invoiceCss, ".payment-value", "white-space"), "nowrap", "while the class the verbatim values share still states the one-line contract, which those values keep, being strings a wallet takes");
		assert.equal(appliedDeclaration(invoiceCss, ".payment-value", "overflow-x"), "auto", "with the scroll box a value wider than the column is read through");
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
		// The icon replaces the default brand mark rather than accompanying it, so the letterhead draws exactly one of the two, and the wordmark is drawn beside whichever it is.
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

test("the print path keeps the letterhead's supplied mark and never restores the default one", () => {
	// The page draws exactly one of the two marks and the PDF draws the icon in the brand mark's place; the print path renders the page's own markup, so print.css must keep whichever mark the page drew — never hide the supplied icon, and never add a rule that would draw the built-in brand mark the page left out.
	const printCss = readFileSync(join(root, "app/stylesheets/print.css"), "utf8");
	for (const body of [...printCss.matchAll(/\.letterhead-icon[^{}]*\{([^{}]*)\}/g)].map((match) => match[1])) {
		assert.doesNotMatch(body, /display:\s*none|visibility:\s*hidden/, `print.css must not hide the payee's own icon: ${body.trim()}`);
	}
	const markRules = [...printCss.matchAll(/\.invoice-logo[^{}]*\{([^{}]*)\}/g)].map((match) => match[1]);
	assert.ok(markRules.length > 0, "print.css declares the default brand mark's own print treatment");
	for (const body of markRules) {
		assert.doesNotMatch(body, /display:|background-image:|content:|visibility:/, `print.css must not re-show the built-in brand mark the page leaves out when the invoice carries its own icon: ${body.trim()}`);
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
	assert.equal(appliedDeclaration(invoiceCss, ".party", "display"), "grid", "the party block lays its children out as grid rows, which is what stacks the contact lines");
	assert.equal(
		appliedDeclaration(readFileSync(join(root, "app/stylesheets/print.css"), "utf8"), ".party-detail", "color"),
		"#000 !important",
		"print.css forces the contact lines to the same black ink as the rest of the party text",
	);
});

test("a stored contact value is drawn line for line exactly as the validator stored it", () => {
	// The model stores the canonical contact text, so a line the page draws is the line the payload carries rather than a stripped second spelling of it — the invariant the tab pass and the format-character refusal exist to hold.
	const contact = "Stüdió — Café\n+44 20 7946 0000\n日本 🧾 𝒜";
	const invoice = invoiceFor({ payee: { name: "Studio Example", address: PAYEE, email: contact } });
	assert.equal(invoice.payee.email, contact, "the stored value is the value the form submitted");
	const stored = invoice.payee.email.split("\n");

	const model = buildInvoiceViewModel(invoice, VIEW_OPTIONS.today);
	assert.deepEqual(model.from.email, stored, "the view model draws the stored value's own lines");

	const fake = installInteractiveDocument();
	try {
		const view = renderInvoiceView(invoice, { ...VIEW_OPTIONS, notice: noticeRecorder() });
		const payee = findAll(view, (node) => hasClass(node, "party-payee"))[0];
		assert.deepEqual(
			findAll(payee, (node) => hasClass(node, "party-detail")).map((node) => textOf(node)),
			stored,
			"the document draws each stored line whole, and the print path prints this same element",
		);
	} finally {
		fake.restore();
	}
});

test("a tab pasted into a contact value is stored as the space the page, the print twin, and the PDF all draw", () => {
	// The model admits a tab inside a contact line while the display boundary removes it, so a stored tab would be drawn as nothing and would join the words it separated; the canonical contact text stores the single space the tab stood for instead.
	const invoice = invoiceFor({ payee: { name: "Studio Example", address: PAYEE, email: "Studio\tExample\n+44 20 7946 0000" } });
	assert.equal(invoice.payee.email, "Studio Example\n+44 20 7946 0000", "the stored value carries a single space where the tab stood");
	const model = buildInvoiceViewModel(invoice, VIEW_OPTIONS.today);
	assert.deepEqual(
		model.from.email,
		["Studio Example", "+44 20 7946 0000"],
		"so the rendered lines are the stored lines, with no control character left to strip",
	);

	const fake = installInteractiveDocument();
	try {
		const view = renderInvoiceView(invoice, { ...VIEW_OPTIONS, notice: noticeRecorder() });
		const payee = findAll(view, (node) => hasClass(node, "party-payee"))[0];
		assert.deepEqual(
			findAll(payee, (node) => hasClass(node, "party-detail")).map((node) => textOf(node)),
			model.from.email,
			"and the document draws those same lines",
		);
	} finally {
		fake.restore();
	}
});

test("a contact value's own spacing is drawn as the payee typed it on the page and on paper", () => {
	// The field is free text, so a run of spaces and the space a line opens with are part of the value; the block that draws it would collapse them under the default `white-space`, while the PDF draws the line's own characters, and the print path is that same element rather than a second copy of the markup.
	const contact = "12  Example  Street\n  Accounts\n+44 20 7946 0000";
	const invoice = invoiceFor({ payee: { name: "Studio Example", address: PAYEE, email: contact } });
	assert.equal(invoice.payee.email, contact, "the stored value keeps the run of spaces and the space a line opens with");
	const stored = invoice.payee.email.split("\n");
	assert.ok(stored.some((line) => line.includes("  ")), "the fixture carries a run of spaces for the assertions below to be about");
	assert.ok(stored.some((line) => line.startsWith(" ")), "and a line a space opens");

	const invoiceCss = readFileSync(join(root, "app/stylesheets/invoice.css"), "utf8");
	assert.equal(
		declaration(ruleBody(invoiceCss, ".party-detail"), "white-space"),
		"pre-wrap",
		"the block that draws the contact lines preserves their whitespace, as the note lines' own block already does",
	);
	// The print stylesheet recolours the same element and is loaded instead of the screen's, so it is the one place a re-collapse could hide: it must declare no `white-space` for these lines, or for the note lines that preserve their own spacing.
	const printCss = readFileSync(join(root, "app/stylesheets/print.css"), "utf8");
	for (const rule of cssRules(printCss)) {
		if (!rule.selectors.some((selector) => selector === ".party-detail" || selector === ".note-line")) continue;
		assert.equal(declaration(rule.body, "white-space"), undefined, "the print path prints the contact lines under the document's own declaration rather than one that would collapse their spaces");
	}

	const fake = installInteractiveDocument();
	try {
		const view = renderInvoiceView(invoice, { ...VIEW_OPTIONS, notice: noticeRecorder() });
		const payee = findAll(view, (node) => hasClass(node, "party-payee"))[0];
		assert.deepEqual(
			findAll(payee, (node) => hasClass(node, "party-detail")).map((node) => textOf(node)),
			stored,
			"and the document hands the block that preserves them the same characters",
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
	const copy = ruleBody(invoiceCss, ".payment-term .payment-copy");
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

	// The rule that decides a flex line's height is the box of the tallest item on it, so a row is the value's line box exactly while every other item's own box fits inside that line — and only while the value is the line's one baseline-aligned item.
	// The copy control is centred for that reason: left on the row's baseline instead, it takes part in the alignment, and the flex line is then the largest ascent above the baseline plus the largest descent below it, counted on each side of the control's face separately, so its ascent or its descent alone could hold the row a fraction of a line taller than its neighbours while its whole box still fitted inside the value's line.
	assert.equal(declaration(copy, "align-self"), "center", "the copy control is centred rather than left on the row's baseline, so it contributes its whole box and no ascent or descent of its own can decide the row's height");
	// The tallest box on a row sets that row's height, so what has to fit inside the line is the control's whole border box: its face, its leading, its padding on each edge, and the border `.btn` declares.
	const face = pxLength(declaration(copy, "font-size"), ".payment-copy font-size");
	const leading = Number(declaration(copy, "line-height"));
	assert.ok(Number.isFinite(leading), "the control's leading is a multiple of its own face, so its box follows from that face");
	// The padding shorthand resolves the way the shorthand reads — one value for both edges, two for the vertical pair, three or four with the bottom edge of their own — so a padding that pads one edge more than the other cannot pass as a doubled first token.
	const copyPadding = String(declaration(copy, "padding")).trim().split(/\s+/);
	const paddingTop = copyPadding[0];
	const paddingBottom = copyPadding.length >= 3 ? copyPadding[2] : copyPadding[0];
	const [btnPadding] = String(declaration(button, "padding")).split(/\s+/);
	const [btnBorder] = String(declaration(button, "border")).split(/\s+/);
	const control = face * leading + pxLength(paddingTop, ".payment-copy padding") + pxLength(paddingBottom, ".payment-copy padding") + 2 * pxLength(btnBorder, ".btn border");
	assert.ok(control <= linePx, `the copy control's ${control}px box, read on the edges it pads, fits inside the ${linePx}px line its value is drawn on, so it adds no height to its row`);
	assert.ok(
		pxLength(paddingTop, ".payment-copy padding") < pxLength(btnPadding, ".btn padding"),
		"and the padding it is given is shorter than the .btn padding it overrides",
	);

	// The status keeps the full-width line a message needs and reserves none while it is empty, so nothing holds a verbatim row apart from its neighbour before the first copy.
	// It is the live region that announces the copy, so an empty one is taken out of flow and clipped rather than hidden with `display: none`, which would drop it from the accessibility tree and leave nothing to announce the text that later fills it.
	assert.equal(declaration(status, "flex-basis"), "100%", "a copied-message states itself on a line of its own rather than reflowing its row, read from the status's own rule rather than the combined block that mentions it");
	const empty = ruleBody(invoiceCss, ".payment-status:empty");
	assert.ok(empty !== undefined, "invoice.css states what an empty status is");
	assert.notEqual(declaration(empty, "display"), "none", "the empty status is not removed from the accessibility tree, so the live region can still announce the copy into it");
	assert.equal(declaration(empty, "position"), "absolute", "taken out of flow instead, so it reserves neither the full-width line nor the list's row gap while it has nothing to say");
	assert.notEqual(declaration(status, "display"), "none", "and the status's own rule hides nothing either");

	// That rule is in force only while the status holds no child: `:empty` need not match an element carrying one, and the builder appends none to this status — a `""` child would become a text node and bring the reserved full-width line back into flow.
	const fake = installInteractiveDocument();
	try {
		const view = renderInvoiceView(invoiceFor(), { ...VIEW_OPTIONS, notice: noticeRecorder() });
		const statuses = findAll(view, (node) => hasClass(node, "payment-status"));
		assert.ok(statuses.length > 0, "the rendered document carries one status per verbatim term");
		for (const node of statuses) {
			assert.deepEqual(node.children, [], "the rendered empty status holds no child node, so `:empty` necessarily matches it and the row it would reserve stays out of flow");
		}
	} finally {
		fake.restore();
	}

	// The value is a scroll container, and its scrollbar is one thing an overflowing value says so with: nothing hides it, so an engine that paints a bar shows the value's overflow rather than clipping it silently.
	assert.equal(declaration(value, "scrollbar-width"), undefined, "the base rule hides no scrollbar, so an engine that paints one shows a value that overflows it");
	assert.equal(declaration(value, "overflow-x"), "auto", "and the value scrolls its own overflow");
	assert.equal(ruleBody(invoiceCss, ".payment-value::-webkit-scrollbar"), undefined, "no WebKit rule hides the scrollbar that overflow draws either");
	// The bar is not a cue every engine paints — an overlay-scrollbar engine draws one only once the payer scrolls, and the states in which no fit ever lands carry no rung at all — so the cue a value may be clipped by is a line of text on the row itself, painted for every state of a row the ladder sizes that no rung holding the value covers. The ladder-agreement test in `tests/fit-value.test.mjs` holds that cue, and the states that silence it, to the ladder.
	const sizedCue = ruleBody(invoiceCss, ".payment-term.fit-sized::after");
	assert.ok(sizedCue !== undefined, "invoice.css states the cue a value the ladder sizes carries, on the row rather than in the value's scroll box");
	assert.equal(declaration(sizedCue, "content"), '"If the value is cut off, scroll it."', "worded as an instruction conditioned on the clip rather than a claim that the value continues, so it is true beside a value a fit has just shown whole — the common case for every address, amount, and hash — and beside the 311-character address that is genuinely clipped, and it names the scroll box this term gives its value whether or not a copy control sits beside it");
	assert.equal(declaration(sizedCue, "user-select"), "none", "and the rule that paints the cue states the one exclusion a stylesheet can make from a selection, which is all this suite can read: the cue is generated content of the row and never a text node, so the value's own text and every string the app copies are free of it, and the residual a browser's selection could still carry is stated in the rule's own comment");

	// Neither affordance is part of the text a payer selects, which is what makes a select-all of the section read one label and one value per line; both also keep their own width on the row rather than stretching.
	for (const selector of [".payment-copy", ".payment-status"]) {
		assert.equal(appliedDeclaration(invoiceCss, selector, "flex"), "0 0 auto", `${selector} keeps its own width on the payment row rather than stretching`);
		assert.equal(appliedDeclaration(invoiceCss, selector, "user-select"), "none", `${selector} is outside a text selection of the section`);
	}
});

/**
 * The cue every row a value the ladder sizes is drawn in carries, as both stylesheets state it and as every assertion below is held to.
 * It is worded as an instruction conditioned on the clip rather than as a claim that the value continues, so it is true beside a value a fit has just shown whole and beside one that is cut off, and it names the scroll box such a row gives its value whether or not a copy control sits beside it.
 */
const CUE_TEXT = "If the value is cut off, scroll it.";

/** The words the cue is recognised by in a rendered document, which is read for them rather than for the stylesheet that paints them. */
const CUE_WORDS = /cut off|scroll it/;

/** The classes a fitted value's own text is drawn in, on either surface: a cue generated inside one of them would be part of the value's own box rather than beside it. */
const VALUE_BOXES = [".payment-value", ".pay-term-value", ".pay-account-value", ".pay-balance-value", ".pay-hash"];

/** The elements the invoice keeps out of a text selection: its copy control, and the status that reports the copy. */
const INVOICE_SELECTION_EXCLUSIONS = [".payment-copy", ".payment-status"];

/** The same two elements on the panel's receipt row: the control that copies the transaction hash, and its "Copied" status. */
const RECEIPT_SELECTION_EXCLUSIONS = [".pay-copy", ".pay-copy-status"];

test("the clipping cue is scoped to the screen, so the printed page never draws it beside the complete print twin", () => {
	// The cue is a line of text on the row, and the printed page draws the whole value of that same row from its print twin: a cue that reached paper would sit beside an address that is already complete, and a value marked as possibly cut off would be the one thing on the sheet that is whole.
	const invoiceCss = readFileSync(join(root, "app/stylesheets/invoice.css"), "utf8");
	const appCss = readFileSync(join(root, "app/stylesheets/app.css"), "utf8");
	const printCss = readFileSync(join(root, "app/stylesheets/print.css"), "utf8");
	const statesCue = (rule) => String(declaration(rule.body, "content") ?? "").includes(CUE_TEXT);

	// Every statement of the cue text in the invoice stylesheet stands under the screen query, read from the at-rule prelude the rule sits inside rather than from the declaration alone.
	const cueRules = cssRules(invoiceCss).filter(statesCue);
	assert.ok(cueRules.length > 0, "invoice.css states the cue a value the ladder sizes carries");
	for (const rule of cueRules) {
		assert.equal(rule.at, "@media screen", `${rule.selectors.join(", ")} states the cue inside \`@media screen\`, so no print engine can draw it beside the print twin of the same value`);
	}

	// The whole treatment of that cue is screen-only, and nothing on the screen silences it: a cue shown only on paper is the same defect seen from the other side, and a state that switched the cue off would be exactly the missing cue a clipped value must never have.
	const sizedRows = cssRules(invoiceCss).filter((rule) => rule.selectors.some((selector) => selector.startsWith(".payment-term.fit-sized")));
	assert.ok(sizedRows.length > 0, `the cue's own rule is read: ${sizedRows.map((rule) => rule.selectors.join(", ")).join(" | ")}`);
	assert.deepEqual(
		sizedRows.filter((rule) => declaration(rule.body, "content") === "none").map((rule) => rule.selectors.join(", ")),
		[],
		"no state of a sized payment term silences its cue, so a value that may be clipped is never drawn as whole",
	);
	for (const rule of sizedRows) {
		assert.equal(rule.at, "@media screen", `${rule.selectors.join(", ")} is drawn on the screen alone, the cue and every state that switches it off alike`);
	}

	// The panel draws its own version of the cue under a screen query of its own, and print.css hides the dialog it is drawn in: both halves of that are pinned here, because either one alone would let the text reach paper.
	assert.equal(cssRules(printCss).filter(statesCue).length, 0, "print.css states no clipping cue of its own");
	const panelCue = cssRules(appCss).filter(statesCue);
	assert.ok(panelCue.length > 0, "app.css states the panel's own version of the cue");
	for (const rule of panelCue) {
		assert.ok(
			rule.selectors.every((selector) => /^\.pay-(?:term|account|balance|result)\.fit-sized/.test(selector)),
			`${rule.selectors.join(", ")} states the cue on the panel's own rows — the summary terms, the two wallet strings, and the receipt's transaction hash — which are drawn inside the dialog print.css hides`,
		);
		assert.equal(rule.at, "@media screen", `${rule.selectors.join(", ")} states the panel's cue inside \`@media screen\`, so the sentence rests on the panel's own query rather than on print.css hiding the dialog it is drawn in`);
	}

	// The cue's placement on the panel's rows is part of the same screen-only treatment, for the same reason: a rule that kept its declarations and lost its query would leave the panel's cue off paper only for as long as print.css went on hiding the whole dialog.
	const panelCueTreatment = cssRules(appCss).filter((rule) => rule.selectors.some((selector) => /^\.pay-(?:term|account|balance|result)\.fit-sized::after$/.test(selector)));
	assert.ok(panelCueTreatment.length > 0, "app.css states how the panel's cue is placed on its rows");
	for (const rule of panelCueTreatment) {
		assert.equal(rule.at, "@media screen", `${rule.selectors.join(", ")} places the panel's cue on the screen alone, the cue and the box it is drawn in alike`);
	}
	const hiddenDialog = cssRules(printCss).find((rule) => rule.selectors.includes(".dialog-backdrop"));
	assert.ok(hiddenDialog !== undefined, "print.css states what happens to a dialog a print is taken of");
	assert.equal(declaration(hiddenDialog.body, "display"), "none !important", "which is that it never reaches paper, so the panel's cue cannot either");

	// The two surfaces say one thing: the panel's cue and the invoice's cue are the same sentence, so a payer reads one instruction wherever a row a value the ladder sizes is drawn in, and a wording changed on one side alone fails here.
	assert.deepEqual(
		[...new Set(panelCue.map((rule) => declaration(rule.body, "content")))],
		[...new Set(cueRules.map((rule) => declaration(rule.body, "content")))],
		"app.css paints the same sentence invoice.css paints, so the cue cannot come to mean two things on the surfaces that draw it",
	);
});

test("the cue is generated content of a row and never a text node, so no string the app copies can carry it", () => {
	// What keeps the cue out of a copied string is pinned here as far as this repository can see it: the sentence is a `::after` of the row the value sits in rather than of the value's own box, and it is no text node at all — the value's own text, which is the string each copy control is handed and the run any read of the rendered document picks up, is the value and nothing else.
	const cueRules = ["invoice.css", "app.css"].flatMap((name) => {
		const css = readFileSync(join(root, `app/stylesheets/${name}`), "utf8");
		return cssRules(css)
			.filter((rule) => String(declaration(rule.body, "content") ?? "").includes(CUE_TEXT))
			.map((rule) => ({ name, selectors: rule.selectors, body: rule.body }));
	});
	assert.equal(cueRules.length, 2, "each surface states the cue once: invoice.css for the invoice's terms and app.css for the panel's rows");
	for (const { name, selectors, body } of cueRules) {
		for (const selector of selectors) {
			assert.ok(selector.endsWith("::after"), `${name}'s ${selector} paints the cue as generated content rather than as an element carrying it`);
			assert.ok(
				/^\.(?:payment-term|pay-term|pay-account|pay-balance|pay-result)\.fit-sized::after$/.test(selector),
				`${name}'s ${selector} generates the cue on the row a value the ladder sizes is drawn in, beside the value rather than in it`,
			);
			for (const valueSelector of VALUE_BOXES) {
				assert.ok(
					!selector.includes(valueSelector),
					`${name}'s ${selector} generates no cue inside ${valueSelector}, so the box a value's own text is drawn in stays the value alone`,
				);
			}
		}
		assert.equal(declaration(body, "user-select"), "none", `${name} states the one exclusion a stylesheet can make from a selection in the rule that paints the cue, so the two cannot drift apart; what no suite here can observe, because the suites drive a fake DOM with no CSS, is a browser keeping the sentence out of a selection that spans the row`);
	}

	// The rendered documents then carry no text node of the sentence at all, so neither a copy of a value's own text nor the string a copy control is handed can include it.
	const fake = installInteractiveDocument();
	try {
		const invoice = invoiceFor();
		const view = renderInvoiceView(invoice, { ...VIEW_OPTIONS, notice: noticeRecorder() });
		const verbatim = buildInvoiceViewModel(invoice, VIEW_OPTIONS.today).payment.filter((term) => term.verbatim === true);
		assert.deepEqual(paymentValues(view), verbatim.map((term) => term.value), "each value a wallet takes verbatim renders the term's own string and nothing else, which is the string its copy control hands the clipboard");
		assert.doesNotMatch(textOf(view), CUE_WORDS, "and the cue is in no text node of the document, because a stylesheet paints it rather than the view building it");

		// An invoice of its own, because the attempted-payment latch is per invoice id and another test in this process may already have claimed this one.
		const handled = openPayPanel(invoiceFor({ id: "INV-CUE" }), { notice: noticeRecorder(), clipboard: null, fit: fakeProbe(() => ({ content: 120, box: 240 })) });
		assert.ok(handled !== null, "the payment panel opens for an invoice of its own");
		const panelValues = findAll(handled.element, (node) => hasClass(node, "pay-term-value"));
		assert.ok(panelValues.length > 0, "and draws its summary values in the boxes the cue is painted beside");
		for (const node of panelValues) {
			assert.doesNotMatch(textOf(node), CUE_WORDS, "no panel value's own text carries the cue either");
		}
		assert.doesNotMatch(textOf(handled.element), CUE_WORDS, "nor does any other text node the panel builds");
		handled.close();
	} finally {
		fake.restore();
	}
});

test("the copy control's own metrics outrank the plain button's, whatever order the stylesheets load in", () => {
	const invoiceCss = readFileSync(join(root, "app/stylesheets/invoice.css"), "utf8");
	const appCss = readFileSync(join(root, "app/stylesheets/app.css"), "utf8");
	const button = ruleBody(appCss, ".btn");
	const metrics = ruleBody(invoiceCss, ".payment-term .payment-copy");
	assert.ok(button !== undefined, "app.css states the plain button the control is built on");
	assert.ok(metrics !== undefined, "invoice.css states the control's metrics under a selector scoped to its term, not a lone .payment-copy at the button's own specificity");
	assert.ok(
		declaration(metrics, "padding") !== undefined && declaration(metrics, "font-size") !== undefined,
		"the scoped rule is where the control's padding and face are set",
	);
	// .btn sets `font: inherit` and a taller padding at a single class's specificity, so metrics written under .payment-copy alone would win only while the payment stylesheet happened to load last; only a more specific selector keeps them no matter which stylesheet a reorder puts later.
	assert.ok(
		selectorWeight(".payment-term .payment-copy") > selectorWeight(".btn"),
		"the control's scoped selector must outrank the plain .btn class, so no stylesheet order can hand the control the button's taller metrics",
	);
});

test("the receipt row's copy control and status are kept out of a selection the way the invoice's are", () => {
	// A drag-selection that spans the receipt row must not add the control's face or the "Copied" line to the transaction hash, which is the string the payer checks against their wallet: the invoice states that exclusion on its own copy control and status, and the panel's receipt row states the same two rules for the two elements it draws.
	const invoiceCss = readFileSync(join(root, "app/stylesheets/invoice.css"), "utf8");
	const appCss = readFileSync(join(root, "app/stylesheets/app.css"), "utf8");
	const invoiceExclusion = cssRules(invoiceCss).filter((rule) => INVOICE_SELECTION_EXCLUSIONS.every((selector) => rule.selectors.includes(selector)));
	assert.equal(invoiceExclusion.length, 1, "invoice.css states one rule naming the invoice's copy control and its status together");
	assert.equal(declaration(invoiceExclusion[0].body, "user-select"), "none", "and that rule is what keeps both out of a text selection");
	const receiptExclusion = cssRules(appCss).filter((rule) => RECEIPT_SELECTION_EXCLUSIONS.every((selector) => rule.selectors.includes(selector)));
	assert.equal(receiptExclusion.length, 1, "app.css states the same rule for the receipt row's copy control and its status, in one selector list of their own");
	assert.equal(declaration(receiptExclusion[0].body, "user-select"), "none", "so a selection that spans the receipt row yields the transaction hash alone");
});

test("a copy confirmation clears after its pause and a repeated copy still announces", async () => {
	// A confirmation that never clears leaves the term's row a line taller than its neighbours for the rest of the session, and a second copy that rewrites the same string may not be announced at all; this drives the control's lifecycle on a fake timer rather than a wall-clock sleep.
	const pauses = [];
	const cancelled = [];
	const timer = {
		after(clear) {
			pauses.push(clear);
			return () => cancelled.push(clear);
		},
	};
	const status = { textContent: "" };
	const value = { tagName: "span", textContent: "zcash:u1example" };
	const written = [];
	const click = copyControlClick(value.textContent, { writeText: async (text) => written.push(text) }, value, status, timer);

	click();
	await drain();
	await drain();
	assert.equal(status.textContent, "Copied", "the copy is confirmed in the live region");
	assert.equal(pauses.length, 1, "the confirmation is given a pause to run on");
	assert.deepEqual(written, ["zcash:u1example"], "the clipboard receives the value the control read");

	click();
	assert.equal(status.textContent, "", "a repeat copy clears the status before it re-confirms, so the live region's text really changes");
	assert.deepEqual(cancelled, [pauses[0]], "and the pending clear is cancelled rather than left to fire against the new confirmation");
	await drain();
	await drain();
	assert.equal(status.textContent, "Copied", "the repeated copy still confirms");
	assert.equal(pauses.length, 2, "on a fresh pause of its own");

	pauses[1]();
	assert.equal(status.textContent, "", "the confirmation clears when its pause elapses, returning the row to its uniform height and the empty status to its layout-neutral state");
});

test("a repeated copy on the clipboard-less path still changes the live region on a later task", async () => {
	// With no clipboard API the write resolves synchronously, so the confirmation would otherwise be set as a microtask of the click's own task: a repeated copy of the same value would rewrite the text the region already held and could go unannounced, which is the case the blanking exists for.
	const fake = installDocument({ getSelection: () => null });
	try {
		const timer = { after() { return () => {}; } };
		const status = { textContent: "" };
		const value = { tagName: "span", textContent: "zcash:u1example" };
		const click = copyControlClick(value.textContent, null, value, status, timer);

		click();
		assert.equal(status.textContent, "", "the blank lands synchronously, on the click's own task");
		await Promise.resolve();
		assert.equal(status.textContent, "", "and the confirmation does not land in a microtask of that same task");
		await drain();
		assert.equal(status.textContent, "Press Ctrl/Cmd+C to copy", "the fallback confirmation lands on a later task of its own");

		click();
		assert.equal(status.textContent, "", "the second copy blanks the line again");
		await Promise.resolve();
		assert.equal(status.textContent, "", "still no same-task rewrite");
		await drain();
		assert.equal(status.textContent, "Press Ctrl/Cmd+C to copy", "and the repeated copy re-sets it on a later task, so the change is observable");
	} finally {
		fake.restore();
	}
});

test("each copy status is a live region that stays in the document before it has anything to say", () => {
	// A copy confirmation reaches a screen reader only if the region carrying it is in the accessibility tree when the text lands, so the empty status is present in the markup and taken out of layout rather than removed.
	const fake = installInteractiveDocument();
	try {
		const view = renderInvoiceView(invoiceFor(), { ...VIEW_OPTIONS, notice: noticeRecorder() });
		const statuses = findAll(view, (node) => hasClass(node, "payment-status"));
		const values = findAll(view, (node) => hasClass(node, "payment-value-verbatim"));
		assert.equal(statuses.length, values.length, "each value a wallet takes verbatim carries the status that reports its copy");
		for (const node of statuses) {
			assert.equal(node.attributes.role, "status", "the status is a live region, so a confirmation is announced");
			assert.equal(textOf(node), "", "and it is empty until a copy runs");
		}
	} finally {
		fake.restore();
	}
});

test("a verbatim payment value is a named focus stop with its own ring, and a clipped value is cued on its row rather than by a mask", () => {
	const invoiceCss = readFileSync(join(root, "app/stylesheets/invoice.css"), "utf8");
	const appCss = readFileSync(join(root, "app/stylesheets/app.css"), "utf8");
	// A value wider than its column is a keyboard-reachable scroll container, so it needs both the ring `app.css` gives only form controls and a name that tells a screen-reader user which value the stop holds.
	const ring = declaration(ruleBody(invoiceCss, ".payment-value-verbatim:focus-visible"), "outline");
	assert.ok(ring !== undefined, "a focusable value needs a visible focus indicator, the one `app.css` does not give a span");
	// The payee's create screen draws this same section under `.created-payment`, with no `.view-invoice` ancestor to declare `--inv-accent`, so a bare `--inv-accent` would leave the outline's shorthand invalid there and the ring gone. The outline therefore carries a fallback to the root-scoped token `app.css`'s own ring uses.
	assert.match(
		ring,
		/var\(--inv-accent, var\(--accent\)\)/,
		"the ring's colour falls back to the root-scoped `--accent`, so it resolves on the create screen as well as the payer's document",
	);
	assert.ok(declaration(ruleBody(appCss, ":root"), "--accent") !== undefined, "and that fallback is the root's own accent token, which every surface inherits");
	// The cue that a value does not fit is neither a mask nor a fade drawn out of its glyphs: a hidden scrollbar would make the overflow a silent clip, so no rule hides the bar an engine paints, and the cue a clipped value is given is the row's own line of text, which the ladder-agreement test holds to the ladder.
	assert.equal(ruleBody(invoiceCss, ".payment-term:hover .payment-value-verbatim"), undefined, "no hover-only rule stands in for the scrollbar a clipped value would otherwise show");
	assert.doesNotMatch(invoiceCss, /mask-image/, "and no mask fades the value's edge in its place");
	assert.equal(ruleBody(invoiceCss, ".payment-value::-webkit-scrollbar"), undefined, "and the base rule hides no scrollbar for the engine that would draw one");

	const fake = installInteractiveDocument();
	try {
		const view = renderInvoiceView(invoiceFor(), { ...VIEW_OPTIONS, notice: noticeRecorder() });
		const values = findAll(view, (node) => hasClass(node, "payment-value-verbatim"));
		const model = buildInvoiceViewModel(invoiceFor(), VIEW_OPTIONS.today);
		assert.deepEqual(
			values.map((node) => textOf(node)),
			model.payment.filter((term) => term.verbatim === true).map((term) => term.value),
			"the amount, the address, and the link are the focusable values",
		);
		assert.deepEqual(
			values.map((node) => node.attributes["aria-label"]),
			["Pays to", "Amount", "Payment link"],
			"each focus stop names the term whose value it holds",
		);
		for (const node of values) {
			assert.equal(node.attributes.tabindex, "0", "each value is a keyboard stop");
			assert.equal(node.attributes.role, "group", "and carries a role an author may name");
		}
	} finally {
		fake.restore();
	}
});

test("a copy in flight does not write into a payment section the create screen has rebuilt", async () => {
	// The create screen rebuilds the whole section with `replaceChildren` each time the form creates an invoice, so a confirmation or a pending clear left running in the discarded section must not write into its detached status.
	const fake = installInteractiveDocument();
	try {
		const view = buildInvoiceViewModel(invoiceFor(), VIEW_OPTIONS.today);
		const clipboard = { writeText: async () => {} };
		const section = renderPaymentSection(view, { clipboard });
		document.body.append(section);
		const status = findAll(section, (node) => hasClass(node, "payment-status"))[0];
		const value = findAll(section, (node) => hasClass(node, "payment-value-verbatim"))[0];
		const pauses = [];
		const timer = {
			after(clear) {
				pauses.push(clear);
				return () => {};
			},
		};
		const click = copyControlClick(textOf(value), clipboard, value, status, timer);

		click();
		await drain();
		await drain();
		assert.equal(textOf(status), "Copied", "a copy on the mounted section confirms in its live region");

		// The section is rebuilt while the second copy's confirmation is still in flight.
		click();
		document.body.replaceChildren(renderPaymentSection(view, { clipboard }));
		await drain();
		await drain();
		assert.equal(textOf(status), "", "the detached status is not written once its section is gone");
		pauses[1]();
		assert.equal(textOf(status), "", "and the pending clear does not write into it either");
	} finally {
		fake.restore();
	}
});

test("the invoice view surfaces a release that throws as the app's own sentence, not the stop's", () => {
	const fake = installInteractiveDocument();
	const createElement = document.createElement;
	// The document is built after the payment section has taken its fittings, so a document that refuses the article fails the render with the section's release still to run — and the stop below throws the way a release a browser refuses does.
	document.createElement = (tag) => {
		if (tag === "article") throw new Error("the document was refused");
		return createElement.call(document, tag);
	};
	try {
		const inner = fakeProbe(() => ({ content: 120, box: 240 }));
		let thrown = false;
		const probe = {
			measure: inner.measure,
			onResize(target, run) {
				const stop = inner.onResize(target, run);
				return () => {
					stop();
					if (thrown) return;
					thrown = true;
					throw new Error("the first stop failed");
				};
			},
		};
		let failure = null;
		try {
			renderInvoiceView(invoiceFor(), { ...VIEW_OPTIONS, notice: noticeRecorder(), fit: probe });
		} catch (error) {
			failure = error;
		}
		assert.ok(failure !== null, "a render that fails after the section took its fittings throws");
		assert.equal(String(failure.message), VIEW_BUILD_RELEASE_FAILED_MESSAGE, "the failure surfaces as the app's own fixed sentence, which is the error a developer reads in the shell's internal report rather than the sentence the payer's notice shows");
		assert.doesNotMatch(String(failure.message), /the first stop failed/, "never in the stopped subscriber's own words, which can carry internal detail the payer-facing notice must not reach");
		assert.equal(failure.cause?.message, "the document was refused", "with the failure that caused the path kept on the error rather than in its message");
		assert.deepEqual(new Set(inner.unsubscribed), new Set(inner.targets), "and every fitting the section had taken was released, the ones behind the stop that threw included");
	} finally {
		document.createElement = createElement;
		fake.restore();
	}
});
