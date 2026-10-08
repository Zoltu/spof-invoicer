/** The suite for `app/js/wallet/erc20.js`: the selectors and the `transfer`, `balanceOf`, and `decimals` calldata against pinned vectors. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, toHex, utf8ToBytes } from "../app/js/util/encoding.js";
import { UINT256_MAX } from "../app/js/util/decimal.js";
import { ZERO_ADDRESS } from "../app/js/wallet/address.js";
import {
	decodeUint256,
	encodeBalanceOf,
	encodeDecimals,
	encodeTransfer,
	ERC20_SELECTORS,
} from "../app/js/wallet/erc20.js";

// A plain externally-owned recipient: the token's own contract address is rejected at the asset-aware requirePayableAddress guard, not by this asset-agnostic encoder.
const TO = "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb";
const TO_LOWER = TO.toLowerCase();

const TRANSFER_1_5 = "0xa9059cbb000000000000000000000000d1220a0cf47c7b9be7a2e6ba89f429762e7b9adb000000000000000000000000000000000000000000000000000000000016e360";
const BALANCE_OF = "0x70a08231000000000000000000000000d1220a0cf47c7b9be7a2e6ba89f429762e7b9adb";

function selectorOf(signature) {
	return toHex(keccak256(utf8ToBytes(signature))).slice(0, 8);
}

function word(value) {
	return `0x${value.toString(16).padStart(64, "0")}`;
}

test("selector constants are the keccak-256 prefixes of the ERC-20 signatures", () => {
	assert.equal(ERC20_SELECTORS.transfer, selectorOf("transfer(address,uint256)"));
	assert.equal(ERC20_SELECTORS.balanceOf, selectorOf("balanceOf(address)"));
	assert.equal(ERC20_SELECTORS.decimals, selectorOf("decimals()"));
	assert.equal(ERC20_SELECTORS.transfer, "a9059cbb");
	assert.equal(ERC20_SELECTORS.balanceOf, "70a08231");
	assert.equal(ERC20_SELECTORS.decimals, "313ce567");
});

test("encodeTransfer matches known-good calldata", () => {
	assert.equal(encodeTransfer(TO, 1500000n), TRANSFER_1_5);
	assert.equal(
		encodeTransfer(TO, 1500000n).length,
		2 + 8 + 64 + 64,
		"selector, padded address, padded uint256",
	);
	assert.equal(encodeTransfer(TO_LOWER, 1500000n), TRANSFER_1_5, "casing is irrelevant");
});

test("encodeTransfer pads the address and the amount independently", () => {
	const recipient = TO_LOWER.slice(2);
	assert.equal(
		encodeTransfer(TO, UINT256_MAX),
		`0xa9059cbb000000000000000000000000${recipient}${"f".repeat(64)}`,
	);
	assert.equal(
		encodeTransfer(TO, 0n),
		`0xa9059cbb000000000000000000000000${recipient}${"0".repeat(64)}`,
	);
	assert.equal(
		encodeTransfer(TO, 1n),
		`0xa9059cbb000000000000000000000000${recipient}${"0".repeat(63)}1`,
	);
});

test("encodeTransfer rejects the zero address, bad recipients, and out-of-range amounts", () => {
	assert.throws(() => encodeTransfer(ZERO_ADDRESS, 1n), /zero address/);
	assert.throws(() => encodeTransfer("0x1234", 1n), /expected a 0x-prefixed 40-hex address/);
	assert.throws(() => encodeTransfer(null, 1n), /expected a 0x-prefixed 40-hex address/);
	assert.throws(() => encodeTransfer(TO, -1n), /amount must not be negative/);
	assert.throws(() => encodeTransfer(TO, UINT256_MAX + 1n), /amount exceeds uint256/);
	assert.throws(() => encodeTransfer(TO, 1500000), /amount must be a bigint, got 1500000/);
	assert.throws(() => encodeTransfer(TO, "1500000"), /amount must be a bigint, got "1500000"/);
});

test("balanceOf calldata is the selector plus one padded address word, and decimals calldata is the bare selector", () => {
	assert.equal(encodeBalanceOf(TO), BALANCE_OF);
	assert.equal(encodeBalanceOf(TO_LOWER), BALANCE_OF);
	assert.equal(encodeBalanceOf(TO).length, 2 + 8 + 64);
	assert.equal(encodeBalanceOf(ZERO_ADDRESS), `0x${ERC20_SELECTORS.balanceOf}${"0".repeat(64)}`);
	assert.equal(encodeDecimals(), "0x313ce567");
	assert.throws(() => encodeBalanceOf("0xzzzz"), /expected a 0x-prefixed 40-hex address/);
});

test("decodeUint256 reads the single word eth_call returns", () => {
	assert.equal(decodeUint256(word(1500000n)), 1500000n);
	assert.equal(decodeUint256(word(UINT256_MAX)), UINT256_MAX);
	assert.equal(decodeUint256(word(0n)), 0n);
	assert.equal(
		decodeUint256(word(0xabcdn).toUpperCase().replace(/^0X/, "0x")),
		0xabcdn,
		"hex digits may arrive upper-cased",
	);

	const failures = ["0x", "0x00", `0x${"0".repeat(62)}`, `0x${"z".repeat(64)}`, null, undefined, 1];
	for (const data of failures) {
		assert.throws(
			() => decodeUint256(data),
			/expected a 0x-prefixed 32-byte hex word/,
			`decodeUint256(${JSON.stringify(data)})`,
		);
	}
});
