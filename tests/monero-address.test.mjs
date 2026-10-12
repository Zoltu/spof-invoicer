/** The suite for `app/js/wallet/monero-address.js`: the standard, subaddress, and integrated mainnet forms, the Keccak-256 checksum, the network-prefix, length and prefix/length-pairing refusals, the length and alphabet bounds the module applies before it decodes anything, the block-padded base58 rules, the `monero:` payment link refused as a link rather than as a character outside the alphabet, the whitespace-padded pastes that are never trimmed into an address, the refusal message as the invoice model wraps it including the bounded echo inside it, which carries none of the control, line-separator or bidi characters a paste could reorder that message with; `46BeWrHp…` is Monero's own vector and `888tNk…` is the subaddress the project publishes, so the standard and subaddress forms are pinned to encodings published outside this repository, while the integrated form rests on the vector built here over reproducible key bytes because no published one was available. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { base58xmr, keccak256 } from "../app/js/util/encoding.js";
import { boundMessage } from "../app/js/util/errors.js";
import {
	InvalidMoneroAddressError,
	isMoneroAddress,
	requireMoneroAddress,
} from "../app/js/wallet/monero-address.js";
import { refusalMessage } from "./helpers/refusals.mjs";
import { tamperLastCharacter } from "./helpers/tamper.mjs";
import { WRAPPED_MESSAGE_MAX } from "./helpers/wrapped-message.mjs";

/** Monero's own mainnet standard-address vector: prefix `0x12`, a spend key, a view key, and a Keccak-256 checksum. */
const STANDARD_VECTOR = "46BeWrHpwXmHDpDEUmZBWZfoQpdc6HaERCNmx1pEYL2rAcuwufPN9rXHHtyUA4QVy66qeFQkn6sfK8aHYjA3jk3o1Bv16em";

/** The subaddress the Monero project publishes as its donation address, which is a real mainnet subaddress rather than a fixture built here. */
const SUBADDRESS_VECTOR = "888tNkZrPN6JsEgekjMnABU4TBzc2Dt29EPAvkRxbANsAnjyPbb3iQ1YBRk1UXcdRsiKc9dhwMVgN5S9cQUiyoogDavup3H";

/** Mainnet prefix bytes: standard, integrated, and subaddress. */
const STANDARD_PREFIX = 0x12;
const INTEGRATED_PREFIX = 0x13;
const SUBADDRESS_PREFIX = 0x2a;

/** The 69-byte pair, in the order the prefix/length-pairing refusal names them. */
const STANDARD_PREFIXES = [STANDARD_PREFIX, SUBADDRESS_PREFIX];

/** Every mainnet prefix byte, in the order the network-prefix refusal names them. */
const MAINNET_PREFIXES = [...STANDARD_PREFIXES, INTEGRATED_PREFIX];

/** Testnet and stagenet prefix bytes, which this module refuses. */
const TESTNET_PREFIXES = [0x35, 0x36, 0x3f];
const STAGENET_PREFIXES = [0x18, 0x19, 0x24];

const CHECKSUM_BYTES = 4;

/** Base58's alphabet carries `a` and `b`, the pair a tamper swaps between so only the trailing checksum stops matching. */
const BASE58_PAIR = ["a", "b"];

/** A prefix byte as the `0x`-prefixed hex text the refusals name it in. */
function prefixHex(value) {
	return `0x${value.toString(16)}`;
}

/**
 * A well-formed Monero-style address of `totalBytes` bytes: the prefix byte, reproducible key bytes filling the rest of the body, and the Keccak-256 checksum the chain appends.
 * The body is `totalBytes - 4` bytes, so the vector's total length is what the caller pins.
 */
function encodeAddress(totalBytes, prefix) {
	const body = new Uint8Array(totalBytes - CHECKSUM_BYTES);
	body[0] = prefix;
	for (let index = 1; index < body.length; index += 1) body[index] = (index * 7) & 0xff;
	const full = new Uint8Array(totalBytes);
	full.set(body);
	full.set(keccak256(body).subarray(0, CHECKSUM_BYTES), body.length);
	return base58xmr.encode(full);
}

test("requireMoneroAddress accepts the standard, subaddress, and integrated mainnet forms unchanged", () => {
	const standard = encodeAddress(69, STANDARD_PREFIX);
	const subaddress = encodeAddress(69, SUBADDRESS_PREFIX);
	const integrated = encodeAddress(77, INTEGRATED_PREFIX);

	assert.equal(requireMoneroAddress(STANDARD_VECTOR), STANDARD_VECTOR);
	assert.equal(STANDARD_VECTOR.length, 95, "a standard address is 95 characters");
	assert.equal(STANDARD_VECTOR.startsWith("4"), true);

	assert.equal(requireMoneroAddress(SUBADDRESS_VECTOR), SUBADDRESS_VECTOR);
	assert.equal(isMoneroAddress(SUBADDRESS_VECTOR), true);
	assert.equal(SUBADDRESS_VECTOR.length, 95, "the published subaddress is 95 characters");
	assert.equal(SUBADDRESS_VECTOR.startsWith("8"), true);
	assert.equal(base58xmr.decode(SUBADDRESS_VECTOR)[0], SUBADDRESS_PREFIX, "and decodes under the 0x2a subaddress prefix");
	assert.equal(Buffer.from(base58xmr.decode(SUBADDRESS_VECTOR)).length, 69);

	assert.equal(standard.length, 95, "a standard address is 95 characters");
	assert.equal(subaddress.length, 95, "a subaddress is 95 characters");
	assert.equal(integrated.length, 106, "an integrated address is 106 characters");
	assert.equal(subaddress.startsWith("8"), true, "a subaddress starts with 8");
	assert.equal(integrated.startsWith("4"), true, "an integrated address starts with 4");

	for (const address of [standard, subaddress, integrated]) {
		assert.equal(requireMoneroAddress(address), address, address.slice(0, 6));
		assert.equal(isMoneroAddress(address), true, address.slice(0, 6));
	}
});

test("a tampered Keccak-256 checksum is refused", () => {
	const broken = tamperLastCharacter(STANDARD_VECTOR, BASE58_PAIR);
	assert.notEqual(broken, STANDARD_VECTOR);
	assert.equal(Buffer.from(base58xmr.decode(broken)).length, 69, "the tampered string still decodes");
	assert.equal(isMoneroAddress(broken), false);
	assert.throws(() => requireMoneroAddress(broken), InvalidMoneroAddressError);
	assert.throws(() => requireMoneroAddress(broken), /Keccak-256 checksum/);

	const tamperedSubaddress = tamperLastCharacter(SUBADDRESS_VECTOR, BASE58_PAIR);
	assert.equal(isMoneroAddress(tamperedSubaddress), false, "the published subaddress is checksum-protected too");
	assert.throws(() => requireMoneroAddress(tamperedSubaddress), /Keccak-256 checksum/);
});

test("testnet and stagenet prefixes are refused as the wrong network", () => {
	for (const prefix of [...TESTNET_PREFIXES, ...STAGENET_PREFIXES]) {
		const address = encodeAddress(69, prefix);
		assert.equal(address.length, 95);
		assert.equal(isMoneroAddress(address), false, `prefix 0x${prefix.toString(16)}`);
		assert.throws(() => requireMoneroAddress(address), InvalidMoneroAddressError);
		assert.throws(() => requireMoneroAddress(address), new RegExp(`expected a mainnet address prefix of ${MAINNET_PREFIXES.map(prefixHex).join(", ")}, got`));
	}

	const integrated = encodeAddress(77, 0x36);
	assert.equal(isMoneroAddress(integrated), false, "a testnet integrated address is refused too");
});

test("a payload that is neither 69 nor 77 bytes is refused", () => {
	// 70 and 73 bytes decode from 97 and 101 characters, both inside the longest encoding an address has, so each reaches the decoded-length check rather than the length pre-check.
	const vectors = [
		[70, 97],
		[73, 101],
	];
	for (const [totalBytes, textLength] of vectors) {
		const address = encodeAddress(totalBytes, STANDARD_PREFIX);
		assert.equal(address.length, textLength, `${totalBytes} bytes are ${textLength} characters`);
		assert.equal(Buffer.from(base58xmr.decode(address)).length, totalBytes, "and decode back to their own byte count");
		assert.equal(isMoneroAddress(address), false, `${totalBytes} bytes`);
		assert.throws(() => requireMoneroAddress(address), InvalidMoneroAddressError);
		assert.throws(() => requireMoneroAddress(address), /expected a 69-byte standard or subaddress encoding/);
	}
});

test("the prefix and the encoded length are paired, so a combination no wallet produces is refused", () => {
	const mismatched = [
		[69, INTEGRATED_PREFIX, new RegExp(`expected a 69-byte standard or subaddress encoding to start with the ${STANDARD_PREFIXES.map(prefixHex).join(" or ")} prefix, got ${prefixHex(INTEGRATED_PREFIX)}`)],
		[77, STANDARD_PREFIX, new RegExp(`expected a 77-byte integrated encoding to start with the ${prefixHex(INTEGRATED_PREFIX)} prefix, got ${prefixHex(STANDARD_PREFIX)}`)],
		[77, SUBADDRESS_PREFIX, new RegExp(`expected a 77-byte integrated encoding to start with the ${prefixHex(INTEGRATED_PREFIX)} prefix, got ${prefixHex(SUBADDRESS_PREFIX)}`)],
	];
	for (const [totalBytes, prefix, refusal] of mismatched) {
		const address = encodeAddress(totalBytes, prefix);
		assert.equal(Buffer.from(base58xmr.decode(address)).length, totalBytes, "each vector decodes at its own length");
		assert.equal(isMoneroAddress(address), false, `${totalBytes} bytes under prefix 0x${prefix.toString(16)}`);
		assert.throws(() => requireMoneroAddress(address), InvalidMoneroAddressError);
		assert.throws(() => requireMoneroAddress(address), refusal);
	}
});

test("a string whose blocked base58 framing is broken is refused", () => {
	// Neither tail length is a block width a decoder can split: only 0, 2, 3, 5, 6, 7, 9, 10 and 11 characters are.
	const invalidTail = ["4".repeat(8), "4".repeat(12)];
	for (const value of invalidTail) {
		assert.equal(isMoneroAddress(value), false, value.slice(0, 12));
		assert.throws(() => requireMoneroAddress(value), InvalidMoneroAddressError);
		assert.throws(() => requireMoneroAddress(value), /blocked base58 encoding/);
	}

	const outsideAlphabet = `${STANDARD_VECTOR.slice(0, 94)}l`;
	assert.equal(isMoneroAddress(outsideAlphabet), false, "base58's alphabet carries no `l`");
	assert.throws(() => requireMoneroAddress(outsideAlphabet), InvalidMoneroAddressError);
	assert.throws(() => requireMoneroAddress(outsideAlphabet), /outside Monero's base58 alphabet/);
});

test("text that no address encoding can be is refused before it is decoded", () => {
	// The decoder slices its input into 11-character blocks and sizes its output from the input's length, so a longer paste is refused on its length without any of it being decoded.
	const tooLong = "4".repeat(200_000);
	assert.equal(isMoneroAddress(tooLong), false);
	assert.throws(() => requireMoneroAddress(tooLong), InvalidMoneroAddressError);
	assert.throws(() => requireMoneroAddress(tooLong), /a Monero address encoding is 95 characters/);
	assert.throws(() => requireMoneroAddress(tooLong), /this value is 200000 characters/);

	// One character past the longest encoding an address has is refused the same way.
	const onePast = "4".repeat(107);
	assert.equal(isMoneroAddress(onePast), false);
	assert.throws(() => requireMoneroAddress(onePast), /this value is 107 characters/);
});

test("whitespace-padded input is refused, never trimmed into the address under it", () => {
	// Padding is not part of any Monero encoding, so a padded paste must be refused rather than normalized into the address it wraps; the vectors below pin each bound that refuses one.
	const padded = [
		[`${STANDARD_VECTOR}\u00a0`, /outside Monero's base58 alphabet/, "a trailing non-breaking space is not a base58 character"],
		[`\u00a0${SUBADDRESS_VECTOR}`, /outside Monero's base58 alphabet/, "a leading non-breaking space is not one either"],
		[` ${STANDARD_VECTOR}`, /outside Monero's base58 alphabet/, "so does a leading space"],
		[`${"4".repeat(106)}\u00a0`, /this value is 107 characters/, "and a padded paste past the decoder's own length bound is refused on its length"],
	];
	for (const [value, refusal, why] of padded) {
		assert.notEqual(value.trim(), value);
		assert.equal(isMoneroAddress(value), false, why);
		assert.throws(() => requireMoneroAddress(value), InvalidMoneroAddressError, why);
		assert.throws(() => requireMoneroAddress(value), refusal, why);
	}
});

test("a refusal leads with the reason, so an integrated address still shows it at the wrap the invoice model applies", () => {
	const rejected = tamperLastCharacter(encodeAddress(77, INTEGRATED_PREFIX), BASE58_PAIR);
	assert.equal(rejected.length, 106, "the same 106 characters an integrated address has");
	assert.equal(Buffer.from(base58xmr.decode(rejected)).length, 77, "the tampered string still decodes as an integrated address");
	const message = refusalMessage(() => requireMoneroAddress(rejected));
	assert.match(message, /^monero-address: not a Monero payout address — its Keccak-256 checksum does not match the address body/);
	assert.equal(message.includes(rejected), false, "the rejected value trails as a bounded preview");
	assert.equal(message.includes("(106 characters)"), true, "the preview reports the value's full length");

	const shown = boundMessage(message, WRAPPED_MESSAGE_MAX);
	assert.equal(shown, message, "the whole refusal fits the wrap the invoice model applies");
	assert.equal(shown.includes("its Keccak-256 checksum does not match the address body"), true);
});

test("anything that is not a Monero address string is refused", () => {
	for (const value of [null, undefined, 42, {}, [], true]) {
		assert.throws(() => requireMoneroAddress(value), TypeError);
		assert.equal(isMoneroAddress(value), false, String(value));
	}
	for (const value of [
		"",
		"0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
		"t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs",
		"utest10c5kutapazdnf8ztl3pu43nkfsjx89fy3uuff8tsmxm6s86j37pe7uz94z5jhkl49pqe8yz75rlsaygexk6jpaxwx0esjr8wm5ut7d5s",
	]) {
		assert.equal(isMoneroAddress(value), false, value.slice(0, 12));
		assert.throws(() => requireMoneroAddress(value), InvalidMoneroAddressError, value.slice(0, 12));
	}
});

test("a refusal echoes the paste without the characters that could reorder or disguise it", () => {
	// `JSON.stringify` escapes the C0 controls but leaves the C1 block, the line and paragraph separators and the bidi overrides as themselves, and a DOM text node renders those without showing them, so the bounded echo must carry none of them.
	const hostile = `${STANDARD_VECTOR.slice(0, 40)}\u202E\u0085\u2028${STANDARD_VECTOR.slice(40)}`;
	assert.equal(isMoneroAddress(hostile), false);
	const message = refusalMessage(() => requireMoneroAddress(hostile));
	assert.match(message, /^monero-address: not a Monero payout address — its blocked base58 encoding is malformed — it carries a character outside Monero's base58 alphabet/);
	assert.doesNotMatch(message, /[\u202E\u0085\u2028]/, "no bidi override, C1 control, or line separator reaches the message");
	assert.equal(message.includes(hostile), false, "the whole paste is not echoed");
	const echo = message.slice(message.indexOf("value: "));
	assert.ok(echo.length < 70, `the echo is the bounded preview, not the paste: ${echo.length} characters`);
});

test("a non-string is refused with a bounded preview, not its whole rendering", () => {
	const flood = { toString: () => "x".repeat(1024 * 1024) };
	assert.equal(isMoneroAddress(flood), false);
	assert.throws(() => requireMoneroAddress(flood), TypeError);
	assert.equal(
		refusalMessage(() => requireMoneroAddress(flood)),
		"monero-address: expected a Monero payout address string, got [object Object]",
	);
});

test("a `monero:` payment link is refused as the link it is, not for a character outside the alphabet", () => {
	// The scheme's `:`, and the length of a link that carries a query, are properties of a link rather than of a mistyped address, so the paste is named as what it is and never accepted in place of the address it carries.
	const linkReason = "it is a `monero:` payment link, and this app wants the address the link carries rather than the link itself";
	for (const link of [
		`monero:${STANDARD_VECTOR}`,
		`monero:${STANDARD_VECTOR}?tx_amount=1.234567890123`,
		`monero:${SUBADDRESS_VECTOR}?tx_amount=1`,
		`Monero:${STANDARD_VECTOR}`,
		"monero:",
	]) {
		assert.equal(isMoneroAddress(link), false, link.slice(0, 24));
		assert.throws(() => requireMoneroAddress(link), InvalidMoneroAddressError, link.slice(0, 24));
		const message = refusalMessage(() => requireMoneroAddress(link));
		assert.equal(message.startsWith(`monero-address: not a Monero payout address — ${linkReason}; value: `), true, message);
		assert.equal(message.includes("base58 alphabet"), false, "a link is never reported as a character outside the alphabet");
		assert.equal(message.includes("is 106 characters"), false, "nor as an encoding that is merely too long");
	}

	// The link is refused however well-formed the address inside it is: what the field wants is that address, and a link is never accepted in its place.
	assert.equal(requireMoneroAddress(STANDARD_VECTOR), STANDARD_VECTOR);
	assert.equal(requireMoneroAddress(SUBADDRESS_VECTOR), SUBADDRESS_VECTOR);
	assert.equal(isMoneroAddress(STANDARD_VECTOR), true);
});
