/**
 * The modal overlay the app's dialogs are built on.
 *
 * A dialog module owns its own content; this module supplies the part every modal needs and no dialog should re-implement: the backdrop, dismissal on Escape, a click on the backdrop, Tab containment (`aria-modal`), hiding the page behind the dialog from assistive tech and from pointer/keyboard focus, and restoring focus afterwards.
 *
 * {@link createOverlay} builds and wires the overlay without mounting it, so a test can drive it against a fake document; {@link openOverlay} mounts it over the page and returns the handle whose `close()` undoes the mount and returns focus to whatever had it.
 * A dialog reaches this module carrying its release (`ui/release.ts`), exactly as every other subscribing surface returns one, and the overlay runs it as the dialog closes.
 */

import { h } from "../util/dom.js";
import {
	NOTHING_TO_RELEASE,
	releasable,
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
}

/**
 * A built (and possibly mounted) overlay: the element plus the one way to dismiss it.
 *
 * `element` carries the release of the dialog it wraps, the same value the dialog returned, so a caller whose mount never landed still holds the dialog's own release.
 */
export interface OverlayHandle {
	readonly element: ReleasableElement;
	close(): void;
}

/**
 * Wrap a dialog in a backdrop and wire its dismissal and focus containment, without mounting it.
 *
 * `buildDialog` is handed the overlay's `close`, so a dialog's own close and done controls route through the same idempotent path as Escape and a backdrop click, and it returns the dialog carrying the release of everything it subscribed to.
 * Tab is trapped inside the dialog so a keyboard user cannot reach the obscured page and then find Escape unresponsive.
 */
export function createOverlay(
	buildDialog: (close: () => void) => ReleasableElement,
	options: OverlayOptions = {},
): OverlayHandle {
	let closed = false;
	// The dialog's release runs first and the caller's close runs inside a `finally`, so neither half of a dismissal can keep the other from running.
	const close = (): void => {
		if (closed) return;
		closed = true;
		try {
			dialog.release();
		} finally {
			options.onClose?.();
		}
	};
	const dialog = buildDialog(close);
	let backdrop: HTMLElement;
	try {
		backdrop = h("div", { class: "dialog-backdrop", role: "presentation" }, dialog);
	} catch (error) {
		// The dialog exists before the backdrop that wraps it, so a backdrop that cannot be built would leave a dialog nothing ever dismisses: its release runs here rather than on a surface that is never returned.
		dialog.release();
		throw error;
	}
	const element = releasable(backdrop, dialog.release);

	element.addEventListener("click", (event) => {
		if (event.target === element) close();
	});
	element.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			close();
			return;
		}
		if (event.key === "Tab") trapFocus(event, dialog);
	});

	return { element, close };
}

/**
 * Build a dialog through {@link createOverlay} and mount it over the page: the backdrop is appended to the body, the page behind it is hidden from assistive tech and from focus (`aria-hidden` + `inert`), and focus moves into the dialog.
 * Closing removes it, un-hides the page, and returns focus to whatever had it.
 */
export function openOverlay(
	buildDialog: (close: () => void) => ReleasableElement,
	options: OverlayOptions = {},
): OverlayHandle {
	let teardown: Release = NOTHING_TO_RELEASE;
	const handle = createOverlay(buildDialog, {
		onClose: () => {
			teardown();
			options.onClose?.();
		},
	});
	try {
		teardown = mountOverlay(handle.element);
		focusFirst(handle.element, options.initialFocus);
	} catch (error) {
		// A dialog built behind an overlay that never mounted is a dialog no dismissal will ever reach, so this window releases what it built — the undo of whatever part of the mount landed, then the dialog's own release — before the failure reaches the caller that asked to open it.
		teardown();
		handle.element.release();
		throw error;
	}
	return handle;
}

/** Append the overlay to the page and return the undo: un-hide the background, remove it, refocus. */
function mountOverlay(element: HTMLElement): Release {
	const previouslyFocused = activeElement();
	if (typeof document !== "undefined") document.body?.append(element);
	const restoreBackground = hideBackground(element);
	return () => {
		restoreBackground();
		element.remove();
		previouslyFocused?.focus();
	};
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
 * The `tabindex` case is what keeps a dialog's own focusable regions reachable by Tab: the payment panel's values are scroll boxes the page made stops, and a trap that counted only form controls would skip them, leaving a value that overflows its column unreachable while the same value is an ordinary stop in the payer's document. A negative `tabindex` is an element made programmatically focusable alone, so the dialog does not become a stop of its own.
 * A `tabindex` the platform cannot read as an integer — an empty value, a word — is no `tabindex` at all, so such an element is judged by its tag here exactly as the browser judges it, rather than being counted as a stop the browser never makes.
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

/**
 * Hide every body child but `overlay` from assistive tech and from focus, for as long as the dialog is open.
 * Returns the undo: each element's previous `aria-hidden` is restored and the temporary `inert` is dropped, so a background element that was already hidden (or already inert) keeps its state.
 */
function hideBackground(overlay: HTMLElement): Release {
	if (typeof document === "undefined") return NOTHING_TO_RELEASE;
	const body = document.body ?? null;
	if (body === null) return NOTHING_TO_RELEASE;
	const previous: {
		readonly element: HTMLElement;
		readonly ariaHidden: string | null;
		readonly inert: boolean;
	}[] = [];
	for (const child of body.children) {
		if (child === overlay || !(child instanceof HTMLElement)) continue;
		previous.push({ element: child, ariaHidden: child.getAttribute("aria-hidden"), inert: child.hasAttribute("inert") });
	}
	for (const entry of previous) {
		entry.element.setAttribute("aria-hidden", "true");
		entry.element.setAttribute("inert", "");
	}
	return () => {
		for (const entry of previous) {
			if (entry.ariaHidden === null) entry.element.removeAttribute("aria-hidden");
			else entry.element.setAttribute("aria-hidden", entry.ariaHidden);
			if (!entry.inert) entry.element.removeAttribute("inert");
		}
	};
}
