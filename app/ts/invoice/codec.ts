/**
 * The versioned, self-describing share container.
 *
 * An invoice is UTF-8 JSON — canonically serialized by {@link serializeInvoice} — carried in one of two container forms:
 *
 * ```text
 * base32 payload      <base32>          the bare container a link's fragment carries
 * base32 blob         pinv1b-<base32>   standalone, for pasting outside a URL
 * ```
 *
 * `base32` is RFC 4648 base32 without padding, upper case.
 * The blob prefix states its container version (`pinv1b-`) and encoding (the `b`), and the JSON states its schema version (`v: 1`) and kind (`t: "invoice"`), so both a future container change and a future schema change stay distinguishable.
 * The URL fragment that carries a payload is spelled one layer up, in `invoice/share.ts`: this module owns the container and never the route.
 *
 * Base32 is the sole encoding because its encode is a linear, uncapped pass over the bytes, so it scales with the invoice size and the 64 KiB cap below stands as the format's real limit; base58 was withdrawn precisely because its big-number conversion is quadratic and does not scale.
 * A `pinv1-` (base64url) blob is recognised as a blob and refused with a clear error naming the retired encoding, never decoded.
 *
 * The JSON is canonical — {@link serializeInvoice} writes it in a fixed key order with no whitespace, no absent optional field, text already composed to NFC and the optional icon's line endings normalized to LF with its surrounding whitespace trimmed, a byte-order mark at either end with it, and every number in its shortest exact spelling — and {@link decodeInvoice} refuses anything that is not byte-for-byte what this encoder writes, so a repeated key (the last one winning silently in `JSON.parse`) cannot hide inside a share string, and neither can an NFD spelling of the same visible text, an icon padded with whitespace or a byte-order mark at either end, nor a longer spelling of the same number.
 *
 * Either party's `email` key carries free-text contact info — an email address, a phone number, or a postal address — and it keeps that name however wide its value grows: widening a field adds no second spelling of it, so a payload a build wrote when the key held an email address alone still decodes and re-encodes byte for byte, and no schema version changes.
 *
 * The optional paid record is appended last, after the icon, and written only when the invoice carries one, so an unpaid invoice re-encodes byte for byte as it did before the field existed and the schema version stays 1.
 * The record is the transaction a payer reported and the day they recorded it, and nothing else: the format carries no provenance, so it can never say whether a hash came from a wallet or was typed by hand.
 * Its hash is written in the one case `invoice/paid.ts` stores, and the byte-for-byte comparison in {@link decodeInvoice} is what refuses a payload that spells it in another case, exactly as that comparison refuses another case of the payee address.
 * Not bumping the schema version has a consequence a maintainer needs: a paid payload is refused by every earlier build, because that build's closed-object check meets an unknown `paid` field and rejects the whole document, while the container still reads `pinv1b-` and the JSON still reads `v: 1`.
 * A paid link therefore does not open in a copy of this app built before the field existed, and nothing in the payload says why — a payer who reports that is holding a link one build reads and another cannot, which is the cost of adding the field without a version bump.
 *
 * Money is transported as a decimal string of the asset's own units — `"150.00"`, never a JSON number and never base units — so every value round-trips exactly and a reader can convert it with `toBaseUnits` alone.
 * {@link decodeInvoice} derives the totals; they are never transported.
 *
 * Compressed share strings are deliberately not offered: this codec never runs a compressor, and the only vendored codecs are the two crypto/encoding packages.
 * The vendored pdf-lib bundle does embed pako's deflate/inflate, but only for the PDF streams it writes itself, and pulling a compressor into the share container for a few kilobytes of invoice text is not worth the supply chain.
 *
 * Very large invoices are refused outright rather than truncated, and the bound an encode applies depends on what the invoice records: a decode is always held to {@link MAX_JSON_BYTES}, and so is an encode of a paid invoice, while an invoice with no paid record must also leave free the room the widest one needs, {@link MAX_AUTHORING_JSON_BYTES}.
 * The asymmetry is the invariant: every unpaid payload this module writes can take the widest payment record and still be written again, so a payee's link always has room for the payment the payer reports.
 * It lives in {@link encodePayload}, the one function that writes a payload, so every path that hands an invoice out is guarded rather than only the create form's own.
 * What it costs is stated where it bites: an unpaid payload an older copy wrote between the two figures still decodes, renders, and is displayed, but cannot be encoded again — so it cannot be passed on, which is the point, since handing it on would give the payer a link no payment can be recorded against.
 * {@link paidEncodingSize} is the verdict the mark-as-paid path asks before it appends a record, and {@link requirePaidEncodingSize} turns it into the typed refusal {@link encodePayload} would raise.
 */

import { base32nopad, utf8 } from "../util/encoding.js";
import { boundMessage, describe, messageOf, preview } from "../util/errors.js";
import { canonicalContactText } from "./contact-canonical-text.js";
import { validateInvoice, type Invoice } from "./model.js";
import { WIDEST_PAID_RECORD, type PaidRecord } from "./paid.js";

/** The container version written into every blob prefix. */
export const SHARE_VERSION = 1;

/**
 * The most JSON a share container may carry, on both sides of the codec: every decode is held to it, and so is every encode, whatever the invoice records.
 *
 * One cap on both sides is what keeps a legacy link openable — a payload an older copy wrote at any size that copy could write still decodes and renders here — while the smaller figure a payee's new invoice must fit is not a second decode cap: it is {@link MAX_AUTHORING_JSON_BYTES}, applied by {@link encodePayload} to an invoice with no paid record so the payload it writes always has room for one.
 */
export const MAX_JSON_BYTES = 65536;

/**
 * The most characters a share payload may hold.
 * A payload is refused before it is decoded, so this is a coarse pre-decode guard rather than the format's size limit: no base32 encoding of {@link MAX_JSON_BYTES} bytes reaches it (base32 needs only a little over 1.6 characters per encoded byte), so the byte cap above is what actually bounds an invoice, and this twice-the-cap bound only rejects absurd input early.
 */
export const MAX_PAYLOAD_CHARS = 2 * MAX_JSON_BYTES;

const BLOB_PREFIX_PATTERN = /^pinv(\d+)(b?)-/;

/**
 * The most of a wrapped codec message a user-facing refusal carries.
 *
 * {@link decodePayload} passes a caught `JSON.parse`, `TextDecoder` or scure-base error through verbatim.
 * Those messages are believed bounded today, but only by engine-specific truncation that no spec guarantees, at a boundary that reads attacker-controlled bytes — so this module bounds them itself rather than relying on that behavior.
 * The bound leaves every message these libraries build from a legitimate payload intact — each is far under it — while keeping a hostile one far inside the notice's own limit (`util/errors.ts`, `app/shell.ts`).
 */
const WRAPPED_MESSAGE_MAX = 200;

/** Raised when a share container is malformed: not a string, empty, wrongly prefixed, not base32, not well-formed UTF-8, or not the canonical JSON this encoder writes. */
export class ShareFormatError extends Error {
	constructor(reason: string) {
		super(`share: ${reason}`);
		this.name = "ShareFormatError";
	}
}

/** Raised when a blob prefix names a container version other than {@link SHARE_VERSION}. */
export class UnsupportedShareVersionError extends Error {
	constructor(version: number) {
		super(`share: unsupported blob version ${version} — this build reads version ${SHARE_VERSION}`);
		this.name = "UnsupportedShareVersionError";
	}
}

/**
 * Raised by {@link encodePayload} for an unpaid invoice whose canonical JSON outgrows the budget a new invoice may use, {@link MAX_AUTHORING_JSON_BYTES}.
 *
 * It is a size refusal and not a field refusal: the invoice is valid, and what to change is content the payee controls, which is what the sentence names.
 * The class matters because the payee's form classifies the refusal by it — a form that had to measure the invoice itself to know this was a budget refusal would leave the rule to each surface, and a surface added later would be free to skip it.
 */
export class AuthoringSizeError extends Error {
	/** The bytes the invoice's canonical JSON needs. */
	readonly bytes: number;
	/** The authoring budget it missed. */
	readonly limit: number;

	constructor(bytes: number) {
		super(authoringTooLargeMessage(bytes));
		this.name = "AuthoringSizeError";
		this.bytes = bytes;
		this.limit = MAX_AUTHORING_JSON_BYTES;
	}
}

/**
 * Raised by {@link encodePayload} and {@link requirePaidEncodingSize} for a paid invoice whose canonical JSON outgrows the one wire cap, {@link MAX_JSON_BYTES}.
 *
 * It lives here rather than beside `markPaid` because it is a fact about the encoding and not about the invoice: `markPaid` records a payment without knowing what a payload may weigh, and this is the refusal the layer that owns the cap raises for a document it cannot write.
 * The sentence it carries is {@link paidTooLargeMessage}'s, the same one the {@link paidEncodingSize} verdict reports, so the payer reads one sentence whichever path asked.
 */
export class PaidInvoiceTooLargeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PaidInvoiceTooLargeError";
	}
}

/**
 * The blob prefix for the container version, e.g. `"pinv1b-"`.
 *
 * Only {@link SHARE_VERSION} can be encoded: a prefix for any other version is one this build cannot read back, so building it is refused with the same {@link UnsupportedShareVersionError} the decoder raises for a foreign version.
 */
export function blobPrefix(version: number = SHARE_VERSION): string {
	if (version !== SHARE_VERSION) {
		throw new UnsupportedShareVersionError(version);
	}
	return `pinv${version}b-`;
}

/**
 * The vendored `utf8` codec follows its library's orientation — `decode` turns text into bytes and `encode` turns bytes into text — which reads backwards for JSON, hence these two names.
 * It decodes strictly, so a payload that is not well-formed UTF-8 is refused rather than silently repaired.
 */
function jsonToBytes(text: string): Uint8Array {
	return utf8.decode(text);
}

function bytesToJson(bytes: Uint8Array): string {
	return utf8.encode(bytes);
}

/**
 * The JSON value {@link serializeInvoice} writes for a paid record.
 *
 * This is the serializer's one statement of the record's wire spelling — its two field names and their order — so the reserve below is measured through the value the serializer writes rather than from a second statement of the record's syntax.
 */
function paidWireValue(record: PaidRecord): { readonly hash: string; readonly date: string } {
	return { hash: record.hash, date: record.date };
}

/**
 * The canonical JSON text of a validated invoice: fixed key order, no whitespace, absent optional fields omitted.
 * This is the wire form; changing it changes the format, so it is pinned by a test.
 * Items and the tax carry the canonical numeric spellings {@link validateInvoice} stored, so this emits exactly the one encoding the decoder accepts.
 * A party's contact info is written under `email` on both parties — the name the field has always carried on the wire, whatever shape its value takes — so the field widening to free text moves no byte of a payload that existed before it.
 * The optional icon is written after `notes`, and carries the trimmed, NFC-composed text {@link validateInvoice} stored, so an icon is transported verbatim and an icon-less invoice keeps the payload it had before the field existed.
 * The optional paid record is written last, after the icon, in the record's canonical case, so an invoice that records no payment keeps its payload byte for byte and a field added after it appends rather than moving a byte of what came before.
 */
export function serializeInvoice(invoice: Invoice): string {
	return JSON.stringify({
		v: invoice.v,
		t: invoice.t,
		id: invoice.id,
		issued: invoice.issued,
		...(invoice.due === undefined ? {} : { due: invoice.due }),
		payee: {
			name: invoice.payee.name,
			address: invoice.payee.address,
			...(invoice.payee.email === undefined ? {} : { email: invoice.payee.email }),
			...(invoice.payee.notes === undefined ? {} : { notes: invoice.payee.notes }),
		},
		...(invoice.payer === undefined ? {} : { payer: { name: invoice.payer.name, ...(invoice.payer.email === undefined ? {} : { email: invoice.payer.email }) } }),
		chainId: invoice.chainId,
		asset: invoice.asset,
		items: invoice.items.map((item) => ({
			description: item.description,
			quantity: item.quantity,
			unitPrice: item.unitPrice,
		})),
		...(invoice.tax === undefined ? {} : { tax: { label: invoice.tax.label, rate: invoice.tax.rate } }),
		...(invoice.notes === undefined ? {} : { notes: invoice.notes }),
		...(invoice.icon === undefined ? {} : { icon: invoice.icon }),
		...(invoice.paid === undefined ? {} : { paid: paidWireValue(invoice.paid) }),
	});
}

/**
 * The most bytes a paid record adds to an invoice's canonical JSON: the delta {@link serializeInvoice} writes for the widest record the format admits, {@link WIDEST_PAID_RECORD}.
 *
 * The record is written last, after every other field of the serializer's object, so appending it to any invoice adds one comma, the field's name, and the record's own JSON — the same bytes whatever the invoice carries.
 * Measuring that append on a one-field probe, through the serializer's own value function and its own `JSON.stringify`, is what derives the figure from the serializer: a field renamed, reordered, or respelled there moves this figure with it, and no module outside codec states the syntax.
 */
const PAID_RECORD_RESERVE_BYTES = paidRecordReserveBytes();

function paidRecordReserveBytes(): number {
	const probe = { v: SHARE_VERSION };
	const withoutRecord = jsonToBytes(JSON.stringify(probe)).length;
	const withRecord = jsonToBytes(JSON.stringify({ ...probe, paid: paidWireValue(WIDEST_PAID_RECORD) })).length;
	return withRecord - withoutRecord;
}

/**
 * The size invariant, and the most JSON a payee may put into a new invoice: {@link MAX_JSON_BYTES} less the room the widest paid record needs, so that
 *
 *     MAX_AUTHORING_JSON_BYTES + PAID_RECORD_RESERVE_BYTES === MAX_JSON_BYTES
 *
 * holds by construction rather than by recollection, and every invoice a payee creates can still be marked paid and still encode.
 * Both terms are derived above: the cap is the format's one figure, and the reserve is measured from this module's own serializer for the widest record `invoice/paid.ts` states.
 *
 * {@link encodePayload} applies it to every invoice that records no payment, so the invariant holds for whatever surface authored the invoice.
 * It is not a decode bound and not a bound on a paid invoice: a payload an older copy wrote between this figure and {@link MAX_JSON_BYTES} still decodes and renders, while encoding it again — which is what passing it on would mean — is refused, because the invoice it states could never carry a payment.
 */
export const MAX_AUTHORING_JSON_BYTES = MAX_JSON_BYTES - PAID_RECORD_RESERVE_BYTES;

/**
 * The codec's size verdict on one invoice: the bytes its canonical JSON needs, the cap that applies where the caller stands, and — when it does not fit — the sentence the person holding the invoice can act on.
 *
 * A verdict rather than a pair of figures is what keeps the cap in this module: a caller asks whether its invoice fits and what to do about it, and never measures the invoice and combines the result with a cap of its own.
 */
export type SizeVerdict =
	| { readonly fits: true; readonly bytes: number; readonly limit: number }
	| { readonly fits: false; readonly bytes: number; readonly limit: number; readonly message: string };

/**
 * The one statement of the remedy a payee reads when an invoice exceeds the authoring budget: remove content the payee controls, then try again.
 *
 * The create form's live hint and the sentence {@link AuthoringSizeError} carries both read this clause, so changing the advice means changing one statement rather than two.
 */
export const AUTHORING_SIZE_REMEDY = "Remove part of the content — the optional icon is the largest field, and line descriptions and notes come next — then try again.";

/** The sentence a payee reads when an unpaid invoice outgrows {@link MAX_AUTHORING_JSON_BYTES}: one statement for the verdict, the refusal class, and the encoder. */
function authoringTooLargeMessage(bytes: number): string {
	return `The invoice is too large to share: its encoded form needs ${bytes} bytes of JSON, past the ${MAX_AUTHORING_JSON_BYTES} bytes a new invoice may use — the difference is the room the recipient's payment record needs. ${AUTHORING_SIZE_REMEDY}`;
}

/**
 * The sentence a payer reads when a payment cannot be appended inside the one wire cap: one statement for the {@link paidEncodingSize} verdict, {@link requirePaidEncodingSize}, and {@link encodePayload}.
 *
 * It names who can act — the payee, by sending a smaller invoice — because nothing the payer changes makes the record fit.
 */
function paidTooLargeMessage(bytes: number): string {
	return `This invoice is too large to record a payment against: with the payment added, its encoded form needs ${bytes} bytes of JSON, past the ${MAX_JSON_BYTES}-byte share limit. Ask the payee for a smaller invoice — one with a shorter icon, fewer line items, or shorter descriptions — and pay that one.`;
}

/**
 * The verdict on an invoice a payee is authoring: {@link MAX_AUTHORING_JSON_BYTES}, the encode cap less the room the widest paid record needs.
 *
 * The figure is smaller than the encode cap on purpose: the payee's link is the payload the payer appends a paid record to, so the room that record needs must be free before the payee sends the invoice.
 * {@link encodePayload} applies it to an unpaid invoice, and this function is what a surface asks to measure one before it tries — the create form's live hint reads it while the payee edits, so the warning arrives before the submit that would refuse.
 */
export function authoringSize(invoice: Invoice): SizeVerdict {
	const bytes = jsonToBytes(serializeInvoice(invoice)).length;
	if (bytes <= MAX_AUTHORING_JSON_BYTES) {
		return { fits: true, bytes, limit: MAX_AUTHORING_JSON_BYTES };
	}
	return {
		fits: false,
		bytes,
		limit: MAX_AUTHORING_JSON_BYTES,
		message: authoringTooLargeMessage(bytes),
	};
}

/**
 * The verdict on adding `record` to `invoice`: whether the invoice with the payment appended fits the one wire cap every decode and encode is held to.
 *
 * The figure is the encode cap's own, not the authoring budget's: an invoice that already exists is never judged by the smaller figure a payee's new invoice must fit, because judging it there would refuse to mark paid a link an older copy wrote that still opens.
 * The verdict measures the invoice the caller holds plus the record, through the same serializer {@link encodePayload} writes with, so the verdict and the encode cannot disagree about the bytes.
 * {@link requirePaidEncodingSize} is the one place that turns it into {@link PaidInvoiceTooLargeError}, and {@link encodePayload} raises the same class with the same sentence for a paid invoice over the cap, so every path states one refusal rather than two.
 *
 * The record's own validity is `invoice/paid.ts`'s and `markPaid`'s to refuse, so this seam answers the size question alone and never throws: a caller may ask it before it has validated anything, and gets a verdict rather than an exception.
 * A record whose hash is not the string this module writes would make the serializer's own JSON differ from the record's fields, so the size is measured on the value the serializer writes; a record the model refused never reaches here.
 */
export function paidEncodingSize(invoice: Invoice, record: PaidRecord): SizeVerdict {
	const bytes = jsonToBytes(serializeInvoice({ ...invoice, paid: record })).length;
	if (bytes <= MAX_JSON_BYTES) {
		return { fits: true, bytes, limit: MAX_JSON_BYTES };
	}
	return {
		fits: false,
		bytes,
		limit: MAX_JSON_BYTES,
		message: paidTooLargeMessage(bytes),
	};
}

/**
 * Refuse a payment the one wire cap cannot hold, with the sentence the payer can act on.
 *
 * The egress that builds a paid link calls this before it records the payment, so the refusal arrives as the typed error the dialog and the panel report rather than as a half-built link or an unrelated failure; {@link encodePayload} raises the same class and the same sentence for any path that skips this check.
 */
export function requirePaidEncodingSize(invoice: Invoice, record: PaidRecord): void {
	const verdict = paidEncodingSize(invoice, record);
	if (!verdict.fits) {
		throw new PaidInvoiceTooLargeError(verdict.message);
	}
}

/**
 * Encode a validated invoice as the bare base32 payload a fragment carries.
 *
 * The bound depends on what the invoice records. An invoice with no paid record is held to {@link MAX_AUTHORING_JSON_BYTES}, the encode cap less the room the widest paid record needs, so the payload this writes always has room for the payment the payer will report; that is the invariant, applied here rather than by each surface that hands an invoice out, so no authoring path can produce a link no payment can be recorded against.
 * An invoice that already carries a record is held to the one wire cap, {@link MAX_JSON_BYTES}, because the record is already part of the payload and there is no later append to leave room for.
 * The asymmetry follows from the two questions being different: a decode answers whether a link can be read, and stays generous so an older copy's link opens; an encode of an unpaid invoice answers whether the link can be paid, and refuses when it cannot.
 * The cost is deliberate and is stated in the module doc — a legacy unpaid payload between the two figures decodes but cannot be encoded again.
 * Refused outright rather than truncated, so no share string ever states a smaller invoice than the one the payee wrote.
 */
export function encodePayload(invoice: Invoice): string {
	const bytes = jsonToBytes(serializeInvoice(invoice));
	if (invoice.paid === undefined) {
		if (bytes.length > MAX_AUTHORING_JSON_BYTES) {
			throw new AuthoringSizeError(bytes.length);
		}
	} else if (bytes.length > MAX_JSON_BYTES) {
		throw new PaidInvoiceTooLargeError(paidTooLargeMessage(bytes.length));
	}
	return base32nopad.encode(bytes);
}

/**
 * Decode the bare base32 payload of a fragment into an invoice.
 *
 * Every failure is a `ShareFormatError` (the container is broken), an `InvalidInvoiceError` (the JSON is well-formed but is not a valid invoice), or an `UnsupportedInvoiceVersionError` (the JSON names a schema version this build does not read); a payload that is valid JSON in a shape this encoder would never write is refused as non-canonical.
 * Accepts any value: a payload that is not a string is refused with a `ShareFormatError`.
 */
export function decodeInvoice(payload: unknown): Invoice {
	if (typeof payload !== "string") {
		throw new ShareFormatError(`expected a payload string, got ${preview(payload)}`);
	}
	return decodePayload(payload);
}

/** Encode an invoice as a standalone base32 blob, prefixed with its version and encoding. */
export function encodeInvoiceBlob(invoice: Invoice): string {
	return blobPrefix() + encodePayload(invoice);
}

/** True when `text` begins with a blob prefix (`pinv<version>-` or `pinv<version>b-`). */
export function isShareBlob(text: string): boolean {
	return BLOB_PREFIX_PATTERN.test(text);
}

/**
 * The base32 payload a blob carries, past its version-and-encoding prefix, or `null` when `blob` carries no prefix this module recognises.
 *
 * This is the container's own answer to "what payload does this string state", so a surface that re-spells a blob as the fragment route carries the payload it arrived as rather than encoding the invoice again.
 * A payload an older copy wrote between the authoring budget and the encode cap is read here and refused by {@link encodePayload}, so re-encoding it to hand it on would fail; reusing its own payload is what still lets the invoice be opened and read.
 */
export function blobPayload(blob: string): string | null {
	const match = BLOB_PREFIX_PATTERN.exec(blob);
	return match === null ? null : blob.slice(match[0].length);
}

/**
 * Decode a standalone base32 blob.
 *
 * Accepts any value: one that is not a string, or that carries no blob prefix, is refused with {@link blobRefusal}'s `ShareFormatError`; one whose prefix names a version other than {@link SHARE_VERSION} is refused with an `UnsupportedShareVersionError`; and one whose prefix omits the base32 `b` carries the retired base64url encoding and is refused with a `ShareFormatError` naming it, never decoded.
 * The payload past the prefix fails exactly as {@link decodeInvoice} fails.
 */
export function decodeInvoiceBlob(blob: unknown): Invoice {
	if (typeof blob !== "string") {
		throw blobRefusal(blob);
	}
	const match = BLOB_PREFIX_PATTERN.exec(blob);
	if (match === null) {
		throw blobRefusal(blob);
	}
	const version = Number(match[1]);
	if (version !== SHARE_VERSION) {
		throw new UnsupportedShareVersionError(version);
	}
	if (match[2] !== "b") {
		throw new ShareFormatError(`the ${describe(match[0])} blob carries the retired base64url encoding — this build shares base32 blobs only (pinv1b-)`);
	}
	return decodePayload(blob.slice(match[0].length));
}

/** The refusal for a value that is not a string or carries no blob prefix. */
function blobRefusal(value: unknown): ShareFormatError {
	return new ShareFormatError(`expected a share blob starting with ${describe(blobPrefix())}, got ${preview(value)}`);
}

function decodePayload(payload: string): Invoice {
	if (payload.length === 0) {
		throw new ShareFormatError("the base32 payload is empty");
	}
	if (payload.length > MAX_PAYLOAD_CHARS) {
		throw new ShareFormatError(`the payload is ${payload.length} characters — the limit is ${MAX_PAYLOAD_CHARS}, which no invoice can exceed`);
	}
	let bytes: Uint8Array;
	try {
		bytes = base32nopad.decode(payload);
	} catch (error) {
		throw new ShareFormatError(`the base32 payload is malformed: ${boundMessage(messageOf(error), WRAPPED_MESSAGE_MAX)}`);
	}
	// The decode bound is the one wire cap, and it is deliberately not the encoder's authoring budget: a link an older copy wrote between the two figures still opens and renders here, and only writing it again is refused.
	if (bytes.length > MAX_JSON_BYTES) {
		throw new ShareFormatError(`the payload is ${bytes.length} bytes of JSON — the share limit is ${MAX_JSON_BYTES}; trim free text or split the invoice`);
	}
	let json: string;
	try {
		json = bytesToJson(bytes);
	} catch (error) {
		throw new ShareFormatError(`the payload is not well-formed UTF-8: ${boundMessage(messageOf(error), WRAPPED_MESSAGE_MAX)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (error) {
		throw new ShareFormatError(`the payload is not JSON: ${boundMessage(messageOf(error), WRAPPED_MESSAGE_MAX)}`);
	}
	// This byte-for-byte comparison, not `validateInvoice`, is what holds the wire format to one spelling per value: validation repairs the icon through the same canonicalization the encoder applies, lower-cases a paid record's hash, and runs a contact value through the same `canonicalContactText` the encoder wrote, so a payload whose icon, paid hash, or contact value is a second encoding of the same value parses into a valid invoice and the comparison is what refuses it.
	const invoice = validateInvoice(parsed);
	if (serializeInvoice(invoice) !== json) {
		throw new ShareFormatError(nonCanonicalReason(parsed, invoice));
	}
	return invoice;
}

/**
 * Why a payload that parsed into a valid invoice is still not the text this encoder writes.
 *
 * Validation re-encodes the payee address to the one canonical spelling its family stores it in — the EIP-55 checksummed form for an EVM payee, the lower-case Bech32 spelling for a Zcash one — so a payload that names a payable address in another case that spells the same address parses into a valid invoice yet is not the canonical text — naming that divergence is the point, because the generic message would otherwise blame a key order or a number the payload spelled correctly.
 * Validation also lower-cases the paid record's hash — the one stored spelling `invoice/paid.ts` states — so a payload that spells the same transaction in another case parses into a valid invoice and this comparison is what refuses it, with a reason naming that spelling.
 * Validation likewise repairs the icon with `util/icon-canonical-text.ts`'s `canonicalIconText`, the one definition of canonical icon text, so a payload that spells the icon with any fault that canonicalization repairs is one the model admits and this byte-for-byte comparison is what refuses.
 * It also runs a party contact value through the canonicalization `invoice/contact-canonical-text.ts` states — composing it to NFC, normalizing its line endings to LF, and replacing its tabs with single spaces — so a value spelled with an uncomposed character, with CRLF or a lone CR, or with a tab is another repair this comparison, and no other check, refuses.
 * That makes this comparison, not {@link validateInvoice}, the guard on the icon's single wire spelling: a decode path that validated a transported icon without it would admit a second encoding of one icon.
 * The reason below paraphrases that same rule, so a change to `canonicalIconText` has to update this reason rather than leave it naming a fault the canonicalization no longer covers.
 * Each repair a payload could be carrying — the address's case, the paid hash's case, the icon's text, and a contact value's line endings, composition, or tabs — gets a reason of its own, so the user is told the actual fault rather than a generic key order or number; every other divergence is the JSON spelling itself.
 */
function nonCanonicalReason(parsed: unknown, invoice: Invoice): string {
	const spelled = payeeAddressOf(parsed);
	if (spelled !== undefined && spelled !== invoice.payee.address && spelled.toLowerCase() === invoice.payee.address.toLowerCase()) {
		return `the payload spells the payee address ${spelled}, but its canonical spelling is ${invoice.payee.address}, the same address in the one case its family stores it in — the payload is not in the canonical form this encoder writes`;
	}
	const paidHash = paidHashOf(parsed);
	if (paidHash !== undefined && invoice.paid !== undefined && paidHash !== invoice.paid.hash && paidHash.toLowerCase() === invoice.paid.hash) {
		return `the payload spells the paid transaction hash ${paidHash}, but its canonical spelling is ${invoice.paid.hash}, the same hash in the one case this format stores it in — the payload is not in the canonical form this encoder writes`;
	}
	const icon = iconTextOf(parsed);
	if (icon !== undefined && icon !== invoice.icon) {
		return "the payload spells the icon with surrounding whitespace, a byte-order mark at either end, a CRLF or lone-CR line ending, or an uncomposed spelling, but the icon gate stores the line-ending-normalized, trimmed, NFC-composed text — the payload is not in the canonical form this encoder writes";
	}
	const contact = contactRepairOf(parsed, invoice);
	if (contact !== null) {
		return `the payload spells the ${contact} contact value with CRLF or a lone CR, or in an uncomposed spelling, or with a tab in place of a stored space, but a party's contact info is stored with its line endings normalized to LF, its tabs replaced with single spaces, and its text composed to NFC — the payload is not in the canonical form this encoder writes`;
	}
	return "the payload is not in the canonical form this encoder writes — it repeats a key, reorders keys, adds whitespace, or spells a number non-canonically";
}

/** The payee address as the parsed JSON spells it, or `undefined` when the shape does not carry one. */
function payeeAddressOf(parsed: unknown): string | undefined {
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const payee = (parsed as { payee?: unknown }).payee;
	if (typeof payee !== "object" || payee === null) return undefined;
	const address = (payee as { address?: unknown }).address;
	return typeof address === "string" ? address : undefined;
}

/** The paid record's hash as the parsed JSON spells it, or `undefined` when the shape does not carry one. */
function paidHashOf(parsed: unknown): string | undefined {
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const paid = (parsed as { paid?: unknown }).paid;
	if (typeof paid !== "object" || paid === null) return undefined;
	const hash = (paid as { hash?: unknown }).hash;
	return typeof hash === "string" ? hash : undefined;
}

/** The icon as the parsed JSON spells it, or `undefined` when the shape does not carry one. */
function iconTextOf(parsed: unknown): string | undefined {
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const icon = (parsed as { icon?: unknown }).icon;
	return typeof icon === "string" ? icon : undefined;
}

/**
 * The party whose contact value the payload spells as a repaired form of the stored one, or `null` when no party carries such a respelling.
 *
 * The repair is the canonicalization `invoice/contact-canonical-text.ts` states — the text composed to NFC, its CRLF or lone-CR line endings normalized to LF, and its tabs replaced with single spaces — read from that one statement rather than respelled here, so a change to the model cannot leave this reason naming a fault the model no longer covers while the decode still fails closed on the comparison above.
 */
function contactRepairOf(parsed: unknown, invoice: Invoice): string | null {
	for (const party of ["payee", "payer"] as const) {
		const spelled = partyEmailOf(parsed, party);
		const stored = party === "payee" ? invoice.payee.email : invoice.payer?.email;
		if (spelled !== undefined && stored !== undefined && spelled !== stored && canonicalContactText(spelled) === stored) {
			return party;
		}
	}
	return null;
}

/** The `email` value a party in the parsed JSON spells, or `undefined` when the shape does not carry one. */
function partyEmailOf(parsed: unknown, party: "payee" | "payer"): string | undefined {
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const record = (parsed as Record<string, unknown>)[party];
	if (typeof record !== "object" || record === null) return undefined;
	const email = (record as { email?: unknown }).email;
	return typeof email === "string" ? email : undefined;
}
export const encodeInvoice = encodePayload;
