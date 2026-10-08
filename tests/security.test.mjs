/** The suite for the app's security invariants: no command downloads remote code, `.gitignore` refuses secrets, and `index.html`'s CSP and script loads hold, checked through the source sweeps and the runtime blocker. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { codeOnly } from "./helpers/code-only.mjs";
import { installInteractiveDocument } from "./helpers/dom.mjs";
import { blockNetwork } from "./helpers/network-block.mjs";
import { installWindow } from "./helpers/wallet-mock.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
	return readFileSync(join(root, relativePath), "utf8");
}

function cspDirectives() {
	const policy = read("app/index.html").match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/);
	assert.ok(policy, "index.html must carry a CSP meta tag");
	return new Map(
		policy[1]
			.split(";")
			.filter((entry) => entry.trim() !== "")
			.map((entry) => entry.trim().split(/\s+/))
			.map(([name, ...values]) => [name, values]),
	);
}

const SCRIPT_ELEM_FALLBACKS = ["script-src", "default-src"];
const SCRIPT_ATTR_FALLBACKS = ["script-src", "default-src"];
const SCRIPT_EVAL_FALLBACKS = ["default-src"];

function effectiveDirective(directives, name, fallbacks) {
	for (const candidate of [name, ...fallbacks]) {
		if (directives.has(candidate)) return directives.get(candidate);
	}
	return [];
}

function allowsInlineScriptElement(directives) {
	return effectiveDirective(directives, "script-src-elem", SCRIPT_ELEM_FALLBACKS).includes("'unsafe-inline'");
}

function allowsInlineEventHandler(directives) {
	const values = effectiveDirective(directives, "script-src-attr", SCRIPT_ATTR_FALLBACKS);
	return !values.includes("'none'") && values.includes("'unsafe-inline'");
}

function allowsDynamicCode(directives) {
	return effectiveDirective(directives, "script-src", SCRIPT_EVAL_FALLBACKS).includes("'unsafe-eval'");
}

function allowsExternalScript(directives, origin) {
	const values = effectiveDirective(directives, "script-src-elem", SCRIPT_ELEM_FALLBACKS);
	if (values.includes("'none'")) return false;
	const source = origin === "self" ? "'self'" : origin;
	return values.includes("*") || values.includes(source);
}

test("no project command downloads or executes remote code", () => {
	const reachesNetwork = /\b(npx|bunx|pnpm\s+dlx|yarn\s+dlx|npm\s+exec|curl|wget)\b/;
	const scripts = JSON.parse(read("package.json")).scripts ?? {};
	for (const [name, command] of Object.entries(scripts)) {
		assert.ok(!reachesNetwork.test(command), `script "${name}" reaches the network: ${command}`);
	}
});

test(".gitignore refuses secrets, wallet material, and editor junk", () => {
	const lines = new Set(
		read(".gitignore")
			.split("\n")
			.map((line) => line.trim()),
	);
	const required = [
		".env",
		".env.*",
		"*.pem",
		"*.key",
		"*.keystore",
		"*.p12",
		"*.pfx",
		"*.seed",
		"wallet.json",
		".vscode/",
		".idea/",
		"Thumbs.db",
		"*.swp",
		"*.tmp",
	];
	for (const pattern of required) {
		assert.ok(lines.has(pattern), `.gitignore must list ${pattern}`);
	}
});

test("index.html pins a CSP whose only connect-src is none", () => {
	const directives = cspDirectives();
	assert.deepEqual(directives.get("default-src"), ["'self'"]);
	assert.deepEqual(directives.get("script-src"), ["'self'"]);
	assert.deepEqual(directives.get("script-src-elem"), ["'self'", "'unsafe-inline'"]);
	assert.deepEqual(directives.get("style-src"), ["'self'"]);
	assert.deepEqual(directives.get("img-src"), ["'self'"]);
	assert.deepEqual(directives.get("font-src"), ["'none'"]);
	assert.deepEqual(directives.get("frame-src"), ["'none'"]);
	assert.deepEqual(directives.get("object-src"), ["'none'"]);
	assert.deepEqual(directives.get("connect-src"), ["'none'"]);
});

test("the inline allowance is confined to script-src-elem and closes every other script door", () => {
	const directives = cspDirectives();

	const inlineDirectives = [...directives]
		.filter(([, values]) => values.includes("'unsafe-inline'"))
		.map(([name]) => name);
	assert.deepEqual(inlineDirectives, ["script-src-elem"], "'unsafe-inline' must appear in exactly one directive");

	const evalDirectives = [...directives]
		.filter(([, values]) => values.includes("'unsafe-eval'"))
		.map(([name]) => name);
	assert.deepEqual(evalDirectives, [], "'unsafe-eval' must appear nowhere");

	assert.deepEqual(directives.get("script-src-attr"), ["'none'"]);
	assert.deepEqual(directives.get("object-src"), ["'none'"]);
	assert.deepEqual(directives.get("base-uri"), ["'none'"]);
	assert.deepEqual(directives.get("frame-src"), ["'none'"]);
	assert.deepEqual(directives.get("connect-src"), ["'none'"]);
	assert.deepEqual(directives.get("form-action"), ["'none'"]);
});

// The assertions below re-derive the effective-directive decisions from the same parsed map the tests above use, so they prove the policy's own semantics — not that any browser enforces them.
// The end-to-end behavior, including whether Firefox applies script-src-elem to an injected inline script, is the manual Firefox check in README.md's "Testing with a real wallet" section.
test("the parsed policy permits the injected inline script element and blocks the other script vectors", () => {
	const directives = cspDirectives();
	assert.equal(allowsInlineScriptElement(directives), true, "an inline <script> element must be permitted");
	assert.equal(allowsInlineEventHandler(directives), false, "an inline event handler must be blocked");
	assert.equal(allowsDynamicCode(directives), false, "eval and new Function must be blocked");
	assert.equal(allowsExternalScript(directives, "self"), true, "a same-origin external script must stay permitted");
	assert.equal(allowsExternalScript(directives, "https://cdn.example.com"), false, "a cross-origin external script must be blocked");
});

test("index.html loads only external, same-origin scripts", () => {
	const html = read("app/index.html");
	const scriptTags = html.match(/<script\b[^>]*>/g) ?? [];
	assert.ok(scriptTags.length > 0, "index.html must load the entry module");
	for (const tag of scriptTags) {
		assert.match(tag, /\ssrc="(?!https?:|\/\/)/, `inline or cross-origin script: ${tag}`);
	}
	assert.ok(!/\son[a-z]+\s*=/i.test(html), "index.html must not use inline event handlers");
	assert.ok(!/<style\b/i.test(html), "index.html must not use inline <style> blocks");
});

test("the shipped index.html can never satisfy its own script-src-elem 'unsafe-inline' exception", () => {
	const html = read("app/index.html");
	// The exception exists only for a wallet extension's injected element: the app's own markup must never be an inline <script>, an on*= handler, or a javascript: URL, or it would be exactly the thing the exception lets run.
	const inlineScripts = (html.match(/<script\b[^>]*>/gi) ?? []).filter((tag) => !/\ssrc\s*=/i.test(tag));
	assert.deepEqual(inlineScripts, [], `index.html must carry no inline <script> element: ${inlineScripts.join(", ")}`);
	assert.ok(!/\son[a-z]+\s*=/i.test(html), "index.html must carry no inline on*= handler attribute");
	assert.ok(!/javascript:/i.test(codeOnly(html, { htmlComments: true })), "index.html must carry no javascript: URL");
});

test("the runtime blocker records the storage and side-channel sinks the runtime sweep relies on", () => {
	const fake = installInteractiveDocument();
	const installed = installWindow({});
	const calls = [];
	const restore = blockNetwork(calls);
	try {
		const attempts = [
			["localStorage.setItem", () => globalThis.localStorage.setItem("key", "value")],
			["sessionStorage.getItem", () => globalThis.sessionStorage.getItem("key")],
			["indexedDB.open", () => globalThis.indexedDB.open("db")],
			["history.pushState", () => globalThis.history.pushState({}, "", "#/x")],
			["document.cookie", () => { globalThis.document.cookie = "a=1"; }],
			["window.name", () => { globalThis.window.name = "leak"; }],
		];
		for (const [label, attempt] of attempts) {
			assert.throws(attempt, /storage blocked/, `the blocker did not catch ${label}`);
		}
		const recorded = calls.join("\n");
		for (const [label] of attempts) {
			assert.match(recorded, new RegExp(label.replace(".", "\\.")), `${label} was not recorded`);
		}
	} finally {
		restore();
		installed.restore();
		fake.restore();
	}
});
