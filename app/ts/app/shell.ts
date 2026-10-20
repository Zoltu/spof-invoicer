/**
 * The app shell: the page chrome around whichever route is showing.
 *
 * It owns the header, the notice region, and the route container, and it is the one place that wires `hashchange` to `app/router.ts`.
 * Every message that reaches the notice region — a router refusal that embeds an attacker-controlled share substring, a success line, the report of a document whose release failed — is rendered as a text child of `util/dom.ts`'s `h()` and then made display-safe here: the same invisible-and-direction-formatting characters the wallet-label boundary strips are removed first, and the result is re-bounded, so no payload can become markup, carry a bidi override or other default-ignorable into the rendered text, or overflow the notice.
 * The shell itself never touches the network.
 *
 * The route→render decision lives in {@link dispatchRoute}, which talks only to the {@link RouteEffects} it is handed and never to the DOM; {@link renderRoute} supplies a shell-backed implementation of those effects, and {@link createDispatcher} adds the memo that keeps a repeated route from rebuilding its view.
 * The view renderers those effects call are the shell's one seam that can throw — the payer's document is built from the invoice's payment link and its symbol — so each render runs behind the boundary `ui/view.ts`'s action runner already gives a click: a failure names itself in the notice region and in the route container rather than leaving the previous route's document, or an empty shell, on screen.
 * Each renderer returns the document it built carrying the release of everything that document subscribed to (`ui/release.ts`), so the route container reads one value from the document it mounts and keeps no second channel for it.
 * The shell is also the one place that holds a modal: a document opens the payment panel or the share dialog, and a route change drops the document, so the shell keeps the handle of whichever dialog was opened and dismisses it on the same path that replaces the document — otherwise a dialog would outlive the document it describes and stand over one it does not.
 * The slot reads two facts of that handle and no more: whether a dialog arrived at all, and whether the one it holds has closed itself, so the payer dismissing a panel is what the next Pay click finds rather than a dialog the slot still believes is standing.
 *
 * The invoice view's two outward seams — {@link ExportPdfHandler} (the pdf-lib renderer) and {@link PayHandler} (the wallet payment flow) — are carried through {@link BootOptions} and {@link RenderOptions}.
 * {@link viewOptions} supplies both defaults: the pdf-lib renderer bound to the boot's `today`, loaded lazily on the first export so its ~1.4 MB bundle stays out of first load, and the payment panel in ui/pay.ts, which reads nothing but the invoice until the payer clicks to pay, so wiring the default adds no wallet access on load or on render.
 * A boot that supplies either seam's own handler (a test, an embedding) still wins.
 * The header brand reads its spelling from {@link INVOICE_LABELS}, so the wordmark cannot drift from the document the PDF draws.
 * The header's paste box is the one payer-facing entry that decodes text the payer or an attacker handed over: a refusal there states a fixed sentence and reports the codec's own failure where a developer can read it, because that failure carries a bounded preview of the paste.
 */

import type { Invoice } from "../invoice/model.js";
import { decodeShare, encodeShare } from "../invoice/share.js";
import { renderCreateView, type CreateViewOptions } from "../ui/create.js";
import type { LayoutProbe } from "../ui/fit-value.js";
import type { NoticeApi, NoticeTone } from "../ui/notice.js";
import type { OverlayHandle } from "../ui/overlay.js";
import { openPayPanel } from "../ui/pay.js";
import { INVOICE_LABELS } from "../ui/presentation.js";
import { NOTHING_TO_RELEASE, releasable, type ReleasableElement } from "../ui/release.js";
import type { ClipboardLike } from "../ui/share.js";
import { renderInvoiceView, type ExportPdfHandler, type PayHandler, type ViewOptions } from "../ui/view.js";
import { h } from "../util/dom.js";
import { boundMessage, reportInternalFailure } from "../util/errors.js";
import { stripDisplayCharacters } from "../util/text.js";
import { currentRoute, type Route } from "./router.js";

const NOTICE_MESSAGE_MAX = 300;

/** Reported when the document a route replaced could not be released: what the payer can do about it, and nothing of the failure's internal detail. */
const RELEASE_FAILED_MESSAGE = "The previous document could not be cleared away, so something it was watching may still be running. Reload the page to start over.";

/** Reported when the modal the document a route replaced had open could not be dismissed: what the failure may leave running and what the payer can do, never the exception's own message. */
const DIALOG_DISMISS_FAILED_MESSAGE = "The dialog the previous document had open could not be cleared away, so something it was watching may still be running. Reload the page to start over.";

/** Reported when a dialog that arrived while one was already open could not be cleared away: what the failure may leave running and what the payer can do, never the exception's own message. */
const DIALOG_SUPERSEDED_MESSAGE = "The dialog opened over the one already on screen could not be cleared away, so something it was watching may still be running. Reload the page to start over.";

/** Reported when the create view's form cannot be built: what the payer sees instead, and the one action that clears it, never the renderer's own message. */
const CREATE_VIEW_FAILED_MESSAGE = "The invoice form could not be shown. Reload the page to start over.";

/** Reported when the invoice view cannot be built, for the reason the create view's sentence gives. */
const INVOICE_VIEW_FAILED_MESSAGE = "The invoice could not be shown. Reload the page to start over.";

/** Reported when a pasted share cannot be read: what the payer can do about it, and never the codec's own message, whose bounded preview echoes the pasted text back at them. */
const PASTE_FAILED_MESSAGE = "That could not be read as a share link or a pinv1b- blob. Check that the whole value was copied, or ask the sender for a fresh link.";

/** The mounted shell and the handles a caller uses to update it. */
export interface AppShell extends NoticeApi {
	readonly root: HTMLElement;
	readonly notice: HTMLElement;
	readonly content: HTMLElement;
	/**
	 * Replace the route container's document, releasing the document it drops.
	 *
	 * The container is what drops a document, so it is also what ends what that document subscribed to, and nothing waits for a layout report to notice that the dropped rows are gone.
	 * The incoming release is promoted into the one release slot before the dropped one is released, so a release that fails — reported in the notice region rather than thrown at the render that already replaced it, which must not be undone for a fault in what it displaced — can neither strand its successor unpromoted nor be released a second time on the next route.
	 * That report is a fixed sentence about what the failure leaves running and what the payer can do, never the exception's own message: the notice is announced as an alert and read by the payer, and an internal message can carry a validator's echo of a rejected value.
	 * Only a document that reached this call has something to release: a render that throws never gets here, because the renderer releases its own subscription in its own `catch` before {@link renderGuarded} mounts its error paragraph, whose release is `NOTHING_TO_RELEASE` and so ends nothing.
	 * The modal an open document left behind is dismissed first, by the same path: it was opened from the document being replaced, so its dialog and whatever it watches end with that document rather than outliving it, and a dismissal that fails is reported in the notice region in {@link DIALOG_DISMISS_FAILED_MESSAGE}'s words for the same reason the document release is.
	 */
	setContent(node: ReleasableElement): void;
	/**
	 * Hand the shell the modal the document on screen has open, and tell it `null` when that dialog closes or an open attempt is refused.
	 *
	 * The shell dismisses it on the path that replaces the document — the next {@link AppShell.setContent} — because the document that opened it is the one it describes, and a dialog left standing over the next document would offer that document's reader the previous one's payment link or payout address. A dismissal the payer triggers is the dialog's own path, and this one covers the payer who navigates instead.
	 * One modal at a time: a `null` dismisses the dialog the shell holds rather than forgetting it, and a handle that arrives while one is held is dismissed as it arrives, so a dialog still mounted over the page can never lose the handle that ends its backdrop and its subscriptions.
	 * A dismissal the slot runs re-enters it, because the dismissed dialog reports its own close through the same `null` a payer's dismissal does; that report is recognised as the slot's own and changes nothing, so the newcomer goes and the dialog on screen stays mounted with its backdrop, its release, and the background hiding that keeps the page behind it out of the keyboard and out of assistive tech's reading.
	 * A handle that has already closed is no dialog the page holds, so the slot forgets it instead of dismissing the newcomer in its place: a payer who dismisses the payment panel without paying finds the next Pay or Share click opens its dialog, rather than a dialog mounted and cleared away within the one click.
	 */
	setOpenDialog(dialog: OverlayHandle | null): void;
	setActiveNav(name: string): void;
	setOpenControl(node: Node): void;
}

/** Everything {@link renderRoute} needs, fixed once at boot. */
export interface RenderOptions {
	readonly baseUrl: string;
	readonly today: string;
	readonly clipboard: ClipboardLike | null;
	/** The probe every fitted value the routes draw measures through; {@link BootOptions.fit} states where it comes from and what an absent or `null` probe means. */
	readonly fit: LayoutProbe | null;
	readonly exportPdf?: ExportPdfHandler;
	readonly pay?: PayHandler;
}

/**
 * The optional overrides {@link bootApp} accepts: the base URL and date its defaults read, the clipboard, the layout probe the fitted values measure through, and the two invoice-view seams.
 * Every field falls back to the live-page default when omitted, except the probe, which only the entry module knows how to build.
 */
export interface BootOptions {
	readonly baseUrl?: string;
	readonly today?: string;
	readonly clipboard?: ClipboardLike | null;
	/** The probe the fitted values measure through, supplied by `main.ts` as the browser's own; `PaymentSectionOptions.fit` in `../ui/payment-section.ts` states what an absent one means. */
	readonly fit?: LayoutProbe | null;
	readonly exportPdf?: ExportPdfHandler;
	readonly pay?: PayHandler;
}

/** The chrome operations a route needs, so the route→render mapping can be tested without a shell. */
export interface RouteEffects {
	clearNotice(): void;
	showNotice(message: string, tone: NoticeTone): void;
	setActiveNav(name: string): void;
	showCreateView(): void;
	showView(invoice: Invoice): void;
}

/** Build the page chrome inside `root` and return the handles to update it. */
export function mountShell(root: HTMLElement): AppShell {
	const brand = h("a", { class: "brand", href: "#/create" }, INVOICE_LABELS.brand);
	const createLink = h("a", { class: "nav-link", href: "#/create" }, "Create");
	const openSlot = h("div", { class: "app-open" });
	const header = h("header", { class: "app-header" }, brand, h("nav", { class: "app-nav" }, createLink), openSlot);
	const notice = h("div", { class: "notice-region", role: "status" });
	const content = h("main", { class: "app-content" });
	root.replaceChildren(h("div", { class: "app" }, header, notice, content));
	// The one release slot: what the document now in the route container subscribed to.
	let contentRelease = NOTHING_TO_RELEASE;
	// The one modal the page may hold open, so a route change dismisses the dialog the document it replaces was opened from.
	let openDialog: OverlayHandle | null = null;
	// How many dismissals the slot itself is running: each one re-enters `setOpenDialog` with `null` through the dismissed dialog's own close report, and that `null` is this count's, not a dialog reporting a dismissal the slot did not ask for.
	let dismissalsInFlight = 0;

	function showNotice(message: string, tone: NoticeTone = "info"): void {
		notice.replaceChildren(
			h(
				"p",
				{ class: `notice notice-${tone}`, role: tone === "error" ? "alert" : "status" },
				boundMessage(stripDisplayCharacters(message), NOTICE_MESSAGE_MAX),
			),
		);
	}

	function clearNotice(): void {
		notice.replaceChildren();
	}

	/**
	 * Dismiss the modal the page has open, if any, and forget it.
	 *
	 * The handle is dropped before the dismissal runs, so a release that throws still leaves the shell holding no dialog — the state the page is in either way, since the overlay's own close runs its dismissal once.
	 * A failure is reported in the notice region rather than thrown at the render that replaced the document: nothing the render built is wrong because the dialog it displaced could not be cleared away.
	 */
	function dismissOpenDialog(): void {
		const dialog = openDialog;
		openDialog = null;
		if (dialog === null) return;
		dismissDialog(dialog, DIALOG_DISMISS_FAILED_MESSAGE, "open dialog dismissal");
	}

	/**
	 * Dismiss one modal handle, reporting a failure in the notice region rather than throwing it at whoever asked for the dismissal.
	 *
	 * The fixed sentence is the caller's, because what such a failure means for the payer depends on which dialog could not be cleared away; the exception itself goes to the console under `context` and never to the notice, whose text the payer reads.
	 * The dismissal is recorded for as long as it runs, because it re-enters `setOpenDialog` with `null` as it closes and the slot has to read that `null` as its own report rather than as a dialog the page has lost.
	 */
	function dismissDialog(dialog: OverlayHandle, message: string, context: string): void {
		dismissalsInFlight += 1;
		try {
			dialog.close();
		} catch (error) {
			reportInternalFailure(context, error);
			showNotice(message, "error");
		} finally {
			dismissalsInFlight -= 1;
		}
	}

	return {
		root,
		notice,
		content,
		showNotice,
		clearNotice,
		setContent(node: ReleasableElement): void {
			dismissOpenDialog();
			content.replaceChildren(node);
			const dropped = contentRelease;
			contentRelease = node.release;
			try {
				dropped();
			} catch (error) {
				// The notice region is announced as an alert and read by the payer, so a release failure is reported as what it means for them rather than as the exception's own message: that message can carry a validator's echo of a rejected value, and internal detail belongs nowhere the payer-facing notice reaches. The failure itself goes to the console, so a shipped release fault leaves a developer trace.
				reportInternalFailure("dropped document release", error);
				showNotice(RELEASE_FAILED_MESSAGE, "error");
			}
		},
		setOpenDialog(dialog: OverlayHandle | null): void {
			// A dialog the payer has already dismissed is not one the page holds: the slot forgets it before reading the newcomer, because a held closed handle would make the next Pay or Share click look like a second dialog standing over the first, and its dialog would be mounted and cleared away within that one click.
			if (openDialog !== null && openDialog.closed) openDialog = null;
			// A null is a dialog closing itself or an open attempt that mounted nothing, and neither leaves the page without the dialog the slot already holds: that dialog is dismissed rather than forgotten, so its backdrop and its subscriptions end here instead of outliving the slot.
			if (dialog === null) {
				// The dialog the slot is dismissing reports its own close through this `null`; dismissing the dialog the page still holds on its way would take the one the payer was using off the screen and un-hide the page behind a modal that is still mounted.
				if (dismissalsInFlight > 0) return;
				dismissOpenDialog();
				return;
			}
			// The newcomer is already mounted over the dialog the slot holds, and dismissing the older one would undo the background hiding the newer one has just applied: the newcomer goes, so no dialog is left mounted with no handle able to release it.
			if (openDialog !== null) {
				dismissDialog(dialog, DIALOG_SUPERSEDED_MESSAGE, "superseded dialog dismissal");
				return;
			}
			openDialog = dialog;
		},
		setActiveNav(name: string): void {
			if (name === "create") {
				createLink.setAttribute("class", "nav-link active");
			} else {
				createLink.setAttribute("class", "nav-link");
			}
		},
		setOpenControl(node: Node): void {
			openSlot.replaceChildren(node);
		},
	};
}

/**
 * Apply a route's chrome effects: the pure route→render mapping, written against {@link RouteEffects} rather than a shell so it can be exercised in tests without a document or a global listener.
 */
export function dispatchRoute(route: Route, effects: RouteEffects): void {
	switch (route.kind) {
		case "create":
			effects.clearNotice();
			effects.setActiveNav("create");
			effects.showCreateView();
			return;
		case "view":
			effects.clearNotice();
			effects.setActiveNav("");
			effects.showView(route.invoice);
			return;
		case "error":
			effects.showNotice(route.message, "error");
			effects.setActiveNav("create");
			effects.showCreateView();
			return;
	}
}

/**
 * Wrap {@link dispatchRoute} in a memo: a dispatch of the same route object as the last one is dropped.
 *
 * `parseHash` returns one frozen singleton for the create route, so a hash change that stays on create (clicking the brand or nav link from the landing state) does not rebuild the view and does not clear a partly-filled form.
 * A genuinely different route — including a fresh view or error object — passes through and renders.
 */
export function createDispatcher(effects: RouteEffects): (route: Route) => void {
	let last: Route | null = null;
	return (route) => {
		if (route === last) return;
		last = route;
		dispatchRoute(route, effects);
	};
}

/** Show the route the fragment names, rendering the create view for both `create` and `error`. */
export function renderRoute(shell: AppShell, route: Route, options: RenderOptions): void {
	dispatchRoute(route, shellEffects(shell, options));
}

/**
 * Render a view behind an error boundary, the way `ui/view.ts`'s `runAction` bounds an action a click starts.
 *
 * A renderer is a seam that can throw: `ui/presentation.ts`'s `buildInvoiceViewModel` builds the invoice's payment link through `payment/links.ts` and encodes its QR symbol through `util/qr.ts`, and each of those refuses an invoice its own validators do not admit, so a throw would otherwise escape the `hashchange` listener and the boot dispatch with the payer looking at whatever the previous route drew — or, at boot, at an empty container.
 * A failure replaces the route container with the fixed sentence its route states and reaches the notice region with that same sentence, which is announced and is the one part of the chrome the shell always draws; the notice boundary bounds and display-strips it exactly as it does every other notice.
 * The renderer's own message appears in neither place: the notice is announced and read by the payer, and a renderer's message can carry a validator's echo of a rejected value, which is nothing the payer can act on. It goes to `reportInternalFailure` under `context`, which is the route whose render failed, so the failure a payer is told nothing about is still one a developer can read.
 * The renderer that threw has already released what it took before the throw, so the paragraph mounted here subscribed to nothing and states that with `NOTHING_TO_RELEASE`; what the container drops on this path is the previous document, whose own release runs in {@link AppShell.setContent}.
 * The paragraph and the notice are mounted before the failure is reported, so a console that refuses the report cannot leave the payer looking at the document the failed render replaced.
 */
function renderGuarded(shell: AppShell, message: string, context: string, build: () => ReleasableElement): void {
	try {
		shell.setContent(build());
	} catch (error) {
		shell.setContent(releasable(h("p", { class: "notice notice-error" }, message), NOTHING_TO_RELEASE));
		shell.showNotice(message, "error");
		reportInternalFailure(context, error);
	}
}

/** The {@link RouteEffects} a live shell performs, building each view through its own renderer and its own boundary. */
function shellEffects(shell: AppShell, options: RenderOptions): RouteEffects {
	return {
		clearNotice: () => shell.clearNotice(),
		showNotice: (message, tone) => shell.showNotice(message, tone),
		setActiveNav: (name) => shell.setActiveNav(name),
		showCreateView: () => renderGuarded(shell, CREATE_VIEW_FAILED_MESSAGE, "create view render", () => renderCreateView(createViewOptions(shell, options))),
		showView: (invoice) => renderGuarded(shell, INVOICE_VIEW_FAILED_MESSAGE, "invoice view render", () => renderInvoiceView(invoice, viewOptions(shell, options))),
	};
}

function createViewOptions(shell: AppShell, options: RenderOptions): CreateViewOptions {
	return {
		notice: shell,
		baseUrl: options.baseUrl,
		today: options.today,
		clipboard: options.clipboard,
		fit: options.fit,
		// The share dialog a submit opens is handed to the shell's one modal slot, so a route change dismisses it with the form that opened it.
		onDialog: (dialog) => shell.setOpenDialog(dialog),
	};
}

/**
 * Forward the invoice view's seams — the pdf-lib export and the wallet payment flow.
 */
function viewOptions(shell: AppShell, options: RenderOptions): ViewOptions {
	return {
		notice: shell,
		baseUrl: options.baseUrl,
		today: options.today,
		clipboard: options.clipboard,
		fit: options.fit,
		exportPdf: options.exportPdf ?? ((invoice) => exportInvoice(invoice, options.today)),
		pay: options.pay ?? ((invoice) => {
			// The handle is handed to the shell rather than dropped here, so the panel a route change displaces is dismissed with the document that opened it.
			shell.setOpenDialog(openPayPanel(invoice, { notice: shell, clipboard: options.clipboard ?? null, fit: options.fit }));
		}),
		// The share dialog the document's Share control opens is handed to the same slot, for the panel's reason: it describes this document, so it must not outlive it.
		onDialog: (dialog) => shell.setOpenDialog(dialog),
	};
}

/**
 * The default "Save as PDF" handler.
 * The pdf-lib bundle is ~1.4 MB, so it is imported on the first export rather than at page load; the specifier is the compiled tree's own relative, `.js`-suffixed path (`app/js/app/shell.js` → `app/js/pdf/renderer.js`), which resolves when the static site is served as-is with no bundler.
 * The returned promise is what the view's action runner awaits.
 */
async function exportInvoice(invoice: Invoice, today: string): Promise<void> {
	const { renderPdf } = await import("../pdf/renderer.js");
	await renderPdf(invoice, today);
}

/** The header control that turns a pasted link or blob into a route. */
function renderOpenForm(shell: AppShell): HTMLFormElement {
	const input = h("input", { type: "text", name: "share", class: "open-input", placeholder: "Paste a share link or pinv1b- blob" });
	const form = h(
		"form",
		{ class: "open-form" },
		input,
		h("button", { type: "submit", class: "btn btn-secondary" }, "Open"),
	);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		openPasted(input.value, shell);
	});
	return form;
}

/**
 * Turn pasted text into a route.
 * A link (or bare fragment) is navigated to directly; a standalone blob is re-encoded to its `#/i/<payload>` fragment and navigated to as well, so every path goes through `location.hash` and the resulting `hashchange` — the blob path is not a special case that renders without updating the URL.
 * A legacy `pinv1-…` base64url blob is recognised as a blob and refused rather than decoded, and {@link PASTE_FAILED_MESSAGE} names the container this build shares, so a payer holding a retired link is told to ask the sender for a fresh one rather than left to read an internal refusal.
 *
 * The text is the payer's paste and, when a link was shared with them, an attacker's: the codec's refusals embed a bounded preview of it, so a throw reaches the notice as {@link PASTE_FAILED_MESSAGE} and the codec's own detail goes to the console, exactly as every other payer-facing failure path in this app states a fixed sentence and reports the exception behind it.
 */
function openPasted(text: string, shell: AppShell): void {
	const value = text.trim();
	if (value === "") return;
	const hashAt = value.indexOf("#");
	if (hashAt !== -1) {
		navigate(value.slice(hashAt));
		return;
	}
	if (value.startsWith("/")) {
		navigate(value);
		return;
	}
	try {
		const invoice = decodeShare(value);
		if (invoice !== null) {
			navigate(encodeShare(invoice));
			return;
		}
	} catch (error) {
		// The notice is announced and read by the payer, and the codec's message carries a bounded preview of the pasted text; so the payer reads the app's own sentence and the failure itself goes where a developer can read it.
		reportInternalFailure("pasted share refusal", error);
		shell.showNotice(PASTE_FAILED_MESSAGE, "error");
		return;
	}
	shell.showNotice("router: that is not a share link or blob", "error");
}

function navigate(hash: string): void {
	if (typeof location !== "undefined") {
		location.hash = hash;
	}
}

/**
 * Mount the shell, render the current route, and re-render on `hashchange`.
 * The dispatcher memoizes the last route, so staying on the same route (a create→create hash change) leaves the live view untouched.
 * Returns the shell; the listener is intentionally never removed, since the app lives as long as the page does.
 */
export function bootApp(root: HTMLElement, options: BootOptions = {}): AppShell {
	const shell = mountShell(root);
	const renderOptions: RenderOptions = {
		baseUrl: options.baseUrl ?? pageUrl(),
		today: options.today ?? isoToday(new Date()),
		clipboard: options.clipboard ?? null,
		fit: options.fit ?? null,
		exportPdf: options.exportPdf,
		pay: options.pay,
	};
	shell.setOpenControl(renderOpenForm(shell));
	const dispatch = createDispatcher(shellEffects(shell, renderOptions));
	dispatch(currentRoute());
	if (typeof globalThis.addEventListener === "function") {
		globalThis.addEventListener("hashchange", () => dispatch(currentRoute()));
	}
	return shell;
}

function pageUrl(): string {
	return typeof location === "undefined" ? "" : location.href;
}

function isoToday(date: Date): string {
	return date.toISOString().slice(0, 10);
}
