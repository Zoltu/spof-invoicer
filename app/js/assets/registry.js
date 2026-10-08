/**
 * The asset and chain registry: the single source of truth for what this app can be paid in.
 *
 * One entry per asset, keyed by the lower-case id an invoice stores, and the chain ids they imply.
 * The asset picker, the invoice validator, the payment planner, and the chain list all derive from here, so a new token is one entry and a new chain additionally needs a `CHAIN_NAMES` entry in `ui/presentation.ts`.
 * {@link validateRegistry} runs at module load and rejects an entry that would otherwise surface later as a mysterious payment failure.
 */
import { MAX_DECIMALS } from "../util/decimal.js";
import { describe } from "../util/errors.js";
import { addressesEqual, isAddress, isZeroAddress, normalizeAddress, toChecksumAddress, } from "../wallet/address.js";
/**
 * The supported assets.
 * Every entry is keyed by the lower-case id an invoice stores as its `asset`; a new token is one entry here, while a new chain additionally needs a `CHAIN_NAMES` entry in `app/ts/ui/presentation.ts`.
 */
const REGISTRY = {
    eth: {
        id: "eth",
        symbol: "ETH",
        name: "Ether",
        chainId: "0x1",
        decimals: 18,
        kind: "native",
        address: null,
    },
    usdc: {
        id: "usdc",
        symbol: "USDC",
        name: "USD Coin",
        chainId: "0x1",
        decimals: 6,
        kind: "erc20",
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    },
    usdt: {
        id: "usdt",
        symbol: "USDT",
        name: "Tether USD",
        chainId: "0x1",
        decimals: 6,
        kind: "erc20",
        address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    },
};
// Object.freeze(REGISTRY) alone is shallow, so without this a runtime write could retarget ASSET_REGISTRY.usdc.address and send funds elsewhere.
// Every field is a primitive, so freezing each entry once — before the registry is exposed — is a complete deep freeze.
for (const asset of Object.values(REGISTRY)) {
    Object.freeze(asset);
}
/** The frozen registry, keyed by the lower-case asset id an invoice stores. */
export const ASSET_REGISTRY = Object.freeze(REGISTRY);
/** Registry order, for building an asset picker. */
export const ASSETS = Object.freeze(Object.values(REGISTRY));
/** Every chain id the registry can pay on, deduplicated and in registry order. */
export const SUPPORTED_CHAIN_IDS = Object.freeze([...new Set(ASSETS.map((asset) => asset.chainId))]);
function firstSupportedChain() {
    const chainId = SUPPORTED_CHAIN_IDS[0];
    if (chainId === undefined) {
        throw new Error("assets: the registry defines no supported chain to default to");
    }
    return chainId;
}
/** The chain new invoices default to — derived from the supported set, so it cannot drift from it. */
export const DEFAULT_CHAIN_ID = firstSupportedChain();
/** Raised by {@link requireAsset} when an id is not a key of {@link ASSET_REGISTRY}; the message names the ids that are. */
export class UnsupportedAssetError extends Error {
    constructor(id) {
        super(`assets: unsupported asset ${describe(id)} — expected one of ${Object.keys(ASSET_REGISTRY).join(", ")}`);
        this.name = "UnsupportedAssetError";
    }
}
/** Raised by {@link requireChain} when a chain is not in {@link SUPPORTED_CHAIN_IDS}; the message names the chains that are. */
export class UnsupportedChainError extends Error {
    constructor(chainId) {
        super(`assets: unsupported chain ${describe(chainId)} — expected one of ${SUPPORTED_CHAIN_IDS.join(", ")}`);
        this.name = "UnsupportedChainError";
    }
}
/** Raised by {@link requirePayableAddress} for a recipient a transfer must not target. */
export class UnpayableAddressError extends Error {
    constructor(address, reason) {
        super(`assets: ${describe(address)} cannot receive a transfer — ${reason}`);
        this.name = "UnpayableAddressError";
    }
}
/** True when `id` is a key of {@link ASSET_REGISTRY}, narrowing it to {@link AssetId}. */
export function isSupportedAsset(id) {
    return Object.prototype.hasOwnProperty.call(ASSET_REGISTRY, id);
}
/** The asset for `id`, or `undefined` when the registry does not carry it. */
export function getAsset(id) {
    return isSupportedAsset(id) ? ASSET_REGISTRY[id] : undefined;
}
/** The asset for `id`, or an {@link UnsupportedAssetError} when the registry does not carry it. */
export function requireAsset(id) {
    const asset = getAsset(id);
    if (asset === undefined) {
        throw new UnsupportedAssetError(id);
    }
    return asset;
}
/**
 * Fail closed before a transfer is encoded.
 * The recipient must be an address and must not be the zero address (a transfer there is burned) nor — for an ERC-20 — the token's own contract address (which locks the funds).
 * Returns the lower-case address `wallet/erc20.ts`'s `encodeTransfer` expects; route untrusted text through `wallet/address.ts`'s `requireInvoiceAddress` first to reject a bad checksum.
 */
export function requirePayableAddress(recipient, asset) {
    const address = normalizeAddress(recipient);
    if (isZeroAddress(address)) {
        throw new UnpayableAddressError(address, "the zero address burns the transfer");
    }
    if (asset.kind === "erc20" && addressesEqual(address, asset.address)) {
        throw new UnpayableAddressError(address, "it is the token's own contract address");
    }
    return address;
}
/** True when `chainId` is one of {@link SUPPORTED_CHAIN_IDS}, narrowing it to {@link ChainId}. */
export function isSupportedChain(chainId) {
    return SUPPORTED_CHAIN_IDS.includes(chainId);
}
/** The chain id unchanged, or an {@link UnsupportedChainError} when the registry does not support it. */
export function requireChain(chainId) {
    if (!isSupportedChain(chainId)) {
        throw new UnsupportedChainError(chainId);
    }
    return chainId;
}
/** Every supported asset on `chainId`, in registry order (empty when none). */
export function assetsOnChain(chainId) {
    return ASSETS.filter((asset) => asset.chainId === chainId);
}
/** A canonical lower-case chain id: `0x` then `0` or a non-zero-leading lower-case quantity. */
const CHAIN_ID_PATTERN = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
/**
 * Reject a registry entry that would only surface later as a mysterious payment failure.
 * Malformed `chainId`s (a bare `"0x"`, an upper-case `"0X1"`, a leading-zero `"0x01"`) would otherwise reach `wallet_switchEthereumChain` and tx params, and a duplicate `(chainId, address)` pair means two registry ids compete to pay the same target.
 * Exported so a test can drive a deliberately-broken registry; the shipped one is validated at the bottom of this module.
 */
export function validateRegistry(registry) {
    const transferTargets = new Set();
    for (const [key, asset] of Object.entries(registry)) {
        if (asset.id !== key) {
            throw new Error(`assets: registry key "${key}" does not match the asset id "${asset.id}"`);
        }
        if (!CHAIN_ID_PATTERN.test(asset.chainId)) {
            throw new Error(`assets: ${key} has a non-canonical chain id ${describe(asset.chainId)} — expected a 0x-prefixed lower-case quantity like "0x1"`);
        }
        const target = `${asset.chainId}:${asset.address == null ? "" : asset.address.toLowerCase()}`;
        if (transferTargets.has(target)) {
            throw new Error(`assets: ${key} duplicates the (chainId, address) pair ${asset.chainId}/${asset.address ?? "(native)"}`);
        }
        transferTargets.add(target);
        if (!Number.isSafeInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > MAX_DECIMALS) {
            throw new Error(`assets: ${key} has invalid decimals ${asset.decimals}`);
        }
        if (asset.kind === "native") {
            if (asset.address != null) {
                throw new Error(`assets: native ${key} must not carry a contract address`);
            }
            continue;
        }
        if (!isAddress(asset.address)) {
            throw new Error(`assets: ${key} needs a 0x-prefixed 40-hex contract address`);
        }
        const checksummed = toChecksumAddress(asset.address);
        if (asset.address !== checksummed) {
            throw new Error(`assets: ${key} address must be EIP-55 checksummed, expected ${checksummed}, got ${asset.address}`);
        }
    }
}
validateRegistry(ASSET_REGISTRY);
//# sourceMappingURL=registry.js.map