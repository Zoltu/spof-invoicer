/**
 * Zcash payout-address syntax: the mainnet transparent `t1`/`t3` (Base58Check), Sapling `zs1`/`ZS1` (Bech32), unified `u1`/`U1` (Bech32m), and TEX `tex1`/`TEX1` (Bech32m) forms.
 *
 * Each accepted encoding carries the integrity check its own standard defines — Base58Check's double-SHA-256 suffix and Bech32's or Bech32m's six-character checksum — so an address that validates cannot be one mistyped character away from another address, and this module reads no further than that check: it decodes the text, compares the human-readable part with the one the form uses, bounds the length, and stops.
 * A transparent string is dispatched by its `t1`/`t3` text, but the two version bytes under that text are what admit it, and a version outside the mainnet pair is refused at that check even though the text prefix matched.
 * The forms those checks admit are stated once, in {@link ZCASH_ADDRESS_FORMS}, which they read through the constants below and the payee-facing hint `ui/create.ts` renders.
 * A unified address is accepted, not certified: ZIP 316 wraps its receivers in an F4Jumble encoding this module does not implement, so nothing behind the container is read and no set of receivers is claimed — the Bech32m checksum, the mainnet human-readable part `u`, the length bound below, and the payload size floor below are the whole of what {@link ZcashAddress}'s unified member certifies.
 * The payload is measured rather than parsed: ZIP 316 spells the receivers a container carries as the concatenation of one or more `typecode || length || addr` items, prefixes that list with the human-readable part padded to 16 bytes, and jumbles the whole with a length-preserving F4Jumble, while the `u` part this module accepts is the one whose addresses must carry at least one shielded receiver — so no container a payee's wallet can publish is shorter than {@link MIN_UNIFIED_PAYLOAD_BYTES}, and one below it is refused rather than certified as a payee.
 * A unified address is the default receiving form in modern wallets, so refusing the form outright would leave this app unable to invoice most Zcash payees.
 * A TEX address is ZIP-320's transparent-source-only spelling of an unshielded one: its payload is the 20-byte HASH160 a `t1`/`t3` address of the same script carries beside its version bytes, with no version bytes of its own, so the two spellings name one script and this module certifies the payload and nothing behind it — the Bech32m checksum, the mainnet human-readable part `tex`, the 42-character length a 20-byte payload takes, and that payload width.
 * An accepted TEX address is stored exactly as the payee wrote it, Bech32 case normalisation aside, and is never rewritten into the `t1…` or `t3…` spelling of the same hash: the spelling the payee published is the one an invoice carries.
 * The bound is drawn from what the address is turned into rather than from the address format: a ZIP-321 `zcash:` payment link carries the scheme, the address, `?amount=`, and the amount, and `payment/schemes.ts` derives {@link MAX_ZCASH_ADDRESS_LENGTH} from the capacity contract this app's budget and encoder share (`util/qr-capacity.ts`'s 412 bytes at version 15, level M) less what such a link spends on everything but the address — so the bound a container is held to and the ceiling its own link is encoded at are one derivation rather than two figures kept in step by hand, and a longer container is refused where the payee can still see what they pasted.
 * Every accepted form is mainnet-only: a testnet `tm`/`t2` transparent string, a testnet or regtest `ztestsapling`/`zregtest` Sapling one, Sprout's `zc`, a TEX address under the testnet `textest` part, and a unified container under another human-readable part — the testnet `utest` (`utest1…`) or the regtest `uregtest` — are all refused.
 * Neither the asset nor this validator carries a network, so for a unified address the decoded human-readable part is what tells mainnet from testnet: a container that decodes under the mainnet `u` is accepted, and one that decodes under any other part this module knows is refused as {@link TestnetUnifiedAddressError}, which names the network it addresses.
 * A TEX address is classified the same way and for the same reason: its decoded `textest` part is the only thing that says the paste addresses testnet, so it is refused as {@link TestnetTexAddressError}, which names that network rather than reporting a paste that is merely malformed.
 * A unified paste that is not such a container is refused as the malformed encoding it is — a broken checksum or alphabet, a mixed-case spelling, a container decoding under a part this module does not know, one whose data words are not a whole number of payload bytes, one carrying fewer payload bytes than a legal mainnet container has, and one longer than {@link MAX_ZCASH_ADDRESS_LENGTH} — rather than named as another network's address.
 * A TEX paste that is not such an address is refused as the malformed encoding it is — one longer than {@link MAX_BECH32_TEXT_LENGTH}, a mixed-case spelling, one of a character count no address of its own part has, a broken checksum or alphabet, one decoding under a part this module does not know, one whose data words are not a whole number of payload bytes, and a payload of another width than the {@link TEX_PAYLOAD_BYTES} its `t1`/`t3` twin carries — rather than named as another network's address, the distinction the container above draws.
 * A ZIP-321 `zcash:` payment link — the usual way one of these addresses gets copied — is refused as the link it is, not as the Sprout address whose `zc` text prefix the scheme shares, and never accepted in place of the address a link carries.
 * A Sprout spelling in either case is refused as a Sprout address, because it is the prefix that says which form the user pasted; the transparent case rule, which is about an accepted form's case-sensitive encoding, is not what is wrong with it.
 * Case is read the way the encoding defines it: a transparent `t1`/`t3` address is case-sensitive Base58Check, so a uniformly upper-case paste is refused as the different string it spells rather than case-folded into a spelling only this app produced, while a Bech32 candidate is read as BIP-173 defines it — either uniform case spells the same string, a mixed-case one spells nothing at all, and an accepted Sapling, unified, or TEX address is returned in the lower-case spelling the checksum is computed over.
 * Every branch bounds its input before the step that would grow with it: a transparent paste past {@link MAX_TRANSPARENT_TEXT_LENGTH} is refused ahead of Base58Check's quadratic conversion, a Sapling or TEX paste past {@link MAX_BECH32_TEXT_LENGTH} ahead of the word-to-byte conversion or the Bech32m decode, a unified paste past {@link MAX_ZCASH_ADDRESS_LENGTH} ahead of the Bech32m decode, and each case probe reads only text its own branch's bound already covers, so no branch case-maps or converts an unbounded paste, and each length refusal leads with the bound it applied rather than with the decoding step's own message.
 * A Bech32 or Bech32m paste the decoder refuses is refused for the length its form never has rather than for the decode's own reason, where the form has a fixed length: the length is reported as a detail of that failure, never read ahead of the decode, so a paste one character short of a Sapling address — which fails its checksum because a character is missing — is refused for being 77 characters where the form has 78, while a paste of the form's own length whose checksum really is wrong is refused for the checksum, and a unified container, which has no fixed length, is refused for the checksum alone.
 * A paste of another length whose checksum is instead valid over what it spells is not refused for its length at all: it decodes, so what answers it is that form's payload rule — a padding that is not a whole number of bytes, a payload width the form never has, or, for a unified container, the payload floor below, since a container is as long as the receivers it carries but one below the smallest legal set of them is refused rather than certified.
 * A refusal names the form it expected and never echoes a human-readable part it decoded that its own form's table does not carry, which is input-derived and can be arbitrarily long, while the part a network refusal names is read off one of those tables and is therefore a known short literal rather than text the paste wrote, so a hostile value cannot inflate the message it is refused with either way; the value itself trails as a bounded preview, which `util/errors.ts` also strips of the control, line-separator and bidi characters a rendered refusal must not carry.
 * A value of another type throws a `TypeError` — naming what arrived through that same bounded preview, so a non-string paste cannot inflate that message either; a string that fails any check throws {@link InvalidZcashAddressError} — its {@link TestnetUnifiedAddressError} or {@link TestnetTexAddressError} subclass only for an address on a network this app does not pay — whose message leads with the check that refused it and trails a bounded echo of the value, so the reason a user needs is not clipped away along with the value they pasted.
 */

import { PAYMENT_SCHEME_PREFIXES } from "../payment/scheme-prefixes.js";
import { MAX_ZCASH_ADDRESS_LENGTH } from "../payment/schemes.js";
import { base58check, bech32, bech32m, sha256, toHex } from "../util/encoding.js";
import { describe, preview } from "../util/errors.js";
import type { PayoutAddressForm } from "./payout-forms.js";

/**
 * A validated Zcash address string, tagged by the forms this module accepts: transparent `t1`/`t3` (case-sensitive Base58Check), and the Bech32 and Bech32m forms in either of the two spellings BIP-173 defines — Sapling `zs1…`/`ZS1…`, unified `u1…`/`U1…`, and TEX `tex1…`/`TEX1…`.
 *
 * Either Bech32 spelling is the same address, and {@link requireZcashAddress} returns the lower-case one the checksum is computed over, so a stored address has a single canonical spelling; a transparent address is case-sensitive and is stored and compared exactly as it was validated.
 * The spelling is therefore no part of what this type certifies: {@link isZcashAddress} admits both Bech32 spellings of one address, so a value narrowed by it can be either, and {@link requireZcashAddress} is the entry point that collapses the two to the one a stored address carries.
 * A unified member certifies a mainnet container — its Bech32m checksum, its `u` human-readable part, its length, and a payload at least as long as the smallest one a legal container can have — and not the receivers inside it, which this module never decodes.
 * A TEX member certifies a mainnet address of ZIP-320's transparent-source-only form — its Bech32m checksum, its `tex` human-readable part, and a 20-byte payload — and is kept in the `tex1…` spelling the payee wrote rather than rewritten into the `t1…` or `t3…` spelling that carries the same hash.
 */
export type ZcashAddress = AcceptedFormAddresses[AcceptedZcashForm];

/**
 * The text {@link ZcashAddress} admits for each accepted form, keyed by the form {@link classifyZcashAddress} names: a transparent address in either of its two Base58Check spellings, and each Bech32 or Bech32m form in the two spellings BIP-173 defines.
 *
 * The union above is this mapping read at {@link AcceptedZcashForm}, so the accepted forms and the union's members are one statement: a form added to that key set states its text here before the module compiles, and no form is admitted whose member the union does not carry.
 * Each member is derived from the prefix constant its form is dispatched by — {@link TRANSPARENT_VERSIONS}'s prefixes, {@link SAPLING_TEXT_PREFIX}, {@link UNIFIED_TEXT_PREFIX}, and {@link TEX_TEXT_PREFIX} — so renaming a prefix is a compile error here rather than a spelling this mapping still carries.
 */
interface AcceptedFormAddresses {
	readonly transparent: TransparentAddresses;
	readonly sapling: Bech32Addresses<typeof SAPLING_TEXT_PREFIX>;
	readonly unified: Bech32Addresses<typeof UNIFIED_TEXT_PREFIX>;
	readonly tex: Bech32Addresses<typeof TEX_TEXT_PREFIX>;
}

/** A transparent address's text: the spelling each prefix in {@link TRANSPARENT_VERSIONS} leads, read off that table so a renamed prefix breaks this derivation instead of leaving a spelling behind. */
type TransparentAddresses = `${(typeof TRANSPARENT_VERSIONS)[number]["prefix"]}${string}`;

/** A Bech32 or Bech32m address's text under the text prefix `Prefix`, in the two cases BIP-173 spells a string in: the prefix and its upper-case form, derived rather than written beside it. */
type Bech32Addresses<Prefix extends string> = `${Prefix}${string}` | `${Uppercase<Prefix>}${string}`;

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
 * Mainnet's transparent version bytes, each paired with the text prefix its encoding carries: `0x1CB8` for a P2PKH (`t1`) address and `0x1CBD` for a P2SH (`t3`) one.
 *
 * The pairs are the single source for the version bytes the version check admits, for the text prefixes {@link classifyZcashAddress} dispatches on, and for the listing {@link transparentRefusal} names, so a version a check accepts cannot be missing from a refusal or from the dispatch.
 * The prefixes are literal types, so {@link TransparentAddresses} reads the spellings this table carries rather than repeating them.
 */
const TRANSPARENT_VERSIONS = [
	{ version: 0x1cb8, prefix: "t1" },
	{ version: 0x1cbd, prefix: "t3" },
] as const satisfies readonly { readonly version: number; readonly prefix: string }[];

/** The separator BIP-173 puts between a Bech32 string's human-readable part and its data words. */
const BECH32_SEPARATOR = "1";

/**
 * `hrp` as the text prefix an address of that part leads with: the part followed by the {@link BECH32_SEPARATOR} that separates it from the data words.
 *
 * The return type is the literal prefix, so each form's text spelling is derived from the part it carries — {@link SAPLING_TEXT_PREFIX}, {@link UNIFIED_TEXT_PREFIX}, and {@link TEX_TEXT_PREFIX} are the one statement of it — rather than written out beside the part a second time.
 */
function bech32PrefixOf<Part extends string>(hrp: Part): `${Part}${typeof BECH32_SEPARATOR}` {
	return `${hrp}${BECH32_SEPARATOR}`;
}

/** The six characters a Bech32 or Bech32m checksum occupies. */
const BECH32_CHECKSUM_CHARACTERS = 6;

/** The bits one payload byte carries. */
const BITS_PER_BYTE = 8;

/** The bits one base32 data word carries, which is why a payload takes a word per five bits rather than per eight. */
const BITS_PER_WORD = 5;

/**
 * The characters a Bech32 or Bech32m spelling of `payloadBytes` occupies under `hrp`: the part, the separator, the data words the payload's bits take rounded up to whole words, and the checksum.
 *
 * A form's text length is derived through here rather than stated beside the payload width it belongs to, so the two figures cannot disagree.
 */
function bech32TextLength(hrp: string, payloadBytes: number): number {
	return hrp.length + BECH32_SEPARATOR.length + Math.ceil((payloadBytes * BITS_PER_BYTE) / BITS_PER_WORD) + BECH32_CHECKSUM_CHARACTERS;
}

/** The raw Sapling payment address: an 11-byte diversifier followed by the 32-byte `pk_d`. */
const SAPLING_PAYLOAD_BYTES = 43;

/** The human-readable part a mainnet Sapling address carries, read by the text length below and by the part check {@link saplingRefusal} applies. */
const SAPLING_MAINNET_HRP = "zs";

/** The characters a mainnet Sapling address occupies, derived from its payload width rather than stated beside it, as each TEX part length is: the human-readable part, the separator, the 69 words a 43-byte payload takes, and the checksum. */
const SAPLING_TEXT_LENGTH = bech32TextLength(SAPLING_MAINNET_HRP, SAPLING_PAYLOAD_BYTES);

/**
 * The longest paste the uniform-case probe at the end of {@link classifyZcashAddress} case-maps: the longer of {@link MAX_TRANSPARENT_TEXT_LENGTH} and {@link SAPLING_TEXT_LENGTH}, 78 characters.
 *
 * A Sapling, unified, or TEX candidate is dispatched by a text prefix read in either case, so the probe only answers a paste no form claimed, and the one accepted spelling it can name is a transparent address in the other case — no longer than {@link MAX_TRANSPARENT_TEXT_LENGTH}.
 * The figure bounds what the probe may case-map rather than what it has to name: a paste past it is refused without being case-mapped, so the mapping never runs over input of unbounded length.
 * It bounds that probe alone rather than the text this module accepts, which reaches {@link MAX_ZCASH_ADDRESS_LENGTH} for a unified container.
 */
const MAX_CASE_PROBE_TEXT_LENGTH = Math.max(MAX_TRANSPARENT_TEXT_LENGTH, SAPLING_TEXT_LENGTH);

/**
 * The longest text the Bech32 branches read: the Bech32 codec's 90-character cap, which is also BIP-173's own limit on a Bech32 string.
 *
 * It is the bound {@link saplingRefusal} checks before its decode and the bound {@link TEX_FORM} states for {@link bech32mRefusal}, passed to each decode as an explicit limit, so the readers of the bound cannot drift apart and an over-long paste is refused on its length, under its own reason, rather than by the codec's generic checksum message.
 */
const MAX_BECH32_TEXT_LENGTH = 90;

/**
 * The transparent and Sapling text prefixes a candidate is dispatched on, each read off the table its own form is stated in: the `t1`/`t3` pair from {@link TRANSPARENT_VERSIONS}, and `zs1` from {@link SAPLING_MAINNET_HRP} by {@link bech32PrefixOf}.
 *
 * The unified and TEX prefixes are derived the same way from their own tables — {@link UNIFIED_TEXT_PREFIX} from {@link UNIFIED_HRPS} and {@link TEX_TEXT_PREFIX} from {@link TEX_HRPS} — so a form's text prefix is always spelled from the part that admits it, and a form added later states its prefix where its parts are listed rather than being written into this block or into the dispatch.
 * Because every prefix is read off its own form's table, the text a string is dispatched by and the version or part that admits it cannot drift apart.
 * A leading text prefix is not the human-readable part: a Bech32 string's part runs up to its last `1`, so a string that starts `zs1` can carry another part and still satisfy that other part's own checksum — the decoded part, not the leading text, is what admits a Sapling address.
 * Text leading with a Bech32 prefix is therefore a candidate that decodes under that part, not yet an accepted address.
 */
const TRANSPARENT_TEXT_PREFIXES: readonly string[] = TRANSPARENT_VERSIONS.map(({ prefix }) => prefix);
const SAPLING_TEXT_PREFIX = bech32PrefixOf(SAPLING_MAINNET_HRP);

/** Sprout's mainnet Base58Check prefix; Sprout cannot receive funds, so the prefix is named rather than left to the generic refusal, and it is probed in either case because it is the form the paste points at rather than a spelling this module accepts. */
const SPROUT_TEXT_PREFIX = "zc";

/**
 * The scheme of a ZIP-321 `zcash:` payment link: the usual way one of these addresses reaches a clipboard, and no address this module accepts.
 *
 * The prefix is read off `payment/scheme-prefixes.ts`'s `PAYMENT_SCHEME_PREFIXES`, the scheme table the link builder spells from too, so the courtesy refusal that tells a payee to paste the address rather than the link cannot name a scheme no builder uses.
 * A link shares Sprout's `zc` text prefix, so without a branch of its own it would be refused as a Sprout address — a statement about the value that is not true of it — while `:` is outside base58's alphabet, so no Sprout address can be mistaken for a link.
 */
const PAYMENT_LINK_PREFIX = PAYMENT_SCHEME_PREFIXES.zcash;

/** The one network this app pays, named here once for the human-readable-part tables below, each of which pairs a part with the network it addresses. */
const MAINNET_NETWORK = "mainnet";

/** The unified human-readable part a mainnet container is addressed under. */
const UNIFIED_MAINNET_HRP = "u";

/** The text prefix a mainnet unified address leads with, spelled from {@link UNIFIED_MAINNET_HRP} by {@link bech32PrefixOf}: the one statement of it the hint entry and the {@link ZcashAddress} member both read. */
const UNIFIED_TEXT_PREFIX = bech32PrefixOf(UNIFIED_MAINNET_HRP);

/**
 * The networks the human-readable-part tables below name: {@link MAINNET_NETWORK}, the one this app pays, and the two whose addresses it refuses by name.
 *
 * A part's network is only ever one of these literals, so a table entry cannot carry a mistyped spelling that compares unequal to {@link MAINNET_NETWORK} and silently reclassifies a payable mainnet address as another network's.
 */
type ZcashNetworkName = "mainnet" | "testnet" | "regtest";

/**
 * The networks a human-readable-part table names that this app does not pay: {@link ZcashNetworkName} less {@link MAINNET_NETWORK}.
 *
 * A network refusal is raised only for a paste that decoded under one of these, so the error constructors below take this narrower type and the impossible "a mainnet address cannot be paid from a mainnet-only invoice" state cannot be constructed at all.
 */
type UnpayableZcashNetwork = Exclude<ZcashNetworkName, typeof MAINNET_NETWORK>;

/**
 * The networks {@link TEX_HRPS} names that this app does not pay: `testnet` alone, since ZIP-320 pairs the mainnet `tex` part with the testnet `textest` one and defines no regtest TEX part.
 *
 * {@link TestnetTexAddressError} takes this narrower type rather than {@link UnpayableZcashNetwork}, so a refusal naming a regtest TEX address — a network no TEX human-readable part spells — cannot be constructed at all.
 */
type UnpayableTexNetwork = Extract<UnpayableZcashNetwork, "testnet">;

/**
 * One human-readable part a Bech32m form's table carries, paired with the network it addresses: the decoding's part, which is what classifies a paste, and the network this app either pays or names in its refusal.
 *
 * A part this app pays is a {@link PayableHrpNetwork} and carries no refusal, while a part on another network is an {@link UnpayableHrpNetwork} and carries the refusal a paste that decodes under it gets, so the class a form refuses another network's address with is stated in that form's own table.
 * Both Bech32m forms this module reads state their parts as a table of these, and one set of helpers reads every table: the text prefixes {@link classifyZcashAddress} dispatches on, the part that classifies a decoded paste, and the listing a refusal names.
 */
type HrpNetwork = PayableHrpNetwork | UnpayableHrpNetwork;

/**
 * The human-readable part `hrp` on {@link MAINNET_NETWORK}, the one network this app pays: the part a paste decodes under when it addresses a payout this app can carry, and therefore the one part whose network is never refused.
 *
 * The network is the literal {@link MAINNET_NETWORK} rather than the wider {@link ZcashNetworkName}, which is what tells a payable part from an {@link UnpayableHrpNetwork} at compile time: a refusal reads the class it constructs off the entry the decoding matched, so no refusal path narrows a network read at run time.
 */
interface PayableHrpNetwork {
	readonly hrp: string;
	readonly network: typeof MAINNET_NETWORK;
}

/**
 * The human-readable part `hrp` on a network this app does not pay, with the refusal a paste that decodes under it gets.
 *
 * The refusal is built by {@link unpayablePart} from the entry's own network, so the network the entry states and the network its clause names are one statement.
 */
interface UnpayableHrpNetwork {
	readonly hrp: string;
	readonly network: UnpayableZcashNetwork;
	readonly refusal: (value: string, reason: string) => InvalidZcashAddressError;
}

/**
 * An error class a form refuses another network's part with, constructed from the paste, the entry's own network, and the reason the refusal gives.
 *
 * Each class keeps the network parameter it declares — {@link TestnetTexAddressError} takes {@link UnpayableTexNetwork}, while {@link TestnetUnifiedAddressError} takes any {@link UnpayableZcashNetwork} — so a table entry naming a network its form's class cannot spell is a compile error where the table is written rather than a refusal constructed at run time.
 */
interface NetworkRefusalClass<Network extends UnpayableZcashNetwork> {
	new (value: string, network: Network, reason: string): InvalidZcashAddressError;
}

/**
 * The {@link UnpayableHrpNetwork} for `hrp` on `network`, refused by the error class `Construct`.
 *
 * The entry states its network once and the refusal it carries names that same network, so an entry cannot be listed under one network and refused as another.
 * This factory is the one adapter between the table and the error class: it closes over the entry's `network` and hands it to the class's constructor beside the paste and the reason, so each row of a table states a part, a network, and a class rather than a small builder function of its own.
 */
function unpayablePart<Network extends UnpayableZcashNetwork>(
	hrp: string,
	network: Network,
	Construct: NetworkRefusalClass<Network>,
): UnpayableHrpNetwork {
	return { hrp, network, refusal: (value, reason) => new Construct(value, network, reason) };
}

/** The bytes a TEX payload carries: the {@link TRANSPARENT_HASH_BYTES}-byte HASH160 a `t1`/`t3` transparent payload carries beside its version bytes, with no version bytes of its own, so the two spellings name one script. */
const TEX_PAYLOAD_BYTES = TRANSPARENT_HASH_BYTES;

/**
 * The human-readable part a mainnet TEX address carries: ZIP-320's `tex`, which is the part {@link TEX_HRPS} admits and the one {@link bech32mRefusal} classifies a decoded TEX paste by.
 * The name says which network's part it is because {@link TEX_HRPS} lists the testnet `textest` part beside it: the mainnet part is the one this module pays, not the form's only part.
 */
const TEX_MAINNET_HRP = "tex";

/** The text prefix a mainnet TEX address leads with, spelled from {@link TEX_MAINNET_HRP} by {@link bech32PrefixOf}: the one statement of it that the payee hint renders, {@link classifyZcashAddress} dispatches on, and the refusals that name it read. */
const TEX_TEXT_PREFIX = bech32PrefixOf(TEX_MAINNET_HRP);

/**
 * The form an accepted address carries: which validator admitted it, and therefore whether a stored value is the lower-case spelling.
 *
 * There is one member per accepted form, so the case rule {@link CASE_FOLDED_FORMS} states covers exactly the forms {@link classifyZcashAddress} dispatches, and the hint entry {@link ADDRESS_FORM_HINTS} names each of them.
 */
type AcceptedZcashForm = "transparent" | "sapling" | "unified" | "tex";

/**
 * The forms this module accepts, for the payout-address hint `ui/create.ts` renders: the transparent `t1`/`t3` pair, Sapling's `zs1`, the mainnet unified `u1`, and the mainnet TEX `tex1`.
 *
 * The mapping is total over {@link AcceptedZcashForm}, as {@link CASE_FOLDED_FORMS} is, so a form added to that key set states its hint entry here before the module compiles and no form this validator takes can silently miss the hint.
 * Every entry is read off the constants the checks below apply — {@link TRANSPARENT_VERSIONS}, {@link SAPLING_TEXT_PREFIX}, {@link UNIFIED_TEXT_PREFIX}, and {@link TEX_TEXT_PREFIX} — so a form the hint names is one this validator takes and one this validator takes is named by the hint; the sentence around those entries is the UI layer's own wording rather than a second statement of the forms.
 */
const ADDRESS_FORM_HINTS: Readonly<Record<AcceptedZcashForm, PayoutAddressForm>> = Object.freeze({
	transparent: Object.freeze({ name: "transparent", prefixes: Object.freeze([...TRANSPARENT_TEXT_PREFIXES]) }),
	sapling: Object.freeze({ name: "Sapling", prefixes: Object.freeze([SAPLING_TEXT_PREFIX]) }),
	unified: Object.freeze({ name: "unified", prefixes: Object.freeze([UNIFIED_TEXT_PREFIX]) }),
	tex: Object.freeze({ name: "TEX", prefixes: Object.freeze([TEX_TEXT_PREFIX]) }),
});

/**
 * {@link ADDRESS_FORM_HINTS}'s entries in the order the mapping states them, as the payee hint and the catch-all refusal read them: the transparent `t1`/`t3` pair, Sapling's `zs1`, the mainnet unified `u1`, and the mainnet TEX `tex1`.
 *
 * The order is the mapping's own, so the transparent pair is the first form either surface lists and TEX the last.
 */
export const ZCASH_ADDRESS_FORMS: readonly PayoutAddressForm[] = Object.freeze(Object.values(ADDRESS_FORM_HINTS));

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
 * The bytes ZIP 316 pads the human-readable part to before F4Jumble, and therefore the bytes every container carries ahead of its item list.
 *
 * The padding is what keeps the parts distinguishable once jumbled, so it is part of the container the Bech32m checksum covers rather than an annotation beside it.
 */
const UNIFIED_PADDED_PART_BYTES = 16;

/**
 * The bytes that frame each item in a container's item list: the `compactSize` typecode and the `compactSize` length of the receiver encoding that follows it.
 *
 * Each is one byte at the typecodes and receiver widths ZIP 316 defines today, the shorter `compactSize` form taking every value below 253.
 */
const RECEIVER_ITEM_PREFIX_BYTES = 2;

/**
 * The fewest payload bytes a unified-address container may carry: 61, the smallest container a legal mainnet address can have.
 *
 * The bytes measured here are the container the Bech32m checksum covers, and ZIP 316 builds that container as F4Jumble over the item list prefixed by the human-readable part padded with zero bytes to {@link UNIFIED_PADDED_PART_BYTES}, so the container is that much longer than the item list itself.
 * The item list is the concatenation of one or more items, each a `typecode` (`compactSize`), a `length` (`compactSize`), and that many bytes of receiver.
 * The `u` part this module accepts is the pre-Revision-2 spelling, whose addresses must carry at least one shielded receiver, and a shielded receiver is an Orchard or Sapling raw address of {@link SAPLING_PAYLOAD_BYTES} bytes — a diversifier and a `pk_d`, the width a Sapling address is — framed by {@link RECEIVER_ITEM_PREFIX_BYTES}, so the shortest item list that revision permits is 45 bytes.
 * A transparent P2PKH or P2SH receiver is shorter still, a 20-byte hash framed the same way, but a container carrying only transparent receivers is not a legal address of that part, so a 22-byte item list names no address a payee's wallet can have published.
 * One below this floor is therefore refused rather than certified as a payable mainnet address: the checksum, the human-readable part, and the length bound above admit a container of any payload whatever, which would otherwise be rendered to the payee as the address the invoice pays to.
 * The floor is inclusive at the smallest legal container — librustzcash's 106-character round-trip vector is a 61-byte container holding one shielded receiver — and it is exported so the suite that pins this boundary names the floor where it refuses and admits a container rather than restating the figure beside it.
 */
export const MIN_UNIFIED_PAYLOAD_BYTES = UNIFIED_PADDED_PART_BYTES + RECEIVER_ITEM_PREFIX_BYTES + SAPLING_PAYLOAD_BYTES;

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
	constructor(value: string, network: UnpayableZcashNetwork, reason: string) {
		super(value, reason, `a ${network} unified address cannot be paid from a mainnet-only invoice`);
		this.name = "TestnetUnifiedAddressError";
	}
}

/**
 * Raised by {@link requireZcashAddress} for a TEX address on a network this app does not pay: the testnet `textest` part {@link TEX_HRPS} names.
 *
 * It is {@link TestnetUnifiedAddressError}'s sibling for the other Bech32m form: the decoded human-readable part is the only evidence a TEX paste carries a network, so a paste that decodes under `textest` is a real testnet address, and it is refused by the network it names rather than for a check it passed.
 * It extends {@link InvalidZcashAddressError} too, so a caller that catches every refusal still catches this one, while a caller that distinguishes them can report "a testnet TEX address" from this class alone rather than reading the message.
 * It takes {@link UnpayableTexNetwork} rather than the wider set of unpayable networks, so the network its clause names is one a TEX human-readable part actually carries, and {@link TEX_HRPS} threads that type through {@link unpayablePart}, which refuses a TEX entry naming any other part where the table is written.
 */
export class TestnetTexAddressError extends InvalidZcashAddressError {
	constructor(value: string, network: UnpayableTexNetwork, reason: string) {
		super(value, reason, `a ${network} TEX address cannot be paid from a mainnet-only invoice`);
		this.name = "TestnetTexAddressError";
	}
}

/**
 * The Bech32m human-readable part a unified address carries on each network this module names, each paired with the network it addresses: mainnet `u`, testnet `utest`, and regtest `uregtest`.
 *
 * The text prefixes {@link classifyZcashAddress} dispatches a candidate on are read off this list, so the text that admits a candidate and the part that classifies it cannot drift apart, and a container that decodes under a part this list does not carry is not a unified address whatever its text began with.
 * Only the first entry is payable here: a paste that decodes under another one is refused by name, because this app's invoices are mainnet-only and the human-readable part is the only thing that says which network a container addresses, and each of those parts carries the class it is refused by through {@link unpayablePart}.
 */
const UNIFIED_HRPS: readonly HrpNetwork[] = [
	{ hrp: UNIFIED_MAINNET_HRP, network: MAINNET_NETWORK },
	unpayablePart("utest", "testnet", TestnetUnifiedAddressError),
	unpayablePart("uregtest", "regtest", TestnetUnifiedAddressError),
];

/**
 * The Bech32m human-readable part a TEX address carries on each network this module names, each paired with the network it addresses: mainnet `tex` and testnet `textest`.
 *
 * The text prefixes {@link classifyZcashAddress} dispatches a TEX candidate on are read off this list, so the text that admits a candidate and the part that classifies it cannot drift apart, and a paste that decodes under a part this list does not carry is not a TEX address whatever its text began with.
 * Only the mainnet entry is payable here: ZIP-320 pairs the testnet part with mainnet's, so a paste under `textest` is a real testnet address and is refused by name rather than as a malformed one, which is the same distinction the unified table above draws, and the testnet entry carries {@link TestnetTexAddressError} through {@link unpayablePart}, whose {@link NetworkRefusalClass} parameter holds that entry's `testnet` to the one network the class spells.
 */
const TEX_HRPS: readonly HrpNetwork[] = [
	{ hrp: TEX_MAINNET_HRP, network: MAINNET_NETWORK },
	unpayablePart("textest", "testnet", TestnetTexAddressError),
];

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
 * The words are returned unconverted: turning them into payload bytes is {@link saplingPayloadBytes}'s own step, whose failure means something the checks above never touch, so a word count that maps to no whole byte is not reported as a broken checksum it did not have.
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
 * The number of payload bytes `words` carry, or `null` when they are not a whole number of payload bytes.
 *
 * Bech32 spells a payload as 5-bit words whose last byte is padded with zero bits, and the codec's converter throws both for a word count with more trailing bits than that padding accounts for and for one whose trailing bits are not zero — the checksum and alphabet checks behind {@link decodeSapling} admit either.
 * Only the count is kept, as {@link bech32mPayloadBytes} keeps its own: the check below compares the payload's width, so the bytes the converter produces are measured and discarded rather than held.
 */
function saplingPayloadBytes(words: number[]): number | null {
	try {
		return bech32.fromWords(words).length;
	} catch {
		return null;
	}
}

/**
 * Why `text` is spelled in neither case a Bech32 string may be, or `null` when it is spelled in one of them.
 *
 * BIP-173 spells a Bech32 string either uniformly lower case or uniformly upper case — the checksum is computed over the lower-case spelling of both, which is why the codec accepts either and refuses a mixed-case one — so this names the case rule for a paste the codec would otherwise refuse as though its checksum were wrong.
 * Both callers refuse a paste past their own form's bound before they get here, so the two case maps below never run over input that could be arbitrarily long.
 */
function mixedCaseReason(text: string, scheme: string): string | null {
	const lower = text.toLowerCase();
	if (lower === text || text.toUpperCase() === text) {
		return null;
	}
	return `it mixes upper and lower case, and ${scheme} spells a string either uniformly lower case or uniformly upper case`;
}

/**
 * The reason a paste of a length its form never has is refused with, or `null` when its length is the form's own: the expected and the obtained character counts, and never a check the paste passed.
 *
 * `form` names the form and part the length belongs to — `Sapling zs1`, `mainnet TEX tex1`, `testnet TEX textest1` — so each caller states its own form's figures and this states the wording once.
 */
function formLengthReason(text: string, expectedCharacters: number, form: string): string | null {
	return text.length === expectedCharacters ? null : `expected ${expectedCharacters} characters for a ${form} address, got ${text.length}`;
}

/**
 * The reason a paste past its form's character bound is refused with: the bound applied and the count obtained.
 *
 * `form` names the form and part the bound belongs to — `Sapling zs1`, `mainnet TEX tex1`, `testnet TEX textest1` — so each caller states its own form's bound and part and this states the sentence once, as {@link formLengthReason} does for the length a form never has.
 */
function overLengthReason(text: string, maxCharacters: number, form: string): string {
	return `expected at most ${maxCharacters} characters for a ${form} address, got ${text.length}`;
}

/**
 * The reason a paste the codec refused outright is refused with: `scheme` names the encoding — `Bech32` or `Bech32m` — so the two Bech32 ladders state the sentence once, as {@link mixedCaseReason} states the case rule they share.
 *
 * The decoder raises this same error for a broken checksum and for a character outside its alphabet, so the reason names both rather than a check the paste may have passed.
 */
function checksumReason(scheme: string): string {
	return `its ${scheme} checksum or alphabet is wrong`;
}

/**
 * The reason a paste whose data words are not a whole number of payload bytes is refused with: `scheme` names the encoding whose padding rule the count breaks.
 *
 * The count is what the paste carries and the padding rule is what it must have been built under, so the reason names both, as {@link checksumReason} names the two failures its decoder collapses.
 */
function paddingReason(words: number, scheme: string): string {
	return `its ${words} data words are not a whole number of payload bytes, and ${scheme} pads a payload's last byte with zero bits`;
}

/**
 * The refusal `text` gets for not being a mainnet Sapling `zs1` address, or `null` when it is one.
 *
 * The bound is checked here rather than left to the codec, which refuses a paste past {@link MAX_BECH32_TEXT_LENGTH} with the same error it raises for a broken alphabet or checksum: that reason would misstate what is wrong with a paste that is merely too long, so this refusal names the bound instead, as the transparent branch's own length refusal does.
 * The decode and the word-to-byte conversion are read separately, under a reason each, for the same reason: the codec refuses a data run that is not a whole number of payload bytes with the same error it raises for a bad checksum, so a paste every check over its text admits is refused for the padding that is actually wrong with it rather than for a check that passed.
 */
function saplingRefusal(text: string): InvalidZcashAddressError | null {
	if (text.length > MAX_BECH32_TEXT_LENGTH) {
		return new InvalidZcashAddressError(text, overLengthReason(text, MAX_BECH32_TEXT_LENGTH, `Sapling ${SAPLING_TEXT_PREFIX}`));
	}
	const mixed = mixedCaseReason(text, "Bech32");
	if (mixed !== null) {
		return new InvalidZcashAddressError(text, mixed);
	}
	const decoded = decodeSapling(text);
	if (decoded === null) {
		// A paste of a length the Sapling form never has cannot be one whatever its checksum reads, so the length is what it is refused for; a paste of the form's own length is refused for the checksum it failed.
		const length = formLengthReason(text, SAPLING_TEXT_LENGTH, `Sapling ${SAPLING_TEXT_PREFIX}`);
		if (length !== null) return new InvalidZcashAddressError(text, length);
		return new InvalidZcashAddressError(text, checksumReason("Bech32"));
	}
	if (decoded.prefix !== SAPLING_MAINNET_HRP) {
		// The decoded part is read off the input and can be arbitrarily long on a hostile paste, so the refusal names the part it expected instead of echoing the one it found.
		return new InvalidZcashAddressError(text, `expected the Bech32 human-readable part ${describe(SAPLING_MAINNET_HRP)} (mainnet Sapling)`);
	}
	const payloadBytes = saplingPayloadBytes(decoded.words);
	if (payloadBytes === null) {
		// The checksum covers the words and the decode above verified it, so the failure is the word count rather than any check over the text, and the reason names that count beside the padding rule it breaks.
		return new InvalidZcashAddressError(text, paddingReason(decoded.words.length, "Bech32"));
	}
	if (payloadBytes !== SAPLING_PAYLOAD_BYTES) {
		return new InvalidZcashAddressError(text, `expected a ${SAPLING_PAYLOAD_BYTES}-byte Sapling payment address, got ${payloadBytes} bytes`);
	}
	return null;
}

/**
 * True when `text` leads with `prefix` in either case, reading no more than the prefix.
 *
 * Two kinds of text are dispatched this way: a Bech32 string's leading text, which BIP-173 spells in either case, so both spellings are one address and one branch reads both; and a prefix that names the form a paste points at — a URI scheme, Sprout's `zc`, a unified or TEX container's human-readable part — where the form is what a refusal should name whatever case the paste happens to use.
 * Reading no more than the prefix keeps the comparison off text that a branch's own bound has yet to limit.
 */
function leadsWithPrefixInEitherCase(text: string, prefix: string): boolean {
	return text.slice(0, prefix.length).toLowerCase() === prefix;
}

/** The {@link HrpNetwork} entry of `hrps` whose text prefix `text` leads with — the part {@link bech32PrefixOf} spells it into, in either case — or `null` when `text` is not a candidate for that form. */
function hrpCandidate(text: string, hrps: readonly HrpNetwork[]): HrpNetwork | null {
	return hrps.find(({ hrp }) => leadsWithPrefixInEitherCase(text, bech32PrefixOf(hrp))) ?? null;
}

/** The {@link HrpNetwork} entry of `hrps` for a decoded human-readable part, or `null` when the part is not one that table carries — the same absent value {@link hrpCandidate} answers with for its own miss. */
function knownHrp(hrps: readonly HrpNetwork[], hrp: string): HrpNetwork | null {
	return hrps.find((candidate) => candidate.hrp === hrp) ?? null;
}

/** `hrps` as a refusal lists them, each with the network it addresses: `"u" (mainnet), "utest" (testnet), "uregtest" (regtest)`. */
function hrpList(hrps: readonly HrpNetwork[]): string {
	return hrps.map(({ hrp, network }) => `${describe(hrp)} (${network})`).join(", ");
}

/**
 * The Bech32m human-readable part of `text` and the data words behind it, or `null` when the encoding itself is broken.
 *
 * `limit` is the bound the caller measured the paste against before this call — {@link MAX_ZCASH_ADDRESS_LENGTH} for a unified container and {@link MAX_BECH32_TEXT_LENGTH} for a TEX address — so the decode's cap and the caller's own check cannot drift apart.
 * The words are carried out unconverted, as the Sapling branch's decoder carries its own: they are turned into payload bytes by {@link bech32mPayloadBytes}, a step of its own whose failure means the padding rather than any check over the text.
 */
function decodeBech32m(text: string, limit: number): { readonly hrp: string; readonly words: number[] } | null {
	try {
		const decoded = bech32m.decode(text, limit);
		return { hrp: decoded.prefix, words: decoded.words };
	} catch {
		return null;
	}
}

/**
 * The number of payload bytes `words` carry, or `null` when they are not a whole number of payload bytes.
 *
 * A Bech32m string is the spelling of a byte string, so a word count that is not one is not the payload it claims to be; the codec's converter throws both for a count with more trailing bits than the padding accounts for and for one whose trailing bits are not zero, and each is reported as the padding that is actually wrong rather than as a checksum the paste passed.
 * Only the count is kept, as {@link saplingPayloadBytes} keeps its own: a unified container's bytes are measured and discarded because nothing behind the container is read, and a TEX payload is measured for its width rather than parsed.
 */
function bech32mPayloadBytes(words: number[]): number | null {
	try {
		return bech32m.fromWords(words).length;
	} catch {
		return null;
	}
}

/**
 * The refusal a unified candidate past the form's own {@link MAX_ZCASH_ADDRESS_LENGTH} bound gets: the QR budget that refused it, not the address form it otherwise is.
 *
 * The bound is handed in as the form's own figure rather than restated here, so the length that refused the paste and the length the reason quotes are one number.
 * The bound is applied before the container is decoded, so a paste past it is never classified by the network its text prefix names — a bound this app applies to a mainnet address leaves no container to read.
 * It takes the paste and the bound, not the part: what refused the value is this app's QR budget rather than the form or the network its spelling names, so the part a Bech32m candidate carries says nothing about this refusal.
 */
function unifiedOverLengthRefusal(text: string, maxTextLength: number): InvalidZcashAddressError {
	return new InvalidZcashAddressError(
		text,
		`it is longer than the ${maxTextLength} characters a \`zcash:\` payment link carries in this app's QR symbol`,
		"a unified-address candidate is longer than this app's QR symbol carries",
	);
}

/**
 * One of the two Bech32m forms this module reads — a unified container and a ZIP-320 TEX address — as {@link bech32mRefusal} reads it.
 *
 * The steps a paste of either form goes through are the same and in the same order, so they live once in that helper; what differs between the forms is stated here as data: the human-readable parts the form is addressed under, the bound its text is measured against, the length reason its fixed-length text states for each of its parts, and the rules its over-long text and its payload are held to.
 * Each form-specific refusal is supplied as a reason or an error of its own rather than spelled at a call site, so the wording both forms share — the checksum, the padding, and the part-list messages — is written once in the helper while each form keeps its own wording beside its own entry.
 * A paste on another network is refused through the entry its own decoding matched, so the class each form's refusals construct is stated in that form's table rather than here.
 */
interface Bech32mForm {
	/** The form as the unknown-part refusal names it: `unified address` or `TEX address`. */
	readonly label: string;
	/** The human-readable parts the form is addressed under, each paired with the network it names and, on a network this app does not pay, the refusal a paste that decodes under it gets; the first entry is the mainnet part, which is the payout part the form pays and its refusals name. */
	readonly hrps: readonly HrpNetwork[];
	/** The bound the paste is measured against before its decode, and the limit its decode and its case probe read it under. */
	readonly maxTextLength: number;
	/** The refusal a paste past `maxTextLength` gets, handed that bound so the figure that refused the paste and the figure its reason quotes are one, worded by the form whose bound refused it and, for the fixed-length TEX text, by the part the paste's own spelling names. */
	readonly overLength: (text: string, maxTextLength: number, part: HrpNetwork) => InvalidZcashAddressError;
	/** The reason a paste of a length the form never has is refused with, or `null` when the form's text has no fixed length. */
	readonly lengthReason: ((text: string, part: HrpNetwork) => string | null) | null;
	/** The reason a payload of `bytes` bytes is refused with, or `null` when its width is the form's own. */
	readonly payloadReason: (bytes: number) => string | null;
}

/**
 * The refusal a paste of a Bech32m form gets, or `null` when it is an accepted mainnet address of that form.
 *
 * `part` is the human-readable-part entry the paste's leading text names, which {@link bech32mAnswer} resolved as it recognized the candidate and carried in, and it words the TEX form's two refusals that answer a paste before its payload is read — the bound applied ahead of the decode, and the length a failed decode is reported for — while the unified form states no fixed text length and its bound refusal is worded by the QR budget that refused it.
 * That entry is the part the leading text spells, not the part the decode produces: the two are the same for a well-formed paste and can differ for any other, since a string leading `tex1` can carry another part and still satisfy that part's checksum, so the decoded part is looked up in the form's table by {@link knownHrp} once the decode has produced it, and that lookup misses for a part the form does not carry even where the recognition step found a candidate.
 * The order of the checks is the reason each paste reads as it does: the bound comes before the decode, the decoded human-readable part decides the network, a paste of a length no address of the form has is refused for that length where the decode is what noticed it, and the payload is measured last, so a paste is refused for the one thing that is wrong with it.
 * The part decides the network before the payload is measured, so a well-formed address on another network is refused by name whatever its payload is, and only a mainnet one is held to the payload rule its form states.
 */
function bech32mRefusal(text: string, form: Bech32mForm, part: HrpNetwork): InvalidZcashAddressError | null {
	if (text.length > form.maxTextLength) {
		return form.overLength(text, form.maxTextLength, part);
	}
	const mixed = mixedCaseReason(text, "Bech32m");
	if (mixed !== null) {
		return new InvalidZcashAddressError(text, mixed);
	}
	const decoded = decodeBech32m(text, form.maxTextLength);
	if (decoded === null) {
		// The length answers a failed decode before the checksum does, for the reason the Sapling branch's own decode-failure comment records.
		const length = form.lengthReason === null ? null : form.lengthReason(text, part);
		if (length !== null) return new InvalidZcashAddressError(text, length);
		return new InvalidZcashAddressError(text, checksumReason("Bech32m"));
	}
	const known = knownHrp(form.hrps, decoded.hrp);
	if (known === null) {
		// The decoded part is read off the input and can be arbitrarily long on a hostile paste, so the refusal names the parts it expects instead of echoing the one it found.
		return new InvalidZcashAddressError(text, `expected the Bech32m human-readable part ${hrpList(form.hrps)} for a ${form.label}`);
	}
	if (known.network !== MAINNET_NETWORK) {
		return known.refusal(
			text,
			`it decodes under the Bech32m human-readable part ${describe(known.hrp)} (${known.network}), and only the mainnet part ${describe(form.hrps[0].hrp)} is a payout address this app pays`,
		);
	}
	const payloadBytes = bech32mPayloadBytes(decoded.words);
	if (payloadBytes === null) {
		// The checksum covers the words and the decode above verified it, so the failure is the word count rather than any check over the text, exactly as the Sapling branch reports the same count.
		return new InvalidZcashAddressError(text, paddingReason(decoded.words.length, "Bech32m"));
	}
	const payloadReason = form.payloadReason(payloadBytes);
	return payloadReason === null ? null : new InvalidZcashAddressError(text, payloadReason);
}

/**
 * The part `part` names as a refusal states it — the network it addresses, the form, and the text prefix: `mainnet TEX tex1`, `testnet TEX textest1`.
 *
 * Both callers pass the {@link HrpNetwork} entry of {@link TEX_HRPS} the paste's own spelling named, so the mainnet part is the table's entry rather than a second statement of it here.
 * The two character-count refusals of this form take their wording from here, so the count a paste never has and the bound it is measured against name the same network, the form, and the part rather than one of them naming the form alone.
 */
function texPartName(part: HrpNetwork): string {
	return `${part.network} TEX ${bech32PrefixOf(part.hrp)}`;
}

/**
 * The refusal a TEX candidate past the form's own {@link MAX_BECH32_TEXT_LENGTH} bound gets: the bound that refused it rather than the codec's generic checksum message, under the network and part the paste itself names.
 *
 * The bound is handed in as the form's own figure rather than restated here, so the length that refused the paste and the length the reason quotes are one number, as {@link unifiedOverLengthRefusal} takes its own.
 * A bound refusal answers a paste whose decode never ran, so the part is the one {@link bech32mAnswer} read off the paste's leading text and carried in here; a `textest1…` paste past the bound is then refused under the testnet part its own spelling names.
 */
function texOverLengthRefusal(text: string, maxTextLength: number, part: HrpNetwork): InvalidZcashAddressError {
	return new InvalidZcashAddressError(text, overLengthReason(text, maxTextLength, texPartName(part)));
}

/**
 * The reason a TEX paste of a length no address of its own part has is refused with, or `null` when its length is that part's own.
 *
 * The part is the one {@link bech32mAnswer} read off `text` and carried in: a `textest` paste whose checksum fails is refused for the 46 characters the testnet part takes rather than the 42 a mainnet one does, and each part's length is {@link bech32TextLength} over that part and the payload width every part of the form shares.
 */
function texLengthReason(text: string, part: HrpNetwork): string | null {
	return formLengthReason(text, bech32TextLength(part.hrp, TEX_PAYLOAD_BYTES), texPartName(part));
}

/**
 * The reason a unified container is refused for a payload below {@link MIN_UNIFIED_PAYLOAD_BYTES}, or `null` when it carries at least that much.
 *
 * The container decodes and its part is mainnet, so what is wrong with a shorter one is the payload: it is shorter than the padded human-readable part plus the one shielded receiver an address of that part must carry, and certifying it would present an invoice paying an address that cannot exist.
 */
function unifiedPayloadReason(bytes: number): string | null {
	return bytes < MIN_UNIFIED_PAYLOAD_BYTES ? `expected at least ${MIN_UNIFIED_PAYLOAD_BYTES} payload bytes for a container carrying one shielded receiver, got ${bytes}` : null;
}

/** The reason a TEX payload of another width is refused with, or `null` when it is the {@link TEX_PAYLOAD_BYTES} bytes the form carries: another width names a different script, not this form. */
function texPayloadReason(bytes: number): string | null {
	return bytes === TEX_PAYLOAD_BYTES ? null : `expected a ${TEX_PAYLOAD_BYTES}-byte TEX payload (the HASH160 a ${TRANSPARENT_TEXT_PREFIXES.join("/")} address carries), got ${bytes} bytes`;
}

/**
 * The unified-address form as {@link bech32mRefusal} reads it: the mainnet `u` part beside the testnet `utest` and regtest `uregtest` ones this module refuses by name, measured against {@link MAX_ZCASH_ADDRESS_LENGTH}, and held to the payload floor a legal container has.
 *
 * A candidate past that bound is refused on the payment link's QR budget before its container is read, so malformed text that merely begins `utest1` is the over-length paste it is rather than another network's address.
 * Nothing behind the container is read, so an accepted value certifies a mainnet container and no set of receivers, and a container has no fixed length — it is as long as the receiver list inside it — so the decode-failure path of {@link bech32mRefusal} has no character count to report for this form.
 */
const UNIFIED_FORM: Bech32mForm = {
	label: "unified address",
	hrps: UNIFIED_HRPS,
	maxTextLength: MAX_ZCASH_ADDRESS_LENGTH,
	overLength: unifiedOverLengthRefusal,
	lengthReason: null,
	payloadReason: unifiedPayloadReason,
};

/**
 * The TEX form as {@link bech32mRefusal} reads it: ZIP-320's mainnet `tex` part beside the testnet `textest` one, measured against {@link MAX_BECH32_TEXT_LENGTH}, a fixed text length each of those parts derives from the payload width, and the {@link TEX_PAYLOAD_BYTES} bytes of that hash that spelling carries.
 *
 * A paste of a length no address of its own part has is refused for that length where the decode is what noticed it, and a payload of another width is refused as the different script it names.
 */
const TEX_FORM: Bech32mForm = {
	label: "TEX address",
	hrps: TEX_HRPS,
	maxTextLength: MAX_BECH32_TEXT_LENGTH,
	overLength: texOverLengthRefusal,
	lengthReason: texLengthReason,
	payloadReason: texPayloadReason,
};

/**
 * The accepted forms as the catch-all refusal lists them, each with the text prefixes {@link ZCASH_ADDRESS_FORMS} states for it and the mainnet qualifier the first entry carries: `mainnet transparent t1/t3, Sapling zs1, unified u1, or TEX tex1`.
 *
 * The listing is composed from that frozen list rather than restated here, so a form this validator takes cannot be missing from the refusal a paste of no recognized form gets.
 */
function acceptedFormList(): string {
	const listed = ZCASH_ADDRESS_FORMS.map(({ name, prefixes }) => `${name} ${prefixes.join("/")}`);
	return `mainnet ${listed.slice(0, -1).join(", ")}, or ${listed[listed.length - 1]}`;
}

/**
 * Whether an accepted address of each form is stored in the lower-case spelling its checksum is computed over.
 *
 * The table is total over {@link AcceptedZcashForm}, so a form added to that key set has to state its case rule here before the module compiles, as {@link FORM_ANSWERS} states the answer it is read by, and no form can be admitted without the spelling it is stored in being decided.
 * It is frozen as the other form-keyed tables here are, since a reader takes a form's case rule as fixed for the module's lifetime.
 */
const CASE_FOLDED_FORMS: Readonly<Record<AcceptedZcashForm, boolean>> = Object.freeze({
	transparent: false,
	sapling: true,
	unified: true,
	tex: true,
});

/**
 * How a paste was read: the form the accepted address carries, or the refusal that answered it.
 *
 * The form travels with the acceptance so {@link requireZcashAddress} reads its case rule from the decision that admitted the value, rather than re-deriving which branch matched from the text it is about to store.
 */
type ZcashAddressVerdict =
	| { readonly kind: "accepted"; readonly form: AcceptedZcashForm }
	| { readonly kind: "refused"; readonly error: InvalidZcashAddressError };

/**
 * What one accepted form answers about a paste: that the paste is not a candidate of that form at all, that the form admits it and the answer names that form, or the refusal that answered it.
 *
 * A form resolves what its own refusals are worded by before it answers — {@link bech32mAnswer} resolves the human-readable-part entry a Bech32m paste's leading text names — so a value the recognition step has already read reaches the refusal that needs it, and a refusal that needs the decoded part rather than the leading text looks that part up once the decode has produced it, as {@link bech32mRefusal} does through {@link knownHrp}.
 */
type FormAnswer =
	| { readonly kind: "not-a-candidate" }
	| { readonly kind: "accepted"; readonly form: AcceptedZcashForm }
	| { readonly kind: "refused"; readonly error: InvalidZcashAddressError };

/** A form's answer to a paste: the one function {@link classifyZcashAddress} asks, so the test that recognizes a candidate and the refusal that answers one are one reading of the text. */
type FormAnswerer = (text: string) => FormAnswer;

/** The answer the transparent form gives about `text`: a paste beginning `t1`/`t3` in the spelling those prefixes have is a candidate of it, and {@link transparentRefusal} answers it. */
function transparentAnswer(text: string): FormAnswer {
	if (!TRANSPARENT_TEXT_PREFIXES.some((prefix) => text.startsWith(prefix))) return { kind: "not-a-candidate" };
	const refusal = transparentRefusal(text);
	return refusal === null ? { kind: "accepted", form: "transparent" } : { kind: "refused", error: refusal };
}

/** The answer the Sapling form gives about `text`: a paste leading with {@link SAPLING_TEXT_PREFIX} in either case is a candidate of it, and {@link saplingRefusal} answers it. */
function saplingAnswer(text: string): FormAnswer {
	if (!leadsWithPrefixInEitherCase(text, SAPLING_TEXT_PREFIX)) return { kind: "not-a-candidate" };
	const refusal = saplingRefusal(text);
	return refusal === null ? { kind: "accepted", form: "sapling" } : { kind: "refused", error: refusal };
}

/**
 * The answer a Bech32m form gives about `text`: a paste whose own spelling names one of the form's human-readable parts is a candidate of it, and the entry it names is carried into {@link bech32mRefusal}, which words the TEX form's two length refusals by it.
 *
 * `acceptedForm` is the form this answerer answers for, so the acceptance it returns states the form that admitted the paste rather than leaving a caller to pair the answer with a key it already knew.
 * Reading the part here rather than in the refusal is what makes a candidate and its leading text one lookup: the entry a paste's leading text names is decided once, and the refusals that answer a paste before its decode runs — the form's bound, and the length a failed decode is reported for — read that entry rather than looking one up again.
 * The decoded part is a different reading of the paste, so {@link bech32mRefusal} looks it up once, after the decode, through {@link knownHrp}.
 */
function bech32mAnswer(form: Bech32mForm, acceptedForm: AcceptedZcashForm): FormAnswerer {
	return (text) => {
		const part = hrpCandidate(text, form.hrps);
		if (part === null) return { kind: "not-a-candidate" };
		const refusal = bech32mRefusal(text, form, part);
		return refusal === null ? { kind: "accepted", form: acceptedForm } : { kind: "refused", error: refusal };
	};
}

/** The answer the unified form gives about a paste: {@link bech32mAnswer} over {@link UNIFIED_FORM}, answering for the `unified` form. */
const unifiedAnswer: FormAnswerer = bech32mAnswer(UNIFIED_FORM, "unified");

/** The answer the TEX form gives about a paste: {@link bech32mAnswer} over {@link TEX_FORM}, answering for the `tex` form. */
const texAnswer: FormAnswerer = bech32mAnswer(TEX_FORM, "tex");

/**
 * The answer each accepted form gives about a paste, keyed by the form its acceptance names: {@link transparentAnswer}, {@link saplingAnswer}, {@link unifiedAnswer}, and {@link texAnswer}.
 *
 * This record is the single statement of which forms exist and in what order they are tried: the transparent `t1`/`t3` pair first, Sapling's `zs1` next, the mainnet unified `u1` after it, and the mainnet TEX `tex1` last, and {@link classifyZcashAddress} iterates the entries in that declaration order, so the first form that recognizes a paste answers it and a form declared later never sees one an earlier form claimed.
 * The record is keyed by {@link AcceptedZcashForm}, as {@link ADDRESS_FORM_HINTS} and {@link CASE_FOLDED_FORMS} are, so the compiler refuses a record that omits one of those forms: the place a form is added is the place it is dispatched, and no companion order list has to be kept in step with it.
 */
const FORM_ANSWERS: Readonly<Record<AcceptedZcashForm, FormAnswerer>> = Object.freeze({
	transparent: transparentAnswer,
	sapling: saplingAnswer,
	unified: unifiedAnswer,
	tex: texAnswer,
});

/**
 * The verdict `text` gets: the form an accepted address carries, or the refusal that says why it is not one.
 *
 * Every acceptance path runs through here, so {@link isZcashAddress} and {@link requireZcashAddress} cannot disagree about what an address is, and each refusal is built with the error class that says why: a unified container or a TEX address on another network gets {@link TestnetUnifiedAddressError} or {@link TestnetTexAddressError} through the entry its own decoding matched, everything else {@link InvalidZcashAddressError}.
 * Each form is read through its own entry of {@link FORM_ANSWERS}, iterated in the order the record declares its entries, so the accepted form the answer carries and the case rule {@link CASE_FOLDED_FORMS} states are read from the branch that decided the paste rather than from the text a second time.
 * `Object.values` returns a record's entries in declaration order for these identifier keys, which is why this table needs no companion order list to state the order the forms are tried in.
 * A `zcash:` payment link is read first, before any address form is considered: it is the one paste here that is not an address candidate at all, and the scheme's `zc` text prefix would otherwise dispatch it into the Sprout branch, whose reason is not true of it.
 */
function classifyZcashAddress(text: string): ZcashAddressVerdict {
	if (leadsWithPrefixInEitherCase(text, PAYMENT_LINK_PREFIX)) {
		return {
			kind: "refused",
			error: new InvalidZcashAddressError(
				text,
				"it is a `zcash:` payment link, and this app wants the address the link carries rather than the link itself",
				"a payment link is not a payout address",
			),
		};
	}
	for (const answer of Object.values(FORM_ANSWERS)) {
		const answered = answer(text);
		if (answered.kind === "not-a-candidate") continue;
		return answered;
	}
	if (leadsWithPrefixInEitherCase(text, SPROUT_TEXT_PREFIX)) {
		// Sprout is case-sensitive Base58Check like the transparent forms, but an upper-case spelling of it is not a spelling this module could ever accept either way, and the prefix is what tells the user which form they pasted.
		return { kind: "refused", error: new InvalidZcashAddressError(text, "Sprout addresses can no longer receive funds, and this app never pays one") };
	}
	// A transparent address is dispatched by its lower-case prefix and its spelling is case-sensitive Base58Check, so a uniformly upper-case paste lands here; it is refused as the different string upper case spells, not folded into the address it resembles. The length is checked first, because only a string no longer than an accepted address can be such a spelling, so the case-mapping never runs over an unbounded paste.
	if (text.length <= MAX_CASE_PROBE_TEXT_LENGTH && text === text.toUpperCase() && text !== text.toLowerCase()) {
		return { kind: "refused", error: new InvalidZcashAddressError(text, "it is uniformly upper case, and a transparent address is case-sensitive Base58Check — upper case spells a different string, not that address in another spelling") };
	}
	return { kind: "refused", error: new InvalidZcashAddressError(text, `expected a ${acceptedFormList()} address`) };
}

/**
 * True when `value` is an address this module accepts, narrowing it to {@link ZcashAddress}; never throws.
 *
 * The guard certifies the address, not one spelling of it: both spellings BIP-173 defines are the same address and both narrow to {@link ZcashAddress}, so a value that passes can be either, and a caller that needs the one spelling a stored address carries normalizes through {@link requireZcashAddress} instead of keeping whichever spelling it read.
 */
export function isZcashAddress(value: unknown): value is ZcashAddress {
	return typeof value === "string" && classifyZcashAddress(value).kind === "accepted";
}

/**
 * The one entry point for Zcash address text — a pasted payee address, an invoice field — returning it once it is an address of one of the accepted forms.
 *
 * This is the canonicalizing half of the pair {@link isZcashAddress} completes: the guard admits both Bech32 spellings BIP-173 defines, while this function is what turns the two spellings of one address into one text, so a caller that normalizes both through here holds one value rather than two spellings of it.
 * A Sapling, unified, or TEX address is returned in the lower-case spelling its checksum is computed over, which is the one spelling of the two BIP-173 admits that a stored address carries; a transparent address is case-sensitive Base58Check and is returned exactly as it was written, never case-folded.
 * A unified container on another network or carrying too little payload to hold a receiver, and a TEX address on another network or carrying another payload width, are refused rather than returned, so no caller can hold a `ZcashAddress` addressed to a network this app does not pay, to no address at all, or to a script its own spelling does not name.
 */
export function requireZcashAddress(value: unknown): ZcashAddress {
	if (typeof value !== "string") {
		throw new TypeError(`zcash-address: expected a Zcash payout address string, got ${preview(value)}`);
	}
	const verdict = classifyZcashAddress(value);
	if (verdict.kind === "refused") {
		throw verdict.error;
	}
	// The checker cannot narrow a `string` leading with `tex1` to the template-literal member the form names.
	return (CASE_FOLDED_FORMS[verdict.form] ? value.toLowerCase() : value) as ZcashAddress;
}
