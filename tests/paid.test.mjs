/** The suite for the paid record: the per-family transaction-hash grammar, the two-field record, and the bytes the record adds to an invoice. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ASSET_FAMILIES } from "../app/js/assets/registry.js";
import { InvalidCalendarDateError, requireCalendarDate } from "../app/js/invoice/calendar-date.js";
import {
	InvalidPaidRecordError,
	WIDEST_PAID_RECORD,
	paidHashForm,
	validatePaidRecord,
} from "../app/js/invoice/paid.js";
import { hashHint } from "../app/js/ui/mark-paid.js";
import { INVOICE_LABELS } from "../app/js/ui/presentation.js";

/** An EVM transaction hash: `0x` in front of 32 hex-encoded bytes. */
const EVM_HASH = `0x${"9f".repeat(32)}`;

/** The same hash spelled in upper case, which is the same transaction and not a second record. */
const EVM_HASH_UPPER = `0x${"9F".repeat(32)}`;

/** A privacy-chain transaction id: the same 32 bytes with no prefix. */
const BARE_HASH = "ab".repeat(32);

/** The same id spelled in upper case. */
const BARE_HASH_UPPER = "AB".repeat(32);

/** A recorded date, as the caller's own `today`. */
const DATE = "2026-10-05";

/** The families whose transactions are named by a bare id rather than a `0x` hash. */
const BARE_FAMILIES = ["zcash", "monero"];

/** Refuse `run` with an `errorType` and match `pattern` against its message; returns the refusal so a case can read the clause. */
function rejects(label, run, errorType, pattern) {
	let refusal = null;
	try {
		run();
	} catch (error) {
		refusal = error;
	}
	assert.ok(
		refusal instanceof errorType,
		`${label}: expected ${errorType.name}, got ${refusal?.name}: ${refusal?.message}`,
	);
	assert.match(refusal.message, pattern, label);
	return refusal;
}

test("each family's hash spelling is accepted and stored in the one lower-case form rather than preserving its case", () => {
	const evm = validatePaidRecord({ hash: EVM_HASH, date: DATE }, "evm");
	assert.deepEqual(evm, { hash: EVM_HASH, date: DATE }, "an EVM hash is stored as it arrived");
	assert.deepEqual(Object.keys(evm), ["hash", "date"], "the record holds the hash and the date and nothing else");
	assert.ok(Object.isFrozen(evm), "the record is frozen value data");
	assert.deepEqual(validatePaidRecord(evm, "evm"), evm, "validating a record again returns the same record");
	assert.equal(
		validatePaidRecord({ hash: EVM_HASH_UPPER, date: DATE }, "evm").hash,
		EVM_HASH,
		"an upper-case EVM hash is stored lower-cased, so one transaction has one spelling",
	);
	for (const family of BARE_FAMILIES) {
		assert.equal(validatePaidRecord({ hash: BARE_HASH, date: DATE }, family).hash, BARE_HASH, `${family}: a bare id is stored as it arrived`);
		assert.equal(
			validatePaidRecord({ hash: BARE_HASH_UPPER, date: DATE }, family).hash,
			BARE_HASH,
			`${family}: an upper-case bare id is stored lower-cased`,
		);
	}
});

test("a hash of the other family's spelling is refused rather than accepted, naming the shape the family takes", () => {
	rejects(
		"a bare id in an EVM invoice",
		() => validatePaidRecord({ hash: BARE_HASH, date: DATE }, "evm"),
		InvalidPaidRecordError,
		/must be a 0x-prefixed 64-hex-digit transaction hash, got "/,
	);
	for (const family of BARE_FAMILIES) {
		rejects(
			`a 0x hash in a ${family} invoice`,
			() => validatePaidRecord({ hash: EVM_HASH, date: DATE }, family),
			InvalidPaidRecordError,
			/must be a bare 64-hex-digit transaction id with no prefix, got "/,
		);
	}
	// The prefix is part of the grammar rather than a case of it, so a capital `0X` is not an EVM hash either.
	rejects(
		"a capital-X prefix",
		() => validatePaidRecord({ hash: `0X${"9f".repeat(32)}`, date: DATE }, "evm"),
		InvalidPaidRecordError,
		/must be a 0x-prefixed 64-hex-digit transaction hash/,
	);
});

test("a hash of the wrong length or with a non-hex character is refused rather than accepted, naming the family's shape", () => {
	const evmShape = /must be a 0x-prefixed 64-hex-digit transaction hash/;
	const bareShape = /must be a bare 64-hex-digit transaction id with no prefix/;
	for (const [label, hash] of [
		["63 hex digits", `0x${"9f".repeat(31)}9`],
		["65 hex digits", `0x${"9f".repeat(32)}9`],
		["67 hex digits", `0x${"9f".repeat(33)}9`],
		["a non-hex body", `0x${"zz".repeat(32)}`],
		["a hex body one character short of its prefix", `0x${"9f".repeat(32)}`.slice(0, -1)],
		["an empty string", ""],
	]) {
		rejects(`${label} in an EVM invoice`, () => validatePaidRecord({ hash, date: DATE }, "evm"), InvalidPaidRecordError, evmShape);
	}
	for (const [label, hash] of [
		["63 hex digits", "ab".repeat(31) + "a"],
		["65 hex digits", BARE_HASH + "a"],
		["67 hex digits", BARE_HASH + "abc"],
		["a non-hex body", "zz".repeat(32)],
		["a 0x prefix", `0x${BARE_HASH}`],
	]) {
		rejects(`${label} in a Zcash invoice`, () => validatePaidRecord({ hash, date: DATE }, "zcash"), InvalidPaidRecordError, bareShape);
	}
	// A value that is not text at all takes the same one channel, so a caller classifies every refusal by class.
	for (const value of [undefined, null, 42, {}, [EVM_HASH]]) {
		rejects(
			`a hash of ${JSON.stringify(value) ?? "undefined"}`,
			() => validatePaidRecord({ hash: value, date: DATE }, "evm"),
			InvalidPaidRecordError,
			/must be a 0x-prefixed 64-hex-digit transaction hash/,
		);
	}
});

test("the record holds exactly the hash and the recorded date rather than carrying provenance, amount, chain, asset, or payer", () => {
	rejects(
		"a provenance flag",
		() => validatePaidRecord({ hash: EVM_HASH, date: DATE, via: "wallet" }, "evm"),
		InvalidPaidRecordError,
		/is not a known field — expected one of hash, date/,
	);
	for (const field of ["amount", "chainId", "asset", "payer", "captured", "confirmed"]) {
		rejects(
			`a ${field} field`,
			() => validatePaidRecord({ hash: EVM_HASH, date: DATE, [field]: "x" }, "evm"),
			InvalidPaidRecordError,
			/is not a known field — expected one of hash, date/,
		);
	}
	rejects("a record with no date", () => validatePaidRecord({ hash: EVM_HASH }, "evm"), InvalidPaidRecordError, /must be a YYYY-MM-DD date string, got undefined/);
	rejects("a record with no hash", () => validatePaidRecord({ date: DATE }, "evm"), InvalidPaidRecordError, /must be a 0x-prefixed 64-hex-digit transaction hash, got undefined/);
	for (const value of [null, [], DATE, 42, true]) {
		rejects(
			`a record of ${JSON.stringify(value)}`,
			() => validatePaidRecord(value, "evm"),
			InvalidPaidRecordError,
			/must be a JSON object holding a transaction hash and the date it was recorded/,
		);
	}
	// The unknown field's name comes from the payload, so the refusal carries a bounded echo of it rather than the whole key.
	const longKey = "k".repeat(500);
	const refusal = rejects(
		"an over-long unknown field",
		() => validatePaidRecord({ hash: EVM_HASH, date: DATE, [longKey]: 1 }, "evm"),
		InvalidPaidRecordError,
		/is not a known field/,
	);
	assert.ok(refusal.message.length < 300, `the refusal stays readable, got ${refusal.message.length} characters`);
});

test("the recorded date is read by the one calendar rule the model's dates use rather than a second rule", () => {
	for (const [label, date, pattern] of [
		["the 30th of February", "2026-02-30", /is not a real calendar date/],
		["month thirteen", "2026-13-01", /is not a real calendar date/],
		["month zero", "2026-00-10", /is not a real calendar date/],
		["a day that does not exist", "2026-04-31", /is not a real calendar date/],
		["an unpadded month", "2026-1-05", /must be a YYYY-MM-DD date string/],
		["a timestamp", "2026-10-05T00:00:00Z", /must be a YYYY-MM-DD date string/],
	]) {
		rejects(`${label} as the recorded date`, () => validatePaidRecord({ hash: EVM_HASH, date }, "evm"), InvalidPaidRecordError, pattern);
	}
	rejects("a numeric date", () => validatePaidRecord({ hash: EVM_HASH, date: 20261005 }, "evm"), InvalidPaidRecordError, /must be a YYYY-MM-DD date string, got 20261005/);

	// The clause is the calendar rule's own, so the model's `issued` and `due` fields and this record cannot word the same fault two ways.
	let calendarRefusal = null;
	try {
		requireCalendarDate("2026-02-30");
	} catch (error) {
		calendarRefusal = error;
	}
	assert.ok(calendarRefusal instanceof InvalidCalendarDateError, "the calendar rule refuses a day its month does not have");
	const recordRefusal = rejects("the same day in a record", () => validatePaidRecord({ hash: EVM_HASH, date: "2026-02-30" }, "evm"), InvalidPaidRecordError, /is not a real calendar date/);
	assert.equal(recordRefusal.reason, calendarRefusal.reason, "the record publishes the calendar rule's clause unchanged");
	assert.equal(requireCalendarDate("2024-02-29"), "2024-02-29", "and a leap day is still a real date");
});

test("a refused day echoes the value bounded and stripped of the characters a message cannot show", () => {
	// The day arrives in a share payload, so it can be arbitrarily long and can carry the characters `JSON.stringify` leaves as themselves: the C1 block, the line and paragraph separators, and the bidi overrides a text node renders without showing. An unbounded echo would spend the notice on the paste and could reorder the clause around it.
	const hostile = `2026-10-03\u202E\u0085\u2028`;
	let refusal = null;
	try {
		requireCalendarDate(hostile);
	} catch (error) {
		refusal = error;
	}
	assert.ok(refusal instanceof InvalidCalendarDateError, "a day carrying a bidi override is refused");
	assert.doesNotMatch(refusal.message, /[\u202E\u0085\u2028]/, "no bidi override, C1 control, or line separator reaches the message");

	const overLong = "1".repeat(5000);
	let longRefusal = null;
	try {
		requireCalendarDate(overLong);
	} catch (error) {
		longRefusal = error;
	}
	assert.ok(longRefusal instanceof InvalidCalendarDateError, "a day far past the spelling's length is refused");
	assert.ok(longRefusal.message.length < 200, `the echo of an over-long date stays bounded, got ${longRefusal.message.length} characters`);
	assert.match(longRefusal.message, /\(5000 characters\)/, "and reports the value's full length, so the cut is stated rather than hidden");
});

test("a refused recorded day keeps the calendar rule's own error as its cause rather than a new error", () => {
	let refusal = null;
	try {
		validatePaidRecord({ hash: EVM_HASH, date: "2026-02-30" }, "evm");
	} catch (error) {
		refusal = error;
	}
	assert.ok(refusal instanceof InvalidPaidRecordError, "the record publishes the refusal under its date field");
	assert.equal(refusal.field, "date");
	assert.ok(refusal.cause instanceof InvalidCalendarDateError, "and keeps the calendar rule's error as the cause, so a dialog classifies the refusal by class instead of reading the clause");
	assert.equal(refusal.cause.reason, refusal.reason, "the clause is the calendar rule's own, unchanged");
	assert.equal(validatePaidRecord({ hash: EVM_HASH, date: DATE }, "evm").date, DATE, "while a real day is accepted");
});

test("the hash form is the data a hint draws and the grammar checks rather than two tables, for every family", () => {
	for (const family of Object.keys(ASSET_FAMILIES)) {
		const form = paidHashForm(family);
		assert.ok(form.name.length > 0, `${family}: the form names the value`);
		assert.ok(form.characters <= WIDEST_PAID_RECORD.hash.length, `${family}: no form is wider than the widest hash the record reserves room for`);
		const prefix = form.prefixes[0] ?? "";
		const hash = prefix + "0".repeat(form.characters - prefix.length);
		assert.equal(hash.length, form.characters, `${family}: the form's character count is the length its hashes have`);
		assert.equal(validatePaidRecord({ hash, date: DATE }, family).hash, hash, `${family}: a hash at the form's own character count is one the grammar accepts`);
	}
	assert.deepEqual(paidHashForm("evm").prefixes, ["0x"], "the EVM family spells its hash with a 0x prefix");
	assert.equal(paidHashForm("evm").characters, WIDEST_PAID_RECORD.hash.length, "and its spelling is the widest one recorded");
	for (const family of BARE_FAMILIES) {
		assert.deepEqual(paidHashForm(family).prefixes, [], `${family}: a bare id carries no prefix`);
	}
	// The app's own copy: the hint text and the section's terms, driven against the grammar so a guard that matches nothing cannot pass.
	for (const family of Object.keys(ASSET_FAMILIES)) {
		const form = paidHashForm(family);
		const hint = hashHint(family === "evm" ? "eth" : family === "zcash" ? "zec" : "xmr");
		assert.ok(hint.includes(form.name), `${family}: the hint names the grammar's value`);
		assert.ok(hint.includes(String(form.characters)), `${family}: the hint names the grammar's character count`);
		if (form.prefixes.length === 0) {
			assert.ok(hint.includes("no prefix"), `${family}: the hint states the bare id carries no prefix`);
		} else {
			for (const prefix of form.prefixes) {
				assert.ok(hint.includes(prefix), `${family}: the hint names the prefix ${prefix}`);
			}
		}
	}
	assert.ok(INVOICE_LABELS.paidHash.toLowerCase().includes("transaction"), "the section's hash label names the transaction");
	assert.ok(INVOICE_LABELS.paidDate.toLowerCase().includes("record"), "the section's date label names the recorded day");
});

test("the widest record is a value the hash grammar and the date rule both admit rather than rejecting", () => {
	// The bytes a record adds to a payload are `invoice/codec.ts`'s to measure from its own serializer, so this module states what the widest record holds and the codec measures what it costs.
	assert.deepEqual(Object.keys(WIDEST_PAID_RECORD), ["hash", "date"], "the widest record holds the hash and the date and nothing else");
	assert.ok(Object.isFrozen(WIDEST_PAID_RECORD), "and it is frozen value data");
	assert.equal(WIDEST_PAID_RECORD.hash.length, paidHashForm("evm").characters, "its hash is at the widest spelling any family records");
	assert.equal(validatePaidRecord(WIDEST_PAID_RECORD, "evm").hash, WIDEST_PAID_RECORD.hash, "the grammar accepts that hash as it stands");
	assert.equal(requireCalendarDate(WIDEST_PAID_RECORD.date), WIDEST_PAID_RECORD.date, "and its day is one the calendar rule accepts, at the only length a stored date has");
});
