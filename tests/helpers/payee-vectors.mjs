/**
 * The payee vectors the invoice suites share: mainnet payout addresses, spelled the way the address validators accept them — the transparent, Sapling, unified, and TEX Zcash spellings stand side by side here, since each is accepted on an encoding of its own — and the testnet TEX spelling a mainnet-only invoice refuses by the network its part names.
 *
 * They live here once so a suite's fixture and another suite's expectation cannot drift apart, and so a payee address is changed in one place rather than in every copy.
 */

import { bech32m } from "../../app/js/util/encoding.js";

/** An EIP-55 checksummed Ethereum address, spelled in the mixed case its own checksum requires. */
export const PAYEE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

/** A mainnet Sapling address: the shielded payee form a Zcash invoice names. */
export const ZEC_PAYEE = "zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9slya";

/** A mainnet unified address carrying a Sapling item, as librustzcash's `zcash_address` crate round-trips it: the default receiving form modern wallets hand out, accepted on its Bech32m checksum, part, length, and payload floor. */
export const ZEC_UNIFIED_PAYEE = "u1qpatys4zruk99pg59gcscrt7y6akvl9vrhcfyhm9yxvxz7h87q6n8cgrzzpe9zru68uq39uhmlpp5uefxu0su5uqyqfe5zp3tycn0ecl";

/** A mainnet transparent P2PKH address: the unshielded Zcash form the validator accepts beside Sapling, unified, and TEX, so an invoice naming one reaches the link, the view, and the PDF too. */
export const ZEC_TRANSPARENT_PAYEE = "t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs";

/** A mainnet TEX address from ZIP-320's own reference implementation: the transparent-source-only spelling of a 20-byte HASH160 that is not the one {@link ZEC_TRANSPARENT_PAYEE} carries, so the two vectors name different scripts, and the validator stores this one as the payee published it rather than rewriting it into a `t1` twin. */
export const ZEC_TEX_PAYEE = "tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte";

/** A testnet TEX address under ZIP-320's `textest` human-readable part over a zeroed 20-byte payload, checksum and all: a well-formed address of the width a TEX address carries, so the refusals it drives are the network refusal its part names rather than a malformed paste. */
export const ZEC_TEX_TESTNET_PAYEE = bech32m.encode("textest", bech32m.toWords(new Uint8Array(20)), false);

/** A mainnet Monero address: the payee form a Monero invoice names. */
export const XMR_PAYEE = "46BeWrHpwXmHDpDEUmZBWZfoQpdc6HaERCNmx1pEYL2rAcuwufPN9rXHHtyUA4QVy66qeFQkn6sfK8aHYjA3jk3o1Bv16em";
