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

/**
 * Reported when a view that was being built could not be released, which is the state both renderers that build through a release can leave: `ui/view.ts` and `ui/payment-section.ts` release what they had already subscribed to before they rethrow, and a release that throws there is the failure this sentence names.
 *
 * The sentence is the message of the error those renderers throw and the failed build is kept on its `cause`, so the console report a developer reads names the stop that failed rather than the render behind it; no catcher here shows a caught message to the payer, so this sentence never reaches the notice region, which states the shell's own fixed sentence for the route that failed (`app/shell.ts`'s `renderGuarded`) and sends the error to `reportInternalFailure`.
 */
export const VIEW_BUILD_RELEASE_FAILED_MESSAGE = "The view could not be drawn, and something it had already started may still be running. Reload the page to start over.";
