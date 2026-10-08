/** The suite for the util modules: decimal and base-unit conversion, the DOM helpers, error descriptions, and text bounding. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { fromBaseUnits, toBaseUnits, UINT256_MAX } from "../app/js/util/decimal.js";
import { append, h, safeUrl } from "../app/js/util/dom.js";
import { describe, preview } from "../app/js/util/errors.js";
import { boundRaw } from "../app/js/util/text.js";
import { installFakeDocument } from "./helpers/dom.mjs";

const EIGHTEEN = 10n ** 18n;

test("toBaseUnits scales a decimal string by the asset's decimals", () => {
	assert.equal(toBaseUnits("1.5", 6), 1500000n);
	assert.equal(toBaseUnits("1", 18), EIGHTEEN, "1 ETH -> 1000000000000000000 wei");
	assert.equal(toBaseUnits("1.000001", 6), 1000001n);
	assert.equal(toBaseUnits("0.000001", 6), 1n);
	assert.equal(toBaseUnits("0.5", 6), 500000n);
	assert.equal(toBaseUnits("123456789.123456", 6), 123456789123456n);
	assert.equal(toBaseUnits("3", 0), 3n, "a decimals-0 asset accepts integer quantities");
	assert.equal(toBaseUnits("1", 77), 10n ** 77n, "high-decimal values stay exact up to the uint256 cap");
	assert.equal(toBaseUnits("7", 6), 7000000n);
});

test("toBaseUnits rejects over-precision, zero, and non-canonical input", () => {
	assert.throws(() => toBaseUnits("1.2345678", 6), /has 7 decimal places but the asset allows 6/);
	assert.throws(() => toBaseUnits("0.1", 0), /has 1 decimal places but the asset allows 0/);
	assert.throws(() => toBaseUnits("0", 6), /is zero/);
	assert.throws(() => toBaseUnits("0.00", 6), /is zero/);
	assert.throws(() => toBaseUnits("-1", 18), /is not a plain decimal amount/);
	assert.throws(() => toBaseUnits("+1", 18), /is not a plain decimal amount/);
	assert.throws(() => toBaseUnits("1e3", 18), /is not a plain decimal amount/);
	assert.throws(() => toBaseUnits("007", 18), /is not a plain decimal amount/);
	assert.throws(() => toBaseUnits("1.", 18), /is not a plain decimal amount/);
	assert.throws(() => toBaseUnits(".5", 18), /is not a plain decimal amount/);
	assert.throws(() => toBaseUnits(" 1", 18), /is not a plain decimal amount/);
	assert.throws(() => toBaseUnits("1,5", 18), /is not a plain decimal amount/);
	assert.throws(() => toBaseUnits("", 18), /is not a plain decimal amount/);
	assert.throws(() => toBaseUnits("1", 18.5), /decimals must be an integer/);
	assert.throws(() => toBaseUnits("1", -1), /decimals must be an integer/);
	assert.throws(() => toBaseUnits("1", 256), /decimals must be an integer/);
});

test("toBaseUnits accepts exactly uint256 max and rejects anything above it", () => {
	assert.equal(toBaseUnits(UINT256_MAX.toString(), 0), UINT256_MAX);
	assert.throws(
		() => toBaseUnits((UINT256_MAX + 1n).toString(), 0),
		/exceeds the uint256 base-unit maximum/,
	);
	assert.throws(() => toBaseUnits("1", 78), /exceeds the uint256 base-unit maximum/);
	assert.throws(() => toBaseUnits("1", 255), /exceeds the uint256 base-unit maximum/);
});

test("toBaseUnits caps the whole-part length before converting to BigInt", () => {
	assert.equal(UINT256_MAX.toString().length, 78, "the cap is the length of uint256 max");
	assert.throws(() => toBaseUnits("1".repeat(79), 0), /exceeds the uint256 base-unit maximum/);
	assert.throws(() => toBaseUnits(`${"9".repeat(200)}.0`, 6), /exceeds the uint256 base-unit maximum/);
	assert.throws(() => toBaseUnits("1".repeat(10_000), 18), /exceeds the uint256 base-unit maximum/);
});

test("fromBaseUnits formats the shortest exact decimal string", () => {
	assert.equal(fromBaseUnits(1500000n, 6), "1.5");
	assert.equal(fromBaseUnits(EIGHTEEN, 18), "1");
	assert.equal(fromBaseUnits(0n, 6), "0");
	assert.equal(fromBaseUnits(1n, 6), "0.000001");
	assert.equal(fromBaseUnits(1n, 18), "0.000000000000000001");
	assert.equal(fromBaseUnits(123456789n, 8), "1.23456789");
	assert.equal(fromBaseUnits(1000n, 3), "1", "trailing fractional zeros are dropped");
	assert.equal(fromBaseUnits(1000000n, 3), "1000");
});

test("fromBaseUnits rejects negative and non-bigint input", () => {
	assert.throws(() => fromBaseUnits(-1n, 6), /units must not be negative/);
	assert.throws(() => fromBaseUnits(1, 6), /units must be a bigint, got 1/);
	assert.throws(() => fromBaseUnits("1", 6), /units must be a bigint, got "1"/);
	assert.throws(() => fromBaseUnits(1n, 18.5), /decimals must be an integer/);
});

test("parse and format round-trip for 0-, 6-, and 18-decimal assets", () => {
	const cases = [
		[0, [1n, 3n, 1000n]],
		[6, [1n, 500000n, 1500000n, 999999n, 123456789123456n]],
		[18, [1n, EIGHTEEN, 1500000000000000000n, EIGHTEEN * 42n + 7n]],
	];
	for (const [decimals, units] of cases) {
		for (const unit of units) {
			assert.equal(toBaseUnits(fromBaseUnits(unit, decimals), decimals), unit);
		}
	}
});

test("the round-trip invariant holds exactly for 0 < units <= uint256 max", () => {
	for (const decimals of [0, 6, 18]) {
		assert.equal(toBaseUnits(fromBaseUnits(1n, decimals), decimals), 1n);
		assert.equal(
			toBaseUnits(fromBaseUnits(UINT256_MAX, decimals), decimals),
			UINT256_MAX,
			`uint256 max round-trips through ${decimals} decimals`,
		);
	}
	assert.equal(fromBaseUnits(0n, 6), "0", "zero formats…");
	assert.throws(
		() => toBaseUnits(fromBaseUnits(0n, 6), 6),
		/is zero/,
		"…but throws as zero on the way back",
	);
	const aboveCap = fromBaseUnits(UINT256_MAX + 1n, 6);
	assert.equal(typeof aboveCap, "string", "above the cap, fromBaseUnits still formats…");
	assert.throws(
		() => toBaseUnits(aboveCap, 6),
		/exceeds the uint256 base-unit maximum/,
		"…but throws as too large on the way back",
	);
});

test("describe renders any rejected value without throwing", () => {
	assert.equal(describe("x"), "\"x\"");
	assert.equal(describe(""), "\"\"");
	assert.equal(describe(null), "null");
	assert.equal(describe(undefined), "undefined");
	assert.equal(describe(42), "42");
	assert.equal(describe(Object.create(null)), "[unprintable]", "no primitive conversion");
	assert.equal(
		describe({ toString() { throw new Error("hostile"); } }),
		"[unprintable]",
		"a throwing toString cannot mask the rejection",
	);
});

test("boundRaw truncates to whole code units without leaving a lone surrogate", () => {
	assert.equal(boundRaw("abcdef", 6), "abcdef", "a string within the bound is unchanged");
	assert.equal(boundRaw("abcdef", 3), "abc");
	// An emoji is a surrogate pair; a cut between its two units would leave the high surrogate alone.
	const pair = `${"a".repeat(3)}\u{1F600}tail`;
	assert.equal(boundRaw(pair, 4), "aaa", "the high surrogate of a split pair is dropped, not left alone");
	assert.doesNotMatch(boundRaw(pair, 4), /[\uD800-\uDBFF]/, "no lone high surrogate survives the bound");
	assert.equal(boundRaw(pair, 5), `aaa\u{1F600}`, "a bound that fits the whole pair keeps it");
});

test("preview bounds a long string before it is rendered", () => {
	const long = "x".repeat(1000);
	const rendered = preview(long, 60);
	assert.ok(rendered.length < 120, `the preview stays bounded, got ${rendered.length} characters`);
	assert.match(rendered, /1000 characters/);
	assert.ok(!rendered.includes("x".repeat(100)), "the raw string is not carried into the preview whole");
	assert.equal(preview("x"), "\"x\"", "a short string still renders exactly as describe does");
});

test("preview cuts the escaped rendering without leaving a lone surrogate", () => {
	// The escaped rendering wraps the value in quotes, two characters more than the raw value, so fifty-eight ASCII characters push the cut inside the emoji's surrogate pair.
	const value = `${"a".repeat(58)}\u{1F600}tail`;
	const bounded = preview(value, 60);
	assert.ok(!/[\uD800-\uDFFF]/.test(bounded), `a lone surrogate survived: ${JSON.stringify(bounded)}`);
	assert.ok(bounded.startsWith(`"${"a".repeat(58)}`), bounded);
	assert.match(bounded, /\(64 characters\)$/);
});

test("h builds elements from attributes and text children", () => {
	const fake = installFakeDocument();
	try {
		const element = h(
			"span",
			{ class: "amount", hidden: false, disabled: true, title: null },
			"1.5",
			" USDC",
			null,
			undefined,
			false,
			7,
		);
		assert.equal(element.tagName, "span");
		assert.deepEqual(element.attributes, { class: "amount", disabled: "" });
		assert.deepEqual(
			element.children,
			["1.5", " USDC", "7"],
			"strings and numbers stay text; false/null/undefined are skipped",
		);
	} finally {
		fake.restore();
	}
});

test("h refuses to build a script-bearing element", () => {
	const fake = installFakeDocument();
	try {
		assert.throws(
			() => h("script", {}, "alert(1)"),
			/refusing to build a <script> element/,
			"h must never construct a script element, even from a string child",
		);
	} finally {
		fake.restore();
	}
});

test("h refuses attributes outside the allow-list", () => {
	const fake = installFakeDocument();
	try {
		for (const attributes of [
			{ onclick: "alert(1)" },
			{ onmouseover: "alert(1)" },
			{ src: "logo.svg" },
			{ srcdoc: "<script>alert(1)</script>" },
			{ style: "color:red" },
			{ "xlink:href": "javascript:alert(1)" },
			{ formaction: "https://evil.example" },
		]) {
			assert.throws(
				() => h("a", attributes),
				/not on the h\(\) allow-list/,
				`h must refuse ${JSON.stringify(attributes)}`,
			);
		}
	} finally {
		fake.restore();
	}
});

test("h validates a URL-bearing attribute through safeUrl", () => {
	const fake = installFakeDocument();
	try {
		assert.equal(h("a", { href: "#/i/abc" }).attributes.href, "#/i/abc");
		assert.equal(
			h("a", { href: " /i/abc" }).attributes.href,
			"/i/abc",
			"the attribute receives safeUrl's normalized value, not the raw string",
		);
		assert.equal(
			h("a", { href: "js\\main.js" }).attributes.href,
			"js/main.js",
			"a backslash normalizes to a slash in the attribute too",
		);
		assert.throws(() => h("a", { href: "javascript:alert(1)" }), /refusing an absolute "javascript:" URL/);
	} finally {
		fake.restore();
	}
});

test("safeUrl allows only same-origin and fragment references and rejects every absolute URL", () => {
	assert.equal(safeUrl("#/i/abc"), "#/i/abc");
	assert.equal(safeUrl("./js/main.js"), "./js/main.js");
	assert.equal(safeUrl("/app/index.html"), "/app/index.html");
	assert.equal(safeUrl("?open=1"), "?open=1");
	assert.equal(safeUrl(" /i/abc"), "/i/abc", "leading control characters are normalized away");
	assert.equal(safeUrl("js\\main.js"), "js/main.js", "a backslash normalizes to a slash");

	const rejected = [
		"javascript:alert(1)",
		"JavaScript:alert(1)",
		"java\tscript:alert(1)",
		" data:text/html,<script>alert(1)</script>",
		"vbscript:msgbox(1)",
		"file:///etc/passwd",
		"blob:https://example.com/uuid",
		"https://evil.example/x",
		"http://localhost:8080/x",
		"//evil.example/x",
		"\\/\\/evil.example",
	];
	for (const value of rejected) {
		assert.throws(
			() => safeUrl(value),
			/refusing an absolute|refusing a protocol-relative/,
			`safeUrl(${JSON.stringify(value)})`,
		);
	}
	assert.throws(() => safeUrl(42), /a URL must be a string, got 42/);
});

test("append accepts nodes, stringifies numbers, and skips holes", () => {
	const parent = { children: [], append(...nodes) { this.children.push(...nodes); } };
	append(parent, ["a", null, 0, undefined, false]);
	assert.deepEqual(parent.children, ["a", "0"], "zero is a value, not a hole");
});
