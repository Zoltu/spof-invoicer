/**
 * The payment state machine, kept free of the DOM so it can be driven without a browser.
 *
 * The panel in `ui/pay.ts` owns only how a {@link PayFlowSnapshot} is drawn; this module owns what the flow does — discovering a wallet, connecting, checking the network, reading a balance, and sending.
 * It reads the validated {@link PaymentPlan}'s own amount and recipient and reaches the wallet only when one of its methods is called, so nothing here runs at import, and the panel calls {@link PayFlow.begin} solely from the payer's click.
 * Every transition is reported through `onSnapshot`, and every failure the payer must see is reported through `onNotice`; a unit test supplies both and drives the flow with a mock provider, with no document involved.
 *
 * A failure of the send itself is treated differently from one before it.
 * A step before the send left nothing broadcast, so the flow may be retried from the start; but `eth_sendTransaction` can fail ambiguously — a timeout, an unusable reply — after the wallet may already have broadcast, so the flow remembers the connected session and exposes {@link PayFlow.retrySend}, which repeats only the send.
 * A re-run of `begin` from that state would raise a fresh approval and a second broadcast, which is exactly the double-send this split prevents.
 *
 * A caller that must latch the invoice against a second broadcast is told through `onSendAttempt` the instant a send leaves for the wallet, before its reply: a settled `sent`/`send-failed` frame can be pre-empted by the panel being dismissed while the send is in flight, so a caller waiting for that frame would leave a window in which a reopened panel could arm a second broadcast.
 * A caller whose latch must also hold across two flows consults `claimSend` as the send begins, not merely when a panel opens: a flow dismissed during the pre-send window — discovery, connection, the chain check, the balance read — is still running, and a reopened panel builds a second flow, so the check has to run where the send does to refuse one of them.
 *
 * Every failure the flow shows the payer is worded here, not copied out of an error: a provider failure reads `wallet: eth_call failed (code -32000) — …`, which names internal machinery a payer cannot act on, so `failureMessage` maps each error class to plain guidance and answers anything it does not recognize with generic guidance rather than that error's own text, while the original message stays on the error for diagnostics.
 * A network the guidance names is spelled through `ui/network-labels.ts`'s `networkLabel`, the one spelling the payer's document, the payment panel's summary, and this guidance share.
 */
import { fromBaseUnits } from "../util/decimal.js";
import { UnknownChainError, WalletClient, WalletRejectedError, WalletRequestError, WalletResponseError, walletCandidates, } from "../wallet/eip1193.js";
import { NoAccountError, WrongChainError, connectWallet, ensureWalletChain, readBalance, sendPayment, } from "../wallet/payment.js";
import { networkLabel } from "./network-labels.js";
/** The payer-facing wording for a send that failed without a definitive answer. */
const SEND_FAILURE_MESSAGE = "Your wallet did not confirm the transaction. It may still have been sent, so check your wallet's activity before trying again.";
/** The payer-facing wording for a send refused because another flow on this page has already claimed the invoice's payment. */
const SEND_CLAIMED_ELSEWHERE_MESSAGE = "Another payment for this invoice is already under way from this page, so this one was not sent. Check your wallet's activity before trying again; reloading the page is the only way to start over.";
/**
 * Build the payment flow for one plan.
 *
 * The returned controls never reject: any error that escapes a step is normalized into a `failed` view and an error notice.
 * Internal steps re-read `client`/`session` and return early when the flow has been reset, so a late resolution after a second click cannot act on a stale wallet, and a control holds a lock for the whole of its asynchronous run so two overlapping clicks cannot start two flows — and so reach one broadcast at most.
 */
export function createPayFlow(plan, callbacks) {
    let client = null;
    let session = null;
    let balance = null;
    let view = { kind: "ready" };
    // Latched the instant a send is handed to the wallet and never cleared while an earlier attempt is in doubt: a later failure must not reopen the whole-flow path, which could broadcast a second payment for the same invoice.
    let sendAttempted = false;
    // Held for the duration of one control's asynchronous run, so a second click that arrives before the first control has been replaced by a busy frame cannot start a parallel flow that reaches a second broadcast.
    let running = false;
    function emit() {
        callbacks.onSnapshot({ view, session, balance });
    }
    function setView(next) {
        view = next;
        emit();
    }
    /** Show a failure the payer must read: the `failed` view and an error notice, from text already worded for the payer. */
    function showFailure(message) {
        setView({ kind: "failed", message });
        callbacks.onNotice(message, "error");
    }
    /** Show the ambiguous send failure, whose only safe retry is the send step itself. */
    function showSendFailure(message) {
        setView({ kind: "send-failed", message });
        callbacks.onNotice(message, "error");
    }
    /** Turn a caught error into {@link showFailure}, mapping its wording to what a payer should see. */
    function failFromError(error) {
        showFailure(failureMessage(error));
    }
    /**
     * Whether a send has already been attempted, in which case no full-flow entry may run — discovery, connection, or the chain check that leads back to another send — and only the send-only retry may continue.
     * Raises the caution frame and returns true so the caller stops.
     */
    function blockedAfterSend() {
        if (!sendAttempted)
            return false;
        showSendFailure(SEND_FAILURE_MESSAGE);
        return true;
    }
    function wrongChain(message) {
        setView({ kind: "wrong-chain", message });
        callbacks.onNotice(message, "error");
    }
    function unknownChain(message) {
        setView({ kind: "unknown-chain", message });
        callbacks.onNotice(message, "error");
    }
    /**
     * The payer-facing wording for a wallet that is not on the invoice's network, the neighbour of the declined-switch and unknown-chain branches.
     * `current` is the network the wallet is on when the failure names one; `null` when only the mismatch is known.
     */
    function networkFailureMessage(current) {
        const where = current === null ? "not on the right network" : `on ${networkLabel(current)}`;
        return `Your wallet is ${where}, but this invoice must be paid on ${networkLabel(plan.chainId)}. Switch networks in your wallet, then try again.`;
    }
    /**
     * The payer-facing text for a caught failure.
     *
     * Nothing a wallet said is shown verbatim: a provider failure names the method and the code (`wallet: eth_call failed (code -32000) — …`) and a wrong-network failure quotes the raw chain ids, and neither means anything to a payer.
     * Each recognized class gets its own guidance here — a wrong network is worded exactly as the chain check words it, whichever step raised it — and a failure this flow does not recognize gets generic guidance rather than its own text; the error object is left untouched for diagnostics.
     */
    function failureMessage(error) {
        if (error instanceof WrongChainError)
            return networkFailureMessage(error.current);
        if (error instanceof NoAccountError) {
            return "Your wallet did not return an account to pay from. Unlock it, grant access, then try again.";
        }
        if (error instanceof WalletResponseError) {
            return "The wallet sent back a reply this page could not use. Unlock the wallet and try again.";
        }
        if (error instanceof WalletRequestError) {
            return "The wallet could not complete that step. Open the wallet and try again.";
        }
        return "Something went wrong while reaching your wallet. Open the wallet and try again.";
    }
    /**
     * The caution wording for a failure that follows a send attempt.
     * A retry stopped by a network drift still needs the switch guidance, but every case must warn that the earlier attempt may already be on-chain.
     */
    function afterSendFailureMessage(error) {
        if (error instanceof WrongChainError) {
            return `${networkFailureMessage(error.current)} An earlier attempt may still have been sent, so check your wallet's activity before trying again.`;
        }
        return SEND_FAILURE_MESSAGE;
    }
    function totalLabel() {
        return `${plan.amountText} ${plan.asset.symbol}`;
    }
    async function discover() {
        if (blockedAfterSend())
            return;
        client = null;
        session = null;
        balance = null;
        setView({ kind: "busy", message: "Looking for a wallet on this page…" });
        const candidates = await walletCandidates();
        if (candidates.length === 0) {
            showFailure("No Ethereum wallet was found in this browser. Install or unlock a wallet, then try again.");
            return;
        }
        const only = candidates[0];
        if (candidates.length === 1 && only !== undefined) {
            await connect(only);
            return;
        }
        setView({ kind: "picker", candidates });
    }
    async function connect(candidate) {
        if (blockedAfterSend())
            return;
        const next = new WalletClient(candidate.provider, candidate.label);
        client = next;
        setView({ kind: "busy", message: `Connecting to ${candidate.label}…` });
        try {
            session = await connectWallet(next);
        }
        catch (error) {
            if (error instanceof WalletRejectedError) {
                showFailure("You declined the connection request in your wallet.");
                return;
            }
            failFromError(error);
            return;
        }
        await checkChain();
    }
    async function checkChain() {
        if (client === null || session === null)
            return;
        if (blockedAfterSend())
            return;
        setView({ kind: "busy", message: "Checking the network…" });
        try {
            await ensureWalletChain(client, plan.chainId);
        }
        catch (error) {
            if (error instanceof WalletRejectedError) {
                wrongChain(`You declined the network switch. Switch your wallet to ${networkLabel(plan.chainId)} to continue.`);
                return;
            }
            if (error instanceof UnknownChainError) {
                unknownChain(`Your wallet does not know the network ${networkLabel(plan.chainId)}, so it cannot switch to it. Add that network in your wallet, then retry.`);
                return;
            }
            wrongChain(networkFailureMessage(error instanceof WrongChainError ? error.current : null));
            return;
        }
        await checkFunds();
    }
    async function checkFunds() {
        if (client === null || session === null)
            return;
        setView({ kind: "busy", message: "Checking your balance…" });
        let read = null;
        try {
            read = await readBalance(client, plan.asset, session.account);
        }
        catch {
            // The balance is an advisory pre-flight, not the authority: a wallet that cannot answer the read must not block a payment the wallet itself may still accept.
            read = null;
        }
        balance = read;
        if (balance !== null && balance < plan.amount) {
            showFailure(`Your wallet holds ${fromBaseUnits(balance, plan.asset.decimals)} ${plan.asset.symbol}, less than the ${totalLabel()} needed. Top up the wallet and try again.`);
            return;
        }
        await submit();
    }
    async function submit() {
        if (client === null || session === null)
            return;
        // Claim the invoice's payment before any send leaves: a second flow for the same invoice — a dismissed panel reopened — must not also broadcast, while this flow's own retry after a decline must still get through.
        if (callbacks.claimSend !== undefined && !callbacks.claimSend()) {
            showSendFailure(SEND_CLAIMED_ELSEWHERE_MESSAGE);
            return;
        }
        setView({ kind: "busy", message: "Waiting for your wallet to confirm the transaction…" });
        const attemptedBefore = sendAttempted;
        let receipt;
        try {
            receipt = await sendPayment(client, plan, session, () => {
                sendAttempted = true;
                callbacks.onSendAttempt?.();
            });
        }
        catch (error) {
            if (attemptedBefore) {
                // An earlier attempt may already be on-chain.
                // A retry the payer declines, or one that stops on a network drift, is no proof that the first send did not broadcast, so the flow stays in the caution frame — never the whole-flow retry that could send twice.
                showSendFailure(afterSendFailureMessage(error));
                return;
            }
            if (error instanceof WalletRejectedError && error.action === "transaction") {
                // The wallet explicitly refused this transaction and nothing was broadcast, so — with no earlier attempt in doubt — clearing the latch leaves the whole flow safely retryable.
                sendAttempted = false;
                showFailure("You declined the transaction in your wallet. No payment was sent.");
                return;
            }
            if (error instanceof WrongChainError) {
                // The chain is re-read before the wallet is asked to send, so this refusal happened before anything could be broadcast: the whole flow may be retried safely.
                failFromError(error);
                return;
            }
            showSendFailure(SEND_FAILURE_MESSAGE);
            return;
        }
        balance = null;
        setView({ kind: "sent", receipt });
        callbacks.onNotice(`Payment submitted: ${receipt.hash}`, "success");
    }
    /**
     * Retry only the send, reusing the connected session and the validated plan from the failed attempt.
     * Discovery, connection and the funds check are not repeated, so an ambiguous send failure cannot turn a retry into a fresh approval-and-broadcast sequence; the chain is still re-read inside {@link sendPayment} immediately before the wallet is asked to send.
     */
    async function resend() {
        if (client === null || session === null) {
            showFailure("The wallet is no longer connected. Connect it again to pay.");
            return;
        }
        await submit();
    }
    async function guard(action) {
        if (running)
            return;
        running = true;
        try {
            await action();
        }
        catch (error) {
            if (sendAttempted) {
                showSendFailure(afterSendFailureMessage(error));
                return;
            }
            failFromError(error);
        }
        finally {
            running = false;
        }
    }
    return {
        begin: () => guard(discover),
        connectWith: (candidate) => guard(() => connect(candidate)),
        retryChain: () => guard(checkChain),
        retrySend: () => guard(resend),
    };
}
//# sourceMappingURL=pay-flow.js.map