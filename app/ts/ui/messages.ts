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
 * It states that plainly so neither reader can mistake the record for a verified settlement, and it names the link itself as the reason the claim is only as trustworthy as whoever sent it.
 * It is page-only on purpose: the printed page's title already states the record as a payment reported rather than confirmed, so the note is not repeated there; the on-screen page carries it to state the limit plainly.
 * The constraint this sentence follows is `docs/design/payment-safety-memo.md`'s: nothing in this app can confirm a payment, so the record is stated as one party's report and the link is named as the reason its trust is only the sender's.
 */
export const UNVERIFIED_PAYMENT_NOTE = "This page records a payment the payer reported. The app cannot check a payment against the network: anyone who holds this link can edit the record.";

/**
 * Reported when an invoice could not be turned into the strings a share dialog offers: a fault this app cannot explain to whoever is sharing, so the failure itself goes to the console and the person reads what they can do about it.
 *
 * The create form's submit and the recipient's Share control both report it, so the two surfaces state one sentence rather than two spellings of the same advice.
 */
export const SHARE_FAILED_MESSAGE = "The invoice could not be shared. Reload the page and try again.";

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
