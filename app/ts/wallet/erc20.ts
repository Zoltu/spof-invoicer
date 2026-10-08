/**
 * ERC-20 calldata: the ABI encoding for the token calls the payment flow and its balance read make.
 *
 * It owns the four-byte function selectors and the 32-byte word layout, so callers work in `Address` and bigint values rather than hand-assembled hex.
 * The module is pure — it touches no provider — and fails closed on a zero-address recipient or an amount outside `uint256`, rather than emitting calldata that would burn funds or be rejected by the chain.
 */

import { UINT256_MAX } from "../util/decimal.js";
import { describe } from "../util/errors.js";
import { isZeroAddress, normalizeAddress } from "./address.js";

/** ERC-20 function selectors: the first four bytes of `keccak256(signature)`. */
export const ERC20_SELECTORS = Object.freeze({
	transfer: "a9059cbb",
	balanceOf: "70a08231",
	decimals: "313ce567",
});

const WORD_HEX_LENGTH = 64;

function encodeUint256(value: unknown): string {
	if (typeof value !== "bigint") {
		throw new TypeError(`erc20: amount must be a bigint, got ${describe(value)}`);
	}
	if (value < 0n) {
		throw new RangeError(`erc20: amount must not be negative, got ${value}`);
	}
	if (value > UINT256_MAX) {
		throw new RangeError(`erc20: amount exceeds uint256, got ${value}`);
	}
	return value.toString(16).padStart(WORD_HEX_LENGTH, "0");
}

function encodeAddressArgument(value: unknown): string {
	return normalizeAddress(value).slice(2).padStart(WORD_HEX_LENGTH, "0");
}

/**
 * Calldata for `transfer(address,uint256)` — the token moved, not the native coin.
 *
 * Fails closed on the zero address, which would burn the funds.
 * The asset-aware guard `requirePayableAddress` additionally rejects the token's own contract address; use it on the invoice-text recipient before calling this encoder.
 */
export function encodeTransfer(to: unknown, amount: unknown): string {
	if (isZeroAddress(to)) {
		throw new RangeError("erc20: transfer recipient must not be the zero address — it would burn the funds");
	}
	return `0x${ERC20_SELECTORS.transfer}${encodeAddressArgument(to)}${encodeUint256(amount)}`;
}

/** Calldata for `balanceOf(address)`, for an optional pre-flight balance check. */
export function encodeBalanceOf(owner: unknown): string {
	return `0x${ERC20_SELECTORS.balanceOf}${encodeAddressArgument(owner)}`;
}

/** Calldata for `decimals()`; no production path reads a token's decimals, and only the ERC-20 test calls this, to assert the selector bytes. */
export function encodeDecimals(): string {
	return `0x${ERC20_SELECTORS.decimals}`;
}

/** Decode the single 32-byte word an `eth_call` returns for a `uint256`. */
export function decodeUint256(data: unknown): bigint {
	if (typeof data !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(data)) {
		throw new TypeError(`erc20: expected a 0x-prefixed 32-byte hex word from eth_call, got ${describe(data)}`);
	}
	return BigInt(data);
}
