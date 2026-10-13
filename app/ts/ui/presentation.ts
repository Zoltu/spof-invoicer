/**
 * The invoice's presentation layer: the domain model derived once into display strings.
 *
 * The on-screen document (`ui/view.ts`) and the pdf-lib renderer both build from this module, so the two layouts cannot drift: the clip caps, the date formatting, the status classification, the chain name, and every money figure are computed here, never re-derived at a render site.
 * The payment link and its QR symbol are computed here for the same reason: the URI is built once through `payment/links.ts`, checked to be a URI the display boundary carries byte for byte, exposed as this module's own named `paymentLink`, and its symbol is encoded from that same value through `util/qr.ts`, so the link a payer reads, the link a payer copies, and the payload a wallet scans are one string rather than two spellings that happen to agree.
 * The amount is read off that same built link — the total it carries, which is the invoice's own recomputed total — for the document's Total due and for the Amount term a payer copies alike, so the figure a wallet is asked for, the figure the document prints, and the figure the clipboard takes are one value rather than two recomputations of the same total kept in step by hope.
 * A link the display boundary would shorten or alter is refused rather than shown clipped: the link builder and the encoder would each refuse the altered text, and the document must never present a payment URI a wallet cannot pay.
 * Each clip cap is the widest legal form of the value it bounds rather than any other budget: the free-text caps are the model's own exported constants, the payee address's is the widest address any of this app's payout-address validators accepts across every family and form, and the network label's is the longest label this app's supported networks spell, so a bound never shortens a value a payer copies out of the document.
 * The payment values a wallet takes verbatim are the exception to the clip: an address or a URI the display boundary cannot carry unchanged is refused rather than displayed, because {@link clip}'s free-text rule annotates what it shortened, and an address a payer copies with `… (N characters)` appended is a payment to a wallet that does not exist.
 * The link is the one payment value whose bound is not a clip cap: its budget is the link layer's own, applied in bytes where the URI is built, and the display boundary re-measures the URI it would show in those same bytes rather than in the UTF-16 code units a clip counts.
 * Each free-text field is also passed through the display strip as it is clipped, and so is every payment-details value derived from the invoice's network or payee, so a hostile invoice cannot carry a code point the validator leaves unrefused — the interlinear-annotation and Egyptian-hieroglyph format ranges, the C1 controls — into the document a payer reads.
 * The network label is the one spelling every payer-facing surface shows, so the document, the payment panel's summary, and the payment flow's guidance cannot describe one network differently; it is declared in `ui/network-labels.ts`, the dependency-free leaf that names every supported network, and this module imports the one label it displays from there without re-exporting any of them, so a surface that only names a network reaches that leaf rather than the module whose import graph carries the link builder and the QR encoder.
 * Nothing in this module touches the DOM or the clock — `today` is an explicit argument — so the whole output is a pure function of the validated {@link Invoice} and the caller's `today`.
 *
 * {@link buildInvoiceViewModel} is the seam both renderers consume.
 * The exported members beside it ({@link money}, {@link formatInvoiceDate}, {@link invoiceStatus}) are the shared primitives the view model is assembled from, while the network label it shows is `ui/network-labels.ts`'s own — imported, not re-exported, so naming a network has one import path; {@link clip} is a helper internal to this module, not part of what it exports.
 */

import { SUPPORTED_CHAIN_IDS } from "../assets/registry.js";
import {
	MAX_DESCRIPTION_CHARS,
	MAX_EMAIL_CHARS,
	MAX_ID_CHARS,
	MAX_INVOICE_NOTES_CHARS,
	MAX_NAME_CHARS,
	MAX_TAX_LABEL_CHARS,
	computeTotals,
	type Amount,
	type Invoice,
} from "../invoice/model.js";
import { MAX_PAYMENT_LINK_BYTES, PaymentLinkError, buildPaymentLink, type PaymentLink } from "../payment/links.js";
import { svgDataUrl, type SvgDataUrl } from "../util/data-url.js";
import { utf8ToBytes } from "../util/encoding.js";
import { boundMessage } from "../util/errors.js";
import { encodeQr, type QrMatrix } from "../util/qr.js";
import { stripDisplayCharacters } from "../util/text.js";
import { MAX_PAYOUT_ADDRESS_LENGTH, type PayoutAddress } from "../wallet/payout-address.js";
import { networkLabel } from "./network-labels.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** How prominently the status reads, so a stylesheet or PDF can color it without parsing the label. */
export type InvoiceStatusTone = "open" | "due" | "overdue";

/** The invoice's payment status as shown in the letterhead. */
export interface InvoiceStatus {
	readonly label: string;
	readonly tone: InvoiceStatusTone;
}

/**
 * Render a `YYYY-MM-DD` date as a deterministic human date, e.g. `3 Oct 2026`.
 *
 * Deliberately table-based rather than `Intl`/`toLocaleDateString`, so the output is identical in every browser and locale and can be asserted exactly.
 * A value that is not a date is returned unchanged, which the model's validation makes unreachable but keeps the helper total.
 */
export function formatInvoiceDate(iso: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (match === null) return iso;
	const month = MONTHS[Number(match[2]) - 1];
	if (month === undefined) return iso;
	return `${Number(match[3])} ${month} ${match[1]}`;
}

/**
 * The invoice's status against `today` (a `YYYY-MM-DD` date).
 * No due date is `Open`; a due date in the past is `Overdue`; otherwise `Payment due`.
 * Dates compare correctly as `YYYY-MM-DD` strings.
 */
export function invoiceStatus(invoice: Invoice, today: string): InvoiceStatus {
	if (invoice.due === undefined) return Object.freeze({ label: "Open", tone: "open" });
	if (/^\d{4}-\d{2}-\d{2}$/.test(today) && today > invoice.due) {
		return Object.freeze({ label: "Overdue", tone: "overdue" });
	}
	return Object.freeze({ label: "Payment due", tone: "due" });
}

/**
 * Clip a free-text field to its model cap and pass it through {@link stripDisplayCharacters}, the same display strip the wallet boundary applies to an announced label.
 *
 * The invoice validator deliberately does not refuse the interlinear-annotation and Egyptian-hieroglyph format ranges, so this is the boundary that keeps those, and any C1 control, out of the rendered document; every displayed invoice text field is clipped here, so a new field inherits the strip unless it is deliberately rendered some other way.
 * The bound runs before the strip, exactly as the wallet boundary bounds an announced label before stripping it, so the pass never sees more than the cap.
 * The payment values a wallet takes verbatim deliberately do not come through here — {@link paymentAddressText} and {@link paymentLinkText} refuse a value the boundary cannot carry unchanged instead of annotating it, and the amount is the model's own ASCII decimal text — while the network label beside them, which no wallet reads as a value, is clipped like any other displayed text.
 * Every call site is inside this module; elsewhere the codebase calls `boundMessage` directly, which is why this is not exported.
 */
function clip(value: string, max: number): string {
	return stripDisplayCharacters(boundMessage(value, max));
}

/**
 * The widest payee address the payment section displays: {@link MAX_PAYOUT_ADDRESS_LENGTH}, the longest address any of this app's payout-address validators accepts.
 *
 * The bound is the display's own: the address the section shows is the one a payer copies into a wallet, so it is drawn from the true maximum across every accepted family and form — an EVM address, a transparent, Sapling, or unified Zcash address, and a Monero standard, subaddress, or integrated one — rather than from one family's validator constant, which an address of another family's longer form would be silently cut against.
 * It is applied fail closed by {@link paymentAddressText} rather than as a clip: the figure is the true maximum, so no address a validator accepts reaches it, and one that ever did — a family growing a longer form, or a validator admitting a code point the display strip removes — is refused outright instead of being displayed, and copied, with the clip's own annotation on it.
 */
const MAX_PAYMENT_ADDRESS_CHARS = MAX_PAYOUT_ADDRESS_LENGTH;

/**
 * The widest network label the payment section displays: the longest {@link networkLabel} this app's supported networks spell.
 *
 * The term shows `networkLabel(chainId)` for a network the model has already held to `SUPPORTED_CHAIN_IDS`, so this derivation covers every label the section can show and the bound never shortens one; the registry always names at least one network, which `DEFAULT_CHAIN_ID`'s own derivation requires.
 */
const MAX_PAYMENT_NETWORK_CHARS = Math.max(...SUPPORTED_CHAIN_IDS.map((chainId) => networkLabel(chainId).length));

/**
 * The invoice's notes split into the lines the view renders one paragraph per.
 * The strip removes line and paragraph separators, so it runs on each line after the split; stripping the whole block instead would collapse the note to one line.
 */
function noteLines(notes: string): readonly string[] {
	return boundMessage(notes, MAX_INVOICE_NOTES_CHARS).split("\n").map((line) => stripDisplayCharacters(line));
}

/** A money figure with the asset's symbol, e.g. `357.000001 USDC`. */
export function money(amount: Amount, symbol: string): string {
	return `${amount.text} ${symbol}`;
}

/**
 * The payment URI as the document shows it: the link's own bytes, or the {@link PaymentLinkError} that says the display boundary could not carry them unchanged and inside the link layer's own byte budget.
 *
 * The displayed term and the QR payload are this one string, so presenting a shortened or stripped URI would hand a payer a link whose copy and whose symbol disagree about what is paid — and the link builder and the encoder would each refuse the altered text the document had already shown.
 * The length is measured in UTF-8 bytes, the unit {@link MAX_PAYMENT_LINK_BYTES} and the encoder's own version selection are stated in, rather than in the UTF-16 code units {@link clip} counts: a bound counted in code units under-counts a URI carrying any code point outside ASCII, which would pass the display boundary and then be refused by the encoder — with the whole payer document rather than the value that provoked it.
 * The link is app-generated from a validated payee address and the invoice's own recomputed total, so the strip and the byte budget both leave it untouched and neither refusal is reachable from a validated invoice.
 * It is checked here rather than assumed, because the display pass does remove code points from other values: a validator or an asset family that one day admitted one into an address would produce a link the document must refuse instead of quietly showing a different one.
 */
function paymentLinkText(link: PaymentLink): string {
	const shown = stripDisplayCharacters(link.uri);
	if (shown !== link.uri || utf8ToBytes(shown).length > MAX_PAYMENT_LINK_BYTES) {
		throw new PaymentLinkError(`the ${link.scheme} link does not survive the display boundary as the ${MAX_PAYMENT_LINK_BYTES}-byte URI it was built as, so the document cannot show, copy, and encode one link`);
	}
	return shown;
}

/**
 * The payee address as the document shows it: the address the URI beside it carries, or the {@link PaymentLinkError} that says the display boundary could not carry it unchanged under {@link MAX_PAYMENT_ADDRESS_CHARS}.
 *
 * This is the fail-closed shape {@link paymentLinkText} applies to the URI, applied to the address for the same reason: the term is a value a wallet takes verbatim, and {@link clip}'s free-text rule would answer a value it could not show whole by returning the value's prefix with `… (N characters)` appended — an address a payer copies as a payment to nowhere, displayed beside a URI that carries the whole of it.
 * The refusal is a payment-value refusal rather than a clip, so it carries the class {@link PaymentLinkError} that names the payment whose display boundary could not be honoured, and a caller that assembles an invoice by hand meets it instead of shipping one.
 * {@link MAX_PAYMENT_ADDRESS_CHARS} is the widest address any of this app's payout validators accepts, so no address a validated invoice can carry reaches the bound or the strip and the refusal is unreachable from one; it is the guard for the day a validator admits a code point the display strip removes, exactly as the link's own re-measurement is.
 */
function paymentAddressText(address: PayoutAddress): string {
	const shown = stripDisplayCharacters(address);
	if (shown !== address || address.length > MAX_PAYMENT_ADDRESS_CHARS) {
		throw new PaymentLinkError(`the payee address does not survive the display boundary as the ${MAX_PAYMENT_ADDRESS_CHARS}-character address the payment link carries, so the document cannot show the payee whose URI it prints`);
	}
	return shown;
}

/** One party line: the role label, the name, and the email that party carries. */
export interface InvoicePartyView {
	readonly role: string;
	readonly name: string;
	readonly email?: string;
}

/** A labelled document date, already rendered to its human spelling. */
export interface InvoiceDateView {
	readonly label: string;
	readonly value: string;
}

/** One itemized line with its amount, already rendered with the asset's symbol. */
export interface InvoiceLineView {
	readonly description: string;
	readonly quantity: string;
	readonly unitPrice: string;
	readonly amount: string;
}

/** The tax row, already rendered, when the invoice carries one. */
export interface InvoiceTaxView {
	readonly label: string;
	readonly value: string;
}

/**
 * One payment-details term; `verbatim` is the single statement that its value is one a wallet takes verbatim — the amount, the payee address, or the link.
 *
 * Every surface that serves that one concept reads this one flag, so they cannot key on different ones: the on-screen document draws such a term in a single-line field with an exact-copy control, the print path draws the same string whole in the field's place, and the PDF draws it as one unbroken monospace run rather than wrapping it.
 * Two independent flags would let a term be an exact-copy field on screen and a wrapped sans run in the PDF, which is exactly the drift a single statement rules out.
 */
export interface InvoicePaymentTermView {
	readonly label: string;
	readonly value: string;
	readonly verbatim?: boolean;
}

/**
 * The document's fixed chrome text: the letterhead's wordmark, tagline and kind, the item table's column headers, the totals labels, the section titles, the dates block's role, and the payment details' terms.
 * Both renderers read these, so a label the on-screen view and the PDF both draw has a single spelling — the party roles beside them stay the domain's own words on the view model — and one of them cannot be reworded without the other.
 * The payment details' terms are labelled from here too, and the section's own amount term reads the same {@link InvoiceLabels.amount} the item table's column header does: the figure a payer copies and the column it was computed from are worded once, so the section cannot be reworded apart from the table it summarizes.
 * The on-screen view uppercases the tagline, the kind, the status badge, the role labels, the date labels, the column headers, the section titles, and the payment-term labels in CSS; the PDF uppercases the same eight groups at draw time, so neither renderer hardcodes a second spelling.
 */
export interface InvoiceLabels {
	readonly brand: string;
	readonly tagline: string;
	readonly kind: string;
	readonly description: string;
	readonly quantity: string;
	readonly unitPrice: string;
	readonly amount: string;
	readonly subtotal: string;
	readonly totalDue: string;
	readonly notesTitle: string;
	readonly paymentTitle: string;
	readonly asset: string;
	readonly network: string;
	readonly paysTo: string;
	readonly paymentLink: string;
	readonly dates: string;
}

/**
 * Everything both renderers show, as display strings — the document reduced to what gets drawn — plus the payment URI by name and the symbol of it.
 *
 * {@link InvoiceViewModel.paymentLink} is the one statement of the URI as the document displays it — the ecosystem link itself, since a link the display boundary would alter is refused rather than shown — so a link consumer reads it by name rather than out of the term list: the `Payment link` term {@link InvoiceViewModel.payment} ends with displays that same named value, {@link InvoiceViewModel.paymentQr} is that same value's modules, and inserting or reordering a payment term cannot change what such a consumer reads.
 * {@link InvoiceViewModel.total} and the `Amount` term in {@link InvoiceViewModel.payment} are both the amount the built link carries, so the document's own figure and the value a payer copies are one reading of the link rather than two spellings of a recomputed total.
 */
export interface InvoiceViewModel {
	readonly assetName: string;
	readonly symbol: string;
	readonly iconDataUrl: SvgDataUrl | null;
	readonly documentNumber: string;
	readonly status: InvoiceStatus;
	readonly from: InvoicePartyView;
	readonly billTo: InvoicePartyView | null;
	readonly dates: readonly InvoiceDateView[];
	readonly lines: readonly InvoiceLineView[];
	readonly subtotal: string;
	readonly tax: InvoiceTaxView | null;
	readonly total: string;
	readonly notes: readonly string[] | null;
	readonly paymentLink: string;
	readonly payment: readonly InvoicePaymentTermView[];
	readonly paymentQr: QrMatrix;
	readonly labels: InvoiceLabels;
}

/** The one spelling of every fixed document label, shared by the on-screen view and the PDF. */
export const INVOICE_LABELS: InvoiceLabels = Object.freeze({
	brand: "Invoicing",
	tagline: "On-chain payment invoice",
	kind: "Invoice",
	description: "Description",
	quantity: "Qty",
	unitPrice: "Unit price",
	amount: "Amount",
	subtotal: "Subtotal",
	totalDue: "Total due",
	notesTitle: "Notes and terms",
	paymentTitle: "Payment details",
	asset: "Asset",
	network: "Network",
	paysTo: "Pays to",
	paymentLink: "Payment link",
	dates: "Dates",
});

/**
 * Derive the display strings for a validated invoice against `today`.
 *
 * Every money figure comes from the invoice's own line items — {@link computeTotals} recomputes them, never a transported total — and every free-text field is clipped to its model cap here, so a hostile payee name or description cannot stretch a cell past readability.
 * The total the document draws and the Amount term a payer copies are the one amount the built link carries — `payment/links.ts`'s {@link PaymentLink.amount}, whose decimal text is the bare decimal a wallet's amount field takes, with no ticker — so the figure a wallet is asked for, the figure printed beside it, and the figure copied out of it are one value rather than two recomputations that happen to agree today.
 * The payment terms' network label is clipped like the free-text fields, under the longest label this app's networks spell, while the payee address and the URI are held fail closed instead: the address under {@link MAX_PAYMENT_ADDRESS_CHARS} and the URI under the link layer's own byte budget, so a value that cannot be shown whole is a refused build rather than a displayed prefix with the clip's annotation on it.
 * The payee term draws the address the link itself carries — the payout-address dispatcher's own return, which `payment/links.ts` exposes as the built link's `payee` — rather than the invoice's raw field, so an `Invoice` a caller assembled by hand cannot display one spelling of a payee beside a URI that encodes another.
 * The amount, the address, and the link terms carry `verbatim`, the one thing that marks a value a wallet takes verbatim: the on-screen view draws each of those in a single-line field with a copy control, so the value a payer clicks to copy is the same string the URI and the symbol carry rather than whatever their text selection spanned, and the print path and the PDF draw the same string whole rather than the field's own clipped overflow.
 * The payment link is built once, checked to survive that boundary unchanged, exposed by name, and its symbol is encoded from that one value, so the view model's own {@link InvoiceViewModel.paymentLink}, the term that displays it, and the encoded payload are one string rather than three spellings that happen to agree: a legal invoice's link always fits the encoder's widest symbol, so the two throws those boundaries can raise (`PaymentLinkError`, `RangeError`) are unreachable from a validated invoice and surface only for one a caller assembled by hand.
 * The optional icon is armed here, once: the value is the icon leaf's own data URL, which is the type every image sink accepts, so the on-screen document and the PDF read one prepared value rather than each building a URL of its own.
 * The result is frozen; a renderer reads it and draws, it does not re-derive.
 */
export function buildInvoiceViewModel(invoice: Invoice, today: string): InvoiceViewModel {
	const totals = computeTotals(invoice);
	const asset = totals.asset;
	const symbol = asset.symbol;
	const notes = invoice.notes === undefined ? null : noteLines(invoice.notes);
	const link = buildPaymentLink(invoice);
	// The amount the link was built from, read for the printed total and the copied Amount term alike, so the figure the URI asks for and the figure the document shows are one value.
	const amount = link.amount;
	// One value for the named field, the displayed term, and the QR payload alike, so the link a payer reads and the symbol a wallet scans cannot drift apart.
	const paymentLink = paymentLinkText(link);
	return Object.freeze({
		assetName: asset.name,
		symbol,
		iconDataUrl: invoice.icon === undefined ? null : svgDataUrl(invoice.icon),
		documentNumber: `#${clip(invoice.id, MAX_ID_CHARS)}`,
		status: invoiceStatus(invoice, today),
		from: Object.freeze({
			role: "From",
			name: clip(invoice.payee.name, MAX_NAME_CHARS),
			...(invoice.payee.email === undefined ? {} : { email: clip(invoice.payee.email, MAX_EMAIL_CHARS) }),
		}),
		billTo: invoice.payer === undefined ? null : Object.freeze({
			role: "Bill to",
			name: clip(invoice.payer.name, MAX_NAME_CHARS),
			...(invoice.payer.email === undefined ? {} : { email: clip(invoice.payer.email, MAX_EMAIL_CHARS) }),
		}),
		dates: Object.freeze([
			Object.freeze({ label: "Issued", value: formatInvoiceDate(invoice.issued) }),
			...(invoice.due === undefined ? [] : [Object.freeze({ label: "Due", value: formatInvoiceDate(invoice.due) })]),
		]),
		lines: Object.freeze(
			totals.lines.map((line) =>
				Object.freeze({
					description: clip(line.item.description, MAX_DESCRIPTION_CHARS),
					quantity: line.item.quantity,
					unitPrice: `${line.item.unitPrice} ${symbol}`,
					amount: money(line.amount, symbol),
				}),
			),
		),
		subtotal: money(totals.subtotal, symbol),
		tax: invoice.tax === undefined
			? null
			: Object.freeze({ label: clip(invoice.tax.label, MAX_TAX_LABEL_CHARS), value: money(totals.tax, symbol) }),
		total: money(amount, symbol),
		notes: notes === null ? null : Object.freeze(notes),
		paymentLink,
		payment: Object.freeze([
			Object.freeze({ label: INVOICE_LABELS.asset, value: `${asset.name} (${asset.symbol})` }),
			Object.freeze({ label: INVOICE_LABELS.network, value: clip(networkLabel(invoice.chainId), MAX_PAYMENT_NETWORK_CHARS) }),
			Object.freeze({ label: INVOICE_LABELS.paysTo, value: paymentAddressText(link.payee), verbatim: true }),
			Object.freeze({ label: INVOICE_LABELS.amount, value: amount.text, verbatim: true }),
			Object.freeze({ label: INVOICE_LABELS.paymentLink, value: paymentLink, verbatim: true }),
		]),
		paymentQr: encodeQr(paymentLink),
		labels: INVOICE_LABELS,
	});
}
