/**
 * The modal overlay the app's dialogs are built on.
 *
 * A dialog module owns its own content; this module supplies the part every modal needs and no dialog should re-implement: the backdrop, dismissal on Escape, a click on the backdrop, Tab containment (`aria-modal`), hiding the page behind the dialog from assistive tech and from pointer/keyboard focus, and restoring focus afterwards.
 *
 * {@link createOverlay} builds and wires the overlay without mounting it, so a test can drive it against a fake document; {@link openOverlay} mounts it over the page and returns the handle whose `close()` undoes the mount and returns focus to whatever had it.
 */
import { h } from "../util/dom.js";
/**
 * Wrap a dialog in a backdrop and wire its dismissal and focus containment, without mounting it.
 *
 * `buildDialog` is handed the overlay's `close`, so a dialog's own close and done controls route through the same idempotent path as Escape and a backdrop click.
 * Tab is trapped inside the dialog so a keyboard user cannot reach the obscured page and then find Escape unresponsive.
 */
export function createOverlay(buildDialog, options = {}) {
    let closed = false;
    const close = () => {
        if (closed)
            return;
        closed = true;
        options.onClose?.();
    };
    const dialog = buildDialog(close);
    const element = h("div", { class: "dialog-backdrop", role: "presentation" }, dialog);
    element.addEventListener("click", (event) => {
        if (event.target === element)
            close();
    });
    element.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            close();
            return;
        }
        if (event.key === "Tab")
            trapFocus(event, dialog);
    });
    return { element, close };
}
/**
 * Build a dialog through {@link createOverlay} and mount it over the page: the backdrop is appended to the body, the page behind it is hidden from assistive tech and from focus (`aria-hidden` + `inert`), and focus moves into the dialog.
 * Closing removes it, un-hides the page, and returns focus to whatever had it.
 */
export function openOverlay(buildDialog, options = {}) {
    let teardown = () => { };
    const handle = createOverlay(buildDialog, {
        onClose: () => {
            teardown();
            options.onClose?.();
        },
    });
    teardown = mountOverlay(handle.element);
    focusFirst(handle.element, options.initialFocus);
    return handle;
}
/** Append the overlay to the page and return the undo: un-hide the background, remove it, refocus. */
function mountOverlay(element) {
    const previouslyFocused = activeElement();
    if (typeof document !== "undefined")
        document.body?.append(element);
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
function trapFocus(event, dialog) {
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
/** Every focusable control below `root`, in document order: the dialog's buttons and its inputs. */
function focusableElements(root) {
    const found = [];
    const visit = (node) => {
        for (const child of node.children) {
            if (!(child instanceof HTMLElement))
                continue;
            if (isFocusable(child))
                found.push(child);
            visit(child);
        }
    };
    visit(root);
    return found;
}
const FOCUSABLE_TAGS = new Set(["button", "input", "select", "textarea"]);
function isFocusable(element) {
    if (element.hasAttribute("disabled"))
        return false;
    const tag = element.tagName.toLowerCase();
    if (tag === "a")
        return element.hasAttribute("href");
    return FOCUSABLE_TAGS.has(tag);
}
function activeElement() {
    if (typeof document === "undefined")
        return null;
    const active = document.activeElement;
    return active instanceof HTMLElement ? active : null;
}
/**
 * Move focus into a freshly mounted overlay.
 * A dialog that named its own primary control with `initialFocus` gets it; otherwise the first focusable control (the header close button) is focused.
 * Falls back to the overlay itself when the selector matches nothing.
 */
function focusFirst(element, selector) {
    const explicit = selector === undefined ? null : element.querySelector(selector);
    (explicit ?? element.querySelector("button, input") ?? element).focus();
}
/**
 * Hide every body child but `overlay` from assistive tech and from focus, for as long as the dialog is open.
 * Returns the undo: each element's previous `aria-hidden` is restored and the temporary `inert` is dropped, so a background element that was already hidden (or already inert) keeps its state.
 */
function hideBackground(overlay) {
    if (typeof document === "undefined")
        return () => { };
    const body = document.body ?? null;
    if (body === null)
        return () => { };
    const previous = [];
    for (const child of body.children) {
        if (child === overlay || !(child instanceof HTMLElement))
            continue;
        previous.push({ element: child, ariaHidden: child.getAttribute("aria-hidden"), inert: child.hasAttribute("inert") });
    }
    for (const entry of previous) {
        entry.element.setAttribute("aria-hidden", "true");
        entry.element.setAttribute("inert", "");
    }
    return () => {
        for (const entry of previous) {
            if (entry.ariaHidden === null)
                entry.element.removeAttribute("aria-hidden");
            else
                entry.element.setAttribute("aria-hidden", entry.ariaHidden);
            if (!entry.inert)
                entry.element.removeAttribute("inert");
        }
    };
}
//# sourceMappingURL=overlay.js.map