/**
 * The ecosystem payment links: one invoice reduced to the URI a wallet — or a QR symbol — pays.
 *
 * Each scheme is the one its own ecosystem blesses: ZIP-321's `zcash:<address>?amount=<decimal ZEC>` for a Zcash invoice, Monero's `monero:<address>?tx_amount=<decimal XMR>`, and EIP-681's `ethereum:` form for an EVM invoice — `<address>@<chainId>?value=<wei>` for the chain's own coin, and `<token>@<chainId>/transfer?address=<recipient>&uint256=<base units>` for an ERC-20.
 * The scheme spellings live in `payment/scheme-prefixes.ts` — the leaf the two privacy-chain address validators read their own prefixes from as well — and the byte budgets live in `payment/schemes.ts`, the one module that states them and the Zcash address bound derived from them, which this module re-exports and applies, so the prefix a link is built with and the prefix an address validator recognises a pasted link by are one statement; a Zcash link's own shape is stated there too, as the template this module's builder spells it with, and the Zcash address bound derived from that template is what the Zcash validator holds a unified container to.
 * The budgets stay in that leaf rather than moving in here because the bound is read by an address validator: this module reaches the validators through `wallet/payout-address.ts`, so a validator importing a figure from here would close the cycle `links → payout-address → zcash-address → links`, whose module-scope constants are then read before they are initialized — a load-time `ReferenceError`, not a slower start. What this module owns instead is the composition, made at load and read again where a share is handed out: `requireZcashAmountBudget` holds the registry's own ZEC scale to the amount the address budget reserves, and `requireLinkBudget` holds every registry entry's own widest link — its scheme, its chain id, the widest address its family accepts, and the widest amount a uint256-bounded total prints in that scheme's field — inside the same ceiling, so an entry that is admitted is one whose links the payer's document can carry.
 * The widest `zcash:` link the Zcash address bound admits is measured once, as the registry's `zec` entry: the entry measurement composes that link through the same template the builder spells it with, and `requireZcashAmountBudget` keeps the entry's scale at the amount the bound reserved, so the Zcash family needs no measurement of its own.
 * Those gates raise {@link PaymentLinkBudgetError}, the class this module declares beside {@link PaymentLinkError}, so the form that hands a share out reads the class rather than the message to tell a budget refusal from a fault of its own.
 * A link carries the address and the amount and nothing else: the invoice already shows the payee, so ZIP-321's optional `label` and `message` and Monero's `recipient_name` are left out, which is what keeps every link inside the QR symbol the view renders it in — the budget {@link MAX_PAYMENT_LINK_BYTES} states, measured in the UTF-8 bytes the ceiling is stated in rather than in UTF-16 code units, so the check here and the encoder's own byte measurement agree by construction.
 * The amount is never taken from anything transported: it is the invoice's own recomputed total (`invoice/model.ts`'s `computeTotals`), read off the single figure the model publishes for each scheme's field rather than converted a second way, and it travels on the built link as {@link PaymentLink.amount} — so a surface that displays, copies, or compares the amount a link asks for reads the one value the URI was spelled from, rather than recomputing the same total a second way and hoping the two spellings agree.
 * The payee is re-validated through `wallet/payout-address.ts`'s dispatcher, the same boundary the invoice was built at, so the link carries the canonical spelling its family's encoding defines, and an EVM link spells the address — and a token's contract — in the EIP-55 checksummed form EIP-681's examples use; the dispatcher's own return is carried on the link as {@link PaymentLink.payee}, so a caller that displays the payee shows the very spelling this URI encodes rather than re-reading the invoice field beside it.
 * Nothing here touches the DOM, the clock, or the network: a link is text, and the caller decides how it is displayed, copied, or encoded.
 */

import { ASSETS, isAssetNetwork, isCanonicalEvmChainId, requireAsset, requireAssetFamily, requireEvmChain, type Asset } from "../assets/registry.js";
import { computeTotals, type Amount, type Invoice } from "../invoice/model.js";
import { MAX_UINT256_DIGITS } from "../util/decimal.js";
import { utf8ToBytes } from "../util/encoding.js";
import { describe } from "../util/errors.js";
import { MAX_EVM_ADDRESS_LENGTH } from "../wallet/address.js";
import { MAX_MONERO_ADDRESS_LENGTH } from "../wallet/monero-address.js";
import { requirePayoutAddress, type PayoutAddress } from "../wallet/payout-address.js";
import { MAX_ZCASH_ADDRESS_LENGTH } from "../wallet/zcash-address.js";
import { MAX_PAYMENT_LINK_BYTES, PAYMENT_SCHEME_PREFIXES, ZCASH_AMOUNT_BUDGET_CHARS, maxAmountChars, zcashAmountOutgrowsBudget, zcashLinkUri, type PaymentLinkScheme } from "./schemes.js";

export { MAX_PAYMENT_LINK_BYTES, type PaymentLinkScheme };

/**
 * A payment link: the whole URI, the scheme that spells it, the payee address it was built from, and the amount it asks for.
 *
 * `uri` is the link byte for byte as it is carried — the same text a QR symbol is encoded from — so a link and the symbol showing it cannot disagree about what is paid.
 * `payee` is `wallet/payout-address.ts`'s own return for the invoice's payee field: the canonical spelling the URI carries, and the one a display boundary draws, so a document cannot show one spelling beside a URI that encodes another — an `Invoice` a caller assembled by hand rather than through `validateInvoice` included.
 * `amount` is the invoice's own recomputed total as `invoice/model.ts` publishes it — the base units a transfer carries and the decimal text a URI field spells, both at once — and it is the one value the URI was spelled from, so a surface that displays, copies, or compares the amount a link asks for reads this figure rather than recomputing a total a second way and hoping the two agree; which of the two spellings a given URI carries is that scheme's own field, and both are this one value.
 */
export interface PaymentLink {
	readonly scheme: PaymentLinkScheme;
	readonly uri: string;
	readonly payee: PayoutAddress;
	readonly amount: Amount;
}

/**
 * Raised by {@link buildPaymentLink} for an invoice it refuses for a reason of its own: the invoice names a network its asset does not live on, or the link it built is past {@link MAX_PAYMENT_LINK_BYTES}.
 *
 * The byte refusal is deliberately a last defence that no validated input can reach: the address validators bound the container a payee address may be, the amount is the invoice's uint256-bounded total, and this module checks at load that every registry entry's own widest link fits the budget, which leaves the widest link at 404 bytes, eight inside it.
 * It is kept, rather than dropped as unreachable, because it names the link that outgrew the symbol — the encoder would instead refuse the same text as a symbol-size limit and name itself — so a validator loosened upstream still meets the message that says which link is too long.
 * The network refusal is the one an invoice can provoke, and `invoice/model.ts` already refuses such an invoice where it is created.
 * The app-level budget gates raise this class's {@link PaymentLinkBudgetError} subclass instead, so the one budget refusal a caller can provoke is a class apart from this one — `ui/create.ts` answers it in its own words — while a caller that knows only this class still catches it.
 * `ui/presentation.ts` raises this class too, for the other positions a payment value can be refused in: a URI, or the payee address the URI carries, that the display boundary would not carry unchanged is refused there rather than shown, copied, and encoded in a clipped spelling.
 */
export class PaymentLinkError extends Error {
	constructor(reason: string) {
		super(`payment-link: ${reason}`);
		this.name = "PaymentLinkError";
	}
}

/**
 * Raised by this module's own byte-budget gates: {@link requireLinkBudget}, which holds an entry's widest link to {@link MAX_PAYMENT_LINK_BYTES} where the registry is admitted and again where the payee's form hands a share out, and {@link requireZcashAmountBudget}, which holds the registry's own ZEC scale to the amount the address budget reserved.
 *
 * It is a class of its own rather than a base `Error` because the one budget refusal a payee can reach — {@link requireLinkBudget}, on the payee's own share path — has to be tellable from a fault inside the form: `ui/create.ts` catches this class and answers with the selected asset and the one action that clears the refusal, while any other throw stays its generic failed share.
 * A caller that knows only the link layer still catches it, this class being a {@link PaymentLinkError}, exactly as `wallet/zcash-address.ts`'s testnet refusal is caught as an `InvalidZcashAddressError`.
 * The per-link check inside {@link paymentLink} stays a plain {@link PaymentLinkError}: it refuses one link as it is built, where these gates refuse an entry or a bound at admission, so a loosened validator meets a link refusal rather than a gate the registry passed.
 */
export class PaymentLinkBudgetError extends PaymentLinkError {
	constructor(reason: string) {
		super(reason);
		this.name = "PaymentLinkBudgetError";
	}
}

/**
 * The link `uri` spells, frozen, together with the amount it was spelled from, or the {@link PaymentLinkError} that says the link is past the app's byte budget.
 *
 * Every builder in this module returns through here, which is what keeps the budget one statement rather than a rule each scheme restates, and nothing outside the module can hand the four fields a scheme, a uri, a payee, and an amount that disagree: the amount is the one figure the uri was spelled from.
 * The budget is applied in UTF-8 bytes — the unit the encoder's ceiling and its own version selection are stated in — so the figure this check compares against and the encoder's own measurement of the same text cannot disagree about a link carrying a code point outside ASCII, which the scheme validators leave unrefused today but the budget module no longer depends on: `utf8ToBytes(uri).length` is the byte count `encodeQr` selects a version by.
 */
function paymentLink(scheme: PaymentLinkScheme, uri: string, payee: PayoutAddress, amount: Amount): PaymentLink {
	const bytes = utf8ToBytes(uri).length;
	if (bytes > MAX_PAYMENT_LINK_BYTES) {
		throw new PaymentLinkError(`the ${scheme} link is ${bytes} bytes, past the ${MAX_PAYMENT_LINK_BYTES}-byte ceiling of the largest QR symbol this app draws`);
	}
	return Object.freeze({ scheme, uri, payee, amount });
}

/**
 * The invoice's own recomputed total: the one amount any link asks for, carried onto the link so the figure and the URI are one value rather than two recomputations.
 *
 * `invoice/model.ts`'s `computeTotals` publishes the total both ways at once — the base units a transfer carries and the decimal text a URI field spells — and each scheme reads the figure its own field takes off that one value, so a link cannot carry an amount recomputed a second way and the two spellings of one total cannot diverge.
 */
function total(invoice: Invoice): Amount {
	return computeTotals(invoice).total;
}

/**
 * Refuse an invoice that names a network other than the one its asset lives on.
 *
 * The asset, the network, and the payee are re-derived here rather than trusted, as `wallet/payment.ts`'s `buildPaymentPlan` re-derives them for the injected-wallet path, so an invoice whose own fields disagree is refused as the link that cannot exist instead of becoming a link in the asset's scheme that carries another network's address.
 * The comparison itself is `assets/registry.ts`'s `isAssetNetwork`, which the invoice validator and the injected-wallet planner read too, so the three readers of the rule cannot drift apart.
 */
function requireAssetNetwork(invoice: Invoice, asset: Asset): void {
	if (!isAssetNetwork(invoice.chainId, asset)) {
		throw new PaymentLinkError(`the invoice names network ${describe(invoice.chainId)} but ${asset.id} lives on ${describe(asset.chainId)}`);
	}
}

/**
 * The decimal quantity an EIP-681 link writes after `@` for a chain id: the registry's `0x` form as the number it denotes, so `0x1` is `1`.
 *
 * EIP-681 spells the chain as a decimal quantity while the registry states the canonical lower-case hex id a wallet's `wallet_switchEthereumChain` call takes, so the conversion is written once here and both the builder and the widest-link measurement below read it.
 * A chain id that is not that canonical form is refused rather than handed to `BigInt`, whose own message would name a parse failure instead of the entry that carried it: the registry's shape rule refuses one at load, and this is the same refusal for the caller-built asset the measurement can be handed.
 */
function chainQuantity(chainId: string): string {
	if (!isCanonicalEvmChainId(chainId)) {
		throw new Error(`payment-link: cannot spell an EIP-681 link for the chain id ${describe(chainId)} — expected a canonical lower-case 0x quantity like "0x1"`);
	}
	return BigInt(chainId).toString();
}

/**
 * The EIP-681 link a native EVM invoice is spelled as: the scheme, the recipient, the chain the transfer is for, and the amount in base units.
 *
 * This is the one statement of that shape, and both readers of it go through this function: {@link ethereumLink} builds a link with it and {@link widestLinkBytes} measures the widest link an entry can build with it, so a field the link layer grows moves that measurement with it instead of leaving the budget sized against a link no builder writes.
 */
function ethereumTransferUri(chain: string, recipient: string, units: string): string {
	return `${PAYMENT_SCHEME_PREFIXES.ethereum}${recipient}@${chain}?value=${units}`;
}

/**
 * The EIP-681 link an ERC-20 invoice is spelled as: the token's own contract, the chain, the recipient, and the amount in the token's base units.
 *
 * The shape is stated here once for the reason {@link ethereumTransferUri} states its own: the builder spells the link with it and the widest-link measurement measures the entry with it.
 */
function ethereumTokenUri(chain: string, contract: string, recipient: string, units: string): string {
	return `${PAYMENT_SCHEME_PREFIXES.ethereum}${contract}@${chain}/transfer?address=${recipient}&uint256=${units}`;
}

/**
 * The Monero link an invoice is spelled as: the scheme, the payee's mainnet address, and the amount in XMR.
 *
 * The shape is stated here once for the reason {@link ethereumTransferUri} states its own: the builder spells the link with it and the widest-link measurement measures the entry with it.
 */
function moneroLinkUri(address: string, amount: string): string {
	return `${PAYMENT_SCHEME_PREFIXES.monero}${address}?tx_amount=${amount}`;
}

/**
 * The EIP-681 link for an EVM invoice: the chain's own coin as a plain `value` transfer, or an ERC-20 as a `transfer` call addressed to the token's contract.
 *
 * The chain id is written as the decimal quantity EIP-681 spells after `@` — the registry's `0x1` is `1` — so the link is unambiguous wherever a payer's wallet also knows another chain with the same address, and the amount is the total's own base-unit figure: wei for the coin, the token's own smallest unit for an ERC-20 — the figure the total was published as, so the field is a reading of {@link PaymentLink.amount} rather than a second conversion of the human decimal.
 * The recipient is the payee the payout-address dispatcher accepted, which is already the EIP-55 checksummed spelling, and the token's contract is read from the registry, which holds every entry's contract address in that same spelling: neither figure is re-checksummed here, where the only statement this module makes about casing is the one those two boundaries already make.
 */
function ethereumLink(invoice: Invoice, asset: Asset): PaymentLink {
	const chain = chainQuantity(requireEvmChain(invoice.chainId));
	const recipient = requirePayoutAddress(invoice.payee.address, asset);
	const amount = total(invoice);
	const units = amount.units.toString();
	if (asset.kind === "erc20") {
		return paymentLink("ethereum", ethereumTokenUri(chain, asset.address, recipient, units), recipient, amount);
	}
	return paymentLink("ethereum", ethereumTransferUri(chain, recipient, units), recipient, amount);
}

/**
 * The ZIP-321 link for a Zcash invoice: the scheme, the payee's mainnet address, and the amount in ZEC.
 *
 * The shape is `payment/schemes.ts`'s `zcashLinkUri`, the one template such a link is spelled with, so the `amount` parameter written here and the bytes that module's address budget reserves for it are one statement rather than two spellings kept in step by hand.
 * The amount is the total's own decimal text, which is the spelling the model publishes in ZEC's eight decimals; the spec's optional `label` and `message` are left out so the link carries nothing the invoice does not already show.
 */
function zcashLink(invoice: Invoice, asset: Asset): PaymentLink {
	const address = requirePayoutAddress(invoice.payee.address, asset);
	const amount = total(invoice);
	return paymentLink("zcash", zcashLinkUri(address, amount.text), address, amount);
}

/**
 * The Monero link for an invoice: the scheme, the payee's mainnet address, and the amount in XMR.
 *
 * The amount is the total's own decimal text, in XMR's twelve decimals, and the spec's optional `recipient_name` is left out for the same reason as ZIP-321's label.
 */
function moneroLink(invoice: Invoice, asset: Asset): PaymentLink {
	const address = requirePayoutAddress(invoice.payee.address, asset);
	const amount = total(invoice);
	return paymentLink("monero", moneroLinkUri(address, amount.text), address, amount);
}

/**
 * The widest link `asset` can build, in UTF-8 bytes: the asset's own scheme and chain id, the widest amount a uint256-bounded total prints in that scheme's field, and the widest address the asset's family accepts.
 *
 * The figures are composed through the same templates the builders spell their links with — {@link ethereumTransferUri}, {@link ethereumTokenUri}, {@link moneroLinkUri}, and `payment/schemes.ts`'s `zcashLinkUri` — so a field the link layer grows moves this measurement with it rather than leaving the budget sized against a link no builder writes.
 * The address is each family's own bound: an EVM recipient and a token contract are {@link MAX_EVM_ADDRESS_LENGTH} characters by their grammar, a Monero encoding's widest form is {@link MAX_MONERO_ADDRESS_LENGTH}, and the Zcash family's widest accepted form is the bound `payment/schemes.ts` derives from this same ceiling and `wallet/zcash-address.ts` applies.
 * The amount is the widest spelling the model's own uint256 cap can print as that scheme carries it: a bare decimal at the entry's own scale for the two privacy-chain schemes, and the base-unit integer for EIP-681, whose `value` and `uint256` fields take base units whatever the token's scale is.
 * It is deliberately measured against the widest the entry can reach rather than against one invoice's own values, because that is the figure an entry has to satisfy to be admitted at all.
 */
function widestLinkBytes(asset: Asset): number {
	const amount = "9".repeat(maxAmountChars(asset.decimals));
	switch (requireAssetFamily(asset)) {
		case "zcash":
			return utf8ToBytes(zcashLinkUri("u".repeat(MAX_ZCASH_ADDRESS_LENGTH), amount)).length;
		case "monero":
			return utf8ToBytes(moneroLinkUri("4".repeat(MAX_MONERO_ADDRESS_LENGTH), amount)).length;
		case "evm": {
			const chain = chainQuantity(asset.chainId);
			const recipient = "0".repeat(MAX_EVM_ADDRESS_LENGTH);
			const units = "9".repeat(MAX_UINT256_DIGITS);
			const uri = asset.kind === "erc20"
				? ethereumTokenUri(chain, asset.address, recipient, units)
				: ethereumTransferUri(chain, recipient, units);
			return utf8ToBytes(uri).length;
		}
	}
}

/**
 * Fail closed unless the widest link `asset` can build still fits {@link MAX_PAYMENT_LINK_BYTES}.
 *
 * This is the entry half of the budget: the per-link check inside {@link paymentLink} refuses one link as it is built, which is too late to be useful at admission — an entry whose chain id is long enough to outgrow the symbol satisfies every shape rule the registry applies, so it would be admitted and shared and refused only when the payer's document tried to render it.
 * The figure measured is the widest the entry can reach, never the value one invoice happens to carry, so the check does not depend on which invoice is being shown.
 * The refusal names the entry and the figure, so an entry that grew a long chain id fails where it is admitted with a message saying which entry and by how much, rather than reaching a payer as half a document.
 * The refusal is a {@link PaymentLinkBudgetError}, so `ui/create.ts` — which applies this same gate where a payee submits — catches the class and answers the payee with the asset and the one action that clears the refusal, rather than folding it into its catch-all.
 * The Zcash address bound is measured through this same gate, as the registry's `zec` entry rather than in a check of its own: the bound is derived from this ceiling, and {@link requireZcashAmountBudget} holds that entry's scale to the amount the bound reserved, so the figure measured here for that entry is the widest `zcash:` link the bound admits.
 */
export function requireLinkBudget(asset: Asset): void {
	const widest = widestLinkBytes(asset);
	if (widest > MAX_PAYMENT_LINK_BYTES) {
		throw new PaymentLinkBudgetError(`the ${asset.id} entry builds a ${widest}-byte link at the widest address and amount its family admits, past the ${MAX_PAYMENT_LINK_BYTES}-byte ceiling of the largest QR symbol this app draws — no invoice of this entry could be shown, copied, or encoded`);
	}
}

/**
 * Fail closed unless the registry's own ZEC entry can print an amount inside the figure the Zcash address budget reserves.
 *
 * The address bound is derived from this app's own uint256 digit budget rather than from the ZEC entry's scale, because reading the entry at load would pull the registry module — and its load-time validation — into every address validator's import graph; this check is what keeps that derivation honest, and it runs here, in the module that owns the link budgets and already depends on the registry.
 * A refused entry stops the app at load instead of accepting a payee address whose link the encoder would refuse a moment later, and the amount budget itself is read from `payment/schemes.ts`, so the figure checked against and the figure the address bound reserved cannot drift apart.
 * It is also what keeps the Zcash invariant to one measurement: the figure the bound reserved is the digits arm of the amount budget, which holds at every scale this check admits, so the entry's widest spelling is that very figure and the link {@link requireLinkBudget} measures for the entry is the widest `zcash:` link the bound admits.
 * It refuses with {@link PaymentLinkBudgetError}, the class this module's budget gates raise.
 */
function requireZcashAmountBudget(): void {
	const asset = requireAsset("zec");
	if (zcashAmountOutgrowsBudget(asset.decimals)) {
		throw new PaymentLinkBudgetError(`the ${asset.id} entry prints amounts at ${asset.decimals} decimals, whose widest spelling is longer than the ${ZCASH_AMOUNT_BUDGET_CHARS} characters the Zcash address budget reserves — the widest address this app accepts would build a link past the ${MAX_PAYMENT_LINK_BYTES}-byte ceiling of the largest QR symbol it draws`);
	}
}

/**
 * The composition check made as this module loads: every entry the registry carries is held to its own widest link, so an entry that is admitted is one whose links this app can show, copy, and encode.
 *
 * The set read is the registry's own, not a list restated here, so an entry added to the registry is measured by this check without a second edit — which is what makes the refusal a load-time gate rather than a test that has to be extended alongside the registry.
 */
function requireRegistryLinkBudgets(): void {
	for (const asset of ASSETS) {
		requireLinkBudget(asset);
	}
}

/**
 * The link `invoice` asks to be paid by, dispatched on the payment family its asset belongs to.
 *
 * The family is the registry's own statement about the asset and nothing else picks the scheme, so a new asset of a family already covered needs no case here and an invoice cannot be handed a link in a scheme its asset does not use.
 * It is read through `assets/registry.ts`'s `requireAssetFamily` — the one place a family is resolved for a reader that acts on it — so the switch below covers every name `AssetFamily` holds and there is no value left for it to fall out of: an asset whose family resolves to nothing the app has rules for is refused with that resolution's own `UnsupportedAssetFamilyError`, before this switch runs, rather than returning `undefined` for a link no scheme spells.
 * The asset, the network, and the payee address are re-derived here rather than trusted from the caller: {@link requireAssetNetwork} holds the network to the one the asset lives on before any branch runs, an EVM asset's network is read through `requireEvmChain` so a chain no wallet can reach is refused by name, and every family's payee address is re-validated by the rules its family states — the canonical spelling that validation returns is what the link carries and what {@link PaymentLink.payee} exposes.
 * The amount the link asks for is the invoice's own recomputed total, and it is carried on the returned link as {@link PaymentLink.amount}: one recomputation per built link, read by every surface that displays, copies, or compares it.
 * A refusal keeps the class of the boundary that raised it rather than folding every case into one: the asset lookup raises `assets/registry.ts`'s `UnsupportedAssetError`, the family resolution raises that module's `UnsupportedAssetFamilyError`, {@link requireAssetNetwork} and the byte budget raise {@link PaymentLinkError}, the EVM network read raises `UnsupportedChainError` or `UnsupportedEvmChainError`, and the payee carries its own validator's refusal — `InvalidZcashAddressError`, or the subclass it raises for an address on a network this app does not pay, for a Zcash payee, `InvalidMoneroAddressError` for a Monero one, and the EVM branch's `InvalidChecksumError` or `UnpayableAddressError` for an EVM one — so a caller classifying a link that cannot be built reads the class it caught rather than a message.
 */
export function buildPaymentLink(invoice: Invoice): PaymentLink {
	const asset = requireAsset(invoice.asset);
	requireAssetNetwork(invoice, asset);
	switch (requireAssetFamily(asset)) {
		case "evm":
			return ethereumLink(invoice, asset);
		case "zcash":
			return zcashLink(invoice, asset);
		case "monero":
			return moneroLink(invoice, asset);
	}
}

requireZcashAmountBudget();
requireRegistryLinkBudgets();
