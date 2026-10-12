// Hand-written shim for the vendored @scure/base bundle — declares the vendored exports the app's modules import or re-export.
export interface BytesCoder {
	encode(bytes: Uint8Array): string;
	decode(text: string): Uint8Array;
}

export interface Bech32Decoded<Prefix extends string = string> {
	prefix: Prefix;
	words: number[];
}

export interface Bech32 {
	encode(prefix: string, words: number[] | Uint8Array, limit?: number | false): string;
	decode(str: string, limit?: number | false): Bech32Decoded;
	toWords(bytes: Uint8Array): number[];
	fromWords(words: number[]): Uint8Array;
}

export declare const base32: BytesCoder;
export declare const base32nopad: BytesCoder;
export declare const base58: BytesCoder;
export declare const base58xmr: BytesCoder;
export declare const bech32: Bech32;
export declare const bech32m: Bech32;
export declare const utf8: BytesCoder;

export declare const base58check: (sha256: (msg: Uint8Array) => Uint8Array) => BytesCoder;
