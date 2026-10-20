/** The suite for the wallet layer and the payment panel: transaction building, chain checks, EIP-6963 and `window.ethereum` discovery, the pay flow, and the opener and duplicate-payment refusals. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { installInteractiveDocument } from "./helpers/dom.mjs";
import { blockNetwork } from "./helpers/network-block.mjs";
import { USDC_LOWER } from "./helpers/tokens.mjs";
import { findAll, hasClass, textOf } from "./helpers/tree.mjs";
import {
	ACCOUNT,
	TX_HASH,
	word,
	mockProvider,
	installWindow,
	announcementTarget,
	noticeRecorder,
} from "./helpers/wallet-mock.mjs";
import { encodeInvoice } from "../app/js/invoice/codec.js";
import { encodeShare } from "../app/js/invoice/share.js";
import { computeTotals, createInvoice } from "../app/js/invoice/model.js";
import { parseHash } from "../app/js/app/router.js";
import { mountShell, renderRoute } from "../app/js/app/shell.js";
import { openPayPanel } from "../app/js/ui/pay.js";
import { renderInvoiceView } from "../app/js/ui/view.js";
import { toChecksumAddress } from "../app/js/wallet/address.js";
import { encodeBalanceOf, encodeTransfer } from "../app/js/wallet/erc20.js";
import {
	UnknownChainError,
	WalletClient,
	WalletRejectedError,
	WalletResponseError,
	discoverProviders,
	fromHexQuantity,
	normalizeChainId,
	toHexQuantity,
	walletCandidates,
	windowProvider,
} from "../app/js/wallet/eip1193.js";
import {
	NoAccountError,
	WrongChainError,
	buildPaymentPlan,
	connectWallet,
	ensureWalletChain,
	isWalletPayable,
	readBalance,
	sendPayment,
	transactionRequest,
} from "../app/js/wallet/payment.js";

const PAYEE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const PAYEE_LOWER = PAYEE.toLowerCase();
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const USDC_TOTAL = 357000000n;
const VIEW_OPTIONS = { baseUrl: "https://example.com/app/", today: "2026-10-03", clipboard: null };

/**
 * Every call mints a distinct invoice id, so the in-memory payment latch — keyed by invoice content — does not silently carry between tests as it would not across a page reload.
 * A test that needs two objects with the same content builds one invoice and re-parses its fragment, exactly as the router does.
 */
let invoiceSequence = 0;

function nextInvoiceId(stem) {
	return `${stem}-${(invoiceSequence += 1)}`;
}

function usdcInvoice(overrides = {}) {
	return createInvoice({
		id: nextInvoiceId("INV"),
		issued: "2026-10-03",
		payee: { name: "Studio Example", address: PAYEE },
		chainId: "0x1",
		asset: "usdc",
		items: [{ description: "Design work", quantity: "2", unitPrice: "150" }],
		tax: { label: "VAT 19%", rate: "19" },
		...overrides,
	});
}

function ethInvoice(overrides = {}) {
	return createInvoice({
		id: nextInvoiceId("INV-ETH"),
		issued: "2026-10-03",
		payee: { name: "Studio Example", address: PAYEE },
		chainId: "0x1",
		asset: "eth",
		items: [{ description: "Advice", quantity: "1", unitPrice: "1.5" }],
		...overrides,
	});
}

function byText(node, tag, text) {
	return findAll(node, (child) => child.tagName === tag && textOf(child) === text);
}

function click(node) {
	node.dispatch("click", { type: "click" });
}

async function drain() {
	for (let index = 0; index < 3; index += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function dialogOf(handle) {
	return findAll(handle.element, (node) => hasClass(node, "pay-dialog"))[0];
}

/** The transaction hash the panel shows: the text of the fitted value element that holds it. */
function hashOf(node) {
	const field = findAll(node, (child) => hasClass(child, "pay-hash"))[0];
	return field === undefined ? null : textOf(field);
}

test("a native invoice builds an eth_sendTransaction that pays the payee the computed total", () => {
	const invoice = ethInvoice();
	const plan = buildPaymentPlan(invoice);

	assert.equal(plan.amount, 1500000000000000000n);
	assert.equal(plan.amountText, "1.5");
	assert.equal(plan.amount, computeTotals(invoice).total.units);
	assert.equal(plan.recipient, PAYEE_LOWER);
	assert.equal(plan.target, PAYEE_LOWER);
	assert.equal(plan.data, null);
	assert.equal(plan.value, plan.amount);
	assert.ok(Object.isFrozen(plan));

	const request = transactionRequest(plan, ACCOUNT);
	assert.deepEqual(request, { from: ACCOUNT, to: PAYEE_LOWER, value: "0x14d1120d7b160000", chainId: "0x1" });
	assert.equal("data" in request, false, "a native transfer carries no calldata");
});

test("an ERC-20 invoice builds transfer calldata addressed to the token contract", () => {
	const invoice = usdcInvoice();
	const plan = buildPaymentPlan(invoice);

	assert.equal(plan.amount, USDC_TOTAL);
	assert.equal(plan.amountText, "357");
	assert.equal(plan.recipient, PAYEE_LOWER);
	assert.equal(plan.target, USDC_LOWER, "the transaction is addressed to the token, not the payee");
	assert.equal(plan.value, 0n);
	assert.equal(plan.data, encodeTransfer(PAYEE_LOWER, USDC_TOTAL));
	assert.equal(plan.data, encodeTransfer(PAYEE, USDC_TOTAL), "the payee's casing does not change the calldata");
	assert.deepEqual(transactionRequest(plan, ACCOUNT), {
		from: ACCOUNT,
		to: USDC_LOWER,
		value: "0x0",
		chainId: "0x1",
		data: encodeTransfer(PAYEE, USDC_TOTAL),
	});
});

test("hostile invoice data cannot change the recipient or the amount", () => {
	const invoice = usdcInvoice();
	const totals = computeTotals(invoice);
	const plan = buildPaymentPlan({
		...invoice,
		total: { units: 1n, text: "0.000001" },
		amount: 1n,
		value: "0x1",
		data: "0xdeadbeef",
		target: "0x00000000000000000000000000000000deadbeef",
	});

	assert.equal(plan.amount, totals.total.units);
	assert.equal(plan.recipient, PAYEE_LOWER);
	assert.equal(plan.target, USDC_LOWER);
	assert.equal(plan.data, encodeTransfer(PAYEE, totals.total.units));
	assert.equal(plan.value, 0n);
});

test("an unpayable destination or unsupported asset is refused before a transaction is built", () => {
	const invoice = usdcInvoice();
	assert.throws(() => buildPaymentPlan({ ...invoice, payee: { name: "x", address: ZERO_ADDRESS } }), /zero address/);
	assert.throws(() => buildPaymentPlan({ ...invoice, payee: { name: "x", address: USDC_LOWER } }), /own contract address/);
	assert.throws(() => buildPaymentPlan({ ...invoice, chainId: "0x89" }), /unsupported chain/);
	assert.throws(() => buildPaymentPlan({ ...invoice, asset: "doge" }), /unsupported asset/);
});

test("isWalletPayable answers for every family rather than raising, so a caller can branch on it", () => {
	// The callers are a filter and a guard — the document's Pay control and the panel's entry — so an asset stating a family this app has no rules for has to read as one no wallet pays here rather than throwing out of the caller's branch.
	assert.equal(isWalletPayable({ family: "evm" }), true);
	assert.equal(isWalletPayable({ family: "zcash" }), false, "a privacy-chain family is not paid through an injected wallet");
	assert.equal(isWalletPayable({ family: "monero" }), false);
	assert.equal(isWalletPayable({}), true, "an asset stating no family is the default EVM one, as the registry's own resolution reads it");
	assert.equal(isWalletPayable({ family: undefined }), true);
	assert.equal(isWalletPayable({ family: "bitcoin" }), false, "a family no rule carries is not the EVM one");
	assert.equal(isWalletPayable({ family: null }), false, "nor is an explicit statement that is not a family");
});

test("sendPayment sends the plan's exact params and reads the token balance with balanceOf", async () => {
	const provider = mockProvider();
	const client = new WalletClient(provider, "Mock");
	const plan = buildPaymentPlan(usdcInvoice());

	const session = await connectWallet(client);
	assert.deepEqual(session, { account: ACCOUNT, chainId: "0x1" });
	assert.deepEqual(provider.calls.map((call) => call.method), ["eth_requestAccounts", "eth_chainId"]);

	assert.equal(await readBalance(client, plan.asset, session.account), 1000000000n);
	assert.deepEqual(provider.calls.find((call) => call.method === "eth_call").params, [
		{ to: USDC_LOWER, data: encodeBalanceOf(ACCOUNT) },
		"latest",
	]);

	const receipt = await sendPayment(client, plan, session);
	assert.equal(receipt.hash, TX_HASH);
	assert.equal(receipt.amount, USDC_TOTAL);
	assert.deepEqual(provider.calls.map((call) => call.method), [
		"eth_requestAccounts",
		"eth_chainId",
		"eth_call",
		"eth_chainId",
		"eth_sendTransaction",
	]);
	assert.deepEqual(provider.calls.find((call) => call.method === "eth_sendTransaction").params, [{ from: ACCOUNT, to: USDC_LOWER, value: "0x0", chainId: "0x1", data: encodeTransfer(PAYEE, USDC_TOTAL) }]);
});

test("the native path reads eth_getBalance and attaches the total as value", async () => {
	const provider = mockProvider({ balance: toHexQuantity(2n * 10n ** 18n) });
	const client = new WalletClient(provider, "Mock");
	const plan = buildPaymentPlan(ethInvoice());
	const session = await connectWallet(client);

	assert.equal(await readBalance(client, plan.asset, session.account), 2000000000000000000n);
	assert.deepEqual(provider.calls.find((call) => call.method === "eth_getBalance").params, [ACCOUNT, "latest"]);

	await sendPayment(client, plan, session);
	assert.deepEqual(provider.calls.find((call) => call.method === "eth_sendTransaction").params, [{ from: ACCOUNT, to: PAYEE_LOWER, value: "0x14d1120d7b160000", chainId: "0x1" }]);
});

test("sendPayment refuses to send while the wallet is on another network", async () => {
	const provider = mockProvider({ chainId: "0x89" });
	const client = new WalletClient(provider, "Mock");
	const plan = buildPaymentPlan(usdcInvoice());

	await assert.rejects(
		() => sendPayment(client, plan, { account: ACCOUNT, chainId: "0x89" }),
		(error) => {
			assert.ok(error instanceof WrongChainError);
			assert.equal(error.current, "0x89");
			assert.equal(error.expected, "0x1");
			return true;
		},
	);
	assert.deepEqual(provider.calls.map((call) => call.method), ["eth_chainId"]);
	assert.equal(provider.calls.some((call) => call.method === "eth_sendTransaction"), false);
});

test("ensureWalletChain switches the wallet and re-reads the chain", async () => {
	const provider = mockProvider({ chainId: "0x89" });
	provider.state.chainAfterSwitch = "0x1";
	const client = new WalletClient(provider, "Mock");

	await ensureWalletChain(client, "0x1");
	assert.deepEqual(provider.calls.map((call) => call.method), [
		"eth_chainId",
		"wallet_switchEthereumChain",
		"eth_chainId",
	]);
	assert.deepEqual(provider.calls[1].params, [{ chainId: "0x1" }]);
});

test("a switch that does not move the wallet still refuses to send", async () => {
	const provider = mockProvider({ chainId: "0x89" });
	await assert.rejects(() => ensureWalletChain(new WalletClient(provider, "Mock"), "0x1"), WrongChainError);
	assert.equal(provider.calls.some((call) => call.method === "eth_sendTransaction"), false);
});

test("a declined switch and an unknown chain are reported as their own failures", async () => {
	const declined = mockProvider({ chainId: "0x89" });
	declined.state.switchFails = "reject";
	await assert.rejects(
		() => ensureWalletChain(new WalletClient(declined, "Mock"), "0x1"),
		(error) => error instanceof WalletRejectedError && error.action === "network switch",
	);

	const unknown = mockProvider({ chainId: "0x89" });
	unknown.state.switchFails = "unknown";
	await assert.rejects(
		() => ensureWalletChain(new WalletClient(unknown, "Mock"), "0x1"),
		(error) => error instanceof UnknownChainError && error.chainId === "0x1",
	);
});

test("a rejected connection and a rejected transaction are reported as user rejections", async () => {
	const connect = mockProvider();
	connect.state.fail.eth_requestAccounts = { code: 4001, message: "User rejected the request." };
	await assert.rejects(
		() => connectWallet(new WalletClient(connect, "Mock")),
		(error) => error instanceof WalletRejectedError && error.action === "connection request",
	);

	const send = mockProvider();
	const plan = buildPaymentPlan(usdcInvoice());
	const session = await connectWallet(new WalletClient(send, "Mock"));
	send.state.fail.eth_sendTransaction = { code: 4001, message: "User rejected the request." };
	await assert.rejects(
		() => sendPayment(new WalletClient(send, "Mock"), plan, session),
		(error) => error instanceof WalletRejectedError && error.action === "transaction",
	);
});

test("a wallet that grants access but returns no account is refused", async () => {
	const provider = mockProvider({ accounts: [] });
	await assert.rejects(() => connectWallet(new WalletClient(provider, "Mock")), NoAccountError);
});

test("a provider that answers with the wrong shape fails closed", async () => {
	const malformed = mockProvider({ accounts: ["0x1234"] });
	await assert.rejects(() => new WalletClient(malformed, "Mock").requestAccounts(), WalletResponseError);

	const badChain = mockProvider();
	badChain.state.chainId = "mainnet";
	await assert.rejects(() => new WalletClient(badChain, "Mock").chainId(), WalletResponseError);

	const badBalance = mockProvider({ balance: "one ether" });
	await assert.rejects(() => new WalletClient(badBalance, "Mock").getBalance(ACCOUNT), WalletResponseError);

	const badHash = mockProvider();
	badHash.state.hash = "0xdeadbeef";
	const client = new WalletClient(badHash, "Mock");
	const plan = buildPaymentPlan(usdcInvoice());
	const session = await connectWallet(client);
	await assert.rejects(() => sendPayment(client, plan, session), WalletResponseError);

	assert.throws(() => new WalletClient({}, "Nope"), /EIP-1193 provider/);
	assert.throws(() => toHexQuantity(-1n), RangeError);
	assert.throws(() => fromHexQuantity("nope", "eth_getBalance"), WalletResponseError);
});

test("quantities round-trip through their JSON-RPC hex spelling", () => {
	assert.equal(toHexQuantity(0n), "0x0");
	assert.equal(toHexQuantity(10n ** 18n), "0xde0b6b3a7640000");
	assert.equal(fromHexQuantity("0xde0b6b3a7640000", "test"), 10n ** 18n);
	assert.equal(normalizeChainId("0x01"), "0x1");
	assert.throws(() => normalizeChainId("0X1"), WalletResponseError);
});

test("EIP-6963 discovery collects announcements and drops an unusable one", async () => {
	const meta = { info: { uuid: "meta", name: "MetaMask" }, provider: mockProvider() };
	const rabby = { info: { uuid: "rabby", name: "Rabby" }, provider: mockProvider() };
	const hostile = { info: { uuid: "evil", name: "Evil" }, provider: {} };
	const target = announcementTarget([meta, rabby, hostile, meta]);

	const found = await discoverProviders({ target, timeoutMs: 0 });
	assert.deepEqual(found.map((entry) => entry.info.name), ["MetaMask", "Rabby"], "one entry per wallet");
	assert.equal(found[0].provider, meta.provider);
	assert.equal(target.listenerCount(), 0, "the announcement listener is removed after discovery");
	assert.deepEqual(await discoverProviders({ target: null, timeoutMs: 0 }), [], "no event target, no providers");
});

test("a caller-supplied target that is not an event target yields the empty result rather than throwing", async () => {
	assert.deepEqual(
		await discoverProviders({ target: {}, timeoutMs: 0 }),
		[],
		"an object with no event methods is no target",
	);
	assert.deepEqual(
		await discoverProviders({ target: { addEventListener() {}, removeEventListener() {} }, timeoutMs: 0 }),
		[],
		"a target missing one of the three required methods is no target",
	);
});

test("discovery retains only a bounded number of announcements", async () => {
	const details = Array.from({ length: 300 }, (_, index) => ({
		info: { uuid: `wallet-${index}`, name: `Wallet ${index}` },
		provider: mockProvider(),
	}));
	const found = await discoverProviders({ target: announcementTarget(details), timeoutMs: 0 });
	assert.equal(
		found.length,
		256,
		"the announcement list is capped so a flooding wallet cannot grow it without bound",
	);
});

test("eth_requestAccounts refuses an unbounded account array and admits a generous one", async () => {
	const flood = mockProvider({ accounts: Array.from({ length: 1025 }, () => ACCOUNT) });
	await assert.rejects(() => new WalletClient(flood, "Mock").requestAccounts(), WalletResponseError);

	const generous = mockProvider({ accounts: Array.from({ length: 1024 }, () => ACCOUNT) });
	assert.equal(
		(await new WalletClient(generous, "Mock").requestAccounts()).length,
		1024,
		"the bound admits a generous account list",
	);
});

test("the window.ethereum fallback is used only when nothing announces", async () => {
	const provider = mockProvider();
	const installed = installWindow({ ethereum: provider });
	try {
		const candidates = await walletCandidates();
		assert.deepEqual(candidates.map((candidate) => candidate.label), ["Injected wallet"]);
		assert.equal(candidates[0].provider, provider);
		assert.equal(windowProvider(), provider);
	} finally {
		installed.restore();
	}
	assert.equal(windowProvider(), null);
});

test("more than one announced wallet becomes a choice", async () => {
	const target = announcementTarget([
		{ info: { uuid: "meta", name: "MetaMask" }, provider: mockProvider() },
		{ info: { uuid: "rabby", name: "Rabby" }, provider: mockProvider() },
	]);
	const candidates = await walletCandidates({ target, timeoutMs: 0 });
	assert.deepEqual(candidates.map((candidate) => candidate.label), ["MetaMask", "Rabby"]);
});

test("no provider method is called on render, on the Pay click, or while the panel is idle", async () => {
	const fake = installInteractiveDocument();
	const provider = mockProvider();
	const installed = installWindow({ ethereum: provider });
	try {
		const notices = noticeRecorder();
		const view = renderInvoiceView(usdcInvoice(), {
			...VIEW_OPTIONS,
			notice: notices,
			pay: (invoice) => {
				openPayPanel(invoice, { notice: notices, clipboard: null });
			},
		});
		assert.equal(provider.calls.length, 0, "rendering the invoice must not touch the wallet");

		click(byText(view, "button", "Pay")[0]);
		await drain();
		assert.equal(provider.calls.length, 0, "opening the panel must not touch the wallet");

		const panel = findAll(document.body, (node) => hasClass(node, "pay-dialog"))[0];
		assert.ok(panel, "the payment panel opens over the page");
		assert.match(textOf(panel), /357 USDC/, "the panel shows the invoice's own total");
		assert.match(textOf(panel), new RegExp(toChecksumAddress(PAYEE)));
		assert.match(textOf(panel), /Ethereum \(0x1\)/);
		assert.equal(findAll(panel, (node) => node.tagName === "a").length, 0, "the panel links nowhere");

		click(byText(panel, "button", "Connect wallet & pay")[0]);
		await drain();
		assert.deepEqual(provider.calls.map((call) => call.method), [
			"eth_requestAccounts",
			"eth_chainId",
			"eth_chainId",
			"eth_call",
			"eth_chainId",
			"eth_sendTransaction",
		]);
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("the panel shows the hash as text with a copy control, and falls back to selectable text", async () => {
	const fake = installInteractiveDocument();
	const provider = mockProvider();
	const installed = installWindow({ ethereum: provider });
	try {
		const notices = noticeRecorder();
		const written = [];
		const handle = openPayPanel(usdcInvoice(), {
			notice: notices,
			clipboard: { writeText: async (text) => written.push(text) },
		});
		click(byText(handle.element, "button", "Connect wallet & pay")[0]);
		await drain();

		const dialog = dialogOf(handle);
		assert.match(textOf(dialog), /Transaction submitted/);
		const hashValue = findAll(dialog, (node) => hasClass(node, "pay-hash"))[0];
		assert.equal(textOf(hashValue), TX_HASH, "the hash is drawn as the panel's own text, whole, rather than as a form control's value");
		assert.equal(findAll(dialog, (node) => node.tagName === "input").length, 0, "no form control holds the hash, so a selection of the receipt yields its characters");
		assert.equal(hashValue.attributes.role, "group", "the hash is a named group, the shape a bare span cannot take a name in");
		assert.equal(hashValue.attributes["aria-label"], "Transaction hash", "named by its label, so a screen-reader user reaching the focus stop hears which value it holds");
		assert.equal(hashValue.attributes.tabindex, "0", "and a focus stop of its own, which is how a value wider than the panel is read to its tail");
		const receipt = findAll(dialog, (node) => hasClass(node, "pay-result"))[0];
		assert.ok(hasClass(receipt, "fit-sized"), "and its row is one the ladder sizes, which is what paints the cue beside a hash the panel cannot hold whole");
		assert.equal(findAll(dialog, (node) => node.tagName === "a").length, 0, "no block-explorer link");

		const copyControl = byText(dialog, "button", "Copy")[0];
		assert.ok(hasClass(copyControl, "pay-copy"), "the receipt row's copy control carries the class the stylesheet keeps out of a text selection, so a drag over the row cannot add its face to the hash");
		click(copyControl);
		await drain();
		assert.deepEqual(written, [TX_HASH]);
		assert.equal(findAll(dialog, (node) => hasClass(node, "pay-copy-status"))[0].textContent, "Copied");
		assert.equal(notices.calls.at(-1).tone, "success");

		const offline = openPayPanel(usdcInvoice(), { notice: noticeRecorder(), clipboard: null });
		click(byText(offline.element, "button", "Connect wallet & pay")[0]);
		await drain();
		const offlineDialog = dialogOf(offline);
		const offlineHash = findAll(offlineDialog, (node) => hasClass(node, "pay-hash"))[0];
		const selections = fake.document.selections;
		click(byText(offlineDialog, "button", "Copy")[0]);
		await drain();
		assert.equal(selections.length, 1, "without a clipboard the hash is selected for a manual copy");
		assert.equal(selections[0].node, offlineHash, "and the selection is taken over the value element that holds the hash, whose characters are the value itself");
		assert.equal(
			findAll(offlineDialog, (node) => hasClass(node, "pay-copy-status"))[0].textContent,
			"Press Ctrl/Cmd+C to copy",
		);
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("with no wallet installed the panel says so and calls nothing", async () => {
	const fake = installInteractiveDocument();
	const installed = installWindow({});
	try {
		const notices = noticeRecorder();
		const handle = openPayPanel(usdcInvoice(), { notice: notices, clipboard: null });
		click(byText(handle.element, "button", "Connect wallet & pay")[0]);
		await drain();
		assert.match(textOf(dialogOf(handle)), /No Ethereum wallet was found/);
		assert.equal(notices.calls.at(-1).tone, "error");
		assert.ok(byText(handle.element, "button", "Try again")[0], "the panel offers a retry");
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("the panel reports a declined connection instead of throwing", async () => {
	const fake = installInteractiveDocument();
	const provider = mockProvider();
	provider.state.fail.eth_requestAccounts = { code: 4001, message: "User rejected the request." };
	const installed = installWindow({ ethereum: provider });
	try {
		const notices = noticeRecorder();
		const handle = openPayPanel(usdcInvoice(), { notice: notices, clipboard: null });
		click(byText(handle.element, "button", "Connect wallet & pay")[0]);
		await drain();
		assert.match(textOf(dialogOf(handle)), /declined the connection request/);
		assert.equal(notices.calls.at(-1).tone, "error");
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("the panel guides a wrong network and pays once the wallet switches", async () => {
	const fake = installInteractiveDocument();
	const provider = mockProvider({ chainId: "0x89" });
	provider.state.switchFails = "reject";
	const installed = installWindow({ ethereum: provider });
	try {
		const notices = noticeRecorder();
		const handle = openPayPanel(usdcInvoice(), { notice: notices, clipboard: null });
		click(byText(handle.element, "button", "Connect wallet & pay")[0]);
		await drain();

		const dialog = dialogOf(handle);
		const switchButton = byText(dialog, "button", "Switch network in my wallet")[0];
		assert.ok(switchButton, "the panel offers a switch control");
		assert.match(textOf(dialog), /declined the network switch/);
		assert.equal(provider.calls.some((call) => call.method === "eth_sendTransaction"), false);
		assert.equal(notices.calls.at(-1).tone, "error");

		provider.state.switchFails = null;
		provider.state.chainAfterSwitch = "0x1";
		click(switchButton);
		await drain();
		assert.equal(provider.calls.some((call) => call.method === "eth_sendTransaction"), true);
		assert.equal(hashOf(dialog), TX_HASH);
		assert.ok(
			findAll(dialog, (node) => hasClass(node, "pay-account")).length === 1,
			"the connected account is shown",
		);
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("the panel refuses to send when the balance is short and re-checks on retry", async () => {
	const fake = installInteractiveDocument();
	const provider = mockProvider({ callResult: word(1n) });
	const installed = installWindow({ ethereum: provider });
	try {
		const notices = noticeRecorder();
		const handle = openPayPanel(usdcInvoice(), { notice: notices, clipboard: null });
		click(byText(handle.element, "button", "Connect wallet & pay")[0]);
		await drain();

		const dialog = dialogOf(handle);
		assert.match(textOf(dialog), /less than the 357 USDC needed/);
		assert.equal(provider.calls.some((call) => call.method === "eth_sendTransaction"), false);

		assert.match(textOf(dialog), /Wallet balance: 0\.000001 USDC/, "the balance reads as the line it names, beside the wallet's report of it");

		provider.state.callResult = word(USDC_TOTAL);
		click(byText(dialog, "button", "Try again")[0]);
		await drain();
		assert.equal(provider.calls.some((call) => call.method === "eth_sendTransaction"), true);
		assert.equal(hashOf(dialog), TX_HASH);
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("a transaction the payer declines in the wallet is reported, not thrown", async () => {
	const fake = installInteractiveDocument();
	const provider = mockProvider();
	provider.state.fail.eth_sendTransaction = { code: 4001, message: "User rejected the request." };
	const installed = installWindow({ ethereum: provider });
	try {
		const notices = noticeRecorder();
		const handle = openPayPanel(usdcInvoice(), { notice: notices, clipboard: null });
		click(byText(handle.element, "button", "Connect wallet & pay")[0]);
		await drain();
		const dialog = dialogOf(handle);
		assert.match(textOf(dialog), /declined the transaction/);
		assert.match(textOf(dialog), /No payment was sent/);
		assert.ok(byText(dialog, "button", "Try again")[0]);
		assert.equal(notices.calls.at(-1).tone, "error");
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("the panel offers every announced wallet before connecting", async () => {
	const fake = installInteractiveDocument();
	const meta = mockProvider();
	const rabby = mockProvider();
	const target = announcementTarget([
		{ info: { uuid: "meta", name: "MetaMask" }, provider: meta },
		{ info: { uuid: "rabby", name: "Rabby" }, provider: rabby },
	]);
	const installed = installWindow({
		addEventListener: target.addEventListener,
		removeEventListener: target.removeEventListener,
		dispatchEvent: target.dispatchEvent,
	});
	try {
		const handle = openPayPanel(usdcInvoice(), { notice: noticeRecorder(), clipboard: null });
		click(byText(handle.element, "button", "Connect wallet & pay")[0]);
		await new Promise((resolve) => setTimeout(resolve, 250));

		const dialog = dialogOf(handle);
		const choices = byText(dialog, "button", "Pay with MetaMask").concat(byText(dialog, "button", "Pay with Rabby"));
		assert.equal(choices.length, 2, "one control per announced wallet");
		assert.equal(meta.calls.length, 0, "choosing a wallet is what reaches it");
		assert.equal(rabby.calls.length, 0);

		click(choices[1]);
		await drain();
		assert.equal(rabby.calls.some((call) => call.method === "eth_sendTransaction"), true);
		assert.equal(meta.calls.length, 0, "the wallet the payer did not choose is never reached");
		assert.equal(hashOf(dialog), TX_HASH);
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("the shell installs the payment panel as the Pay handler, and only a click reaches the wallet", async () => {
	const fake = installInteractiveDocument();
	const provider = mockProvider();
	const installed = installWindow({ ethereum: provider });
	try {
		const shell = mountShell(document.createElement("div"));
		renderRoute(shell, parseHash(`#/i/${encodeInvoice(usdcInvoice())}`), VIEW_OPTIONS);

		const pay = byText(shell.content, "button", "Pay")[0];
		assert.ok(pay, "the Pay control is present");
		assert.equal("disabled" in pay.attributes, false, "the default wallet flow activates Pay");
		assert.equal(provider.calls.length, 0, "rendering the route must not touch the wallet");

		click(pay);
		await drain();
		assert.equal(provider.calls.length, 0, "opening the panel must not touch the wallet");

		const panel = findAll(document.body, (node) => hasClass(node, "pay-dialog"))[0];
		assert.ok(panel, "the payment panel opens over the page");
		click(byText(panel, "button", "Connect wallet & pay")[0]);
		await drain();

		assert.equal(provider.calls.some((call) => call.method === "eth_sendTransaction"), true);
		assert.match(shell.notice.children[0].textContent, /Payment submitted/);
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("the shell reports a missing wallet through the notice region", async () => {
	const fake = installInteractiveDocument();
	const installed = installWindow({});
	try {
		const shell = mountShell(document.createElement("div"));
		renderRoute(shell, parseHash(`#/i/${encodeInvoice(usdcInvoice())}`), VIEW_OPTIONS);
		click(byText(shell.content, "button", "Pay")[0]);
		await drain();
		const panel = findAll(document.body, (node) => hasClass(node, "pay-dialog"))[0];
		click(byText(panel, "button", "Connect wallet & pay")[0]);
		await drain();
		const notice = shell.notice.children[0];
		assert.ok(notice, "a failure reaches the notice region");
		assert.match(notice.textContent, /No Ethereum wallet was found/);
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("the whole pay flow performs zero network I/O apart from the injected provider", async () => {
	const fake = installInteractiveDocument();
	const provider = mockProvider();
	const installed = installWindow({ ethereum: provider });
	const network = [];
	const restoreNetwork = blockNetwork(network);
	try {
		const handle = openPayPanel(usdcInvoice(), {
			notice: noticeRecorder(),
			clipboard: { writeText: async () => {} },
		});
		click(byText(handle.element, "button", "Connect wallet & pay")[0]);
		await drain();
		click(byText(dialogOf(handle), "button", "Copy")[0]);
		await drain();

		assert.equal(hashOf(dialogOf(handle)), TX_HASH);
		assert.deepEqual(network, [], "no page-origin network API was used");
		assert.deepEqual(
			provider.calls.map((call) => call.method),
			["eth_requestAccounts", "eth_chainId", "eth_chainId", "eth_call", "eth_chainId", "eth_sendTransaction"],
			"the wallet is the only channel, and only these calls travel over it",
		);
	} finally {
		restoreNetwork();
		installed.restore();
		fake.restore();
	}
});

test("an ambiguous send failure offers a send-only retry and an 'already sent' exit", async () => {
	const fake = installInteractiveDocument();
	const provider = mockProvider();
	provider.state.fail.eth_sendTransaction = { code: -32000, message: "timeout" };
	const installed = installWindow({ ethereum: provider });
	try {
		const notices = noticeRecorder();
		const handle = openPayPanel(usdcInvoice(), { notice: notices, clipboard: null });
		click(byText(handle.element, "button", "Connect wallet & pay")[0]);
		await drain();

		const dialog = dialogOf(handle);
		assert.match(textOf(dialog), /may still have been sent/);
		assert.ok(byText(dialog, "button", "Try sending again")[0], "the retry re-sends only");
		assert.ok(byText(dialog, "button", "I already sent it")[0], "an acknowledgement is offered");
		assert.equal(byText(dialog, "button", "Try again").length, 0, "no full-flow retry is offered after a send");
		assert.equal(notices.calls.at(-1).tone, "error");

		const before = provider.calls.length;
		provider.state.fail.eth_sendTransaction = undefined;
		click(byText(dialog, "button", "Try sending again")[0]);
		await drain();

		assert.equal(hashOf(dialog), TX_HASH);
		assert.deepEqual(
			provider.calls.slice(before).map((call) => call.method),
			["eth_chainId", "eth_sendTransaction"],
			"the retry re-runs only the chain check and the send step",
		);
		assert.equal(
			provider.calls.filter((call) => call.method === "eth_requestAccounts").length,
			1,
			"the connection request is not repeated",
		);
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("the 'I already sent it' exit dismisses the panel without touching the wallet", async () => {
	const fake = installInteractiveDocument();
	const provider = mockProvider();
	provider.state.fail.eth_sendTransaction = { code: -32000, message: "timeout" };
	const installed = installWindow({ ethereum: provider });
	try {
		const handle = openPayPanel(usdcInvoice(), { notice: noticeRecorder(), clipboard: null });
		click(byText(handle.element, "button", "Connect wallet & pay")[0]);
		await drain();

		const dialog = dialogOf(handle);
		const before = provider.calls.length;
		click(byText(dialog, "button", "I already sent it")[0]);
		await drain();

		assert.equal(provider.calls.length, before, "acknowledging sends nothing");
		assert.equal(
			findAll(document.body, (node) => hasClass(node, "pay-dialog")).length,
			0,
			"the panel closes",
		);
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("the shell's default Pay handler pays with zero network I/O apart from the injected provider", async () => {
	const fake = installInteractiveDocument();
	const provider = mockProvider();
	const installed = installWindow({ ethereum: provider });
	const network = [];
	const restoreNetwork = blockNetwork(network);
	try {
		const shell = mountShell(document.createElement("div"));
		renderRoute(shell, parseHash(`#/i/${encodeInvoice(usdcInvoice())}`), VIEW_OPTIONS);

		assert.equal(provider.calls.length, 0, "rendering the route must not touch the wallet");
		click(byText(shell.content, "button", "Pay")[0]);
		await drain();
		assert.equal(provider.calls.length, 0, "opening the panel must not touch the wallet");

		const panel = findAll(document.body, (node) => hasClass(node, "pay-dialog"))[0];
		assert.ok(panel, "the shell's default Pay handler opens the panel");
		click(byText(panel, "button", "Connect wallet & pay")[0]);
		await drain();

		assert.equal(hashOf(panel), TX_HASH);
		assert.deepEqual(network, [], "no page-origin network API was used");
		assert.deepEqual(
			provider.calls.map((call) => call.method),
			["eth_requestAccounts", "eth_chainId", "eth_chainId", "eth_call", "eth_chainId", "eth_sendTransaction"],
			"the wallet is the only channel",
		);
	} finally {
		restoreNetwork();
		installed.restore();
		fake.restore();
	}
});

test("the shell's default Pay handler discovers an EIP-6963 wallet with zero network I/O", async () => {
	const fake = installInteractiveDocument();
	const meta = mockProvider();
	const rabby = mockProvider();
	const target = announcementTarget([
		{ info: { uuid: "meta", name: "MetaMask" }, provider: meta },
		{ info: { uuid: "rabby", name: "Rabby" }, provider: rabby },
	]);
	const installed = installWindow({
		addEventListener: target.addEventListener,
		removeEventListener: target.removeEventListener,
		dispatchEvent: target.dispatchEvent,
	});
	const network = [];
	const restoreNetwork = blockNetwork(network);
	try {
		const shell = mountShell(document.createElement("div"));
		renderRoute(shell, parseHash(`#/i/${encodeInvoice(usdcInvoice())}`), VIEW_OPTIONS);
		click(byText(shell.content, "button", "Pay")[0]);
		await drain();

		const panel = findAll(document.body, (node) => hasClass(node, "pay-dialog"))[0];
		click(byText(panel, "button", "Connect wallet & pay")[0]);
		await new Promise((resolve) => setTimeout(resolve, 250));

		assert.equal(meta.calls.length, 0, "discovery alone reaches no wallet");
		assert.equal(rabby.calls.length, 0);
		const chosen = byText(panel, "button", "Pay with Rabby")[0];
		assert.ok(chosen, "the announced wallets are offered as a picker");
		click(chosen);
		await drain();

		assert.equal(hashOf(panel), TX_HASH);
		assert.deepEqual(network, [], "no page-origin network API was used");
		assert.deepEqual(
			rabby.calls.map((call) => call.method),
			["eth_requestAccounts", "eth_chainId", "eth_chainId", "eth_call", "eth_chainId", "eth_sendTransaction"],
		);
		assert.equal(meta.calls.length, 0, "the wallet the payer did not choose is never reached");
		assert.equal(target.listenerCount(), 0, "the announcement listener is removed after discovery");
	} finally {
		restoreNetwork();
		installed.restore();
		fake.restore();
	}
});

test("an over-long provider quantity is rejected before it reaches BigInt", () => {
	assert.throws(() => fromHexQuantity(`0x${"f".repeat(65)}`, "eth_getBalance"), WalletResponseError);
	assert.throws(() => normalizeChainId(`0x${"1".repeat(65)}`), WalletResponseError);
	assert.equal(fromHexQuantity(`0x${"f".repeat(64)}`, "test"), (1n << 256n) - 1n, "a full uint256 still fits");
	assert.equal(fromHexQuantity("0x0", "test"), 0n);
});

test("a hostile provider's oversized chain id cannot reach the status line", async () => {
	const fake = installInteractiveDocument();
	const provider = mockProvider({ chainId: "0x89" });
	provider.state.chainId = `0x${"1".repeat(4000)}`;
	const installed = installWindow({ ethereum: provider });
	try {
		const notices = noticeRecorder();
		const handle = openPayPanel(usdcInvoice(), { notice: notices, clipboard: null });
		click(byText(handle.element, "button", "Connect wallet & pay")[0]);
		await drain();

		const dialog = dialogOf(handle);
		assert.match(textOf(dialog), /could not use/);
		assert.doesNotMatch(textOf(dialog), /11111/);
		assert.equal(notices.calls.at(-1).tone, "error");
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("a declined retry after an ambiguous send keeps the panel in the send-only caution state", async () => {
	const fake = installInteractiveDocument();
	const provider = mockProvider();
	provider.state.fail.eth_sendTransaction = { code: -32000, message: "timeout" };
	const installed = installWindow({ ethereum: provider });
	try {
		const handle = openPayPanel(usdcInvoice(), { notice: noticeRecorder(), clipboard: null });
		click(byText(handle.element, "button", "Connect wallet & pay")[0]);
		await drain();

		const dialog = dialogOf(handle);
		assert.match(textOf(dialog), /may still have been sent/);
		assert.ok(byText(dialog, "button", "Try sending again")[0]);

		provider.state.fail.eth_sendTransaction = { code: 4001, message: "User rejected the request." };
		click(byText(dialog, "button", "Try sending again")[0]);
		await drain();

		assert.match(textOf(dialog), /may still have been sent/);
		assert.ok(byText(dialog, "button", "Try sending again")[0], "the send-only retry remains");
		assert.equal(byText(dialog, "button", "Try again").length, 0, "the whole-flow retry is never offered after a send");
		assert.equal(
			provider.calls.filter((call) => call.method === "eth_requestAccounts").length,
			1,
			"the whole flow is not re-run after a send attempt",
		);
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("an ambiguous send whose retry drifts networks keeps the caution and the send-only retry", async () => {
	const fake = installInteractiveDocument();
	const provider = mockProvider();
	provider.state.fail.eth_sendTransaction = { code: -32000, message: "timeout" };
	const installed = installWindow({ ethereum: provider });
	try {
		const handle = openPayPanel(usdcInvoice(), { notice: noticeRecorder(), clipboard: null });
		click(byText(handle.element, "button", "Connect wallet & pay")[0]);
		await drain();

		const dialog = dialogOf(handle);
		provider.state.fail.eth_sendTransaction = undefined;
		provider.state.chainId = "0x89";
		click(byText(dialog, "button", "Try sending again")[0]);
		await drain();

		assert.match(textOf(dialog), /may still have been sent/);
		assert.match(textOf(dialog), /Ethereum \(0x1\)/, "the network guidance still names the invoice network");
		assert.ok(byText(dialog, "button", "Try sending again")[0]);
		assert.equal(byText(dialog, "button", "Try again").length, 0, "a drifted retry never offers the whole-flow retry");
		assert.equal(
			provider.calls.filter((call) => call.method === "eth_sendTransaction").length,
			1,
			"the drifted retry sends nothing",
		);
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("eth_call refuses an oversized reply before scanning it and admits a generous one", async () => {
	const provider = mockProvider({ callResult: `0x${"ff".repeat(2049)}` });
	await assert.rejects(
		() => new WalletClient(provider, "Mock").call(ACCOUNT, "0x70a08231"),
		WalletResponseError,
	);
	const generous = mockProvider({ callResult: `0x${"ff".repeat(2048)}` });
	const data = await new WalletClient(generous, "Mock").call(ACCOUNT, "0x70a08231");
	assert.equal(data.length, 2 + 2048 * 2, "a generous reply is still accepted");
});

test("the payment panel opens inside a frame and still contacts no wallet until the click", async () => {
	const fake = installInteractiveDocument();
	const provider = mockProvider();
	const installed = installWindow({ ethereum: provider, top: {} });
	try {
		assert.notEqual(globalThis.window.top, globalThis.window, "the fixture is a framed document rather than the top-level page");
		const notices = noticeRecorder();
		const handle = openPayPanel(usdcInvoice(), { notice: notices, clipboard: null });
		assert.ok(handle, "the panel is presented inside the frame");
		assert.equal(notices.calls.filter((call) => call.tone === "error").length, 0, "and no refusal is raised for the frame");
		assert.equal(provider.calls.length, 0, "opening the panel contacts no wallet");
		click(byText(handle.element, "button", "Connect wallet & pay")[0]);
		await drain();
		assert.equal(hashOf(handle.element), TX_HASH, "the payer's own click inside the frame is the only route to the provider");
		assert.equal(provider.calls.filter((call) => call.method === "eth_sendTransaction").length, 1, "and the flow it starts sends exactly once");
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("a panel reopened for the same invoice refuses a second payment", async () => {
	const fake = installInteractiveDocument();
	const provider = mockProvider();
	const installed = installWindow({ ethereum: provider });
	try {
		const notices = noticeRecorder();
		const invoice = usdcInvoice();
		const first = openPayPanel(invoice, { notice: notices, clipboard: null });
		click(byText(first.element, "button", "Connect wallet & pay")[0]);
		await drain();
		assert.equal(hashOf(first.element), TX_HASH, "the first panel paid once");
		click(byText(first.element, "button", "Done")[0]);

		const again = openPayPanel(invoice, { notice: notices, clipboard: null });
		assert.equal(again, null, "the reopened panel is refused for this invoice");
		assert.match(notices.calls.at(-1).message, /already attempted/);
		assert.equal(
			provider.calls.filter((call) => call.method === "eth_sendTransaction").length,
			1,
			"only one transaction was broadcast",
		);
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("navigating away and back to the same invoice cannot re-arm the payment latch", async () => {
	const fake = installInteractiveDocument();
	const provider = mockProvider();
	const installed = installWindow({ ethereum: provider });
	try {
		const notices = noticeRecorder();
		const fragment = encodeShare(usdcInvoice());
		const first = parseHash(fragment);
		// A trip to the create route and back decodes the same fragment into a distinct Invoice object, exactly as a real hashchange does.
		assert.equal(parseHash("#/create").kind, "create");
		const second = parseHash(fragment);
		assert.equal(first.kind, "view");
		assert.equal(second.kind, "view");
		assert.notEqual(first.invoice, second.invoice, "the router mints a fresh invoice for each fragment parse");

		const handle = openPayPanel(first.invoice, { notice: notices, clipboard: null });
		click(byText(handle.element, "button", "Connect wallet & pay")[0]);
		await drain();
		assert.equal(hashOf(handle.element), TX_HASH, "the first visit pays once");

		const again = openPayPanel(second.invoice, { notice: notices, clipboard: null });
		assert.equal(again, null, "the re-parsed invoice is still refused");
		assert.match(notices.calls.at(-1).message, /already attempted/);
		assert.equal(
			provider.calls.filter((call) => call.method === "eth_sendTransaction").length,
			1,
			"only one transaction was broadcast",
		);
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("a wallet label is stripped of invisible and direction-formatting characters before it is shown", async () => {
	const target = announcementTarget([
		{ info: { uuid: "spoof", name: "Meta\u202EMask\u200B" }, provider: mockProvider() },
		{ info: { uuid: "invisible", name: "\u200B" }, provider: mockProvider() },
		{ info: { uuid: "control", name: "Wa\u0000llet" }, provider: mockProvider() },
	]);
	const candidates = await walletCandidates({ target, timeoutMs: 0 });
	assert.deepEqual(
		candidates.map((candidate) => candidate.label),
		["MetaMask", "Wallet"],
		"the bidi override, zero-width space, and NUL are stripped, and a label that is only invisible characters is dropped",
	);
});

test("the payment panel is refused when another page opened this one", async () => {
	const fake = installInteractiveDocument();
	const provider = mockProvider();
	const installed = installWindow({ ethereum: provider, opener: {} });
	try {
		const notices = noticeRecorder();
		const handle = openPayPanel(usdcInvoice(), { notice: notices, clipboard: null });
		assert.equal(handle, null, "no panel is presented in a window another page opened");
		const message = notices.calls.at(-1).message;
		assert.match(message, /opened by another page/);
		// The refusal tests presence and nothing else, so it refuses every opener, and the notice has to say so: a payer who followed a plain link across origins has an opener too, and a sentence that named only a page from this website as the reason would tell them something untrue about their own window.
		assert.match(message, /every opener is refused/, "the notice says what the refusal does — every opener is refused, not only one kind of opener");
		assert.match(message, /whichever page that is/, "including the window the payer is looking at, whatever page opened it");
		assert.match(message, /could drive the payment controls/, "while still naming the hazard that makes an opener a reason to refuse at all");
		assert.doesNotMatch(message, /\(\d+ characters\)/, "and the refusal reaches the payer whole rather than cut off at the notice region's bound");
		assert.equal(notices.calls.at(-1).tone, "error");
		assert.equal(provider.calls.length, 0, "refusing the panel contacts no wallet");
	} finally {
		installed.restore();
		fake.restore();
	}
});
