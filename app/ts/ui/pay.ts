/**
 * The payment panel: what will be sent, and the payer's explicit route to sending it.
 *
 * The panel is the only place the wallet is reached from, and it holds the app's central guarantee: nothing touches a provider until the payer clicks.
 * The panel is itself refused — with a notice, touching no provider — when the document is displayed inside another page's frame or opened in a window another page still holds, either of which lets that page overlay or drive the Pay control, and when this invoice's payment has already been claimed, so a reopened panel cannot start a second broadcast.
 * That refusal is a client-side check on `window.top` and `window.opener`, ordinary properties a page can replace, so it is best-effort coverage of a cross-origin framer or opener; the load-bearing control for the confidentiality it is meant to protect is the dedicated-origin deployment rule (see the README's "Deploying to IPFS"), not the refusal.
 * Opening the panel computes the transfer from the validated invoice and renders it — asset, amount, recipient, network — and that is all that happens on the Pay click; discovery, connection, the chain check, the balance read, and the transaction itself all wait for the payer's own "Connect wallet & pay".
 *
 * What the flow *does* lives in `ui/pay-flow.ts`, which is free of the DOM and driven directly by tests; this module owns only how each of its states is drawn and which control maps to which step.
 * A `failed` frame — nothing was broadcast — offers a full-flow "Try again", while the ambiguous `send-failed` frame offers a send-only "Try sending again" and an "I already sent it" exit that dismisses the panel without touching the wallet, so a retry after an unclear send cannot blindly re-run the whole flow.
 * Everything the panel shows comes from `wallet/payment.ts` and `wallet/eip1193.ts`: the amount is the model's own total, the recipient is the invoice's validated payee, and a wrong network stops the flow with guidance and a switch control rather than a transaction.
 * All text is a text child of `util/dom.ts`'s `h()`, so no invoice field can become markup, and the transaction hash is shown as plain text with a copy control — the panel deliberately links to no block explorer, since resolving one would mean a network destination the app refuses to have.
 * A provider-derived string that reaches this panel — a wallet's announced label, whether on its own or echoed into a status line — is run through the same display-character pass the notices get, so it cannot carry bidi or invisible characters even if a future caller hands the panel one that `providerInfo` has not already cleaned.
 */

import { serializeInvoice } from "../invoice/codec.js";
import type { Invoice } from "../invoice/model.js";
import { fromBaseUnits } from "../util/decimal.js";
import { append, h, type DomChild } from "../util/dom.js";
import { stripDisplayCharacters } from "../util/text.js";
import { toChecksumAddress } from "../wallet/address.js";
import type { WalletCandidate } from "../wallet/eip1193.js";
import { buildPaymentPlan, type PaymentPlan, type PaymentReceipt } from "../wallet/payment.js";
import { copyWithFallback, type ClipboardLike } from "./clipboard.js";
import type { NoticeApi, NoticeTone } from "./notice.js";
import { openOverlay, type OverlayHandle } from "./overlay.js";
import { createPayFlow, type PayFlowSnapshot } from "./pay-flow.js";
import { chainName } from "./presentation.js";

let panelSequence = 0;

/**
 * The invoice whose payment this page has claimed, keyed by the invoice's canonical serialization, and the flow that claimed it.
 *
 * A flow's own latch covers one panel session; this record also covers a panel being closed and reopened, which would otherwise build a fresh flow and reach a second `eth_sendTransaction`.
 * The claim is taken as a send begins, not when the panel opens: the panel can be dismissed while discovery, connection, the chain check, or the balance read is still running, and a check made only at open would let the reopened flow and the leftover one each broadcast.
 * Recording which flow holds the claim keeps the intended retry working — the flow that claimed the invoice may send again after its own wallet decline — while a second flow's send for the same invoice is refused.
 * The key is the invoice's canonical text rather than the object, because the router mints a fresh `Invoice` for every fragment parse: navigating away and back — to `#/create`, the brand link, Back/Forward — or re-pasting the same payload decodes the same content into a distinct object, and an object key would treat that as a new invoice and re-arm the flow.
 * The record lives only in memory, so a genuine page reload starts over and the page still keeps no storage.
 */
const attemptedPayments = new Map<string, object>();

/** The stable identity of an invoice for the payment latch: the canonical serialization that survives re-parsing and re-pasting. */
function paymentKey(invoice: Invoice): string {
	return serializeInvoice(invoice);
}

/**
 * Claim `key` for one flow, or refuse the claim when a different flow already holds it.
 *
 * Called as a send begins and synchronously, so two flows that both reach their send cannot both pass: the first claims, the second is refused and broadcasts nothing.
 * A flow that already holds the key — its own whole-flow retry after a wallet decline — is answered true, so the retry still reaches the wallet.
 */
function claimPayment(key: string, owner: object): boolean {
	const holder = attemptedPayments.get(key);
	if (holder !== undefined && holder !== owner) return false;
	attemptedPayments.set(key, owner);
	return true;
}

/** Shown when the panel is refused because the page is displayed inside another page's frame. */
const FRAMED_MESSAGE = "This page is displayed inside another page, so the payment panel is blocked. Open the invoice at its own address to pay.";

/** Shown when the panel is refused because another page opened this one and still holds a handle to it. */
const OPENED_MESSAGE = "This page was opened by another page, which could drive the payment controls. Open the invoice at its own address to pay.";

/** Shown when the panel is refused because this page has already claimed a payment for the same invoice. */
const REOPEN_MESSAGE = "A payment for this invoice was already attempted from this page. Check your wallet's activity before trying again; reloading the page is the only way to start over.";

/**
 * True when this document is displayed inside another page's frame.
 *
 * A meta CSP cannot carry `frame-ancestors` and a static gateway sends no headers, so a framing page could otherwise overlay the app's own Pay control; the panel is refused there instead.
 * `window.top` is a replaceable property, so this is a best-effort check rather than an enforceable control; it is the dedicated-origin deployment rule, not this test, that keeps the fragment from another page.
 * A window with no `top` — a test harness, a worker — is treated as unframed.
 */
function isFramed(): boolean {
	if (typeof window === "undefined") return false;
	const top = (window as { top?: unknown }).top;
	return top !== undefined && top !== window;
}

/**
 * True when another page opened this one and still holds a reference to it (`window.opener`).
 *
 * A same-origin opener can reach into the popup and drive its controls, so the panel is refused there for the same reason it is refused when framed.
 * Like `window.top`, `window.opener` is a replaceable property, so the check is best-effort and the dedicated-origin deployment rule remains the control.
 * A direct navigation — a modern `target="_blank"` link, a pasted URL, a bookmark — carries no opener, and a window with no `opener` at all (a test harness, a worker) is treated as unopened.
 */
function isOpened(): boolean {
	if (typeof window === "undefined") return false;
	const opener = (window as { opener?: unknown }).opener;
	return opener !== undefined && opener !== null;
}

/**
 * The refusal notice for a context where another page could drive the panel, or `null` when the page stands alone.
 *
 * `window.top` and `window.opener` are ordinary, replaceable window properties, so this refusal is best-effort coverage of a cross-origin framer or opener — one that cannot read the fragment but could overlay or drive the controls it holds — not a control an adversarial embedder is bound by; the load-bearing control remains the dedicated-origin deployment rule.
 */
function embeddingRefusal(): string | null {
	if (isFramed()) return FRAMED_MESSAGE;
	if (isOpened()) return OPENED_MESSAGE;
	return null;
}

/** Everything the payment panel needs: where to report, and how to copy. */
export interface PayPanelOptions {
	readonly notice: NoticeApi;
	readonly clipboard?: ClipboardLike | null;
}

/** The mounted panel: the overlay element plus the one way to dismiss it. */
export type PayPanelHandle = OverlayHandle;

/**
 * Open the payment panel over the page, or refuse it with a notice.
 *
 * Nothing but the invoice is read until the payer asks to pay.
 * The panel is refused when the document is framed or opened in a window another page still holds, either of which could overlay or drive the app's Pay control, and when this page has already claimed a payment for the same invoice content, so a reopened panel — including one reopened by navigating back to the same fragment — cannot begin a second broadcast.
 */
export function openPayPanel(invoice: Invoice, options: PayPanelOptions): PayPanelHandle | null {
	const refusal = embeddingRefusal();
	if (refusal !== null) {
		options.notice.showNotice(refusal, "error");
		return null;
	}
	const key = paymentKey(invoice);
	if (attemptedPayments.has(key)) {
		options.notice.showNotice(REOPEN_MESSAGE, "error");
		return null;
	}
	return openOverlay((close) => buildPayDialog(invoice, key, options, close), { initialFocus: ".pay-connect" });
}

/** Build the panel's dialog element. Every wallet call below happens only from a click on its controls. */
function buildPayDialog(invoice: Invoice, key: string, options: PayPanelOptions, close: () => void): HTMLElement {
	const plan = buildPaymentPlan(invoice);
	const notice = options.notice;
	const clipboard = options.clipboard ?? null;
	const panelId = `pay-${(panelSequence += 1)}`;
	// This panel's identity in the payment latch: a send claims the invoice for this object, and a flow holding a different object is refused.
	const owner = {};
	const dynamic = h("div", { class: "pay-body" });
	const statusRegion = h("div", { class: "pay-status-region", role: "status" });
	let snapshot: PayFlowSnapshot = { view: { kind: "ready" }, session: null, balance: null };
	const flow = createPayFlow(plan, {
		onSnapshot: (next) => {
			snapshot = next;
			render();
		},
		onNotice: (message, tone) => notice.showNotice(message, tone),
		// Claim this invoice's payment as a send begins, so a flow left behind by a panel dismissed inside the pre-send window is refused rather than broadcasting a second time.
		claimSend: () => claimPayment(key, owner),
	});

	const dialog = h(
		"div",
		{
			class: "dialog pay-dialog",
			role: "dialog",
			"aria-modal": "true",
			"aria-label": payDialogTitle(plan.invoiceId),
			tabindex: "-1",
		},
		payHeader(plan, close),
		paySummary(plan),
		statusRegion,
		dynamic,
		h("p", { class: "field-hint" }, "Only your wallet is contacted while this panel is open."),
	);

	function render(): void {
		dynamic.replaceChildren();
		append(dynamic, panelBody());
		refreshStatus();
		// A `busy` or `sent` frame carries no `.pay-connect`/`.pay-wallet`, so the control that held focus is gone.
		// Fall back to the dialog itself, which carries `tabindex="-1"` and so is focusable: focus stays a descendant of the backdrop, where `ui/overlay.ts` binds Escape and Tab, and those keys keep working instead of going dead mid-flow.
		const primary = dynamic.querySelector<HTMLElement>(".pay-connect, .pay-wallet");
		(primary ?? dialog).focus();
	}

	function panelBody(): readonly DomChild[] {
		return [accountLine(), balanceLine(), ...viewBody()];
	}

	function viewBody(): readonly DomChild[] {
		const view = snapshot.view;
		switch (view.kind) {
			case "ready":
				return [actionRow(primaryButton("Connect wallet & pay", () => flow.begin()))];
			case "busy":
				return [actionRow(h("button", { type: "button", class: "btn btn-primary pay-working", disabled: true }, "Working…"))];
			case "picker":
				return [actionRow(...view.candidates.map(pickerButton))];
			case "wrong-chain":
				return [actionRow(primaryButton("Switch network in my wallet", () => flow.retryChain()))];
			case "unknown-chain":
				return [actionRow(primaryButton("Retry the network check", () => flow.retryChain()))];
			case "failed":
				return [actionRow(primaryButton("Try again", () => flow.begin()))];
			case "send-failed":
				return [actionRow(primaryButton("Try sending again", () => flow.retrySend()), acknowledgeSentButton())];
			case "sent":
				return [hashBlock(view.receipt), actionRow(doneButton())];
		}
	}

	/**
	 * Replace the status region's single child with the current frame's message.
	 *
	 * The region is created once and mounted beside the re-rendered body — never inside it — so `render`'s `replaceChildren` leaves it attached: a screen reader is handed one persistent live region whose child changes, not a fresh region pulled out and re-inserted each frame.
	 * The message can embed a provider-derived string — the busy frame names the wallet being connected — so it takes the same display-character pass the notice region gets.
	 * The tone modifier is emitted only when the base `.pay-status` look is not the one wanted, so an informational frame carries the bare class.
	 */
	function refreshStatus(): void {
		const status = statusText();
		const modifier = status.tone === "info" ? "" : ` pay-status-${status.tone}`;
		statusRegion.replaceChildren(h("p", { class: `pay-status${modifier}`, role: status.tone === "error" ? "alert" : "status" }, stripDisplayCharacters(status.message)));
	}

	function statusText(): { readonly message: string; readonly tone: NoticeTone } {
		const view = snapshot.view;
		switch (view.kind) {
			case "ready":
				return {
					message: "Your wallet will show the amount and the recipient before you approve. Nothing leaves this page until then.",
					tone: "info",
				};
			case "busy":
				return { message: view.message, tone: "info" };
			case "picker":
				return { message: "More than one wallet is available. Choose the one to pay with.", tone: "info" };
			case "wrong-chain":
			case "unknown-chain":
			case "failed":
			case "send-failed":
				return { message: view.message, tone: "error" };
			case "sent":
				return { message: "Transaction submitted. Keep this hash as your receipt.", tone: "success" };
		}
	}

	function accountLine(): DomChild {
		const session = snapshot.session;
		if (session === null) return null;
		return h(
			"p",
			{ class: "pay-account" },
			h("span", { class: "pay-account-label" }, "Connected account"),
			h("span", { class: "pay-account-value mono" }, toChecksumAddress(session.account)),
		);
	}

	function balanceLine(): DomChild {
		const balance = snapshot.balance;
		if (balance === null) return null;
		return h(
			"p",
			{ class: "pay-balance" },
			`Wallet balance: ${fromBaseUnits(balance, plan.asset.decimals)} ${plan.asset.symbol}`,
		);
	}

	function actionRow(...children: readonly DomChild[]): HTMLElement {
		return h("div", { class: "pay-actions" }, ...children);
	}

	function primaryButton(label: string, run: () => Promise<void>): HTMLElement {
		const button = h("button", { type: "button", class: "btn btn-primary pay-connect" }, label);
		button.addEventListener("click", () => {
			void run();
		});
		return button;
	}

	function pickerButton(candidate: WalletCandidate): HTMLElement {
		// The label comes from a wallet announcement; `providerInfo` already strips it upstream, and stripping again here keeps this render boundary safe for any future provider-derived label.
		const button = h(
			"button",
			{ type: "button", class: "btn btn-secondary pay-wallet" },
			`Pay with ${stripDisplayCharacters(candidate.label)}`,
		);
		button.addEventListener("click", () => {
			void flow.connectWith(candidate);
		});
		return button;
	}

	/**
	 * The exit after an ambiguous send: it dismisses the panel without touching the wallet, so a payer who believes the transaction went through is not handed a control that would send again.
	 */
	function acknowledgeSentButton(): HTMLElement {
		const button = h("button", { type: "button", class: "btn btn-secondary pay-acknowledge" }, "I already sent it");
		button.addEventListener("click", close);
		return button;
	}

	function doneButton(): HTMLElement {
		const button = h("button", { type: "button", class: "btn btn-secondary" }, "Done");
		button.addEventListener("click", close);
		return button;
	}

	function hashBlock(receipt: PaymentReceipt): HTMLElement {
		const inputId = `${panelId}-hash`;
		const input = h("input", { type: "text", id: inputId, class: "pay-hash", readonly: true, value: receipt.hash });
		const status = h("span", { class: "pay-copy-status", role: "status" }, "");
		const copy = h("button", { type: "button", class: "btn btn-secondary", "aria-label": "Copy transaction hash" }, "Copy");
		copy.addEventListener("click", () => {
			copyWithFallback(receipt.hash, clipboard, input, status);
		});
		return h(
			"div",
			{ class: "pay-result" },
			h("label", { class: "pay-result-label", for: inputId }, "Transaction hash"),
			input,
			h("div", { class: "pay-result-actions" }, copy, status),
		);
	}

	render();
	return dialog;
}

/**
 * The panel's own title text, with the decoded invoice id run through the display strip.
 *
 * The id is attacker-influenced text carried on the plan, and this panel is the one surface that shows invoice text without going through the view model's own clipping (`ui/presentation.ts`), so it strips here rather than relying on the validator, which deliberately leaves the interlinear-annotation and Egyptian-hieroglyph format ranges unrefused. Both the visible title and the dialog's `aria-label` are built from this one helper, so the two cannot disagree.
 */
function payDialogTitle(invoiceId: string): string {
	return `Pay invoice ${stripDisplayCharacters(invoiceId)}`;
}

/** The panel's own header: what is being paid, and its labelled close control. */
function payHeader(plan: PaymentPlan, close: () => void): HTMLElement {
	const closeButton = h(
		"button",
		{ type: "button", class: "btn-icon dialog-close", "aria-label": "Close payment panel" },
		"×",
	);
	closeButton.addEventListener("click", close);
	return h(
		"div",
		{ class: "dialog-header" },
		h("h2", { class: "dialog-title" }, payDialogTitle(plan.invoiceId)),
		closeButton,
	);
}

/** What the transaction will send, read off the plan so the panel cannot disagree with the wallet. */
function paySummary(plan: PaymentPlan): HTMLElement {
	return h(
		"dl",
		{ class: "pay-summary" },
		payTerm("Amount due", `${plan.amountText} ${plan.asset.symbol}`, true),
		payTerm("Asset", `${plan.asset.name} (${plan.asset.symbol})`),
		payTerm("Recipient", toChecksumAddress(plan.recipient), true),
		payTerm("Network", `${chainName(plan.chainId)} (${plan.chainId})`),
	);
}

function payTerm(label: string, value: string, mono = false): HTMLElement {
	return h(
		"div",
		{ class: "pay-term" },
		h("dt", { class: "pay-term-label" }, label),
		h("dd", { class: mono ? "pay-term-value mono" : "pay-term-value" }, value),
	);
}
