/**
 * The stylesheet reader the suites pin CSS rules with: a stylesheet split into its rules, one rule's body looked up by selector, one property's value read out of a body, and a length read in the unit it states.
 * The suites that pin `app/stylesheets/**` share these so no suite carries a second parser of its own.
 */

import assert from "node:assert/strict";

/**
 * Every rule of a stylesheet, as the selector list its header names and the body its braces hold, with its comments dropped first because a rule's text reaches back to the previous closing brace and a comment above it carries commas of its own.
 */
export function cssRules(css) {
	return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((rule) => ({
		selectors: rule[1].split(",").map((entry) => entry.trim()),
		body: rule[2],
	}));
}

/**
 * The declarations of the one rule a stylesheet declares under `selector` alone, or `undefined` when it declares none.
 *
 * A rule's selector list is read entry by entry — split on its commas and trimmed — so the block this returns is the one whose whole list is that selector, and a combined block that lists it beside another selector is not mistaken for the sole-selector rule the way a search for the selector's own line would.
 * Every stylesheet here writes one declaration per line, which is the shape this reads, and writes each selector this asks about as the sole selector of its rule.
 */
export function ruleBody(css, selector) {
	const rule = cssRules(css).find((candidate) => candidate.selectors.length === 1 && candidate.selectors[0] === selector);
	return rule?.body;
}

/** The value of one `property` declaration in a rule body, or `undefined` when the rule declares none. */
export function declaration(body, property) {
	const line = String(body ?? "")
		.split("\n")
		.map((entry) => entry.trim())
		.find((entry) => entry.startsWith(property + ": "));
	return line === undefined ? undefined : line.slice(property.length + 2, -1);
}

/**
 * The value `property` resolves to for `selector`, or `undefined` when no rule naming it declares the property.
 *
 * A selector need not sit alone in a rule's list: `print.css`'s ink block names `.party-detail` beside a dozen others, `.payment-status` is named by that shared affordance block and by its own full-width rule, and a rung's selector is one entry among the surfaces the rung sizes, so this reads every rule whose selector list names it rather than one literal block and takes the last declaration, the one the cascade applies at equal specificity within one stylesheet.
 */
export function appliedDeclaration(css, selector, property) {
	const values = cssRules(css)
		.filter((rule) => rule.selectors.includes(selector))
		.map((rule) => declaration(rule.body, property))
		.filter((value) => value !== undefined);
	return values.length === 0 ? undefined : values[values.length - 1];
}

/** The 16px root font size a rem resolves against, which the page declares no font size of its own to change. */
export const ROOT_FONT_PX = 16;

/** The pixels a stylesheet's `rem` or `px` length states, with the unit required so a length in another unit cannot pass as one. */
export function pxLength(length, where) {
	const text = String(length).trim();
	if (text.endsWith("rem")) return Number(text.slice(0, -3)) * ROOT_FONT_PX;
	assert.ok(text.endsWith("px"), `${where} states its length in rem or px, not ${text}`);
	return Number(text.slice(0, -2));
}

/** The specificity weight of a selector written with classes, attributes, pseudo-classes, and elements: enough to compare the single-class `.btn` with the scoped `.payment-term .payment-copy`, where a class-like token outweighs an element and no id is in play. */
export function selectorWeight(selector) {
	const classLike = (selector.match(/\.[\w-]+|\[[^\]]*\]|::?[\w-]+(?:\([^)]*\))?/g) ?? []).length;
	const elements = (selector.match(/(?:^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length;
	return classLike * 100 + elements;
}
