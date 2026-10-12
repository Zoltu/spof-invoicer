/**
 * Monero payout-address syntax: the block-padded base58 encoding of a mainnet standard, subaddress, or integrated address.
 *
 * A Monero address is not text over a public key: it is the network prefix, the public spend key, and the public view key, followed by the first four bytes of Keccak-256 over everything before them, encoded with Monero's block-padded base58 variant.
 * Only mainnet prefixes are accepted, so a testnet or stagenet address is refused rather than shown as payable, and an integrated address is accepted on its own 77-byte form — this app carries no separate payment id, and must not invent one.
 * The prefix and the encoded length are paired rather than each merely accepted: the standard `0x12` and subaddress `0x2a` prefixes carry a 69-byte encoding and the integrated `0x13` prefix a 77-byte one, so the mixed combinations no wallet produces are refused instead of being read as an address.
 * The forms those pairs describe are stated once, in the {@link MONERO_FORMS} table below, which the checks and the payee-facing hint {@link MONERO_ADDRESS_FORMS} both read.
 * Text is bounded before it is decoded: the longest encoding an address has is the integrated form's 106 characters and every character comes from base58's alphabet, so a longer paste or one carrying another character is refused on sight rather than sliced into blocks and converted, where the work and the output allocation would grow with the paste.
 * A `monero:` payment link — the usual way one of these addresses reaches a clipboard — is refused as the link it is, ahead of both of those bounds: a link is longer than an address encoding and carries the scheme's `:`, which is outside base58's alphabet, so each bound would misstate a value that is neither too long nor misspelled but a link, and a link is never accepted in place of the address it carries.
 * A value of another type throws a `TypeError` — naming what arrived through that same bounded preview, so a non-string paste cannot inflate that message either; a string that fails any check throws {@link InvalidMoneroAddressError}, whose message leads with the check that refused it and trails a bounded echo of the value, so the reason a user needs is not clipped away along with the value they pasted.
 * The bounded echo is a `util/errors.ts` preview, which also strips the control, line-separator and bidi characters a rendered refusal must not carry, so a paste cannot reorder or disguise the message it is refused with.
 */
import { PAYMENT_SCHEME_PREFIXES } from "../payment/scheme-prefixes.js";
import { base58xmr, keccak256, toHex } from "../util/encoding.js";
import { preview } from "../util/errors.js";
/** The standard address: the 69-byte `0x12` encoding, whose base58 spelling is 95 characters beginning with `4`. */
const STANDARD_FORM = { name: "standard address", prefix: 0x12, bytes: 69, characters: 95, leading: "4" };
/** The subaddress: the same 69 bytes under the `0x2a` prefix, spelled as 95 characters beginning with `8`. */
const SUBADDRESS_FORM = { name: "subaddress", prefix: 0x2a, bytes: 69, characters: 95, leading: "8" };
/** The integrated address: the standard body with an 8-byte payment id, 77 bytes spelled as 106 characters beginning with `4`. */
const INTEGRATED_FORM = { name: "integrated address", prefix: 0x13, bytes: 77, characters: 106, leading: "4" };
/**
 * Every form this module accepts, in the order a payout-address hint lists them.
 *
 * The table is the one statement of the forms: the constants below are read off it, and so is {@link MONERO_ADDRESS_FORMS}, the list `ui/create.ts` builds that hint from — so the encodings this validator accepts and the forms it tells a payee to paste cannot drift apart.
 * Each form's leading character is the one its own encoding puts there, `4` for the standard and integrated forms and `8` for the subaddress, which are the two spellings {@link MoneroAddress} names.
 */
const MONERO_FORMS = [STANDARD_FORM, SUBADDRESS_FORM, INTEGRATED_FORM];
/** Mainnet's 69-byte prefixes: `0x12` for a standard address and `0x2a` for a subaddress. */
const STANDARD_PREFIXES = [STANDARD_FORM.prefix, SUBADDRESS_FORM.prefix];
/** Mainnet's integrated prefix, which only ever carries the 77-byte encoding. */
const INTEGRATED_PREFIX = INTEGRATED_FORM.prefix;
/** Every byte a mainnet address may start with, whose pairing with the encoding length {@link refusal} enforces. */
const MAINNET_PREFIXES = MONERO_FORMS.map((form) => form.prefix);
/** A standard or subaddress encoding: prefix, two 32-byte public keys, and a 4-byte checksum. */
const STANDARD_BYTES = STANDARD_FORM.bytes;
/** An integrated encoding adds the 8-byte payment id between the view key and the checksum. */
const INTEGRATED_BYTES = INTEGRATED_FORM.bytes;
/** The Keccak-256 checksum length Monero appends to an address body. */
const CHECKSUM_BYTES = 4;
/** The characters a 69-byte standard or subaddress encoding occupies: 11 for each full 8-byte block and 7 for the trailing 5-byte one. */
const STANDARD_ADDRESS_LENGTH = STANDARD_FORM.characters;
/** The characters a 77-byte integrated encoding occupies: 11 for each of the nine full 8-byte blocks and 7 for the trailing 5-byte one. */
const INTEGRATED_ADDRESS_LENGTH = INTEGRATED_FORM.characters;
/**
 * The longest text this module decodes at all; a longer one cannot be an address encoding, which is why it is refused before the decoder slices it.
 *
 * It is exported as the Monero family's own address length, which `wallet/payout-address.ts`'s `MAX_PAYOUT_ADDRESS_LENGTH` reads to bound a payee address across every family, so no reader bounds a Monero address from a figure of its own.
 */
export const MAX_MONERO_ADDRESS_LENGTH = Math.max(...MONERO_FORMS.map((form) => form.characters));
/**
 * The forms this module accepts, for the payout-address hint `ui/create.ts` renders: each form's name, its leading spelling, and the characters its encoding occupies.
 *
 * The list is read off {@link MONERO_FORMS}, so a form the hint names is one this validator takes and one this validator takes is named by the hint; the sentence around those entries is the UI layer's own wording rather than a second statement of the forms.
 */
export const MONERO_ADDRESS_FORMS = Object.freeze(MONERO_FORMS.map((form) => Object.freeze({ name: form.name, prefixes: Object.freeze([form.leading]), characters: form.characters })));
/**
 * The characters Monero's block-padded base58 carries — base58's alphabet, which holds neither `0`, `O`, `I`, nor `l` — as the pattern {@link syntaxRefusal} tests text against before the decoder sees it.
 */
const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]*$/;
/**
 * The scheme of a `monero:` payment link: the usual way one of these addresses reaches a clipboard, and no address this module accepts.
 *
 * The prefix is read off `payment/scheme-prefixes.ts`'s `PAYMENT_SCHEME_PREFIXES`, the scheme table the link builder spells from too, so the courtesy refusal that tells a payee to paste the address rather than the link cannot name a scheme no builder uses.
 * The scheme's `:` is outside base58's alphabet, so a link can never be an address encoding, while the rest of a link is an address this module does accept — so without a branch of its own the paste would be refused for a character and a length that say nothing about what the user actually pasted.
 */
const PAYMENT_LINK_PREFIX = PAYMENT_SCHEME_PREFIXES.monero;
/** Raised by {@link requireMoneroAddress} for a string that is not an acceptable Monero address; `reason` names the check that refused it and leads the message. */
export class InvalidMoneroAddressError extends Error {
    constructor(value, reason) {
        super(`monero-address: not a Monero payout address — ${reason}; value: ${preview(value)}`);
        this.name = "InvalidMoneroAddressError";
    }
}
/**
 * True when `text` leads with `prefix` in either case, reading no more than the prefix.
 *
 * The prefix here is a URI scheme, which names the form a paste points at rather than a spelling this module accepts, so both cases are read: the scheme is what a refusal should name whatever case the paste happens to use, and reading no more than the prefix keeps the comparison off the length of a paste no bound has yet limited.
 */
function leadsWithPrefixInEitherCase(text, prefix) {
    return text.slice(0, prefix.length).toLowerCase() === prefix;
}
function checksumOf(body) {
    return keccak256(body).subarray(0, CHECKSUM_BYTES);
}
/** The decoded bytes of `text`, or `null` when the blocked base58 encoding itself is broken. */
function decode(text) {
    try {
        return base58xmr.decode(text);
    }
    catch {
        return null;
    }
}
/** One of {@link MAINNET_PREFIXES} as the `0x`-prefixed hex text a refusal names it in. */
function prefixHex(value) {
    return `0x${value.toString(16)}`;
}
/**
 * Why `text` cannot be an address encoding at all, or `null` when it is worth decoding.
 *
 * The decoder slices its input into 11-character blocks and allocates its output in proportion to the input's length, so a text longer than an address encoding can be, or one carrying a character base58's alphabet does not hold, is refused here — before any of it is decoded.
 */
function syntaxRefusal(text) {
    if (text.length > MAX_MONERO_ADDRESS_LENGTH) {
        return `its blocked base58 encoding is malformed — a Monero address encoding is ${STANDARD_ADDRESS_LENGTH} characters (a ${STANDARD_BYTES}-byte standard or subaddress form) or ${INTEGRATED_ADDRESS_LENGTH} (a ${INTEGRATED_BYTES}-byte integrated one), and this value is ${text.length} characters`;
    }
    if (!BASE58_PATTERN.test(text)) {
        return "its blocked base58 encoding is malformed — it carries a character outside Monero's base58 alphabet";
    }
    return null;
}
/**
 * Why `text` is not an acceptable Monero address, or `null` when it is.
 *
 * Every acceptance path runs through here, so {@link isMoneroAddress} and {@link requireMoneroAddress} cannot disagree about what an address is.
 * A `monero:` payment link is read first, before the syntax checks: it is the one paste here that is not an address candidate at all, and the checks below would each name something untrue of it — a length no address has, or a character the scheme puts there rather than a mistyped address.
 */
function refusal(text) {
    if (leadsWithPrefixInEitherCase(text, PAYMENT_LINK_PREFIX)) {
        return "it is a `monero:` payment link, and this app wants the address the link carries rather than the link itself";
    }
    const syntax = syntaxRefusal(text);
    if (syntax !== null) {
        return syntax;
    }
    const bytes = decode(text);
    if (bytes === null) {
        return "its blocked base58 encoding is malformed (a block of the wrong length, or a padded one)";
    }
    if (bytes.length !== STANDARD_BYTES && bytes.length !== INTEGRATED_BYTES) {
        return `expected a ${STANDARD_BYTES}-byte standard or subaddress encoding, or a ${INTEGRATED_BYTES}-byte integrated one, got ${bytes.length} bytes`;
    }
    const prefix = bytes[0];
    if (!MAINNET_PREFIXES.includes(prefix)) {
        return `expected a mainnet address prefix of ${MAINNET_PREFIXES.map(prefixHex).join(", ")}, got 0x${toHex(bytes.subarray(0, 1))}`;
    }
    if (bytes.length === INTEGRATED_BYTES && prefix !== INTEGRATED_PREFIX) {
        return `expected a ${INTEGRATED_BYTES}-byte integrated encoding to start with the ${prefixHex(INTEGRATED_PREFIX)} prefix, got 0x${toHex(bytes.subarray(0, 1))}`;
    }
    if (bytes.length === STANDARD_BYTES && prefix === INTEGRATED_PREFIX) {
        return `expected a ${STANDARD_BYTES}-byte standard or subaddress encoding to start with the ${STANDARD_PREFIXES.map(prefixHex).join(" or ")} prefix, got 0x${toHex(bytes.subarray(0, 1))}`;
    }
    const body = bytes.subarray(0, bytes.length - CHECKSUM_BYTES);
    if (toHex(bytes.subarray(body.length)) !== toHex(checksumOf(body))) {
        return "its Keccak-256 checksum does not match the address body";
    }
    return null;
}
/** True when `value` is an address this module accepts, narrowing it to {@link MoneroAddress}; never throws. */
export function isMoneroAddress(value) {
    return typeof value === "string" && refusal(value) === null;
}
/**
 * The one entry point for Monero address text — a pasted payee address, an invoice field — returning it unchanged once it is a mainnet address of one of the accepted forms.
 *
 * The returned string is not normalized: Monero's base58 is case-sensitive, and the payer's wallet has to see the address exactly as it was written.
 * A `monero:` payment link is refused rather than returned: the field wants the address the link carries, and a link is never accepted in its place.
 */
export function requireMoneroAddress(value) {
    if (typeof value !== "string") {
        throw new TypeError(`monero-address: expected a Monero payout address string, got ${preview(value)}`);
    }
    const reason = refusal(value);
    if (reason !== null) {
        throw new InvalidMoneroAddressError(value, reason);
    }
    return value;
}
//# sourceMappingURL=monero-address.js.map