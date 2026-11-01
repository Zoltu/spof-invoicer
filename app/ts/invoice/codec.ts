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
 * Money is transported as a decimal string of the asset's own units — `"150.00"`, never a JSON number and never base units — so every value survives the round trip exactly and a reader can convert it with `toBaseUnits` alone.
 * {@link decodeInvoice} derives the totals; they are never transported.
 *
 * Compressed share strings are deliberately not offered: this codec never runs a compressor, and the only vendored codecs are the two crypto/encoding packages.
 * The vendored pdf-lib bundle does embed pako's deflate/inflate, but only for the PDF streams it writes itself, and pulling a compressor into the share container for a few kilobytes of invoice text is not worth the supply chain.
 *
 * Very large invoices are refused outright rather than truncated, at one cap on both sides of the codec: {@link MAX_JSON_BYTES} bounds every decode and every encode, so any payload this build decodes it can also encode again and pass on.
 * That symmetry is what keeps the size a build an older copy wrote still openable, which is why the smaller figure a payee's new invoice must fit is not a second encode cap: {@link MAX_AUTHORING_JSON_BYTES} is the cap less the room the widest paid record needs, and only the paths that author an invoice apply it, through the verdict {@link authoringSize} returns.
 * Encode and decode share one cap; the reduced budget applies only where an invoice is authored.
 * The record is appended to a payload the payee's link already carries, so the bytes it needs have to be free before the payee sends the invoice; {@link paidEncodingSize} is the verdict the mark-as-paid path asks before it writes one.
 */

import { base32nopad, utf8 } from "../util/encoding.js";
import { boundMessage, describe, messageOf, preview } from "../util/errors.js";
import { canonicalContactText } from "./contact-canonical-text.js";
import { InvalidInvoiceError, PaidInvoiceTooLargeError, validateInvoice, type Invoice } from "./model.js";
import { WIDEST_PAID_RECORD, type PaidRecord } from "./paid.js";

/** The container version written into every blob prefix. */
export const SHARE_VERSION = 1;

/**
 * The most JSON a share container may carry, on both sides of the codec: every decode is held to it, and so is every encode, whatever the invoice records.
 *
 * Encode and decode share one cap; the reduced budget applies only where an invoice is authored.
 * One cap rather than two is what makes the codec symmetric — a payload this build decoded is one it can encode again — so a link an older copy wrote at any size that copy could write still opens, renders, and is passed on.
 * The smaller figure a payee's own new invoice must fit is not a second encode cap: it is {@link MAX_AUTHORING_JSON_BYTES}, and only the paths that author an invoice apply it.
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
 * This bounds an invoice being authored and never one that already exists: a payload an older copy wrote between this figure and {@link MAX_JSON_BYTES} decodes, renders, re-encodes, and is passed on, because the encoder applies the one cap above. Judging an existing invoice by this figure is the regression the separate verdict keeps out of the encode path.
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
 * The create form's live hint and the submit refusal both read this sentence, so changing the advice means changing one statement rather than two.
 */
export const AUTHORING_SIZE_REMEDY = "Remove part of the content — the optional icon is the largest field, and line descriptions and notes come next — then try again.";

/**
 * The verdict on an invoice a payee is authoring: {@link MAX_AUTHORING_JSON_BYTES}, the encode cap less the room the widest paid record needs.
 *
 * The figure is smaller than the encode cap on purpose: the payee's link is the payload the payer appends a paid record to, so the room that record needs must be free before the payee sends the invoice.
 * It bounds only an invoice being authored; {@link encodePayload} and {@link decodePayload} both keep the one wire cap, so an invoice that already exists — a payload an older copy wrote between this figure and the cap — still opens, renders, and re-encodes byte for byte.
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
		message: `The invoice is too large to share: its encoded form needs ${bytes} bytes of JSON, past the ${MAX_AUTHORING_JSON_BYTES} bytes a new invoice may use — the difference is the room the payer's payment record needs. ${AUTHORING_SIZE_REMEDY}`,
	};
}

/**
 * The verdict on adding `record` to `invoice`: whether the invoice with the payment appended fits the one wire cap every encode and decode is held to.
 *
 * The figure is the encode cap's own, not the authoring budget's: an invoice that already exists is never judged by the smaller figure a payee's new invoice must fit, because judging it there would refuse to mark paid a link an older copy wrote that still opens.
 * The verdict measures the invoice the caller holds plus the record, through the same serializer {@link encodePayload} writes with, so the verdict and the encode cannot disagree about the bytes.
 * {@link PaidInvoiceTooLargeError} is raised by the caller when the verdict does not fit, carrying this message, so the payer reads one sentence whatever path asked.
 * `markPaid` requires the verdict this returns as an argument, so the path cannot skip the seam.
 *
 * The record's own validity is `invoice/paid.ts`'s and `markPaid`'s to refuse, so this seam answers the size question alone and never throws: a caller may ask it before it has validated anything, and gets a verdict rather than an exception.
 * A record whose hash is not the string this module writes would make the serializer's own JSON differ from the record's fields, so the size is measured on the value the serializer writes; a record the model refused never reaches here.
 * {@link paidEncodingSize} and {@link encodePayload} both state it, so a caller that asks the verdict and a caller that encodes directly get the same actionable sentence.
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
		message: `This invoice is too large to record a payment against: with the payment added, its encoded form needs ${bytes} bytes of JSON, past the ${MAX_JSON_BYTES}-byte share limit. Ask the payee for a smaller invoice — one with a shorter icon, fewer line items, or shorter descriptions — and pay that one.`,
	};
}

/**
 * Encode a validated invoice as the bare base32 payload a fragment carries.
 *
 * The bytes are measured against the one wire cap, {@link MAX_JSON_BYTES}, which applies here whatever the invoice records: a paid invoice may use the full cap, because the record it carries is already part of the payload and there is no later append to leave room for. The smaller figure a payee's new invoice must fit is {@link MAX_AUTHORING_JSON_BYTES}, applied where the invoice is authored, not here.
 * Refused outright rather than truncated, so no share string ever states a smaller invoice than the one the payee wrote.
 */
export function encodePayload(invoice: Invoice): string {
	const bytes = jsonToBytes(serializeInvoice(invoice));
	if (bytes.length > MAX_JSON_BYTES) {
		throw new ShareFormatError(`the invoice needs ${bytes.length} bytes of JSON — the share limit is ${MAX_JSON_BYTES}; trim free text or split the invoice`);
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
	// The decode bound is the one wire cap, the same one the encoder applies, so every payload this build reads is one it can write again.
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
