/**
 * The payee vectors the invoice suites share: mainnet payout addresses, spelled the way the address validators accept them — the two Zcash forms a payee may name stand side by side, since the transparent, Sapling, and unified spellings are accepted on different encodings.
 *
 * They live here once so a suite's fixture and another suite's expectation cannot drift apart, and so a payee address is changed in one place rather than in every copy.
 */

/** An EIP-55 checksummed Ethereum address, spelled in the mixed case its own checksum requires. */
export const PAYEE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

/** A mainnet Sapling address: the shielded payee form a Zcash invoice names. */
export const ZEC_PAYEE = "zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9slya";

/** A mainnet unified address carrying a Sapling item, as librustzcash's `zcash_address` crate round-trips it: the default receiving form modern wallets hand out, accepted on its Bech32m checksum, part, length, and payload floor. */
export const ZEC_UNIFIED_PAYEE = "u1qpatys4zruk99pg59gcscrt7y6akvl9vrhcfyhm9yxvxz7h87q6n8cgrzzpe9zru68uq39uhmlpp5uefxu0su5uqyqfe5zp3tycn0ecl";

/** A mainnet transparent P2PKH address: the unshielded Zcash form the validator accepts beside Sapling and unified, so an invoice naming one reaches the link, the view, and the PDF too. */
export const ZEC_TRANSPARENT_PAYEE = "t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs";

/** A mainnet Monero address: the payee form a Monero invoice names. */
export const XMR_PAYEE = "46BeWrHpwXmHDpDEUmZBWZfoQpdc6HaERCNmx1pEYL2rAcuwufPN9rXHHtyUA4QVy66qeFQkn6sfK8aHYjA3jk3o1Bv16em";
