/**
 * The asset and chain registry: the single source of truth for what this app can be paid in.
 *
 * One entry per asset, keyed by the lower-case id an invoice stores, together with the network it is paid on and the payment `family` whose address rules and payment path its invoices use.
 * The asset picker, the invoice validator, the payment planner, and the network list all derive from here, so a new asset is one entry and nothing else, while a network is the one thing an entry here cannot state for itself: a network's payer-visible name is `ui/network-labels.ts`'s own label statement, and that module refuses to load while a network the registry supports has no name there, so a new EVM chain takes a `CHAIN_NAMES` entry beside its first asset entry in that module rather than being able to render as its raw id.
 * {@link validateRegistry} runs at module load and rejects an entry that would otherwise surface later as a mysterious payment failure, and the shape rules it applies are {@link assetShapeFault}, the same statement `wallet/payout-address.ts`'s dispatcher applies to the structural assets its callers build.
 */

import { MAX_DECIMALS } from "../util/decimal.js";
import { describe } from "../util/errors.js";
import {
	addressesEqual,
	isAddress,
	isZeroAddress,
	normalizeAddress,
	toChecksumAddress,
	type Address,
} from "../wallet/address.js";

/** A `0x`-prefixed chain id, e.g. `"0x1"` for Ethereum mainnet. */
export type ChainId = `0x${string}`;

/**
 * Whether an asset is a chain's own coin or an ERC-20 contract token.
 *
 * The token-contract guard keeps a transfer from being sent to the token's own contract address, and it reads this kind: an entry that states none is read as the one its own fields imply through {@link assetKind}, which is the resolution both the guard and the load-time gate apply.
 */
export type AssetKind = "native" | "erc20";

/**
 * The payment family an asset belongs to: the injected-wallet EVM flow, or one of the two privacy chains whose invoices are paid by link and QR only.
 *
 * `wallet/payout-address.ts`'s `requirePayoutAddress` dispatches on it to pick the rules that validate a payee address, so the union is declared here with the registry rather than in the wallet layer that reads it.
 * Every entry states its own family, and that statement is what the dispatcher reads: the family is part of what an asset is, not a label attached at the call that validates an address against it.
 * An entry that states none is read as {@link DEFAULT_ASSET_FAMILY} through {@link assetFamily}, which is the resolution both the load-time gate and the dispatcher apply, and every reader that acts on a family rather than judging one reads it through {@link requireAssetFamily}, which applies that same resolution and refuses a name no family rule carries.
 */
export type AssetFamily = "evm" | "zcash" | "monero";

/** Every family {@link AssetFamily} names except the EVM one: the families paid by link and QR rather than through an injected wallet. */
type NonEvmFamily = Exclude<AssetFamily, "evm">;

/**
 * The one network slug each non-EVM family is paid on, keyed by that family: a Zcash family on the `zcash` network, a Monero family on the `monero` one.
 *
 * The two names coincide today, but they are separate statements — the family picks the address rules and the payment path, the slug is the network an invoice names — so the pairing is spelled here once, and both readers hold an entry to it rather than each entry repeating a slug that could then disagree with the family it states: {@link validateRegistry} for the entries it loads, and `wallet/payout-address.ts`'s dispatcher for the structural assets its callers build.
 * The mapped type keys each family to its own slug, so a cross-wired pairing — the `zcash` family on the `monero` slug — is a type error where the map is written rather than a value only a load-time check could reach.
 * These slugs are the non-EVM half of {@link NetworkId}, which is derived from this map rather than spelled a second time, so a family paired here with a slug is one an invoice may name without a further edit to the union.
 */
export const NON_EVM_NETWORK_SLUGS = { zcash: "zcash", monero: "monero" } as const satisfies { readonly [Family in NonEvmFamily]: Family };

/**
 * The network an asset is paid on: an EVM chain id, or the non-EVM network slug the family an entry states is paired with.
 *
 * The wire format is unchanged — an invoice still carries its network under the `chainId` key — so this union is what that key may hold, and {@link ChainId} stays the EVM half of it, the `0x` quantity a wallet can be asked to switch to.
 * The non-EVM half is read off {@link NON_EVM_NETWORK_SLUGS} rather than spelled again, so a network slug cannot exist in the map and be rejected by this type: a family added to {@link AssetFamily} with its slug in the map widens the union with it, and the mapped type that map is written against keeps each family on its own slug.
 */
export type NetworkId = ChainId | (typeof NON_EVM_NETWORK_SLUGS)[NonEvmFamily];

/**
 * The families {@link AssetFamily} names, as the runtime set {@link validateRegistry} checks an entry against and the one definition of the name set `wallet/payout-address.ts` dispatches on.
 *
 * `satisfies Record<AssetFamily, true>` refuses a name this map does not carry and a union member it omits, so the family names the app dispatches on and the union that types them cannot drift apart, and the dispatcher sources the same object for the families it accepts rather than repeating the list.
 */
export const ASSET_FAMILIES = { evm: true, zcash: true, monero: true } as const satisfies Record<AssetFamily, true>;

/**
 * The kinds {@link AssetKind} names, as the runtime set {@link validateRegistry} checks an entry against and the one definition of the name set `wallet/payout-address.ts`'s token-contract guard classifies.
 *
 * The dispatcher's token-contract guard is keyed on `kind`, so a kind no rule knows is one the guard would silently skip; `satisfies Record<AssetKind, true>` keeps the accepted names and the union in step, and the guard sources the same object rather than repeating the list.
 */
export const ASSET_KINDS = { native: true, erc20: true } as const satisfies Record<AssetKind, true>;

/** The EVM family: the chain coin and its contract tokens, paid through the injected wallet rather than by link and QR, and the one family whose entries may be `erc20`. */
const EVM_FAMILY: AssetFamily = "evm";

/** The family an entry that states none is taken to belong to: the injected-wallet EVM flow every entry predating the field is on. */
const DEFAULT_ASSET_FAMILY: AssetFamily = EVM_FAMILY;

/** The kind an entry that states none and carries no contract address is taken to be: the chain's own coin, which is sent to a recipient directly rather than through a contract. */
const DEFAULT_ASSET_KIND: AssetKind = "native";

/**
 * The family `entry` belongs to: the `family` it states, or {@link DEFAULT_ASSET_FAMILY} when the field is absent.
 *
 * This is the one place the default is applied, and both readers go through it — {@link validateRegistry} when it admits an entry at load, and `wallet/payout-address.ts`'s dispatcher when it picks the address rules for an asset — so the gate cannot bless a family-less entry the dispatcher then refuses.
 * Only an absent field is a family-less entry: a `family` that is present but is not a string — an explicit `null` included, which the `!== undefined` test keeps distinct from an absent field — is a statement the entry does make, so it is returned as it stands for the reader to refuse rather than read as the absence of a statement.
 * The result is `unknown`, because an entry a caller built outside this module can state anything: each reader judges what it got and refuses it in its own terms, and a family that is neither a known name nor absent is still refused at load.
 * A reader that must act on the family — rather than report what is wrong with it — reads it through {@link requireAssetFamily}, which does that judging once for every such reader.
 */
export function assetFamily(entry: { readonly family?: unknown }): unknown {
	if (entry.family !== undefined) return entry.family;
	return DEFAULT_ASSET_FAMILY;
}

/** Raised by {@link requireAssetFamily} for an asset that states a family this app has no address rules and no payment path for. */
export class UnsupportedAssetFamilyError extends Error {
	constructor(stated: unknown) {
		super(`assets: unsupported asset family ${describe(stated)} — expected one of ${Object.keys(ASSET_FAMILIES).join(", ")}`);
		this.name = "UnsupportedAssetFamilyError";
	}
}

/**
 * The family `entry` belongs to, as a name this app has rules for, or an {@link UnsupportedAssetFamilyError} when it states one it does not.
 *
 * This is the resolution every reader that acts on a family goes through, and it is the one that reports a name no rule carries: `payment/links.ts` picks a link's scheme with it and `wallet/payment.ts`'s `buildPaymentPlan` names with it the family no injected wallet pays, so the two cannot read a family one of them knows and the other refuses.
 * The reader that only judges a family — `wallet/payment.ts`'s total `isWalletPayable`, which answers false rather than raising — reads the same resolution in its unrefusing form, {@link assetFamily}, and applies the same default an absent field takes.
 * The default an absent field takes is {@link assetFamily}'s, and the name set is {@link isAssetFamily}'s, so a family-less asset is the EVM one here exactly as it is at the registry's load-time gate and a name the gate refuses is refused here too.
 * Refusing rather than returning whatever the entry stated is the point: a reader that switched on an unresolved value would fall out of its own cases and hand back `undefined` for an asset it never admitted.
 */
export function requireAssetFamily(entry: { readonly family?: unknown }): AssetFamily {
	const family = assetFamily(entry);
	if (!isAssetFamily(family)) {
		throw new UnsupportedAssetFamilyError(family);
	}
	return family;
}

/**
 * The kind `entry` belongs to: the `kind` it states, or the one its own fields imply when it states none.
 *
 * This is the one place an absent kind is resolved, and both readers of the kind go through it — {@link requirePayableAddress}, whose token-contract check is the funds-locking guard, and `wallet/payout-address.ts`'s dispatcher, which refuses an `erc20` whose own contract address cannot be read before that check runs — so neither can be skipped by an entry that omits the field: an entry carrying a contract address is read as an `erc20`, and one carrying none as {@link DEFAULT_ASSET_KIND}, a coin with no contract for either reader to compare a recipient against.
 * The registry's own `Asset` union draws the same line, typing a token by a present contract address and a coin by its absence, so the resolution follows the types rather than adding a rule of its own.
 * The result is `unknown`, because an entry a caller built outside this module can state anything: a kind that is neither a known name nor absent is passed through for each reader to refuse in its own terms.
 */
export function assetKind(entry: { readonly kind?: unknown; readonly address?: unknown }): unknown {
	if (entry.kind !== undefined) return entry.kind;
	return entry.address == null ? DEFAULT_ASSET_KIND : "erc20";
}

interface AssetBase {
	/** Lower-case registry key, used by invoices and the asset picker. */
	readonly id: string;
	readonly symbol: string;
	readonly name: string;
	/** The network this asset is paid on: an EVM chain id, or the non-EVM network slug its family spells. */
	readonly chainId: NetworkId;
	readonly decimals: number;
	/** The payment family whose address rules and payment path this asset's invoices use. */
	readonly family: AssetFamily;
}

/** The chain's own coin, which has no contract address to transfer to. */
export interface NativeAsset extends AssetBase {
	readonly kind: "native";
	readonly address?: null;
}

/** A contract token, whose address is always a present, checksummed contract address. */
export interface Erc20Asset extends AssetBase {
	readonly kind: "erc20";
	readonly address: Address;
}

/**
 * A supported asset, discriminated on `kind`.
 * Narrowing on `asset.kind === "erc20"` yields a non-null {@link Address}, so a native coin (whose address is absent) cannot reach ERC-20 calldata.
 */
export type Asset = NativeAsset | Erc20Asset;

/**
 * The supported assets.
 * Every entry is keyed by the lower-case id an invoice stores as its `asset`; a new token is one entry here, while a new EVM chain additionally needs a `CHAIN_NAMES` entry in `app/ts/ui/network-labels.ts` — the module that owns the payer-visible names and refuses at load, through `requireNamedNetworks`, to let a supported network render as its raw id.
 * The two privacy-chain entries are the chain's own coin paid on its own network slug, so each carries `kind: "native"` and no contract address.
 */
const REGISTRY = {
	eth: {
		id: "eth",
		symbol: "ETH",
		name: "Ether",
		chainId: "0x1",
		decimals: 18,
		family: "evm",
		kind: "native",
		address: null,
	},
	usdc: {
		id: "usdc",
		symbol: "USDC",
		name: "USD Coin",
		chainId: "0x1",
		decimals: 6,
		family: "evm",
		kind: "erc20",
		address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
	},
	usdt: {
		id: "usdt",
		symbol: "USDT",
		name: "Tether USD",
		chainId: "0x1",
		decimals: 6,
		family: "evm",
		kind: "erc20",
		address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
	},
	zec: {
		id: "zec",
		symbol: "ZEC",
		name: "Zcash",
		chainId: "zcash",
		decimals: 8,
		family: "zcash",
		kind: "native",
		address: null,
	},
	xmr: {
		id: "xmr",
		symbol: "XMR",
		name: "Monero",
		chainId: "monero",
		decimals: 12,
		family: "monero",
		kind: "native",
		address: null,
	},
} as const satisfies Record<string, Asset>;

// Object.freeze(REGISTRY) alone is shallow, so without this a runtime write could retarget ASSET_REGISTRY.usdc.address and send funds elsewhere.
// Every field is a primitive, so freezing each entry once — before the registry is exposed — is a complete deep freeze.
for (const asset of Object.values(REGISTRY)) {
	Object.freeze(asset);
}

/** Every asset id the app knows about; derived from the registry, so it grows with it. */
export type AssetId = keyof typeof REGISTRY;

/** The frozen registry, keyed by the lower-case asset id an invoice stores. */
export const ASSET_REGISTRY = Object.freeze(REGISTRY);

/** Registry order, for building an asset picker. */
export const ASSETS = Object.freeze(Object.values(REGISTRY));

/** Every network the registry can pay on, deduplicated and in registry order. */
export const SUPPORTED_CHAIN_IDS: readonly NetworkId[] = Object.freeze([...new Set(ASSETS.map((asset) => asset.chainId))]);

/** A canonical lower-case chain id: `0x` then `0` or a non-zero-leading lower-case quantity. */
const CHAIN_ID_PATTERN = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;

/**
 * True for a canonical EVM chain id, narrowing it to {@link ChainId}.
 *
 * This is the one statement of the shape a chain id has to be in, and both readers of it go through it: {@link assetShapeFault}, for the shape an entry or a caller-built asset states, so an entry the gate admits for stating a canonical id is not one the dispatcher then refuses, nor the other way round.
 */
export function isCanonicalEvmChainId(value: unknown): value is ChainId {
	return typeof value === "string" && CHAIN_ID_PATTERN.test(value);
}

/**
 * True for a name {@link AssetKind} carries, narrowing it to `AssetKind`.
 *
 * This is the one statement of the kind name set, and both readers of a kind go through it: {@link validateRegistry}, for the entries the registry loads, and `wallet/payout-address.ts`'s token-contract guard, for the structural assets its callers build — so a kind the gate admits for being one of the names is not one the dispatcher then refuses, nor the other way round.
 */
export function isAssetKind(value: unknown): value is AssetKind {
	return typeof value === "string" && Object.hasOwn(ASSET_KINDS, value);
}

/**
 * True for a name {@link AssetFamily} carries, narrowing it to `AssetFamily`.
 *
 * This is the one statement of the family name set, and every reader of an asset's family goes through it: {@link assetShapeFault}, for the shape an entry or a caller-built asset states, {@link requireAssetFamily}, for the family a reader acts on, and `ui/create.ts`'s payout-address hint, for the family whose forms it names — so a family the gate admits for being one of the names is not one a reader then refuses, nor the other way round.
 * A name that resolves through `Object.prototype` — `"constructor"`, for one — is not a family, exactly as it is not a chain name or a registry key.
 */
export function isAssetFamily(value: unknown): value is AssetFamily {
	return typeof value === "string" && Object.hasOwn(ASSET_FAMILIES, value);
}

/**
 * True for a contract address the loader admits: a `0x`-prefixed 40-hex address spelled exactly as its own EIP-55 checksum requires.
 *
 * This is the one statement of the contract-address rule, and both readers of a contract address go through it: {@link validateRegistry}, for the entries the registry loads, and `wallet/payout-address.ts`'s token-contract guard, for the structural assets its callers build — so a contract address the gate admits is not one the dispatcher then refuses, nor the other way round.
 * A uniformly-cased address is a well-formed address that carries no checksum, so it is not one this predicate admits.
 */
export function isChecksummedContractAddress(value: unknown): value is Address {
	return isAddress(value) && value === toChecksumAddress(value);
}

/**
 * True for a decimals count the loader admits: a non-negative safe integer no greater than {@link MAX_DECIMALS}.
 *
 * This is the one statement of the decimals rule, and both readers of an asset's decimals go through it: {@link validateRegistry}, for the entries the registry loads, and `wallet/payout-address.ts`'s dispatcher, for the structural assets its callers build — so a decimals count the gate admits is not one the dispatcher then refuses, nor the other way round.
 */
export function isValidAssetDecimals(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_DECIMALS;
}

/** The asset fields the family-shape rules read: the family an asset states, and the fields that family constrains. */
export type AssetShapeField = "family" | "kind" | "address" | "chainId" | "decimals";

/** The fields {@link assetShapeFault} reads off one asset, as the structural assets a caller builds carry them. */
export interface StatedAssetShape {
	readonly family?: unknown;
	readonly kind?: unknown;
	readonly address?: unknown;
	readonly chainId?: unknown;
	readonly decimals?: unknown;
}

/** The rules an asset's stated shape can break, one per way a field can contradict the family beside it. */
export type AssetShapeRule =
	| "unknown-family"
	| "unknown-kind"
	| "non-native-kind"
	| "non-evm-contract-address"
	| "non-canonical-chain-id"
	| "foreign-network-slug"
	| "invalid-decimals"
	| "native-contract-address"
	| "unshaped-contract-address"
	| "unchecksummed-contract-address";

/**
 * One way an asset's stated shape contradicts the family it belongs to: the field at fault, the value the asset states for it, and the rule that refused it.
 * A fault other than `unknown-family` carries the family the asset's own field resolves to, so a reader's message can name the family the field contradicts.
 */
export type AssetShapeFault =
	| { readonly rule: "unknown-family"; readonly field: "family"; readonly stated: unknown }
	| {
		readonly rule: Exclude<AssetShapeRule, "unknown-family">;
		readonly field: AssetShapeField;
		readonly stated: unknown;
		readonly family: AssetFamily;
	};

/**
 * Which of an asset's fields a reader requires to be stated as well as well-formed.
 *
 * {@link assetShapeFault} judges the value a field states; whether the field has to be there at all is the reader's own requirement, and it is stated as one of these rather than left implicit at each call site, so the two readers of an asset's shape cannot hold it to different field sets by accident.
 */
export interface AssetShapePolicy {
	requires(field: AssetShapeField, family: AssetFamily): boolean;
}

/**
 * The policy a registry entry is held to: every field a shape rule reads is stated.
 *
 * An entry describes a whole asset — its kind, its network, its decimals — so a field it leaves out is the malformed entry {@link validateRegistry} reports rather than a field with nothing to say, exactly as this gate has always required.
 */
export const COMPLETE_ASSET_SHAPE: AssetShapePolicy = { requires: () => true };

/**
 * The policy a caller-built asset the payout-address dispatcher is handed is held to: the fields it states, beside the kind an EVM asset must state.
 *
 * Such an asset carries what its reader reads, so an absent `chainId` or `decimals` is a field it makes no statement about rather than a malformed one; the kind is required of an EVM asset because `wallet/payout-address.ts`'s token-contract guard is keyed on it, and inferring it from a contract address is how a token's own contract would reach that guard unclassified.
 */
export const STATED_ASSET_SHAPE: AssetShapePolicy = { requires: (field, family) => family === EVM_FAMILY && field === "kind" };

/**
 * Why the shape `asset` states contradicts the family it belongs to, or `null` when the two agree.
 *
 * This is the one statement of the family-shape rules, and both readers of an asset's shape apply it: {@link validateRegistry}, for the entries the registry loads, and `wallet/payout-address.ts`'s dispatcher, for the structural assets its callers build — so an asset one admits for its shape is not one the other refuses.
 * The rules are what each family's own payment path requires: a non-EVM family pays its chain's own coin over that family's address grammar, so its kind must be `native`, it must carry no contract address, and it must state the network slug `NON_EVM_NETWORK_SLUGS` pairs it with; an EVM asset must state a canonical `0x` chain id; an `erc20` must spell its contract address as the EIP-55 checksummed address the loader admits, and a `native` must carry none; and a stated `decimals` must be the integer from 0 to `util/decimal.ts`'s `MAX_DECIMALS` the loader admits.
 * `policy` says which fields must be stated at all — {@link COMPLETE_ASSET_SHAPE} for a registry entry, {@link STATED_ASSET_SHAPE} for a partial asset — and a field the policy does not require is judged only when the asset states it, so an absent field makes no statement to contradict while an entry that leaves one out meets the fault its own rule reports for a value that cannot satisfy it.
 * One fault is returned rather than all of them: the first the rules find, in the order the fields are read above, so a reader reports what is wrong with the field rather than everything wrong with the asset.
 */
export function assetShapeFault(asset: StatedAssetShape, policy: AssetShapePolicy): AssetShapeFault | null {
	const statedFamily = assetFamily(asset);
	if (!isAssetFamily(statedFamily)) {
		return { rule: "unknown-family", field: "family", stated: statedFamily };
	}
	const family = statedFamily;
	const kind = asset.kind;
	if (kind !== undefined || policy.requires("kind", family)) {
		if (!isAssetKind(kind)) {
			return { rule: "unknown-kind", field: "kind", stated: kind, family };
		}
		if (family !== EVM_FAMILY && kind !== "native") {
			return { rule: "non-native-kind", field: "kind", stated: kind, family };
		}
	}
	if (family !== EVM_FAMILY && asset.address != null) {
		return { rule: "non-evm-contract-address", field: "address", stated: asset.address, family };
	}
	const chainId = asset.chainId;
	if (chainId !== undefined || policy.requires("chainId", family)) {
		if (family === EVM_FAMILY) {
			if (!isCanonicalEvmChainId(chainId)) {
				return { rule: "non-canonical-chain-id", field: "chainId", stated: chainId, family };
			}
		} else if (chainId !== NON_EVM_NETWORK_SLUGS[family as NonEvmFamily]) {
			return { rule: "foreign-network-slug", field: "chainId", stated: chainId, family };
		}
	}
	const decimals = asset.decimals;
	if (decimals !== undefined || policy.requires("decimals", family)) {
		if (!isValidAssetDecimals(decimals)) {
			return { rule: "invalid-decimals", field: "decimals", stated: decimals, family };
		}
	}
	if (kind === "native" && asset.address != null) {
		return { rule: "native-contract-address", field: "address", stated: asset.address, family };
	}
	if (kind === "erc20") {
		if (!isAddress(asset.address)) {
			return { rule: "unshaped-contract-address", field: "address", stated: asset.address, family };
		}
		if (!isChecksummedContractAddress(asset.address)) {
			return { rule: "unchecksummed-contract-address", field: "address", stated: asset.address, family };
		}
	}
	return null;
}

/** Raised by {@link requireAsset} when an id is not a key of {@link ASSET_REGISTRY}; the message names the ids that are. */
export class UnsupportedAssetError extends Error {
	constructor(id: string) {
		super(`assets: unsupported asset ${describe(id)} — expected one of ${Object.keys(ASSET_REGISTRY).join(", ")}`);
		this.name = "UnsupportedAssetError";
	}
}

/** Raised by {@link requireChain} when a network is not in {@link SUPPORTED_CHAIN_IDS}; the message names the networks that are. */
export class UnsupportedChainError extends Error {
	constructor(chainId: string) {
		super(`assets: unsupported chain ${describe(chainId)} — expected one of ${SUPPORTED_CHAIN_IDS.join(", ")}`);
		this.name = "UnsupportedChainError";
	}
}

/** Raised by {@link requireEvmChain} for a supported network that is not an EVM chain, so no wallet can be asked to pay on it. */
export class UnsupportedEvmChainError extends Error {
	constructor(networkId: string) {
		super(`assets: unsupported chain ${describe(networkId)} — expected an EVM chain, one of ${SUPPORTED_EVM_CHAIN_IDS.join(", ")}`);
		this.name = "UnsupportedEvmChainError";
	}
}

/** Raised by {@link requirePayableAddress} for a recipient a transfer must not target. */
export class UnpayableAddressError extends Error {
	constructor(address: string, reason: string) {
		super(`assets: ${describe(address)} cannot receive a transfer — ${reason}`);
		this.name = "UnpayableAddressError";
	}
}

/** True when `id` is a key of {@link ASSET_REGISTRY}, narrowing it to {@link AssetId}. */
export function isSupportedAsset(id: string): id is AssetId {
	return Object.prototype.hasOwnProperty.call(ASSET_REGISTRY, id);
}

/** The asset for `id`, or `undefined` when the registry does not carry it. */
export function getAsset(id: string): Asset | undefined {
	return isSupportedAsset(id) ? ASSET_REGISTRY[id] : undefined;
}

/** The asset for `id`, or an {@link UnsupportedAssetError} when the registry does not carry it. */
export function requireAsset(id: string): Asset {
	const asset = getAsset(id);
	if (asset === undefined) {
		throw new UnsupportedAssetError(id);
	}
	return asset;
}

/**
 * Fail closed before a transfer is encoded.
 * The recipient must be an address and must not be the zero address (a transfer there is burned) nor — for an ERC-20 — the token's own contract address (which locks the funds).
 * The kind that decides the last check is read through {@link assetKind}, so an asset a caller built without one cannot skip it by carrying a contract address the entry never classified: an address makes the entry a token here as it does in `wallet/payout-address.ts`'s token-contract guard.
 * Returns the lower-case address `wallet/erc20.ts`'s `encodeTransfer` expects; route untrusted text through `wallet/address.ts`'s `requireInvoiceAddress` first to reject a bad checksum.
 */
export function requirePayableAddress(recipient: unknown, asset: Asset): Address {
	const address = normalizeAddress(recipient);
	if (isZeroAddress(address)) {
		throw new UnpayableAddressError(address, "the zero address burns the transfer");
	}
	if (assetKind(asset) === "erc20" && addressesEqual(address, asset.address)) {
		throw new UnpayableAddressError(address, "it is the token's own contract address");
	}
	return address;
}

/** True when `chainId` is one of {@link SUPPORTED_CHAIN_IDS}, narrowing it to {@link NetworkId}. */
export function isSupportedChain(chainId: string): chainId is NetworkId {
	return (SUPPORTED_CHAIN_IDS as readonly string[]).includes(chainId);
}

/** The network id unchanged, or an {@link UnsupportedChainError} when the registry does not support it. */
export function requireChain(chainId: string): NetworkId {
	if (!isSupportedChain(chainId)) {
		throw new UnsupportedChainError(chainId);
	}
	return chainId;
}

/** True for the EVM half of {@link NetworkId}: a canonical `0x` quantity, which is what an EVM chain id is and what no network slug is. */
function isEvmChainId(networkId: NetworkId): networkId is ChainId {
	return isCanonicalEvmChainId(networkId);
}

/** Every EVM chain id the registry supports, in registry order; a privacy chain's network slug is not one. */
export const SUPPORTED_EVM_CHAIN_IDS: readonly ChainId[] = Object.freeze(SUPPORTED_CHAIN_IDS.filter(isEvmChainId));

/**
 * The EVM chain id of a supported EVM network, or the error that says why this network id cannot be paid through a wallet.
 *
 * The one caller that needs a {@link ChainId} rather than a {@link NetworkId} — the injected-wallet flow, which asks the wallet to switch to that chain and encodes it into transaction params — reads its network through here, so a privacy chain's slug is refused by name before any EVM logic runs.
 * An unsupported network keeps {@link UnsupportedChainError}, the same refusal {@link requireChain} raises for one, so a caller sees one error class per kind of mistake: an unknown network, or a known network that is not an EVM chain.
 */
export function requireEvmChain(networkId: NetworkId): ChainId {
	if (!isSupportedChain(networkId)) {
		throw new UnsupportedChainError(networkId);
	}
	if (!isEvmChainId(networkId)) {
		throw new UnsupportedEvmChainError(networkId);
	}
	return networkId;
}

/** Every supported asset on `chainId`, in registry order (empty when none). */
export function assetsOnChain(chainId: string): readonly Asset[] {
	return ASSETS.filter((asset) => asset.chainId === chainId);
}

/**
 * True when `networkId` is the network `asset` lives on: the one statement of the rule that an invoice pays an asset on the network that asset belongs to.
 *
 * Three readers apply that rule — the invoice validator's own chain field, the link builder, and the injected-wallet planner — and each reports a mismatch in its own terms, so the comparison they share lives here rather than being restated beside each refusal.
 */
export function isAssetNetwork(networkId: string, asset: Asset): boolean {
	return networkId === asset.chainId;
}

function firstSupportedChain(): NetworkId {
	const chainId = SUPPORTED_CHAIN_IDS[0];
	if (chainId === undefined) {
		throw new Error("assets: the registry defines no supported chain to default to");
	}
	return chainId;
}

/** The network new invoices default to — derived from the supported set, so it cannot drift from it. */
export const DEFAULT_CHAIN_ID: NetworkId = firstSupportedChain();

/**
 * The refusal {@link validateRegistry} reports a shape fault with: the entry's key, the rule the asset's own fields broke, and the value that broke it.
 *
 * The wording is this load-time gate's own — it names the entry by key, where the payout-address dispatcher names the asset and the field a pasted value was read against — so the rule set the two share is one statement while each reader reports it in its own terms.
 */
function entryShapeRefusal(key: string, fault: AssetShapeFault): string {
	switch (fault.rule) {
		case "unknown-family":
			return `assets: ${key} has an unknown family ${describe(fault.stated)} — expected one of ${Object.keys(ASSET_FAMILIES).join(", ")}, or no family for the default ${DEFAULT_ASSET_FAMILY}`;
		case "unknown-kind":
			return `assets: ${key} has an unknown kind ${describe(fault.stated)} — expected one of ${Object.keys(ASSET_KINDS).join(", ")}`;
		case "non-native-kind":
			return `assets: ${key} states the non-EVM family ${describe(fault.family)} with kind ${describe(fault.stated)} — a non-EVM asset must be kind "native"`;
		case "non-evm-contract-address":
			return `assets: ${key} states the non-EVM family ${describe(fault.family)} with a contract address ${describe(fault.stated)} — a non-EVM asset must carry no contract address`;
		case "non-canonical-chain-id":
			return `assets: ${key} has a non-canonical chain id ${describe(fault.stated)} — expected a 0x-prefixed lower-case quantity like "0x1"`;
		case "foreign-network-slug":
			return `assets: ${key} states the ${fault.family} family on the network ${describe(fault.stated)} — expected the ${fault.family} network slug ${describe(NON_EVM_NETWORK_SLUGS[fault.family as NonEvmFamily])}`;
		case "invalid-decimals":
			return `assets: ${key} has invalid decimals ${String(fault.stated)}`;
		case "native-contract-address":
			return `assets: native ${key} must not carry a contract address`;
		case "unshaped-contract-address":
			return `assets: ${key} needs a 0x-prefixed 40-hex contract address`;
		case "unchecksummed-contract-address":
			return `assets: ${key} address must be EIP-55 checksummed, expected ${toChecksumAddress(fault.stated)}, got ${String(fault.stated)}`;
	}
}

/**
 * Reject a registry entry that would only surface later as a mysterious payment failure.
 *
 * The entry's own shape is checked before any of its fields is read, so a `null` entry, a non-string `id`, an address that is not text, and a `chainId` that is not text are reported by this validator rather than by an engine `TypeError` from the property access or the coercion that follows it.
 * The family-shape rules themselves are {@link assetShapeFault} with {@link COMPLETE_ASSET_SHAPE}, the same statement `wallet/payout-address.ts`'s dispatcher applies to the structural assets its callers build, so an entry this gate admits for its shape is not one the dispatcher then refuses: the network an entry states is held to the shape its family spells — an EVM entry's canonical `0x` quantity, a non-EVM entry's own slug, `NON_EVM_NETWORK_SLUGS` being the single source for that pair — its `kind` is one {@link AssetKind} names and the one its family pays, its contract address is the EIP-55 checksummed spelling its kind requires or absent as its kind requires, and its `decimals` is within the range `util/decimal.ts` admits.
 * One rule the dispatcher does not restate is applied here alone: an entry states every field its shape depends on, which is what {@link COMPLETE_ASSET_SHAPE} requires and what a caller-built asset carrying only what its reader reads need not.
 * A duplicate `(chainId, address)` pair means two registry ids compete to pay the same target, so the pair is the transfer target a wallet sends to, read as the entry states its network id: one native coin per chain, and no two entries paying the same contract.
 * That key is EVM transfer-target semantics, and it stays keyed as the entries state their networks — a non-EVM entry's slug and absent contract address make it `zcash:` or `monero:`, which no other entry's key can be, so the privacy-chain entries collide with nothing and only two entries claiming one EVM target are refused.
 * Exported so a test can drive a deliberately-broken registry; the shipped one is validated at the bottom of this module.
 */
export function validateRegistry(registry: Readonly<Record<string, Asset>>): void {
	const transferTargets = new Set<string>();
	for (const [key, asset] of Object.entries(registry)) {
		if (asset === null || typeof asset !== "object") {
			throw new Error(`assets: registry entry ${describe(key)} must be an asset object, got ${describe(asset)}`);
		}
		if (typeof asset.id !== "string") {
			throw new Error(`assets: registry entry ${describe(key)} must carry a string id, got ${describe(asset.id)}`);
		}
		if (asset.id !== key) {
			throw new Error(`assets: registry key "${key}" does not match the asset id "${asset.id}"`);
		}
		const statedAddress: unknown = asset.address;
		if (statedAddress != null && typeof statedAddress !== "string") {
			throw new Error(`assets: ${key} has a non-string address ${describe(statedAddress)} — expected a contract address string, or null for a native asset`);
		}
		// The pair is read as the entry states it — a lower-case spelling of a checksummed address is the same target — and it is checked before the shape rules, so two ids competing to pay one target are reported as that rather than as whichever field the second entry also got wrong.
		const target = `${asset.chainId}:${asset.address == null ? "" : asset.address.toLowerCase()}`;
		if (transferTargets.has(target)) {
			throw new Error(`assets: ${key} duplicates the (chainId, address) pair ${asset.chainId}/${asset.address ?? "(native)"}`);
		}
		transferTargets.add(target);
		const fault = assetShapeFault(asset, COMPLETE_ASSET_SHAPE);
		if (fault !== null) {
			throw new Error(entryShapeRefusal(key, fault));
		}
	}
}

validateRegistry(ASSET_REGISTRY);
