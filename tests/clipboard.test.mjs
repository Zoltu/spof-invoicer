/** The suite for the clipboard module: that `app/js/ui/clipboard.js` stays a neutral helper the share panel re-exports and the payment panel uses directly. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { copyText } from "../app/js/ui/clipboard.js";
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
