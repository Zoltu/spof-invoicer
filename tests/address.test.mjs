/** The suite for `app/js/wallet/address.js`: the EIP-55 checksum vectors, checksum status, parsing, normalization, comparison, and the invoice-address guard. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	addressFromBytes,
	addressesEqual,
	addressToBytes,
	checksumStatus,
	hasValidChecksum,
	InvalidChecksumError,
	isAddress,
	normalizeAddress,
	requireInvoiceAddress,
	toChecksumAddress,
} from "../app/js/wallet/address.js";
import { USDC, USDC_LOWER, USDT, USDT_LOWER } from "./helpers/tokens.mjs";

// The four vectors from EIP-55 plus the two mainnet stablecoins the registry pins.
const EIP55_VECTORS = [
	["0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"],
	["0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359", "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359"],
	["0xdbf03b407c01e7cd3cbea99509d93f8dddc8c6fb", "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB"],
	["0xd1220a0cf47c7b9be7a2e6ba89f429762e7b9adb", "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb"],
	[USDC_LOWER, USDC],
	[USDT_LOWER, USDT],
];

/** Flip one body character's case so the mixed-case body no longer matches its EIP-55 checksum. */
function withBrokenChecksum(checksummed) {
	return `${checksummed.slice(0, 3)}${checksummed[3].toUpperCase()}${checksummed.slice(4)}`;
}

test("toChecksumAddress reproduces the EIP-55 vectors", () => {
	for (const [lower, checksummed] of EIP55_VECTORS) {
		assert.equal(toChecksumAddress(lower), checksummed, `checksum of ${lower}`);
		assert.equal(toChecksumAddress(lower.toUpperCase().replace(/^0X/, "0x")), checksummed);
		assert.equal(toChecksumAddress(checksummed), checksummed, "checksumming is idempotent");
	}
});

test("hasValidChecksum accepts uniform case and the EIP-55 form, rejects a wrong mixed case", () => {
	const checksummed = EIP55_VECTORS[0][1];
	const lower = EIP55_VECTORS[0][0];
	const allCaps = lower.slice(2).toUpperCase();

	assert.equal(hasValidChecksum(checksummed), true);
	assert.equal(hasValidChecksum(lower), true);
	assert.equal(hasValidChecksum(`0x${allCaps}`), true);

	const wrong = withBrokenChecksum(checksummed);
	assert.notEqual(wrong, checksummed);
	assert.equal(hasValidChecksum(wrong), false);
	assert.equal(toChecksumAddress(wrong), checksummed, "the checksum form corrects the casing");
});

test("checksumStatus distinguishes verified, unverifiable, and invalid casing", () => {
	const [lower, checksummed] = EIP55_VECTORS[0];
	assert.equal(checksumStatus(checksummed), "checksummed");
	assert.equal(checksumStatus(lower), "unverifiable", "an all-lowercase body carries no checksum");
	assert.equal(checksumStatus(`0x${lower.slice(2).toUpperCase()}`), "unverifiable");
	assert.equal(checksumStatus(withBrokenChecksum(checksummed)), "invalid");
	for (const value of ["", "0x", "0x1234", null, undefined, 42]) {
		assert.equal(checksumStatus(value), "invalid", `checksumStatus(${String(value)})`);
	}
});

test("isAddress and hasValidChecksum reject anything that is not an address", () => {
	const rejects = [
		"",
		"0x",
		"0x1234",
		"5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
		`0x${"a".repeat(39)}`,
		`0x${"a".repeat(41)}`,
		`0x${"g".repeat(40)}`,
		"0X5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
		null,
		undefined,
		42,
	];
	for (const value of rejects) {
		assert.equal(isAddress(value), false, `isAddress(${String(value)})`);
		assert.equal(hasValidChecksum(value), false, `hasValidChecksum(${String(value)})`);
	}
	assert.equal(isAddress(EIP55_VECTORS[3][1]), true);
});

test("normalizeAddress lower-cases and throws on a non-address", () => {
	assert.equal(normalizeAddress(EIP55_VECTORS[1][1]), EIP55_VECTORS[1][0]);
	assert.equal(normalizeAddress(EIP55_VECTORS[1][0]), EIP55_VECTORS[1][0]);
	assert.throws(() => normalizeAddress("0x1234"), /expected a 0x-prefixed 40-hex address/);
});

test("requireInvoiceAddress enforces the checksum and returns the canonical form", () => {
	const [lower, checksummed] = EIP55_VECTORS[0];

	assert.equal(requireInvoiceAddress(checksummed), checksummed);
	assert.equal(requireInvoiceAddress(lower), checksummed, "uniform case is re-encoded");
	assert.equal(requireInvoiceAddress(`0x${lower.slice(2).toUpperCase()}`), checksummed);

	const wrong = withBrokenChecksum(checksummed);
	assert.throws(() => requireInvoiceAddress(wrong), InvalidChecksumError);
	assert.throws(() => requireInvoiceAddress(wrong), /invalid EIP-55 checksum/);
	assert.throws(() => requireInvoiceAddress("0x1234"), /expected a 0x-prefixed 40-hex address/);
	assert.throws(() => requireInvoiceAddress(null), /expected a 0x-prefixed 40-hex address/);
});

test("addressesEqual compares case-insensitively and never throws", () => {
	const [lower, checksummed] = EIP55_VECTORS[5];
	assert.equal(addressesEqual(lower, checksummed), true);
	assert.equal(addressesEqual(checksummed, checksummed.toUpperCase().replace(/^0X/, "0x")), true);
	assert.equal(addressesEqual(lower, EIP55_VECTORS[4][0]), false);
	assert.equal(addressesEqual(lower, "not an address"), false);
	assert.equal(addressesEqual(null, null), false);
});

test("addressToBytes and addressFromBytes round-trip 20 bytes", () => {
	const [lower, checksummed] = EIP55_VECTORS[4];
	const bytes = addressToBytes(checksummed);
	assert.ok(bytes instanceof Uint8Array);
	assert.equal(bytes.length, 20);
	assert.equal(addressFromBytes(bytes), lower);
	assert.deepEqual(addressToBytes(lower), bytes, "casing does not change the bytes");
	assert.equal(addressToBytes(checksummed)[0], 0xa0);

	assert.throws(() => addressFromBytes(new Uint8Array(19)), /expected 20 bytes, got 19/);
	assert.throws(() => addressFromBytes(new Uint8Array(21)), /expected 20 bytes, got 21/);
	assert.throws(() => addressFromBytes("0x"), /expected 20 bytes, got "0x"/);
	assert.throws(() => addressToBytes("0xnothex"), /expected a 0x-prefixed 40-hex address/);
});
