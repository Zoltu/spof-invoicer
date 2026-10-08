/**
 * Ethereum address syntax, EIP-55 checksum handling, and the address ↔ 20-byte conversion shared by the invoice and wallet layers.
 *
 * The module offers two normalizations on purpose: {@link normalizeAddress} lower-cases trusted, already-validated input without checking casing, while {@link requireInvoiceAddress} is the one entry point for untrusted text — an invoice payee, a pasted recipient — and refuses a mixed-case body whose EIP-55 checksum does not match, since that contradiction is exactly the mistyped character EIP-55 exists to catch.
 */

import { hexToBytes, keccak256, toHex, utf8ToBytes } from "../util/encoding.js";
import { describe } from "../util/errors.js";

/** A `0x`-prefixed 40-hex-digit Ethereum address. Casing is not encoded in the type. */
export type Address = `0x${string}`;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

const ADDRESS_BYTES = 20;

/** The all-zero address. A transfer here is unrecoverable, so the transfer guards reject it. */
export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** True when `value` is a `0x`-prefixed 40-hex address, narrowing it to {@link Address}. */
export function isAddress(value: unknown): value is Address {
	return typeof value === "string" && ADDRESS_PATTERN.test(value);
}

/**
 * Syntax-only normalization: lower-case an address and keep the `0x` prefix, throwing on anything that is not an address.
 *
 * This does not check EIP-55 casing, so it must not be the path for text a human or an invoice supplied — route that through {@link requireInvoiceAddress}.
 * Use it for trusted, already-validated input and before comparing or encoding, where casing is presentation only.
 */
export function normalizeAddress(value: unknown): Address {
	if (!isAddress(value)) {
		throw new TypeError(`address: expected a 0x-prefixed 40-hex address, got ${describe(value)}`);
	}
	return value.toLowerCase() as Address;
}

/** Case-insensitive comparison. Returns `false` (never throws) when either side is not an address. */
export function addressesEqual(a: unknown, b: unknown): boolean {
	if (!isAddress(a) || !isAddress(b)) {
		return false;
	}
	return a.toLowerCase() === b.toLowerCase();
}

/** True when `value` is the all-zero address. Never throws; a non-address is `false`. */
export function isZeroAddress(value: unknown): boolean {
	return addressesEqual(value, ZERO_ADDRESS);
}

/**
 * EIP-55 checksummed form of an address.
 *
 * The address is keccak-256 hashed in lower case without the prefix; nibble `i` of the address is upper-cased when nibble `i` of the hash is greater than 7.
 */
export function toChecksumAddress(value: unknown): Address {
	const lower = normalizeAddress(value).slice(2);
	const hash = toHex(keccak256(utf8ToBytes(lower)));
	let checksummed = "";
	for (let i = 0; i < lower.length; i += 1) {
		checksummed += Number.parseInt(hash[i], 16) > 7 ? lower[i].toUpperCase() : lower[i];
	}
	return `0x${checksummed}`;
}

/**
 * How much typo protection an address's casing carries, so a caller can tell "verified" from "no checksum present" instead of accepting both as valid:
 * - `"checksummed"` — mixed case that matches its EIP-55 form exactly; a typo would fail the checksum.
 * - `"unverifiable"` — uniformly lower- or upper-case, which encodes no checksum and cannot catch a typo (EIP-55 lets clients skip validation there).
 * - `"invalid"` — not an address, or a mixed-case body that contradicts its EIP-55 checksum.
 */
export type ChecksumStatus = "checksummed" | "unverifiable" | "invalid";

/** Classify an address's casing as its EIP-55 {@link ChecksumStatus}, so a caller can tell a verified checksum from an absent one. */
export function checksumStatus(value: unknown): ChecksumStatus {
	if (!isAddress(value)) {
		return "invalid";
	}
	const body = value.slice(2);
	if (body === body.toLowerCase() || body === body.toUpperCase()) {
		return "unverifiable";
	}
	return value === toChecksumAddress(value) ? "checksummed" : "invalid";
}

/**
 * True when an address passes the EIP-55 rule: a mixed-case body must match its checksum, and a uniformly-cased body is accepted as-is.
 * Use {@link checksumStatus} when the caller must react to the absence of a checksum rather than merely proceed.
 */
export function hasValidChecksum(value: unknown): boolean {
	return checksumStatus(value) !== "invalid";
}

/** Raised by {@link requireInvoiceAddress} for a mixed-case address whose EIP-55 checksum does not match. */
export class InvalidChecksumError extends Error {
	constructor(value: string) {
		super(`address: ${describe(value)} has an invalid EIP-55 checksum — check for a mistyped character`);
		this.name = "InvalidChecksumError";
	}
}

/**
 * The one entry point for an address that arrives as untrusted text (an invoice payee, a pasted recipient).
 * Enforces EIP-55 consistency for mixed case and returns the canonical checksummed form, so the caller stores and displays a single spelling.
 * Uniform-case text carries no checksum and is re-encoded (use {@link checksumStatus} to warn about that gap).
 * A mixed-case address with a bad checksum, which {@link normalizeAddress} would let through, is refused here.
 */
export function requireInvoiceAddress(value: unknown): Address {
	if (!isAddress(value)) {
		throw new TypeError(`address: expected a 0x-prefixed 40-hex address, got ${describe(value)}`);
	}
	if (checksumStatus(value) === "invalid") {
		throw new InvalidChecksumError(value);
	}
	return toChecksumAddress(value);
}

/** The 20 raw bytes of an address. */
export function addressToBytes(value: unknown): Uint8Array {
	return hexToBytes(normalizeAddress(value).slice(2));
}

/** The lower-case `0x` address for 20 raw bytes. */
export function addressFromBytes(bytes: unknown): Address {
	if (!(bytes instanceof Uint8Array) || bytes.length !== ADDRESS_BYTES) {
		const received = bytes instanceof Uint8Array ? bytes.length : describe(bytes);
		throw new TypeError(`address: expected ${ADDRESS_BYTES} bytes, got ${received}`);
	}
	return `0x${toHex(bytes)}`;
}
