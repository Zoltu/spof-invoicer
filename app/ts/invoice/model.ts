/**
 * The invoice model.
 *
 * An {@link Invoice} is the wire object and nothing more: an id, dates, the parties, the asset, the line items, an optional tax, an optional icon and free text.
 * Totals are never transported — {@link computeTotals} derives them from the invoice's own inputs, so a share string cannot smuggle in a total that disagrees with its own lines.
 * {@link validateInvoice} checks every field of an untrusted parsed object and fails closed with a field path; {@link createInvoice} is the same validation for an object built in memory.
 * The optional icon is the one field whose rules live outside this module: `invoice/icon.ts` bounds and canonicalizes it, and {@link validateInvoice} reads that gate's refusal under the `icon` path.
 * The icon is also the one field whose surrounding whitespace this validator repairs rather than refuses: the gate trims it, where {@link text} refuses any other field that starts or ends with whitespace.
 * That repair admits an icon whose stored text can differ from the spelling a payload carried, so this validator alone cannot hold the field to one wire spelling: the wire format's single-spelling guarantee for the icon rests one layer up, on `invoice/codec.ts`'s byte-for-byte comparison of the decoded JSON against the canonical text `serializeInvoice` writes — the boundary every decode path passes through.
 *
 * Text is normalized to Unicode NFC as it is validated, so one visible string has a single encoded form and an NFD spelling of a name is not a second, equally valid spelling of the same invoice.
 * Invisible and direction-formatting characters (zero-width spaces, bidi marks and overrides, the soft hyphen, the byte-order mark, and other default-ignorable formatting) are refused, a single-line field also refuses the Unicode line and paragraph separators, and the C1 control block is refused alongside the C0 controls, so a stored name or id cannot be made to render differently from how it reads.
 * A lone surrogate code unit is refused as malformed text: it is not a code point any renderer can show as the byte it is, and neither the NFC composition above nor the codec's canonical re-serialization rejects one, so this validator is the boundary that must.
 *
 * A party's `email` field carries a second accepted shape: the wire key keeps its name and now carries free-text contact info — an email address, a phone number, a postal address — which a single-line legacy email spelling of up to {@link MAX_EMAIL_CHARS} characters satisfies unchanged, so a share link written before the field widened still validates.
 * The text stored for a value that takes the free-text branch is the canonical contact text `invoice/contact-canonical-text.ts` states once — composed to NFC, its line endings LF, and a tab stored as the space it stood for — so the value the field holds and the spelling the payload carries are one text, and the page, the print twin, and the PDF draw that value rather than a stripped second spelling of it.
 * The legacy email branch is the one exception, and it exists because the recorded byte-for-byte legacy decision leaves its accepted set exactly as the old rule left it: that set admits the interlinear-annotation format characters and the Egyptian hieroglyph format controls, which the display boundary strips from a value it shows, so a legacy value carrying one is stored as the payload spells it and drawn stripped.
 *
 * Money is integer base units and BigInt throughout — never a float — with these rules:
 * - `quantity` and `unitPrice` are plain decimal strings with at most the asset's `decimals` fractional digits, both greater than zero, stored in the shortest exact spelling so `"2"` and `"2.00"` are one payload rather than two;
 * - a line amount is `quantity × unitPrice`, computed exactly in BigInt and rounded half-up (ties away from zero) to the asset's decimals; a line that rounds to zero is refused, because a zero-value line is a mistyped price rather than an invoice;
 * - the subtotal is the sum of the rounded line amounts;
 * - an optional tax is a percentage with at most {@link TAX_RATE_DECIMALS} fractional digits applied to the subtotal and rounded the same way (a tax that rounds to zero is allowed: it is a real `0` amount, not a mistyped line);
 * - the total is `subtotal + tax` and must still fit the uint256 a single transfer carries.
 */

import {
	ASSET_REGISTRY,
	SUPPORTED_CHAIN_IDS,
	isAssetNetwork,
	isSupportedAsset,
	isSupportedChain,
	type Asset,
	type AssetId,
	type NetworkId,
} from "../assets/registry.js";
import { UINT256_MAX, canonicalAmount, fractionalDigits, fromBaseUnits, toBaseUnits } from "../util/decimal.js";
import { boundMessage, describe, messageOf, preview } from "../util/errors.js";
import { INVISIBLE_FORMATTING, LONE_SURROGATE, MULTI_LINE_CONTROL, SINGLE_LINE_CONTROL, stripDisplayCharacters } from "../util/text.js";
import { requirePayoutAddress, type PayoutAddress } from "../wallet/payout-address.js";
import { canonicalContactText } from "./contact-canonical-text.js";
import { validateIcon } from "./icon.js";

/** The only invoice schema version this build writes and reads. */
export const INVOICE_VERSION = 1;

/** The payload kind, so a decoded object says what it is next to its version. */
export const INVOICE_KIND = "invoice";

/** The most line items one invoice may carry; more is a rendering and link-length problem. */
export const MAX_ITEMS = 200;

/** The most characters an invoice id may carry. */
export const MAX_ID_CHARS = 64;

/** The most characters a party name may carry. */
export const MAX_NAME_CHARS = 200;

/** The most characters a legacy email spelling may carry: a party contact value that matches that spelling is accepted at this cap rather than at the contact limits. */
export const MAX_EMAIL_CHARS = 320;

/** The most lines a party's contact info may carry. */
export const MAX_CONTACT_LINES = 4;

/** The most characters one line of a party's contact info may carry. */
export const MAX_CONTACT_LINE_CHARS = 40;

/**
 * The most characters a party's contact info may carry in total: {@link MAX_CONTACT_LINES} lines of {@link MAX_CONTACT_LINE_CHARS} characters each, plus the {@link MAX_CONTACT_LINES} minus one line breaks between them.
 *
 * The total is derived from the per-line bounds rather than stated beside them, so the widest shape those bounds hold out — every line at its own cap — is the shape this bound admits: a total that left the line breaks uncounted would refuse the very input the per-line caps accept.
 */
export const MAX_CONTACT_CHARS = MAX_CONTACT_LINES * MAX_CONTACT_LINE_CHARS + (MAX_CONTACT_LINES - 1);

/** The most characters one line item's description may carry. */
export const MAX_DESCRIPTION_CHARS = 500;

/** The most characters a payee's free-text notes may carry. */
export const MAX_PAYEE_NOTES_CHARS = 500;

/** The most characters an invoice's notes field may carry. */
export const MAX_INVOICE_NOTES_CHARS = 2000;

/** The most characters a tax label may carry. */
export const MAX_TAX_LABEL_CHARS = 100;

/** Fractional digits a tax rate may carry, so a rate stays exactly representable. */
export const TAX_RATE_DECIMALS = 6;

/** One billed line, in the invoice asset's human units. */
export interface LineItem {
	readonly description: string;
	readonly quantity: string;
	readonly unitPrice: string;
}

/** A percentage tax on the subtotal, e.g. `{ label: "VAT 19%", rate: "19" }`. */
export interface TaxLine {
	readonly label: string;
	readonly rate: string;
}

/** The party being paid. `address` is the payout address for the invoice's own asset, in the form that asset's family validates it to. */
export interface Payee {
	readonly name: string;
	readonly address: PayoutAddress;
	/** Optional free-text contact info — an email address, a phone number, a postal address, anything the payee wants shown; the JSON key stays `email` for wire compatibility. */
	readonly email?: string;
	readonly notes?: string;
}

/** The party being billed; payer details are display-only. */
export interface Payer {
	readonly name: string;
	/** Optional free-text contact info — anything the payer wants shown on the invoice; the JSON key stays `email` for wire compatibility. */
	readonly email?: string;
}

/** A complete, validated invoice — exactly what the share codec serializes. */
export interface Invoice {
	readonly v: typeof INVOICE_VERSION;
	readonly t: typeof INVOICE_KIND;
	readonly id: string;
	readonly issued: string;
	readonly due?: string;
	readonly payee: Payee;
	readonly payer?: Payer;
	readonly chainId: NetworkId;
	readonly asset: AssetId;
	readonly items: readonly LineItem[];
	readonly tax?: TaxLine;
	readonly notes?: string;
	readonly icon?: string;
}

/**
 * Everything an invoice needs except the version and kind, which {@link createInvoice} fills in.
 *
 * The payee's `address` is the one field typed loosely, as the raw text a caller holds: a caller builds this object from untrusted input — the create form's field, a hand-built fixture — and which address spelling is valid belongs to the invoice's asset family, so {@link createInvoice} re-validates the string with `wallet/payout-address.ts`'s `requirePayoutAddress` against the asset rather than trusting the call site to already hold a validated {@link PayoutAddress}.
 */
export type InvoiceInput = Omit<Invoice, "v" | "t" | "payee"> & {
	readonly payee: Omit<Payee, "address"> & { readonly address: string };
};

/** A money figure as integer base units plus its shortest exact decimal rendering. */
export interface Amount {
	readonly units: bigint;
	readonly text: string;
}

/** One line item together with the amount it contributes. */
export interface LineAmount {
	readonly item: LineItem;
	readonly amount: Amount;
}

/** The derived money of an invoice; nothing here is ever serialized into a share string. */
export interface InvoiceTotals {
	readonly asset: Asset;
	readonly lines: readonly LineAmount[];
	readonly subtotal: Amount;
	readonly tax: Amount;
	readonly total: Amount;
}

/** The invoice fields the money computation reads; {@link computeTotalsFor} needs no identity fields. */
export interface TotalsInput {
	readonly asset: AssetId;
	readonly items: readonly LineItem[];
	readonly tax?: TaxLine;
}

/**
 * Raised by {@link validateInvoice} for a field that is missing, mis-shaped, or out of range; `path` names the offending field.
 *
 * A refusal this module wraps from another validator — a payout address, a money input, an icon — is kept as the error's own `cause`, so a surface above the model can classify the refusal by the class that raised it rather than by reading the message it was worded into.
 */
export class InvalidInvoiceError extends Error {
	/** The offending field, e.g. `payee.address` or `items[0].quantity`. Empty for the root object. */
	readonly path: string;

	constructor(path: string, reason: string, options?: ErrorOptions) {
		super(path === "" ? `invoice: ${reason}` : `invoice: ${path}: ${reason}`, options);
		this.name = "InvalidInvoiceError";
		this.path = path;
	}
}

/** Raised when a payload names a schema version other than {@link INVOICE_VERSION}. */
export class UnsupportedInvoiceVersionError extends Error {
	constructor(version: unknown) {
		super(`invoice: unsupported schema version ${describe(version)} — this build reads version ${INVOICE_VERSION}`);
		this.name = "UnsupportedInvoiceVersionError";
	}
}

const INVOICE_FIELDS = [
	"v",
	"t",
	"id",
	"issued",
	"due",
	"payee",
	"payer",
	"chainId",
	"asset",
	"items",
	"tax",
	"notes",
	"icon",
] as const;

const PAYEE_FIELDS = ["name", "address", "email", "notes"] as const;
const PAYER_FIELDS = ["name", "email"] as const;
const ITEM_FIELDS = ["description", "quantity", "unitPrice"] as const;
const TAX_FIELDS = ["label", "rate"] as const;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** The largest accepted tax rate, expressed in `TAX_RATE_DECIMALS`-scaled percent units. */
const MAX_TAX_RATE_UNITS = 100n * 10n ** BigInt(TAX_RATE_DECIMALS);

/**
 * The most of a wrapped validator message a user-facing refusal carries.
 *
 * {@link payoutAddress} and {@link moneyRefusal} wrap another module's message, {@link date} builds one of its own, and {@link assertKnownFields} puts an unknown JSON key into the field path; each embeds the rejected value, which a share payload within the codec's cap can stretch without bound — the address validator imposes no length of its own, a date string reaches its refusal with no cap at all, and an unknown key's length is limited only by the payload.
 * Left unbounded, that turns the route notice into ~100 KB and breaks the bounded-message invariant (`util/errors.ts`, `app/shell.ts`).
 * The bound leaves every message this module builds from a legitimate value intact — the longest is well under it — while keeping a hostile one far inside the notice's own limit.
 */
const WRAPPED_MESSAGE_MAX = 200;

interface TextRules {
	readonly max: number;
	readonly multiline?: boolean;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new InvalidInvoiceError(path, `must be a JSON object, got ${preview(value)}`);
	}
	return value as Record<string, unknown>;
}

function assertKnownFields(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) {
			const at = boundMessage(path === "" ? key : `${path}.${key}`, WRAPPED_MESSAGE_MAX);
			throw new InvalidInvoiceError(at, `is not a known field — expected one of ${allowed.join(", ")}`);
		}
	}
}

/** Refuse text that starts or ends with whitespace: the create form trims each field before it is validated, so a stored value is never a padded one, and the one field that repairs surrounding whitespace rather than refusing it is the icon gate (`invoice/icon.ts`). */
function assertUnpadded(value: string, path: string): void {
	if (value.trim() !== value) {
		throw new InvalidInvoiceError(path, "must not start or end with whitespace");
	}
}

function text(value: unknown, path: string, { max, multiline = false }: TextRules): string {
	if (typeof value !== "string") {
		throw new InvalidInvoiceError(path, `must be a string, got ${preview(value)}`);
	}
	const normalized = value.normalize("NFC");
	if (normalized.length === 0 || normalized.length > max) {
		throw new InvalidInvoiceError(path, `must be 1 to ${max} characters long, got ${normalized.length}`);
	}
	assertUnpadded(normalized, path);
	if ((multiline ? MULTI_LINE_CONTROL : SINGLE_LINE_CONTROL).test(normalized)) {
		const reason = multiline
			? "must not contain control characters other than newlines and tabs"
			: "must not contain control characters";
		throw new InvalidInvoiceError(path, reason);
	}
	if (INVISIBLE_FORMATTING.test(normalized)) {
		throw new InvalidInvoiceError(path, "must not contain invisible or direction-formatting characters");
	}
	if (LONE_SURROGATE.test(normalized)) {
		throw new InvalidInvoiceError(path, "must not contain lone surrogate code units");
	}
	return normalized;
}

/**
 * A party's contact info, which the wire format still spells `email` on both parties.
 *
 * The value is free text — an email address, a phone number, a postal address — so it is held to the contact limits rather than to an address pattern: at most {@link MAX_CONTACT_LINES} lines of at most {@link MAX_CONTACT_LINE_CHARS} characters, {@link MAX_CONTACT_CHARS} in total, and free of control characters beside the newlines the limits themselves split on.
 * Its ends are refused rather than trimmed, the rule {@link assertUnpadded} holds for every text field here, so a value pasted with a stray leading or trailing space is refused by name; the spaces a line carries inside the value — a run of them, or the one a line opens with — are stored as the payee typed them.
 * The stored text is the one `invoice/contact-canonical-text.ts`'s `canonicalContactText` returns — composed to NFC, its line endings LF, and every tab replaced with the single space it stood for — and every surface draws its spacing as it stands.
 * The page and the print twin draw a run of spaces, and the space a line opens with, as the characters they are: `app/stylesheets/invoice.css` declares `white-space: pre-wrap` for `.party-detail`, the treatment it already gives the invoice's other free-text field, and the print path is that same element under that same declaration.
 * The PDF draws each contact line literally too — in the fitted run where the line fits, and in the runs `pdf/renderer.ts`'s `wrapContactText` wraps a line into below its scale floor, which keeps every space rather than collapsing or dropping one.
 * One character class is refused on top of that shape: the display boundary removes the interlinear-annotation and Egyptian-hieroglyph format characters from a line it shows even though this validator admits them as ordinary text, so a stored one would render differently from the payload it travels in — a divergence no surface can draw around, unlike the tab, whose single space is faithful.
 * A shape that reads as an email address goes down the legacy branch instead and is held to {@link MAX_EMAIL_CHARS}, the cap the field carried before it widened, so a share link written then still validates: every value the old rule accepted is accepted here too.
 * That branch is left exactly as it was — a single line of at most {@link MAX_EMAIL_CHARS} characters with no control character at all, which no tab reaches — so neither the tab pass nor the refusal above narrows or widens it, and it is the one shape the paragraph above does not cover: the recorded byte-for-byte legacy decision pins its accepted set to the set the old rule admitted, which holds the interlinear-annotation and Egyptian-hieroglyph format characters `util/text.ts`'s display strip removes, so such a value is stored as the payload spells it and drawn stripped rather than refused.
 * Each refusal names the bound its value tripped and how to satisfy it: a line past {@link MAX_CONTACT_LINE_CHARS} says to shorten or break the line and names the whole-value email-shaped exception that admits it alone, more lines than {@link MAX_CONTACT_LINES} says to use fewer, and the total is checked last — after the two bounds that imply it — so the coarse total-length message never stands in for the specific bound a value actually tripped.
 * The ends are settled before any of those bounds: a value whose only fault is a trailing line break has no fault of that kind in its line count once the break is gone, so it is told about its padding rather than refused for a count it never reached.
 */
function contact(value: unknown, path: string): string {
	if (typeof value !== "string") {
		throw new InvalidInvoiceError(path, `must be a string, got ${preview(value)}`);
	}
	// The legacy test below reads the stored spelling, so the line endings, the tab-to-space pass, and the NFC composition are settled first; none of them changes a value the legacy rule accepts, which holds no tab and nothing but free text on its one line.
	const normalized = canonicalContactText(value);
	if (EMAIL_PATTERN.test(normalized)) {
		return text(normalized, path, { max: MAX_EMAIL_CHARS });
	}
	// The ends are checked before the bounds below, because a value padded with a line break has one line fewer than the split reads: counting first would refuse it for a bound it never tripped. `text` checks the ends again with the rest of the shape rules, and the value reaching it is unpadded, so that check passes.
	assertUnpadded(normalized, path);
	// The line count and the per-line bound are checked before the total: each names its own bound and its remedy, where the total-length message `text` would raise first says only how long the value is, and every value past {@link MAX_CONTACT_CHARS} is past one of these two anyway.
	const lines = normalized.split("\n");
	if (lines.length > MAX_CONTACT_LINES) {
		throw new InvalidInvoiceError(path, `must hold at most ${MAX_CONTACT_LINES} lines, got ${lines.length} — put the contact info on ${MAX_CONTACT_LINES} lines or fewer`);
	}
	for (const line of lines) {
		if (line.length > MAX_CONTACT_LINE_CHARS) {
			throw new InvalidInvoiceError(
				path,
				`must hold lines of at most ${MAX_CONTACT_LINE_CHARS} characters, got ${line.length} — shorten the line to ${MAX_CONTACT_LINE_CHARS} characters or fewer, or break it across lines; only a whole value that is one email-shaped line is held to ${MAX_EMAIL_CHARS} instead`,
			);
		}
	}
	// `text` still enforces the total cap and the shape rules the two bounds above do not read, and every value reaching it here is already within {@link MAX_CONTACT_CHARS}.
	const stored = text(normalized, path, { max: MAX_CONTACT_CHARS, multiline: true });
	// The display boundary removes a control or invisible-format character from every stored line it shows, so a character it would remove is one no surface can draw as itself; the tab it would also remove reached here already replaced by a space.
	const unrenderable = firstUnrenderableCodePoint(stored);
	if (unrenderable !== null) {
		throw new InvalidInvoiceError(path, `must not contain ${codePointLabel(unrenderable)}, an invisible formatting character no surface can show — remove it or replace it with a visible character`);
	}
	return stored;
}

/** The `U+XXXX` label a refusal gives a character that renders as nothing, since the character's own text cannot stand in the message. */
function codePointLabel(codePoint: number): string {
	return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * The first code point a stored contact value carries that `util/text.ts`'s display strip would remove, or `null` when every character survives it.
 *
 * The value is split into lines before the check because the strip removes the newline between them as well; the model's own shape refusals run before this, so the only code points it can return are the invisible-format characters those refusals leave unrefused.
 */
function firstUnrenderableCodePoint(stored: string): number | null {
	for (const line of stored.split("\n")) {
		for (const character of line) {
			const codePoint = character.codePointAt(0);
			if (codePoint !== undefined && stripDisplayCharacters(character) !== character) return codePoint;
		}
	}
	return null;
}

function date(value: unknown, path: string): string {
	if (typeof value !== "string") {
		throw new InvalidInvoiceError(path, `must be a YYYY-MM-DD date string, got ${preview(value)}`);
	}
	const match = DATE_PATTERN.exec(value);
	if (match === null) {
		throw new InvalidInvoiceError(
			path,
			boundMessage(`must be a YYYY-MM-DD date string, got ${describe(value)}`, WRAPPED_MESSAGE_MAX),
		);
	}
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (month < 1 || month > 12) {
		throw new InvalidInvoiceError(path, `${describe(value)} is not a real calendar date`);
	}
	const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
	const longest = month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1];
	if (day < 1 || day > longest) {
		throw new InvalidInvoiceError(path, `${describe(value)} is not a real calendar date`);
	}
	return value;
}

/**
 * A money input as written.
 * Range and precision are enforced when the totals are computed, but an accepted spelling is folded to the one canonical decimal form, so `"2"`, `"2.0"` and `"2.00"` reach a share string as a single payload rather than three (see {@link canonicalAmount}).
 */
function amountText(value: unknown, path: string, decimals: number): string {
	if (typeof value !== "string") {
		throw new InvalidInvoiceError(path, `must be a decimal amount string like "1.5", got ${preview(value)}`);
	}
	return canonicalAmount(value, decimals);
}

function assetField(value: unknown, path: string): { id: AssetId; asset: Asset } {
	if (typeof value !== "string" || !isSupportedAsset(value)) {
		throw new InvalidInvoiceError(
			path,
			`must be a supported asset id (${Object.keys(ASSET_REGISTRY).join(", ")}), got ${preview(value)}`,
		);
	}
	return { id: value, asset: ASSET_REGISTRY[value] };
}

function chainField(value: unknown, path: string, asset: Asset): NetworkId {
	if (typeof value !== "string" || !isSupportedChain(value)) {
		throw new InvalidInvoiceError(
			path,
			`must be one of the supported chains (${SUPPORTED_CHAIN_IDS.join(", ")}), got ${preview(value)}`,
		);
	}
	if (!isAssetNetwork(value, asset)) {
		throw new InvalidInvoiceError(
			path,
			`must be ${describe(asset.chainId)} to match the ${asset.id} asset, got ${describe(value)}`,
		);
	}
	return value;
}

/**
 * The payee address for the invoice's own asset, validated by the family that asset states and refused under this field's path.
 *
 * The rules belong to the dispatcher: an EVM asset re-encodes the address to its EIP-55 checksum and refuses the zero address or a token's own contract, a Zcash asset reads the transparent, Sapling, and mainnet unified forms, and a Monero asset the standard, subaddress, and integrated ones.
 * Every refusal it raises reaches the field this module read the value from, bounded with the same cap the other wrapped messages use, because the message embeds the rejected value.
 * The dispatcher's own error travels with it as the `cause`, so a surface that acts on the refusal — rather than showing its message — reads the class the validator raised: a testnet unified container is a `TestnetUnifiedAddressError` here rather than a wording to match.
 */
function payoutAddress(value: unknown, path: string, asset: Asset): PayoutAddress {
	try {
		return requirePayoutAddress(value, asset);
	} catch (error) {
		throw new InvalidInvoiceError(path, boundMessage(messageOf(error), WRAPPED_MESSAGE_MAX), { cause: error });
	}
}

/**
 * The optional icon, validated by the icon gate and refused under this field's path.
 *
 * The gate owns the rules — the byte cap, the canonicalization, the root `<svg>` dimension bound, and the construct denylist — and its refusal reaches the field this module read the value from, bounded with the same cap the other wrapped messages use, because the message names the rejected value.
 * The icon is the one text field the gate repairs rather than refuses, a repair the module block above states the reason for.
 * Because that repair admits a spelling this build would not write, the field's single wire spelling does not rest on this validator: it rests on `invoice/codec.ts`'s byte-for-byte comparison of the decoded JSON against the canonical text, which every decode path passes through.
 * The gate's own error travels with it as the `cause`, so a surface that acts on the refusal reads the class the validator raised — an `InvalidIconError` for a malformed document, a `TypeError` for a value that is not text — rather than a wording to match.
 */
function iconField(value: unknown, path: string): string {
	try {
		return validateIcon(value);
	} catch (error) {
		throw new InvalidInvoiceError(path, boundMessage(messageOf(error), WRAPPED_MESSAGE_MAX), { cause: error });
	}
}

function payeeField(value: unknown, path: string, asset: Asset): Payee {
	const payee = asRecord(value, path);
	assertKnownFields(payee, path, PAYEE_FIELDS);
	return Object.freeze({
		name: text(payee.name, `${path}.name`, { max: MAX_NAME_CHARS }),
		address: payoutAddress(payee.address, `${path}.address`, asset),
		...(payee.email === undefined ? {} : { email: contact(payee.email, `${path}.email`) }),
		...(payee.notes === undefined ? {} : { notes: text(payee.notes, `${path}.notes`, { max: MAX_PAYEE_NOTES_CHARS, multiline: true }) }),
	});
}

function payerField(value: unknown, path: string): Payer {
	const payer = asRecord(value, path);
	assertKnownFields(payer, path, PAYER_FIELDS);
	return Object.freeze({
		name: text(payer.name, `${path}.name`, { max: MAX_NAME_CHARS }),
		...(payer.email === undefined ? {} : { email: contact(payer.email, `${path}.email`) }),
	});
}

function itemsField(value: unknown, path: string, decimals: number): readonly LineItem[] {
	if (!Array.isArray(value)) {
		throw new InvalidInvoiceError(path, `must be an array of line items, got ${preview(value)}`);
	}
	if (value.length === 0) {
		throw new InvalidInvoiceError(path, "must hold at least one line item");
	}
	if (value.length > MAX_ITEMS) {
		throw new InvalidInvoiceError(path, `must hold at most ${MAX_ITEMS} line items, got ${value.length}`);
	}
	return Object.freeze(
		value.map((entry, index) => {
			const at = `${path}[${index}]`;
			const item = asRecord(entry, at);
			assertKnownFields(item, at, ITEM_FIELDS);
			return Object.freeze({
				description: text(item.description, `${at}.description`, { max: MAX_DESCRIPTION_CHARS }),
				quantity: amountText(item.quantity, `${at}.quantity`, decimals),
				unitPrice: amountText(item.unitPrice, `${at}.unitPrice`, decimals),
			});
		}),
	);
}

function taxField(value: unknown, path: string): TaxLine {
	const tax = asRecord(value, path);
	assertKnownFields(tax, path, TAX_FIELDS);
	return Object.freeze({
		label: text(tax.label, `${path}.label`, { max: MAX_TAX_LABEL_CHARS }),
		rate: amountText(tax.rate, `${path}.rate`, TAX_RATE_DECIMALS),
	});
}

function unitsOf(value: unknown, path: string, decimals: number, scale: string): bigint {
	try {
		return toBaseUnits(value, decimals);
	} catch (error) {
		throw new InvalidInvoiceError(path, moneyRefusal(value, decimals, scale, error));
	}
}

/**
 * Why `toBaseUnits` refused a money input, said for the field this module is validating.
 *
 * `toBaseUnits` words its refusals around an abstract decimal and the asset's decimals, and both a zero value and an over-precise value reach the user under a field this module names itself (a tax rate, a line item) rather than the asset, so those two refusals are re-said here in the caller's own words.
 * The classification uses {@link fractionalDigits} from `util/decimal.ts`, the same grammar `toBaseUnits` parses, so the wording cannot drift from the refusal it explains.
 * Every other refusal already names what was wrong with the value, so it passes through — bounded, because that message embeds the rejected value, which a within-cap payload can make tens of KB long.
 */
function moneyRefusal(value: unknown, decimals: number, scale: string, error: unknown): string {
	const digits = fractionalDigits(value);
	if (digits !== null && digits > decimals) {
		return `${preview(value)} has ${digits} decimal places but the ${scale} allows ${decimals}`;
	}
	if (typeof value === "string" && isZeroAmount(value)) {
		return `must be greater than zero, got ${preview(value)}`;
	}
	return boundMessage(messageOf(error), WRAPPED_MESSAGE_MAX);
}

/** True for a canonical decimal that parses to zero base units: `"0"`, `"0.0"`, `"0.00"`. */
function isZeroAmount(value: string): boolean {
	return /^0(?:\.0+)?$/.test(value);
}

/** Half-up: a remainder of exactly half the denominator rounds away from zero. All inputs are >= 0. */
function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
	const whole = numerator / denominator;
	const remainder = numerator % denominator;
	return remainder * 2n >= denominator ? whole + 1n : whole;
}

function amount(units: bigint, decimals: number): Amount {
	return Object.freeze({ units, text: fromBaseUnits(units, decimals) });
}

function lineUnits(item: LineItem, path: string, decimals: number): bigint {
	const quantity = unitsOf(item.quantity, `${path}.quantity`, decimals, "asset");
	const unitPrice = unitsOf(item.unitPrice, `${path}.unitPrice`, decimals, "asset");
	const units = divideRoundHalfUp(quantity * unitPrice, 10n ** BigInt(decimals));
	if (units === 0n) {
		throw new InvalidInvoiceError(
			path,
			`amounts to zero at ${decimals} decimal places — raise the unit price or drop the line`,
		);
	}
	return units;
}

function taxUnits(tax: TaxLine, subtotal: bigint): bigint {
	const rate = unitsOf(tax.rate, "tax.rate", TAX_RATE_DECIMALS, "tax rate");
	if (rate > MAX_TAX_RATE_UNITS) {
		throw new InvalidInvoiceError("tax.rate", `must be a percentage of at most 100, got ${describe(tax.rate)}`);
	}
	return divideRoundHalfUp(subtotal * rate, 10n ** BigInt(TAX_RATE_DECIMALS + 2));
}

/**
 * Derive the money of an invoice from its own line items — never from a transported total.
 *
 * Expects validated fields and re-checks the money rules, so a hand-built input with a zero line, an over-precise amount, an unsupported asset, or a total past the uint256 a single transfer can carry is refused here rather than becoming a failed payment later.
 */
export function computeTotalsFor(input: TotalsInput): InvoiceTotals {
	const { asset } = assetField(input.asset, "asset");
	const { decimals } = asset;
	if (input.items.length === 0) {
		throw new InvalidInvoiceError("items", "must hold at least one line item");
	}
	const lines: LineAmount[] = [];
	let subtotal = 0n;
	for (const [index, item] of input.items.entries()) {
		const units = lineUnits(item, `items[${index}]`, decimals);
		subtotal += units;
		lines.push(Object.freeze({ item, amount: amount(units, decimals) }));
	}
	const tax = input.tax === undefined ? 0n : taxUnits(input.tax, subtotal);
	const total = subtotal + tax;
	if (total > UINT256_MAX) {
		throw new InvalidInvoiceError("items", `the invoice total ${total} base units exceeds the uint256 transfer maximum`);
	}
	return Object.freeze({
		asset,
		lines: Object.freeze(lines),
		subtotal: amount(subtotal, decimals),
		tax: amount(tax, decimals),
		total: amount(total, decimals),
	});
}

/** Derive the money of a validated {@link Invoice}. */
export function computeTotals(invoice: Invoice): InvoiceTotals {
	return computeTotalsFor({ asset: invoice.asset, items: invoice.items, tax: invoice.tax });
}

/**
 * Validate an untrusted value — a parsed share payload, a hand-built object — into an {@link Invoice}.
 *
 * Nothing is trusted: every field must be present with the right shape, no unknown field is tolerated, and the money rules are enforced by {@link computeTotals}.
 * Optional fields may be absent or `undefined`; both mean the same thing.
 * Dates are compared as `YYYY-MM-DD` strings, which orders identically to the calendar.
 * Text is composed to NFC, invisible formatting is refused, and money fields are folded to their canonical spelling.
 * An optional icon is read through {@link iconField}, so a decoded invoice carries the canonical text the icon gate returned — the `util/icon-canonical-text.ts` spelling, the one repair the module block above states the reason for — and an icon the gate refuses is refused rather than kept.
 * The result is frozen.
 */
export function validateInvoice(value: unknown): Invoice {
	const source = asRecord(value, "");

	if (source.v !== INVOICE_VERSION) {
		if (source.v === undefined) {
			throw new InvalidInvoiceError("v", `is missing — this build reads invoice version ${INVOICE_VERSION}`);
		}
		if (typeof source.v !== "number") {
			throw new InvalidInvoiceError("v", `must be the number ${INVOICE_VERSION}, got ${preview(source.v)}`);
		}
		throw new UnsupportedInvoiceVersionError(source.v);
	}
	if (source.t !== INVOICE_KIND) {
		throw new InvalidInvoiceError("t", `must be ${describe(INVOICE_KIND)}, got ${preview(source.t)}`);
	}
	assertKnownFields(source, "", INVOICE_FIELDS);

	const id = text(source.id, "id", { max: MAX_ID_CHARS });
	const issued = date(source.issued, "issued");
	const due = source.due === undefined ? undefined : date(source.due, "due");
	if (due !== undefined && due < issued) {
		throw new InvalidInvoiceError("due", `must not be before the issue date ${issued}, got ${due}`);
	}
	const { id: assetId, asset } = assetField(source.asset, "asset");
	const chainId = chainField(source.chainId, "chainId", asset);
	const payee = payeeField(source.payee, "payee", asset);
	const payer = source.payer === undefined ? undefined : payerField(source.payer, "payer");
	const items = itemsField(source.items, "items", asset.decimals);
	const tax = source.tax === undefined ? undefined : taxField(source.tax, "tax");
	const notes = source.notes === undefined ? undefined : text(source.notes, "notes", { max: MAX_INVOICE_NOTES_CHARS, multiline: true });
	const icon = source.icon === undefined ? undefined : iconField(source.icon, "icon");

	const invoice: Invoice = Object.freeze({
		v: INVOICE_VERSION,
		t: INVOICE_KIND,
		id,
		issued,
		...(due === undefined ? {} : { due }),
		payee,
		...(payer === undefined ? {} : { payer }),
		chainId,
		asset: assetId,
		items,
		...(tax === undefined ? {} : { tax }),
		...(notes === undefined ? {} : { notes }),
		...(icon === undefined ? {} : { icon }),
	});
	computeTotals(invoice);
	return invoice;
}

/** Build a validated invoice from everything but the version and kind, which are filled in here. */
export function createInvoice(input: InvoiceInput): Invoice {
	return validateInvoice({ v: INVOICE_VERSION, t: INVOICE_KIND, ...input });
}
