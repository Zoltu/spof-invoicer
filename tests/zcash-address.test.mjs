/** The suite for `app/js/wallet/zcash-address.js`: the transparent, Sapling, mainnet TEX, and mainnet unified forms, the TEX address accepted on its Bech32m checksum, `tex` part, and 20-byte payload and stored in the spelling the payee published rather than rewritten into its `t1` twin, the TEX and Sapling lengths each form's own characters are refused for, the testnet `textest` TEX address and the testnet or regtest unified container refused by name, the mainnet unified container accepted on its Bech32m checksum, human-readable part, length, and payload floor, the two cases BIP-173 spells a Bech32 string in and the transparent spelling the module refuses rather than folds, the two spellings of one Bech32 address normalizing to a single stored text, the payee hint pinned to the accepted forms and their prefixes, the checksum, version, human-readable-part, payload-width and length refusals (the Sapling one naming its own 90-character bound and its 78 characters, the TEX one its 90-character bound, its 42 characters, and its 20-byte payload, the unified one the QR budget that refused it), the merely unified-shaped pastes refused as malformed encodings, the unified length figure that keeps the widest payment link inside the QR symbol, the `zcash:` payment link refused as a link rather than as the Sprout address whose prefix it shares, the Sprout prefix refused in either case it is spelled, the Sapling and unified word counts that map to no whole number of payload bytes, the whitespace-padded pastes that are never trimmed into an address, and the refusal message as the invoice model wraps it; the accepted vectors are librustzcash's `zcash_address` crate round-trips plus ZIP-320's own reference-implementation vector for the TEX address, and the refusal vectors are built here with `@scure/base`'s encoders, so each is refused at the check that produces it rather than at the text prefix that dispatches it. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { UINT256_MAX, fromBaseUnits } from "../app/js/util/decimal.js";
import { base58check, bech32, bech32m, sha256 } from "../app/js/util/encoding.js";
import { boundMessage } from "../app/js/util/errors.js";
import { encodeQr } from "../app/js/util/qr.js";
import {
	InvalidZcashAddressError,
	MAX_ZCASH_ADDRESS_LENGTH,
	TestnetTexAddressError,
	TestnetUnifiedAddressError,
	ZCASH_ADDRESS_FORMS,
	isZcashAddress,
	requireZcashAddress,
} from "../app/js/wallet/zcash-address.js";
import { refusalError, refusalMessage } from "./helpers/refusals.mjs";
import { tamperLastCharacter } from "./helpers/tamper.mjs";
import { unifiedOfBytes } from "./helpers/unified-address.mjs";
import { WRAPPED_MESSAGE_MAX } from "./helpers/wrapped-message.mjs";

/** A mainnet transparent P2PKH address (version `0x1CB8`). */
const T1 = "t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs";

/** A mainnet transparent P2SH address (version `0x1CBD`). */
const T3 = "t3JZcvsuaXE6ygokL4XUiZSTrQBUoPYFnXJ";

/** A mainnet Sapling address: a 43-byte payload under the `zs` human-readable part. */
const SAPLING = "zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9slya";

/** The mainnet TEX address ZIP-320's own reference implementation prints for the P2PKH script below: the script's 20-byte HASH160 under the Bech32m `tex` part. */
const TEX = "tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte";

/** The transparent address the TEX vector is the other spelling of: version `0x1CB8` over the same 20-byte HASH160. */
const TEX_TWIN = "t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC";

/** A mainnet unified address carrying a Sapling item (106 characters), as librustzcash's `zcash_address` crate round-trips it. */
const UNIFIED = "u1qpatys4zruk99pg59gcscrt7y6akvl9vrhcfyhm9yxvxz7h87q6n8cgrzzpe9zru68uq39uhmlpp5uefxu0su5uqyqfe5zp3tycn0ecl";

/** A mainnet unified address carrying a Transparent P2PKH item and several others (213 characters, the longest mainnet vector). */
const UNIFIED_LONG = "u1pg2aaph7jp8rpf6yhsza25722sg5fcn3vaca6ze27hqjw7jvvhhuxkpcg0ge9xh6drsgdkda8qjq5chpehkcpxf87rnjryjqwymdheptpvnljqqrjqzjwkc2ma6hcq666kgwfytxwac8eyex6ndgr6ezte66706e3vaqrd25dzvzkc69kw0jgywtd0cmq52q5lkw6uh7hyvzjse8ksx";

/** The testnet unified address a mainnet-only invoice must never certify: a `utest1` address, refused by the network its human-readable part names. */
const UNIFIED_TESTNET = "utest10c5kutapazdnf8ztl3pu43nkfsjx89fy3uuff8tsmxm6s86j37pe7uz94z5jhkl49pqe8yz75rlsaygexk6jpaxwx0esjr8wm5ut7d5s";

/** Testnet transparent addresses, whose version bytes (`0x1D25`, `0x1CBA`) are the ones this module refuses. */
const TESTNET_T1 = "tm9iMLAuYMzJ6jtFLcA7rzUmfreGuKvr7Ma";
const TESTNET_T3 = "t26YoyZ1iPgiMEWL4zGUm74eVWfhyDMXzY2";

const ACCEPTED = [T1, T3, SAPLING, TEX, UNIFIED, UNIFIED_LONG];

/** Base58Check's alphabet carries `a` and `b`; Bech32's carries `q` and `p`. */
const BASE58_PAIR = ["a", "b"];
const BECH32_PAIR = ["q", "p"];

const decodeBase58Check = base58check(sha256);

/** A Sprout payment address: Sprout's mainnet version bytes over a 64-byte key. */
function sproutAddress() {
	const payload = new Uint8Array(66);
	payload[0] = 0x16;
	payload[1] = 0x9a;
	return decodeBase58Check.encode(payload);
}

/**
 * A 22-byte Base58Check payload under `version`, over reproducible hash bytes.
 * The version bytes determine the leading text of the encoding, so a version outside the mainnet pair can still produce a string this module dispatches as `t1` or `t3` and then refuses at the version check.
 */
function transparentOfVersion(version) {
	const payload = new Uint8Array(22);
	payload[0] = (version >> 8) & 0xff;
	payload[1] = version & 0xff;
	for (let index = 2; index < payload.length; index += 1) payload[index] = (index * 7) & 0xff;
	return decodeBase58Check.encode(payload);
}

/** The leading statement a container past the QR budget is refused with: the budget that refused it, not the address form it otherwise is. */
const QR_BUDGET_CLAUSE = "a unified-address candidate is longer than this app's QR symbol carries";

/**
 * Assert that `run` refuses with the ordinary malformed-address error rather than {@link TestnetUnifiedAddressError}: the classification this suite is about is what separates a well-formed container on another network from a merely unified-shaped paste.
 * `clause` is the leading statement the refusal must carry, defaulting to the generic one; a paste past the QR budget is refused before it is read and leads with that budget instead.
 */
function refusesAsMalformedEncoding(run, clause = "not a Zcash payout address") {
	try {
		run();
	} catch (error) {
		assert.equal(error instanceof InvalidZcashAddressError, true, "refused as a Zcash payout address error");
		assert.equal(error instanceof TestnetUnifiedAddressError, false, "not reported as another network's unified address");
		assert.equal(error.name, "InvalidZcashAddressError");
		assert.equal(error.message.startsWith(`zcash-address: ${clause} — `), true, error.message);
		return;
	}
	throw new Error("expected the value to be refused");
}

test("requireZcashAddress accepts the transparent, Sapling, TEX, and mainnet unified forms unchanged", () => {
	for (const address of ACCEPTED) {
		assert.equal(requireZcashAddress(address), address, address.slice(0, 12));
		assert.equal(isZcashAddress(address), true, address.slice(0, 12));
	}
	assert.equal(SAPLING.length, 78, "a Sapling address is 78 characters");
	assert.equal(SAPLING.startsWith("zs1"), true);
	assert.equal(TEX.length, 42, "a TEX address is 42 characters");
	assert.equal(TEX.startsWith("tex1"), true, "and is spelled under the mainnet `tex` part");
	assert.equal(UNIFIED.startsWith("u1"), true, "a unified address is spelled under the mainnet `u` part");
});

test("the payout-address hint names exactly the forms this validator accepts", () => {
	// The module keys its hint by the accepted-form union, so a form added without a hint entry fails to compile; this pins the four forms and the prefixes that union is read at, so a renamed or dropped entry is caught here rather than only in the hint that renders it.
	assert.deepEqual(
		ZCASH_ADDRESS_FORMS.map(({ name, prefixes }) => [name, [...prefixes]]),
		[["transparent", ["t1", "t3"]], ["Sapling", ["zs1"]], ["unified", ["u1"]], ["TEX", ["tex1"]]],
	);

	// Every accepted vector leads with a prefix its own form states, so a prefix the hint shows and the text this validator dispatches on are one statement.
	for (const [form, address] of [["transparent", T1], ["transparent", T3], ["Sapling", SAPLING], ["unified", UNIFIED], ["TEX", TEX]]) {
		const hint = ZCASH_ADDRESS_FORMS.find(({ name }) => name === form);
		assert.ok(hint !== undefined, `${form} is named by the hint`);
		assert.equal(hint.prefixes.some((prefix) => address.startsWith(prefix)), true, `${form} ${address.slice(0, 8)}`);
	}
});

test("a mainnet unified address is accepted on its container alone, in either case BIP-173 spells", () => {
	// Nothing behind the container is read, so acceptance is the Bech32m checksum, the mainnet `u` part, and the length bound: a container built here over arbitrary payload bytes is accepted exactly as librustzcash's round-trips are.
	for (const address of [UNIFIED, UNIFIED_LONG, unifiedOfBytes(61), unifiedOfBytes(189)]) {
		assert.equal(isZcashAddress(address), true, address.slice(0, 12));
		assert.equal(requireZcashAddress(address), address, "an accepted address is returned as it stands");
		const upper = address.toUpperCase();
		assert.equal(upper.startsWith("U1"), true);
		assert.equal(isZcashAddress(upper), true, "BIP-173 spells one Bech32m string in either case");
		assert.equal(requireZcashAddress(upper), address, "and the accepted value is returned in the lower-case spelling its checksum is computed over");
	}
	assert.equal(UNIFIED_LONG.length, 213, "the longer of the two librustzcash vectors is well inside the bound");
	// The bound is inclusive: the longest container a `zcash:` link of this app's widest amount could carry is accepted.
	const longest = unifiedOfBytes(189);
	assert.equal(longest.length, MAX_ZCASH_ADDRESS_LENGTH);
	assert.equal(requireZcashAddress(longest), longest);
});

test("a Sapling address is accepted in either case BIP-173 spells, and returned in the lower-case one", () => {
	const upper = SAPLING.toUpperCase();
	assert.equal(upper.startsWith("ZS1"), true);
	assert.equal(upper.length, SAPLING.length, "the other spelling is the same length");
	assert.equal(isZcashAddress(upper), true, "BIP-173 spells one Bech32 string in either case");
	assert.equal(requireZcashAddress(upper), SAPLING, "and the accepted value is returned in the lower-case spelling its checksum is computed over");

	// The case is folded before the checksum is read, so the other spelling of a tampered address is still refused for the tampering rather than for its case.
	const tampered = tamperLastCharacter(SAPLING, BECH32_PAIR);
	const tamperedUpper = tampered.toUpperCase();
	assert.equal(tamperedUpper, tamperedUpper.toUpperCase());
	assert.equal(isZcashAddress(tamperedUpper), false);
	assert.throws(() => requireZcashAddress(tamperedUpper), InvalidZcashAddressError);
	assert.throws(() => requireZcashAddress(tamperedUpper), /its Bech32 checksum or alphabet is wrong/);

	// Mixed case is no Bech32 spelling at all, and the refusal names that case rule rather than a checksum the paste never had.
	const mixed = `Z${SAPLING.slice(1)}`;
	assert.equal(mixed === mixed.toUpperCase(), false);
	assert.equal(isZcashAddress(mixed), false);
	assert.throws(() => requireZcashAddress(mixed), InvalidZcashAddressError);
	assert.match(
		refusalMessage(() => requireZcashAddress(mixed)),
		/^zcash-address: not a Zcash payout address — it mixes upper and lower case, and Bech32 spells a string either uniformly lower case or uniformly upper case/,
	);

	// A transparent address is case-sensitive Base58Check, so its upper-case spelling is a different string and is refused as that spelling, never folded into the address it resembles.
	for (const address of [T1, T3]) {
		const upperAddress = address.toUpperCase();
		assert.notEqual(upperAddress, address);
		assert.equal(isZcashAddress(upperAddress), false, upperAddress.slice(0, 12));
		assert.throws(() => requireZcashAddress(upperAddress), InvalidZcashAddressError);
		assert.match(
			refusalMessage(() => requireZcashAddress(upperAddress)),
			/^zcash-address: not a Zcash payout address — it is uniformly upper case, and a transparent address is case-sensitive Base58Check/,
		);
	}
});

test("the two spellings of one Bech32 address normalize to a single stored text", () => {
	// The guard certifies the address rather than one spelling of it: `ZS1…`/`zs1…` and `U1…`/`u1…` are one address each, so both spellings narrow to `ZcashAddress` and it is `requireZcashAddress` that collapses them.
	for (const address of [SAPLING, UNIFIED]) {
		const upper = address.toUpperCase();
		assert.notEqual(upper, address, "the two spellings differ as text");
		assert.equal(upper.toLowerCase(), address);
		assert.equal(isZcashAddress(upper), true);
		assert.equal(isZcashAddress(address), true);
		assert.equal(requireZcashAddress(upper), requireZcashAddress(address), "both spellings normalize to one text");
		assert.equal(requireZcashAddress(upper), address, "and the text the canonicalizing entry point returns is the lower-case one");
	}
});

test("the transparent vectors really are mainnet Base58Check, so the version check is what admits them", () => {
	const versions = new Map([
		[T1, "1cb8"],
		[T3, "1cbd"],
	]);
	for (const [address, version] of versions) {
		const payload = decodeBase58Check.decode(address);
		assert.equal(payload.length, 22);
		assert.equal(Buffer.from(payload.subarray(0, 2)).toString("hex"), version);
	}
});

test("a tampered checksum is refused for every accepted form", () => {
	const tampered = [
		[T1, BASE58_PAIR],
		[T3, BASE58_PAIR],
		[SAPLING, BECH32_PAIR],
		[TEX, BECH32_PAIR],
		[UNIFIED, BECH32_PAIR],
	];
	for (const [address, alphabet] of tampered) {
		const broken = tamperLastCharacter(address, alphabet);
		assert.notEqual(broken, address);
		assert.equal(isZcashAddress(broken), false, broken.slice(0, 12));
		assert.throws(() => requireZcashAddress(broken), InvalidZcashAddressError, broken.slice(0, 12));
		assert.throws(() => requireZcashAddress(broken), /checksum or alphabet/);
	}
});

test("a 22-byte payload whose version bytes are foreign is refused at the version check", () => {
	// `0x1CB9` and `0x1CBE` are the neighbours of the mainnet pair, and each one encodes as `t1` and `t3` respectively: the text prefix admits these strings and only the version pair refuses them.
	const foreign = [
		[0x1cb9, "t1", "1cb9"],
		[0x1cbe, "t3", "1cbe"],
	];
	for (const [version, textPrefix, hex] of foreign) {
		const address = transparentOfVersion(version);
		assert.equal(address.startsWith(textPrefix), true, `${hex} is dispatched as ${textPrefix}`);
		const payload = decodeBase58Check.decode(address);
		assert.equal(payload.length, 22, "the payload-length check admits it too");
		assert.equal(Buffer.from(payload.subarray(0, 2)).toString("hex"), hex);
		assert.equal(isZcashAddress(address), false);
		assert.throws(() => requireZcashAddress(address), InvalidZcashAddressError);
		assert.throws(
			() => requireZcashAddress(address),
			new RegExp(`expected the mainnet transparent version 0x1cb8 \\(t1\\) or 0x1cbd \\(t3\\), got 0x${hex}`),
		);
	}
});

test("a testnet transparent address is refused by the text prefix, which never reaches the version check", () => {
	for (const [address, version] of [[TESTNET_T1, "1d25"], [TESTNET_T3, "1cba"]]) {
		assert.equal(Buffer.from(decodeBase58Check.decode(address).subarray(0, 2)).toString("hex"), version);
		assert.equal(isZcashAddress(address), false);
		assert.throws(() => requireZcashAddress(address), InvalidZcashAddressError);
		assert.throws(() => requireZcashAddress(address), /expected a mainnet transparent t1\/t3, Sapling zs1, unified u1, or TEX tex1 address/);
	}

	const testnetSapling = bech32.encode("ztestsapling", bech32.toWords(new Uint8Array(43)), false);
	assert.equal(isZcashAddress(testnetSapling), false, "a testnet Sapling address carries another prefix");
	assert.throws(() => requireZcashAddress(testnetSapling), InvalidZcashAddressError);
	assert.throws(() => requireZcashAddress(testnetSapling), /expected a mainnet transparent t1\/t3, Sapling zs1, unified u1, or TEX tex1 address/);
});

test("a testnet or regtest unified container is refused by the network its part names", () => {
	// Neither the asset nor the validator carries a network, so the decoded human-readable part is what says which network a container addresses — and this app builds mainnet-only invoices, so anything else is refused by name rather than certified for a mainnet payee.
	for (const [address, network] of [
		[UNIFIED_TESTNET, "testnet"],
		[bech32m.encode("utest", bech32m.toWords(new Uint8Array(61)), false), "testnet"],
		[bech32m.encode("uregtest", bech32m.toWords(new Uint8Array(61)), false), "regtest"],
	]) {
		assert.equal(isZcashAddress(address), false, address.slice(0, 12));
		assert.throws(() => requireZcashAddress(address), TestnetUnifiedAddressError, address.slice(0, 12));
		assert.throws(() => requireZcashAddress(address), InvalidZcashAddressError, "a caller that catches every refusal still catches this one");
		assert.match(
			refusalMessage(() => requireZcashAddress(address)),
			new RegExp(`^zcash-address: a ${network} unified address cannot be paid from a mainnet-only invoice — it decodes under the Bech32m human-readable part`),
			address.slice(0, 12),
		);
	}

	// The other spelling of the same container is still that network's address.
	assert.throws(() => requireZcashAddress(UNIFIED_TESTNET.toUpperCase()), TestnetUnifiedAddressError);

	// A container past the bound is refused on its length before it is decoded, so nothing classifies it but its length: a paste that begins `utest1` yet is longer than a `zcash:` link carries is the over-length paste it is, not another network's address.
	const longTestnet = bech32m.encode("utest", bech32m.toWords(new Uint8Array(250)), false);
	assert.ok(longTestnet.length > MAX_ZCASH_ADDRESS_LENGTH, longTestnet.length);
	refusesAsMalformedEncoding(() => requireZcashAddress(longTestnet), QR_BUDGET_CLAUSE);
	assert.throws(() => requireZcashAddress(longTestnet), /it is longer than the 311 characters a `zcash:` payment link carries/);

	// Malformed text that merely begins `utest1` reads the same way: the network comes from the decoded human-readable part, never from the text prefix alone.
	const malformedTestnet = `utest1${"q".repeat(400)}`;
	assert.equal(malformedTestnet.length > MAX_ZCASH_ADDRESS_LENGTH, true);
	assert.equal(isZcashAddress(malformedTestnet), false);
	refusesAsMalformedEncoding(() => requireZcashAddress(malformedTestnet), QR_BUDGET_CLAUSE);

	// The regtest part is not one this module accepts either, and the reason names the part it read rather than a check the container passed or failed.
	assert.match(
		refusalMessage(() => requireZcashAddress(bech32m.encode("uregtest", bech32m.toWords(new Uint8Array(61)), false))),
		/it decodes under the Bech32m human-readable part "uregtest" \(regtest\), and only the mainnet part "u" is a payout address this app pays/,
	);
});

test("the decoded human-readable part is what admits a Sapling address, not its leading text", () => {
	// A Bech32 string's human-readable part runs up to its last `1`, so this one is dispatched as `zs1` text while decoding under a part this module refuses; it carries a valid checksum and a payload of the accepted size.
	const alienSapling = bech32.encode("zs1x", bech32.toWords(new Uint8Array(43)), false);
	assert.equal(alienSapling.startsWith("zs1"), true);
	assert.equal(alienSapling.length, 80);
	assert.equal(bech32.decode(alienSapling).prefix, "zs1x");
	assert.equal(isZcashAddress(alienSapling), false);
	assert.throws(() => requireZcashAddress(alienSapling), InvalidZcashAddressError);
	assert.match(
		refusalMessage(() => requireZcashAddress(alienSapling)),
		/^zcash-address: not a Zcash payout address — expected the Bech32 human-readable part "zs" \(mainnet Sapling\); value: /,
	);

	// The same words under the part Sapling uses are accepted, so only the human-readable part made the string above unacceptable.
	const saplingWords = bech32.toWords(new Uint8Array(43));
	assert.equal(requireZcashAddress(bech32.encode("zs", saplingWords, false)).startsWith("zs1"), true);
});

test("a Sprout address is refused by name, in either case it is spelled", () => {
	const sprout = sproutAddress();
	assert.equal(sprout.startsWith("zc"), true, "Sprout's mainnet prefix");
	const upper = sprout.toUpperCase();
	assert.equal(upper.startsWith("ZC"), true);
	for (const [value, why] of [[sprout, "the lower-case spelling"], [upper, "and the other spelling of the same form"]]) {
		assert.equal(isZcashAddress(value), false, why);
		assert.throws(() => requireZcashAddress(value), InvalidZcashAddressError, why);
		assert.throws(() => requireZcashAddress(value), /Sprout addresses can no longer receive funds, and this app never pays one/, why);
	}
});

test("a `zcash:` payment link is refused as the link it is, not as the Sprout address whose prefix it shares", () => {
	// The scheme opens with Sprout's `zc` text, and a link is the usual way one of these addresses reaches a clipboard, so the refusal has to name the link rather than state that a Sprout address can no longer receive funds.
	const linkReason = "it is a `zcash:` payment link, and this app wants the address the link carries rather than the link itself";
	for (const link of [
		`zcash:${SAPLING}?amount=1.23456789`,
		`zcash:${T1}?amount=1`,
		`zcash:${UNIFIED}?amount=1`,
		"zcash:",
		`Zcash:${SAPLING}`,
	]) {
		assert.equal(isZcashAddress(link), false, link.slice(0, 24));
		assert.throws(() => requireZcashAddress(link), InvalidZcashAddressError, link.slice(0, 24));
		assert.match(
			refusalMessage(() => requireZcashAddress(link)),
			new RegExp(`^zcash-address: a payment link is not a payout address — ${linkReason}; value: `),
			link.slice(0, 24),
		);
		assert.equal(refusalMessage(() => requireZcashAddress(link)).includes("Sprout"), false, "a link is never reported as a Sprout address");
	}

	// The link is refused for being a link however well-formed the address inside it is: what the field wants is that address, and a link is never accepted in its place.
	assert.equal(requireZcashAddress(SAPLING), SAPLING);
	assert.equal(requireZcashAddress(T1), T1);
	assert.equal(requireZcashAddress(UNIFIED), UNIFIED);
});

test("a unified-shaped paste that is not a unified container is refused as a malformed encoding, not as another network's address", () => {
	// The class says what the module verified: only a well-formed Bech32m container under a known unified human-readable part is classified by its network, while a paste that merely looks like one is refused at the check it fails.
	for (const value of ["u1qqqqqqqqqq", "utest1qqqqqqqqqq", `u1${"q".repeat(20)}`]) {
		assert.equal(isZcashAddress(value), false, value.slice(0, 12));
		refusesAsMalformedEncoding(() => requireZcashAddress(value));
		assert.throws(() => requireZcashAddress(value), /its Bech32m checksum or alphabet is wrong/, value.slice(0, 12));
	}

	// A Bech32 container is not the Bech32m one a unified address is: the same payload under the Bech32 checksum constant is a malformed unified paste.
	const bech32Unified = bech32.encode("u", bech32.toWords(new Uint8Array(61)), false);
	assert.equal(bech32Unified.startsWith("u1"), true);
	assert.equal(isZcashAddress(bech32Unified), false);
	refusesAsMalformedEncoding(() => requireZcashAddress(bech32Unified));
	assert.throws(() => requireZcashAddress(bech32Unified), /its Bech32m checksum or alphabet is wrong/);

	// A well-formed container that decodes under another human-readable part is not a unified address either, however its text begins.
	const alienUnified = bech32m.encode("u1x", bech32m.toWords(new Uint8Array(61)), false);
	assert.equal(alienUnified.startsWith("u1"), true, "the text prefix dispatches it as unified-shaped");
	assert.equal(bech32m.decode(alienUnified, false).prefix, "u1x", "and the part it really decodes under is what classifies it");
	assert.equal(isZcashAddress(alienUnified), false);
	refusesAsMalformedEncoding(() => requireZcashAddress(alienUnified));
	assert.throws(() => requireZcashAddress(alienUnified), /expected the Bech32m human-readable part "u" \(mainnet\), "utest" \(testnet\), "uregtest" \(regtest\)/);

	// The length bound is the decode's bound: one character past it is refused before the container is read at all, and the refusal leads with the QR budget that refused it rather than with "not a Zcash payout address" — a real mainnet unified address can simply be longer than the symbol this app builds.
	const overLong = unifiedOfBytes(190);
	assert.equal(overLong.length, MAX_ZCASH_ADDRESS_LENGTH + 1);
	assert.equal(isZcashAddress(overLong), false);
	refusesAsMalformedEncoding(() => requireZcashAddress(overLong), QR_BUDGET_CLAUSE);
	const overLongMessage = refusalMessage(() => requireZcashAddress(overLong));
	assert.equal(overLongMessage.startsWith(`zcash-address: ${QR_BUDGET_CLAUSE} — `), true, overLongMessage);
	assert.equal(
		overLongMessage.includes(`it is longer than the ${MAX_ZCASH_ADDRESS_LENGTH} characters a \`zcash:\` payment link carries in this app's QR symbol`),
		true,
	);
	assert.equal(
		overLongMessage.includes("no unified address is certified for payout here"),
		false,
		"a mainnet unified address is certified for payout here, so the over-length refusal names the QR budget instead",
	);
});

test("a hostile unified-shaped paste is refused without being decoded, and never inflates the message it is refused with", () => {
	// The length bound binds before the decoder does, so this paste is refused on its length rather than decoded into a container sized from the input.
	const flood = `u1${"q".repeat(200_000)}`;
	assert.equal(isZcashAddress(flood), false);
	refusesAsMalformedEncoding(() => requireZcashAddress(flood), QR_BUDGET_CLAUSE);
	assert.throws(() => requireZcashAddress(flood), /it is longer than the 311 characters a `zcash:` payment link carries/);
	const message = refusalMessage(() => requireZcashAddress(flood));

	// The reason is fixed and the preview is bounded, so a paste hundreds of times longer reads no longer than the shortest one that crosses the bound.
	const acrossTheBound = refusalMessage(() => requireZcashAddress(unifiedOfBytes(190)));
	assert.ok(
		Math.abs(message.length - acrossTheBound.length) < 20,
		`the refusal does not grow with the paste: ${message.length} characters for the flood, ${acrossTheBound.length} for one that just crosses the bound`,
	);
	assert.equal(message.includes("q".repeat(64)), false, "nothing read off the input is echoed");

	// A unified-shaped paste inside the bound but far longer than a preview is refused at its checksum and trails a bounded echo of itself.
	const longBroken = `u1${"q".repeat(300)}`;
	assert.equal(isZcashAddress(longBroken), false);
	const brokenMessage = refusalMessage(() => requireZcashAddress(longBroken));
	assert.match(brokenMessage, /^zcash-address: not a Zcash payout address — its Bech32m checksum or alphabet is wrong/);
	assert.equal(brokenMessage.includes(longBroken), false, "the paste trails as a bounded preview");
	assert.equal(brokenMessage.includes(`(${longBroken.length} characters)`), true, "the preview reports its full length");
});

test("the unified length figure keeps the widest payment link inside the QR symbol", () => {
	// This figure is the length budget a `zcash:` link is built against: the longest address such a link may carry, so that even an invoice with a uint256-scale amount stays inside the symbol.
	assert.equal(MAX_ZCASH_ADDRESS_LENGTH, 311);

	const longest = unifiedOfBytes(189);
	assert.equal(longest.length, MAX_ZCASH_ADDRESS_LENGTH);
	assert.equal(requireZcashAddress(longest), longest, "the longest address the budget allows is an accepted payout address");

	// A uint256-capped total at ZEC's eight decimals is 70 whole digits and eight decimals, the widest amount any accepted invoice can print.
	const widestAmount = fromBaseUnits(UINT256_MAX, 8);
	assert.equal(widestAmount.length, 79);
	const longestLink = `zcash:${longest}?amount=${widestAmount}`;
	assert.equal(longestLink.length, 404, "the widest link the address budget admits, inside the encoder's 412-byte ceiling");
	const matrix = encodeQr(longestLink);
	assert.equal((matrix.size - 17) / 4, 15, "the longest acceptable address still leaves a symbol the encoder builds");

	// The bound is this app's own and sits inside the encoder's ceiling, so a character past it is refused where the payee pastes it although the encoder itself would still carry the link.
	const overLong = unifiedOfBytes(190);
	assert.equal(overLong.length, MAX_ZCASH_ADDRESS_LENGTH + 1);
	const overLongLink = `zcash:${overLong}?amount=${widestAmount}`;
	assert.equal(overLongLink.length, 405);
	assert.doesNotThrow(() => encodeQr(overLongLink), "the refusal is the address budget's, not the encoder's");
});

test("a refusal leads with the reason, so the longest rejected address still shows it at the wrap the invoice model applies", () => {
	// A mainnet container past the bound is the longest value this module refuses for its length, and its refusal leads with the QR budget rather than the address form.
	const rejected = unifiedOfBytes(190);
	assert.equal(rejected.length, MAX_ZCASH_ADDRESS_LENGTH + 1);
	const message = refusalMessage(() => requireZcashAddress(rejected));
	assert.match(message, /^zcash-address: a unified-address candidate is longer than this app's QR symbol carries — it is longer than the 311 characters/);
	assert.equal(message.includes(rejected), false, "the rejected value trails as a bounded preview");
	assert.equal(message.includes(`(${rejected.length} characters)`), true, "the preview reports the value's full length");

	const shown = boundMessage(message, WRAPPED_MESSAGE_MAX);
	assert.equal(shown.includes(QR_BUDGET_CLAUSE), true, "the clause survives the wrap");
	assert.equal(shown.includes(`it is longer than the ${MAX_ZCASH_ADDRESS_LENGTH} characters`), true, "the reason survives the wrap");
	assert.equal(shown.includes(rejected), false, "the wrap never shows the paste in place of the reason");

	// The network refusal's clause names the network, so a testnet container is still reported as one wherever the message is clipped.
	const testnetShown = boundMessage(refusalMessage(() => requireZcashAddress(UNIFIED_TESTNET)), WRAPPED_MESSAGE_MAX);
	assert.equal(testnetShown.includes("a testnet unified address cannot be paid from a mainnet-only invoice"), true);
	assert.equal(testnetShown.includes(`"utest" (testnet)`), true, "and the part it decoded under is still named");
});

test("a Sapling-shaped paste whose word count is not whole payload bytes is refused for the padding, not for a checksum that passed", () => {
	const payloadWords = bech32.toWords(new Uint8Array(43));
	assert.equal(payloadWords.length, 69, "43 payload bytes are 69 Bech32 words");

	// 70 data words are 350 bits, five bits more than the 43 bytes and zero padding a Sapling address spells, so the checksum over them is valid and the codec's conversion is what refuses the paste.
	const excess = bech32.encode("zs", [...payloadWords, 0], false);
	assert.equal(excess.length, 79);
	assert.equal(bech32.decode(excess, false).words.length, 70, "the checksum over those 70 words is valid");
	assert.equal(isZcashAddress(excess), false);
	assert.throws(() => requireZcashAddress(excess), InvalidZcashAddressError);
	assert.match(
		refusalMessage(() => requireZcashAddress(excess)),
		/^zcash-address: not a Zcash payout address — its 70 data words are not a whole number of payload bytes, and Bech32 pads a payload's last byte with zero bits/,
	);
	assert.equal(refusalMessage(() => requireZcashAddress(excess)).includes("checksum"), false, "the reason is not a check the paste passed");

	// Trailing bits that are not zero are the codec's other refusal, and it reads the same way here: 68 words are 340 bits, so they are not a whole number of payload bytes either.
	const nonzeroPadding = bech32.encode("zs", [...payloadWords.slice(0, 67), 1], false);
	assert.equal(nonzeroPadding.length, 77);
	assert.equal(bech32.decode(nonzeroPadding, false).words.length, 68);
	assert.equal(isZcashAddress(nonzeroPadding), false);
	assert.match(
		refusalMessage(() => requireZcashAddress(nonzeroPadding)),
		/— its 68 data words are not a whole number of payload bytes, and Bech32 pads a payload's last byte with zero bits/,
	);

	// The same count with those trailing bits zero is canonical for 42 bytes, so the payload-length refusal is what answers it: the two above are about the padding itself, not about a count no conversion could read.
	const shortPayload = bech32.encode("zs", payloadWords.slice(0, 68), false);
	assert.equal(shortPayload.length, 77);
	assert.equal(bech32.decode(shortPayload, false).words.length, 68);
	assert.equal(isZcashAddress(shortPayload), false);
	assert.throws(() => requireZcashAddress(shortPayload), /expected a 43-byte Sapling payment address, got 42 bytes/);
});

test("a hostile Sapling paste is refused without being decoded, and never inflates the message it is refused with", () => {
	// The 90-character bound is applied by the module itself, before the decode, so this paste is refused on its length rather than decoded into a payload sized from the input — and the refusal names that bound instead of borrowing the codec's checksum message.
	const flood = `zs1${"q".repeat(200_000)}`;
	assert.equal(isZcashAddress(flood), false);
	assert.throws(() => requireZcashAddress(flood), InvalidZcashAddressError);
	assert.throws(() => requireZcashAddress(flood), /expected at most 90 characters for a Sapling zs1 address, got 200003/, "refused on its length, which the reason names");
	assert.equal(refusalMessage(() => requireZcashAddress(flood)).includes("bytes"), false);

	// A crafted string whose checksum covers a megabyte-long human-readable part is still refused before it is decoded: the length bound binds first, so the refusal is bounded instead of carrying the part the decoder would have read.
	const longPart = `zs1${"q".repeat(1_000_000)}`;
	const hostile = bech32.encode(longPart, bech32.toWords(new Uint8Array(43)), false);
	assert.equal(hostile.startsWith("zs1"), true, "the text prefix dispatches it as Sapling");
	assert.equal(bech32.decode(hostile, false).prefix, longPart, "and its checksum covers that part when this test's own decoder lifts the cap");
	const message = refusalMessage(() => requireZcashAddress(hostile));
	assert.match(message, /^zcash-address: not a Zcash payout address — expected at most 90 characters for a Sapling zs1 address, got /);
	assert.equal(message.includes("checksum or alphabet"), false, "the refusal does not misstate the reason as a checksum the paste never had");

	// The reason and the preview are both fixed-length, so a paste a megabyte long reads no longer than one that just crosses the bound.
	const acrossTheBound = refusalMessage(() => requireZcashAddress(`zs1${"q".repeat(88)}`));
	assert.ok(
		Math.abs(message.length - acrossTheBound.length) < 20,
		`the refusal does not grow with the paste: ${message.length} characters for the megabyte-long paste, ${acrossTheBound.length} for one that just crosses the bound`,
	);
	assert.equal(message.includes("q".repeat(64)), false, "nothing read off the input is echoed");
});

test("whitespace-padded input is refused, never trimmed into the address under it", () => {
	// Padding does not survive a decode in any of these encodings, so each paste must be refused rather than silently normalized into the address it wraps.
	const padded = [
		[` ${SAPLING}`, /expected a mainnet transparent t1\/t3, Sapling zs1, unified u1, or TEX tex1 address/, "a leading space takes the paste out of the Sapling dispatch"],
		[` ${UNIFIED}`, /expected a mainnet transparent t1\/t3, Sapling zs1, unified u1, or TEX tex1 address/, "and out of the unified one"],
		[` ${TEX}`, /expected a mainnet transparent t1\/t3, Sapling zs1, unified u1, or TEX tex1 address/, "and out of the TEX dispatch"],
		[`${T1}\n`, /its Base58Check checksum or alphabet is wrong/, "a trailing newline is not in base58's alphabet"],
		[`${T1}\n\n\n`, /expected at most 36 characters for a 22-byte Base58Check payload/, "and padding past the encoding's own maximum is refused on its length"],
	];
	for (const [value, refusal, why] of padded) {
		assert.notEqual(value.trim(), value);
		assert.equal(isZcashAddress(value), false, why);
		assert.throws(() => requireZcashAddress(value), InvalidZcashAddressError, why);
		assert.throws(() => requireZcashAddress(value), refusal, why);
	}
});

test("a refusal echoes the paste without the characters that could reorder or disguise it", () => {
	// `JSON.stringify` escapes the C0 controls but leaves the C1 block, the line and paragraph separators and the bidi overrides as themselves, and a DOM text node renders those without showing them, so the bounded echo must carry none of them.
	const hostile = `zs1\u202E${"q".repeat(72)}\u2028\u0085`;
	assert.equal(hostile.length, 78, "the form's own length, so the refusal is the checksum the paste failed");
	assert.equal(isZcashAddress(hostile), false);
	const message = refusalMessage(() => requireZcashAddress(hostile));
	assert.match(message, /^zcash-address: not a Zcash payout address — its Bech32 checksum or alphabet is wrong/);
	assert.doesNotMatch(message, /[\u202E\u2028\u0085]/, "no bidi override, line separator, or C1 control reaches the message");
	assert.equal(message.includes(hostile), false, "the whole paste is not echoed");
	assert.equal(message.length <= 200, true, `the refusal stays bounded, got ${message.length} characters`);
});

test("anything that is not a string throws a TypeError carrying a bounded preview, and isZcashAddress never throws", () => {
	for (const value of [null, undefined, 42, {}, [], true]) {
		assert.throws(() => requireZcashAddress(value), TypeError);
		assert.equal(isZcashAddress(value), false, String(value));
	}

	// The bad-argument slot is a `util/errors.ts` preview, so a value whose own rendering is a megabyte costs the same handful of characters a `42` does.
	const flood = { toString: () => "x".repeat(1024 * 1024) };
	assert.equal(isZcashAddress(flood), false);
	assert.throws(() => requireZcashAddress(flood), TypeError);
	assert.equal(
		refusalMessage(() => requireZcashAddress(flood)),
		"zcash-address: expected a Zcash payout address string, got [object Object]",
	);
	for (const value of ["", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "t1", "t1notanaddress", "u1"]) {
		assert.equal(isZcashAddress(value), false, JSON.stringify(value.slice(0, 12)));
		assert.throws(() => requireZcashAddress(value), InvalidZcashAddressError, JSON.stringify(value.slice(0, 12)));
	}
});

test("a container too short to carry one typed receiver is refused", () => {
	// The floor is the smallest container a legal address can have: ZIP 316 pads the one-byte mainnet human-readable part to a 16-byte field and prefixes the item list with it, F4Jumble preserves the length, and the shortest item is a 20-byte transparent hash framed by a typecode and a length — 16 + 22 = 38 bytes. The figure is pinned literally by the refusals below and by the accepted boundary at it.

	const empty = bech32m.encode("u", [], false);
	assert.equal(empty.startsWith("u1"), true, "an empty container is still dispatched as a unified candidate");
	assert.equal(bech32m.decode(empty, false).words.length, 0);
	assert.equal(isZcashAddress(empty), false, "a container with no payload at all is not a payable address");
	refusesAsMalformedEncoding(() => requireZcashAddress(empty));
	assert.throws(() => requireZcashAddress(empty), /expected at least 38 payload bytes for a container carrying one typed receiver, got 0/);

	// A container of one to 37 bytes is below that floor: a legal one is at least the 16-byte padded human-readable part plus the 22-byte smallest item the grammar spells, so anything shorter cannot be a container at all — 22 bytes, the old figure, is the bare item list and is refused on the same check.
	for (const byteLength of [1, 2, 22, 37]) {
		const short = unifiedOfBytes(byteLength);
		assert.equal(isZcashAddress(short), false, `${byteLength} bytes`);
		refusesAsMalformedEncoding(() => requireZcashAddress(short));
		assert.throws(() => requireZcashAddress(short), new RegExp(`expected at least 38 payload bytes for a container carrying one typed receiver, got ${byteLength}`));
	}

	// The floor is inclusive: the smallest container a legal address can have is still an accepted payout address, in either spelling.
	const shortest = unifiedOfBytes(38);
	assert.equal(isZcashAddress(shortest), true);
	assert.equal(requireZcashAddress(shortest), shortest);
	assert.equal(requireZcashAddress(shortest.toUpperCase()), shortest);

	// The paste is classified by the part it decodes under before its payload is measured, so a container on another network is refused by name whatever its payload is.
	assert.throws(() => requireZcashAddress(bech32m.encode("utest", [], false)), TestnetUnifiedAddressError);
});

test("a container whose data words are not whole payload bytes is refused for the padding", () => {
	const words = bech32m.toWords(new Uint8Array(61));
	assert.equal(words.length, 98, "61 payload bytes are 98 Bech32m words");

	// 99 words are 495 bits, seven more than the 61 bytes and two padding bits a container spells, so the checksum over them is valid and the codec's conversion is what refuses the paste.
	const excess = bech32m.encode("u", [...words, 0], false);
	assert.equal(bech32m.decode(excess, false).words.length, 99);
	assert.equal(isZcashAddress(excess), false);
	refusesAsMalformedEncoding(() => requireZcashAddress(excess));
	assert.throws(() => requireZcashAddress(excess), /its 99 data words are not a whole number of payload bytes, and Bech32m pads a payload's last byte with zero bits/);
});

test("a mainnet TEX address is accepted in either case, and kept in the spelling the payee published", () => {
	// ZIP-320's transparent-source-only address: the 20-byte HASH160 of the script below, spelled under the Bech32m `tex` part, and a form a payee may publish as their payout address.
	assert.equal(requireZcashAddress(TEX), TEX, "the spelling the payee wrote is the one that is stored");
	assert.equal(isZcashAddress(TEX), true);
	assert.equal(requireZcashAddress(TEX.toUpperCase()), TEX, "either case BIP-173 spells is one address, returned in the lower-case spelling its checksum covers");
	assert.equal(isZcashAddress(TEX.toUpperCase()), true);

	// A TEX address and its `t1` twin name one script, and the accepted value is never rewritten into the twin's spelling: the payee published the `tex1` one.
	assert.equal(requireZcashAddress(TEX_TWIN), TEX_TWIN, "the twin is accepted in its own spelling");
	assert.notEqual(requireZcashAddress(TEX), TEX_TWIN);
	const texPayload = bech32m.fromWords(bech32m.decode(TEX, false).words);
	const twinPayload = decodeBase58Check.decode(TEX_TWIN);
	assert.equal(texPayload.length, 20);
	assert.equal(twinPayload.length, 22);
	assert.equal(Buffer.from(twinPayload.subarray(0, 2)).toString("hex"), "1cb8", "the twin is a mainnet P2PKH address");
	assert.equal(Buffer.from(texPayload).toString("hex"), Buffer.from(twinPayload.subarray(2)).toString("hex"), "and both spellings carry the same 20-byte HASH160");
});

test("a TEX-shaped paste is refused for the check it fails, not for the form it resembles", () => {
	const reason = (value) => refusalMessage(() => requireZcashAddress(value));

	// One character short of the 42 a mainnet TEX address occupies, and one past it: the checksum fails only because the length does, so the length is what the paste is refused for.
	const short = TEX.slice(0, -1);
	assert.equal(short.length, 41);
	assert.match(reason(short), /^zcash-address: not a Zcash payout address — expected 42 characters for a mainnet TEX tex1 address, got 41; value: /);
	const long = `${TEX}a`;
	assert.equal(long.length, 43);
	assert.match(reason(long), /^zcash-address: not a Zcash payout address — expected 42 characters for a mainnet TEX tex1 address, got 43; value: /);

	// A tampered checksum of the form's own length: the checksum is what is wrong, so the checksum is what is named.
	const tampered = tamperLastCharacter(TEX, BECH32_PAIR);
	assert.equal(tampered.length, 42);
	assert.match(reason(tampered), /^zcash-address: not a Zcash payout address — its Bech32m checksum or alphabet is wrong; value: /);

	// A valid checksum over a payload of another width: 19 and 21 bytes are the neighbourhood of the 20 the form carries, and each is refused for its width rather than for a check it passed.
	for (const [byteLength, characters] of [[19, 41], [21, 44]]) {
		const width = bech32m.encode("tex", bech32m.toWords(new Uint8Array(byteLength)), false);
		assert.equal(width.length, characters, `${byteLength} payload bytes`);
		const widthReason = reason(width);
		assert.equal(widthReason.startsWith("zcash-address: not a Zcash payout address — "), true, widthReason);
		assert.equal(widthReason.includes(`expected a 20-byte TEX payload (the HASH160 a t1/t3 address carries), got ${byteLength} bytes`), true, widthReason);
	}

	// The same payload under the Bech32 checksum is not the Bech32m string a TEX address is.
	const bech32Tex = bech32.encode("tex", bech32m.toWords(new Uint8Array(20)), false);
	assert.equal(bech32Tex.length, 42);
	assert.match(reason(bech32Tex), /its Bech32m checksum or alphabet is wrong/);

	// A well-formed string under a part this module does not know is not a TEX address however its text begins, and the refusal names the parts it expected instead of echoing the one it found.
	const alien = bech32m.encode("tex1x", bech32m.toWords(new Uint8Array(20)), false);
	assert.equal(alien.startsWith("tex1"), true, "the text prefix dispatches it as TEX-shaped");
	assert.match(reason(alien), /^zcash-address: not a Zcash payout address — expected the Bech32m human-readable part "tex" \(mainnet\), "textest" \(testnet\) for a TEX address; value: /);

	// Mixed case spells nothing at all, and the refusal names that case rule rather than a checksum the paste never had.
	assert.match(reason(`T${TEX.slice(1)}`), /^zcash-address: not a Zcash payout address — it mixes upper and lower case, and Bech32m spells a string either uniformly lower case or uniformly upper case; value: /);

	// The bound binds before the decode, so a flood is refused on its length rather than decoded into a payload sized from the input.
	assert.match(reason(`tex1${"q".repeat(200_000)}`), /^zcash-address: not a Zcash payout address — expected at most 90 characters for a mainnet TEX tex1 address, got 200004/);

	// The part the refusal names is the one the paste itself spells: a `textest1` flood is refused under the testnet part its own text names rather than under the mainnet `tex1` that text also leads with.
	assert.match(reason(`textest1${"q".repeat(200_000)}`), /^zcash-address: not a Zcash payout address — expected at most 90 characters for a testnet TEX textest1 address, got 200008/);
});

test("a testnet TEX address is refused by the network its part names", () => {
	// ZIP-320 pairs mainnet's `tex` with testnet's `textest`, so a paste under the testnet part is a real address on another network rather than a malformed one.
	const testnet = bech32m.encode("textest", bech32m.toWords(new Uint8Array(20)), false);
	assert.equal(testnet.length, 46, "the testnet part spells a longer address than the mainnet one");
	assert.equal(isZcashAddress(testnet), false);
	assert.throws(() => requireZcashAddress(testnet), TestnetTexAddressError);
	assert.throws(() => requireZcashAddress(testnet), InvalidZcashAddressError, "a caller that catches every refusal still catches this one");
	assert.equal(refusalError(() => requireZcashAddress(testnet)) instanceof TestnetUnifiedAddressError, false, "and it is not reported as another network's unified address");
	assert.match(
		refusalMessage(() => requireZcashAddress(testnet)),
		/^zcash-address: a testnet TEX address cannot be paid from a mainnet-only invoice — it decodes under the Bech32m human-readable part "textest" \(testnet\), and only the mainnet part "tex" is a payout address this app pays; value: /,
	);

	// The other spelling of the same address is still that network's address.
	assert.throws(() => requireZcashAddress(testnet.toUpperCase()), TestnetTexAddressError);

	// A paste of a length no address of its own part has is refused for that length, and the figure is the part's own: the testnet part is four characters longer than the mainnet one, so a `textest` paste one character short is refused for 46 rather than for the 42 a mainnet address takes.
	const short = testnet.slice(0, -1);
	assert.equal(short.length, 45);
	assert.match(refusalMessage(() => requireZcashAddress(short)), /^zcash-address: not a Zcash payout address — expected 46 characters for a testnet TEX textest1 address, got 45; value: /);
	assert.equal(refusalError(() => requireZcashAddress(short)) instanceof TestnetTexAddressError, false, "the paste never decoded, so it names no network");

	// The clause names the network, so the refusal still reads as one wherever the invoice model clips it.
	const shown = boundMessage(refusalMessage(() => requireZcashAddress(testnet)), WRAPPED_MESSAGE_MAX);
	assert.equal(shown.includes("a testnet TEX address cannot be paid from a mainnet-only invoice"), true, shown);
	assert.equal(shown.includes('"textest" (testnet)'), true, "and the part it decoded under is still named");
});

test("a Sapling paste of the wrong length is refused for that length, not for a checksum it could not carry", () => {
	// The example copied through write-ups about Zcash: 77 characters, one short of the 78 a mainnet Sapling address has, so its checksum fails because a character is missing rather than the paste being one mistyped character long.
	const copied = "zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9sly";
	assert.equal(copied.length, 77);
	assert.equal(copied, SAPLING.slice(0, -1), "it is the accepted vector with its last character missing");
	assert.equal(isZcashAddress(copied), false);
	assert.throws(() => requireZcashAddress(copied), InvalidZcashAddressError);
	assert.match(
		refusalMessage(() => requireZcashAddress(copied)),
		/^zcash-address: not a Zcash payout address — expected 78 characters for a mainnet Sapling zs1 address, got 77; value: /,
	);

	// A character past the form reads the same way, and a paste of the form's own length with a broken checksum is still refused for the checksum itself.
	assert.match(refusalMessage(() => requireZcashAddress(`${SAPLING}q`)), /^zcash-address: not a Zcash payout address — expected 78 characters for a mainnet Sapling zs1 address, got 79; value: /);
	assert.match(refusalMessage(() => requireZcashAddress(tamperLastCharacter(SAPLING, BECH32_PAIR))), /^zcash-address: not a Zcash payout address — its Bech32 checksum or alphabet is wrong; value: /);
});
