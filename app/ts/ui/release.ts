/**
 * The release a subscribing surface hands back on the element it built.
 *
 * A surface that subscribed to something — the fitting `ui/fit-value.ts` attaches, or any later subscription — is the only thing that can end it: no probe promises a final notification for a target that has left the document, so a surface that leaves its teardown in a variable, or accepts it through a callback its caller may omit, strands that subscription for the life of the page.
 * This module states the one shape such a surface returns instead: the element it built carries `release`, and running that release stops everything the surface subscribed to.
 *
 * It hides where the teardown lives on a returned surface and how it is attached, and it promises that a surface has one release.
 * It builds no subscription and ends none of its own: which subscriptions a surface holds, and what makes their release idempotent, stays with the module that took them — `ui/payment-section.ts` drains its `fits`, `ui/pay.ts` its `stops`, and `ui/overlay.ts` guards its dismissal with `closed`.
 * A surface that subscribed to nothing returns {@link NOTHING_TO_RELEASE}, stated by that surface rather than read into by its caller, because a default inside {@link releasable} would make the omission silent again — the one omission that once stranded a live observer for the life of the page.
 *
 * The release travels on the element rather than in a `{ element, release }` handle because the element is what callers take: `app/shell.ts` mounts what a renderer returns in the route container, and the suites walk it as a tree root, so a handle would make every caller unwrap a document it never asked to inspect.
 * It is one property on a node, so no markup path can read it: nothing here reaches the network, the storage APIs, or the document.
 */

/** The teardown of everything one surface subscribed to; running it a second time does nothing. */
export type Release = () => void;

/** An element that carries the release of everything the surface that built it subscribed to. */
export type ReleasableElement = HTMLElement & { readonly release: Release };

/** The release a surface returns when it subscribed to nothing. */
export const NOTHING_TO_RELEASE: Release = () => {};

/**
 * Return `element` carrying `release`, so the surface that built it hands its teardown back with the element it returns.
 *
 * Nothing runs here and the release is never called: the caller that drops the element is the one that runs it, and running it is what ends the surface's subscriptions.
 */
export function releasable<T extends HTMLElement>(element: T, release: Release): T & ReleasableElement {
	return Object.assign(element, { release });
}
