/**
 * The browser's own layout probe: the app's adapter from the platform's layout primitives to the port `ui/fit-value.ts` fits a value through.
 *
 * It is integration glue at the composition root, an adapter for a platform primitive rather than a module with a contract of its own: it is a module-scope constant that `main.ts` imports and hands to the shell at boot, which carries it down to the surfaces that fit a value, so nothing below this file knows how a box is measured and no suite has to install a global to measure one.
 *
 * It deliberately decides nothing: which rung a measurement earns stays in `ui/fit-value.ts`, and this file only answers the two questions the port asks — the widths of a value's content and its box, and how to stop watching that box.
 * What it hides is the platform's own spelling of those questions, and the two places its obvious spelling is wrong: a range over the value's own contents behind the width the run draws, because `scrollWidth` is a whole pixel and reports a run overflowing by a fraction of a pixel as fitting; and the value's own laid-out box behind the width it has to fit, because `clientWidth` shrinks by the scrollbar the overflow itself draws, which prices a phase against a box narrower than the one the chosen rung finally gets.
 *
 * The security property it keeps is the page's own: it reads layout and observes it, writing no attribute or style and keeping no storage, so it cannot become a channel the page did not ship.
 */

import type { LayoutProbe } from "../ui/fit-value.js";
import { NOTHING_TO_RELEASE } from "../ui/release.js";

/**
 * `measure` reports the width the run draws and the width of the box it is drawn in, both in fractional CSS pixels, and answers `null` for a value the platform lays out nothing for; what a fit makes of widths that say nothing is `ui/fit-value.ts`'s decision, and that module's doc states it.
 *
 * An engine without `ResizeObserver` is handed `NOTHING_TO_RELEASE`, and what that costs is the whole of the fitting rather than its re-fit on a resize: every surface in the app fits a value built into a subtree nothing has mounted yet, so `fitValue`'s `isConnected === false` guard returns before it measures anything and no rung is written at all.
 * The row then keeps the base rung its stylesheet states and the cue class the surface wrote on it when it built the row, which is why a row no fit ever settled keeps the cue that the value may be cut off while a row a fit measured whole does not.
 */
export const browserLayoutProbe: LayoutProbe = {
	measure(value) {
		const box = laidOutWidth(value);
		if (box === null) return null;
		const content = drawnWidth(value);
		if (content === null) return null;
		return { content, box };
	},
	onResize(target, run) {
		if (typeof ResizeObserver !== "function") return NOTHING_TO_RELEASE;
		const observer = new ResizeObserver(() => run());
		observer.observe(target);
		return () => observer.disconnect();
	},
};

/**
 * The width the value's own run draws, in fractional CSS pixels, read from a range over the value's contents: a run held on one non-wrapping line is laid out at its full width whether or not its box clips it, so this is the demand a rung is priced against.
 * `null` when there is no range to measure with or the range reports no finite width, which a caller reads as no measurement: shrinking a value on a figure the platform did not give would be a guess, and a wrong one hides the tail of an address.
 */
function drawnWidth(value: HTMLElement): number | null {
	if (typeof document === "undefined" || typeof document.createRange !== "function") return null;
	const range = document.createRange();
	range.selectNodeContents(value);
	const width = range.getBoundingClientRect().width;
	return Number.isFinite(width) ? width : null;
}

/**
 * The width the value's run has once it fits, in fractional CSS pixels: the border box the layout gives the value, which does not move when a scrollbar the overflow drew comes and goes.
 *
 * The fitted values state no padding and no border of their own — `.payment-value` in `app/stylesheets/invoice.css` and the panel's four value classes in `app/stylesheets/app.css` — so their border box is the room their run is drawn in, and `tests/fit-value.test.mjs` holds those rules to that.
 * `null` for a value this platform lays out nothing for, which is the same no-measurement case as above.
 */
function laidOutWidth(value: HTMLElement): number | null {
	if (typeof value.getBoundingClientRect !== "function") return null;
	const width = value.getBoundingClientRect().width;
	return Number.isFinite(width) ? width : null;
}
