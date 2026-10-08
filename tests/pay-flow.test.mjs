/** The suite for `app/js/ui/pay-flow.js`: the payment state machine driven with a mock provider through discovery, connection, the chain check, the funds read, the send, and the send-only retry. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { installInteractiveDocument } from "./helpers/dom.mjs";
import { findAll } from "./helpers/tree.mjs";
import {
	ACCOUNT,
	TX_HASH,
	word,
	mockProvider,
	installWindow,
	announcementTarget,
	noticeRecorder,
} from "./helpers/wallet-mock.mjs";
import { createInvoice } from "../app/js/invoice/model.js";
import { openPayPanel } from "../app/js/ui/pay.js";
import { createPayFlow } from "../app/js/ui/pay-flow.js";
import { WalletClient, WalletRequestError } from "../app/js/wallet/eip1193.js";
import { buildPaymentPlan, readBalance } from "../app/js/wallet/payment.js";

const PAYEE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const USDC_TOTAL = 357000000n;

function usdcInvoice(overrides = {}) {
	return createInvoice({
		id: "INV-1",
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
		id: "INV-ETH",
		issued: "2026-10-03",
		payee: { name: "Studio Example", address: PAYEE },
		chainId: "0x1",
		asset: "eth",
		items: [{ description: "Advice", quantity: "1", unitPrice: "1.5" }],
		...overrides,
	});
}

function hasClass(node, name) {
	return (node.attributes.class ?? "").split(/\s+/).includes(name);
}

function buttonLabels(rootNode) {
	return findAll(rootNode, (node) => node.tagName === "button").map((button) => button.textContent);
}

async function drain() {
	for (let index = 0; index < 3; index += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

/** True when `ancestor` is `node` or an element `node` sits inside, following parentNode links. */
function isWithin(node, ancestor) {
	let current = node;
	while (current != null) {
		if (current === ancestor) return true;
		current = current.parentNode ?? null;
	}
	return false;
}

/** Build a flow recorder: the frames it drew, and the notices it raised. */
function recorder() {
	const frames = [];
	const notices = [];
	return {
		frames,
		notices,
		callbacks: {
			onSnapshot: (snapshot) => frames.push(snapshot),
			onNotice: (message, tone) => notices.push({ message, tone }),
		},
		last: () => frames.at(-1).view,
	};
}

test("the driver walks discovery → connect → chain → balance → send with no DOM", async () => {
	const provider = mockProvider();
	const installed = installWindow({ ethereum: provider });
	try {
		const plan = buildPaymentPlan(usdcInvoice());
		const flow = recorder();
		const pay = createPayFlow(plan, flow.callbacks);

		assert.equal(flow.frames.length, 0, "creating the flow emits nothing");
		assert.equal(provider.calls.length, 0, "creating the flow touches no wallet");

		await pay.begin();

		assert.deepEqual(
			provider.calls.map((call) => call.method),
			["eth_requestAccounts", "eth_chainId", "eth_chainId", "eth_call", "eth_chainId", "eth_sendTransaction"],
		);
		assert.equal(flow.frames[0].view.kind, "busy", "the flow opens by announcing discovery");
		assert.equal(flow.last().kind, "sent");
		assert.equal(flow.last().receipt.hash, TX_HASH);
		assert.equal(flow.frames.at(-1).session.account, ACCOUNT, "the connected account travels with the frame");
		assert.equal(flow.frames.at(-1).balance, null, "the balance line is cleared once the transaction is sent");
		assert.deepEqual(flow.notices.at(-1), { message: `Payment submitted: ${TX_HASH}`, tone: "success" });
	} finally {
		installed.restore();
	}
});

test("the driver reports a missing wallet as a failed frame and an error notice", async () => {
	const installed = installWindow({});
	try {
		const flow = recorder();
		const pay = createPayFlow(buildPaymentPlan(usdcInvoice()), flow.callbacks);
		await pay.begin();

		assert.equal(flow.last().kind, "failed");
		assert.match(flow.last().message, /No Ethereum wallet was found/);
		assert.equal(flow.notices.at(-1).tone, "error");
	} finally {
		installed.restore();
	}
});

test("an unknown chain gets its own frame distinct from the wrong-chain switch path", async () => {
	const provider = mockProvider({ chainId: "0x89" });
	provider.state.switchFails = "unknown";
	const installed = installWindow({ ethereum: provider });
	try {
		const flow = recorder();
		const pay = createPayFlow(buildPaymentPlan(usdcInvoice()), flow.callbacks);
		await pay.begin();

		assert.equal(flow.last().kind, "unknown-chain");
		assert.match(flow.last().message, /does not know the network Ethereum \(0x1\)/);
		assert.match(flow.last().message, /Add that network in your wallet/);
		assert.equal(provider.calls.some((call) => call.method === "eth_sendTransaction"), false);
		assert.equal(flow.notices.at(-1).tone, "error");

		provider.state.switchFails = null;
		provider.state.chainAfterSwitch = "0x1";
		await pay.retryChain();
		assert.equal(flow.last().kind, "sent");
		assert.equal(flow.last().receipt.hash, TX_HASH);
	} finally {
		installed.restore();
	}
});

test("a declined network switch keeps the switch affordance", async () => {
	const provider = mockProvider({ chainId: "0x89" });
	provider.state.switchFails = "reject";
	const installed = installWindow({ ethereum: provider });
	try {
		const flow = recorder();
		const pay = createPayFlow(buildPaymentPlan(usdcInvoice()), flow.callbacks);
		await pay.begin();

		assert.equal(flow.last().kind, "wrong-chain");
		assert.match(flow.last().message, /declined the network switch/);
	} finally {
		installed.restore();
	}
});

test("the driver refuses a short balance and pays after a top-up", async () => {
	const provider = mockProvider({ callResult: word(1n) });
	const installed = installWindow({ ethereum: provider });
	try {
		const flow = recorder();
		const pay = createPayFlow(buildPaymentPlan(usdcInvoice()), flow.callbacks);
		await pay.begin();

		assert.equal(flow.last().kind, "failed");
		assert.match(flow.last().message, /less than the 357 USDC needed/);
		assert.equal(provider.calls.some((call) => call.method === "eth_sendTransaction"), false);

		provider.state.callResult = word(USDC_TOTAL);
		await pay.begin();
		assert.equal(flow.last().kind, "sent");
	} finally {
		installed.restore();
	}
});

test("the driver offers a picker and connects only the chosen wallet", async () => {
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
		const flow = recorder();
		const pay = createPayFlow(buildPaymentPlan(usdcInvoice()), flow.callbacks);
		await pay.begin();

		const picker = flow.last();
		assert.equal(picker.kind, "picker");
		assert.deepEqual(picker.candidates.map((candidate) => candidate.label), ["MetaMask", "Rabby"]);
		assert.equal(meta.calls.length, 0, "discovery does not reach a wallet");
		assert.equal(rabby.calls.length, 0);

		await pay.connectWith(picker.candidates[1]);
		assert.equal(rabby.calls.some((call) => call.method === "eth_sendTransaction"), true);
		assert.equal(meta.calls.length, 0, "the wallet the payer did not choose is never reached");
		assert.equal(flow.last().kind, "sent");
	} finally {
		installed.restore();
	}
});

test("readBalance rejects on a failed read rather than resolving a null balance", async () => {
	const failedCall = mockProvider();
	failedCall.state.fail.eth_call = { code: -32000, message: "boom" };
	const plan = buildPaymentPlan(usdcInvoice());
	await assert.rejects(() => readBalance(new WalletClient(failedCall, "Mock"), plan.asset, ACCOUNT), WalletRequestError);

	const failedBalance = mockProvider();
	failedBalance.state.fail.eth_getBalance = { code: -32000, message: "boom" };
	const native = buildPaymentPlan(ethInvoice());
	await assert.rejects(
		() => readBalance(new WalletClient(failedBalance, "Mock"), native.asset, ACCOUNT),
		WalletRequestError,
	);
});

test("the panel offers a retry, not a switch, when the wallet does not know the network", async () => {
	const fake = installInteractiveDocument();
	const provider = mockProvider({ chainId: "0x89" });
	provider.state.switchFails = "unknown";
	const installed = installWindow({ ethereum: provider });
	try {
		const notices = noticeRecorder();
		const handle = openPayPanel(usdcInvoice(), { notice: notices, clipboard: null });
		handle.element.querySelector(".pay-connect").dispatch("click", { type: "click" });
		await drain();

		const status = findAll(handle.element, (node) => hasClass(node, "pay-status"))[0];
		assert.match(status.textContent, /does not know the network Ethereum \(0x1\)/);
		assert.ok(buttonLabels(handle.element).includes("Retry the network check"), "the affordance retries the check");
		assert.ok(
			!buttonLabels(handle.element).includes("Switch network in my wallet"),
			"the wrong-chain switch control cannot succeed for an unknown chain",
		);
		assert.equal(notices.calls.at(-1).tone, "error");
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("the payment panel focuses its primary action on open, not the header close button", () => {
	const fake = installInteractiveDocument();
	const installed = installWindow({});
	try {
		const handle = openPayPanel(usdcInvoice(), {
			notice: { showNotice() {}, clearNotice() {} },
			clipboard: null,
		});
		const primary = findAll(handle.element, (node) => hasClass(node, "pay-connect"))[0];
		const close = findAll(handle.element, (node) => hasClass(node, "dialog-close"))[0];
		assert.ok(primary, "the primary action is present");
		assert.ok(close, "the close control is present");
		assert.equal(document.activeElement, primary, "the primary action receives initial focus");
		assert.notEqual(document.activeElement, close);
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("a busy frame keeps focus inside the backdrop so Escape stays reachable", async () => {
	const fake = installInteractiveDocument();
	const installed = installWindow({});
	try {
		const handle = openPayPanel(usdcInvoice(), {
			notice: { showNotice() {}, clearNotice() {} },
			clipboard: null,
		});
		const primary = findAll(handle.element, (node) => hasClass(node, "pay-connect"))[0];
		assert.equal(document.activeElement, primary, "the primary action starts focused");

		primary.dispatch("click", { type: "click" });

		assert.equal(
			findAll(handle.element, (node) => hasClass(node, "pay-connect")).length,
			0,
			"the busy frame removes the control that held focus",
		);
		const active = document.activeElement;
		assert.ok(active, "focus stays in the panel rather than falling out of the dialog");
		assert.notEqual(active, primary, "focus cannot remain on the control the frame removed");
		assert.ok(
			isWithin(active, handle.element),
			"focus stays a descendant of the backdrop, where overlay.ts receives Escape and Tab",
		);

		await drain();
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("a provider failure is shown as plain guidance, not the provider's own wording", async () => {
	const provider = mockProvider();
	provider.state.fail.eth_requestAccounts = { code: -32000, message: "execution reverted" };
	const installed = installWindow({ ethereum: provider });
	try {
		const flow = recorder();
		const pay = createPayFlow(buildPaymentPlan(usdcInvoice()), flow.callbacks);
		await pay.begin();

		assert.equal(flow.last().kind, "failed");
		assert.equal(flow.last().message, "The wallet could not complete that step. Open the wallet and try again.");
		assert.doesNotMatch(flow.last().message, /wallet:|eth_requestAccounts|-32000|execution reverted/);
		assert.equal(flow.notices.at(-1).tone, "error");
	} finally {
		installed.restore();
	}
});

test("a wallet that returns no account is told in plain guidance, not the error's own wording", async () => {
	const provider = mockProvider({ accounts: [] });
	const installed = installWindow({ ethereum: provider });
	try {
		const flow = recorder();
		const pay = createPayFlow(buildPaymentPlan(usdcInvoice()), flow.callbacks);
		await pay.begin();

		assert.equal(flow.last().kind, "failed");
		assert.equal(
			flow.last().message,
			"Your wallet did not return an account to pay from. Unlock it, grant access, then try again.",
		);
		assert.doesNotMatch(flow.last().message, /payment:/);
		assert.equal(provider.calls.some((call) => call.method === "eth_sendTransaction"), false);
		assert.equal(flow.notices.at(-1).tone, "error");
	} finally {
		installed.restore();
	}
});

test("a wallet stuck on the wrong network is told in plain network wording, not the raw chain ids", async () => {
	const provider = mockProvider({ chainId: "0x89" });
	provider.state.chainAfterSwitch = "0x89";
	const installed = installWindow({ ethereum: provider });
	try {
		const flow = recorder();
		const pay = createPayFlow(buildPaymentPlan(usdcInvoice()), flow.callbacks);
		await pay.begin();

		assert.equal(flow.last().kind, "wrong-chain");
		assert.equal(
			flow.last().message,
			"Your wallet is on 0x89, but this invoice must be paid on Ethereum (0x1). Switch networks in your wallet, then try again.",
		);
		assert.doesNotMatch(flow.last().message, /payment:|"0x89"|"0x1"/);
	} finally {
		installed.restore();
	}
});

test("a wallet that drifts off the network before sending fails with the same plain wording", async () => {
	const base = mockProvider();
	const provider = {
		...base,
		async request(request) {
			if (request.method === "eth_call") base.state.chainId = "0x89";
			return base.request(request);
		},
	};
	const installed = installWindow({ ethereum: provider });
	try {
		const flow = recorder();
		const pay = createPayFlow(buildPaymentPlan(usdcInvoice()), flow.callbacks);
		await pay.begin();

		assert.equal(flow.last().kind, "failed");
		assert.equal(
			flow.last().message,
			"Your wallet is on 0x89, but this invoice must be paid on Ethereum (0x1). Switch networks in your wallet, then try again.",
		);
		assert.equal(provider.calls.some((call) => call.method === "eth_sendTransaction"), false);
	} finally {
		installed.restore();
	}
});

test("an ambiguous send failure retries only the send, never reconnecting", async () => {
	const provider = mockProvider();
	provider.state.fail.eth_sendTransaction = { code: -32000, message: "timeout" };
	const installed = installWindow({ ethereum: provider });
	try {
		const flow = recorder();
		const pay = createPayFlow(buildPaymentPlan(usdcInvoice()), flow.callbacks);
		await pay.begin();

		assert.equal(flow.last().kind, "send-failed");
		assert.match(flow.last().message, /may still have been sent/);
		assert.equal(flow.notices.at(-1).tone, "error");

		const before = provider.calls.length;
		provider.state.fail.eth_sendTransaction = undefined;
		await pay.retrySend();

		assert.equal(flow.last().kind, "sent");
		assert.equal(flow.last().receipt.hash, TX_HASH);
		assert.deepEqual(
			provider.calls.slice(before).map((call) => call.method),
			["eth_chainId", "eth_sendTransaction"],
			"the retry repeats only the chain check and the send",
		);
		assert.equal(
			provider.calls.filter((call) => call.method === "eth_requestAccounts").length,
			1,
			"the connection request is never repeated after an ambiguous send",
		);
	} finally {
		installed.restore();
	}
});

test("a transaction the payer declined keeps the full-flow retry rather than a send-only one", async () => {
	const provider = mockProvider();
	provider.state.fail.eth_sendTransaction = { code: 4001, message: "User rejected the request." };
	const installed = installWindow({ ethereum: provider });
	try {
		const flow = recorder();
		const pay = createPayFlow(buildPaymentPlan(usdcInvoice()), flow.callbacks);
		await pay.begin();

		assert.equal(flow.last().kind, "failed", "a rejection broadcast nothing, so the whole flow may be retried");
		assert.match(flow.last().message, /declined the transaction/);
		assert.match(flow.last().message, /No payment was sent/);
	} finally {
		installed.restore();
	}
});

test("retrying a send with no retained session asks the payer to reconnect", async () => {
	const installed = installWindow({});
	try {
		const flow = recorder();
		const pay = createPayFlow(buildPaymentPlan(usdcInvoice()), flow.callbacks);
		await pay.begin();
		await pay.retrySend();

		assert.equal(flow.last().kind, "failed");
		assert.match(flow.last().message, /no longer connected/);
	} finally {
		installed.restore();
	}
});

test("a retry the payer declines after an ambiguous send stays in the caution state", async () => {
	const provider = mockProvider();
	provider.state.fail.eth_sendTransaction = { code: -32000, message: "timeout" };
	const installed = installWindow({ ethereum: provider });
	try {
		const flow = recorder();
		const pay = createPayFlow(buildPaymentPlan(usdcInvoice()), flow.callbacks);
		await pay.begin();
		assert.equal(flow.last().kind, "send-failed");

		provider.state.fail.eth_sendTransaction = { code: 4001, message: "User rejected the request." };
		await pay.retrySend();

		assert.equal(flow.last().kind, "send-failed", "a declined retry may not reopen the whole-flow path");
		assert.match(flow.last().message, /may still have been sent/);
		assert.equal(
			provider.calls.filter((call) => call.method === "eth_requestAccounts").length,
			1,
			"the whole flow is not re-run after a send attempt",
		);
	} finally {
		installed.restore();
	}
});

test("a retry after an ambiguous send that finds the wrong network stays in the caution state", async () => {
	const provider = mockProvider();
	provider.state.fail.eth_sendTransaction = { code: -32000, message: "timeout" };
	const installed = installWindow({ ethereum: provider });
	try {
		const flow = recorder();
		const pay = createPayFlow(buildPaymentPlan(usdcInvoice()), flow.callbacks);
		await pay.begin();
		assert.equal(flow.last().kind, "send-failed");

		provider.state.fail.eth_sendTransaction = undefined;
		provider.state.chainId = "0x89";
		const sendsBefore = provider.calls.filter((call) => call.method === "eth_sendTransaction").length;
		await pay.retrySend();

		assert.equal(flow.last().kind, "send-failed", "a chain drift on retry may not reopen the whole-flow path");
		assert.match(flow.last().message, /may still have been sent/);
		assert.match(flow.last().message, /Switch networks in your wallet/);
		assert.equal(
			provider.calls.filter((call) => call.method === "eth_sendTransaction").length,
			sendsBefore,
			"the drifted retry sends nothing",
		);
	} finally {
		installed.restore();
	}
});

test("a failure that escapes to guard after a send attempt stays in the caution state", async () => {
	const provider = mockProvider();
	provider.state.fail.eth_sendTransaction = { code: -32000, message: "timeout" };
	const installed = installWindow({ ethereum: provider });
	try {
		const frames = [];
		const notices = [];
		let explodeOnBusy = false;
		const pay = createPayFlow(buildPaymentPlan(usdcInvoice()), {
			onSnapshot: (snapshot) => {
				if (explodeOnBusy && snapshot.view.kind === "busy") throw new Error("render exploded");
				frames.push(snapshot);
			},
			onNotice: (message, tone) => notices.push({ message, tone }),
		});
		await pay.begin();
		assert.equal(frames.at(-1).view.kind, "send-failed");

		explodeOnBusy = true;
		provider.state.fail.eth_sendTransaction = undefined;
		await pay.retrySend();

		assert.equal(
			frames.at(-1).view.kind,
			"send-failed",
			"a guarded failure may not fall back to the whole-flow retry",
		);
		assert.match(frames.at(-1).view.message, /may still have been sent/);
		assert.equal(notices.at(-1).tone, "error");
	} finally {
		installed.restore();
	}
});

test("a declined send before any attempt still leaves the whole flow retryable", async () => {
	const provider = mockProvider();
	provider.state.fail.eth_sendTransaction = { code: 4001, message: "User rejected the request." };
	const installed = installWindow({ ethereum: provider });
	try {
		const flow = recorder();
		const pay = createPayFlow(buildPaymentPlan(usdcInvoice()), flow.callbacks);
		await pay.begin();
		assert.equal(flow.last().kind, "failed", "a declined send broadcast nothing, so nothing is latched");

		provider.state.fail.eth_sendTransaction = undefined;
		await pay.begin();
		assert.equal(flow.last().kind, "sent", "no send was attempted, so begin() may run the whole flow again");
	} finally {
		installed.restore();
	}
});

test("a second begin() while one is in flight is dropped, so one action cannot broadcast twice", async () => {
	const provider = mockProvider();
	const installed = installWindow({ ethereum: provider });
	try {
		const flow = recorder();
		const pay = createPayFlow(buildPaymentPlan(usdcInvoice()), flow.callbacks);
		await Promise.all([pay.begin(), pay.begin()]);
		assert.equal(
			provider.calls.filter((call) => call.method === "eth_requestAccounts").length,
			1,
			"only one discovery-and-connect ran",
		);
		assert.equal(
			provider.calls.filter((call) => call.method === "eth_sendTransaction").length,
			1,
			"at most one transaction was broadcast",
		);
		assert.equal(flow.last().kind, "sent");
	} finally {
		installed.restore();
	}
});

test("the send attempt is surfaced the instant the transaction leaves for the wallet", async () => {
	const base = mockProvider();
	let releaseSend = () => {};
	const gate = new Promise((resolve) => {
		releaseSend = resolve;
	});
	const provider = {
		...base,
		async request(request) {
			if (request.method === "eth_sendTransaction") await gate;
			return base.request(request);
		},
	};
	const installed = installWindow({ ethereum: provider });
	try {
		let attempts = 0;
		const flow = recorder();
		const pay = createPayFlow(buildPaymentPlan(usdcInvoice()), {
			...flow.callbacks,
			onSendAttempt: () => {
				attempts += 1;
			},
		});
		const begun = pay.begin();
		await drain();
		assert.equal(attempts, 1, "the attempt fires once the wallet is asked to send, before its reply");
		assert.equal(flow.last().kind, "busy", "no settled frame has arrived yet");
		releaseSend();
		await begun;
		assert.equal(flow.last().kind, "sent");
	} finally {
		installed.restore();
	}
});

const DISMISSALS = [
	["Escape", (handle) => handle.element.dispatch("keydown", { type: "keydown", key: "Escape" })],
	["a backdrop click", (handle) => handle.element.dispatch("click", { type: "click", target: handle.element })],
	["the header close control", (handle) => handle.element.querySelector(".dialog-close").dispatch("click", { type: "click" })],
];

for (const [index, [label, dismiss]] of DISMISSALS.entries()) {
	test(`dismissing the panel with ${label} while a send is in flight still latches the payment`, async () => {
		const fake = installInteractiveDocument();
		const base = mockProvider();
		let releaseSend = () => {};
		const gate = new Promise((resolve) => {
			releaseSend = resolve;
		});
		const provider = {
			...base,
			async request(request) {
				if (request.method === "eth_sendTransaction") await gate;
				return base.request(request);
			},
		};
		const installed = installWindow({ ethereum: provider });
		try {
			const notices = noticeRecorder();
			const invoice = usdcInvoice({ id: `INV-LATCH-${index}` });
			const handle = openPayPanel(invoice, { notice: notices, clipboard: null });
			handle.element.querySelector(".pay-connect").dispatch("click", { type: "click" });
			await drain();
			assert.equal(
				provider.calls.filter((call) => call.method === "eth_sendTransaction").length,
				0,
				"the send is still in flight",
			);

			dismiss(handle);
			assert.equal(
				findAll(document.body, (node) => hasClass(node, "pay-dialog")).length,
				0,
				"the panel is dismissed while the send is in flight",
			);

			const reopened = openPayPanel(invoice, { notice: notices, clipboard: null });
			assert.equal(reopened, null, "a panel reopened before the first send settles cannot arm a second broadcast");
			assert.match(notices.calls.at(-1).message, /already attempted/);

			releaseSend();
			await drain();
			assert.equal(
				provider.calls.filter((call) => call.method === "eth_sendTransaction").length,
				1,
				"only one transaction was ever broadcast",
			);
		} finally {
			installed.restore();
			fake.restore();
		}
	});
}

test("a panel dismissed inside the pre-send window cannot start a second flow, and only one flow broadcasts", async () => {
	const fake = installInteractiveDocument();
	const base = mockProvider();
	let releaseFunds = () => {};
	const gate = new Promise((resolve) => {
		releaseFunds = resolve;
	});
	let holdFunds = true;
	let heldAtBalance = false;
	const provider = {
		...base,
		async request(request) {
			if (request.method === "eth_call" && holdFunds) {
				holdFunds = false;
				heldAtBalance = true;
				await gate;
			}
			return base.request(request);
		},
	};
	const installed = installWindow({ ethereum: provider });
	try {
		const notices = noticeRecorder();
		const invoice = usdcInvoice({ id: "INV-PRESEND" });
		const first = openPayPanel(invoice, { notice: notices, clipboard: null });
		first.element.querySelector(".pay-connect").dispatch("click", { type: "click" });
		await drain();
		assert.equal(heldAtBalance, true, "the first flow is held at the balance read, before any send");
		assert.equal(
			provider.calls.filter((call) => call.method === "eth_sendTransaction").length,
			0,
			"the first flow has sent nothing yet",
		);

		first.element.querySelector(".dialog-close").dispatch("click", { type: "click" });
		assert.equal(
			findAll(document.body, (node) => hasClass(node, "pay-dialog")).length,
			0,
			"the panel is dismissed inside the pre-send window",
		);

		const second = openPayPanel(invoice, { notice: notices, clipboard: null });
		assert.ok(second, "no send has happened, so the invoice is not yet latched against a reopen");
		second.element.querySelector(".pay-connect").dispatch("click", { type: "click" });
		await drain();
		assert.equal(
			provider.calls.filter((call) => call.method === "eth_sendTransaction").length,
			1,
			"the reopened flow broadcasts",
		);

		releaseFunds();
		await drain();
		assert.equal(
			provider.calls.filter((call) => call.method === "eth_sendTransaction").length,
			1,
			"the flow left behind by the dismissed panel is refused at its send, so one invoice yields one broadcast",
		);
	} finally {
		installed.restore();
		fake.restore();
	}
});

test("the panel's own whole-flow retry after a declined send still broadcasts", async () => {
	const fake = installInteractiveDocument();
	const provider = mockProvider();
	provider.state.fail.eth_sendTransaction = { code: 4001, message: "User rejected the request." };
	const installed = installWindow({ ethereum: provider });
	try {
		const notices = noticeRecorder();
		const invoice = usdcInvoice({ id: "INV-DECLINE-RETRY" });
		const handle = openPayPanel(invoice, { notice: notices, clipboard: null });
		handle.element.querySelector(".pay-connect").dispatch("click", { type: "click" });
		await drain();
		assert.equal(
			provider.calls.filter((call) => call.method === "eth_sendTransaction").length,
			1,
			"the declined send is the first attempt",
		);
		assert.match(notices.calls.at(-1).message, /declined the transaction/);
		assert.match(notices.calls.at(-1).message, /No payment was sent/);

		provider.state.fail.eth_sendTransaction = undefined;
		const retry = findAll(handle.element, (node) => node.tagName === "button" && node.textContent === "Try again")[0];
		assert.ok(retry, "the panel keeps the whole-flow retry after a decline");
		retry.dispatch("click", { type: "click" });
		await drain();

		assert.equal(
			provider.calls.filter((call) => call.method === "eth_sendTransaction").length,
			2,
			"the flow that claimed the invoice may send again after its own decline",
		);
		assert.match(notices.calls.at(-1).message, /Payment submitted/);
	} finally {
		installed.restore();
		fake.restore();
	}
});
