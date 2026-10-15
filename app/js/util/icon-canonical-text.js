/**
 * The one canonicalization of an icon value: the text with its surrounding whitespace trimmed and the text that remains composed to NFC, the canonical text the invoice's icon field stores.
 *
 * The canonicalization is stated once, here, so the value the icon gate validates and the text a share payload must carry are one spelling: the icon gate (`invoice/icon.ts`) is this function's one caller, and it canonicalizes the text it validates, measures the result with `util/icon-byte-length.ts`'s `iconByteLength` — the {@link CanonicalIconText} brand's one consumer — and returns it to be stored.
 * A reader that has to accept or refuse icon text — the create form's file check included — therefore routes through that gate rather than calling this function, because a second canonicalize-then-decide path would duplicate the gate's rules, and a reader that needs only the canonical spelling takes it from the gate's return value.
 * Canonicalizing a value that is already canonical changes nothing, so applying it to text already in the stored form leaves that text as it was.
 *
 * Its result is the branded {@link CanonicalIconText}, so a reader that assumes canonical text — `util/icon-byte-length.ts`'s measurement — states that precondition in its own signature and the compiler refuses a raw spelling rather than a comment asking a caller to remember one.
 * That brand is a guarantee about one call and no more: it reaches the `iconByteLength` call in the gate and widens back to `string` at each boundary that carries the text onward, so nothing about the stored or transported text is checked at compile time.
 * The boundaries that widen it are the gate's `validateIcon` return, stored as `invoice/model.ts`'s `Invoice.icon`; the form's `ui/create.ts` `CreateFormState.iconSvg`; and `ui/create.ts`'s `checkIconText`, whose `IconCheck` answers a plain `string`.
 * The empty string the form's state uses for "no icon" is what keeps those boundaries a plain `string`: the brand has no way to say a value holds no icon.
 */
/**
 * The canonical text of an icon value: the ends of the text trimmed by `String.prototype.trim()` and the text that remains composed to NFC, the one spelling the invoice's icon field stores and the text the byte cap bounds.
 * The trim's removal set is wider than the word whitespace suggests: `String.prototype.trim()` strips, at either end alone, every character of the spec's `WhiteSpace` and `LineTerminator` productions — tab (U+0009), LF (U+000A), VT (U+000B), FF (U+000C), CR (U+000D), space (U+0020), no-break space (U+00A0), ogham space mark (U+1680), U+2000–U+200A, line separator (U+2028), paragraph separator (U+2029), narrow no-break space (U+202F), medium mathematical space (U+205F), ideographic space (U+3000), and the byte-order mark U+FEFF.
 * Several of those are characters the icon gate otherwise refuses: VT (U+000B), FF (U+000C), CR (U+000D), U+2028, and U+2029 are the boundary faults `util/text.ts`'s `MULTI_LINE_CONTROL` refuses inside the text, and the byte-order mark is one `INVISIBLE_FORMATTING` refuses, so a document whose only fault was such a character at a boundary is repaired here rather than refused.
 * That repair is not an evasion, because of where its result flows: the trimmed, NFC-composed text this function returns is the string the icon gate scans, the value the model stores, the text the codec serializes, and the text a renderer is handed — so a character stripped from a boundary reaches none of those, gone before any check or sink reads the value.
 * The trim reaches the ends alone: a multi-line SVG saved with CRLF endings has its trailing CRLF trimmed here and keeps a CR at each interior line break, which the icon gate then refuses through `util/text.ts`'s `MULTI_LINE_CONTROL`.
 * It returns the branded {@link CanonicalIconText}, the type a reader that requires canonical text accepts.
 */
export function canonicalIconText(value) {
    return value.trim().normalize("NFC");
}
//# sourceMappingURL=icon-canonical-text.js.map