/** The suite for the create and share UI and the app shell: form state and totals, the payout-address placeholder and guidance per family, the share dialog, route dispatch, the chrome, and hostile text kept inert as text. */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { installInteractiveDocument } from "./helpers/dom.mjs";
import { ZEC_PAYEE, XMR_PAYEE } from "./helpers/payee-vectors.mjs";
import { assertSymbolCellsInDom } from "./helpers/qr-dom.mjs";
import { readSymbol } from "./helpers/qr-reader.mjs";
import { refusalMessage } from "./helpers/refusals.mjs";
import { findAll, findButton, hasClass, inputValues, textOf } from "./helpers/tree.mjs";
import { nextTask } from "./helpers/wait.mjs";
import { ASSET_FAMILIES, ASSET_REGISTRY } from "../app/js/assets/registry.js";
import { MAX_ITEMS, computeTotals, createInvoice } from "../app/js/invoice/model.js";
import { MAX_JSON_BYTES, encodeInvoice } from "../app/js/invoice/codec.js";
import { MAX_ICON_SVG_BYTES, validateIcon } from "../app/js/invoice/icon.js";
import { decodeShare } from "../app/js/invoice/share.js";
import { parseHash } from "../app/js/app/router.js";
import { createDispatcher, dispatchRoute, mountShell, renderRoute } from "../app/js/app/shell.js";
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
import { buildInvoiceViewModel } from "../app/js/ui/presentation.js";
import { buildShareBundle, copyText } from "../app/js/ui/share.js";
import { renderInvoiceView } from "../app/js/ui/view.js";
import { base32nopad, utf8 } from "../app/js/util/encoding.js";
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

test("a view renderer that throws leaves a notice, not a blank or stale document", () => {
	const fake = installInteractiveDocument();
	try {
		const shell = mountShell(document.createElement("div"));
		renderRoute(shell, parseHash(""), TOTAL_OPTIONS);
		const createView = shell.content.children[0];
		assert.equal(shell.notice.children.length, 0);

		// A hand-built invoice reaches the renderer without the validation `createInvoice` applies, so `buildInvoiceViewModel` throws while it builds the payment link — the seam the boundary covers.
		const unpayable = { ...invoiceFor(), payee: { name: "Studio Example", address: "0x1234" } };
		renderRoute(shell, { kind: "view", invoice: unpayable }, TOTAL_OPTIONS);

		assert.notEqual(shell.content.children[0], createView, "the route container drops the previous route's document");
		assert.match(textOf(shell.content), /Invoice view failed:/);
		assert.equal(shell.notice.children[0].attributes.role, "alert", "and the notice region announces it too");
		assert.match(textOf(shell.notice), /Invoice view failed:/);
		assert.match(textOf(shell.notice), /0x-prefixed 40-hex address/, "with the reason the render refused the invoice");
	} finally {
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
	assert.match(failed.message, /^The invoice could not be shared: the codec threw$/);
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

			// The payee's own screen: the invoice the form just built shows its own payment section, so the link, its symbol, and the copy fields are reachable without opening the share link.
			const created = findAll(view, (node) => node.attributes?.class === "invoice-payment")[0];
			assert.ok(created, "the created invoice's payment details are shown on the create screen");
			const createdValues = inputValues(created);
			assert.ok(createdValues.includes(path.payee), "the address the invoice pays to is one of the copy fields");
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
			assert.deepEqual(inputValues(payment), [path.payee, "300", model.paymentLink], "the address, the amount, and the link, each in its own copy field");
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

test("the icon cap is measured on the NFC form the invoice stores, not the bytes on disk", async () => {
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

test("checkIconText decides the icon field's accept or refuse from the file's text alone", () => {
	assert.deepEqual(checkIconText(ICON_SVG), { ok: true, svg: ICON_SVG }, "a good document yields the gate's own canonical text");

	const overCap = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">${"x".repeat(MAX_ICON_SVG_BYTES)}</svg>`;
	assert.deepEqual(
		checkIconText(overCap),
		{ ok: false, message: `The icon is ${Buffer.byteLength(overCap, "utf8")} bytes, over the ${MAX_ICON_SVG_BYTES}-byte limit.` },
		"an over-cap document is refused with the form's own byte-cap message",
	);

	const malformed = checkIconText("not an svg at all");
	assert.equal(malformed.ok, false, "a document the gate refuses is refused");
	assert.match(malformed.message, /must contain a single <svg> root element/, "with the gate's own reason, which carries no namespace of its own");

	// The measure is the NFC-composed value, not the raw spelling: an NFD text over the cap on disk is accepted and stored composed.
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

test("checkIconText trims a file's surrounding whitespace before the gate reads it", () => {
	// The common case a picker meets is an SVG saved with a trailing newline, so the surrounding whitespace is trimmed rather than refused: the trimmed text is the canonical value the field stores and the text the byte cap measures.
	const cases = [
		["a leading newline and tab", `\n\t${ICON_SVG}`],
		["a trailing newline", `${ICON_SVG}\n`],
		["both ends", ` ${ICON_SVG}\n\n`],
		["a leading byte-order mark", `\uFEFF${ICON_SVG}`],
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

	// Trimming removes a spelling fault and nothing else: the gate's rules still decide the trimmed text, and the two canonicalizations compose.
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
