/** The suite for `app/js/payment/links.js`: the ZIP-321, Monero, and EIP-681 links one invoice becomes, the amount each one carries for its caller, the network refusal a hand-built invoice meets, the QR budget every link stays inside — measured in bytes, and pinned at the worst case each family can build rather than for the Zcash family alone — the canonical payee address the link carries and the document draws — a TEX payee included, carried in the spelling the payee published — the amount premise the Zcash address budget rests on, and the surface the module exports. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ASSETS, requireAsset } from "../app/js/assets/registry.js";
import { buildInvoiceViewModel } from "../app/js/ui/presentation.js";
import { createInvoice, computeTotals } from "../app/js/invoice/model.js";
import { MAX_PAYMENT_LINK_BYTES, PaymentLinkBudgetError, PaymentLinkError, buildPaymentLink, requireLinkBudget } from "../app/js/payment/links.js";
import { MAX_DECIMALS, MAX_UINT256_DIGITS, UINT256_MAX, fromBaseUnits } from "../app/js/util/decimal.js";
import { base58xmr, keccak256 } from "../app/js/util/encoding.js";
import { QR_MAX_TEXT_BYTES, encodeQr } from "../app/js/util/qr.js";
import { MAX_EVM_ADDRESS_LENGTH } from "../app/js/wallet/address.js";
import { MAX_MONERO_ADDRESS_LENGTH } from "../app/js/wallet/monero-address.js";
import { InvalidZcashAddressError, requireZcashAddress } from "../app/js/wallet/zcash-address.js";
import { PAYEE, XMR_PAYEE, ZEC_PAYEE } from "./helpers/payee-vectors.mjs";
import { USDC, USDT } from "./helpers/tokens.mjs";
import { unifiedOfBytes } from "./helpers/unified-address.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A mainnet TEX address from ZIP-320's own reference implementation: a Zcash payee form the validator accepts beside the transparent, Sapling, and unified ones. */
const TEX_PAYEE = "tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte";

/** A mainnet unified address: the second Zcash payee form the payout validator accepts. */
const UNIFIED = "u1qpatys4zruk99pg59gcscrt7y6akvl9vrhcfyhm9yxvxz7h87q6n8cgrzzpe9zru68uq39uhmlpp5uefxu0su5uqyqfe5zp3tycn0ecl";

/**
 * The widest address the Monero family accepts — its 77-byte integrated form — built the way the validator reads one: the `0x13` mainnet prefix, a 77-byte body, and the four-byte Keccak-256 checksum over everything before them, in Monero's block-padded base58.
 * The body is deterministic filler, because what the validator checks is the prefix, the encoding length, and the checksum; no key material is read and none is certified.
 */
function widestMoneroAddress() {
	const body = new Uint8Array(77 - 4);
	body[0] = 0x13;
	for (let index = 1; index < body.length; index += 1) body[index] = (index * 7) & 0xff;
	const encoding = new Uint8Array(77);
	encoding.set(body);
	encoding.set(keccak256(body).subarray(0, 4), body.length);
	return base58xmr.encode(encoding);
}

/**
 * An EVM entry of the shape the registry admits whose chain id is the exact power of ten spelling `decimalDigits` decimal digits: EIP-681 writes the chain as that decimal quantity, so an entry built this way pins the widest link one entry can build to the byte.
 */
function chainIdOfDigits(decimalDigits) {
	return {
		id: "longchain",
		symbol: "LONG",
		name: "Long chain",
		chainId: `0x${(10n ** BigInt(decimalDigits - 1)).toString(16)}`,
		decimals: 18,
		family: "evm",
		kind: "native",
		address: null,
	};
}

/**
 * A Zcash entry of the shape the registry admits, printing its amounts at `decimals`: the gate measures a `zcash:` link from the validator's own address bound and the entry's own scale, so an entry built this way pins that measurement to the byte.
 */
function zcashEntryOfDecimals(decimals) {
	return {
		id: "widezec",
		symbol: "WZEC",
		name: "Wide ZEC",
		chainId: "zcash",
		decimals,
		family: "zcash",
		kind: "native",
		address: null,
	};
}

/** The decimal quantity an EIP-681 link writes after `@` for the chain id {@link chainIdOfDigits} builds. */
function chainQuantityOf(decimalDigits) {
	return (10n ** BigInt(decimalDigits - 1)).toString();
}

/** The widest native EIP-681 link such an entry can build: the scheme, a recipient, the chain as EIP-681 writes it, and a uint256 in base units. */
function widestNativeUri(decimalDigits) {
	return `ethereum:${"0".repeat(42)}@${chainQuantityOf(decimalDigits)}?value=${"9".repeat(78)}`;
}

/** The widest ERC-20 link such an entry can build, which carries the token's own contract and the `transfer` call's field names as well. */
function widestTokenUri(decimalDigits) {
	return `ethereum:${USDC}@${chainQuantityOf(decimalDigits)}/transfer?address=${"0".repeat(42)}&uint256=${"9".repeat(78)}`;
}

/** The error a refusal raised by `run` carries; `run` failing to refuse at all is an error, so a case expecting a refusal cannot pass silently. */
function refusal(run) {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw new Error("expected the run to refuse");
}

function zecInvoice(overrides = {}) {
	return createInvoice({
		id: "INV-ZEC",
		issued: "2026-10-03",
		payee: { name: "Studio Example", address: ZEC_PAYEE },
		chainId: "zcash",
		asset: "zec",
		items: [{ description: "Advice", quantity: "1", unitPrice: "1.23456789" }],
		...overrides,
	});
}

function xmrInvoice(overrides = {}) {
	return createInvoice({
		id: "INV-XMR",
		issued: "2026-10-03",
		payee: { name: "Studio Example", address: XMR_PAYEE },
		chainId: "monero",
		asset: "xmr",
		items: [{ description: "Advice", quantity: "1", unitPrice: "0.000000000001" }],
		...overrides,
	});
}

function ethInvoice(overrides = {}) {
	return createInvoice({
		id: "INV-ETH",
		issued: "2026-10-03",
		payee: { name: "Studio Example", address: PAYEE },
		chainId: "0x1",
		asset: "eth",
		items: [{ description: "Advice", quantity: "1", unitPrice: "1.5" }],
		...overrides,
	});
}

function tokenInvoice(asset, overrides = {}) {
	return createInvoice({
		id: `INV-${asset.toUpperCase()}`,
		issued: "2026-10-03",
		payee: { name: "Studio Example", address: PAYEE },
		chainId: "0x1",
		asset,
		items: [{ description: "Design work", quantity: "2", unitPrice: "150" }],
		...overrides,
	});
}

test("a Zcash invoice becomes its ZIP-321 link, with no optional label or message", () => {
	const link = buildPaymentLink(zecInvoice());

	assert.equal(link.scheme, "zcash");
	assert.equal(link.uri, `zcash:${ZEC_PAYEE}?amount=1.23456789`);
	assert.equal(link.uri.includes("label="), false, "the payee's name is not repeated into the link");
	assert.equal(link.uri.includes("message="), false);
	assert.equal(link.uri.includes("&"), false, "the amount is the only parameter the link carries");

	const unified = buildPaymentLink(zecInvoice({ payee: { name: "Studio Example", address: UNIFIED } }));
	assert.equal(unified.uri, `zcash:${UNIFIED}?amount=1.23456789`, "a unified payee is carried the same way");

	// A TEX payee reaches the link verbatim, in the spelling the payee published rather than in its `t1` twin's.
	const tex = buildPaymentLink(zecInvoice({ payee: { name: "Studio Example", address: TEX_PAYEE } }));
	assert.equal(tex.uri, `zcash:${TEX_PAYEE}?amount=1.23456789`);
	assert.equal(tex.payee, TEX_PAYEE, "and the link exposes that spelling as the payee it carries");
});

test("a Monero invoice becomes its link, with no optional recipient name", () => {
	const link = buildPaymentLink(xmrInvoice());

	assert.equal(link.scheme, "monero");
	assert.equal(link.uri, `monero:${XMR_PAYEE}?tx_amount=0.000000000001`);
	assert.equal(link.uri.includes("recipient_name="), false);
	assert.equal(link.uri.includes("&"), false);
});

test("an ETH invoice becomes its EIP-681 native link with an explicit chain id", () => {
	const link = buildPaymentLink(ethInvoice());

	assert.equal(link.scheme, "ethereum");
	assert.equal(link.uri, `ethereum:${PAYEE}@1?value=1500000000000000000`, "1.5 ETH is wei, on chain 1, in the checksummed spelling");

	const uniformCase = buildPaymentLink(ethInvoice({ payee: { name: "Studio Example", address: PAYEE.toLowerCase() } }));
	assert.equal(uniformCase.uri, link.uri, "a uniformly-cased paste is carried in its EIP-55 checksummed spelling");
});

test("an ERC-20 invoice becomes its EIP-681 transfer link addressed to the token's own contract", () => {
	const usdc = buildPaymentLink(tokenInvoice("usdc"));
	assert.equal(usdc.scheme, "ethereum");
	assert.equal(usdc.uri, `ethereum:${USDC}@1/transfer?address=${PAYEE}&uint256=300000000`, "300 USDC is the token's six-decimal base units");

	const usdt = buildPaymentLink(tokenInvoice("usdt", { items: [{ description: "Advice", quantity: "1", unitPrice: "0.000001" }] }));
	assert.equal(usdt.uri, `ethereum:${USDT}@1/transfer?address=${PAYEE}&uint256=1`, "one base unit of a six-decimal token is one");
});

test("the amount a link asks for is the invoice's own recomputed total, in the asset's decimals", () => {
	const taxed = { items: [{ description: "Design work", quantity: "2", unitPrice: "150" }], tax: { label: "VAT 19%", rate: "19" } };

	// 300 plus 19% VAT is 357, and the link asks for that figure rather than for any subtotal a transport might have carried.
	assert.equal(buildPaymentLink(zecInvoice(taxed)).uri, `zcash:${ZEC_PAYEE}?amount=357`);
	assert.equal(buildPaymentLink(ethInvoice(taxed)).uri, `ethereum:${PAYEE}@1?value=357000000000000000000`);
	assert.equal(buildPaymentLink(tokenInvoice("usdc", taxed)).uri, `ethereum:${USDC}@1/transfer?address=${PAYEE}&uint256=357000000`, "USDC's six decimals");
	assert.equal(buildPaymentLink(xmrInvoice({ items: [{ description: "Advice", quantity: "2", unitPrice: "1.000000000001" }] })).uri, `monero:${XMR_PAYEE}?tx_amount=2.000000000002`, "XMR's twelve decimals");

	for (const [invoice, decimals] of [[zecInvoice(), 8], [xmrInvoice(), 12]]) {
		const amount = fromBaseUnits(computeTotals(invoice).total.units, decimals);
		assert.equal(buildPaymentLink(invoice).uri.endsWith(`=${amount}`), true, `${invoice.asset} carries its recomputed total`);
	}
});

test("the total a link asks for is exposed on the link, and every surface reads that one value", () => {
	// `PaymentLink.amount` is the total the URI was spelled from — both spellings at once — so the figure a link asks for is not a second recomputation a caller cannot compare against: the printed Total due and the Amount term a payer copies are readings of it, and the URI's own field is that same value in its family's spelling.
	for (const invoice of [zecInvoice(), xmrInvoice(), ethInvoice(), tokenInvoice("usdc"), tokenInvoice("usdt")]) {
		const { family, decimals } = requireAsset(invoice.asset);
		const link = buildPaymentLink(invoice);
		const total = computeTotals(invoice).total;

		assert.equal(link.amount.units, total.units, `${invoice.asset}: the link carries the model's own total in base units`);
		assert.equal(link.amount.text, total.text, `${invoice.asset}: and the same total in the decimal spelling its field takes`);
		assert.equal(fromBaseUnits(link.amount.units, decimals), link.amount.text, `${invoice.asset}: the two spellings on the link are one value`);

		const model = buildInvoiceViewModel(invoice, "2026-10-03");
		const amountTerm = model.payment.filter((term) => term.label === model.labels.amount)[0];
		assert.equal(amountTerm.value, link.amount.text, `${invoice.asset}: the Amount term a payer copies is the amount the link carries`);
		assert.equal(model.total, `${link.amount.text} ${model.symbol}`, `${invoice.asset}: and the document's Total due is that same value`);

		const spelled = family === "evm" ? link.amount.units.toString() : link.amount.text;
		assert.equal(link.uri.endsWith(`=${spelled}`), true, `${invoice.asset}: the URI's own amount field is that value in its family's spelling`);
	}
});

test("the link re-validates the payee rather than trusting the invoice it is handed", () => {
	// The builders re-derive the address through `wallet/payout-address.ts`, so an invoice whose payee does not match its own asset's family is refused here instead of becoming a link that asks a wallet to pay a Zcash invoice at an Ethereum address.
	const invoice = zecInvoice();
	const error = refusal(() => buildPaymentLink({ ...invoice, payee: { name: "Studio Example", address: PAYEE } }));
	assert.equal(error instanceof InvalidZcashAddressError, true, error.message);
	assert.equal(error.message.startsWith("zcash-address: not a Zcash payout address — "), true, error.message);
});

test("an invoice naming a network its asset does not live on is refused rather than linked", () => {
	// A validated invoice always names its asset's network — `invoice/model.ts` refuses one that does not — so this is the refusal a hand-built invoice meets: the link that cannot exist rather than one built in the asset's own scheme while carrying another network's address.
	for (const [invoice, message] of [
		[{ ...zecInvoice(), chainId: "monero" }, 'payment-link: the invoice names network "monero" but zec lives on "zcash"'],
		[{ ...xmrInvoice(), chainId: "zcash" }, 'payment-link: the invoice names network "zcash" but xmr lives on "monero"'],
		[{ ...ethInvoice(), chainId: "zcash" }, 'payment-link: the invoice names network "zcash" but eth lives on "0x1"'],
	]) {
		const error = refusal(() => buildPaymentLink(invoice));
		assert.equal(error instanceof PaymentLinkError, true, error.message);
		assert.equal(error.name, "PaymentLinkError");
		assert.equal(error.message, message);
	}
});

test("every link is a text the QR encoder accepts, inside the app's own byte budget", () => {
	const invoices = [
		zecInvoice(),
		zecInvoice({ payee: { name: "Studio Example", address: UNIFIED } }),
		xmrInvoice(),
		ethInvoice(),
		tokenInvoice("usdc"),
		tokenInvoice("usdt"),
	];
	for (const invoice of invoices) {
		const link = buildPaymentLink(invoice);
		assert.ok(link.uri.length <= MAX_PAYMENT_LINK_BYTES, `${invoice.asset}: ${link.uri.length} bytes`);
		const matrix = encodeQr(link.uri);
		assert.ok(matrix.size >= 21 && matrix.size <= 77, `${invoice.asset}: ${matrix.size} modules`);
	}
});

test("the widest amount a uint256-bounded invoice can carry still fits the symbol", () => {
	const widestAmount = fromBaseUnits(UINT256_MAX, 8);
	assert.equal(widestAmount.length, 79, "a uint256 ZEC total is 70 whole digits and ZEC's eight decimals");
	const address = unifiedOfBytes(189);
	assert.equal(requireZcashAddress(address), address, "the longest address the payout validator accepts");

	const invoice = zecInvoice({
		payee: { name: "Studio Example", address },
		items: [{ description: "Advice", quantity: "1", unitPrice: widestAmount }],
	});
	const link = buildPaymentLink(invoice);
	assert.equal(link.uri, `zcash:${address}?amount=${widestAmount}`);
	assert.equal(link.uri.length, 6 + address.length + 8 + widestAmount.length);
	assert.equal(link.uri.length, 404, "the widest ZEC link stays inside the 412-byte budget");
	assert.equal(MAX_PAYMENT_LINK_BYTES - link.uri.length, 8, "and is the widest any accepted invoice can build, eight bytes inside it");

	const matrix = encodeQr(link.uri);
	assert.equal((matrix.size - 17) / 4, 15, "and is encoded at the widest version this app draws");
});

test("the byte budget is the encoder's own ceiling, not a second figure", () => {
	assert.equal(MAX_PAYMENT_LINK_BYTES, QR_MAX_TEXT_BYTES, "the link budget is derived from the encoder's exported capacity");
	assert.equal(MAX_PAYMENT_LINK_BYTES, 412);
	assert.doesNotThrow(() => encodeQr("a".repeat(MAX_PAYMENT_LINK_BYTES)), "the budget is encodable");
	assert.throws(() => encodeQr("a".repeat(MAX_PAYMENT_LINK_BYTES + 1)), RangeError, "one byte past it is not");
});

test("the scheme prefixes and the address budget are one statement, shared with the validators", async () => {
	// The scheme a link is spelled with and the prefix an address validator recognises a pasted link by are the same entry, so `payment/schemes.ts` is where both read it: a scheme renamed in one place cannot leave the other refusing the link under the old name.
	const schemes = await import("../app/js/payment/schemes.js");
	assert.deepEqual(schemes.PAYMENT_SCHEME_PREFIXES, { ethereum: "ethereum:", monero: "monero:", zcash: "zcash:" });
	assert.equal(schemes.MAX_PAYMENT_LINK_BYTES, MAX_PAYMENT_LINK_BYTES, "and the budget the builders apply is that statement's own");

	// The bound the Zcash validator holds a unified address to is derived there too, from the budget and the bytes a `zcash:` link spends on everything but the address: the scheme and its separator, `?amount=`, the longest decimal ZEC total, and the margin that keeps the widest link inside the ceiling.
	const zcash = await import("../app/js/wallet/zcash-address.js");
	assert.equal(zcash.MAX_ZCASH_ADDRESS_LENGTH, schemes.MAX_ZCASH_ADDRESS_LENGTH, "the validator re-exports the one statement of the bound the budget layer derives");
	// The envelope is measured at the asset's own scale rather than restated as digits: the longest amount is the widest value printed there, so a scale at or past the digit budget — where the whole part is the bare `0` and the fraction keeps the full scale — moves this figure instead of cancelling away.
	const longestZecAmount = fromBaseUnits(UINT256_MAX, requireAsset("zec").decimals);
	assert.equal(MAX_PAYMENT_LINK_BYTES - zcash.MAX_ZCASH_ADDRESS_LENGTH, schemes.zcashLinkUri("", longestZecAmount).length + 8, "the budget less the `zcash:` envelope at the asset's own scale and the margin");

	// The widest `zcash:` link the validator's bound admits — the longest container it accepts, with the amount the address budget reserves — is a 404-byte link of the 412-byte ceiling.
	const widestAdmitted = schemes.zcashLinkUri("u".repeat(zcash.MAX_ZCASH_ADDRESS_LENGTH), "9".repeat(schemes.ZCASH_AMOUNT_BUDGET_CHARS));
	assert.equal(widestAdmitted.length, 404);
	assert.equal(MAX_PAYMENT_LINK_BYTES - widestAdmitted.length, 8, "and it leaves the margin the budget documents");

	// The figure the link layer's own gate measures for a `zcash:` entry is observed rather than read out of the source: an entry at the registry's own scale passes, and one past the amount budget is refused with the byte count that bound and that template give the link — so the measurement is this bound, not a figure of the gate's own.
	assert.doesNotThrow(() => requireLinkBudget(zcashEntryOfDecimals(requireAsset("zec").decimals)), "the registry's own ZEC scale is inside the gate every entry goes through");
	const pastTheAmountBudget = refusal(() => requireLinkBudget(zcashEntryOfDecimals(MAX_DECIMALS)));
	const measured = schemes.zcashLinkUri("u".repeat(zcash.MAX_ZCASH_ADDRESS_LENGTH), "9".repeat(schemes.maxAmountChars(MAX_DECIMALS)));
	assert.equal(measured.length, 582, "the widest `zcash:` link a scale past the amount budget builds, from the validator's own bound");
	assert.equal(pastTheAmountBudget.message.includes(`${measured.length}-byte link`), true, pastTheAmountBudget.message);
	assert.equal(pastTheAmountBudget instanceof PaymentLinkBudgetError, true, "and the gate refuses it with the budget class");

	assert.match(refusal(() => requireZcashAddress(schemes.PAYMENT_SCHEME_PREFIXES.zcash)).message, /`zcash:` payment link/);
	const monero = await import("../app/js/wallet/monero-address.js");
	assert.match(refusal(() => monero.requireMoneroAddress(schemes.PAYMENT_SCHEME_PREFIXES.monero)).message, /`monero:` payment link/);
});

test("the amount budget bounds the longest spelling at every scale the registry admits", async () => {
	const schemes = await import("../app/js/payment/schemes.js");
	// The whole text is bounded rather than either side of the point, so the two parts trade digits: a figure that cancelled the scale out would under-count a legal amount from the digit budget on, where the whole part is the bare `0` and the fraction keeps the full scale — and would oversize the address bound with it.
	for (const scale of [0, 1, requireAsset("zec").decimals, MAX_UINT256_DIGITS - 1, MAX_UINT256_DIGITS, MAX_UINT256_DIGITS + 1, MAX_DECIMALS]) {
		const bound = schemes.maxAmountChars(scale);
		for (const units of [1n, UINT256_MAX]) {
			assert.ok(fromBaseUnits(units, scale).length <= bound, `${scale} decimals: the budget covers the ${units} base-unit spelling`);
		}
	}
	assert.equal(schemes.maxAmountChars(requireAsset("zec").decimals), 79, "a uint256 ZEC total is 70 whole digits and ZEC's eight decimals");
	assert.equal(schemes.maxAmountChars(MAX_UINT256_DIGITS), MAX_UINT256_DIGITS + 2, "a total at the digit budget prints the bare `0`, the point, and the full scale");
});

test("the Zcash link's envelope is the builder's own template, not a second spelling of it", async () => {
	const schemes = await import("../app/js/payment/schemes.js");
	// The template the address budget measures the envelope of is the one the builder spells the link with, so a query parameter renamed in the builder moves the bound with it instead of leaving it sized against a link nothing produces.
	assert.equal(schemes.zcashLinkUri("", ""), "zcash:?amount=", "the envelope is that template with both fields empty");

	const address = unifiedOfBytes(189);
	const amount = fromBaseUnits(UINT256_MAX, 8);
	const link = buildPaymentLink(zecInvoice({
		payee: { name: "Studio Example", address },
		items: [{ description: "Advice", quantity: "1", unitPrice: amount }],
	}));
	assert.equal(link.uri, schemes.zcashLinkUri(address, amount), "the built link is that same template with the address and the amount filled in");
	assert.equal(MAX_PAYMENT_LINK_BYTES - link.uri.length, 8, "so the widest link still lands on the budget the envelope was measured for");
});

test("the budget module loads neither the registry nor the encoder, so a validator's own import pulls neither", () => {
	// The address bound is derived from the app's own uint256 digit budget rather than read off the ZEC entry, because reading the entry in `schemes.ts` would pull the registry module — and its load-time validation — into every address validator's import graph. That property is the import graph itself, so it is pinned as the source shape it is; the figure premise the link layer's load-time check holds is observed as a figure in the tests around this one.
	const schemes = readFileSync(join(root, "app", "ts", "payment", "schemes.ts"), "utf8");
	assert.ok(!/\bASSET_REGISTRY\b/.test(schemes), "the budget module never indexes the registry by a hardcoded key");
	assert.equal(/from "\.\.\/assets\/registry\.js"/.test(schemes), false, "and it imports no registry entry at all, so a validator that reads its bound does not run the registry check");
	assert.equal(/from "\.\.\/util\/qr\.js"/.test(schemes), false, "nor does it load the encoder: the ceiling comes from the capacity contract both modules read");

	const links = readFileSync(join(root, "app", "ts", "payment", "links.ts"), "utf8");
	assert.ok(!/\bASSET_REGISTRY\b/.test(links), "and the link layer indexes no registry entry by a hardcoded key either, so an entry's own family is the only thing that picks its scheme");
});

test("the amount budget the Zcash address bound reserves covers the ZEC entry's own scale and refuses a wider one", async () => {
	const schemes = await import("../app/js/payment/schemes.js");
	// The premise the address bound rests on, as a figure: the amount reserved is the digits arm of `maxAmountChars`, which holds for every scale up to the last one whose whole part still carries a digit — and the registry's own ZEC scale sits inside it, at exactly the reserved figure.
	assert.equal(schemes.ZCASH_AMOUNT_BUDGET_CHARS, 79);
	assert.equal(schemes.maxAmountChars(requireAsset("zec").decimals), schemes.ZCASH_AMOUNT_BUDGET_CHARS, "the shipped entry's widest amount is the reserved figure");
	assert.equal(schemes.zcashAmountOutgrowsBudget(requireAsset("zec").decimals), false, "so the shipped entry is inside the budget");
	assert.equal(schemes.zcashAmountOutgrowsBudget(MAX_UINT256_DIGITS - 1), false, "the last scale the digits arm holds is inside it");
	assert.equal(schemes.zcashAmountOutgrowsBudget(MAX_UINT256_DIGITS), true, "one scale past it is not, so the check is not vacuous");
	assert.equal(schemes.zcashAmountOutgrowsBudget(MAX_DECIMALS), true, "nor is the widest scale the registry admits");
});

test("the link budget is applied in bytes, and the display boundary measures the same unit", () => {
	// The ceiling is a byte budget, observed through the encoder itself: a text of the ceiling's own bytes written in a two-byte character fills the widest symbol, while one byte more is refused rather than encoded at a version this app does not draw.
	const twoByteChars = Math.floor(MAX_PAYMENT_LINK_BYTES / 2);
	assert.doesNotThrow(() => encodeQr("é".repeat(twoByteChars)), `${twoByteChars} two-byte characters are the ceiling's ${MAX_PAYMENT_LINK_BYTES} bytes`);
	assert.throws(() => encodeQr("é".repeat(twoByteChars + 1)), RangeError, "one byte past the ceiling is refused");

	// Every link a legal invoice builds is ASCII, so the two measurements agree across the whole accepted surface — the property the budget module no longer rests on, held here as the observation it is.
	for (const invoice of [zecInvoice(), xmrInvoice(), ethInvoice(), tokenInvoice("usdc"), tokenInvoice("usdt")]) {
		const uri = buildPaymentLink(invoice).uri;
		assert.equal(uri.length, Buffer.byteLength(uri, "utf8"), `${invoice.asset}: the link is ASCII, so its code units are its bytes`);
		assert.ok(Buffer.byteLength(uri, "utf8") <= MAX_PAYMENT_LINK_BYTES, `${invoice.asset}: ${uri.length} bytes`);
	}

	// Source-shape pin, kept because no accepted invoice can reach either guard: which unit the two boundaries measure a payment value in is a statement about the code, not a value any input this app accepts can distinguish.
	const links = readFileSync(join(root, "app", "ts", "payment", "links.ts"), "utf8");
	assert.match(links, /utf8ToBytes\(uri\)\.length/, "the link builder measures its URI in bytes");
	const presentation = readFileSync(join(root, "app", "ts", "ui", "presentation.ts"), "utf8");
	assert.match(presentation, /utf8ToBytes\(shown\)\.length > MAX_PAYMENT_LINK_BYTES/, "and the display boundary re-measures the URI it would show in the same bytes");
	assert.equal(/MAX_PAYMENT_LINK_CHARS/.test(presentation), false, "no code-unit cap stands in for that budget");
});

test("the widest link the Monero family can build is inside the symbol, with the margin it leaves", () => {
	// The invariant this suite pins for Zcash is pinned here for the other families from the bounds their own validators and this app's digit budget export, rather than asserted in prose: the widest address each family admits, with the widest amount the invoice model can carry.
	const monero = widestMoneroAddress();
	assert.equal(monero.length, MAX_MONERO_ADDRESS_LENGTH, "the fixture is the widest address the Monero validator admits");
	const amount = fromBaseUnits(UINT256_MAX, requireAsset("xmr").decimals);
	assert.equal(amount.length, 79, "a uint256 XMR total is 70 whole digits and XMR's twelve decimals");
	const link = buildPaymentLink(xmrInvoice({ payee: { name: "Studio Example", address: monero }, items: [{ description: "Advice", quantity: "1", unitPrice: amount }] }));
	assert.equal(link.uri, `monero:${monero}?tx_amount=${amount}`);
	assert.equal(link.uri.length, "monero:".length + MAX_MONERO_ADDRESS_LENGTH + "?tx_amount=".length + amount.length);
	assert.equal(link.uri.length, 203, "the widest Monero link");
	assert.equal(MAX_PAYMENT_LINK_BYTES - link.uri.length, 209, "leaves more of the ceiling than the Zcash one, which is the widest link of all");
	const version = (encodeQr(link.uri).size - 17) / 4;
	assert.ok(version <= 12, `the widest Monero link is inside version 12, got version ${version}`);
});

test("the widest EIP-681 links are inside the symbol, with the margin they leave", () => {
	assert.equal(PAYEE.length, MAX_EVM_ADDRESS_LENGTH, "the fixture is the length every EVM address has");
	const widest = UINT256_MAX.toString();
	assert.equal(widest.length, MAX_UINT256_DIGITS, "a uint256 total is 78 digits");

	const native = buildPaymentLink(ethInvoice({ items: [{ description: "Advice", quantity: "1", unitPrice: fromBaseUnits(UINT256_MAX, requireAsset("eth").decimals) }] }));
	assert.equal(native.uri, `ethereum:${PAYEE}@1?value=${widest}`, "the widest native EIP-681 link is the chain id and the uint256 itself");
	assert.equal(native.uri.length, 138);
	assert.equal(MAX_PAYMENT_LINK_BYTES - native.uri.length, 274, "the native link leaves the most of the ceiling");

	const transfer = buildPaymentLink(tokenInvoice("usdc", { items: [{ description: "Advice", quantity: "1", unitPrice: fromBaseUnits(UINT256_MAX, requireAsset("usdc").decimals) }] }));
	assert.equal(transfer.uri, `ethereum:${USDC}@1/transfer?address=${PAYEE}&uint256=${widest}`, "the widest ERC-20 link carries the token contract, the recipient, and the uint256");
	assert.equal(transfer.uri.length, 200);
	assert.equal(MAX_PAYMENT_LINK_BYTES - transfer.uri.length, 212);
	for (const link of [native, transfer]) {
		const version = (encodeQr(link.uri).size - 17) / 4;
		assert.ok(version <= 12, `the widest ${link.scheme} link is inside version 12, got version ${version}`);
	}

	// The Zcash link stays the widest any accepted invoice can build, which is what keeps the address bound the one that has to be derived.
	const zec = buildPaymentLink(zecInvoice({ payee: { name: "Studio Example", address: unifiedOfBytes(189) }, items: [{ description: "Advice", quantity: "1", unitPrice: fromBaseUnits(UINT256_MAX, 8) }] }));
	assert.equal(zec.uri.length, 404);
	assert.ok(zec.uri.length > transfer.uri.length && transfer.uri.length > native.uri.length);
});

test("the link carries the payee address it encodes, and the document draws that same spelling", () => {
	// The URI's address and the link's `payee` are one value from one dispatcher call, so a document cannot show one spelling beside a URI that encodes another — including for an invoice a caller assembled by hand rather than through `validateInvoice`.
	for (const [invoice, canonical] of [
		[ethInvoice({ payee: { name: "Studio Example", address: PAYEE.toLowerCase() } }), PAYEE],
		[zecInvoice({ payee: { name: "Studio Example", address: UNIFIED.toUpperCase() } }), UNIFIED],
		[xmrInvoice(), XMR_PAYEE],
	]) {
		const link = buildPaymentLink(invoice);
		assert.equal(link.payee, canonical, `${invoice.asset}: the link exposes the canonical spelling its URI carries`);
		assert.equal(link.uri.includes(canonical), true, `${invoice.asset}: and the URI carries that same spelling`);
		const view = buildInvoiceViewModel(invoice, "2026-10-03");
		const paysTo = view.payment.filter((term) => term.label === view.labels.paysTo)[0];
		assert.equal(paysTo.value, canonical, `${invoice.asset}: the document draws the spelling the URI encodes`);
	}

	// The hand-built invoice is the case the field-and-link divergence needs: the model is the boundary that canonicalizes a field, so an invoice that skipped it reaches the document with whatever spelling its caller wrote — and the document still shows the one the link encodes.
	const handBuilt = { ...zecInvoice(), payee: { name: "Studio Example", address: UNIFIED.toUpperCase() } };
	assert.notEqual(handBuilt.payee.address, UNIFIED, "the hand-built field is not the canonical spelling");
	const view = buildInvoiceViewModel(handBuilt, "2026-10-03");
	assert.equal(view.paymentLink.startsWith(`zcash:${UNIFIED}?`), true, "the link carries the canonical payee");
	assert.equal(view.payment.filter((term) => term.label === view.labels.paysTo)[0].value, UNIFIED, "and the term beside it draws the same address");
});

test("every entry's own widest link is checked where the entry is admitted, and again where a share is handed out", () => {
	// The budget inside the builder refuses one link as it is built, which is too late to protect an admission: an entry whose chain id is long enough to outgrow the symbol satisfies every shape rule the registry applies, so the gate measures each entry's own widest link as the module loads — and the payee's form applies the same gate, so the refusal belongs to the share rather than to the payer's page. Where each gate sits is a property of the source, since no shipped entry can provoke the refusal, so those two positions are pinned as the source shape they are while the figures the gates measure are observed below.
	const links = readFileSync(join(root, "app", "ts", "payment", "links.ts"), "utf8");
	assert.match(links, /requireRegistryLinkBudgets\(/, "the link layer measures the registry's own entries as it loads");
	const create = readFileSync(join(root, "app", "ts", "ui", "create.ts"), "utf8");
	assert.match(create, /requireLinkBudget\(/, "and the create form reads that gate where the share is handed out");

	for (const asset of ASSETS) {
		assert.doesNotThrow(() => requireLinkBudget(asset), `${asset.id}: the shipped entry's widest link is inside the symbol`);
	}

	// The boundary is read off the scheme's own shape: 137 bytes of a native EIP-681 link are everything but the chain id, and 199 are everything but the chain id for a `transfer` call, so a chain id spelling 275 and 213 decimal digits respectively lands exactly on the 412-byte ceiling while its neighbour steps one byte over it.
	assert.equal(widestNativeUri(275).length, MAX_PAYMENT_LINK_BYTES, "the fixture at the boundary is the ceiling itself");
	assert.equal(widestNativeUri(276).length, MAX_PAYMENT_LINK_BYTES + 1, "and its neighbour is one byte past it");
	assert.equal(widestTokenUri(213).length, MAX_PAYMENT_LINK_BYTES);
	assert.equal(widestTokenUri(214).length, MAX_PAYMENT_LINK_BYTES + 1);
	assert.doesNotThrow(() => requireLinkBudget(chainIdOfDigits(275)), "an entry whose widest native link is the ceiling is admitted");
	const erc20 = (decimalDigits) => ({ ...chainIdOfDigits(decimalDigits), kind: "erc20", address: USDC });
	assert.doesNotThrow(() => requireLinkBudget(erc20(213)), "as is one whose widest transfer link is");
	for (const [asset, uri] of [[chainIdOfDigits(276), widestNativeUri(276)], [erc20(214), widestTokenUri(214)]]) {
		const error = refusal(() => requireLinkBudget(asset));
		assert.equal(error.message.startsWith("payment-link: "), true, error.message);
		assert.equal(error.message.includes(`${uri.length}-byte link`), true, error.message);
		assert.equal(error.message.includes(`${MAX_PAYMENT_LINK_BYTES}-byte ceiling`), true, error.message);
		assert.equal(error instanceof PaymentLinkBudgetError, true, "the gate refuses with the budget class rather than a bare Error");
		assert.equal(error.name, "PaymentLinkBudgetError");
		assert.equal(error instanceof PaymentLinkError, true, "which is still the link layer's own refusal, so one catch still covers the layer");
	}
});

test("the displayed payee address is the address the URI carries, whole, at the widest value each family accepts", () => {
	// The address term is the third of the display boundary's payment values: the link is re-measured in bytes and refused, and the address is held to the widest form any payout validator accepts and refused rather than run through the free-text clipper, whose answer to a value it cannot show whole is the value's prefix with `… (N characters)` appended — an address a payer copies as a payment that goes nowhere.
	for (const [invoice, address] of [
		[ethInvoice(), PAYEE],
		[zecInvoice({ payee: { name: "Studio Example", address: unifiedOfBytes(189) } }), unifiedOfBytes(189)],
		[xmrInvoice({ payee: { name: "Studio Example", address: widestMoneroAddress() } }), widestMoneroAddress()],
	]) {
		const link = buildPaymentLink(invoice);
		const model = buildInvoiceViewModel(invoice, "2026-10-03");
		const paysTo = model.payment.filter((term) => term.label === model.labels.paysTo)[0];
		assert.equal(paysTo.value, address, `${invoice.asset}: the widest accepted address is displayed whole`);
		assert.equal(paysTo.value, link.payee, `${invoice.asset}: and it is the address the URI beside it encodes`);
		assert.equal(link.uri.includes(paysTo.value), true, `${invoice.asset}: so the displayed address is a value the link carries`);
		assert.doesNotMatch(paysTo.value, /\(\d+ characters\)$/, `${invoice.asset}: and carries no clip's annotation`);
	}

	// Source-shape pin, kept because no address a validator accepts reaches the guard: the payment values a wallet takes verbatim are refused by their own fail-closed helpers rather than answered by the free-text clipper, and that is a statement about the code the refusal makes unreachable.
	const presentation = readFileSync(join(root, "app", "ts", "ui", "presentation.ts"), "utf8");
	assert.equal(/\bclip\(\s*link\.(?:uri|payee)\s*\)/.test(presentation), false, "no payment value goes through the free-text clipper");
});

test("the module exports its validated surface and no constructor for an unchecked pair", async () => {
	// The budget is applied inside `buildPaymentLink`, so a consumer cannot hand the module a scheme and a uri that disagree, nor a length nothing checked: the names a consumer resolves are exactly these.
	assert.deepEqual(Object.keys(await import("../app/js/payment/links.js")).sort(), ["MAX_PAYMENT_LINK_BYTES", "PaymentLinkBudgetError", "PaymentLinkError", "buildPaymentLink", "requireLinkBudget"]);
});

test("every link carries the invoice's own total in its family's spelling", () => {
	// A family's spelling is not interchangeable — a bare decimal for Zcash and Monero, the total in base units for Ethereum — while the Amount term displays that same bare decimal, the spelling a wallet's own amount field takes.
	for (const [invoice, linkEnding, displayedAmount] of [
		[zecInvoice(), "=1.23456789", "1.23456789"],
		[xmrInvoice(), "=0.000000000001", "0.000000000001"],
		[ethInvoice(), "=1500000000000000000", "1.5"],
		[tokenInvoice("usdc"), "=300000000", "300"],
		[tokenInvoice("usdt"), "=300000000", "300"],
	]) {
		// The expected endings are written out rather than recomputed from the builders: a spelling the builders shared would satisfy a recomputed expectation, and cannot satisfy these.
		assert.equal(buildPaymentLink(invoice).uri.endsWith(linkEnding), true, `${invoice.asset}'s link carries its recomputed total in its own family's spelling`);
		const view = buildInvoiceViewModel(invoice, "2026-10-03");
		const amountTerm = view.payment.filter((term) => term.label === view.labels.amount)[0];
		assert.ok(amountTerm !== undefined, `${invoice.asset}: the document states its own Amount term`);
		assert.equal(amountTerm.verbatim, true, `${invoice.asset}'s Amount term is marked as a value a wallet takes verbatim`);
		assert.equal(amountTerm.value, displayedAmount, `${invoice.asset}'s Amount term states the bare decimal its own link's amount field carries`);
	}
});
