// Hand-written shim for the vendored @noble/hashes byte helpers — declares the vendored exports the app's modules import or re-export.
export declare function bytesToHex(bytes: Uint8Array): string;
export declare function hexToBytes(hex: string): Uint8Array;
export declare function utf8ToBytes(str: string): Uint8Array;
export declare function concatBytes(...arrays: Uint8Array[]): Uint8Array;
