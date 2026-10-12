/**
 * The one statement both layout suites make about a symbol a page drew: that the modules drawn are the view model's own matrix, cell for cell.
 *
 * The rule lives here once so the suites cannot drift apart: the matrix's dark cells carry the document's ink, read from the ink rule that opens the payment section the symbol belongs to, and its light cells carry the page's own paper — part of this one rule rather than a second assertion over it, because the app draws a symbol's light modules in its paper and a page carrying any other shade there would be a different document.
 * Each module is mapped back to the cell its own geometry occupies — its column from the symbol's left edge, its row from the symbol's top edge, each in module steps — and its shade read against that cell, so a transposed grid, a reversed row order, or a swapped pair of shades cannot pass on the colours alone.
 */

import assert from "node:assert/strict";
import { QR_SYMBOL } from "../../app/js/pdf/renderer.js";

/** The paper the app's pages are drawn on, as the "r,g,b" triple a drawn fill and a matrix cell are compared on. */
const PAGE_PAPER = "1,1,1";

/** A drawn color as the "r,g,b" triple the ink and a matrix cell are compared on. */
function shade(color) {
	return color.red + "," + color.green + "," + color.blue;
}

/**
 * The paying ink of the page's payment section, read off the rule that opens it: the drawn rule standing nearest above `symbolTop`, the symbol's own top edge.
 * Anchoring on the symbol puts the rule inside the symbol's own context, so a restyle of an unrelated rule cannot move the shade the modules are compared against.
 */
function sectionInk(page, symbolTop) {
	const above = page.ops.filter((op) => op.kind === "rule" && op.y1 >= symbolTop);
	assert.ok(above.length > 0, "the layout opens the payment section with a rule above the symbol");
	const opening = above.reduce((nearest, op) => (op.y1 < nearest.y1 ? op : nearest));
	return shade(opening.color);
}

/** Every module the layout drew as a filled square, in the order the symbol's rows are drawn. */
export function moduleFills(page) {
	return page.ops.filter(
		(op) => op.kind === "fill" && op.width === QR_SYMBOL.module && op.height === QR_SYMBOL.module,
	);
}

/** Assert the symbol `page` drew is `view`'s own matrix, cell for cell: one filled square per module, dark and light alike, each shaded as the cell it lands on. */
export function assertSymbolCells(page, view) {
	const size = view.paymentQr.size;
	const modules = moduleFills(page);
	assert.equal(modules.length, size * size, "exactly one filled square per module, dark and light alike");
	const left = Math.min(...modules.map((op) => op.x));
	const top = Math.max(...modules.map((op) => op.y + op.height));
	const ink = sectionInk(page, top);
	assert.notEqual(ink, PAGE_PAPER, "the payment section's own rule draws in ink, not in the page's paper");
	const cells = new Map();
	for (const op of modules) {
		const column = Math.round((op.x - left) / QR_SYMBOL.module);
		const row = Math.round((top - (op.y + op.height)) / QR_SYMBOL.module);
		assert.ok(row >= 0 && row < size && column >= 0 && column < size, `a module is drawn outside the symbol's own grid: row ${row}, column ${column}`);
		assert.equal(cells.has(`${row},${column}`), false, `two fills occupy the cell at row ${row}, column ${column}`);
		cells.set(`${row},${column}`, op);
		const dark = view.paymentQr.modules[row][column];
		assert.equal(
			shade(op.color),
			dark ? ink : PAGE_PAPER,
			dark
				? `the cell at row ${row}, column ${column} is a dark module and must be drawn in the document's ink`
				: `the cell at row ${row}, column ${column} is a light module and must be drawn in the page's paper`,
		);
	}
	assert.equal(cells.size, size * size, "every cell of the matrix is drawn exactly once, dark and light alike");
}
