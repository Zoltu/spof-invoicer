/**
 * The one normalization of a string's line endings: every CRLF and every lone CR replaced by LF, the line ending the wire format carries.
 *
 * The rule is stated once, here, so the two fields that admit a pasted multi-line value — a party's contact info, canonicalized by `invoice/contact-canonical-text.ts`, and an invoice's icon, canonicalized by `util/icon-canonical-text.ts` — read one statement of it rather than a private copy each, and a change to the rule reaches both fields instead of only the one that kept the copy.
 * Each leaf keeps its own additional passes — the contact's NFC composition and tab replacement, the icon's trim and NFC composition — and calls this function for the line-ending pass alone, so the shared statement never widens into either leaf's other rules.
 *
 * Replacing a CRLF or a lone CR with LF leaves text that already carries LF endings as it was.
 */
/** A CRLF or a lone CR: the two line endings an editor writes that are not the LF the wire format carries. */
const CARRIAGE_RETURN_LINE_ENDING = /\r\n?/g;
/** The text of `value` with its CRLF and lone-CR line endings replaced by LF. */
export function normalizeLineEndings(value) {
    return value.replace(CARRIAGE_RETURN_LINE_ENDING, "\n");
}
//# sourceMappingURL=line-endings.js.map