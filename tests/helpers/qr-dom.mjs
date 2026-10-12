/**
 * The one statement the view suite makes about a symbol a page drew: that the cells it built are the view model's own matrix, cell for cell.
 *
 * The rule lives here once so the sites cannot drift to different strengths.
 * Each row element is read against the matrix row at the same index and each cell element against the column at the same index, so a transposed grid, a reversed row order, or a shade swapped for its opposite cannot pass on a count of dark modules.
 */

import assert from "node:assert/strict";
import { hasClass, isNode } from "./tree.mjs";

/** Assert the symbol `grid` drew is `symbol`'s own matrix, cell for cell: one row element per matrix row, one module cell per column, each shaded as the cell it stands on. */
export function assertSymbolCellsInDom(grid, symbol) {
	const rows = grid.children.filter(isNode);
	assert.equal(rows.length, symbol.size, "one row element per matrix row");
	rows.forEach((row, rowIndex) => {
		const cells = row.children.filter(isNode);
		assert.equal(cells.length, symbol.size, `row ${rowIndex} carries one element per matrix column`);
		cells.forEach((cell, columnIndex) => {
			assert.equal(hasClass(cell, "qr-module"), true, `the element at row ${rowIndex}, column ${columnIndex} is a module cell`);
			assert.equal(
				hasClass(cell, "qr-module-dark"),
				symbol.modules[rowIndex][columnIndex],
				`the cell at row ${rowIndex}, column ${columnIndex} draws the matrix's own shade`,
			);
		});
	});
}
