/** The suite for the one-line value fitter: the ladder it searches, the print rungs, the class it writes on a row, and the surfaces that ask it to fit their verbatim values. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { appliedDeclaration, cssRules, declaration, expectedPrintRung, printedCharactersAt, pxLength, ruleBody } from "./helpers/css.mjs";
import { installInteractiveDocument } from "./helpers/dom.mjs";
import { fakeProbe } from "./helpers/layout-probe.mjs";
import { PAYEE } from "./helpers/payee-vectors.mjs";
import { findAll, findButton, hasClass, paymentValues, textOf } from "./helpers/tree.mjs";
import { unifiedOfBytes } from "./helpers/unified-address.mjs";
import { installWindow, mockProvider, noticeRecorder, word } from "./helpers/wallet-mock.mjs";
import { browserLayoutProbe } from "../app/js/app/layout-probe.js";
import { createInvoice } from "../app/js/invoice/model.js";
import { FIT_LADDER, fitValue, printFitRung } from "../app/js/ui/fit-value.js";
import { openPayPanel } from "../app/js/ui/pay.js";
import { renderPaymentSection } from "../app/js/ui/payment-section.js";
import { buildInvoiceViewModel } from "../app/js/ui/presentation.js";
import { MAX_ZCASH_ADDRESS_LENGTH } from "../app/js/wallet/zcash-address.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const VIEW_OPTIONS = { baseUrl: "https://example.com/app/", today: "2026-10-03", clipboard: null };

/**
 * The screen ladder as the module publishes it: the rung names in the order the search walks them, the size each rung states, and the two phases the sized rungs belong to.
 * Every assertion about a rung's name or size reads these, so the ladder's representation can change in the module without a rewrite here.
 */
const SCREEN_RUNG_NAMES = FIT_LADDER.screen.map((entry) => entry.rung);

/** The rung names of one phase of the ladder, largest first. */
function phaseRungs(phase) {
	return FIT_LADDER.screen.filter((entry) => entry.phase === phase).map((entry) => entry.rung);
}

/** The size, in rem, the ladder states for `rung`. */
function sizeOf(rung) {
	const entry = FIT_LADDER.screen.find((candidate) => candidate.rung === rung);
	assert.ok(entry !== undefined, `${rung} is a rung of the ladder`);
	return entry.sizeRem;
}

/**
 * The width a value of a fixed character count demands at each phase's largest rung, in pixels, and the room the two phases leave it: the inline phase shares the row with the label and the copy control, and the stacked phase gives the value the whole row.
 * The figures are a model rather than a measurement — the fitter prices every smaller rung of a phase from the one measurement it takes at that phase's largest rung, so a test states one demand per phase and a box.
 */
const DEMAND = { inline: 300, stacked: 200 };

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

/** The phase whose largest rung `rung` is, read from the ladder; a row carrying no rung yet is drawn at the base, which is the inline phase's largest. */
function phaseOf(rung) {
	const entry = FIT_LADDER.screen.find((candidate) => candidate.rung === rung);
	return entry === undefined ? "inline" : entry.phase;
}

/**
 * Fit one value whose box the test states per phase, and report the rungs the fit wrote and the class the row carried at each measurement.
 * The measurement follows the face the row's class list states, the way a real box reports the layout the class produced, so what the search cost is observable from outside the module.
 */
function measurementSequence(boxes) {
	const row = fakeRow("payment-term");
	const measured = [];
	const probe = fakeProbe(() => {
		measured.push(row.rungs[0] ?? null);
		const phase = phaseOf(row.rungs[0]);
		return { content: DEMAND[phase], box: boxes()[phase] };
	});
	const stop = fitValue({ row, value: fakeValue() }, probe);
	const rungs = [...row.rungs];
	stop();
	return { measured, rungs };
}

/**
 * The measurements a fit took in each phase, counted from the rung the row carried at the time: every measurement is taken at a phase's largest rung, so that rung names the phase it priced, and the measurement of the box as it stands prices no phase at all.
 */
function measurementsPerPhase(measured) {
	const counts = { inline: 0, stacked: 0 };
	for (const rung of measured) {
		if (rung === null) continue;
		counts[phaseOf(rung)] += 1;
	}
	return counts;
}

/** The rung a value takes when the inline phase's box leaves it `inlineBox` pixels and the stacked phase's leaves it `stackedBox` pixels. */
function fittedRung(inlineBox, stackedBox) {
	const [rung = null] = measurementSequence(() => ({ inline: inlineBox, stacked: stackedBox })).rungs;
	return rung;
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
			return (attributes.class ?? "").split(/\s+/).filter((name) => SCREEN_RUNG_NAMES.includes(name));
		},
	};
}

/** A value the fitter measures and subscribes to but must never write to: every attribute write is recorded so a test can hold it to nothing. */
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

/** The rows the panel is currently holding a fit subscription for: every row a rung class was written on, which is one per fitted value it shows. */
function fittedRows(node) {
	return findAll(node, (child) => rungsOf(child).length > 0);
}

/** The rungs a rendered element carries, read off its class attribute the way the compare above reads them. */
function rungsOf(element) {
	return String(element.attributes.class ?? "")
		.split(/\s+/)
		.filter((name) => SCREEN_RUNG_NAMES.includes(name));
}

/** The print ladder's rung names, read from the module's own table so a renamed or added rung cannot leave this suite green. */
const PRINT_RUNG_NAMES = FIT_LADDER.print.map((entry) => entry.rung);

/** The print rungs a rendered twin carries, read off its class attribute. */
function printRungsOf(element) {
	return String(element.attributes.class ?? "")
		.split(/\s+/)
		.filter((name) => PRINT_RUNG_NAMES.includes(name));
}

/** The print stylesheet whose own `@page` geometry every printed break point is derived from. */
const PRINT_CSS = readFileSync(join(root, "app/stylesheets/print.css"), "utf8");

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

test("the ladder is searched in two monotone phases and stops at the floor", () => {
	// The inline phase leaves the value a column beside its label and the stacked phase gives it the whole row, so a box's room is stated per phase, as the stylesheets' geometry states it.
	// A 300px value set at the 13px base demands 277px at 12, 254 at 11, and 231 at the 10px floor; a 200px value set at the stacked 12px base demands 183 at 11 and 167 at the stacked floor.
	const inline = phaseRungs("inline");
	const stacked = phaseRungs("stacked");
	assert.deepEqual(
		inline.map(sizeOf),
		[0.8125, 0.75, 0.6875, 0.625],
		"the inline phase descends from the 13px base to the 10px floor",
	);
	assert.deepEqual(stacked.map(sizeOf), [0.75, 0.6875, 0.625], "and the stacked phase from 12px to the same floor");
	assert.equal(sizeOf(SCREEN_RUNG_NAMES[SCREEN_RUNG_NAMES.length - 1]), 0.625, "the residual rung keeps the floor's own size");

	const cases = [
		[320, 260, inline[0], "the base rung wins while it fits, so no value is shrunk for nothing"],
		[280, 260, inline[1], "a narrower box steps down to the largest rung that still fits"],
		[231, 260, inline[3], "and settles on the floor when nothing larger does"],
		[230, 260, stacked[0], "a column narrower than the floor's own demand enters the stacked phase, where the value has the row to itself"],
		[230, 168, stacked[2], "and steps down inside that phase too"],
		[230, 166, SCREEN_RUNG_NAMES[SCREEN_RUNG_NAMES.length - 1], "reaching the residual rung only when no rung of either phase fits"],
	];
	for (const [inlineBox, stackedBox, rung, why] of cases) {
		assert.equal(fittedRung(inlineBox, stackedBox), rung, why);
	}
});

test("no fitting rung yields the residual rung rather than a smaller font", () => {
	assert.equal(fittedRung(400, 400), phaseRungs("inline")[0], "the largest rung is priced first, so nothing is shrunk below what fits");
	assert.equal(
		fittedRung(100, 100),
		SCREEN_RUNG_NAMES[SCREEN_RUNG_NAMES.length - 1],
		"a value no rung holds takes the residual rung rather than a face smaller than the floor",
	);
	// The residual rung is a fallback rather than a candidate: it is never applied to be measured, which is what keeps a value from being priced at a face the ladder does not search.
	const measured = [];
	const row = fakeRow("payment-term");
	const probe = fakeProbe(() => {
		measured.push(row.rungs[0] ?? null);
		return { content: 4000, box: 100 };
	});
	fitValue({ row, value: fakeValue() }, probe);
	assert.deepEqual(measured, [null, phaseRungs("inline")[0], phaseRungs("stacked")[0]], "each phase is laid out at its own largest rung and measured once");
	assert.ok(!measured.includes(SCREEN_RUNG_NAMES[SCREEN_RUNG_NAMES.length - 1]), "and the residual rung is never measured, because it is not a rung the search prices");
});

test("a fit costs at most three measurements per phase, and only the phases it needs", () => {
	// The contract is the bound rather than one sequence: a phase is priced from a single measurement at its largest rung, so pricing a phase costs at most three measurements however many rungs it states.
	const inlineFit = measurementSequence(() => ({ inline: 320, stacked: 100 }));
	assert.deepEqual(inlineFit.rungs, [phaseRungs("inline")[0]], "a value that fits beside its label settles in the inline phase");
	assert.deepEqual(
		measurementsPerPhase(inlineFit.measured),
		{ inline: 1, stacked: 0 },
		"paying one measurement in that phase and none in the stacked one, whose row is never laid out",
	);
	assert.ok(phaseRungs("inline").length > 3, "the inline phase states more rungs than the bound, so a search that measured each rung would fail below");
	for (const [inlineBox, stackedBox] of [[230, 200], [200, 200], [230, 168], [230, 100]]) {
		const fit = measurementSequence(() => ({ inline: inlineBox, stacked: stackedBox }));
		const measured = measurementsPerPhase(fit.measured);
		assert.ok(measured.inline >= 1 && measured.inline <= 3, `the inline phase is priced in at most three measurements for a ${inlineBox}px inline box`);
		assert.ok(measured.stacked >= 1 && measured.stacked <= 3, `and the stacked phase for a ${stackedBox}px stacked box`);
		assert.ok(SCREEN_RUNG_NAMES.includes(fit.rungs[0]), `${fit.rungs[0]} is a rung of the ladder`);
	}
});

test("the print ladder's break points follow print.css's own page geometry", () => {
	// Every expectation below is derived from the @page block the printed page is laid out by — a Letter page less its declared margin, at 96 CSS pixels to the inch — so a width or a units error in the module fails here instead of being transcribed into the expectation.
	const sized = FIT_LADDER.print.filter((entry) => !entry.wraps);
	assert.equal(sized[sized.length - 1].points, 6, "the ladder stops at the 6pt floor, ordinary fine print");
	for (const rung of sized) {
		const holds = printedCharactersAt(PRINT_CSS, rung.points);
		assert.ok(holds > 0, `the ${rung.points}pt rung holds characters on the printed line`);
		assert.equal(printFitRung("x".repeat(holds)), rung.rung, `a value of the ${holds} characters the ${rung.points}pt rung holds prints at it`);
		assert.notEqual(printFitRung("x".repeat(holds + 1)), rung.rung, `and one character past that steps down from ${rung.rung}`);
	}
	assert.equal(expectedPrintRung(PRINT_CSS, FIT_LADDER, 42), "print-fit-1", "a 42-character address prints at the largest size");
	for (const characters of [0, 42, 95, 106, 135, 136, 311]) {
		assert.equal(printFitRung("x".repeat(characters)), expectedPrintRung(PRINT_CSS, FIT_LADDER, characters), `${characters} characters take the rung the printed page's geometry earns`);
	}
	// The lengths this app's pages actually carry: a Sapling address is 78 characters and a Monero integrated address 106, which the 6pt floor holds with room to spare.
	const wrapRung = FIT_LADDER.print[FIT_LADDER.print.length - 1].rung;
	assert.equal(printFitRung("x".repeat(78)), expectedPrintRung(PRINT_CSS, FIT_LADDER, 78), "a 78-character Sapling address stays at the size the page earns");
	assert.notEqual(printFitRung("x".repeat(106)), wrapRung, "and a 106-character Monero integrated address fits the print floor rather than wrapping");
	assert.equal(printFitRung("x".repeat(136)), wrapRung, "only a value past the floor wraps rather than shrinking further");
	assert.equal(printFitRung("x".repeat(311)), wrapRung, "as does the widest address the Zcash validator accepts");
	assert.equal(printFitRung(""), "print-fit-1", "an empty value needs no shrinking");
});

/** Every surface a fitted value is drawn on: the row a rung's class is written on, and the element inside that row which carries the value. */
const VALUE_SURFACES = [
	{ row: ".payment-term", value: ".payment-value" },
	{ row: ".pay-term", value: ".pay-term-value" },
	{ row: ".pay-account", value: ".pay-account-value" },
	{ row: ".pay-balance", value: ".pay-balance-value" },
];

test("every screen rung invoice.css declares matches the module's ladder, and the sizes descend to the 10px floor", () => {
	const invoiceCss = readFileSync(join(root, "app/stylesheets/invoice.css"), "utf8");
	const appCss = readFileSync(join(root, "app/stylesheets/app.css"), "utf8");
	// A rung is a class the fitter writes and a size the stylesheet states; the ladder the module publishes is what both sides are held to, so a rung added on one side alone fails here rather than being written onto a row no rule sizes.
	const rules = cssRules(invoiceCss);
	const sizes = [];
	for (const { rung, phase, sizeRem } of FIT_LADDER.screen) {
		const bodies = rules.filter((rule) => rule.selectors.some((selector) => selector.includes(`.${rung} `)) && declaration(rule.body, "font-size") !== undefined);
		assert.equal(bodies.length, 1, `invoice.css states the ${rung} rung's size exactly once`);
		const size = declaration(bodies[0].body, "font-size");
		assert.ok(String(size).endsWith("rem"), `${rung} states its size in rem, so it follows the root font size the page assumes`);
		assert.equal(pxLength(size, rung), sizeRem * 16, `${rung} is the size the fitter prices it at`);
		// Every surface that draws a fitted value is named in the rung's own rule: a rung that sizes the invoice's terms but not the panel's leaves a surface at a face the fitter never chose, and a dropped selector shows up nowhere but the browser.
		for (const { row, value } of VALUE_SURFACES) {
			assert.ok(bodies[0].selectors.includes(`${row}.${rung} ${value}`), `the ${rung} rung sizes ${row}'s value, so every surface is held to the rung the fitter writes`);
		}
		sizes.push({ rung, phase, px: pxLength(size, rung) });
	}
	// The order the rungs' rules appear in, read off the stylesheet rather than restated from the module's own list, so the claim that the ladder reads top to bottom here is checked rather than assumed.
	const declared = [];
	for (const rule of rules) {
		if (declaration(rule.body, "font-size") === undefined) continue;
		for (const { rung } of FIT_LADDER.screen) {
			if (declared.includes(rung) || !rule.selectors.some((selector) => selector.includes(`.${rung} `))) continue;
			declared.push(rung);
		}
	}
	assert.deepEqual(declared, FIT_LADDER.screen.map((entry) => entry.rung), "invoice.css declares the rungs in the ladder's own order, so the ladder reads from the base rung to the residual one");
	assert.deepEqual(sizes.filter((entry) => entry.phase === "inline").map((entry) => entry.px), [13, 12, 11, 10], "the inline phase descends from the 13px base to the 10px floor");
	assert.deepEqual(sizes.filter((entry) => entry.phase === "stacked").map((entry) => entry.px), [12, 11, 10], "the stacked phase descends from 12px to the same floor");
	const residual = sizes[sizes.length - 1];
	assert.equal(residual.phase, "residual", "the ladder ends on the residual rung, the one the search falls out of");
	assert.equal(residual.px, 10, "which keeps the floor's own size, scrolling rather than shrinking past it");
	// The floor is 10px monospace: below it a payer can no longer tell 0 from O or l from 1 in the address they are checking.
	for (const entry of sizes) assert.ok(entry.px >= 10, `${entry.rung} is at or above the 10px floor`);
	// The residual rung's cue is the scrollbar it states rather than a smaller face: the standard property carries it wherever a thin bar is drawn, and the engine rule below carries it where a full-height bar would otherwise appear.
	assert.equal(appliedDeclaration(invoiceCss, `.payment-term.${residual.rung} .payment-value`, "scrollbar-width"), "thin", "the residual rung states the visible thin scrollbar rather than hiding the overflow");
	// That engine rule also names the same four surfaces as the rung's size does, so a surface left out falls back to a full-height bar the ladder never priced.
	const residualBar = rules.filter((rule) => rule.selectors.some((selector) => selector.endsWith("::-webkit-scrollbar")) && declaration(rule.body, "height") === "6px");
	assert.equal(residualBar.length, 1, "invoice.css states the residual rung's scrollbar once");
	for (const { row, value } of VALUE_SURFACES) {
		assert.ok(residualBar[0].selectors.includes(`${row}.${residual.rung} ${value}::-webkit-scrollbar`), `the residual rung's scrollbar is stated for ${row}'s value too`);
	}

	// The stacked phase buys the value the row's whole width, and invoice.css is where the invoice's own row states that geometry: the one rule must name exactly the stacked rungs, because a rung left out sizes the value for a full row while the row still draws the label's rail.
	const stacked = FIT_LADDER.screen.filter((entry) => entry.phase === "stacked").map((entry) => entry.rung);
	const stackedRules = rules.filter((rule) => declaration(rule.body, "grid-template-columns") === "1fr");
	assert.equal(stackedRules.length, 1, "invoice.css states the invoice row's stacked columns once");
	assert.deepEqual(
		stackedRules[0].selectors.slice().sort(),
		stacked.map((rung) => `.payment-term.${rung}`).sort(),
		"and names every stacked rung, so a dropped selector cannot leave a stacked term in the label's rail",
	);

	// The size a value is drawn at before any script runs is the ladder's base rung, and each surface states it in its own base rule rather than in a rung class, so those two declarations are held to the same ladder: a base size changed on one side alone would draw a value at a size no rung prices.
	const base = FIT_LADDER.screen[0].sizeRem;
	const baseRung = FIT_LADDER.screen[0].rung;
	const invoiceBase = ruleBody(invoiceCss, ".payment-term dd.mono");
	assert.ok(invoiceBase !== undefined, "invoice.css states the face a payment value is drawn at before a fit");
	assert.equal(pxLength(declaration(invoiceBase, "font-size"), ".payment-term dd.mono"), base * 16, "which is the ladder's base rung");
	const dialogBase = ruleBody(appCss, ".pay-dialog .mono");
	assert.ok(dialogBase !== undefined, "app.css states the face the payment panel's verbatim values are drawn at before a fit");
	assert.equal(pxLength(declaration(dialogBase, "font-size"), ".pay-dialog .mono"), base * 16, "which is the same base rung");

	// Every surface that draws such a value is named in the one rule, so the size is stated here alone rather than repeated in `app.css` where it could drift.
	const panelValue = rules.find((rule) => declaration(rule.body, "font-size") === `${base}rem` && rule.selectors.some((selector) => selector.includes(`.${baseRung}`)));
	assert.ok(panelValue !== undefined, "the ladder's base rung sizes every surface that draws such a value");
	assert.ok(panelValue.selectors.includes(`.pay-term.${baseRung} .pay-term-value`), "the payment panel's own term is sized by the same rung");
	assert.ok(panelValue.selectors.includes(`.pay-account.${baseRung} .pay-account-value`), "as is the connected account");
	assert.ok(panelValue.selectors.includes(`.pay-balance.${baseRung} .pay-balance-value`), "and the wallet's balance");
	// The panel's rows change their own columns in the stacked phase, and app.css is where that geometry is stated, so the ladder the module declares is held against that statement too: a rung the stylesheet left out would leave a stacked panel row in inline geometry the fitter had already priced the value out of.
	for (const row of [".pay-term", ".pay-account", ".pay-balance"]) {
		const named = new Set();
		for (const rule of cssRules(appCss)) {
			for (const selector of rule.selectors) {
				if (!selector.startsWith(`${row}.`)) continue;
				const rung = selector.slice(row.length + 1).split(/[\s.]/)[0];
				if (rung.startsWith("fit-stacked-")) named.add(rung);
			}
		}
		assert.deepEqual([...named].sort(), [...stacked].sort(), `app.css stacks ${row} for exactly the rungs the ladder stacks`);
	}
});

test("a fit writes one class on the row and replaces the previous one", () => {
	const row = fakeRow("payment-term");
	const value = fakeValue();
	let box = 400;
	// The measurement follows the face the row's class list states, the way a real box reports the layout the class produced.
	const probe = fakeProbe(() => ({ content: DEMAND[phaseOf(row.rungs[0])], box }));
	const stop = fitValue({ row, value }, probe);

	assert.deepEqual(row.rungs, [phaseRungs("inline")[0]], "the first fit writes the largest rung that holds the value");
	assert.deepEqual(row.className.split(/\s+/).sort(), [phaseRungs("inline")[0], "payment-term"].sort(), "one rung class, beside the class the row was built with");
	box = 280;
	probe.fire();
	assert.deepEqual(row.rungs, [phaseRungs("inline")[1]], "a narrower box replaces the rung rather than stacking a second one");
	assert.deepEqual(
		row.className.split(/\s+/).filter((name) => !SCREEN_RUNG_NAMES.includes(name)),
		["payment-term"],
		"so the row never carries two rungs, which would leave the cascade to pick a size, and keeps the class it was built with",
	);
	assert.deepEqual(value.writes, [], "the value itself is never written to: no style, no attribute, no text");
	stop();
});

test("a hidden or detached box leaves the current rung alone", () => {
	const unmeasurable = fakeRow("payment-term");
	const stopUnmeasurable = fitValue({ row: unmeasurable, value: fakeValue() }, fakeProbe(() => null));
	assert.equal(unmeasurable.className, "payment-term", "a box that cannot be measured keeps the stylesheet's base rung");
	assert.deepEqual(unmeasurable.classWrites, [], "and the fit writes no class at all rather than guessing a rung");
	stopUnmeasurable();

	const kept = phaseRungs("inline")[2];
	const untouched = fakeRow(`payment-term ${kept}`);
	fitValue({ row: untouched, value: fakeValue() }, fakeProbe(() => ({ content: 300, box: 0 })));
	assert.equal(untouched.className, `payment-term ${kept}`, "a box with no width yet keeps the rung the row already carries");

	const detachedValue = fakeValue();
	detachedValue.isConnected = false;
	const detachedRow = fakeRow("payment-term");
	fitValue({ row: detachedRow, value: detachedValue }, fakeProbe(() => ({ content: 300, box: 200 })));
	assert.equal(detachedRow.className, "payment-term", "a value the document no longer holds is not fitted at all");

	// The browser adapter answers `null` when the layout reports no widths at all rather than reading the absence as a zero-width box, which would write the residual rung onto every row.
	assert.equal(browserLayoutProbe.measure(fakeValue()), null, "a value no layout has measured is no measurement, not a box of no width");
	const adapterRow = fakeRow("payment-term");
	const stopAdapter = fitValue({ row: adapterRow, value: fakeValue() }, browserLayoutProbe);
	assert.equal(adapterRow.className, "payment-term", "so an unmeasurable page keeps the CSS base rung");
	stopAdapter();
});

test("a resize re-fits upward and downward", () => {
	const row = fakeRow("pay-term");
	let box = 400;
	const probe = fakeProbe(() => ({ content: DEMAND[phaseOf(row.rungs[0])], box }));
	const stop = fitValue({ row, value: fakeValue() }, probe);
	assert.deepEqual(row.rungs, [phaseRungs("inline")[0]], "the first fit runs as the section is drawn");

	box = 240;
	probe.fire();
	assert.deepEqual(row.rungs, [phaseRungs("inline")[3]], "a narrower box steps the face down to the largest rung that fits");
	box = 400;
	probe.fire();
	assert.deepEqual(row.rungs, [phaseRungs("inline")[0]], "and a wider one re-fits upward rather than staying shrunk");
	box = 168;
	probe.fire();
	assert.deepEqual(row.rungs, [phaseRungs("stacked")[2]], "a box too narrow for the inline phase enters the stacked one");
	box = 90;
	probe.fire();
	assert.deepEqual(row.rungs, [SCREEN_RUNG_NAMES[SCREEN_RUNG_NAMES.length - 1]], "and the residual rung when not even the stacked floor fits");
	stop();
});

test("a fit's own class write does not wake another fit", () => {
	const row = fakeRow("payment-term");
	let box = 400;
	const probe = fakeProbe(() => ({ content: DEMAND[phaseOf(row.rungs[0])], box }));
	const stop = fitValue({ row, value: fakeValue() }, probe);
	assert.deepEqual(row.rungs, [phaseRungs("inline")[0]], "the first fit writes the largest rung that holds the value");
	const writes = row.classWrites.length;
	probe.fire();
	assert.equal(row.classWrites.length, writes, "a layout report that lands on the rung already applied writes nothing, so a fit cannot wake itself through the class it wrote");
	box = 280;
	probe.fire();
	assert.deepEqual(row.rungs, [phaseRungs("inline")[1]], "while a box that really moved is fitted again");
	stop();
});

test("the teardown stops further fitting", () => {
	const row = fakeRow("payment-term");
	let box = 400;
	const probe = fakeProbe(() => ({ content: DEMAND[phaseOf(row.rungs[0])], box }));
	const stop = fitValue({ row, value: fakeValue() }, probe);
	assert.equal(probe.targets.length, 1, "the fitter takes one resize subscription");
	box = 200;
	stop();
	assert.equal(probe.unsubscribed.length, 1, "the teardown drops the subscription it took");
	const writes = row.classWrites.length;
	probe.fire();
	assert.equal(row.classWrites.length, writes, "and a resize that arrives afterwards writes nothing");
	assert.deepEqual(row.rungs, [phaseRungs("inline")[0]], "leaving the last fit in place");
	stop();
	assert.equal(probe.unsubscribed.length, 1, "a second teardown drops nothing a second time");
});

test("a dropped or never-mounted value is released by its owner, not by a later layout report", () => {
	// `onResize` promises no notification for a target that has left the document, so nothing may wait for one: the value that is dropped and the value that is never connected are both released through the teardown the caller holds.
	const row = fakeRow("payment-term");
	const value = fakeValue();
	const probe = fakeProbe(() => ({ content: DEMAND[phaseOf(row.rungs[0])], box: 400 }));
	const stop = fitValue({ row, value }, probe);
	assert.deepEqual(row.rungs, [phaseRungs("inline")[0]], "the value is fitted while the document holds it");
	value.isConnected = false;
	const writes = row.classWrites.length;
	probe.fire();
	assert.equal(row.classWrites.length, writes, "a layout report that finds the value gone writes no rung");
	assert.equal(probe.unsubscribed.length, 0, "and releases nothing, because the probe promises no last report for a target it can no longer lay out");
	stop();
	assert.equal(probe.unsubscribed.length, 1, "so the owner's own teardown is what hands the observer back");

	// The same holds for a value that was built and never connected: the subscription that fits it once it is mounted is the owner's to release.
	const mounted = fakeValue();
	mounted.isConnected = false;
	const unmountedRow = fakeRow("payment-term");
	const unmountedProbe = fakeProbe(() => ({ content: 300, box: 200 }));
	const stopUnmounted = fitValue({ row: unmountedRow, value: mounted }, unmountedProbe);
	assert.equal(unmountedProbe.targets.length, 1, "a value nothing has mounted still takes the subscription that would fit it");
	assert.equal(unmountedRow.classWrites.length, 0, "and is not fitted while it is out of the document");
	stopUnmounted();
	assert.equal(unmountedProbe.unsubscribed.length, 1, "with the teardown releasing it rather than a report that never arrives");
});

test("the payment section asks the fitting module about every value a wallet takes verbatim", () => {
	const fake = installInteractiveDocument();
	try {
		const model = buildInvoiceViewModel(evmInvoice(), VIEW_OPTIONS.today);
		const probe = fakeProbe(() => ({ content: 120, box: 240 }));
		const section = renderPaymentSection(model, null, { fit: probe });
		document.body.append(section.element);
		// A document lays a section out only once it is in the page, so the resize a real observer would deliver is the one the test delivers here.
		probe.fire();

		const rows = findAll(section.element, (node) => hasClass(node, "payment-term"));
		assert.equal(rows.length, model.payment.length, "every payment term is one row");
		assert.deepEqual(
			rows.map(rungsOf),
			model.payment.map((term) => (term.verbatim === true ? [phaseRungs("inline")[0]] : [])),
			"each value a wallet takes verbatim is fitted on its own row, and no row of a value it does not take carries a rung",
		);
		assert.equal(rows.filter((row) => hasClass(row, "payment-term") && rungsOf(row).length > 0).length, 3, "the amount, the address, and the link");
		assert.deepEqual(paymentValues(section.element), model.payment.filter((term) => term.verbatim === true).map((term) => term.value), "and the values the copy controls read are unchanged by the fit");

		// The fitting outlives the render that started it, so the section hands back the way to drop it: a create screen rebuilding the section would otherwise leave one observer per fitted row watching a dropped subtree.
		assert.equal(probe.unsubscribed.length, 0, "the section holds its subscriptions while it is mounted");
		section.stop();
		assert.equal(probe.unsubscribed.length, probe.targets.length, "and its own teardown hands every one of them back");
	} finally {
		fake.restore();
	}
});

test("a payment section that throws part-way releases the values it had already fitted", () => {
	const fake = installInteractiveDocument();
	try {
		const model = buildInvoiceViewModel(evmInvoice(), VIEW_OPTIONS.today);
		const probe = fakeProbe(() => ({ content: 120, box: 240 }));
		// The symbol is built after the terms, so a view model whose symbol cannot be drawn is a build that throws with the terms' subscriptions already taken.
		assert.throws(() => renderPaymentSection({ ...model, paymentQr: {} }, null, { fit: probe }), "the symbol is refused");
		assert.equal(probe.targets.length, 3, "the three verbatim terms had taken their subscriptions before the throw");
		assert.deepEqual(probe.unsubscribed, probe.targets, "and the section hands every one of them back rather than leaving them on rows it never returned");
	} finally {
		fake.restore();
	}
});

test("a payment section rendered with no layout probe keeps the base rung", () => {
	const fake = installInteractiveDocument();
	try {
		const model = buildInvoiceViewModel(evmInvoice(), VIEW_OPTIONS.today);
		const section = renderPaymentSection(model, null);
		document.body.append(section.element);
		const rows = findAll(section.element, (node) => hasClass(node, "payment-term"));
		assert.deepEqual(rows.map(rungsOf), rows.map(() => []), "with nothing able to measure the page, every row keeps the size the stylesheet states");
		assert.equal(rows[0].attributes.class, "payment-term", "no rung class is written when no measurement can be taken");

		// `fit: null` is how a caller asks for no fitting at all, so it takes no probe and no subscription rather than falling back to the browser's.
		const unfitted = renderPaymentSection(model, null, { fit: null });
		document.body.append(unfitted.element);
		assert.deepEqual(
			findAll(unfitted.element, (node) => hasClass(node, "payment-term")).map(rungsOf),
			rows.map(() => []),
			"and asking for no fitting leaves the stylesheet's rung alone just as a layout-less page does",
		);
		section.stop();
		unfitted.stop();
	} finally {
		fake.restore();
	}
});

test("each print twin carries the rung its length earns", () => {
	const fake = installInteractiveDocument();
	try {
		const wide = unifiedOfBytes(189);
		assert.equal(wide.length, MAX_ZCASH_ADDRESS_LENGTH, "the fixture is the widest address the Zcash validator accepts");
		const zec = renderPaymentSection(buildInvoiceViewModel(zecInvoice(wide), VIEW_OPTIONS.today), null).element;
		const zecTwins = findAll(zec, (node) => hasClass(node, "payment-value-print"));
		assert.equal(textOf(zecTwins[0]), wide, "the address's print twin is the address itself");
		assert.deepEqual(printRungsOf(zecTwins[0]), [expectedPrintRung(PRINT_CSS, FIT_LADDER, wide.length)], "a value past the print floor takes the one rung that wraps");
		assert.equal(printRungsOf(zecTwins[1]).length, 1, "the amount's twin is sized from its own length");

		const evm = renderPaymentSection(buildInvoiceViewModel(evmInvoice(), VIEW_OPTIONS.today), null).element;
		const evmTwins = findAll(evm, (node) => hasClass(node, "payment-value-print"));
		assert.equal(textOf(evmTwins[0]), PAYEE, "a 42-character address carries its own twin");
		assert.deepEqual(
			printRungsOf(evmTwins[0]),
			[expectedPrintRung(PRINT_CSS, FIT_LADDER, PAYEE.length)],
			"and prints at the size the page's geometry earns for its length",
		);
		assert.deepEqual(printRungsOf(evmTwins[0]), ["print-fit-1"], "which for a 42-character address is the ladder's largest rung");
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

		assert.deepEqual(rungsOf(recipient), [phaseRungs("inline")[0]], "the recipient is fitted against the panel's own column");
		assert.deepEqual(rungsOf(amount), [], "a term the panel reads off its own plan is not fitted, so the row keeps its declared size");
		assert.deepEqual(rungsOf(account), [phaseRungs("inline")[0]], "and the connected account's row is fitted the same way");

		// A panel value is a scroll container inside a modal, so it carries the contract the invoice's own payment values carry: a named focus stop, because Tab cannot reach an unnamed box and a value wider than its column is only readable by arrowing along it.
		const recipientValue = findAll(recipient, (node) => hasClass(node, "pay-term-value"))[0];
		const accountValue = findAll(account, (node) => hasClass(node, "pay-account-value"))[0];
		for (const stop of [recipientValue, accountValue]) {
			assert.equal(stop.attributes.role, "group", "each value is a group an author may name");
			assert.equal(stop.attributes.tabindex, "0", "and a keyboard stop");
		}
		assert.equal(recipientValue.attributes["aria-label"], "Recipient", "the recipient's stop is named for its term");
		assert.equal(accountValue.attributes["aria-label"], "Connected account", "as is the connected account's");

		// The body is rebuilt on every state change, so a rebuild drops the subscription its predecessor took: what the panel holds is one subscription per fitted row it shows, however many frames it drew to get here.
		click(findButton(handle.element, "Switch network in my wallet"));
		await drain();
		probe.fire();
		assert.ok(fittedRows(dialog).length > 1, "the panel shows more than one fitted row to hold them for");
		assert.ok(probe.unsubscribed.length > 0, "a rebuild dropped the subscription of the row it replaced");
		assert.equal(
			probe.targets.length - probe.unsubscribed.length,
			fittedRows(dialog).length,
			"what the panel holds is exactly one subscription per fitted row it shows",
		);

		// The rows are dropped when the panel closes, so every subscription the fitter took is handed back rather than left watching a detached row.
		handle.close();
		assert.equal(probe.unsubscribed.length, probe.targets.length, "closing the panel drops every fit subscription it took");
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("the wallet's balance is a named focus stop the ladder fits", async () => {
	const fake = installInteractiveDocument();
	// A balance short of the amount stops the flow with the balance read and shown, which is the state the panel draws the balance line in.
	const provider = mockProvider({ callResult: word(1n) });
	const installed = installWindow({ ethereum: provider });
	try {
		const probe = fakeProbe(() => ({ content: 120, box: 240 }));
		const handle = openPayPanel(evmInvoice(), { notice: noticeRecorder(), clipboard: null, fit: probe });
		assert.ok(handle, "the panel opens");
		click(findButton(handle.element, "Connect wallet & pay"));
		await drain();
		probe.fire();

		const row = findAll(handle.element, (node) => hasClass(node, "pay-balance"))[0];
		assert.ok(row !== undefined, "the panel draws the balance the wallet reported");
		assert.deepEqual(rungsOf(row), [phaseRungs("inline")[0]], "and fits it the way it fits its other verbatim values");
		// Each rebuild drops the rows it replaced, so what is outstanding is exactly the fitted rows on screen: the summary's recipient, the connected account, and the balance.
		assert.deepEqual(
			fittedRows(handle.element).map((row) => String(row.attributes.class).split(" ")[0]).sort(),
			["pay-account", "pay-balance", "pay-term"],
			"the rows the panel holds a subscription for are the recipient's, the account's, and the balance's",
		);
		assert.equal(
			probe.targets.length - probe.unsubscribed.length,
			fittedRows(handle.element).length,
			"and it holds exactly one subscription for each of them",
		);

		const value = findAll(row, (node) => hasClass(node, "pay-balance-value"))[0];
		assert.ok(value !== undefined, "the balance is a value of its own rather than the row's whole text");
		assert.equal(textOf(value), "0.000001 USDC", "holding the amount and symbol the wallet reported");
		assert.equal(value.attributes.role, "group", "it is a group an author may name");
		assert.equal(value.attributes.tabindex, "0", "and a keyboard stop, so a balance wider than the panel can be arrowed along");
		assert.equal(value.attributes["aria-label"], "Wallet balance", "named for what it holds");

		handle.close();
		assert.equal(probe.unsubscribed.length, probe.targets.length, "and closing the panel hands every subscription back");
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("a snapshot that arrives after the panel is dismissed takes no fit subscription", async () => {
	const fake = installInteractiveDocument();
	const provider = mockProvider();
	const installed = installWindow({ ethereum: provider });
	try {
		const probe = fakeProbe(() => ({ content: 120, box: 240 }));
		const handle = openPayPanel(evmInvoice(), { notice: noticeRecorder(), clipboard: null, fit: probe });
		assert.ok(handle, "the panel opens");
		// The payer dismisses the panel while discovery is still in flight, and the flow's snapshots then arrive into a dialog the page no longer holds.
		click(findButton(handle.element, "Connect wallet & pay"));
		handle.close();
		const taken = probe.targets.length;
		assert.equal(probe.unsubscribed.length, taken, "closing the panel hands back the subscriptions it took");
		await drain();
		assert.equal(probe.targets.length, taken, "and a render that arrives afterwards builds no row and takes no subscription");
		assert.equal(probe.unsubscribed.length, taken, "so nothing is left for a later teardown to drop");
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("no pay-panel address value can wrap", () => {
	const appCss = readFileSync(join(root, "app/stylesheets/app.css"), "utf8");
	for (const selector of [".pay-term-value", ".pay-account-value", ".pay-balance-value"]) {
		const wrap = appliedDeclaration(appCss, selector, "overflow-wrap");
		assert.ok(wrap === undefined || wrap === "normal", `${selector} must not break a value a wallet takes verbatim`);
	}
	for (const selector of [".pay-term-value", ".pay-account-value", ".pay-balance-value"]) {
		assert.equal(appliedDeclaration(appCss, selector, "white-space"), "nowrap", `${selector} is held on one line and shrunk by the ladder instead of breaking`);
		assert.equal(appliedDeclaration(appCss, selector, "overflow-x"), "auto", `${selector} scrolls its own overflow rather than escaping the dialog`);
	}
	for (const selector of [".pay-term-value:focus-visible", ".pay-account-value:focus-visible", ".pay-balance-value:focus-visible"]) {
		assert.match(String(appliedDeclaration(appCss, selector, "outline")), /var\(--accent\)/, `${selector} is ringed in the accent app.css states at the root, where it otherwise rings only form controls`);
	}
});

test("a payment panel that throws while it builds releases the rows it had already fitted", () => {
	const fake = installInteractiveDocument();
	const provider = mockProvider();
	const installed = installWindow({ ethereum: provider });
	const createElement = document.createElement;
	// The summary is built once its recipient term has taken its subscription, so a document that refuses it is a panel build that throws with that subscription already taken.
	document.createElement = (tag) => {
		if (tag === "dl") throw new Error("the summary was refused");
		return createElement.call(document, tag);
	};
	try {
		const probe = fakeProbe(() => ({ content: 120, box: 240 }));
		assert.throws(() => openPayPanel(evmInvoice({ id: "INV-REFUSED" }), { notice: noticeRecorder(), clipboard: null, fit: probe }), /the summary was refused/);
		assert.equal(probe.targets.length, 1, "the recipient's row had taken its subscription before the throw");
		assert.deepEqual(probe.unsubscribed, probe.targets, "and the panel hands it back rather than leaving it on a dialog it never returned");
	} finally {
		document.createElement = createElement;
		installed.restore();
		fake.restore();
	}
});
