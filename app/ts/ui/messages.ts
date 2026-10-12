/**
 * The payer-facing sentences that belong to no single surface.
 *
 * A sentence that more than one surface shows is owned here rather than by one of them, so a surface reads the wording without depending on another surface's module — the invoice document's hint and the payment panel's refusal are the same sentence, and neither module imports the other for it.
 * Nothing here touches the DOM, the clock, or the network: these are strings, and the surface that shows one decides how.
 */

/**
 * Shown where an invoice's asset belongs to a family no injected wallet pays: the invoice view's hint beside its missing Pay control, and the payment panel's refusal.
 *
 * The sentence names where such an invoice is paid, so one spelling keeps the two payer-facing surfaces from describing that hand-off differently.
 */
export const UNSUPPORTED_WALLET_MESSAGE = "This invoice is paid by the payment link and QR code under Payment details, so there is no wallet to connect.";
