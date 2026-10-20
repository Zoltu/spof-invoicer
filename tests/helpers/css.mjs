/**
 * The stylesheet reader the suites pin CSS rules with: a stylesheet split into its rules, one rule's body looked up by selector, one property's value read out of a body, and a length read in the unit it states.
 *
 * The suites that pin `app/stylesheets/**` share these so no suite carries a second parser of its own.
 */

import assert from "node:assert/strict";

/**
 * Every rule of a stylesheet, as the selector list its header names, the body its braces hold, and the at-rule query it sits inside, with its comments dropped first because a rule's text reaches back to the previous closing brace and a comment above it carries commas of its own.
 *
 * `at` is the query a rule stands under — `"@media screen"`, `"@media print"`, `""` at the top level — so a suite can pin where a rule is stated and not only what it declares: a rule that keeps its declarations and loses its query is invisible to a reader that keeps only selectors and bodies, and that is exactly how a screen-only cue could reach paper with every other assertion still green.
 */
export function cssRules(css) {
	const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const rules = [];
	const enclosing = [];
	let header = "";
	let index = 0;
	while (index < text.length) {
		const character = text[index];
		if (character === "{") {
			const prelude = header.trim();
			header = "";
			const close = text.indexOf("}", index);
			const nested = text.indexOf("{", index + 1);
			// An at-rule whose block holds rules states the query every rule inside it is drawn under; one whose block holds declarations is a rule of its own, which is how a page block is stated and read.
			if (prelude.startsWith("@") && nested !== -1 && nested < close) {
				enclosing.push(prelude);
				index += 1;
				continue;
			}
			if (close === -1) break;
			rules.push({ selectors: prelude.split(",").map((entry) => entry.trim()), body: text.slice(index + 1, close), at: enclosing.join(" ") });
			index = close + 1;
			continue;
		}
		if (character === "}") {
			enclosing.pop();
			header = "";
			index += 1;
			continue;
		}
		header += character;
		index += 1;
	}
	return rules;
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

/** The width of a U.S. Letter page, the one page size `print.css` declares, in inches. */
const LETTER_WIDTH_IN = 8.5;

/** The CSS pixels an inch the printed page assumes, which is the 96dpi reference the rest of the page is laid out against. */
const CSS_PX_PER_IN = 96;

/** CSS pixels per point at that reference, derived from the inch both geometries already share rather than stated as a fraction of its own: a point is 1/72in. */
const PX_PER_POINT = CSS_PX_PER_IN / 72;

/**
 * The advance of one character in the widest common monospace face a printer substitutes, in em: the bound `MONO_ADVANCE_EM` in `app/ts/ui/fit-value.ts` states and justifies, repeated here as a literal rather than imported, so the suite keeps a figure of its own to hold that module to.
 *
 * It is the one figure of this reader no stylesheet states — a page's geometry is in `print.css`, but a typeface's advance is not — and `printFitRung` is held to it from both sides at every rung: a value of exactly the characters this bound fits prints at that rung, and one character more does not.
 */
const PRINTED_MONO_ADVANCE_EM = 0.62;

/**
 * The width of the line a printed payment value is laid out on, in CSS pixels, read from a print stylesheet's own `@page` block: a Letter page's width less the margin the block declares on each side, at the CSS pixels an inch the page assumes.
 */
export function printedLinePx(printCss) {
	const page = ruleBody(printCss, "@page");
	assert.ok(page !== undefined, "print.css declares the page block a printed value is laid out in");
	const size = String(declaration(page, "size") ?? "").trim();
	assert.equal(size, "Letter", `print.css declares a page size this reader knows, not ${JSON.stringify(size)}`);
	const margin = /^([\d.]+)in$/.exec(String(declaration(page, "margin") ?? "").trim());
	assert.ok(margin !== null, "print.css states its page margin in inches, which is the geometry a printed value is sized against");
	return (LETTER_WIDTH_IN - 2 * Number(margin[1])) * CSS_PX_PER_IN;
}

/**
 * The width of the column a printed payment value is laid out on, in CSS pixels: the page's own content line less the label rail and the column gap the invoice stylesheet gives `.payment-term`.
 * The print twin is a block inside that term's own value column, so this — not the page's whole line — is the width the print ladder is sized against; a rung sized against the line overflows the column, and `white-space: nowrap` then runs the tail of an address past the paper's margin.
 * The widest rail and gap any statement of the term gives are used, because the narrower rail a width query states only widens the column, and the narrowest column is the one a rung must hold the value in.
 */
export function printedValueColumnPx(printCss, invoiceCss) {
	const page = printedLinePx(printCss);
	const terms = cssRules(invoiceCss).filter((rule) => rule.selectors.length === 1 && rule.selectors[0] === ".payment-term");
	assert.ok(terms.length > 0, "invoice.css states the payment term whose value column a printed value is laid out in");
	const widest = (property) => {
		const stated = terms.map((rule) => declaration(rule.body, property)).filter((value) => value !== undefined);
		assert.ok(stated.length > 0, `invoice.css's .payment-term states its ${property}, which is what a printed value's column is derived from`);
		return Math.max(...stated.map((value) => pxLength(String(value).trim().split(/\s+/)[0], `.payment-term ${property}`)));
	};
	const column = page - widest("grid-template-columns") - widest("gap");
	assert.ok(column > 0 && column < page, `a printed payment value's column is narrower than the page's ${page}px line and still has a width: ${column}px`);
	return column;
}

/** How many monospace characters a printed value set at `points` fits in the column it is laid out in: that column's width in CSS pixels against one character's advance, which is the em bound converted to pixels at the point size. */
export function printedCharactersAt(printCss, invoiceCss, points) {
	return Math.floor(printedValueColumnPx(printCss, invoiceCss) / (points * PX_PER_POINT * PRINTED_MONO_ADVANCE_EM));
}

/**
 * The print rung a value of `characters` length earns on the page `printCss` describes and in the column `invoiceCss` gives it, walking the module's own `ladder`: the largest sized rung whose column holds the value, or the rung that wraps when even the last one does not.
 * The break points come from the stylesheets' geometry — the page block's line less the payment term's own rail and gap — rather than from the module's arithmetic, so a width, a rail, or a unit stated wrongly on the module's side fails a suite rather than being transcribed into it.
 */
export function expectedPrintRung(printCss, invoiceCss, ladder, characters) {
	for (const rung of ladder.print) {
		if (rung.wraps || characters > printedCharactersAt(printCss, invoiceCss, rung.points)) continue;
		return rung.rung;
	}
	return ladder.print[ladder.print.length - 1].rung;
}
