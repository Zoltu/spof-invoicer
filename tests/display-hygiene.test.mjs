/** The suite for display hygiene: the stripping pass and the validator's refusals of control, line-separator, and direction-formatting code points across the view model, document, panel, and PDF. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeInvoice } from "../app/js/invoice/codec.js";
import { createInvoice } from "../app/js/invoice/model.js";
import { buildInvoicePages } from "../app/js/pdf/renderer.js";
import { openPayPanel } from "../app/js/ui/pay.js";
import { buildInvoiceViewModel } from "../app/js/ui/presentation.js";
import { renderInvoiceView } from "../app/js/ui/view.js";
import { base32nopad, utf8 } from "../app/js/util/encoding.js";
import { boundMessage } from "../app/js/util/errors.js";
import { MULTI_LINE_CONTROL, SINGLE_LINE_CONTROL, stripDisplayCharacters } from "../app/js/util/text.js";
import { installInteractiveDocument } from "./helpers/dom.mjs";
import { findAll, textOf } from "./helpers/tree.mjs";

const PAYEE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const VIEW_OPTIONS = { baseUrl: "https://example.com/app/", today: "2026-10-03", clipboard: null };

// Code points the validator deliberately leaves unrefused but every render surface must strip: the interlinear-annotation format characters and the Egyptian hieroglyph format controls.
const INVOICE_TEXT_STRIP = ["\uFFF9", "\uFFFA", "\uFFFB", "\u{13430}", "\u{1343F}"];

// A deterministic stand-in for embedded-font metrics, matching the PDF suite: every glyph is half the point size wide.
const METRICS = { widthOfText: (text, size) => text.length * size * 0.5 };

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

function hasClass(node, name) {
	return (node.attributes.class ?? "").split(/\s+/).includes(name);
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
	assert.equal(model.from.email, "billing@example.com", "the payee email is stripped too");
	assert.equal(model.billTo.name, "Client Co", "the payer name is stripped too");
	assert.equal(model.billTo.email, "payer@example.com", "the payer email is stripped too");
	assert.equal(model.tax.label, "VAT 19%", "the tax label is stripped too");
	assert.equal(model.lines[0].description, "Design");
	assert.deepEqual(model.notes, ["first line", "second line"], "the note's line structure survives the strip");
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
	assert.ok(!text.includes("?"), "no stripped code point was left to fold into a replacement glyph");
});
