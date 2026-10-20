/**
 * The fitting of a one-line value to the box that holds it: the first rung of a fixed font-size ladder that keeps the value on one line, unclipped and unwrapped.
 *
 * A payment value is a string a wallet takes verbatim — a payee address, an amount, a payment link — so it may never be wrapped, truncated, or respaced to fit, and the only lever its box has is the font size it is set at; the receipt's transaction hash is fitted the same way, because it is a string the payer reads character by character and copies out.
 * The app has two ladders — a screen ladder the browser measures a value against, and a print ladder the printed page draws a value on — and this module owns both and the search along each; {@link fitValue} keeps a value's screen rung current as its box resizes.
 * The screen ladder's rungs belong to two phases, and the search walks the phases in the ladder's own order, trying each phase's rungs largest first: every inline rung down to its 10px floor is tried before the first, larger stacked rung, so a value keeps the inline row whenever any inline rung at or above the floor holds it.
 * The inline phase is the row a value shares with its label, and, on the invoice's payment terms, with the copy control beside it; a panel term carries no copy control, and below the `640px` breakpoint `app.css` gives every panel term a line of its own whatever rung a fit writes, so an inline rung there sets the font size of a value the row already gives the panel's whole width. The row each phase is measured in is the stylesheet's to draw; this module only orders the two.
 * {@link FIT_RUNGS} is the one published statement of both ladders: every screen rung's name, size, and phase, and every print rung's name and whether it wraps, with the point size each sized rung's rule states.
 * The screen search prices a phase from one measurement taken at that phase's largest rung, and writes a rung only after a measurement of the value with that rung in place, so an engine whose glyph advances do not follow its font size cannot settle on a rung its own measurement overflows: the proportional reading only proposes a candidate, a candidate whose measurement refuses it steps down to the next smaller rung of its phase and is measured in turn, and the residual rung is where a phase holding no measured rung leaves the search.
 * The screen ladder's rungs are stated once per surface in the stylesheet that draws that surface — `invoice.css` for the payment section's values, `app.css` for the payment panel's — and the print ladder's rungs in `print.css`.
 * Two tests in `tests/fit-value.test.mjs` read this one statement, one per ladder: "both stylesheets agree with the ladder the module states" holds the screen ladder to the two stylesheets that draw its rows, rung by rung, and "the print ladder's break points follow print.css's own page geometry and the column it leaves a value" holds the print ladder to the page geometry `print.css` declares, so no rung is a size the script knows and the page does not, and either ladder's representation can change without rewriting a suite.
 *
 * It deliberately does not touch the value's text, its focus, its ARIA, or any attribute but the one class on the row: the value stays ordinary selectable text and the copy control beside it keeps handing over the whole string whatever rung is applied.
 * What it hides: the two phases of the screen search and its floor, the measurement search and its bound, the guard for a box that has not been laid out yet, the subscriptions that re-fit it and their stop, and the mapping from a measurement to one class on one element.
 *
 * A box that already reports no width when a fit begins is left at whatever rung its class list already states rather than being assumed to fit: a wrong "fits" would hide the tail of an address, and a box the page has not laid out yet is no evidence that the value needs a smaller font size, so the failure stays out of the output instead of shrinking a line the page never showed to be too wide.
 * A box that stops reporting a width once a rung has been applied is read the other way, because there the absent measurement is the evidence for the rung the search has in hand: the row loses its rung rather than keeping one nothing confirmed, so the value falls back to the state its stylesheet marks as possibly clipped rather than to a silent fits.
 * A probe that throws during a fit is read the same way for the same reason: a fit that cannot finish has confirmed no rung, so the row loses the one it was carrying before the failure reaches the caller rather than keeping a rung nothing measured.
 *
 * The cue that a value may be clipped is therefore painted in every state of a row whose value the ladder sizes, and nothing a fit writes switches it off: a completed fit is no evidence that the value is still whole, because the one change a fit cannot observe — the advance the value's glyphs are actually drawn at — can grow the run past a box that reports nothing new, and a cue painted beside a value that is whole costs a payer one sentence while a missing cue beside a value that is clipped costs them the tail of an address.
 * The fit still writes the rung its own measurement held, so the value is drawn as large as it can be; it just makes no claim, in the class list, that the value is whole.
 *
 * The value's own box cannot report a change to the value's font size: a box is as wide as its column whatever face the value is drawn in, so a stylesheet rule that overrides a rung's size, or a change to the root font size every rem rung follows, can grow the run past the box while that box reports the same width as before, and a fit that only watched the box would never run again.
 * So the surface that builds a fitted value also builds the scale box {@link FIT_SCALE_CLASS} states — an `em`-sized, hidden element inside the value — and hands it to {@link fitValue}, which watches it beside the value: the scale box is sized from the value's computed font size, so a change to that size re-measures the value and the fit steps down to a rung its own measurement of the larger run supports. A surface that hands no scale box states that its value is fitted once and on its box's resizes alone.
 * What the scale box does not cover is the difference between the size a value is computed at and the advance its glyphs are actually drawn with: a browser minimum-font-size setting, `text-size-adjust` and the font boosting a mobile engine applies to a long run, and a face substituted after the first layout all change the used advance alone, leave every size the page can observe where it was, and report themselves to no observer the page may subscribe to. The cue below is what covers that gap.
 *
 * The stylesheets carry the other half of that: a row whose value a fitter sizes states it with a class of its own, and the surface's stylesheet paints the cue that the value may be cut off on that state, so a value the fit never reached is marked as possibly clipped rather than drawn as if a measurement had shown it whole.
 *
 * The print twin is sized here too: print metrics are not measurable from script, so {@link printFitRung} maps a character count to the rung `print.css` declares, priced against the column the twin is laid out on a Letter page rather than the page's whole line, and shrinking to the print floor before it hands a longer value to the wrap that breaks it into segments.
 * That column is the one the printed page draws, not one a printed page is guaranteed to give the twin — another page size or a changed margin leaves a narrower column, which no script can see before the page prints — so `print.css` states every rung as a line that keeps the value's characters and may break them, and a price taken against a wider column costs paper a visible continuation rather than the tail of an address.
 * {@link printedSegments} is the other half of that break: the string split into the runs one printed line of that column holds at the floor's size, so the first breaks fall where this module put them at the width the ladder prices.
 * A column narrower than that one breaks inside a segment, which no script can place or see, so the marking is the stylesheet's rather than this module's: `print.css` rules under every printed line of the value, and a break inside a segment is marked exactly as a break between two segments is.
 *
 * It reaches for no platform global: how a box is measured and watched arrives as the {@link LayoutProbe} its callers supply, the app's composition root is the one place that supplies the browser's own, and a fit that subscribed to nothing hands back a release that does nothing — the same case `ui/release.ts` states for a surface that started nothing.
 * The one name it takes from elsewhere as a type is `ui/release.ts`'s `Release`, taken as an inline `type` import, so the compiler erases it from the emitted module; the one function it loads is `util/errors.ts`'s `reportInternalFailure`, which is how a fit that fails inside a layout observation — a callback with no caller to return to — reaches a developer instead of leaving the payer with a cue and the console with an unexplained throw.
 *
 * The security property it keeps is the page's own: it writes a class and nothing else, never an inline style, which `style-src-attr 'none'` and the acceptance sweep both refuse, so fitting cannot become a channel for a stylesheet the page did not ship.
 */

import { reportInternalFailure } from "../util/errors.js";
import type { Release } from "./release.js";

/** The width of the printed page's content line in CSS pixels: the seven inches `print.css`'s `@page` block leaves between its margins, at the 96 CSS pixels an inch the page assumes. */
const PAGE_CONTENT_WIDTH_PX = 7 * 96;

/** The width of a printed payment term's label rail in CSS pixels: the seven rem `invoice.css` gives `.payment-term`'s first column, at the 16 CSS pixels the page's root font size stands for. */
const PRINT_LABEL_RAIL_PX = 7 * 16;

/** The gap between a printed payment term's two columns in CSS pixels: the half rem `invoice.css` states for `.payment-term`. */
const PRINT_ROW_GAP_PX = 0.5 * 16;

/**
 * The width of the column a printed payment value is laid out on, in CSS pixels: the page's content line less the label's rail and the row's gap.
 *
 * The print twin is a block inside the term's own value column, so the page's whole line is not the width it has: a twin sized against that line would set a value larger than its column holds on the page these margins draw, which is a printed value continuing past the width the rung was priced for.
 * The rail stated here is the widest `invoice.css` gives a printed term, so this is the narrowest the value's column is drawn at: the `640px` block at the foot of that stylesheet only narrows the rail, which widens the column.
 * `tests/fit-value.test.mjs` derives the same figure from `print.css`'s own page block and `invoice.css`'s own term rule, so a changed margin, rail, or gap fails a test rather than leaving a comment behind.
 */
const PRINT_VALUE_WIDTH_PX = PAGE_CONTENT_WIDTH_PX - PRINT_LABEL_RAIL_PX - PRINT_ROW_GAP_PX;

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

/**
 * The class of the scale box a surface draws inside a value the ladder sizes, and the one thing that reports a change to the value's drawn font size to the fit.
 *
 * It is an empty, hidden, absolutely positioned element sized `1em` in each direction, so its own size follows the value's computed font size and nothing else: the box it is drawn in is a fixed column whatever face the value is set at, which is why the value's own box cannot report that change (`app.css` states the rule).
 * What it reports is a change to the value's computed font size — a re-sized rung, a changed root font size, an inherited size — and it reports nothing of a change to the used advance alone: a browser minimum-font-size setting, `text-size-adjust`, a mobile engine's font boosting, and a late face substitution leave every size the page can observe where it was. That gap is why the cue that the value may be cut off is painted in every state of a fitted row and no class a fit writes switches it off.
 * The surface that builds the value builds this too, because the element has to sit inside the value to inherit its face; {@link fitValue} is what subscribes to it.
 */
export const FIT_SCALE_CLASS = "fit-scale";

/** One rung of the screen ladder: the class the fitter writes, the phase whose geometry decides the row, or `residual` for the last rung, which belongs to no phase, and the font size in rem its rule states. */
type ScreenRung = (typeof FIT_RUNGS.screen)[number];

/** One rung of the print ladder: the class a twin carries, whether it is the rung that wraps, and — for a sized rung — the point size its rule states. */
type PrintRung = (typeof FIT_RUNGS.print)[number];

/** A print rung a value is priced against: a rung that states its point size, so {@link printedCharacters} can work out how many characters the printed value's column holds at it — the wrapping rung states no size, so the estimate cannot price it and a value past every sized rung takes it as the fallback. */
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

/** The print ladder's floor, in points: the size its smallest sized rung states, and the size the wrapping rung is drawn at, which is the face a segment of a wrapped value is measured against. */
const PRINT_FLOOR_POINTS = SIZED_PRINT_RUNGS[SIZED_PRINT_RUNGS.length - 1].points;

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
 * Both figures come from one layout, taken with the rung whose verdict they are: the search asks for the value's width and its box's width with a rung applied, so the rung it writes is one a measurement of that rung reported on rather than one a proportional reading of another rung predicted.
 * Both are in fractional CSS pixels, which the port below states: a run overflowing its box by a fraction of a pixel is an overflow, and a whole-pixel figure would report it as a fit and leave the run's last glyph edge clipped.
 */
export interface FitMeasurement {
	readonly content: number;
	readonly box: number;
}

/**
 * How the fitting reaches the layout: one measurement of a value against its own box, and a subscription to a box's resizes.
 *
 * It is shaped like the platform primitives behind it — the width a run is drawn at, the width its box gives it, and `ResizeObserver` — so the adapter the app's composition root supplies (`app/layout-probe.ts`) is a short statement of those, and a test can hand the fitter measurements it decides instead of installing a global.
 * The two widths are the whole of the verdict, so the port states the precision it needs of them: both are measured in fractional CSS pixels and neither is a rounded whole-pixel reading, because a run that overflows its box by less than a pixel would otherwise be reported as fitting and would keep a rung at which its last glyph edge is clipped.
 * The box is the room the run has once it fits, so a scrollbar the overflow itself draws is not part of it: a box measured in the overflowing state would be narrower than the one the rung the fit chooses is finally drawn in.
 * `measure` answers `null` when it cannot measure the value at all, which the fitter reads as no verdict.
 * `onResize` promises the function that stops the subscription, and nothing else: it does not promise a last notification for a target that leaves the document, so nothing here reads a missing resize as a release.
 */
export interface LayoutProbe {
	/** The width of `value`'s content and the width of the box it is drawn in, in fractional pixels, or `null` when the layout reports no widths for it. */
	measure(value: HTMLElement): FitMeasurement | null;
	/** Run `run` whenever `target` is laid out at a new size, and return the function that stops the subscription. */
	onResize(target: HTMLElement, run: () => void): () => void;
}

/**
 * How a fitted value is handed to the fitting: the probe its box is measured through, and the collector each fit's release is added to.
 *
 * Both surfaces that fit values state this one shape — `ui/payment-section.ts` for the invoice's payment terms, `ui/pay.ts` for the panel's summary rows and its receipt — so it sits here beside the fitter rather than in either of them: a surface that fits a value depends on this module for how it is fitted, and on no other surface for it.
 */
export interface TermFitting {
	readonly fit: LayoutProbe | null;
	readonly releases: Release[];
}

/**
 * What one fit is taken against: the row the rung's class is written on, the value the fitter measures and must never write to, and — for a surface that builds one — the scale box that reports a change to the value's drawn font size.
 *
 * `scale` is the element {@link FIT_SCALE_CLASS} states, drawn inside `value`: the fit watches it beside the value's box, so the one change the box cannot report — the value set in a larger face inside a column of the same width — is one the fit is still told about.
 * A caller that hands no scale box is stating that its value is fitted once and on its box's resizes alone.
 */
export interface FitTarget {
	readonly row: HTMLElement;
	readonly value: HTMLElement;
	readonly scale?: HTMLElement | null;
}

/**
 * The rung the screen search writes for a value, given how that value and its box measure with one rung applied: the first rung, in the ladder's order, whose own measurement shows the box holding the value on one line, or the residual rung when no rung's measurement does.
 *
 * A phase is priced from one measurement taken at its largest rung, and that measurement is itself the verdict for that rung; every rung below it is priced by that same measurement and then measured in turn before the search may write it, because a face whose advances do not follow its size can demand more at a smaller rung than the proportional reading predicted.
 * A phase whose measurement is `null` — a box that stops reporting a width mid-search — ends the search with no rung at all rather than with the last one it happened to have: `null` is this function's answer that nothing was measured, and its caller drops the rung so the stylesheet's cue is painted.
 * Exported so a caller can drive the search with measurements it decides; {@link fitValue} is its only caller in the app.
 */
export function smallestFittingRung(measureAt: (rung: ScreenFitClass) => FitMeasurement | null): ScreenFitClass | null {
	for (const phase of PHASE_ORDER) {
		const rungs = PHASES[phase];
		if (rungs.length === 0) continue;
		const reference = measureAt(rungs[0].rung);
		if (reference === null) return null;
		if (fits(reference)) return rungs[0].rung;
		const candidate = largestFittingInPhase(rungs, reference);
		// No candidate means the reading priced even this phase's floor past the box, so the phase is left rather than walked: the ladder's order puts the next phase's rungs above this phase's floor, and a rung the reading did not propose would only be written after a measurement of its own.
		const start = candidate === null ? rungs.length : rungs.indexOf(candidate);
		for (let index = start; index < rungs.length; index += 1) {
			const measured = measureAt(rungs[index].rung);
			if (measured === null) return null;
			if (fits(measured)) return rungs[index].rung;
		}
	}
	return RESIDUAL_RUNG.rung;
}

/** Whether a measurement taken with one rung applied shows the box holding the value, on the fractional pixels both figures are stated in. */
function fits(measured: FitMeasurement): boolean {
	return measured.content <= measured.box;
}

/**
 * The largest rung of one phase whose width, read proportionally from a measurement taken at the phase's largest rung, would hold the value — or `null` when even the phase's floor would not.
 *
 * This is a candidate and never a verdict: a monospace run's advance usually follows its font size, which makes the reading a good guess at which rung to measure next, but an engine whose glyph advances do not is exactly the case the reading gets wrong, so every rung this names is measured with that rung applied before {@link smallestFittingRung} writes it.
 */
function largestFittingInPhase(rungs: readonly ScreenRung[], measured: FitMeasurement): ScreenRung | null {
	const reference = rungs[0].sizeRem;
	for (const entry of rungs) {
		if (measured.content * (entry.sizeRem / reference) <= measured.box) return entry;
	}
	return null;
}

/**
 * Keep `target.value` on one line at the first rung of the screen ladder that a measurement shows holding its box, and re-fit it whenever that box resizes or the value's drawn font size changes; returns the release that stops fitting.
 *
 * The rung is written as one class on `target.row` — the row holding the label and the value, because the stacked rungs change the row's own columns — and the row's other classes are kept, so a fit replaces the previous rung rather than adding a second one.
 * The row's class attribute is the only record of its rung: every write reads the classes the row already carries, drops whichever of them is a rung, and writes the one class the search chose, so the fit keeps no copy of a rung between writes and the class list is the whole of what it has written.
 * The subscription watches the value, which the fitter never writes to: an observer watching the row the fit reclasses is re-notified by the fit's own write, and the loop a browser detects between frames is reported as an undelivered notification. It watches `target.scale` beside it, because the value's own box is as wide as its column whatever face the value is drawn in and so reports no change when a rule or an inherited size sets the value in a larger face: the scale box is sized from that same computed font size and is the one box that reports it.
 * A value the document already holds is fitted before this returns, so its rung is in place before the page draws it; a value the document does not hold yet is not fitted then — it carries no rung, and its surface's stylesheet paints the cue that says the value may be clipped — while the subscription is taken all the same, and the first layout report after the value is mounted is what fits it.
 * A value whose box stops reporting a width once a rung is applied loses its rung rather than keeping the one it had: the cue is painted either way, and a rung nothing measured is not worth keeping.
 * A measurement that throws is answered the same way: the row loses its rung before the failure reaches the caller, so a probe that fails leaves the value in the state that paints the cue rather than one that keeps a rung nothing confirmed. A clean-up that fails is not reported in place of the fit's failure, which stays the error the caller receives.
 * A subscription the fit cannot take is answered by releasing the subscriptions it already took: the function returns no release on that path, so the caller has nothing else to run, and a subscription taken before the failure would otherwise watch a row nothing ever drops.
 * A fit that throws after its first, synchronous run — one a resize observation delivered — has no caller to hand the failure back to, so it is reported to the console where a developer can read it (`util/errors.ts`'s `reportInternalFailure`) and the row it left behind keeps the cue.
 * The returned function is the whole of the release, and the caller owns it on every path: `onResize` promises no notification for a target that has left the document, so the surface that built the value carries that release on the element it returns (`ui/release.ts`) and runs it when it drops the row — whether the value was mounted and then replaced or never connected at all.
 * A `null` probe fits nothing, which is how a caller asks for the stylesheet's own rung alone, and a run that arrives after the release does nothing.
 */
export function fitValue(target: FitTarget, probe: LayoutProbe | null): Release {
	if (probe === null) return () => {};
	let running = false;
	let released = false;
	const stops: Release[] = [];

	/**
	 * Stop everything this fit subscribed to, once.
	 *
	 * There is one stop per box watched, and each runs even when an earlier one throws: a stop that failed would otherwise leave the second box watched for the life of the page, which is the leak this release exists to end. The first failure still reaches the caller that ran the release.
	 */
	const release = (): void => {
		if (released) return;
		released = true;
		let failure: unknown = null;
		for (const stop of stops.splice(0)) {
			try {
				stop();
			} catch (error) {
				if (failure === null) failure = error;
			}
		}
		if (failure !== null) throw failure;
	};

	/**
	 * Fit the value as it is laid out now, and leave the row with no rung when that cannot be done.
	 *
	 * The rung the search lands on is one its own measurement showed holding the value, and the stylesheet's cue that the value may be cut off stays painted beside it whatever rung that is: the cue belongs to the row rather than to the rung, because a value a measurement showed whole can still be drawn in a larger face that no observer reports (the module doc states which changes those are).
	 * A fit that throws replaces the search's last candidate with the row's no-rung state before the failure reaches the caller, and only a recovery that itself throws leaves that candidate in place; the cue is painted in either state, so no value that may be clipped rests on a verdict nothing took.
	 */
	const fit = (): void => {
		try {
			const before = probe.measure(target.value);
			if (before === null || before.box <= 0) return;
			// A measurement is of the value with a rung applied, so the search's own verdicts are the width each rung finally drawn was drawn at.
			const measureAt = (candidate: ScreenFitClass): FitMeasurement | null => {
				applyRung(target.row, candidate);
				const measured = probe.measure(target.value);
				return measured === null || measured.box <= 0 ? null : measured;
			};
			const chosen = smallestFittingRung(measureAt);
			applyRung(target.row, chosen);
		} catch (error) {
			try {
				applyRung(target.row, null);
			} catch {
				// The row is left as the failed fit left it, which is the state a candidate write produces, so the cue is painted either way. There is no second route to the row's one class attribute, and the failure the caller asked about is the fit's own, not the recovery's.
			}
			throw error;
		}
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

	/**
	 * The run a layout observation delivers: `run`, with a failure reported rather than escaping a callback that has no caller.
	 *
	 * A `ResizeObserver` callback's throw is an uncaught error and nothing else — no surface renders it and no payer sees it — so the failure is reported to the console here, the route every other failure path in this change takes, and the row keeps the state the fit's own recovery left it in.
	 */
	const observe = (): void => {
		try {
			run();
		} catch (error) {
			reportInternalFailure("fitted value refit", error);
		}
	};

	run();
	if (!released) {
		stops.push(probe.onResize(target.value, observe));
		if (target.scale !== undefined && target.scale !== null) {
			try {
				stops.push(probe.onResize(target.scale, observe));
			} catch (error) {
				// The first subscription is taken and nothing above this call holds it, so a second one that throws is answered by releasing the first before the failure reaches the caller: otherwise a row the surface goes on to drop would leave an observer watching it for the life of the page.
				try {
					release();
				} catch (releaseFailure) {
					// The subscription failure is the one the caller asked for and the one it gets; the release that failed beside it is carried on it rather than thrown in its place.
					if (error instanceof Error && error.cause === undefined) error.cause = releaseFailure;
				}
				throw error;
			}
		}
	}
	return release;
}

/**
 * Write `rung` as the row's one rung class, keeping every class the row itself was built with, and write nothing when the class list already reads that way.
 *
 * One `setAttribute("class", …)` replaces the whole list, so the swap stays a single write and no reader observes two rungs at once.
 * Skipping the write when it would change nothing keeps a re-fit that lands on the rung already applied from waking the observer.
 * A `null` rung removes the class the previous fit wrote, which is the row's may-be-clipped state rather than a verdict about it; the stylesheet's cue is painted there as it is in every other state of a row whose value the ladder sizes.
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

/**
 * The print rung a value's length earns: the largest rung of the print ladder whose line holds the value, or the wrapping rung when even the print floor cannot.
 *
 * A printed page cannot be measured from script and does not resize, so the choice is made from the character count: {@link printedCharacters} prices each rung from the width of the column the print twin is laid out in and the mono advance bound, and the rungs are tried largest first.
 * That count is the whole of the estimate — a printer substitutes its own face, and the bound is what keeps the substituted face on a line of the column the price was taken against — so a value past the floor takes the segment-building wrap, whose first breaks {@link printedSegments} decides, rather than shrinking past the floor.
 * A printed column narrower than the priced one is a case no script can see, so the rung's rule in `print.css` keeps the value's characters and lets them break: a price taken against a wider column costs paper a visible continuation, never the tail of the value.
 * The break points are not restated here: the suite derives them from `print.css`'s page block and `invoice.css`'s own payment term, and holds every rung to that geometry, so a changed constant fails a test rather than leaving a comment behind.
 */
export function printFitRung(text: string): PrintFitClass {
	const characters = [...text].length;
	for (const { rung, points } of SIZED_PRINT_RUNGS) {
		if (characters <= printedCharacters(points)) return rung;
	}
	return PRINT_WRAP_RUNG.rung;
}

/**
 * A printed value split into the runs one line of its column holds at the print floor's size: the value's own characters, in order, with nothing added, dropped, or moved.
 *
 * A value long enough to take the wrapping rung is broken by the page, and a break the page chose falls wherever the box ends — which is a place a payer hand-copying the value cannot see, and a place where the copied text may pick up a space or a newline that is no part of the value.
 * Splitting the string here puts the breaks it can put where this module decided them, and the printed run holds no character the value does not.
 * The capacity is the floor's, because that is the size the wrapping rung is drawn at and the smallest a printed value is ever set; a value short enough for a sized rung is shorter than that capacity, so it is one segment and one line.
 * Those breaks are the ones the priced column earns: the longest segment is measured against the widest monospace face a printer substitutes, so at that width no segment overflows and no line breaks where this module did not put it.
 * A narrower column — another page size, a margin set in the print dialog, a wider substituted face — breaks inside a segment, which is a break this module cannot place and cannot see; `print.css` marks every printed line of the value, so that break is as marked as one between two segments, and a payer is never asked to interpret a line end as a matter of judgement.
 */
export function printedSegments(text: string): readonly string[] {
	const characters = [...text];
	const capacity = printedCharacters(PRINT_FLOOR_POINTS);
	const segments: string[] = [];
	for (let start = 0; start < characters.length; start += capacity) {
		segments.push(characters.slice(start, start + capacity).join(""));
	}
	return segments.length === 0 ? [""] : segments;
}

/** How many monospace characters a value set at `points` fits on a printed payment value's line: the width of the column the twin is laid out in, in CSS pixels, against one character's advance — its em advance at the point size converted to those same pixels. */
function printedCharacters(points: number): number {
	return Math.floor(PRINT_VALUE_WIDTH_PX / (points * PIXELS_PER_POINT * MONO_ADVANCE_EM));
}
