/**
 * The payee's create-invoice view.
 *
 * The view is split in two layers so most of it is testable without a browser: the pure form state and its mapping to a validated {@link Invoice} live in the exported helpers at the top, and the DOM building at the bottom only wires those helpers to inputs.
 * The payee's own screen shows the invoice the form creates, not only its share link: the section `ui/payment-section.ts` owns is drawn into this view for each invoice the form builds, so the payee can pay it, or copy its link, its address, and its amount, without opening their own share link.
 * Every rendered string — a field value, a validation message, a share payload — reaches the page as a text child of `util/dom.ts`'s `h()`, so nothing a user or a share link supplies can become markup.
 * An optional SVG icon is chosen from a file input and checked in place — a generous raw read ceiling on the file's own size first, then the icon gate, which applies its raw code-unit bound, its byte cap on the trimmed, NFC-composed text, and its construct rules — before it enters the form state, so an over-large, over-cap, or malformed file is refused under its own field and the icon the form already carries stays; the icon the form does carry is previewed through the icon leaf's own data URL, never as markup.
 */

import { ASSETS, assetFamily, isAssetFamily, isSupportedAsset, requireAsset, type Asset, type AssetFamily, type AssetId } from "../assets/registry.js";
import { MAX_JSON_BYTES, encodedJsonBytes } from "../invoice/codec.js";
import { validateIcon } from "../invoice/icon.js";
import {
	InvalidInvoiceError,
	MAX_ITEMS,
	computeTotalsFor,
	createInvoice,
	type Invoice,
	type InvoiceInput,
	type InvoiceTotals,
	type LineItem,
} from "../invoice/model.js";
import { PaymentLinkBudgetError, requireLinkBudget } from "../payment/links.js";
import { toBaseUnits } from "../util/decimal.js";
import { h } from "../util/dom.js";
import { boundMessage, messageOf } from "../util/errors.js";
import { MAX_ICON_DIMENSION, MAX_ICON_FILE_BYTES, MAX_ICON_SVG_BYTES, iconFileSizeRefusal } from "../util/icon-capacity.js";
import { svgDataUrl } from "../util/svg-data-url.js";
import { checksumStatus } from "../wallet/address.js";
import { EVM_ADDRESS_FORMS } from "../wallet/address.js";
import { MONERO_ADDRESS_FORMS } from "../wallet/monero-address.js";
import type { PayoutAddressForm } from "../wallet/payout-forms.js";
import { ZCASH_ADDRESS_FORMS } from "../wallet/zcash-address.js";
import type { NoticeApi } from "./notice.js";
import { renderPaymentSection } from "./payment-section.js";
import { buildInvoiceViewModel } from "./presentation.js";
import { buildShareBundle, openShareDialog, type ClipboardLike, type ShareBundle } from "./share.js";

/**
 * Upper bound on a field or summary error's rendered length, matching the shell notice's own bound.
 * A model message can embed the rejected value, so the same defensive clip the notice applies is applied here before any error reaches the DOM.
 */
const FIELD_MESSAGE_MAX = 300;

/**
 * One editable line, as typed.
 * Values are the raw strings in the inputs, canonicalized on submit.
 *
 * The fields are deliberately mutable, so the row's DOM identity survives an edit.
 */
export interface ItemDraft {
	description: string;
	quantity: string;
	unitPrice: string;
}

/**
 * Every field the create form edits, before it is validated into an {@link Invoice}.
 *
 * Mutable by design: the renderer owns one instance and assigns to a field per input event rather than rebuilding the state, so the mounted form, its focus, and the caret position are never thrown away.
 */
export interface CreateFormState {
	payeeName: string;
	payeeAddress: string;
	payeeEmail: string;
	invoiceId: string;
	issued: string;
	due: string;
	payerName: string;
	assetId: AssetId;
	items: ItemDraft[];
	taxEnabled: boolean;
	taxLabel: string;
	taxRate: string;
	notes: string;
	iconSvg: string;
}

/** A validation failure bound to the form field it should be shown under. */
export interface FieldError {
	readonly field: string;
	readonly message: string;
}

/** The outcome of turning the form into an invoice: either the invoice, or the fields to fix. */
export type ParseOutcome =
	| { readonly ok: true; readonly invoice: Invoice }
	| { readonly ok: false; readonly errors: readonly FieldError[] };

/** The live totals block's text, already formatted with the selected asset's symbol. */
export interface TotalsDisplay {
	readonly symbol: string;
	readonly subtotal: string;
	readonly tax: string | null;
	readonly total: string;
}

/** The seams {@link renderCreateView} needs: a notice sink, the base URL share links are built against, today's date, and an optional clipboard. */
export interface CreateViewOptions {
	readonly notice: NoticeApi;
	readonly baseUrl: string;
	readonly today: string;
	readonly clipboard?: ClipboardLike | null;
}

/** A fresh, empty line with a sensible starting quantity. */
export function emptyItem(): ItemDraft {
	return { description: "", quantity: "1", unitPrice: "" };
}

/** A blank form for `today` (a `YYYY-MM-DD` date), with one line and today's default invoice number. */
export function emptyFormState(today: string): CreateFormState {
	return {
		payeeName: "",
		payeeAddress: "",
		payeeEmail: "",
		invoiceId: `INV-${today.replace(/-/g, "")}`,
		issued: today,
		due: "",
		payerName: "",
		assetId: ASSETS[0].id,
		items: [emptyItem()],
		taxEnabled: false,
		taxLabel: "Tax",
		taxRate: "",
		notes: "",
		iconSvg: "",
	};
}

/** True while another line may be added; the editor stops at {@link MAX_ITEMS}. */
export function canAddItem(state: CreateFormState): boolean {
	return state.items.length < MAX_ITEMS;
}

/** Append a blank line, unless the invoice already holds {@link MAX_ITEMS}. */
export function addItem(state: CreateFormState): CreateFormState {
	if (!canAddItem(state)) return state;
	return { ...state, items: [...state.items, emptyItem()] };
}

/** Drop one line; removing the last line leaves a single blank one so the editor is never empty. */
export function removeItem(state: CreateFormState, index: number): CreateFormState {
	if (index < 0 || index >= state.items.length) return state;
	const items = state.items.filter((_, at) => at !== index);
	return { ...state, items: items.length === 0 ? [emptyItem()] : items };
}

/** Move one line by `delta` places; an out-of-range move leaves the state untouched. */
export function moveItem(state: CreateFormState, index: number, delta: number): CreateFormState {
	const target = index + delta;
	if (index < 0 || index >= state.items.length || target < 0 || target >= state.items.length) {
		return state;
	}
	const items = [...state.items];
	const [moved] = items.splice(index, 1);
	items.splice(target, 0, moved);
	return { ...state, items };
}

/**
 * Map the form state to the {@link InvoiceInput} the model validates.
 *
 * Text is trimmed at the edges (the model refuses padding) and empty optional fields are omitted rather than sent as empty strings, which the model would reject.
 */
export function invoiceInputFromState(state: CreateFormState): InvoiceInput {
	const asset = requireAsset(state.assetId);
	const payerName = state.payerName.trim();
	const notes = state.notes.trim();
	const payeeEmail = state.payeeEmail.trim();
	const due = state.due.trim();
	const taxLabel = state.taxLabel.trim();
	return {
		id: state.invoiceId.trim(),
		issued: state.issued.trim(),
		...(due === "" ? {} : { due }),
		payee: {
			name: state.payeeName.trim(),
			// The address is untrusted form text, kept as the string it is; createInvoice re-dispatches it through `wallet/payout-address.ts`'s requirePayoutAddress, which validates it against the selected asset's family — an EIP-55 checked `0x` address for an EVM asset, the chain's own grammar for Zcash or Monero — rather than asserting a family here.
			address: state.payeeAddress.trim(),
			...(payeeEmail === "" ? {} : { email: payeeEmail }),
		},
		...(payerName === "" ? {} : { payer: { name: payerName } }),
		chainId: asset.chainId,
		asset: state.assetId,
		items: state.items.map((item) => ({
			description: item.description.trim(),
			quantity: item.quantity.trim(),
			unitPrice: item.unitPrice.trim(),
		})),
		...(state.taxEnabled ? { tax: { label: taxLabel === "" ? "Tax" : taxLabel, rate: state.taxRate.trim() } } : {}),
		...(notes === "" ? {} : { notes }),
		...(state.iconSvg === "" ? {} : { icon: state.iconSvg }),
	};
}

/**
 * Validate the form into an invoice.
 *
 * Cheap required-field checks run first so several empty fields surface together; anything the model alone can judge (formats, money, the payout address) is then reported through its own error, bound to the field path it names.
 */
export function parseFormState(state: CreateFormState): ParseOutcome {
	const errors = requiredFieldErrors(state);
	if (errors.length > 0) {
		return { ok: false, errors };
	}
	try {
		return { ok: true, invoice: createInvoice(invoiceInputFromState(state)) };
	} catch (error) {
		return { ok: false, errors: [fieldErrorFor(error)] };
	}
}

function requiredFieldErrors(state: CreateFormState): FieldError[] {
	const errors: FieldError[] = [];
	if (state.payeeName.trim() === "") errors.push({ field: "payeeName", message: "Payee name is required" });
	if (state.payeeAddress.trim() === "") errors.push({ field: "payeeAddress", message: "Payout address is required" });
	if (state.invoiceId.trim() === "") errors.push({ field: "invoiceId", message: "Invoice number is required" });
	if (state.issued.trim() === "") errors.push({ field: "issued", message: "Issue date is required" });
	state.items.forEach((item, index) => {
		if (item.description.trim() === "") {
			errors.push({ field: `item-${index}-description`, message: "Description is required" });
		}
		if (item.quantity.trim() === "") {
			errors.push({ field: `item-${index}-quantity`, message: "Quantity is required" });
		}
		if (item.unitPrice.trim() === "") {
			errors.push({ field: `item-${index}-unitPrice`, message: "Unit price is required" });
		}
	});
	if (state.taxEnabled && state.taxRate.trim() === "") {
		errors.push({ field: "taxRate", message: "Tax rate is required when tax is on" });
	}
	return errors;
}

/** Bind a model error to the form field its path names. */
function fieldErrorFor(error: unknown): FieldError {
	if (error instanceof InvalidInvoiceError) {
		const prefix = error.path === "" ? "invoice: " : `invoice: ${error.path}: `;
		const message = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
		return { field: fieldKeyForPath(error.path), message };
	}
	return { field: "form", message: messageOf(error) };
}

/**
 * The icon gate's refusal, worded for the field it is shown under.
 *
 * The gate words its refusals as reasons with no namespace of this form's own — `invoice/model.ts` publishes one under the icon field's own `invoice: icon: ` prefix — so the reason reaches this field as it stands.
 * The result is bounded like every other message this form renders, because the gate's own message names the rejected value.
 */
function iconRefusalMessage(error: unknown): string {
	return boundMessage(messageOf(error), FIELD_MESSAGE_MAX);
}

/** The decision the icon field makes about the text a chosen file yields: the canonical SVG to store, or the message to show under the icon field. */
export type IconCheck =
	| { readonly ok: true; readonly svg: string }
	| { readonly ok: false; readonly message: string };

/**
 * Decide whether the text a chosen icon file yields is one the form may carry, as a value rather than by mutating the form, so the decision is testable without a browser.
 *
 * The icon gate is the one decider, so this helper keeps no bound of its own to hold in step with the gate's: `validateIcon` applies its raw code-unit bound to the text before it composes anything, canonicalizes the text that survives with `util/icon-canonical-text.ts`'s `canonicalIconText`, measures that canonical text against the byte cap with `util/icon-byte-length.ts`'s `iconByteLength`, and applies every other rule of its own, wording each refusal once.
 * The gate applies those bounds to the text whatever path reached this helper, so a direct caller cannot make it normalize an unbounded string or slip past the raw bound, and an icon whose file carries a trailing newline at the byte cap stays inside it.
 * The picker refuses a file the gate would accept where their two bounds disagree: the form bounds the file's bytes before decoding it while the gate bounds the decoded text's code units, so a file just past {@link MAX_ICON_FILE_BYTES} whose text decodes to at most `MAX_ICON_RAW_CODE_UNITS` code units is refused by the picker but accepted by the gate — which takes multibyte characters, since an all-ASCII file decodes to one code unit per byte — and the size check is therefore not redundant with the gate's raw bound.
 * The refusal the gate raises becomes this field's message through {@link iconRefusalMessage}, which bounds it like every other message the form renders.
 * A value that is not a string reaches the same call, whose own `TypeError` becomes this field's refusal through that same bounded reason — so a file read that answers something other than text is refused under the field rather than escaping as an unhandled rejection from the change handler that does not await it.
 * The DOM layer keeps the file's own declared-size pre-check, the file read, and the form mutation around this decision.
 */
export function checkIconText(text: unknown): IconCheck {
	try {
		return { ok: true, svg: validateIcon(text) };
	} catch (error) {
		return { ok: false, message: iconRefusalMessage(error) };
	}
}

/** The line index and control name an item field key such as `item-2-unitPrice` names, or `null` when the key scopes to something other than a line. */
function itemFieldParts(field: string): { readonly index: number; readonly name: string } | null {
	const match = /^item-(\d+)-(.+)$/.exec(field);
	if (match === null) return null;
	return { index: Number(match[1]), name: match[2] };
}

/**
 * An old-to-new line-index map for a structural edit, derived from object identity: each {@link ItemDraft} the state still holds maps to the index it now sits at, and one the state dropped maps to `null`.
 * Identity rather than position is what carries a moved line's errors to the row it now occupies, and a refused out-of-range move maps every index to itself.
 */
function indexRemap(before: readonly ItemDraft[], after: readonly ItemDraft[]): (oldIndex: number) => number | null {
	return (oldIndex) => {
		const item = before[oldIndex];
		if (item === undefined) return null;
		const at = after.indexOf(item);
		return at === -1 ? null : at;
	};
}

function fieldKeyForPath(path: string): string {
	const item = /^items\[(\d+)\]\.(description|quantity|unitPrice)$/.exec(path);
	if (item !== null) return `item-${item[1]}-${item[2]}`;
	const named: Record<string, string> = {
		id: "invoiceId",
		issued: "issued",
		due: "due",
		"payee.name": "payeeName",
		"payee.address": "payeeAddress",
		"payee.email": "payeeEmail",
		"payer.name": "payerName",
		asset: "asset",
		"tax.label": "taxLabel",
		"tax.rate": "taxRate",
		notes: "notes",
		icon: "icon",
		items: "items",
	};
	// Own properties only, so a field path that collides with an inherited Object.prototype member (for example "constructor") falls back to the generic form key rather than resolving through the prototype.
	return Object.hasOwn(named, path) ? named[path] : "form";
}

function isPositiveAmount(value: string, decimals: number): boolean {
	try {
		toBaseUnits(value, decimals);
		return true;
	} catch {
		return false;
	}
}

/**
 * Compute totals for the money fields alone.
 *
 * `computeTotalsFor` reads only `asset`, `items`, and `tax` from the fields it is handed — the identity and date fields never enter the arithmetic — so the preview passes those three and nothing else, rather than fabricating a payee the user has not finished entering.
 * `withTax` is off for a single line's amount, which the invoice tax must not inflate.
 */
function previewTotals(state: CreateFormState, items: readonly LineItem[], withTax = true): InvoiceTotals | null {
	const taxLabel = state.taxLabel.trim();
	try {
		return computeTotalsFor({
			asset: state.assetId,
			items,
			...(withTax && state.taxEnabled ? { tax: { label: taxLabel === "" ? "Tax" : taxLabel, rate: state.taxRate.trim() } } : {}),
		});
	} catch {
		return null;
	}
}

/**
 * The live subtotal/tax/total for the form, or `null` while any line is not yet a positive amount of the selected asset (the totals block shows a dash until the money is computable).
 */
export function liveTotals(state: CreateFormState): TotalsDisplay | null {
	const asset = requireAsset(state.assetId);
	const items: LineItem[] = [];
	for (const item of state.items) {
		const quantity = item.quantity.trim();
		const unitPrice = item.unitPrice.trim();
		if (!isPositiveAmount(quantity, asset.decimals) || !isPositiveAmount(unitPrice, asset.decimals)) {
			return null;
		}
		items.push({ description: item.description.trim(), quantity, unitPrice });
	}
	if (items.length === 0) return null;
	const totals = previewTotals(state, items);
	if (totals === null) return null;
	return Object.freeze({
		symbol: asset.symbol,
		subtotal: totals.subtotal.text,
		tax: state.taxEnabled ? totals.tax.text : null,
		total: totals.total.text,
	});
}

/** One line's amount in the selected asset, or `null` while its quantity or price is not yet valid. */
export function liveLineAmount(state: CreateFormState, index: number): string | null {
	const item = state.items[index];
	if (item === undefined) return null;
	const asset = requireAsset(state.assetId);
	const quantity = item.quantity.trim();
	const unitPrice = item.unitPrice.trim();
	if (!isPositiveAmount(quantity, asset.decimals) || !isPositiveAmount(unitPrice, asset.decimals)) return null;
	const totals = previewTotals(state, [{ description: item.description.trim(), quantity, unitPrice }], false);
	return totals === null ? null : totals.total.text;
}

/**
 * What the create form does with a submitted form, decided as data rather than thrown.
 *
 * Turning a valid form into a share link can still fail in ways the fields cannot show: the invoice is accepted by the model yet its canonical JSON is past the codec's {@link MAX_JSON_BYTES} cap, so no container can hold it; the asset's own registry entry builds a link past the byte budget of the largest QR symbol the payer's document draws, which `payment/links.ts`'s `requireLinkBudget` refuses; or building the container throws for some other reason.
 * Returning that decision as a value keeps the submit handler thin and makes the refusals this form can actually reach — the oversized invoice, since it advertises up to {@link MAX_ITEMS} lines of 500 characters each, and the link budget gate — testable without a browser.
 * The budget gate is applied here, where the share is handed out, rather than only where the registry is admitted, so an entry whose widest link outgrows the symbol is refused at the payee's own form instead of reaching the payer as a document that cannot render.
 * That refusal is classified by class rather than by message: `payment/links.ts`'s `PaymentLinkBudgetError` is the one a payee's own input can provoke, so it gets its own {@link ShareRefusal} kind and the one action that clears it, while every other throw keeps the generic failure.
 * No branch throws.
 */
export type ShareRefusal =
	| { readonly kind: "too-large"; readonly message: string }
	| { readonly kind: "link-too-large"; readonly message: string }
	| { readonly kind: "failed"; readonly message: string };

/** The outcome of a share attempt: a bundle to share, the fields to fix, or the refusal that stopped it. */
export type SharePlan =
	| { readonly kind: "ready"; readonly invoice: Invoice; readonly bundle: ShareBundle }
	| { readonly kind: "invalid"; readonly errors: readonly FieldError[] }
	| ShareRefusal;

/**
 * The payee-facing message for a link-budget refusal: the asset the form selected, and the one action that clears the refusal.
 *
 * Nothing the payee typed can change it — the gate measures the selected entry's own widest link rather than this invoice — so the message names the asset and leaves choosing a different one as the payee's move.
 */
function linkBudgetMessage(asset: Asset): string {
	return `This invoice cannot be shared: the payment link for ${asset.symbol} is longer than the invoice's QR code can carry. Choose a different asset, then try again.`;
}

/**
 * The refusal a failed share attempt reads as, decided by the error's class rather than by its message.
 *
 * A budget refusal is the one throw a payee's own input can provoke, so it is answered as the state it is; anything else is a fault this form cannot explain and is reported as one, with the underlying message clipped the way every other message reaching the page is.
 * Exported so the classification is testable without a registry entry that outgrows the symbol, which no shipped entry does.
 */
export function shareFailure(error: unknown, asset: Asset): ShareRefusal {
	if (error instanceof PaymentLinkBudgetError) {
		return { kind: "link-too-large", message: linkBudgetMessage(asset) };
	}
	return {
		kind: "failed",
		message: `The invoice could not be shared: ${boundMessage(messageOf(error), FIELD_MESSAGE_MAX)}`,
	};
}

/**
 * Decide a share attempt's outcome as a value — a ready bundle, invalid fields, or the refusal that stopped it — so the submit handler stays thin.
 *
 * The asset is resolved before the work below because the model has already validated that field: `parseFormState` accepts only an invoice `createInvoice` built, and that refuses an asset id the registry does not carry, so the lookup cannot throw and no branch of this function does.
 */
export function planShare(state: CreateFormState, baseUrl: string): SharePlan {
	const outcome = parseFormState(state);
	if (!outcome.ok) return { kind: "invalid", errors: outcome.errors };
	const asset = requireAsset(outcome.invoice.asset);
	try {
		const bytes = encodedJsonBytes(outcome.invoice);
		if (bytes > MAX_JSON_BYTES) return { kind: "too-large", message: tooLargeMessage(bytes) };
		// The entry's widest link is measured before the share is handed out: the refusal belongs to the payee's form, not to the payer's page.
		requireLinkBudget(asset);
		return { kind: "ready", invoice: outcome.invoice, bundle: buildShareBundle(outcome.invoice, baseUrl) };
	} catch (error) {
		return shareFailure(error, asset);
	}
}

function tooLargeMessage(bytes: number): string {
	return `This invoice is too large to share: its encoded form is ${bytes} bytes, past the ${MAX_JSON_BYTES}-byte share limit. Remove the optional icon — the largest field — or trim line items and descriptions, then try again.`;
}

/** How close a form is to the share cap, once it is valid enough to measure. */
export interface ShareSizeHint {
	readonly bytes: number;
	readonly limit: number;
	readonly fits: boolean;
}

/**
 * The size hint the form shows while editing: the encoded byte count and whether it fits the cap.
 * `null` while the form does not yet parse to a valid invoice, so nothing is measured or shown before there is a shareable invoice to measure.
 */
export function shareSizeHint(state: CreateFormState): ShareSizeHint | null {
	const outcome = parseFormState(state);
	if (!outcome.ok) return null;
	const bytes = encodedJsonBytes(outcome.invoice);
	return { bytes, limit: MAX_JSON_BYTES, fits: bytes <= MAX_JSON_BYTES };
}

/**
 * The forms each family's addresses take, read from the validators that decide them: `wallet/address.ts`, `wallet/zcash-address.ts` and `wallet/monero-address.ts` each state their own accepted forms as one list.
 *
 * The map is exhaustive by type, so adding a family to `AssetFamily` is a compile error until it is given its forms here — a decision rather than a silently empty hint — and the placeholder and guidance below are composed from these entries rather than from a wording of their own, so a hint cannot name a form its validator refuses or miss one it accepts, nor spell the EVM family's form apart from the validator that reads it.
 */
const PAYOUT_ADDRESS_FORMS: Record<AssetFamily, readonly PayoutAddressForm[]> = {
	evm: EVM_ADDRESS_FORMS,
	zcash: ZCASH_ADDRESS_FORMS,
	monero: MONERO_ADDRESS_FORMS,
};

/**
 * The spellings a family's forms lead with, deduplicated in the order its validator states them.
 *
 * A form may lead with more than one spelling — the transparent Zcash address with `t1` and `t3` — and those are one entry of the hint's list, so a form's spellings are joined under the form rather than listed apart; two forms that share a spelling, as the integrated Monero address shares the standard one's `4`, are named once.
 */
function formSpellings(forms: readonly PayoutAddressForm[]): readonly string[] {
	const spellings: string[] = [];
	for (const form of forms) {
		const spelling = form.prefixes.join("/");
		if (!spellings.includes(spelling)) spellings.push(spelling);
	}
	return spellings;
}

/** Join `parts` as an English list — `a, b, or c`, `a or b` for a pair, and `a` alone when there is one — which is the shape both hints read in. */
function orList(parts: readonly string[]): string {
	const last = parts[parts.length - 1] ?? "";
	if (parts.length <= 1) return last;
	const head = parts.slice(0, -1).join(", ");
	return parts.length === 2 ? `${head} or ${last}` : `${head}, or ${last}`;
}

/**
 * The family `asset` belongs to as one of the families this app carries, or `null` for an asset that states a name it does not.
 *
 * The family is read through `assets/registry.ts`'s `assetFamily` — the resolution `wallet/payout-address.ts`'s dispatcher applies — so an asset that states no family is the default EVM one for this form exactly as it is for the validator that reads what the form holds.
 * The name is then judged by that module's `isAssetFamily`, the one statement of which names a family, so this hint and the registry's load-time gate cannot disagree about that: a name the gate refuses leaves this form showing no family-specific text rather than a value that means nothing, an inherited `Object.prototype` member such as `"constructor"` included.
 */
function payoutFamily(asset: Asset): AssetFamily | null {
	const family = assetFamily(asset);
	return isAssetFamily(family) ? family : null;
}

/**
 * The placeholder the payout-address field shows for `asset`'s family, and no placeholder at all for a family this file does not carry.
 *
 * The field's placeholder is what tells a payee which spelling to paste, and the families do not share one: an EVM address is an `0x` string while a privacy-chain address is an address in that chain's own encoding, so one EVM-shaped placeholder would point a Zcash or Monero payee at the wrong form.
 * Every spelling comes from the family's own validator through {@link PAYOUT_ADDRESS_FORMS}, so a form the placeholder names is one a paste in it is accepted by; the family comes from {@link payoutFamily}, so the asset the dispatcher validates by the default EVM rules shows the EVM forms here.
 */
export function payoutAddressPlaceholder(asset: Asset): string {
	const family = payoutFamily(asset);
	return family === null ? "" : orList(formSpellings(PAYOUT_ADDRESS_FORMS[family]).map((spelling) => `${spelling}…`));
}

/**
 * The guidance the payout-address field shows per family: what a family whose addresses carry no EIP-55 checksum expects instead, and `null` for the EVM family, which its placeholder and its checksum caution already cover.
 *
 * The map is exhaustive by type, exactly as {@link PAYOUT_ADDRESS_FORMS} is: adding a family to `AssetFamily` is a compile error until it is given a guidance decision here, so a new family forces an explicit choice — a sentence naming its forms, or a deliberate `null` — rather than silently shipping a placeholder with no guidance and no checksum caution.
 * Each sentence is composed from the family's own form list, so it names every form `wallet/zcash-address.ts` or `wallet/monero-address.ts` accepts and only those: a payee who pasted an address the validator takes must not be told by the hint that its shape is wrong, and a form the validator refuses must not be held out as one to paste.
 */
const PAYOUT_ADDRESS_GUIDANCE: Record<AssetFamily, ((forms: readonly PayoutAddressForm[]) => string) | null> = {
	evm: null,
	zcash: (forms) => `This invoice pays to a mainnet Zcash address: a ${orList(forms.map((form) => `${form.name} (${form.prefixes.join("/")})`))} form.`,
	monero: (forms) => `This invoice pays to a mainnet Monero address: ${orList(forms.map((form) => `a ${form.characters}-character ${form.name} beginning with ${form.prefixes[0]}`))}.`,
};

/**
 * The guidance the payout-address field shows for `asset`'s family, or `null` for the EVM family and for a family this file does not carry.
 *
 * A privacy-chain payee has no EIP-55 checksum to be cautioned about — {@link payoutAddressWarning} cautions about a mistyped `0x` address — so the slot carries what the family does expect instead, rather than an EVM instruction for an asset that cannot receive one.
 * The family comes from {@link payoutFamily}, so a family-less asset is treated as the EVM one here as it is by the dispatcher that validates its address, and a name this app carries no rules for resolves to `null` and shows no guidance.
 */
export function payoutAddressGuidance(asset: Asset): string | null {
	const family = payoutFamily(asset);
	if (family === null) return null;
	const sentence = PAYOUT_ADDRESS_GUIDANCE[family];
	return sentence === null ? null : sentence(PAYOUT_ADDRESS_FORMS[family]);
}

/**
 * The non-blocking caution shown under the payout address when an EVM asset's entered address is uniformly cased.
 *
 * EIP-55 catches a mistyped character only in a mixed-case address; a uniformly-cased address carries no checksum, so nothing verifies it — yet {@link parseFormState} accepts one and the model stores the checksummed spelling, which every display then shows as if verified.
 * This names the gap where the raw text still exists: the payee is cautioned as they type, before the address is folded to its checksummed form.
 * The caution is about an EVM `0x` address's checksum alone, so a family whose addresses carry no EIP-55 checksum gets `null` and shows {@link payoutAddressGuidance} in its place.
 * The family comes from {@link payoutFamily}, so an asset that states no family is cautioned here exactly as the dispatcher validates it, by the EVM rules.
 * Returns `null` for a mixed-case address with a valid checksum, for an empty or malformed field, and for a wrong checksum (that is reported by the model on submit, not as a caution).
 */
export function payoutAddressWarning(address: string, asset: Asset): string | null {
	if (payoutFamily(asset) !== "evm") return null;
	if (checksumStatus(address.trim()) !== "unverifiable") return null;
	return "This payout address is all one case, so it carries no EIP-55 checksum and a mistyped character would not be caught. Paste the checksummed (mixed-case) spelling to verify it.";
}

type FormControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/**
 * Render the create view and wire it to the form state.
 *
 * The DOM is built once; typing only updates the totals text, the line-amount cells, and the share-size note, never re-rendering the form.
 * Structural edits — add, remove, reorder — rebuild the item rows from the state.
 */
export function renderCreateView(options: CreateViewOptions): HTMLElement {
	let state = emptyFormState(options.today);
	const errorsByKey = new Map<string, HTMLElement>();
	const amountCells: HTMLElement[] = [];
	let shownErrors: readonly FieldError[] = [];
	// The most recent icon pick: a read that settles after a later pick takes the form's icon only while its own token is still current.
	let iconSelection = 0;

	const errorSummary = h("div", { class: "error-summary", role: "alert", hidden: true });
	const payeeName = h("input", { type: "text", name: "payeeName", value: state.payeeName, placeholder: "Acme Studio" });
	const payeeAddress = h("input", { type: "text", name: "payeeAddress", value: state.payeeAddress, placeholder: payoutAddressPlaceholder(requireAsset(state.assetId)) });
	// Its single child changes in place, so the node stays mounted: an empty caution is hidden rather than removed.
	const payoutWarning = h("p", { class: "field-warning", role: "status", hidden: true }, "");
	const payeeEmail = h("input", { type: "text", name: "payeeEmail", value: state.payeeEmail, placeholder: "billing@example.com" });
	const invoiceId = h("input", { type: "text", name: "invoiceId", value: state.invoiceId, placeholder: "INV-0001" });
	const issued = h("input", { type: "text", name: "issued", value: state.issued, placeholder: "YYYY-MM-DD" });
	const due = h("input", { type: "text", name: "due", value: state.due, placeholder: "YYYY-MM-DD (optional)" });
	const payerName = h("input", { type: "text", name: "payerName", value: state.payerName, placeholder: "Client name (optional)" });
	const assetSelect = h(
		"select",
		{ name: "asset" },
		...ASSETS.map((asset) => h("option", { value: asset.id, selected: asset.id === state.assetId }, `${asset.symbol} — ${asset.name}`)),
	);
	const notes = h("textarea", { name: "notes", placeholder: "Payment terms, thank you note…" }, state.notes);
	const iconInput = h("input", { type: "file", name: "icon", accept: "image/svg+xml,.svg" });
	const iconPreview = h("div", { class: "icon-preview-slot" });
	const iconRemove = h("button", { type: "button", class: "btn btn-secondary", hidden: true }, "Remove icon");

	const taxToggle = h("input", { id: "tax-enabled", type: "checkbox", name: "taxEnabled", checked: state.taxEnabled });
	const taxLabel = h("input", { type: "text", name: "taxLabel", value: state.taxLabel, placeholder: "Tax" });
	const taxRate = h("input", { type: "text", name: "taxRate", value: state.taxRate, placeholder: "e.g. 19" });
	const taxFields = h(
		"div",
		{ class: "field-row", hidden: !state.taxEnabled },
		fieldGroup("tax-label", "Tax label", taxLabel, errorsByKey, "taxLabel"),
		fieldGroup("tax-rate", "Tax rate %", taxRate, errorsByKey, "taxRate"),
	);

	const tbody = h("tbody");
	const addButton = h("button", { type: "button", class: "btn btn-secondary" }, "Add line");
	const subtotalText = h("span", { class: "totals-value" }, "—");
	const taxText = h("span", { class: "totals-value" }, "—");
	const totalText = h("span", { class: "totals-value" }, "—");
	const taxRow = h("tr", { class: "totals-row", hidden: true }, h("th", { scope: "row" }, "Tax"), h("td", {}, taxText));
	const shareSizeNote = h("p", { class: "field-hint share-size" }, "");
	// The created invoice's section, drawn in this view rather than only in the share dialog: a payee who has just built an invoice can pay it, or copy its link, address, and amount, without opening their own share link.
	const createdPayment = h("div", { class: "created-payment", hidden: true });

	function syncTotals(): void {
		const symbol = requireAsset(state.assetId).symbol;
		amountCells.forEach((cell, index) => {
			const amount = liveLineAmount(state, index);
			cell.textContent = amount === null ? "—" : `${amount} ${symbol}`;
		});
		const totals = liveTotals(state);
		if (totals === null) {
			subtotalText.textContent = "—";
			totalText.textContent = "—";
			taxRow.setAttribute("hidden", "");
			return;
		}
		subtotalText.textContent = `${totals.subtotal} ${totals.symbol}`;
		totalText.textContent = `${totals.total} ${totals.symbol}`;
		if (totals.tax === null) {
			taxRow.setAttribute("hidden", "");
			return;
		}
		taxRow.removeAttribute("hidden");
		taxText.textContent = `${totals.tax} ${totals.symbol}`;
	}

	function syncShareSize(): void {
		const hint = shareSizeHint(state);
		if (hint === null) {
			shareSizeNote.textContent = "";
			shareSizeNote.setAttribute("class", "field-hint share-size");
			return;
		}
		shareSizeNote.textContent = hint.fits
			? `Encoded size: ${hint.bytes} of ${hint.limit} bytes of JSON; the share link carries about 1.6 characters per byte, and the optional icon is the largest field.`
			: `Encoded size: ${hint.bytes} bytes — over the ${hint.limit}-byte share limit. Remove the optional icon — the largest field — or trim line items and descriptions.`;
		shareSizeNote.setAttribute("class", hint.fits ? "field-hint share-size" : "field-error share-size");
	}

	function syncPayoutWarning(): void {
		const asset = requireAsset(state.assetId);
		const guidance = payoutAddressGuidance(asset);
		const message = guidance ?? payoutAddressWarning(state.payeeAddress, asset);
		if (message === null) {
			payoutWarning.textContent = "";
			payoutWarning.setAttribute("hidden", "");
			return;
		}
		payoutWarning.textContent = message;
		payoutWarning.setAttribute("class", guidance === null ? "field-warning" : "field-hint");
		payoutWarning.removeAttribute("hidden");
	}

	/** Draw the icon the form currently carries, or empty the slot when it carries none. */
	function syncIconPreview(): void {
		if (state.iconSvg === "") {
			iconPreview.replaceChildren();
			iconRemove.setAttribute("hidden", "");
			return;
		}
		iconPreview.replaceChildren(h("img", { class: "icon-preview", src: svgDataUrl(state.iconSvg), alt: "" }));
		iconRemove.removeAttribute("hidden");
	}

	/**
	 * Show the icon field's own message, or clear it, without disturbing the other fields.
	 *
	 * A file refused at the input is reported under its own field rather than through `showErrors`: the rest of the form is not being re-checked, so a message already shown beside another field stays where it is.
	 */
	function showIconError(message: string): void {
		const element = errorsByKey.get("icon");
		if (element === undefined) return;
		element.textContent = boundMessage(message, FIELD_MESSAGE_MAX);
		element.removeAttribute("hidden");
	}

	/**
	 * Refuse a pick under the icon field, clearing the input's own value as it does.
	 *
	 * An engine fires `change` only for a selection that differs from the input's current value, so a value left standing by a refused pick keeps the same file from being chosen again, and the only other control that clears it is the removal button, which is hidden while the form carries no icon.
	 * Clearing the value here is what makes the refusal retryable; the picker replaces it on the next pick either way, so no part of the form reads it.
	 */
	function refuseIconPick(message: string): void {
		iconInput.value = "";
		showIconError(message);
	}

	function clearIconError(): void {
		const element = errorsByKey.get("icon");
		if (element === undefined) return;
		element.textContent = "";
		element.setAttribute("hidden", "");
	}

	/**
	 * Read the payee's chosen file, check it in place, and store it.
	 *
	 * The file is refused on its own declared size before it is read at all, so one far past {@link MAX_ICON_FILE_BYTES} is never decoded, and the text it yields is then decided by {@link checkIconText}, which hands the text to the icon gate: the gate's raw code-unit bound, its byte cap on the trimmed, NFC-composed value, and the reason it raises are the field's.
	 * Each pick claims the form's own selection token before its read and answers only while that token is still current, so two overlapping picks resolve in pick order and the last pick wins rather than whichever read settles last; a later pick or a removal that bumps the token makes this read stale, and a stale read applies neither its failure nor its success.
	 * A refusal leaves the form's icon — and so the invoice the form would build — exactly as it was, clears the input through {@link refuseIconPick} so the refused file can be chosen again, and a file that passes is stored as the gate's own canonical text.
	 */
	async function applyIconFile(file: File): Promise<void> {
		const selection = (iconSelection += 1);
		if (file.size > MAX_ICON_FILE_BYTES) {
			refuseIconPick(iconFileSizeRefusal(file.size));
			return;
		}
		let text: string;
		try {
			text = await file.text();
		} catch (error) {
			// A later pick or a removal has already answered, so this read's failure is stale: reporting it would paint an error for a pick the form no longer stands behind.
			if (selection !== iconSelection) return;
			refuseIconPick(`The icon file could not be read: ${boundMessage(messageOf(error), FIELD_MESSAGE_MAX)}`);
			return;
		}
		// A later pick or a removal has already answered, so this read is stale: applying it would overwrite the newer icon.
		if (selection !== iconSelection) return;
		const check = checkIconText(text);
		if (!check.ok) {
			refuseIconPick(check.message);
			return;
		}
		state.iconSvg = check.svg;
		clearIconError();
		syncIconPreview();
		sync();
	}

	/** Draw the invoice the form just created into this view, through the section the payer's document draws beside it. */
	function showCreatedPayment(invoice: Invoice): void {
		createdPayment.replaceChildren(renderPaymentSection(buildInvoiceViewModel(invoice, options.today), options.clipboard ?? null));
		createdPayment.removeAttribute("hidden");
	}

	function sync(): void {
		syncTotals();
		syncShareSize();
	}

	function showErrors(errors: readonly FieldError[]): void {
		shownErrors = errors;
		for (const element of errorsByKey.values()) {
			element.textContent = "";
			element.setAttribute("hidden", "");
		}
		if (errors.length === 0) {
			errorSummary.replaceChildren();
			errorSummary.setAttribute("hidden", "");
			return;
		}
		errorSummary.replaceChildren(h("ul", { class: "error-list" }, ...errors.map((error) => h("li", {}, boundMessage(error.message, FIELD_MESSAGE_MAX)))));
		errorSummary.removeAttribute("hidden");
		for (const error of errors) {
			const element = errorsByKey.get(error.field);
			if (element !== undefined) {
				element.textContent = boundMessage(error.message, FIELD_MESSAGE_MAX);
				element.removeAttribute("hidden");
			}
		}
	}

	function rebuildItems(remap: (oldIndex: number) => number | null): void {
		amountCells.length = 0;
		for (const key of [...errorsByKey.keys()]) {
			if (itemFieldParts(key) !== null) errorsByKey.delete(key);
		}
		const rows = state.items.map((item, index) => {
			const built = buildItemRow(item, index, errorsByKey, sync, () => {
				replaceItems(removeItem(state, index));
			}, () => {
				replaceItems(moveItem(state, index, -1));
			}, () => {
				replaceItems(moveItem(state, index, 1));
			});
			amountCells.push(built.amount);
			return built.row;
		});
		tbody.replaceChildren(...rows);
		if (canAddItem(state)) {
			addButton.removeAttribute("disabled");
		} else {
			addButton.setAttribute("disabled", "");
		}
		carryItemErrors(remap);
	}

	function replaceItems(next: CreateFormState): void {
		const before = state.items;
		state = next;
		rebuildItems(indexRemap(before, state.items));
		sync();
	}

	// Rebuilding the rows replaces their inline error elements, so every shown item error is re-applied with its key remapped to the line's new index; only a line the state no longer holds loses its error.
	function carryItemErrors(remap: (oldIndex: number) => number | null): void {
		let sawItemError = false;
		const carried: FieldError[] = [];
		for (const error of shownErrors) {
			const parts = itemFieldParts(error.field);
			if (parts === null) {
				carried.push(error);
				continue;
			}
			sawItemError = true;
			const next = remap(parts.index);
			if (next === null) continue;
			carried.push(next === parts.index ? error : { field: `item-${next}-${parts.name}`, message: error.message });
		}
		if (sawItemError) showErrors(carried);
	}

	bind(payeeName, () => {
		state.payeeName = payeeName.value;
	});
	bind(payeeAddress, () => {
		state.payeeAddress = payeeAddress.value;
		syncPayoutWarning();
	});
	bind(payeeEmail, () => {
		state.payeeEmail = payeeEmail.value;
	});
	bind(invoiceId, () => {
		state.invoiceId = invoiceId.value;
	});
	bind(issued, () => {
		state.issued = issued.value;
	});
	bind(due, () => {
		state.due = due.value;
	});
	bind(payerName, () => {
		state.payerName = payerName.value;
	});
	bind(notes, () => {
		state.notes = notes.value;
		sync();
	});
	iconInput.addEventListener("change", () => {
		const file = iconInput.files?.[0];
		if (file === undefined) return;
		void applyIconFile(file);
	});
	iconRemove.addEventListener("click", () => {
		// The removal is the form's latest answer, so any in-flight pick is stale and must not re-apply the icon the user just cleared.
		iconSelection += 1;
		state.iconSvg = "";
		iconInput.value = "";
		clearIconError();
		syncIconPreview();
		sync();
	});
	bind(taxLabel, () => {
		state.taxLabel = taxLabel.value;
		sync();
	});
	bind(taxRate, () => {
		state.taxRate = taxRate.value;
		sync();
	});
	assetSelect.addEventListener("change", () => {
		if (isSupportedAsset(assetSelect.value)) {
			state.assetId = assetSelect.value;
			payeeAddress.setAttribute("placeholder", payoutAddressPlaceholder(requireAsset(state.assetId)));
			syncPayoutWarning();
			sync();
		}
	});
	taxToggle.addEventListener("change", () => {
		state.taxEnabled = taxToggle.checked;
		if (state.taxEnabled) {
			taxFields.removeAttribute("hidden");
		} else {
			taxFields.setAttribute("hidden", "");
		}
		sync();
	});
	addButton.addEventListener("click", () => {
		replaceItems(addItem(state));
	});

	const form = h(
		"form",
		{ class: "create-form" },
		h(
			"fieldset",
			{ class: "form-section" },
			h("legend", {}, "Your details and asset"),
			fieldGroup("payee-name", "Payee name", payeeName, errorsByKey, "payeeName"),
			fieldGroup("asset", "Asset", assetSelect, errorsByKey, "asset"),
			fieldGroup("payee-address", "Payout address", payeeAddress, errorsByKey, "payeeAddress", "The address this invoice pays to."),
			payoutWarning,
			fieldGroup("payee-email", "Contact email (optional)", payeeEmail, errorsByKey, "payeeEmail"),
		),
		h(
			"fieldset",
			{ class: "form-section" },
			h("legend", {}, "Brand icon (optional)"),
			fieldGroup("icon", "Icon", iconInput, errorsByKey, "icon", `An SVG up to ${MAX_ICON_SVG_BYTES} bytes and ${MAX_ICON_DIMENSION}×${MAX_ICON_DIMENSION} pixels. It is carried in the share link and never fetched.`),
			iconPreview,
			iconRemove,
		),
		h(
			"fieldset",
			{ class: "form-section" },
			h("legend", {}, "Invoice details"),
			fieldGroup("invoice-id", "Invoice number", invoiceId, errorsByKey, "invoiceId"),
			fieldGroup("issued", "Issue date", issued, errorsByKey, "issued", "YYYY-MM-DD"),
			fieldGroup("due", "Due date (optional)", due, errorsByKey, "due", "YYYY-MM-DD"),
		),
		h(
			"fieldset",
			{ class: "form-section" },
			h("legend", {}, "Bill to (optional)"),
			fieldGroup("payer-name", "Client name", payerName, errorsByKey, "payerName"),
		),
		h(
			"fieldset",
			{ class: "form-section" },
			h("legend", {}, "Line items"),
			h(
				"table",
				{ class: "items-table" },
				h(
					"thead",
					{},
					h(
						"tr",
						{},
						h("th", { scope: "col" }, "Description"),
						h("th", { scope: "col" }, "Qty"),
						h("th", { scope: "col" }, "Unit price"),
						h("th", { scope: "col" }, "Amount"),
						h("th", { scope: "col" }, ""),
					),
				),
				tbody,
			),
			addButton,
			h("p", { class: "field-hint" }, `Up to ${MAX_ITEMS} lines; the encoded invoice must fit the ${MAX_JSON_BYTES / 1024} KiB share limit.`),
		),
		h(
			"fieldset",
			{ class: "form-section" },
			h("legend", {}, "Tax and notes"),
			h("div", { class: "field field-inline" }, taxToggle, h("label", { for: "tax-enabled" }, "Add tax")),
			taxFields,
			fieldGroup("notes", "Notes and terms (optional)", notes, errorsByKey, "notes"),
		),
		errorSummary,
		h(
			"div",
			{ class: "totals" },
			h(
				"table",
				{ class: "totals-table" },
				h(
					"tbody",
					{},
					h("tr", { class: "totals-row" }, h("th", { scope: "row" }, "Subtotal"), h("td", {}, subtotalText)),
					taxRow,
					h("tr", { class: "totals-row totals-total" }, h("th", { scope: "row" }, "Total"), h("td", {}, totalText)),
				),
			),
		),
		shareSizeNote,
		h("div", { class: "form-actions" }, h("button", { type: "submit", class: "btn btn-primary" }, "Create share link")),
	);

	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const plan = planShare(state, options.baseUrl);
		if (plan.kind === "invalid") {
			showErrors(plan.errors);
			options.notice.showNotice("Please fix the highlighted fields.", "error");
			return;
		}
		showErrors([]);
		if (plan.kind !== "ready") {
			options.notice.showNotice(plan.message, "error");
			return;
		}
		options.notice.clearNotice();
		showCreatedPayment(plan.invoice);
		openShareDialog(plan.bundle, { clipboard: options.clipboard ?? null });
		options.notice.showNotice(`Invoice ${plan.invoice.id} is ready to share.`, "success");
	});

	rebuildItems((index) => index);
	sync();
	syncPayoutWarning();
	syncIconPreview();

	return h(
		"section",
		{ class: "view view-create" },
		h("h1", { class: "view-title" }, "Create an invoice"),
		h("p", { class: "view-intro" }, "Fill in your details and line items. Totals update as you type; the share link stays on this device."),
		form,
		createdPayment,
	);
}

interface BuiltRow {
	readonly row: HTMLElement;
	readonly amount: HTMLElement;
}

function buildItemRow(
	item: ItemDraft,
	index: number,
	errors: Map<string, HTMLElement>,
	sync: () => void,
	onRemove: () => void,
	onUp: () => void,
	onDown: () => void,
): BuiltRow {
	const description = h("input", { type: "text", name: `item-${index}-description`, value: item.description, placeholder: "Design work" });
	const quantity = h("input", { type: "text", name: `item-${index}-quantity`, value: item.quantity, placeholder: "1" });
	const unitPrice = h("input", { type: "text", name: `item-${index}-unitPrice`, value: item.unitPrice, placeholder: "0.00" });
	bind(description, () => {
		item.description = description.value;
		sync();
	});
	bind(quantity, () => {
		item.quantity = quantity.value;
		sync();
	});
	bind(unitPrice, () => {
		item.unitPrice = unitPrice.value;
		sync();
	});

	const amount = h("span", { class: "line-amount" }, "—");
	const up = h("button", { type: "button", class: "btn-icon", title: "Move line up", "aria-label": "Move line up", disabled: index === 0 }, "↑");
	const down = h("button", { type: "button", class: "btn-icon", title: "Move line down", "aria-label": "Move line down" }, "↓");
	const remove = h("button", { type: "button", class: "btn-icon", title: "Remove line", "aria-label": "Remove line" }, "×");
	up.addEventListener("click", onUp);
	down.addEventListener("click", onDown);
	remove.addEventListener("click", onRemove);

	const descriptionError = h("p", { class: "field-error", hidden: true }, "");
	const quantityError = h("p", { class: "field-error", hidden: true }, "");
	const unitPriceError = h("p", { class: "field-error", hidden: true }, "");
	errors.set(`item-${index}-description`, descriptionError);
	errors.set(`item-${index}-quantity`, quantityError);
	errors.set(`item-${index}-unitPrice`, unitPriceError);

	return {
		row: h(
			"tr",
			{},
			h("td", {}, description, descriptionError),
			h("td", {}, quantity, quantityError),
			h("td", {}, unitPrice, unitPriceError),
			h("td", { class: "cell-amount" }, amount),
			h("td", { class: "cell-actions" }, up, down, remove),
		),
		amount,
	};
}

function fieldGroup(
	id: string,
	labelText: string,
	control: FormControl,
	errors: Map<string, HTMLElement>,
	key: string,
	hint?: string,
): HTMLElement {
	control.setAttribute("id", id);
	control.setAttribute("aria-describedby", `${id}-error`);
	const error = h("p", { class: "field-error", id: `${id}-error`, role: "alert", hidden: true });
	errors.set(key, error);
	return h(
		"div",
		{ class: "field" },
		h("label", { for: id }, labelText),
		control,
		hint === undefined ? null : h("p", { class: "field-hint" }, hint),
		error,
	);
}

function bind(control: FormControl, onChange: () => void): void {
	control.addEventListener("input", onChange);
	control.addEventListener("change", onChange);
}
