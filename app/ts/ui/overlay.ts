/**
 * The modal overlay the app's dialogs are built on.
 *
 * A dialog module owns its own content; this module supplies the part every modal needs and no dialog should re-implement: the backdrop, dismissal on Escape, a click on the backdrop, Tab containment (`aria-modal`), hiding the page behind the dialog from assistive tech and from pointer/keyboard focus, and restoring focus afterwards.
 *
 * {@link createOverlay} builds and wires the overlay without mounting it, so a test can drive it against a fake document; {@link openOverlay} mounts it over the page and returns the handle whose `close()` undoes the mount and returns focus to whatever had it.
 * A dialog reaches this module carrying its release (`ui/release.ts`), exactly as every other subscribing surface returns one, and the overlay runs it as the dialog closes.
 * A release that throws while the payer dismisses the dialog is reported to the dialog's owner, which is the only place a payer can be told that something may still be running: a throw raised inside a DOM listener would otherwise reach nobody at all, so the dismissal the payer triggers never throws at them and the failure is reported both to their owner's fixed sentence and to the console, where a developer can read the exception itself.
 *
 * A handle also states whether its dialog has closed, because the payer dismissing a dialog is an event the dialog's owner is not the only reader of: `app/shell.ts` keeps whichever dialog a document opened, and a slot that could not tell a closed handle from a live one would read the next open attempt as a second dialog standing over the first.
 */

import { h } from "../util/dom.js";
import { reportInternalFailure } from "../util/errors.js";
import {
	NOTHING_TO_RELEASE,
	releasable,
	runReleases,
	type ReleasableElement,
	type Release,
} from "./release.js";

/** How an overlay reports its own dismissal, once. */
export interface OverlayOptions {
	readonly onClose?: () => void;
	/**
	 * A selector for the control the overlay should focus when it opens.
	 * Without one the first focusable control — usually the header's close button — receives focus; a dialog whose primary action should win names it here instead.
	 */
	readonly initialFocus?: string;
	/**
	 * Report that a dismissal could not stop everything the dialog started, so something it was watching may still be running.
	 *
	 * A dismissal the payer triggers — Escape, a click on the backdrop, a control of the dialog — has no caller to hand a failure back to, and a throw raised inside a DOM listener reaches the console and nobody else: this hook is where the dialog's owner states that to the payer in its own words, and the overlay hands it no detail of the failure, whose message can carry a validator's echo of a rejected value.
	 */
	readonly onDismissFailed?: () => void;
}

/**
 * A built (and possibly mounted) overlay: the element plus the one way to dismiss it.
 *
 * `element` carries the release of the dialog it wraps, the same value the dialog returned, so a caller whose mount never landed still holds the dialog's own release.
 * `close()` runs that release, so a release that throws reaches the caller that ran it; the dismissals a payer triggers report the same failure through `OverlayOptions.onDismissFailed` instead, having no caller to reach.
 * `closed` states that the dismissal has run, whichever path ran it: a caller that keeps the handle — the shell's modal slot — reads it to tell a dialog the page still holds from one the payer has already dismissed, and reads nothing else of what the dismissal did.
 */
export interface OverlayHandle {
	readonly element: ReleasableElement;
	readonly closed: boolean;
	close(): void;
}

/**
 * Wrap a dialog in a backdrop and wire its dismissal and focus containment, without mounting it.
 *
 * `buildDialog` is handed the overlay's dismissal, so a dialog's own close and done controls route through the same idempotent path as Escape and a backdrop click, and it returns the dialog carrying the release of everything it subscribed to.
 * That path reports a release that throws through `OverlayOptions.onDismissFailed` rather than throwing it at the listener that ran it, which on a page is the console and nothing else.
 * Tab is trapped inside the dialog so a keyboard user cannot reach the obscured page and then find Escape unresponsive.
 */
export function createOverlay(
	buildDialog: (close: () => void) => ReleasableElement,
	options: OverlayOptions = {},
): OverlayHandle {
	let dismissed = false;
	// The dialog's release runs first and the caller's close runs inside a `finally`, so neither half of a dismissal can keep the other from running.
	// The flag is set before either half runs, so the handle reads as closed from the moment the dismissal starts and a dialog that closes halfway is never reported as one the page still holds.
	const close = (): void => {
		if (dismissed) return;
		dismissed = true;
		try {
			dialog.release();
		} finally {
			options.onClose?.();
		}
	};
	/**
	 * Dismiss the dialog for a caller that has nobody to hand a failure back to: the same dismissal, with a release that throws reported through `onDismissFailed` rather than thrown into the listener that ran it.
	 * The dialog's own controls and the overlay's listeners are all this path, and the handle keeps `close` for a caller that can take the failure itself.
	 */
	const dismiss = (): void => {
		try {
			close();
		} catch (error) {
			// The owner states the fixed sentence the payer reads, and the failure behind it goes to the console: a dismissal the payer triggers has no caller to hand it back to, so a discarded error would leave a shipped stop fault with no trace anywhere.
			reportInternalFailure("dialog dismissal", error);
			options.onDismissFailed?.();
		}
	};
	const dialog = buildDialog(dismiss);
	let backdrop: HTMLElement;
	try {
		backdrop = h("div", { class: "dialog-backdrop", role: "presentation" }, dialog);
	} catch (error) {
		// The dialog exists before the backdrop that wraps it, so a backdrop that cannot be built would leave a dialog nothing ever dismisses: its release runs here rather than on a surface that is never returned.
		// A release that throws here is carried on the failure this window is already unwinding rather than thrown in its place, so neither is lost and the caller reads the failure it asked for.
		try {
			dialog.release();
		} catch (releaseFailure) {
			if (error instanceof Error && error.cause === undefined) error.cause = releaseFailure;
		}
		throw error;
	}
	const element = releasable(backdrop, dialog.release);

	element.addEventListener("click", (event) => {
		if (event.target === element) dismiss();
	});
	element.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			dismiss();
			return;
		}
		if (event.key === "Tab") trapFocus(event, dialog);
	});

	return {
		element,
		close,
		get closed(): boolean {
			return dismissed;
		},
	};
}

/**
 * Build a dialog through {@link createOverlay} and mount it over the page: the backdrop is appended to the body, the page behind it is hidden from assistive tech and from focus (`aria-hidden` + `inert`), and focus moves into the dialog.
 * Closing removes it, un-hides the page, and returns focus to whatever had it.
 */
export function openOverlay(
	buildDialog: (close: () => void) => ReleasableElement,
	options: OverlayOptions = {},
): OverlayHandle {
	let releaseMount: Release = NOTHING_TO_RELEASE;
	const handle = createOverlay(buildDialog, {
		onClose: () => {
			releaseMount();
			options.onClose?.();
		},
		onDismissFailed: options.onDismissFailed,
	});
	try {
		releaseMount = mountOverlay(handle.element);
		focusFirst(handle.element, options.initialFocus);
	} catch (error) {
		// A dialog built behind an overlay that never mounted is a dialog no dismissal will ever reach, so this window releases what it built — the release of the mount and the dialog's own release — before the failure reaches the caller that asked to open it.
		// Both run through the shared helper, because a mount that throws while it is undone would otherwise strand the dialog's release on a dialog no handle ever returns.
		try {
			runReleases([releaseMount, handle.element.release]);
		} catch (releaseFailure) {
			// The failure this window is already unwinding is the one the caller asked to open and the one it gets; the release that failed beside it is carried on it rather than thrown in its place, so neither failure is lost.
			if (error instanceof Error && error.cause === undefined) error.cause = releaseFailure;
		}
		throw error;
	}
	return handle;
}

/**
 * Append the overlay to the page and return the release of that mount: remove the backdrop, un-hide the background, refocus.
 *
 * The release exists only once this function returns one, so a mount that throws partway has no release for the caller to run: the backdrop this call appended is removed here, inside the same window, rather than left standing over a page whose background the failure may also have left hidden.
 * The removal comes before the undo in the returned release because either half can throw, and a throw in the background's undo would otherwise leave the backdrop mounted over the page the caller has already replaced — so the order is what makes that failure fail safe rather than what makes it tidy.
 */
function mountOverlay(element: HTMLElement): Release {
	const previouslyFocused = activeElement();
	try {
		if (typeof document !== "undefined") document.body?.append(element);
		const restoreBackground = hideBackground(element);
		return () => {
			element.remove();
			restoreBackground();
			previouslyFocused?.focus();
		};
	} catch (error) {
		element.remove();
		throw error;
	}
}

/**
 * Keep Tab inside `dialog`: wrap forward from the last control to the first, and backward from the first to the last.
 * When focus is already outside the dialog — after some other code moved it — the next Tab pulls it back to an edge.
 */
function trapFocus(event: KeyboardEvent, dialog: HTMLElement): void {
	const focusable = focusableElements(dialog);
	if (focusable.length === 0) {
		event.preventDefault();
		return;
	}
	const active = activeElement();
	const atEdge = event.shiftKey ? active === focusable[0] : active === focusable[focusable.length - 1];
	if (atEdge || active === null || !focusable.includes(active)) {
		event.preventDefault();
		(event.shiftKey ? focusable[focusable.length - 1] : focusable[0]).focus();
	}
}

/** Every focusable element below `root`, in document order: the dialog's controls and the focus stops its content declares. */
function focusableElements(root: HTMLElement): HTMLElement[] {
	const found: HTMLElement[] = [];
	const visit = (node: HTMLElement): void => {
		for (const child of node.children) {
			if (!(child instanceof HTMLElement)) continue;
			if (isFocusable(child)) found.push(child);
			visit(child);
		}
	};
	visit(root);
	return found;
}

const FOCUSABLE_TAGS: ReadonlySet<string> = new Set(["button", "input", "select", "textarea"]);

/**
 * Whether `element` can take keyboard focus: a form control, a link with a target, or anything the page made a focus stop with a non-negative `tabindex`.
 *
 * The `tabindex` case is what keeps a dialog's own focusable regions reachable by Tab: the payment panel's values are scroll boxes the page made focus stops, and a trap that counted only form controls would skip them, leaving a value that overflows its column unreachable while the same value is an ordinary focus stop in the payer's document.
 * A negative `tabindex` is an element made programmatically focusable alone, so the dialog does not become a focus stop of its own.
 * A `tabindex` the platform cannot read as an integer — an empty value, a word — is no `tabindex` at all, so such an element is judged by its tag here exactly as the browser judges it, rather than being counted as a focus stop the browser never makes.
 */
function isFocusable(element: HTMLElement): boolean {
	if (element.hasAttribute("disabled")) return false;
	const tabindex = element.getAttribute("tabindex");
	if (tabindex !== null) {
		const declared = declaredTabIndex(tabindex);
		if (declared !== null) return declared >= 0;
	}
	const tag = element.tagName.toLowerCase();
	if (tag === "a") return element.hasAttribute("href");
	return FOCUSABLE_TAGS.has(tag);
}

/** The integer a `tabindex` attribute declares, or `null` when the platform would read none out of it and the element's own tag decides instead. */
function declaredTabIndex(value: string): number | null {
	const trimmed = value.trim();
	return /^[+-]?\d+$/.test(trimmed) ? Number(trimmed) : null;
}

function activeElement(): HTMLElement | null {
	if (typeof document === "undefined") return null;
	const active = document.activeElement;
	return active instanceof HTMLElement ? active : null;
}

/**
 * Move focus into a freshly mounted overlay.
 * A dialog that named its own primary control with `initialFocus` gets it; otherwise the first focusable control (the header close button) is focused.
 * Falls back to the overlay itself when the selector matches nothing.
 */
function focusFirst(element: HTMLElement, selector?: string): void {
	const explicit = selector === undefined ? null : element.querySelector<HTMLElement>(selector);
	(explicit ?? element.querySelector<HTMLElement>("button, input") ?? element).focus();
}

/** One body child's state as an overlay found it, which is exactly what undoing that overlay's hiding writes back. */
interface BackgroundState {
	readonly element: HTMLElement;
	readonly ariaHidden: string | null;
	readonly inert: boolean;
}

/**
 * Hide every body child but `overlay` from assistive tech and from focus, for as long as the dialog is open.
 * Returns the release of that hiding: each element's previous `aria-hidden` is restored and the temporary `inert` is dropped, so a background element that was already hidden (or already inert) keeps its state.
 *
 * The state recorded for each child is the one it is in when this overlay mounts, so an overlay that arrives over another one records the background as the overlay beneath it left it and restores exactly that: dismissing the newcomer leaves the page hidden behind the dialog that still holds it, and leaves that dialog's own backdrop unhidden.
 * The hiding itself is all-or-nothing: a write that throws partway undoes the writes this call made before the failure leaves, because the mount that called it returns no release to undo them with.
 */
function hideBackground(overlay: HTMLElement): Release {
	if (typeof document === "undefined") return NOTHING_TO_RELEASE;
	const body = document.body ?? null;
	if (body === null) return NOTHING_TO_RELEASE;
	const previous: BackgroundState[] = [];
	for (const child of body.children) {
		if (child === overlay || !(child instanceof HTMLElement)) continue;
		previous.push({ element: child, ariaHidden: child.getAttribute("aria-hidden"), inert: child.hasAttribute("inert") });
	}
	let hidden = 0;
	try {
		for (const entry of previous) {
			hidden += 1;
			entry.element.setAttribute("aria-hidden", "true");
			entry.element.setAttribute("inert", "");
		}
	} catch (error) {
		restoreBackground(previous.slice(0, hidden));
		throw error;
	}
	return () => restoreBackground(previous);
}

/**
 * Write each entry's `aria-hidden` and `inert` back as the overlay found them, so a background element that was already hidden keeps its state and one this overlay hid stops being hidden by it.
 *
 * An entry whose writes never landed is restored just as faithfully: the values written back are the ones recorded before the first write, so restoring it changes nothing.
 */
function restoreBackground(entries: readonly BackgroundState[]): void {
	for (const entry of entries) {
		if (entry.ariaHidden === null) entry.element.removeAttribute("aria-hidden");
		else entry.element.setAttribute("aria-hidden", entry.ariaHidden);
		if (!entry.inert) entry.element.removeAttribute("inert");
	}
}
