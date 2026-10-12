/**
 * The payout-address dispatcher: an untrusted payee address validated against the asset it will be paid in.
 *
 * The address rules belong to the payment family, not to the individual asset, so this module is where the family is read: an EVM payee is validated as an Ethereum address and guarded against the targets a transfer must not reach, a Zcash payee by `wallet/zcash-address.ts`, and a Monero payee by `wallet/monero-address.ts`.
 * A caller holding an asset and a pasted address therefore does not pick the rules; a new family is one case here.
 * The family travels on the asset itself — `assets/registry.ts` declares it on every entry — so the family a branch runs on is the registry's statement about the asset rather than a label the call site attaches, and a new asset of a family already covered needs no case here.
 * That statement is read through `assets/registry.ts`'s `assetFamily`, the same resolution the registry's load-time gate applies, so an entry the gate admits for stating no family at all is dispatched here as the default EVM asset rather than refused for a family the gate never required, and the family name set is that module's `ASSET_FAMILIES` rather than a second list kept in step by hand.
 * The asset's family and the fields it carries are checked against each other by `assets/registry.ts`'s `assetShapeFault`, the one statement of those rules, which this module applies under `STATED_ASSET_SHAPE`: the rule set that refuses a non-EVM asset carrying a contract address — or stating a kind its family does not pay, or a network that is not its family's own slug — is the same one the registry's load-time gate applies, so an asset either reader admits for its shape is not one the other refuses.
 * The two readers differ in one place only, and that difference is stated once in the policy rather than restated here: a registry entry states every field its shape depends on, while a caller-built asset carries only what its reader reads, so an absent `chainId` or `decimals` is a field this module judges not at all and an absent kind is refused for an EVM asset, whose token-contract guard is keyed on the kind it states.
 * An asset whose family this app cannot pay is refused with {@link UnsupportedPayoutFamilyError} rather than a `TypeError`: `util/errors.ts` reserves that class for an argument of the wrong shape, so a caller can tell "this asset is not payable here" from "your address is malformed". A `family` of the wrong type is still that shape error, and both messages keep the module's `payout-address:` prefix.
 * An EVM payee string that is not an address is refused with that same wrong-shape `TypeError` — the class `wallet/address.ts` raises for a value that is not an address, in the clause that module states and this branch reads — rather than the typed domain error the Zcash and Monero branches raise for a string that fails their grammars, so a caller that groups refusals by class reads it as a wrong-shaped argument rather than an internal fault.
 * The EVM branch's token-contract guard is fail-closed: an `erc20` asset whose own contract address is not the EIP-55 checksummed `0x` address the loader admits is refused with {@link UnreadableTokenContractError} before that guard runs, because `assets/registry.ts`'s `requirePayableAddress` reports "not the token's own contract" — not an error — for a value it cannot compare, which would leave the funds-locking target unchecked; a stated `native` that carries a contract address is refused for the same reason, since trusting the label over the field it contradicts is exactly how the guard would be skipped; and an asset that states no `kind` is refused, so no asset reaches that guard classified by an inference rather than its own statement.
 * The kind that guard reads is the one the asset states, so every asset that reaches the funds-locking comparison `requirePayableAddress` runs has already stated a valid kind, and that comparison's own `assetKind` resolution and this rule can only read the same one.
 * Every refusal this module raises echoes the rejected value boundedly rather than in full: the EVM branch refuses a value that is not an address with `wallet/address.ts`'s own clause, read from that module's `addressShapeMessage` and rendered here with `util/errors.ts`'s `preview` rather than the `describe` rendering that would carry a hostile paste whole, and the delegated address refusals it still reaches name a 42-character address; the two privacy-chain validators lead with the reason and echo only a bounded preview of the value, so the reason still shows wherever a caller clips the message.
 * This module's own refusals for a value that is not a string echo a bounded preview too — `util/errors.ts`'s `preview` rather than `describe` — so an object whose `toString` is arbitrarily large cannot inflate the message it is refused with.
 * The EVM branch's refusal of a value that is not a string is the one message here that is a bare reason clause rather than a prefixed one: it is this module's own clause for a non-string payee address, which `invoice/model.ts` reaches through this dispatcher and wraps under the field path it read the value from, so the user reads the path in front of that clause rather than a second wording of the same refusal.
 * The longest address any of those families admits is stated here once, as {@link MAX_PAYOUT_ADDRESS_LENGTH}, so a reader that has to bound a displayed address derives the true maximum from the validators rather than from one family's constant.
 */

// `AssetFamily` is imported as a type only, so it erases on emit; the name sets `ASSET_FAMILIES` and `ASSET_KINDS`, the slug pairing `NON_EVM_NETWORK_SLUGS`, and the shape rules `assetShapeFault` with its policy `STATED_ASSET_SHAPE` are imported as the runtime values they are — the registry's own definitions — so this module and the registry's load-time gate share one statement per rule rather than keeping two in step by hand.
import { ASSET_FAMILIES, ASSET_KINDS, NON_EVM_NETWORK_SLUGS, assetFamily, assetShapeFault, requirePayableAddress, STATED_ASSET_SHAPE, type Asset, type AssetFamily, type AssetShapeFault } from "../assets/registry.js";
import { MAX_DECIMALS } from "../util/decimal.js";
import { preview } from "../util/errors.js";
import { addressShapeMessage, MAX_EVM_ADDRESS_LENGTH, isAddress, requireInvoiceAddress, type Address } from "./address.js";
import { MAX_MONERO_ADDRESS_LENGTH, requireMoneroAddress, type MoneroAddress } from "./monero-address.js";
import { MAX_ZCASH_ADDRESS_LENGTH, requireZcashAddress, type ZcashAddress } from "./zcash-address.js";

/**
 * A validated payout address, tagged by the family whose rules produced it.
 *
 * Each branch of {@link requirePayoutAddress} returns one member — the EVM branch an `Address`, the Zcash branch a `ZcashAddress`, and the Monero branch a `MoneroAddress` — so a caller that stores a validated payee address holds this union.
 * The three members are disjoint string types — an `Address` is `0x`-prefixed and no privacy-chain spelling is — so the union cannot reach the EVM-only transfer encoders without being narrowed, and the asset the value was validated against is what says which member to expect.
 */
export type PayoutAddress = Address | ZcashAddress | MoneroAddress;

/**
 * The longest payee address any family this module dispatches on accepts: the EVM validator's own length, the Zcash validator's own bound (the one `payment/schemes.ts` derives and that validator re-exports), and the Monero one's, of which the widest is a mainnet unified Zcash container.
 *
 * It is derived from those three validators' own exported bounds rather than from any one family's constant, so a reader that has to bound a payee address for display or copying — `ui/presentation.ts`'s `MAX_PAYMENT_ADDRESS_CHARS` — takes the true maximum across every accepted family and form and cannot truncate a longer address one of them admits.
 */
export const MAX_PAYOUT_ADDRESS_LENGTH: number = Math.max(MAX_EVM_ADDRESS_LENGTH, MAX_ZCASH_ADDRESS_LENGTH, MAX_MONERO_ADDRESS_LENGTH);

/**
 * The asset {@link requirePayoutAddress} validates against: one carrying the `family` whose address grammar the value is checked against.
 *
 * The registry is the one place an asset's family is stated, so a caller passes the asset it already holds and this module reads the family the registry gives it — the dispatch key is not a label the call site chooses — while an asset a caller builds itself is held to the same shape rules the loader states.
 */
export type PayoutAsset = Asset;

/** The families this module dispatches on as a refusal lists them: `evm, zcash, monero`. */
function familyList(): string {
	return Object.keys(ASSET_FAMILIES).join(", ");
}

/** The kinds this module accepts as a refusal lists them: `native, erc20`. */
function kindList(): string {
	return Object.keys(ASSET_KINDS).join(", ");
}

/**
 * Raised by {@link requirePayoutAddress} for an asset whose family this app has no address rules and no payment path for.
 *
 * A typed domain error, like `assets/registry.ts`'s `UnsupportedAssetError`: the asset is well-formed and its family is one the union can name, but nothing here can be paid in it, so the refusal is about the app's coverage rather than about the argument's shape.
 * The family it echoes is a bounded preview, so a caller-supplied string cannot inflate the refusal.
 */
export class UnsupportedPayoutFamilyError extends Error {
	constructor(family: string) {
		super(`payout-address: the asset family ${preview(family)} is not payable here — expected an asset family of ${familyList()}`);
		this.name = "UnsupportedPayoutFamilyError";
	}
}

/**
 * Raised by {@link requirePayoutAddress} for an `erc20` asset whose own contract address is missing, is not an address, or is not the EIP-55 checksummed spelling the loader admits.
 *
 * A typed domain error, like {@link UnsupportedPayoutFamilyError}: the payee address may be perfectly well-formed, and what cannot be checked is the asset it was validated against, so this is about that asset rather than about the argument's shape.
 * It exists because the EVM branch's last guard compares the recipient with the token's own contract address through `assets/registry.ts`'s `requirePayableAddress`, whose comparison reports "not equal" for anything it cannot compare — so an asset whose contract address is missing, unshaped, or wrongly cased would otherwise pass the guard that keeps funds from being sent to the token's own contract.
 */
export class UnreadableTokenContractError extends Error {
	constructor(contract: unknown) {
		super(`payout-address: cannot check a transfer against the token's own contract address — expected an erc20 asset carrying an EIP-55 checksummed 0x-prefixed 40-hex contract address, got ${preview(contract)}`);
		this.name = "UnreadableTokenContractError";
	}
}

/**
 * The `asset` as an object this module can read fields off, or its own `TypeError` naming what arrived.
 *
 * It runs before the shape rules, so a `null` or primitive asset meets this module's message rather than an engine `TypeError` from the property access that follows, and what arrived is a bounded preview.
 */
function requireAssetRecord(asset: PayoutAsset): void {
	if (asset === null || typeof asset !== "object") {
		throw new TypeError(`payout-address: expected an asset carrying a family, got ${preview(asset)}`);
	}
}

/**
 * The `value` as text, or this module's own `TypeError` naming what arrived instead.
 *
 * It runs before a privacy-chain validator, so one refusal covers both of those families rather than each validator's own text handling deciding what a `null` or a `42` looks like, and the value it names is a bounded preview, so an object whose `toString` is large cannot inflate the message.
 */
function requireAddressText(value: unknown): string {
	if (typeof value !== "string") {
		throw new TypeError(`payout-address: expected a payout address string, got ${preview(value)}`);
	}
	return value;
}

/**
 * The `value` as an EVM address string, or a `TypeError` naming what arrived through a bounded preview.
 *
 * It runs before `requireInvoiceAddress`, so it is the dispatcher's own gate for the two ways a value can be refused before its checksum is read: a value that is not a string meets this module's own clause for a payee address, and a string that is not an address meets `wallet/address.ts`'s clause, read from that module's `addressShapeMessage` rather than restated here, so the same paste is refused in the same words whichever of the two readers saw it first.
 * Both are `TypeError`s rather than domain errors, because `util/errors.ts` classes a value of the wrong shape as that error: a string that is not an address is not the shape this slot takes, exactly as `wallet/address.ts` refuses it, so the only typed domain error the EVM branch raises for a rejected value is `InvalidChecksumError`, on an address that is already well-shaped but mistyped.
 * The shared clause is rendered here with `util/errors.ts`'s `preview`, this module's own bound on a rejected value, where the module that states the clause renders it with `describe`, which escapes a string in full: a hostile paste would otherwise inflate the message this module raises, while an accepted address still reaches `requireInvoiceAddress` for the checksum check.
 */
function requireEvmAddress(value: unknown): Address {
	if (typeof value !== "string") {
		throw new TypeError(`must be a 0x-prefixed 40-hex payout address, got ${preview(value)}`);
	}
	if (!isAddress(value)) {
		throw new TypeError(addressShapeMessage(preview(value)));
	}
	return value;
}

/**
 * The refusal an asset's shape fault gets here: this module's own class for the fault, and the clause the field's rule states.
 *
 * The fault is `assets/registry.ts`'s, so which field broke which rule is decided once for both readers; this is where it is rendered in this module's terms — the asset's field named beside a bounded preview of the value, and the class each fault deserves, with `UnreadableTokenContractError` for a contract address the token-contract guard cannot read and `UnsupportedPayoutFamilyError` for a family this app has no rules for, rather than a `TypeError` about the argument's shape.
 * A family that is not a string is the one fault whose class turns on what arrived: a name this app does not carry is the coverage refusal, while a `null` or a number is a field of the wrong type, exactly as this module refused each before the rules were shared.
 */
function assetShapeError(fault: AssetShapeFault): Error {
	switch (fault.rule) {
		case "unknown-family":
			return typeof fault.stated === "string"
				? new UnsupportedPayoutFamilyError(fault.stated)
				: new TypeError(`payout-address: expected an asset family of ${familyList()}, got ${preview(fault.stated)}`);
		case "unknown-kind":
			return new TypeError(`payout-address: expected an asset kind of ${kindList()}, got ${preview(fault.stated)}`);
		case "non-native-kind":
			return new TypeError(`payout-address: the ${fault.family} asset states the field kind as ${preview(fault.stated)}, and a non-EVM asset must state it as "native"`);
		case "non-evm-contract-address":
			return new TypeError(`payout-address: the ${fault.family} asset carries the field address ${preview(fault.stated)}, and a non-EVM asset must carry no contract address`);
		case "non-canonical-chain-id":
			return new TypeError(`payout-address: the ${fault.family} asset states the field chainId as ${preview(fault.stated)}, and an EVM asset must state a canonical EVM chain id like "0x1"`);
		case "foreign-network-slug":
			return new TypeError(`payout-address: the ${fault.family} asset states the field chainId as ${preview(fault.stated)}, and a non-EVM asset must state the ${fault.family} network slug ${preview(NON_EVM_NETWORK_SLUGS[fault.family as keyof typeof NON_EVM_NETWORK_SLUGS])}`);
		case "invalid-decimals":
			return new TypeError(`payout-address: the asset states the field decimals as ${preview(fault.stated)}, and an asset must state its decimals as an integer from 0 to ${MAX_DECIMALS}`);
		case "native-contract-address":
			return new TypeError(`payout-address: expected a native asset carrying no contract address, got ${preview(fault.stated)}`);
		case "unshaped-contract-address":
		case "unchecksummed-contract-address":
			return new UnreadableTokenContractError(fault.stated);
	}
}

/**
 * Validate `value` as a payout address for `asset`, returning the form its family's encoders and builders expect.
 *
 * An `asset` that is not an object is refused before a field of it is read, and one whose stated shape contradicts the family it states — or that states a `decimals` the loader's rule refuses — is refused before a branch runs, by `assets/registry.ts`'s `assetShapeFault` under `STATED_ASSET_SHAPE`, so a non-EVM asset carrying a contract address, an EVM asset whose stated kind is missing or unknown, a stated network that is not the family's own, and a stated `decimals` outside the loader's range each meet this module's refusal rather than reaching a family's grammar.
 * The EVM family reads the value through its own gate before those rules run, which is the order this module has always applied: a paste that is not an address is refused as that even where the asset it was read against states a shape the guard could not read, so an asset whose kind is unstated meets the kind refusal for an address the branch could otherwise act on. The branch reads the address through the same gate again, which cannot refuse it a second time.
 * A `value` that is not a string is refused before a privacy-chain branch's validator sees it — the EVM branch with this module's own payee-address clause, which `invoice/model.ts` wraps under the field path it read the value from, the others with this module's message.
 * The EVM branch keeps the invoice path's two guards in order: `requireInvoiceAddress` refuses a mixed-case address whose EIP-55 checksum contradicts it and returns the checksummed spelling, then `requirePayableAddress` refuses the zero address and, for an ERC-20, the token's own contract address — with an `erc20` asset required to spell its own contract address as the loader's EIP-55 checksummed address before that second guard runs.
 * The Zcash branch takes the mainnet transparent, Sapling, and unified forms of `wallet/zcash-address.ts` — a mainnet `u1` container is accepted on its Bech32m checksum, human-readable part, and length, and a testnet `utest1` one is refused by name — and the Monero branch the mainnet standard, subaddress, and integrated encodings of `wallet/monero-address.ts`; their typed errors pass through unchanged, for the caller to report against the field it read the value from.
 */
export function requirePayoutAddress(value: unknown, asset: PayoutAsset): PayoutAddress {
	requireAssetRecord(asset);
	if (assetFamily(asset) === "evm") {
		requireEvmAddress(value);
	}
	const fault = assetShapeFault(asset, STATED_ASSET_SHAPE);
	if (fault !== null) {
		throw assetShapeError(fault);
	}
	switch (assetFamily(asset) as AssetFamily) {
		case "evm": {
			const checksummed = requireInvoiceAddress(requireEvmAddress(value));
			requirePayableAddress(checksummed, asset);
			return checksummed;
		}
		case "zcash":
			return requireZcashAddress(requireAddressText(value));
		case "monero":
			return requireMoneroAddress(requireAddressText(value));
	}
}
