/** The suite for the invoice view, share dialog, and stylesheets: the rendered document and its view model, the dialog's accessibility, and every reference the page makes. */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { installInteractiveDocument } from "./helpers/dom.mjs";
import { findAll, walk, textOf } from "./helpers/tree.mjs";
import { SUPPORTED_CHAIN_IDS } from "../app/js/assets/registry.js";
import { encodeInvoice } from "../app/js/invoice/codec.js";
import { createInvoice } from "../app/js/invoice/model.js";
import { parseHash } from "../app/js/app/router.js";
import { mountShell, renderRoute } from "../app/js/app/shell.js";
import {
	CHAIN_NAMES,
	buildInvoiceViewModel,
	chainName,
	formatInvoiceDate,
	invoiceStatus,
	money,
} from "../app/js/ui/presentation.js";
import { buildShareBundle, createShareDialog, openShareDialog } from "../app/js/ui/share.js";
import { renderInvoiceView } from "../app/js/ui/view.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAYEE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

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

function hasClass(node, name) {
	return (node.attributes.class ?? "").split(/\s+/).includes(name);
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
	assert.equal(model.from.email, "billing@example.com");
	assert.deepEqual(model.dates, [
		{ label: "Issued", value: "3 Oct 2026" },
		{ label: "Due", value: "2 Nov 2026" },
	]);
	assert.equal(model.lines[0].amount, "300 USDC");
	assert.deepEqual(model.notes, ["Thanks for your business.", "Payment due within 30 days."]);
	assert.deepEqual(model.payment[1], { label: "Network", value: "Ethereum (0x1)" });
	assert.ok(Object.isFrozen(model), "the view model is frozen so a renderer cannot mutate it");

	assert.equal(chainName("0x89"), "0x89", "an unnamed chain falls back to its id");
	assert.equal(chainName("constructor"), "constructor", "an inherited prototype member is not read as a chain name");
	assert.equal(chainName("toString"), "toString");
	assert.equal(money({ units: 5n, text: "5" }, "ETH"), "5 ETH");
});

test("every chain the registry supports renders under a friendly name, not its raw id", () => {
	for (const chainId of SUPPORTED_CHAIN_IDS) {
		assert.ok(
			Object.prototype.hasOwnProperty.call(CHAIN_NAMES, chainId),
			`the registry supports ${chainId}, which has no CHAIN_NAMES entry and would render as its raw id`,
		);
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
});

test("print.css gates itself to print and keeps the document whole", () => {
	const printCss = readFileSync(join(root, "app/stylesheets/print.css"), "utf8");
	assert.match(printCss, /@media print/);
	assert.match(printCss, /@page/);
	assert.match(printCss, /break-inside: avoid/);
	assert.ok(!/Cmd\/Ctrl\+P/.test(printCss), "the comment must not mistake Save as PDF for browser print");
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
		assert.ok(textOf(payment).includes(PAYEE), "the Ethereum address still renders under Payment details");
	} finally {
		fake.restore();
	}
});
