/**
 * Shared error-message helpers for the wallet, asset, invoice, and share primitives.
 *
 * `describe` renders any rejected value safely and uniformly for the bad-argument slot of an error message: `null`, `undefined`, `symbol` and objects never throw, and identical values render identically across modules.
 * `preview` is `describe` with a length bound for values that can be arbitrarily large (an unparsed share payload, an over-long free-text field), `boundMessage` clips an already-rendered message that embeds such a value, and `messageOf` extracts the message of a caught error so one module can wrap another's failure with its own path.
 *
 * The value-validation functions in `util/decimal.ts`, `wallet/address.ts` and `wallet/erc20.ts` follow one rule: an argument of the wrong shape or type throws a `TypeError`, while a correctly-shaped value outside the accepted range throws a `RangeError`.
 * Typed domain errors are separate `Error` subclasses and sit outside that rule — for example `UnsupportedAssetError`, `UnsupportedChainError` and `UnpayableAddressError` in `assets/registry.ts`, `InvalidChecksumError` in `wallet/address.ts`, `InvalidInvoiceError` and `UnsupportedInvoiceVersionError` in `invoice/model.ts`, and `ShareFormatError` and `UnsupportedShareVersionError` in `invoice/codec.ts`.
 *
 * Messages start with a `<module>:` prefix and name the value that failed, but the rest of the wording varies with what went wrong; there is no single rigid separator form.
 */
import { boundRaw } from "./text.js";
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
 * Render a rejected value exactly like {@link describe} while keeping the message bounded, so a hostile share payload or a long free-text field cannot flood the notice a user reads.
 *
 * A string value is bounded to `limit` code units before it is rendered, so a multi-megabyte provider reply is not escaped end to end by `JSON.stringify` only to be cut a moment later; that bound is surrogate-safe, and so is the cut of the escaped rendering below, so truncating cannot leave a lone surrogate, and the annotation for a string reports its own length rather than the escaped rendering's.
 * A value whose rendering fits within `limit` is unaffected; a longer one is cut and annotated with its full length.
 */
export function preview(value, limit = 60) {
    if (typeof value === "string") {
        const rendered = describe(boundRaw(value, limit));
        return rendered.length <= limit ? rendered : `${boundRaw(rendered, limit)}… (${value.length} characters)`;
    }
    const rendered = describe(value);
    return rendered.length <= limit ? rendered : `${boundRaw(rendered, limit)}… (${rendered.length} characters)`;
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