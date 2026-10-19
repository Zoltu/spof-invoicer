/** The suite for display hygiene: the stripping pass across the view model, document, panel, and PDF, and the bound each displayed value — a payment-details term or a party's contact lines — is clipped to, the validator's refusals of control, line-separator, and direction-formatting code points included. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SUPPORTED_CHAIN_IDS, isCanonicalEvmChainId } from "../app/js/assets/registry.js";
import { decodeInvoice } from "../app/js/invoice/codec.js";
import {
	MAX_CONTACT_CHARS,
	MAX_CONTACT_LINE_CHARS,
	MAX_CONTACT_LINES,
	MAX_EMAIL_CHARS,
	createInvoice,
} from "../app/js/invoice/model.js";
import { MAX_PAYMENT_LINK_BYTES, buildPaymentLink } from "../app/js/payment/links.js";
import { buildInvoicePages } from "../app/js/pdf/renderer.js";
import { chainName, networkLabel } from "../app/js/ui/network-labels.js";
import { openPayPanel } from "../app/js/ui/pay.js";
import { buildInvoiceViewModel } from "../app/js/ui/presentation.js";
import { renderInvoiceView } from "../app/js/ui/view.js";
import { base32nopad, base58xmr, keccak256, utf8 } from "../app/js/util/encoding.js";
import { boundMessage } from "../app/js/util/errors.js";
import { MULTI_LINE_CONTROL, SINGLE_LINE_CONTROL, stripDisplayCharacters } from "../app/js/util/text.js";
import { MAX_EVM_ADDRESS_LENGTH } from "../app/js/wallet/address.js";
import { MAX_MONERO_ADDRESS_LENGTH } from "../app/js/wallet/monero-address.js";
import { MAX_PAYOUT_ADDRESS_LENGTH } from "../app/js/wallet/payout-address.js";
import { MAX_ZCASH_ADDRESS_LENGTH } from "../app/js/wallet/zcash-address.js";
import { installInteractiveDocument } from "./helpers/dom.mjs";
import { findAll, hasClass, textOf } from "./helpers/tree.mjs";
import { unifiedOfBytes } from "./helpers/unified-address.mjs";

const PAYEE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
/**
 * The render options every case in this suite builds on: a renderer requires the release of what it subscribed to, and the cases that hold one override this placeholder with their own.
 */
const VIEW_OPTIONS = { baseUrl: "https://example.com/app/", today: "2026-10-03", clipboard: null, onRelease: () => {} };

// Code points the validator deliberately leaves unrefused but every render surface must strip: the interlinear-annotation format characters and the Egyptian hieroglyph format controls.
const INVOICE_TEXT_STRIP = ["\uFFF9", "\uFFFA", "\uFFFB", "\u{13430}", "\u{1343F}"];

// A deterministic stand-in for embedded-font metrics, matching the PDF suite: every glyph is half the point size wide.
const METRICS = { widthOfText: (text, size) => text.length * size * 0.5 };

// The two Zcash bounds the fixtures below read: the unified container the validator decodes under its longest bound, and the mainnet integrated Monero encoding, which is the widest form that family takes.
const UNIFIED_PAYLOAD_BYTES = 189;
const INTEGRATED_MONERO_BYTES = 77;
const MONERO_CHECKSUM_BYTES = 4;

function invoiceFor(overrides = {}) {
	return createInvoice({
		id: "INV-1",
		issued: "2026-10-03",
		payee: { name: "Studio Example", address: PAYEE },
		chainId: "0x1",
		asset: "usdc",
		items: [{ description: "Design work", quantity: "2", unitPrice: "150" }],
		...overrides,
	});
}

function noticeRecorder() {
	const calls = [];
	return {
		calls,
		showNotice(message, tone) {
			calls.push({ message, tone });
		},
		clearNotice() {
			calls.push(null);
		},
	};
}

/**
 * A mainnet Monero integrated address — the widest address that family accepts — built the way the validator reads one: the `0x13` mainnet prefix, a 77-byte body, and the four-byte Keccak-256 checksum over everything before them, in Monero's block-padded base58.
 * The body is deterministic filler, because what the validator checks is the prefix, the encoding length, and the checksum; no key material is read and none is certified.
 */
function widestMoneroAddress() {
	const body = new Uint8Array(INTEGRATED_MONERO_BYTES - MONERO_CHECKSUM_BYTES);
	body[0] = 0x13;
	for (let index = 1; index < body.length; index += 1) body[index] = (index * 7) & 0xff;
	const encoding = new Uint8Array(INTEGRATED_MONERO_BYTES);
	encoding.set(body);
	encoding.set(keccak256(body).subarray(0, MONERO_CHECKSUM_BYTES), body.length);
	return base58xmr.encode(encoding);
}

/** The text the PDF text path draws, read from the pure layout so no font is embedded. */
function pdfTextOf(view) {
	return buildInvoicePages(view, METRICS)
		.flatMap((page) => page.ops.filter((op) => op.kind === "text").map((op) => op.text))
		.join("\n");
}

test("the control classes and the display strip cover the C1 block", () => {
	for (const code of [0x80, 0x84, 0x85, 0x9f]) {
		const character = String.fromCodePoint(code);
		assert.ok(SINGLE_LINE_CONTROL.test(character), `U+${code.toString(16)} must be refused in a single-line field`);
		assert.ok(MULTI_LINE_CONTROL.test(character), `U+${code.toString(16)} must be refused in a multi-line field`);
		assert.equal(stripDisplayCharacters(`a${character}b`), "ab", `U+${code.toString(16)} must be stripped when shown`);
	}
});

test("the display strip removes the ranges the invoice validator leaves unrefused", () => {
	for (const code of [0xfff9, 0xfffb, 0x13430, 0x1343f]) {
		assert.equal(stripDisplayCharacters(`a${String.fromCodePoint(code)}b`), "ab", `U+${code.toString(16)} must be stripped`);
	}
	assert.equal(stripDisplayCharacters("a\u0600b"), "a\u0600b", "a Prepended_Concatenation_Mark is a rendered character and stays");
});

test("the invoice validator refuses the C1 block in single-line and multi-line fields", () => {
	assert.throws(() => invoiceFor({ id: "INV\u00851" }), /id: must not contain control characters/);
	assert.throws(
		() => invoiceFor({ payee: { name: "Ac\u0080me", address: PAYEE } }),
		/payee\.name: must not contain control characters/,
	);
	assert.throws(
		() => invoiceFor({ notes: "line\u0085line" }),
		/notes: must not contain control characters other than newlines and tabs/,
	);
});

test("the invoice validator refuses the line and paragraph separators in multi-line fields too", () => {
	assert.throws(
		() => invoiceFor({ notes: "one\u2028two" }),
		/notes: must not contain control characters other than newlines and tabs/,
		"a line separator is refused in a multi-line field, not silently stripped later",
	);
	assert.throws(
		() => invoiceFor({ notes: "one\u2029two" }),
		/notes: must not contain control characters other than newlines and tabs/,
		"a paragraph separator is refused in a multi-line field too",
	);
	assert.equal(
		invoiceFor({ notes: "one\ntwo\tthree" }).notes,
		"one\ntwo\tthree",
		"the LF and tab the multi-line renderer splits on are still permitted",
	);
});

test("the invoice validator refuses a lone surrogate and keeps a well-formed pair", () => {
	assert.throws(() => invoiceFor({ id: "INV\uD800" }), /id: must not contain lone surrogate code units/);
	assert.throws(() => invoiceFor({ id: "INV\uDC00" }), /id: must not contain lone surrogate code units/);
	assert.throws(
		() => invoiceFor({ payee: { name: "Ana\uD83D", address: PAYEE } }),
		/payee\.name: must not contain lone surrogate code units/,
	);
	const emoji = invoiceFor({ payee: { name: "Ana \u{1F600}", address: PAYEE } });
	assert.equal(emoji.payee.name, "Ana \u{1F600}", "a valid surrogate pair is ordinary text");
});

test("a decoded payload cannot carry a lone surrogate past validation", () => {
	const json = `{"v":1,"t":"invoice","id":"INV\\ud800","issued":"2026-10-03","payee":{"name":"X","address":"${PAYEE}"},"chainId":"0x1","asset":"usdc","items":[{"description":"d","quantity":"1","unitPrice":"1"}]}`;
	const payload = base32nopad.encode(utf8.decode(json));
	assert.throws(() => decodeInvoice(payload), /id: must not contain lone surrogate code units/);
});

test("boundMessage truncates without leaving a lone surrogate", () => {
	const pair = `${"a".repeat(3)}\u{1F600}tail`;
	assert.equal(boundMessage(pair, 100), pair, "a message within the bound is unchanged");
	const cut = boundMessage(pair, 4);
	assert.ok(!/[\uD800-\uDBFF]/.test(cut), "no lone high surrogate survives the cut");
	assert.ok(cut.startsWith("aaa"), cut);
	assert.ok(cut.endsWith(`(${pair.length} characters)`), cut);
});

test("the view model passes every clipped field through the display strip", () => {
	const invoice = invoiceFor({
		id: "INV\uFFF91",
		payee: { name: "Ana\u{13430}Example", address: PAYEE, email: "bill\uFFF9ing@example.com" },
		payer: { name: "Cli\uFFFAent Co", email: "pay\u{13430}er@example.com" },
		tax: { label: "V\uFFFBAT 19%", rate: "19" },
		items: [{ description: "De\uFFFBsign", quantity: "1", unitPrice: "1" }],
		notes: "first\uFFF9 line\nsecond line",
	});
	const model = buildInvoiceViewModel(invoice, "2026-10-03");
	assert.equal(model.documentNumber, "#INV1");
	assert.equal(model.from.name, "AnaExample");
	assert.deepEqual(model.from.email, ["billing@example.com"], "the payee's contact line is stripped whole");
	assert.equal(model.billTo.name, "Client Co", "the payer name is stripped too");
	assert.deepEqual(model.billTo.email, ["payer@example.com"], "the payer's contact line is stripped whole");
	assert.equal(model.tax.label, "VAT 19%", "the tax label is stripped too");
	assert.equal(model.lines[0].description, "Design");
	assert.deepEqual(model.notes, ["first line", "second line"], "the note's line structure survives the strip");
});

/** Every string the view model hands a renderer, labelled by where it is displayed. */
function displayedStrings(model) {
	const entries = [
		["documentNumber", model.documentNumber],
		["from.name", model.from.name],
		["from.email", model.from.email],
		["billTo.name", model.billTo === null ? undefined : model.billTo.name],
		["billTo.email", model.billTo === null ? undefined : model.billTo.email],
		["dates", model.dates.map((date) => date.value)],
		["lines", model.lines.flatMap((line) => [line.description, line.unitPrice, line.amount])],
		["subtotal", model.subtotal],
		["tax.label", model.tax === null ? undefined : model.tax.label],
		["tax.value", model.tax === null ? undefined : model.tax.value],
		["total", model.total],
		["notes", model.notes],
		["payment", model.payment.map((term) => term.value)],
	];
	const flat = [];
	for (const [where, value] of entries) {
		if (Array.isArray(value)) value.forEach((entry, index) => flat.push([`${where}[${index}]`, entry]));
		else if (typeof value === "string") flat.push([where, value]);
	}
	return flat;
}

// Each payment-details term's own clip bound, recomputed here from the source that owns it — the link layer's byte ceiling, the widest address any payout family admits, and the longest network label the supported networks spell — rather than read off the view model, so a term bounded by another value's figure fails the case below.
const MAX_PAYMENT_NETWORK_CHARS = Math.max(...SUPPORTED_CHAIN_IDS.map((chainId) => networkLabel(chainId).length));

test("the payment details pass their values through the clip boundary every other displayed field uses", () => {
	// The payee is the widest address any payout family admits, so the address term is exercised at a length its own bound has to carry rather than at one every candidate bound would leave untouched.
	const address = unifiedOfBytes(UNIFIED_PAYLOAD_BYTES);
	assert.equal(address.length, MAX_ZCASH_ADDRESS_LENGTH, "the fixture is the widest address the payout validators accept");
	const invoice = invoiceFor({
		due: "2026-11-02",
		payee: { name: "Studio Example", address },
		chainId: "zcash",
		asset: "zec",
	});
	const model = buildInvoiceViewModel(invoice, "2026-10-03");
	const link = buildPaymentLink(invoice);
	assert.equal(model.paymentLink, link.uri, "the view model states that URI by name, so the case below reads it rather than a term's position");
	// The network, the payee address, and the link are invoice-derived display strings like any other, so each is the same clip bound and strip the module applies to a name or a description — each under its own value's bound, never one figure borrowed from another layer.
	for (const [index, label, raw, bound] of [
		[1, "Network", networkLabel(invoice.chainId), MAX_PAYMENT_NETWORK_CHARS],
		[2, "Pays to", address, MAX_PAYOUT_ADDRESS_LENGTH],
		[4, "Payment link", model.paymentLink, MAX_PAYMENT_LINK_BYTES],
	]) {
		assert.equal(model.payment[index].label, label);
		assert.equal(
			model.payment[index].value,
			stripDisplayCharacters(boundMessage(raw, bound)),
			`${label}: the displayed value is not the clip boundary's own output for the value under its own bound`,
		);
	}
	assert.equal(model.payment[2].value, address, "the widest accepted address is displayed whole rather than truncated");
});

test("the payment details show the widest address each payout family accepts, whole", () => {
	// The bound the section clips an address to is the payout dispatcher's own maximum across the families, so no family's longest accepted address is truncated on screen or in the PDF: each fixture here is the widest that family's validator takes, and each reaches the displayed term through a real invoice — which is itself the validator's acceptance of it.
	const zcashAddress = unifiedOfBytes(UNIFIED_PAYLOAD_BYTES);
	const moneroAddress = widestMoneroAddress();
	assert.equal(PAYEE.length, MAX_EVM_ADDRESS_LENGTH, "the EVM fixture is the one length every EVM payee has");
	assert.equal(zcashAddress.length, MAX_ZCASH_ADDRESS_LENGTH, "the Zcash fixture is the widest form its validator accepts");
	assert.equal(moneroAddress.length, MAX_MONERO_ADDRESS_LENGTH, "the Monero fixture is the widest form its validator accepts");
	assert.equal(
		Math.max(PAYEE.length, zcashAddress.length, moneroAddress.length),
		MAX_PAYOUT_ADDRESS_LENGTH,
		"and the display cap is the widest of them, not one family's constant",
	);

	for (const [invoice, address] of [
		[invoiceFor(), PAYEE],
		[invoiceFor({ chainId: "zcash", asset: "zec", payee: { name: "Studio Example", address: zcashAddress } }), zcashAddress],
		[invoiceFor({ chainId: "monero", asset: "xmr", payee: { name: "Studio Example", address: moneroAddress } }), moneroAddress],
	]) {
		const model = buildInvoiceViewModel(invoice, "2026-10-03");
		assert.equal(model.payment[2].value, address, `${invoice.asset}: the widest accepted address is displayed whole`);
	}
});

test("the payer-visible network label has one spelling, shared by every surface that names a network", () => {
	// The document's Payment details term, the payment panel's summary, and the payment flow's guidance all read this one helper, so none of them can describe a network differently.
	// The registry id is one a wallet shows only for an EVM chain, so it is carried beside that chain's name alone: a privacy chain's id is this app's own slug for it.
	for (const chainId of SUPPORTED_CHAIN_IDS) {
		const expected = isCanonicalEvmChainId(chainId) ? `${chainName(chainId)} (${chainId})` : chainName(chainId);
		assert.equal(networkLabel(chainId), expected, `${chainId} is named by its friendly name, with its id only where a wallet reads one`);
	}
	assert.equal(networkLabel("0x1"), "Ethereum (0x1)");
	assert.equal(networkLabel("zcash"), "Zcash", "a privacy chain renders under its name alone, with no id suffix");
	assert.equal(networkLabel("monero"), "Monero", "and the same for the other privacy chain");
	assert.equal(networkLabel("0x89"), "0x89", "a network the display map does not name falls back to its bare id");
	assert.equal(networkLabel("constructor"), "constructor", "an inherited prototype member is not read as a chain name");

	const fake = installInteractiveDocument();
	try {
		const handle = openPayPanel(invoiceFor(), { notice: noticeRecorder(), clipboard: null });
		assert.ok(handle, "the panel opens");
		const dialog = findAll(handle.element, (node) => hasClass(node, "pay-dialog"))[0];
		assert.ok(dialog, "the panel renders its dialog");
		assert.ok(textOf(dialog).includes(networkLabel("0x1")), "the panel's summary names the network in the same spelling");
	} finally {
		fake.restore();
	}
});

test("every string the view model displays is free of unshown code points, the payment details included", () => {
	const invoice = invoiceFor({
		id: "INV\uFFF91",
		payee: { name: "Ana\u{13430}Example", address: PAYEE, email: "bill\uFFF9ing@example.com" },
		payer: { name: "Cli\uFFFAent Co", email: "pay\u{13430}er@example.com" },
		tax: { label: "V\uFFFBAT 19%", rate: "19" },
		items: [{ description: "De\uFFFBsign", quantity: "1", unitPrice: "1" }],
		notes: "first\uFFF9 line\nsecond line",
	});
	const model = buildInvoiceViewModel(invoice, "2026-10-03");
	for (const [where, value] of displayedStrings(model)) {
		assert.equal(value, stripDisplayCharacters(value), `${where} carries a code point the display strip removes: ${JSON.stringify(value)}`);
	}
});

test("the invoice view strips unshown code points from the document it renders", () => {
	const fake = installInteractiveDocument();
	try {
		const invoice = invoiceFor({
			payee: { name: "Studio\uFFF9Example", address: PAYEE },
			items: [{ description: "De\u{13430}sign", quantity: "1", unitPrice: "1" }],
			notes: "one\ntwo",
		});
		const view = renderInvoiceView(invoice, { ...VIEW_OPTIONS, notice: noticeRecorder() });
		const text = textOf(view);
		assert.ok(text.includes("StudioExample"), "the readable characters survive");
		assert.ok(text.includes("Design"));
		for (const character of INVOICE_TEXT_STRIP) {
			assert.ok(!text.includes(character), `U+${character.codePointAt(0).toString(16)} reached the document`);
		}
	} finally {
		fake.restore();
	}
});

test("the payment dialog strips unshown code points from the invoice id in its title and aria-label", () => {
	const fake = installInteractiveDocument();
	try {
		const invoice = invoiceFor({ id: "INV\uFFF91\u{13430}" });
		const handle = openPayPanel(invoice, { notice: noticeRecorder(), clipboard: null });
		assert.ok(handle, "the panel opens");
		const dialog = findAll(handle.element, (node) => hasClass(node, "pay-dialog"))[0];
		assert.ok(dialog, "the panel renders its dialog");
		const title = findAll(dialog, (node) => hasClass(node, "dialog-title"))[0];
		assert.equal(textOf(title), "Pay invoice INV1", "the visible title shows the stripped id");
		assert.equal(dialog.attributes["aria-label"], "Pay invoice INV1", "the aria-label shows the stripped id too");
		for (const character of INVOICE_TEXT_STRIP) {
			assert.ok(!textOf(dialog).includes(character), `U+${character.codePointAt(0).toString(16)} reached the dialog text`);
			assert.ok(
				!dialog.attributes["aria-label"].includes(character),
				`U+${character.codePointAt(0).toString(16)} reached the dialog aria-label`,
			);
		}
	} finally {
		fake.restore();
	}
});

test("the PDF text path draws the stripped invoice text", () => {
	const invoice = invoiceFor({
		id: "INV\uFFF91",
		payee: { name: "Studio\uFFF9Example", address: PAYEE, email: "bill\uFFF9ing@example.com" },
		payer: { name: "Cli\uFFFAent Co" },
		tax: { label: "V\uFFFBAT 19%", rate: "19" },
		items: [{ description: "De\u{13430}sign", quantity: "1", unitPrice: "1" }],
		notes: "first\uFFFB line",
	});
	const text = pdfTextOf(buildInvoiceViewModel(invoice, "2026-10-03"));
	assert.ok(text.includes("StudioExample"), "the readable party name survives into the PDF");
	assert.ok(text.includes("Design"), "the readable description survives into the PDF");
	for (const character of INVOICE_TEXT_STRIP) {
		assert.ok(!text.includes(character), `U+${character.codePointAt(0).toString(16)} reached the PDF text path`);
	}
	// The payment link carries the query separator `?` of its own scheme, so exactly that many question marks are expected: any other would be a code point folded into a replacement glyph.
	assert.equal(text.split("?").length - 1, 1, "no stripped code point was left to fold into a replacement glyph");
});

test("the PDF draws a stored contact line exactly as the model stored it", () => {
	// The page and the PDF both draw the view model's contact lines, and the validator stores the canonical contact text, so the PDF's fitted run carries the stored value rather than a stripped second spelling of it.
	const contact = "Stüdió — Café\n+44 20 7946 0000\n12 Rue de l'Exemple, Paris";
	const invoice = invoiceFor({ payee: { name: "Studio Example", address: PAYEE, email: contact } });
	assert.equal(invoice.payee.email, contact, "the stored contact value is the one the form submitted");
	const drawn = pdfTextOf(buildInvoiceViewModel(invoice, "2026-10-03"));
	for (const line of invoice.payee.email.split("\n")) {
		assert.ok(drawn.includes(line), `the PDF loses the stored contact line ${JSON.stringify(line)}`);
	}
});

test("a contact value's own spacing is drawn the same by the document and by the export", () => {
	// The page and the print twin are one element under `invoice.css`'s own declaration for the contact lines (asserted in the view suite), and the export draws each stored line literally, so a run of spaces and the space a line opens with have to reach both surfaces as the characters the model stored rather than as a collapsed rendering of them.
	const contact = "12  Example  Street\n  Accounts\n+44 20 7946 0000";
	const invoice = invoiceFor({ payee: { name: "Studio Example", address: PAYEE, email: contact } });
	const model = buildInvoiceViewModel(invoice, VIEW_OPTIONS.today);
	const lines = model.from.email;
	assert.deepEqual(lines, contact.split("\n"), "the view model holds the stored lines");
	assert.ok(lines.some((line) => line.includes("  ")), "the fixture carries a run of spaces for the assertions below to be about");
	assert.ok(lines.some((line) => line.startsWith(" ")), "and a line a space opens");

	const drawn = buildInvoicePages(model, METRICS).flatMap((page) => page.ops.filter((op) => op.kind === "text").map((op) => op.text));
	for (const line of lines) {
		assert.ok(drawn.includes(line), `the export draws ${JSON.stringify(line)} as one run of the line's own characters`);
	}

	const fake = installInteractiveDocument();
	try {
		const view = renderInvoiceView(invoice, { ...VIEW_OPTIONS, notice: noticeRecorder() });
		assert.deepEqual(
			findAll(view, (node) => hasClass(node, "party-detail")).map((node) => textOf(node)),
			lines,
			"and the document hands the block that preserves those characters the same lines",
		);
	} finally {
		fake.restore();
	}
});

test("a contact value the validator accepts is displayed whole, at the widest bound the field's shapes admit", () => {
	// The module's rule for every clip cap: it is the widest legal form of the value it bounds. A contact value is free text the model bounds by lines and by a total, or the single-line legacy email spelling, so the two fixtures below fill each shape to its own bound, and every line of them has to reach the view model as the validator stored it — the bound the page, the print twin, and the PDF all draw through.
	const legacyEmail = `${"m".repeat(MAX_EMAIL_CHARS - "@example.com".length)}@example.com`;
	const freeText = Array.from({ length: MAX_CONTACT_LINES }, () => "m".repeat(MAX_CONTACT_LINE_CHARS)).join("\n");
	assert.equal(legacyEmail.length, MAX_EMAIL_CHARS, "the legacy fixture is a single-line address at exactly the legacy cap");
	assert.equal(freeText.length, MAX_CONTACT_CHARS, "the free-text fixture fills every line the model allows, its line breaks counted");

	for (const contact of [legacyEmail, freeText]) {
		const invoice = invoiceFor({ payee: { name: "Studio Example", address: PAYEE, email: contact } });
		assert.equal(invoice.payee.email, contact, "the validator accepts the fixture as one of the field's widest legal shapes");
		const lines = contact.split("\n");
		assert.deepEqual(
			buildInvoiceViewModel(invoice, VIEW_OPTIONS.today).from.email,
			lines,
			"every stored line reaches the view model whole, with nothing cut and no clip annotation on it",
		);

		const fake = installInteractiveDocument();
		try {
			const view = renderInvoiceView(invoice, { ...VIEW_OPTIONS, notice: noticeRecorder() });
			const payee = findAll(view, (node) => hasClass(node, "party-payee"))[0];
			assert.deepEqual(
				findAll(payee, (node) => hasClass(node, "party-detail")).map((node) => textOf(node)),
				lines,
				"and the document, the print twin with it, draws those same lines rather than a clipped prefix",
			);
		} finally {
			fake.restore();
		}
	}
});
