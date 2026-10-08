/** The suite for the wallet layer's input bounds: announced names and icons, oversized provider replies, and hostile wallet text, bounded before display. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createInvoice } from "../app/js/invoice/model.js";
import {
	WalletClient,
	WalletRequestError,
	WalletResponseError,
	discoverProviders,
} from "../app/js/wallet/eip1193.js";
import { buildPaymentPlan, connectWallet, sendPayment } from "../app/js/wallet/payment.js";
import { announcementTarget, mockProvider } from "./helpers/wallet-mock.mjs";

const PAYEE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

let invoiceSequence = 0;

function usdcInvoice() {
	return createInvoice({
		id: `INV-${(invoiceSequence += 1)}`,
		issued: "2026-10-03",
		payee: { name: "Studio Example", address: PAYEE },
		chainId: "0x1",
		asset: "usdc",
		items: [{ description: "Design work", quantity: "2", unitPrice: "150" }],
	});
}

test("an announced name is bounded before the display pass, without splitting a surrogate pair", async () => {
	const target = announcementTarget([
		{ info: { uuid: "long", name: "x".repeat(100_000) }, provider: mockProvider() },
		{ info: { uuid: "split", name: `${"a".repeat(39)}\u{1F600}tail` }, provider: mockProvider() },
		{ info: { uuid: "order", name: `${"a".repeat(39)}\u200B${"b".repeat(50)}` }, provider: mockProvider() },
	]);
	const found = await discoverProviders({ target, timeoutMs: 0 });
	assert.equal(found[0].info.name, "x".repeat(40), "an arbitrarily long announced name is cut to the label limit");
	const split = found[1].info.name;
	assert.equal(split, "a".repeat(39), "the cut drops the high surrogate of a pair it would have split");
	assert.doesNotMatch(split, /[\uD800-\uDBFF]/u, "no lone surrogate remains in the label");
	assert.equal(
		found[2].info.name,
		"a".repeat(39),
		"an invisible character just inside the bound is removed after the cut, so bounding runs before stripping",
	);
});

test("an oversized provider reply is bounded before it is rendered into a failure", async () => {
	const provider = mockProvider();
	provider.state.hash = `0x${"a".repeat(50_000)}`;
	const client = new WalletClient(provider, "Mock");
	const plan = buildPaymentPlan(usdcInvoice());
	const session = await connectWallet(client);
	await assert.rejects(
		() => sendPayment(client, plan, session),
		(error) =>
			error instanceof WalletResponseError &&
			!error.message.includes("a".repeat(400)) &&
			error.message.length < 400,
	);
});

test("a provider that throws an oversized string is bounded before it is rendered", async () => {
	const provider = mockProvider();
	provider.state.fail.eth_sendTransaction = "x".repeat(50_000);
	const client = new WalletClient(provider, "Mock");
	const plan = buildPaymentPlan(usdcInvoice());
	const session = await connectWallet(client);
	await assert.rejects(
		() => sendPayment(client, plan, session),
		(error) =>
			error instanceof WalletRequestError &&
			!error.message.includes("x".repeat(400)) &&
			error.message.length < 400,
	);
});

test("an announced icon and rdns are stripped of control, invisible, and bidi characters", async () => {
	const target = announcementTarget([
		{
			info: {
				uuid: "display",
				name: "Wallet",
				icon: "data:image/svg+xml,\u202Ebase64\u0000\u200B\uFFF9",
				rdns: "io.example\u202E\u2066.wallet\u2069\u{13430}",
			},
			provider: mockProvider(),
		},
	]);
	const found = await discoverProviders({ target, timeoutMs: 0 });
	assert.equal(found[0].info.icon, "data:image/svg+xml,base64");
	assert.equal(found[0].info.rdns, "io.example.wallet");
});

test("an announced name that is only invisible characters leaves no candidate", async () => {
	const target = announcementTarget([
		{ info: { uuid: "invisible", name: "\u200B\u2066\u2069\uFEFF" }, provider: mockProvider() },
	]);
	const found = await discoverProviders({ target, timeoutMs: 0 });
	assert.equal(found.length, 0, "a name that strips to nothing is refused rather than shown empty");
});
