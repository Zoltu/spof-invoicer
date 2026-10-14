/** The suite for the invoice model and codec: field validation, canonical encoding, total computation, and the base32 share containers. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { UINT256_MAX } from "../app/js/util/decimal.js";
import { base32nopad, utf8 } from "../app/js/util/encoding.js";
import {
	INVOICE_KIND,
	INVOICE_VERSION,
	MAX_ITEMS,
	InvalidInvoiceError,
	UnsupportedInvoiceVersionError,
	computeTotals,
	computeTotalsFor,
	createInvoice,
	validateInvoice,
} from "../app/js/invoice/model.js";
import {
	MAX_JSON_BYTES,
	MAX_PAYLOAD_CHARS,
	ShareFormatError,
	UnsupportedShareVersionError,
	blobPrefix,
	decodeInvoice,
	decodeInvoiceBlob,
	encodeInvoice,
	encodeInvoiceBlob,
	isShareBlob,
	serializeInvoice,
} from "../app/js/invoice/codec.js";
import { MAX_ICON_SVG_BYTES } from "../app/js/invoice/icon.js";
import { SHARE_FRAGMENT_PREFIX, buildShareUrl, decodeShare, encodeShare } from "../app/js/invoice/share.js";
import { currentRoute, parseHash } from "../app/js/app/router.js";

const PAYEE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const PAYEE_LOWER = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const USDC_CONTRACT = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** A mainnet unified Zcash address, whose canonical spelling is the lower-case one its Bech32m checksum is computed over. */
const UNIFIED = "u1qpatys4zruk99pg59gcscrt7y6akvl9vrhcfyhm9yxvxz7h87q6n8cgrzzpe9zru68uq39uhmlpp5uefxu0su5uqyqfe5zp3tycn0ecl";

function baseInput(overrides = {}) {
	return {
		id: "INV-0001",
		issued: "2026-10-03",
		payee: { name: "Studio Example", address: PAYEE },
		chainId: "0x1",
		asset: "usdc",
		items: [{ description: "Design work", quantity: "2", unitPrice: "150.00" }],
		...overrides,
	};
}

function make(overrides = {}) {
	return createInvoice(baseInput(overrides));
}

function b32(text) {
	return base32nopad.encode(utf8.decode(text));
}

function rejects(label, run, errorType, pattern) {
	assert.throws(
		run,
		(error) => {
			assert.ok(
				error instanceof errorType,
				`${label}: expected ${errorType.name}, got ${error?.name}: ${error?.message}`,
			);
			assert.match(error.message, pattern, label);
			return true;
		},
		label,
	);
}

/** Refuse `run` and return the `InvalidInvoiceError` it raised under the icon path, so a case can read the field and the cause. */
function iconRefusal(label, run) {
	let refusal = null;
	try {
		run();
	} catch (error) {
		refusal = error;
	}
	assert.ok(
		refusal instanceof InvalidInvoiceError,
		`${label}: expected an InvalidInvoiceError, got ${refusal?.name}: ${refusal?.message}`,
	);
	assert.equal(refusal.path, "icon", `${label}: the refusal names the icon field`);
	return refusal;
}

const MINIMAL = make();
const RICH = make({
	id: "INV-2026-0042",
	due: "2026-11-02",
	payee: {
		name: "Büro 例 — Émile",
		address: PAYEE_LOWER,
		email: "billing@example.com",
		notes: "VAT ID DE123456789\nThanks!",
	},
	payer: { name: "Acme GmbH", email: "ap@acme.example" },
	items: [
		{ description: "Consulting — 2026-09", quantity: "1.5", unitPrice: "120.00" },
		{ description: "Rush fee \"priority\"", quantity: "1", unitPrice: "0.000001" },
	],
	tax: { label: "VAT 19%", rate: "19" },
	notes: "Payable within 30 days. 🧾",
});

const GOLDEN_JSON = "{\"v\":1,\"t\":\"invoice\",\"id\":\"INV-0001\",\"issued\":\"2026-10-03\",\"payee\":{\"name\":\"Studio Example\",\"address\":\"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045\"},\"chainId\":\"0x1\",\"asset\":\"usdc\",\"items\":[{\"description\":\"Design work\",\"quantity\":\"2\",\"unitPrice\":\"150\"}]}";

/** A valid icon for the share tests: a 32×32 document the icon gate accepts. */
const ICON = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"32\" height=\"32\" viewBox=\"0 0 32 32\"><circle cx=\"16\" cy=\"16\" r=\"12\" fill=\"#c00\"/></svg>";
/** The same document with a precomposed label, and its NFD spelling, so a payload can carry a spelling validation has to compose. */
const ICON_NFC = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"32\" height=\"32\" data-label=\"caf\u00e9\"><rect width=\"32\" height=\"32\"/></svg>";
const ICON_NFD = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"32\" height=\"32\" data-label=\"cafe\u0301\"><rect width=\"32\" height=\"32\"/></svg>";

test("createInvoice fills the version and kind and canonicalizes the payee address", () => {
	assert.equal(MINIMAL.v, INVOICE_VERSION);
	assert.equal(MINIMAL.t, INVOICE_KIND);
	assert.equal(MINIMAL.asset, "usdc");
	assert.equal(MINIMAL.payee.address, PAYEE, "a uniformly lower-case address is re-encoded");
	assert.ok(Object.isFrozen(MINIMAL), "the invoice is frozen value data");
	assert.ok(Object.isFrozen(MINIMAL.items), "its line items are frozen too");
	assert.deepEqual(validateInvoice(MINIMAL), MINIMAL, "validation is idempotent");
	assert.deepEqual(validateInvoice(JSON.parse(JSON.stringify(MINIMAL))), MINIMAL, "and survives JSON");
});

test("validateInvoice rejects a missing, mistyped, or unknown schema version", () => {
	const { v, t, ...withoutVersion } = baseInput();
	assert.equal(v, undefined);
	assert.equal(t, undefined);
	rejects("missing v", () => validateInvoice(withoutVersion), InvalidInvoiceError, /v: is missing/);
	rejects(
		"a string version",
		() => validateInvoice({ ...baseInput(), v: "1", t: INVOICE_KIND }),
		InvalidInvoiceError,
		/v: must be the number 1/,
	);
	rejects(
		"a future version",
		() => validateInvoice({ ...baseInput(), v: 2, t: INVOICE_KIND }),
		UnsupportedInvoiceVersionError,
		/unsupported schema version 2/,
	);
	rejects(
		"a missing kind",
		() => validateInvoice({ ...baseInput(), v: 1 }),
		InvalidInvoiceError,
		/t: must be "invoice"/,
	);
	rejects(
		"another kind",
		() => validateInvoice({ ...baseInput(), v: 1, t: "receipt" }),
		InvalidInvoiceError,
		/t: must be "invoice", got "receipt"/,
	);
	for (const value of [null, undefined, 42, "invoice", [], true]) {
		rejects(
			`a ${JSON.stringify(value)} payload`,
			() => validateInvoice(value),
			InvalidInvoiceError,
			/must be a JSON object/,
		);
	}
});

test("validateInvoice rejects unknown fields at every level", () => {
	rejects("a root extra", () => make({ extra: 1 }), InvalidInvoiceError, /extra: is not a known field/);
	rejects(
		"a payee extra",
		() => make({ payee: { name: "X", address: PAYEE, phone: "123" } }),
		InvalidInvoiceError,
		/payee\.phone: is not a known field/,
	);
	rejects(
		"a payer extra",
		() => make({ payer: { name: "X", address: PAYEE } }),
		InvalidInvoiceError,
		/payer\.address: is not a known field/,
	);
	rejects(
		"a tax extra",
		() => make({ tax: { label: "VAT", rate: "19", amount: "1" } }),
		InvalidInvoiceError,
		/tax\.amount: is not a known field/,
	);
	rejects(
		"an item extra",
		() => make({ items: [{ description: "d", quantity: "1", unitPrice: "1", asset: "eth" }] }),
		InvalidInvoiceError,
		/items\[0\]\.asset: is not a known field/,
	);
});

test("text fields are bounded, trimmed, and free of control characters", () => {
	rejects("an empty id", () => make({ id: "" }), InvalidInvoiceError, /id: must be 1 to 64 characters/);
	rejects("a padded id", () => make({ id: " INV-1" }), InvalidInvoiceError, /id: must not start or end with whitespace/);
	rejects("a long id", () => make({ id: "x".repeat(65) }), InvalidInvoiceError, /id: must be 1 to 64 characters/);
	rejects(
		"a nul byte in the name",
		() => make({ payee: { name: "A\u0000B", address: PAYEE } }),
		InvalidInvoiceError,
		/payee\.name: must not contain control characters/,
	);
	rejects("a non-string id", () => make({ id: 7 }), InvalidInvoiceError, /id: must be a string, got 7/);
	rejects(
		"a newline in a single-line field",
		() => make({ payee: { name: "A\nB", address: PAYEE } }),
		InvalidInvoiceError,
		/payee\.name: must not contain control characters/,
	);
	rejects(
		"a carriage return in notes",
		() => make({ notes: "line\r\nline" }),
		InvalidInvoiceError,
		/notes: must not contain control characters other than newlines and tabs/,
	);
	rejects(
		"an over-long notes field",
		() => make({ notes: "x".repeat(2001) }),
		InvalidInvoiceError,
		/notes: must be 1 to 2000 characters/,
	);
	assert.equal(
		make({ notes: "line one\n\tline two" }).notes,
		"line one\n\tline two",
		"newlines and tabs are allowed in notes",
	);
});

test("payee and payer identity is validated field by field", () => {
	rejects("a missing payee", () => make({ payee: undefined }), InvalidInvoiceError, /payee: must be a JSON object/);
	rejects(
		"a nameless payee",
		() => make({ payee: { address: PAYEE } }),
		InvalidInvoiceError,
		/payee\.name: must be a string/,
	);
	rejects("an array payee", () => make({ payee: [PAYEE] }), InvalidInvoiceError, /payee: must be a JSON object/);
	rejects(
		"a malformed email",
		() => make({ payee: { name: "X", address: PAYEE, email: "nope@nope" } }),
		InvalidInvoiceError,
		/payee\.email: must be an email address/,
	);
	assert.equal(
		make({ payer: { name: "Acme", email: "ap@acme.example" } }).payer.email,
		"ap@acme.example",
		"a payer email is accepted",
	);
	rejects(
		"a nameless payer",
		() => make({ payer: { email: "ap@acme.example" } }),
		InvalidInvoiceError,
		/payer\.name: must be a string/,
	);
});

test("items are a non-empty, bounded array of described lines", () => {
	rejects("no items", () => make({ items: [] }), InvalidInvoiceError, /items: must hold at least one line item/);
	rejects(
		"too many items",
		() => make({ items: Array.from({ length: MAX_ITEMS + 1 }, () => ({ description: "d", quantity: "1", unitPrice: "1" })) }),
		InvalidInvoiceError,
		/items: must hold at most 200 line items, got 201/,
	);
	rejects("a non-array", () => make({ items: {} }), InvalidInvoiceError, /items: must be an array/);
	rejects(
		"a missing price",
		() => make({ items: [{ description: "d", quantity: "1" }] }),
		InvalidInvoiceError,
		/items\[0\]\.unitPrice: must be a decimal amount string/,
	);
	rejects(
		"an empty description",
		() => make({ items: [{ description: "", quantity: "1", unitPrice: "1" }] }),
		InvalidInvoiceError,
		/items\[0\]\.description: must be 1 to 500 characters/,
	);
});

test("dates must be real calendar dates and the due date must not precede the issue date", () => {
	rejects(
		"a short date",
		() => make({ issued: "2026-10-3" }),
		InvalidInvoiceError,
		/issued: must be a YYYY-MM-DD date string/,
	);
	rejects(
		"a non-string date",
		() => make({ issued: 20261003 }),
		InvalidInvoiceError,
		/issued: must be a YYYY-MM-DD date string/,
	);
	rejects(
		"the 30th of February",
		() => make({ issued: "2026-02-30" }),
		InvalidInvoiceError,
		/is not a real calendar date/,
	);
	rejects(
		"the 29th of February in a common year",
		() => make({ due: "2025-02-29" }),
		InvalidInvoiceError,
		/is not a real calendar date/,
	);
	rejects("month zero", () => make({ due: "2026-00-10" }), InvalidInvoiceError, /is not a real calendar date/);
	rejects("month thirteen", () => make({ due: "2026-13-10" }), InvalidInvoiceError, /is not a real calendar date/);
	rejects(
		"a due date before the issue date",
		() => make({ due: "2026-10-02" }),
		InvalidInvoiceError,
		/due: must not be before the issue date 2026-10-03/,
	);
	assert.equal(
		make({ issued: "2024-02-29", due: "2028-02-29" }).due,
		"2028-02-29",
		"a leap day and a later due date are accepted",
	);
});

test("money inputs reject zero, negative, non-decimal, and over-precision values", () => {
	rejects(
		"a zero quantity",
		() => make({ items: [{ description: "d", quantity: "0", unitPrice: "1" }] }),
		InvalidInvoiceError,
		/items\[0\]\.quantity: .*greater than zero/,
	);
	rejects(
		"a negative price",
		() => make({ items: [{ description: "d", quantity: "1", unitPrice: "-1" }] }),
		InvalidInvoiceError,
		/items\[0\]\.unitPrice: .*is not a plain decimal amount/,
	);
	rejects(
		"an over-precise price",
		() => make({ items: [{ description: "d", quantity: "1", unitPrice: "1.1234567" }] }),
		InvalidInvoiceError,
		/items\[0\]\.unitPrice: .*has 7 decimal places but the asset allows 6/,
	);
	rejects(
		"an over-precise quantity",
		() => make({ items: [{ description: "d", quantity: "1.1234567", unitPrice: "1" }] }),
		InvalidInvoiceError,
		/items\[0\]\.quantity: .*has 7 decimal places but the asset allows 6/,
	);
	rejects(
		"a numeric quantity",
		() => make({ items: [{ description: "d", quantity: 2, unitPrice: "1" }] }),
		InvalidInvoiceError,
		/items\[0\]\.quantity: must be a decimal amount string like "1\.5", got 2/,
	);
	rejects(
		"an exponent",
		() => make({ items: [{ description: "d", quantity: "1e3", unitPrice: "1" }] }),
		InvalidInvoiceError,
		/items\[0\]\.quantity: .*is not a plain decimal amount/,
	);
	rejects(
		"a zero tax rate",
		() => make({ tax: { label: "VAT", rate: "0" } }),
		InvalidInvoiceError,
		/tax\.rate: .*greater than zero/,
	);
	rejects(
		"a tax over 100%",
		() => make({ tax: { label: "VAT", rate: "150" } }),
		InvalidInvoiceError,
		/tax\.rate: must be a percentage of at most 100, got "150"/,
	);
	rejects(
		"an over-precise tax rate",
		() => make({ tax: { label: "VAT", rate: "8.2500000" } }),
		InvalidInvoiceError,
		/tax\.rate: .*has 7 decimal places but the tax rate allows 6/,
	);
	rejects("a nameless tax", () => make({ tax: { rate: "8" } }), InvalidInvoiceError, /tax\.label: must be a string/);
});

test("the payee address must be an address, EIP-55 consistent, and payable", () => {
	rejects(
		"a mistyped checksum",
		() => make({ payee: { name: "X", address: `${PAYEE.slice(0, -1)}6` } }),
		InvalidInvoiceError,
		/payee\.address: .*has an invalid EIP-55 checksum/,
	);
	rejects(
		"a short address",
		() => make({ payee: { name: "X", address: "0x1234" } }),
		InvalidInvoiceError,
		/payee\.address: address: expected a 0x-prefixed 40-hex address/,
	);
	rejects(
		"a non-string address",
		() => make({ payee: { name: "X", address: 42 } }),
		InvalidInvoiceError,
		/payee\.address: must be a 0x-prefixed 40-hex payout address, got 42/,
	);
	rejects(
		"the zero address",
		() => make({ payee: { name: "X", address: ZERO_ADDRESS } }),
		InvalidInvoiceError,
		/payee\.address: .*cannot receive a transfer/,
	);
	rejects(
		"the token's own contract",
		() => make({ payee: { name: "X", address: USDC_CONTRACT } }),
		InvalidInvoiceError,
		/payee\.address: .*it is the token's own contract address/,
	);
});

test("the asset must be supported and the chain must match it", () => {
	rejects(
		"an unknown asset",
		() => make({ asset: "dai" }),
		InvalidInvoiceError,
		/asset: must be a supported asset id \(eth, usdc, usdt, zec, xmr\), got "dai"/,
	);
	rejects("a non-string asset", () => make({ asset: 42 }), InvalidInvoiceError, /asset: must be a supported asset id/);
	rejects(
		"an inherited property",
		() => make({ asset: "constructor" }),
		InvalidInvoiceError,
		/asset: must be a supported asset id/,
	);
	rejects(
		"an unsupported chain",
		() => make({ chainId: "0x89" }),
		InvalidInvoiceError,
		/chainId: must be one of the supported chains \(0x1, zcash, monero\), got "0x89"/,
	);
	rejects(
		"a numeric chain id",
		() => make({ chainId: 1 }),
		InvalidInvoiceError,
		/chainId: must be one of the supported chains/,
	);
	assert.equal(make({ asset: "eth", chainId: "0x1" }).asset, "eth", "a native asset on its own chain is accepted");
});

test("a privacy-chain invoice carries its own network slug and payout form through the share container", () => {
	// The wire format is unchanged: the network still travels under `chainId`, now holding the slug the entry states, and the payee address is the mainnet unified container the Zcash branch accepts.
	const UNIFIED = "u1qpatys4zruk99pg59gcscrt7y6akvl9vrhcfyhm9yxvxz7h87q6n8cgrzzpe9zru68uq39uhmlpp5uefxu0su5uqyqfe5zp3tycn0ecl";
	const MONERO = "46BeWrHpwXmHDpDEUmZBWZfoQpdc6HaERCNmx1pEYL2rAcuwufPN9rXHHtyUA4QVy66qeFQkn6sfK8aHYjA3jk3o1Bv16em";
	const zec = make({ asset: "zec", chainId: "zcash", payee: { name: "Studio Example", address: UNIFIED } });
	assert.equal(zec.chainId, "zcash");
	assert.equal(zec.payee.address, UNIFIED, "the validated address is stored as the family that read it returned it");
	assert.deepEqual(decodeInvoice(encodeInvoice(zec)), zec, "and the invoice survives the share container");

	const xmr = make({ asset: "xmr", chainId: "monero", payee: { name: "Studio Example", address: MONERO } });
	assert.equal(xmr.chainId, "monero");
	assert.deepEqual(decodeInvoice(encodeInvoice(xmr)), xmr);

	// The asset and the chain must still agree, and the payee address must belong to the asset's family.
	rejects(
		"a Zcash asset on the Ethereum chain",
		() => make({ asset: "zec", chainId: "0x1" }),
		InvalidInvoiceError,
		/chainId: must be "zcash" to match the zec asset, got "0x1"/,
	);
	rejects(
		"an EVM payee in a Zcash invoice",
		() => make({ asset: "zec", chainId: "zcash" }),
		InvalidInvoiceError,
		/payee\.address: zcash-address: not a Zcash payout address — expected a mainnet transparent t1\/t3, Sapling zs1, or unified u1 address/,
	);
	rejects(
		"a testnet unified payee in a mainnet Zcash invoice",
		() => make({ asset: "zec", chainId: "zcash", payee: { name: "X", address: "utest10c5kutapazdnf8ztl3pu43nkfsjx89fy3uuff8tsmxm6s86j37pe7uz94z5jhkl49pqe8yz75rlsaygexk6jpaxwx0esjr8wm5ut7d5s" } }),
		InvalidInvoiceError,
		/payee\.address: zcash-address: a testnet unified address cannot be paid from a mainnet-only invoice/,
	);
});

test("totals are computed in base units with half-up rounding", () => {
	const tie = computeTotals(make({ items: [{ description: "d", quantity: "1.5", unitPrice: "0.000001" }] }));
	assert.deepEqual(tie.lines[0].amount, { units: 2n, text: "0.000002" }, "an exact half rounds up");
	assert.deepEqual(tie.subtotal, { units: 2n, text: "0.000002" });
	assert.deepEqual(tie.tax, { units: 0n, text: "0" }, "no tax line means a zero tax amount");
	assert.deepEqual(tie.total, { units: 2n, text: "0.000002" });

	const down = computeTotals(make({ items: [{ description: "d", quantity: "1.499999", unitPrice: "0.000001" }] }));
	assert.equal(down.lines[0].amount.text, "0.000001", "just under a half rounds down");

	const multi = computeTotals(
		make({
			items: [
				{ description: "Consulting", quantity: "3", unitPrice: "10.00" },
				{ description: "Rush", quantity: "1", unitPrice: "0.000001" },
			],
			tax: { label: "VAT", rate: "8.25" },
		}),
	);
	assert.deepEqual(multi.lines.map((line) => line.amount.text), ["30", "0.000001"]);
	assert.deepEqual(multi.subtotal, { units: 30000001n, text: "30.000001" });
	assert.deepEqual(multi.tax, { units: 2475000n, text: "2.475" });
	assert.deepEqual(multi.total, { units: 32475001n, text: "32.475001" });
	assert.equal(multi.asset.id, "usdc");

	const taxTie = computeTotals(
		make({
			items: [{ description: "d", quantity: "1", unitPrice: "0.000001" }],
			tax: { label: "Half", rate: "50" },
		}),
	);
	assert.deepEqual(taxTie.tax, { units: 1n, text: "0.000001" }, "a tax of exactly half a base unit rounds up");
	assert.deepEqual(taxTie.total, { units: 2n, text: "0.000002" });

	const eighteen = computeTotals(make({ asset: "eth", items: [{ description: "Hour", quantity: "1.5", unitPrice: "1" }] }));
	assert.equal(eighteen.total.text, "1.5", "an 18-decimal asset keeps full precision");

	rejects(
		"a line that rounds to zero",
		() => make({ items: [{ description: "d", quantity: "0.499999", unitPrice: "0.000001" }] }),
		InvalidInvoiceError,
		/items\[0\]: amounts to zero at 6 decimal places/,
	);
	rejects(
		"a total beyond uint256",
		() => make({ items: [{ description: "d", quantity: `1${"0".repeat(70)}`, unitPrice: "100" }] }),
		InvalidInvoiceError,
		/exceeds the uint256 transfer maximum/,
	);

	const huge = computeTotals(make({ items: [{ description: "d", quantity: `1${"0".repeat(70)}`, unitPrice: "1" }] }));
	assert.equal(huge.total.units, 10n ** 76n, "a quantity near the uint256 ceiling totals exactly");
	assert.equal(huge.total.text, `1${"0".repeat(70)}`, "and renders as a plain decimal string");
	assert.ok(huge.total.units <= UINT256_MAX, "and stays inside the uint256 transfer range");
});

test("computeTotalsFor derives totals from asset, items, and tax alone", () => {
	const totals = computeTotalsFor({
		asset: "usdc",
		items: [{ description: "Design work", quantity: "2", unitPrice: "150" }],
	});
	assert.equal(totals.asset.id, "usdc");
	assert.deepEqual(totals.subtotal, { units: 300000000n, text: "300" });
	assert.deepEqual(totals.tax, { units: 0n, text: "0" });
	assert.deepEqual(totals.total, { units: 300000000n, text: "300" });
	const taxed = computeTotalsFor({
		asset: "usdc",
		items: [{ description: "Design work", quantity: "2", unitPrice: "150" }],
		tax: { label: "VAT", rate: "19" },
	});
	assert.deepEqual(taxed.total, { units: 357000000n, text: "357" });
	assert.throws(() => computeTotalsFor({ asset: "usdc", items: [] }), InvalidInvoiceError);
});

test("encodeInvoice writes the canonical JSON form", () => {
	assert.equal(serializeInvoice(MINIMAL), GOLDEN_JSON);
	assert.equal(encodeInvoice(MINIMAL), b32(GOLDEN_JSON), "the payload is unpadded base32 of the canonical JSON");
	assert.ok(/^[A-Z2-7]+$/.test(encodeInvoice(MINIMAL)), "the payload uses the RFC 4648 base32 upper-case alphabet");
	assert.ok(encodeInvoice(RICH).length > encodeInvoice(MINIMAL).length, "a richer invoice encodes to a longer payload");
});

test("encode then decode is the identity for representative invoices", () => {
	for (const [label, invoice] of [
		["minimal", MINIMAL],
		["every optional field, unicode, mixed casing", RICH],
	]) {
		const blob = encodeInvoiceBlob(invoice);
		assert.deepEqual(decodeShare(blob), invoice, `${label} through a base32 blob`);
		assert.deepEqual(decodeInvoiceBlob(blob), invoice, `${label} through decodeInvoiceBlob`);
		const payload = encodeInvoice(invoice);
		assert.deepEqual(decodeInvoice(payload), invoice, `${label} through the fragment payload`);
		assert.deepEqual(decodeShare(SHARE_FRAGMENT_PREFIX + payload), invoice, `${label} through a full fragment`);
		assert.deepEqual(decodeShare(payload), invoice, `${label} through a bare payload`);
		assert.equal(encodeInvoice(decodeInvoice(payload)), payload, `${label} re-encodes byte for byte`);
	}
});

test("the base32 URL and blob containers round-trip through their own decoders", () => {
	const payload = encodeInvoice(RICH);
	assert.equal(payload, base32nopad.encode(utf8.decode(serializeInvoice(RICH))));
	assert.deepEqual(decodeInvoice(payload), RICH, "the base32 URL payload decodes back");
	assert.deepEqual(decodeShare(`${SHARE_FRAGMENT_PREFIX}${payload}`), RICH, "and through the full fragment");
	const blob = encodeInvoiceBlob(RICH);
	assert.equal(blob, `pinv1b-${payload}`);
	assert.deepEqual(decodeInvoiceBlob(blob), RICH, "the base32 blob decodes back");
	assert.deepEqual(decodeShare(blob), RICH, "and through the share reader");
});

test("the container is self-describing and always begins with the base32 prefix", () => {
	const payload = encodeInvoice(MINIMAL);
	const blob = encodeInvoiceBlob(MINIMAL);
	assert.ok(blob.startsWith("pinv1b-"));
	assert.equal(blob, `pinv1b-${payload}`);
	assert.ok(blob.length > payload.length && blob.length < payload.length * 1.3, "base32 is the bulkier alphabet");
	assert.deepEqual(decodeShare(blob), MINIMAL);
	assert.equal(SHARE_FRAGMENT_PREFIX, "#/i/");
	assert.equal(encodeShare(MINIMAL), SHARE_FRAGMENT_PREFIX + payload, "the fragment is the prefix plus the payload");
});

test("unknown versions are rejected in both the container and the payload", () => {
	rejects(
		"a future blob version",
		() => decodeInvoiceBlob(`pinv2-${encodeInvoice(MINIMAL)}`),
		UnsupportedShareVersionError,
		/unsupported blob version 2/,
	);
	rejects(
		"a future base32 blob version",
		() => decodeInvoiceBlob(`pinv9b-${encodeInvoice(MINIMAL)}`),
		UnsupportedShareVersionError,
		/unsupported blob version 9/,
	);
	rejects(
		"a future schema version",
		() => decodeInvoice(b32("{\"v\":2,\"t\":\"invoice\"}")),
		UnsupportedInvoiceVersionError,
		/unsupported schema version 2/,
	);
	rejects(
		"a zero blob version",
		() => decodeInvoiceBlob(`pinv0-${encodeInvoice(MINIMAL)}`),
		UnsupportedShareVersionError,
		/unsupported blob version 0/,
	);
});

test("a legacy base64url blob is recognised, refused by name, and never decoded", () => {
	const legacy = "pinv1-" + Buffer.from(GOLDEN_JSON, "utf8").toString("base64url");
	assert.ok(isShareBlob(legacy), "the loose prefix pattern still routes it to the blob decoder");
	rejects("the bare blob decoder", () => decodeInvoiceBlob(legacy), ShareFormatError, /retired base64url/);
	rejects("the share reader", () => decodeShare(legacy), ShareFormatError, /retired base64url/);
	assert.throws(() => decodeInvoiceBlob("pinv1-AAAA"), ShareFormatError, "any pinv1- blob is refused, not decoded");
	rejects("a legacy blob with no payload", () => decodeInvoiceBlob("pinv1-"), ShareFormatError, /retired base64url/);
});

test("the blob builder and the blob parser agree on which versions exist", () => {
	assert.equal(blobPrefix(), "pinv1b-");
	rejects(
		"a version the builder must not emit",
		() => blobPrefix(2),
		UnsupportedShareVersionError,
		/unsupported blob version 2/,
	);
	rejects(
		"a blob version past any digit bound",
		() => decodeInvoiceBlob(`pinv12345-${encodeInvoice(MINIMAL)}`),
		UnsupportedShareVersionError,
		/unsupported blob version 12345/,
	);
});

test("malformed, truncated, and hostile containers are refused", () => {
	const payload = encodeInvoice(MINIMAL);
	rejects("an empty payload", () => decodeInvoice(""), ShareFormatError, /the base32 payload is empty/);
	rejects("an empty blob", () => decodeInvoiceBlob("pinv1b-"), ShareFormatError, /the base32 payload is empty/);
	rejects("bad base32 letters", () => decodeInvoice("!!!!"), ShareFormatError, /the base32 payload is malformed/);
	rejects("base32 padding", () => decodeInvoice("AAAA===="), ShareFormatError, /the base32 payload is malformed/);
	rejects(
		"a missing prefix",
		() => decodeInvoiceBlob(payload),
		ShareFormatError,
		/expected a share blob starting with "pinv1b-"/,
	);
	assert.equal(decodeShare("#/x/abc"), null, "a fragment on another route is not a share");
	rejects(
		"a truncated payload",
		() => decodeInvoice(payload.slice(0, Math.floor(payload.length / 2))),
		ShareFormatError,
		/malformed|not JSON|not well-formed UTF-8/,
	);
	rejects(
		"a payload three characters long",
		() => decodeInvoice("AAA"),
		ShareFormatError,
		/malformed|not well-formed UTF-8|not JSON/,
	);
	rejects(
		"a payload that is not UTF-8",
		() => decodeInvoice(base32nopad.encode(Buffer.concat([Buffer.from("{\"v\":1,\"t\":\"inv"), Buffer.from([0xff])]))),
		ShareFormatError,
		/not well-formed UTF-8/,
	);
	rejects("a non-string payload", () => decodeInvoice(42), ShareFormatError, /expected a payload string, got 42/);
	rejects("a non-string blob", () => decodeInvoiceBlob(null), ShareFormatError, /expected a share blob/);
	rejects("a non-string share", () => decodeShare({}), ShareFormatError, /expected a share string/);
	rejects(
		"a lower-case base32 blob",
		() => decodeInvoiceBlob(`pinv1b-${encodeInvoice(MINIMAL).toLowerCase()}`),
		ShareFormatError,
		/the base32 payload is malformed/,
	);
	rejects(
		"padded base32",
		() => decodeInvoiceBlob("pinv1b-AAAA===="),
		ShareFormatError,
		/the base32 payload is malformed/,
	);

	const oversized = "A".repeat(MAX_PAYLOAD_CHARS + 1);
	let tooLong = null;
	try {
		decodeInvoice(oversized);
	} catch (error) {
		tooLong = error;
	}
	assert.ok(tooLong instanceof ShareFormatError, "an oversized payload must be refused");
	assert.match(tooLong.message, /the limit is 131072/);
	assert.ok(tooLong.message.length < 300, `the refusal stays readable, got ${tooLong.message.length} characters`);
});

test("a payload that is not canonical JSON is refused", () => {
	const json = serializeInvoice(MINIMAL);
	const payloadOf = (text) => decodeInvoice(b32(text));

	rejects(
		"a repeated key",
		() => payloadOf(json.replace("\"asset\":\"usdc\"", "\"asset\":\"usdc\",\"asset\":\"usdc\"")),
		ShareFormatError,
		/not in the canonical form/,
	);
	rejects(
		"reordered keys",
		() => payloadOf(json.replace("\"chainId\":\"0x1\",\"asset\":\"usdc\"", "\"asset\":\"usdc\",\"chainId\":\"0x1\"")),
		ShareFormatError,
		/not in the canonical form/,
	);
	rejects(
		"pretty printing",
		() => payloadOf(JSON.stringify(JSON.parse(json), null, 2)),
		ShareFormatError,
		/not in the canonical form/,
	);
	rejects(
		"an escaped letter",
		() => payloadOf(json.replace("Design", "\\u0044esign")),
		ShareFormatError,
		/not in the canonical form/,
	);
	rejects(
		"an extra field",
		() => payloadOf(json.replace("{\"v\":1", "{\"extra\":1,\"v\":1")),
		InvalidInvoiceError,
		/extra: is not a known field/,
	);
	rejects("a non-object payload", () => payloadOf("[]"), InvalidInvoiceError, /must be a JSON object/);
});

test("a payload that spells a payee address in the other case names that cause", () => {
	const json = serializeInvoice(MINIMAL);
	rejects(
		"a uniformly-cased EVM payee address",
		() => decodeInvoice(b32(json.replace(PAYEE, PAYEE_LOWER))),
		ShareFormatError,
		/but its canonical spelling is 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045/,
	);
	// A Zcash payee's canonical spelling is the lower-case Bech32 one rather than an EIP-55 checksum, and the message names that canonical spelling.
	const zcash = make({ payee: { name: "Studio Example", address: UNIFIED }, chainId: "zcash", asset: "zec" });
	const zcashJson = serializeInvoice(zcash);
	rejects(
		"an upper-case Zcash payee address",
		() => decodeInvoice(b32(zcashJson.replace(UNIFIED, UNIFIED.toUpperCase()))),
		ShareFormatError,
		new RegExp(`but its canonical spelling is ${UNIFIED}`),
	);
	// A divergence that is the JSON spelling itself keeps the generic message.
	rejects(
		"reordered keys",
		() => decodeInvoice(b32(json.replace("\"chainId\":\"0x1\",\"asset\":\"usdc\"", "\"asset\":\"usdc\",\"chainId\":\"0x1\""))),
		ShareFormatError,
		/not in the canonical form/,
	);
});

test("text is normalized to NFC, so an NFD spelling is not canonical", () => {
	const nfd = "Bu\u0308ro";
	const nfc = "B\u00fcro";
	assert.notEqual(nfd, nfc);
	const fromNfd = make({ payee: { name: nfd, address: PAYEE } });
	assert.equal(fromNfd.payee.name, nfc, "validation composes the text");
	assert.equal(
		encodeInvoice(fromNfd),
		encodeInvoice(make({ payee: { name: nfc, address: PAYEE } })),
		"both spellings share one share string",
	);
	const nfdJson = serializeInvoice(make({ payee: { name: nfc, address: PAYEE } })).replace(nfc, nfd);
	rejects("an NFD payload", () => decodeInvoice(b32(nfdJson)), ShareFormatError, /not in the canonical form/);
});

test("an optional icon round-trips through the share containers", () => {
	const invoice = make({ icon: ICON, notes: "Thanks!" });
	assert.equal(invoice.icon, ICON, "the validated text is stored as it was read");
	assert.ok(Object.isFrozen(invoice), "an invoice carrying an icon is frozen like any other");
	assert.match(serializeInvoice(invoice), /"notes":"Thanks!","icon":"<svg/, "the icon is written last, after notes");
	for (const [label, container] of [
		["the fragment payload", encodeInvoice(invoice)],
		["the base32 blob", encodeInvoiceBlob(invoice)],
		["the full fragment", `${SHARE_FRAGMENT_PREFIX}${encodeInvoice(invoice)}`],
	]) {
		assert.deepEqual(decodeShare(container), invoice, label);
	}
	assert.deepEqual(decodeInvoiceBlob(encodeInvoiceBlob(invoice)), invoice, "the blob decoder returns the same invoice");
	assert.equal(
		encodeInvoice(decodeInvoice(encodeInvoice(invoice))),
		encodeInvoice(invoice),
		"and the payload re-encodes byte for byte",
	);
});

test("an icon-less invoice keeps the payload it had before the field existed", () => {
	assert.equal(serializeInvoice(MINIMAL), GOLDEN_JSON);
	assert.equal(serializeInvoice(MINIMAL).includes('"icon"'), false, "an absent icon is not written");
	assert.equal(serializeInvoice(RICH).includes('"icon"'), false, "and a richer icon-less invoice writes none either");
	assert.equal(decodeInvoice(encodeInvoice(MINIMAL)).icon, undefined, "a decoded invoice carries no icon key");
});

test("an icon is validated as it is read, under the icon path", () => {
	const overCap = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">${"x".repeat(MAX_ICON_SVG_BYTES)}</svg>`;
	// Every case pins the whole message the refusal carries, so the byte-cap refusal and the empty-icon clause are asserted as themselves rather than as "some error": the gate words the reason and the model states it under the icon path, with the `invoice:` namespace applied once.
	const cases = [
		["an over-cap icon", overCap, "InvalidIconError", `The icon is ${Buffer.byteLength(overCap, "utf8")} bytes, over the ${MAX_ICON_SVG_BYTES}-byte limit.`],
		["an empty icon", "", "InvalidIconError", "must not be empty"],
		["a script-bearing icon", "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"32\" height=\"32\"><script>alert(1)</script></svg>", "InvalidIconError", "must not contain a <script> element"],
		["an icon with trailing whitespace", `${ICON} `, "InvalidIconError", "must not start or end with whitespace"],
		["a null icon", null, "TypeError", "expected an SVG string, got null"],
		["a numeric icon", 42, "TypeError", "expected an SVG string, got 42"],
	];
	for (const [label, value, cause, reason] of cases) {
		const refusal = iconRefusal(label, () => make({ icon: value }));
		assert.equal(refusal.cause?.name, cause, `${label}: the gate's own error travels as the cause`);
		assert.equal(refusal.message, `invoice: icon: ${reason}`, label);
	}
	assert.equal(make({ icon: ICON }).icon, ICON, "a well-formed icon is accepted");
});

test("the notice a payer sees for a shared link whose icon is refused carries the namespace once", () => {
	// The route notice is the message the model raised, verbatim, so this pins the wording a payer reads end to end: one field path and one reason, never `invoice: icon: invoice: …`.
	const overCap = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">${"x".repeat(MAX_ICON_SVG_BYTES)}</svg>`;
	const json = serializeInvoice(MINIMAL).replace('{"v":1', `{"icon":${JSON.stringify(overCap)},"v":1`);
	const route = parseHash(`#/i/${b32(json)}`);
	assert.equal(route.kind, "error", "the payload carrying the refused icon is refused rather than rendered");
	assert.equal(
		route.message,
		`invoice: icon: The icon is ${Buffer.byteLength(overCap, "utf8")} bytes, over the ${MAX_ICON_SVG_BYTES}-byte limit.`,
		"the payer reads the field path once and the gate's reason once",
	);
});

test("a payload whose icon is not the canonical text is refused", () => {
	const encoded = JSON.stringify(ICON_NFC);
	const json = serializeInvoice(make({ icon: ICON_NFC }));
	assert.ok(json.includes(encoded), "the fixture carries the icon as the encoder wrote it");
	assert.equal(make({ icon: ICON_NFD }).icon, ICON_NFC, "validation composes an NFD icon to NFC");

	rejects(
		"an NFD icon",
		() => decodeInvoice(b32(json.replace(encoded, JSON.stringify(ICON_NFD)))),
		ShareFormatError,
		/not in the canonical form/,
	);
	rejects(
		"an icon with trailing whitespace",
		() => decodeInvoice(b32(json.replace(encoded, JSON.stringify(`${ICON_NFC} `)))),
		InvalidInvoiceError,
		/icon: /,
	);

	const withNotes = serializeInvoice(make({ icon: ICON_NFC, notes: "note" }));
	const reordered = withNotes.replace(`"notes":"note","icon":${encoded}`, `"icon":${encoded},"notes":"note"`);
	assert.notEqual(reordered, withNotes, "the fixture really writes the icon before notes");
	rejects(
		"an icon written before notes",
		() => decodeInvoice(b32(reordered)),
		ShareFormatError,
		/not in the canonical form/,
	);

	const nullIcon = serializeInvoice(MINIMAL).replace('{"v":1', '{"icon":null,"v":1');
	const refusal = iconRefusal("a null icon in a payload", () => decodeInvoice(b32(nullIcon)));
	assert.match(refusal.message, /expected an SVG string/);
});

test("compact invoices fit the share string and oversized ones are refused", () => {
	const many = (count, descriptionLength) => ({
		items: Array.from({ length: count }, (_, index) => ({
			description: `${index}`.padEnd(descriptionLength, "x"),
			quantity: "1",
			unitPrice: "1.00",
		})),
	});

	const large = make(many(60, 500));
	assert.deepEqual(decodeInvoice(encodeInvoice(large)), large, "a 60-line invoice survives the round trip");
	assert.deepEqual(decodeShare(encodeInvoiceBlob(large)), large, "and survives the base32 blob");

	rejects(
		"an invoice past the share limit",
		() => encodeInvoice(make(many(MAX_ITEMS, 500))),
		ShareFormatError,
		/the share limit is 65536/,
	);
});

test("buildShareUrl keeps the payload in the fragment", () => {
	const url = buildShareUrl(MINIMAL, "https://example.com/app/index.html");
	assert.ok(url.startsWith("https://example.com/app/index.html#/i/"), url);
	assert.ok(url.includes(encodeInvoice(MINIMAL)), "the payload travels in the fragment, verbatim and unescaped");
	assert.equal(url.slice(url.indexOf("#")), `${SHARE_FRAGMENT_PREFIX}${encodeInvoice(MINIMAL)}`);
	assert.equal(
		buildShareUrl(MINIMAL, "https://example.com/app/index.html#/i/old"),
		url,
		"an existing fragment is replaced",
	);
	assert.equal(
		buildShareUrl(MINIMAL, "#/i/old"),
		`${SHARE_FRAGMENT_PREFIX}${encodeInvoice(MINIMAL)}`,
		"a bare fragment base stays a bare fragment",
	);
	assert.throws(() => buildShareUrl(MINIMAL, 42), TypeError);
});

test("parseHash reports the create route for the empty hash", () => {
	for (const hash of ["", "#", "#/", "#/create", "   "]) {
		assert.deepEqual(parseHash(hash), { kind: "create" }, `hash ${JSON.stringify(hash)}`);
	}
});

test("parseHash turns a shared link into the invoice it carries", () => {
	const url = buildShareUrl(RICH, "https://example.com/app/");
	const route = parseHash(new URL(url).hash);
	assert.equal(route.kind, "view");
	assert.deepEqual(route.invoice, RICH, "the payer sees exactly the payee's invoice");
	assert.deepEqual(parseHash(`${SHARE_FRAGMENT_PREFIX}${encodeInvoice(MINIMAL)}`), { kind: "view", invoice: MINIMAL });
	assert.deepEqual(currentRoute(), { kind: "create" }, "with no location there is no invoice to show");
});

test("parseHash never throws, whatever the hash holds", () => {
	const payload = encodeInvoice(MINIMAL);
	const errorRoutes = [
		42,
		null,
		undefined,
		{},
		[],
		"x",
		"#/i",
		"#/i/",
		"#/i/!!!",
		"#/i/not-a-payload",
		"#/invoice/abc",
		"#/nope/x",
		`#/i/${payload.slice(0, -4)}`,
		`#/i/${b32("{\"v\":9,\"t\":\"invoice\"}")}`,
		`#/i/${"A".repeat(MAX_PAYLOAD_CHARS + 1)}`,
		`#${"x".repeat(4096)}`,
	];
	for (const hash of errorRoutes) {
		const route = parseHash(hash);
		assert.equal(route.kind, "error", `hash ${JSON.stringify(String(hash).slice(0, 40))}`);
		assert.equal(typeof route.message, "string");
		assert.ok(route.message.length > 0);
		assert.ok(route.message.length < 400, `the notice stays bounded, got ${route.message.length} characters`);
	}

	const hostile = parseHash(`#/i/${"A".repeat(MAX_PAYLOAD_CHARS + 1)}`);
	assert.match(hostile.message, /the limit is 131072/);
	assert.match(parseHash("#/i/not-a-payload").message, /share:/);
	assert.match(parseHash("#/nope/x").message, /unrecognized route/);
});

test("a parsed route survives a real hash round trip", () => {
	const hash = new URL(buildShareUrl(RICH, "https://example.com/")).hash;
	const route = parseHash(hash);
	assert.equal(route.kind, "view");
	assert.equal(encodeInvoice(route.invoice), encodeInvoice(RICH), "the link round-trips through parseHash");
});

test("text rejects invisible and direction-formatting characters", () => {
	const cases = {
		"a right-to-left override in the payee name": { payee: { name: "Ana\u202Eeman", address: PAYEE } },
		"a right-to-left mark in a description": { items: [{ description: "Design\u200Fwork", quantity: "1", unitPrice: "1" }] },
		"a zero-width space in the id": { id: "INV\u200B1" },
		"a zero-width joiner in a payer name": { payer: { name: "Ac\u200Dme" } },
		"an isolate control in the notes": { notes: "total\u2066 hidden\u2069" },
		"a byte-order mark inside a tax label": { tax: { label: "VA\uFEFFT", rate: "19" } },
		"a soft hyphen in the payee name": { payee: { name: "Ac\u00ADme", address: PAYEE } },
		"an Arabic letter mark in a description": { items: [{ description: "De\u061Csign", quantity: "1", unitPrice: "1" }] },
		"a word joiner in the id": { id: "INV\u2060-1" },
		"an invisible plus in a payer name": { payer: { name: "Ac\u2064me" } },
		"a Mongolian vowel separator in a description": { items: [{ description: "De\u180Esign", quantity: "1", unitPrice: "1" }] },
		"a Hangul filler in the payee name": { payee: { name: "Ac\u3164me", address: PAYEE } },
		"a soft hyphen in the notes": { notes: "Pay\u00ADable within 30 days" },
		"a combining grapheme joiner in the id": { id: "INV\u034F1" },
		"a Hangul choseong filler in the payee name": { payee: { name: "Ac\u115Fme", address: PAYEE } },
		"a halfwidth Hangul filler in a description": { items: [{ description: "De\uFFA0sign", quantity: "1", unitPrice: "1" }] },
		"a Mongolian free variation selector in the payee name": { payee: { name: "Ac\u180Bme", address: PAYEE } },
		"a variation selector-16 in a payer name": { payer: { name: "Ac\uFE0Fme" } },
		"a variation selector-17 in a description": { items: [{ description: "De\u{E0100}sign", quantity: "1", unitPrice: "1" }] },
		"a shorthand-format control in the id": { id: "INV\u{1BCA0}-1" },
		"a reserved default-ignorable in a payer name": { payer: { name: "Ac\u2065me" } },
	};
	for (const [label, overrides] of Object.entries(cases)) {
		rejects(
			label,
			() => make(overrides),
			InvalidInvoiceError,
			/must not contain invisible or direction-formatting characters/,
		);
	}
	rejects(
		"a line separator in the id",
		() => make({ id: "INV\u20281" }),
		InvalidInvoiceError,
		/must not contain control characters/,
	);
	rejects(
		"a paragraph separator in the id",
		() => make({ id: "INV\u20291" }),
		InvalidInvoiceError,
		/must not contain control characters/,
	);
	assert.equal(make({ payee: { name: "Ana", address: PAYEE } }).payee.name, "Ana", "plain text still passes");
	const override = serializeInvoice(MINIMAL).replace("Design work", "Design\u202Ework");
	rejects(
		"an RTL-override payload",
		() => decodeInvoice(b32(override)),
		InvalidInvoiceError,
		/must not contain invisible or direction-formatting characters/,
	);
});

test("numeric spellings collapse to one canonical form", () => {
	const respelled = make({ items: [{ description: "Design work", quantity: "2.0", unitPrice: "150.00" }] });
	assert.deepEqual(respelled.items[0], { description: "Design work", quantity: "2", unitPrice: "150" });
	assert.equal(encodeInvoice(respelled), encodeInvoice(MINIMAL), "two spellings of one number share a payload");
	assert.equal(make({ tax: { label: "VAT", rate: "8.50" } }).tax.rate, "8.5", "the tax rate is canonicalized too");
	assert.equal(
		make({ items: [{ description: "d", quantity: "1.120000", unitPrice: "1" }] }).items[0].quantity,
		"1.12",
		"trailing zeros inside the precision are dropped",
	);

	const json = serializeInvoice(MINIMAL);
	rejects(
		"a trailing-zero price",
		() => decodeInvoice(b32(json.replace("\"unitPrice\":\"150\"", "\"unitPrice\":\"150.00\""))),
		ShareFormatError,
		/not in the canonical form/,
	);
	rejects(
		"a trailing-zero quantity",
		() => decodeInvoice(b32(json.replace("\"quantity\":\"2\"", "\"quantity\":\"2.00\""))),
		ShareFormatError,
		/not in the canonical form/,
	);
});

test("an oversized value inside a within-cap payload yields a bounded notice", () => {
	const json = serializeInvoice(MINIMAL);
	const hugeAddress = json.replace(PAYEE, "x".repeat(50000));
	const hugeQuantity = json.replace("\"quantity\":\"2\"", `"quantity":"${"9".repeat(50000)}"`);
	const hugePrice = json.replace("\"unitPrice\":\"150\"", `"unitPrice":"1.${"0".repeat(50000)}1"`);
	const hugeIssued = json.replace("\"issued\":\"2026-10-03\"", `"issued":"${"9".repeat(50000)}"`);
	// The longest accepted email address stays inside every payload limit, yet the refusal that quotes it runs past 400 characters, so it has to be bounded like the address and amount refusals.
	const longEmail = json.replace(`"address":"${PAYEE}"`, `"address":"${PAYEE}","email":"${"x".repeat(320)}"`);
	const hugeRootKey = json.replace("{", `{"${"k".repeat(50000)}":1,`);
	const hugeNestedKey = json.replace("\"payee\":{", `"payee":{"${"k".repeat(50000)}":1,`);
	for (const [label, text] of [
		["a huge payee address", hugeAddress],
		["a huge quantity", hugeQuantity],
		["a huge over-precise price", hugePrice],
		["a huge issued date", hugeIssued],
		["a long invalid email", longEmail],
		["a huge unknown root key", hugeRootKey],
		["a huge unknown nested key", hugeNestedKey],
	]) {
		assert.ok(Buffer.byteLength(text, "utf8") <= MAX_JSON_BYTES, `${label} stays inside the payload byte cap`);
		const payload = b32(text);
		rejects(
			label,
			() => decodeInvoice(payload),
			InvalidInvoiceError,
			/payee\.(address|email)|items\[0\]\.(quantity|unitPrice)|issued|is not a known field/,
		);
		const route = parseHash(`#/i/${payload}`);
		assert.equal(route.kind, "error", label);
		assert.ok(
			route.message.length < 400,
			`${label}: the notice stays bounded, got ${route.message.length} characters`,
		);
	}

	const emailNotice = parseHash(`#/i/${b32(longEmail)}`).message;
	assert.ok(!emailNotice.includes("x".repeat(320)), "the email address is not carried into the notice whole");
});

test("decode accepts exactly the envelope the encoder writes", () => {
	const items = Array.from({ length: 140 }, (_, index) => ({
		description: `${index}`.padEnd(500, "x"),
		quantity: "1",
		unitPrice: "1.00",
	}));
	const oversized = make({ items });
	const json = serializeInvoice(oversized);
	const payload = b32(json);
	const bytes = Buffer.byteLength(json, "utf8");
	assert.ok(bytes > MAX_JSON_BYTES, `the JSON is ${bytes} bytes, past the byte cap`);
	assert.ok(payload.length <= MAX_PAYLOAD_CHARS, `the payload is ${payload.length} characters, inside the pre-decode guard`);
	rejects("encoding it", () => encodeInvoice(oversized), ShareFormatError, /the share limit is 65536/);
	rejects("decoding the same bytes", () => decodeInvoice(payload), ShareFormatError, /the share limit is 65536/);
});
