/**
 * The one statement of the closed-object rule every invoice record keeps: a record holds exactly the fields its format names, and the refusal for a key it does not name echoes that key boundedly.
 *
 * Two validators read it and neither restates it — `invoice/model.ts` for the invoice and its parties, line items, and tax, and `invoice/paid.ts` for the paid record — so auditing "no unknown field is tolerated and every echo is bounded" means reading this rule once.
 * It lives in this leaf rather than in the model because the paid record is validated by a module the model imports, and a rule kept in the model would make that import a cycle: the same reason `invoice/calendar-date.ts` states the date rule here.
 *
 * The echo is bounded at one figure for every record, because an unknown key's length is limited only by the payload that carries it: unbounded, one hostile payload could stretch a refusal to its own size, and a figure that differed per record would make the two refusals incomparable.
 * The bound is applied to the key alone, so a caller composes its own field path around a part that is already bounded.
 */

import { boundMessage } from "../util/errors.js";

/**
 * The most characters of an unknown field's name a refusal echoes.
 *
 * Every field name this format writes is far shorter, so the bound is invisible to a legitimate refusal and only clips a key a payload invented.
 */
const UNKNOWN_FIELD_ECHO_MAX = 60;

/** An unknown field as a caller publishes it: the field a refusal names for the key the record spelled. */
export interface UnknownField {
	/** The field a refusal names: the key alone at the root, `parent.key` below it, the bounded echo of the key in either case. */
	readonly field: string;
}

/**
 * The sentence a refusal states for an unknown field: "is not a known field — expected one of …".
 *
 * Both validators that read {@link unknownFieldOf} use this, so the wording is edited in one place rather than restated in each consumer.
 */
export function unknownFieldReason(allowed: readonly string[]): string {
	return `is not a known field — expected one of ${allowed.join(", ")}`;
}

/**
 * The first key `record` carries that `allowed` does not name, or `null` when the record is closed.
 *
 * `parent` is the path of the object the record sits under — empty at the root — so a caller publishes the unknown key under the path it was found at.
 * The keys are read in the order the record holds them, so a payload with two unknown keys always earns the same refusal.
 */
export function unknownFieldOf(record: Record<string, unknown>, allowed: readonly string[], parent = ""): UnknownField | null {
	for (const key of Object.keys(record)) {
		if (allowed.includes(key)) continue;
		const echo = boundMessage(key, UNKNOWN_FIELD_ECHO_MAX);
		return { field: parent === "" ? echo : `${parent}.${echo}` };
	}
	return null;
}
