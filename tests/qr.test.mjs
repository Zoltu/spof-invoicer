/**
 * The suite for the first-party QR encoder in `app/js/util/qr.js`.
 *
 * The reader lives in `tests/helpers/qr-reader.mjs`, shared so a rendering suite can decode the symbol a page drew and compare the URI it carries with the one the document displays; it re-derives a symbol from the standard's construction rules, but only part of it is independent of the encoder: the alignment centres come from the spacing formula rather than the encoder's table, the format and version fields are checked by polynomial division, the version-information modules are the standard's figure 25 coordinates rather than the encoder's own offsets, and every block's Reed–Solomon syndromes are recomputed in the field.
 * Its mask formulas, its information-field generators and XOR constant, its reserved-module map and its zigzag traversal are mirrors of the encoder's own code, so on their own they only show a symbol agrees with itself.
 * The evidence from outside this repository is hard-coded instead: a version-5 known-answer matrix and the version and mask of each captured symbol, all from `qrcode` 1.5.4, the version-information field of every version from 7 up from ISO/IEC 18004 table D.1 together with the figure 25 modules it is drawn in, and level M's format string for each of the eight masks from table C.1.
 * That closes the two paths one version-5 symbol cannot reach — the BCH(18,6) version field and seven of the eight mask choices — against an outside source rather than against self-consistent code.
 * The reader verifies the finder, timing, alignment and always-dark patterns, both copies of the format and version information, every block's Reed–Solomon syndromes, and the byte payload; the mutation cases at the end prove it reports each of those defects, so a green run means the symbol was decoded rather than merely sized.
 * The version-selection case also pins the capacity contract: a text of exactly the ceiling — 412 bytes at level M — encodes as a version-15 symbol, and one byte more is refused rather than encoded at a size the encoder's tables do not reach.
 * A multi-byte boundary case pins that ceiling in bytes rather than characters, so an encoder measuring text in characters would fail it.
 * A multi-megabyte case pins the other side of the same ceiling: a text that long is refused on its code-unit length before anything encodes it, observed in the message it throws and in the byte buffer it never allocates.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeQr } from "../app/js/util/qr.js";
import { BLOCK_SPECS, MAX_VERSION, MIN_VERSION, QR_MAX_TEXT_BYTES, dataCodewordCount } from "../app/js/util/qr-capacity.js";
import { CAPACITIES, FORMAT_INFORMATION, VERSION_INFORMATION, fieldOf, firstDataModule, flipModule, readFormatField, readSymbol, readVersionInformation, versionInformationCopies } from "./helpers/qr-reader.mjs";

/**
 * A payment-shaped URI that carries ZIP-321's optional `label` as well as its `amount`.
 * Its bytes were the input to `qrcode` 1.5.4, which produced the version-5 known-answer matrix and the version-and-mask capture from them, so it stays label included: re-shaping it to a label-free link would invalidate that capture.
 */
const LABEL_CARRYING_URI_TEXT = "zcash:u1q8pcvpvj2m3lnhqkq6x5f5tjv?amount=1.23456789&label=Studio%20Example";

const TEXT_CASES = [
	"zcash:u1aaa?amount=1",
	"ethereum:0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045@1?value=1500000000000000000",
	"monero:44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A?tx_amount=1.23456789",
	LABEL_CARRYING_URI_TEXT,
	"Süß — naïve 日本",
	"ethereum:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48@1/transfer?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045&uint256=424830000",
	"z".repeat(412),
];

/**
 * One input per mask pattern, with the version and the mask `qrcode` 1.5.4's `create([{ data, mode: "byte" }], { errorCorrectionLevel: "M" })` chose for it: those two readings are what is captured here, not the foreign matrices, which only the version-5 known answer above holds.
 * The standard's four penalty rules decide the mask a symbol is drawn with, so a foreign implementation's choice — one per mask, eight of them — is what makes the encoder's own scoring evidence rather than a mirror of this reader.
 */
const MASK_CASES = [
	{ text: "zcash:u1aaa?amount=1", version: 2, mask: 0 },
	{ text: "monero:44AFFq5k", version: 2, mask: 1 },
	{ text: "Süß — naïve 日本", version: 2, mask: 2 },
	{ text: "zcash:u1abc?amount=1.5", version: 2, mask: 3 },
	{ text: "zcash:zs1abc?amount=0.5", version: 2, mask: 4 },
	{ text: "zcash:t1abc?amount=1.5", version: 2, mask: 5 },
	{ text: LABEL_CARRYING_URI_TEXT, version: 5, mask: 6 },
	{ text: "test invoice", version: 1, mask: 7 },
];

test("the reader decodes every text the encoder is given", () => {
	for (const text of TEXT_CASES) {
		const matrix = encodeQr(text);
		assert.equal(matrix.modules.length, matrix.size, "the grid holds one row per module row");
		assert.ok(matrix.modules.every((row) => row.length === matrix.size), "every row is a full module row");
		const decoded = readSymbol(matrix);
		assert.equal(decoded.text, text, `the payload of the ${text.length}-character text`);
		assert.equal(decoded.version, (matrix.size - 17) / 4);
	}
});

test("the version is the smallest one that holds the text, and the next byte moves up", () => {
	for (const [index, capacity] of CAPACITIES.entries()) {
		const version = index + 1;
		const atCapacity = encodeQr("z".repeat(capacity));
		assert.equal(atCapacity.size, version * 4 + 17, `${capacity} bytes should fill version ${version}`);
		assert.equal(readSymbol(atCapacity).text.length, capacity, `version ${version} at capacity still decodes`);
		const oneMore = "z".repeat(capacity + 1);
		if (version === CAPACITIES.length) {
			// 412 bytes at level M is the ceiling, so the 413th byte is refused rather than pushed into a version this encoder does not build; a text that long in code units can be no shorter in bytes, so the refusal names the code units it counted instead of a byte count nothing has encoded yet.
			assert.throws(() => encodeQr(oneMore), /413 code units exceed version 15's 412 bytes/, `${capacity + 1} bytes should not fit any version`);
		} else {
			assert.equal(encodeQr(oneMore).size, (version + 1) * 4 + 17, `${capacity + 1} bytes should need version ${version + 1}`);
		}
	}
});

/**
 * The ceiling is 412 UTF-8 bytes, not 412 characters, so a multi-byte text reaches it at fewer characters and passes it while its character count is still small.
 * Two-byte characters put the boundary exactly on a character count: 206 of them are the 412 bytes of the ceiling, and 400 of them are 800 bytes at a character count a character-measuring encoder would call free.
 * Both refusals here come from the byte-level capacity check, which the length pre-check in `encodeQr` cannot pre-empt: these texts are shorter than the ceiling in code units, whatever they are in bytes.
 */
test("the ceiling is counted in bytes, so multi-byte text reaches it at fewer characters", () => {
	const atCeiling = "é".repeat(206);
	assert.equal(Buffer.byteLength(atCeiling, "utf8"), 412, "206 two-byte characters are exactly the ceiling");
	const matrix = encodeQr(atCeiling);
	assert.equal(matrix.size, 77, "412 bytes of two-byte characters fill version 15");
	assert.equal(readSymbol(matrix).text, atCeiling, "the multi-byte payload decodes back byte for byte");

	const oneCharacterMore = "é".repeat(207);
	assert.equal(Buffer.byteLength(oneCharacterMore, "utf8"), 414);
	assert.throws(() => encodeQr(oneCharacterMore), /414 bytes exceed version 15 at level M/, "the 207th two-byte character is past the ceiling");

	const shortInCharacters = "é".repeat(400);
	assert.equal(shortInCharacters.length, 400, "the text is 400 characters, well under the ceiling");
	assert.throws(() => encodeQr(shortInCharacters), /800 bytes exceed version 15 at level M/, "800 bytes are refused although the character count is small");
});

/**
 * A text many megabytes past the ceiling is refused by a length pre-check, before any encoder sees it: since a code unit is never fewer than a UTF-8 byte, such a text cannot fit any version, and the pre-check answers that in O(1) where encoding it would first copy the whole input and build its bit stream.
 * The refusal's two observable marks are the message, which can only name a code-unit count, and the byte-buffer total `process.memoryUsage()` reports: encoding this text would add its eight mebibytes of payload there, which the heap figure is too coarse to show.
 */
test("a text many megabytes past the ceiling is refused before it is encoded", () => {
	const huge = "z".repeat(8 * 1024 * 1024);
	const before = process.memoryUsage().arrayBuffers;
	let refusal;
	try {
		encodeQr(huge);
	} catch (error) {
		refusal = error;
	}
	const encoded = process.memoryUsage().arrayBuffers - before;

	assert.ok(refusal instanceof RangeError, `a text of ${huge.length} code units should be refused with a RangeError, got ${refusal === undefined ? "a symbol" : refusal.constructor.name}`);
	assert.match(refusal.message, /^qr: 8388608 code units exceed version 15's 412 bytes at level M, the largest symbol this encoder builds$/);
	assert.equal(encoded, 0, `the refusal allocated ${encoded} bytes of byte buffer, so the input was encoded before it was refused`);
});

test("the capacity contract is frozen, so no stray write can move the ceiling its readers derive from", () => {
	// The byte ceiling is read off this table, and the link layer's budget and the Zcash address bound are read off that ceiling, so a table a write could reach would let the encoder and those bounds disagree with no code having changed.
	assert.equal(BLOCK_SPECS.length, MAX_VERSION - MIN_VERSION + 1, "the table carries one block layout per version the encoder draws");
	assert.ok(Object.isFrozen(BLOCK_SPECS), "the table itself is frozen");
	for (const [index, spec] of BLOCK_SPECS.entries()) {
		assert.ok(Object.isFrozen(spec), `version ${index + 1}'s block layout is frozen`);
	}
	assert.throws(() => {
		BLOCK_SPECS[0].firstDataPerBlock = 1;
	}, TypeError, "a written block figure is refused rather than applied");
	assert.equal(dataCodewordCount(MIN_VERSION), 16, "and the derived table is the one the encoder still reads");
	assert.equal(QR_MAX_TEXT_BYTES, 412, "so the ceiling the budgets are drawn from is unmoved");
});

test("a pinned version is honored, and one that cannot hold the text is refused", () => {
	const pinned = encodeQr(LABEL_CARRYING_URI_TEXT, { version: 10 });
	assert.equal(pinned.size, 57, "version 10 is a 57-module symbol");
	assert.equal(readSymbol(pinned).text, LABEL_CARRYING_URI_TEXT);
	assert.equal(readSymbol(pinned).version, 10);
	assert.throws(() => encodeQr(LABEL_CARRYING_URI_TEXT, { version: 2 }), /74 bytes do not fit version 2 at level M/);
	for (const version of [0, 16, 1.5, "3", Number.NaN]) {
		assert.throws(() => encodeQr(LABEL_CARRYING_URI_TEXT, { version }), /version must be an integer from 1 to 15/, `version ${String(version)}`);
	}
});

test("a non-string is refused rather than coerced", () => {
	assert.throws(() => encodeQr(42), /text must be a string, got 42/);
	assert.throws(() => encodeQr(null), /text must be a string, got null/);
	assert.throws(() => encodeQr({ text: "x", toString: () => "x" }), /text must be a string/);
});

/**
 * The bad-argument slot of each refusal names a caller-supplied value, and `describe` renders one without a bound, so the values here carry a megabyte of `toString` between them.
 * Each message must stay small: an argument of any size costs the same handful of characters, which is what keeps a hostile value out of the notice a user reads.
 */
test("a hostile argument cannot flood the error message that names it", () => {
	const flood = "x".repeat(1024 * 1024);
	const hostile = { toString: () => flood };
	assert.throws(() => encodeQr(hostile), (error) => {
		assert.ok(error instanceof TypeError, `a non-string text raises a TypeError, got ${error.constructor.name}`);
		assert.ok(error.message.length <= 200, `the message for a hostile text is ${error.message.length} characters`);
		return true;
	});
	assert.throws(() => encodeQr("text", flood), (error) => {
		assert.ok(error instanceof TypeError, `a non-object options raises a TypeError, got ${error.constructor.name}`);
		assert.ok(error.message.length <= 200, `the message for hostile options is ${error.message.length} characters`);
		return true;
	});
	assert.throws(() => encodeQr("text", { version: hostile }), (error) => {
		assert.ok(error instanceof RangeError, `a hostile version raises a RangeError, got ${error.constructor.name}`);
		assert.ok(error.message.length <= 200, `the message for a hostile version is ${error.message.length} characters`);
		return true;
	});
});

test("options that are not an object are refused with the module's own error", () => {
	for (const options of [null, 42, "version", true, [], () => {}]) {
		assert.throws(() => encodeQr(LABEL_CARRYING_URI_TEXT, options), (error) => {
			assert.ok(error instanceof TypeError, `options ${String(options)} should raise a TypeError, got ${error.constructor.name}`);
			assert.match(error.message, /^qr: options must be an object, got /, `the message for options ${String(options)}`);
			return true;
		});
	}
	assert.throws(() => encodeQr(LABEL_CARRYING_URI_TEXT, { version: null }), /version must be an integer from 1 to 15, got null/, "a version of the wrong type is a range failure");
	assert.equal(readSymbol(encodeQr(LABEL_CARRYING_URI_TEXT, { version: undefined })).version, 5, "an absent version still selects automatically");
});

test("the same text always encodes to the same matrix", () => {
	assert.deepEqual(encodeQr(LABEL_CARRYING_URI_TEXT).modules, encodeQr(LABEL_CARRYING_URI_TEXT).modules);
	assert.deepEqual(encodeQr("").modules, encodeQr("").modules, "an empty text is a valid symbol too");
	assert.equal(readSymbol(encodeQr("")).text, "");
});

/**
 * A symbol captured from an independent implementation: `qrcode` 1.5.4's `create([{ data, mode: "byte" }], { errorCorrectionLevel: "M" })` produced this matrix for the URI below byte for byte, version 5 and mask 6 included.
 * The reader in this file re-derives it, so the literal pins the whole pipeline — bit placement, block interleaving, Reed–Solomon codewords, both information fields and the mask choice — against a foreign encoder.
 */
test("a fixed known-answer symbol matches module for module", () => {
	const expected = [
		"1111111010101110100111110001001111111",
		"1000001011110110010100001010101000001",
		"1011101010001011000101001101001011101",
		"1011101001011111010001100111101011101",
		"1011101010000011101111100000101011101",
		"1000001000011110000000010100101000001",
		"1111111010101010101010101010101111111",
		"0000000001011111111000111101100000000",
		"1001111110100001000100010011010010111",
		"0111010101111010101000011001100010100",
		"0001111101011001111110111111011110101",
		"1101100100000000110110101000001010100",
		"1100111010000001000000011000011000011",
		"0010000110110001001001110111110010010",
		"1010111011011001001101100111111000101",
		"0101010001101100000110101010100011100",
		"0000101110001010011110110101001100111",
		"1010000011011110000001101111010001110",
		"0111001110110110110101110101010111101",
		"0101010101010101100100000100101100000",
		"0110001011001110010100100001011010000",
		"1011100001101011111100010001010010110",
		"0001001001110011000011011001000110111",
		"0111100111110110001010011011011101110",
		"1101011110110011010110001001101001000",
		"1011010100000110011000011111100111010",
		"1110111010101011010101000001101010111",
		"1000100001001110100000010001101110100",
		"1011011110010011100100101101111110110",
		"0000000011110011010111100001100010010",
		"1111111011010011111101011100101011111",
		"1000001010100011100100110111100010011",
		"1011101010101000101100011011111110001",
		"1011101010011110000100010111011101101",
		"1011101001101100010010110001010111101",
		"1000001001110101010000111000011010111",
		"1111111011101000100100101000101100001",
	];
	const matrix = encodeQr(LABEL_CARRYING_URI_TEXT);
	assert.equal(matrix.size, 37, "the known-answer URI is a version 5 symbol");
	assert.deepEqual(matrix.modules, expected.map((row) => [...row].map((module) => module === "1")));
	const decoded = readSymbol(matrix);
	assert.equal(decoded.text, LABEL_CARRYING_URI_TEXT);
	assert.equal(decoded.version, 5);
	assert.equal(decoded.mask, 6, "the mask is the one the captured symbol carries");
});

/**
 * The version and the mask of every captured symbol, against the implementation the known-answer matrix came from.
 * A symbol carrying any of the eight masks decodes, so matching this table is what shows the mask choice itself — not merely the format field that names it — is right for more than the one mask the version-5 known answer pins.
 */
test("the symbol's version and mask are the ones an independent implementation produces", () => {
	const drawn = new Set();
	for (const { text, version, mask } of MASK_CASES) {
		const decoded = readSymbol(encodeQr(text));
		assert.equal(decoded.version, version, `the version of the ${JSON.stringify(text)} symbol`);
		assert.equal(decoded.mask, mask, `the mask of the ${JSON.stringify(text)} symbol`);
		drawn.add(mask);
	}
	assert.deepEqual([...drawn].sort((left, right) => left - right), [0, 1, 2, 3, 4, 5, 6, 7], "the captures must name every mask pattern");
});

/**
 * ISO/IEC 18004 table C.1's format string for level M and each mask, against what the symbol actually carries in both copies.
 * The captured cases carry all eight masks between them, so this pins the BCH(15,5) field, its XOR mask and its placement around the finder pattern for every mask the encoder can select, not only the mask-6 known answer.
 */
test("the format field is the standard's string for the mask the symbol carries", () => {
	for (const { text, mask } of MASK_CASES) {
		const matrix = encodeQr(text);
		assert.equal(readFormatField(matrix.modules, matrix.size), fieldOf(FORMAT_INFORMATION[mask]), `the format field of the ${JSON.stringify(text)} symbol, drawn with mask ${mask}`);
	}
});

/**
 * ISO/IEC 18004 table D.1's 18-bit version-information field for versions 7 to 15, read at the two 3×6 blocks' figure 25 module positions and checked on each copy.
 * A version-5 symbol draws no version information, so without this the BCH(18,6) field and its two placements would rest on this file's own re-derivation of the encoder's arithmetic.
 */
test("the version information is the standard's field for every version from 7 up", () => {
	for (const [spelling, bits] of Object.entries(VERSION_INFORMATION)) {
		const version = Number(spelling);
		const matrix = encodeQr("z".repeat(CAPACITIES[version - 1]), { version });
		assert.equal(matrix.size, version * 4 + 17, `version ${version} is a ${version * 4 + 17}-module symbol`);
		const field = fieldOf(bits);
		const copies = versionInformationCopies(matrix.modules, matrix.size);
		assert.equal(copies.topRight, field, `the field at the standard's modules beside the top-right finder of version ${version}`);
		assert.equal(copies.bottomLeft, field, `the field at the standard's modules above the bottom-left finder of version ${version}`);
		assert.equal(readVersionInformation(matrix.modules, matrix.size), field, `the version information of version ${version}`);
		assert.equal(readSymbol(matrix).version, version, `the version of the ${version}-module symbol`);
	}
});

test("the reader reports every kind of damage, so a green decode means the symbol was verified", () => {
	const version = 8;
	const matrix = encodeQr("z".repeat(CAPACITIES[version - 1]));

	const cases = [
		[[3, 3], /finder pattern/],
		[[6, 8], /timing pattern/],
		[[24, 24], /alignment pattern/],
		[[matrix.size - 8, 8], /always-dark module/],
		[[0, 38], /version information/],
		[[8, 0], /format field/],
		[firstDataModule(version), /Reed–Solomon syndromes/],
	];
	for (const [[row, col], reason] of cases) {
		assert.throws(() => readSymbol(flipModule(matrix, row, col)), reason, `damage at ${row},${col}`);
	}
});

test("a payload that survives the syndromes is still read back exactly", () => {
	const text = "monero:" + "4".repeat(95) + "?tx_amount=0.000000000001";
	const matrix = encodeQr(text);
	const decoded = readSymbol(matrix);
	assert.equal(decoded.text, text, "the 127-byte payload in version 8's four blocks decodes byte for byte");
	assert.equal(decoded.version, (matrix.size - 17) / 4);
});
