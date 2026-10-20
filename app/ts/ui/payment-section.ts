/**
 * The payment details of an invoice, as one shared section: the terms a wallet takes verbatim — the payee address, the amount, and the invoice's own payment link — beside the symbol of that same URI.
 *
 * {@link renderPaymentSection} is the one renderer of that section, drawn by the payer's document (`ui/view.ts`) and by the payee's create screen (`ui/create.ts`), which shows the section for the invoice it just built rather than making the payee open their own share link to see how they are to be paid.
 * Every string and every module comes from `ui/presentation.ts`'s frozen view model, so the two surfaces cannot word, order, or encode the payment differently, and neither of them recomputes a value the model already states.
 *
 * The amount, the address, and the link are values a wallet takes verbatim, so each is drawn as ordinary text with an exact-copy control beside it: a payer selects and copies the value the way they would any other text on the page — one term per block, so selecting the whole section yields a label and a value per line — while one click on the control hands the clipboard that string itself rather than whatever a selection happened to span.
 * The stylesheet holds each value on one run, so neither the layout nor a text selection can put a line break inside a value that has none, and because a run that does not fit its column would be clipped, each verbatim value is handed to `ui/fit-value.ts`: that module sets the value at the first rung of the screen ladder that holds it on one line, in the search order its own module doc states, and leaves the residual rung — the value at the floor, scrolling — for a value no rung holds, with the cue that the value may be cut off painted on every state of a row the ladder sizes rather than on that rung alone.
 * The row of a value the ladder sizes says so with a `fit-sized` class, and `invoice.css` paints that same cue on every state of such a row, so a fit that never lands — an engine with no `ResizeObserver`, a section rendered with no probe, a value the document has not laid out yet — cannot leave a clipped address reading as a whole one, and neither can a fit that threw part-way and left a candidate rung behind, nor a completed fit whose run is later drawn with wider glyphs than any measurement reported.
 * The terms no wallet takes verbatim — the asset's name and symbol, and the network's label — are held on no one-line run and are handed to no fitting: their value wraps, so a label longer than the column is drawn whole on the next line instead of running a clipped tail that reads as the whole label.
 * The fitting is a subscription of its own, so the section returns the `<footer>` it built carrying that release (`ui/release.ts`), and the surface that mounted the section is what runs it: a surface that replaces the section — the create screen rebuilding it for the next invoice — releases the one it is about to discard, and a surface that drops the whole document, as the router replaces the payer's document, carries the section's release on the document it returns.
 * The control's confirmation is a status line with a lifecycle: it is cleared after a pause so the section returns to its uniform resting height, and a repeated copy of the same value blanks the line first and re-sets it, so the change is one an assistive technology announces rather than an identical rewrite it may pass over.
 *
 * The print path is given a second presentation of the same string.
 * A print engine cannot be trusted with the on-screen run — it is not allowed to wrap, and the copy control beside it is chrome the print path hides — so each copyable term also carries a print-only twin of its value: the same string as text, which `print.css` swaps in for the value, drawn at the print rung `ui/fit-value.ts` computes from the value's own length and broken only past the print floor, so a printed invoice carries the complete amount, payee address, and payment link of every legal invoice.
 * The twin holds the value in the segments `ui/fit-value.ts` splits it into, each segment holding one inline run of the value's own characters, and `print.css` rules under every printed line of that run: the rule is the mark at a line's end, it cannot be read as a character of the address, it enters no text a payer copies, and because the run is marked wherever the page breaks it, a break inside a segment is marked exactly as a break between two segments is.
 *
 * The symbol is one element per module through `util/dom.ts`'s `h()`: no markup is built from a string, and no `data:` URL or canvas is reachable under the page's policy.
 */

import { h, type DomChild } from "../util/dom.js";
import type { QrMatrix } from "../util/qr.js";
import { copyWithFallback, type ClipboardLike, type CopyStatus } from "./clipboard.js";
import {
	FIT_SCALE_CLASS,
	fitValue,
	printFitRung,
	printedSegments,
	type LayoutProbe,
	type TermFitting,
} from "./fit-value.js";
import { VIEW_BUILD_RELEASE_FAILED_MESSAGE } from "./messages.js";
import type { InvoicePaymentTermView, InvoiceViewModel } from "./presentation.js";
import { releasable, runReleases, type ReleasableElement, type Release } from "./release.js";

/**
 * The pause a copy confirmation stays up before its status clears, so a copied term's row returns to the height of the plain rows beside it rather than keeping the confirmation's line for the rest of the session.
 */
const CONFIRMATION_MS = 4000;

/**
 * The timer a copy confirmation's clearing runs on.
 *
 * A rendered section uses the wall clock through {@link wallClockTimer}; a test hands {@link copyControlClick} a fake it drives itself, so the confirmation's lifecycle is pinned without waiting on a real delay.
 */
export interface ConfirmationTimer {
	/** Run `clear` after the confirmation's pause, and return a function that cancels the pending run. */
	after(clear: () => void): () => void;
}

/** The confirmation timer a rendered section uses: the wall clock's own pause, cancelled when a new copy replaces the confirmation. */
const wallClockTimer: ConfirmationTimer = {
	after(clear) {
		const handle = setTimeout(clear, CONFIRMATION_MS);
		return () => clearTimeout(handle);
	},
};

/**
 * Run a copy's confirmation on a task of its own.
 *
 * A live region records a change it observes between tasks, so the blank this control writes and the confirmation that follows must not land in one task: a repeated copy of the same value would re-set the text a screen reader already holds and could go unannounced, which is the case the blanking exists for.
 * The clipboard write itself stays in the click's own task — deferring it would drop the gesture some browsers require — so only the confirmation's reporting moves here.
 */
const laterTask: (report: () => void) => void = (report) => {
	setTimeout(report, 0);
};

/**
 * Whether `status` is still part of the document the section was rendered into.
 *
 * The browser keeps a rendered element's `isConnected` current: it is `false` once `ui/create.ts` rebuilds the payment section with `replaceChildren` and drops the subtree that held the status, so a write after that would land in a detached node the payee never sees.
 * A caller that drives the control directly passes a plain object whose `isConnected` is `undefined`, which is not `false`, so the control writes as it does for a mounted status.
 */
function stillMounted(status: CopyStatus): boolean {
	return status.isConnected !== false;
}

/**
 * Wire a copy control's click: copy the term's value, confirm the write in `status`, and clear the confirmation after its pause so the section returns to its uniform resting state.
 *
 * The status is blanked synchronously before each copy and any pending clear is cancelled first, and the confirmation is reported on a later task rather than the click's own, so a repeated copy of the same value still changes the live region's text — the blank and the set are two mutations an assistive technology announces — and the term's row carries the confirmation's height only while the confirmation stands.
 * Every write is guarded by {@link stillMounted}, so a confirmation or a pending clear left running when `ui/create.ts` rebuilds the section with `replaceChildren` does not land in the detached status it would otherwise write into.
 */
export function copyControlClick(
	text: string,
	clipboard: ClipboardLike | null,
	value: HTMLElement,
	status: CopyStatus,
	timer: ConfirmationTimer,
): () => void {
	let cancel = (): void => {};
	return () => {
		cancel();
		if (stillMounted(status)) status.textContent = "";
		cancel = timer.after(() => {
			if (!stillMounted(status)) return;
			status.textContent = "";
			cancel = (): void => {};
		});
		copyWithFallback(text, clipboard, value, status, (report) => {
			laterTask(() => {
				if (stillMounted(status)) report();
			});
		});
	};
}

/** Everything the section needs beyond the view model: how to copy, and the probe its fitted values measure through. */
export interface PaymentSectionOptions {
	/**
	 * The clipboard each term's copy control hands its value to, or `null` when the page has none and the control falls back to selecting the value for the payer to copy by hand.
	 */
	readonly clipboard?: ClipboardLike | null;
	/**
	 * The probe the section's fitted values measure through, or `null` to fit nothing and leave each value at the rung its stylesheet states.
	 * An absent option fits nothing for the same reason: a surface handed no probe has no layout to measure, and the only fail-safe reading of that is the rung the stylesheet already states rather than a guess at the environment.
	 * The composition root supplies the browser's own probe.
	 */
	readonly fit?: LayoutProbe | null;
}

/**
 * The section the view model describes: its payment title, one term per entry in the model's own list, and the symbol of the link those terms state.
 *
 * The symbol is drawn under the terms that state the same URI, never as a second statement of it: the link text the term above it draws is what a screen reader reads and a payer can select.
 * Every value a wallet takes verbatim is fitted through the probe the options state; `PaymentSectionOptions.fit` states what an absent or `null` probe leaves the value at.
 * A build that throws part-way — a term that cannot be drawn, a symbol the encoder refuses — releases the subscriptions the terms built before it.
 * The release drains that collector through `ui/release.ts`'s `runReleases`, so one stop that throws cannot strand the subscriptions after it on a section the page has dropped.
 * A release that throws while the section is already unwinding a failed build is surfaced as `ui/messages.ts`'s fixed sentence rather than in the stop's own words, with the failed build kept on the error's `cause`, so the console report names the stop that failed rather than the build behind it; the payer reads the catcher's own fixed sentence for the route, so a stopped subscriber's message, which can carry internal detail, arrives nowhere that is announced.
 */
export function renderPaymentSection(view: InvoiceViewModel, options: PaymentSectionOptions = {}): ReleasableElement {
	const clipboard = options.clipboard ?? null;
	const releases: Release[] = [];
	const fitting: TermFitting = { fit: options.fit ?? null, releases };
	const release = (): void => {
		runReleases(releases.splice(0));
	};
	try {
		const element = h(
			"footer",
			{ class: "invoice-payment" },
			h("h2", { class: "section-title" }, view.labels.paymentTitle),
			h("dl", { class: "payment-list" }, ...view.payment.map((term) => paymentTerm(term, clipboard, fitting))),
			qrBlock(view.paymentQr),
		);
		return releasable(element, release);
	} catch (error) {
		try {
			release();
		} catch {
			// The failure that caused this path is the one to report, and a release that throws must not replace it: the release failure is surfaced as the app's own fixed sentence, with the failed build kept on the error's `cause`, so the console report names the stop rather than the render — and no caught message reaches the payer, whose notice states the catcher's own sentence.
			const failure = new Error(VIEW_BUILD_RELEASE_FAILED_MESSAGE);
			failure.cause = error;
			throw failure;
		}
		throw error;
	}
}

/**
 * One payment-details term: its label and, in the `<dd>`, the value {@link paymentValue} renders, in a monospace face when the term is one a wallet takes verbatim.
 *
 * A verbatim value is fitted with the row it is drawn in, because the row is the layout the choice is measured against — the label's rail, the value's column, and the copy control all decide how much width the run has — and the row is also the element the chosen rung's class is written on.
 * The value element is the one {@link paymentValue} just built and handed back, so the fit is taken against the element itself rather than a search of the row for a class name that could be renamed out from under it, and the scale box it hands back with it is the element that reports a change to the value's drawn font size — the one change the value's own column-wide box cannot report (`ui/fit-value.ts`).
 * A term whose value is handed to the fitting carries `fit-sized`, which states what no rung class can: this row's value is one the ladder sizes, so `invoice.css` paints its cue that the value may be cut off on the row in every state of that row, a completed fit's included, because no measurement can see a run drawn with wider glyphs than the sizes it priced. A term no wallet takes verbatim carries no such class, because nothing sizes its value and its value wraps rather than scrolls, so nothing can clip it and no cue is owed.
 */
function paymentTerm(term: InvoicePaymentTermView, clipboard: ClipboardLike | null, fitting: TermFitting): HTMLElement {
	const built = paymentValue(term, clipboard);
	const row = h(
		"div",
		{ class: built.value === null ? "payment-term" : "payment-term fit-sized" },
		h("dt", {}, term.label),
		h("dd", { class: term.verbatim === true ? "mono" : undefined }, ...built.children),
	);
	if (built.value !== null && built.scale !== null) fitting.releases.push(fitValue({ row, value: built.value, scale: built.scale }, fitting.fit));
	return row;
}

/** What a term's value contributes to its `<dd>`: the elements it is drawn with, and the element the value's own text sits in when a wallet takes it verbatim. */
interface PaymentTermValue {
	readonly children: readonly DomChild[];
	/** The element a verbatim value's text is drawn in, which is what the fitter measures and what the copy control reads; `null` for a term no wallet takes verbatim. */
	readonly value: HTMLElement | null;
	/** The scale box `ui/fit-value.ts` watches beside that element, drawn inside it so it is set in the value's own face; `null` for a term no wallet takes verbatim. */
	readonly scale: HTMLElement | null;
}

/**
 * A term's value: the term's own text with an exact-copy control when it is one a wallet takes verbatim, and plain text when it is not.
 *
 * The value is a text node rather than a form control, so a payer reads, selects, and copies it as they would any other text on the page, and a selection that spans the whole section yields one label and value per line rather than a control's value.
 * The copy control hands over the term's own string rather than the span of that selection, and the run the stylesheet draws the value in does not wrap, so the layout cannot break a value that breaks nowhere either.
 * A verbatim value is a keyboard-focusable scroll container: a value wider than its column overflows it, and focusing the value is what lets a keyboard-only user arrow along it to the tail the copy control also hands over whole, while the rung the fitter chooses is what normally keeps the whole value in view with no scrolling at all.
 * Being focusable and a scroll container of its own, the value is a named `group`: ARIA 1.2 does not let an author name a bare generic element, and the role is what lets `aria-label` tell a screen-reader user which value the focus stop holds, while `invoice.css` rings the stop where `app.css` would leave a span unringed.
 * A term no wallet takes verbatim takes the wrapping state of that same value box instead: the asset's name and symbol and the network's label are the section's own readings rather than strings a wallet takes or a payer compares, so the value wraps and is drawn whole on the next line rather than scrolling a tail out of sight with no cue and no focus stop, and it is owed no cue and no stop because nothing can hide a character of it.
 * The print-only twin is that same term as the printed page presents it: the on-screen run does not wrap, a print engine would lay it out on one line and clip it at the column's edge, and the copy control — the one complete-copy affordance — is hidden in print, so a value longer than the column, a Zcash unified address of up to 311 characters or the payment link carrying it, would otherwise reach paper as the prefix that fitted.
 * The twin is ordinary text rather than a control's value, which is what lets `print.css` size it; the rung it carries is the one `ui/fit-value.ts` computes from the value's own length, because a printed page's geometry is fixed and cannot be measured from script, and on screen the twin is hidden while the value with its copy control is the presentation.
 * The twin holds the value in the segments `ui/fit-value.ts` splits it into, and each segment holds the segment's characters in one inline run of their own: a run is what a line break fragments, so `print.css` can rule under every printed line of the value and the mark stands at a break inside a segment exactly as it stands at a break between two.
 * The verbatim value carries its own class because the print swap drops that value alone: the terms no wallet takes verbatim have no twin, and their text stays in the printed document.
 * The write goes through `ui/clipboard.ts`, the seam the share dialog and the payment panel use: the two outcomes are spelled there once, and when the clipboard is unavailable or refuses the write the value's own contents are selected and the status tells the payer to copy by hand.
 * The button's accessible name carries the term's label, so two controls reading "Copy" on one document are still told apart.
 * The one flag is what the term's own `verbatim` statement is: the copy control, the print twin, and the PDF's unbroken run all read it, so no surface can disagree about which values a wallet takes.
 */
function paymentValue(term: InvoicePaymentTermView, clipboard: ClipboardLike | null): PaymentTermValue {
	if (term.verbatim !== true) {
		return { children: [h("span", { class: "payment-value payment-value-wrapping" }, term.value)], value: null, scale: null };
	}
	// The scale box is empty, hidden, and drawn in the value's own face, so its size is the one thing that changes when a later rule or setting sets the value in a larger face: the value's box is as wide as its column either way (`ui/fit-value.ts` states the hazard and what it costs).
	const scale = h("span", { class: FIT_SCALE_CLASS, "aria-hidden": "true" });
	const value = h(
		"span",
		{ class: "payment-value payment-value-verbatim", role: "group", "aria-label": term.label, tabindex: "0" },
		term.value,
		scale,
	);
	const printed = h(
		"span",
		{ class: `payment-value-print ${printFitRung(term.value)}` },
		...printedSegments(term.value).map((segment) =>
			h("span", { class: "payment-value-print-segment" }, h("span", { class: "payment-value-print-run" }, segment)),
		),
	);
	// The status is built with no children at all rather than an empty string: `h()` turns a string child into a text node, and the stylesheet's `:empty` rule — what takes the status's reserved full-width row out of flow while it is silent — need not match an element holding one.
	const status = h("span", { class: "payment-status no-print", role: "status" });
	const copy = h("button", { type: "button", class: "btn btn-secondary payment-copy no-print", "aria-label": `Copy ${term.label}` }, "Copy");
	copy.addEventListener("click", copyControlClick(term.value, clipboard, value, status, wallClockTimer));
	return { children: [value, printed, copy, status], value, scale };
}

/**
 * The payment link's symbol: one element per module, dark or light alike, drawn under the terms that state the same URI.
 *
 * The grid is `aria-hidden` rather than content: the link text the term above it draws is the statement a screen reader reads and a payer can select, and the symbol carries nothing that text does not.
 * It is drawn element by element because the app builds no markup from strings and no `data:` URL or canvas is reachable under the page's policy; the stylesheet sizes the modules, so a 77-module symbol (the widest the link layer can produce) is laid out by the same rules as a 21-module one.
 *
 * That element-per-module cost is paid once per render and stays bounded by the link layer's own figures: the worst case is the version-15 symbol at 77 modules across — 77×77 = 5929 module elements plus 77 row elements — while an ordinary invoice is cheaper, a unified address of the ~200 characters a container naming several receivers reaches building a 61×61 symbol of 3721 module elements plus 61 rows.
 * Nothing rebuilds the grid on a keystroke: the payer's document draws it once for a decoded invoice, and the create screen rebuilds the section only for an invoice it has just created, so a second symbol, or a rebuild on every keystroke, is a deliberate change to this cost rather than something the code already does.
 */
function qrBlock(matrix: QrMatrix): HTMLElement {
	return h(
		"div",
		{ class: "payment-qr", "aria-hidden": "true" },
		...matrix.modules.map((row) =>
			h("div", { class: "qr-row" }, ...row.map((dark) => h("span", { class: dark ? "qr-module qr-module-dark" : "qr-module" }))),
		),
	);
}
