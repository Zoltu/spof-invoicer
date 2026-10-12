/**
 * Zcash payout-address syntax: the mainnet transparent `t1`/`t3` (Base58Check), Sapling `zs1`/`ZS1` (Bech32), and unified `u1`/`U1` (Bech32m) forms.
 *
 * Each accepted encoding carries the integrity check its own standard defines — Base58Check's double-SHA-256 suffix and Bech32's or Bech32m's six-character checksum — so an address that validates cannot be one mistyped character away from another address, and this module reads no further than that check: it decodes the text, compares the human-readable part with the one the form uses, bounds the length, and stops.
 * A transparent string is dispatched by its `t1`/`t3` text, but the two version bytes under that text are what admit it, and a version outside the mainnet pair is refused at that check even though the text prefix matched.
 * The forms those checks admit are stated once, in {@link ZCASH_ADDRESS_FORMS}, which they read through the constants below and the payee-facing hint `ui/create.ts` renders.
 * A unified address is accepted, not certified: ZIP 316 wraps its receivers in an F4Jumble encoding this module does not implement, so nothing behind the container is read and no set of receivers is claimed — the Bech32m checksum, the mainnet human-readable part `u`, the length bound below, and the payload size floor below are the whole of what {@link ZcashAddress}'s unified member certifies.
 * The payload is measured rather than parsed: ZIP 316 spells the receivers a container carries as the concatenation of one or more `typecode || length || addr` items and requires at least one of them, and prefixes that list with the human-readable part padded to 16 bytes before F4Jumble preserves the length, so a container shorter than {@link MIN_UNIFIED_PAYLOAD_BYTES} is below the smallest item list the grammar can spell and is refused rather than certified as a payee.
 * A unified address is the default receiving form in modern wallets, so refusing the form outright would leave this app unable to invoice most Zcash payees.
 * The bound is drawn from what the address is turned into rather than from the address format: a ZIP-321 `zcash:` payment link carries the scheme, the address, `?amount=`, and the amount, and `payment/schemes.ts` derives {@link MAX_ZCASH_ADDRESS_LENGTH} from the capacity contract this app's budget and encoder share (`util/qr-capacity.ts`'s 412 bytes at version 15, level M) less what such a link spends on everything but the address — so the bound a container is held to and the ceiling its own link is encoded at are one derivation rather than two figures kept in step by hand, and a longer container is refused where the payee can still see what they pasted.
 * Every accepted form is mainnet-only: a testnet `tm`/`t2` transparent string, a testnet or regtest `ztestsapling`/`zregtest` Sapling one, Sprout's `zc`, and a unified container under another human-readable part — the testnet `utest` (`utest1…`) or the regtest `uregtest` — are all refused.
 * Neither the asset nor this validator carries a network, so for a unified address the decoded human-readable part is what tells mainnet from testnet: a container that decodes under the mainnet `u` is accepted, and one that decodes under any other part this module knows is refused as {@link TestnetUnifiedAddressError}, which names the network it addresses.
 * A unified paste that is not such a container is refused as the malformed encoding it is — a broken checksum or alphabet, a mixed-case spelling, a container decoding under a part this module does not know, one whose data words are not a whole number of payload bytes, one carrying fewer payload bytes than the smallest container the ZIP-316 padding and item grammar can spell, and one longer than {@link MAX_ZCASH_ADDRESS_LENGTH} — rather than named as another network's address.
 * A ZIP-321 `zcash:` payment link — the usual way one of these addresses gets copied — is refused as the link it is, not as the Sprout address whose `zc` text prefix the scheme shares, and never accepted in place of the address a link carries.
 * A Sprout spelling in either case is refused as a Sprout address, because it is the prefix that says which form the user pasted; the transparent case rule, which is about an accepted form's case-sensitive encoding, is not what is wrong with it.
 * Case is read the way the encoding defines it: a transparent `t1`/`t3` address is case-sensitive Base58Check, so a uniformly upper-case paste is refused as the different string it spells rather than case-folded into a spelling only this app produced, while a Bech32 candidate is read as BIP-173 defines it — either uniform case spells the same string, a mixed-case one spells nothing at all, and an accepted Sapling or unified address is returned in the lower-case spelling the checksum is computed over.
 * Every branch bounds its input before the step that would grow with it: a transparent paste past {@link MAX_TRANSPARENT_TEXT_LENGTH} is refused ahead of Base58Check's quadratic conversion, a Sapling paste past {@link MAX_BECH32_TEXT_LENGTH} ahead of the word-to-byte conversion, a unified paste past {@link MAX_ZCASH_ADDRESS_LENGTH} ahead of the Bech32m decode, and each case probe reads only text its own branch's bound already covers, so no branch case-maps or converts an unbounded paste, and each of the three length refusals leads with the bound it applied rather than with the decoding step's own message.
 * A refusal names the form it expected and never echoes the human-readable part it decoded, which is input-derived and can be arbitrarily long, so a hostile value cannot inflate the message it is refused with; the value itself trails as a bounded preview, which `util/errors.ts` also strips of the control, line-separator and bidi characters a rendered refusal must not carry.
 * A value of another type throws a `TypeError` — naming what arrived through that same bounded preview, so a non-string paste cannot inflate that message either; a string that fails any check throws {@link InvalidZcashAddressError} — {@link TestnetUnifiedAddressError}, its subclass, only for a container on a network this app does not pay — whose message leads with the check that refused it and trails a bounded echo of the value, so the reason a user needs is not clipped away along with the value they pasted.
 */

import { PAYMENT_SCHEME_PREFIXES } from "../payment/scheme-prefixes.js";
import { MAX_ZCASH_ADDRESS_LENGTH } from "../payment/schemes.js";
import { base58check, bech32, bech32m, sha256, toHex } from "../util/encoding.js";
import { describe, preview } from "../util/errors.js";
import type { PayoutAddressForm } from "./payout-forms.js";

/**
 * A validated Zcash address string, tagged by the forms this module accepts: transparent `t1`/`t3` (case-sensitive Base58Check), Sapling, and unified, the latter two in either of the two spellings BIP-173 defines — `zs1…`/`ZS1…` and `u1…`/`U1…`.
 *
 * Either Bech32 spelling is the same address, and {@link requireZcashAddress} returns the lower-case one the checksum is computed over, so a stored address has a single canonical spelling; a transparent address is case-sensitive and is stored and compared exactly as it was validated.
 * The spelling is therefore no part of what this type certifies: {@link isZcashAddress} admits both Bech32 spellings of one address, so a value narrowed by it can be either, and {@link requireZcashAddress} is the entry point that collapses the two to the one a stored address carries.
 * A unified member certifies a mainnet container — its Bech32m checksum, its `u` human-readable part, its length, and a payload at least as long as the smallest one a legal container can have — and not the receivers inside it, which this module never decodes.
 */
export type ZcashAddress = `t1${string}` | `t3${string}` | `zs1${string}` | `ZS1${string}` | `u1${string}` | `U1${string}`;

/** The big-endian version at the head of a transparent payload, two bytes wide, carrying one of {@link TRANSPARENT_VERSIONS} as a number. */
const TRANSPARENT_VERSION_BYTES = 2;

/** The HASH160 that follows the version in a transparent payload, 20 bytes wide. */
const TRANSPARENT_HASH_BYTES = 20;

/** The transparent payload Base58Check wraps: the version followed by the hash. */
const TRANSPARENT_PAYLOAD_BYTES = TRANSPARENT_VERSION_BYTES + TRANSPARENT_HASH_BYTES;

/**
 * The longest text a transparent `t1`/`t3` address can occupy: 36 characters.
 *
 * Base58Check's own cap is 4096 characters, but its conversion is quadratic in the input, so a `t…` paste is measured against the encoding's real maximum — the 26 bytes of version, hash, and checksum need no more than 36 base58 characters — before it is decoded, as the Sapling path is measured against its codec's cap.
 */
const MAX_TRANSPARENT_TEXT_LENGTH = 36;

/**
 * The longest text the upper-case probe reads: 78 characters, the longest mainnet transparent or Sapling address.
 *
 * Those are the only forms that reach the probe — a unified candidate is dispatched by its own text prefixes, which are read in either case — so this is the longest paste whose uniform case that rule has to name, and a longer one is refused without being case-mapped.
 */
const MAX_ACCEPTED_TEXT_LENGTH = 78;

/**
 * Mainnet's transparent version bytes, each paired with the text prefix its encoding carries: `0x1CB8` for a P2PKH (`t1`) address and `0x1CBD` for a P2SH (`t3`) one.
 *
 * The pairs are the single source for the version bytes the version check admits, for the text prefixes {@link refusal} dispatches on, and for the listing {@link transparentRefusal} names, so a version a check accepts cannot be missing from a refusal or from the dispatch.
 */
const TRANSPARENT_VERSIONS: readonly { readonly version: number; readonly prefix: string }[] = [
	{ version: 0x1cb8, prefix: "t1" },
	{ version: 0x1cbd, prefix: "t3" },
];

/** The raw Sapling payment address: an 11-byte diversifier followed by the 32-byte `pk_d`. */
const SAPLING_PAYLOAD_BYTES = 43;

/**
 * The longest text the Sapling branch reads: the Bech32 codec's 90-character cap, which is also BIP-173's own limit on a Bech32 string.
 *
 * It is checked by {@link saplingRefusal} before the decode, passed to the decode as an explicit limit, and probed by {@link mixedCaseReason}, so the three readers of the bound cannot drift apart and an over-long paste is refused on its length, under its own reason, rather than by the codec's generic checksum message.
 */
const MAX_BECH32_TEXT_LENGTH = 90;

/**
 * The text prefixes of the accepted forms and of the form this module refuses by name, plus the Bech32 human-readable part Sapling admits.
 *
 * The transparent prefixes are read off {@link TRANSPARENT_VERSIONS}, so the text a string is dispatched by and the version bytes that admit it cannot drift apart.
 * A leading text prefix is not the human-readable part: a Bech32 string's part runs up to its last `1`, so a string that starts `zs1` can carry another part and still satisfy that other part's own checksum — the decoded part, not the leading text, is what admits a Sapling address.
 * The unified prefixes are read off {@link UNIFIED_HRPS} for the same reason: text leading with one of them is a candidate that decodes under that part, not yet an accepted address.
 */
const TRANSPARENT_TEXT_PREFIXES: readonly string[] = TRANSPARENT_VERSIONS.map(({ prefix }) => prefix);
const SAPLING_TEXT_PREFIX = "zs1";
const SAPLING_HRP = "zs";
/** Sprout's mainnet Base58Check prefix; Sprout cannot receive funds, so the prefix is named rather than left to the generic refusal, and it is probed in either case because it is the form the paste points at rather than a spelling this module accepts. */
const SPROUT_TEXT_PREFIX = "zc";

/**
 * The scheme of a ZIP-321 `zcash:` payment link: the usual way one of these addresses reaches a clipboard, and no address this module accepts.
 *
 * The prefix is read off `payment/scheme-prefixes.ts`'s `PAYMENT_SCHEME_PREFIXES`, the scheme table the link builder spells from too, so the courtesy refusal that tells a payee to paste the address rather than the link cannot name a scheme no builder uses.
 * A link shares Sprout's `zc` text prefix, so without a branch of its own it would be refused as a Sprout address — a statement about the value that is not true of it — while `:` is outside base58's alphabet, so no Sprout address can be mistaken for a link.
 */
const PAYMENT_LINK_PREFIX = PAYMENT_SCHEME_PREFIXES.zcash;

/** The one network this app pays, and the one unified human-readable part it is addressed under. */
const UNIFIED_MAINNET_NETWORK = "mainnet";
const UNIFIED_MAINNET_HRP = "u";

/**
 * The Bech32m human-readable part a unified address carries on each network this module names, each paired with the network it addresses: mainnet `u`, testnet `utest`, and regtest `uregtest`.
 *
 * The text prefixes {@link unifiedCandidate} dispatches on are read off this list, so the text that admits a candidate and the part that classifies it cannot drift apart, and a container that decodes under a part this list does not carry is not a unified address whatever its text began with.
 * Only the first entry is payable here: a paste that decodes under another one is refused by name, because this app's invoices are mainnet-only and the human-readable part is the only thing that says which network a container addresses.
 */
const UNIFIED_HRPS: readonly { readonly hrp: string; readonly network: string }[] = [
	{ hrp: UNIFIED_MAINNET_HRP, network: UNIFIED_MAINNET_NETWORK },
	{ hrp: "utest", network: "testnet" },
	{ hrp: "uregtest", network: "regtest" },
];

/**
 * The forms this module accepts, for the payout-address hint `ui/create.ts` renders: the transparent `t1`/`t3` pair, Sapling's `zs1`, and the mainnet unified `u1`.
 *
 * Every entry is read off the constants the checks below apply — {@link TRANSPARENT_VERSIONS}, {@link SAPLING_TEXT_PREFIX}, and {@link UNIFIED_MAINNET_HRP} — so a form the hint names is one this validator takes and one this validator takes is named by the hint; the sentence around those entries is the UI layer's own wording rather than a second statement of the forms.
 */
export const ZCASH_ADDRESS_FORMS: readonly PayoutAddressForm[] = Object.freeze([
	Object.freeze({ name: "transparent", prefixes: Object.freeze([...TRANSPARENT_TEXT_PREFIXES]) }),
	Object.freeze({ name: "Sapling", prefixes: Object.freeze([SAPLING_TEXT_PREFIX]) }),
	Object.freeze({ name: "unified", prefixes: Object.freeze([`${UNIFIED_MAINNET_HRP}1`]) }),
]);

/**
 * The longest address this module accepts: 311 characters, and `payment/schemes.ts`'s one statement of that bound, re-exported here under the name this validator's own bound is read by.
 *
 * The figure is that module's `MAX_ZCASH_ADDRESS_LENGTH` — the ceiling `util/qr-capacity.ts` publishes for the widest symbol this app draws, less the bytes a `zcash:` link spends on the scheme, the `amount` key, and the longest amount this app's own uint256 digit budget lets that link print, less the margin that keeps the widest link inside that ceiling.
 * The derivation stays in that module because `payment/links.ts` reaches this validator through `wallet/payout-address.ts`, so a validator importing the figure from the link layer would close the cycle `links → payout-address → zcash-address → links`, whose module-scope constants are read before they are initialized and the app then fails to load.
 * It is re-exported rather than derived a second time, and `wallet/payout-address.ts` reads it here as the Zcash family's widest accepted address — and through it the length `ui/presentation.ts` clips a displayed address to — so the link budget, this validator's bound, and the length the document displays are one declaration rather than three that happen to agree today.
 * The budget is read from the capacity contract rather than from the encoder, and `payment/links.ts` holds the registry's own ZEC entry to the amount figure that budget reserves as it loads, so the bound applied here comes from a figure an entry's amount scale cannot outgrow and no validator's import graph reaches the registry or the encoder through this one.
 * ZIP 316 itself bounds a unified address only at F4Jumble's 4 194 352-byte maximum, far past what a QR symbol can carry, so the bound is drawn from the symbol the address is turned into instead.
 * It is the length budget a link is built against and, here, the bound a mainnet unified candidate is decoded under: a longer paste is refused before its container is read, so neither the decode nor a refusal message grows with the paste.
 */
export { MAX_ZCASH_ADDRESS_LENGTH };

/**
 * The fewest payload bytes a unified-address container may carry: 38, the smallest container a legal mainnet address can have.
 *
 * The bytes measured here are the container the Bech32m checksum covers, and ZIP 316 builds that container as F4Jumble over the item list prefixed by the human-readable part, the part padded with zero bytes to 16 bytes.
 * F4Jumble preserves the length of what it encodes, so the container is 16 bytes longer than the item list itself, and the padded `u` a mainnet address carries is 16 bytes.
 * The item list is the concatenation of one or more items, each a `typecode` (`compactSize`), a `length` (`compactSize`), and that many bytes of receiver, and the shortest item the grammar can spell is a transparent P2PKH or P2SH receiver: a 20-byte hash, framed by one byte of typecode and one byte of length.
 * The 16 bytes of padded human-readable part plus those 22 bytes are therefore the smallest container a legal address can have, and one below that size cannot be the concatenation of receivers the grammar spells at all, so it is refused rather than certified as a payable mainnet address: the checksum, the human-readable part, and the length bound above admit a container of any payload whatever, which would otherwise be rendered to the payee as the address the invoice pays to.
 * The Sapling and Orchard receivers are 43 bytes, framed 45, so a container holding one of those is longer than this floor and is admitted on the same length check.
 */
export const MIN_UNIFIED_PAYLOAD_BYTES = 38;

const decodeBase58Check = base58check(sha256);

/**
 * Raised by {@link requireZcashAddress} for a string that is not an address this module accepts; `reason` names the check that refused it.
 *
 * The message leads with `clause` — what the value is instead of an address of an accepted form, or, for a container past {@link MAX_ZCASH_ADDRESS_LENGTH}, the QR budget that refused it — and trails a bounded echo of the value.
 */
export class InvalidZcashAddressError extends Error {
	constructor(value: string, reason: string, clause = "not a Zcash payout address") {
		super(`zcash-address: ${clause} — ${reason}; value: ${preview(value)}`);
		this.name = "InvalidZcashAddressError";
	}
}

/**
 * Raised by {@link requireZcashAddress} for a unified-address container on a network this app does not pay: the testnet `utest` part, the regtest `uregtest` one, or any other part {@link UNIFIED_HRPS} names that is not the mainnet `u`.
 *
 * The app builds mainnet-only invoices and nothing it holds — neither the asset nor this validator — carries a network, so the human-readable part is the evidence: a container that decodes under another part is an address on another network, and the refusal names that network rather than reporting a check the paste passed as though it were merely malformed.
 * It extends {@link InvalidZcashAddressError}, so a caller that treats every refusal alike still catches it, while a caller that distinguishes them can report "a testnet unified address" from this class alone rather than reading the message.
 * The invoice model keeps this refusal as the `cause` of its own field error, so a surface above the model still classifies a network refusal here rather than in the wording it was wrapped into.
 */
export class TestnetUnifiedAddressError extends InvalidZcashAddressError {
	constructor(value: string, network: string, reason: string) {
		super(value, reason, `a ${network} unified address cannot be paid from a mainnet-only invoice`);
		this.name = "TestnetUnifiedAddressError";
	}
}

/**
 * The Base58Check payload of `text`, or `null` when the encoding itself is broken.
 *
 * scure's decoder throws for a bad checksum, for a character outside base58's alphabet, and for a string longer than its own 4096-character cap; the payer needs to know the address is unusable rather than which of the three it was, so they collapse into one refusal here.
 */
function decodeTransparent(text: string): Uint8Array | null {
	try {
		return decodeBase58Check.decode(text);
	} catch {
		return null;
	}
}

/** One of {@link TRANSPARENT_VERSIONS} as the `0x`-prefixed hex text a refusal names it in. */
function versionHex(value: number): string {
	return `0x${value.toString(16)}`;
}

/** Mainnet's accepted transparent versions as a refusal lists them, each with the text prefix its encoding carries: `0x1cb8 (t1) or 0x1cbd (t3)`. */
function transparentVersionList(): string {
	return TRANSPARENT_VERSIONS.map(({ version, prefix }) => `${versionHex(version)} (${prefix})`).join(" or ");
}

/** The refusal `text` gets for not being a transparent `t1`/`t3` address, or `null` when it is one. */
function transparentRefusal(text: string): InvalidZcashAddressError | null {
	if (text.length > MAX_TRANSPARENT_TEXT_LENGTH) {
		return new InvalidZcashAddressError(text, `expected at most ${MAX_TRANSPARENT_TEXT_LENGTH} characters for a ${TRANSPARENT_PAYLOAD_BYTES}-byte Base58Check payload, got ${text.length}`);
	}
	const payload = decodeTransparent(text);
	if (payload === null) {
		return new InvalidZcashAddressError(text, "its Base58Check checksum or alphabet is wrong");
	}
	if (payload.length !== TRANSPARENT_PAYLOAD_BYTES) {
		return new InvalidZcashAddressError(text, `expected a ${TRANSPARENT_PAYLOAD_BYTES}-byte Base58Check payload (a ${TRANSPARENT_VERSION_BYTES}-byte version and a ${TRANSPARENT_HASH_BYTES}-byte hash), got ${payload.length} bytes`);
	}
	const version = (payload[0] << 8) | payload[1];
	if (!TRANSPARENT_VERSIONS.some(({ version: accepted }) => accepted === version)) {
		return new InvalidZcashAddressError(text, `expected the mainnet transparent version ${transparentVersionList()}, got 0x${toHex(payload.subarray(0, TRANSPARENT_VERSION_BYTES))}`);
	}
	return null;
}

/**
 * The Bech32 human-readable part and data words of `text`, or `null` when the codec refuses the string itself.
 *
 * scure's decoder is where the human-readable part, the alphabet, the separator, the case, and the six-character checksum are checked, and it throws for a failure of any of them; the payer needs to know the address is unusable rather than which of them it was, so they collapse into one refusal here.
 * The words are returned unconverted: turning them into payload bytes is {@link saplingPayload}'s own step, whose failure means something the checks above never touch, so a word count that maps to no whole byte is not reported as a broken checksum it did not have.
 * The limit is spelled out rather than left to the codec's default so the bound the case probe reads a paste under and the bound checked here cannot drift apart; the codec applies it before it folds case or converts words to bytes, so neither that conversion nor the payload allocation grows with the length of the paste.
 */
function decodeSapling(text: string): { readonly prefix: string; readonly words: number[] } | null {
	try {
		const decoded = bech32.decode(text, MAX_BECH32_TEXT_LENGTH);
		return { prefix: decoded.prefix, words: decoded.words };
	} catch {
		return null;
	}
}

/**
 * The payload bytes `words` carry, or `null` when they are not a whole number of payload bytes.
 *
 * Bech32 spells a payload as 5-bit words whose last byte is padded with zero bits, and the codec's converter throws both for a word count with more trailing bits than that padding accounts for and for one whose trailing bits are not zero — the checksum and alphabet checks behind {@link decodeSapling} admit either.
 */
function saplingPayload(words: number[]): Uint8Array | null {
	try {
		return bech32.fromWords(words);
	} catch {
		return null;
	}
}

/**
 * Why `text` is spelled in neither case a Bech32 string may be, or `null` when it is spelled in one of them.
 *
 * BIP-173 spells a Bech32 string either uniformly lower case or uniformly upper case — the checksum is computed over the lower-case spelling of both, which is why the codec accepts either and refuses a mixed-case one — so this names the case rule for a paste the codec would otherwise refuse as though its checksum were wrong.
 * `limit` is the bound `text` is decoded under: a longer paste is refused on its length, so the two case maps here never run over input that could be arbitrarily long.
 */
function mixedCaseReason(text: string, limit: number, scheme: string): string | null {
	if (text.length > limit) {
		return null;
	}
	const lower = text.toLowerCase();
	if (lower === text || text.toUpperCase() === text) {
		return null;
	}
	return `it mixes upper and lower case, and ${scheme} spells a string either uniformly lower case or uniformly upper case`;
}

/**
 * The refusal `text` gets for not being a mainnet Sapling `zs1` address, or `null` when it is one.
 *
 * The length is checked here rather than left to the codec, which refuses a paste past {@link MAX_BECH32_TEXT_LENGTH} with the same error it raises for a broken alphabet or checksum: that reason would misstate what is wrong with a paste that is merely too long, so this refusal names the bound instead, as the transparent branch's own length refusal does.
 * The decode and the word-to-byte conversion are read separately, under a reason each, for the same reason: the codec refuses a data run that is not a whole number of payload bytes with the same error it raises for a bad checksum, so a paste every check over its text admits is refused for the padding that is actually wrong with it rather than for a check that passed.
 */
function saplingRefusal(text: string): InvalidZcashAddressError | null {
	if (text.length > MAX_BECH32_TEXT_LENGTH) {
		return new InvalidZcashAddressError(text, `expected at most ${MAX_BECH32_TEXT_LENGTH} characters for a Sapling ${SAPLING_TEXT_PREFIX} address, got ${text.length}`);
	}
	const mixed = mixedCaseReason(text, MAX_BECH32_TEXT_LENGTH, "Bech32");
	if (mixed !== null) {
		return new InvalidZcashAddressError(text, mixed);
	}
	const decoded = decodeSapling(text);
	if (decoded === null) {
		return new InvalidZcashAddressError(text, "its Bech32 checksum or alphabet is wrong");
	}
	if (decoded.prefix !== SAPLING_HRP) {
		// The decoded part is read off the input and can be arbitrarily long on a hostile paste, so the refusal names the part it expected instead of echoing the one it found.
		return new InvalidZcashAddressError(text, `expected the Bech32 human-readable part ${describe(SAPLING_HRP)} (mainnet Sapling)`);
	}
	const payload = saplingPayload(decoded.words);
	if (payload === null) {
		// The checksum covers the words and the decode above verified it, so the failure is the word count rather than any check over the text; the count trails a fixed number into the message and the ten-character reason is what a user needs.
		return new InvalidZcashAddressError(text, `its ${decoded.words.length} data words are not a whole number of payload bytes, and Bech32 pads a payload's last byte with zero bits`);
	}
	if (payload.length !== SAPLING_PAYLOAD_BYTES) {
		return new InvalidZcashAddressError(text, `expected a ${SAPLING_PAYLOAD_BYTES}-byte Sapling payment address, got ${payload.length} bytes`);
	}
	return null;
}

/**
 * True when `text` leads with `prefix` in either case, reading no more than the prefix.
 *
 * Two kinds of text are dispatched this way: a Bech32 string's leading text, which BIP-173 spells in either case, so both spellings are one address and one branch reads both; and a prefix that names the form a paste points at — a URI scheme, Sprout's `zc`, a unified container's human-readable part — where the form is what a refusal should name whatever case the paste happens to use.
 * Reading no more than the prefix keeps the comparison off text that a branch's own bound has yet to limit.
 */
function leadsWithPrefixInEitherCase(text: string, prefix: string): boolean {
	return text.slice(0, prefix.length).toLowerCase() === prefix;
}

/** The {@link UNIFIED_HRPS} entry whose text prefix `text` leads with — `u1`, `utest1`, or `uregtest1`, in either case — or `null` when `text` is not a unified candidate. */
function unifiedCandidate(text: string): { readonly hrp: string; readonly network: string } | null {
	return UNIFIED_HRPS.find(({ hrp }) => leadsWithPrefixInEitherCase(text, `${hrp}1`)) ?? null;
}

/** The {@link UNIFIED_HRPS} entry for a decoded human-readable part, or `undefined` when the part is not one this module knows. */
function knownUnifiedHrp(hrp: string): { readonly hrp: string; readonly network: string } | undefined {
	return UNIFIED_HRPS.find((candidate) => candidate.hrp === hrp);
}

/**
 * The Bech32m human-readable part of `text` and the data words behind it, or `null` when the encoding itself is broken.
 *
 * The decode is capped at {@link MAX_ZCASH_ADDRESS_LENGTH}, the figure {@link unifiedRefusal} measures the candidate against before calling this, so neither bound can be lifted past the other.
 * The words are carried out unconverted, as the Sapling branch's decoder carries its own: they are turned into payload bytes by {@link unifiedPayloadBytes}, a step of its own whose failure means the padding rather than any check over the text.
 */
function decodeUnified(text: string): { readonly hrp: string; readonly words: number[] } | null {
	try {
		const decoded = bech32m.decode(text, MAX_ZCASH_ADDRESS_LENGTH);
		return { hrp: decoded.prefix, words: decoded.words };
	} catch {
		return null;
	}
}

/**
 * The number of payload bytes `words` carry, or `null` when they are not a whole number of payload bytes.
 *
 * A container is the Bech32m spelling of a byte string, so a word count that is not one is not the container it claims to be; the codec's converter throws both for a count with more trailing bits than the padding accounts for and for one whose trailing bits are not zero, and each is reported as the padding that is actually wrong rather than as a checksum the paste passed.
 * Only the count is kept: the bytes themselves are measured and discarded, because nothing behind the container is read.
 */
function unifiedPayloadBytes(words: number[]): number | null {
	try {
		return bech32m.fromWords(words).length;
	} catch {
		return null;
	}
}

/** {@link UNIFIED_HRPS} as a refusal lists them, each with the network it addresses: `"u" (mainnet), "utest" (testnet), "uregtest" (regtest)`. */
function unifiedHrpList(): string {
	return UNIFIED_HRPS.map(({ hrp, network }) => `${describe(hrp)} (${network})`).join(", ");
}

/**
 * The refusal a unified candidate past {@link MAX_ZCASH_ADDRESS_LENGTH} gets: the QR budget that refused it, not the address form it otherwise is.
 *
 * The bound is applied before the container is decoded, so a paste past it is never classified by the network its text prefix names — a bound this app applies to a mainnet address leaves no container to read.
 */
function overLengthUnifiedRefusal(text: string): InvalidZcashAddressError {
	return new InvalidZcashAddressError(
		text,
		`it is longer than the ${MAX_ZCASH_ADDRESS_LENGTH} characters a \`zcash:\` payment link carries in this app's QR symbol`,
		"a unified-address candidate is longer than this app's QR symbol carries",
	);
}

/**
 * The refusal `text` gets for a unified candidate, or `null` when it is an accepted mainnet address.
 *
 * The class says what the module verified: within {@link MAX_ZCASH_ADDRESS_LENGTH} it is the decoded human-readable part that classifies the paste, so a container under the mainnet `u` is accepted on its checksum, part, length, and payload, one that decodes under a non-mainnet part this list knows is named as that network's address, and every other failure — a broken checksum, a mixed-case spelling, a part this list does not carry, a word count that is not whole payload bytes, a payload too short to carry a receiver — is the ordinary malformed-encoding refusal rather than a form this module read and then rejected.
 * A candidate past the bound is refused on its length before it is decoded, so its text prefix names no network: malformed text that merely begins `utest1` is the malformed paste it is rather than another network's address.
 * The payload checks are applied on the mainnet path, after the paste has been classified by its part, so a container on another network is still refused by name whatever its payload is, and a mainnet one is held to the smallest container a legal address can have: a container below it carries no complete receiver and is not the address it would otherwise be presented as.
 * Nothing behind the container is read, so an accepted value certifies a mainnet container and no set of receivers.
 */
function unifiedRefusal(text: string): InvalidZcashAddressError | null {
	if (text.length > MAX_ZCASH_ADDRESS_LENGTH) {
		// The bound is the payment link's QR budget rather than the address form's, so the refusal leads with the budget that refused the value instead of with "not a Zcash payout address", which is the wrong reason for a real unified address that is simply longer than this app can carry.
		return overLengthUnifiedRefusal(text);
	}
	const mixed = mixedCaseReason(text, MAX_ZCASH_ADDRESS_LENGTH, "Bech32m");
	if (mixed !== null) {
		return new InvalidZcashAddressError(text, mixed);
	}
	const decoded = decodeUnified(text);
	if (decoded === null) {
		return new InvalidZcashAddressError(text, "its Bech32m checksum or alphabet is wrong");
	}
	const known = knownUnifiedHrp(decoded.hrp);
	if (known === undefined) {
		// The decoded part is read off the input and can be arbitrarily long on a hostile paste, so the refusal names the parts it expects instead of echoing the one it found.
		return new InvalidZcashAddressError(text, `expected the Bech32m human-readable part ${unifiedHrpList()} for a unified address`);
	}
	if (known.network !== UNIFIED_MAINNET_NETWORK) {
		return new TestnetUnifiedAddressError(
			text,
			known.network,
			`it decodes under the Bech32m human-readable part ${describe(known.hrp)} (${known.network}), and only the mainnet part ${describe(UNIFIED_MAINNET_HRP)} is a payout address this app pays`,
		);
	}
	const payloadBytes = unifiedPayloadBytes(decoded.words);
	if (payloadBytes === null) {
		// The checksum covers the words and the decode above verified it, so the failure is the word count rather than any check over the text, exactly as the Sapling branch reports the same count.
		return new InvalidZcashAddressError(text, `its ${decoded.words.length} data words are not a whole number of payload bytes, and Bech32m pads a payload's last byte with zero bits`);
	}
	if (payloadBytes < MIN_UNIFIED_PAYLOAD_BYTES) {
		// The container decodes and its part is mainnet, so what is wrong with it is the payload: it is shorter than the padded human-readable part plus the smallest item the grammar spells, and certifying it would present an invoice paying an address that cannot exist.
		return new InvalidZcashAddressError(text, `expected at least ${MIN_UNIFIED_PAYLOAD_BYTES} payload bytes for a container carrying one typed receiver, got ${payloadBytes}`);
	}
	return null;
}

/**
 * The refusal `text` gets, or `null` when it is an address this module accepts.
 *
 * Every acceptance path runs through here, so {@link isZcashAddress} and {@link requireZcashAddress} cannot disagree about what an address is, and each refusal is built with the error class that says why: a container on another network gets {@link TestnetUnifiedAddressError} through {@link unifiedRefusal}, everything else {@link InvalidZcashAddressError}.
 * A `zcash:` payment link is read first, before any address form is considered: it is the one paste here that is not an address candidate at all, and the scheme's `zc` text prefix would otherwise dispatch it into the Sprout branch, whose reason is not true of it.
 */
function refusal(text: string): InvalidZcashAddressError | null {
	if (leadsWithPrefixInEitherCase(text, PAYMENT_LINK_PREFIX)) {
		return new InvalidZcashAddressError(
			text,
			"it is a `zcash:` payment link, and this app wants the address the link carries rather than the link itself",
			"a payment link is not a payout address",
		);
	}
	if (TRANSPARENT_TEXT_PREFIXES.some((prefix) => text.startsWith(prefix))) {
		return transparentRefusal(text);
	}
	if (leadsWithPrefixInEitherCase(text, SAPLING_TEXT_PREFIX)) {
		return saplingRefusal(text);
	}
	if (unifiedCandidate(text) !== null) {
		return unifiedRefusal(text);
	}
	if (leadsWithPrefixInEitherCase(text, SPROUT_TEXT_PREFIX)) {
		// Sprout is case-sensitive Base58Check like the transparent forms, but an upper-case spelling of it is not a spelling this module could ever accept either way, and the prefix is what tells the user which form they pasted.
		return new InvalidZcashAddressError(text, "Sprout addresses can no longer receive funds, and this app never pays one");
	}
	// A transparent address is dispatched by its lower-case prefix and its spelling is case-sensitive Base58Check, so a uniformly upper-case paste lands here; it is refused as the different string upper case spells, not folded into the address it resembles. The length is checked first, because only a string no longer than an accepted address can be such a spelling, so the case-mapping never runs over an unbounded paste.
	if (text.length <= MAX_ACCEPTED_TEXT_LENGTH && text === text.toUpperCase() && text !== text.toLowerCase()) {
		return new InvalidZcashAddressError(text, "it is uniformly upper case, and a transparent address is case-sensitive Base58Check — upper case spells a different string, not that address in another spelling");
	}
	return new InvalidZcashAddressError(text, `expected a mainnet transparent ${TRANSPARENT_TEXT_PREFIXES.join("/")}, Sapling ${SAPLING_TEXT_PREFIX}, or unified ${UNIFIED_MAINNET_HRP}1 address`);
}

/**
 * True when `value` is an address this module accepts, narrowing it to {@link ZcashAddress}; never throws.
 *
 * The guard certifies the address, not one spelling of it: both spellings BIP-173 defines are the same address and both narrow to {@link ZcashAddress}, so a value that passes can be either, and a caller that needs the one spelling a stored address carries normalizes through {@link requireZcashAddress} instead of keeping whichever spelling it read.
 */
export function isZcashAddress(value: unknown): value is ZcashAddress {
	return typeof value === "string" && refusal(value) === null;
}

/**
 * The one entry point for Zcash address text — a pasted payee address, an invoice field — returning it once it is an address of one of the accepted forms.
 *
 * This is the canonicalizing half of the pair {@link isZcashAddress} completes: the guard admits both Bech32 spellings BIP-173 defines, while this function is what turns the two spellings of one address into one text, so a caller that normalizes both through here holds one value rather than two spellings of it.
 * A Sapling or unified address is returned in the lower-case spelling its checksum is computed over, which is the one spelling of the two BIP-173 admits that a stored address carries; a transparent address is case-sensitive Base58Check and is returned exactly as it was written, never case-folded.
 * A unified container on another network, or one carrying too little payload to hold a receiver, is refused rather than returned, so no caller can hold a `ZcashAddress` addressed to a network this app does not pay or to no address at all.
 */
export function requireZcashAddress(value: unknown): ZcashAddress {
	if (typeof value !== "string") {
		throw new TypeError(`zcash-address: expected a Zcash payout address string, got ${preview(value)}`);
	}
	const refused = refusal(value);
	if (refused !== null) {
		throw refused;
	}
	// Sapling and the unified member are the Bech32 forms this module accepts, and a Bech32 string's two spellings are one string, so an accepted one is returned in the lower-case spelling; an accepted transparent address is returned as it came.
	const bech32Form = leadsWithPrefixInEitherCase(value, SAPLING_TEXT_PREFIX) || unifiedCandidate(value) !== null;
	return (bech32Form ? value.toLowerCase() : value) as ZcashAddress;
}
