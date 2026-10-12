/**
 * The payment schemes and the byte budget every link this app builds is held to.
 *
 * The scheme spellings themselves live in `payment/scheme-prefixes.ts`, the dependency-free leaf that states each scheme with the prefix its links carry; this module re-exports them, spells a `zcash:` link through {@link zcashLinkUri}, and derives the budgets below, so a reader that needs a prefix and a budget both resolves them from the link layer.
 * `payment/links.ts` spells each link from that table and `wallet/zcash-address.ts` and `wallet/monero-address.ts` read their own prefixes from it, so the courtesy refusal that tells a payee to paste the address rather than the link cannot name a scheme no builder uses.
 * The budgets are derived here for the same reason: {@link MAX_PAYMENT_LINK_BYTES} is the capacity contract `util/qr-capacity.ts` publishes for the widest symbol this app draws, and {@link MAX_ZCASH_ADDRESS_LENGTH} is that ceiling less what a `zcash:` link carries besides the address, so the bound an address validator applies and the ceiling a link is checked against are one figure and one derivation rather than two numbers kept in step by hand.
 * Every figure a budget spends is read off the source that owns it — the capacity contract, `util/decimal.ts`'s uint256 digit budget, and {@link zcashLinkUri}, the template the link builder spells a `zcash:` link with — rather than restated as a literal here.
 * The one figure this derivation cannot read from a module of its own weight is the ZEC entry's own amount scale: the registry that states it validates itself at load, so reading the entry here would pull the registry module, and with it that load-time gate, into the import graph of every address validator — for a figure this app's own amount cap already bounds from above. {@link ZCASH_AMOUNT_BUDGET_CHARS} is therefore the figure drawn from that cap instead, and {@link zcashAmountOutgrowsBudget} is the check `payment/links.ts` applies to the registry's own ZEC entry as it loads, so the premise this bound rests on is verified — fail-closed, before any invoice is built — rather than assumed.
 * Nothing here touches the DOM, the clock, or the network: these are strings and counts, read by the modules that build a link or validate an address.
 *
 * The invariant that every accepted invoice's link is QR-encodable rests on two statements, one per family rather than one per scheme: `payment/links.ts`'s `paymentLink` holds every scheme's link to {@link MAX_PAYMENT_LINK_BYTES} bytes as it is built, and the Zcash family is additionally held by address length — {@link MAX_ZCASH_ADDRESS_LENGTH}, the single name `wallet/zcash-address.ts` re-exports and applies to a mainnet unified container.
 * Only the Zcash family carries that second statement, because its unified container is the one address whose own format leaves it effectively unbounded — ZIP 316 bounds it at F4Jumble's 4 194 352 bytes, far past a symbol — while a transparent or Sapling Zcash address, a Monero address, and an EVM address are each bounded by their own grammar well inside the ceiling; the margin each of those families leaves is pinned by `tests/payment-link.test.mjs`, which builds the widest link a Monero address admits, the widest native EIP-681 link, and the widest ERC-20 transfer link, each from the bounds those families' own validators and this app's digit budget export.
 */
import { MAX_UINT256_DIGITS } from "../util/decimal.js";
import { QR_MAX_TEXT_BYTES } from "../util/qr-capacity.js";
import { PAYMENT_SCHEME_PREFIXES } from "./scheme-prefixes.js";
export { PAYMENT_SCHEME_PREFIXES };
/**
 * The ZIP-321 link a `zcash:` invoice is spelled as: the scheme, the payee's address, and the amount field.
 *
 * This is the one statement of the shape a `zcash:` link has: `payment/links.ts`'s builder spells a link through it, and {@link ZCASH_LINK_ENVELOPE_CHARS} reads the same template with both fields empty, so the bytes the address budget reserves for the link's query parameter and the parameter the builder actually writes cannot drift apart.
 */
export function zcashLinkUri(address, amount) {
    return `${PAYMENT_SCHEME_PREFIXES.zcash}${address}?amount=${amount}`;
}
/**
 * The most a link may occupy: {@link QR_MAX_TEXT_BYTES} bytes, the ceiling `util/qr-capacity.ts` publishes for the version 15 symbol at level M this app's encoder builds.
 *
 * The figure is read from the capacity contract rather than from the encoder, so an address validator whose own length bound is derived from this budget does not load the encoder with it, and it is derived from an exported capacity rather than stated a second time, so the budget this module hands the link builders and the encoder their URIs are handed to cannot drift apart; staying inside it is the link layer's own obligation, applied to every scheme's link by `payment/links.ts`'s `paymentLink`, which measures the link in the same UTF-8 bytes this ceiling is stated in as it is built.
 * It is therefore the ceiling that carries the encodability invariant for the families whose addresses their own grammar bounds — an EVM or Monero payee — while the Zcash family's effectively unbounded container is held by {@link MAX_ZCASH_ADDRESS_LENGTH} as well.
 */
export const MAX_PAYMENT_LINK_BYTES = QR_MAX_TEXT_BYTES;
/**
 * The longest decimal spelling an amount at `decimals` fractional digits takes, with the amount itself held to the uint256 a single transfer carries.
 *
 * `invoice/model.ts` caps every amount at `util/decimal.ts`'s `UINT256_MAX`, whose own maximum is `MAX_UINT256_DIGITS` digits, and that cap bounds the printed text as a whole rather than either side of the point: the two parts trade digits, the whole part carrying at most the digits the cap leaves beside the scale and the fractional part at most the scale's own.
 * That is why the figure is invariant in the scale while the whole part still carries a digit at all: the whole part gives up exactly the digits the fractional part takes, so the text is the digit budget's own digits of value plus the one point a fractional part adds — `MAX_UINT256_DIGITS + 1` characters, whatever the scale is.
 * Past the digit budget the whole part has no digit left to carry — `floor(UINT256_MAX / 10^decimals)` is zero from `MAX_UINT256_DIGITS` decimals on — so the text becomes the bare `0`, the point, and the fraction at full scale, `decimals + 2` characters, which the invariant sum under-counts from that scale on: a uint256 total prints 80 characters at 78 decimals against the 79 the sum gives.
 * The larger of the two arms is returned, so the figure bounds every amount the model admits at every scale `assets/registry.ts` admits (0 to `util/decimal.ts`'s `MAX_DECIMALS`) instead of cancelling the scale out of a text the scale lengthens.
 */
export function maxAmountChars(decimals) {
    return Math.max(MAX_UINT256_DIGITS + 1, decimals + 2);
}
/**
 * The longest decimal spelling the `zcash:` link's amount may occupy: {@link maxAmountChars} at the last scale whose whole part still carries a digit, 79 characters — 70 whole digits, the point, and a scale short enough to leave the whole part its digits.
 *
 * The figure is the digits arm of {@link maxAmountChars} rather than a literal, so the amount budget and the amount-spelling rule are one statement: the arm holds for every scale from 0 to `MAX_UINT256_DIGITS - 1` (77), which includes the ZEC entry's own eight decimals, and every wider scale prints a longer text instead.
 * {@link zcashAmountOutgrowsBudget} is that difference as a check, and `payment/links.ts` applies it to the registry's own ZEC entry as it loads: the entry's scale is what makes this figure the right one for the amount a `zcash:` link will actually carry, and reading it here at load is what this module deliberately does not do — see the module block above.
 */
export const ZCASH_AMOUNT_BUDGET_CHARS = maxAmountChars(MAX_UINT256_DIGITS - 1);
/**
 * The bytes a `zcash:` link carries besides the address: the scheme and its separator, the `amount` field, and the longest amount that link's amount budget admits.
 *
 * The figure is read off {@link zcashLinkUri} — the template `payment/links.ts` builds that link from — with the address and the amount both empty, so a query parameter renamed or added in the builder moves this measurement with it instead of leaving the address budget below sized against a link no builder writes.
 */
const ZCASH_LINK_ENVELOPE_CHARS = zcashLinkUri("", "").length + ZCASH_AMOUNT_BUDGET_CHARS;
/**
 * The bytes {@link MAX_ZCASH_ADDRESS_LENGTH} leaves between the widest link this app builds and the encoder's ceiling: 8.
 *
 * The margin is this app's own headroom rather than a figure any format or other module owns, so it is the one number here that is stated instead of derived: the widest `zcash:` link an accepted address admits is 404 bytes of the 412-byte ceiling, so the address bound below spends 311 of the 319 bytes that link leaves for an address and keeps these eight in hand.
 */
const LINK_BUDGET_SPARE_BYTES = 8;
/**
 * The longest address a `zcash:` link carries: 311 characters, and the one name this figure has.
 *
 * It is {@link MAX_PAYMENT_LINK_BYTES} less what the link spends on everything but the address and less {@link LINK_BUDGET_SPARE_BYTES}, so the widest link an address of this length builds — a 311-character container with a 79-character amount — is 404 bytes, eight inside the ceiling the symbol is encoded at.
 * The name is deliberately the only one the figure has: `wallet/zcash-address.ts` re-exports it as its own bound on a mainnet unified container, and `wallet/payout-address.ts` reads it there as the Zcash family's widest accepted address — and through it the length `ui/presentation.ts` clips a displayed address to — so the bound a link is built against, the bound a validator applies, and the length the document displays are one declaration rather than several derivations that happen to agree today.
 * A separate statement of the Zcash family's widest form — a maximum taken across the transparent, Sapling, and unified bounds — would read as another derivation of this figure while quietly turning on a form's own constant, so the family states this one bound and each form's grammar bound stays what its own grammar needs.
 * Every character of every scheme's link is ASCII — base58, Bech32, Bech32m, hex, digits, and the scheme's own punctuation — so counting characters counts the bytes the ceiling is stated in; the link builder and this module apply the budget in bytes all the same, so a code point one of today's address validators might one day leave unrefused cannot slip past a budget counted in UTF-16 code units.
 * It is the longest address any of this app's payout-address validators accepts, because the Zcash unified container is the one address whose own format leaves it effectively unbounded — ZIP 316 bounds it at F4Jumble's 4 194 352 bytes, far past a symbol — while a transparent or Sapling Zcash address, a Monero address, and an EVM address are each bounded by their own grammar well inside the ceiling; so no accepted payee can build a link the symbol cannot carry.
 */
export const MAX_ZCASH_ADDRESS_LENGTH = MAX_PAYMENT_LINK_BYTES - ZCASH_LINK_ENVELOPE_CHARS - LINK_BUDGET_SPARE_BYTES;
/**
 * True when an asset printing its amounts at `decimals` would outgrow {@link ZCASH_AMOUNT_BUDGET_CHARS}, the amount the Zcash address budget reserves.
 *
 * The bound above is the figure {@link maxAmountChars} gives at the last scale whose whole part still carries a digit, so an entry at a wider scale would print a longer amount than that budget reserved and a link carrying the widest address this app accepts could outgrow the symbol: this is that difference, stated once here and applied by `payment/links.ts` to the registry's own ZEC entry as it loads, so the premise {@link MAX_ZCASH_ADDRESS_LENGTH} rests on is checked rather than assumed.
 * It reads nothing and throws nothing, so a test can drive it at any scale, and a registry the check refuses fails the app closed — at load, before any invoice is built — instead of accepting an address whose link the encoder would later refuse.
 */
export function zcashAmountOutgrowsBudget(decimals) {
    return maxAmountChars(decimals) > ZCASH_AMOUNT_BUDGET_CHARS;
}
//# sourceMappingURL=schemes.js.map