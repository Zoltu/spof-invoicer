/**
 * The fitting of a one-line value to the box that holds it: the largest rung of a fixed font-size ladder that keeps the value on one line, unclipped and unwrapped.
 *
 * A payment value is a string a wallet takes verbatim — a payee address, an amount, a payment link — so it may never be wrapped, truncated, or respaced to fit, and the only lever its box has is the size of the face it is set in. This module owns that ladder and the search along it; {@link fitValue} keeps a value's rung current as its box resizes.
 * The sizes themselves belong to the stylesheet: this module declares the ladder's rung names, `invoice.css` declares one rule per rung for every surface that draws such a value, and a test pins the two together, so no rung is a size the script knows and the page does not.
 * It deliberately does not touch the value's text, its focus, its ARIA, or any attribute but the one class on the row: the value stays ordinary selectable text and the copy control beside it keeps handing over the whole string whatever rung is applied.
 * What it hides: the ladder's two phases and its floor, the measurement search and its bound, the guard for a box that has not been laid out yet, the resize subscription and its teardown, and the mapping from a measurement to one class on one element.
 * A box that cannot be measured is left at the rung it already has rather than being assumed to fit: a wrong "fits" would hide the tail of an address, while a wrong "does not fit" costs only a smaller face, so the failure falls on the harmless side.
 * The print twin is sized here too: a printed page's geometry is fixed and its metrics are not measurable from script, so {@link printFitRung} maps a character count to the rung `print.css` declares, shrinking to the print floor before it lets the value break.
 * The module imports nothing from the app — it is the whole of this seam, as `ui/pay-flow.ts` is the whole of the payment flow — and `ui/payment-section.ts` and `ui/pay.ts` are its two callers.
 * The security property it keeps is the page's own: it writes a class and nothing else, never an inline style, which `style-src-attr 'none'` and the acceptance sweep both refuse, so fitting cannot become a channel for a stylesheet the page did not ship.
 */

/**
 * The width of the line a printed payment value is laid out on, in CSS pixels: a Letter page's 8.5in less the 0.75in margin `print.css` sets on each side, which is 7in, and 96 pixels to the inch.
 */
const PRINT_VALUE_WIDTH_PX = 504;

/**
 * The advance of one character in the widest monospace face a page is likely to substitute, in em: Courier and DejaVu Mono are about 0.602em, so 0.62em bounds them and no printed value is sized against a narrower face than the printer draws.
 */
const MONO_ADVANCE_EM = 0.62;

/** CSS pixels per point at the 96dpi reference the page assumes: a point is 1/72in and a CSS pixel 1/96in. */
const PIXELS_PER_POINT = 4 / 3;

/**
 * The first phase of the screen ladder: the label, the value, and the copy control on one row, from the base rung down to the floor.
 * The base rung is what a reader without JavaScript sees, and the last is the floor: below 10px a monospace face stops separating 0 from O and l from 1 at the default zoom, which is a verification hazard for an address rather than a matter of taste.
 */
const INLINE_RUNGS = ["fit-inline-13", "fit-inline-12", "fit-inline-11", "fit-inline-10"] as const;

/**
 * The second phase of the screen ladder: the label on a line of its own, so the value takes the card's whole width instead of sharing a row with it.
 * The phase costs the term a line, which is why it is entered only when no inline rung holds the value.
 */
const STACKED_RUNGS = ["fit-stacked-12", "fit-stacked-11", "fit-stacked-10"] as const;

/** The rung a value takes when no rung fits: still one line, at the floor, with the scrollbar its overflow draws shown rather than hidden, so the tail is reachable instead of clipped. */
const RESIDUAL_RUNG = "fit-residual";

/**
 * Every screen rung, in the ladder's order: the inline phase, then the stacked phase, then the residual rung.
 * `invoice.css` declares one rule per rung in this order, so the ladder reads top to bottom there, and `app.css` declares the panel's own row geometry for the phase whose class is written on it.
 */
export const FIT_RUNGS = [...INLINE_RUNGS, ...STACKED_RUNGS, RESIDUAL_RUNG] as const;

/** One rung of the screen ladder: a size in one of its two phases, or the residual rung. */
export type FitRung = (typeof FIT_RUNGS)[number];

/**
 * The print ladder, from the largest rung to the print floor, with the point size `print.css` declares for each rung.
 * The floor is 6pt — ordinary fine print — because a monospace address set smaller loses the 0/O and l/1 distinctions its reader checks on paper.
 */
const PRINT_RUNGS = [
	{ rung: "print-fit-1", points: 9 },
	{ rung: "print-fit-2", points: 8 },
	{ rung: "print-fit-3", points: 7 },
	{ rung: "print-fit-4", points: 6 },
] as const;

/** The rung a printed value takes when even the print floor cannot hold it: the one rung that may put a line break inside a value a wallet takes verbatim. */
const PRINT_WRAP_RUNG = "print-fit-wrap";

/** One rung of the print ladder, or the rung that wraps a value even the floor cannot hold. */
export type PrintFitRung = (typeof PRINT_RUNGS)[number]["rung"] | typeof PRINT_WRAP_RUNG;

/**
 * How the fitting reaches the layout: one measurement of a value against its own box, and a subscription to that box's resizes.
 *
 * It is shaped like the platform primitives behind it — `scrollWidth`/`clientWidth` and `ResizeObserver` — so the browser adapter below is a short statement of those, and a test can hand the fitter measurements it decides.
 * `measure` answers `null` when it cannot measure the value at all, which the fitter treats as no verdict rather than as either one.
 */
export interface LayoutProbe {
	/** The width of `value`'s content and the width of the box it is drawn in, in pixels, or `null` when the value cannot be measured. */
	measure(value: HTMLElement): { readonly content: number; readonly box: number } | null;
	/** Run `run` whenever `target` is laid out at a new size, and return the function that stops the subscription. */
	onResize(target: HTMLElement, run: () => void): () => void;
}

/**
 * The browser's own layout probe: the value's two widths for the measurement, and one `ResizeObserver` per fitted row for the subscription.
 *
 * It is this module's platform adapter, the way `wallClockTimer` sits in `ui/payment-section.ts`, and it answers `null` measurements with a no-op subscription on an engine without `ResizeObserver`, so a fake document and an engine that predates the interface both keep the base rung the stylesheet states rather than being fitted against a layout nothing reports.
 */
export const browserLayoutProbe: LayoutProbe = {
	measure(value) {
		if (typeof ResizeObserver !== "function") return null;
		return { content: value.scrollWidth, box: value.clientWidth };
	},
	onResize(target, run) {
		if (typeof ResizeObserver !== "function") return () => {};
		const observer = new ResizeObserver(() => run());
		observer.observe(target);
		return () => observer.disconnect();
	},
};

/**
 * The largest rung of the screen ladder whose box holds the value on one line, as `fits` reports it, or the residual rung when no rung does.
 *
 * The phases are tried in order: the inline phase keeps the label, the value, and the copy control on one row, and the stacked phase — which buys the value the card's whole width at the cost of a line for the label — is entered only when no inline rung holds the value.
 * `fits` is asked about a rung by name and must answer for the layout that rung produces, so the caller applies the rung before it measures.
 */
export function smallestFittingRung(fits: (rung: FitRung) => boolean): FitRung {
	for (const phase of [INLINE_RUNGS, STACKED_RUNGS]) {
		const rung = largestFittingInPhase(phase, fits);
		if (rung !== null) return rung;
	}
	return RESIDUAL_RUNG;
}

/**
 * The largest rung of one phase that `fits` accepts, or `null` when it accepts none.
 *
 * A phase is monotone — a smaller face never needs more width than a larger one — so a rung that fits rules out every larger rung and a rung that does not rules out every smaller one; halving the phase finds the answer in at most three measurements, which keeps a resize's re-fit off the frame's critical path.
 */
function largestFittingInPhase(phase: readonly FitRung[], fits: (rung: FitRung) => boolean): FitRung | null {
	let lowest = 0;
	let highest = phase.length - 1;
	let found: FitRung | null = null;
	while (lowest <= highest) {
		const middle = Math.floor((lowest + highest) / 2);
		const candidate = phase[middle];
		if (fits(candidate)) {
			found = candidate;
			highest = middle - 1;
		} else {
			lowest = middle + 1;
		}
	}
	return found;
}

/**
 * Keep `target.value` on one line at the largest rung that fits its box, and re-fit it whenever that box resizes; returns the teardown that stops fitting.
 *
 * The rung is written as one class on `target.row` — the row holding the label and the value, because the stacked rungs change the row's own columns — and the row's other classes are kept, so a fit replaces the previous rung rather than adding a second one and the write itself cannot wake the observer into a loop.
 * The first fit runs synchronously and the rest run on the subscription; a run that finds the value detached, or a box with no width yet — a subtree no document holds, a hidden container — leaves the rung exactly as it is, which before the first fit is the CSS base rung.
 * A `null` probe fits nothing, which is how a caller asks for the stylesheet's own rung alone, and a run that arrives after the teardown does nothing, so a section `ui/create.ts` rebuilt away is never written into.
 */
export function fitValue(target: { readonly row: HTMLElement; readonly value: HTMLElement }, probe: LayoutProbe | null): () => void {
	if (probe === null) return () => {};
	let rung: FitRung | null = currentRung(target.row);
	let stopped = false;
	const run = (): void => {
		if (stopped) return;
		if (target.value.isConnected === false) return;
		if (!hasBox(target.value, probe)) return;
		const starting = rung;
		let measurable = true;
		const chosen = smallestFittingRung((candidate) => {
			applyRung(target.row, candidate);
			const measurement = probe.measure(target.value);
			if (measurement === null || measurement.box <= 0) {
				measurable = false;
				return false;
			}
			return measurement.content <= measurement.box;
		});
		if (!measurable) {
			applyRung(target.row, starting);
			return;
		}
		rung = chosen;
		applyRung(target.row, chosen);
	};
	run();
	const unsubscribe = probe.onResize(target.row, run);
	return () => {
		stopped = true;
		unsubscribe();
	};
}

/** Whether `value` has a box to fit against at all: a measurement it can produce, on a width greater than zero. */
function hasBox(value: HTMLElement, probe: LayoutProbe): boolean {
	const measurement = probe.measure(value);
	return measurement !== null && measurement.box > 0;
}

/**
 * Write `rung` as the row's one rung class, keeping every class the row itself was built with, and write nothing when the class list already reads that way.
 *
 * One `setAttribute("class", …)` replaces the whole list, which is how the swap stays a single write; skipping the write when it would change nothing is what keeps a re-fit that lands on the rung already applied from waking the observer that watches the row.
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
	return FIT_RUNGS.some((rung) => rung === name);
}

/** The rung `row` already carries, or `null` when it carries none and the stylesheets' base rules still decide its size. */
function currentRung(row: HTMLElement): FitRung | null {
	const names = classNames(row);
	return FIT_RUNGS.find((rung) => names.includes(rung)) ?? null;
}

/**
 * The print rung a value's length earns: the largest rung of `print.css`'s ladder whose line holds the value, or the wrapping rung when even the print floor cannot.
 *
 * A printed page cannot be measured from script and does not resize, so the choice is made from the character count instead: the page's own line width against the widest common monospace advance gives 67 characters at 9pt, 76 at 8pt, 87 at 7pt, and 101 at the 6pt floor, and the rungs are tried largest first.
 * That count is the whole of the estimate — a printer substitutes its own face, and the bound is what keeps the substituted face on one line — so only a value past the floor is allowed to break, which is the one printed presentation that puts a line break inside a string a wallet takes verbatim.
 */
export function printFitRung(text: string): PrintFitRung {
	const characters = [...text].length;
	for (const { rung, points } of PRINT_RUNGS) {
		if (characters <= printedCharacters(points)) return rung;
	}
	return PRINT_WRAP_RUNG;
}

/** How many monospace characters a value set at `points` fits on a printed payment value's line, from the page's line width and the widest common face's advance. */
function printedCharacters(points: number): number {
	return Math.floor(PRINT_VALUE_WIDTH_PX / (points * PIXELS_PER_POINT * MONO_ADVANCE_EM));
}
