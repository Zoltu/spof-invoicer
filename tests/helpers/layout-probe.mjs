/**
 * The layout probe a suite drives itself: the measurements it states, the resize callbacks it fires by hand, and the subscriptions it can hold equal.
 *
 * The fitting in `app/ts/ui/fit-value.ts` reaches the layout through an injected probe rather than a platform global, so no suite installs a `ResizeObserver` to watch a fit: it hands the surface it renders a probe, states what that probe measures, and reads the subscriptions the probe recorded.
 */

/**
 * A probe whose measurements the test states and whose resize callbacks it fires by hand, so a fit is observed without a browser laying anything out.
 * `measure` answers whatever the test's own function says, which is how a value's demand is made to follow the phase the row's class list states.
 * `targets` records every subscription the fitter took and `unsubscribed` every one a release dropped, so the two can be held equal, and `fire` delivers the resize every subscription is waiting for.
 */
export function fakeProbe(measure) {
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
		/** Deliver the resize every subscription is waiting for, as a laid-out box reports it. */
		fire() {
			for (const run of runs) run();
		},
	};
}
