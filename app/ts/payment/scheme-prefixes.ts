/**
 * The payment schemes, each with the prefix its ecosystem's links carry, as the one statement of them.
 *
 * A scheme's prefix names both the link a builder spells and the link a paste is recognised by, so `payment/links.ts` and the two privacy-chain address validators read the same entries: a scheme renamed in one place cannot leave a validator recognising a link no builder writes.
 * The module deliberately imports nothing — no registry entry, no budget, no encoder — so the address-grammar layer reaches the prefixes it shares with the payment layer without loading any of them: a validator that needs a prefix and nothing else, as the Monero one does, reads this table alone.
 * `payment/schemes.ts` re-exports these names, so a reader that also needs a link budget still resolves both from the link layer.
 */

/** The name of each payment scheme a link can be spelled in: ZIP-321's `zcash`, the Monero URI scheme's `monero`, and EIP-681's `ethereum`. */
export type PaymentLinkScheme = "ethereum" | "monero" | "zcash";

/**
 * Every scheme with the prefix its links carry, as the one statement of both.
 *
 * The mapped type ties each prefix to the scheme it is keyed by, so a prefix that does not spell its own key is a compile error rather than something a reader has to compare by eye.
 */
export const PAYMENT_SCHEME_PREFIXES = {
	ethereum: "ethereum:",
	monero: "monero:",
	zcash: "zcash:",
} as const satisfies { readonly [Scheme in PaymentLinkScheme]: `${Scheme}:` };
