/**
 * The invoice model.
 *
 * An {@link Invoice} is the wire object and nothing more: an id, dates, the parties, the asset, the line items, an optional tax, an optional icon and free text.
 * Totals are never transported — {@link computeTotals} derives them from the invoice's own inputs, so a share string cannot smuggle in a total that disagrees with its own lines.
 * {@link validateInvoice} checks every field of an untrusted parsed object and fails closed with a field path; {@link createInvoice} is the same validation for an object built in memory.
 * The optional icon is the one field whose rules live outside this module: `invoice/icon.ts` bounds and canonicalizes it, and {@link validateInvoice} reads that gate's refusal under the `icon` path.
 *
 * Text is normalized to Unicode NFC as it is validated, so one visible string has a single encoded form and an NFD spelling of a name is not a second, equally valid spelling of the same invoice.
 * Invisible and direction-formatting characters (zero-width spaces, bidi marks and overrides, the soft hyphen, the byte-order mark, and other default-ignorable formatting) are refused, a single-line field also refuses the Unicode line and paragraph separators, and the C1 control block is refused alongside the C0 controls, so a stored name or id cannot be made to render differently from how it reads.
 * A lone surrogate code unit is refused as malformed text: it is not a code point any renderer can show as the byte it is, and neither the NFC composition above nor the codec's canonical re-serialization rejects one, so this validator is the boundary that must.
 *
 * Money is integer base units and BigInt throughout — never a float — with these rules:
 * - `quantity` and `unitPrice` are plain decimal strings with at most the asset's `decimals` fractional digits, both greater than zero, stored in the shortest exact spelling so `"2"` and `"2.00"` are one payload rather than two;
 * - a line amount is `quantity × unitPrice`, computed exactly in BigInt and rounded half-up (ties away from zero) to the asset's decimals; a line that rounds to zero is refused, because a zero-value line is a mistyped price rather than an invoice;
 * - the subtotal is the sum of the rounded line amounts;
 * - an optional tax is a percentage with at most {@link TAX_RATE_DECIMALS} fractional digits applied to the subtotal and rounded the same way (a tax that rounds to zero is allowed: it is a real `0` amount, not a mistyped line);
 * - the total is `subtotal + tax` and must still fit the uint256 a single transfer carries.
 */
import { ASSET_REGISTRY, SUPPORTED_CHAIN_IDS, isAssetNetwork, isSupportedAsset, isSupportedChain, } from "../assets/registry.js";
import { UINT256_MAX, canonicalAmount, fractionalDigits, fromBaseUnits, toBaseUnits } from "../util/decimal.js";
import { boundMessage, describe, messageOf, preview } from "../util/errors.js";
import { INVISIBLE_FORMATTING, LONE_SURROGATE, MULTI_LINE_CONTROL, SINGLE_LINE_CONTROL } from "../util/text.js";
import { requirePayoutAddress } from "../wallet/payout-address.js";
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
/** The most characters an email address may carry. */
export const MAX_EMAIL_CHARS = 320;
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
/**
 * Raised by {@link validateInvoice} for a field that is missing, mis-shaped, or out of range; `path` names the offending field.
 *
 * A refusal this module wraps from another validator — a payout address, a money input, an icon — is kept as the error's own `cause`, so a surface above the model can classify the refusal by the class that raised it rather than by reading the message it was worded into.
 */
export class InvalidInvoiceError extends Error {
    /** The offending field, e.g. `payee.address` or `items[0].quantity`. Empty for the root object. */
    path;
    constructor(path, reason, options) {
        super(path === "" ? `invoice: ${reason}` : `invoice: ${path}: ${reason}`, options);
        this.name = "InvalidInvoiceError";
        this.path = path;
    }
}
/** Raised when a payload names a schema version other than {@link INVOICE_VERSION}. */
export class UnsupportedInvoiceVersionError extends Error {
    constructor(version) {
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
];
const PAYEE_FIELDS = ["name", "address", "email", "notes"];
const PAYER_FIELDS = ["name", "email"];
const ITEM_FIELDS = ["description", "quantity", "unitPrice"];
const TAX_FIELDS = ["label", "rate"];
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** The largest accepted tax rate, expressed in `TAX_RATE_DECIMALS`-scaled percent units. */
const MAX_TAX_RATE_UNITS = 100n * 10n ** BigInt(TAX_RATE_DECIMALS);
/**
 * The most of a wrapped validator message a user-facing refusal carries.
 *
 * {@link payoutAddress} and {@link moneyRefusal} wrap another module's message, {@link email} and {@link date} build one of their own, and {@link assertKnownFields} puts an unknown JSON key into the field path; each embeds the rejected value, which a share payload within the codec's cap can stretch without bound — the address validator imposes no length of its own, the email validator's 320-character cap still leaves room for a notice past 400 characters, a date string reaches its refusal with no cap at all, and an unknown key's length is limited only by the payload.
 * Left unbounded, that turns the route notice into ~100 KB and breaks the bounded-message invariant (`util/errors.ts`, `app/shell.ts`).
 * The bound leaves every message this module builds from a legitimate value intact — the longest is well under it — while keeping a hostile one far inside the notice's own limit.
 */
const WRAPPED_MESSAGE_MAX = 200;
function asRecord(value, path) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new InvalidInvoiceError(path, `must be a JSON object, got ${preview(value)}`);
    }
    return value;
}
function assertKnownFields(value, path, allowed) {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) {
            const at = boundMessage(path === "" ? key : `${path}.${key}`, WRAPPED_MESSAGE_MAX);
            throw new InvalidInvoiceError(at, `is not a known field — expected one of ${allowed.join(", ")}`);
        }
    }
}
function text(value, path, { max, multiline = false }) {
    if (typeof value !== "string") {
        throw new InvalidInvoiceError(path, `must be a string, got ${preview(value)}`);
    }
    const normalized = value.normalize("NFC");
    if (normalized.length === 0 || normalized.length > max) {
        throw new InvalidInvoiceError(path, `must be 1 to ${max} characters long, got ${normalized.length}`);
    }
    if (normalized.trim() !== normalized) {
        throw new InvalidInvoiceError(path, "must not start or end with whitespace");
    }
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
function email(value, path) {
    const address = text(value, path, { max: MAX_EMAIL_CHARS });
    if (!EMAIL_PATTERN.test(address)) {
        throw new InvalidInvoiceError(path, boundMessage(`must be an email address like "billing@example.com", got ${describe(address)}`, WRAPPED_MESSAGE_MAX));
    }
    return address;
}
function date(value, path) {
    if (typeof value !== "string") {
        throw new InvalidInvoiceError(path, `must be a YYYY-MM-DD date string, got ${preview(value)}`);
    }
    const match = DATE_PATTERN.exec(value);
    if (match === null) {
        throw new InvalidInvoiceError(path, boundMessage(`must be a YYYY-MM-DD date string, got ${describe(value)}`, WRAPPED_MESSAGE_MAX));
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
function amountText(value, path, decimals) {
    if (typeof value !== "string") {
        throw new InvalidInvoiceError(path, `must be a decimal amount string like "1.5", got ${preview(value)}`);
    }
    return canonicalAmount(value, decimals);
}
function assetField(value, path) {
    if (typeof value !== "string" || !isSupportedAsset(value)) {
        throw new InvalidInvoiceError(path, `must be a supported asset id (${Object.keys(ASSET_REGISTRY).join(", ")}), got ${preview(value)}`);
    }
    return { id: value, asset: ASSET_REGISTRY[value] };
}
function chainField(value, path, asset) {
    if (typeof value !== "string" || !isSupportedChain(value)) {
        throw new InvalidInvoiceError(path, `must be one of the supported chains (${SUPPORTED_CHAIN_IDS.join(", ")}), got ${preview(value)}`);
    }
    if (!isAssetNetwork(value, asset)) {
        throw new InvalidInvoiceError(path, `must be ${describe(asset.chainId)} to match the ${asset.id} asset, got ${describe(value)}`);
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
function payoutAddress(value, path, asset) {
    try {
        return requirePayoutAddress(value, asset);
    }
    catch (error) {
        throw new InvalidInvoiceError(path, boundMessage(messageOf(error), WRAPPED_MESSAGE_MAX), { cause: error });
    }
}
/**
 * The optional icon, validated by the icon gate and refused under this field's path.
 *
 * The gate owns the rules — the byte cap, the NFC composition, the root `<svg>` dimension bound, and the construct denylist — and its refusal reaches the field this module read the value from, bounded with the same cap the other wrapped messages use, because the message names the rejected value.
 * The gate's own error travels with it as the `cause`, so a surface that acts on the refusal reads the class the validator raised — an `InvalidIconError` for a malformed document, a `TypeError` for a value that is not text — rather than a wording to match.
 */
function iconField(value, path) {
    try {
        return validateIcon(value);
    }
    catch (error) {
        throw new InvalidInvoiceError(path, boundMessage(messageOf(error), WRAPPED_MESSAGE_MAX), { cause: error });
    }
}
function payeeField(value, path, asset) {
    const payee = asRecord(value, path);
    assertKnownFields(payee, path, PAYEE_FIELDS);
    return Object.freeze({
        name: text(payee.name, `${path}.name`, { max: MAX_NAME_CHARS }),
        address: payoutAddress(payee.address, `${path}.address`, asset),
        ...(payee.email === undefined ? {} : { email: email(payee.email, `${path}.email`) }),
        ...(payee.notes === undefined ? {} : { notes: text(payee.notes, `${path}.notes`, { max: MAX_PAYEE_NOTES_CHARS, multiline: true }) }),
    });
}
function payerField(value, path) {
    const payer = asRecord(value, path);
    assertKnownFields(payer, path, PAYER_FIELDS);
    return Object.freeze({
        name: text(payer.name, `${path}.name`, { max: MAX_NAME_CHARS }),
        ...(payer.email === undefined ? {} : { email: email(payer.email, `${path}.email`) }),
    });
}
function itemsField(value, path, decimals) {
    if (!Array.isArray(value)) {
        throw new InvalidInvoiceError(path, `must be an array of line items, got ${preview(value)}`);
    }
    if (value.length === 0) {
        throw new InvalidInvoiceError(path, "must hold at least one line item");
    }
    if (value.length > MAX_ITEMS) {
        throw new InvalidInvoiceError(path, `must hold at most ${MAX_ITEMS} line items, got ${value.length}`);
    }
    return Object.freeze(value.map((entry, index) => {
        const at = `${path}[${index}]`;
        const item = asRecord(entry, at);
        assertKnownFields(item, at, ITEM_FIELDS);
        return Object.freeze({
            description: text(item.description, `${at}.description`, { max: MAX_DESCRIPTION_CHARS }),
            quantity: amountText(item.quantity, `${at}.quantity`, decimals),
            unitPrice: amountText(item.unitPrice, `${at}.unitPrice`, decimals),
        });
    }));
}
function taxField(value, path) {
    const tax = asRecord(value, path);
    assertKnownFields(tax, path, TAX_FIELDS);
    return Object.freeze({
        label: text(tax.label, `${path}.label`, { max: MAX_TAX_LABEL_CHARS }),
        rate: amountText(tax.rate, `${path}.rate`, TAX_RATE_DECIMALS),
    });
}
function unitsOf(value, path, decimals, scale) {
    try {
        return toBaseUnits(value, decimals);
    }
    catch (error) {
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
function moneyRefusal(value, decimals, scale, error) {
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
function isZeroAmount(value) {
    return /^0(?:\.0+)?$/.test(value);
}
/** Half-up: a remainder of exactly half the denominator rounds away from zero. All inputs are >= 0. */
function divideRoundHalfUp(numerator, denominator) {
    const whole = numerator / denominator;
    const remainder = numerator % denominator;
    return remainder * 2n >= denominator ? whole + 1n : whole;
}
function amount(units, decimals) {
    return Object.freeze({ units, text: fromBaseUnits(units, decimals) });
}
function lineUnits(item, path, decimals) {
    const quantity = unitsOf(item.quantity, `${path}.quantity`, decimals, "asset");
    const unitPrice = unitsOf(item.unitPrice, `${path}.unitPrice`, decimals, "asset");
    const units = divideRoundHalfUp(quantity * unitPrice, 10n ** BigInt(decimals));
    if (units === 0n) {
        throw new InvalidInvoiceError(path, `amounts to zero at ${decimals} decimal places — raise the unit price or drop the line`);
    }
    return units;
}
function taxUnits(tax, subtotal) {
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
export function computeTotalsFor(input) {
    const { asset } = assetField(input.asset, "asset");
    const { decimals } = asset;
    if (input.items.length === 0) {
        throw new InvalidInvoiceError("items", "must hold at least one line item");
    }
    const lines = [];
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
export function computeTotals(invoice) {
    return computeTotalsFor({ asset: invoice.asset, items: invoice.items, tax: invoice.tax });
}
/**
 * Validate an untrusted value — a parsed share payload, a hand-built object — into an {@link Invoice}.
 *
 * Nothing is trusted and nothing is repaired: every field must be present with the right shape, no unknown field is tolerated, and the money rules are enforced by {@link computeTotals}.
 * Optional fields may be absent or `undefined`; both mean the same thing.
 * Dates are compared as `YYYY-MM-DD` strings, which orders identically to the calendar.
 * Text is composed to NFC, invisible formatting is refused, and money fields are folded to their canonical spelling.
 * An optional icon is read through {@link iconField}, so a decoded invoice carries the canonical text the icon gate returned and an icon this build would not have stored is refused rather than kept.
 * The result is frozen.
 */
export function validateInvoice(value) {
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
    const invoice = Object.freeze({
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
export function createInvoice(input) {
    return validateInvoice({ v: INVOICE_VERSION, t: INVOICE_KIND, ...input });
}
//# sourceMappingURL=model.js.map