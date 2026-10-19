/** The suite for the one-line value fitter: the screen ladder and its search, the print rung table, the class it writes on a row, and the two surfaces that ask it to fit their verbatim values. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { appliedDeclaration } from "./helpers/css.mjs";
import { installInteractiveDocument } from "./helpers/dom.mjs";
import { PAYEE } from "./helpers/payee-vectors.mjs";
import { findAll, findButton, hasClass, paymentValues, textOf } from "./helpers/tree.mjs";
import { unifiedOfBytes } from "./helpers/unified-address.mjs";
import { installWindow, mockProvider, noticeRecorder } from "./helpers/wallet-mock.mjs";
import { createInvoice } from "../app/js/invoice/model.js";
import { browserLayoutProbe, FIT_RUNGS, fitValue, printFitRung, smallestFittingRung } from "../app/js/ui/fit-value.js";
import { openPayPanel } from "../app/js/ui/pay.js";
import { renderPaymentSection } from "../app/js/ui/payment-section.js";
import { buildInvoiceViewModel } from "../app/js/ui/presentation.js";
import { MAX_ZCASH_ADDRESS_LENGTH } from "../app/js/wallet/zcash-address.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const VIEW_OPTIONS = { baseUrl: "https://example.com/app/", today: "2026-10-03", clipboard: null };

/**
 * The width a payment value of a fixed character count demands at each rung's face, in pixels, and the room the two phases leave it: the inline phase shares the row with the label and the copy control, and the stacked phase gives the value the whole row.
 * The figures are a model rather than a measurement — every rung is a smaller face, so the demand falls as the ladder descends, which is the one property the search relies on.
 */
const DEMAND = {
	"fit-inline-13": 300,
	"fit-inline-12": 276,
	"fit-inline-11": 253,
	"fit-inline-10": 230,
	"fit-stacked-12": 200,
	"fit-stacked-11": 184,
	"fit-stacked-10": 168,
};

/** The pixel size each rung's face is named for, at the 16px root the page assumes. */
const RUNG_PX = {
	"fit-inline-13": 13,
	"fit-inline-12": 12,
	"fit-inline-11": 11,
	"fit-inline-10": 10,
	"fit-stacked-12": 12,
	"fit-stacked-11": 11,
	"fit-stacked-10": 10,
	"fit-residual": 10,
};

function line(overrides = {}) {
	return { description: "Design work", quantity: "2", unitPrice: "150", ...overrides };
}

function evmInvoice(overrides = {}) {
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

function zecInvoice(address) {
	return createInvoice({
		id: "INV-ZEC",
		issued: "2026-10-03",
		payee: { name: "Studio Example", address },
		chainId: "zcash",
		asset: "zec",
		items: [line()],
	});
}

/**
 * A probe whose measurements the test states and whose resize callbacks it fires by hand, so a fit is observed without a browser laying anything out.
 * `unsubscribed` records the target of every subscription the fitter dropped.
 */
function fakeProbe(measure) {
	const runs = [];
	const targets = [];
	const unsubscribed = [];
	return {
		runs,
		targets,
		unsubscribed,
		measure,
		onResize(target, run) {
			targets.push(target);
			runs.push(run);
			return () => unsubscribed.push(target);
		},
		/** Deliver the resize every subscription is waiting for, as a laid-out row reports it. */
		fire() {
			for (const run of runs) run();
		},
	};
}

/**
 * A row with the two attribute methods the fitter uses, and a record of every class list it writes, because the row is the only element the fitter may touch.
 */
function fakeRow(classes = "payment-term") {
	const attributes = { class: classes };
	const classWrites = [];
	return {
		classWrites,
		isConnected: true,
		getAttribute(name) {
			return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
		},
		setAttribute(name, value) {
			attributes[name] = String(value);
			classWrites.push(String(value));
		},
		get className() {
			return attributes.class ?? "";
		},
		/** The rungs the row carries, in the order its class list holds them. */
		get rungs() {
			return (attributes.class ?? "").split(/\s+/).filter((name) => FIT_RUNGS.includes(name));
		},
	};
}

/** A value the fitter measures but must never write to: every attribute write is recorded so a test can hold it to nothing. */
function fakeValue() {
	const writes = [];
	return {
		isConnected: true,
		writes,
		setAttribute(name, value) {
			writes.push([name, value]);
		},
		getAttribute() {
			return null;
		},
	};
}

/** The rungs a rendered element carries, read off its class attribute the way the compare above reads them. */
function rungsOf(element) {
	return String(element.attributes.class ?? "")
		.split(/\s+/)
		.filter((name) => FIT_RUNGS.includes(name));
}

/** The print ladder's rung names, which are the module's own table rather than `FIT_RUNGS`, the screen's. */
const PRINT_RUNG_NAMES = ["print-fit-1", "print-fit-2", "print-fit-3", "print-fit-4", "print-fit-wrap"];

/** The print rungs a rendered twin carries, read off its class attribute. */
function printRungsOf(element) {
	return String(element.attributes.class ?? "")
		.split(/\s+/)
		.filter((name) => PRINT_RUNG_NAMES.includes(name));
}

/** The `.pay-term` row whose label is `label`, so a test can name the row it asserts a rung on rather than counting them. */
function payTermRow(node, label) {
	return findAll(node, (child) => hasClass(child, "pay-term") && textOf(child).startsWith(label))[0];
}

function click(node) {
	node.dispatch("click", { type: "click" });
}

async function drain() {
	for (let index = 0; index < 3; index += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

test("the screen ladder is searched in two monotone phases and stops at the floor", () => {
	// The inline phase leaves the value a column beside its label and the stacked phase gives it the whole row, so a box's room is stated per phase, as the stylesheets' geometry states it.
	const fitsWith = (inlineRoom, stackedRoom) => (rung) => DEMAND[rung] <= (rung.startsWith("fit-stacked") ? stackedRoom : inlineRoom);

	assert.equal(smallestFittingRung(fitsWith(320, 260)), "fit-inline-13", "the base rung wins while it fits, so no value is shrunk for nothing");
	assert.equal(smallestFittingRung(fitsWith(280, 260)), "fit-inline-12", "a narrower box steps down to the largest rung that still fits");
	assert.equal(smallestFittingRung(fitsWith(230, 260)), "fit-inline-10", "and settles on the floor when nothing larger does");
	assert.equal(smallestFittingRung(fitsWith(229, 200)), "fit-stacked-12", "a box too narrow for the inline phase enters the stacked one, where the value has the row to itself");
	assert.equal(smallestFittingRung(fitsWith(229, 168)), "fit-stacked-10", "and steps down inside that phase too");
	assert.equal(smallestFittingRung(fitsWith(229, 167)), "fit-residual", "reaching the residual rung only when no rung of either phase fits");

	// The floor is 10px: below it a monospace face stops separating 0 from O and l from 1 at the default zoom, which is the hazard the ladder's bottom rung exists to avoid.
	assert.deepEqual([...FIT_RUNGS].sort(), Object.keys(RUNG_PX).sort(), "the ladder the module declares is exactly the eight screen rungs the stylesheets state");
	for (const rung of FIT_RUNGS) {
		assert.ok(RUNG_PX[rung] >= 10, `${rung} is at or above the 10px screen floor`);
	}
});

test("no fitting rung yields the residual rung rather than a smaller font", () => {
	assert.equal(smallestFittingRung(() => true), "fit-inline-13", "the largest rung is tried first, so nothing is shrunk below what fits");
	assert.equal(smallestFittingRung(() => false), "fit-residual", "a value no rung holds takes the residual rung rather than a face smaller than the floor");
	assert.equal(FIT_RUNGS[FIT_RUNGS.length - 1], "fit-residual", "which is the ladder's last rung, the one the search falls out of");
	const measured = [];
	smallestFittingRung((rung) => {
		measured.push(rung);
		return false;
	});
	assert.equal(measured.includes("fit-residual"), false, "the residual rung is a fallback rather than a candidate: it is never measured");
});

test("the choice costs at most three measurements per phase", () => {
	// Each phase is monotone, so the search halves it rather than walking it: three measurements is the worst case on the four-rung inline phase, and a value that fits at the base rung costs one.
	for (const threshold of [320, 300, 276, 253, 230, 200, 184, 168, 0]) {
		const measured = [];
		const chosen = smallestFittingRung((rung) => {
			measured.push(rung);
			return DEMAND[rung] <= threshold;
		});
		const inline = measured.filter((rung) => rung.startsWith("fit-inline-")).length;
		const stacked = measured.filter((rung) => rung.startsWith("fit-stacked-")).length;
		assert.ok(inline <= 3, `the inline phase spent ${inline} measurements on a ${threshold}px box`);
		assert.ok(stacked <= 3, `the stacked phase spent ${stacked} measurements on a ${threshold}px box`);
		assert.equal(measured.includes("fit-residual"), false, "and neither phase measures the residual rung");
		assert.ok(FIT_RUNGS.includes(chosen), `${chosen} is a rung of the ladder`);
	}
});

test("the print rung table fits 42, 78, 95 and 106 characters and wraps only past the floor", () => {
	// The page is Letter with 0.75in margins, so a printed value is laid out on 7in; the widest common monospace face advances 0.62em per character, which holds 67 characters at 9pt, 76 at 8pt, 87 at 7pt, and 101 at the 6pt floor.
	assert.equal(printFitRung("x".repeat(42)), "print-fit-1", "a 42-character address prints at the largest size");
	assert.equal(printFitRung("x".repeat(67)), "print-fit-1", "up to the last character 9pt holds");
	assert.equal(printFitRung("x".repeat(68)), "print-fit-2", "one character past it steps down");
	assert.equal(printFitRung("x".repeat(76)), "print-fit-2", "the 8pt rung ends where its own count says");
	assert.equal(printFitRung("x".repeat(77)), "print-fit-3");
	assert.equal(printFitRung("x".repeat(78)), "print-fit-3", "a 78-character address prints at the third rung");
	assert.equal(printFitRung("x".repeat(87)), "print-fit-3");
	assert.equal(printFitRung("x".repeat(88)), "print-fit-4");
	assert.equal(printFitRung("x".repeat(95)), "print-fit-4", "a 95-character address prints at the floor");
	assert.equal(printFitRung("x".repeat(101)), "print-fit-4", "to the last character the floor holds");
	assert.equal(printFitRung("x".repeat(106)), "print-fit-wrap", "and one past the floor wraps rather than shrinking further");
	assert.equal(printFitRung("x".repeat(311)), "print-fit-wrap", "as does the widest address the Zcash validator accepts");
	assert.equal(printFitRung(""), "print-fit-1", "an empty value needs no shrinking");
});

test("a fit writes one class on the row and replaces the previous one", () => {
	const row = fakeRow("payment-term");
	const value = fakeValue();
	let box = 400;
	// The measurement follows the face the row's own class list states, the way a real box reports the layout the class produced.
	const probe = fakeProbe(() => ({ content: DEMAND[row.rungs[0] ?? "fit-inline-13"], box }));
	const stop = fitValue({ row, value }, probe);

	assert.equal(row.className, "payment-term fit-inline-13", "the first fit writes the largest rung that holds the value");
	assert.deepEqual(row.rungs, ["fit-inline-13"], "one rung class, beside the class the row was built with");
	box = 280;
	probe.fire();
	assert.equal(row.className, "payment-term fit-inline-12", "a narrower box replaces the rung rather than stacking a second one");
	assert.deepEqual(row.rungs, ["fit-inline-12"], "so the row never carries two rungs, which would leave the cascade to pick a size");
	assert.deepEqual(value.writes, [], "the value itself is never written to: no style, no attribute, no text");
	stop();
});

test("a hidden or detached box leaves the current rung alone", () => {
	const unmeasurable = fakeRow("payment-term");
	const stopUnmeasurable = fitValue({ row: unmeasurable, value: fakeValue() }, fakeProbe(() => null));
	assert.equal(unmeasurable.className, "payment-term", "a box that cannot be measured keeps the stylesheet's base rung");
	assert.deepEqual(unmeasurable.classWrites, [], "and the fit writes no class at all rather than guessing a rung");
	stopUnmeasurable();

	const untouched = fakeRow("payment-term fit-inline-11");
	fitValue({ row: untouched, value: fakeValue() }, fakeProbe(() => ({ content: 300, box: 0 })));
	assert.equal(untouched.className, "payment-term fit-inline-11", "a box with no width yet keeps the rung the row already carries");

	const detachedValue = fakeValue();
	detachedValue.isConnected = false;
	const detachedRow = fakeRow("payment-term");
	fitValue({ row: detachedRow, value: detachedValue }, fakeProbe(() => ({ content: 300, box: 200 })));
	assert.equal(detachedRow.className, "payment-term", "a value the document no longer holds is not fitted at all");

	// The browser adapter answers the same way on an engine with no `ResizeObserver`, which is the state a fake document is in: no verdict, so no write, and a subscription with nothing to drop.
	const adapterRow = fakeRow("payment-term");
	const stopAdapter = fitValue({ row: adapterRow, value: fakeValue() }, browserLayoutProbe);
	assert.equal(adapterRow.className, "payment-term", "an unmeasurable page keeps the CSS base rung");
	stopAdapter();
});

test("a resize re-fits upward and downward", () => {
	const row = fakeRow("pay-term");
	let box = 400;
	const probe = fakeProbe(() => ({ content: DEMAND[row.rungs[0] ?? "fit-inline-13"], box }));
	const stop = fitValue({ row, value: fakeValue() }, probe);
	assert.deepEqual(row.rungs, ["fit-inline-13"], "the first fit runs as the section is drawn");

	box = 240;
	probe.fire();
	assert.deepEqual(row.rungs, ["fit-inline-10"], "a narrower box steps the face down to the largest rung that fits");
	box = 400;
	probe.fire();
	assert.deepEqual(row.rungs, ["fit-inline-13"], "and a wider one re-fits upward rather than staying shrunk");
	box = 168;
	probe.fire();
	assert.deepEqual(row.rungs, ["fit-stacked-10"], "a box too narrow for the inline phase enters the stacked one");
	box = 90;
	probe.fire();
	assert.deepEqual(row.rungs, ["fit-residual"], "and the residual rung when not even the stacked floor fits");
	stop();
});

test("the teardown stops further fitting", () => {
	const row = fakeRow("payment-term");
	let box = 400;
	const probe = fakeProbe(() => ({ content: DEMAND[row.rungs[0] ?? "fit-inline-13"], box }));
	const stop = fitValue({ row, value: fakeValue() }, probe);
	box = 200;
	stop();
	assert.deepEqual(probe.unsubscribed, [row], "the teardown drops the one resize subscription the fitter took");
	const writes = row.classWrites.length;
	probe.fire();
	assert.equal(row.classWrites.length, writes, "and a resize that arrives afterwards writes nothing");
	assert.deepEqual(row.rungs, ["fit-inline-13"], "leaving the last fit in place");
});

test("the payment section asks the fitting module about every value a wallet takes verbatim", () => {
	const fake = installInteractiveDocument();
	try {
		const model = buildInvoiceViewModel(evmInvoice(), VIEW_OPTIONS.today);
		const probe = fakeProbe(() => ({ content: 120, box: 240 }));
		const section = renderPaymentSection(model, null, { fit: probe });
		document.body.append(section);
		// A document lays a section out only once it is in the page, so the resize a real observer would deliver is the one the test delivers here.
		probe.fire();

		const rows = findAll(section, (node) => hasClass(node, "payment-term"));
		assert.equal(rows.length, model.payment.length, "every payment term is one row");
		assert.deepEqual(
			rows.map(rungsOf),
			model.payment.map((term) => (term.verbatim === true ? ["fit-inline-13"] : [])),
			"each value a wallet takes verbatim is fitted on its own row, and no row of a value it does not take carries a rung",
		);
		assert.equal(rows.filter((row) => hasClass(row, "payment-term") && rungsOf(row).length > 0).length, 3, "the amount, the address, and the link");
		assert.deepEqual(paymentValues(section), model.payment.filter((term) => term.verbatim === true).map((term) => term.value), "and the values the copy controls read are unchanged by the fit");
	} finally {
		fake.restore();
	}
});

test("a payment section rendered with no layout probe keeps the base rung", () => {
	const fake = installInteractiveDocument();
	try {
		const model = buildInvoiceViewModel(evmInvoice(), VIEW_OPTIONS.today);
		const section = renderPaymentSection(model, null);
		document.body.append(section);
		const rows = findAll(section, (node) => hasClass(node, "payment-term"));
		assert.deepEqual(rows.map(rungsOf), rows.map(() => []), "with nothing able to measure the page, every row keeps the size the stylesheet states");
		assert.equal(rows[0].attributes.class, "payment-term", "no rung class is written when no measurement can be taken");
	} finally {
		fake.restore();
	}
});

test("each print twin carries the rung its length earns", () => {
	const fake = installInteractiveDocument();
	try {
		const wide = unifiedOfBytes(189);
		assert.equal(wide.length, MAX_ZCASH_ADDRESS_LENGTH, "the fixture is the widest address the Zcash validator accepts");
		const zec = renderPaymentSection(buildInvoiceViewModel(zecInvoice(wide), VIEW_OPTIONS.today), null);
		const zecTwins = findAll(zec, (node) => hasClass(node, "payment-value-print"));
		assert.equal(textOf(zecTwins[0]), wide, "the address's print twin is the address itself");
		assert.deepEqual(printRungsOf(zecTwins[0]), ["print-fit-wrap"], "a value past the 6pt floor is the one rung that wraps");
		assert.equal(printRungsOf(zecTwins[1]).length, 1, "the amount's twin is sized from its own length");

		const evm = renderPaymentSection(buildInvoiceViewModel(evmInvoice(), VIEW_OPTIONS.today), null);
		const evmTwins = findAll(evm, (node) => hasClass(node, "payment-value-print"));
		assert.equal(textOf(evmTwins[0]), PAYEE, "a 42-character address carries its own twin");
		assert.deepEqual(printRungsOf(evmTwins[0]), ["print-fit-1"], "and prints at the largest size the print ladder states");
	} finally {
		fake.restore();
	}
});

test("the payment panel fits its recipient and the connected account with one class per row", async () => {
	const fake = installInteractiveDocument();
	// A wallet on another chain stops the flow at the network check with the account connected and nothing sent, which is the state the panel's own rows are read in.
	const provider = mockProvider({ chainId: "0x5" });
	const installed = installWindow({ ethereum: provider });
	try {
		const probe = fakeProbe(() => ({ content: 120, box: 240 }));
		const handle = openPayPanel(evmInvoice(), { notice: noticeRecorder(), clipboard: null, fit: probe });
		assert.ok(handle, "the panel opens");
		click(findButton(handle.element, "Connect wallet & pay"));
		await drain();
		probe.fire();

		const dialog = findAll(handle.element, (node) => hasClass(node, "pay-dialog"))[0];
		const recipient = payTermRow(dialog, "Recipient");
		const amount = payTermRow(dialog, "Amount due");
		const account = findAll(dialog, (node) => hasClass(node, "pay-account"))[0];
		assert.ok(recipient !== undefined && amount !== undefined, "the summary keeps its recipient and amount rows");
		assert.ok(account !== undefined, "and the connected account is shown once the wallet has handed one over");

		assert.deepEqual(rungsOf(recipient), ["fit-inline-13"], "the recipient is fitted against the panel's own column");
		assert.deepEqual(rungsOf(amount), [], "a term the panel reads off its own plan is not fitted, so the row keeps its declared size");
		assert.deepEqual(rungsOf(account), ["fit-inline-13"], "and the connected account's row is fitted the same way");
		assert.ok(probe.targets.includes(recipient) && probe.targets.includes(account), "both rows are what the fitter watches for a resize");

		// The rows are rebuilt on every state change and dropped when the panel closes, so every subscription the fitter took is handed back rather than left watching a detached row.
		handle.close();
		assert.equal(probe.unsubscribed.length, probe.targets.length, "closing the panel drops every fit subscription it took");
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("no pay-panel address value can wrap", () => {
	const appCss = readFileSync(join(root, "app/stylesheets/app.css"), "utf8");
	for (const selector of [".pay-term-value", ".pay-account", ".pay-balance"]) {
		const wrap = appliedDeclaration(appCss, selector, "overflow-wrap");
		assert.ok(wrap === undefined || wrap === "normal", `${selector} must not break a value a wallet takes verbatim`);
	}
	assert.equal(appliedDeclaration(appCss, ".pay-term-value", "white-space"), "nowrap", "a term value is held on one line and shrunk by the ladder instead of breaking");
	assert.equal(appliedDeclaration(appCss, ".pay-account-value", "white-space"), "nowrap", "as is the connected account an address is drawn in");
});
