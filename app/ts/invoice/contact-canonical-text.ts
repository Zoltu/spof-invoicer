/**
 * The one canonicalization of a party's contact value: the text composed to NFC, its line endings normalized to LF, and each tab replaced with a single space.
 *
 * The canonicalization is stated once, here, so the value the model stores and the spelling a share payload must carry are one text: `invoice/model.ts`'s `contact` repairs a value to this text before it validates and stores it, and `invoice/codec.ts`'s non-canonical reason reads the same function to tell a payload that respelled a contact value apart from one that spells a different value.
 * A second, inline copy of the repair would let a change to this canonicalization leave that reason naming a fault the model no longer covers, while the decode still failed closed on the byte-for-byte comparison.
 * Its line-ending pass is `util/line-endings.ts`'s `normalizeLineEndings` rather than a copy of that rule, so the CRLF and lone-CR normalization this leaf and the icon's own canonicalization both make is stated in one place.
 *
 * The NFC pass makes one visible string one encoding, and the line-ending pass makes a value pasted from an editor that writes Windows endings a single stored spelling, the same two repairs the icon's own canonicalization makes for the same reasons.
 * The tab pass is not a line ending but an in-line character: the model admits a tab inside a contact line, while the display boundary removes every control character from a line it shows, so a stored tab would be drawn as nothing and would join the words it separated — the divergence between the stored value and the drawn one this pass closes by storing the single space the tab stood for.
 *
 * Applying it to a value already in this form leaves that value as it was.
 */

import { normalizeLineEndings } from "../util/line-endings.js";

/** A tab: the one in-line character the contact validator admits that the display boundary removes from a line it shows, stored as the single space it stood for. */
const TAB = /\t/g;

/** The canonical text of a party's contact value: composed to NFC, its line endings normalized to LF, and its tabs replaced with single spaces. */
export function canonicalContactText(value: string): string {
	return normalizeLineEndings(value.normalize("NFC")).replace(TAB, " ");
}
