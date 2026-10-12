/**
 * One form an address validator accepts, as the payee-facing hint names it.
 *
 * Each validator states the forms it takes as a list of these — `wallet/zcash-address.ts`'s `ZCASH_ADDRESS_FORMS` and `wallet/monero-address.ts`'s `MONERO_ADDRESS_FORMS` — and `ui/create.ts`'s payout-address placeholder and guidance are composed from those lists rather than from wording of their own, so a hint that names a form and the validator that decides whether a paste is one cannot drift apart.
 * The interface is deliberately display-shaped rather than an address type: it carries the spellings a hint shows and the length a form's encodings have, never a validated address.
 */
export interface PayoutAddressForm {
	/** The spellings an address in this form leads with, in the order a hint lists them, e.g. a transparent Zcash address's `t1` and `t3`. */
	readonly prefixes: readonly string[];
	/** The name a hint gives the form, e.g. `transparent` or `standard address`. */
	readonly name: string;
	/** The characters the form's encodings occupy, for a form whose every encoding has the same length. */
	readonly characters?: number;
}
