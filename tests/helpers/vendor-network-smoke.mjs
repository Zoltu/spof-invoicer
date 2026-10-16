/**
 * Runs the page entry and every vendored bundle in a fresh module registry with all network APIs stubbed, then exits non-zero if any of them was touched.
 * Spawned by tests/slow/vendor.test.mjs: Bun caches in-process module instances, so the entry only genuinely executes under the stubs here.
 */

import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installInteractiveDocument } from "./dom.mjs";
import { blockNetwork } from "./network-block.mjs";
import { findButton, textOf } from "./tree.mjs";
import { SERVED_BUNDLES } from "./vendor-bundles.mjs";
import { waitFor } from "./wait.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const vendor = join(root, "app", "js", "vendor");

const KECCAK_256_EMPTY = "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";
const KECCAK_256_ABC = "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45";

const PAYEE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

function moduleUrl(path) {
	return pathToFileURL(path).href;
}

const calls = [];
const restoreNetwork = blockNetwork(calls);
// The page entry needs a document to boot the shell into; the same minimal interactive node shape the unit tests use keeps the entry's own DOM interaction real without a browser.
const fakeDocument = installInteractiveDocument();
const mounted = document.createElement("div");
document.getElementById = (id) => (id === "app" ? mounted : null);

// The export's only outward step is a blob URL and a download anchor, neither of which Node supplies; recording them is what proves the real handler ran, since an empty network recorder would pass just as vacuously if the click threw and showed a notice instead.
// `HTMLElement` is the fake DOM class.
const objectUrls = [];
const downloads = [];
const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;
const prototype = globalThis.HTMLElement.prototype;
const originalClick = prototype.click;
URL.createObjectURL = (blob) => {
	objectUrls.push(blob);
	return `blob:smoke-${objectUrls.length}`;
};
URL.revokeObjectURL = () => {};
prototype.click = function click() {
	if (this.hasAttribute("download")) downloads.push([this.getAttribute("href"), this.getAttribute("download")]);
};

try {
	const encoding = await import(moduleUrl(join(root, "app", "js", "util", "encoding.js")));
	assert.equal(encoding.toHex(encoding.keccak256(new Uint8Array(0))), KECCAK_256_EMPTY);
	assert.equal(encoding.toHex(encoding.keccak256(encoding.utf8ToBytes("abc"))), KECCAK_256_ABC);

	const message = encoding.utf8ToBytes("hello");
	assert.equal(encoding.base32.encode(message), "NBSWY3DP");

	for (const file of SERVED_BUNDLES) {
		await import(moduleUrl(join(vendor, file)));
	}

	const pdfLib = await import(moduleUrl(join(vendor, "pdf-lib", "pdf-lib.esm.js")));
	const pdf = await pdfLib.PDFDocument.create();
	const page = pdf.addPage(pdfLib.PageSizes.A4);
	const font = await pdf.embedFont(pdfLib.StandardFonts.TimesRoman);
	page.drawText("vendor smoke", { x: 24, y: 24, size: 12, font, color: pdfLib.rgb(0, 0, 0) });
	const bytes = await pdf.save();
	assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");

	// The page entry loads encoding -> every vendored bundle under the same blocking stubs, so the document stub above also proves the shell boots without reaching for the network.
	await import(moduleUrl(join(root, "app", "js", "main.js")));
	assert.ok(mounted.children.length > 0, "the page entry mounted the app shell");

	// main.js boots the create route; the view route is the other half of the app, where a decoded invoice is untrusted input and the PDF/payment seams hang.
	// Render it through the official router + shell here too, so a network call introduced into `ui/view.ts` or the share dialog it opens trips the same blocking stubs.
	const { parseHash } = await import(moduleUrl(join(root, "app", "js", "app", "router.js")));
	const { mountShell, renderRoute } = await import(moduleUrl(join(root, "app", "js", "app", "shell.js")));
	const { createInvoice } = await import(moduleUrl(join(root, "app", "js", "invoice", "model.js")));
	const { encodeShare } = await import(moduleUrl(join(root, "app", "js", "invoice", "share.js")));

	const hostile = "<img src=x onerror=\"alert(1)\"><script>alert(2)</script>";
	const route = parseHash(
		encodeShare(
			createInvoice({
				id: "INV-SMOKE",
				issued: "2026-10-03",
				payee: { name: hostile, address: PAYEE },
				chainId: "0x1",
				asset: "usdc",
				items: [{ description: hostile, quantity: "2", unitPrice: "150" }],
			}),
		),
	);
	assert.equal(route.kind, "view", "the encoded invoice decodes to the view route");

	const viewShell = mountShell(document.createElement("div"));
	renderRoute(viewShell, route, { baseUrl: "https://example.com/app/", today: "2026-10-03", clipboard: null });
	assert.ok(textOf(viewShell.content).includes("INV-SMOKE"), "the view route rendered the decoded invoice");

	// The shell wires the payment panel as Pay's default handler, so the control is live.
	const pay = findButton(viewShell.content, "Pay");
	assert.ok(pay, "the view route renders a Pay control");
	assert.ok(!("disabled" in pay.attributes), "the shell wires a live Pay handler");

	// The shell now defaults Save as PDF to its real renderer (the lazily imported pdf-lib path), so the click must actually export — proven by the recorded download, not merely by an empty recorder, which a handler that threw and showed a notice instead would satisfy too.
	const save = findButton(viewShell.content, "Save as PDF");
	assert.ok(save, "the view route renders a Save as PDF control");
	save.dispatch("click", { type: "click" });
	await waitFor(() => downloads.length > 0 || viewShell.notice.children.length > 0);
	assert.deepEqual(downloads, [["blob:smoke-1", "invoice-INV-SMOKE.pdf"]], "the real export handler downloaded the invoice PDF");
	assert.equal(objectUrls.length, 1, "the export produced exactly one PDF blob");
	assert.equal(objectUrls[0].type, "application/pdf");
	assert.equal(viewShell.notice.children.length, 0, "the export reported no failure");

	// Only the payer's own click may look for a wallet, and this process has no window.ethereum, so the panel reports that instead of reaching for anything; the blocking stubs prove the whole path added no page-origin network call of its own.
	pay.dispatch("click", { type: "click" });
	const connect = findButton(document.body, "Connect wallet & pay");
	assert.ok(connect, "the payment panel opened in the page");
	connect.dispatch("click", { type: "click" });
	await waitFor(() => viewShell.notice.children.length > 0);
	assert.match(textOf(viewShell.notice), /No Ethereum wallet was found/);

	// Deferred work (setTimeout / queueMicrotask / a late promise) can fire after the awaits above, so drain a macrotask before concluding the call list is empty.
	await new Promise((fulfil) => setTimeout(fulfil, 50));
	assert.deepEqual(calls, [], `network I/O attempted: ${calls.join(", ")}`);

	console.log("vendor-network-smoke: ok");
} catch (error) {
	console.error(`vendor-network-smoke: ${error instanceof Error ? error.message : error}`);
	process.exitCode = 1;
} finally {
	if (originalCreateObjectUrl === undefined) delete URL.createObjectURL;
	else URL.createObjectURL = originalCreateObjectUrl;
	if (originalRevokeObjectUrl === undefined) delete URL.revokeObjectURL;
	else URL.revokeObjectURL = originalRevokeObjectUrl;
	if (originalClick === undefined) delete prototype.click;
	else prototype.click = originalClick;
	restoreNetwork();
	fakeDocument.restore();
}
