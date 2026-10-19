/**
 * The fitting of a one-line value to the box that holds it: the largest rung of a fixed font-size ladder that keeps the value on one line, unclipped and unwrapped.
 *
 * A payment value is a string a wallet takes verbatim — a payee address, an amount, a payment link — so it may never be wrapped, truncated, or respaced to fit, and the only lever its box has is the size of the face it is set in. This module owns that ladder and the search along it; {@link fitValue} keeps a value's rung current as its box resizes.
 * {@link FIT_LADDER} is the one published statement of the ladder — every rung's name, its size, the phase it belongs to, and the print rungs with their point sizes — because the search prices a rung from its size rather than walking the ladder with a measurement per rung, and the screen rungs are stated once per surface in the stylesheet that draws that surface — `invoice.css` for the payment section's values, `app.css` for the payment panel's — with `print.css` stating the print rungs; a test reads the one statement and holds all three stylesheets to it, so no rung is a size the script knows and the page does not, and the ladder's representation can change without rewriting a suite.
 * It deliberately does not touch the value's text, its focus, its ARIA, or any attribute but the one class on the row: the value stays ordinary selectable text and the copy control beside it keeps handing over the whole string whatever rung is applied.
 * What it hides: the two phases of the screen search and its floor, the measurement search and its bound, the guard for a box that has not been laid out yet, the resize subscription and its teardown, and the mapping from a measurement to one class on one element.
 * A box that cannot be measured is left at the rung it already has rather than being assumed to fit: a wrong "fits" would hide the tail of an address, while a wrong "does not fit" costs only a smaller face, so the failure falls on the harmless side.
 * The print twin is sized here too: a printed page's geometry is fixed and its metrics are not measurable from script, so {@link printFitRung} maps a character count to the rung `print.css` declares, shrinking to the print floor before it lets the value break.
 * The module imports nothing from the app and reaches for no platform global: how a box is measured and watched arrives as the {@link LayoutProbe} its callers supply, and the app's composition root is the one place that supplies the browser's own.
 * The security property it keeps is the page's own: it writes a class and nothing else, never an inline style, which `style-src-attr 'none'` and the acceptance sweep both refuse, so fitting cannot become a channel for a stylesheet the page did not ship.
 */

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
 * The ladder: every rung the fitting can apply, its size, and the order the search walks them in.
 *
 * The screen rungs are grouped by the phase that decides the row's geometry — the inline phase keeps the label, the value, and the copy control on one row, the stacked phase buys the value the whole row at the cost of a line for the label — and the residual rung is the last, what a value no rung holds takes: one line at the floor, scrolling its overflow rather than shrinking past it.
 * The sizes are in rem, which is the unit both screen stylesheets state each rung's rule in, and the base rung's size is also the size a value is drawn at before any script runs, which the stylesheets' own base rules state.
 * The print rungs are the point sizes `print.css` states, largest first; the last one wraps, and is the one presentation that puts a line break inside a string a wallet takes verbatim.
 * The floor of the screen ladder is 10px: below it a monospace face stops separating 0 from O and l from 1 at the default zoom, which is a verification hazard for an address rather than a matter of taste. The floor of the print ladder is 6pt, ordinary fine print, for the same reason on paper.
 */
export const FIT_LADDER = {
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
		{ rung: "print-fit-wrap", points: 6, wraps: true },
	],
} as const;

/** One rung of the screen ladder: the class the fitter writes, the phase whose geometry decides the row, and the size in rem its rule states. */
type ScreenRung = (typeof FIT_LADDER.screen)[number];

/** One rung of the print ladder: the class a twin carries, the point size its rule states, and whether it is the rung that wraps. */
type PrintRung = (typeof FIT_LADDER.print)[number];

/** A screen rung's class name. */
type FitRung = ScreenRung["rung"];

/** A phase of the screen ladder: the row a value shares with its label, the row it has to itself, or the residual rung's, which is what no phase of the search holds. */
type ScreenPhase = ScreenRung["phase"];

/** A phase the search walks: one the ladder states sized rungs for, rather than the residual rung's. */
type SizedPhase = Exclude<ScreenPhase, "residual">;

/** A print rung's class name. */
export type PrintFitRung = PrintRung["rung"];

/** The ladder's last screen rung: what a value takes when no sized rung of either phase holds it. */
const RESIDUAL_RUNG = FIT_LADDER.screen[FIT_LADDER.screen.length - 1];

/** The print rungs a value is sized against, largest first: every rung before the one that wraps, which is what a value past them all takes. */
const SIZED_PRINT_RUNGS: readonly PrintRung[] = FIT_LADDER.print.filter((entry) => !entry.wraps);

/** The print ladder's last rung, the one that wraps a value even the floor cannot hold. */
const PRINT_WRAP_RUNG: PrintFitRung = FIT_LADDER.print[FIT_LADDER.print.length - 1].rung;

/** Whether `phase` is one the search walks rather than the residual rung's, which is where the search falls out instead of a phase it tries. */
function isSizedPhase(phase: ScreenPhase): phase is SizedPhase {
	return phase !== RESIDUAL_RUNG.phase;
}

/** The rungs of one phase, largest first, as the ladder states them. */
function rungsOf(phase: SizedPhase): readonly ScreenRung[] {
	return FIT_LADDER.screen.filter((entry) => entry.phase === phase);
}

/** The sized rungs of every phase, keyed by phase. */
const PHASES: Readonly<Record<SizedPhase, readonly ScreenRung[]>> = {
	inline: rungsOf("inline"),
	stacked: rungsOf("stacked"),
};

/** The phases the search walks, in the order the ladder states them, so the ladder's own order is what decides which phase is tried first. */
const PHASE_ORDER: readonly SizedPhase[] = [...new Set(FIT_LADDER.screen.map((entry) => entry.phase).filter(isSizedPhase))];

/**
 * How wide a value is and how much room its box gives it, at one rung of one phase, in pixels.
 *
 * Both figures come from one layout: a phase is monotone and a monospace run's advance is proportional to its face's size, so one measurement at a phase's largest rung places the value among that phase's rungs.
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
 * The largest rung of the screen ladder whose box holds the value on one line, as `measure` reports each phase, or the residual rung when no rung of either phase does.
 *
 * `measure` is asked for one phase at a time and answers the width the value's content demands in that phase's largest rung and the width the box gives it there, so a value that fits beside its label costs one measurement and the stacked phase's row is never laid out.
 * The phases are tried in the ladder's order — the inline phase keeps the label, the value, and the copy control on one row, and the stacked phase, which buys the value the card's whole width at the cost of a line for the label, is entered only when no inline rung holds the value — and a phase whose measurement is `null` is skipped rather than read as a fit.
 */
function smallestFittingRung(measure: (phase: SizedPhase) => FitMeasurement | null): FitRung {
	for (const phase of PHASE_ORDER) {
		const rungs = PHASES[phase];
		if (rungs.length === 0) continue;
		const measured = measure(phase);
		if (measured === null) continue;
		const rung = largestFittingInPhase(rungs, measured);
		if (rung !== null) return rung;
	}
	return RESIDUAL_RUNG.rung;
}

/**
 * The largest rung of one phase that holds a value measured in that phase's largest rung, or `null` when even the phase's floor does not.
 *
 * A phase is monotone — a smaller face never needs more width than a larger one — and a monospace run's width is proportional to its face's size, so the demand at any rung of the phase follows from the one measurement and no rung has to be applied to be priced.
 */
function largestFittingInPhase(phase: readonly ScreenRung[], measured: FitMeasurement): FitRung | null {
	const reference = phase[0].sizeRem;
	for (const entry of phase) {
		if (measured.content * (entry.sizeRem / reference) <= measured.box) return entry.rung;
	}
	return null;
}

/** The largest rung of `phase`, which is the rung a fit is measured at, or `null` for a phase the ladder states no sized rung for. */
function largestRungOf(phase: SizedPhase): FitRung | null {
	const rungs = PHASES[phase];
	return rungs.length === 0 ? null : rungs[0].rung;
}

/**
 * Keep `target.value` on one line at the largest rung that fits its box, and re-fit it whenever that box resizes; returns the teardown that stops fitting.
 *
 * The rung is written as one class on `target.row` — the row holding the label and the value, because the stacked rungs change the row's own columns — and the row's other classes are kept, so a fit replaces the previous rung rather than adding a second one.
 * The subscription watches the value, which the fitter never writes to: an observer watching the row the fit reclasses is re-notified by the fit's own write, and the loop a browser detects between frames is reported as an undelivered notification.
 * A value the document already holds is fitted before this returns, so its rung is in place before the page draws it; a value the document does not hold yet is not fitted then — the subscription is taken all the same, and the first layout report after the value is mounted is what fits it. A run that finds the value detached, or a box with no width yet — a subtree no document holds, a hidden container — leaves the rung exactly as it is, which before the first fit is the CSS base rung.
 * The returned teardown is the whole of the release, and the caller owns it on every path: `onResize` promises no notification for a target that has left the document, so the surface that built the value carries that teardown on the element it returns (`ui/release.ts`) and runs it when it drops the row — whether the value was mounted and then replaced or never connected at all.
 * A `null` probe fits nothing, which is how a caller asks for the stylesheet's own rung alone, and a run that arrives after the teardown does nothing.
 */
export function fitValue(target: { readonly row: HTMLElement; readonly value: HTMLElement }, probe: LayoutProbe | null): () => void {
	if (probe === null) return () => {};
	let rung: FitRung | null = currentRung(target.row);
	let running = false;
	let stopped = false;
	let unsubscribe = (): void => {};

	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		unsubscribe();
	};

	const fit = (): void => {
		const starting = rung;
		// A box with no width yet — a subtree no document holds, a hidden container, a page that reports no layout at all — cannot price any rung, so the row is left exactly as it is rather than written to and put back with nothing gained.
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
		if (stopped || running) return;
		// A value the document does not hold is not fitted: it has no layout to measure, and the row keeps the rung it already carries until the value is mounted and a notification says so.
		if (target.value.isConnected === false) return;
		running = true;
		try {
			fit();
		} finally {
			running = false;
		}
	};

	run();
	if (!stopped) unsubscribe = probe.onResize(target.value, run);
	return stop;
}

/**
 * Write `rung` as the row's one rung class, keeping every class the row itself was built with, and write nothing when the class list already reads that way.
 *
 * One `setAttribute("class", …)` replaces the whole list, which is how the swap stays a single write; skipping the write when it would change nothing keeps a re-fit that lands on the rung already applied from waking the observer.
 */
function applyRung(row: HTMLElement, rung: FitRung | null): void {
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

/** Whether `name` is one of the ladder's rung classes rather than a class the row itself was built with. */
function isRung(name: string): boolean {
	return FIT_LADDER.screen.some((entry) => entry.rung === name);
}

/** The rung `row` already carries, or `null` when it carries none and the stylesheets' base rules still decide its size. */
function currentRung(row: HTMLElement): FitRung | null {
	const names = classNames(row);
	return FIT_LADDER.screen.find((entry) => names.includes(entry.rung))?.rung ?? null;
}

/**
 * The print rung a value's length earns: the largest rung of the print ladder whose line holds the value, or the wrapping rung when even the print floor cannot.
 *
 * A printed page cannot be measured from script and does not resize, so the choice is made from the character count: {@link printedCharacters} prices each rung from the page's line width and the mono advance bound, and the rungs are tried largest first.
 * That count is the whole of the estimate — a printer substitutes its own face, and the bound is what keeps the substituted face on one line — so only a value past the floor is allowed to break, which is the one printed presentation that puts a line break inside a string a wallet takes verbatim.
 * The break points are not restated here: the suite derives them from `print.css`'s own page block and holds every rung to that geometry, so a changed constant fails a test rather than leaving a comment behind.
 */
export function printFitRung(text: string): PrintFitRung {
	const characters = [...text].length;
	for (const { rung, points } of SIZED_PRINT_RUNGS) {
		if (characters <= printedCharacters(points)) return rung;
	}
	return PRINT_WRAP_RUNG;
}

/** How many monospace characters a value set at `points` fits on a printed payment value's line: the page's line width in CSS pixels against one character's advance, its em advance at the point size converted to those same pixels. */
function printedCharacters(points: number): number {
	return Math.floor(PRINT_VALUE_WIDTH_PX / (points * PIXELS_PER_POINT * MONO_ADVANCE_EM));
}
