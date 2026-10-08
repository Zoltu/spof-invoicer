/**
 * The invoice's presentation layer: the domain model derived once into display strings.
 *
 * The on-screen document (`ui/view.ts`) and the pdf-lib renderer both build from this module, so the two layouts cannot drift: the clip caps, the date formatting, the status classification, the chain name, and every money figure are computed here, never re-derived at a render site.
 * The clip caps are the model's own exported constants, so a cap can only be changed in one place.
 * Each free-text field is also passed through the display strip as it is clipped, so a hostile invoice cannot carry a code point the validator leaves unrefused — the interlinear-annotation and Egyptian-hieroglyph format ranges, the C1 controls — into the document a payer reads.
 * Nothing in this module touches the DOM or the clock — `today` is an explicit argument — so the whole output is a pure function of the validated {@link Invoice} and the caller's `today`.
 *
 * {@link buildInvoiceViewModel} is the seam the PDF renderer consumes.
 * The exported members beside it ({@link CHAIN_NAMES}, {@link money}, {@link chainName}, {@link formatInvoiceDate}, {@link invoiceStatus}) are the shared primitives the view model is assembled from; {@link clip} is a helper internal to this module, not part of what it exports.
 */
import { MAX_DESCRIPTION_CHARS, MAX_EMAIL_CHARS, MAX_ID_CHARS, MAX_INVOICE_NOTES_CHARS, MAX_NAME_CHARS, MAX_TAX_LABEL_CHARS, computeTotals, } from "../invoice/model.js";
import { boundMessage } from "../util/errors.js";
import { stripDisplayCharacters } from "../util/text.js";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The friendly name of each supported chain, keyed by its canonical lower-case id; every chain the registry supports must have an entry so it never renders as its raw id. */
export const CHAIN_NAMES = Object.freeze({ "0x1": "Ethereum" });
/**
 * Render a `YYYY-MM-DD` date as a deterministic human date, e.g. `3 Oct 2026`.
 *
 * Deliberately table-based rather than `Intl`/`toLocaleDateString`, so the output is identical in every browser and locale and can be asserted exactly.
 * A value that is not a date is returned unchanged, which the model's validation makes unreachable but keeps the helper total.
 */
export function formatInvoiceDate(iso) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (match === null)
        return iso;
    const month = MONTHS[Number(match[2]) - 1];
    if (month === undefined)
        return iso;
    return `${Number(match[3])} ${month} ${match[1]}`;
}
/**
 * The invoice's status against `today` (a `YYYY-MM-DD` date).
 * No due date is `Open`; a due date in the past is `Overdue`; otherwise `Payment due`.
 * Dates compare correctly as `YYYY-MM-DD` strings.
 */
export function invoiceStatus(invoice, today) {
    if (invoice.due === undefined)
        return Object.freeze({ label: "Open", tone: "open" });
    if (/^\d{4}-\d{2}-\d{2}$/.test(today) && today > invoice.due) {
        return Object.freeze({ label: "Overdue", tone: "overdue" });
    }
    return Object.freeze({ label: "Payment due", tone: "due" });
}
/**
 * The human name of a chain, falling back to its id for one the display map does not name.
 * Only an own property is read, so a chain id that collides with an inherited `Object.prototype` member still falls back to the raw id.
 */
export function chainName(chainId) {
    return Object.hasOwn(CHAIN_NAMES, chainId) ? CHAIN_NAMES[chainId] : chainId;
}
/**
 * Clip a free-text field to its model cap and pass it through {@link stripDisplayCharacters}, the same display strip the wallet boundary applies to an announced label.
 *
 * The invoice validator deliberately does not refuse the interlinear-annotation and Egyptian-hieroglyph format ranges, so this is the boundary that keeps those, and any C1 control, out of the rendered document; every displayed invoice text field is clipped here, so a new field inherits the strip unless it is deliberately rendered some other way.
 * The bound runs before the strip, exactly as the wallet boundary bounds an announced label before stripping it, so the pass never sees more than the cap.
 * Every call site is inside this module; elsewhere the codebase calls `boundMessage` directly, which is why this is not exported.
 */
function clip(value, max) {
    return stripDisplayCharacters(boundMessage(value, max));
}
/**
 * The invoice's notes split into the lines the view renders one paragraph per.
 * The strip removes line and paragraph separators, so it runs on each line after the split; stripping the whole block instead would collapse the note to one line.
 */
function noteLines(notes) {
    return boundMessage(notes, MAX_INVOICE_NOTES_CHARS).split("\n").map((line) => stripDisplayCharacters(line));
}
/** A money figure with the asset's symbol, e.g. `357.000001 USDC`. */
export function money(amount, symbol) {
    return `${amount.text} ${symbol}`;
}
/** The one spelling of every fixed document label, shared by the on-screen view and the PDF. */
export const INVOICE_LABELS = Object.freeze({
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
    dates: "Dates",
});
/**
 * Derive the display strings for a validated invoice against `today`.
 *
 * Every figure comes from {@link computeTotals}, which recomputes the money from the invoice's own line items — never from a transported total — and every free-text field is clipped to its model cap here, so a hostile payee name or description cannot stretch a cell past readability.
 * The result is frozen; a renderer reads it and draws, it does not re-derive.
 */
export function buildInvoiceViewModel(invoice, today) {
    const totals = computeTotals(invoice);
    const asset = totals.asset;
    const symbol = asset.symbol;
    const notes = invoice.notes === undefined ? null : noteLines(invoice.notes);
    return Object.freeze({
        assetName: asset.name,
        symbol,
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
        lines: Object.freeze(totals.lines.map((line) => Object.freeze({
            description: clip(line.item.description, MAX_DESCRIPTION_CHARS),
            quantity: line.item.quantity,
            unitPrice: `${line.item.unitPrice} ${symbol}`,
            amount: money(line.amount, symbol),
        }))),
        subtotal: money(totals.subtotal, symbol),
        tax: invoice.tax === undefined
            ? null
            : Object.freeze({ label: clip(invoice.tax.label, MAX_TAX_LABEL_CHARS), value: money(totals.tax, symbol) }),
        total: money(totals.total, symbol),
        notes: notes === null ? null : Object.freeze(notes),
        payment: Object.freeze([
            Object.freeze({ label: "Asset", value: `${asset.name} (${asset.symbol})` }),
            Object.freeze({ label: "Network", value: `${chainName(invoice.chainId)} (${invoice.chainId})` }),
            Object.freeze({ label: "Pays to", value: invoice.payee.address, mono: true }),
        ]),
        labels: INVOICE_LABELS,
    });
}
//# sourceMappingURL=presentation.js.map