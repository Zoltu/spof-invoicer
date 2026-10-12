/**
 * The tamper the address suites share: the final character of an address-shaped string replaced by another one the string's own encoding carries.
 *
 * The pair is the encoding's characters to swap between — Base58Check's `a` and `b`, Bech32's `q` and `p` — because a character outside the alphabet would be refused for the encoding rather than for the checksum, which is the refusal these suites are pinning.
 */

export function tamperLastCharacter(value, [first, second]) {
	const last = value.slice(-1);
	return value.slice(0, -1) + (last === first ? second : first);
}
