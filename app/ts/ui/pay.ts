/**
 * The payment panel: what will be sent, and the payer's explicit route to sending it.
 *
 * The panel is the only place the wallet is reached from, and it holds the app's central guarantee: nothing touches a provider until the payer clicks.
 * The panel is refused — with a notice, touching no provider — when this window reports an opener, whatever page that opener names, and when this invoice's payment has already been claimed, so a reopened panel cannot start a second broadcast.
 * Framing is permitted on purpose, because some wallet hosts show the invoice inside their own frame, and the permission accepts that the framing page can overlay the controls it frames: README.md records that risk beside the permission, and nothing here bounds it.
 * Two controls remain, and neither of them covers an overlay: no wallet is touched until the payer's own click, which README.md's "Security over features" states and which a framing host defeats by making that click land on the control it covers, and this page's claim on the invoice's payment lets only one flow send that invoice, which stops a second broadcast of the same invoice rather than an overlaid click.
 * Opening the panel computes the transfer from the validated invoice and renders it — asset, amount, recipient, network — and that is all that happens on the Pay click; discovery, connection, the chain check, the balance read, and the transaction itself all wait for the payer's own "Connect wallet & pay".
 *
 * What the flow *does* lives in `ui/pay-flow.ts`, which is free of the DOM and driven directly by tests; this module owns only how each of its states is drawn and which control maps to which step.
 * A `failed` frame — nothing was broadcast — offers a full-flow "Try again", while the ambiguous `send-failed` frame offers a send-only "Try sending again" and an "I already sent it" exit that dismisses the panel without touching the wallet, so a retry after an unclear send cannot blindly re-run the whole flow.
 * Everything the panel shows comes from `wallet/payment.ts` and `wallet/eip1193.ts`: the amount is the model's own total, the recipient is the invoice's validated payee, and a wrong network stops the flow with guidance and a switch control rather than a transaction.
 * The network it names is spelled by `ui/network-labels.ts`'s `networkLabel`, the same spelling the payer's document and the flow's guidance use.
 * The amount due, the recipient's address, and the receipt's transaction hash are values the payer checks and copies verbatim, and the connected account and the wallet's balance are strings the wallet reports; those five fitted values are handed to `ui/fit-value.ts` rather than left to wrap: that module holds the value on one line at the first rung of its ladder that fits the row, in the search order its own module doc states, and a value still wider than its column takes the residual rung, scrolling inside its own box and never breaking — the same scroll container contract `ui/payment-section.ts` gives the invoice's own payment values.
 * The three the payer carries away are drawn with a copy control beside them, and it is the control `ui/payment-section.ts` builds for the invoice's own verbatim values: one click hands the clipboard that term's own string rather than whatever a selection spanned, the confirmation blanks and re-sets so a repeated copy is announced, and the control falls back to selecting the value when the clipboard is unavailable or refuses. The connected account and the balance carry none: the panel draws them for the payer's reading rather than for a copy, so each is read through its own scroll box and focus stop.
 * The cue that the value may be cut off is the row's own state: `app.css` paints it on the cue class `ui/fit-value.ts` names, which this panel writes as it builds each fitted row, and that module clears the class only on a rung its own measurement showed holding the value — so a panel drawn with no probe, or on an engine with no `ResizeObserver`, reaches no rung at all and keeps the cue painted beside a value scrolling at the base size.
 * All text is a text child of `util/dom.ts`'s `h()`, so no invoice field can become markup, and the transaction hash is drawn as plain selectable text with a copy control — the panel deliberately links to no block explorer, since resolving one would mean a network destination the app refuses to have.
 * That hash is one of the strings the payer carries away, so it is neither a form control's value nor an unfitted line: it is fitted like the addresses above it and carries the same cue on its row that the value may be cut off, because a receipt whose hash is cut at a phone's panel width with nothing said about it reads as a complete hash.
 * A provider-derived string that reaches this panel arrives one of two ways, and those two are the whole of the boundary: a wallet's announced label and a status line the flow reports are run through `util/text.ts`'s display-character pass, while the connected account and the receipt's transaction hash are values their own address and hex checks admit, and the wallet's reported balance is a decoded `bigint` the panel formats itself, so none of the three can carry a character that pass would remove.
 * A provider-derived string added here must have one of those two before it is drawn, because nothing after the string's own arrival inspects its code points: either the pass runs over it, or a check upstream admits only the characters the panel means to show.
 */

import { requireAsset } from "../assets/registry.js";
import { serializeInvoice } from "../invoice/codec.js";
import type { Invoice } from "../invoice/model.js";
import { fromBaseUnits } from "../util/decimal.js";
import { append, h, type DomChild } from "../util/dom.js";
import { reportInternalFailure } from "../util/errors.js";
import { stripDisplayCharacters } from "../util/text.js";
import { toChecksumAddress } from "../wallet/address.js";
import type { WalletCandidate } from "../wallet/eip1193.js";
import {
	UnsupportedPaymentFamilyError,
	buildPaymentPlan,
	isWalletPayable,
	type PaymentPlan,
	type PaymentReceipt,
} from "../wallet/payment.js";
import type { ClipboardLike } from "./clipboard.js";
import { FIT_CUE_CLASS, FIT_SCALE_CLASS, fitValue, type LayoutProbe, type TermFitting } from "./fit-value.js";
import { UNSUPPORTED_WALLET_MESSAGE } from "./messages.js";
import { networkLabel } from "./network-labels.js";
import type { NoticeApi, NoticeTone } from "./notice.js";
import { openOverlay, type OverlayHandle } from "./overlay.js";
import { copyControlClick, wallClockTimer } from "./payment-section.js";
import { createPayFlow, type PayFlowSnapshot } from "./pay-flow.js";
import { releasable, runReleases, type ReleasableElement, type Release } from "./release.js";

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

/**
 * Shown when the panel is refused because this window reports an opener.
 *
 * It states what the refusal does — it covers every opener — and why: a page from this website could drive the payment controls, and the page cannot tell which website an opener comes from.
 * A payer who arrived from a plain link carries an opener too, and a sentence naming only a page from this website as the reason told them something untrue about their own window.
 */
const OPENED_MESSAGE = "This page was opened by another page, so paying is refused here — whichever page that is. A page from this website could drive the payment controls, and this page cannot tell which website an opener comes from, so every opener is refused. Open the invoice on its own, from the link you were sent.";

/**
 * Reported when the panel could not be cleared away on dismissal: what the failure leaves running and what the payer can do about it, never the exception's own message, which can carry a validator's echo of a rejected value.
 * `app/shell.ts` dismisses whichever modal the replaced document left open — this panel or the share dialog — and reports that in its own dialog-neutral sentence, so the payer who loses the panel to a navigation is told what may still be running without being told a share dialog was a payment panel.
 */
export const DISMISS_FAILED_MESSAGE = "The payment panel could not be cleared away, so something it was watching may still be running. Reload the page to start over.";

/**
 * Reported in the panel's own body when a frame of it cannot be drawn: what the failure may leave running and the one action that clears it, never the exception's own message.
 *
 * The panel is the one surface the payer reads while it is open — the overlay hides the page behind it, the notice region included — so a frame that fails says so where it is drawn rather than through a notice nobody would see under the backdrop.
 */
const FRAME_FAILED_MESSAGE = "The payment panel could not draw what it had to show, so something it was watching may still be running. Reload the page to start over.";

/** Shown when the panel is refused because this page has already claimed a payment for the same invoice. */
const REOPEN_MESSAGE = "A payment for this invoice was already attempted from this page. Check your wallet's activity before trying again; reloading the page is the only way to start over.";

/** The hand-off sentence `ui/messages.ts` owns, re-exported so this module's callers keep a single import site. */
export { UNSUPPORTED_WALLET_MESSAGE };

/**
 * The refusal notice for a window that reports an opener, or `null` when the page stands alone.
 *
 * The test is presence and nothing else: every window whose `window.opener` is neither `undefined` nor `null` is refused, whatever page that opener names, because presence is what the property reports without reaching across a boundary the page may not cross.
 * An opener served from the same website is the case that matters, since it can reach into the popup and drive its controls; an opener served from another website can neither read the fragment nor reach those controls, and the one presence test refuses it too rather than a second test singling it out.
 * The notice says what this test does rather than what the same-website case alone would justify: it tells the payer that every opener is refused, and why — a page from this website could drive the controls, and nothing here can tell which website an opener comes from — so a payer who arrived from a plain link is not told that their window is the one hazard the refusal names.
 * `window.opener` is an ordinary, replaceable window property, so this refusal is best-effort coverage of every opener rather than a control an adversarial page is bound by; the load-bearing control remains README.md's requirement, in "Open the app", that the app's website be one whose pages are trusted with the invoice, because any other page on the same website would be trusted with the fragment.
 * A direct navigation — a modern `target="_blank"` link, a pasted URL, a bookmark — carries no opener, and a window with no `opener` at all (a test harness, a worker) is treated as unopened.
 */
function openerRefusal(): string | null {
	if (typeof window === "undefined") return null;
	const opener = (window as { opener?: unknown }).opener;
	if (opener === undefined || opener === null) return null;
	return OPENED_MESSAGE;
}

/** Everything the payment panel needs: where to report, how to copy, and how a value it states measures the box it is drawn in. */
export interface PayPanelOptions {
	readonly notice: NoticeApi;
	readonly clipboard?: ClipboardLike | null;
	/**
	 * The probe the panel's fitted values measure the boxes they are drawn in through; `PaymentSectionOptions.fit` in `./payment-section.ts` states what an absent or `null` probe means.
	 */
	readonly fit?: LayoutProbe | null;
}

/**
 * The parts of a summary term beyond its label and its text: the fitting a verbatim value is handed to, and the clipboard its copy control hands that value over to.
 *
 * `verbatim` is present only for a value a wallet takes byte for byte — the amount due and the recipient's address — and its presence is what draws the value in the panel's monospace face, fits it to its column, gives it a copy control, and states that its row may be cut off. The two readings the panel makes for itself, the asset's name and the network's label, pass neither field.
 */
interface PayTermOptions {
	readonly verbatim?: TermFitting | null;
	readonly clipboard?: ClipboardLike | null;
}

/** The mounted panel: the overlay element plus the one way to dismiss it. */
export type PayPanelHandle = OverlayHandle;

/**
 * Open the payment panel over the page, or refuse it with a notice.
 *
 * Nothing but the invoice is read until the payer asks to pay.
 * The panel is refused when this window reports an opener, whatever page that opener names, and when this page has already claimed a payment for the same invoice content, so a reopened panel — including one reopened by navigating back to the same fragment — cannot begin a second broadcast.
 * It is refused too for an invoice whose asset belongs to a family no injected wallet pays, read through `wallet/payment.ts`'s own `isWalletPayable`; the same typed refusal `buildPaymentPlan` raises is caught here as well, so a privacy-chain invoice can never let that error escape this entry uncaught.
 */
export function openPayPanel(invoice: Invoice, options: PayPanelOptions): PayPanelHandle | null {
	const refusal = openerRefusal();
	if (refusal !== null) {
		options.notice.showNotice(refusal, "error");
		return null;
	}
	const key = paymentKey(invoice);
	if (attemptedPayments.has(key)) {
		options.notice.showNotice(REOPEN_MESSAGE, "error");
		return null;
	}
	if (!isWalletPayable(requireAsset(invoice.asset))) {
		options.notice.showNotice(UNSUPPORTED_WALLET_MESSAGE, "error");
		return null;
	}
	// The panel rebuilds its rows on every state change, so the dialog returns the release of the rows it holds on its own element, and the overlay's close runs it as it dismisses the panel (`ui/release.ts`).
	// A payer who dismisses the panel is told when that release failed, because the dismissal has no caller to hand the failure back to: the notice region is the only place they can learn that a row may still be watched.
	try {
		return openOverlay((close) => buildPayDialog(invoice, key, options, close), {
			initialFocus: ".pay-connect",
			onDismissFailed: () => options.notice.showNotice(DISMISS_FAILED_MESSAGE, "error"),
		});
	} catch (error) {
		// The typed refusal `buildPaymentPlan` raises for a family this flow cannot pay must not escape the panel entry; the gate above already covers it, and this keeps the guarantee if the two ever diverge.
		if (error instanceof UnsupportedPaymentFamilyError) {
			options.notice.showNotice(UNSUPPORTED_WALLET_MESSAGE, "error");
			return null;
		}
		throw error;
	}
}

/**
 * Build the panel's dialog. Every wallet call below happens only from a click on its controls.
 *
 * The element it returns carries the release of every fit subscription its rows took, so the overlay it is handed to runs that release as it dismisses the panel.
 * Both collectors are drained through `ui/release.ts`'s `runReleases`, so a stop that throws is reported without stranding the ones after it.
 * The dialog's own build is the one path that ends every subscription it has taken when it throws: a dialog that is never returned is mounted by nothing, so the summary rows it had already fitted have no other owner.
 * A frame the dialog draws later is not that path: a frame that cannot be drawn drops its own rows and states the failure in the body, while the dialog's rows stay mounted and keep their fitting (`renderFrame`).
 */
function buildPayDialog(invoice: Invoice, key: string, options: PayPanelOptions, close: () => void): ReleasableElement {
	const plan = buildPaymentPlan(invoice);
	const notice = options.notice;
	const clipboard = options.clipboard ?? null;
	const fit = options.fit ?? null;
	// The rows a render builds are dropped by the next one, so the fit subscriptions taken for them are dropped with it rather than left watching a detached row; the summary's own rows are built once and live as long as the dialog, so their subscriptions are held apart and dropped when the panel closes.
	const renderReleases: Release[] = [];
	const dialogReleases: Release[] = [];
	// Set by the overlay's close, so a snapshot a wallet call delivers under a dismissed panel rebuilds nothing and takes nothing.
	let dismissed = false;
	const release = (): void => {
		dismissed = true;
		runReleases([...renderReleases.splice(0), ...dialogReleases.splice(0)]);
	};
	// This panel's identity in the payment latch: a send claims the invoice for this object, and a flow holding a different object is refused.
	const owner = {};
	const dynamic = h("div", { class: "pay-body" });
	const statusRegion = h("div", { class: "pay-status-region", role: "status" });
	let snapshot: PayFlowSnapshot = { view: { kind: "ready" }, session: null, balance: null };
	/**
	 * Run the dialog's own build, and release every subscription it has taken when that build throws.
	 *
	 * A subscription is taken as each fitted row is built, so a row after the first that cannot be built — a summary term, an account line — would otherwise leave the rows built before it watching a dialog that is never mounted and never dismissed.
	 */
	const releaseOnThrow = <T>(build: () => T): T => {
		try {
			return build();
		} catch (error) {
			release();
			throw error;
		}
	};

	const flow = createPayFlow(plan, {
		onSnapshot: (next) => {
			snapshot = next;
			renderFrame();
		},
		onNotice: (message, tone) => notice.showNotice(message, tone),
		// Claim this invoice's payment as a send begins, so a flow left behind by a panel dismissed inside the pre-send window is refused rather than broadcasting a second time.
		claimSend: () => claimPayment(key, owner),
	});

	const dialog = releaseOnThrow(() =>
		h(
			"div",
			{
				class: "dialog pay-dialog",
				role: "dialog",
				"aria-modal": "true",
				"aria-label": payDialogTitle(plan.invoiceId),
				tabindex: "-1",
			},
			payHeader(plan, close),
			paySummary(plan, fit, dialogReleases, clipboard),
			statusRegion,
			dynamic,
			h("p", { class: "field-hint" }, "Only your wallet is contacted while this panel is open."),
		),
	);

	/**
	 * Draw the frame the current snapshot describes into the body.
	 *
	 * The previous frame's rows leave the document before their releases run, and their releases run whether the new frame is drawn or not: a frame that cannot be built must not keep the subscriptions of the frame it replaced alive.
	 * A failure here does not end the dialog. The amount and the recipient are the dialog's own rows, built and subscribed once, so they stay mounted and keep their fitting: a release run on them would leave the rung their own measurement wrote on a value still on screen, with nothing left to refit it after the next resize.
	 * The failure is stated in the body and the panel stays open, so the payer closes it themselves and a later snapshot may draw a later frame.
	 */
	function renderFrame(): void {
		// A snapshot that arrives after the panel was dismissed — a wallet call the payer closed the panel under — rebuilds nothing: those would be rows of a dialog the page no longer holds, and the fit subscriptions they took would have no path back.
		if (dismissed) return;
		const dropped = renderReleases.splice(0);
		const drawn = drawFrame();
		const released = releaseRows(dropped);
		if (!drawn || !released) stateFrameFailure();
	}

	/**
	 * Draw the snapshot's frame into the body, and report whether it was drawn.
	 *
	 * A frame that cannot be drawn — a row that throws — leaves no rows of its own behind: the part of it that had already taken a fitting is dropped with it, so no row of it stays mounted with a rung class and nothing watching it, and the body is emptied of the half-drawn frame rather than left holding one.
	 * The status line goes with it, because the frame it described is no longer on screen and a sentence about a frame the payer cannot see would be the only thing left in front of them.
	 */
	function drawFrame(): boolean {
		try {
			dynamic.replaceChildren();
			append(dynamic, panelBody());
			refreshStatus();
			// A `busy` or `sent` frame carries no `.pay-connect`/`.pay-wallet`, so the control that held focus is gone.
			// Fall back to the dialog itself, which carries `tabindex="-1"` and so is focusable: focus stays a descendant of the backdrop, where `ui/overlay.ts` binds Escape and Tab, and those keys keep working instead of going dead mid-flow.
			const primary = dynamic.querySelector<HTMLElement>(".pay-connect, .pay-wallet");
			(primary ?? dialog).focus();
			return true;
		} catch (error) {
			// The body states the app's fixed sentence for a frame it could not draw, and the row's own failure goes to the console: a frame that a shipped build could not draw is the one failure here no payer message explains.
			reportInternalFailure("payment panel frame", error);
			dynamic.replaceChildren();
			statusRegion.replaceChildren();
			releaseRows(renderReleases.splice(0));
			return false;
		}
	}

	/**
	 * Release `rows` and report whether every stop ran, never throwing at the snapshot delivery that caused the release.
	 *
	 * `ui/release.ts`'s `runReleases` runs every stop it is handed, so a stop that throws strands none of the ones after it; what is left is to tell the payer, which the panel does in its own sentence rather than by throwing into the promise chain a wallet call's reply travels.
	 */
	function releaseRows(rows: readonly Release[]): boolean {
		try {
			runReleases(rows);
			return true;
		} catch (error) {
			// The payer reads the panel's fixed sentence for a stop that threw; the stop's own message goes to the console, so a shipped release fault is not lost between the two.
			reportInternalFailure("payment panel row release", error);
			return false;
		}
	}

	/**
	 * State in the panel that a frame could not be drawn, under whatever it is still showing.
	 *
	 * The sentence joins the body rather than replacing it, so a frame that did draw keeps its rows and its status line, and a body with no frame on it carries the sentence instead of nothing.
	 */
	function stateFrameFailure(): void {
		dynamic.append(h("p", { class: "pay-status pay-status-error", role: "alert" }, FRAME_FAILED_MESSAGE));
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

	/**
	 * The connected account, drawn as the line it reads as: the words that name it, then the address the wallet reported, in the checksummed spelling the rest of the app shows.
	 * Its label is a `span` carrying `pay-account-label`, so `app.css` draws it bold and muted the way a summary term's label is drawn, and the row reads as a label followed by a value.
	 * What it shares with `balanceLine` is the value rather than the label: the address span carries the same monospaced face, the same ladder rungs written on its row, and the same role, name, and focus stop as the balance's amount, so the panel reports its two wallet strings in one shape.
	 */
	function accountLine(): DomChild {
		const session = snapshot.session;
		if (session === null) return null;
		const scale = h("span", { class: FIT_SCALE_CLASS, "aria-hidden": "true" });
		const value = h(
			"span",
			{ class: "pay-account-value mono", role: "group", "aria-label": "Connected account", tabindex: "0" },
			toChecksumAddress(session.account),
			scale,
		);
		const row = h(
			"p",
			{ class: `pay-account fit-sized ${FIT_CUE_CLASS}` },
			h("span", { class: "pay-account-label" }, "Connected account"),
			value,
		);
		renderReleases.push(fitValue({ row, value, scale }, fit));
		return row;
	}

	/**
	 * The wallet's balance, drawn as the line it reads as: the words that name it, then the amount and symbol the wallet reported.
	 * The amount is a span of its own rather than part of the row's text, which is the one structural change a balance needs: a box cannot be a keyboard stop unless it is an element of its own, and a balance the panel cannot draw whole is only readable by arrowing along it.
	 * The rest of its contract is the panel's other values': the fitted font size and rung the screen ladder states for them, and the role and name that keep the stop meaningful, so the row is fitted exactly as its neighbours are.
	 * Its label, unlike the account row's, is a bare text node of the row, so it keeps the row's inherited text and takes none of the bold muted styling `.pay-account-label` carries: a reader should expect the account line to introduce itself as a label and the balance line to read as running text before its value.
	 */
	function balanceLine(): DomChild {
		const balance = snapshot.balance;
		if (balance === null) return null;
		const scale = h("span", { class: FIT_SCALE_CLASS, "aria-hidden": "true" });
		const value = h(
			"span",
			{ class: "pay-balance-value mono", role: "group", "aria-label": "Wallet balance", tabindex: "0" },
			`${fromBaseUnits(balance, plan.asset.decimals)} ${plan.asset.symbol}`,
			scale,
		);
		const row = h("p", { class: `pay-balance fit-sized ${FIT_CUE_CLASS}` }, "Wallet balance: ", value);
		renderReleases.push(fitValue({ row, value, scale }, fit));
		return row;
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

	/**
	 * The receipt: the transaction hash the wallet handed back, drawn as the panel's other verbatim values are.
	 *
	 * It is one selectable text run in a keyboard-reachable scroll container named by its label, fitted by the panel's own ladder, and its row carries `fit-sized` with the cue class this panel writes on every row it fits: a hash wider than the panel scrolls inside its box with the cue beside it rather than being cut at the panel's edge with nothing said, which is what a read-only field of the same width did, and the fit clears that cue once its own measurement holds the hash on one line.
	 * Its copy control is the one the amount and the recipient carry, so the receipt's confirmation follows the same lifecycle and falls back to selecting this value's contents.
	 * The fit's release is collected with the frame's other rows, so the subscription ends when the next frame replaces this one.
	 */
	function hashBlock(receipt: PaymentReceipt): HTMLElement {
		const scale = h("span", { class: FIT_SCALE_CLASS, "aria-hidden": "true" });
		const value = h(
			"span",
			{ class: "pay-hash", role: "group", "aria-label": "Transaction hash", tabindex: "0" },
			receipt.hash,
			scale,
		);
		const [copy, status] = copyControl("transaction hash", receipt.hash, value, clipboard);
		const row = h(
			"div",
			{ class: `pay-result fit-sized ${FIT_CUE_CLASS}` },
			h("span", { class: "pay-result-label" }, "Transaction hash"),
			value,
			h("div", { class: "pay-result-actions" }, copy, status),
		);
		renderReleases.push(fitValue({ row, value, scale }, fit));
		return row;
	}

	renderFrame();
	return releasable(dialog, release);
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

/** What the transaction will send, read off the plan so the panel cannot disagree with the wallet, and how each value a wallet takes verbatim is handed over. */
function paySummary(plan: PaymentPlan, fit: LayoutProbe | null, releases: Release[], clipboard: ClipboardLike | null): HTMLElement {
	const fitting: TermFitting = { fit, releases };
	return h(
		"dl",
		{ class: "pay-summary" },
		payTerm("Amount due", `${plan.amountText} ${plan.asset.symbol}`, { verbatim: fitting, clipboard }),
		payTerm("Asset", `${plan.asset.name} (${plan.asset.symbol})`),
		payTerm("Recipient", toChecksumAddress(plan.recipient), { verbatim: fitting, clipboard }),
		payTerm("Network", networkLabel(plan.chainId)),
	);
}

/**
 * One summary term: its label and the value it states — in a monospace face, with a copy control beside it, when that value is one a wallet takes verbatim.
 *
 * A verbatim value is a keyboard-reachable scroll container named by its label, the contract `ui/payment-section.ts` gives the invoice's own verbatim payment values: a value wider than the panel's column scrolls inside its box and never breaks, focusing it is what lets a keyboard-only user arrow along to the tail, `ui/overlay.ts` counts it among the dialog's focus stops, and `app.css` rings it where the panel would otherwise leave a definition unringed.
 * The role, name, and focus stop are this helper's own choice for every term it builds, not part of what `ui/payment-section.ts` holds: `app.css` states the value's contract and the focus ring once for the class all four summary terms draw their value in, and the two readings the panel makes for itself take the wrapping state of that class rather than the scroll box; ARIA 1.2 does not let a bare `dd` carry a name, so the role is what the label needs.
 * The `<dd>` holds the value beside what acts on it — the copy control and the status reporting that copy — and the value is an element of its own inside it, which is what the control is handed: it copies the string the payer reads, and it selects that element's contents when there is no clipboard to write to.
 * Whether a term's value is fitted is the other choice this helper makes: a value a wallet takes verbatim is handed to `ui/fit-value.ts` through the fitting it is given, and the release the fitter returns is added to the collector that fitting carries, so the dialog drops it with the row.
 * The amount's string carries the asset's symbol, so a symbol the row cannot hold shrinks that row rather than wrapping it, which is the trade a value that may not wrap makes.
 * The asset's name and the network's label are the panel's own readings of the plan and carry no rung: they are handed to no fitter, so neither takes a rung class, and both keep the panel's inherited text size in its ordinary face rather than the monospace one.
 * Their value wraps instead of scrolling, because neither string is one a wallet takes verbatim or a payer compares: a registry name or a network label longer than the panel's column is drawn whole on the next line rather than running a clipped tail that reads as the whole name, which is what a scroll box with no cue would show.
 * A term whose value is handed to the fitting carries `fit-sized` and the cue state `ui/fit-value.ts` names, which the panel writes as it builds the row because no measurement has settled that row yet; the fitter clears the cue on the one verdict of its own measurement. The rows no fitter sizes carry neither class and are never cued: their value wraps, so neither of them can hide a character of what it reads.
 * The copy control is `ui/payment-section.ts`'s own, so the panel hands over the term's whole string — never the fitted box's text as a selection happened to span it — with the same confirmation lifecycle and the same `Copy <label>` name; the panel is drawn in a dialog `print.css` drops whole, so neither the control nor its confirmation can reach paper.
 */
function payTerm(label: string, value: string, options: PayTermOptions = {}): HTMLElement {
	const verbatim = options.verbatim ?? null;
	// The scale box is drawn inside a value the ladder sizes and nowhere else: it exists so a change to the value's drawn font size can be reported to the fitting, which `ui/fit-value.ts` states.
	const scale = verbatim === null ? null : h("span", { class: FIT_SCALE_CLASS, "aria-hidden": "true" });
	const field = h(
		"span",
		{ class: termValueClass(options), role: "group", "aria-label": label, tabindex: "0" },
		value,
		scale,
	);
	const row = h(
		"div",
		{ class: verbatim === null ? "pay-term" : `pay-term fit-sized ${FIT_CUE_CLASS}` },
		h("dt", { class: "pay-term-label" }, label),
		h("dd", { class: "pay-term-field" }, field, ...(verbatim === null ? [] : copyControl(label, value, field, options.clipboard ?? null))),
	);
	if (verbatim !== null) verbatim.releases.push(fitValue({ row, value: field, scale }, verbatim.fit));
	return row;
}

/**
 * The control that hands one verbatim term's value over whole, and the status that reports the copy.
 *
 * The click is `ui/payment-section.ts`'s `copyControlClick` on that module's wall-clock timer, so the panel copies through one seam rather than a second of its own: the same two outcomes, the same confirmation cleared after a pause, the same blanking of that confirmation before each copy so a repeated copy is announced, and the same fallback that selects the value when the clipboard is unavailable or refuses the write.
 * The name carries the term's label, so the panel's three controls reading "Copy" are told apart.
 * The status is built with no children at all rather than an empty string: `h()` turns a string child into a text node, and the stylesheet's `:empty` rule — what takes the status's reserved line out of flow while it is silent — does not match an element holding one.
 */
function copyControl(label: string, text: string, value: HTMLElement, clipboard: ClipboardLike | null): readonly DomChild[] {
	const status = h("span", { class: "pay-copy-status", role: "status" });
	const copy = h("button", { type: "button", class: "btn btn-secondary pay-copy", "aria-label": `Copy ${label}` }, "Copy");
	copy.addEventListener("click", copyControlClick(text, clipboard, value, status, wallClockTimer));
	return [copy, status];
}

/**
 * The class a term's value is drawn in: a value a wallet takes verbatim is the one monospace run the ladder fits and a copy control hands over, and a value the panel reads for itself wraps.
 * The two states are stated as classes rather than left to a narrower selector because `app.css` draws one scroll box per state and the value is the one element that carries the difference.
 */
function termValueClass(options: PayTermOptions): string {
	return (options.verbatim ?? null) === null ? "pay-term-value pay-term-value-wrapping" : "pay-term-value mono";
}
