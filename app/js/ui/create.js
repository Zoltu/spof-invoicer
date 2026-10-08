/**
 * The payee's create-invoice view.
 *
 * The view is split in two layers so most of it is testable without a browser: the pure form state and its mapping to a validated {@link Invoice} live in the exported helpers at the top, and the DOM building at the bottom only wires those helpers to inputs.
 * Every rendered string — a field value, a validation message, a share payload — reaches the page as a text child of `util/dom.ts`'s `h()`, so nothing a user or a share link supplies can become markup.
 */
import { ASSETS, isSupportedAsset, requireAsset } from "../assets/registry.js";
import { MAX_JSON_BYTES, encodedJsonBytes } from "../invoice/codec.js";
import { InvalidInvoiceError, MAX_ITEMS, computeTotalsFor, createInvoice, } from "../invoice/model.js";
import { toBaseUnits } from "../util/decimal.js";
import { h } from "../util/dom.js";
import { boundMessage, messageOf } from "../util/errors.js";
import { checksumStatus } from "../wallet/address.js";
import { buildShareBundle, openShareDialog } from "./share.js";
/**
 * Upper bound on a field or summary error's rendered length, matching the shell notice's own bound.
 * A model message can embed the rejected value, so the same defensive clip the notice applies is applied here before any error reaches the DOM.
 */
const FIELD_MESSAGE_MAX = 300;
/** A fresh, empty line with a sensible starting quantity. */
export function emptyItem() {
    return { description: "", quantity: "1", unitPrice: "" };
}
/** A blank form for `today` (a `YYYY-MM-DD` date), with one line and today's default invoice number. */
export function emptyFormState(today) {
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
    };
}
/** True while another line may be added; the editor stops at {@link MAX_ITEMS}. */
export function canAddItem(state) {
    return state.items.length < MAX_ITEMS;
}
/** Append a blank line, unless the invoice already holds {@link MAX_ITEMS}. */
export function addItem(state) {
    if (!canAddItem(state))
        return state;
    return { ...state, items: [...state.items, emptyItem()] };
}
/** Drop one line; removing the last line leaves a single blank one so the editor is never empty. */
export function removeItem(state, index) {
    if (index < 0 || index >= state.items.length)
        return state;
    const items = state.items.filter((_, at) => at !== index);
    return { ...state, items: items.length === 0 ? [emptyItem()] : items };
}
/** Move one line by `delta` places; an out-of-range move leaves the state untouched. */
export function moveItem(state, index, delta) {
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
export function invoiceInputFromState(state) {
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
            // The address is untrusted form text; createInvoice validates and checksums it.
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
    };
}
/**
 * Validate the form into an invoice.
 *
 * Cheap required-field checks run first so several empty fields surface together; anything the model alone can judge (formats, money, the payout address) is then reported through its own error, bound to the field path it names.
 */
export function parseFormState(state) {
    const errors = requiredFieldErrors(state);
    if (errors.length > 0) {
        return { ok: false, errors };
    }
    try {
        return { ok: true, invoice: createInvoice(invoiceInputFromState(state)) };
    }
    catch (error) {
        return { ok: false, errors: [fieldErrorFor(error)] };
    }
}
function requiredFieldErrors(state) {
    const errors = [];
    if (state.payeeName.trim() === "")
        errors.push({ field: "payeeName", message: "Payee name is required" });
    if (state.payeeAddress.trim() === "")
        errors.push({ field: "payeeAddress", message: "Payout address is required" });
    if (state.invoiceId.trim() === "")
        errors.push({ field: "invoiceId", message: "Invoice number is required" });
    if (state.issued.trim() === "")
        errors.push({ field: "issued", message: "Issue date is required" });
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
function fieldErrorFor(error) {
    if (error instanceof InvalidInvoiceError) {
        const prefix = error.path === "" ? "invoice: " : `invoice: ${error.path}: `;
        const message = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
        return { field: fieldKeyForPath(error.path), message };
    }
    return { field: "form", message: messageOf(error) };
}
/** The line index and control name an item field key such as `item-2-unitPrice` names, or `null` when the key scopes to something other than a line. */
function itemFieldParts(field) {
    const match = /^item-(\d+)-(.+)$/.exec(field);
    if (match === null)
        return null;
    return { index: Number(match[1]), name: match[2] };
}
/**
 * An old-to-new line-index map for a structural edit, derived from object identity: each {@link ItemDraft} the state still holds maps to the index it now sits at, and one the state dropped maps to `null`.
 * Identity rather than position is what carries a moved line's errors to the row it now occupies, and a refused out-of-range move maps every index to itself.
 */
function indexRemap(before, after) {
    return (oldIndex) => {
        const item = before[oldIndex];
        if (item === undefined)
            return null;
        const at = after.indexOf(item);
        return at === -1 ? null : at;
    };
}
function fieldKeyForPath(path) {
    const item = /^items\[(\d+)\]\.(description|quantity|unitPrice)$/.exec(path);
    if (item !== null)
        return `item-${item[1]}-${item[2]}`;
    const named = {
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
        items: "items",
    };
    // Own properties only, so a field path that collides with an inherited Object.prototype member (for example "constructor") falls back to the generic form key rather than resolving through the prototype.
    return Object.hasOwn(named, path) ? named[path] : "form";
}
function isPositiveAmount(value, decimals) {
    try {
        toBaseUnits(value, decimals);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Compute totals for the money fields alone.
 *
 * `computeTotalsFor` reads only `asset`, `items`, and `tax` from the fields it is handed — the identity and date fields never enter the arithmetic — so the preview passes those three and nothing else, rather than fabricating a payee the user has not finished entering.
 * `withTax` is off for a single line's amount, which the invoice tax must not inflate.
 */
function previewTotals(state, items, withTax = true) {
    const taxLabel = state.taxLabel.trim();
    try {
        return computeTotalsFor({
            asset: state.assetId,
            items,
            ...(withTax && state.taxEnabled ? { tax: { label: taxLabel === "" ? "Tax" : taxLabel, rate: state.taxRate.trim() } } : {}),
        });
    }
    catch {
        return null;
    }
}
/**
 * The live subtotal/tax/total for the form, or `null` while any line is not yet a positive amount of the selected asset (the totals block shows a dash until the money is computable).
 */
export function liveTotals(state) {
    const asset = requireAsset(state.assetId);
    const items = [];
    for (const item of state.items) {
        const quantity = item.quantity.trim();
        const unitPrice = item.unitPrice.trim();
        if (!isPositiveAmount(quantity, asset.decimals) || !isPositiveAmount(unitPrice, asset.decimals)) {
            return null;
        }
        items.push({ description: item.description.trim(), quantity, unitPrice });
    }
    if (items.length === 0)
        return null;
    const totals = previewTotals(state, items);
    if (totals === null)
        return null;
    return Object.freeze({
        symbol: asset.symbol,
        subtotal: totals.subtotal.text,
        tax: state.taxEnabled ? totals.tax.text : null,
        total: totals.total.text,
    });
}
/** One line's amount in the selected asset, or `null` while its quantity or price is not yet valid. */
export function liveLineAmount(state, index) {
    const item = state.items[index];
    if (item === undefined)
        return null;
    const asset = requireAsset(state.assetId);
    const quantity = item.quantity.trim();
    const unitPrice = item.unitPrice.trim();
    if (!isPositiveAmount(quantity, asset.decimals) || !isPositiveAmount(unitPrice, asset.decimals))
        return null;
    const totals = previewTotals(state, [{ description: item.description.trim(), quantity, unitPrice }], false);
    return totals === null ? null : totals.total.text;
}
/** Decide a share attempt's outcome as a value — a ready bundle, invalid fields, a too-large invoice, or a failure — so the submit handler stays thin. */
export function planShare(state, baseUrl) {
    const outcome = parseFormState(state);
    if (!outcome.ok)
        return { kind: "invalid", errors: outcome.errors };
    try {
        const bytes = encodedJsonBytes(outcome.invoice);
        if (bytes > MAX_JSON_BYTES)
            return { kind: "too-large", message: tooLargeMessage(bytes) };
        return { kind: "ready", invoice: outcome.invoice, bundle: buildShareBundle(outcome.invoice, baseUrl) };
    }
    catch (error) {
        return {
            kind: "failed",
            message: `The invoice could not be shared: ${boundMessage(messageOf(error), FIELD_MESSAGE_MAX)}`,
        };
    }
}
function tooLargeMessage(bytes) {
    return `This invoice is too large to share: its encoded form is ${bytes} bytes, past the ${MAX_JSON_BYTES}-byte share limit. Remove line items or shorten descriptions, then try again.`;
}
/**
 * The size hint the form shows while editing: the encoded byte count and whether it fits the cap.
 * `null` while the form does not yet parse to a valid invoice, so nothing is measured or shown before there is a shareable invoice to measure.
 */
export function shareSizeHint(state) {
    const outcome = parseFormState(state);
    if (!outcome.ok)
        return null;
    const bytes = encodedJsonBytes(outcome.invoice);
    return { bytes, limit: MAX_JSON_BYTES, fits: bytes <= MAX_JSON_BYTES };
}
/**
 * The non-blocking caution shown under the payout address when the entered address is uniformly cased.
 *
 * EIP-55 catches a mistyped character only in a mixed-case address; a uniformly-cased address carries no checksum, so nothing verifies it — yet {@link parseFormState} accepts one and the model stores the checksummed spelling, which every display then shows as if verified.
 * This names the gap where the raw text still exists: the payee is cautioned as they type, before the address is folded to its checksummed form.
 * Returns `null` for a mixed-case address with a valid checksum, for an empty or malformed field, and for a wrong checksum (that is reported by the model on submit, not as a caution).
 */
export function payoutAddressWarning(address) {
    if (checksumStatus(address.trim()) !== "unverifiable")
        return null;
    return "This payout address is all one case, so it carries no EIP-55 checksum and a mistyped character would not be caught. Paste the checksummed (mixed-case) spelling to verify it.";
}
/**
 * Render the create view and wire it to the form state.
 *
 * The DOM is built once; typing only updates the totals text, the line-amount cells, and the share-size note, never re-rendering the form.
 * Structural edits — add, remove, reorder — rebuild the item rows from the state.
 */
export function renderCreateView(options) {
    let state = emptyFormState(options.today);
    const errorsByKey = new Map();
    const amountCells = [];
    let shownErrors = [];
    const errorSummary = h("div", { class: "error-summary", role: "alert", hidden: true });
    const payeeName = h("input", { type: "text", name: "payeeName", value: state.payeeName, placeholder: "Acme Studio" });
    const payeeAddress = h("input", { type: "text", name: "payeeAddress", value: state.payeeAddress, placeholder: "0x…" });
    // Its single child changes in place, so the node stays mounted: an empty caution is hidden rather than removed.
    const payoutWarning = h("p", { class: "field-warning", role: "status", hidden: true }, "");
    const payeeEmail = h("input", { type: "text", name: "payeeEmail", value: state.payeeEmail, placeholder: "billing@example.com" });
    const invoiceId = h("input", { type: "text", name: "invoiceId", value: state.invoiceId, placeholder: "INV-0001" });
    const issued = h("input", { type: "text", name: "issued", value: state.issued, placeholder: "YYYY-MM-DD" });
    const due = h("input", { type: "text", name: "due", value: state.due, placeholder: "YYYY-MM-DD (optional)" });
    const payerName = h("input", { type: "text", name: "payerName", value: state.payerName, placeholder: "Client name (optional)" });
    const assetSelect = h("select", { name: "asset" }, ...ASSETS.map((asset) => h("option", { value: asset.id, selected: asset.id === state.assetId }, `${asset.symbol} — ${asset.name}`)));
    const notes = h("textarea", { name: "notes", placeholder: "Payment terms, thank you note…" }, state.notes);
    const taxToggle = h("input", { id: "tax-enabled", type: "checkbox", name: "taxEnabled", checked: state.taxEnabled });
    const taxLabel = h("input", { type: "text", name: "taxLabel", value: state.taxLabel, placeholder: "Tax" });
    const taxRate = h("input", { type: "text", name: "taxRate", value: state.taxRate, placeholder: "e.g. 19" });
    const taxFields = h("div", { class: "field-row", hidden: !state.taxEnabled }, fieldGroup("tax-label", "Tax label", taxLabel, errorsByKey, "taxLabel"), fieldGroup("tax-rate", "Tax rate %", taxRate, errorsByKey, "taxRate"));
    const tbody = h("tbody");
    const addButton = h("button", { type: "button", class: "btn btn-secondary" }, "Add line");
    const subtotalText = h("span", { class: "totals-value" }, "—");
    const taxText = h("span", { class: "totals-value" }, "—");
    const totalText = h("span", { class: "totals-value" }, "—");
    const taxRow = h("tr", { class: "totals-row", hidden: true }, h("th", { scope: "row" }, "Tax"), h("td", {}, taxText));
    const shareSizeNote = h("p", { class: "field-hint share-size" }, "");
    function syncTotals() {
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
    function syncShareSize() {
        const hint = shareSizeHint(state);
        if (hint === null) {
            shareSizeNote.textContent = "";
            shareSizeNote.setAttribute("class", "field-hint share-size");
            return;
        }
        shareSizeNote.textContent = hint.fits
            ? `Encoded size: ${hint.bytes} of ${hint.limit} bytes.`
            : `Encoded size: ${hint.bytes} bytes — over the ${hint.limit}-byte share limit. Remove line items or shorten descriptions.`;
        shareSizeNote.setAttribute("class", hint.fits ? "field-hint share-size" : "field-error share-size");
    }
    function syncPayoutWarning() {
        const warning = payoutAddressWarning(state.payeeAddress);
        if (warning === null) {
            payoutWarning.textContent = "";
            payoutWarning.setAttribute("hidden", "");
            return;
        }
        payoutWarning.textContent = warning;
        payoutWarning.removeAttribute("hidden");
    }
    function sync() {
        syncTotals();
        syncShareSize();
    }
    function showErrors(errors) {
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
    function rebuildItems(remap) {
        amountCells.length = 0;
        for (const key of [...errorsByKey.keys()]) {
            if (itemFieldParts(key) !== null)
                errorsByKey.delete(key);
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
        }
        else {
            addButton.setAttribute("disabled", "");
        }
        carryItemErrors(remap);
    }
    function replaceItems(next) {
        const before = state.items;
        state = next;
        rebuildItems(indexRemap(before, state.items));
        sync();
    }
    // Rebuilding the rows replaces their inline error elements, so every shown item error is re-applied with its key remapped to the line's new index; only a line the state no longer holds loses its error.
    function carryItemErrors(remap) {
        let sawItemError = false;
        const carried = [];
        for (const error of shownErrors) {
            const parts = itemFieldParts(error.field);
            if (parts === null) {
                carried.push(error);
                continue;
            }
            sawItemError = true;
            const next = remap(parts.index);
            if (next === null)
                continue;
            carried.push(next === parts.index ? error : { field: `item-${next}-${parts.name}`, message: error.message });
        }
        if (sawItemError)
            showErrors(carried);
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
            sync();
        }
    });
    taxToggle.addEventListener("change", () => {
        state.taxEnabled = taxToggle.checked;
        if (state.taxEnabled) {
            taxFields.removeAttribute("hidden");
        }
        else {
            taxFields.setAttribute("hidden", "");
        }
        sync();
    });
    addButton.addEventListener("click", () => {
        replaceItems(addItem(state));
    });
    const form = h("form", { class: "create-form" }, h("fieldset", { class: "form-section" }, h("legend", {}, "Your details"), fieldGroup("payee-name", "Payee name", payeeName, errorsByKey, "payeeName"), fieldGroup("payee-address", "Payout address", payeeAddress, errorsByKey, "payeeAddress", "The address this invoice pays to."), payoutWarning, fieldGroup("payee-email", "Contact email (optional)", payeeEmail, errorsByKey, "payeeEmail")), h("fieldset", { class: "form-section" }, h("legend", {}, "Invoice details"), fieldGroup("invoice-id", "Invoice number", invoiceId, errorsByKey, "invoiceId"), fieldGroup("issued", "Issue date", issued, errorsByKey, "issued", "YYYY-MM-DD"), fieldGroup("due", "Due date (optional)", due, errorsByKey, "due", "YYYY-MM-DD"), fieldGroup("asset", "Asset", assetSelect, errorsByKey, "asset")), h("fieldset", { class: "form-section" }, h("legend", {}, "Bill to (optional)"), fieldGroup("payer-name", "Client name", payerName, errorsByKey, "payerName")), h("fieldset", { class: "form-section" }, h("legend", {}, "Line items"), h("table", { class: "items-table" }, h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Description"), h("th", { scope: "col" }, "Qty"), h("th", { scope: "col" }, "Unit price"), h("th", { scope: "col" }, "Amount"), h("th", { scope: "col" }, ""))), tbody), addButton, h("p", { class: "field-hint" }, `Up to ${MAX_ITEMS} lines; the encoded invoice must fit the ${MAX_JSON_BYTES / 1024} KiB share limit.`)), h("fieldset", { class: "form-section" }, h("legend", {}, "Tax and notes"), h("div", { class: "field field-inline" }, taxToggle, h("label", { for: "tax-enabled" }, "Add tax")), taxFields, fieldGroup("notes", "Notes and terms (optional)", notes, errorsByKey, "notes")), errorSummary, h("div", { class: "totals" }, h("table", { class: "totals-table" }, h("tbody", {}, h("tr", { class: "totals-row" }, h("th", { scope: "row" }, "Subtotal"), h("td", {}, subtotalText)), taxRow, h("tr", { class: "totals-row totals-total" }, h("th", { scope: "row" }, "Total"), h("td", {}, totalText))))), shareSizeNote, h("div", { class: "form-actions" }, h("button", { type: "submit", class: "btn btn-primary" }, "Create share link")));
    form.addEventListener("submit", (event) => {
        event.preventDefault();
        const plan = planShare(state, options.baseUrl);
        if (plan.kind === "invalid") {
            showErrors(plan.errors);
            options.notice.showNotice("Please fix the highlighted fields.", "error");
            return;
        }
        showErrors([]);
        if (plan.kind === "too-large" || plan.kind === "failed") {
            options.notice.showNotice(plan.message, "error");
            return;
        }
        options.notice.clearNotice();
        openShareDialog(plan.bundle, { clipboard: options.clipboard ?? null });
        options.notice.showNotice(`Invoice ${plan.invoice.id} is ready to share.`, "success");
    });
    rebuildItems((index) => index);
    sync();
    return h("section", { class: "view view-create" }, h("h1", { class: "view-title" }, "Create an invoice"), h("p", { class: "view-intro" }, "Fill in your details and line items. Totals update as you type; the share link stays on this device."), form);
}
function buildItemRow(item, index, errors, sync, onRemove, onUp, onDown) {
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
        row: h("tr", {}, h("td", {}, description, descriptionError), h("td", {}, quantity, quantityError), h("td", {}, unitPrice, unitPriceError), h("td", { class: "cell-amount" }, amount), h("td", { class: "cell-actions" }, up, down, remove)),
        amount,
    };
}
function fieldGroup(id, labelText, control, errors, key, hint) {
    control.setAttribute("id", id);
    control.setAttribute("aria-describedby", `${id}-error`);
    const error = h("p", { class: "field-error", id: `${id}-error`, role: "alert", hidden: true });
    errors.set(key, error);
    return h("div", { class: "field" }, h("label", { for: id }, labelText), control, hint === undefined ? null : h("p", { class: "field-hint" }, hint), error);
}
function bind(control, onChange) {
    control.addEventListener("input", onChange);
    control.addEventListener("change", onChange);
}
//# sourceMappingURL=create.js.map