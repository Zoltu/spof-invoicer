/**
 * Dependency-free decimal ↔ integer conversion for token amounts.
 *
 * Amounts travel through the app as canonical decimal strings and only become BigInt base units at the boundary (validation, calldata, totals), so no float ever touches a monetary value.
 */
import { describe } from "./errors.js";
const AMOUNT_PATTERN = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/;
/** `2^256 - 1` has 78 decimal digits, so any longer whole part exceeds the uint256 range. */
const MAX_UINT256_DIGITS = 78;
/** The uint8 ceiling an on-chain `decimals()` can report; the asset registry validates against it. */
export const MAX_DECIMALS = 255;
/** The largest value a single uint256 base-unit amount can hold. */
export const UINT256_MAX = (1n << 256n) - 1n;
function assertDecimals(decimals) {
    if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
        throw new RangeError(`decimal: decimals must be an integer between 0 and ${MAX_DECIMALS}, got ${decimals}`);
    }
}
/**
 * Parse a human decimal amount into integer base units: `("1.5", 6)` → `1500000n`.
 *
 * Rejects anything a payer could not have meant: a non-canonical string (leading zeros, `.5`, `1.`, signs, exponents, whitespace), more fractional digits than the asset allows, amounts of zero or less, and amounts whose base units would not fit in the uint256 a single transfer carries.
 */
export function toBaseUnits(amount, decimals) {
    assertDecimals(decimals);
    if (typeof amount !== "string") {
        throw new TypeError(`decimal: amount must be a string, got ${describe(amount)}`);
    }
    const match = AMOUNT_PATTERN.exec(amount);
    if (match === null) {
        throw new TypeError(`decimal: ${describe(amount)} is not a plain decimal amount (digits, optional fractional part, no sign or exponent)`);
    }
    const fraction = match[1] ?? "";
    if (fraction.length > decimals) {
        throw new RangeError(`decimal: ${describe(amount)} has ${fraction.length} decimal places but the asset allows ${decimals}`);
    }
    const point = amount.indexOf(".");
    const whole = point === -1 ? amount : amount.slice(0, point);
    if (whole.length > MAX_UINT256_DIGITS) {
        // Cap the digit count before BigInt: an unbounded-length string would otherwise be converted wholesale, and 78 is already the most digits `2^256 - 1` can have.
        throw new RangeError(`decimal: ${describe(amount)} exceeds the uint256 base-unit maximum`);
    }
    const units = BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
    if (units === 0n) {
        throw new RangeError(`decimal: ${describe(amount)} is zero — amounts must be greater than zero`);
    }
    if (units > UINT256_MAX) {
        throw new RangeError(`decimal: ${describe(amount)} exceeds the uint256 base-unit maximum`);
    }
    return units;
}
/**
 * The number of fractional digits in a canonical plain decimal amount: `"1.5"` → `1`, `"7"` → `0`.
 *
 * Returns `null` when `value` is not a string or does not match the grammar {@link toBaseUnits} parses.
 * Exposing it here keeps that grammar in one place, so a caller that classifies an amount by its precision cannot drift from the parse it explains.
 */
export function fractionalDigits(value) {
    if (typeof value !== "string") {
        return null;
    }
    const match = AMOUNT_PATTERN.exec(value);
    return match === null ? null : (match[1]?.length ?? 0);
}
/**
 * The one canonical spelling of a plain decimal amount within a scale's precision: `("2.00", 6)` → `"2"`, `("1.500", 6)` → `"1.5"`.
 *
 * Trailing zeros carry no value, so without this one number has many equally valid spellings — and one invoice therefore has many byte-distinct share payloads, which breaks any later comparison or dedupe by payload equality.
 * A string that is not a plain decimal amount, or that carries more fractional digits than `decimals` (which {@link toBaseUnits} refuses anyway), is returned unchanged, so its refusal still reports exactly the text the caller wrote.
 */
export function canonicalAmount(value, decimals) {
    assertDecimals(decimals);
    const match = AMOUNT_PATTERN.exec(value);
    if (match === null || (match[1]?.length ?? 0) > decimals) {
        return value;
    }
    const point = value.indexOf(".");
    if (point === -1) {
        return value;
    }
    const fraction = value.slice(point + 1).replace(/0+$/, "");
    return fraction === "" ? value.slice(0, point) : `${value.slice(0, point)}.${fraction}`;
}
/**
 * Format integer base units as the shortest exact decimal string: `(1500000n, 6)` → `"1.5"`.
 *
 * Trailing fractional zeros are dropped.
 * This function formats any non-negative bigint, but {@link toBaseUnits} accepts only `0 < units <= 2^256 - 1`, so the round-trip `toBaseUnits(fromBaseUnits(units, d), d) === units` holds exactly for `0 < units <= UINT256_MAX`: `0n` formats as `"0"` but throws as zero on the way back, and anything above the uint256 cap formats too but throws as too large on the way back.
 */
export function fromBaseUnits(units, decimals) {
    assertDecimals(decimals);
    if (typeof units !== "bigint") {
        throw new TypeError(`decimal: units must be a bigint, got ${describe(units)}`);
    }
    if (units < 0n) {
        throw new RangeError(`decimal: units must not be negative, got ${units}`);
    }
    const scale = 10n ** BigInt(decimals);
    const whole = units / scale;
    const fraction = units % scale;
    if (fraction === 0n) {
        return whole.toString();
    }
    return `${whole}.${fraction.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}
//# sourceMappingURL=decimal.js.map