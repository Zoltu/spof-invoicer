/**
 * The browser's own layout probe: the app's adapter from the platform's layout primitives to the port `ui/fit-value.ts` fits a value through.
 *
 * It is integration glue at the composition root, not a module of its own: `main.ts` builds it once and hands it to the shell at boot, which carries it down to the surfaces that fit a value, so nothing below this file knows how a box is measured and no suite has to install a global to say.
 */

import type { LayoutProbe } from "../ui/fit-value.js";

/**
 * The value's two widths for the measurement, and a `ResizeObserver` for the subscription.
 *
 * `measure` answers `null` unless both widths are finite numbers: an environment with no layout — a fake document, a value in a subtree nothing draws — reports no widths rather than zero, and reading that as a measurement would write the residual rung onto every row instead of leaving the stylesheet's rung alone.
 * `onResize` is a no-op on an engine without `ResizeObserver`, so the base rung the stylesheet states is what an old engine keeps.
 */
export const browserLayoutProbe: LayoutProbe = {
	measure(value) {
		const content = value.scrollWidth;
		const box = value.clientWidth;
		if (!Number.isFinite(content) || !Number.isFinite(box)) return null;
		return { content, box };
	},
	onResize(target, run) {
		if (typeof ResizeObserver !== "function") return () => {};
		const observer = new ResizeObserver(() => run());
		observer.observe(target);
		return () => observer.disconnect();
	},
};
