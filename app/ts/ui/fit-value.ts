/**
 * The fitting of a one-line value to the box that holds it: the first rung of a fixed font-size ladder that keeps the value on one line, unclipped and unwrapped.
 *
 * A payment value is a string a wallet takes verbatim — a payee address, an amount, a payment link — so it may never be wrapped, truncated, or respaced to fit, and the only lever its box has is the font size it is set at.
 * The app has two ladders — a screen ladder the browser measures a value against, and a print ladder the printed page draws a value on — and this module owns both and the search along each; {@link fitValue} keeps a value's screen rung current as its box resizes.
 * The screen ladder's rungs belong to two phases, and the search walks the phases in the ladder's own order, trying each phase's rungs largest first: every inline rung down to its 10px floor is tried before the first, larger stacked rung, so a value keeps the inline row whenever any inline rung at or above the floor holds it.
 * The inline phase is the row a value shares with its label, and, on the invoice's payment terms, with the copy control beside it; a panel term carries no copy control, and below the `640px` breakpoint `app.css` gives every panel term a line of its own whatever rung a fit writes, so an inline rung there sets the font size of a value the row already gives the panel's whole width. The row each phase is measured in is the stylesheet's to draw; this module only orders the two.
 * {@link FIT_RUNGS} is the one published statement of both ladders: every screen rung's name, size, and phase, and every print rung's name and whether it wraps, with the point size each sized rung's rule states.
 * The search prices a rung from that size rather than walking a ladder one measurement per rung.
 * The screen ladder's rungs are stated once per surface in the stylesheet that draws that surface — `invoice.css` for the payment section's values, `app.css` for the payment panel's — and the print ladder's rungs in `print.css`.
 * The ladder-agreement test in `tests/fit-value.test.mjs` reads this one statement and holds all three stylesheets to it, so no rung is a size the script knows and the page does not, and either ladder's representation can change without rewriting a suite.
 *
 * It deliberately does not touch the value's text, its focus, its ARIA, or any attribute but the one class on the row: the value stays ordinary selectable text and the copy control beside it keeps handing over the whole string whatever rung is applied.
 * What it hides: the two phases of the screen search and its floor, the measurement search and its bound, the guard for a box that has not been laid out yet, the resize subscription and its stop, and the mapping from a measurement to one class on one element.
 *
 * A box that cannot be measured is left at the rung it already has rather than being assumed to fit: a wrong "fits" would hide the tail of an address, and a measurement that says nothing is no evidence that the value needs a smaller font size, so the failure stays out of the output instead of shrinking a line the page never showed to be too wide.
 *
 * The print twin is sized here too: a printed page's geometry is fixed and its metrics are not measurable from script, so {@link printFitRung} maps a character count to the rung `print.css` declares, shrinking to the print floor before it lets the value break.
 *
 * It reaches for no platform global and loads no code from another module: how a box is measured and watched arrives as the {@link LayoutProbe} its callers supply, the app's composition root is the one place that supplies the browser's own, and a fit that subscribed to nothing hands back a release that does nothing — the same case `ui/release.ts` states for a surface that started nothing.
 * The one name it takes from elsewhere is `ui/release.ts`'s `Release`, taken as an inline `type` import, so the compiler erases it from the emitted module: nothing is loaded for that name at run time, and importing this module loads no other module of the app.
 *
 * The security property it keeps is the page's own: it writes a class and nothing else, never an inline style, which `style-src-attr 'none'` and the acceptance sweep both refuse, so fitting cannot become a channel for a stylesheet the page did not ship.
 */

import type { Release } from "./release.js";

/**
 * The width of the line a printed payment value is laid out on, in CSS pixels: the seven inches `print.css`'s `@page` block leaves between its margins, at the 96 CSS pixels an inch the page assumes.
 */
const PRINT_VALUE_WIDTH_PX = 7 * 96;

/**
 * The advance of one character in the widest monospace face a page is likely to substitute, in em: Courier and DejaVu Mono are about 0.602em, so 0.62em bounds them and no printed value is sized against a narrower face than the printer draws.
 */
const MONO_ADVANCE_EM = 0.62;

/** CSS pixels per point at the 96dpi reference the page assumes: a point is 1/72in and a CSS pixel 1/96in. */
const PIXELS_PER_POINT = 4 / 3;

/**
 * Both ladders every fit reads.
 *
 * The order is load-bearing: the search follows it, so moving an entry changes what a fit chooses as surely as changing that rung's font size does.
 * The screen rungs state their font size in rem, the unit every screen rung's rule states it in, and the sized print rungs state theirs in points, because a printed length must not follow the reader's root font size; the base rung's font size is also the one a value is drawn at before any script runs.
 * The wrapping rung states no font size: it is the entry that says a value past the print floor breaks rather than shrinks, so `wraps` is the only field telling it from the sized rungs, and the font size it is drawn at stays `print.css`'s to declare — that rule states the floor's 6pt, because a print twin carries a single rung class and so cannot inherit the floor's font size from the rung above it.
 * The floor of the screen ladder is 10px: below it a monospace face stops separating 0 from O and l from 1 at the default zoom, which is a verification hazard for an address rather than a matter of taste.
 * The floor of the print ladder is 6pt, ordinary fine print, for the same reason on paper.
 */
export const FIT_RUNGS = {
	screen: [
		{ rung: "fit-inline-13", phase: "inline", sizeRem: 0.8125 },
		{ rung: "fit-inline-12", phase: "inline", sizeRem: 0.75 },
		{ rung: "fit-inline-11", phase: "inline", sizeRem: 0.6875 },
		{ rung: "fit-inline-10", phase: "inline", sizeRem: 0.625 },
		{ rung: "fit-stacked-12", phase: "stacked", sizeRem: 0.75 },
		{ rung: "fit-stacked-11", phase: "stacked", sizeRem: 0.6875 },
		{ rung: "fit-stacked-10", phase: "stacked", sizeRem: 0.625 },
		{ rung: "fit-residual", phase: "residual", sizeRem: 0.625 },
	],
	print: [
		{ rung: "print-fit-1", points: 9, wraps: false },
		{ rung: "print-fit-2", points: 8, wraps: false },
		{ rung: "print-fit-3", points: 7, wraps: false },
		{ rung: "print-fit-4", points: 6, wraps: false },
		{ rung: "print-fit-wrap", wraps: true },
	],
} as const;

/** One rung of the screen ladder: the class the fitter writes, the phase whose geometry decides the row, or `residual` for the last rung, which belongs to no phase, and the font size in rem its rule states. */
type ScreenRung = (typeof FIT_RUNGS.screen)[number];

/** One rung of the print ladder: the class a twin carries, whether it is the rung that wraps, and — for a sized rung — the point size its rule states. */
type PrintRung = (typeof FIT_RUNGS.print)[number];

/** A print rung a value is priced against: a rung that states its point size, so {@link printedCharacters} can work out how many characters the page's line holds at it — the wrapping rung states no size, so the estimate cannot price it and a value past every sized rung takes it as the fallback. */
type SizedPrintRung = Extract<PrintRung, { readonly wraps: false }>;

/** A rung class of the screen ladder: a name the ladder's own entries state, and the one class a fit leaves on the row — `invoice.css` and `app.css` declare a rule for every one of them. */
type ScreenFitClass = ScreenRung["rung"];

/** A phase of the screen search: the row a value shares with its label, or the row it has to itself, drawn by the stylesheet of the surface that fits the value. */
export type ScreenPhase = Exclude<ScreenRung["phase"], "residual">;

/** The value a screen rung states in its `phase` field: one of the two phases, or `residual` for the last rung, which is where the search falls out rather than a phase it walks. */
type ScreenRungPhase = ScreenRung["phase"];

/** A rung class of the print ladder: a name the ladder's own entries state, and the one class a print twin carries — `print.css` declares a rule for every one of them. */
type PrintFitClass = PrintRung["rung"];

/** The ladder's last screen rung: what a value takes when no rung of either phase holds it. */
const RESIDUAL_RUNG = FIT_RUNGS.screen[FIT_RUNGS.screen.length - 1];

/** The print rungs a value is priced against, largest first: every rung before the one that wraps, which is what a value past them all takes. */
const SIZED_PRINT_RUNGS: readonly SizedPrintRung[] = FIT_RUNGS.print.filter((entry): entry is SizedPrintRung => !entry.wraps);

/** The print ladder's last rung, the one that wraps a value even the floor cannot hold. */
const PRINT_WRAP_RUNG: PrintRung = FIT_RUNGS.print[FIT_RUNGS.print.length - 1];

/** Whether `phase` is one the search walks rather than the residual rung's, which is where the search falls out instead of a phase it tries. */
function isWalkedPhase(phase: ScreenRungPhase): phase is ScreenPhase {
	return phase !== RESIDUAL_RUNG.phase;
}

/** The rungs of one phase, in the ladder's order. */
function rungsOf(phase: ScreenPhase): readonly ScreenRung[] {
	return FIT_RUNGS.screen.filter((entry) => entry.phase === phase);
}

/** The rungs of every phase the search walks, keyed by phase. */
const PHASES: Readonly<Record<ScreenPhase, readonly ScreenRung[]>> = {
	inline: rungsOf("inline"),
	stacked: rungsOf("stacked"),
};

/** The phases the search walks, read out of the ladder, so they are tried in the order the ladder states them. */
const PHASE_ORDER: readonly ScreenPhase[] = [...new Set(FIT_RUNGS.screen.map((entry) => entry.phase).filter(isWalkedPhase))];

/**
 * How wide a value is and how much room its box gives it, at one rung of one phase, in pixels.
 *
 * Both figures come from one layout: a phase is monotone and a monospace run's advance is proportional to its font size, so one measurement at a phase's largest rung places the value among that phase's rungs.
 */
export interface FitMeasurement {
	readonly content: number;
	readonly box: number;
}

/**
 * How the fitting reaches the layout: one measurement of a value against its own box, and a subscription to that box's resizes.
 *
 * It is shaped like the platform primitives behind it — `scrollWidth`/`clientWidth` and `ResizeObserver` — so the adapter the app's composition root supplies (`app/layout-probe.ts`) is a short statement of those, and a test can hand the fitter measurements it decides instead of installing a global.
 * `measure` answers `null` when it cannot measure the value at all, which the fitter treats as no verdict rather than as either one.
 * `onResize` promises the function that stops the subscription, and nothing else: it does not promise a last notification for a target that leaves the document, so nothing here reads a missing resize as a release.
 */
export interface LayoutProbe {
	/** The width of `value`'s content and the width of the box it is drawn in, in pixels, or `null` when the layout reports no widths for it. */
	measure(value: HTMLElement): FitMeasurement | null;
	/** Run `run` whenever `target` is laid out at a new size, and return the function that stops the subscription. */
	onResize(target: HTMLElement, run: () => void): () => void;
}

/**
 * How a fitted value is handed to the fitting: the probe its box is measured through, and the collector each fit's release is added to.
 *
 * Both surfaces that fit values state this one shape — `ui/payment-section.ts` for the invoice's payment terms, `ui/pay.ts` for the panel's summary rows — so it sits here beside the fitter rather than in either of them: a surface that fits a value depends on this module for how it is fitted, and on no other surface for it.
 */
export interface TermFitting {
	readonly fit: LayoutProbe | null;
	readonly releases: Release[];
}

/**
 * The smallest fitting rung of the screen ladder: the first rung, in the ladder's order, whose box holds the value on one line, as `fits` reports each phase, or the residual rung when no rung of either phase does.
 *
 * The name measures the step down from the base rung and not the font size a rung states: because the ladder's order is load-bearing, an inline rung at or above the floor is taken even where a larger stacked rung would also have held the value.
 * `fits` is asked for one phase at a time and answers the width the value's content demands in that phase's largest rung and the width the box gives it there.
 * A phase whose measurement is `null` is skipped rather than read as a fit.
 * Exported so a caller can drive the search with measurements it decides; {@link fitValue} is its only caller in the app.
 */
export function smallestFittingRung(fits: (phase: ScreenPhase) => FitMeasurement | null): ScreenFitClass {
	for (const phase of PHASE_ORDER) {
		const rungs = PHASES[phase];
		if (rungs.length === 0) continue;
		const measured = fits(phase);
		if (measured === null) continue;
		const rung = largestFittingInPhase(rungs, measured);
		if (rung !== null) return rung;
	}
	return RESIDUAL_RUNG.rung;
}

/**
 * The largest rung of one phase that holds a value measured in that phase's largest rung, or `null` when even the phase's floor does not.
 *
 * A phase is monotone — a smaller font size never needs more width than a larger one — and a monospace run's width is proportional to its font size, so the demand at any rung of the phase follows from the one measurement and no rung has to be applied to be priced.
 */
function largestFittingInPhase(rungs: readonly ScreenRung[], measured: FitMeasurement): ScreenFitClass | null {
	const reference = rungs[0].sizeRem;
	for (const entry of rungs) {
		if (measured.content * (entry.sizeRem / reference) <= measured.box) return entry.rung;
	}
	return null;
}

/** The largest rung of `phase`, which is the rung a fit is measured at, or `null` for a phase the ladder states no rung for. */
function largestRungOf(phase: ScreenPhase): ScreenFitClass | null {
	const rungs = PHASES[phase];
	return rungs.length === 0 ? null : rungs[0].rung;
}

/**
 * Keep `target.value` on one line at the first rung of the screen ladder that fits its box, and re-fit it whenever that box resizes; returns the release that stops fitting.
 *
 * The rung is written as one class on `target.row` — the row holding the label and the value, because the stacked rungs change the row's own columns — and the row's other classes are kept, so a fit replaces the previous rung rather than adding a second one.
 * The subscription watches the value, which the fitter never writes to: an observer watching the row the fit reclasses is re-notified by the fit's own write, and the loop a browser detects between frames is reported as an undelivered notification.
 * A value the document already holds is fitted before this returns, so its rung is in place before the page draws it; a value the document does not hold yet is not fitted then — the subscription is taken all the same, and the first layout report after the value is mounted is what fits it.
 * The returned function is the whole of the release, and the caller owns it on every path: `onResize` promises no notification for a target that has left the document, so the surface that built the value carries that release on the element it returns (`ui/release.ts`) and runs it when it drops the row — whether the value was mounted and then replaced or never connected at all.
 * A `null` probe fits nothing, which is how a caller asks for the stylesheet's own rung alone, and a run that arrives after the release does nothing.
 */
export function fitValue(target: { readonly row: HTMLElement; readonly value: HTMLElement }, probe: LayoutProbe | null): Release {
	if (probe === null) return () => {};
	let rung: ScreenFitClass | null = currentRung(target.row);
	let running = false;
	let released = false;
	let stopSubscription = (): void => {};

	const release = (): void => {
		if (released) return;
		released = true;
		stopSubscription();
	};

	const fit = (): void => {
		const starting = rung;
		const before = probe.measure(target.value);
		if (before === null || before.box <= 0) return;
		let unmeasurable = false;
		const chosen = smallestFittingRung((phase) => {
			if (unmeasurable) return null;
			const largest = largestRungOf(phase);
			if (largest === null) return null;
			applyRung(target.row, largest);
			const measurement = probe.measure(target.value);
			if (measurement === null || measurement.box <= 0) {
				unmeasurable = true;
				return null;
			}
			return measurement;
		});
		if (unmeasurable) {
			applyRung(target.row, starting);
			return;
		}
		rung = chosen;
		applyRung(target.row, chosen);
	};

	const run = (): void => {
		if (released || running) return;
		if (target.value.isConnected === false) return;
		running = true;
		try {
			fit();
		} finally {
			running = false;
		}
	};

	run();
	if (!released) stopSubscription = probe.onResize(target.value, run);
	return release;
}

/**
 * Write `rung` as the row's one rung class, keeping every class the row itself was built with, and write nothing when the class list already reads that way.
 *
 * One `setAttribute("class", …)` replaces the whole list, which is how the swap stays a single write; skipping the write when it would change nothing keeps a re-fit that lands on the rung already applied from waking the observer.
 */
function applyRung(row: HTMLElement, rung: ScreenFitClass | null): void {
	const kept = classNames(row).filter((name) => !isRung(name));
	if (rung !== null) kept.push(rung);
	const written = kept.join(" ");
	if (written !== (row.getAttribute("class") ?? "")) row.setAttribute("class", written);
}

/** The classes `row` carries, read from its one class attribute because the fake elements the tests build have no `classList`. */
function classNames(row: HTMLElement): string[] {
	const list = row.getAttribute("class");
	return list === null ? [] : list.split(/\s+/).filter((name) => name !== "");
}

function isRung(name: string): boolean {
	return FIT_RUNGS.screen.some((entry) => entry.rung === name);
}

/** The rung `row` already carries, or `null` when it carries none and the stylesheets' base rules still decide its size. */
function currentRung(row: HTMLElement): ScreenFitClass | null {
	const names = classNames(row);
	return FIT_RUNGS.screen.find((entry) => names.includes(entry.rung))?.rung ?? null;
}

/**
 * The print rung a value's length earns: the largest rung of the print ladder whose line holds the value, or the wrapping rung when even the print floor cannot.
 *
 * A printed page cannot be measured from script and does not resize, so the choice is made from the character count: {@link printedCharacters} prices each rung from the page's line width and the mono advance bound, and the rungs are tried largest first.
 * That count is the whole of the estimate — a printer substitutes its own face, and the bound is what keeps the substituted face on one line — so only a value past the floor is allowed to break, which is the one printed presentation that puts a line break inside a string a wallet takes verbatim.
 * The break points are not restated here: the suite derives them from `print.css`'s own page block and holds every rung to that geometry, so a changed constant fails a test rather than leaving a comment behind.
 */
export function printFitRung(text: string): PrintFitClass {
	const characters = [...text].length;
	for (const { rung, points } of SIZED_PRINT_RUNGS) {
		if (characters <= printedCharacters(points)) return rung;
	}
	return PRINT_WRAP_RUNG.rung;
}

/** How many monospace characters a value set at `points` fits on a printed payment value's line: the page's line width in CSS pixels against one character's advance, its em advance at the point size converted to those same pixels. */
function printedCharacters(points: number): number {
	return Math.floor(PRINT_VALUE_WIDTH_PX / (points * PIXELS_PER_POINT * MONO_ADVANCE_EM));
}
