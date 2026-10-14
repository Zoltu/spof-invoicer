/** The suite for the util modules: decimal and base-unit conversion, the encoding primitives (hex, base58/base58xmr/base58check, bech32/bech32m, sha-256), the DOM helpers, error descriptions, and text bounding. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fromBaseUnits, toBaseUnits, UINT256_MAX } from "../app/js/util/decimal.js";
import { append, h, safeUrl } from "../app/js/util/dom.js";
import { svgDataUrl } from "../app/js/util/svg-data-url.js";
import { base58, base58check, base58xmr, bech32, bech32m, hexToBytes, sha256, toHex, utf8ToBytes } from "../app/js/util/encoding.js";
import { describe, preview } from "../app/js/util/errors.js";
import { boundRaw } from "../app/js/util/text.js";
import { findTsc } from "../build.mjs";
import { installFakeDocument } from "./helpers/dom.mjs";
import { readEmittedModule, repoRelativeTarget, staticImportReach } from "./helpers/static-imports.mjs";

const EIGHTEEN = 10n ** 18n;

/** The deepest directory that contains every one of `paths`, which is the `rootDir` a probe tsconfig must set to span both the throwaway probe directory and the sources it imports. */
function commonAncestor(...paths) {
	const parts = paths.map((value) => resolve(value).split(sep));
	let end = 0;
	while (end < parts[0].length && parts.every((entry) => entry[end] === parts[0][end])) end += 1;
	return parts[0].slice(0, end).join(sep) || sep;
}

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

test("base58 matches the Bitcoin Core known-answer vectors", () => {
	// src/test/data/base58_encode_decode.json from Bitcoin Core.
	const vectors = [
		["", ""],
		["61", "2g"],
		["626262", "a3gV"],
		["636363", "aPEr"],
		["73696d706c792061206c6f6e6720737472696e67", "2cFupjhnEsSn59qHXstmK2ffpLv2"],
		["00eb15231dfceb60925886b67d065299925915aeb172c06647", "1NS17iag9jJgTHD1VXjvLCEnZuQ3rJDE9L"],
		["516b6fcd0f", "ABnLTmg"],
		["bf4f89001e670274dd", "3SEo3LWLoPntC"],
		["572e4794", "3EFU7m"],
		["ecac89cad93923c02321", "EJDM8drfXA6uyA"],
		["10c8511e", "Rt5zm"],
		["00000000000000000000", "1111111111"],
	];
	for (const [hex, text] of vectors) {
		const bytes = hexToBytes(hex);
		assert.equal(base58.encode(bytes), text, `base58.encode(${hex})`);
		assert.deepEqual(base58.decode(text), bytes, `base58.decode(${text})`);
	}
});

test("base58xmr round-trips its block-padded encoding across block boundaries", () => {
	for (const length of [0, 1, 7, 8, 9, 69]) {
		const payload = Uint8Array.from({ length }, (_, index) => (index * 37 + 11) % 256);
		assert.deepEqual(base58xmr.decode(base58xmr.encode(payload)), payload, `length ${length}`);
	}
});

test("sha256 matches known-answer vectors", () => {
	assert.equal(
		toHex(sha256(utf8ToBytes(""))),
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		"sha256(\"\")",
	);
	assert.equal(
		toHex(sha256(utf8ToBytes("abc"))),
		"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		"sha256(\"abc\")",
	);
	assert.equal(
		toHex(sha256(utf8ToBytes("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))),
		"248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
		"sha256 of the 56-byte two-block message",
	);
});

test("base58check round-trips the Bitcoin mainnet P2PKH address vector and rejects a tampered checksum", () => {
	const check = base58check(sha256);
	const payload = hexToBytes("00010966776006953d5567439e5e39f86a0d273bee");
	const encoded = check.encode(payload);
	assert.equal(encoded, "16UwLL9Risc3QfPqBUvKofHmBQ7wMtjvM");
	assert.deepEqual(check.decode(encoded), payload);
	const last = encoded.at(-1);
	assert.throws(() => check.decode(`${encoded.slice(0, -1)}${last === "2" ? "3" : "2"}`), /checksum/);
});

test("bech32 and bech32m match the BIP 173 and BIP 350 known-answer vectors", () => {
	// BIP 173: a witness-v0 P2WPKH address for program 751e76e8199196d454941c45d1b3a323f1433bd6.
	const program20 = hexToBytes("751e76e8199196d454941c45d1b3a323f1433bd6");
	const bech32Text = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
	assert.equal(bech32.encode("bc", [0, ...bech32.toWords(program20)]), bech32Text);
	const decodedV0 = bech32.decode(bech32Text);
	assert.equal(decodedV0.prefix, "bc");
	assert.deepEqual(bech32.fromWords(decodedV0.words.slice(1)), program20);

	// BIP 350: a witness-v1 P2TR address for program 79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798.
	const program32 = hexToBytes("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
	const bech32mText = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0";
	assert.equal(bech32m.encode("bc", [1, ...bech32m.toWords(program32)]), bech32mText);
	const decodedV1 = bech32m.decode(bech32mText);
	assert.equal(decodedV1.prefix, "bc");
	assert.deepEqual(bech32m.fromWords(decodedV1.words.slice(1)), program32);
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

test("h refuses a src that is not the icon leaf's own data URL", () => {
	const fake = installFakeDocument();
	try {
		const url = svgDataUrl('<svg width="16" height="16"></svg>');
		assert.equal(h("img", { src: url }).attributes.src, url, "the leaf's own data URL reaches the attribute");
		assert.equal(h("img", { alt: "", src: url }).attributes.alt, "", "and the alt text beside it is free text");
		assert.throws(
			() => h("iframe", { src: url }),
			/only an <img> renders a source in the browser's image context/,
			"and the same data URL on a document-context element is refused, so the image-context boundary is h()'s and not only the CSP's",
		);
		for (const value of [
			"logo.svg",
			"#/create",
			"data:text/html,<script>alert(1)</script>",
			"blob:https://example/x",
			"javascript:alert(1)",
		]) {
			assert.throws(
				() => h("img", { src: value }),
				/only the icon leaf's own data URL may reach an image sink/,
				`h must refuse the src ${JSON.stringify(value)}`,
			);
		}
		assert.throws(
			() => h("img", { ...{ src: "logo.svg" } }),
			/only the icon leaf's own data URL may reach an image sink/,
			"a spread that smuggles a plain string into src is refused by the runtime check even where the type brand could be bypassed",
		);
		assert.throws(() => h("img", { src: 42 }), /only the icon leaf's own data URL/, "a non-string src is refused too");
		assert.throws(
			() => h("a", { href: "data:text/html,x" }),
			/refusing an absolute "data:" URL/,
			"a data: URL is still refused in an href, where safeUrl is unchanged",
		);
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

test("preview reads a value's toStringTag under a guard", () => {
	// A hostile tag is a string this module would otherwise let `Object.prototype.toString` allocate and copy in full before the bound could cut the result.
	const unbounded = { [Symbol.toStringTag]: "x".repeat(1024 * 1024) };
	const bounded = preview(unbounded, 60);
	assert.ok(bounded.length <= 60, `the rendering stays inside the bound, got ${bounded.length} characters`);
	assert.equal(bounded.includes("x".repeat(64)), false, "the claimed tag is not carried whole");
	assert.equal(bounded.startsWith("[object "), true, "it is still rendered as a tag");

	// A tag getter that throws must not replace the caller's contracted TypeError with the value's own error.
	const throwing = {
		get [Symbol.toStringTag]() {
			throw new Error("hostile");
		},
	};
	assert.equal(preview(throwing, 60), "[unprintable]", "a throwing tag renders as the fixed fallback instead of throwing");

	// The guard changes nothing for the ordinary shapes: a value with no tag of its own is rendered by the engine exactly as before.
	assert.equal(preview([]), "[object Array]");
	assert.equal(preview({}), "[object Object]");
	assert.equal(preview(new Date(0)), "[object Date]");
	assert.equal(preview(new Map()), "[object Map]");
	assert.equal(preview(Object.create(null)), "[object Object]", "an object with no prototype still renders through the engine");
});

test("DomAttributes refuses an src on a widened or union-typed tag at compile time, and admits it on an img", () => {
	// The probe carries a `@ts-expect-error` on the union-typed tag and on a spread that smuggles a plain string into `src`, so a `tsc` run exits zero only while both lines are compile errors and the `<img>` call site still compiles.
	// The probe source is generated from this committed string into a throwaway directory at run time, so no untracked path is required for a clean checkout to run the suite; its own `package.json` makes it an ES module and its tsconfig extends the root one, so the probe is checked under the project's own configuration — `verbatimModuleSyntax`, `isolatedModules`, `moduleDetection`, `noImplicitOverride`, `noFallthroughCasesInSwitch` and the rest — rather than a hand-copied flag list that can drift.
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const tsc = findTsc();
	assert.notEqual(tsc, null, "typescript is installed");
	const dir = mkdtempSync(join(tmpdir(), "invoice-type-probe-"));
	try {
		const specifier = (target) => relative(dir, join(root, target)).split(sep).join("/");
		const probe = `/** The compile-time probe for the DomAttributes src sink, compiled by tests/util.test.mjs under the project's own tsconfig. */
import { h } from "${specifier("app/ts/util/dom.js")}";
import { svgDataUrl } from "${specifier("app/ts/util/svg-data-url.js")}";

const url = svgDataUrl('<svg width="64" height="64"></svg>');

declare const widenedTag: keyof HTMLElementTagNameMap;
// @ts-expect-error an src on a union-typed tag is a compile error, not only a runtime refusal
h(widenedTag, { src: url });

h("img", { src: url, alt: "" });

// @ts-expect-error a spread that smuggles a plain string into src is a compile error, so the brand holds at the spread too
h("img", { ...{ src: "logo.svg" } });
`;
		writeFileSync(join(dir, "dom-src.ts"), probe);
		writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
		writeFileSync(
			join(dir, "tsconfig.json"),
			`${JSON.stringify({ extends: join(root, "tsconfig.json"), compilerOptions: { rootDir: commonAncestor(dir, root), noEmit: true }, include: ["dom-src.ts"] }, null, "\t")}\n`,
		);
		const result = spawnSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json"), "--noEmit"], { cwd: root, encoding: "utf8" });
		assert.equal(result.error, undefined, `tsc could not run: ${result.error}`);
		assert.equal(result.status, 0, `the type probe must compile cleanly under the project's own configuration, so an src is a compile error on a union-typed tag and on a spread, and still admitted on an img:\n${result.stdout}${result.stderr}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the emitted markup builder's static graph reaches no encoding or vendored module", () => {
	// `h()` is imported by nearly every page module, so the leaf it reads the src contract from stays dependency-free: a static import of the encoding or vendored bundle here would ride into every page load.
	const reached = staticImportReach("app/js/util/dom.js", readEmittedModule, repoRelativeTarget);
	const offenders = [...reached].filter((file) => /(?:^|\/)util\/encoding\.js$/.test(file) || file.startsWith("app/js/vendor/"));
	assert.deepEqual(offenders, [], `the builder's static graph reaches ${offenders.join(", ")}`);
});
