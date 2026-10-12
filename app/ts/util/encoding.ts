/**
 * The single re-export surface for the vendored encoding primitives: lower-case hex, UTF-8, RFC 4648 base32, base58 and its Monero variant, bech32/bech32m, the Base58Check factory, and the keccak-256 and sha-256 digests.
 *
 * Every other module imports these names from here rather than reaching into `app/js/vendor/`, so the vendored file layout stays in one place and the two renames the app makes — `bytesToHex` re-exported as `toHex` and noble's `keccak_256` re-exported as `keccak256` — sit beside it.
 *
 * `bech32` and `bech32m` are re-exported with @scure/base's 90-character default cap left in place on `encode` as well as `decode`: `decode` throws on a longer input string, and `encode` throws when the string it would produce exceeds the cap, so a caller that needs a longer string passes an explicit wider `limit` or `false` to lift the cap.
 */

/** Lower-case hex, no `0x` prefix. */
export { bytesToHex as toHex } from "../../js/vendor/noble-hashes/utils.js";

/** Decode a hex string into bytes; a non-string throws a `TypeError`, and an odd-length string or a non-hex character throws a `RangeError`. */
export { hexToBytes } from "../../js/vendor/noble-hashes/utils.js";

/** Encode a string as UTF-8 bytes through the platform `TextEncoder`, returning a fresh array; a non-string throws a `TypeError`. */
export { utf8ToBytes } from "../../js/vendor/noble-hashes/utils.js";

/** Strict UTF-8, backed by the platform `TextEncoder`/`TextDecoder` when available. */
export { utf8 } from "../../js/vendor/scure-base/index.js";

/** RFC 4648 base32, padded. */
export { base32 } from "../../js/vendor/scure-base/index.js";

/** RFC 4648 base32, unpadded. */
export { base32nopad } from "../../js/vendor/scure-base/index.js";

/**
 * Bitcoin base58 (`123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz`).
 * Its big-number conversion is quadratic in the input length, so the vendored implementation caps the input at 2048 bytes to encode and 4096 characters to decode and throws beyond either; base32 is the linear, uncapped encoding this app uses for invoice payloads.
 */
export { base58 } from "../../js/vendor/scure-base/index.js";

/** Monero's block-padded base58 variant. */
export { base58xmr } from "../../js/vendor/scure-base/index.js";

/** BIP 173 bech32, the 5-bit-word codec behind the `bc1` (Bitcoin) and `zs1` (Zcash) address prefixes; those prefixes are the human-readable part plus the `1` separator, and the six trailing characters are the checksum over the prefix and data. */
export { bech32 } from "../../js/vendor/scure-base/index.js";

/** BIP 350 bech32m, the codec behind the `bc1p` (Bitcoin) and `u1` (Zcash) address prefixes, which shares bech32's 5-bit-word layout and the same six-character checksum position but uses a different checksum constant. */
export { bech32m } from "../../js/vendor/scure-base/index.js";

/**
 * Factory for a Base58Check codec, not a codec itself: call it with a SHA-256 function to get a codec that appends a 4-byte double-SHA-256 checksum to the payload; `base58check` is the deprecated upstream alias of `createBase58check`.
 * The codec it returns inherits base58's quadratic conversion and the same input cap: 2048 bytes to encode, 4096 characters to decode.
 */
export { base58check } from "../../js/vendor/scure-base/index.js";

/** keccak-256 digest; the vendor exports it as `keccak_256`. */
export { keccak_256 as keccak256 } from "../../js/vendor/noble-hashes/sha3.js";

/** One-shot SHA-256 over the message bytes, returning the 32-byte digest. */
export { sha256 } from "../../js/vendor/noble-hashes/sha2.js";
