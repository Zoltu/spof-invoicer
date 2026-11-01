/**
 * The payer's manual record of a payment: one dialog for typing the transaction hash a wallet's receipt shows or a block explorer gave, so the payer can hand the invoice back with a record attached even when the wallet flow cannot be reached.
 *
 * The dialog is the manual path's whole surface: one labelled input for the hash, a hint naming the asset family's own hash shape from `invoice/paid.ts`, the recorded day read-only from the caller's `today`, and one confirm that hands the canonical hash to the injected `onPaid` egress and closes.
 * It reads no clock, navigates nowhere, and encodes nothing: the egress builds the paid link and the shell owns the navigation.
 * Validation is `invoice/paid.ts`'s, so a malformed hash is refused with the family's own shape and the clause is bounded and stripped beside the field; the over-budget refusal `invoice/codec.ts` raises when the paid encoding will not fit is shown as the actionable sentence it carries, never as a silent failure.
 * A refusal is stated beside the field rather than in the notice region, because the hash is what the payer changes.
 * The wording follows `docs/design/payment-safety-memo.md`'s constraint: nothing in this app can confirm a payment, so the dialog states the record as the payer's report and repeats the unverified note `ui/messages.ts` owns.
 *
 * The modal mechanics — backdrop, Escape, the Tab trap, background hiding, and focus restoration — are `ui/overlay.ts`'s, exactly as the share dialog's are.
 * This module supplies the dialog's content and its close controls, and it subscribes to nothing, so it states `NOTHING_TO_RELEASE` (`ui/release.ts`).
 */

import { requireAsset, requireAssetFamily } from "../assets/registry.js";
import { PaidInvoiceTooLargeError } from "../invoice/codec.js";
import type { Invoice } from "../invoice/model.js";
import { InvalidPaidRecordError, paidHashForm, validatePaidRecord } from "../invoice/paid.js";
import { h } from "../util/dom.js";
import { boundMessage, reportInternalFailure } from "../util/errors.js";
import { UNVERIFIED_PAYMENT_NOTE } from "./messages.js";
import { createOverlay, openOverlay, type OverlayHandle } from "./overlay.js";
import { formatInvoiceDate } from "./presentation.js";
import { NOTHING_TO_RELEASE, releasable, type ReleasableElement } from "./release.js";

/** Hand the canonical hash the payer typed to the surface that builds the paid link. */
export type MarkPaidHandler = (hash: string) => void;

/** Options for the mark-paid dialog: the one egress the confirm hands its canonical hash to. */
export interface MarkPaidDialogOptions {
	readonly onPaid: MarkPaidHandler;
}

/** A mounted (or mountable) mark-paid dialog: the element plus the one way to dismiss it. */
export type MarkPaidDialogHandle = OverlayHandle;

/** The longest field message this dialog shows, matching the bound the create form's fields use. */
const FIELD_MESSAGE_MAX = 300;

/** The dialog's title, matching the action row's wording. */
const MARK_PAID_TITLE = "Mark this invoice paid";

/** The hint beside the hash field, naming the asset family's own spelling from `invoice/paid.ts`'s table so a hint cannot offer a shape the validator refuses. */
function hashHint(invoice: Invoice): string {
	const form = paidHashForm(requireAssetFamily(requireAsset(invoice.asset)));
	const prefix = form.prefixes.length === 0
		? " It carries no prefix."
		: ` It begins with ${form.prefixes.join(" or ")}.`;
	return `Enter the ${form.characters}-character ${form.name}.${prefix}`;
}

/** The label over the hash field, naming the family's own value from the same table the hint reads. */
function hashLabel(invoice: Invoice): string {
	const name = paidHashForm(requireAssetFamily(requireAsset(invoice.asset))).name;
	return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Build the mark-paid dialog and wire its dismissal and its focus containment.
 *
 * The element is returned rather than mounted, so a test can drive it against a fake document.
 * Escape, the close button, the cancel button, and a click on the backdrop all route through the same idempotent `close` — mounting, background inertness, and focus restoration are {@link openMarkPaidDialog}'s job.
 * Every string is a text child, never markup.
 */
export function createMarkPaidDialog(invoice: Invoice, today: string, options: MarkPaidDialogOptions): MarkPaidDialogHandle {
	return createOverlay((close) => buildMarkPaidDialog(invoice, today, options, close), { initialFocus: "#mark-paid-hash" });
}

/**
 * Open the mark-paid dialog over the page: build it, mount it on `document.body`, hide the page behind it from assistive tech and pointer/keyboard focus, move focus into the hash field, and on close remove it, un-hide the page, and return focus to whatever had it.
 */
export function openMarkPaidDialog(invoice: Invoice, today: string, options: MarkPaidDialogOptions): MarkPaidDialogHandle {
	return openOverlay((close) => buildMarkPaidDialog(invoice, today, options, close), { initialFocus: "#mark-paid-hash" });
}

/** The dialog's own element: its hash field, its hint and error, its read-only recorded day, and its confirm and cancel controls. */
function buildMarkPaidDialog(invoice: Invoice, today: string, options: MarkPaidDialogOptions, close: () => void): ReleasableElement {
	const inputId = "mark-paid-hash";
	const hintId = "mark-paid-hash-hint";
	const errorId = "mark-paid-hash-error";
	const input = h("input", {
		type: "text",
		id: inputId,
		name: "hash",
		class: "mark-paid-input",
		"aria-describedby": `${hintId} ${errorId}`,
	});
	const hint = h("p", { class: "field-hint", id: hintId }, hashHint(invoice));
	const error = h("p", { class: "field-error", id: errorId, role: "alert", hidden: "" }, "");
	const recorded = h("p", { class: "field-hint" }, `Recorded ${formatInvoiceDate(today)}.`);
	const note = h("p", { class: "field-hint" }, UNVERIFIED_PAYMENT_NOTE);

	const submit = (): void => {
		let canonical: string;
		try {
			const record = validatePaidRecord({ hash: input.value.trim(), date: today }, requireAssetFamily(requireAsset(invoice.asset)));
			canonical = record.hash;
		} catch (failure) {
			if (failure instanceof InvalidPaidRecordError) {
				error.textContent = boundMessage(failure.reason, FIELD_MESSAGE_MAX);
				error.removeAttribute("hidden");
				return;
			}
			reportInternalFailure("mark-paid dialog validation", failure);
			error.textContent = "The payment could not be recorded. Reload the page and try again.";
			error.removeAttribute("hidden");
			return;
		}
		error.setAttribute("hidden", "");
		error.textContent = "";
		try {
			options.onPaid(canonical);
		} catch (failure) {
			// The over-budget refusal carries the sentence the payer can act on, so it is shown as the validator worded it rather than replaced by a generic sentence.
			if (failure instanceof PaidInvoiceTooLargeError) {
				error.textContent = boundMessage(failure.message, FIELD_MESSAGE_MAX);
				error.removeAttribute("hidden");
				return;
			}
			reportInternalFailure("mark-paid dialog egress", failure);
			error.textContent = "The payment could not be recorded. Reload the page and try again.";
			error.removeAttribute("hidden");
			return;
		}
		close();
	};

	const form = h(
		"form",
		{ id: "mark-paid-form", class: "mark-paid-form" },
		h("label", { class: "field-label", for: inputId }, hashLabel(invoice)),
		input,
		hint,
		error,
		recorded,
	);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		submit();
	});

	const closeButton = h("button", { type: "button", class: "btn-icon dialog-close", "aria-label": "Close" }, "×");
	closeButton.addEventListener("click", close);
	const cancel = h("button", { type: "button", class: "btn btn-secondary" }, "Cancel");
	cancel.addEventListener("click", close);
	const confirm = h("button", { type: "button", class: "btn btn-primary" }, "Mark as paid");
	confirm.addEventListener("click", submit);

	return releasable(
		h(
			"div",
			{ class: "dialog", role: "dialog", "aria-modal": "true", "aria-label": MARK_PAID_TITLE },
			h("div", { class: "dialog-header" }, h("h2", { class: "dialog-title" }, MARK_PAID_TITLE), closeButton),
			h("div", { class: "dialog-body" }, note, form),
			h("div", { class: "dialog-footer" }, cancel, confirm),
		),
		NOTHING_TO_RELEASE,
	);
}
