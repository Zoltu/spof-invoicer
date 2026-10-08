/** The mock EIP-1193 provider and its fixtures, plus the window, announcement-target, and notice helpers the wallet and pay-flow suites drive. */

import { toHexQuantity } from "../../app/js/wallet/eip1193.js";

/** The account the mock wallet connects, and the account the wallet and pay-flow suites assert against. */
export const ACCOUNT = "0x2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b";

/** The transaction hash the mock wallet returns, and the hash the suites assert against. */
export const TX_HASH = `0x${"ab".repeat(32)}`;

/** A single 32-byte word, the shape an `eth_call` result takes. */
export function word(value) {
	return `0x${value.toString(16).padStart(64, "0")}`;
}

/**
 * A mock EIP-1193 provider.
 * It records every request so a test can assert both that the flow called the right methods with the right params and that nothing was called at all before the Pay action.
 * `state` is mutable between steps, which is how a test models a user who first declines a switch and then accepts it, a top-up, or any method failing on demand.
 */
export function mockProvider(config = {}) {
	const calls = [];
	const state = {
		chainId: config.chainId ?? "0x1",
		accounts: config.accounts ?? [ACCOUNT],
		balance: config.balance ?? toHexQuantity(10n ** 18n),
		callResult: config.callResult ?? word(1000000000n),
		hash: config.hash ?? TX_HASH,
		switchFails: null,
		chainAfterSwitch: null,
		fail: {},
	};
	const provider = {
		calls,
		state,
		async request(request) {
			calls.push({ method: request.method, params: request.params });
			const failure = state.fail[request.method];
			if (failure !== undefined) throw failure;
			switch (request.method) {
				case "eth_requestAccounts":
					return state.accounts;
				case "eth_chainId":
					return state.chainId;
				case "wallet_switchEthereumChain":
					if (state.switchFails === "reject") throw { code: 4001, message: "User rejected the request." };
					if (state.switchFails === "unknown") throw { code: 4902, message: "Unrecognized chain ID." };
					if (state.chainAfterSwitch !== null) state.chainId = state.chainAfterSwitch;
					return null;
				case "eth_sendTransaction":
					return state.hash;
				case "eth_getBalance":
					return state.balance;
				case "eth_call":
					return state.callResult;
				default:
					throw new Error(`mock provider: unexpected method ${request.method}`);
			}
		},
	};
	return provider;
}

/** Swap `globalThis.window` for `value`, returning a handle that puts the previous value back. */
export function installWindow(value) {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
	Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value });
	return {
		restore() {
			if (previous === undefined) delete globalThis.window;
			else Object.defineProperty(globalThis, "window", previous);
		},
	};
}

/** An EIP-6963 event target that announces the given details in answer to the request event. */
export function announcementTarget(details) {
	const listeners = new Set();
	return {
		listenerCount: () => listeners.size,
		addEventListener(type, listener) {
			if (type === "eip6963:announceProvider") listeners.add(listener);
		},
		removeEventListener(type, listener) {
			if (type === "eip6963:announceProvider") listeners.delete(listener);
		},
		dispatchEvent(event) {
			if (event.type === "eip6963:requestProvider") {
				for (const detail of details) {
					for (const listener of listeners) listener({ type: "eip6963:announceProvider", detail });
				}
			}
			return true;
		},
	};
}

/** Record the notices a view or shell raises, so a test can assert each message and its tone. */
export function noticeRecorder() {
	const calls = [];
	return {
		calls,
		showNotice(message, tone) {
			calls.push({ message, tone });
		},
		clearNotice() {
			calls.push(null);
		},
	};
}
