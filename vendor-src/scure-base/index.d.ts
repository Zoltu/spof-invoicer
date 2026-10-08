// Hand-written shim for the vendored @scure/base bundle — declares only the surface this app uses.
export interface BytesCoder {
	encode(bytes: Uint8Array): string;
	decode(text: string): Uint8Array;
}

export declare const base32: BytesCoder;
export declare const base32nopad: BytesCoder;
export declare const base64urlnopad: BytesCoder;
export declare const hex: BytesCoder;
export declare const utf8: BytesCoder;
