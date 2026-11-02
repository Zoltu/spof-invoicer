/**
 * The one statement of an invoice date: the `YYYY-MM-DD` spelling every stored date carries, and the calendar rules that spelling admits.
 *
 * Two callers read it and neither restates it: `invoice/model.ts` publishes a refused `issued` or `due` value under the field it read, and `invoice/paid.ts` under the day a payment was recorded, so one spelling cannot be a real date in one field and not in the other.
 * Its length is a fact of the pattern below: every stored date occupies the same characters, so the greatest day the spelling can state — the value `invoice/paid.ts` carries as its widest record — needs no more room than any other.
 * The rule lives here rather than in the model because the paid record is validated by a module the model imports, and a date rule kept in the model would make that import a cycle.
 *
 * A stored date is a calendar day as text, which orders identically to the calendar, so nothing here reads a clock, a locale, or a time zone: the caller supplies the day it already holds.
 * The day count admits the leap years the Gregorian rule gives every year the four-digit spelling can state, and no other day: a stored date is never the 30th of February.
 *
 * Every refusal echoes the rejected value through `util/errors.ts`'s `preview`, which bounds the echo and strips the characters a text node renders without showing: the value arrives from a share payload, so it can be arbitrarily long and can carry the C1 controls, the line and paragraph separators, and the bidi overrides `JSON.stringify` leaves as themselves.
 */

import { preview } from "../util/errors.js";

/** The digits a stored date's year occupies. */
const YEAR_DIGITS = 4;

/** The digits a stored date's month occupies. */
const MONTH_DIGITS = 2;

/** The digits a stored date's day occupies. */
const DAY_DIGITS = 2;

/** The character between a stored date's year, month, and day. */
const DATE_SEPARATOR = "-";

/** The one spelling of a stored date: four year digits, two month digits, two day digits, and the separator between them. */
const DATE_PATTERN = new RegExp(`^(\\d{${YEAR_DIGITS}})${DATE_SEPARATOR}(\\d{${MONTH_DIGITS}})${DATE_SEPARATOR}(\\d{${DAY_DIGITS}})$`);

/** The days each month of a common year holds, January first. February's 29th is added by the leap rule in {@link requireCalendarDate}. */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Raised by {@link requireCalendarDate} for a value that is not a stored date.
 *
 * The refusal carries its clause alone as {@link reason}, so a caller publishes the field it read the value from once, in its own words and under its own path; `message` states that clause under the `invoice:` namespace for a caller that lets the refusal escape unwrapped.
 */
export class InvalidCalendarDateError extends Error {
	/** The refusal clause alone, with no field path and no namespace, so a caller that names the field states it once. */
	readonly reason: string;

	constructor(reason: string) {
		super(`invoice: ${reason}`);
		this.name = "InvalidCalendarDateError";
		this.reason = reason;
	}
}

/**
 * `value` as a stored date, or an {@link InvalidCalendarDateError} saying why it is not one.
 *
 * The four-digit spelling is required rather than repaired, so `2026-1-03` is refused instead of being completed; the calendar checks then refuse a month outside 1 to 12 and a day past the end of its month, so `2026-02-30` is not a date this app stores.
 * The value is returned as it arrived: a match of the pattern above is already the one spelling, so there is nothing to canonicalize.
 */
export function requireCalendarDate(value: unknown): string {
	if (typeof value !== "string") {
		throw new InvalidCalendarDateError(`must be a YYYY-MM-DD date string, got ${preview(value)}`);
	}
	const match = DATE_PATTERN.exec(value);
	if (match === null) {
		throw new InvalidCalendarDateError(`must be a YYYY-MM-DD date string, got ${preview(value)}`);
	}
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (month < 1 || month > 12) {
		throw new InvalidCalendarDateError(`${preview(value)} is not a real calendar date`);
	}
	const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
	const longest = month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1];
	if (day < 1 || day > longest) {
		throw new InvalidCalendarDateError(`${preview(value)} is not a real calendar date`);
	}
	return value;
}
