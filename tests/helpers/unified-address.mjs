/**
 * The unified-address fixture the address, link, view, and PDF suites share: a Bech32m container over a given number of payload bytes, checksum and all.
 *
 * The payload is deterministic filler rather than a real container: a suite that needs an address of a given length wants the shape `wallet/zcash-address.ts` accepts under its mainnet part, and nothing behind it is read.
 */

import { bech32m } from "../../app/js/util/encoding.js";

/** A unified-address-shaped string over `byteLength` payload bytes, checksum and all — the shape the payout validator accepts under its mainnet part. */
export function unifiedOfBytes(byteLength) {
	const payload = new Uint8Array(byteLength);
	for (let index = 0; index < byteLength; index += 1) payload[index] = (index * 7) & 0xff;
	return bech32m.encode("u", bech32m.toWords(payload), false);
}
