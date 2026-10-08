/**
 * The single re-export surface for the vendored encoding primitives: lower-case hex, UTF-8, RFC 4648 base32, and keccak-256.
 *
 * Every other module imports these names from here rather than reaching into `app/js/vendor/`, so the vendored file layout stays in one place and the two renames the app makes — `bytesToHex` re-exported as `toHex` and noble's `keccak_256` re-exported as `keccak256` — sit beside it.
 */
/** Lower-case hex, no `0x` prefix. */
export { bytesToHex as toHex } from "../../js/vendor/noble-hashes/utils.js";
/** Decode a lower-case hex string into bytes. */
export { hexToBytes } from "../../js/vendor/noble-hashes/utils.js";
/** Encode a string as UTF-8 bytes. */
export { utf8ToBytes } from "../../js/vendor/noble-hashes/utils.js";
/** Bidirectional UTF-8 codec (`encode`/`decode`). */
export { utf8 } from "../../js/vendor/scure-base/index.js";
/** RFC 4648 base32, padded. */
export { base32 } from "../../js/vendor/scure-base/index.js";
/** RFC 4648 base32, unpadded. */
export { base32nopad } from "../../js/vendor/scure-base/index.js";
/** keccak-256 digest; the vendor exports it as `keccak_256`. */
export { keccak_256 as keccak256 } from "../../js/vendor/noble-hashes/sha3.js";
//# sourceMappingURL=encoding.js.map