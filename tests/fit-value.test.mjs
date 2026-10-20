/** The suite for the one-line value fitter: the ladder it searches, the print rungs, the class it writes on a row, and the surfaces that ask it to fit the values a wallet takes verbatim and the strings the wallet reports. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { appliedDeclaration, cssRules, declaration, expectedPrintRung, printedCharactersAt, printedLinePx, printedValueColumnPx, pxLength, ruleBody } from "./helpers/css.mjs";
import { installDocument, installInteractiveDocument } from "./helpers/dom.mjs";
import { fakeProbe } from "./helpers/layout-probe.mjs";
import { PAYEE } from "./helpers/payee-vectors.mjs";
import { findAll, findButton, hasClass, paymentValues, textOf } from "./helpers/tree.mjs";
import { unifiedOfBytes } from "./helpers/unified-address.mjs";
import { installWindow, mockProvider, noticeRecorder, word } from "./helpers/wallet-mock.mjs";
import { browserLayoutProbe } from "../app/js/app/layout-probe.js";
import { createInvoice } from "../app/js/invoice/model.js";
import { FIT_RUNGS, FIT_SCALE_CLASS, fitValue, printFitRung, printedSegments } from "../app/js/ui/fit-value.js";
import { VIEW_BUILD_RELEASE_FAILED_MESSAGE } from "../app/js/ui/messages.js";
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
const SCREEN_RUNG_NAMES = FIT_RUNGS.screen.map((entry) => entry.rung);

/** The rung names of one phase of the ladder, largest first. */
function phaseRungs(phase) {
	return FIT_RUNGS.screen.filter((entry) => entry.phase === phase).map((entry) => entry.rung);
}

/** The size, in rem, the ladder states for `rung`. */
function sizeOf(rung) {
	const entry = FIT_RUNGS.screen.find((candidate) => candidate.rung === rung);
	assert.ok(entry !== undefined, `${rung} is a rung of the ladder`);
	return entry.sizeRem;
}

/**
 * The width a value of a fixed character count demands at each phase's largest rung, in pixels, and the room the two phases leave it: the inline phase shares the row with the label and the copy control, and the stacked phase gives the value the whole row.
 * The figures are a model rather than a measurement, and it is the model a monospace run draws itself by: the demand at a smaller rung is the demand at the phase's largest rung scaled by the two rungs' font sizes, which is what an advance that follows its face gives. A suite that stated one flat demand per phase instead would model a face whose glyphs never narrow, which is the one engine no rung can fit.
 */
const DEMAND = { inline: 300, stacked: 200 };

/**
 * The width the value demands while the row carries `rung`, in pixels: the model above read at the face the rung states, against the face of the largest rung of the phase that rung is drawn in.
 * A row carrying no rung is drawn at the inline base, and the residual rung draws at the stacked phase's floor, which is the face both phases end on.
 */
function demandAt(rung) {
	const entry = rung === null ? FIT_RUNGS.screen.find((candidate) => candidate.phase === "inline") : FIT_RUNGS.screen.find((candidate) => candidate.rung === rung);
	const phase = entry.phase === "residual" ? "stacked" : entry.phase;
	return DEMAND[phase] * (sizeOf(entry.rung) / sizeOf(phaseRungs(phase)[0]));
}

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
	const entry = FIT_RUNGS.screen.find((candidate) => candidate.rung === rung);
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
		const applied = row.rungs[0] ?? null;
		measured.push(applied);
		return { content: demandAt(applied), box: boxes()[phaseOf(applied)] };
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
 * A probe whose first stop unsubscribes and then throws, forwarding everything else to `inner`, so a release that must run every stop it collected can be shown to run the ones after a failure.
 */
function probeWhoseFirstStopThrows(inner) {
	let thrown = false;
	return {
		...inner,
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
}

/**
 * A row with the two attribute methods the fitter uses, and a record of every class list it writes, because the row is the only element the fitter may touch.
 * `onWrite` runs after every write, which is how a test hands the row the layout report a rewritten box causes.
 */
function fakeRow(classes = "payment-term", onWrite = null) {
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
			if (onWrite !== null) onWrite();
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
const PRINT_RUNG_NAMES = FIT_RUNGS.print.map((entry) => entry.rung);

/** The print rungs a rendered twin carries, read off its class attribute. */
function printRungsOf(element) {
	return String(element.attributes.class ?? "")
		.split(/\s+/)
		.filter((name) => PRINT_RUNG_NAMES.includes(name));
}

/** The print stylesheet whose own `@page` geometry every printed break point is derived from. */
const PRINT_CSS = readFileSync(join(root, "app/stylesheets/print.css"), "utf8");

/** The invoice stylesheet, whose payment term is the column a printed value is laid out in: the ladder is sized against that column rather than the page's whole line. */
const INVOICE_CSS = readFileSync(join(root, "app/stylesheets/invoice.css"), "utf8");

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

test("a fit measures a phase at its largest rung, then once per rung it steps down to with that rung applied, and only the phases it needs", () => {
	// The contract is one measurement at the phase's largest rung — the verdict for that rung and the reading every rung below it is priced from — plus one for each rung the search then walks with that rung applied, which is what confirms the rung it writes. A phase the search never reaches is never measured, and a rung the reading names is measured again before it may be written, so a phase that settles on its largest rung costs one measurement and a phase that steps down costs one per rung it walks; the assertions below bound each phase's count per case rather than state one count for the ladder.
	const inlineFit = measurementSequence(() => ({ inline: 320, stacked: 100 }));
	assert.deepEqual(inlineFit.rungs, [phaseRungs("inline")[0]], "a value that fits beside its label settles in the inline phase");
	assert.deepEqual(
		measurementsPerPhase(inlineFit.measured),
		{ inline: 1, stacked: 0 },
		"paying one measurement in that phase and none in the stacked one, whose row is never laid out, because the rung the reading named is the rung that measurement already reported on",
	);
	assert.ok(phaseRungs("inline").length > 2, "the inline phase states more rungs than the bound, so a search that measured each rung would fail below");
	for (const [inlineBox, stackedBox] of [[230, 200], [200, 200], [230, 168], [230, 100]]) {
		const fit = measurementSequence(() => ({ inline: inlineBox, stacked: stackedBox }));
		const measured = measurementsPerPhase(fit.measured);
		assert.ok(measured.inline >= 1 && measured.inline <= 2, `the inline phase is priced in at most two measurements for a ${inlineBox}px inline box, none of these boxes stepping down more than one rung`);
		assert.ok(measured.stacked >= 1 && measured.stacked <= 2, `and the stacked phase for a ${stackedBox}px stacked box`);
		assert.ok(SCREEN_RUNG_NAMES.includes(fit.rungs[0]), `${fit.rungs[0]} is a rung of the ladder`);
	}
	// A face whose advances do not follow its size makes the reading name a rung that its own measurement then refuses, so the search steps down and measures again: the count is the phase's largest rung plus one per rung the search walked, which is why the bound above is stated per case rather than for the ladder.
	const stepped = stickyFace(() => ({ inline: 298, stacked: 100 }), 0.05);
	const counts = measurementsPerPhase(stepped.measured.map((entry) => entry.rung));
	assert.equal(counts.inline, 3, "the inline phase is measured at its largest rung, then once at each of the two rungs the search stepped down to, and no rung is written on the reading alone");
});

/**
 * Fit one value against a face whose glyphs narrow less than its font size, as an engine whose advance is not proportional to its face draws them.
 * `stickiness` is how much of the proportional narrowing the face declines: at 0 the face is the suite's own linear model, at 1 the value is as wide at the floor as at the base, and in between the proportional reading taken at a phase's largest rung always under-states the demand of the rungs below it.
 * Every measurement is recorded with the rung the row carried when it was taken, so a test can hold both the rung the search wrote and the measurement that refused the rung the reading named.
 */
function stickyFace(boxes, stickiness) {
	const row = fakeRow("payment-term");
	const measured = [];
	const probe = fakeProbe(() => {
		const applied = row.rungs[0] ?? null;
		const phase = phaseOf(applied);
		const face = applied ?? phaseRungs(phase)[0];
		const scaling = sizeOf(face) / sizeOf(phaseRungs(phase)[0]);
		const content = DEMAND[phase] * (1 - stickiness * (1 - scaling));
		const box = boxes()[phase];
		measured.push({ rung: applied, content, box });
		return { content, box };
	});
	const stop = fitValue({ row, value: fakeValue() }, probe);
	const written = [...row.rungs];
	stop();
	return { measured, written };
}

test("a rung whose own measurement overflows is never written, however the proportional reading priced it", () => {
	// The reading taken at a phase's largest rung assumes a run's advance follows its font size, and an engine whose glyphs narrow less than that breaks the assumption in one direction only: the rung it names is wider than it promised. A search that wrote that rung would leave a value overflowing the box that holds it with the cue switched off, which is the state the whole ladder exists to prevent, so what is asserted below is the written rung's own measurement rather than the reading that named it.
	const stepped = stickyFace(() => ({ inline: 298, stacked: 100 }), 0.05);
	assert.deepEqual(
		stepped.written,
		[phaseRungs("inline")[2]],
		"the reading named the inline phase's second rung, that rung's own measurement refused it, and the next rung down — which its own measurement held — is the one written",
	);
	const refused = stepped.measured.find((entry) => entry.rung === phaseRungs("inline")[1]);
	assert.ok(refused !== undefined, "the rung the reading named was measured with that rung applied, so the reading is a candidate rather than a verdict");
	assert.ok(
		refused.content * (sizeOf(phaseRungs("inline")[1]) / sizeOf(phaseRungs("inline")[0])) <= refused.box && refused.content > refused.box,
		"and where the proportional reading priced it as a fit, the rung's own measurement showed the overflow this test exists for",
	);
	const writtenMeasurement = stepped.measured.find((entry) => entry.rung === stepped.written[0]);
	assert.ok(writtenMeasurement !== undefined, "the rung the row finally carries is one the search measured with that rung applied");
	assert.ok(writtenMeasurement.content <= writtenMeasurement.box, "and the value it measured there is inside its box, so no written rung is one whose own measurement overflowed");

	// The reading can also name a rung that nothing in its phase holds, and the search then leaves the phase rather than writing any of them.
	const fellThrough = stickyFace(() => ({ inline: 277, stacked: 260 }), 0.1);
	assert.deepEqual(fellThrough.written, [phaseRungs("stacked")[0]], "a phase whose rungs all overflow their own measurements is left for the next phase, whose largest rung was measured and held");
	const stackedMeasurement = fellThrough.measured.find((entry) => entry.rung === phaseRungs("stacked")[0]);
	assert.ok(stackedMeasurement !== undefined && stackedMeasurement.content <= stackedMeasurement.box, "and that rung's measurement is the one the verdict rests on");
	assert.ok(
		fellThrough.measured.every((entry) => entry.rung !== SCREEN_RUNG_NAMES[SCREEN_RUNG_NAMES.length - 1]),
		"the residual rung is still never measured, being where a search that holds no measured rung falls out",
	);
});

test("the print ladder's break points follow print.css's own page geometry and the column it leaves a value", () => {
	// Every expectation below is derived from the stylesheets that lay a printed value out — the @page block's Letter page less its declared margin, and then the payment term's own label rail and column gap, at 96 CSS pixels to the inch — so a width, a rail, or a units error in the module fails here instead of being transcribed into the expectation.
	const sized = FIT_RUNGS.print.filter((entry) => !entry.wraps);
	assert.equal(sized[sized.length - 1].points, 6, "the ladder stops at the 6pt floor, ordinary fine print");
	// The twin is laid out in the term's value column, not across the page's whole line: a rung sized against the line overflows the column, and the twin's `white-space: nowrap` runs the tail of an address past the paper's margin, with the copy control that would hand the value over whole hidden in print.
	const column = printedValueColumnPx(PRINT_CSS, INVOICE_CSS);
	assert.ok(column < printedLinePx(PRINT_CSS), `a printed payment value's ${column}px column is narrower than the page's ${printedLinePx(PRINT_CSS)}px line, so the ladder cannot be sized against the line`);
	for (const rung of sized) {
		const holds = printedCharactersAt(PRINT_CSS, INVOICE_CSS, rung.points);
		assert.ok(holds > 0, `the ${rung.points}pt rung holds characters in the printed value's column`);
		assert.equal(printFitRung("x".repeat(holds)), rung.rung, `a value of the ${holds} characters the ${rung.points}pt rung holds prints at it`);
		assert.notEqual(printFitRung("x".repeat(holds + 1)), rung.rung, `and one character past that steps down from ${rung.rung}`);
	}
	assert.equal(expectedPrintRung(PRINT_CSS, INVOICE_CSS, FIT_RUNGS, 42), "print-fit-1", "a 42-character address prints at the largest size");
	for (const characters of [0, 42, 74, 75, 84, 95, 106, 111, 112, 116, 311]) {
		assert.equal(printFitRung("x".repeat(characters)), expectedPrintRung(PRINT_CSS, INVOICE_CSS, FIT_RUNGS, characters), `${characters} characters take the rung the printed value's own column earns`);
	}
	// The lengths this app's pages actually carry: a Sapling address is 78 characters, which the 8pt rung's column holds, and a Monero integrated address is 106, which the 6pt floor holds.
	const wrapRung = FIT_RUNGS.print[FIT_RUNGS.print.length - 1].rung;
	assert.equal(printFitRung("x".repeat(78)), expectedPrintRung(PRINT_CSS, INVOICE_CSS, FIT_RUNGS, 78), "a 78-character Sapling address stays at the size the column earns");
	assert.notEqual(printFitRung("x".repeat(106)), wrapRung, "and a 106-character Monero integrated address fits the print floor rather than wrapping");
	assert.equal(printFitRung("x".repeat(136)), wrapRung, "only a value past the floor wraps rather than shrinking further, so a value no rung can hold reaches paper whole rather than as a prefix");
	assert.equal(printFitRung("x".repeat(311)), wrapRung, "as does the widest address the Zcash validator accepts");
	assert.equal(printFitRung(""), "print-fit-1", "an empty value needs no shrinking");
});

/**
 * Every surface a fitted value is drawn on: the row a rung's class is written on, the element inside that row which carries the value, and the stylesheet that draws that surface, because a surface's row geometry and its rungs are stated in one file.
 * The `fit-sized` class every one of those rows carries is what the stylesheet paints the cue that the value may be cut off on: it states that the row's value is one the ladder sizes, which is a fact about the row no rung class can state, because the states that clip are exactly the ones no rung was ever written in — and because a value a measurement showed whole can still be drawn in a wider face than any measurement priced, so no class a fit writes silences the cue either.
 */
const SIZED_ROW_CLASS = "fit-sized";

/**
 * The class a summary value the panel reads for itself carries instead of a rung: its value wraps, so a name longer than the panel's column is drawn whole on the next line rather than clipped in a scroll box no cue marks.
 */
const WRAPPING_VALUE_CLASS = "pay-term-value-wrapping";

const VALUE_SURFACES = [
	{ row: ".payment-term", value: ".payment-value", stylesheet: "invoice.css" },
	{ row: ".pay-term", value: ".pay-term-value", stylesheet: "app.css" },
	{ row: ".pay-account", value: ".pay-account-value", stylesheet: "app.css" },
	{ row: ".pay-balance", value: ".pay-balance-value", stylesheet: "app.css" },
	{ row: ".pay-result", value: ".pay-hash", stylesheet: "app.css" },
];

test("both stylesheets agree with the ladder the module states", () => {
	const stylesheetNames = ["invoice.css", "app.css"];
	const stylesheets = Object.fromEntries(stylesheetNames.map((name) => [name, readFileSync(join(root, `app/stylesheets/${name}`), "utf8")]));
	const rules = Object.fromEntries(stylesheetNames.map((name) => [name, cssRules(stylesheets[name])]));
	// A rung's size rule is the one rule in a stylesheet whose selector list names that row, rung, and value and states a font size, so a second statement of the size and a missing one are both visible here.
	const sizeRules = (name, selector) => rules[name].filter((rule) => rule.selectors.includes(selector) && declaration(rule.body, "font-size") !== undefined);
	for (const { rung, sizeRem } of FIT_RUNGS.screen) {
		for (const { row, value, stylesheet } of VALUE_SURFACES) {
			const selector = `${row}.${rung} ${value}`;
			// The stylesheet that draws the surface states its rung once, and the other states nothing for it: a rung added on one side alone would be written onto a row no rule sizes, and a second statement of the same size could drift.
			for (const name of stylesheetNames) {
				const mine = name === stylesheet;
				assert.equal(
					sizeRules(name, selector).length,
					mine ? 1 : 0,
					mine ? `${name} states the ${rung} rung for ${row} exactly once` : `${name} states no ${rung} rung for ${row}, whose face is ${stylesheet}'s to state`,
				);
			}
			const size = declaration(sizeRules(stylesheet, selector)[0].body, "font-size");
			assert.ok(String(size).endsWith("rem"), `${rung} states its size in rem, so it follows the root font size the page assumes`);
			assert.equal(pxLength(size, rung), sizeRem * 16, `${rung} is the size the fitter prices it at`);
		}
	}
	// The pixels each rung states, read off the payment section's own rules once per rung, so the descent below is read from the stylesheet rather than restated from the module's list.
	const sizes = FIT_RUNGS.screen.map(({ rung, phase }) => {
		const size = declaration(sizeRules("invoice.css", `.payment-term.${rung} .payment-value`)[0].body, "font-size");
		return { rung, phase, px: pxLength(size, rung) };
	});
	// The order each stylesheet states its rungs in, read off the stylesheet itself, so the claim that each ladder reads top to bottom is checked rather than assumed.
	for (const name of stylesheetNames) {
		const declared = [];
		for (const rule of rules[name]) {
			if (declaration(rule.body, "font-size") === undefined) continue;
			for (const { rung } of FIT_RUNGS.screen) {
				if (declared.includes(rung) || !rule.selectors.some((selector) => selector.includes(`.${rung} `))) continue;
				declared.push(rung);
			}
		}
		assert.deepEqual(declared, FIT_RUNGS.screen.map((entry) => entry.rung), `${name} states the rungs it draws in the ladder's own order, so its ladder reads from the base rung to the residual one`);
	}
	assert.deepEqual(sizes.filter((entry) => entry.phase === "inline").map((entry) => entry.px), [13, 12, 11, 10], "the inline phase descends from the 13px base to the 10px floor");
	assert.deepEqual(sizes.filter((entry) => entry.phase === "stacked").map((entry) => entry.px), [12, 11, 10], "the stacked phase descends from 12px to the same floor");
	const residual = sizes[sizes.length - 1];
	assert.equal(residual.phase, "residual", "the ladder ends on the residual rung, the one the search falls out of");
	assert.equal(residual.px, 10, "which keeps the floor's own size, scrolling rather than shrinking past it");
	// The floor is 10px monospace: below it a payer can no longer tell 0 from O or l from 1 in the address they are checking.
	for (const entry of sizes) assert.ok(entry.px >= 10, `${entry.rung} is at or above the 10px floor`);
	// The residual rung's cue is the scrollbar it states rather than a smaller face: the standard property carries it wherever a thin bar is drawn, and the engine rule carries it where a full-height bar would otherwise appear.
	for (const { row, value, stylesheet } of VALUE_SURFACES) {
		const selector = `${row}.${residual.rung} ${value}`;
		assert.equal(appliedDeclaration(stylesheets[stylesheet], selector, "scrollbar-width"), "thin", `${stylesheet} gives ${row} the residual rung's visible thin scrollbar rather than hiding the overflow`);
		const bars = rules[stylesheet].filter((rule) => rule.selectors.includes(`${selector}::-webkit-scrollbar`) && declaration(rule.body, "height") === "6px");
		assert.equal(bars.length, 1, `${stylesheet} states ${row}'s residual scrollbar once, in the engine rule the thin cue needs`);
	}
	// The bar is not a cue every engine paints: an engine with overlay scrollbars draws one only once the payer scrolls, and the states in which no fit ever lands — no `ResizeObserver`, no probe, a value not yet laid out — carry no rung at all, so the cue is painted on the row's own sized state, and nothing a fit writes switches it off.
	for (const { row, value, stylesheet } of VALUE_SURFACES) {
		const cueSelector = `${row}.${SIZED_ROW_CLASS}::after`;
		const cue = appliedDeclaration(stylesheets[stylesheet], cueSelector, "content");
		assert.ok(cue !== undefined && cue !== "none" && cue !== '""', `${stylesheet} states ${row}'s cue on the row a value the ladder sizes is drawn in, where a clip cannot hide it and where it is painted whether or not the engine paints the bar and whether or not a fit was ever reached`);
		assert.equal(
			appliedDeclaration(stylesheets[stylesheet], cueSelector, "user-select"),
			"none",
			`${row}'s cue states the one exclusion a stylesheet can make from a selection, which is all this suite can read: what keeps the sentence out of a value's own string is its placement, pinned in the cue suite in tests/view.test.mjs`,
		);
		// Nothing may silence the cue, and the ladder is read rather than restated: no rung class may turn it off, because the fitting writes each candidate rung before it measures the value at that rung and a fit that throws leaves the last candidate on the row, and no completed fit may turn it off either, because no measurement can see the advance the run is later drawn at.
		const silences = (selector) => appliedDeclaration(stylesheets[stylesheet], selector, "content") === "none";
		for (const { rung } of FIT_RUNGS.screen) {
			assert.equal(
				silences(`${row}.${SIZED_ROW_CLASS}.${rung}::after`),
				false,
				`${stylesheet} lets no rung silence ${row}'s cue, so a candidate rung a failed fit left behind cannot leave a value that may be clipped drawn as whole`,
			);
		}
		// Nothing silences it at all, a completed fit's own state included: the advance the value's glyphs are drawn at can outgrow every size the page can observe, so a cue that waited for a measurement's confirmation would be missing exactly where the value is clipped.
		const silencers = rules[stylesheet].filter((rule) => rule.selectors.some((selector) => selector.startsWith(`${row}.${SIZED_ROW_CLASS}`)) && declaration(rule.body, "content") === "none");
		assert.deepEqual(silencers.map((rule) => rule.selectors.join(", ")), [], `${stylesheet} states no state of ${row} that silences the cue, so no value the ladder sizes is ever drawn as whole on the strength of a measurement that a wider face could have invalidated`);
		// The cue is the value's neighbour, so nothing in this rung may respell, respace, or mask the run it sits beside.
		const rungValue = `${row}.${residual.rung} ${value}`;
		for (const property of ["text-overflow", "letter-spacing", "transform", "mask-image", "-webkit-mask-image"]) {
			assert.equal(appliedDeclaration(stylesheets[stylesheet], rungValue, property), undefined, `${rungValue} states no ${property}, so the cue is painted beside the value rather than drawn out of its glyphs`);
		}
		// The browser's probe measures the value's border box as the room its run has, which it is only while the value states no padding or border of its own.
		for (const property of ["padding", "padding-left", "padding-right", "border", "border-left", "border-right"]) {
			assert.equal(appliedDeclaration(stylesheets[stylesheet], value, property), undefined, `${stylesheet}'s ${value} states no ${property}, so its border box is the room its run is drawn in`);
		}
	}

	// The stacked phase buys the value the row's whole width, and invoice.css is where the invoice's own row states that geometry: the one rule must name exactly the stacked rungs, because a rung left out sizes the value for a full row while the row still draws the label's rail.
	const stacked = FIT_RUNGS.screen.filter((entry) => entry.phase === "stacked").map((entry) => entry.rung);
	const stackedRules = rules["invoice.css"].filter((rule) => declaration(rule.body, "grid-template-columns") === "1fr");
	assert.equal(stackedRules.length, 1, "invoice.css states the invoice row's stacked columns once");
	assert.deepEqual(
		stackedRules[0].selectors.slice().sort(),
		[...stacked, residual.rung].map((rung) => `.payment-term.${rung}`).sort(),
		"and names every stacked rung beside the residual one, so a dropped selector cannot leave a stacked term in the label's rail and the row that certainly scrolls is drawn in the whole width the stacked phase measured in rather than in the rail",
	);

	// The size a value is drawn at before any script runs is the ladder's base rung, and each surface states it in its own base rule rather than in a rung class, so those two declarations are held to the same ladder: a base size changed on one side alone would draw a value at a size no rung prices.
	const base = FIT_RUNGS.screen[0].sizeRem;
	const invoiceBase = ruleBody(stylesheets["invoice.css"], ".payment-term dd.mono");
	assert.ok(invoiceBase !== undefined, "invoice.css states the face a payment value is drawn at before a fit");
	assert.equal(pxLength(declaration(invoiceBase, "font-size"), ".payment-term dd.mono"), base * 16, "which is the ladder's base rung");
	const dialogBase = ruleBody(stylesheets["app.css"], ".pay-dialog .mono");
	assert.ok(dialogBase !== undefined, "app.css states the face the payment panel's verbatim values are drawn at before a fit");
	assert.equal(pxLength(declaration(dialogBase, "font-size"), ".pay-dialog .mono"), base * 16, "which is the same base rung");

	// The panel's rows change their own columns in the stacked phase, and app.css is where that geometry is stated, so the ladder the module declares is held against that statement too: a rung the stylesheet left out would leave a stacked panel row in inline geometry the fitter had already priced the value out of.
	for (const row of [".pay-term", ".pay-account", ".pay-balance"]) {
		const named = new Set();
		for (const rule of rules["app.css"]) {
			for (const selector of rule.selectors) {
				if (!selector.startsWith(`${row}.`)) continue;
				const rung = selector.slice(row.length + 1).split(/[\s.]/)[0];
				if (rung.startsWith("fit-stacked-")) named.add(rung);
			}
		}
		assert.deepEqual([...named].sort(), [...stacked].sort(), `app.css stacks ${row} for exactly the rungs the ladder stacks`);
		// The residual rung repeats the stacked geometry on the panel's rows for the reason the invoice's does: it is the state the row certainly scrolls, so the value keeps the whole width the stacked phase measured in rather than the share a label leaves it, and the painted cue is a cue rather than the only thing standing between a clipped value and a payer reading it as whole.
		if (row === ".pay-term") {
			assert.equal(appliedDeclaration(stylesheets["app.css"], `${row}.${residual.rung}`, "grid-template-columns"), "1fr", `${row} gives the residual rung the stacked columns, so no state of the row that scrolls is measured in the label's rail`);
		} else {
			assert.equal(appliedDeclaration(stylesheets["app.css"], `${row}.${residual.rung}`, "flex-wrap"), "wrap", `${row} wraps at the residual rung, so its value takes a line of its own`);
			assert.equal(appliedDeclaration(stylesheets["app.css"], `${row}.${residual.rung} .${row.slice(1)}-value`, "flex-basis"), "100%", `and ${row}'s value keeps the row's whole width in the state that certainly scrolls`);
		}
	}
});

test("a fit writes one class on the row and replaces the previous one", () => {
	const row = fakeRow("payment-term");
	const value = fakeValue();
	let box = 400;
	// The measurement follows the face the row's class list states, the way a real box reports the layout the class produced.
	const probe = fakeProbe(() => ({ content: demandAt(row.rungs[0] ?? null), box }));
	const stop = fitValue({ row, value }, probe);

	assert.deepEqual(row.rungs, [phaseRungs("inline")[0]], "the first fit writes the largest rung that holds the value");
	assert.deepEqual(
		row.className.split(/\s+/).sort(),
		[phaseRungs("inline")[0], "payment-term"].sort(),
		"one rung class beside the class the row was built with, and no second class of the fit's own that a stylesheet could silence the cue with",
	);
	box = 280;
	probe.fire();
	assert.deepEqual(row.rungs, [phaseRungs("inline")[1]], "a narrower box replaces the rung rather than stacking a second one");
	assert.deepEqual(
		row.className.split(/\s+/).filter((name) => !SCREEN_RUNG_NAMES.includes(name)).sort(),
		["payment-term"],
		"so the row never carries two rungs, which would leave the cascade to pick a size, and the class it was built with is the only other one it carries",
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

test("a box that stops reporting a width loses the rung it had rather than keeping a stale fits", () => {
	// The row carries the rung a previous fit wrote, and that rung silences the stylesheet's cue. A measurement taken at that rung that reports no width at all is no evidence the value still fits, and keeping the rung would leave the cue off on the strength of a verdict nothing has taken since, so the rung is dropped and the row falls back to the state its stylesheet paints the cue on.
	const stale = phaseRungs("inline")[1];
	for (const second of [null, { content: 0, box: 0 }]) {
		const row = fakeRow(`payment-term ${stale}`);
		let taken = 0;
		const stop = fitValue(
			{ row, value: fakeValue() },
			fakeProbe(() => {
				taken += 1;
				return taken === 1 ? { content: 300, box: 400 } : second;
			}),
		);
		stop();
		assert.deepEqual(row.rungs, [], `a measurement of ${JSON.stringify(second)} at the rung the row carried drops it, so no unconfirmed rung is left on the row for the fit to have written`);
		assert.equal(row.className, "payment-term", "leaving the row in the base state its stylesheet states and on which the cue that the value may be cut off is painted");
	}
});

test("a probe that throws leaves the row in the state that paints the cue, never on an unconfirmed rung", () => {
	// The search writes each candidate rung on the row before it measures the value at that rung, so the rung a row carries when a probe throws is one nothing confirmed — and a rung a failed fit leaves behind would draw the value at a size no measurement priced, while the cue is painted beside it whatever rung it carries. The failure still reaches the caller that caused the fit.
	const row = fakeRow("payment-term");
	let taken = 0;
	const probe = fakeProbe(() => {
		taken += 1;
		if (taken === 3) throw new Error("the probe failed");
		return { content: 600, box: 400 };
	});
	assert.throws(() => fitValue({ row, value: fakeValue() }, probe), /the probe failed/, "the failure reaches the caller that caused the fit rather than being swallowed");
	assert.equal(taken, 3, "the probe threw on a later rung of the search, with a candidate already written on the row");
	assert.deepEqual(row.rungs, [], "and the row lost that candidate, so no unconfirmed rung keeps the cue switched off");
	assert.equal(row.className, "payment-term", "leaving the row in the base state its stylesheet states and on which the cue that the value may be cut off is painted");

	// The same for a fit a later report starts: the rung an earlier fit confirmed stands only until a report would renew it, and a report whose probe throws renews nothing.
	const confirmed = phaseRungs("inline")[0];
	const refitRow = fakeRow("payment-term");
	let reports = 0;
	const refit = fakeProbe(() => {
		reports += 1;
		if (reports > 2) throw new Error("the refit failed");
		return { content: 100, box: 400 };
	});
	const release = fitValue({ row: refitRow, value: fakeValue() }, refit);
	assert.deepEqual(refitRow.rungs, [confirmed], "the first fit measured the value at its rung and wrote it");
	const reported = [];
	const consoleError = console.error;
	console.error = (...args) => reported.push(args);
	try {
		refit.fire();
	} finally {
		console.error = consoleError;
	}
	assert.equal(reported.length, 1, "a report whose probe throws is reported to the console rather than escaping a layout callback no surface can catch it in");
	assert.equal(reported[0][0], "fitted value refit:", "under the fitter's own context, so a developer reads which route failed");
	assert.equal(reported[0][1]?.message, "the refit failed", "and with the failure itself, not a replacement for it");
	assert.deepEqual(refitRow.rungs, [], "and the row falls back to the cue's state rather than keeping a rung the failing report never confirmed");
	assert.equal(refitRow.className, "payment-term", "which is the state the stylesheet marks as possibly clipped");
	release();
});

test("a second subscription that throws releases the first, so a row the surface drops leaves no observer behind", () => {
	// A fitted value watches the value and, when its surface built one, the scale box; the release that ends both is the value the call returns, so a second subscription that throws returns none and the first would be stranded on a row the surface goes on to drop.
	const row = fakeRow("payment-term");
	const value = fakeValue();
	const scale = fakeValue();
	const probe = fakeProbe(() => ({ content: 120, box: 240 }));
	const subscribed = [];
	const onResize = probe.onResize.bind(probe);
	probe.onResize = (target, run) => {
		subscribed.push(target);
		if (subscribed.length === 2) throw new Error("the scale box refused the subscription");
		return onResize(target, run);
	};
	assert.throws(() => fitValue({ row, value, scale }, probe), /the scale box refused the subscription/, "the failure reaches the caller rather than being swallowed");
	assert.deepEqual(subscribed, [value, scale], "the value was subscribed to first and the scale box second");
	assert.deepEqual(probe.targets, [value], "so the value's is the only subscription the probe holds");
	assert.deepEqual(probe.unsubscribed, [value], "and it is released before the failure returns, because nothing above the call holds it");

	// A release that throws while that failure is unwinding does not replace the failure the caller asked for.
	let calls = 0;
	const failing = fakeProbe(() => ({ content: 120, box: 240 }));
	const innerOnResize = failing.onResize.bind(failing);
	failing.onResize = (target, run) => {
		calls += 1;
		if (calls === 2) throw new Error("the scale box refused the subscription");
		const stop = innerOnResize(target, run);
		return () => {
			stop();
			throw new Error("the stop failed");
		};
	};
	assert.throws(
		() => fitValue({ row: fakeRow("payment-term"), value: fakeValue(), scale: fakeValue() }, failing),
		(thrown) => {
			assert.match(thrown.message, /the scale box refused the subscription/, "the caller is told about the subscription that could not be taken, not about the cleanup's failure");
			assert.match(String(thrown.cause?.message), /the stop failed/, "and the release that failed beside it is carried on that failure rather than lost");
			return true;
		},
	);
});

test("the first fit runs before the call returns for a mounted value, and on the first report after mount for a detached one", () => {
	const mountedRow = fakeRow("payment-term");
	const mountedProbe = fakeProbe(() => ({ content: DEMAND.inline, box: 400 }));
	const stopMounted = fitValue({ row: mountedRow, value: fakeValue() }, mountedProbe);
	assert.deepEqual(mountedRow.rungs, [phaseRungs("inline")[0]], "a value the document holds is fitted before the call returns, so its rung is in place before the page draws it");
	assert.equal(mountedProbe.targets.length, 1, "and the subscription is taken for the reports that follow");
	stopMounted();

	// A value built into a subtree nothing has mounted yet has no layout to measure, so the call fits nothing; the subscription is taken all the same, and its first report is what fits the value once it is mounted.
	const detachedRow = fakeRow("payment-term");
	const detachedValue = fakeValue();
	detachedValue.isConnected = false;
	const detachedProbe = fakeProbe(() => ({ content: DEMAND.inline, box: 400 }));
	const stopDetached = fitValue({ row: detachedRow, value: detachedValue }, detachedProbe);
	assert.deepEqual(detachedRow.classWrites, [], "a value the document does not hold is not fitted when the fit is taken");
	assert.equal(detachedProbe.targets.length, 1, "though the subscription that would fit it is taken at once");
	detachedValue.isConnected = true;
	detachedProbe.fire();
	assert.deepEqual(detachedRow.rungs, [phaseRungs("inline")[0]], "and the first layout report after the value is mounted is what fits it");
	stopDetached();
});

test("a resize re-fits upward and downward", () => {
	const row = fakeRow("pay-term");
	let box = 400;
	const probe = fakeProbe(() => ({ content: demandAt(row.rungs[0] ?? null), box }));
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

/**
 * How many reports the model delivers before it stops: a fit that re-entered itself on the report its own write caused would never return, so the cap turns that into an assertion this suite reports rather than a recursion that ends the run.
 */
const REPORT_CAP = 32;

/**
 * A probe whose reports arrive when the layout does: `fire` is the report the page itself causes, and a write to the row causes one too, delivered at once while the fit that wrote it is still running — the case the fitter must not re-enter itself on.
 * `delivered` counts every report handed to the fit and `measured` every measurement it took, so a fit that started a second fit inside the first shows up as both climbing past the bounds the module documents.
 */
function synchronousProbe(measure) {
	const runs = [];
	const probe = {
		delivered: 0,
		measured: 0,
		measure(value) {
			probe.measured += 1;
			return measure(value);
		},
		onResize(target, run) {
			runs.push(run);
			return () => {};
		},
		/** Deliver one report to every subscription, at once, as a box the page has laid out again reports itself. */
		fire() {
			for (const run of runs) run();
		},
		/** Deliver the report a write to the row causes, inside the write, for as long as the cap holds. */
		report() {
			for (const run of runs) {
				if (probe.delivered >= REPORT_CAP) return;
				probe.delivered += 1;
				run();
			}
		},
	};
	return probe;
}

test("a report that lands while a fit is running does not re-enter it", () => {
	// The row reports every write through the probe built beneath it: its callback runs only when a fit writes, which is after both stand, and each report lands inside the fit that caused it.
	let box = 400;
	const row = fakeRow("payment-term", () => probe.report());
	const probe = synchronousProbe(() => ({ content: demandAt(row.rungs[0] ?? null), box }));
	const stop = fitValue({ row, value: fakeValue() }, probe);
	assert.deepEqual(row.rungs, [phaseRungs("inline")[0]], "the first fit settles the value while the row stands at the base rung");

	const measured = probe.measured;
	box = 280;
	probe.fire();
	assert.deepEqual(row.rungs, [phaseRungs("inline")[1]], "a narrower box steps the face down to the largest rung that holds the value");
	assert.equal(probe.delivered, 1, "and the one write that stepped it down — the rung that differs from the one the row already carried — causes one report, which arrives while the fit is still running");
	assert.ok(
		probe.measured - measured <= 6,
		"so the fit is not re-entered by it: one run measures a phase at most three times, and a run started inside it would measure the value again and again",
	);
	assert.equal(row.classWrites.length, 2, "the first fit writes its candidate rung before any subscription stands, and the second writes the one rung that changed, because a write that would leave the class list as it is is skipped");
	stop();
});

test("the release stops further fitting", () => {
	const row = fakeRow("payment-term");
	let box = 400;
	const probe = fakeProbe(() => ({ content: demandAt(row.rungs[0] ?? null), box }));
	const stop = fitValue({ row, value: fakeValue() }, probe);
	assert.equal(probe.targets.length, 1, "the fitter takes one resize subscription");
	box = 200;
	stop();
	assert.equal(probe.unsubscribed.length, 1, "the release drops the subscription it took");
	const writes = row.classWrites.length;
	probe.fire();
	assert.equal(row.classWrites.length, writes, "and a resize that arrives afterwards writes nothing");
	assert.deepEqual(row.rungs, [phaseRungs("inline")[0]], "leaving the last fit in place");
	stop();
	assert.equal(probe.unsubscribed.length, 1, "a second release drops nothing a second time");
});

test("a dropped or never-mounted value is released by its owner, not by a later layout report", () => {
	// `onResize` promises no notification for a target that has left the document, so nothing may wait for one: the value that is dropped and the value that is never connected are both released by the release the caller holds.
	const row = fakeRow("payment-term");
	const value = fakeValue();
	const probe = fakeProbe(() => ({ content: demandAt(row.rungs[0] ?? null), box: 400 }));
	const stop = fitValue({ row, value }, probe);
	assert.deepEqual(row.rungs, [phaseRungs("inline")[0]], "the value is fitted while the document holds it");
	value.isConnected = false;
	const writes = row.classWrites.length;
	probe.fire();
	assert.equal(row.classWrites.length, writes, "a layout report that finds the value gone writes no rung");
	assert.equal(probe.unsubscribed.length, 0, "and releases nothing, because the probe promises no last report for a target it can no longer lay out");
	stop();
	assert.equal(probe.unsubscribed.length, 1, "so the owner's own release is what releases the observer");

	// The same holds for a value that was built and never connected: the subscription that fits it once it is mounted is the owner's to release.
	const mounted = fakeValue();
	mounted.isConnected = false;
	const unmountedRow = fakeRow("payment-term");
	const unmountedProbe = fakeProbe(() => ({ content: 300, box: 200 }));
	const stopUnmounted = fitValue({ row: unmountedRow, value: mounted }, unmountedProbe);
	assert.equal(unmountedProbe.targets.length, 1, "a value nothing has mounted still takes the subscription that would fit it");
	assert.equal(unmountedRow.classWrites.length, 0, "and is not fitted while it is out of the document");
	stopUnmounted();
	assert.equal(unmountedProbe.unsubscribed.length, 1, "with the release releasing it rather than a report that never arrives");
});

test("the browser's probe measures the run's exact width against the box its rung will be drawn in", () => {
	// The platform's whole-pixel widths are the defect this holds shut: `scrollWidth` reported a run overflowing by a fraction of a pixel as fitting, and `clientWidth` shrank by the scrollbar the overflow itself drew, so a phase was priced against a box narrower than the one its rung finally gets.
	const drawn = { width: 300.4 };
	const installed = installDocument({
		createRange() {
			return {
				selectNodeContents() {},
				getBoundingClientRect() {
					return drawn;
				},
			};
		},
	});
	try {
		const value = { clientWidth: 285, scrollWidth: 301, getBoundingClientRect: () => ({ width: 300 }) };
		assert.deepEqual(
			browserLayoutProbe.measure(value),
			{ content: 300.4, box: 300 },
			"the run's width and the box's are both reported as the layout gives them, unrounded",
		);
		const measured = browserLayoutProbe.measure(value);
		assert.ok(measured.content > measured.box, "a run overflowing its box by four tenths of a pixel is an overflow, so no rung priced from it can be mistaken for a fit");
		assert.equal(measured.box, 300, "and the box is the value's own border box, not the 285px content width a scrollbar the overflow drew leaves it");
		drawn.width = 299.6;
		assert.ok(browserLayoutProbe.measure(value).content < browserLayoutProbe.measure(value).box, "while a run inside its box by the same margin is a fit");
		assert.equal(browserLayoutProbe.measure({}), null, "a value the platform lays out nothing for is no measurement rather than a guess");
	} finally {
		installed.restore();
	}
});

test("the payment section asks the fitting module about every value a wallet takes verbatim", () => {
	const fake = installInteractiveDocument();
	try {
		const model = buildInvoiceViewModel(evmInvoice(), VIEW_OPTIONS.today);
		const probe = fakeProbe(() => ({ content: 120, box: 240 }));
		const section = renderPaymentSection(model, { fit: probe });
		document.body.append(section);
		// A document lays a section out only once it is in the page, so the resize a real observer would deliver is the one the test delivers here.
		probe.fire();

		const rows = findAll(section, (node) => hasClass(node, "payment-term"));
		assert.equal(rows.length, model.payment.length, "every payment term is one row");
		assert.deepEqual(
			rows.map(rungsOf),
			model.payment.map((term) => (term.verbatim === true ? [phaseRungs("inline")[0]] : [])),
			"each value a wallet takes verbatim is fitted on its own row, and no row of a value it does not take carries a rung",
		);
		assert.equal(rows.filter((row) => hasClass(row, "payment-term") && rungsOf(row).length > 0).length, 3, "the amount, the address, and the link");
		assert.deepEqual(
			rows.map((row) => hasClass(row, SIZED_ROW_CLASS)),
			model.payment.map((term) => term.verbatim === true),
			"and each row whose value is handed to the fitting says so, which is the state its stylesheet paints the cue for a value it cannot show whole on",
		);
		assert.deepEqual(paymentValues(section), model.payment.filter((term) => term.verbatim === true).map((term) => term.value), "and the values the copy controls read are unchanged by the fit");

		// The fitting outlives the render that started it, so the section returns the way to drop it: a create screen rebuilding the section would otherwise leave one observer per fitted row watching a dropped subtree.
		assert.equal(probe.unsubscribed.length, 0, "the section holds its subscriptions while it is mounted");
		section.release();
		assert.equal(probe.unsubscribed.length, probe.targets.length, "and its own release releases every one of them");
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
		assert.throws(() => renderPaymentSection({ ...model, paymentQr: {} }, { fit: probe }), "the symbol is refused");
		assert.equal(probe.targets.length, 6, "the three verbatim terms had taken both of their subscriptions — the value's box and the scale box inside it — before the throw");
		assert.deepEqual(probe.unsubscribed, probe.targets, "and the section releases every one of them rather than leaving them on rows it never returned");
	} finally {
		fake.restore();
	}
});

test("a stop that throws does not strand the section's other subscriptions", () => {
	const fake = installInteractiveDocument();
	try {
		const model = buildInvoiceViewModel(evmInvoice(), VIEW_OPTIONS.today);
		const probe = probeWhoseFirstStopThrows(fakeProbe(() => ({ content: 120, box: 240 })));
		const section = renderPaymentSection(model, { fit: probe });
		document.body.append(section);
		assert.equal(probe.targets.length, 6, "the three verbatim terms each took both of their subscriptions — the value's box and the scale box inside it");
		// The collector is drained before any stop runs, so a stop that strands the ones after it would leave an observer on a row the page dropped with no handle left to release it.
		assert.throws(() => section.release(), /the first stop failed/, "the failure reaches the surface that released the section rather than being swallowed");
		assert.equal(probe.unsubscribed.length, 6, "and every subscription after the failing one was released too");
	} finally {
		fake.restore();
	}
});

test("a payment section rendered with no layout probe keeps the base rung", () => {
	const fake = installInteractiveDocument();
	try {
		const model = buildInvoiceViewModel(evmInvoice(), VIEW_OPTIONS.today);
		const section = renderPaymentSection(model);
		document.body.append(section);
		const rows = findAll(section, (node) => hasClass(node, "payment-term"));
		assert.deepEqual(rows.map(rungsOf), rows.map(() => []), "with nothing able to measure the page, every row keeps the size the stylesheet states");
		assert.deepEqual(
			rows.map((row) => row.attributes.class),
			model.payment.map((term) => (term.verbatim === true ? `payment-term ${SIZED_ROW_CLASS}` : "payment-term")),
			"no rung class is written when no measurement can be taken, and the row of every value a wallet takes verbatim still says the ladder sizes it, which is the state the stylesheet paints its cue on",
		);

		// `fit: null` is how a caller asks for no fitting at all, so it takes no probe and no subscription rather than falling back to the browser's.
		const unfitted = renderPaymentSection(model, { fit: null });
		document.body.append(unfitted);
		assert.deepEqual(
			findAll(unfitted, (node) => hasClass(node, "payment-term")).map(rungsOf),
			rows.map(() => []),
			"and asking for no fitting leaves the stylesheet's rung alone just as a layout-less page does",
		);
		section.release();
		unfitted.release();
	} finally {
		fake.restore();
	}
});

test("each print twin carries the rung its length earns", () => {
	const fake = installInteractiveDocument();
	try {
		const wide = unifiedOfBytes(189);
		assert.equal(wide.length, MAX_ZCASH_ADDRESS_LENGTH, "the fixture is the widest address the Zcash validator accepts");
		const zec = renderPaymentSection(buildInvoiceViewModel(zecInvoice(wide), VIEW_OPTIONS.today));
		const zecTwins = findAll(zec, (node) => hasClass(node, "payment-value-print"));
		assert.equal(textOf(zecTwins[0]), wide, "the address's print twin is the address itself");
		assert.deepEqual(printRungsOf(zecTwins[0]), [expectedPrintRung(PRINT_CSS, INVOICE_CSS, FIT_RUNGS, wide.length)], "a value past the print floor takes the one rung that wraps");
		assert.equal(printRungsOf(zecTwins[1]).length, 1, "the amount's twin is sized from its own length");

		const evm = renderPaymentSection(buildInvoiceViewModel(evmInvoice(), VIEW_OPTIONS.today));
		const evmTwins = findAll(evm, (node) => hasClass(node, "payment-value-print"));
		assert.equal(textOf(evmTwins[0]), PAYEE, "a 42-character address carries its own twin");
		assert.deepEqual(
			printRungsOf(evmTwins[0]),
			[expectedPrintRung(PRINT_CSS, INVOICE_CSS, FIT_RUNGS, PAYEE.length)],
			"and prints at the size the page's geometry earns for its length",
		);
		assert.deepEqual(printRungsOf(evmTwins[0]), ["print-fit-1"], "which for a 42-character address is the ladder's largest rung");
	} finally {
		fake.restore();
	}
});

test("a printed value past the floor's line breaks where the module put it, and every printed line of a value carries the mark at its end", () => {
	// A value too long for the print floor's line has to break, and a break falls at a place no reader can see: a payer hand-copying the printed address may take the wrap for a space or a newline, or the end of the value for the end of an address. So the string is split here, at the characters one line of the column holds, and every printed line of the value is ruled whatever made the break: the split this module made, or the page running out of a column narrower than the one the value was priced against.
	const address = unifiedOfBytes(189);
	assert.equal(address.length, MAX_ZCASH_ADDRESS_LENGTH, "the fixture is the widest address the Zcash validator accepts");
	const floor = FIT_RUNGS.print.filter((entry) => !entry.wraps).at(-1);
	const capacity = printedCharactersAt(PRINT_CSS, INVOICE_CSS, floor.points);
	assert.ok(address.length > capacity, `a ${address.length}-character address needs more than the ${capacity} characters a printed line holds at the ${floor.points}pt floor`);
	const segments = printedSegments(address);
	assert.ok(segments.length > 1, "so the printed value is drawn in more than one segment");
	assert.equal(segments.join(""), address, "and the segments are the address itself, in order, with nothing added, dropped, or respaced");
	assert.equal([...segments[0]].length, capacity, "the first segment is as long as a printed line of the column holds, so the break falls where the module put it rather than where the box ran out");
	for (const segment of segments) {
		assert.ok([...segment].length <= capacity, "and no segment is longer than the column holds at the face the wrapping rung draws it at, so no line breaks inside one");
	}
	assert.deepEqual(printedSegments(PAYEE), [PAYEE], "a value that fits one printed line is one segment, which is the whole of it");

	const fake = installInteractiveDocument();
	try {
		const section = renderPaymentSection(buildInvoiceViewModel(zecInvoice(address), VIEW_OPTIONS.today));
		const twin = findAll(section, (node) => hasClass(node, "payment-value-print"))[0];
		assert.deepEqual(printRungsOf(twin), [FIT_RUNGS.print[FIT_RUNGS.print.length - 1].rung], "the twin carries the rung a value past the floor takes");
		assert.equal(textOf(twin), address, "the twin's text is still the address itself, the segments included");
		const drawn = findAll(twin, (node) => hasClass(node, "payment-value-print-segment"));
		assert.deepEqual(drawn.map((node) => textOf(node)), segments, "and it draws the value as the segments the module split it into");
		const runs = findAll(twin, (node) => hasClass(node, "payment-value-print-run"));
		assert.deepEqual(runs.map((node) => textOf(node)), segments, "each segment holds its characters in one inline run, which is the box a line break fragments and the box the mark is drawn on");
		// Every twin holds its characters in runs, a sized rung's one run included, so no printed line of any value is drawn outside the rule that marks it.
		for (const printed of findAll(section, (node) => hasClass(node, "payment-value-print"))) {
			const held = findAll(printed, (node) => hasClass(node, "payment-value-print-run"));
			assert.equal(held.map((node) => textOf(node)).join(""), textOf(printed), "every twin is drawn in runs, so every line a value prints on is a line the mark can reach");
		}
	} finally {
		fake.restore();
	}

	const segmentRule = ruleBody(PRINT_CSS, ".payment-value-print.print-fit-wrap .payment-value-print-segment");
	assert.ok(segmentRule !== undefined, "print.css states how a wrapped value's segments are drawn");
	assert.equal(declaration(segmentRule, "display"), "block", "one segment per printed line at the column the ladder prices");
	assert.equal(declaration(segmentRule, "white-space"), "pre-wrap", "the segment keeps every character of the value, its spacing included, rather than collapsing a run of spaces");
	assert.equal(declaration(segmentRule, "overflow-wrap"), "anywhere", "and it breaks inside itself rather than running its tail past the paper's margin when the printed column is narrower than the one its length was priced against");

	// The mark at a break is the end decoration of the one run a fragment belongs to: the value's characters sit in an inline run per segment, a line break fragments that run, and `box-decoration-break: clone` paints each fragment's own rule — so the break the page makes inside a segment above is marked exactly as a break between two segments is, and no rule marks a segment boundary alone.
	const mark = ruleBody(PRINT_CSS, ".payment-value-print .payment-value-print-run");
	assert.ok(mark !== undefined, "print.css marks every printed line of a value, whatever ends it");
	assert.equal(declaration(mark, "box-decoration-break"), "clone", "each rendered fragment of the run is decorated on its own, so a break inside a segment carries the same mark as a break between two");
	assert.equal(declaration(mark, "-webkit-box-decoration-break"), "clone", "under the prefixed name the engines that predate the property honour");
	assert.equal(declaration(mark, "border-bottom"), "0.5pt dashed #000", "the mark is a dashed rule, which no character of an address resembles");
	assert.equal(declaration(mark, "content"), undefined, "and it is drawn as a border rather than generated text, so the printed string holds no character the value does not");
	assert.equal(
		cssRules(PRINT_CSS).filter((rule) => rule.selectors.includes(".payment-value-print .payment-value-print-run")).length,
		1,
		"the mark is stated once for every rung, so a sized value's break is marked by the rule a wrapped value's break is",
	);
	assert.equal(
		ruleBody(PRINT_CSS, ".payment-value-print.print-fit-wrap .payment-value-print-segment:not(:last-child)"),
		undefined,
		"no rule marks a segment's boundary and leaves the line inside a segment unmarked: every printed line of the value carries the one rule",
	);
});

test("the payment panel fits the amount, the recipient, and the connected account with one class per row", async () => {
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
		const asset = payTermRow(dialog, "Asset");
		const network = payTermRow(dialog, "Network");
		const account = findAll(dialog, (node) => hasClass(node, "pay-account"))[0];
		assert.ok(recipient !== undefined && amount !== undefined, "the summary keeps its recipient and amount rows");
		assert.ok(asset !== undefined && network !== undefined, "and the asset and network rows it reads for itself");
		assert.ok(account !== undefined, "and the connected account is shown once the wallet has handed one over");

		assert.deepEqual(rungsOf(amount), [phaseRungs("inline")[0]], "the amount due is fitted against the panel's own column, the row a legal maximal amount would otherwise scroll in");
		assert.deepEqual(rungsOf(recipient), [phaseRungs("inline")[0]], "the recipient is fitted against that same column");
		assert.deepEqual(rungsOf(account), [phaseRungs("inline")[0]], "and the connected account's row is fitted the same way");
		assert.deepEqual(rungsOf(asset), [], "while the asset's name is the panel's own reading of the plan and keeps the size the stylesheet states");
		assert.deepEqual(rungsOf(network), [], "as does the network's label");
		// The rows the ladder sizes are the rows whose stylesheet paints the cue a value the fit never reached carries, so the panel has to state them: the two rows no fitter sizes are never cued, and the four it does size always are.
		for (const row of [amount, recipient, account]) assert.ok(hasClass(row, SIZED_ROW_CLASS), `${String(row.attributes.class)} is a row the ladder sizes`);
		// The two rows no fitter sizes would otherwise be scroll boxes with nothing to say a name was cut, so their value wraps instead: a registry name or a network label longer than the panel's column is drawn whole, and no cue is owed a value nothing can clip.
		for (const row of [asset, network]) {
			const value = findAll(row, (node) => hasClass(node, "pay-term-value"))[0];
			assert.ok(value !== undefined, "each reading the panel makes for itself draws its value in the term's value element");
			assert.ok(hasClass(value, WRAPPING_VALUE_CLASS), `${String(value.attributes.class)} wraps rather than scrolls, so a name longer than the panel's column is drawn whole instead of ending in a clipped tail that reads as the whole name`);
			assert.ok(!hasClass(row, SIZED_ROW_CLASS), "and its row is not one the ladder sizes, so nothing cues a value nothing can hide");
		}

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
			fittedRows(dialog).length * 2,
			"what the panel holds is exactly the two subscriptions each fitted row it shows takes: the value's box, and the scale box inside it",
		);

		// The rows are dropped when the panel closes, so every subscription the fitter took is released rather than left watching a detached row.
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
		assert.deepEqual(rungsOf(row), [phaseRungs("inline")[0]], "and fits it the way it fits the panel's other wallet-reported value");
		// Each rebuild drops the rows it replaced, so what is outstanding is exactly the fitted rows on screen: the summary's amount and recipient, the connected account, and the balance.
		assert.deepEqual(
			fittedRows(handle.element).map((row) => String(row.attributes.class).split(" ")[0]).sort(),
			["pay-account", "pay-balance", "pay-term", "pay-term"],
			"the rows the panel holds a subscription for are the amount's, the recipient's, the account's, and the balance's",
		);
		assert.equal(
			probe.targets.length - probe.unsubscribed.length,
			fittedRows(handle.element).length * 2,
			"and it holds exactly the two subscriptions each of them takes: the value's box, and the scale box inside it",
		);

		const value = findAll(row, (node) => hasClass(node, "pay-balance-value"))[0];
		assert.ok(value !== undefined, "the balance is a value of its own rather than the row's whole text");
		assert.equal(textOf(value), "0.000001 USDC", "holding the amount and symbol the wallet reported");
		assert.equal(value.attributes.role, "group", "it is a group an author may name");
		assert.equal(value.attributes.tabindex, "0", "and a keyboard stop, so a balance wider than the panel can be arrowed along");
		assert.equal(value.attributes["aria-label"], "Wallet balance", "named for what it holds");

		handle.close();
		assert.equal(probe.unsubscribed.length, probe.targets.length, "and closing the panel releases every subscription");
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
		assert.equal(probe.unsubscribed.length, taken, "closing the panel releases the subscriptions it took");
		await drain();
		assert.equal(probe.targets.length, taken, "and a render that arrives afterwards builds no row and takes no subscription");
		assert.equal(probe.unsubscribed.length, taken, "so nothing is left for a later release to drop");
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("a stop that throws does not strand the panel's other subscriptions", () => {
	const fake = installInteractiveDocument();
	const provider = mockProvider();
	const installed = installWindow({ ethereum: provider });
	try {
		const probe = probeWhoseFirstStopThrows(fakeProbe(() => ({ content: 120, box: 240 })));
		const handle = openPayPanel(evmInvoice({ id: "INV-STOP" }), { notice: noticeRecorder(), clipboard: null, fit: probe });
		assert.ok(handle, "the panel opens");
		assert.equal(probe.targets.length, 4, "the amount's row and the recipient's had taken both subscriptions each");
		assert.throws(() => handle.close(), /the first stop failed/, "the failure reaches the surface that dismissed the panel rather than being swallowed");
		assert.equal(probe.unsubscribed.length, 4, "and every subscription after the failing one was released too, so no observer is left on a dialog the page dropped");
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("a render releases the rows of the frame it replaced only after the rebuild has dropped them, and never the dialog's own rows", async () => {
	// The rows a render drops are the ones a rung class says hold their value whole, so a row released while it is still mounted would keep that rung with nothing watching it, and the next resize would clip its value with the cue switched off by the rung the fit left behind. The stop below records whether the row it releases was still in the document when it ran, which is the order the hazard turns on, and it throws the way a release a browser refuses does — which is also how a frame that cannot be swapped ends its own rows and states the failure in their place. The panel's own summary rows are the counter-case: they stay mounted, so whatever a frame does, they keep their fitting.
	const fake = installInteractiveDocument();
	const provider = mockProvider({ chainId: "0x5" });
	const installed = installWindow({ ethereum: provider });
	try {
		const inner = fakeProbe(() => ({ content: 120, box: 240 }));
		const stops = [];
		const probe = {
			measure: inner.measure,
			onResize(target, run) {
				const stop = inner.onResize(target, run);
				return () => {
					stops.push({ target, connected: target.isConnected });
					stop();
					if (stops.length === 1) throw new Error("the first stop failed");
				};
			},
		};
		const handle = openPayPanel(evmInvoice({ id: "INV-RENDER" }), { notice: noticeRecorder(), clipboard: null, fit: probe });
		assert.ok(handle, "the panel opens");
		// The flow's own frame changes are what drop the rows a fitter sized: the connected account and the balance appear once the wallet has answered and are replaced by the frames after that.
		click(findButton(handle.element, "Connect wallet & pay"));
		await drain();
		assert.ok(stops.length > 0, "the flow's frame changes drop rows this panel fitted");
		const dropped = stops.filter((entry) => !entry.target.isConnected);
		assert.ok(dropped.length > 0, "and a rebuild did drop rows: the rows this reads are the ones the document no longer holds at the end");
		for (const entry of dropped) {
			assert.equal(entry.connected, false, "every row a rebuild dropped is released only once it had left the document, so no row left mounted keeps a rung with nothing watching it");
		}
		assert.equal(inner.unsubscribed.length, stops.length, "and the stop that throws is not the last word on the frame it belonged to: every stop of that frame ran behind it");
		// The amount and the recipient are the dialog's own rows: built once, still on the page, and fitted once. A release run on them would switch their cue off with nothing left to fit them again, so a frame that fails — whether its replacement could not be built or a dropped stop threw — ends its own rows and leaves these watched.
		const summaryRows = inner.targets.slice(0, 2);
		assert.equal(summaryRows.length, 2, "the panel's own build takes one subscription per summary row it fits");
		for (const row of summaryRows) {
			assert.ok(!inner.unsubscribed.includes(row), "a summary row that is still on screen keeps its fitting, so the cue it carries stays true");
		}
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("a dismissal whose release throws tells the payer, in the app's own sentence, and still runs every stop", () => {
	const fake = installInteractiveDocument();
	const provider = mockProvider();
	const installed = installWindow({ ethereum: provider });
	try {
		const probe = probeWhoseFirstStopThrows(fakeProbe(() => ({ content: 120, box: 240 })));
		const notices = noticeRecorder();
		const handle = openPayPanel(evmInvoice({ id: "INV-DISMISS" }), { notice: notices, clipboard: null, fit: probe });
		assert.ok(handle, "the panel opens");
		// Escape is the dismissal a payer triggers, and the failure it raises has no caller above the listener to reach.
		handle.element.dispatch("keydown", { type: "keydown", key: "Escape" });
		assert.equal(notices.calls.length, 1, "dismissing the panel reports that once");
		assert.equal(notices.calls[0].tone, "error", "as an error the payer is meant to act on");
		assert.match(notices.calls[0].message, /could not be cleared away/, "in the app's own words about what may still be running and what to do about it");
		assert.doesNotMatch(notices.calls[0].message, /the first stop failed/, "and never in the failure's own words, which can carry the detail the notice region must not reach");
		assert.equal(probe.unsubscribed.length, probe.targets.length, "while every stop the panel held still ran, so nothing it started is stranded");
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("every payment panel value class is held on one line, scrolls its own overflow, and takes the focus ring", () => {
	const appCss = readFileSync(join(root, "app/stylesheets/app.css"), "utf8");
	for (const selector of [".pay-term-value", ".pay-account-value", ".pay-balance-value"]) {
		const wrap = appliedDeclaration(appCss, selector, "overflow-wrap");
		assert.ok(wrap === undefined || wrap === "normal", `${selector} must not break a value the panel draws`);
	}
	for (const selector of [".pay-term-value", ".pay-account-value", ".pay-balance-value"]) {
		assert.equal(appliedDeclaration(appCss, selector, "white-space"), "nowrap", `${selector} is held on one line and shrunk by the ladder instead of breaking`);
		assert.equal(appliedDeclaration(appCss, selector, "overflow-x"), "auto", `${selector} scrolls its own overflow rather than escaping the dialog`);
	}
	for (const selector of [".pay-term-value:focus-visible", ".pay-account-value:focus-visible", ".pay-balance-value:focus-visible"]) {
		assert.match(String(appliedDeclaration(appCss, selector, "outline")), /var\(--accent\)/, `${selector} is ringed in the accent app.css states at the root, where it otherwise rings only form controls`);
	}
});

test("the two values the panel reads for itself wrap rather than scroll, so neither can be clipped without a cue", () => {
	const appCss = readFileSync(join(root, "app/stylesheets/app.css"), "utf8");
	const wrapping = ruleBody(appCss, `.${WRAPPING_VALUE_CLASS}`);
	assert.ok(wrapping !== undefined, "app.css states what a summary value the panel reads for itself does instead of taking the scroll box the verbatim values are drawn in");
	assert.equal(declaration(wrapping, "white-space"), "normal", "it wraps, so a longer registry name or network label is drawn on the next line rather than held on one run");
	assert.equal(declaration(wrapping, "overflow-wrap"), "anywhere", "and a label with no space of its own still breaks inside itself rather than running past the panel");
	assert.equal(declaration(wrapping, "overflow"), "visible", "it draws its own lines rather than scrolling, so every line it wraps onto is part of the value a payer sees");
	// The verbatim values keep their one line and their scroll box: the two states are now one class each rather than one rule that covered both, so a change to either cannot move the other.
	assert.equal(appliedDeclaration(appCss, ".pay-term-value", "white-space"), "nowrap", "and the class every summary value draws on still states the one-line contract, which the verbatim values keep, being strings a wallet takes verbatim");
	assert.equal(appliedDeclaration(appCss, ".pay-term-value", "overflow-x"), "auto", "with the scroll box a value wider than the panel is read through");
});

test("a payment panel that throws while it builds releases the rows it had already fitted", () => {
	const fake = installInteractiveDocument();
	const provider = mockProvider();
	const installed = installWindow({ ethereum: provider });
	const createElement = document.createElement;
	// The summary is built once its amount and recipient terms have taken their subscriptions, so a document that refuses it is a panel build that throws with those subscriptions already taken.
	document.createElement = (tag) => {
		if (tag === "dl") throw new Error("the summary was refused");
		return createElement.call(document, tag);
	};
	try {
		const probe = fakeProbe(() => ({ content: 120, box: 240 }));
		assert.throws(() => openPayPanel(evmInvoice({ id: "INV-REFUSED" }), { notice: noticeRecorder(), clipboard: null, fit: probe }), /the summary was refused/);
		assert.equal(probe.targets.length, 4, "the amount's row and the recipient's had taken both of theirs before the throw");
		assert.deepEqual(probe.unsubscribed, probe.targets, "and the panel releases them rather than leaving them on a dialog it never returned");
	} finally {
		document.createElement = createElement;
		installed.restore();
		fake.restore();
	}
});

test("a frame that cannot be drawn drops its own rows and leaves the panel open, stating the failure in the body", async () => {
	// A frame's rows are built in order, so a row after the first that cannot be built throws with the rows built before it already subscribed. That frame is neither mounted nor dismissed: its rows are dropped with it, the body states the failure in one fixed sentence rather than standing empty, and the dialog's own summary rows — built once and still on screen — keep their fitting. The panel stays open, so the payer can close it and a later snapshot may draw a later frame.
	const fake = installInteractiveDocument();
	const provider = mockProvider();
	const installed = installWindow({ ethereum: provider });
	try {
		const inner = fakeProbe(() => ({ content: 120, box: 240 }));
		/** The subscriptions each fitted row takes: the value's box, and the scale box drawn inside it. */
		const subscriptionsPerRow = 2;
		/** The rows the dialog's own build fits: the amount and the recipient. */
		const dialogRows = 2;
		let subscribed = 0;
		let refused = 0;
		const probe = {
			measure: inner.measure,
			onResize(target, run) {
				subscribed += 1;
				// The frame a wallet's answer delivers draws the connected account and then the balance, so the row after this one is the first row of a later frame that has already subscribed.
				if (subscribed > (dialogRows + 1) * subscriptionsPerRow) {
					refused += 1;
					throw new Error("the frame was refused");
				}
				return inner.onResize(target, run);
			},
		};
		const handle = openPayPanel(evmInvoice({ id: "INV-FRAME" }), { notice: noticeRecorder(), clipboard: null, fit: probe });
		assert.ok(handle, "the panel opens");
		assert.equal(subscribed, dialogRows * subscriptionsPerRow, "the dialog's own build takes one subscription for each box of each row it fits — the value's and the scale box inside it — and no other");

		click(findButton(handle.element, "Connect wallet & pay"));
		await drain();

		assert.ok(refused > 0, "a frame a wallet's answer delivered threw");
		const summaryRows = inner.targets.slice(0, dialogRows * subscriptionsPerRow);
		const frameRows = inner.targets.slice(dialogRows * subscriptionsPerRow);
		assert.ok(frameRows.length > 0, "the frames that threw had built rows that had already taken their fitting");
		assert.deepEqual(
			frameRows.filter((row) => !inner.unsubscribed.includes(row)),
			[],
			"every row a frame that could not be drawn had built is released, so none of them is left watched on a panel that never showed it",
		);
		assert.deepEqual(
			summaryRows.filter((row) => inner.unsubscribed.includes(row)),
			[],
			"while the dialog's own rows, still on screen, are not released: their cue stays true",
		);
		const body = findAll(handle.element, (node) => hasClass(node, "pay-body"))[0];
		assert.ok(body !== undefined, "the panel still draws a body");
		assert.match(textOf(body), /could not draw what it had to show/, "and states the failure in the app's own words rather than standing empty");
		assert.doesNotMatch(textOf(body), /the frame was refused/, "with none of the failure's internal detail in the panel the payer reads");
		assert.equal(findAll(body, (node) => hasClass(node, "pay-status-error")).length, 1, "as the one announcement the failed frame makes");
		assert.equal(handle.element.isConnected, true, "the panel stays open rather than being dismissed by a frame it could not draw");
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("a section whose build throws and whose release throws surfaces the app's own sentence, not the stop's", () => {
	const fake = installInteractiveDocument();
	const createElement = document.createElement;
	// The payment list is built once every term has taken its fitting, so a document that refuses it fails the build with the fittings already taken, and the stop below throws the way a release a browser refuses does.
	document.createElement = (tag) => {
		if (tag === "dl") throw new Error("the payment list was refused");
		return createElement.call(document, tag);
	};
	try {
		const probe = probeWhoseFirstStopThrows(fakeProbe(() => ({ content: 120, box: 240 })));
		let failure = null;
		try {
			renderPaymentSection(buildInvoiceViewModel(evmInvoice(), VIEW_OPTIONS.today), { clipboard: null, fit: probe });
		} catch (error) {
			failure = error;
		}
		assert.ok(failure !== null, "a build that throws with fittings already taken throws out of the renderer");
		assert.equal(String(failure.message), VIEW_BUILD_RELEASE_FAILED_MESSAGE, "the failure surfaces as the app's own fixed sentence, which is the error a catching surface reports to a developer rather than the sentence it shows the payer");
		assert.doesNotMatch(String(failure.message), /the first stop failed/, "never in the stopped subscriber's own words");
		assert.equal(failure.cause?.message, "the payment list was refused", "with the failure that caused the path kept on the error rather than in its message");
		assert.deepEqual(probe.unsubscribed, probe.targets, "and every fitting the terms had taken was released, the ones behind the stop that threw included");
	} finally {
		document.createElement = createElement;
		fake.restore();
	}
});

test("a change to the value's drawn font size re-measures it, which the value's own box cannot report", () => {
	// The value's box is as wide as its column whatever face the value is drawn in, so a later minimum-font-size setting, or a stylesheet rule overriding a rung's size, grows the run past that box while the box reports the same width as before. The scale box drawn inside the value is set in that same face and is the one box that changes, so the fit is told and steps down; without it the value would keep a rung no measurement had taken since the face grew, with the cue switched off by that rung's confirmation.
	const row = fakeRow("payment-term");
	const value = fakeValue();
	const scale = fakeValue();
	const box = 400;
	let faceGrowth = 1;
	let measurements = 0;
	const probe = fakeProbe(() => {
		measurements += 1;
		return { content: demandAt(row.rungs[0] ?? null) * faceGrowth, box };
	});
	const stop = fitValue({ row, value, scale }, probe);
	assert.equal(probe.targets.length, 2, "the fit watches the value's own box and the scale box drawn inside it");
	assert.equal(probe.targets[1], scale, "the second of them being the scale box");
	assert.deepEqual(row.rungs, [phaseRungs("inline")[0]], "the value is fitted at the base rung while its face is the one the rung states");

	// A rule or a setting later draws the value in a larger face: the demand grows by half again, and the value's own box does not change at all.
	faceGrowth = 1.5;
	const measured = measurements;
	const writes = row.classWrites.length;
	probe.runs[1]();
	assert.ok(measurements > measured, "the report from the scale box re-measures the value rather than leaving the face the box last saw");
	assert.ok(row.classWrites.length > writes, "and writes the rung its own measurement of the grown run supports");
	assert.ok(demandAt(row.rungs[0] ?? null) * faceGrowth <= box, "which is a rung the grown run fits in the box it has, so the value is not left clipped under a rung a shrinking box once confirmed");
	assert.deepEqual(row.className.split(/\s+/).filter((name) => name !== "payment-term"), [row.rungs[0]], "and the rung its own measurement of the grown run supported is the only class the fit writes, so the cue stays painted beside a value whose glyphs may still be drawn wider than that measurement");

	// A face the floor cannot hold either is not confirmed at all: the residual rung is the state that certainly scrolls, so the cue stays painted beside it.
	faceGrowth = 3;
	probe.runs[1]();
	assert.deepEqual(row.rungs, [SCREEN_RUNG_NAMES[SCREEN_RUNG_NAMES.length - 1]], "a face no rung of either phase holds takes the residual rung");
	assert.equal(row.className.split(/\s+/).filter((name) => name !== "payment-term").length, 1, "and the fit writes no other class beside it, so a value it could not show whole keeps the cue that says so");
	stop();
});

test("a fit that cannot finish leaves no confirmation behind, even when its own recovery cannot write", () => {
	// The search writes each candidate rung before it measures the value at that rung, so a probe that throws there leaves a candidate on the row and nothing confirmed: the cue is painted whatever the clean-up then does, which is why a recovery that fails is never the state the cue rests on.
	const row = fakeRow("payment-term");
	const write = row.setAttribute.bind(row);
	row.setAttribute = (name, value) => {
		if (!/\bfit-/.test(String(value))) throw new Error("the row refused the clean-up");
		write(name, value);
	};
	const probe = fakeProbe(() => {
		if (row.rungs.length > 0) throw new Error("the probe stopped measuring");
		return { content: 300, box: 400 };
	});
	let failure = null;
	try {
		fitValue({ row, value: fakeValue() }, probe);
	} catch (error) {
		failure = error;
	}
	assert.equal(failure?.message, "the probe stopped measuring", "the caller receives the fit's own failure rather than the recovery's");
	assert.deepEqual(row.rungs, [phaseRungs("inline")[0]], "the candidate the search had written is still on the row");
	assert.equal(row.className, `payment-term ${phaseRungs("inline")[0]}`, "and it carries that one candidate and nothing else, so no class a failed write left behind switches the cue off");
});

test("a fit writes one rung class and nothing that could silence the cue, the residual rung included", () => {
	const row = fakeRow("payment-term");
	fitValue({ row, value: fakeValue() }, fakeProbe(() => ({ content: 4000, box: 100 })));
	assert.deepEqual(row.rungs, [SCREEN_RUNG_NAMES[SCREEN_RUNG_NAMES.length - 1]], "a value no rung of either phase holds takes the residual rung");
	assert.equal(row.className, `payment-term ${SCREEN_RUNG_NAMES[SCREEN_RUNG_NAMES.length - 1]}`, "and the row carries that rung and the class it was built with, so the state that certainly scrolls keeps the cue painted beside it");
});

test("the surfaces that fit a value draw the scale box inside it, and the values nothing fits carry none", () => {
	const fake = installInteractiveDocument();
	try {
		const probe = fakeProbe(() => ({ content: 120, box: 240 }));
		const section = renderPaymentSection(buildInvoiceViewModel(evmInvoice(), VIEW_OPTIONS.today), { fit: probe });
		const scales = findAll(section, (node) => hasClass(node, FIT_SCALE_CLASS));
		assert.equal(scales.length, 3, "the invoice's three verbatim terms each draw the scale box the fitting watches");
		for (const value of findAll(section, (node) => hasClass(node, "payment-value-verbatim"))) {
			assert.equal(findAll(value, (node) => hasClass(node, FIT_SCALE_CLASS)).length, 1, "inside the value itself, so the box is drawn in the value's own face");
			assert.equal(findAll(value, (node) => hasClass(node, "payment-value-verbatim")).length, 0, "and it nests no second value, so the text a payer copies is the term's own");
		}
		const wrapping = findAll(section, (node) => hasClass(node, "payment-value-wrapping"));
		assert.ok(wrapping.length > 0 && wrapping.every((node) => findAll(node, (child) => hasClass(child, FIT_SCALE_CLASS)).length === 0), "and no value nothing fits carries one, because nothing sizes it and nothing can clip it");

		const handle = openPayPanel(evmInvoice({ id: "INV-SCALE" }), { notice: noticeRecorder(), clipboard: null, fit: fakeProbe(() => ({ content: 120, box: 240 })) });
		assert.ok(handle !== null, "the panel opens");
		const panelScales = findAll(handle.element, (node) => hasClass(node, FIT_SCALE_CLASS));
		assert.equal(panelScales.length, 2, "the panel's summary draws one for each of the two rows it fits before a wallet answers");
		handle.close();
	} finally {
		fake.restore();
	}
});

test("a fitted value is the containing block of the scale box, and the box is sized in the value's own em", () => {
	// The box has to follow the value's drawn face and nothing else, so it is sized in em and hidden rather than removed from the layout; and it is positioned inside the value, which is what keeps it from reaching any other element's box.
	const stylesheetNames = ["invoice.css", "app.css"];
	const stylesheets = Object.fromEntries(stylesheetNames.map((name) => [name, readFileSync(join(root, `app/stylesheets/${name}`), "utf8")]));
	const scaleRule = cssRules(stylesheets["app.css"]).filter((rule) => rule.selectors.length === 1 && rule.selectors[0] === `.${FIT_SCALE_CLASS}`);
	assert.equal(scaleRule.length, 1, "app.css states the scale box once, for the document's values and the panel's alike");
	assert.equal(declaration(scaleRule[0].body, "inline-size"), "1em", "sized in the value's own em, so its size follows the face the value is drawn in");
	assert.equal(declaration(scaleRule[0].body, "block-size"), "1em", "in both directions");
	assert.equal(declaration(scaleRule[0].body, "visibility"), "hidden", "hidden rather than taken out of the layout, because a box that is not laid out reports no size");
	for (const { value, stylesheet } of VALUE_SURFACES) {
		assert.equal(appliedDeclaration(stylesheets[stylesheet], value, "position"), "relative", `${stylesheet} makes ${value} the containing block of the box drawn inside it`);
	}
});
