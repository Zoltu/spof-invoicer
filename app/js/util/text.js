/**
 * Text hygiene shared by the invoice model and the wallet metadata boundary: the character classes that let a stored or displayed value read differently from the bytes it holds, and the code-unit bound that keeps a truncated string well-formed.
 *
 * The control classes and the invisible/direction-formatting class are defined once here, and both the invoice validator's refusal and the wallet label sanitizer read them, so the two agree on the property-derived class; the sanitizer additionally drops the two invisible, bidi-affecting ranges Unicode subtracts from that property, which a value that is shown must lose even though a stored field does not refuse them.
 * The control classes cover the C1 block (U+0080–U+009F) alongside the C0 controls: a C1 control is one more byte that renders as nothing or as a terminal or bidi-affecting sequence a viewer cannot see as text, so a validated field refuses it and a shown one strips it, exactly as for a C0 control.
 * The single-line field refuses every line break; the multi-line field permits only the LF its renderer splits on, so a line-breaking C1 control such as NEL (U+0085) is refused in both, just as CR is refused in the multi-line field.
 * {@link LONE_SURROGATE} names the malformed-text class both the invoice model and the icon validator refuse: a lone surrogate code unit is not a code point any renderer can show, and neither NFC composition nor the codec's canonical re-serialization rejects one, so a validating boundary must.
 * The property's third subtraction, `Prepended_Concatenation_Mark` (U+0600–U+0605, U+06DD, U+070F, U+0890–U+0891, U+08E2, U+110BD, U+110CD), is deliberately left unstripped by both classes: those are rendered script characters, and removing them would corrupt legitimate text.
 */
/** All C0 and C1 controls, DEL, and the Unicode line and paragraph separators, for a single-line field. */
export const SINGLE_LINE_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/**
 * The same minus tab and newline, for a field whose value may hold lines.
 * The rule reads text whose ends a caller has already dealt with: the invoice's own text fields refuse a leading or trailing whitespace, and the icon gate reads this rule over the canonical text `util/icon-canonical-text.ts` returns, whose trim has already removed a boundary VT (U+000B), FF (U+000C), CR (U+000D), U+2028, or U+2029 — so an occurrence this rule refuses is one that survives inside the text rather than at its end.
 */
export const MULTI_LINE_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/;
/**
 * Invisible and direction-formatting characters, keyed on Unicode's `Default_Ignorable_Code_Point` property rather than a hand-written list.
 *
 * The property is every code point a conforming renderer may drop or treat as invisible: the soft hyphen, the bidi marks and the bidi embedding, override and isolate controls, the zero-width spaces and joiners, the word joiner and the other invisible operators, the Mongolian vowel separator, the Hangul, Khmer and other fillers, the variation selectors, the tag characters, and the reserved default-ignorables (U+2065, U+FFF0–FFF8, U+E0000+).
 * A hand-written list missed many of these — U+034F, U+115F/1160/FFA0, U+180B–180D, U+FE00–FE0F, U+1BCA0+, U+E0100+, U+2065 — and any of them could hide inside an id, a name, or a description and make one value render as another; deriving the class from the property also means a code point the property gains later is refused without editing this file.
 * The derivation subtracts three groups, so this class does not match them even though they are invisible: the interlinear-annotation format characters (U+FFF9–FFFB) and the Egyptian hieroglyph format controls (U+13430–1343F), which {@link UNSAFE_DISPLAY_CHARACTERS} adds back for a value that is shown, and `Prepended_Concatenation_Mark` (U+0600–U+0605, U+06DD, U+070F, U+0890–U+0891, U+08E2, U+110BD, U+110CD), which is deliberately left out of both classes because those are rendered script characters.
 * The `u` flag is required for the property escape, and the pattern carries no `g` flag so that `.test` stays a pure predicate rather than a stateful scan.
 */
export const INVISIBLE_FORMATTING = /\p{Default_Ignorable_Code_Point}/u;
/** A high surrogate with no low surrogate after it, or a low surrogate with no high surrogate before it — a lone surrogate code unit rather than one half of a valid pair. */
export const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/**
 * {@link SINGLE_LINE_CONTROL}, {@link INVISIBLE_FORMATTING}, and the two invisible and bidi-affecting groups the property subtracts from itself — the interlinear-annotation format characters (U+FFF9–FFFB) and the Egyptian hieroglyph format controls (U+13430–1343F) — as one global pass, for cleaning a value that is shown rather than refusing it.
 * The subtract-set is included because a value that is shown must lose those code points even though {@link INVISIBLE_FORMATTING} leaves them out; the property's third subtraction, `Prepended_Concatenation_Mark`, is deliberately not added, because those render as script characters rather than as invisible ones and removing them would corrupt legitimate text.
 */
const UNSAFE_DISPLAY_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Default_Ignorable_Code_Point}|[\uFFF9-\uFFFB\u{13430}-\u{1343F}]/gu;
/**
 * Remove every control character, line or paragraph separator, and invisible or bidi-affecting formatting character from a value that is shown rather than validated.
 *
 * A wallet's announced label is display text from an untrusted source, so it is cleaned here instead of refused: the control and property-derived classes are exactly the ones {@link SINGLE_LINE_CONTROL} and {@link INVISIBLE_FORMATTING} name, and the pass adds the two ranges the property subtracts from itself.
 */
export function stripDisplayCharacters(value) {
    return value.replace(UNSAFE_DISPLAY_CHARACTERS, "");
}
/**
 * The longest prefix of `value` that fits in `max` UTF-16 code units without ending on a lone high surrogate.
 *
 * Slicing a string at an arbitrary code-unit offset can split a surrogate pair, and the resulting unpaired surrogate is not a code point any renderer can show — a string carrying one is malformed text. Dropping the high surrogate at the cut keeps the bounded prefix well-formed, so bounding a provider-supplied string before the display-character pass cannot seed that pass with a lone surrogate.
 */
export function boundRaw(value, max) {
    if (value.length <= max)
        return value;
    const last = value.charCodeAt(max - 1);
    const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
    return value.slice(0, end);
}
//# sourceMappingURL=text.js.map