/** The suite for the create and share UI and the app shell: form state and totals, the share dialog, route dispatch, the chrome, and hostile text kept inert as text. */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { installInteractiveDocument } from "./helpers/dom.mjs";
import { findAll, findButton, textOf } from "./helpers/tree.mjs";
import { MAX_ITEMS, computeTotals, createInvoice } from "../app/js/invoice/model.js";
import { MAX_JSON_BYTES, encodeInvoice } from "../app/js/invoice/codec.js";
import { decodeShare } from "../app/js/invoice/share.js";
import { parseHash } from "../app/js/app/router.js";
import { createDispatcher, dispatchRoute, mountShell, renderRoute } from "../app/js/app/shell.js";
import {
	addItem,
	canAddItem,
	emptyFormState,
	invoiceInputFromState,
	liveLineAmount,
	liveTotals,
	moveItem,
	parseFormState,
	payoutAddressWarning,
	planShare,
	removeItem,
	renderCreateView,
	shareSizeHint,
} from "../app/js/ui/create.js";
import { buildShareBundle, copyText } from "../app/js/ui/share.js";
import { base32nopad, utf8 } from "../app/js/util/encoding.js";

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

test("emptyFormState seeds one blank line and today's invoice number", () => {
	const state = emptyFormState("2026-10-03");
	assert.equal(state.invoiceId, "INV-20261003");
	assert.equal(state.issued, "2026-10-03");
	assert.equal(state.assetId, "eth", "the registry's first asset is the default");
	assert.equal(state.items.length, 1);
	assert.deepEqual(state.items[0], { description: "", quantity: "1", unitPrice: "" });
	assert.equal(state.taxEnabled, false);
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

test("payoutAddressWarning flags only a uniformly-cased address", () => {
	assert.match(payoutAddressWarning(PAYEE.toLowerCase()), /no EIP-55 checksum/);
	assert.match(payoutAddressWarning(PAYEE.toUpperCase().replace(/^0X/, "0x")), /no EIP-55 checksum/);
	assert.equal(payoutAddressWarning(PAYEE), null, "a checksummed address needs no caution");
	assert.equal(payoutAddressWarning(""), null, "an empty field is not a caution");
	assert.equal(payoutAddressWarning("0x1234"), null, "a malformed address is the submit-time error, not a caution");
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
