/**
 * The human name of every supported network, and the one label every payer-facing surface spells a network with.
 *
 * This is the leaf the naming primitives live in, split out of `ui/presentation.ts` for the import graph's sake: the payment panel (`ui/pay.ts`) and the payment flow (`ui/pay-flow.ts`) name a network in their summary and their guidance, and reaching that spelling through the document's display module would load `payment/links.ts` — running its load-time byte-budget gates — and `util/qr.ts`'s encoder on a wallet-facing path that builds neither a link nor a symbol.
 * It depends on `assets/registry.ts` alone — the layer that decides which networks exist — plus `util/errors.ts` for the refusal's bounded preview, and it is the only import path for the names it declares: `ui/presentation.ts` imports the one label it displays from here and re-exports none of them, so a surface that only names a network cannot reach that spelling through the document's display module and re-add the load-time budget gates and the encoder this leaf was split out to keep off its path.
 * Nothing here touches the DOM or the clock: a label is a pure function of the network id a caller hands it.
 */
import { SUPPORTED_CHAIN_IDS, isCanonicalEvmChainId } from "../assets/registry.js";
import { describe } from "../util/errors.js";
/**
 * The friendly name of each supported network, keyed by its registry id — a canonical lower-case chain id, or a non-EVM network slug.
 *
 * The registry decides which networks exist, so this map has to name every one of them; {@link requireNamedNetworks} holds the shipped pair to exactly that, applied at the bottom of this module, so a network added to the registry without a name here stops the app at load rather than reaching a payer as its raw id in the document, the payment panel, and the payment flow's guidance at once.
 */
export const CHAIN_NAMES = Object.freeze({ "0x1": "Ethereum", zcash: "Zcash", monero: "Monero" });
/**
 * The human name of a chain, falling back to its id for one the display map does not name.
 * Only an own property is read, so a chain id that collides with an inherited `Object.prototype` member still falls back to the raw id.
 */
export function chainName(chainId) {
    return Object.hasOwn(CHAIN_NAMES, chainId) ? CHAIN_NAMES[chainId] : chainId;
}
/**
 * Refuse a name map that leaves a network in `chainIds` unnamed.
 *
 * The set of networks is `assets/registry.ts`'s, the layer that decides which ones exist, while their human names are this module's own statement, so the network set and the name set are one requirement stated in two places — and a network added to the registry without a name here would otherwise reach a payer as a raw slug.
 * The refusal is a load-time gate rather than a test: a network the registry supports and this map does not name stops the app outright, so the label can never ship as the id — the same fail-closed shape `assets/registry.ts`'s `validateRegistry` and `payment/schemes.ts`'s own reads apply at load.
 * Exported so a test can drive a deliberately-unnamed network; the shipped pair is checked at the bottom of this module.
 */
export function requireNamedNetworks(names, chainIds) {
    for (const chainId of chainIds) {
        if (!Object.hasOwn(names, chainId)) {
            throw new Error(`network-labels: the registry supports the network ${describe(chainId)} and no human name is declared for it — add one to CHAIN_NAMES, or every payer-visible label would render the network as its raw id`);
        }
    }
}
/**
 * The payer-visible label of a network: its human name, with the registry id beside it when that id is one a wallet shows — `Ethereum (0x1)` — the bare name for a chain whose id no wallet reads, e.g. `Zcash`, and the bare id for one the display map does not name.
 *
 * This is the one spelling of the label, so the document's Payment details term, the payment panel's summary, and the payment flow's network guidance cannot describe one network in two ways.
 * The id is carried beside an EVM chain's name because a payer's wallet shows that chain id and can be on another network that spells the same address; a privacy chain's id is this app's own slug for it, which no wallet reads, so appending it would put a spelling the payer cannot act on into the label they act by.
 * The predicate is `assets/registry.ts`'s own statement of what a chain id looks like, so the label carries the id for exactly the networks whose wallet-side spelling that module defines.
 * The raw id is the fallback for the same reason {@link chainName} falls back to it: a network this map does not name still has to render as itself.
 */
export function networkLabel(chainId) {
    const name = chainName(chainId);
    if (name === chainId)
        return chainId;
    return isCanonicalEvmChainId(chainId) ? `${name} (${chainId})` : name;
}
requireNamedNetworks(CHAIN_NAMES, SUPPORTED_CHAIN_IDS);
//# sourceMappingURL=network-labels.js.map