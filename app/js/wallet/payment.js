/**
 * The payment flow: an invoice plus a connected wallet become one exact transfer.
 *
 * Two rules shape this module.
 * First, the amount is never taken from anything transported: it is recomputed with `computeTotals(invoice)`, so a share string cannot ask for a total that disagrees with its own line items, and the payee comes from the invoice's validated payout address rather than from any field a payload could add.
 * Second, nothing here runs until the payer has explicitly asked to pay — {@link sendPayment} is the only function that sends, and every function is inert until its caller `ui/pay-flow.ts` invokes it from a click.
 *
 * The provider is the app's only outbound channel: balances and the transaction itself travel through the injected wallet object, never through a page-origin request.
 */
import { requireAsset, requireChain, requirePayableAddress, } from "../assets/registry.js";
import { computeTotals } from "../invoice/model.js";
import { describe } from "../util/errors.js";
import { normalizeAddress } from "./address.js";
import { toHexQuantity, } from "./eip1193.js";
import { decodeUint256, encodeBalanceOf, encodeTransfer } from "./erc20.js";
/** The invoice cannot be paid as described; a validated invoice never reaches this. */
export class PaymentPlanError extends Error {
    constructor(reason) {
        super(`payment: ${reason}`);
        this.name = "PaymentPlanError";
    }
}
/** The wallet is on a different network from the one the invoice names, so nothing may be sent. */
export class WrongChainError extends Error {
    current;
    expected;
    constructor(current, expected) {
        super(`payment: your wallet is on network ${describe(current)} but this invoice must be paid on ${describe(expected)} — switch networks in your wallet and try again`);
        this.name = "WrongChainError";
        this.current = current;
        this.expected = expected;
    }
}
/** The wallet granted access but reported no account to pay from. */
export class NoAccountError extends Error {
    constructor() {
        super("payment: the wallet returned no account — unlock it, grant access, and try again");
        this.name = "NoAccountError";
    }
}
/**
 * Reduce a validated invoice to the one transfer it asks for.
 *
 * The asset and the chain are re-derived from the registry rather than trusted, the recipient is re-checked as payable, and the amount is {@link computeTotals}' total in the asset's base units.
 * A native invoice sends the payee the total as `value`; an ERC-20 invoice addresses the token contract with `transfer(payee, total)` calldata and attaches no value.
 */
export function buildPaymentPlan(invoice) {
    const asset = requireAsset(invoice.asset);
    const chainId = requireChain(invoice.chainId);
    if (chainId !== asset.chainId) {
        throw new PaymentPlanError(`the invoice names chain ${describe(chainId)} but ${asset.id} lives on ${describe(asset.chainId)}`);
    }
    const totals = computeTotals(invoice);
    const amount = totals.total.units;
    const recipient = requirePayableAddress(invoice.payee.address, asset);
    const shared = {
        invoiceId: invoice.id,
        asset,
        chainId,
        amount,
        amountText: totals.total.text,
        recipient,
    };
    if (asset.kind === "native") {
        return Object.freeze({ ...shared, target: recipient, data: null, value: amount });
    }
    return Object.freeze({
        ...shared,
        target: normalizeAddress(asset.address),
        data: encodeTransfer(recipient, amount),
        value: 0n,
    });
}
/**
 * The `eth_sendTransaction` object for a plan and the account that signs it.
 *
 * The request names the invoice's own `chainId` alongside the account, but that field is not part of EIP-1474's `eth_sendTransaction` params and a wallet may ignore it.
 * The wrong-chain guarantee is {@link sendPayment}'s own `eth_chainId` re-read immediately before this request is built, not this field.
 */
export function transactionRequest(plan, from) {
    return Object.freeze({
        from: normalizeAddress(from),
        to: plan.target,
        value: toHexQuantity(plan.value),
        chainId: plan.chainId,
        ...(plan.data === null ? {} : { data: plan.data }),
    });
}
/**
 * Ask the wallet for the account that will pay, then read the network it is on.
 *
 * `eth_requestAccounts` is the call that opens the wallet's approval prompt, so it is only reached from the payer's own action; the chain is read afterwards so the flow can check and, if needed, switch before anything is built.
 */
export async function connectWallet(client) {
    const accounts = await client.requestAccounts();
    if (accounts.length === 0)
        throw new NoAccountError();
    const account = accounts[0];
    if (account === undefined)
        throw new NoAccountError();
    const chainId = await client.chainId();
    return Object.freeze({ account, chainId });
}
/**
 * Make the wallet sit on `chainId`, switching it when it is elsewhere.
 *
 * The chain is read again after the switch rather than assumed: a wallet may report success yet stay put, and the payment must not proceed on the wrong network.
 * A rejected switch or a chain the wallet does not know propagates as its own error so the panel can offer the right guidance.
 */
export async function ensureWalletChain(client, chainId) {
    const current = await client.chainId();
    if (current === chainId)
        return;
    await client.switchChain(chainId);
    const after = await client.chainId();
    if (after !== chainId)
        throw new WrongChainError(after, chainId);
}
/**
 * The wallet's balance of the invoice's asset, in base units.
 *
 * Advisory only — the wallet remains the authority on whether a transfer can go through — so the read either answers or throws: there is no "unknown balance" result, and a caller that cannot read it must treat the failure as inconclusive rather than a refusal, catching it and continuing without a balance.
 * Provider failures propagate as the {@link WalletClient} normalizes them.
 */
export async function readBalance(client, asset, account) {
    if (asset.kind === "native")
        return client.getBalance(account);
    const data = await client.call(normalizeAddress(asset.address), encodeBalanceOf(account));
    return decodeUint256(data);
}
/**
 * Broadcast the plan's transfer through the wallet.
 *
 * The chain is re-checked here, immediately before the transaction is built, so a wallet that drifted to another network between the connect step and this one refuses to send rather than paying on the wrong chain.
 * The request's `from` is the connected account; nothing else about the transfer is caller-supplied.
 * `onSendAttempt` fires the instant before the transaction is handed to the wallet, so a caller can record that a broadcast was asked for even when the reply never arrives.
 */
export async function sendPayment(client, plan, session, onSendAttempt) {
    const current = await client.chainId();
    if (current !== plan.chainId)
        throw new WrongChainError(current, plan.chainId);
    onSendAttempt?.();
    const hash = await client.sendTransaction(transactionRequest(plan, session.account));
    return Object.freeze({ hash, account: session.account, chainId: plan.chainId, amount: plan.amount });
}
//# sourceMappingURL=payment.js.map