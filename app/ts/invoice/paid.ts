/**
 * The paid record: the transaction a payer reports for an invoice, and the day they recorded it, in the one spelling the invoice's own asset family stores that transaction in.
 *
 * The record holds exactly two fields, `hash` and `date`, and this module is deliberately blind to everything else about how a hash was learned: a hash a wallet captured and a hash a payer typed by hand are the same record, so the format carries no provenance flag, no amount, no chain, no asset, and no payer for either of them.
 * The day is the caller's own `today`, validated by the one calendar rule `invoice/calendar-date.ts` states; this module reads no clock, so a record is a value the caller can build in a test.
 *
 * The hash grammar follows the asset family the invoice is paid in, because the families do not name a transaction the same way: an EVM-family asset records the `0x`-prefixed 32-byte hash its chain reports, and a Zcash or Monero asset records the bare 32-byte transaction id, which carries no prefix at all.
 * The grammar is not `wallet/eip1193.ts`'s hash check: that check guards a wallet's *response* and admits nothing without a `0x` prefix, where a typed privacy-chain id is a legitimate record and no wallet is involved in the typed path.
 * It is stated once, in {@link HASH_GRAMMARS}, and three readers share it — {@link validatePaidRecord}, {@link paidHashForm} for the hint that names the accepted spelling, and the shape sentence a refusal carries — so a hint cannot offer a spelling this module refuses, and a refusal cannot name a spelling it accepts.
 *
 * Case is canonicalized rather than merely accepted: {@link validatePaidRecord} stores the hash lower-cased, so one transaction id has exactly one stored spelling, and `invoice/codec.ts`'s byte-for-byte comparison is what refuses a payload that spells it in another case.
 * That split is the payee address's: this module stores the canonical spelling, and the codec holds the wire format to it.
 *
 * {@link MAX_PAID_RECORD_JSON_BYTES} is how much an invoice's canonical JSON grows when a record is attached, and `invoice/codec.ts` subtracts it from its own size cap so that every invoice a payee creates still has room for the widest record a payer can add.
 */

import type { AssetFamily } from "../assets/registry.js";
import { boundMessage, preview } from "../util/errors.js";
import { CALENDAR_DATE_CHARS, InvalidCalendarDateError, requireCalendarDate } from "./calendar-date.js";

/**
 * One hash spelling an asset family records, as a hint and a refusal name it.
 *
 * The shape is the payout-address form's (`wallet/payout-forms.ts`) on purpose: both are data a payee-facing hint draws from the validator that decides whether a paste is accepted, and neither carries a validated value.
 */
export interface PaidHashForm {
	/** What the family calls the value, e.g. `transaction hash` or `transaction id`. */
	readonly name: string;
	/** The spellings a hash in this form leads with, in the order a hint lists them; empty for a family whose hash carries no prefix. */
	readonly prefixes: readonly string[];
	/** The characters every hash in this form occupies, prefix included. */
	readonly characters: number;
}

/**
 * A validated paid record: the transaction hash or id in its one stored spelling, and the day the payment was recorded.
 *
 * It carries nothing else on purpose. A payee reading the record learns what a payer reported and no more, and two ways of learning the same hash produce one record rather than two.
 */
export interface PaidRecord {
	/** The transaction hash or id, lower-cased: `0x` and 32 hex-encoded bytes for the EVM family, the same bytes bare for a privacy-chain one. */
	readonly hash: string;
	/** The day the payment was recorded, as a `YYYY-MM-DD` calendar date in the caller's own reckoning. */
	readonly date: string;
}

/** The bytes a transaction hash or id carries in every family: 32, the width of a Keccak-256 digest and of a Zcash or Monero transaction id. */
const HASH_BYTES = 32;

/** The characters those bytes occupy in hex. */
const HASH_HEX_DIGITS = HASH_BYTES * 2;

/** The characters an EVM transaction hash leads with, and a privacy-chain id does not. */
const EVM_HASH_PREFIX = "0x";

/**
 * The widest hash any family records: the EVM spelling, whose `0x` prefix sits in front of the same 32 hex-encoded bytes a privacy chain's id carries bare.
 *
 * `invoice/codec.ts`'s room for a paid record is derived from the widest record, so one figure covers every family's hash rather than each family reserving its own.
 */
export const MAX_PAID_HASH_CHARS = EVM_HASH_PREFIX.length + HASH_HEX_DIGITS;

/** The fields a paid record holds, in the order the canonical JSON writes them; the record is closed to every other field. */
const PAID_FIELDS = ["hash", "date"] as const;

/**
 * The most of an unknown field's name a refusal echoes.
 *
 * The name comes from the payload, whose keys the payload's own size bounds and nothing narrower, so a hostile one could otherwise stretch both this refusal and the field path a caller publishes it under.
 */
const UNKNOWN_FIELD_MAX = 60;

/**
 * The canonical JSON a paid record's field adds around its two values: the field's name and the punctuation, with the values themselves left out.
 *
 * The shape is `invoice/codec.ts`'s, which appends the field last as `,"paid":{"hash":"…","date":"…"}`, so a record written into that position grows a payload by the values' characters plus this syntax.
 */
const PAID_RECORD_JSON_SYNTAX = `,"paid":{"hash":"","date":""}`;

/**
 * The most bytes a paid record adds to an invoice's canonical JSON: the syntax above, the widest hash, and a stored date.
 *
 * The syntax is ASCII, so its length is its byte count, and every value the record can hold is ASCII too, so no escape lengthens a legitimate record past this figure.
 * `invoice/codec.ts` reserves exactly this many bytes on an invoice that records no payment, which is what makes "every invoice a payee can create can still be marked paid" arithmetic rather than hope.
 */
export const MAX_PAID_RECORD_JSON_BYTES = PAID_RECORD_JSON_SYNTAX.length + MAX_PAID_HASH_CHARS + CALENDAR_DATE_CHARS;

/** The hash grammar of one asset family: the spelling it stores, the check that spelling, and the shape a refusal names. */
interface HashGrammar {
	readonly form: PaidHashForm;
	readonly pattern: RegExp;
	/** The shape a refusal names, composed from {@link form} so the two cannot drift. */
	readonly shape: string;
}

/** The shape a refusal names for `form`: `a 0x-prefixed 64-hex-digit transaction hash`, or `a bare 64-hex-digit transaction id with no prefix`. */
function hashShape(form: PaidHashForm): string {
	const prefix = form.prefixes[0] ?? "";
	const digits = form.characters - prefix.length;
	return prefix === "" ? `a bare ${digits}-hex-digit ${form.name} with no prefix` : `a ${prefix}-prefixed ${digits}-hex-digit ${form.name}`;
}

/**
 * The grammar for one spelling: the form as frozen data, the pattern its prefixes and character count imply, and the shape a refusal names.
 *
 * A prefix is interpolated into the pattern literally, which holds while a prefix carries no regex metacharacter: the `0x` below and the bare family's empty string are both literal, so a future prefix with a metacharacter in it needs this line to escape it.
 */
function grammar(form: PaidHashForm): HashGrammar {
	const frozen = Object.freeze({ ...form, prefixes: Object.freeze([...form.prefixes]) });
	const prefix = frozen.prefixes[0] ?? "";
	const digits = frozen.characters - prefix.length;
	return Object.freeze({ form: frozen, pattern: new RegExp(`^${prefix}[0-9a-fA-F]{${digits}}$`), shape: hashShape(frozen) });
}

/**
 * The families' hash grammars, keyed by the family an invoice names.
 *
 * The two privacy families record the same bare 32-byte id, so they share one form: nothing about the record distinguishes them, and a Monero id and a Zcash id are spelled identically.
 * The map is exhaustive by type, so a family added to `assets/registry.ts` is a compile error here until it states the spelling its transactions carry.
 */
const BARE_HASH_GRAMMAR: HashGrammar = grammar({ name: "transaction id", prefixes: Object.freeze([]), characters: HASH_HEX_DIGITS });

const HASH_GRAMMARS: Record<AssetFamily, HashGrammar> = Object.freeze({
	evm: grammar({ name: "transaction hash", prefixes: Object.freeze([EVM_HASH_PREFIX]), characters: MAX_PAID_HASH_CHARS }),
	zcash: BARE_HASH_GRAMMAR,
	monero: BARE_HASH_GRAMMAR,
});

/**
 * Raised by {@link validatePaidRecord} for a value that is not a paid record: one that is not a JSON object, one carrying anything beside its two fields, or one whose hash or date is missing or malformed.
 *
 * It is this module's single failure channel, including for a value of the wrong type: a share payload can carry anything at this position, and one class is what tells a caller that the record is what to fix rather than the payload's shape.
 * `invoice/model.ts` wraps it under the invoice's `paid` path, keeping this error as the `cause`, and a surface that validates a typed hash reports the clause beside the field.
 */
export class InvalidPaidRecordError extends Error {
	/** The field the refusal is about — `hash`, `date`, or an unknown key — or the empty string when the record itself is at fault. */
	readonly field: string;

	/** The refusal clause alone, without this module's `invoice: paid.<field>: ` prefix, so a caller that publishes the record under its own path states the path once. */
	readonly reason: string;

	constructor(field: string, reason: string) {
		super(field === "" ? `invoice: paid: ${reason}` : `invoice: paid.${field}: ${reason}`);
		this.name = "InvalidPaidRecordError";
		this.field = field;
		this.reason = reason;
	}
}

/**
 * The hash spelling `family` records, as data a hint draws its wording from: the value's name, the prefixes it leads with (none for a family whose hash is bare), and the characters it occupies.
 *
 * Reading the same table {@link validatePaidRecord} checks against is what keeps a hint from naming a spelling this module refuses, or from leaving one out.
 */
export function paidHashForm(family: AssetFamily): PaidHashForm {
	return HASH_GRAMMARS[family].form;
}

/**
 * Validate `value` as a paid record for an invoice paid in `family`, returning the frozen record in its one stored spelling or raising an {@link InvalidPaidRecordError}.
 *
 * The family picks the hash grammar, so a hash of another family's shape is refused rather than stored: a `0x`-prefixed id is not a privacy-chain transaction, and a bare one is not an EVM hash a block explorer can look up.
 * Case is not a fault: a hash in any case is accepted and stored lower-cased, and the wire format's one spelling is `invoice/codec.ts`'s comparison rather than a refusal here.
 * The date is `invoice/calendar-date.ts`'s rule, read rather than restated, and its refusal is narrowed to that error so a caller can classify the clause as this record's `date` field.
 */
export function validatePaidRecord(value: unknown, family: AssetFamily): PaidRecord {
	const hashGrammar = HASH_GRAMMARS[family];
	const record = asRecord(value);
	assertKnownFields(record, PAID_FIELDS);
	return Object.freeze({
		hash: paidHash(record.hash, hashGrammar),
		date: paidDate(record.date),
	});
}

/** `value` as the record's own JSON object, or the refusal that says what arrived instead. */
function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new InvalidPaidRecordError("", `must be a JSON object holding a transaction hash and the date it was recorded, got ${preview(value)}`);
	}
	return value as Record<string, unknown>;
}

/** Refuse every key the two fields do not name, under that key's own field, so a caller publishing the path names the field the payload spelled. */
function assertKnownFields(record: Record<string, unknown>, fields: readonly string[]): void {
	for (const key of Object.keys(record)) {
		if (!fields.includes(key)) {
			const field = boundMessage(key, UNKNOWN_FIELD_MAX);
			throw new InvalidPaidRecordError(field, `is not a known field — expected one of ${PAID_FIELDS.join(", ")}`);
		}
	}
}

/**
 * The stored spelling of `value` in `hashGrammar`, or a refusal naming the shape that grammar takes.
 *
 * The value is lower-cased once it matches, so one transaction has one stored spelling however a wallet, a block explorer, or a paste spelled it.
 */
function paidHash(value: unknown, hashGrammar: HashGrammar): string {
	if (typeof value !== "string" || !hashGrammar.pattern.test(value)) {
		throw new InvalidPaidRecordError("hash", `must be ${hashGrammar.shape}, got ${preview(value)}`);
	}
	return value.toLowerCase();
}

/** The recorded day, through the calendar rule `invoice/calendar-date.ts` states, as this record's own `date` field. */
function paidDate(value: unknown): string {
	try {
		return requireCalendarDate(value);
	} catch (error) {
		if (!(error instanceof InvalidCalendarDateError)) {
			throw error;
		}
		throw new InvalidPaidRecordError("date", error.reason);
	}
}
