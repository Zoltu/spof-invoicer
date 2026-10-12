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
 * The JSON is canonical — {@link serializeInvoice} writes it in a fixed key order with no whitespace, no absent optional field, text already composed to NFC, and every number in its shortest exact spelling — and {@link decodeInvoice} refuses anything that is not byte-for-byte what this encoder writes, so a repeated key (the last one winning silently in `JSON.parse`) cannot hide inside a share string, and neither can an NFD spelling of the same visible text nor a longer spelling of the same number.
 *
 * Money is transported as a decimal string of the asset's own units — `"150.00"`, never a JSON number and never base units — so every value survives the round trip exactly and a reader can convert it with `toBaseUnits` alone.
 * {@link decodeInvoice} derives the totals; they are never transported.
 *
 * Compressed share strings are deliberately not offered: this codec never runs a compressor, and the only vendored codecs are the two crypto/encoding packages.
 * The vendored pdf-lib bundle does embed pako's deflate/inflate, but only for the PDF streams it writes itself, and pulling a compressor into the share container for a few kilobytes of invoice text is not worth the supply chain.
 * Very large invoices are refused outright on both the encode and the decode side (see {@link MAX_JSON_BYTES}) rather than truncated, so any link this build decodes is one it can re-encode.
 */

import { base32nopad, utf8 } from "../util/encoding.js";
import { boundMessage, describe, messageOf, preview } from "../util/errors.js";
import { validateInvoice, type Invoice } from "./model.js";

/** The container version written into every blob prefix. */
export const SHARE_VERSION = 1;

/** The most JSON an invoice may encode to; past this the share string stops being shareable. */
export const MAX_JSON_BYTES = 65536;

/**
 * The most characters a share payload may hold.
 * A payload is refused before it is decoded, so this is a coarse pre-decode guard rather than the format's size limit: no base32 encoding of {@link MAX_JSON_BYTES} bytes reaches it (base32 needs only a little over 1.6 characters per encoded byte), so {@link MAX_JSON_BYTES} is what actually bounds an invoice — enforced on the decoded bytes by {@link decodeInvoice} exactly as {@link encodeInvoice} enforces it — and this twice-the-byte-cap bound only rejects absurd input early.
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
 * The canonical JSON text of a validated invoice: fixed key order, no whitespace, absent optional fields omitted.
 * This is the wire form; changing it changes the format, so it is pinned by a test.
 * Items and the tax carry the canonical numeric spellings {@link validateInvoice} stored, so this emits exactly the one encoding the decoder accepts.
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
	});
}

/**
 * The byte length of an invoice's canonical JSON, validated first.
 *
 * {@link encodePayload} enforces the share cap on exactly these bytes, so a caller that wants to warn before building a container — the create form does, while the payee is still editing — can measure the same figure without provoking the refusal {@link encodePayload} would throw.
 */
export function encodedJsonBytes(invoice: Invoice): number {
	return jsonToBytes(serializeInvoice(validateInvoice(invoice))).length;
}

/**
 * Encode an invoice as the bare base32 payload a link's fragment carries.
 *
 * The invoice is validated first, so only a well-formed invoice can reach a share string.
 */
export function encodeInvoice(invoice: Invoice): string {
	return encodePayload(invoice);
}

/** Validate, serialize, and base32-encode an invoice. */
function encodePayload(invoice: Invoice): string {
	const json = serializeInvoice(validateInvoice(invoice));
	const bytes = jsonToBytes(json);
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
	// The same byte bound the encoder applies, so a payload that reaches the JSON parse is one `encodeInvoice` could have written and can write again — the two envelopes are identical.
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
 * Every other divergence is the JSON spelling itself.
 */
function nonCanonicalReason(parsed: unknown, invoice: Invoice): string {
	const spelled = payeeAddressOf(parsed);
	if (spelled !== undefined && spelled !== invoice.payee.address && spelled.toLowerCase() === invoice.payee.address.toLowerCase()) {
		return `the payload spells the payee address ${spelled}, but its canonical spelling is ${invoice.payee.address}, the same address in the one case its family stores it in — the payload is not in the canonical form this encoder writes`;
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
