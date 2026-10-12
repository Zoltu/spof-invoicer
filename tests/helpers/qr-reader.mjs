/**
 * The independent QR reader the encoder's suite and the rendering suites share: it re-derives a symbol from the standard's construction rules and decodes the payload back out, so a caller can read the text a symbol actually carries rather than trust the matrix a renderer was handed.
 *
 * Only part of it is independent of the encoder: the alignment centres come from the spacing formula rather than the encoder's table, the format and version fields are checked by polynomial division, the version-information modules are the standard's figure 25 coordinates rather than the encoder's own offsets, and every block's Reed–Solomon syndromes are recomputed in the field.
 * Its mask formulas, its information-field generators and XOR constant, its reserved-module map and its zigzag traversal mirror the encoder's own code, so on their own they only show a symbol agrees with itself.
 * What makes a green decode evidence is the outside material `tests/qr.test.mjs` pins through it: the version-5 known-answer matrix and the version and mask of each captured symbol from `qrcode` 1.5.4, the version-information field of every version from 7 up from ISO/IEC 18004 table D.1, level M's format string for each of the eight masks from table C.1, and the mutation cases that prove the reader reports each defect it checks for.
 */

/** Format information's BCH(15, 5) generator polynomial, x^10 + x^8 + x^5 + x^4 + x^2 + x + 1, the encoder's `FORMAT_GENERATOR`; the unmasked field of every entry in `FORMAT_INFORMATION` below divides by it exactly. */
const FORMAT_GENERATOR = 0b10100110111;

/** Version information's BCH(18, 6) generator polynomial, x^12 + x^11 + x^10 + x^9 + x^8 + x^5 + x^2 + 1, the encoder's `VERSION_GENERATOR`, by which every field in `VERSION_INFORMATION` below divides exactly. */
const VERSION_GENERATOR = 0b1111100100101;

/** The fixed pattern the standard XORs into the fifteen format bits, the encoder's `FORMAT_XOR_MASK`, which is `FORMAT_INFORMATION`'s mask-0 entry: level M's `00` and mask `000` leave the data bits all zero. */
const FORMAT_XOR_MASK = 0b101010000010010;

/** Level M's two-bit code in the format field, the encoder's `LEVEL_M`; the two leading bits of every unmasked field in `FORMAT_INFORMATION` below are `00`. */
const LEVEL_M = 0b00;

/** Byte mode's four-bit mode indicator, the encoder's `BYTE_MODE`. */
const BYTE_MODE = 0b0100;

/** ISO/IEC 18004 table D.1: the 18-bit version-information field of every version that draws one, a literal off the standard's table rather than a value computed here. */
export const VERSION_INFORMATION = {
	7: "000111110010010100",
	8: "001000010110111100",
	9: "001001101010011001",
	10: "001010010011010011",
	11: "001011101111110110",
	12: "001100011101100010",
	13: "001101100001000111",
	14: "001110011000001101",
	15: "001111100100101000",
};

/** ISO/IEC 18004 table C.1: the 15-bit format field of level M, one entry per mask pattern, also a literal off the standard's table. */
export const FORMAT_INFORMATION = [
	"101010000010010",
	"101000100100101",
	"101111001111100",
	"101101101001011",
	"100010111111001",
	"100000011001110",
	"100111110010111",
	"100101010100000",
];

/** Level M's block layout (ISO/IEC 18004, table 9): error-correction codewords per block, then each block's data codewords. */
const BLOCKS = {
	1: [10, 16],
	2: [16, 28],
	3: [26, 44],
	4: [18, 32, 32],
	5: [24, 43, 43],
	6: [16, 27, 27, 27, 27],
	7: [18, 31, 31, 31, 31],
	8: [22, 38, 38, 39, 39],
	9: [22, 36, 36, 36, 37, 37],
	10: [26, 43, 43, 43, 43, 44],
	11: [30, 50, 51, 51, 51, 51],
	12: [22, 36, 36, 36, 36, 36, 36, 37, 37],
	13: [22, 37, 37, 37, 37, 37, 37, 37, 37, 38],
	14: [24, 40, 40, 40, 40, 41, 41, 41, 41, 41],
	15: [24, 41, 41, 41, 41, 41, 42, 42, 42, 42, 42],
};

/**
 * ISO/IEC 18004 figure 25: the module holding bit `index` of the 18-bit version-information field in each of the two 3×6 blocks, transcribed as literal coordinates rather than derived from the encoder's own offsets.
 * Each entry holds the [row, column] of the copy beside the top-right finder — the row counting down from the symbol's top edge, the column a negative offset from its right edge — then the [row, column] of the copy above the bottom-left finder, where the row is a negative offset from the bottom edge and the column counts right from the left edge.
 * Bit 0 is the field's least significant bit.
 */
const VERSION_INFORMATION_POSITIONS = [
	[[0, -11], [-11, 0]],
	[[0, -10], [-10, 0]],
	[[0, -9], [-9, 0]],
	[[1, -11], [-11, 1]],
	[[1, -10], [-10, 1]],
	[[1, -9], [-9, 1]],
	[[2, -11], [-11, 2]],
	[[2, -10], [-10, 2]],
	[[2, -9], [-9, 2]],
	[[3, -11], [-11, 3]],
	[[3, -10], [-10, 3]],
	[[3, -9], [-9, 3]],
	[[4, -11], [-11, 4]],
	[[4, -10], [-10, 4]],
	[[4, -9], [-9, 4]],
	[[5, -11], [-11, 5]],
	[[5, -10], [-10, 5]],
	[[5, -9], [-9, 5]],
];

/**
 * The level-M byte capacity of each version, the length boundary the version-selection cases use.
 * The last entry is the encoder's ceiling and it is fixed: byte mode past it would need the capacity and alignment tables of the versions above 15, so a longer text is refused rather than scaled beyond it.
 */
export const CAPACITIES = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412];

/** GF(256)'s tables for the syndrome check, built here so the reader shares no arithmetic with the encoder. */
const GF = (() => {
	const exp = new Uint8Array(512);
	const log = new Uint8Array(256);
	let value = 1;
	for (let power = 0; power < 255; power += 1) {
		exp[power] = value;
		log[value] = power;
		value = value << 1;
		if (value > 0xff) value ^= 0x11d;
	}
	for (let power = 255; power < 512; power += 1) exp[power] = exp[power - 255];
	return { exp, multiply: (left, right) => (left === 0 || right === 0 ? 0 : exp[log[left] + log[right]]) };
})();

function fail(reason) {
	throw new Error(`qr reader: ${reason}`);
}

function bitLength(value) {
	let length = 0;
	for (let rest = value; rest > 0; rest >>= 1) length += 1;
	return length;
}

/** The integer a bit string of the standard's tables names, most significant bit first. */
export function fieldOf(bits) {
	return Number.parseInt(bits, 2);
}

/** The remainder of `value` divided by the binary polynomial `generator`: zero is exactly the check a valid information field passes. */
function polynomialRemainder(value, generator) {
	const degree = bitLength(generator) - 1;
	let rest = value;
	while (rest !== 0 && bitLength(rest) - 1 >= degree) rest ^= generator << (bitLength(rest) - 1 - degree);
	return rest;
}

/** The alignment-pattern centres a version's spacing rule produces — version 1 has none — derived here from the formula rather than the encoder's table. */
function alignmentCentres(version) {
	if (version === 1) return [];
	const count = Math.floor(version / 7) + 2;
	const size = version * 4 + 17;
	const step = Math.floor((version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2;
	const centres = [];
	for (let index = 0; index < count - 1; index += 1) centres.push(size - 7 - index * step);
	centres.push(6);
	return centres.reverse();
}

/** The module holding bit `index` of the format field, in the copy that runs around the top-left finder (1) or the split copy (2). */
function formatPosition(index, copy, size) {
	if (copy === 1) {
		if (index <= 5) return [index, 8];
		if (index === 6) return [7, 8];
		if (index === 7) return [8, 8];
		if (index === 8) return [8, 7];
		return [8, 14 - index];
	}
	return index < 8 ? [8, size - 1 - index] : [size - 15 + index, 8];
}

/** The module a literal position names on a symbol `size` modules wide: a negative entry counts back from the symbol's edge. */
function atEdge(position, size) {
	return position < 0 ? size + position : position;
}

/** Every module the symbol's patterns and information fields occupy, so the data region can be found without the encoder's map. */
function functionModules(version) {
	const size = version * 4 + 17;
	const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
	const mark = (row, col) => {
		if (row >= 0 && row < size && col >= 0 && col < size) reserved[row][col] = true;
	};
	for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
		for (let row = top - 1; row <= top + 7; row += 1) {
			for (let col = left - 1; col <= left + 7; col += 1) mark(row, col);
		}
	}
	for (let index = 0; index < size; index += 1) {
		mark(6, index);
		mark(index, 6);
	}
	const centres = alignmentCentres(version);
	for (const centreRow of centres) {
		for (const centreCol of centres) {
			if (centreRow === 6 && (centreCol === 6 || centreCol === size - 7)) continue;
			if (centreCol === 6 && centreRow === size - 7) continue;
			for (let row = centreRow - 2; row <= centreRow + 2; row += 1) {
				for (let col = centreCol - 2; col <= centreCol + 2; col += 1) mark(row, col);
			}
		}
	}
	mark(size - 8, 8);
	for (let index = 0; index < 15; index += 1) {
		const [row, col] = formatPosition(index, 1, size);
		const [otherRow, otherCol] = formatPosition(index, 2, size);
		mark(row, col);
		mark(otherRow, otherCol);
	}
	if (version >= 7) {
		for (const [[topRow, topColumn], [leftRow, leftColumn]] of VERSION_INFORMATION_POSITIONS) {
			mark(atEdge(topRow, size), atEdge(topColumn, size));
			mark(atEdge(leftRow, size), atEdge(leftColumn, size));
		}
	}
	return reserved;
}

function checkFinderPatterns(modules, size) {
	for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
		for (let row = 0; row < 7; row += 1) {
			for (let col = 0; col < 7; col += 1) {
				const expected = Math.max(Math.abs(row - 3), Math.abs(col - 3)) !== 2;
				if (modules[top + row][left + col] !== expected) fail(`the finder pattern at ${top},${left} is wrong at ${top + row},${left + col}`);
			}
		}
	}
}

function checkTimingPatterns(modules, size) {
	for (let index = 8; index < size - 8; index += 1) {
		if (modules[6][index] !== (index % 2 === 0)) fail(`the horizontal timing pattern is wrong at column ${index}`);
		if (modules[index][6] !== (index % 2 === 0)) fail(`the vertical timing pattern is wrong at row ${index}`);
	}
}

function checkAlignmentPatterns(modules, version, size) {
	const centres = alignmentCentres(version);
	for (const centreRow of centres) {
		for (const centreCol of centres) {
			if (centreRow === 6 && (centreCol === 6 || centreCol === size - 7)) continue;
			if (centreCol === 6 && centreRow === size - 7) continue;
			for (let row = -2; row <= 2; row += 1) {
				for (let col = -2; col <= 2; col += 1) {
					const expected = Math.max(Math.abs(row), Math.abs(col)) !== 1;
					if (modules[centreRow + row][centreCol + col] !== expected) {
						fail(`the alignment pattern at ${centreRow},${centreCol} is wrong at ${centreRow + row},${centreCol + col}`);
					}
				}
			}
		}
	}
}

/** The 18-bit version-information field of each copy, read at the standard's literal module positions. */
export function versionInformationCopies(modules, size) {
	const copies = { topRight: 0, bottomLeft: 0 };
	VERSION_INFORMATION_POSITIONS.forEach(([[topRow, topColumn], [leftRow, leftColumn]], index) => {
		if (modules[atEdge(topRow, size)][atEdge(topColumn, size)]) copies.topRight |= 1 << index;
		if (modules[atEdge(leftRow, size)][atEdge(leftColumn, size)]) copies.bottomLeft |= 1 << index;
	});
	return copies;
}

/** The 18-bit version-information field the symbol carries, after checking that its two copies agree. */
export function readVersionInformation(modules, size) {
	const { topRight, bottomLeft } = versionInformationCopies(modules, size);
	if (topRight !== bottomLeft) fail("the two copies of the version information disagree");
	return topRight;
}

function checkVersionInformation(modules, version, size) {
	if (version < 7) return;
	const value = readVersionInformation(modules, size);
	if (value >> 12 !== version) fail(`the version information names version ${value >> 12} instead of ${version}`);
	if (polynomialRemainder(value, VERSION_GENERATOR) !== 0) fail("the version information fails its BCH check");
}

/** The 15-bit format field the symbol carries, read from both copies after checking that they agree. */
export function readFormatField(modules, size) {
	let first = 0;
	let second = 0;
	for (let index = 0; index < 15; index += 1) {
		const [row, col] = formatPosition(index, 1, size);
		if (modules[row][col]) first |= 1 << index;
		const [otherRow, otherCol] = formatPosition(index, 2, size);
		if (modules[otherRow][otherCol]) second |= 1 << index;
	}
	if (first !== second) fail("the two copies of the format field disagree");
	return first;
}

/** Validate both format copies and return the mask the symbol was drawn with. */
function checkFormat(modules, size) {
	const field = readFormatField(modules, size) ^ FORMAT_XOR_MASK;
	if (polynomialRemainder(field, FORMAT_GENERATOR) !== 0) fail("the format field fails its BCH check");
	const level = field >> 13;
	if (level !== LEVEL_M) fail(`the format field names level ${level} instead of level M`);
	return (field >> 10) & 7;
}

function maskInverts(mask, row, col) {
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
			return fail(`the format field names mask ${mask}`);
	}
}

/** The message codewords of the data region, unmasked and read back in the standard's zigzag from the bottom-right corner. */
function extractCodewords(modules, reserved, mask) {
	const size = modules.length;
	const codewords = [];
	let bit = 0;
	let value = 0;
	let upward = true;
	for (let column = size - 1; column > 0; column -= 2) {
		if (column === 6) column = 5;
		for (let step = 0; step < size; step += 1) {
			const row = upward ? size - 1 - step : step;
			for (const col of [column, column - 1]) {
				if (reserved[row][col]) continue;
				if (modules[row][col] !== maskInverts(mask, row, col)) value |= 0x80 >> (bit & 7);
				bit += 1;
				if ((bit & 7) === 0) {
					codewords.push(value);
					value = 0;
				}
			}
		}
		upward = !upward;
	}
	return codewords;
}

/** Split the interleaved codewords back into blocks: the data codewords one per block in turn, then the error-correction codewords. */
function deinterleave(codewords, ecPerBlock, lengths) {
	const blocks = lengths.map((length) => new Array(length + ecPerBlock).fill(0));
	let at = 0;
	const longest = Math.max(...lengths);
	for (let index = 0; index < longest; index += 1) {
		for (let block = 0; block < blocks.length; block += 1) {
			if (index < lengths[block]) blocks[block][index] = codewords[at++];
		}
	}
	for (let index = 0; index < ecPerBlock; index += 1) {
		for (let block = 0; block < blocks.length; block += 1) {
			blocks[block][lengths[block] + index] = codewords[at];
			at += 1;
		}
	}
	return blocks;
}

/** Whether every syndrome of one Reed–Solomon block vanishes, which a codeword free of errors satisfies at all its roots. */
function syndromesVanish(block, ecPerBlock) {
	for (let power = 0; power < ecPerBlock; power += 1) {
		let value = 0;
		for (const byte of block) value = GF.multiply(value, GF.exp[power]) ^ byte;
		if (value !== 0) return false;
	}
	return true;
}

function bitsOf(bytes) {
	const bits = [];
	for (const byte of bytes) {
		for (let shift = 7; shift >= 0; shift -= 1) bits.push((byte >> shift) & 1);
	}
	return bits;
}

function numberFrom(bits, start, width) {
	let value = 0;
	for (let index = start; index < start + width; index += 1) value = (value << 1) | bits[index];
	return value;
}

/** Decode a symbol end to end, verifying the structure, both information fields, every block's syndromes, and the payload. */
export function readSymbol(matrix) {
	const { size, modules } = matrix;
	if (modules.length !== size || modules.some((row) => row.length !== size)) fail("the module grid is not square");
	if (size < 21 || size > 77 || (size - 17) % 4 !== 0) fail(`the side length ${size} is not a symbol size`);
	const version = (size - 17) / 4;

	checkFinderPatterns(modules, size);
	checkTimingPatterns(modules, size);
	checkAlignmentPatterns(modules, version, size);
	if (!modules[size - 8][8]) fail("the always-dark module is light");
	checkVersionInformation(modules, version, size);
	const mask = checkFormat(modules, size);

	const reserved = functionModules(version);
	const free = reserved.reduce((count, row) => count + row.filter((module) => !module).length, 0);
	const [ecPerBlock, ...lengths] = BLOCKS[version];
	const total = ecPerBlock * lengths.length + lengths.reduce((sum, length) => sum + length, 0);
	if (Math.floor(free / 8) !== total) fail(`the data region holds ${free} modules where version ${version} at level M needs ${total} codewords`);

	const codewords = extractCodewords(modules, reserved, mask);
	if (codewords.length !== total) fail(`the data region yields ${codewords.length} codewords instead of ${total}`);
	const blocks = deinterleave(codewords, ecPerBlock, lengths);
	blocks.forEach((block, index) => {
		if (!syndromesVanish(block, ecPerBlock)) fail(`block ${index + 1} of ${blocks.length} fails its Reed–Solomon syndromes`);
	});

	const data = blocks.flatMap((block, index) => block.slice(0, lengths[index]));
	const bits = bitsOf(data);
	if (numberFrom(bits, 0, 4) !== BYTE_MODE) fail("the payload does not start with the byte-mode indicator");
	const countBits = version <= 9 ? 8 : 16;
	const count = numberFrom(bits, 4, countBits);
	const payload = Uint8Array.from({ length: count }, (_, index) => numberFrom(bits, 4 + countBits + index * 8, 8));
	let text;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
	} catch {
		fail("the payload is not valid UTF-8");
	}
	return { version, mask, text };
}

/** A copy of `matrix` with one module inverted, for the mutation cases. */
export function flipModule(matrix, row, col) {
	const modules = matrix.modules.map((line) => [...line]);
	modules[row][col] = !modules[row][col];
	return { size: matrix.size, modules };
}

/** The first module the zigzag fills with a codeword bit, the target for a data mutation. */
export function firstDataModule(version) {
	const size = version * 4 + 17;
	const reserved = functionModules(version);
	let upward = true;
	for (let column = size - 1; column > 0; column -= 2) {
		if (column === 6) column = 5;
		for (let step = 0; step < size; step += 1) {
			const row = upward ? size - 1 - step : step;
			for (const col of [column, column - 1]) {
				if (!reserved[row][col]) return [row, col];
			}
		}
		upward = !upward;
	}
	return fail("the symbol has no data region");
}
