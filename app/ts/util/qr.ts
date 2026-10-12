/**
 * The first-party QR Code encoder: byte mode, error-correction level M, automatic version selection, and mask selection by the standard’s four penalty rules.
 *
 * The app is a static, network-free bundle whose vendor tree is integrity-pinned, so a symbol is produced from a payment URI in the browser rather than fetched from a service or added as a third-party dependency.
 * Byte mode carries any URI — the Zcash, Monero and EIP-681 links all leave the alphanumeric repertoire — and level M is the level the wallets display, with recovery capacity a payment link never needs.
 * The versions this encoder draws, each version’s level-M block layout, and the {@link QR_MAX_TEXT_BYTES} ceiling those blocks add up to live in `util/qr-capacity.ts`, a module of its own so that a reader which only has to stay inside a symbol this app draws — `payment/schemes.ts`’s link budget, and through it every address validator’s length bound — reads the figure without loading this encoder; this module reads those same tables, so the ceiling a caller holds and the capacity applied here cannot drift apart.
 * A returned matrix is the symbol alone — no quiet zone, no rendering — so each renderer owns its own margin.
 */

import { utf8ToBytes } from "./encoding.js";
import { describe, preview } from "./errors.js";
import { BLOCK_SPECS, MAX_VERSION, MIN_VERSION, QR_MAX_TEXT_BYTES, countIndicatorBits, dataCodewordCount } from "./qr-capacity.js";

export { QR_MAX_TEXT_BYTES };

/**
 * A QR symbol's module grid: one entry per row from the top, `true` for a dark module, and no quiet zone.
 *
 * A returned symbol is frozen, rows included, so a renderer may hold it or pass it on without copying; a caller who needs a mutable grid maps its rows to fresh arrays.
 */
export interface QrMatrix {
	/** The module count along one side; a symbol is square. */
	readonly size: number;
	/** The module rows, one per row from the top; the array and its rows are frozen. */
	readonly modules: readonly (readonly boolean[])[];
}

/** How to build a symbol; `version` pins the symbol size instead of letting the encoder choose the smallest one that fits. */
export interface QrOptions {
	/** A version from 1 (21×21 modules) to 15 (77×77); a text that does not fit it is refused. */
	readonly version?: number;
}

/** Byte mode's four-bit mode indicator. */
const BYTE_MODE = 0b0100;

/** Level M's two-bit code in the format-information field; the levels are L `01`, M `00`, Q `11`, H `10`. */
const LEVEL_M = 0b00;

/** The fixed pattern the standard XORs into the fifteen format-information bits, so an all-zero field cannot read as a symbol. */
const FORMAT_XOR_MASK = 0b101010000010010;

/** Format information's BCH(15, 5) generator, x^10 + x^8 + x^5 + x^4 + x^2 + x + 1, and the ten bits it appends. */
const FORMAT_GENERATOR = 0b10100110111;
const FORMAT_REMAINDER_BITS = 10;

/** Version information's BCH(18, 6) generator, x^12 + x^11 + x^10 + x^9 + x^8 + x^5 + x^2 + 1, and the twelve bits it appends. */
const VERSION_GENERATOR = 0b1111100100101;
const VERSION_REMAINDER_BITS = 12;

/** The two pad codewords, alternated from the first pad position onward. */
const PAD_CODEWORDS: readonly number[] = [0xec, 0x11];

/** The weights the standard assigns its four mask rules: runs of five modules, 2×2 blocks of one color, finder-like patterns, and a dark share away from half. */
const RUN_PENALTY = 3;
const BLOCK_PENALTY = 3;
const FINDER_LIKE_PENALTY = 40;
const BALANCE_PENALTY = 10;

/**
 * The modules holding bit 0 to bit 14 of the first format-information copy, which runs around the top-left finder pattern.
 * The dark module that follows bit 7 is not part of the field and is drawn separately.
 */
const FIRST_FORMAT_POSITIONS: readonly (readonly [number, number])[] = [
	[0, 8],
	[1, 8],
	[2, 8],
	[3, 8],
	[4, 8],
	[5, 8],
	[7, 8],
	[8, 8],
	[8, 7],
	[8, 5],
	[8, 4],
	[8, 3],
	[8, 2],
	[8, 1],
	[8, 0],
];

/** The 1:1:3:1:1 finder shape and its mirror, each with the four light modules rule 3 requires beside it. */
const FINDER_LIKE: readonly boolean[] = [true, false, true, true, true, false, true, false, false, false, false];
const FINDER_LIKE_REVERSED: readonly boolean[] = [...FINDER_LIKE].reverse();

/** The alignment-pattern centres per version: the coordinates of the 5×5 markers' centres, 6 and the far edge always among them. */
const ALIGNMENT_CENTRES: readonly (readonly number[])[] = [
	[],
	[6, 18],
	[6, 22],
	[6, 26],
	[6, 30],
	[6, 34],
	[6, 22, 38],
	[6, 24, 42],
	[6, 26, 46],
	[6, 28, 50],
	[6, 30, 54],
	[6, 32, 58],
	[6, 34, 62],
	[6, 26, 46, 66],
	[6, 26, 48, 70],
];

/**
 * GF(256)'s exponent and logarithm tables, for the primitive polynomial x^8 + x^4 + x^3 + x^2 + 1.
 * The exponent table is doubled so that the sum of two logarithms indexes it without a modulo.
 */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
for (let power = 0, value = 1; power < 255; power += 1) {
	GF_EXP[power] = value;
	GF_LOG[value] = power;
	value <<= 1;
	if (value > 0xff) value ^= 0x11d;
}
for (let power = 255; power < GF_EXP.length; power += 1) {
	GF_EXP[power] = GF_EXP[power - 255];
}

/** Multiplication in GF(256); a zero factor keeps the product zero, which the logarithm tables cannot express. */
function gfMultiply(left: number, right: number): number {
	if (left === 0 || right === 0) return 0;
	return GF_EXP[GF_LOG[left] + GF_LOG[right]];
}

/** The generator polynomial for `degree` error-correction codewords, highest power first: (x - α^0)(x - α^1)…(x - α^(degree-1)). */
function generatorPolynomial(degree: number): Uint8Array {
	let polynomial = Uint8Array.of(1);
	for (let index = 0; index < degree; index += 1) {
		const factor = GF_EXP[index];
		const next = new Uint8Array(polynomial.length + 1);
		for (let term = 0; term < polynomial.length; term += 1) {
			next[term] ^= polynomial[term];
			next[term + 1] ^= gfMultiply(polynomial[term], factor);
		}
		polynomial = next;
	}
	return polynomial;
}

/** The Reed–Solomon codewords of one block: the remainder of `data · x^ecLength` divided by the field's generator polynomial, computed by synthetic division. */
function errorCorrection(data: Uint8Array, ecLength: number): Uint8Array {
	const generator = generatorPolynomial(ecLength);
	const remainder = new Uint8Array(ecLength);
	for (const byte of data) {
		const factor = byte ^ remainder[0];
		remainder.copyWithin(0, 1);
		remainder[ecLength - 1] = 0;
		for (let index = 0; index < ecLength; index += 1) {
			remainder[index] ^= gfMultiply(generator[index + 1], factor);
		}
	}
	return remainder;
}

/** Append `width` bits of `value`, most significant bit first. */
function appendBits(bits: number[], value: number, width: number): void {
	for (let shift = width - 1; shift >= 0; shift -= 1) {
		bits.push((value >> shift) & 1);
	}
}

/** Pack a whole number of bits into bytes, most significant bit of each byte first. */
function toBytes(bits: readonly number[]): Uint8Array {
	const bytes = new Uint8Array(bits.length >> 3);
	for (let index = 0; index < bits.length; index += 1) {
		if (bits[index] !== 0) bytes[index >> 3] |= 0x80 >> (index & 7);
	}
	return bytes;
}

/** Whether a byte-mode string of `byteLength` bytes fits a version's capacity, header and terminator included. */
function fits(version: number, byteLength: number): boolean {
	const countBits = countIndicatorBits(version);
	if (byteLength >= 1 << countBits) return false;
	return 4 + countBits + byteLength * 8 <= dataCodewordCount(version) * 8;
}

/** The smallest version that holds the text, or the caller's pinned one, which must hold it. */
function chooseVersion(byteLength: number, pinned: number | undefined): number {
	if (pinned !== undefined) {
		if (!Number.isInteger(pinned) || pinned < MIN_VERSION || pinned > MAX_VERSION) {
			throw new RangeError(`qr: version must be an integer from ${MIN_VERSION} to ${MAX_VERSION}, got ${preview(pinned)}`);
		}
		if (!fits(pinned, byteLength)) {
			throw new RangeError(`qr: ${byteLength} bytes do not fit version ${pinned} at level M`);
		}
		return pinned;
	}
	for (let version = MIN_VERSION; version <= MAX_VERSION; version += 1) {
		if (fits(version, byteLength)) return version;
	}
	throw new RangeError(`qr: ${byteLength} bytes exceed version ${MAX_VERSION} at level M, the largest symbol this encoder builds`);
}

/** The version's data codewords: the byte-mode header, the text, the terminator, and the alternating pad codewords up to capacity. */
function encodeDataCodewords(bytes: Uint8Array, version: number): Uint8Array {
	const capacity = dataCodewordCount(version);
	const bits: number[] = [];
	appendBits(bits, BYTE_MODE, 4);
	appendBits(bits, bytes.length, countIndicatorBits(version));
	for (const byte of bytes) appendBits(bits, byte, 8);
	appendBits(bits, 0, Math.min(4, capacity * 8 - bits.length));
	appendBits(bits, 0, (8 - (bits.length % 8)) % 8);

	const data = new Uint8Array(capacity);
	const written = toBytes(bits);
	data.set(written);
	for (let index = written.length; index < capacity; index += 1) {
		data[index] = PAD_CODEWORDS[(index - written.length) % 2];
	}
	return data;
}

/** The final message: each block's error-correction codewords appended to its data, then both interleaved block by block as the standard lays them out. */
function interleave(version: number, data: Uint8Array): Uint8Array {
	const spec = BLOCK_SPECS[version - 1];
	const groups = [
		{ count: spec.firstBlocks, dataPerBlock: spec.firstDataPerBlock },
		{ count: spec.secondBlocks, dataPerBlock: spec.secondDataPerBlock },
	];
	const dataBlocks: Uint8Array[] = [];
	const ecBlocks: Uint8Array[] = [];
	let offset = 0;
	for (const group of groups) {
		for (let block = 0; block < group.count; block += 1) {
			const dataBlock = data.slice(offset, offset + group.dataPerBlock);
			offset += group.dataPerBlock;
			dataBlocks.push(dataBlock);
			ecBlocks.push(errorCorrection(dataBlock, spec.ecPerBlock));
		}
	}

	const message = new Uint8Array(offset + ecBlocks.length * spec.ecPerBlock);
	let at = 0;
	const longestData = Math.max(...dataBlocks.map((block) => block.length));
	for (let index = 0; index < longestData; index += 1) {
		for (const block of dataBlocks) {
			if (index < block.length) {
				message[at] = block[index];
				at += 1;
			}
		}
	}
	for (let index = 0; index < spec.ecPerBlock; index += 1) {
		for (const block of ecBlocks) {
			message[at] = block[index];
			at += 1;
		}
	}
	return message;
}

function blankGrid(size: number, fill: boolean): boolean[][] {
	return Array.from({ length: size }, () => new Array<boolean>(size).fill(fill));
}

/** Where the second format copy's bit `index` is drawn: bits 0 to 7 run left along row 8, and bits 8 to 14 run down column 8. */
function secondFormatPosition(index: number, size: number): readonly [number, number] {
	return index < 8 ? [8, size - 1 - index] : [size - 15 + index, 8];
}

/**
 * The grid with every function pattern drawn and the format areas reserved: the three finder patterns with their separators, the two timing patterns, the alignment patterns, the always-dark module, and from version 7 up the two version-information blocks.
 * Reserved modules hold no data, so the caller can draw data over the rest without consulting the version again.
 */
function functionPatterns(version: number): { readonly modules: boolean[][]; readonly reserved: boolean[][] } {
	const size = version * 4 + 17;
	const modules = blankGrid(size, false);
	const reserved = blankGrid(size, false);
	for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
		for (let row = Math.max(top - 1, 0); row <= Math.min(top + 7, size - 1); row += 1) {
			for (let col = Math.max(left - 1, 0); col <= Math.min(left + 7, size - 1); col += 1) {
				const inFinder = row >= top && row < top + 7 && col >= left && col < left + 7;
				// A finder is dark on its 3×3 centre and its outer ring, light in between; the ring of separators around it is entirely light.
				modules[row][col] = inFinder && Math.max(Math.abs(row - top - 3), Math.abs(col - left - 3)) !== 2;
				reserved[row][col] = true;
			}
		}
	}

	for (let index = 8; index < size - 8; index += 1) {
		modules[6][index] = index % 2 === 0;
		reserved[6][index] = true;
		modules[index][6] = index % 2 === 0;
		reserved[index][6] = true;
	}

	const centres = ALIGNMENT_CENTRES[version - 1];
	for (const centreRow of centres) {
		for (const centreCol of centres) {
			// The three positions that fall on a finder pattern are already covered by it.
			if (centreRow === 6 && (centreCol === 6 || centreCol === size - 7)) continue;
			if (centreCol === 6 && centreRow === size - 7) continue;
			for (let row = centreRow - 2; row <= centreRow + 2; row += 1) {
				for (let col = centreCol - 2; col <= centreCol + 2; col += 1) {
					// An alignment pattern is dark on its centre and its outer ring, light in between.
					modules[row][col] = Math.max(Math.abs(row - centreRow), Math.abs(col - centreCol)) !== 1;
					reserved[row][col] = true;
				}
			}
		}
	}

	modules[size - 8][8] = true;
	reserved[size - 8][8] = true;

	if (version >= 7) {
		const bits = versionInformation(version);
		for (let index = 0; index < 18; index += 1) {
			const dark = ((bits >> index) & 1) === 1;
			const near = size - 11 + (index % 3);
			const far = Math.floor(index / 3);
			modules[far][near] = dark;
			reserved[far][near] = true;
			modules[near][far] = dark;
			reserved[near][far] = true;
		}
	}

	for (let index = 0; index < 15; index += 1) {
		const [row, col] = FIRST_FORMAT_POSITIONS[index];
		reserved[row][col] = true;
		const [secondRow, secondCol] = secondFormatPosition(index, size);
		reserved[secondRow][secondCol] = true;
	}
	return { modules, reserved };
}

/** The bit length of a non-negative integer, its highest set bit's position plus one; zero has length zero. */
function bitLength(value: number): number {
	let length = 0;
	for (let rest = value; rest > 0; rest >>>= 1) length += 1;
	return length;
}

/** The remainder of `value` divided by the binary polynomial `generator` of degree `degree`, by long division over GF(2). */
function bchRemainder(value: number, generator: number, degree: number): number {
	let remainder = value;
	for (let shift = bitLength(value) - 1 - degree; shift >= 0; shift -= 1) {
		if (((remainder >>> (shift + degree)) & 1) === 1) remainder ^= generator << shift;
	}
	return remainder;
}

/** The fifteen format-information bits: level M, the mask reference, a ten-bit BCH remainder, and the standard's fixed XOR mask. */
function formatInformation(mask: number): number {
	const data = (LEVEL_M << 3) | mask;
	return ((data << 10) | bchRemainder(data << 10, FORMAT_GENERATOR, FORMAT_REMAINDER_BITS)) ^ FORMAT_XOR_MASK;
}

/** The eighteen version-information bits: the six-bit version and its twelve-bit BCH remainder, drawn from version 7 up. */
function versionInformation(version: number): number {
	return (version << VERSION_REMAINDER_BITS) | bchRemainder(version << VERSION_REMAINDER_BITS, VERSION_GENERATOR, VERSION_REMAINDER_BITS);
}

/** True where mask pattern `mask` inverts the module at `(row, col)`. */
function maskInverts(mask: number, row: number, col: number): boolean {
	switch (mask) {
		case 0:
			return (row + col) % 2 === 0;
		case 1:
			return row % 2 === 0;
		case 2:
			return col % 3 === 0;
		case 3:
			return (row + col) % 3 === 0;
		case 4:
			return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
		case 5:
			return ((row * col) % 2) + ((row * col) % 3) === 0;
		case 6:
			return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
		case 7:
			return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
		default:
			throw new RangeError(`qr: mask must be 0 to 7, got ${describe(mask)}`);
	}
}

/**
 * Draw the message over the free modules in the standard's zigzag: two-module-wide columns from the bottom-right corner, alternating upward and downward, skipping the vertical timing column.
 * Each free module takes the next message bit inverted where the mask says so; the remainder bits a version leaves over are drawn light.
 */
function drawDataCodewords(codewords: Uint8Array, mask: number, modules: boolean[][], reserved: readonly (readonly boolean[])[]): void {
	const size = modules.length;
	let bit = 0;
	let upward = true;
	for (let column = size - 1; column > 0; column -= 2) {
		// The pair that would straddle the vertical timing pattern at column 6 starts one column to its left instead.
		if (column === 6) column = 5;
		for (let step = 0; step < size; step += 1) {
			const row = upward ? size - 1 - step : step;
			for (const col of [column, column - 1]) {
				if (reserved[row][col]) continue;
				const dark = bit < codewords.length * 8 && ((codewords[bit >> 3] >> (7 - (bit & 7))) & 1) === 1;
				modules[row][col] = dark !== maskInverts(mask, row, col);
				bit += 1;
			}
		}
		upward = !upward;
	}
}

/** Draw both copies of the format information, naming the level and the mask a reader needs to decode the symbol. */
function drawFormatInformation(mask: number, modules: boolean[][]): void {
	const size = modules.length;
	const bits = formatInformation(mask);
	for (let index = 0; index < 15; index += 1) {
		const dark = ((bits >> index) & 1) === 1;
		const [row, col] = FIRST_FORMAT_POSITIONS[index];
		modules[row][col] = dark;
		const [secondRow, secondCol] = secondFormatPosition(index, size);
		modules[secondRow][secondCol] = dark;
	}
	modules[size - 8][8] = true;
}

/** The whole symbol for one mask: function patterns, the data and error-correction codewords, then the format information that tells a reader which mask was used. */
function buildSymbol(version: number, codewords: Uint8Array, mask: number): boolean[][] {
	const { modules, reserved } = functionPatterns(version);
	drawDataCodewords(codewords, mask, modules, reserved);
	drawFormatInformation(mask, modules);
	return modules;
}

/** The grid's rows followed by its columns, the two line families the run and finder-like rules scan. */
function linesOf(modules: readonly (readonly boolean[])[]): boolean[][] {
	const size = modules.length;
	const lines: boolean[][] = [];
	for (let row = 0; row < size; row += 1) lines.push([...modules[row]]);
	for (let col = 0; col < size; col += 1) lines.push(modules.map((row) => row[col]));
	return lines;
}

/** Rule 1: every run of five or more modules of one color in a line costs three points, plus one for each module past the fifth. */
function runPenalty(line: readonly boolean[]): number {
	let penalty = 0;
	let run = 1;
	for (let index = 1; index <= line.length; index += 1) {
		if (index < line.length && line[index] === line[index - 1]) {
			run += 1;
			continue;
		}
		if (run >= 5) penalty += RUN_PENALTY + (run - 5);
		run = 1;
	}
	return penalty;
}

/** Rule 3: every appearance of the finder-like 1:1:3:1:1 shape with four light modules beside it. */
function finderLikePenalty(line: readonly boolean[]): number {
	let count = 0;
	for (let start = 0; start + FINDER_LIKE.length <= line.length; start += 1) {
		let forward = true;
		let backward = true;
		for (let offset = 0; offset < FINDER_LIKE.length; offset += 1) {
			if (line[start + offset] !== FINDER_LIKE[offset]) forward = false;
			if (line[start + offset] !== FINDER_LIKE_REVERSED[offset]) backward = false;
		}
		if (forward || backward) count += 1;
	}
	return count;
}

/** Rule 2: every 2×2 block of one color. */
function blockPenalty(modules: readonly (readonly boolean[])[]): number {
	const size = modules.length;
	let penalty = 0;
	for (let row = 0; row < size - 1; row += 1) {
		for (let col = 0; col < size - 1; col += 1) {
			const first = modules[row][col];
			if (modules[row][col + 1] === first && modules[row + 1][col] === first && modules[row + 1][col + 1] === first) {
				penalty += BLOCK_PENALTY;
			}
		}
	}
	return penalty;
}

/** Rule 4: each five-percent step the dark share sits away from half of the modules. */
function balancePenalty(modules: readonly (readonly boolean[])[]): number {
	const size = modules.length;
	let dark = 0;
	for (const row of modules) {
		for (const module of row) {
			if (module) dark += 1;
		}
	}
	const total = size * size;
	return Math.floor(Math.abs(dark * 100 - 50 * total) / (5 * total)) * BALANCE_PENALTY;
}

/** The four rules' total for one candidate symbol; the mask with the lowest total is the one the standard prescribes. */
function penaltyOf(modules: readonly (readonly boolean[])[]): number {
	let penalty = 0;
	for (const line of linesOf(modules)) {
		penalty += runPenalty(line) + finderLikePenalty(line) * FINDER_LIKE_PENALTY;
	}
	return penalty + blockPenalty(modules) + balancePenalty(modules);
}

/**
 * Fail with this module's `TypeError` unless `options` is a plain object.
 *
 * It runs before any field of `options` is read, so a caller who passes `null`, an array or any other non-object gets this module's prefixed error rather than an engine `TypeError` raised by property access further in.
 */
function requireOptionsObject(options: unknown): void {
	if (typeof options !== "object" || options === null || Array.isArray(options)) {
		throw new TypeError(`qr: options must be an object, got ${preview(options)}`);
	}
}

/**
 * Encode `text` as a QR symbol: a payment URI, or any other text.
 *
 * Byte mode holds any UTF-8 text; a non-string `text` or an `options` that is not an object throws a `TypeError`, and a text that fits no supported version — or not the one the caller pinned — throws a `RangeError`, as does a pinned version outside 1 to 15.
 * The returned matrix is frozen, so one symbol may be handed to several renderers as it stands.
 */
export function encodeQr(text: string, options: QrOptions = {}): QrMatrix {
	if (typeof text !== "string") {
		throw new TypeError(`qr: text must be a string, got ${preview(text)}`);
	}
	requireOptionsObject(options);
	// Every code unit costs at least one UTF-8 byte, so a longer string cannot fit any version: refusing it here keeps an oversized text from being encoded and copied before `chooseVersion` would refuse it anyway.
	if (text.length > QR_MAX_TEXT_BYTES) {
		throw new RangeError(`qr: ${text.length} code units exceed version ${MAX_VERSION}'s ${QR_MAX_TEXT_BYTES} bytes at level M, the largest symbol this encoder builds`);
	}
	const bytes = utf8ToBytes(text);
	const version = chooseVersion(bytes.length, options.version);
	const codewords = interleave(version, encodeDataCodewords(bytes, version));

	let best = buildSymbol(version, codewords, 0);
	let bestPenalty = penaltyOf(best);
	for (let mask = 1; mask < 8; mask += 1) {
		const candidate = buildSymbol(version, codewords, mask);
		const penalty = penaltyOf(candidate);
		if (penalty < bestPenalty) {
			best = candidate;
			bestPenalty = penalty;
		}
	}
	for (const row of best) Object.freeze(row);
	return Object.freeze({ size: best.length, modules: Object.freeze(best) });
}
