/**
 * The payment details of an invoice, as one shared section: the terms a wallet takes verbatim — the payee address, the amount, and the invoice's own payment link — beside the symbol of that same URI.
 *
 * {@link renderPaymentSection} is the one renderer of that section, drawn by the payer's document (`ui/view.ts`) and by the payee's create screen (`ui/create.ts`), which shows the section for the invoice it just built rather than making the payee open their own share link to see how they are to be paid.
 * Every string and every module comes from `ui/presentation.ts`'s frozen view model, so the two surfaces cannot word, order, or encode the payment differently, and neither of them recomputes a value the model already states.
 *
 * The amount, the address, and the link are values a wallet takes verbatim, so each is drawn in a single-line field with an exact-copy control: one click hands the clipboard that string itself rather than whatever a text selection happened to span, the write goes through the same clipboard seam the share dialog uses, and the field keeps the value on one line so the layout cannot place a line break inside it either.
 * A print engine cannot read that field whole — it lays a form control's value out on one line and clips it at the field's edge — and the copy control beside it is chrome the print path hides, so each copyable term also carries a print-only twin of its value: the same string as a text node, which `print.css` swaps in for the field and lets wrap, so a printed invoice carries the complete amount, payee address, and payment link of every legal invoice.
 *
 * The symbol is one element per module through `util/dom.ts`'s `h()`: no markup is built from a string, and no `data:` URL or canvas is reachable under the page's policy.
 */
import { h } from "../util/dom.js";
import { copyWithFallback } from "./clipboard.js";
/**
 * The section the view model describes: its payment title, one term per entry in the model's own list, and the symbol of the link those terms state.
 *
 * The symbol is drawn under the terms that state the same URI, never as a second statement of it: the link text the term above it draws is what a screen reader reads and a payer can select.
 */
export function renderPaymentSection(view, clipboard) {
    return h("footer", { class: "invoice-payment" }, h("h2", { class: "section-title" }, view.labels.paymentTitle), h("dl", { class: "payment-list" }, ...view.payment.map((term) => paymentTerm(term, clipboard))), qrBlock(view.paymentQr));
}
/** One payment-details term: its label and, in the `<dd>`, the value {@link paymentValue} renders, in a monospace face when the term is one a wallet takes verbatim. */
function paymentTerm(term, clipboard) {
    return h("div", { class: "payment-term" }, h("dt", {}, term.label), h("dd", { class: term.verbatim === true ? "mono" : undefined }, ...paymentValue(term, clipboard)));
}
/**
 * A term's value: a single-line field with an exact-copy control when the term is one a wallet takes verbatim, and plain text when it is not.
 *
 * The field is what the copy control reads, so the clipboard receives the term's own string rather than the span of a text selection, and the field's single-line layout keeps a value that breaks nowhere from being broken by the layout either.
 * The print-only twin is that same term as the printed page presents it: the field is a form control, whose value a print engine keeps on one line and clips at the field's edge, and the copy control — the one complete-copy affordance — is hidden in print, so a value longer than the column, a Zcash unified address of up to 311 characters or the payment link carrying it, would otherwise reach paper as the prefix that fitted.
 * The twin is a text node rather than a control's value, which is what lets `print.css` wrap it; on screen it is hidden and the field with its copy control is the presentation.
 * The write goes through `ui/clipboard.ts`, the seam the share dialog and the payment panel use: the two outcomes are spelled there once, and when the clipboard is unavailable or refuses the write the field is selected and the status tells the payer to copy by hand.
 * The button's accessible name carries the term's label, so two controls reading "Copy" on one document are still told apart.
 * The one flag is what the term's own `verbatim` statement is: the field, the twin, and the PDF's unbroken run all read it, so a term cannot be a copy field on one surface and plain text on another.
 */
function paymentValue(term, clipboard) {
    if (term.verbatim !== true) {
        return [h("span", { class: "payment-value" }, term.value)];
    }
    const field = h("input", { type: "text", class: "payment-value", readonly: true, value: term.value, "aria-label": term.label });
    const printed = h("span", { class: "payment-value-print" }, term.value);
    const status = h("span", { class: "payment-status no-print", role: "status" }, "");
    const copy = h("button", { type: "button", class: "btn btn-secondary payment-copy no-print", "aria-label": `Copy ${term.label}` }, "Copy");
    copy.addEventListener("click", () => {
        copyWithFallback(term.value, clipboard, field, status);
    });
    return [field, printed, copy, status];
}
/**
 * The payment link's symbol: one element per module, dark or light alike, drawn under the terms that state the same URI.
 *
 * The grid is `aria-hidden` rather than content: the link text the term above it draws is the statement a screen reader reads and a payer can select, and the symbol carries nothing that text does not.
 * It is drawn element by element because the app builds no markup from strings and no `data:` URL or canvas is reachable under the page's policy; the stylesheet sizes the modules, so a 77-module symbol (the widest the link layer can produce) is laid out by the same rules as a 21-module one.
 *
 * That element-per-module cost is paid once per render and stays bounded by the link layer's own figures: the worst case is the version-15 symbol at 77 modules across — 77×77 = 5929 module elements plus 77 row elements — while an ordinary invoice is cheaper, a unified address of the ~200 characters a container naming several receivers reaches building a 61×61 symbol of 3721 module elements plus 61 rows.
 * Nothing rebuilds the grid on a keystroke: the payer's document draws it once for a decoded invoice, and the create screen rebuilds the section only for an invoice it has just created, so a second symbol, or a rebuild on every keystroke, is a deliberate change to this cost rather than something the code already does.
 */
function qrBlock(matrix) {
    return h("div", { class: "payment-qr", "aria-hidden": "true" }, ...matrix.modules.map((row) => h("div", { class: "qr-row" }, ...row.map((dark) => h("span", { class: dark ? "qr-module qr-module-dark" : "qr-module" })))));
}
//# sourceMappingURL=payment-section.js.map