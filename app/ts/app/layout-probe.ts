/**
 * The browser's own layout probe: the app's adapter from the platform's layout primitives to the port `ui/fit-value.ts` fits a value through.
 *
 * It is integration glue at the composition root, an adapter for a platform primitive rather than a module with a contract of its own: it is a module-scope constant that `main.ts` imports and hands to the shell at boot, which carries it down to the surfaces that fit a value, so nothing below this file knows how a box is measured and no suite has to install a global to measure one.
 *
 * It deliberately decides nothing: which rung a measurement earns stays in `ui/fit-value.ts`, and this file only answers the two questions the port asks — the widths of a value's content and its box, and how to stop watching that box.
 * What it hides is the platform's own spelling of those questions: `scrollWidth`/`clientWidth` behind one measurement that answers `null` when the platform reports no finite width, and a `ResizeObserver` behind a subscription whose returned function stops it.
 *
 * The security property it keeps is the page's own: it reads layout and observes it, writing no attribute or style and keeping no storage, so it cannot become a channel the page did not ship.
 */

import type { LayoutProbe } from "../ui/fit-value.js";
import { NOTHING_TO_RELEASE } from "../ui/release.js";

/**
 * The two things this adapter settles are how a width is reported and what it returns when there is nothing to observe.
 *
 * `measure` reports the platform's two widths and answers `null` only for a width the platform does not report as a finite number; what a fit makes of widths that say nothing is `ui/fit-value.ts`'s decision, and that module's doc states it.
 * An engine without `ResizeObserver` is handed `NOTHING_TO_RELEASE`: the fit still runs once before the subscription is attempted, so the rung that first fit chose stands rather than the base rung the stylesheet states, and only the re-fit on a resize is lost.
 */
export const browserLayoutProbe: LayoutProbe = {
	measure(value) {
		const content = value.scrollWidth;
		const box = value.clientWidth;
		if (!Number.isFinite(content) || !Number.isFinite(box)) return null;
		return { content, box };
	},
	onResize(target, run) {
		if (typeof ResizeObserver !== "function") return NOTHING_TO_RELEASE;
		const observer = new ResizeObserver(() => run());
		observer.observe(target);
		return () => observer.disconnect();
	},
};
