/**
 * Shown where an invoice's asset belongs to a family no injected wallet pays: the invoice view's hint beside its missing Pay control, and the payment panel's refusal.
 *
 * The sentence names where such an invoice is paid, so one spelling keeps the two payer-facing surfaces from describing that hand-off differently.
 */
export const UNSUPPORTED_WALLET_MESSAGE = "This invoice is paid by the payment link and QR code under Payment details, so there is no wallet to connect.";

/**
 * Shown beside the record of a payment on a paid invoice, and deliberately kept out of the printed page.
 *
 * The record is whatever its author wrote: a transaction hash and a date are a claim about a payment, not a confirmation of one, because nothing in this app can read a chain and nothing here is trusted to.
 * The sentence names the record's author as the payer — the person the invoice bills, who is the one who sends a payment — rather than the recipient, because the payee reading their own invoice is the recipient, and a sentence saying the record was reported by the recipient would tell that reader the report was their own.
 * It calls the record unverified in that word rather than in a paraphrase of it, and gives the two facts that make the word true: the app cannot check a payment against the network, and the link the record travels in is editable by anyone who holds it.
 * It is page-only on purpose: the printed page's title already states the record as a payment reported rather than confirmed, so the note is not repeated there; the on-screen page carries it to state the limit plainly.
 * The constraint this sentence follows is `docs/design/payment-safety-memo.md`'s: nothing in this app can confirm a payment, so the record is stated as one party's report and the link is named as the reason its trust is only the sender's.
 */
export const UNVERIFIED_PAYMENT_NOTE = "This page records a payment the payer reported. It is unverified: the app cannot check a payment against the network, and anyone who holds this link can edit the record.";

/**
 * Shown when a surface is refused because this window reports an opener: the payment panel and the mark-paid dialog both answer to the same rule, so they state one spelling of it.
 *
 * It states what the refusal does — every opener is refused, whichever page that one is — and why: a page from this website could drive the payment controls, and the page cannot tell which website an opener comes from.
 * It names what the check cannot see in the same sentence: a page that frames this invoice presents no opener, and a frame served from this website shares this document's origin, so no refusal inside the document binds that page — the residual `README.md`'s "Security over features" records as an accepted risk.
 * A payer who arrived from a plain link carries an opener too, so the sentence names every opener rather than telling them their own window is the one hazard.
 */
export const OPENED_REFUSAL_MESSAGE = "This page was opened by another page, so paying is refused here — whichever page that is. A page from this website could drive the payment controls, and this page cannot tell which website an opener comes from, so every opener is refused. Open the invoice on its own, from the link you were sent.";

export const OPENED_RECORD_PAYMENT_REFUSAL_MESSAGE = "This page was opened by another page, so recording a payment is refused here. A page from this website could drive the payment controls, and this page cannot tell which website an opener comes from, so every opener is refused; frames this invoice shows no opener. Open the invoice on its own.";

/**
 * Reported when an invoice could not be turned into the strings a share dialog offers: a fault this app cannot explain to whoever is sharing, so the failure itself goes to the console and the person reads what they can do about it.
 *
 * The create form's submit and the recipient's Share control both report it, so the two surfaces state one sentence rather than two spellings of the same advice.
 */
export const SHARE_FAILED_MESSAGE = "The invoice could not be shared. Reload the page and try again.";

/**
 * Shown by the document's Share control when the invoice on screen is past the budget a new invoice may use, which is a link an older copy wrote before that budget existed.
 *
 * The codec's own refusal for that size is written for the payee who is authoring an invoice, and its remedy is to remove part of the content — something the holder of a link has no form in front of them to do.
 * This document's Share control is offered to whoever holds the link, so the sentence states the two moves that reader has: recreate the invoice smaller, or ask for a fresh link.
 * It says the invoice still opens, because only writing it again is refused, and it names each move against the reader it belongs to rather than leaving the one the payee can perform as the only advice.
 */
export const SHARE_OVER_BUDGET_MESSAGE = "This invoice is too large to share again: it was written without the room the recipient's payment record needs, so the app cannot write its link. It still opens here. If it is your invoice, create it again with shorter descriptions or notes; otherwise ask the sender for a fresh link.";

/**
 * Reported when a view that was being built could not be released, which is the state both renderers that build through a release can leave: `ui/view.ts` and `ui/payment-section.ts` release what they had already subscribed to before they rethrow, and a release that throws there is the failure this sentence names.
 *
 * The sentence is the message of the error those renderers throw and the failed build is kept on its `cause`, so the console report a developer reads names the stop that failed rather than the render behind it; no catcher here shows a caught message to the payer, so this sentence never reaches the notice region, which states the shell's own fixed sentence for the route that failed (`app/shell.ts`'s `renderGuarded`) and sends the error to `reportInternalFailure`.
 */
export const VIEW_BUILD_RELEASE_FAILED_MESSAGE = "The view could not be drawn, and something it had already started may still be running. Reload the page to start over.";

/**
 * Reported when a payment could not be recorded: the mark-paid dialog's validation and egress failures and the payment panel's mark-paid control all state this sentence.
 *
 * The sentence states what failed, that something the attempt started may still be running, and the one action that clears it, so the payer knows a reload is what starts over rather than a second attempt.
 * It is the app's own sentence, never a caught message, because a failure here can carry a validator's echo of a rejected value or an internal path the payer can act on nowhere.
 */
export const PAYMENT_RECORD_FAILED_MESSAGE = "The payment could not be recorded, and something it had already started may still be running. Reload the page to start over.";

/** The mark-paid dialog's opener refusal, exported under the name its consumer imports. */
export const OPENED_MESSAGE = OPENED_RECORD_PAYMENT_REFUSAL_MESSAGE;
