/** The fake documents the UI suites drive: a minimal installable `document` and a richer one whose elements record listeners and dispatch events, each restored on teardown. */

/** Swap `globalThis.document` for `fake`, returning a handle that puts the previous value back. */
export function installDocument(fake) {
	const previous = globalThis.document;
	globalThis.document = fake;
	return {
		restore() {
			if (previous === undefined) {
				delete globalThis.document;
			} else {
				globalThis.document = previous;
			}
		},
	};
}

/** A minimal document whose `createElement` returns an inspectable node, for exercising `h`/`append`. */
export function installFakeDocument() {
	return installDocument({
		createElement(tag) {
			return {
				tagName: tag,
				attributes: {},
				children: [],
				setAttribute(name, value) {
					this.attributes[name] = value;
				},
				append(...nodes) {
					this.children.push(...nodes);
				},
			};
		},
	});
}

/**
 * True when a single selector names this element.
 * Only the two forms the app's `querySelector` calls use are supported: a bare tag name (`"button"`), and a class selector (`".pay-connect"`).
 */
function matchesSimpleSelector(element, selector) {
	if (selector.startsWith(".")) {
		return String(element.attributes.class ?? "")
			.toLowerCase()
			.split(/\s+/)
			.includes(selector.slice(1));
	}
	return element.tagName.toLowerCase() === selector;
}

/** True when a comma-separated selector such as `"button, input"` or `".pay-connect, .pay-wallet"` names this element. */
function selectorMatches(element, selector) {
	return selector
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.some((entry) => matchesSimpleSelector(element, entry));
}

/**
 * A richer document for the views and shell: nodes record listeners and can dispatch events, so the event wiring in `ui/create.ts`, `ui/share.ts`, and `app/shell.ts` can be driven without a real browser.
 * It stays deliberately small — the DOM surface those modules actually use, nothing more.
 *
 * Unlike {@link installFakeDocument}'s plain object nodes, `createElement` returns an instance of the class exposed as `globalThis.HTMLElement`, so `ui/overlay.ts`'s `instanceof HTMLElement` checks behave as they do in a page.
 * `createRange` and `getSelection` are the two calls a copy control's fallback makes when the clipboard refuses, and every range the selection is handed is recorded on the document's own `selections` array, so a suite can assert what a manual copy selected without a real selection to inspect.
 * `document.body` exists for overlay mounting; `append`/`replaceChildren` track each child's `parentNode` so `remove()` can detach it; `isConnected` reports whether a node still hangs under `document.body`, so a subtree `replaceChildren` dropped reads as detached; `focus()` records `document.activeElement`; `querySelector` matches a comma-separated list of tag names or class selectors; and `dispatch` supplies no-op `preventDefault`/`stopPropagation` so a handler can call them on a plain event object.
 */
export function installInteractiveDocument() {
	const previousDocument = globalThis.document;
	const previousHTMLElement = globalThis.HTMLElement;

	class FakeElement {
		constructor(tag) {
			this.tagName = tag;
			this.attributes = {};
			this.children = [];
			this.listeners = {};
			this.parentNode = null;
			this.value = "";
			this.checked = false;
		}
		setAttribute(name, value) {
			this.attributes[name] = String(value);
		}
		getAttribute(name) {
			return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
		}
		removeAttribute(name) {
			delete this.attributes[name];
		}
		hasAttribute(name) {
			return Object.prototype.hasOwnProperty.call(this.attributes, name);
		}
		append(...nodes) {
			for (const node of nodes) {
				if (node instanceof FakeElement) node.parentNode = this;
				this.children.push(node);
			}
		}
		replaceChildren(...nodes) {
			for (const child of this.children) {
				if (child instanceof FakeElement && child.parentNode === this) child.parentNode = null;
			}
			this.children = [];
			this.append(...nodes);
		}
		remove() {
			const parent = this.parentNode;
			if (!(parent instanceof FakeElement)) return;
			parent.children = parent.children.filter((child) => child !== this);
			this.parentNode = null;
		}
		get isConnected() {
			let node = this;
			while (node.parentNode instanceof FakeElement) node = node.parentNode;
			return node === document.body;
		}
		addEventListener(type, listener) {
			(this.listeners[type] ??= []).push(listener);
		}
		removeEventListener(type, listener) {
			this.listeners[type] = (this.listeners[type] ?? []).filter((entry) => entry !== listener);
		}
		dispatch(type, event = { type }) {
			const dispatched = { preventDefault() {}, stopPropagation() {}, ...event };
			for (const listener of this.listeners[type] ?? []) listener(dispatched);
		}
		focus() {
			const doc = globalThis.document;
			if (doc !== undefined && doc !== null) doc.activeElement = this;
		}
		select() {}
		querySelector(selector) {
			const find = (node) => {
				for (const child of node.children) {
					if (!(child instanceof FakeElement)) continue;
					if (selectorMatches(child, selector)) return child;
					const nested = find(child);
					if (nested !== null) return nested;
				}
				return null;
			};
			return find(this);
		}
		get textContent() {
			return this.children.filter((child) => typeof child === "string").join("");
		}
		set textContent(value) {
			this.children = value === "" ? [] : [String(value)];
		}
	}

	const document = {
		body: new FakeElement("body"),
		activeElement: null,
		selections: [],
		createElement(tag) {
			return new FakeElement(tag);
		},
		createTextNode(text) {
			return { nodeType: 3, textContent: text };
		},
		createRange() {
			return {
				node: null,
				selectNodeContents(node) {
					this.node = node;
				},
				getBoundingClientRect() {
					return { width: 0, height: 0 };
				},
			};
		},
		getSelection() {
			return {
				removeAllRanges() {},
				addRange(range) {
					document.selections.push(range);
				},
			};
		},
	};

	globalThis.document = document;
	globalThis.HTMLElement = FakeElement;

	return {
		document,
		restore() {
			if (previousDocument === undefined) {
				delete globalThis.document;
			} else {
				globalThis.document = previousDocument;
			}
			if (previousHTMLElement === undefined) {
				delete globalThis.HTMLElement;
			} else {
				globalThis.HTMLElement = previousHTMLElement;
			}
		},
	};
}
