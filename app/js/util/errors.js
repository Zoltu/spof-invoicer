/**
 * Shared error-message helpers for the wallet, asset, invoice, and share primitives.
 *
 * `describe` renders any rejected value safely and uniformly for the bad-argument slot of an error message: `null`, `undefined`, `symbol` and objects never throw, and identical values render identically across modules.
 * `preview` renders the same bad-argument slot boundedly — a length bound for values that can be arbitrarily large (an unparsed share payload, an over-long free-text field) — and it bounds the work as well as the message: a value that is not a string is never asked for a rendering the bound could not cut, the tag it is rendered under is read under a guard of its own, and the characters `JSON.stringify` leaves as themselves are stripped from whatever it does render.
 * `boundMessage` clips an already-rendered message that embeds such a value, and `messageOf` extracts the message of a caught error so one module can wrap another's failure with its own path.
 *
 * The value-validation functions in `util/decimal.ts`, `wallet/address.ts` and `wallet/erc20.ts` follow one rule: an argument of the wrong shape or type throws a `TypeError`, while a correctly-shaped value outside the accepted range throws a `RangeError`.
 * Typed domain errors are separate `Error` subclasses and sit outside that rule — for example `UnsupportedAssetError`, `UnsupportedChainError` and `UnpayableAddressError` in `assets/registry.ts`, `InvalidChecksumError` in `wallet/address.ts`, `InvalidZcashAddressError` in `wallet/zcash-address.ts` and `InvalidMoneroAddressError` in `wallet/monero-address.ts`, `UnsupportedPayoutFamilyError` and `UnreadableTokenContractError` in `wallet/payout-address.ts`, `InvalidInvoiceError` and `UnsupportedInvoiceVersionError` in `invoice/model.ts`, `InvalidIconError` in `invoice/icon.ts`, and `ShareFormatError` and `UnsupportedShareVersionError` in `invoice/codec.ts`.
 *
 * Messages start with a `<module>:` prefix and name the value that failed, but the rest of the wording varies with what went wrong; there is no single rigid separator form, and the one exception is the prefix-less clause `wallet/payout-address.ts` raises for a non-string EVM payee, whose wording is explained there.
 */
import { boundRaw, stripDisplayCharacters } from "./text.js";
/**
 * Render a rejected value for the bad-argument slot of an error message.
 *
 * Safe for any value: a string is quoted so an empty or padded one stays visible, and `null`/`undefined`/`symbol`/objects render without throwing.
 * An object whose `toString`/`valueOf` throws (e.g. `Object.create(null)`) renders as `"[unprintable]"` rather than masking the rejection with a second error.
 */
export function describe(value) {
    try {
        return typeof value === "string" ? JSON.stringify(value) : String(value);
    }
    catch {
        return "[unprintable]";
    }
}
/**
 * How much of a rejected value a message echoes by default.
 *
 * The refusals this bound is for are the ones that lead with the reason a value was refused and trail a bounded echo of it: the Zcash and Monero payout-address validators (`wallet/zcash-address.ts`, `wallet/monero-address.ts`) and the share validators (`invoice/codec.ts`, `invoice/share.ts`).
 * An EVM address refusal is not one of those — it names the rejected value first and carries it unbounded (`wallet/address.ts`) — so a caller that read such a value from a field clips the whole message with {@link boundMessage} instead.
 * A caller that wraps a reason-first message into a user-facing notice (`invoice/model.ts`) clips the whole message again to its own limit, and a value echoed in full here would spend that clip on the user's own paste rather than on the explanation.
 */
const REJECTED_VALUE_MAX = 60;
/** The rendering of a value whose own conversion or tag cannot be read safely: the fixed form {@link describe} gives a value whose `toString`/`valueOf` throws. */
const UNPRINTABLE = "[unprintable]";
/**
 * The longest type tag {@link tagRendering} echoes: every tag the engine's own rendering produces is shorter than this (`[object AsyncGenerator]` is 25 characters), so a value claiming a longer one is cut rather than carried whole.
 */
const MAX_TAG_LENGTH = 32;
/**
 * The `[object …]` rendering of an object or function value, with the value's own `Symbol.toStringTag` read under a guard.
 *
 * `Object.prototype.toString.call(value)` asks the value for that getter and concatenates whatever it returns into `[object …]` before this module could cut the result, so a hostile tag is allocated and copied in full and the bound would limit the message without limiting the work; a getter that throws would also replace the caller's contracted `TypeError` with the value's own error.
 * Reading the property here keeps the rendering inside that contract: a getter that throws renders as {@link UNPRINTABLE}, a tag that is a string is cut to {@link MAX_TAG_LENGTH} before it is wrapped, and a tag that is absent or is not a string takes the engine's own rendering, whose tag is a fixed literal.
 */
function tagRendering(value) {
    let stated;
    try {
        stated = value[Symbol.toStringTag];
    }
    catch {
        return UNPRINTABLE;
    }
    if (typeof stated === "string") {
        return `[object ${boundRaw(stated, MAX_TAG_LENGTH)}]`;
    }
    try {
        // A value with no tag, or one whose tag is not a string, is rendered by the engine exactly as before; the read above proves nothing about a second one, so a getter that answers a number once and throws the next time is caught here too.
        return Object.prototype.toString.call(value);
    }
    catch {
        return UNPRINTABLE;
    }
}
/**
 * The rendering of a value that is not a string, produced without asking the value for a rendering the bound could not cut.
 *
 * A primitive renders exactly as {@link describe} renders it: its text is its own value rather than work proportional to what a caller supplied.
 * An object or a function renders as its type tag instead, through {@link tagRendering}, because `describe` on one runs the value's own `toString`/`valueOf` and allocates whatever that returns in full — a hostile `toString` therefore costs a megabyte before any cut could reach it, and a tag is a fixed-length form that asks the value for none of its conversions.
 * The tag also makes an array render as `[object Array]` rather than its joined entries and a `Date` as `[object Date]` rather than its formatted date; that information is the price of a bound that holds on the work as well as on the message.
 */
function boundedRendering(value) {
    if (value !== null && (typeof value === "object" || typeof value === "function")) {
        return tagRendering(value);
    }
    return describe(value);
}
/**
 * Render a rejected value boundedly, for the bad-argument slot of an error message, keeping both the message and the work it does inside `limit`.
 *
 * A string value is bounded to `limit` code units before it is rendered, so a multi-megabyte provider reply is not escaped end to end by `JSON.stringify` only to be cut a moment later; that bound is surrogate-safe, and so is the cut of the escaped rendering below, so truncating cannot leave a lone surrogate, and the annotation for a string reports its own length rather than the escaped rendering's.
 * A non-string value is rendered by {@link boundedRendering}, so neither the value's own conversion nor its `Symbol.toStringTag` getter can stretch the rendering past the bound or displace the diagnostic with an error of its own.
 * Whatever is rendered then goes through the display-character pass `util/text.ts` defines, because `JSON.stringify` escapes the C0 controls but leaves the C1 block, the Unicode line and paragraph separators, and the bidi and other invisible formatting characters as themselves — and those are exactly the characters a form or a text node renders without showing, so an unstripped echo could reorder or disguise the message that carries it.
 * The pass runs on the rendering rather than on the raw value, so the escaped form of a C0 control (a literal `\n`) survives it unchanged.
 * A value whose rendering fits within `limit` is unaffected; a longer one is cut and annotated with its full length.
 */
export function preview(value, limit = REJECTED_VALUE_MAX) {
    const described = typeof value === "string" ? describe(boundRaw(value, limit)) : boundedRendering(value);
    const rendered = stripDisplayCharacters(described);
    const length = typeof value === "string" ? value.length : rendered.length;
    return rendered.length <= limit ? rendered : `${boundRaw(rendered, limit)}… (${length} characters)`;
}
/**
 * Clip an already-rendered message to `limit` characters, annotating the cut with the original length.
 *
 * This differs from {@link preview} in the one way that matters here: `preview` renders its argument as a *value* — a string is quoted and escaped — so feeding a message through it would distort the message.
 * A validator whose own message embeds an attacker-controlled value (a payout address, an amount string) is unbounded, so a caller that turns that message into a user-facing notice bounds it here instead.
 * The cut is surrogate-safe in the way {@link boundRaw} is, so a message that carries a surrogate pair across the cut cannot leave a lone surrogate in the notice or document string it becomes.
 */
export function boundMessage(message, limit = 200) {
    return message.length <= limit ? message : `${boundRaw(message, limit)}… (${message.length} characters)`;
}
/** The message of a caught error, or {@link describe} of a non-`Error` throw. */
export function messageOf(error) {
    return error instanceof Error ? error.message : describe(error);
}
//# sourceMappingURL=errors.js.map