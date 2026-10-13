// Hand-written shim for the vendored @noble/hashes keccak module — declares the vendored exports the app's modules import or re-export.
export interface Keccak256Hasher {
	update(data: Uint8Array): Keccak256Hasher;
	digest(): Uint8Array;
}

export interface Keccak256 {
	(message: Uint8Array): Uint8Array;
	readonly outputLen: number;
	readonly blockLen: number;
	create(): Keccak256Hasher;
}

export declare const keccak_256: Keccak256;
