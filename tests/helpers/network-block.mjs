/**
 * Test helper: replace every page-visible network entry point with a recorder, so a module loaded under it fails loudly if it reaches for the network.
 * Returns a function that restores the globals.
 *
 * The harness records the runtime network APIs a page can reach — fetch, XMLHttpRequest, WebSocket, EventSource, WebTransport, Worker, importScripts, sendBeacon, serviceWorker.register and RTCPeerConnection, plus the `Image` constructor — and the persistence and side-channel sinks the "no cookie, no storage" promise bans: localStorage, sessionStorage, indexedDB, history.pushState/replaceState, document.cookie and window.name.
 * It cannot observe a dynamic `import()`, and it cannot see the markup channels that need no script at all (`link rel="prefetch"`/`dns-prefetch`, `a[ping]`), which the static sweep in tests/slow/acceptance.test.mjs covers instead; that sweep names the storage and side-channel APIs too, so the runtime recorder and the source sweep stay paired.
 * The dynamic imports are deliberate and harmless here: the app's two lazy imports (`app/ts/app/shell.ts`'s `import("../pdf/renderer.js")` and `app/ts/pdf/renderer.ts`'s `import("./rasterize.js")`) are static, same-origin, relative literals that resolve to local module files, so each is a same-origin module load — not a `fetch`/XHR and not an external destination — and no invoice data leaves the page.
 * The zero-network guarantee is therefore about the network API calls and external destinations this recorder and the static sweep cover, and it excludes that same-origin module load, which `connect-src 'none'` does not govern either.
 *
 * A browser has `window === globalThis`, so stubbing the globals is enough to catch a bare `fetch`.
 * A test that installs a fake `window` (the shell and EIP-6963 paths do, to hand the app an event target) breaks that identity: a call written as `window.fetch` would then land on the fake object, not on the stubbed global.
 * To keep those paths under the same recorder, the same set is installed on a fake `window` too — when one is present and distinct from `globalThis` — so the call is recorded rather than silently missed.
 */

/** Replace every page-visible network and storage entry point with a recorder that pushes to `calls` and throws, and return a function that restores the globals. */
export function blockNetwork(calls) {
	const navigatorStub = Object.create(globalThis.navigator ?? null);
	navigatorStub.sendBeacon = (...args) => {
		calls.push(`navigator.sendBeacon(${String(args[0])})`);
		throw new Error("network blocked: navigator.sendBeacon");
	};
	Object.defineProperty(navigatorStub, "serviceWorker", {
		configurable: true,
		value: {
			register: (...args) => {
				calls.push(`navigator.serviceWorker.register(${String(args[0])})`);
				throw new Error("network blocked: navigator.serviceWorker.register");
			},
		},
	});
	const stubs = {
		fetch: (...args) => {
			calls.push(`fetch(${String(args[0])})`);
			throw new Error("network blocked: fetch");
		},
		XMLHttpRequest: class {
			constructor() {
				calls.push("XMLHttpRequest");
			}
		},
		WebSocket: class {
			constructor() {
				calls.push("WebSocket");
			}
		},
		EventSource: class {
			constructor() {
				calls.push("EventSource");
			}
		},
		WebTransport: class {
			constructor() {
				calls.push("WebTransport");
			}
		},
		Worker: class {
			constructor(...args) {
				calls.push(`Worker(${String(args[0])})`);
			}
		},
		importScripts: (...args) => {
			calls.push(`importScripts(${args.map(String).join(", ")})`);
			throw new Error("network blocked: importScripts");
		},
		RTCPeerConnection: class {
			constructor() {
				calls.push("RTCPeerConnection");
			}
		},
		Image: class {
			constructor(...args) {
				calls.push(`Image(${args.map(String).join(", ")})`);
			}
		},
		localStorage: storageStub(calls, "localStorage"),
		sessionStorage: storageStub(calls, "sessionStorage"),
		indexedDB: indexedDbStub(calls),
		history: historyStub(calls),
		navigator: navigatorStub,
	};
	const hosts = [globalThis];
	const fakeWindow = globalThis.window;
	if (typeof fakeWindow === "object" && fakeWindow !== null && fakeWindow !== globalThis) {
		hosts.push(fakeWindow);
	}
	const saved = [];
	for (const host of hosts) {
		for (const [name, value] of Object.entries(stubs)) {
			saved.push([host, name, Object.getOwnPropertyDescriptor(host, name)]);
			Object.defineProperty(host, name, { configurable: true, writable: true, value });
		}
		saved.push([host, "name", Object.getOwnPropertyDescriptor(host, "name")]);
		Object.defineProperty(host, "name", sideChannelAccessor(calls, "window.name"));
	}
	const documentHost = globalThis.document;
	if (typeof documentHost === "object" && documentHost !== null) {
		saved.push([documentHost, "cookie", Object.getOwnPropertyDescriptor(documentHost, "cookie")]);
		Object.defineProperty(documentHost, "cookie", sideChannelAccessor(calls, "document.cookie"));
	}
	return () => {
		for (const [host, name, descriptor] of saved) {
			if (descriptor === undefined) {
				delete host[name];
			} else {
				Object.defineProperty(host, name, descriptor);
			}
		}
	};
}

/** A `localStorage`/`sessionStorage` stand-in that records the call and throws, so a module that persists a value fails loudly instead of succeeding silently. */
function storageStub(calls, name) {
	const record = (method) => (...args) => {
		const detail = args.length === 0 ? "" : `(${String(args[0])})`;
		calls.push(`${name}.${method}${detail}`);
		throw new Error(`storage blocked: ${name}.${method}`);
	};
	return {
		getItem: record("getItem"),
		setItem: record("setItem"),
		removeItem: record("removeItem"),
		clear: record("clear"),
		key: record("key"),
	};
}

/** An `indexedDB` stand-in whose `open` records and throws. */
function indexedDbStub(calls) {
	return {
		open: (...args) => {
			calls.push(`indexedDB.open(${String(args[0])})`);
			throw new Error("storage blocked: indexedDB.open");
		},
	};
}

/** A `history` stand-in whose state-changing methods record and throw; the page navigates only through the URL fragment, which the shell owns. */
function historyStub(calls) {
	const record = (method) => (...args) => {
		calls.push(`history.${method}(${String(args[1])})`);
		throw new Error(`storage blocked: history.${method}`);
	};
	return {
		pushState: record("pushState"),
		replaceState: record("replaceState"),
	};
}

/**
 * A property accessor that records and throws on both read and write, for the two sinks that are not calls: a value stashed on `window.name` survives a navigation, and `document.cookie` persists across visits, so either would break the no-storage promise.
 */
function sideChannelAccessor(calls, label) {
	const block = (action) => () => {
		calls.push(`${label} (${action})`);
		throw new Error(`storage blocked: ${label}`);
	};
	return { configurable: true, get: block("read"), set: block("write") };
}
