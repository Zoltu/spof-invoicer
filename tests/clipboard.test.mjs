/** The suite for the clipboard module: that `app/js/ui/clipboard.js` stays a neutral helper the share panel re-exports, that a copy hands over the value byte for byte, that the fallback selects a value the user can copy by hand whichever element holds it, and that the status the seam reports in is declared as the members it reads rather than as an element. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { installDocument } from "./helpers/dom.mjs";
import { runTypeProbe } from "./helpers/type-probe.mjs";
import { nextTask } from "./helpers/wait.mjs";
import { copyText, copyWithFallback } from "../app/js/ui/clipboard.js";
import { copyText as copyTextFromShare } from "../app/js/ui/share.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the clipboard helper is a neutral module that ui/share.ts re-exports", () => {
	assert.equal(copyTextFromShare, copyText, "share re-exports the neutral helper rather than defining its own");
});

test("the payment panel relies on the neutral clipboard module, not the share panel", () => {
	const paySource = readFileSync(join(root, "app", "ts", "ui", "pay.ts"), "utf8");
	assert.match(paySource, /from "\.\/clipboard\.js"/, "ui/pay.ts imports the clipboard helper from the neutral module");
	assert.ok(!/from "\.\/share\.js"/.test(paySource), "ui/pay.ts must not import from ui/share.ts");
});

test("a copy hands the clipboard the value itself, text or field alike", async () => {
	const written = [];
	const status = { textContent: "" };
	const value = { tagName: "span", textContent: "zcash:u1example?amount=1.5" };
	copyWithFallback(value.textContent, { writeText: async (text) => written.push(text) }, value, status);
	await nextTask();

	assert.deepEqual(written, ["zcash:u1example?amount=1.5"], "the clipboard receives the value byte for byte, not a substring of the rendered page");
	assert.equal(status.textContent, "Copied", "and the control confirms the write");
});

test("the fallback selects a text value's contents, since there is no field to select", async () => {
	const selected = [];
	const ranges = [];
	const fake = installDocument({
		createRange() {
			return {
				selectNodeContents(element) {
					selected.push(element);
				},
			};
		},
		getSelection() {
			return {
				removeAllRanges() {},
				addRange(range) {
					ranges.push(range);
				},
			};
		},
	});
	try {
		const value = { tagName: "span", textContent: "zcash:u1example?amount=1.5" };
		const status = { textContent: "" };
		// A verbatim payment value is plain text, so it has no `select()` to call: the fallback reaches the document's own selection instead of leaving the user with nothing to copy by hand.
		copyWithFallback(value.textContent, null, value, status);
		await nextTask();

		assert.deepEqual(selected, [value], "the value's own contents are selected");
		assert.equal(ranges.length, 1, "through one range the document's selection holds");
		assert.equal(status.textContent, "Press Ctrl/Cmd+C to copy", "and the status points at text that is already selected");
	} finally {
		fake.restore();
	}
});

test("the fallback still selects a form control through its own method", async () => {
	// A control's value is not part of the document tree a range spans, so the fallback calls the control's own `select()`; this document offers no selection API at all, so a fallback that reached for one would fail here rather than quietly select nothing.
	const fake = installDocument({});
	try {
		let selected = 0;
		const field = {
			tagName: "input",
			select() {
				selected += 1;
			},
		};
		const status = { textContent: "" };
		copyWithFallback("0xabc", null, field, status);
		await nextTask();

		assert.equal(selected, 1, "the field is selected for a manual copy");
		assert.equal(status.textContent, "Press Ctrl/Cmd+C to copy", "and the status says so");
	} finally {
		fake.restore();
	}
});

test("the copy seam's status contract is the members it reads, so a plain object reports in it and one without text does not", () => {
	// The seam writes the confirmation into the status's text and reads whether it is still mounted, so those two members are the whole contract; the probe pins a plain object's acceptance and refuses one that cannot carry the text, where a parameter typed as an element would state a contract neither the guard nor the tests hold.
	runTypeProbe({
		prefix: "invoice-clipboard-status-probe-",
		fileName: "clipboard-status.ts",
		failureMessage: "the type probe must compile cleanly under the project's own configuration, so a plain object is accepted as the copy seam's status while one that cannot carry the confirmation's text is refused",
		source: (specifier) => `/** The compile-time probe for the copy seam's status contract, compiled by tests/clipboard.test.mjs under the project's own tsconfig. */
import { copyWithFallback, type CopyStatus } from "${specifier("app/ts/ui/clipboard.js")}";
import { copyControlClick } from "${specifier("app/ts/ui/payment-section.js")}";

declare const value: HTMLElement;

const status: CopyStatus = { textContent: "" };
const detached: CopyStatus = { textContent: "", isConnected: false };

copyWithFallback("zcash:u1example", null, value, status);
copyControlClick("zcash:u1example", null, value, detached, { after: () => () => {} });

// @ts-expect-error a status that cannot carry the confirmation's text is not one this seam writes into
const silent: CopyStatus = { isConnected: true };
`,
	});
});
