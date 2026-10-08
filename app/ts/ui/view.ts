/**
 * The payer's official invoice view.
 *
 * A decoded invoice is untrusted input, so the whole document is built from `util/dom.ts`'s `h()` with text children only: a hostile payee name, id, or description can never become an element or an attribute.
 * Every display string — the clipped free text, the formatted dates, the money figures, the status label, and the fixed chrome labels — comes from {@link buildInvoiceViewModel} in `ui/presentation.ts`, the shared view model the pdf-lib renderer consumes as well, so the on-screen and exported layouts cannot drift, not even in a column header.
 * No number is trusted from the share string: the view model recomputes the money from the invoice's own line items.
 *
 * The document is a letterhead, the parties and dates, an itemized table, a prominent total-due block, notes/terms, and payment details.
 * The actions around it (back to Create, Share, Save as PDF, Pay) are chrome.
 */

import type { Invoice } from "../invoice/model.js";
import { h } from "../util/dom.js";
import { boundMessage, messageOf } from "../util/errors.js";
import type { NoticeApi } from "./notice.js";
import { buildInvoiceViewModel, type InvoicePartyView } from "./presentation.js";
import { buildShareBundle, openShareDialog, type ClipboardLike } from "./share.js";

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
}

/** Render the official invoice document. The invoice is validated; the DOM is built once, never from markup. */
export function renderInvoiceView(invoice: Invoice, options: ViewOptions): HTMLElement {
	const view = buildInvoiceViewModel(invoice, options.today);

	const letterhead = h(
		"header",
		{ class: "invoice-letterhead" },
		h(
			"div",
			{ class: "letterhead-brand" },
			h("span", { class: "invoice-logo", role: "img", "aria-label": "Invoicing brand mark" }),
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

	const payment = h(
		"footer",
		{ class: "invoice-payment" },
		h("h2", { class: "section-title" }, view.labels.paymentTitle),
		h(
			"dl",
			{ class: "payment-list" },
			...view.payment.map((term) => paymentTerm(term.label, term.value, term.mono === true)),
		),
	);

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

	return h("section", { class: "view view-invoice" }, documentActions(invoice, options), document);
}

/** The actions around the document are chrome; the `no-print` class hides them from the print path in `print.css`, and the exported PDF, drawn from the view model, never reads this DOM. */
function documentActions(invoice: Invoice, options: ViewOptions): HTMLElement {
	const shareButton = h("button", { type: "button", class: "btn btn-secondary" }, "Share");
	shareButton.addEventListener("click", () => {
		openShareDialog(buildShareBundle(invoice, options.baseUrl), { clipboard: options.clipboard ?? null });
	});

	const saveButton = h("button", { type: "button", class: "btn btn-secondary" }, "Save as PDF");
	saveButton.addEventListener("click", () => runAction(() => exportPdf(invoice, options), options, "PDF export"));

	// Pay is present so the layout is complete; it stays disabled — with the reason shown beside it — until the wallet payment flow supplies a handler, so no click can reach an EVM provider before one is wired.
	const pay = options.pay;
	const payNoteId = "pay-unavailable";
	const payButton = h(
		"button",
		{
			type: "button",
			class: "btn btn-primary",
			disabled: pay === undefined,
			"aria-describedby": pay === undefined ? payNoteId : undefined,
		},
		"Pay",
	);
	if (pay !== undefined) {
		payButton.addEventListener("click", () => runAction(() => pay(invoice), options, "Payment"));
	}
	const payNote = pay === undefined
		? h("p", { class: "field-hint", id: payNoteId }, "Available once the wallet flow is connected.")
		: null;

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
		party.email === undefined ? null : h("span", { class: "party-detail" }, party.email),
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

function paymentTerm(label: string, value: string, mono = false): HTMLElement {
	return h(
		"div",
		{ class: "payment-term" },
		h("dt", {}, label),
		h("dd", { class: mono ? "mono" : undefined }, value),
	);
}
