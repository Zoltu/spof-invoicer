/**
 * The share-presentation surface.
 *
 * One invoice becomes two strings — a fragment URL and a standalone base32 blob — and this module owns both how they are built and how they are shown, as a two-option dialog so whoever is sharing can see which one fits how they are sending it.
 * It carries no dependency on the app shell or on any view, so the create flow and the payer view open the same dialog instead of duplicating it, and the `#/i/<base32>` wire format stays sourced from `invoice/share.ts` alone.
 *
 * The modal behaviour itself — the backdrop, Escape, the Tab trap, hiding the page behind the dialog, and focus restoration — belongs to `ui/overlay.ts`, which the payment panel shares.
 * This module supplies only the dialog's content and its close controls.
 * {@link createShareDialog} builds the overlay without mounting it, so the dialog is testable without a browser; {@link openShareDialog} mounts it over the page.
 * Every string reaches the page as a text child of `util/dom.ts`'s `h()`, so a share payload can never become markup.
 *
 * The clipboard helper is `ui/clipboard.ts`'s, re-exported here so this module's callers keep a single import site.
 */

import { encodeInvoiceBlob } from "../invoice/codec.js";
import type { Invoice } from "../invoice/model.js";
import { buildShareUrl } from "../invoice/share.js";
import { h } from "../util/dom.js";
import { copyText, copyWithFallback, type ClipboardLike } from "./clipboard.js";
import { createOverlay, openOverlay, type OverlayHandle } from "./overlay.js";

/** The clipboard write helper and its `ClipboardLike` shape, re-exported from the neutral `ui/clipboard.ts` module. */
export { copyText, type ClipboardLike };

/** The two share strings an invoice yields; the URL keeps the payload in its fragment. */
export interface ShareBundle {
	readonly url: string;
	readonly blob: string;
}

/** Build the two share strings for an invoice. */
export function buildShareBundle(invoice: Invoice, baseUrl: string): ShareBundle {
	return Object.freeze({
		url: buildShareUrl(invoice, baseUrl),
		blob: encodeInvoiceBlob(invoice),
	});
}

/** Which of the two share strings a row shows; also the suffix of its input's id. */
type ShareFieldKey = "url" | "blob";

interface ShareField {
	readonly key: ShareFieldKey;
	readonly label: string;
	readonly copyLabel: string;
	readonly value: string;
}

/** The two strings an invoice shares, in the order the dialog presents them. */
function shareFields(bundle: ShareBundle): readonly ShareField[] {
	return [
		{ key: "url", label: "Share link", copyLabel: "Copy share link", value: bundle.url },
		{ key: "blob", label: "Invoice text (blob)", copyLabel: "Copy invoice blob", value: bundle.blob },
	];
}

/**
 * The verbatim explanation each option block carries, keyed by the field it presents.
 *
 * The copy addresses whoever is looking at the dialog — the payee who just built the invoice or the payer who received it — so it says "you" and "the recipient" rather than naming either role, and it avoids internal jargon: a link that only resolves on the sharer's own machine is spelled out without the word "localhost", and the standalone string is described as one long run of letters and digits rather than "base32".
 */
const SHARE_OPTION_COPY: Readonly<Record<ShareFieldKey, { title: string; body: string; notes: readonly string[] }>> = {
	url: {
		title: "Option 1 — Share the link",
		body: "Send this link to the recipient. It opens straight to the invoice in their browser.",
		notes: ["This works whenever the tool is at a normal web address. But if you're running it on your own computer, the link only works for you — the recipient can't open it. Use Option 2 in that case."],
	},
	blob: {
		title: "Option 2 — Share the text (the blob)",
		body: "Copy this text and send it to the recipient however you like — email, chat, or a note.",
		notes: [
			"The recipient opens their own copy of the tool and pastes that text into the box at the top of the page, then clicks Open. The invoice appears just as if they had opened a link.",
			"This text is the whole invoice written out as one long run of letters and digits, and it always begins with pinv1b-. It carries no web address of its own, so it works even where a link won't — with no server in between. That is what lets the tool run decentralized: on your own computer, with no central server.",
		],
	},
};

/**
 * Fill `container` with the two-option share dialog body: an intro paragraph and one option block per share string, each explaining what the option is and when to choose it.
 *
 * A copy click reports success in the block's status; when the Clipboard API is unavailable or refuses the write, the field is selected and the status tells the user to copy by hand — the fallback a non-secure context requires, since the Clipboard API is unavailable there.
 * Each input is named by a real `<label>` and each copy button carries its own accessible name, so the two options are distinguishable.
 * The status is a `role="status"` live region, so a screen reader hears the confirmation a copy click produces.
 */
function renderShareOptions(container: HTMLElement, bundle: ShareBundle, clipboard: ClipboardLike | null): void {
	container.replaceChildren(
		h(
			"p",
			{ class: "field-hint" },
			"There are two ways to pass this invoice on. Pick the one that fits how you're sending it.",
		),
		...shareFields(bundle).map((field) => shareOption(field, clipboard)),
	);
}

function shareOption(field: ShareField, clipboard: ClipboardLike | null): HTMLElement {
	const copy = SHARE_OPTION_COPY[field.key];
	return h(
		"div",
		{ class: "share-option" },
		h("h3", { class: "share-option-title" }, copy.title),
		h("p", { class: "share-option-body" }, copy.body),
		...copy.notes.map((note) => h("p", { class: "share-option-note" }, note)),
		shareRow(field, clipboard),
	);
}

function shareRow(field: ShareField, clipboard: ClipboardLike | null): HTMLElement {
	const inputId = `share-value-${field.key}`;
	const input = h("input", { type: "text", id: inputId, class: "share-value", readonly: true, value: field.value });
	const status = h("span", { class: "share-status", role: "status" }, "");
	const copy = h("button", { type: "button", class: "btn btn-secondary", "aria-label": field.copyLabel }, "Copy");
	copy.addEventListener("click", () => {
		copyWithFallback(field.value, clipboard, input, status);
	});
	return h(
		"div",
		{ class: "share-row" },
		h("label", { class: "share-label", for: inputId }, field.label),
		input,
		copy,
		status,
	);
}

/** Options for the share dialog; the clipboard is optional so a non-secure context still works. */
export interface ShareDialogOptions {
	readonly clipboard?: ClipboardLike | null;
	readonly onClose?: () => void;
}

/** A mounted (or mountable) dialog: the element plus the one way to dismiss it. */
export type ShareDialogHandle = OverlayHandle;

/**
 * Build the share dialog and wire its dismissal and its focus containment.
 *
 * The element is returned rather than mounted, so a test can drive it against a fake document.
 * Escape, the close button, the Done button, and a click on the backdrop all route through the same idempotent `close` — mounting, background inertness, and focus restoration are {@link openShareDialog}'s job.
 * Every string is a text child, never markup.
 */
export function createShareDialog(bundle: ShareBundle, options: ShareDialogOptions = {}): ShareDialogHandle {
	return createOverlay((close) => buildShareDialog(bundle, options.clipboard ?? null, close), { onClose: options.onClose });
}

/**
 * Open the share dialog over the page: build it, mount it on `document.body`, hide the page behind it from assistive tech and pointer/keyboard focus, move focus into it, and on close remove it, un-hide the page, and return focus to whatever had it.
 */
export function openShareDialog(bundle: ShareBundle, options: ShareDialogOptions = {}): ShareDialogHandle {
	return openOverlay((close) => buildShareDialog(bundle, options.clipboard ?? null, close), { onClose: options.onClose });
}

/** The dialog's own element: its content, its labelled close control, and its Done control. */
function buildShareDialog(bundle: ShareBundle, clipboard: ClipboardLike | null, close: () => void): HTMLElement {
	const body = h("div", { class: "dialog-body" });
	renderShareOptions(body, bundle, clipboard);

	const closeButton = h("button", { type: "button", class: "btn-icon dialog-close", "aria-label": "Close" }, "×");
	closeButton.addEventListener("click", close);
	const done = h("button", { type: "button", class: "btn btn-primary" }, "Done");
	done.addEventListener("click", close);

	return h(
		"div",
		{ class: "dialog", role: "dialog", "aria-modal": "true", "aria-label": "Share this invoice" },
		h("div", { class: "dialog-header" }, h("h2", { class: "dialog-title" }, "Share this invoice"), closeButton),
		body,
		h("p", { class: "field-hint" }, "Nothing leaves this page — both options are generated on your device."),
		h("div", { class: "dialog-footer" }, done),
	);
}
