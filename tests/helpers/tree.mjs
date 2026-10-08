/**
 * Traversal helpers for the fake document in `helpers/dom.mjs`.
 * They speak the node shape its `createElement` returns — a `tagName` string, an `attributes` record, and a `children` array of child nodes and text strings — so a suite can assert what a view built without re-walking it by hand.
 */

/** True when `value` is an element node rather than a text string or another child value. */
export function isNode(value) {
	return typeof value === "object" && value !== null && typeof value.tagName === "string";
}

/** Invoke `visit` on every element below `node`, in document order; `node` itself is not visited. */
export function walk(node, visit) {
	for (const child of node.children ?? []) {
		if (!isNode(child)) continue;
		visit(child);
		walk(child, visit);
	}
}

/** Every element below `rootNode` that `predicate` accepts, in document order. */
export function findAll(rootNode, predicate) {
	const found = [];
	walk(rootNode, (node) => {
		if (predicate(node)) found.push(node);
	});
	return found;
}

/** The concatenated text of a subtree, reading the string children the views append. */
export function textOf(node) {
	let text = "";
	for (const child of node.children ?? []) {
		text += isNode(child) ? textOf(child) : typeof child === "string" ? child : "";
	}
	return text;
}

/** The first descendant `<button>` whose text is exactly `label`, or `undefined`. */
export function findButton(rootNode, label) {
	return findAll(rootNode, (node) => node.tagName === "button" && textOf(node) === label)[0];
}
