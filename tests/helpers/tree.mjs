/**
 * Traversal helpers for the fake document in `helpers/dom.mjs`.
 * They speak the node shape its `createElement` returns — a `tagName` string, an `attributes` record, and a `children` array of child nodes and text strings — so a suite can assert what a view built without re-walking it by hand.
 */

/** True when `value` is an element node rather than a text string or another child value. */
export function isNode(value) {
	return typeof value === "object" && value !== null && typeof value.tagName === "string";
}

/** True when `node` carries `name` in its space-separated class attribute. */
export function hasClass(node, name) {
	return String(node.attributes.class ?? "").split(/\s+/).includes(name);
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

/**
 * The `value` attribute of every `<input>` below `node`, in document order.
 * A value a view puts in a field rather than in a text node is not part of {@link textOf}, so a suite asserting what such a value reads has to read the field itself.
 */
export function inputValues(node) {
	return findAll(node, (child) => child.tagName === "input").map((input) => String(input.attributes.value));
}

/** The first descendant `<button>` whose text is exactly `label`, or `undefined`. */
export function findButton(rootNode, label) {
	return findAll(rootNode, (node) => node.tagName === "button" && textOf(node) === label)[0];
}
