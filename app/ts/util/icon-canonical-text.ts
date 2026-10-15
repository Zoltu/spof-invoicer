/**
 * The one canonicalization of an icon value: the text with its surrounding whitespace trimmed and the text that remains composed to NFC, the canonical text the invoice's icon field stores.
 *
 * The canonicalization is stated once, here, so the value the icon gate validates and the text a share payload must carry are one spelling: the icon gate (`invoice/icon.ts`) is this function's one caller, and it canonicalizes the text it validates, measures the result with `util/icon-byte-length.ts`'s `iconByteLength` — the {@link CanonicalIconText} brand's one consumer — and returns it to be stored.
 * A reader that has to accept or refuse icon text — the create form's file check included — therefore routes through that gate rather than calling this function, because a second canonicalize-then-decide path would duplicate the gate's rules, and a reader that needs only the canonical spelling takes it from the gate's return value.
 * Canonicalizing a value that is already canonical changes nothing, so applying it to text already in the stored form leaves that text as it was.
 * Its result is the branded {@link CanonicalIconText}, so a reader that assumes canonical text — `util/icon-byte-length.ts`'s measurement — states that precondition in its own signature and the compiler refuses a raw spelling rather than a comment asking a caller to remember one.
 * That brand is a guarantee about one call and no more: it reaches the `iconByteLength` call in the gate and widens back to `string` at each boundary that carries the text onward, so nothing about the stored or transported text is checked at compile time.
 * The boundaries that widen it are the gate's `validateIcon` return, stored as `invoice/model.ts`'s `Invoice.icon`; the form's `ui/create.ts` `CreateFormState.iconSvg`; and `ui/create.ts`'s `checkIconText`, whose `IconCheck` answers a plain `string`.
 * The empty string the form's state uses for "no icon" is what keeps those boundaries a plain `string`: the brand has no way to say a value holds no icon.
 */

/**
 * Canonical icon text: {@link canonicalIconText}'s result, branded so a raw spelling cannot stand in for it.
 *
 * The brand is what keeps an uncomposed or whitespace-padded spelling out of a reader that assumes canonical text: `util/icon-byte-length.ts`'s `iconByteLength` takes this type, so handing it a file's raw text — which would measure a different byte count than the text the gate stores — is a compile error, and {@link canonicalIconText} is the one place that mints the type.
 * The brand is a phantom: no value carries the property at runtime, and every value of this type came from the canonicalizer or from a cast the compiler accepted.
 */
export type CanonicalIconText = string & { readonly __canonicalIconTextBrand: unique symbol };

/**
 * The canonical text of an icon value: its surrounding whitespace trimmed and the text that remains composed to NFC, the one spelling the invoice's icon field stores and the text the byte cap bounds.
 * The trim is `String.prototype.trim()`, which also drops a U+FEFF byte-order mark at either end, so a file's own byte-order mark is not a fault.
 * The trim reaches the ends alone and repairs only the surrounding whitespace: a multi-line SVG saved with CRLF endings has its trailing CRLF trimmed here and keeps a CR at each of its interior line breaks, which the icon gate then refuses through `util/text.ts`'s `MULTI_LINE_CONTROL` — the rule that admits LF and tab alone, so CR, U+2028, and U+2029 are refused wherever they sit inside the text.
 * It returns the branded {@link CanonicalIconText}, the type a reader that requires canonical text accepts.
 */
export function canonicalIconText(value: string): CanonicalIconText {
	return value.trim().normalize("NFC") as CanonicalIconText;
}
