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
 *
 * Opening the dialog is refused in a window another page opened, as the payment panel's own entry is refused: {@link openMarkPaidDialog} states what that refusal holds and what it leaves open.
 */

import { requireAsset, requireAssetFamily, type AssetId } from "../assets/registry.js";
import { PaidInvoiceTooLargeError } from "../invoice/codec.js";
import type { Invoice } from "../invoice/model.js";
import { InvalidPaidRecordError, paidHashForm, validatePaidRecord } from "../invoice/paid.js";
import { h } from "../util/dom.js";
import { boundMessage, reportInternalFailure } from "../util/errors.js";
import { FIELD_MESSAGE_MAX } from "./constants.js";
import { PAYMENT_RECORD_FAILED_MESSAGE, UNVERIFIED_PAYMENT_NOTE } from "./messages.js";
import type { NoticeApi } from "./notice.js";
import { windowHasOpener } from "./opener.js";
import { createOverlay, openOverlay, type OverlayHandle } from "./overlay.js";
import { formatInvoiceDate } from "./presentation.js";
import { NOTHING_TO_RELEASE, releasable, type ReleasableElement } from "./release.js";

/** Hand the canonical hash the payer typed to the surface that builds the paid link. */
export type MarkPaidHandler = (hash: string) => void;

/** Options for the mark-paid dialog: the one egress the confirm hands its canonical hash to, and the optional close report. */
export interface MarkPaidDialogOptions {
	readonly onPaid: MarkPaidHandler;
	/** Called once the dialog has closed, so the surface that opened it can clear the handle it holds. */
	readonly onClose?: () => void;
}

/** Options for opening the dialog over the page: the dialog's own, plus the notice region its opener refusal is reported in. */
export interface OpenMarkPaidDialogOptions extends MarkPaidDialogOptions {
	readonly notice: NoticeApi;
}

/** A mounted (or mountable) mark-paid dialog: the element plus the one way to dismiss it. */
export type MarkPaidDialogHandle = OverlayHandle;

/**
 * The dialog's title and accessible name, stating the record as the payer's report rather than a confirmed payment.
 *
 * The title frames the action as recording what the payer reports, so the dialog's heading and its `aria-label` cannot present the record as a verification the app cannot perform.
 */
export const MARK_PAID_TITLE = "Mark invoice as paid";

/**
 * Shown when the dialog is refused because this window reports an opener.
 *
 * It states what the refusal does — every opener is refused, whichever page that one is — and why: a page from this website could fill this dialog in and record a payment nobody made, and this page cannot tell which website an opener comes from.
 * It names what the check cannot see in the same sentence, because a presence test is the strongest guard a surface inside this document holds and no more: a page that frames this invoice presents no opener, and a frame served from this website shares this document's origin, so no refusal inside the document binds that page — the residual `README.md`'s "Security over features" records as an accepted risk.
 * A payer who arrived from a plain link carries an opener too, so the sentence names every opener rather than telling them their own window is the one hazard.
 */
const OPENED_MESSAGE = "This page was opened by another page, so recording a payment is refused here. A page from this website could fill this dialog in and record a payment nobody made, so every opener is refused; a page that frames this invoice shows no opener, so this check cannot see it. Open the invoice on its own.";

/** The hint beside the hash field, naming the asset family's own spelling from `invoice/paid.ts`'s table so a hint cannot offer a shape the validator refuses. */
export function hashHint(asset: AssetId): string {
	const form = paidHashForm(requireAssetFamily(requireAsset(asset)));
	const prefix = form.prefixes.length === 0 ? " It carries no prefix." : ` It begins with ${form.prefixes.join(" or ")}.`;
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
 * Escape, the close button, the Done button, and a click on the backdrop all route through the same idempotent `close`; mounting, background inertness, and focus restoration are {@link openMarkPaidDialog}'s job, which delegates them to `ui/overlay.ts`.
 * Every string is a text child, never markup.
 */
export function createMarkPaidDialog(invoice: Invoice, today: string, options: MarkPaidDialogOptions): MarkPaidDialogHandle {
	return createOverlay((close) => buildMarkPaidDialog(invoice, today, options, close), { initialFocus: "#mark-paid-hash", onClose: options.onClose });
}

/**
 * Open the mark-paid dialog over the page, or refuse it with a notice when this window reports an opener.
 *
 * The refusal is the payment panel's rule, applied here because this dialog answers to it the same way: nothing in it needs a gesture a page cannot dispatch, so a page from this website that opened this window could fill the field and confirm, and the payer's own document and URL would then be a paid link carrying a hash of that page's choosing — a link the payer may forward with the document's own share control.
 * So the control stays present and the refusal is what the payer reads, as the Pay control does; what the presence test covers, and the best-effort limit it carries, are `ui/opener.ts`'s.
 * A page that frames this invoice is outside that refusal for the reason `ui/opener.ts` states — a frame presents no opener — while a frame served from this website shares this document's origin and can drive the dialog whatever this document refuses, which `README.md`'s "Security over features" records as an accepted risk; the refusal's own sentence says so rather than promising cover it cannot give.
 * Opening mounts the dialog through `ui/overlay.ts`, which owns the backdrop, Escape, the Tab trap, background hiding, and focus restoration, so this module supplies only the dialog's content and close controls.
 */
export function openMarkPaidDialog(invoice: Invoice, today: string, options: OpenMarkPaidDialogOptions): MarkPaidDialogHandle | null {
	if (windowHasOpener()) {
		options.notice.showNotice(OPENED_MESSAGE, "error");
		return null;
	}
	return openOverlay((close) => buildMarkPaidDialog(invoice, today, options, close), { initialFocus: "#mark-paid-hash", onClose: options.onClose });
}

/** The dialog's own element: its hash field, its hint and error, its read-only recorded day, and its confirm and Done controls. */
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
	const hint = h("p", { class: "field-hint", id: hintId }, hashHint(invoice.asset));
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
			error.textContent = PAYMENT_RECORD_FAILED_MESSAGE;
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
			error.textContent = PAYMENT_RECORD_FAILED_MESSAGE;
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

	const closeButton = h("button", { type: "button", class: "btn-icon dialog-close", "aria-label": "Close payment dialog" }, "×");
	closeButton.addEventListener("click", close);
	const done = h("button", { type: "button", class: "btn btn-secondary" }, "Done");
	done.addEventListener("click", close);
	const confirm = h("button", { type: "button", class: "btn btn-primary" }, MARK_PAID_TITLE);
	confirm.addEventListener("click", submit);

	return releasable(
		h(
			"div",
			{ class: "dialog", role: "dialog", "aria-modal": "true", "aria-label": MARK_PAID_TITLE },
			h("div", { class: "dialog-header" }, h("h2", { class: "dialog-title" }, MARK_PAID_TITLE), closeButton),
			h("div", { class: "dialog-body" }, note, form),
			h("div", { class: "dialog-footer" }, done, confirm),
		),
		NOTHING_TO_RELEASE,
	);
}
