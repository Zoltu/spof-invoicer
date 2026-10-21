/** The suite for the create and share UI and the app shell: form state and totals, the payout-address placeholder and guidance per family, the share dialog, route dispatch, the chrome, and hostile text kept inert as text. */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { appliedDeclaration, cssRules, declaration, ruleBody } from "./helpers/css.mjs";
import { installInteractiveDocument } from "./helpers/dom.mjs";
import { fakeProbe } from "./helpers/layout-probe.mjs";
import { ZEC_PAYEE, XMR_PAYEE } from "./helpers/payee-vectors.mjs";
import { assertSymbolCellsInDom } from "./helpers/qr-dom.mjs";
import { readSymbol } from "./helpers/qr-reader.mjs";
import { refusalMessage } from "./helpers/refusals.mjs";
import { findAll, findButton, hasClass, paymentValues, textOf } from "./helpers/tree.mjs";
import { unifiedOfBytes } from "./helpers/unified-address.mjs";
import { nextTask } from "./helpers/wait.mjs";
import { installWindow, mockProvider } from "./helpers/wallet-mock.mjs";
import { ASSET_FAMILIES, ASSET_REGISTRY } from "../app/js/assets/registry.js";
import { MAX_CONTACT_CHARS, MAX_CONTACT_LINE_CHARS, MAX_CONTACT_LINES, MAX_EMAIL_CHARS, MAX_ITEMS, computeTotals, createInvoice } from "../app/js/invoice/model.js";
import { MAX_JSON_BYTES, encodeInvoice } from "../app/js/invoice/codec.js";
import { MAX_ICON_SVG_BYTES, validateIcon } from "../app/js/invoice/icon.js";
import { decodeShare } from "../app/js/invoice/share.js";
import { parseHash } from "../app/js/app/router.js";
import { bootApp, createDispatcher, dispatchRoute, mountShell, renderRoute } from "../app/js/app/shell.js";
import { PaymentLinkBudgetError } from "../app/js/payment/links.js";
import {
	addItem,
	canAddItem,
	checkIconText,
	emptyFormState,
	invoiceInputFromState,
	liveLineAmount,
	liveTotals,
	moveItem,
	parseFormState,
	payoutAddressGuidance,
	payoutAddressPlaceholder,
	payoutAddressWarning,
	planShare,
	removeItem,
	renderCreateView,
	shareFailure,
	shareSizeHint,
} from "../app/js/ui/create.js";
import { FIT_CUE_CLASS, FIT_RUNGS } from "../app/js/ui/fit-value.js";
import { buildInvoiceViewModel } from "../app/js/ui/presentation.js";
import { releasable } from "../app/js/ui/release.js";
import { buildShareBundle, copyText } from "../app/js/ui/share.js";
import { renderInvoiceView } from "../app/js/ui/view.js";
import { base32nopad, base58xmr, keccak256, utf8 } from "../app/js/util/encoding.js";
import { MAX_ICON_FILE_BYTES, MAX_ICON_RAW_CODE_UNITS } from "../app/js/util/icon-capacity.js";
import { svgDataUrl } from "../app/js/util/svg-data-url.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAYEE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

const TOTAL_OPTIONS = { baseUrl: "https://example.com/app/", today: "2026-10-03", clipboard: null };

function line(overrides = {}) {
	return { description: "Design work", quantity: "2", unitPrice: "150", ...overrides };
}

function formState(overrides = {}) {
	return {
		...emptyFormState("2026-10-03"),
		payeeName: "Studio Example",
		payeeAddress: PAYEE,
		assetId: "usdc",
		items: [line()],
		...overrides,
	};
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

function sourceFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(path));
		else if (entry.name.endsWith(".ts")) files.push(path);
	}
	return files;
}

function b32(text) {
	return base32nopad.encode(utf8.decode(text));
}

/** A minimal icon document the gate accepts, and the file shape the icon input reads. */
const ICON_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"32\" height=\"32\"><rect width=\"32\" height=\"32\" fill=\"#123456\"/></svg>";

function iconFile(text, size = text.length) {
	return { size, text: async () => text };
}

test("emptyFormState seeds one blank line and today's invoice number", () => {
	const state = emptyFormState("2026-10-03");
	assert.equal(state.invoiceId, "INV-20261003");
	assert.equal(state.issued, "2026-10-03");
	assert.equal(state.assetId, "eth", "the registry's first asset is the default");
	assert.equal(state.items.length, 1);
	assert.deepEqual(state.items[0], { description: "", quantity: "1", unitPrice: "" });
	assert.equal(state.taxEnabled, false);
	assert.equal(state.iconSvg, "", "no icon is chosen until a file is read");
});

test("addItem appends up to MAX_ITEMS and then refuses", () => {
	let state = emptyFormState("2026-10-03");
	for (let index = 1; index < MAX_ITEMS; index += 1) state = addItem(state);
	assert.equal(state.items.length, MAX_ITEMS);
	assert.equal(canAddItem(state), false);
	const again = addItem(state);
	assert.equal(again.items.length, MAX_ITEMS, "no line past the cap");
	assert.equal(again, state, "the refused add returns the same state");
});

test("removeItem removes one line and never leaves the editor empty", () => {
	const two = { ...formState(), items: [line({ description: "first" }), line({ description: "second" })] };
	const one = removeItem(two, 0);
	assert.deepEqual(one.items.map((item) => item.description), ["second"]);
	const blank = removeItem(one, 0);
	assert.equal(blank.items.length, 1, "the last line is replaced, not dropped");
	assert.equal(blank.items[0].description, "");
	assert.equal(removeItem(two, 99), two, "an out-of-range removal is a no-op");
});

test("moveItem reorders within bounds", () => {
	const three = {
		...formState(),
		items: [line({ description: "a" }), line({ description: "b" }), line({ description: "c" })],
	};
	assert.deepEqual(moveItem(three, 0, 1).items.map((item) => item.description), ["b", "a", "c"]);
	assert.deepEqual(moveItem(three, 2, -1).items.map((item) => item.description), ["a", "c", "b"]);
	assert.equal(moveItem(three, 0, -1), three, "moving the first line up is a no-op");
	assert.equal(moveItem(three, 2, 1), three, "moving the last line down is a no-op");
});

test("invoiceInputFromState trims text and omits empty optional fields", () => {
	const input = invoiceInputFromState({
		...emptyFormState("2026-10-03"),
		payeeName: "  Studio  ",
		payeeAddress: PAYEE,
		items: [line({ description: "  Design  ", quantity: " 2 ", unitPrice: " 150 " })],
	});
	assert.equal(input.payee.name, "Studio");
	assert.deepEqual(input.items, [{ description: "Design", quantity: "2", unitPrice: "150" }]);
	assert.equal("due" in input, false);
	assert.equal("payer" in input, false);
	assert.equal("notes" in input, false);
	assert.equal("email" in input.payee, false);
	assert.equal("tax" in input, false);
	assert.equal(input.chainId, "0x1", "the chain comes from the selected asset");
	assert.equal("icon" in input, false, "an empty icon field is omitted like the other optional fields");
	assert.equal(invoiceInputFromState({ ...formState(), iconSvg: ICON_SVG }).icon, ICON_SVG, "a chosen icon rides in the input the model validates");
});

test("invoiceInputFromState carries each party's contact info and omits both when empty", () => {
	const payeeContact = "Studio Example\nbilling@example.com\n+1 555 0100";
	const payerContact = "Accounts payable\nap@acme.example";
	const input = invoiceInputFromState({
		...emptyFormState("2026-10-03"),
		payeeName: "Studio Example",
		payeeAddress: PAYEE,
		payeeContact,
		payerName: "Acme GmbH",
		payerContact,
		items: [line()],
	});
	assert.equal(input.payee.email, payeeContact, "the payee's contact lines reach the model as written");
	assert.deepEqual(input.payer, { name: "Acme GmbH", email: payerContact }, "and the bill-to block carries its own contact beside the name");

	const without = invoiceInputFromState({
		...emptyFormState("2026-10-03"),
		payeeName: "Studio Example",
		payeeAddress: PAYEE,
		items: [line()],
	});
	assert.equal("email" in without.payee, false, "two empty contact fields leave the payee with no contact key");
	assert.equal("payer" in without, false, "and no bill-to block at all");
});

test("a contact the model refuses is reported under the party's own contact field", () => {
	const tooMany = ["one", "two", "three", "four", "five"].join("\n");
	const payee = parseFormState(formState({ payeeContact: tooMany }));
	assert.equal(payee.ok, false);
	assert.equal(payee.errors[0].field, "payeeContact", "the payee's refusal lands in the payee's contact field");
	const payer = parseFormState(formState({ payerName: "Acme GmbH", payerContact: tooMany }));
	assert.equal(payer.ok, false);
	assert.equal(payer.errors[0].field, "payerContact", "and the payer's refusal in the payer's");
	assert.match(payer.errors[0].message, new RegExp(`at most ${MAX_CONTACT_LINES} lines`));
});

test("the create form accepts the widest contact value its hint holds out", () => {
	const widest = Array.from({ length: MAX_CONTACT_LINES }, () => "m".repeat(MAX_CONTACT_LINE_CHARS)).join("\n");
	const outcome = parseFormState(formState({ payeeContact: widest }));
	assert.equal(outcome.ok, true, "the shape the hint names is one the form accepts");
	assert.equal(outcome.invoice?.payee.email, widest, "and it reaches the model as written");
});

test("the contact hint names the cap the email-shaped exception is held to", () => {
	const widestEmail = `${"m".repeat(MAX_EMAIL_CHARS - "@example.com".length)}@example.com`;
	assert.equal(widestEmail.length, MAX_EMAIL_CHARS, "the fixture is the longest single-line email the legacy branch admits");
	const accepted = parseFormState(formState({ payeeContact: widestEmail }));
	assert.equal(accepted.ok, true, "the email bound the hint names is one the form accepts");
	assert.equal(accepted.invoice?.payee.email, widestEmail, "and it reaches the model as written");
	const refused = parseFormState(formState({ payeeContact: `${widestEmail}m` }));
	assert.equal(refused.ok, false, "one character past the email cap is refused");
	assert.equal(refused.errors[0].field, "payeeContact", "and the refusal lands in the payee's contact field");
});

test("the create form carries a contact info field for each party", () => {
	const fake = installInteractiveDocument();
	try {
		const view = renderCreateView({ ...TOTAL_OPTIONS, notice: noticeRecorder() });
		const limits = new RegExp(`Up to ${MAX_CONTACT_LINES} lines, each of at most ${MAX_CONTACT_LINE_CHARS} characters, ${MAX_CONTACT_CHARS} characters in total counting the line breaks; a single-line email address of up to ${MAX_EMAIL_CHARS} characters is accepted as it is`);
		for (const [name, id] of [["payeeContact", "payee-contact"], ["payerContact", "payer-contact"]]) {
			const control = controlNamed(view, name);
			assert.equal(control.tagName, "textarea", `${name} takes more than one line`);
			const label = findAll(view, (node) => node.tagName === "label" && node.attributes?.for === id)[0];
			assert.ok(label, `the form carries a label for ${id}`);
			assert.equal(textOf(label), "Contact info (optional)", `${name} is labelled as contact info`);
			assert.match(textOf(label.parentNode), limits, `${name} names the limits it is held to`);
			assert.equal(findAll(view, (node) => node.attributes?.id === `${id}-error`).length, 1, `${name} carries the error slot its refusals land in`);
			// The hint is part of the field's description too, so the bound the field is held to is announced with the field rather than left beside it.
			assert.deepEqual(
				String(control.attributes["aria-describedby"]).split(" "),
				[`${id}-error`, `${id}-hint`],
				`${name} names its error slot and its limit hint together as the field's description`,
			);
			const hint = findAll(view, (node) => node.attributes?.id === `${id}-hint`)[0];
			assert.ok(hint, `${name} carries the hint element its description names`);
			assert.match(textOf(hint), limits, `${name}'s described hint states the bound the field is held to`);
		}
	} finally {
		fake.restore();
	}
});

test("the form shares an invoice carrying a multiline payee contact and a bill-to name and contact", () => {
	const fake = installInteractiveDocument();
	try {
		const view = renderCreateView({ ...TOTAL_OPTIONS, notice: noticeRecorder() });
		setControl(view, "payeeName", "Studio Example");
		setControl(view, "payeeAddress", PAYEE);
		setControl(view, "payeeContact", "Studio Example\nbilling@example.com");
		setControl(view, "payerName", "Acme GmbH");
		setControl(view, "payerContact", "Accounts payable\nap@acme.example");
		setControl(view, "item-0-description", "Design work");
		setControl(view, "item-0-quantity", "2");
		setControl(view, "item-0-unitPrice", "150");
		view.children[2].dispatch("submit");
		const backdrop = document.body.children.find((child) => child.attributes?.class?.includes("dialog-backdrop"));
		assert.ok(backdrop, "the share dialog opens for the valid form");
		const url = findAll(backdrop, (node) => node.attributes?.class === "share-value")[0].attributes.value;
		const shared = decodeShare(url.slice(url.indexOf("#")));
		assert.equal(shared.payee.email, "Studio Example\nbilling@example.com", "the payee's contact lines reach the shared invoice");
		assert.deepEqual(shared.payer, { name: "Acme GmbH", email: "Accounts payable\nap@acme.example" }, "and the bill-to block its name and contact");
	} finally {
		fake.restore();
	}
});

test("a bill-to contact without a client name is refused under the client-name field", () => {
	const fake = installInteractiveDocument();
	try {
		const view = renderCreateView({ ...TOTAL_OPTIONS, notice: noticeRecorder() });
		setControl(view, "payeeName", "Studio Example");
		setControl(view, "payeeAddress", PAYEE);
		setControl(view, "payerContact", "ap@acme.example");
		setControl(view, "item-0-description", "Design work");
		setControl(view, "item-0-quantity", "2");
		setControl(view, "item-0-unitPrice", "150");
		view.children[2].dispatch("submit");
		assert.equal(
			document.body.children.some((child) => child.attributes?.class?.includes("dialog-backdrop")),
			false,
			"no share dialog opens while the bill-to block has no name",
		);
		const error = findAll(view, (node) => node.attributes?.id === "payer-name-error")[0];
		assert.ok(error, "the client-name field carries an error slot");
		assert.match(textOf(error), /Client name is required when contact info is given/);
		assert.equal(error.attributes.hidden, undefined, "and the message is shown under that field");
	} finally {
		fake.restore();
	}
});

test("the client-name field states that the name is required once the bill-to block carries anything", () => {
	// The block is optional as a whole while its name is not, so a field that called the name optional told a payee who filled the client's contact info the opposite of what the validator holds and left them to meet the requirement as a post-submit error.
	const fake = installInteractiveDocument();
	try {
		const view = renderCreateView({ ...TOTAL_OPTIONS, notice: noticeRecorder() });
		const name = controlNamed(view, "payerName");
		const label = findAll(view, (node) => node.tagName === "label" && node.attributes?.for === "payer-name")[0];
		assert.ok(label, "the client-name field carries its own label");
		assert.equal(textOf(label), "Client name", "and the label names the field rather than what is optional about it");
		assert.doesNotMatch(
			`${String(name.attributes.placeholder)} ${textOf(label)}`,
			/optional/i,
			"neither the placeholder nor the label calls the client's name optional",
		);
		const hint = findAll(view, (node) => node.attributes?.id === "payer-name-hint")[0];
		assert.ok(hint, "the field carries the hint that states its requirement");
		assert.match(textOf(hint), /required/, "the hint states the requirement the validator holds");
		assert.match(textOf(hint), /optional/, "and keeps the bill-to block itself optional");
		assert.deepEqual(
			String(name.attributes["aria-describedby"]).split(" "),
			["payer-name-error", "payer-name-hint"],
			"the hint is part of the field's own description, so the requirement is announced with the field rather than left for a reader to find beside it",
		);
		const legend = findAll(view, (node) => node.tagName === "legend" && textOf(node) === "Bill to (optional)")[0];
		assert.ok(legend, "and the block the field belongs to still states that the block itself is optional");
	} finally {
		fake.restore();
	}
});

test("parseFormState builds a validated invoice", () => {
	const outcome = parseFormState(formState({ taxEnabled: true, taxLabel: "VAT 19%", taxRate: "19", due: "2026-11-02" }));
	assert.ok(outcome.ok, JSON.stringify(outcome.errors ?? []));
	assert.equal(outcome.invoice.asset, "usdc");
	assert.equal(outcome.invoice.payee.address, PAYEE);
	assert.equal(outcome.invoice.tax.rate, "19");
	assert.deepEqual(computeTotals(outcome.invoice).total.text, "357");
});

test("parseFormState collects every empty required field at once", () => {
	const outcome = parseFormState({
		...emptyFormState("2026-10-03"),
		invoiceId: "",
		items: [{ description: "", quantity: "", unitPrice: "" }],
	});
	assert.equal(outcome.ok, false);
	const fields = outcome.errors.map((error) => error.field);
	for (const field of ["payeeName", "payeeAddress", "invoiceId", "item-0-description", "item-0-quantity", "item-0-unitPrice"]) {
		assert.ok(fields.includes(field), `missing an error for ${field}`);
	}
});

test("parseFormState binds a model refusal to the field it names", () => {
	const zero = parseFormState(formState({ items: [line({ quantity: "0" })] }));
	assert.equal(zero.ok, false);
	assert.equal(zero.errors[0].field, "item-0-quantity");
	assert.match(zero.errors[0].message, /greater than zero/);

	const precise = parseFormState(formState({ items: [line({ unitPrice: "1.1234567" })] }));
	assert.equal(precise.ok, false);
	assert.equal(precise.errors[0].field, "item-0-unitPrice");
	assert.match(precise.errors[0].message, /decimal places/);

	const badAddress = parseFormState(formState({ payeeAddress: "0x1234" }));
	assert.equal(badAddress.ok, false);
	assert.equal(badAddress.errors[0].field, "payeeAddress");
	assert.ok(
		!badAddress.errors[0].message.startsWith("invoice:"),
		`the internal prefix is stripped: ${badAddress.errors[0].message}`,
	);
});

test("liveTotals computes the displayed money with the asset's decimals", () => {
	const state = formState({
		items: [line({ quantity: "2", unitPrice: "150" }), line({ description: "Rush", quantity: "1", unitPrice: "0.000001" })],
		taxEnabled: true,
		taxLabel: "VAT 19%",
		taxRate: "19",
	});
	assert.deepEqual(liveTotals(state), {
		symbol: "USDC",
		subtotal: "300.000001",
		tax: "57",
		total: "357.000001",
	});
	assert.equal(liveLineAmount(state, 0), "300");
	assert.equal(liveLineAmount(state, 1), "0.000001");
	assert.equal(liveLineAmount(state, 9), null);
});

test("liveTotals hides tax when it is off and shows a dash while a line is incomplete", () => {
	const state = formState();
	const noTax = liveTotals(state);
	assert.equal(noTax.tax, null);
	assert.equal(noTax.total, "300");
	assert.equal(liveTotals({ ...state, items: [line({ unitPrice: "" })] }), null);
	assert.equal(liveTotals({ ...state, items: [line({ quantity: "0" })] }), null);
});

test("liveTotals follows the selected asset's precision", () => {
	const precise = formState({ assetId: "usdc", items: [line({ quantity: "1.1234567", unitPrice: "1" })] });
	assert.equal(liveTotals(precise), null, "seven decimals is past USDC's six");
	assert.deepEqual(liveTotals({ ...precise, assetId: "eth" }), {
		symbol: "ETH",
		subtotal: "1.1234567",
		tax: null,
		total: "1.1234567",
	});
});

test("buildShareBundle yields a fragment URL and the blob", () => {
	const invoice = invoiceFor();
	const bundle = buildShareBundle(invoice, "https://example.com/app/");
	assert.ok(bundle.url.startsWith("https://example.com/app/#/i/"));
	assert.equal(bundle.url.slice(bundle.url.indexOf("#")), `#/i/${encodeInvoice(invoice)}`);
	assert.ok(bundle.blob.startsWith("pinv1b-"));
	assert.deepEqual(decodeShare(bundle.url.slice(bundle.url.indexOf("#"))), invoice);
	assert.deepEqual(decodeShare(bundle.blob), invoice);
});

test("copyText reports success and falls back when the clipboard is unavailable", async () => {
	const written = [];
	assert.equal(await copyText("hello", { writeText: async (text) => written.push(text) }), true);
	assert.deepEqual(written, ["hello"]);
	assert.equal(await copyText("hello", null), false);
	assert.equal(await copyText("hello", undefined), false);
	const refused = {
		writeText: async () => {
			throw new Error("not allowed");
		},
	};
	assert.equal(await copyText("hello", refused), false, "a refused write is a fallback, not a throw");
});

test("the shell builds the page chrome and mounts it in #app", () => {
	const fake = installInteractiveDocument();
	try {
		const rootElement = document.createElement("div");
		const shell = mountShell(rootElement);
		assert.equal(rootElement.children.length, 1);
		const layout = rootElement.children[0];
		assert.equal(layout.tagName, "div");
		assert.equal(layout.children[0].children[0].textContent, "Invoicing", "the brand is the first header child");
		assert.equal(shell.notice.children.length, 0, "the notice region starts empty");
		shell.showNotice("hello", "info");
		assert.equal(shell.notice.children[0].textContent, "hello");
		shell.clearNotice();
		assert.equal(shell.notice.children.length, 0);
	} finally {
		fake.restore();
	}
});

test("a hostile notice message is rendered as text, never as markup", () => {
	const fake = installInteractiveDocument();
	try {
		const shell = mountShell(document.createElement("div"));
		const hostile = "<img src=x onerror=\"alert(1)\"><script>alert(2)</script>";
		shell.showNotice(hostile, "error");
		const notice = shell.notice.children[0];
		assert.equal(notice.children.length, 1);
		assert.equal(notice.children[0], hostile, "the payload is one text child, byte for byte");
		assert.equal(notice.textContent, hostile);
		assert.deepEqual(notice.attributes, { class: "notice notice-error", role: "alert" });
		assert.ok(!Object.keys(notice.attributes).some((name) => name.startsWith("on")), "no event handler attribute");
	} finally {
		fake.restore();
	}
});

test("renderRoute switches views and keeps hostile share text inert", () => {
	const fake = installInteractiveDocument();
	try {
		const shell = mountShell(document.createElement("div"));

		renderRoute(shell, parseHash(""), TOTAL_OPTIONS);
		assert.equal(shell.content.children[0].children[0].textContent, "Create an invoice");
		assert.equal(shell.notice.children.length, 0);

		const hostile = "<svg onload=alert(1)>";
		renderRoute(shell, { kind: "error", message: hostile }, TOTAL_OPTIONS);
		assert.equal(shell.notice.children[0].children[0], hostile);
		assert.equal(shell.content.children[0].children[0].textContent, "Create an invoice", "errors fall back to create");

		const invoice = invoiceFor({ payee: { name: hostile, address: PAYEE } });
		const route = parseHash(`#/i/${encodeInvoice(invoice)}`);
		assert.equal(route.kind, "view");
		renderRoute(shell, route, TOTAL_OPTIONS);
		const invoiceView = shell.content.children[0];
		assert.ok(textOf(invoiceView).includes(invoice.id), "the rendered invoice view names the invoice as text");
		const tags = [];
		const walk = (node) => {
			for (const child of node.children) {
				if (typeof child === "string") continue;
				tags.push(child.tagName);
				walk(child);
			}
		};
		walk(invoiceView);
		assert.ok(!tags.includes("script") && !tags.includes("svg"), `hostile text became an element: ${tags.join(", ")}`);
	} finally {
		fake.restore();
	}
});

test("the shell drops a document through one release slot", () => {
	// The route container keeps one release slot, filled by the document it mounts and run as that document is dropped. The incoming release is promoted before the dropped one runs, so a release that fails can neither leave the next document unpromoted nor be run a second time, and the route that already rendered is not thrown away for a fault in the one it replaced.
	const fake = installInteractiveDocument();
	const reported = [];
	const consoleError = console.error;
	console.error = (...args) => reported.push(args);
	try {
		const shell = mountShell(document.createElement("div"));
		const released = [];
		let failed = 0;
		shell.setContent(releasable(document.createElement("p"), () => {}));
		// A document's release runs as the next one takes the container, so the third document below is the one that promotes this failing release into the live slot.
		shell.setContent(releasable(document.createElement("p"), () => {
			failed += 1;
			throw new Error("the old document's release failed");
		}));
		const third = document.createElement("p");
		assert.doesNotThrow(
			() => shell.setContent(releasable(third, () => released.push("second"))),
			"a release that fails is reported rather than thrown at the render that replaced it",
		);
		assert.equal(shell.content.children[0], third, "so the document the route just built is the one on screen");
		// The notice is announced as an alert and read by the payer, so it states what the failure leaves running and what to do about it, and keeps the exception's own message — which can carry a validator's echo of a rejected value — out of the page.
		assert.match(textOf(shell.notice), /The previous document could not be cleared away/, "and the failure is reported in the notice region");
		assert.doesNotMatch(textOf(shell.notice), /the old document's release failed/, "with none of the failure's internal detail in the payer-facing notice");
		assert.equal(shell.notice.children[0].attributes.role, "alert", "as the one announcement the notice region makes for it");
		// The failure is nowhere the payer can read it and is not dropped either: it is reported where a developer can read it, so a shipped release fault leaves a trace.
		assert.equal(reported.length, 1, "the release that threw is reported once, off the payer's surface");
		assert.equal(reported[0][1]?.message, "the old document's release failed", "with the exception that was actually thrown");

		shell.setContent(releasable(document.createElement("p"), () => {}));
		assert.deepEqual(released, ["second"], "the release the failing document's successor carried is still promoted, so it runs when the next route takes the container");
		assert.equal(failed, 1, "and the release that threw ran exactly once");
	} finally {
		console.error = consoleError;
		fake.restore();
	}
});

test("a view renderer that throws leaves a notice, not a blank or stale document", () => {
	const fake = installInteractiveDocument();
	const reported = [];
	const consoleError = console.error;
	console.error = (...args) => reported.push(args);
	try {
		const shell = mountShell(document.createElement("div"));
		renderRoute(shell, parseHash(""), TOTAL_OPTIONS);
		const createView = shell.content.children[0];
		assert.equal(shell.notice.children.length, 0);

		// A hand-built invoice reaches the renderer without the validation `createInvoice` applies, so `buildInvoiceViewModel` throws while it builds the payment link — the seam the boundary covers.
		const unpayable = { ...invoiceFor(), payee: { name: "Studio Example", address: "0x1234" } };
		renderRoute(shell, { kind: "view", invoice: unpayable }, TOTAL_OPTIONS);

		assert.notEqual(shell.content.children[0], createView, "the route container drops the previous route's document");
		assert.match(textOf(shell.content), /^The invoice could not be shown/, "the container states the failure in the app's own words, and only those");
		assert.equal(shell.notice.children[0].attributes.role, "alert", "and the notice region announces it too");
		assert.match(textOf(shell.notice), /^The invoice could not be shown/);
		assert.match(textOf(shell.notice), /Reload the page to start over/, "with the one action that clears it");
		assert.doesNotMatch(textOf(shell.notice), /0x-prefixed 40-hex address/, "and none of the renderer's own message, which can carry a validator's echo of a rejected value");
		assert.doesNotMatch(textOf(shell.content), /0x-prefixed 40-hex address/, "in the document it left behind either");
		// Nothing of the renderer's message reaches the payer, and it is not dropped: it is reported under the route whose render failed, with the validator's own error.
		assert.equal(reported.length, 1, "the failure is reported once, off the payer's surface");
		assert.equal(reported[0][0], "invoice view render:", "under the route that failed");
		assert.match(String(reported[0][1]?.message), /0x-prefixed 40-hex address/, "carrying the renderer's own error, which is what a developer needs to see");
	} finally {
		console.error = consoleError;
		fake.restore();
	}
});

test("the payout-address hint is composed from the validators' own form lists", async () => {
	// The hint names the forms each family accepts, so it is built from the lists `wallet/zcash-address.ts` and `wallet/monero-address.ts` state: a form a validator adds or drops has to appear or vanish here rather than being restated in the view.
	const { ZCASH_ADDRESS_FORMS } = await import("../app/js/wallet/zcash-address.js");
	const { MONERO_ADDRESS_FORMS } = await import("../app/js/wallet/monero-address.js");

	const zcashPlaceholder = payoutAddressPlaceholder(ASSET_REGISTRY.zec);
	const zcashGuidance = payoutAddressGuidance(ASSET_REGISTRY.zec);
	for (const form of ZCASH_ADDRESS_FORMS) {
		assert.ok(zcashPlaceholder.includes(form.prefixes.join("/")), `${form.name} missing from the placeholder`);
		assert.ok(zcashGuidance.includes(`${form.name} (${form.prefixes.join("/")})`), `${form.name} missing from the guidance`);
	}

	const moneroPlaceholder = payoutAddressPlaceholder(ASSET_REGISTRY.xmr);
	const moneroGuidance = payoutAddressGuidance(ASSET_REGISTRY.xmr);
	for (const form of MONERO_ADDRESS_FORMS) {
		assert.ok(moneroPlaceholder.includes(form.prefixes[0]), `${form.name} missing from the placeholder`);
		assert.ok(moneroGuidance.includes(`${form.characters}-character ${form.name} beginning with ${form.prefixes[0]}`), `${form.name} missing from the guidance`);
	}
});

test("the create view renders its title, form, and submit handler through the DOM helpers", () => {
	const fake = installInteractiveDocument();
	try {
		const notices = noticeRecorder();
		const view = renderCreateView({ ...TOTAL_OPTIONS, notice: notices });
		assert.equal(view.tagName, "section");
		assert.equal(view.children[0].textContent, "Create an invoice");
		const form = view.children[2];
		assert.equal(form.tagName, "form");
		assert.ok(form.listeners.submit?.length === 1, "the form handles submit");
	} finally {
		fake.restore();
	}
});

test("no view module writes markup wholesale", () => {
	const banned = /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|document\s*\.\s*write|createContextualFragment/;
	for (const file of sourceFiles(join(root, "app", "ts"))) {
		const source = readFileSync(file, "utf8");
		assert.ok(!banned.test(source), `${file} must not use a markup-sink API`);
	}
});

test("a release travels on the returned element and through no other channel", () => {
	// A release is one value on the element a surface returns (`ui/release.ts`). A callback an options bag accepts, or a `stop()` method on a handle, is a channel the caller that drops a surface can leave out or forget to honour, so neither may come back.
	const files = sourceFiles(join(root, "app", "ts"));
	for (const file of files) {
		const source = readFileSync(file, "utf8");
		assert.ok(!/\bonRelease\b/.test(source), `${file} must not take a release through a callback`);
		assert.ok(!/\bstop\?\s*:/.test(source), `${file} must not make a surface's release optional`);
		assert.ok(!/\.stop\(\)/.test(source), `${file} must not release through a method on a handle`);
	}
	const subscribers = files.filter((file) => /from "\.\/fit-value\.js"/.test(readFileSync(file, "utf8")));
	assert.ok(subscribers.length >= 4, `the sweep reads every surface that fits a value: ${subscribers.length}`);
	for (const file of subscribers) {
		assert.match(readFileSync(file, "utf8"), /from "\.\/release\.js"/, `${file} fits a value, so it returns the release on the element it built`);
	}
});

test("dispatchRoute maps every route to chrome effects without a document", () => {
	const calls = [];
	const effects = {
		clearNotice: () => calls.push("clearNotice"),
		showNotice: (message, tone) => calls.push(["showNotice", message, tone]),
		setActiveNav: (name) => calls.push(["setActiveNav", name]),
		showCreateView: () => calls.push("showCreateView"),
		showView: (invoice) => calls.push(["showView", invoice.id]),
	};

	dispatchRoute(parseHash(""), effects);
	assert.deepEqual(calls, ["clearNotice", ["setActiveNav", "create"], "showCreateView"]);

	calls.length = 0;
	dispatchRoute({ kind: "error", message: "boom" }, effects);
	assert.deepEqual(calls, [["showNotice", "boom", "error"], ["setActiveNav", "create"], "showCreateView"]);

	calls.length = 0;
	dispatchRoute({ kind: "view", invoice: invoiceFor() }, effects);
	assert.deepEqual(calls, ["clearNotice", ["setActiveNav", ""], ["showView", "INV-1"]]);
});

test("createDispatcher drops a repeated create route so the live form survives", () => {
	const calls = [];
	const effects = {
		clearNotice: () => calls.push("clearNotice"),
		showNotice: () => calls.push("showNotice"),
		setActiveNav: () => calls.push("setActiveNav"),
		showCreateView: () => calls.push("showCreateView"),
		showView: () => calls.push("showView"),
	};
	const dispatch = createDispatcher(effects);
	dispatch(parseHash(""));
	assert.deepEqual(calls, ["clearNotice", "setActiveNav", "showCreateView"]);
	dispatch(parseHash("#/create"));
	assert.deepEqual(calls, ["clearNotice", "setActiveNav", "showCreateView"], "the singleton create route is a no-op");
	dispatch(parseHash(`#/i/${encodeInvoice(invoiceFor())}`));
	assert.equal(calls.at(-1), "showView");
});

test("the shell bounds an over-long notice message", () => {
	const fake = installInteractiveDocument();
	try {
		const shell = mountShell(document.createElement("div"));
		const long = "x".repeat(2000);
		shell.showNotice(long, "error");
		const text = shell.notice.children[0].textContent;
		assert.ok(text.length < 330, `the notice stays bounded, got ${text.length} characters`);
		assert.match(text, /2000 characters/);
		assert.ok(!text.includes("x".repeat(400)), "the raw payload is not carried into the notice whole");
	} finally {
		fake.restore();
	}
});

test("the shell strips invisible and direction-formatting characters from a notice", () => {
	const fake = installInteractiveDocument();
	try {
		const shell = mountShell(document.createElement("div"));
		shell.showNotice("invoice: e\u202Evil\u200B: is not a known field", "error");
		const text = shell.notice.children[0].textContent;
		assert.equal(
			text,
			"invoice: evil: is not a known field",
			"the bidi override and zero-width space are stripped, exactly as a wallet label's are",
		);
	} finally {
		fake.restore();
	}
});

test("a hostile invoice substring cannot carry bidi formatting into the rendered notice", () => {
	const fake = installInteractiveDocument();
	try {
		const shell = mountShell(document.createElement("div"));
		// An unknown JSON key echoed into the model's field path is the hostile substring the notice used to render verbatim.
		const payload = b32("{\"v\":1,\"t\":\"invoice\",\"e\u202Evil\u200B\":1}");
		const route = parseHash(`#/i/${payload}`);
		assert.equal(route.kind, "error", "the unknown key refuses the payload");
		renderRoute(shell, route, TOTAL_OPTIONS);
		const text = shell.notice.children[0].textContent;
		assert.match(text, /is not a known field/, "the refusal still reaches the notice");
		assert.match(text, /evil/, "and its readable part survives");
		assert.doesNotMatch(text, /[\u202E\u200B]/, "no bidi override or zero-width space reaches the notice");
	} finally {
		fake.restore();
	}
});

const OVERSIZE_ITEM_COUNT = 60;
const LONG_DESCRIPTION = "€".repeat(500);

function oversizedState() {
	return formState({
		items: Array.from({ length: OVERSIZE_ITEM_COUNT }, () => ({
			description: LONG_DESCRIPTION,
			quantity: "1",
			unitPrice: "1",
		})),
	});
}

function controlNamed(rootNode, name) {
	const control = findAll(rootNode, (node) => node.attributes?.name === name)[0];
	assert.ok(control, `no control named ${name}`);
	return control;
}

function setControl(rootNode, name, value) {
	const control = controlNamed(rootNode, name);
	control.value = value;
	control.dispatch("input");
}

test("planShare refuses an oversized invoice with a payee-facing message instead of throwing", () => {
	let plan;
	assert.doesNotThrow(() => {
		plan = planShare(oversizedState(), "https://example.com/app/");
	}, "an accepted-but-unencodable invoice must not escape as a throw");
	assert.equal(plan.kind, "too-large");
	assert.match(plan.message, /too large to share/);
	assert.match(plan.message, new RegExp(String(MAX_JSON_BYTES)));
});

test("planShare yields a shareable bundle for a normal invoice", () => {
	const plan = planShare(formState(), "https://example.com/app/");
	assert.equal(plan.kind, "ready");
	assert.ok(plan.bundle.url.includes("#/i/"));
	assert.ok(plan.bundle.blob.startsWith("pinv1b-"));
});

test("a link-budget refusal reaches the payee as its own plan, with the asset and the action that clears it", () => {
	// The form's catch-all folded this into one "could not be shared": the refusal is a known state — the selected asset's widest link outgrows the symbol, whatever the invoice says — so it is classified by the error's class and answered with the payee's one move, while a genuine fault still reports itself as one.
	const refused = shareFailure(new PaymentLinkBudgetError("the eth entry builds a 512-byte link"), ASSET_REGISTRY.eth);
	assert.equal(refused.kind, "link-too-large");
	assert.match(refused.message, /ETH/);
	assert.match(refused.message, /Choose a different asset/);
	assert.doesNotMatch(refused.message, /could not be shared/);
	const failed = shareFailure(new Error("the codec threw"), ASSET_REGISTRY.eth);
	assert.equal(failed.kind, "failed");
	assert.equal(failed.message, "The invoice could not be shared. Reload the page and try again.", "a fault this form cannot explain is reported in one fixed sentence, not in the error's own words");
	assert.doesNotMatch(failed.message, /the codec threw/, "so no internal detail of the failure reaches the notice the payee reads");
	assert.equal(failed.cause instanceof Error, true, "while the error itself is carried on the refusal for a diagnostic");
});

test("a share failure the payee cannot act on is reported to the console, not only carried on the refusal", () => {
	// The refusal carries the exception so the submit that answers the payee can report it: a fault nobody can explain to the payee has to reach a developer, or the only trace of it is a sentence that says nothing about what happened.
	const fake = installInteractiveDocument();
	const reported = [];
	const consoleError = console.error;
	console.error = (...args) => reported.push(args);
	try {
		const notices = noticeRecorder();
		// A base URL that is not a string is the fault this suite can provoke through the form: the share builder refuses it, so the plan is the generic refusal rather than a budget one.
		const view = renderCreateView({ ...TOTAL_OPTIONS, baseUrl: 42, notice: notices });
		setControl(view, "payeeName", "Studio Example");
		setControl(view, "payeeAddress", PAYEE);
		setControl(view, "item-0-description", "Design work");
		setControl(view, "item-0-quantity", "2");
		setControl(view, "item-0-unitPrice", "150");
		assert.doesNotThrow(() => view.children[2].dispatch("submit"), "the submit listener reports the fault rather than throwing it");
		assert.equal(notices.calls.at(-1)?.message, "The invoice could not be shared. Reload the page and try again.", "the payee reads the app's fixed sentence");
		assert.doesNotMatch(notices.calls.at(-1)?.message, /base URL/, "and none of the failure's own words");
		assert.equal(reported.length, 1, "and the failure behind it is reported once, off the payee's surface");
		assert.equal(reported[0][0], "share refusal:", "under the refusal it was");
		assert.match(String(reported[0][1]?.message), /the base URL must be a string/, "carrying the error the share builder raised");
	} finally {
		console.error = consoleError;
		fake.restore();
	}
});

test("a refused paste reaches the notice as the app's own sentence, with the codec's refusal reported instead", () => {
	// The paste is the payer's, and when the link was shared with them it is an attacker's, and a codec refusal can echo what it carried; so the notice states a fixed sentence and the codec's own failure goes to the console, which is the boundary every other payer-facing failure path here keeps.
	const fake = installInteractiveDocument();
	const reported = [];
	const consoleError = console.error;
	console.error = (...args) => reported.push(args);
	try {
		const shell = bootApp(document.createElement("div"), TOTAL_OPTIONS);
		const form = findAll(shell.root, (node) => node.tagName === "form" && hasClass(node, "open-form"))[0];
		const input = findAll(shell.root, (node) => node.tagName === "input" && hasClass(node, "open-input"))[0];
		assert.ok(form !== undefined && input !== undefined, "the header offers the paste box");
		// A base32 payload that decodes to text no JSON reader accepts, so the codec's refusal carries what the paste carried.
		input.value = b32("PASTE-ECHO-1234 not json");
		form.dispatch("submit", { type: "submit" });
		const notice = textOf(shell.notice);
		assert.match(notice, /could not be read as a share link or a pinv1b- blob/, "the payer reads the app's own sentence");
		assert.doesNotMatch(notice, /PASTE-ECHO/, "and none of the paste the codec's refusal echoes");
		assert.doesNotMatch(notice, /not JSON|JSON Parse/, "nor the codec's own wording");
		assert.equal(shell.notice.children[0].attributes.role, "alert", "announced as the failure it is");
		assert.equal(reported.length, 1, "and the failure behind it is reported once, off the payer's surface");
		assert.equal(reported[0][0], "pasted share refusal:", "under the refusal it was");
		assert.match(String(reported[0][1]?.message), /JSON/i, "carrying the codec's own error");

		// A retired base64url blob is refused too, and the sentence names the container this build shares, so the payer is told to ask for a fresh link rather than left with the codec's internal account of an encoding they cannot act on.
		input.value = "pinv1-AAAAAAAA";
		form.dispatch("submit", { type: "submit" });
		assert.match(textOf(shell.notice), /ask the sender for a fresh link/, "the payer is given the action that clears a retired blob");
		assert.doesNotMatch(textOf(shell.notice), /retired base64url/, "rather than the codec's own account of the encoding");
		assert.equal(reported.length, 2, "and that refusal is reported too");
	} finally {
		console.error = consoleError;
		fake.restore();
	}
});

test("shareSizeHint reports the encoded size and flags the over-cap case", () => {
	const normal = shareSizeHint(formState());
	assert.ok(normal.fits);
	assert.ok(normal.bytes > 0 && normal.bytes <= MAX_JSON_BYTES);
	const big = shareSizeHint(oversizedState());
	assert.equal(big.fits, false);
	assert.ok(big.bytes > MAX_JSON_BYTES);
	assert.equal(shareSizeHint(emptyFormState("2026-10-03")), null, "nothing is measured before the form is valid");
});

test("a normal invoice opens the share dialog with the URL and the blob", () => {
	const fake = installInteractiveDocument();
	try {
		const notices = noticeRecorder();
		const view = renderCreateView({ ...TOTAL_OPTIONS, notice: notices });
		setControl(view, "payeeName", "Studio Example");
		setControl(view, "payeeAddress", PAYEE);
		setControl(view, "item-0-description", "Design work");
		setControl(view, "item-0-quantity", "2");
		setControl(view, "item-0-unitPrice", "150");
		view.children[2].dispatch("submit");
		const backdrop = document.body.children.find((child) => child.attributes?.class?.includes("dialog-backdrop"));
		assert.ok(backdrop, "the share dialog mounted on the body");
		const values = findAll(backdrop, (node) => node.attributes?.class === "share-value").map((node) => node.attributes.value);
		assert.equal(values.length, 2, "the URL and the blob are offered");
		assert.ok(values[0].includes("#/i/"));
		assert.ok(values[1].startsWith("pinv1b-"));
		assert.ok(notices.calls.some((call) => call !== null && call.tone === "success"));
	} finally {
		fake.restore();
	}
});

test("the create view's release stops the section the payee last built", () => {
	// The section drawn for a created invoice outlives the submit that drew it, so the view returns its element carrying that section's release: the surface replacing the view releases the fitting that would otherwise watch rows the page has dropped, and a section a rebuild replaces is still released as it goes, after its replacement exists.
	const fake = installInteractiveDocument();
	const probe = fakeProbe(() => ({ content: 120, box: 240 }));
	const outstanding = () => probe.targets.length - probe.unsubscribed.length;
	try {
		const notices = noticeRecorder();
		const view = renderCreateView({ ...TOTAL_OPTIONS, notice: notices, fit: probe });
		assert.equal(typeof view.release, "function", "the view carries its release on the element it returns");
		assert.equal(probe.targets.length, 0, "and has taken nothing before an invoice is built");
		view.release();
		assert.equal(outstanding(), 0, "a view released before the payee built an invoice releases nothing");
		setControl(view, "payeeName", "Studio Example");
		setControl(view, "payeeAddress", PAYEE);
		setControl(view, "item-0-description", "Design work");
		setControl(view, "item-0-quantity", "2");
		setControl(view, "item-0-unitPrice", "150");
		view.children[2].dispatch("submit");
		const drawn = probe.targets.length;
		assert.ok(drawn > 0, "the section drawn for the created invoice takes a subscription for each value a wallet takes verbatim");
		assert.equal(outstanding(), drawn, "and holds all of them");

		// A rebuild that throws before it has a section of its own leaves the one on screen exactly as it was: releasing the live section first would leave a visible, unfitted one behind, and the failure has to release what it took instead.
		const createElement = document.createElement;
		document.createElement = (tag) => {
			if (tag === "footer") throw new Error("the section was refused");
			return createElement.call(document, tag);
		};
		try {
			assert.doesNotThrow(() => view.children[2].dispatch("submit"), "a submit whose section cannot be drawn does not escape the submit listener");
		} finally {
			document.createElement = createElement;
		}
		// The notice region was cleared before the section was built, so a submit that failed here has to say so itself: without the boundary the payee was left with no link, no dialog, and no message.
		const reported = notices.calls.filter((call) => call !== null).at(-1);
		assert.equal(reported?.tone, "error", "so the payee is told the submit failed instead of being left with a cleared notice and nothing else");
		assert.equal(reported?.message, "The invoice could not be shown or shared. Reload the page and try again.", "in the app's own fixed sentence");
		assert.doesNotMatch(String(reported?.message), /the section was refused/, "and none of the failure's internal detail");
		assert.equal(outstanding(), drawn, "the section on screen keeps every subscription it holds");
		const failed = probe.targets.slice(drawn);
		assert.ok(failed.length > 0, "while the failed build had taken some of its own");
		for (const target of failed) assert.ok(probe.unsubscribed.includes(target), "and released every one of them");

		const replaced = probe.targets.slice(0, drawn);
		view.children[2].dispatch("submit");
		for (const target of replaced) assert.ok(probe.unsubscribed.includes(target), "a rebuild that does draw one releases every subscription of the section it replaced");
		assert.equal(outstanding(), drawn, "leaving only the subscriptions of the section now on screen");
		view.release();
		assert.equal(outstanding(), 0, "and the view's own release releases the section still on screen");
	} finally {
		fake.restore();
	}
});

test("a submit whose replaced section cannot be released still shows the new invoice and opens the share dialog", () => {
	// The section being replaced is released inside the submit listener, so a stop that throws is the one failure that could strand the fitting of the section just built — nothing else holds it — and leave the listener before the share dialog opened.
	const fake = installInteractiveDocument();
	const inner = fakeProbe(() => ({ content: 120, box: 240 }));
	let thrown = false;
	const probe = {
		...inner,
		onResize(target, run) {
			const stop = inner.onResize(target, run);
			return () => {
				stop();
				if (thrown) return;
				thrown = true;
				throw new Error("the replaced section's stop failed");
			};
		},
	};
	const outstanding = () => probe.targets.length - probe.unsubscribed.length;
	try {
		const notices = noticeRecorder();
		const view = renderCreateView({ ...TOTAL_OPTIONS, notice: notices, fit: probe });
		setControl(view, "payeeName", "Studio Example");
		setControl(view, "payeeAddress", PAYEE);
		setControl(view, "item-0-description", "Design work");
		setControl(view, "item-0-quantity", "2");
		setControl(view, "item-0-unitPrice", "150");
		view.children[2].dispatch("submit");
		const first = probe.targets.length;
		assert.ok(first > 0, "the first section took a subscription for each value a wallet takes verbatim");

		assert.doesNotThrow(() => view.children[2].dispatch("submit"), "a stop that throws while the section it belonged to is released does not escape the submit listener");
		const backdrop = document.body.children.find((child) => child.attributes?.class?.includes("dialog-backdrop"));
		assert.ok(backdrop, "so the share dialog opens for the invoice the submit built");
		assert.ok(notices.calls.some((call) => call !== null && call.tone === "error"), "and the failure is reported rather than swallowed");
		assert.equal(notices.calls.at(-1)?.tone, "error", "reported after the submit's own success line, because the notice region holds one message and a report written first would be overwritten by it");

		// The section the second submit built is the one the view holds, so nothing it took was stranded by the stop that threw: the view's own release is what drops it when the route moves on.
		const second = probe.targets.slice(first);
		assert.ok(second.length > 0, "the section the second submit built took subscriptions of its own");
		assert.deepEqual(second.filter((target) => probe.unsubscribed.includes(target)), [], "and holds every one of them while it is on screen");
		view.release();
		assert.equal(outstanding(), 0, "with the view's release dropping them, because the view held the new section before the failing stop ran");
	} finally {
		fake.restore();
	}
});

test("the create view rendered with no release slot at all still returns an element that releases its fitting", () => {
	// The acceptance gate renders the create form with no release slot to fill and walks the return value as a tree root, so this is that call with the suite's own probe: the release travels on the element, and the element is still the document the tree helpers read.
	const fake = installInteractiveDocument();
	const probe = fakeProbe(() => ({ content: 120, box: 240 }));
	try {
		const create = renderCreateView({ baseUrl: "https://gateway.example/ipfs/bafy/index.html", today: "2026-10-03", clipboard: null, notice: noticeRecorder(), fit: probe });
		assert.equal(findAll(create, (node) => node.attributes?.name === "payeeName").length, 1, "the gate still walks the returned element as a tree root");
		setControl(create, "payeeName", "Studio Example");
		setControl(create, "payeeAddress", PAYEE);
		setControl(create, "item-0-description", "Design work");
		setControl(create, "item-0-quantity", "2");
		setControl(create, "item-0-unitPrice", "150");
		findAll(create, (node) => node.tagName === "form")[0].dispatch("submit");
		assert.ok(probe.targets.length > 0, "the created invoice's section took a subscription for each value a wallet takes verbatim");
		create.release();
		assert.equal(probe.targets.length - probe.unsubscribed.length, 0, "and the element the gate treats as a tree root releases every one of them");
	} finally {
		fake.restore();
	}
});

/**
 * The advance of one character in a monospace face, in em: the bound `MONO_ADVANCE_EM` in `app/ts/ui/fit-value.ts` states for the widest face a platform substitutes for it, repeated here as a figure of this suite's own so the model below is not the module's arithmetic read back.
 */
const MONO_ADVANCE_EM = 0.62;

/**
 * The room a copyable value has in the create screen's preview at the two window widths `app.css` lays the page out for, in CSS pixels: the 60rem `#app` container less its 1.25rem side padding, less the payment term's 7rem label rail and 0.5rem column gap, less the copy control drawn beside the value, which the stylesheet sizes to its own text rather than to a figure this suite could read.
 * Both figures are stated rather than measured, because the suites drive a fake DOM with no CSS: what they model is the column the preview gives a value, and the fit below is the search that column's geometry earns.
 */
const PREVIEW_VALUE_BOX = { desktop: 730, phone: 114 };

/**
 * A mainnet Monero integrated address — the 106-character form the validator accepts — built the way `wallet/monero-address.ts` reads one: the `0x13` mainnet prefix, a 77-byte body, and the four-byte Keccak-256 checksum over everything before them, in Monero's block-padded base58.
 * The body is deterministic filler, because what the validator checks is the prefix, the encoding length, and the checksum.
 */
function widestIntegratedMonero() {
	const body = new Uint8Array(77 - 4);
	body[0] = 0x13;
	for (let index = 1; index < body.length; index += 1) body[index] = (index * 7) & 0xff;
	const encoding = new Uint8Array(77);
	encoding.set(body);
	encoding.set(keccak256(body).subarray(0, 4), body.length);
	return base58xmr.encode(encoding);
}

/** The addresses an invoice of each family carries, at the lengths the app's payment values reach, each named with the length it is drawn at. */
const PREVIEW_ADDRESSES = [
	{ asset: "zec", address: unifiedOfBytes(189), label: "the 311-character unified address the Zcash validator accepts" },
	{ asset: "zec", address: ZEC_PAYEE, label: "the 78-character Sapling address" },
	{ asset: "xmr", address: XMR_PAYEE, label: "the 95-character Monero address" },
	{ asset: "xmr", address: widestIntegratedMonero(), label: "the 106-character Monero integrated address" },
	{ asset: "usdc", address: PAYEE, label: "the 42-character EVM address" },
];

/** The font size, in CSS pixels, of the rung a row carries — or of the base rung, for a row no measurement has written a rung on yet, which is the size the stylesheet draws a value's terms at before any script runs. */
function rungPx(row) {
	const carried = String(row.attributes.class ?? "").split(" ");
	const rung = FIT_RUNGS.screen.find((entry) => carried.includes(entry.rung));
	return (rung ?? FIT_RUNGS.screen[0]).sizeRem * 16;
}

/** The payment term a fitted value is drawn in, read up the value's own parent chain: the term holds the `<dd>`, which holds the value. */
function rowOfValue(value) {
	let node = value.parentNode;
	while (node !== null && !hasClass(node, "payment-term")) node = node.parentNode;
	assert.ok(node !== null, "a fitted value hangs inside the payment term whose rung its fit writes");
	return node;
}

/**
 * A probe that lays the preview out the way a monospace face does: the value's characters at the size the row's rung states, against the box the suite states, so the search has to earn the rung a monospace run needs rather than being handed one.
 * One box serves both phases of the ladder, which is stricter than the page, because the stacked phase gives a value a wider column — so a rung this model shows holding the value holds it on the page too.
 */
function previewProbe(box) {
	return fakeProbe((value) => ({ content: [...textOf(value)].length * rungPx(rowOfValue(value)) * MONO_ADVANCE_EM, box }));
}

/** The rung an address of this length takes in a column `box` wide, re-derived from the ladder's own sizes rather than read back from the fit: the first rung, in the ladder's order, whose face holds it, or the residual rung where none does. */
function expectedPreviewRung(address, box) {
	const characters = [...address].length;
	const sized = FIT_RUNGS.screen.slice(0, -1);
	const rung = sized.find((entry) => characters * entry.sizeRem * 16 * MONO_ADVANCE_EM <= box);
	return rung === undefined ? FIT_RUNGS.screen[FIT_RUNGS.screen.length - 1].rung : rung.rung;
}

/** Choose an asset in the create form, which the form reads on `change` rather than on `input`. */
function chooseAsset(view, assetId) {
	const control = controlNamed(view, "asset");
	control.value = assetId;
	control.dispatch("change");
}

/** Fill the create form with an invoice paying to `address` and submit it, returning the preview the submit drew. */
function submitInvoicePayingTo(view, address) {
	setControl(view, "payeeName", "Studio Example");
	setControl(view, "payeeAddress", address);
	setControl(view, "item-0-description", "Design work");
	setControl(view, "item-0-quantity", "2");
	setControl(view, "item-0-unitPrice", "150");
	findAll(view, (node) => node.tagName === "form")[0].dispatch("submit");
	return findAll(view, (node) => hasClass(node, "created-payment"))[0];
}

test("the create screen's preview draws a payment value in the face the payer's document draws it in, and the ladder settles every address it carries", () => {
	const invoiceCss = readFileSync(join(root, "app/stylesheets/invoice.css"), "utf8");
	// The preview is the section the payer's document carries, drawn under `.created-payment`, so the tokens its terms read are declared for that surface too: a declaration left invalid there falls back to the inherited face rather than to any face this stylesheet states.
	for (const token of ["--inv-ink", "--inv-muted", "--inv-rule", "--inv-sans", "--inv-mono"]) {
		const preview = appliedDeclaration(invoiceCss, ".created-payment", token);
		assert.ok(preview !== undefined, "invoice.css declares " + token + " on the create screen's preview, so the value it sets is drawn in the face that token states");
		assert.equal(preview, appliedDeclaration(invoiceCss, ".view-invoice", token), token + " resolves to the document's own value on the preview, so the two surfaces cannot drift");
		const stated = cssRules(invoiceCss).filter((rule) => declaration(rule.body, token) !== undefined);
		assert.equal(stated.length, 1, token + " is stated once for both surfaces rather than copied beside each");
	}
	// The chain from the section's markup to those tokens: a value a wallet takes verbatim is set in the monospace token, the term's own text in the sans one and the document's ink, and the symbol's dark modules in that same ink.
	assert.equal(declaration(ruleBody(invoiceCss, ".payment-term dd.mono"), "font-family"), "var(--inv-mono)", "a verbatim value is drawn in the monospace face");
	assert.equal(declaration(ruleBody(invoiceCss, ".payment-term dd"), "font-family"), "var(--inv-sans)", "and the term's own text in the sans face");
	assert.equal(declaration(ruleBody(invoiceCss, ".payment-term dd"), "color"), "var(--inv-ink)", "in the document's ink");
	assert.equal(declaration(ruleBody(invoiceCss, ".payment-term dt"), "color"), "var(--inv-muted)", "with the label in the muted ink");
	assert.equal(declaration(ruleBody(invoiceCss, ".payment-qr"), "border"), "1px solid var(--inv-rule)", "the symbol's card in the document's rule colour");
	assert.equal(declaration(ruleBody(invoiceCss, ".qr-module-dark"), "background"), "var(--inv-ink)", "and its dark modules in the document's ink, which an undeclared token draws as nothing");
	// The box the face is set in neither wraps nor truncates the value: a value wider than it is scrolled, which is the guarantee the fit below keeps by choosing a size rather than a break.
	assert.equal(appliedDeclaration(invoiceCss, ".payment-value", "white-space"), "nowrap", "a copyable value is held on one run whatever face it is set in");
	assert.equal(appliedDeclaration(invoiceCss, ".payment-value", "overflow-x"), "auto", "and a value wider than its box scrolls it rather than clipping it");
	assert.equal(appliedDeclaration(invoiceCss, ".payment-value", "text-overflow"), undefined, "with no ellipsis to shorten it");

	const fake = installInteractiveDocument();
	try {
		for (const [width, box] of Object.entries(PREVIEW_VALUE_BOX)) {
			for (const { asset, address, label } of PREVIEW_ADDRESSES) {
				const probe = previewProbe(box);
				const view = renderCreateView({ ...TOTAL_OPTIONS, notice: noticeRecorder(), fit: probe });
				try {
					document.body.append(view);
					chooseAsset(view, asset);
					const preview = submitInvoicePayingTo(view, address);
					// The section is built detached and mounted by the submit, so the first layout report after the mount is what fits it, exactly as the page's own observer delivers one.
					probe.fire();
					const row = findAll(preview, (node) => hasClass(node, "payment-term") && paymentValues(node).includes(address))[0];
					const where = label + " at a " + width + " window";
					assert.ok(row !== undefined, where + ": the preview draws the address, and draws its whole string rather than a shortened form of it");
					const dd = findAll(row, (node) => node.tagName === "dd")[0];
					assert.equal(dd.attributes.class, "mono", where + ": in the monospace face, the one the payer's document draws it in");
					assert.ok(findButton(row, "Copy") !== undefined, where + ": with the copy control that hands the exact string over");
					const carried = String(row.attributes.class).split(" ").filter((name) => FIT_RUNGS.screen.some((entry) => entry.rung === name));
					assert.deepEqual(carried, [expectedPreviewRung(address, box)], where + ": the fit settles the row on the largest rung whose face holds the address, shrinking the font before it gives up the line");
					const demand = [...address].length * rungPx(row) * MONO_ADVANCE_EM;
					if (carried[0] === FIT_RUNGS.screen[FIT_RUNGS.screen.length - 1].rung) {
						assert.ok(demand > box, where + ": the residual rung is taken only where the address outgrows the " + box + "px column at the screen floor");
						assert.ok(hasClass(row, FIT_CUE_CLASS), where + ": and the row carries the cue that the value may be cut off, so the payer scrolls it rather than reading a prefix as the whole address");
					} else {
						assert.ok(demand <= box, where + ": the rung the fit chose holds the address whole on one line in the " + box + "px column");
						assert.ok(!hasClass(row, FIT_CUE_CLASS), where + ": so no cue is painted beside a value the fit showed whole");
					}
				} finally {
					view.release();
				}
			}
		}
	} finally {
		fake.restore();
	}
});

test("an oversized invoice is refused with a notice instead of an uncaught throw", () => {
	const fake = installInteractiveDocument();
	try {
		const notices = noticeRecorder();
		const view = renderCreateView({ ...TOTAL_OPTIONS, notice: notices });
		setControl(view, "payeeName", "Studio Example");
		setControl(view, "payeeAddress", PAYEE);
		const addButton = findButton(view, "Add line");
		for (let index = 1; index < OVERSIZE_ITEM_COUNT; index += 1) addButton.dispatch("click");
		for (let index = 0; index < OVERSIZE_ITEM_COUNT; index += 1) {
			setControl(view, `item-${index}-description`, LONG_DESCRIPTION);
			setControl(view, `item-${index}-quantity`, "1");
			setControl(view, `item-${index}-unitPrice`, "1");
		}
		assert.doesNotThrow(() => view.children[2].dispatch("submit"), "the submit handler must not throw");
		const backdrop = document.body.children.find((child) => child.attributes?.class?.includes("dialog-backdrop"));
		assert.equal(backdrop, undefined, "no dialog opens for an unshareable invoice");
		const last = notices.calls.filter((call) => call !== null).at(-1);
		assert.equal(last.tone, "error");
		assert.match(last.message, /too large to share/);
		const warning = findAll(view, (node) => node.attributes?.class === "field-error share-size")[0];
		assert.ok(warning, "the live size hint flags the invoice as over the cap");
		assert.match(textOf(warning), /over the .* share limit/);
	} finally {
		fake.restore();
	}
});

test("removing a flagged line drops its message from the error summary", () => {
	const fake = installInteractiveDocument();
	try {
		const notices = noticeRecorder();
		const view = renderCreateView({ ...TOTAL_OPTIONS, notice: notices });
		// Payee name is left empty and line 0 is missing its unit price; line 1 is complete.
		setControl(view, "payeeAddress", PAYEE);
		setControl(view, "item-0-description", "Design work");
		setControl(view, "item-0-quantity", "1");
		findButton(view, "Add line").dispatch("click");
		setControl(view, "item-1-description", "Rush");
		setControl(view, "item-1-quantity", "1");
		setControl(view, "item-1-unitPrice", "10");
		view.children[2].dispatch("submit");

		const summary = findAll(view, (node) => node.attributes?.class === "error-summary")[0];
		assert.ok(summary, "the form carries an error summary");
		assert.match(textOf(summary), /Payee name is required/);
		assert.match(textOf(summary), /Unit price is required/);
		assert.equal(summary.attributes.hidden, undefined, "the summary is shown after a failed submit");

		const removeButtons = findAll(view, (node) => node.tagName === "button" && node.attributes?.["aria-label"] === "Remove line");
		removeButtons[0].dispatch("click");

		assert.doesNotMatch(textOf(summary), /Unit price is required/, "the removed line's error is gone from the summary");
		assert.match(textOf(summary), /Payee name is required/, "an unrelated field's error stays in the summary");
		assert.equal(summary.attributes.hidden, undefined, "the summary stays visible while an error remains");
	} finally {
		fake.restore();
	}
});

test("moving a flagged line keeps its still-true error and follows it to the new row", () => {
	const fake = installInteractiveDocument();
	try {
		const notices = noticeRecorder();
		const view = renderCreateView({ ...TOTAL_OPTIONS, notice: notices });
		// Payee name is left empty; line 0 is missing its unit price, and line 1 is complete.
		setControl(view, "payeeAddress", PAYEE);
		setControl(view, "item-0-description", "Design work");
		setControl(view, "item-0-quantity", "1");
		findButton(view, "Add line").dispatch("click");
		setControl(view, "item-1-description", "Rush");
		setControl(view, "item-1-quantity", "1");
		setControl(view, "item-1-unitPrice", "10");
		view.children[2].dispatch("submit");

		const summary = findAll(view, (node) => node.attributes?.class === "error-summary")[0];
		assert.match(textOf(summary), /Unit price is required/);

		const moveDown = findAll(view, (node) => node.tagName === "button" && node.attributes?.["aria-label"] === "Move line down");
		moveDown[0].dispatch("click");

		assert.match(textOf(summary), /Unit price is required/, "a moved line keeps its error in the summary");
		assert.match(textOf(summary), /Payee name is required/, "an unrelated field's error is untouched");
		const flaggedCell = controlNamed(view, "item-1-unitPrice").parentNode;
		assert.match(textOf(flaggedCell), /Unit price is required/, "the error follows the line to its new index");
		const clearedCell = controlNamed(view, "item-0-unitPrice").parentNode;
		assert.doesNotMatch(textOf(clearedCell), /Unit price is required/, "the complete line that moved up carries no error");
	} finally {
		fake.restore();
	}
});

test("payoutAddressWarning flags only a uniformly-cased EVM address", () => {
	assert.match(payoutAddressWarning(PAYEE.toLowerCase(), ASSET_REGISTRY.eth), /no EIP-55 checksum/);
	assert.match(payoutAddressWarning(PAYEE.toUpperCase().replace(/^0X/, "0x"), ASSET_REGISTRY.eth), /no EIP-55 checksum/);
	assert.equal(payoutAddressWarning(PAYEE, ASSET_REGISTRY.eth), null, "a checksummed address needs no caution");
	assert.equal(payoutAddressWarning("", ASSET_REGISTRY.eth), null, "an empty field is not a caution");
	assert.equal(payoutAddressWarning("0x1234", ASSET_REGISTRY.eth), null, "a malformed address is the submit-time error, not a caution");

	// A privacy-chain payee has no EIP-55 checksum to be cautioned about, so the EVM caution never speaks for that family's asset.
	for (const id of ["zec", "xmr"]) {
		assert.equal(payoutAddressWarning(PAYEE.toLowerCase(), ASSET_REGISTRY[id]), null, id);
		assert.equal(payoutAddressWarning("u1qqqqqqqqqq", ASSET_REGISTRY[id]), null, id);
	}
});

test("the payout-address placeholder and guidance follow the asset's family", async () => {
	// The EVM placeholder is composed from the validator's own form list exactly as the two privacy families' are, so the spelling a payee is told to paste cannot drift from the one the validator reads.
	const { EVM_ADDRESS_FORMS } = await import("../app/js/wallet/address.js");
	assert.equal(payoutAddressPlaceholder(ASSET_REGISTRY.eth), `${EVM_ADDRESS_FORMS[0].prefixes.join("/")}…`);
	assert.match(payoutAddressPlaceholder(ASSET_REGISTRY.usdc), /^0x/);
	assert.match(payoutAddressPlaceholder(ASSET_REGISTRY.zec), /u1/);
	assert.match(payoutAddressPlaceholder(ASSET_REGISTRY.zec), /t1\/t3/, "and names the transparent P2SH form the validator accepts as well");
	assert.match(payoutAddressPlaceholder(ASSET_REGISTRY.xmr), /4/);

	assert.equal(payoutAddressGuidance(ASSET_REGISTRY.eth), null, "the EVM family is covered by its placeholder and its checksum caution");
	assert.match(payoutAddressGuidance(ASSET_REGISTRY.zec), /mainnet Zcash/);
	assert.match(payoutAddressGuidance(ASSET_REGISTRY.xmr), /mainnet Monero/);
});

test("every family the app carries has a guidance decision, so a new one cannot ship silently", () => {
	// The guidance map is exhaustive by type exactly as the placeholder map is, so this reads the decision back for every family `ASSET_FAMILIES` names: the EVM family is covered by its placeholder and its checksum caution and returns `null` here, while every other family must name the forms its validator accepts rather than showing nothing.
	for (const family of Object.keys(ASSET_FAMILIES)) {
		const asset = { family };
		assert.notEqual(payoutAddressPlaceholder(asset), "", `${family} placeholder`);
		if (family === "evm") {
			assert.equal(payoutAddressGuidance(asset), null, family);
			continue;
		}
		assert.equal(typeof payoutAddressGuidance(asset), "string", `${family} guidance`);
		assert.notEqual(payoutAddressGuidance(asset), "", `${family} guidance`);
	}
});

test("the create form warns in place when the payout address carries no checksum", () => {
	const fake = installInteractiveDocument();
	try {
		const notices = noticeRecorder();
		const view = renderCreateView({ ...TOTAL_OPTIONS, notice: notices });
		const warning = findAll(view, (node) => node.attributes?.class === "field-warning")[0];
		assert.ok(warning, "the form carries a payout-address caution");
		assert.equal(warning.attributes.hidden, "", "no caution before an address is entered");

		setControl(view, "payeeAddress", PAYEE.toLowerCase());
		assert.equal(warning.attributes.hidden, undefined, "the caution is shown for a checksum-less address");
		assert.match(textOf(warning), /EIP-55 checksum/);

		setControl(view, "payeeAddress", PAYEE);
		assert.equal(warning.attributes.hidden, "", "the checksummed spelling clears the caution");

		setControl(view, "payeeAddress", "0x1234");
		assert.equal(warning.attributes.hidden, "", "a malformed address is not the caution");
	} finally {
		fake.restore();
	}
});

test("the create form follows the selected asset's family in the payout-address field", () => {
	const fake = installInteractiveDocument();
	try {
		const notices = noticeRecorder();
		const view = renderCreateView({ ...TOTAL_OPTIONS, notice: notices });
		const address = controlNamed(view, "payeeAddress");
		const asset = controlNamed(view, "asset");
		const hint = findAll(view, (node) => node.attributes?.class === "field-warning")[0];
		assert.ok(hint, "the form carries a payout-address slot");
		assert.equal(address.attributes.placeholder, "0x…", "the default asset is EVM");

		setControl(view, "payeeAddress", PAYEE.toLowerCase());
		assert.match(textOf(hint), /EIP-55 checksum/);

		asset.value = "zec";
		asset.dispatch("change");
		assert.match(address.attributes.placeholder, /u1/, "a Zcash asset asks for a Zcash-shaped address");
		assert.match(textOf(hint), /mainnet Zcash/);
		assert.equal(textOf(hint).includes("EIP-55"), false, "the EVM caution is not shown for a non-EVM family");
		assert.equal(hint.attributes.hidden, undefined, "the family guidance is shown instead");

		asset.value = "eth";
		asset.dispatch("change");
		assert.equal(address.attributes.placeholder, "0x…", "switching back restores the EVM placeholder");
	} finally {
		fake.restore();
	}
});

test("the create form places the asset selection before the payout-address field", () => {
	const fake = installInteractiveDocument();
	try {
		const view = renderCreateView({ ...TOTAL_OPTIONS, notice: noticeRecorder() });
		const controls = findAll(view, (node) => node.tagName === "select" || node.tagName === "input");
		const assetAt = controls.findIndex((node) => node.attributes.name === "asset");
		const addressAt = controls.findIndex((node) => node.attributes.name === "payeeAddress");
		assert.notEqual(assetAt, -1, "the form carries an asset selection");
		assert.notEqual(addressAt, -1, "the form carries a payout-address field");
		assert.ok(assetAt < addressAt, `the asset selection precedes the address field (asset at ${assetAt}, address at ${addressAt})`);
	} finally {
		fake.restore();
	}
});

test("the payout-address placeholder is read by own property and fails closed", () => {
	// A plain object literal resolves through `Object.prototype`, so a family name that collides with an inherited member would otherwise yield a function rather than a placeholder; the field then shows no placeholder at all.
	for (const family of ["constructor", "toString", "hasOwnProperty", "bitcoin", ""]) {
		assert.equal(payoutAddressPlaceholder({ family }), "", family);
	}
	assert.equal(payoutAddressPlaceholder(ASSET_REGISTRY.eth), "0x…");
	for (const asset of Object.values(ASSET_REGISTRY)) {
		assert.equal(typeof payoutAddressPlaceholder(asset), "string", asset.id);
		assert.notEqual(payoutAddressPlaceholder(asset), "", asset.id);
	}
});

test("the Monero guidance names every form the validator accepts", () => {
	const guidance = payoutAddressGuidance(ASSET_REGISTRY.xmr);
	assert.match(guidance, /mainnet Monero/);
	assert.match(guidance, /95-character standard address beginning with 4/, "the standard form");
	assert.match(guidance, /95-character subaddress beginning with 8/, "the subaddress form");
	assert.match(guidance, /106-character integrated address beginning with 4/, "the integrated form `wallet/monero-address.ts` accepts");
});

test("the payout field resolves the family through the same helper the dispatcher does", () => {
	// `wallet/payout-address.ts` validates an asset that states no family by the default EVM rules, so the field that asset is paired with must show the EVM forms rather than no hint at all.
	const familyLess = { id: "eth", symbol: "ETH", name: "Ether", chainId: "0x1", decimals: 18, kind: "native", address: null };
	assert.equal(payoutAddressPlaceholder(familyLess), "0x…");
	assert.equal(payoutAddressGuidance(familyLess), null);
	assert.match(payoutAddressWarning(PAYEE.toLowerCase(), familyLess), /no EIP-55 checksum/);

	// Only an absent field states none: a name this app carries no rules for is not defaulted to the EVM family.
	assert.equal(payoutAddressPlaceholder({ family: undefined }), "0x…", "an explicit undefined is the absent field");
	assert.equal(payoutAddressPlaceholder({ family: "bitcoin" }), "");
	assert.equal(payoutAddressGuidance({ family: "bitcoin" }), null);
	assert.equal(payoutAddressWarning(PAYEE.toLowerCase(), { family: "bitcoin" }), null);
});

test("the Zcash placeholder names every form the validator accepts", () => {
	// The hint and the validator describe one set of forms, and `wallet/zcash-address.ts` takes the `t3` P2SH spelling as well as `t1`, `zs1`, and `u1`: a payee pasting a `t3` address must see their own form in the field.
	const placeholder = payoutAddressPlaceholder(ASSET_REGISTRY.zec);
	for (const form of ["t1", "t3", "zs1", "u1"]) assert.ok(placeholder.includes(form), `${form} missing from ${placeholder}`);
	assert.match(payoutAddressGuidance(ASSET_REGISTRY.zec), /t1\/t3/);
});

/**
 * The task path this suite left piecewise: a Zcash or Monero invoice created in the form, shared, and paid from the payment section the share renders.
 * The form's per-family validation, the link builders, and the invoice view's own payment section were each covered apart, so no case drove one privacy-chain asset from the payee's own form to the payer's rendered payment details.
 */
const PRIVACY_CREATE_PATH = [
	{ assetId: "zec", payee: ZEC_PAYEE, scheme: "zcash:", amountQuery: "?amount=300" },
	{ assetId: "xmr", payee: XMR_PAYEE, scheme: "monero:", amountQuery: "?tx_amount=300" },
];

for (const path of PRIVACY_CREATE_PATH) {
	test(`a ${path.assetId.toUpperCase()} invoice created in the form is shared and renders its payment section`, () => {
		const fake = installInteractiveDocument();
		try {
			const view = renderCreateView({ ...TOTAL_OPTIONS, notice: noticeRecorder() });
			const asset = controlNamed(view, "asset");
			asset.value = path.assetId;
			asset.dispatch("change");
			setControl(view, "payeeName", "Studio Example");
			setControl(view, "payeeAddress", path.payee);
			setControl(view, "item-0-description", "Design work");
			setControl(view, "item-0-quantity", "2");
			setControl(view, "item-0-unitPrice", "150");
			assert.doesNotThrow(() => view.children[2].dispatch("submit"), "the submit handler must not throw");

			// The payee's own screen: the invoice the form just built shows its own payment section, so the link, its symbol, and the copyable values are reachable without opening the share link.
			const created = findAll(view, (node) => node.attributes?.class === "invoice-payment")[0];
			assert.ok(created, "the created invoice's payment details are shown on the create screen");
			const createdValues = paymentValues(created);
			assert.ok(createdValues.includes(path.payee), "the address the invoice pays to is one of the copyable values");
			assert.ok(createdValues.includes("300"), "beside the amount it asks for");
			const createdLink = createdValues.find((value) => value.startsWith(path.scheme));
			assert.ok(createdLink, `and the invoice's own ${path.scheme} link`);
			assert.ok(createdLink.includes(path.amountQuery), `whose amount field is the family's own: ${createdLink}`);
			assert.deepEqual(
				findAll(created, (node) => hasClass(node, "payment-copy")).map((button) => button.attributes["aria-label"]),
				["Copy Pays to", "Copy Amount", "Copy Payment link"],
				"each value a wallet takes verbatim carries its own copy control",
			);

			// The share dialog carries the invoice the form built; its link is the payer's own entry point, and the invoice it decodes to is what the payer's page renders.
			const backdrop = document.body.children.find((child) => child.attributes?.class?.includes("dialog-backdrop"));
			assert.ok(backdrop, "the share dialog opens over the page for the created invoice");
			const url = findAll(backdrop, (node) => node.attributes?.class === "share-value")[0].attributes.value;
			const shared = decodeShare(url.slice(url.indexOf("#")));
			assert.ok(shared, "the shared link decodes back to the invoice");
			assert.equal(shared.asset, path.assetId);
			assert.equal(shared.payee.address, path.payee);

			const model = buildInvoiceViewModel(shared, TOTAL_OPTIONS.today);
			assert.equal(createdLink, model.paymentLink, "the payee's own screen states the link the shared invoice carries");
			assert.equal(readSymbol(model.paymentQr).text, createdLink, "and an independent decoder reads that same URI back out of its symbol");
			const createdGrid = findAll(created, (node) => hasClass(node, "payment-qr"))[0];
			assert.ok(createdGrid, "the link's symbol is drawn beside the terms on the create screen");
			assertSymbolCellsInDom(createdGrid, model.paymentQr);

			// The payer's side of the same path: the shared invoice renders that link, its symbol, and the address and amount fields a wallet takes verbatim.
			const payer = renderInvoiceView(shared, { ...TOTAL_OPTIONS, notice: noticeRecorder() });
			const payment = findAll(payer, (node) => node.attributes?.class === "invoice-payment")[0];
			assert.ok(payment, "the shared invoice renders its payment section");
			assert.deepEqual(paymentValues(payment), [path.payee, "300", model.paymentLink], "the address, the amount, and the link, each as its own copyable value");
			const payerGrid = findAll(payment, (node) => hasClass(node, "payment-qr"))[0];
			assert.ok(payerGrid, "the link's symbol is drawn beside them");
			assertSymbolCellsInDom(payerGrid, model.paymentQr);
			assert.equal(findButton(payer, "Pay"), undefined, "a privacy-chain invoice is offered no injected-wallet control");
		} finally {
			fake.restore();
		}
	});
}

test("a good icon file sets the form's icon and previews the leaf's own data URL", async () => {
	const fake = installInteractiveDocument();
	try {
		const view = renderCreateView({ ...TOTAL_OPTIONS, notice: noticeRecorder() });
		const input = controlNamed(view, "icon");
		assert.equal(input.attributes.type, "file");
		assert.equal(input.attributes.accept, "image/svg+xml,.svg", "the picker offers SVG files");
		const remove = findButton(view, "Remove icon");
		assert.ok(remove, "the form carries a control that clears the icon");
		assert.equal(remove.attributes.hidden, "", "hidden until an icon is chosen");

		input.files = [iconFile(ICON_SVG)];
		input.dispatch("change");
		await nextTask();

		const preview = findAll(view, (node) => hasClass(node, "icon-preview"))[0];
		assert.ok(preview, "the chosen icon is previewed in place");
		assert.equal(preview.tagName, "img", "as an image rather than inline markup");
		assert.equal(preview.attributes.src, svgDataUrl(ICON_SVG), "carrying the leaf's own data URL");
		assert.equal(remove.attributes.hidden, undefined, "and the remove control is offered once one is set");
		assert.equal(findAll(view, (node) => node.attributes?.id === "icon-error")[0].attributes.hidden, "", "with no message shown");

		setControl(view, "payeeName", "Studio Example");
		setControl(view, "payeeAddress", PAYEE);
		setControl(view, "item-0-description", "Design work");
		setControl(view, "item-0-quantity", "2");
		setControl(view, "item-0-unitPrice", "150");
		view.children[2].dispatch("submit");
		const backdrop = document.body.children.find((child) => child.attributes?.class?.includes("dialog-backdrop"));
		assert.ok(backdrop, "the share dialog opens for the invoice the form built");
		const url = findAll(backdrop, (node) => node.attributes?.class === "share-value")[0].attributes.value;
		const shared = decodeShare(url.slice(url.indexOf("#")));
		assert.equal(shared.icon, ICON_SVG, "the shared invoice carries the icon, in the gate's own canonical text");

		remove.dispatch("click");
		assert.equal(findAll(view, (node) => hasClass(node, "icon-preview")).length, 0, "Remove icon clears the preview");
		assert.equal(remove.attributes.hidden, "", "and hides itself again");
	} finally {
		fake.restore();
	}
});

test("an over-cap or wrong-format icon is refused in place and leaves the invoice without one", async () => {
	const fake = installInteractiveDocument();
	try {
		const view = renderCreateView({ ...TOTAL_OPTIONS, notice: noticeRecorder() });
		const input = controlNamed(view, "icon");
		const message = () => findAll(view, (node) => node.attributes?.id === "icon-error")[0];
		assert.equal(message().attributes.hidden, "", "nothing is shown before a file is chosen");

		const oversized = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">${"x".repeat(MAX_ICON_SVG_BYTES)}</svg>`;
		input.files = [iconFile(oversized)];
		input.dispatch("change");
		await nextTask();
		assert.equal(message().attributes.hidden, undefined, "an over-cap file is refused in place");
		assert.match(textOf(message()), new RegExp(`over the ${MAX_ICON_SVG_BYTES}-byte limit`));
		assert.equal(findAll(view, (node) => hasClass(node, "icon-preview")).length, 0, "and nothing is previewed");

		// The cap is measured on the text the file yields rather than the size it claims, so a file that understates its own size is still caught.
		input.files = [iconFile(oversized, 8)];
		input.dispatch("change");
		await nextTask();
		assert.match(textOf(message()), new RegExp(`bytes, over the ${MAX_ICON_SVG_BYTES}-byte limit`));

		input.files = [iconFile("not an svg at all")];
		input.dispatch("change");
		await nextTask();
		assert.match(textOf(message()), /must contain a single <svg> root element/, "a wrong-format file is refused with the gate's own reason");
		assert.equal(findAll(view, (node) => hasClass(node, "icon-preview")).length, 0, "and still nothing is previewed");

		input.files = [iconFile("")];
		input.dispatch("change");
		await nextTask();
		assert.equal(textOf(message()), "must not be empty", "a zero-byte file is refused as its own fault rather than as a cap it exceeded");

		setControl(view, "payeeName", "Studio Example");
		setControl(view, "payeeAddress", PAYEE);
		setControl(view, "item-0-description", "Design work");
		setControl(view, "item-0-quantity", "2");
		setControl(view, "item-0-unitPrice", "150");
		view.children[2].dispatch("submit");
		const backdrop = document.body.children.find((child) => child.attributes?.class?.includes("dialog-backdrop"));
		assert.ok(backdrop, "the form still builds and shares its invoice");
		const url = findAll(backdrop, (node) => node.attributes?.class === "share-value")[0].attributes.value;
		const shared = decodeShare(url.slice(url.indexOf("#")));
		assert.equal("icon" in shared, false, "a refused icon never reaches the invoice");
	} finally {
		fake.restore();
	}
});

test("a refused pick clears the input, so the same file can be chosen again", async () => {
	const fake = installInteractiveDocument();
	try {
		const view = renderCreateView({ ...TOTAL_OPTIONS, notice: noticeRecorder() });
		const input = controlNamed(view, "icon");
		const message = () => findAll(view, (node) => node.attributes?.id === "icon-error")[0];

		// A picker sets the input's own value, and an engine fires `change` only for a selection that differs from it, so a refusal that left the value standing would keep that same file from being retried; the removal control that would clear it is hidden while the form carries no icon.
		input.value = "C:/fakepath/not-an-svg.txt";
		input.files = [iconFile("not an svg at all")];
		input.dispatch("change");
		await nextTask();
		assert.equal(message().attributes.hidden, undefined, "the file is refused under the field");
		assert.equal(input.value, "", "and the input's own value is cleared, so the same file can be picked again");

		input.value = "C:/fakepath/oversized.svg";
		input.files = [iconFile("x", MAX_ICON_FILE_BYTES + 1)];
		input.dispatch("change");
		await nextTask();
		assert.equal(input.value, "", "a file refused on its own size clears the input too");
		assert.equal(findButton(view, "Remove icon").attributes.hidden, "", "the removal control that would clear it is still hidden, since no icon is stored");

		input.files = [iconFile(ICON_SVG)];
		input.dispatch("change");
		await nextTask();
		assert.ok(findAll(view, (node) => hasClass(node, "icon-preview"))[0], "and a later pick of a good file is stored");
	} finally {
		fake.restore();
	}
});

test("a refused replacement icon leaves the icon the form already carries", async () => {
	const fake = installInteractiveDocument();
	try {
		const view = renderCreateView({ ...TOTAL_OPTIONS, notice: noticeRecorder() });
		const input = controlNamed(view, "icon");
		const message = () => findAll(view, (node) => node.attributes?.id === "icon-error")[0];
		const preview = () => findAll(view, (node) => hasClass(node, "icon-preview"))[0];

		input.files = [iconFile(ICON_SVG)];
		input.dispatch("change");
		await nextTask();
		assert.equal(preview().attributes.src, svgDataUrl(ICON_SVG), "a good pick is stored and previewed");

		// A replacement the gate refuses must not clear the icon the form already carries.
		input.files = [iconFile("not an svg at all")];
		input.dispatch("change");
		await nextTask();
		assert.equal(message().attributes.hidden, undefined, "the bad replacement is refused in place");
		assert.ok(preview(), "and the previously chosen icon stays previewed");
		assert.equal(preview().attributes.src, svgDataUrl(ICON_SVG), "still the leaf's own data URL of the good icon");

		// The invoice the form builds carries the good icon rather than the refused replacement.
		setControl(view, "payeeName", "Studio Example");
		setControl(view, "payeeAddress", PAYEE);
		setControl(view, "item-0-description", "Design work");
		setControl(view, "item-0-quantity", "2");
		setControl(view, "item-0-unitPrice", "150");
		view.children[2].dispatch("submit");
		const backdrop = document.body.children.find((child) => child.attributes?.class?.includes("dialog-backdrop"));
		assert.ok(backdrop, "the form still builds and shares its invoice");
		const url = findAll(backdrop, (node) => node.attributes?.class === "share-value")[0].attributes.value;
		const shared = decodeShare(url.slice(url.indexOf("#")));
		assert.equal(shared.icon, ICON_SVG, "the invoice carries the previously chosen icon, not the refused replacement");
	} finally {
		fake.restore();
	}
});

test("the last icon pick wins when an earlier file read settles after a later one", async () => {
	const fake = installInteractiveDocument();
	try {
		const view = renderCreateView({ ...TOTAL_OPTIONS, notice: noticeRecorder() });
		const input = controlNamed(view, "icon");
		const preview = () => findAll(view, (node) => hasClass(node, "icon-preview"))[0];
		const secondSvg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\"><rect width=\"16\" height=\"16\" fill=\"#654321\"/></svg>";
		let releaseFirst;
		const slow = { size: ICON_SVG.length, text: () => new Promise((resolve) => { releaseFirst = resolve; }) };

		input.files = [slow];
		input.dispatch("change");
		await nextTask();
		assert.equal(preview(), undefined, "the slow first read has not settled, so nothing is previewed yet");

		input.files = [iconFile(secondSvg)];
		input.dispatch("change");
		await nextTask();
		assert.equal(preview().attributes.src, svgDataUrl(secondSvg), "the later pick is the one applied");

		releaseFirst(ICON_SVG);
		await nextTask();
		assert.equal(preview().attributes.src, svgDataUrl(secondSvg), "the earlier read, settling last, does not overwrite the later pick");
	} finally {
		fake.restore();
	}
});

test("a superseded pick's read failure does not paint a stale error under the icon field", async () => {
	const fake = installInteractiveDocument();
	try {
		const view = renderCreateView({ ...TOTAL_OPTIONS, notice: noticeRecorder() });
		const input = controlNamed(view, "icon");
		const message = () => findAll(view, (node) => node.attributes?.id === "icon-error")[0];
		const preview = () => findAll(view, (node) => hasClass(node, "icon-preview"))[0];
		const secondSvg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\"><rect width=\"16\" height=\"16\" fill=\"#654321\"/></svg>";
		let failFirst;
		const slow = { size: ICON_SVG.length, text: () => new Promise((_resolve, reject) => { failFirst = reject; }) };

		input.files = [slow];
		input.dispatch("change");
		await nextTask();

		input.files = [iconFile(secondSvg)];
		input.dispatch("change");
		await nextTask();
		assert.equal(preview().attributes.src, svgDataUrl(secondSvg), "the later pick is the one applied");

		failFirst(new Error("the device vanished"));
		await nextTask();
		assert.equal(message().attributes.hidden, "", "the superseded read's failure is not shown after a newer pick");
		assert.equal(preview().attributes.src, svgDataUrl(secondSvg), "and the later pick still stands");
	} finally {
		fake.restore();
	}
});

test("a pick that settles after Remove icon does not re-apply the removed icon", async () => {
	const fake = installInteractiveDocument();
	try {
		const view = renderCreateView({ ...TOTAL_OPTIONS, notice: noticeRecorder() });
		const input = controlNamed(view, "icon");
		const remove = findButton(view, "Remove icon");
		const preview = () => findAll(view, (node) => hasClass(node, "icon-preview"))[0];
		let release;
		const slow = { size: ICON_SVG.length, text: () => new Promise((resolve) => { release = resolve; }) };

		input.files = [slow];
		input.dispatch("change");
		await nextTask();
		assert.equal(preview(), undefined, "the read has not settled, so nothing is previewed yet");

		remove.dispatch("click");
		release(ICON_SVG);
		await nextTask();
		assert.equal(preview(), undefined, "the removed icon is not re-applied by the read that settles after the removal");
		assert.equal(findAll(view, (node) => node.attributes?.id === "icon-error")[0].attributes.hidden, "", "and the removal leaves no error behind");
	} finally {
		fake.restore();
	}
});

test("the icon cap is measured on the trimmed, NFC-composed form the invoice stores, not the bytes on disk", async () => {
	const fake = installInteractiveDocument();
	try {
		const view = renderCreateView({ ...TOTAL_OPTIONS, notice: noticeRecorder() });
		const input = controlNamed(view, "icon");
		const message = () => findAll(view, (node) => node.attributes?.id === "icon-error")[0];
		// Each NFD "é" (`e\u0301`) is three UTF-8 bytes and composes to the two-byte NFC "é", so this document is over the cap as typed yet inside it once composed.
		const overhead = Buffer.byteLength("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"32\" height=\"32\"></svg>", "utf8");
		const nfd = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">${"e\u0301".repeat(Math.floor((MAX_ICON_SVG_BYTES - overhead) / 2))}</svg>`;
		const nfc = nfd.normalize("NFC");
		assert.ok(Buffer.byteLength(nfd, "utf8") > MAX_ICON_SVG_BYTES, "the NFD spelling exceeds the cap on disk");
		assert.ok(Buffer.byteLength(nfc, "utf8") <= MAX_ICON_SVG_BYTES, "and sits within it once composed");

		input.files = [iconFile(nfd)];
		input.dispatch("change");
		await nextTask();

		assert.equal(message().attributes.hidden, "", "the composed icon is accepted rather than refused as over the limit");
		const preview = findAll(view, (node) => hasClass(node, "icon-preview"))[0];
		assert.ok(preview, "and previewed");
		assert.equal(preview.attributes.src, svgDataUrl(nfc), "carrying the leaf's own data URL of the composed text");
	} finally {
		fake.restore();
	}
});

test("a whitespace-padded icon file is accepted through the picker and previewed with its interior whitespace untouched", async () => {
	const fake = installInteractiveDocument();
	try {
		const view = renderCreateView({ ...TOTAL_OPTIONS, notice: noticeRecorder() });
		const input = controlNamed(view, "icon");
		const message = () => findAll(view, (node) => node.attributes?.id === "icon-error")[0];
		const preview = () => findAll(view, (node) => hasClass(node, "icon-preview"))[0];
		// The reported case: a file saved with whitespace around the document — a leading space or tab, a trailing newline, both at once — reaches the change handler as the file's own text, and the gate trims that padding while the whitespace inside the document stays where the file wrote it.
		const interior = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"32\" height=\"32\"><title> two  words </title><rect width=\"32\" height=\"32\"/></svg>";
		const cases = [
			["a leading space and tab", ` \t${interior}`],
			["a trailing newline", `${interior}\n`],
			["both ends", `\n\t${interior}\r\n`],
		];
		for (const [label, text] of cases) {
			input.files = [iconFile(text)];
			input.dispatch("change");
			await nextTask();
			assert.equal(message().attributes.hidden, "", `${label}: the icon field shows no message`);
			assert.doesNotMatch(textOf(message()), /must not start or end with whitespace/, `${label}: the whitespace fault the report named is not shown`);
			assert.equal(preview().attributes.src, svgDataUrl(interior), `${label}: the padded file is stored and previewed as the trimmed text, its interior whitespace untouched`);
		}
	} finally {
		fake.restore();
	}
});

test("a CRLF-saved icon file is accepted through the picker, its line endings normalized to LF", async () => {
	const fake = installInteractiveDocument();
	try {
		const view = renderCreateView({ ...TOTAL_OPTIONS, notice: noticeRecorder() });
		const input = controlNamed(view, "icon");
		const message = () => findAll(view, (node) => node.attributes?.id === "icon-error")[0];
		const preview = () => findAll(view, (node) => hasClass(node, "icon-preview"))[0];
		// A multi-line document saved on Windows: the CR at each interior line break is a line ending the gate normalizes rather than the control-character fault it used to raise, so the file a Windows editor saves is previewed like any other.
		const crlf = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"32\" height=\"32\">\r\n<rect width=\"32\" height=\"32\" fill=\"#123456\"/>\r\n</svg>\r\n";
		const lf = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"32\" height=\"32\">\n<rect width=\"32\" height=\"32\" fill=\"#123456\"/>\n</svg>";

		input.files = [iconFile(crlf)];
		input.dispatch("change");
		await nextTask();

		assert.equal(message().attributes.hidden, "", "no message is shown under the icon field");
		assert.equal(preview().attributes.src, svgDataUrl(lf), "the file is stored and previewed as the normalized canonical text the gate returns");
	} finally {
		fake.restore();
	}
});

test("checkIconText decides the icon field's accept or refuse from the file's text alone", () => {
	assert.deepEqual(checkIconText(ICON_SVG), { ok: true, svg: ICON_SVG }, "a good document yields the gate's own canonical text");

	const overCap = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">${"x".repeat(MAX_ICON_SVG_BYTES)}</svg>`;
	assert.deepEqual(
		checkIconText(overCap),
		{ ok: false, message: `The icon is ${Buffer.byteLength(overCap, "utf8")} bytes, over the ${MAX_ICON_SVG_BYTES}-byte limit.` },
		"an over-cap document is refused with the gate's own byte-cap message",
	);

	const malformed = checkIconText("not an svg at all");
	assert.equal(malformed.ok, false, "a document the gate refuses is refused");
	assert.match(malformed.message, /must contain a single <svg> root element/, "with the gate's own reason, which carries no namespace of its own");

	// The measure is the trimmed, NFC-composed value, not the raw spelling: an NFD text over the cap on disk is accepted and stored composed.
	const overhead = Buffer.byteLength("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"32\" height=\"32\"></svg>", "utf8");
	const nfd = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">${"e\u0301".repeat(Math.floor((MAX_ICON_SVG_BYTES - overhead) / 2))}</svg>`;
	assert.ok(Buffer.byteLength(nfd, "utf8") > MAX_ICON_SVG_BYTES, "the NFD spelling exceeds the cap on disk");
	assert.deepEqual(checkIconText(nfd), { ok: true, svg: nfd.normalize("NFC") }, "the composed form is accepted");

	// The gate's raw code-unit bound is applied before the value is composed, so a direct caller cannot make the helper normalize an unbounded string.
	const overRaw = "x".repeat(MAX_ICON_RAW_CODE_UNITS + 1);
	assert.deepEqual(
		checkIconText(overRaw),
		{ ok: false, message: `The icon is ${overRaw.length} characters before normalization, over the ${MAX_ICON_RAW_CODE_UNITS}-character limit.` },
		"a value over the gate's raw bound is refused before it is measured or composed",
	);
	// The gate refuses that same value with that same wording, so one bound has one user-facing statement rather than two that can drift apart.
	assert.equal(
		checkIconText(overRaw).message,
		refusalMessage(() => validateIcon(overRaw)),
		"the form's refusal and the gate's refusal for the raw bound are one wording",
	);
	// A zero-byte document is its own fault rather than a cap it exceeded, on this path as on the payload one.
	assert.deepEqual(checkIconText(""), { ok: false, message: "must not be empty" }, "an empty document is refused as its own fault");
});

test("checkIconText accepts a padded file through the gate, the one place that trims and composes", () => {
	// The common case a picker meets is an SVG saved with a trailing newline, so the surrounding whitespace is trimmed rather than refused: the trimmed text is the canonical value the field stores and the text the byte cap measures.
	const cases = [
		["a leading newline and tab", `\n\t${ICON_SVG}`],
		["a trailing newline", `${ICON_SVG}\n`],
		["both ends", ` ${ICON_SVG}\n\n`],
		["a leading byte-order mark", `\uFEFF${ICON_SVG}`],
		["a trailing byte-order mark", `${ICON_SVG}\uFEFF`],
	];
	for (const [label, text] of cases) {
		assert.deepEqual(checkIconText(text), { ok: true, svg: ICON_SVG }, `${label} is trimmed to the canonical text the gate returns`);
	}

	// The cap is measured on that same trimmed text, so a document sitting at it keeps its place once the newline an editor added is trimmed off.
	const atCap = ICON_SVG.replace("</svg>", "x".repeat(MAX_ICON_SVG_BYTES - Buffer.byteLength(ICON_SVG, "utf8")) + "</svg>");
	assert.equal(Buffer.byteLength(atCap, "utf8"), MAX_ICON_SVG_BYTES, "the fixture sits exactly at the icon byte cap");
	assert.deepEqual(checkIconText(`${atCap}\n`), { ok: true, svg: atCap }, "one trailing newline past the cap is still within it once trimmed");
	assert.deepEqual(
		checkIconText(`${atCap}x\n`),
		{ ok: false, message: `The icon is ${MAX_ICON_SVG_BYTES + 1} bytes, over the ${MAX_ICON_SVG_BYTES}-byte limit.` },
		"a content byte past the cap is refused whatever whitespace surrounds it",
	);

	// The gate's trim removes a spelling fault and nothing else: every other rule still decides the trimmed, composed text, and this helper canonicalizes nothing of its own.
	const malformed = checkIconText("not an svg at all\n");
	assert.equal(malformed.ok, false, "a padded malformed document is still refused");
	assert.match(malformed.message, /must contain a single <svg> root element/, "with the gate's own reason");
	assert.deepEqual(checkIconText(" \n\t "), { ok: false, message: "must not be empty" }, "a file that is whitespace alone trims to nothing and is refused as empty");
	const nfd = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"32\" height=\"32\"><title>cafe\u0301</title></svg>";
	assert.deepEqual(checkIconText(` ${nfd}\n`), { ok: true, svg: nfd.normalize("NFC") }, "a padded NFD spelling is trimmed and composed");
});

test("checkIconText refuses a read that yields something other than text rather than throwing", () => {
	assert.deepEqual(
		checkIconText(42),
		{ ok: false, message: refusalMessage(() => validateIcon(42)) },
		"a value that is not text is refused with the gate's own wording rather than escaping the helper",
	);
	assert.equal(checkIconText(undefined).ok, false, "and a read that yields nothing at all is refused too");
});

test("the icon field refuses an over-large file before it reads it", async () => {
	const fake = installInteractiveDocument();
	try {
		const view = renderCreateView({ ...TOTAL_OPTIONS, notice: noticeRecorder() });
		const input = controlNamed(view, "icon");
		const message = () => findAll(view, (node) => node.attributes?.id === "icon-error")[0];
		let reads = 0;
		input.files = [
			{
				size: MAX_ICON_FILE_BYTES + 1,
				text: async () => {
					reads += 1;
					return ICON_SVG;
				},
			},
		];
		input.dispatch("change");
		await nextTask();
		assert.equal(reads, 0, "the file is refused before it is read");
		assert.match(textOf(message()), new RegExp(`over the ${MAX_ICON_FILE_BYTES}-byte read limit`), "the refusal names the raw read ceiling");
		assert.equal(findAll(view, (node) => hasClass(node, "icon-preview")).length, 0, "and nothing is previewed");
	} finally {
		fake.restore();
	}
});

test("a file whose read yields something other than text is refused under the icon field", async () => {
	const fake = installInteractiveDocument();
	try {
		const view = renderCreateView({ ...TOTAL_OPTIONS, notice: noticeRecorder() });
		const input = controlNamed(view, "icon");
		const message = () => findAll(view, (node) => node.attributes?.id === "icon-error")[0];

		// An engine's `File.text()` is contracted to answer a string, so a read that answers anything else must be refused under the field: the change handler fires the read without awaiting it, and a throw there would leave the pick unanswered.
		input.files = [{ size: 8, text: async () => 42 }];
		input.dispatch("change");
		await nextTask();

		assert.equal(message().attributes.hidden, undefined, "the field carries the refusal");
		assert.equal(textOf(message()), refusalMessage(() => validateIcon(42)), "with the gate's own wording for a value that is not text");
		assert.equal(findAll(view, (node) => hasClass(node, "icon-preview")).length, 0, "and no icon is stored or previewed");
	} finally {
		fake.restore();
	}
});

test("a route change dismisses the payment panel the document it replaces was opened from", () => {
	// The panel is mounted over the page rather than inside the route container, and it fits its own summary rows, so a route that replaces the document without dismissing it would leave the dialog and its fitting on a page the payer has navigated away from.
	const fake = installInteractiveDocument();
	const provider = mockProvider();
	const installed = installWindow({ ethereum: provider });
	try {
		const probe = fakeProbe(() => ({ content: 120, box: 240 }));
		const shell = mountShell(document.createElement("div"));
		const options = { ...TOTAL_OPTIONS, fit: probe };
		renderRoute(shell, parseHash(`#/i/${encodeInvoice(invoiceFor({ id: "INV-ROUTE-PANEL" }))}`), options);
		const pay = findButton(shell.content, "Pay");
		assert.ok(pay !== undefined, "the invoice's document offers its Pay control");
		pay.dispatch("click", { type: "click" });
		const backdrop = () => document.body.children.find((child) => typeof child.tagName === "string" && hasClass(child, "dialog-backdrop"));
		assert.ok(backdrop() !== undefined, "the panel mounts over the page");
		assert.ok(probe.targets.length > 0, "and its summary rows take fittings of their own");

		renderRoute(shell, parseHash(""), options);

		assert.equal(backdrop(), undefined, "a route change takes the panel down with the document it was opened from");
		assert.deepEqual(new Set(probe.unsubscribed), new Set(probe.targets), "and releases the fitting it held, so nothing the panel started outlives the document");
	} finally {
		installed.restore();
		fake.restore();
	}
});
