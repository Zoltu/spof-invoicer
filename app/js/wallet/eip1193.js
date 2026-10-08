/**
 * The EIP-1193 wallet boundary — the only place in the app that talks to a wallet.
 *
 * Everything the payment flow needs lives here: EIP-6963 discovery with a `window.ethereum` fallback, a typed wrapper around the provider's single `request` method, the transaction shape `eth_sendTransaction` carries, and the failure taxonomy a caller reports through.
 * The module calls no provider when it is imported and exposes no eager connection: {@link discoverProviders} must be invoked explicitly, and `ui/pay-flow.ts` reaches it only through {@link walletCandidates}, from the payer's own action, so loading the page never reaches a wallet.
 *
 * The provider is the app's only outbound channel, and it is backed by the user's wallet rather than this page: nothing here issues a page-origin request, opens a socket, or resolves a URL.
 * Reading a balance or broadcasting a transaction goes through the injected provider object and nowhere else.
 *
 * Every value a provider or an announcement supplies is bounded before it is rendered: an announced name is cut to the label limit before the display-character pass, and a provider reply that becomes an error message is cut to the message limit before it is escaped, so a hostile announcement or reply cannot drive unbounded work.
 */
import { boundMessage, describe, preview } from "../util/errors.js";
import { boundRaw, stripDisplayCharacters } from "../util/text.js";
import { isAddress, normalizeAddress } from "./address.js";
/** EIP-6963 announcement event name. */
const EIP6963_ANNOUNCE = "eip6963:announceProvider";
/** EIP-6963 discovery request event name. */
const EIP6963_REQUEST = "eip6963:requestProvider";
/**
 * How long discovery waits for announcements before falling back to `window.ethereum`.
 * The wait is a fixed 150 ms: a wallet that announces later than this is missed, and the app falls back to `window.ethereum` or reports "No Ethereum wallet was found".
 * A wallet that injects its provider through a page `<script>` from a non-`'self'` origin is blocked by the page's policy and never appears here at all.
 */
export const DISCOVERY_TIMEOUT_MS = 150;
/** EIP-1193 code for a request the user rejected in the wallet. */
const EIP1193_USER_REJECTED = 4001;
/** EIP-1193 code for a chain the wallet does not know. */
const EIP1193_UNRECOGNIZED_CHAIN = 4902;
/** The labels an announcement's metadata is bounded to, so a hostile detail cannot stretch a notice. */
const MAX_UUID_CHARS = 128;
const MAX_NAME_CHARS = 40;
const MAX_ICON_CHARS = 1024;
const MAX_RDNS_CHARS = 128;
/** The most announcements discovery will retain within its window; an honest wallet announces once, so this only bounds a wallet that floods the event. */
const MAX_ANNOUNCEMENT_COUNT = 256;
/** The most accounts `eth_requestAccounts` may return; far above any honest wallet's account list, it bounds a provider that answers with an arbitrarily long array. */
const MAX_ACCOUNT_COUNT = 1024;
/** The most of a provider's own error message a wrapped failure carries. */
const MAX_PROVIDER_MESSAGE_CHARS = 200;
/** The transaction hash shape a wallet must return. */
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
/** The widest quantity a provider may return: 32 bytes, the size of an Ethereum `uint256`. */
const MAX_QUANTITY_HEX_DIGITS = 64;
/**
 * The minimal quantity shape, before canonicalization, bounded to {@link MAX_QUANTITY_HEX_DIGITS} digits.
 * The bound is what keeps a hostile provider reply from driving `BigInt` over an unbounded digit string or being echoed back as oversized text in a status line.
 */
const QUANTITY_PATTERN = new RegExp(`^0x[0-9a-fA-F]{1,${MAX_QUANTITY_HEX_DIGITS}}$`);
/** The widest contract-call return data a provider may answer with, in bytes: a generous bound far above any call this app makes (a `uint256` word is 32 bytes), so a hostile provider cannot force unbounded processing of an oversized reply. */
const MAX_CALL_DATA_BYTES = 2048;
/** Contract-call return data: `0x` plus an even number of hex digits, bounded to {@link MAX_CALL_DATA_BYTES}. */
const DATA_PATTERN = new RegExp(`^0x(?:[0-9a-fA-F]{2}){0,${MAX_CALL_DATA_BYTES}}$`);
/** The user rejected the request in their wallet. `action` says which request, for the message. */
export class WalletRejectedError extends Error {
    action;
    constructor(action) {
        super(`wallet: you declined the ${action} in your wallet`);
        this.name = "WalletRejectedError";
        this.action = action;
    }
}
/** The wallet does not know the chain being requested, which only the user can fix. */
export class UnknownChainError extends Error {
    chainId;
    constructor(chainId) {
        super(`wallet: your wallet does not know the network ${describe(chainId)} — add it in the wallet, then try again`);
        this.name = "UnknownChainError";
        this.chainId = chainId;
    }
}
/** Any other provider failure, carrying the method and the provider's own code. */
export class WalletRequestError extends Error {
    method;
    code;
    constructor(method, code, detail) {
        super(`wallet: ${method} failed${code === null ? "" : ` (code ${code})`} — ${detail}`);
        this.name = "WalletRequestError";
        this.method = method;
        this.code = code;
    }
}
/** The provider answered something this app cannot use as the requested value. */
export class WalletResponseError extends Error {
    method;
    constructor(method, value, expected) {
        // `preview` bounds a string value before it is escaped, so a multi-megabyte provider reply is not rendered in full just to be cut.
        super(`wallet: ${method} returned an unexpected value — expected ${expected}, got ${preview(value, 80)}`);
        this.name = "WalletResponseError";
        this.method = method;
    }
}
/** Read the EIP-1193/JSON-RPC error code off a rejected value, if it carries one. */
function errorCode(error) {
    if (typeof error !== "object" || error === null)
        return null;
    const code = error.code;
    return typeof code === "number" ? code : null;
}
/** True when `value` looks like an EIP-1193 provider: an object with a callable `request`. */
function isEip1193Provider(value) {
    const candidate = value;
    return typeof value === "object" && value !== null && typeof candidate.request === "function";
}
/** Integer base units as a JSON-RPC quantity: `0n` → `"0x0"`, no leading zeros. */
export function toHexQuantity(value) {
    if (typeof value !== "bigint" || value < 0n) {
        throw new RangeError(`wallet: a quantity must be a non-negative bigint, got ${describe(value)}`);
    }
    return `0x${value.toString(16)}`;
}
/** A JSON-RPC quantity back to base units, failing closed on anything else. */
export function fromHexQuantity(value, what) {
    if (typeof value !== "string" || !QUANTITY_PATTERN.test(value)) {
        throw new WalletResponseError(what, value, "a 0x-prefixed hex quantity");
    }
    return BigInt(value);
}
/** A chain id in its canonical spelling: lower case, minimal, `0x`-prefixed. */
export function normalizeChainId(value) {
    return toHexQuantity(fromHexQuantity(value, "eth_chainId"));
}
const NO_PROVIDERS = Object.freeze([]);
const NO_CANDIDATES = Object.freeze([]);
/**
 * Ask installed wallets to announce themselves through EIP-6963 and collect what they say.
 *
 * The request event is dispatched once and announcements are gathered for `timeoutMs` — wallets answer asynchronously, so the wait is the protocol, not a retry.
 * An announcement that does not carry a usable provider and info is dropped rather than trusted, a wallet that announces twice is reported once, and only the first {@link MAX_ANNOUNCEMENT_COUNT} announcements are retained, so no wallet can grow the list without bound.
 * Returns an empty list when the page has no usable event target (a test, a worker, or a caller-supplied one that is not an event target) or nothing answers; the caller may then fall back to `window.ethereum`.
 */
export async function discoverProviders(options = {}) {
    const target = options.target === undefined ? defaultEventTarget() : options.target;
    if (!isProviderEventTarget(target))
        return NO_PROVIDERS;
    const timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
    const announced = [];
    const listener = (event) => {
        if (announced.length >= MAX_ANNOUNCEMENT_COUNT)
            return;
        const detail = announcementDetail(event);
        if (detail !== null)
            announced.push(detail);
    };
    target.addEventListener(EIP6963_ANNOUNCE, listener);
    try {
        target.dispatchEvent(discoveryRequest());
        if (timeoutMs > 0)
            await wait(timeoutMs);
    }
    finally {
        target.removeEventListener(EIP6963_ANNOUNCE, listener);
    }
    return dedupeProviders(announced);
}
/**
 * The wallets the payer can pay from, discovered through EIP-6963 and falling back to the injected `window.ethereum` when nothing announces.
 * The fallback is only consulted when discovery finds nothing, so a wallet that supports both protocols is not offered twice.
 */
export async function walletCandidates(options = {}) {
    const discovered = await discoverProviders(options);
    if (discovered.length > 0) {
        return Object.freeze(discovered.map((detail) => Object.freeze({ label: detail.info.name, provider: detail.provider })));
    }
    const provider = windowProvider();
    if (provider === null)
        return NO_CANDIDATES;
    return Object.freeze([Object.freeze({ label: "Injected wallet", provider })]);
}
/** The legacy injected provider, or `null` when the page has none. */
export function windowProvider() {
    if (typeof window === "undefined")
        return null;
    const candidate = window.ethereum;
    return isEip1193Provider(candidate) ? candidate : null;
}
/**
 * The typed wrapper over one discovered EIP-1193 provider: the single handle the payment flow holds instead of the provider's raw `request` method.
 * Each method issues one of the provider's account and chain requests — connect, read the chain, switch it, read a balance or contract value, send a transaction — and normalizes the reply, so a caller works in `Address`, {@link ChainId}, and bigint values rather than raw JSON-RPC.
 */
export class WalletClient {
    provider;
    label;
    constructor(provider, label) {
        if (!isEip1193Provider(provider)) {
            throw new TypeError(`wallet: expected an EIP-1193 provider with a request method, got ${describe(provider)}`);
        }
        this.provider = provider;
        this.label = boundMessage(label, MAX_NAME_CHARS);
    }
    /**
     * Ask for the accounts that may pay.
     * This call opens the wallet's approval UI, so it must only be reached from an explicit user action — never on load.
     */
    async requestAccounts() {
        const raw = await rpc(this.provider, "eth_requestAccounts", undefined, "connection request");
        if (!Array.isArray(raw)) {
            throw new WalletResponseError("eth_requestAccounts", raw, "an array of account addresses");
        }
        if (raw.length > MAX_ACCOUNT_COUNT) {
            throw new WalletResponseError("eth_requestAccounts", raw.length, `an array of at most ${MAX_ACCOUNT_COUNT} account addresses`);
        }
        return Object.freeze(raw.map((entry) => providerAddress(entry, "eth_requestAccounts")));
    }
    /** Read the network the wallet is currently connected to, normalized to a canonical chain id. */
    async chainId() {
        return normalizeChainId(await rpc(this.provider, "eth_chainId", undefined, "request"));
    }
    /** Ask the wallet to move to `chainId`, for the chain the invoice names. */
    async switchChain(chainId) {
        try {
            await rpc(this.provider, "wallet_switchEthereumChain", [{ chainId }], "network switch");
        }
        catch (error) {
            if (error instanceof WalletRequestError && error.code === EIP1193_UNRECOGNIZED_CHAIN) {
                throw new UnknownChainError(chainId);
            }
            throw error;
        }
    }
    /** The account's native balance in wei. */
    async getBalance(account) {
        const raw = await rpc(this.provider, "eth_getBalance", [account, "latest"], "request");
        return fromHexQuantity(raw, "eth_getBalance");
    }
    /** Read-only contract call, for an ERC-20 `balanceOf`. */
    async call(to, data) {
        const raw = await rpc(this.provider, "eth_call", [{ to, data }, "latest"], "request");
        if (typeof raw !== "string" || !DATA_PATTERN.test(raw)) {
            throw new WalletResponseError("eth_call", raw, "0x-prefixed return data");
        }
        return raw;
    }
    /**
     * Hand the transaction to the wallet to sign and broadcast.
     * This is the irreversible step: the caller must have verified the chain and built the request from the invoice first.
     */
    async sendTransaction(request) {
        const raw = await rpc(this.provider, "eth_sendTransaction", [request], "transaction");
        if (typeof raw !== "string" || !HASH_PATTERN.test(raw)) {
            throw new WalletResponseError("eth_sendTransaction", raw, "a 32-byte transaction hash");
        }
        return raw;
    }
}
/** Send one JSON-RPC request, normalizing the provider's failures into this module's taxonomy. */
async function rpc(provider, method, params, action) {
    try {
        return await provider.request(params === undefined ? { method } : { method, params });
    }
    catch (error) {
        if (errorCode(error) === EIP1193_USER_REJECTED)
            throw new WalletRejectedError(action);
        throw new WalletRequestError(method, errorCode(error), providerMessage(error));
    }
}
/** A provider's own error description, whatever shape it throws, bounded for a notice. */
function providerMessage(error) {
    if (typeof error === "object" && error !== null) {
        const message = error.message;
        if (typeof message === "string")
            return boundMessage(message, MAX_PROVIDER_MESSAGE_CHARS);
    }
    // A string thrown as the error is bounded before `describe` quotes and escapes it, so a huge one is not rendered in full first; any other value is already bounded by `boundMessage` after `describe`.
    const described = typeof error === "string" ? describe(boundRaw(error, MAX_PROVIDER_MESSAGE_CHARS)) : describe(error);
    return boundMessage(described, MAX_PROVIDER_MESSAGE_CHARS);
}
/** A provider-returned account, normalized to the lower-case address the rest of the app stores. */
function providerAddress(value, method) {
    if (!isAddress(value))
        throw new WalletResponseError(method, value, "a 0x-prefixed 40-hex address");
    return normalizeAddress(value);
}
/** The three event methods EIP-6963 discovery needs before it dispatches on a target. */
const PROVIDER_EVENT_METHODS = ["addEventListener", "removeEventListener", "dispatchEvent"];
/** True when `value` looks like an event target: every method {@link discoverProviders} dispatches through is callable. */
function isProviderEventTarget(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const candidate = value;
    return PROVIDER_EVENT_METHODS.every((method) => typeof candidate[method] === "function");
}
/** The page's event target, or `null` when there is none to dispatch on. */
function defaultEventTarget() {
    if (typeof window === "undefined")
        return null;
    return isProviderEventTarget(window) ? window : null;
}
function discoveryRequest() {
    if (typeof CustomEvent === "function")
        return new CustomEvent(EIP6963_REQUEST);
    return { type: EIP6963_REQUEST };
}
async function wait(ms) {
    await new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
/** One announcement's detail, or `null` when it does not carry a usable provider and metadata. */
function announcementDetail(event) {
    const detail = event?.detail;
    if (typeof detail !== "object" || detail === null)
        return null;
    const candidate = detail;
    if (!isEip1193Provider(candidate.provider))
        return null;
    const info = providerInfo(candidate.info);
    if (info === null)
        return null;
    return Object.freeze({ info, provider: candidate.provider });
}
/** Validated, bounded provider metadata whose label is safe to display; `null` when a required field is missing, not a string, or nothing but invisible characters. */
function providerInfo(value) {
    if (typeof value !== "object" || value === null)
        return null;
    const info = value;
    if (typeof info.uuid !== "string" || info.uuid === "")
        return null;
    if (typeof info.name !== "string")
        return null;
    // The name becomes a picker label, so it is bounded to the label length before the control, invisible, and bidi characters are stripped: the bound keeps the display-character pass off an arbitrarily long announced name, and stripping after the bound keeps a wallet from presenting an entry that renders as another wallet's or hides text the payer would read.
    const name = stripDisplayCharacters(boundRaw(info.name, MAX_NAME_CHARS));
    if (name === "")
        return null;
    return Object.freeze({
        uuid: boundRaw(info.uuid, MAX_UUID_CHARS),
        name,
        // An announced icon and an rdns are display text a picker may render, so they take the announced name's control, invisible, and bidi strip; the uuid is an identity key, not display text.
        ...(typeof info.icon === "string" ? { icon: stripDisplayCharacters(boundRaw(info.icon, MAX_ICON_CHARS)) } : {}),
        ...(typeof info.rdns === "string" ? { rdns: stripDisplayCharacters(boundRaw(info.rdns, MAX_RDNS_CHARS)) } : {}),
    });
}
/** One entry per wallet, however many times it announced. */
function dedupeProviders(details) {
    const uuids = new Set();
    const providers = new Set();
    const unique = [];
    for (const detail of details) {
        if (uuids.has(detail.info.uuid) || providers.has(detail.provider))
            continue;
        uuids.add(detail.info.uuid);
        providers.add(detail.provider);
        unique.push(detail);
    }
    return Object.freeze(unique);
}
//# sourceMappingURL=eip1193.js.map