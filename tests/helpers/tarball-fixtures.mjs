/**
 * Fabricated gzip+tar archives for `tests/vendor-integrity.test.mjs`, this module's only importer: real ustar headers and a real gzip stream, so a test exercises the reader `scripts/vendor-tarball.mjs` uses rather than a stand-in.
 */

import { gzipSync } from "node:zlib";

const BLOCK = 512;

// A real ustar header, so the fixture archives exercise the reader the vendor script uses: an octal field is NUL-padded, and the checksum is summed over the header with its own field left as spaces.
// `typeflag` names the entry kind — a regular file ("0"), a directory ("5"), a link ("1"/"2"), or a GNU ("L") or pax ("x"/"g") extended header.
function tarHeader(name, size, typeflag = "0") {
	const header = Buffer.alloc(BLOCK);
	const octal = (value, length) => value.toString(8).padStart(length - 1, "0") + "\0";
	header.write(name, 0, 100, "utf8");
	header.write(octal(0o644, 8), 100);
	header.write(octal(0, 8), 108);
	header.write(octal(0, 8), 116);
	header.write(octal(size, 12), 124);
	header.write(octal(0, 12), 136);
	header.write("        ", 148);
	header.write(typeflag, 156);
	header.write("ustar\0", 257);
	header.write("00", 263);
	header.write(header.reduce((total, byte) => total + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
	return header;
}

/** The uncompressed ustar bytes for `{ name, typeflag, data }` entries, each written verbatim, so a caller can corrupt a field or truncate the archive before gzipping. */
export function rawTarBytes(entries) {
	const parts = [];
	for (const { name, typeflag = "0", data = Buffer.alloc(0) } of entries) {
		parts.push(tarHeader(name, data.length, typeflag), data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
	}
	parts.push(Buffer.alloc(BLOCK * 2));
	return Buffer.concat(parts);
}

/** A gzipped ustar archive from raw `{ name, typeflag, data }` entries, each written verbatim. */
export function buildRawTarball(entries) {
	return gzipSync(rawTarBytes(entries));
}

/** A gzipped ustar archive holding `entries` (`[name, text]` pairs) as regular files with the names written verbatim. */
export function buildTarball(entries) {
	return buildRawTarball(entries.map(([name, text]) => ({ name, data: Buffer.from(text) })));
}

// A pax record's length prefix counts the whole record — itself, the space, and the body — so the digit count feeds back into the total; iterating the fixed point settles it, and a second pass only when the total crosses a power of ten.
function paxRecord(key, value) {
	const body = `${key}=${value}\n`;
	let length = body.length + 2;
	while (String(length).length + 1 + body.length !== length) {
		length = String(length).length + 1 + body.length;
	}
	return `${length} ${body}`;
}

/** The pax extended-header body for `records` (`[key, value]` pairs), each record length-prefixed with the total record length pax requires. */
export function paxData(records) {
	return Buffer.from(records.map(([key, value]) => paxRecord(key, value)).join(""));
}
