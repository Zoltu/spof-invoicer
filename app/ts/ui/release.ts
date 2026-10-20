/**
 * The release a surface attaches to the element it builds: the one way to undo what that surface started.
 *
 * A surface that subscribed to something — the fitting `ui/fit-value.ts` attaches, or any later subscription — is the only thing that can end it: no probe promises a final notification for a target that has left the document, so a surface that leaves its release in a variable, or accepts it through a callback its caller may omit, strands that subscription for the life of the page.
 * This module states the one shape such a surface returns instead: the element it built carries `release`, and running that release stops everything the surface subscribed to.
 * A release covers the DOM changes a surface made as well as the subscriptions it took, so {@link Release} is the one name for both and no reader has to work out which kind of release a value is: `ui/overlay.ts`'s `mountOverlay` returns the release of the mount it made — the backdrop it appended, the background it hid, the focus it moved — and `hideBackground` the release of the attributes it wrote.
 *
 * It hides how the release is attached to the element, and it promises that a surface has one release.
 * It takes no subscription and makes no DOM change of its own: which subscription or DOM change a release covers, and what makes it idempotent, stays with the module that made it — the section and the panel each pass on the release their own fittings returned (`ui/payment-section.ts`, `ui/pay.ts`), and the overlay passes on the release of its mount beside the guard that makes its dismissal run once (`ui/overlay.ts`).
 * A surface that started nothing returns {@link NOTHING_TO_RELEASE}, stated by that surface rather than read into by its caller: a default inside {@link releasable} would make a forgotten release silent, and a forgotten release strands a live observer for the life of the page.
 *
 * The release travels on the element rather than in a `{ element, release }` handle because the element is what callers take: `app/shell.ts` mounts what a renderer returns in the route container, and the suites walk it as a tree root, so a handle would make every caller unwrap a document it never asked to inspect.
 *
 * The security property it keeps is the page's own: it writes one property on a node and nothing else, reaching neither the network, the storage APIs, nor the document, so it cannot become a channel the page did not ship.
 */

/** The release of everything one surface started — a subscription it took, a mount it made, an attribute it wrote; running it a second time does nothing. */
export type Release = () => void;

/** An element that carries the release of everything the surface that built it started. */
export type ReleasableElement = HTMLElement & { readonly release: Release };

/**
 * The release a surface returns when it started nothing: `ui/share.ts` attaches this value for the dialog that subscribes to nothing.
 * The subscription `app/layout-probe.ts` returns when the engine cannot watch a box, since observing nothing and releasing nothing are both done by doing nothing.
 */
export const NOTHING_TO_RELEASE: Release = () => {};

/**
 * Return `element` carrying `release`, so the release travels out with the element the surface returns.
 *
 * Nothing is released here and the release is never called: the caller that drops the element is the one that releases it, and releasing it is what ends what the surface started.
 */
export function releasable<T extends HTMLElement>(element: T, release: Release): T & ReleasableElement {
	return Object.assign(element, { release });
}
