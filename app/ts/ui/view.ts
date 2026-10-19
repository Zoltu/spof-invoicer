/**
 * The payer's official invoice view.
 *
 * A decoded invoice is untrusted input, so the whole document is built from `util/dom.ts`'s `h()` with text children only: a hostile payee name, id, or description can never become an element or an attribute.
 * Every display string — the clipped free text, the formatted dates, the money figures, the status label, and the fixed chrome labels — comes from {@link buildInvoiceViewModel} in `ui/presentation.ts`, the shared view model the pdf-lib renderer consumes as well, so the on-screen and exported layouts cannot drift, not even in a column header.
 * No number is trusted from the share string: the view model recomputes the money from the invoice's own line items.
 *
 * The document is a letterhead, the parties and dates, an itemized table, a prominent total-due block, notes/terms, and payment details.
 * The letterhead's mark is the payee's own icon when the invoice carries one, in the place of the default brand mark rather than beside it, while the wordmark and tagline are drawn either way; a party's contact info is drawn as the lines it was stored with, one detail line per line.
 * Payment details is {@link renderPaymentSection}, the section `ui/payment-section.ts` owns and the payee's create screen draws from the same function: the payee address, the amount, and the payment link, each a plain-text value with its own copy control, beside the symbol of that same URI.
 * The actions around it (back to Create, Share, Save as PDF, Pay) are chrome, and the Pay control is the injected-wallet flow's alone: a Zcash or Monero invoice is paid by the payment link and QR code the document carries, so it is offered no control that would lead nowhere.
 */

import { requireAsset } from "../assets/registry.js";
import type { Invoice } from "../invoice/model.js";
import { h } from "../util/dom.js";
import { boundMessage, messageOf } from "../util/errors.js";
import { isWalletPayable } from "../wallet/payment.js";
import type { ClipboardLike } from "./clipboard.js";
import type { LayoutProbe } from "./fit-value.js";
import { UNSUPPORTED_WALLET_MESSAGE } from "./messages.js";
import type { NoticeApi } from "./notice.js";
import { renderPaymentSection } from "./payment-section.js";
import { buildInvoiceViewModel, type InvoicePartyView } from "./presentation.js";
import { releasable, type ReleasableElement } from "./release.js";
import { buildShareBundle, openShareDialog } from "./share.js";

/** The most of an action failure's rendered length the view carries into its notice. */
const ACTION_ERROR_MAX = 300;

/** Hand a validated invoice to the pdf-lib renderer when one is supplied; may complete asynchronously. */
export type ExportPdfHandler = (invoice: Invoice) => void | Promise<void>;

/** Hand a validated invoice to the wallet payment flow when one is supplied; may be asynchronous. */
export type PayHandler = (invoice: Invoice) => void | Promise<void>;

/** Everything the invoice view needs to render and to wire its actions. */
export interface ViewOptions {
	readonly notice: NoticeApi;
	readonly baseUrl: string;
	readonly today: string;
	readonly clipboard?: ClipboardLike | null;
	readonly exportPdf?: ExportPdfHandler;
	readonly pay?: PayHandler;
	/**
	 * The probe the document's fitted values measure through, or `null` to fit nothing and leave each value at the rung its stylesheet states; an absent option fits nothing for the same reason. The composition root supplies the browser's own probe.
	 */
	readonly fit?: LayoutProbe | null;
}

/**
 * Render the official invoice document. The invoice is validated; the DOM is built once, never from markup.
 *
 * The element it returns carries the release of everything the document subscribed to — the payment section's fitting — so the surface that drops the document has that release in hand without being handed it separately (`ui/release.ts`).
 */
export function renderInvoiceView(invoice: Invoice, options: ViewOptions): ReleasableElement {
	const view = buildInvoiceViewModel(invoice, options.today);

	// A supplied icon replaces the default brand mark rather than accompanying it, so the letterhead draws exactly one of the two; the icon is the leaf's data URL in an image context, never the document's markup.
	const letterheadMark = view.iconDataUrl === null
		? h("span", { class: "invoice-logo", role: "img", "aria-label": "Invoicing brand mark" })
		: h("img", { class: "letterhead-icon", src: view.iconDataUrl, alt: "" });
	const letterhead = h(
		"header",
		{ class: "invoice-letterhead" },
		h(
			"div",
			{ class: "letterhead-brand" },
			letterheadMark,
			h(
				"div",
				{ class: "letterhead-name" },
				h("span", { class: "letterhead-title" }, view.labels.brand),
				h("span", { class: "letterhead-tagline" }, view.labels.tagline),
			),
		),
		h(
			"div",
			{ class: "letterhead-meta" },
			h("h1", { class: "document-kind" }, view.labels.kind),
			h("span", { class: "document-number" }, view.documentNumber),
			h("span", { class: `status-badge status-${view.status.tone}` }, view.status.label),
		),
	);

	const parties = h(
		"section",
		{ class: "invoice-parties" },
		partyBlock(view.from, "party-payee"),
		view.billTo === null ? null : partyBlock(view.billTo, "party-payer"),
		h(
			"div",
			{ class: "party party-dates" },
			h("span", { class: "party-role" }, view.labels.dates),
			...view.dates.map((date) => metaField(date.label, date.value)),
		),
	);

	const itemsTable = h(
		"table",
		{ class: "invoice-items" },
		h(
			"thead",
			{},
			h(
				"tr",
				{},
				h("th", { scope: "col", class: "col-description" }, view.labels.description),
				h("th", { scope: "col", class: "col-qty num" }, view.labels.quantity),
				h("th", { scope: "col", class: "col-price num" }, view.labels.unitPrice),
				h("th", { scope: "col", class: "col-amount num" }, view.labels.amount),
			),
		),
		h(
			"tbody",
			{},
			...view.lines.map((line) =>
				h(
					"tr",
					{ class: "invoice-item-row" },
					h("td", { class: "item-description" }, line.description),
					h("td", { class: "item-qty num" }, line.quantity),
					h("td", { class: "item-price num" }, line.unitPrice),
					h("td", { class: "item-amount num" }, line.amount),
				),
			),
		),
	);

	const totalRows = [
		h(
			"tr",
			{ class: "totals-row" },
			h("th", { scope: "row" }, view.labels.subtotal),
			h("td", { class: "num" }, view.subtotal),
		),
	];
	if (view.tax !== null) {
		totalRows.push(
			h(
				"tr",
				{ class: "totals-row" },
				h("th", { scope: "row" }, view.tax.label),
				h("td", { class: "num" }, view.tax.value),
			),
		);
	}
	const totalsBlock = h(
		"section",
		{ class: "invoice-totals" },
		h(
			"table",
			{ class: "totals-table" },
			h(
				"tbody",
				{},
				...totalRows,
				h(
					"tr",
					{ class: "totals-due" },
					h("th", { scope: "row" }, view.labels.totalDue),
					h("td", { class: "num" }, view.total),
				),
			),
		),
	);

	const notes = view.notes === null
		? null
		: h(
				"section",
				{ class: "invoice-notes" },
				h("h2", { class: "section-title" }, view.labels.notesTitle),
				...view.notes.map((line) => h("p", { class: "note-line" }, line)),
			);

	// The section's fitting is a subscription rather than something that ends by itself, so the document this returns carries its release, and releases it here when the render throws: neither a dropped document nor a failed one leaves an observer behind.
	const payment = renderPaymentSection(view, { clipboard: options.clipboard ?? null, fit: options.fit ?? null });
	try {
		// The item table can overflow a phone; making its scroll box a named, focusable region lets a keyboard-only user reach the clipped columns, which Safari's scroller auto-focus does not.
		const document = h(
			"article",
			{ class: "invoice-document" },
			letterhead,
			parties,
			h(
				"div",
				{ class: "invoice-items-scroll", role: "region", "aria-label": "Line items", tabindex: "0" },
				itemsTable,
			),
			totalsBlock,
			notes,
			payment,
		);

		const rendered = h("section", { class: "view view-invoice" }, documentActions(invoice, options), document);
		return releasable(rendered, payment.release);
	} catch (error) {
		payment.release();
		throw error;
	}
}

/**
 * The actions around the document are chrome; the `no-print` class hides them from the print path in `print.css`, and the exported PDF, drawn from the view model, never reads this DOM.
 *
 * Pay is the injected-wallet flow, which only the EVM family pays through: on an EVM invoice it is present so the layout is complete and stays disabled — with the reason shown beside it — until a handler is wired, so no click can reach an EVM provider before one exists, while a privacy-chain invoice is offered a hint naming the hand-off it does carry instead of a control that would lead nowhere.
 */
function documentActions(invoice: Invoice, options: ViewOptions): HTMLElement {
	const shareButton = h("button", { type: "button", class: "btn btn-secondary" }, "Share");
	shareButton.addEventListener("click", () => {
		openShareDialog(buildShareBundle(invoice, options.baseUrl), { clipboard: options.clipboard ?? null });
	});

	const saveButton = h("button", { type: "button", class: "btn btn-secondary" }, "Save as PDF");
	saveButton.addEventListener("click", () => runAction(() => exportPdf(invoice, options), options, "PDF export"));

	// The Pay control is offered only for the invoices the wallet planner can pay: `isWalletPayable` is the same predicate `buildPaymentPlan` enforces, so the control this view offers and the flow behind it cannot disagree.
	const walletPayable = isWalletPayable(requireAsset(invoice.asset));
	const pay = walletPayable ? options.pay : undefined;
	const payNoteId = "pay-unavailable";
	const payButton = walletPayable
		? h(
				"button",
				{
					type: "button",
					class: "btn btn-primary",
					disabled: pay === undefined,
					"aria-describedby": pay === undefined ? payNoteId : undefined,
				},
				"Pay",
			)
		: null;
	if (payButton !== null && pay !== undefined) {
		payButton.addEventListener("click", () => runAction(() => pay(invoice), options, "Payment"));
	}
	const payNote = walletPayNote(walletPayable, pay, payNoteId);

	return h(
		"div",
		{ class: "document-actions no-print" },
		h("a", { class: "btn btn-secondary", href: "#/create" }, "← New invoice"),
		h("div", { class: "document-actions-spacer" }),
		shareButton,
		saveButton,
		payButton,
		payNote,
	);
}

/**
 * The text beside the Pay control: the family's own hand-off, or the reason the wallet flow's control is not wired yet.
 *
 * The hand-off sentence is `ui/messages.ts`'s — the one the payment panel's own refusal shows — read from there rather than spelled again, so the hint the payer sees and the notice a panel opened for the same invoice would show cannot describe the payment differently, and this document renderer depends on no wallet-panel module for its own display text.
 */
function walletPayNote(walletPayable: boolean, pay: PayHandler | undefined, noteId: string): HTMLElement | null {
	if (!walletPayable) {
		return h("p", { class: "field-hint" }, UNSUPPORTED_WALLET_MESSAGE);
	}
	if (pay === undefined) {
		return h("p", { class: "field-hint", id: noteId }, "Available once the wallet flow is connected.");
	}
	return null;
}

/**
 * Run an action handler, routing a synchronous throw or an async rejection to the notice instead of letting it escape the click listener.
 * The handler is invoked synchronously, so a wired handler has run by the time the click dispatch returns; only its failure is deferred.
 */
function runAction(run: () => void | Promise<void>, options: ViewOptions, label: string): void {
	void (async () => {
		try {
			await run();
		} catch (error) {
			options.notice.showNotice(boundMessage(`${label} failed: ${messageOf(error)}`, ACTION_ERROR_MAX), "error");
		}
	})();
}

/** The PDF export seam: hand the invoice to the renderer, or say it is not wired in this build. */
function exportPdf(invoice: Invoice, options: ViewOptions): void | Promise<void> {
	if (options.exportPdf === undefined) {
		options.notice.showNotice("PDF export is not available in this build.", "info");
		return;
	}
	return options.exportPdf(invoice);
}

function partyBlock(party: InvoicePartyView, extraClass: string): HTMLElement {
	return h(
		"div",
		{ class: `party ${extraClass}` },
		h("span", { class: "party-role" }, party.role),
		h("span", { class: "party-name" }, party.name),
		...(party.email === undefined ? [] : party.email.map((line) => h("span", { class: "party-detail" }, line))),
	);
}

function metaField(label: string, value: string): HTMLElement {
	return h(
		"span",
		{ class: "meta-field" },
		h("span", { class: "meta-label" }, label),
		h("span", { class: "meta-value" }, value),
	);
}
