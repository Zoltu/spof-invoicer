/**
 * The capacity contract the app's QR encoder builds against: the versions it draws, the level-M block layout each version carries, and the byte ceiling the widest of them fills.
 *
 * It is a module of its own rather than part of the encoder so that a reader which only has to stay inside the symbols this app draws reads the ceiling without loading the encoder.
 * `payment/schemes.ts` derives the payment-link byte budget from {@link QR_MAX_TEXT_BYTES}, and every address validator's own length bound from that budget, so an encoder import here would put this app's field tables and mask selection — machinery an address validator never runs — into the module graph of a pasted-address check.
 * Nothing here encodes: `util/qr.ts` is the encoder, and it reads these same tables, so the ceiling a caller holds and the capacity the encoder applies are one statement rather than two figures kept in step by hand.
 * The tables are frozen, {@link BLOCK_SPECS} included: {@link QR_MAX_TEXT_BYTES} is derived from them, and through it the link layer's byte budget and the Zcash validator's address bound, so a stray write into a block figure would desynchronize the encoder's ceiling from both without any code having changed.
 *
 * Versions 1 to 15 cover a 21×21 to a 77×77 module symbol, and version 15 at level M holds 415 data codewords: after the twenty bits of a byte-mode header — four for the mode indicator, sixteen for the character count — 412 whole bytes remain for the text and four bits, which the terminator takes.
 * That 412-byte ceiling is the whole capacity contract this module states, and {@link QR_MAX_TEXT_BYTES} is that contract as the value a caller holds: a longer text is refused rather than truncated, since reaching past it would take the capacity and alignment tables of versions 16 to 40, which this encoder does not carry.
 */
/** The narrowest and widest symbol this app's encoder builds. */
export const MIN_VERSION = 1;
export const MAX_VERSION = 15;
/**
 * One {@link BlockSpec} per version, in version order from version 1: the blocks each version’s level-M symbol splits its data and error-correction codewords into.
 *
 * Each entry is frozen along with the array, because {@link QR_MAX_TEXT_BYTES} is read off this table and the byte budgets derived from that ceiling — the link layer's, and through it the Zcash address bound — are what hold a payment URI inside the symbol: a mutable figure here would let a stray write lower the ceiling a caller was promised or raise the one the encoder applies.
 */
export const BLOCK_SPECS = Object.freeze([
    Object.freeze({ ecPerBlock: 10, firstBlocks: 1, firstDataPerBlock: 16, secondBlocks: 0, secondDataPerBlock: 0 }),
    Object.freeze({ ecPerBlock: 16, firstBlocks: 1, firstDataPerBlock: 28, secondBlocks: 0, secondDataPerBlock: 0 }),
    Object.freeze({ ecPerBlock: 26, firstBlocks: 1, firstDataPerBlock: 44, secondBlocks: 0, secondDataPerBlock: 0 }),
    Object.freeze({ ecPerBlock: 18, firstBlocks: 2, firstDataPerBlock: 32, secondBlocks: 0, secondDataPerBlock: 0 }),
    Object.freeze({ ecPerBlock: 24, firstBlocks: 2, firstDataPerBlock: 43, secondBlocks: 0, secondDataPerBlock: 0 }),
    Object.freeze({ ecPerBlock: 16, firstBlocks: 4, firstDataPerBlock: 27, secondBlocks: 0, secondDataPerBlock: 0 }),
    Object.freeze({ ecPerBlock: 18, firstBlocks: 4, firstDataPerBlock: 31, secondBlocks: 0, secondDataPerBlock: 0 }),
    Object.freeze({ ecPerBlock: 22, firstBlocks: 2, firstDataPerBlock: 38, secondBlocks: 2, secondDataPerBlock: 39 }),
    Object.freeze({ ecPerBlock: 22, firstBlocks: 3, firstDataPerBlock: 36, secondBlocks: 2, secondDataPerBlock: 37 }),
    Object.freeze({ ecPerBlock: 26, firstBlocks: 4, firstDataPerBlock: 43, secondBlocks: 1, secondDataPerBlock: 44 }),
    Object.freeze({ ecPerBlock: 30, firstBlocks: 1, firstDataPerBlock: 50, secondBlocks: 4, secondDataPerBlock: 51 }),
    Object.freeze({ ecPerBlock: 22, firstBlocks: 6, firstDataPerBlock: 36, secondBlocks: 2, secondDataPerBlock: 37 }),
    Object.freeze({ ecPerBlock: 22, firstBlocks: 8, firstDataPerBlock: 37, secondBlocks: 1, secondDataPerBlock: 38 }),
    Object.freeze({ ecPerBlock: 24, firstBlocks: 4, firstDataPerBlock: 40, secondBlocks: 5, secondDataPerBlock: 41 }),
    Object.freeze({ ecPerBlock: 24, firstBlocks: 5, firstDataPerBlock: 41, secondBlocks: 5, secondDataPerBlock: 42 }),
]);
/** The data codewords one version holds, the sum over its blocks. */
export function dataCodewordCount(version) {
    const spec = BLOCK_SPECS[version - 1];
    return spec.firstBlocks * spec.firstDataPerBlock + spec.secondBlocks * spec.secondDataPerBlock;
}
/** Byte mode's character-count indicator is eight bits up to version 9 and sixteen from version 10 up, so the header's width follows the version. */
export function countIndicatorBits(version) {
    return version <= 9 ? 8 : 16;
}
/**
 * The text ceiling in bytes: the widest version's data codewords less byte mode's four-bit indicator, its count indicator and the terminator, which is the 412 bytes a caller can actually fill.
 * It is exported so that a reader which has to stay inside the symbols this app draws — `payment/links.ts`'s link budget, and through it the bound `wallet/zcash-address.ts` holds a mainnet unified container to — derives its figure from this capacity contract rather than copying the number, which is how the two would drift apart silently.
 * `encodeQr` pre-checks a string's code-unit length against it, since one code unit is never fewer than one UTF-8 byte.
 */
export const QR_MAX_TEXT_BYTES = Math.floor((dataCodewordCount(MAX_VERSION) * 8 - 4 - countIndicatorBits(MAX_VERSION)) / 8);
//# sourceMappingURL=qr-capacity.js.map