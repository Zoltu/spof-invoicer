/**
 * The app shell: the page chrome around whichever route is showing.
 *
 * It owns the header, the notice region, and the route container, and it is the one place that wires `hashchange` to `app/router.ts`.
 * Every message that reaches the notice region — a router refusal that embeds an attacker-controlled share substring, a success line — is rendered as a text child of `util/dom.ts`'s `h()` and then made display-safe here: the same invisible-and-direction-formatting characters the wallet-label boundary strips are removed first, and the result is re-bounded, so no payload can become markup, carry a bidi override or other default-ignorable into the rendered text, or overflow the notice.
 * The shell itself never touches the network.
 *
 * The route→render decision lives in {@link dispatchRoute}, which talks only to the {@link RouteEffects} it is handed and never to the DOM; {@link renderRoute} supplies a shell-backed implementation of those effects, and {@link createDispatcher} adds the memo that keeps a repeated route from rebuilding its view.
 *
 * The invoice view's two outward seams — {@link ExportPdfHandler} (the pdf-lib renderer) and {@link PayHandler} (the wallet payment flow) — are carried through {@link BootOptions} and {@link RenderOptions}.
 * {@link viewOptions} supplies both defaults: the pdf-lib renderer bound to the boot's `today`, loaded lazily on the first export so its ~1.4 MB bundle stays out of first load, and the payment panel in ui/pay.ts, which reads nothing but the invoice until the payer clicks to pay, so wiring the default adds no wallet access on load or on render.
 * A boot that supplies either seam's own handler (a test, an embedding) still wins.
 * The header brand reads its spelling from {@link INVOICE_LABELS}, so the wordmark cannot drift from the document the PDF draws.
 */

import type { Invoice } from "../invoice/model.js";
import { decodeShare, encodeShare } from "../invoice/share.js";
import { renderCreateView, type CreateViewOptions } from "../ui/create.js";
import type { NoticeApi, NoticeTone } from "../ui/notice.js";
import { openPayPanel } from "../ui/pay.js";
import { INVOICE_LABELS } from "../ui/presentation.js";
import type { ClipboardLike } from "../ui/share.js";
import { renderInvoiceView, type ExportPdfHandler, type PayHandler, type ViewOptions } from "../ui/view.js";
import { h } from "../util/dom.js";
import { boundMessage, messageOf } from "../util/errors.js";
import { stripDisplayCharacters } from "../util/text.js";
import { currentRoute, type Route } from "./router.js";

const NOTICE_MESSAGE_MAX = 300;

/** The mounted shell and the handles a caller uses to update it. */
export interface AppShell extends NoticeApi {
	readonly root: HTMLElement;
	readonly notice: HTMLElement;
	readonly content: HTMLElement;
	setContent(node: Node): void;
	setActiveNav(name: string): void;
	setOpenControl(node: Node): void;
}

/** Everything {@link renderRoute} needs, fixed once at boot. */
export interface RenderOptions {
	readonly baseUrl: string;
	readonly today: string;
	readonly clipboard: ClipboardLike | null;
	readonly exportPdf?: ExportPdfHandler;
	readonly pay?: PayHandler;
}

/**
 * The optional overrides {@link bootApp} accepts: the base URL and date its defaults read, the clipboard, and the two invoice-view seams.
 * Every field falls back to the live-page default when omitted.
 */
export interface BootOptions {
	readonly baseUrl?: string;
	readonly today?: string;
	readonly clipboard?: ClipboardLike | null;
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

	return {
		root,
		notice,
		content,
		showNotice,
		clearNotice,
		setContent(node: Node): void {
			content.replaceChildren(node);
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

/** The {@link RouteEffects} a live shell performs, building each view through its own renderer. */
function shellEffects(shell: AppShell, options: RenderOptions): RouteEffects {
	return {
		clearNotice: () => shell.clearNotice(),
		showNotice: (message, tone) => shell.showNotice(message, tone),
		setActiveNav: (name) => shell.setActiveNav(name),
		showCreateView: () => shell.setContent(renderCreateView(createViewOptions(shell, options))),
		showView: (invoice) => shell.setContent(renderInvoiceView(invoice, viewOptions(shell, options))),
	};
}

function createViewOptions(shell: AppShell, options: RenderOptions): CreateViewOptions {
	return { notice: shell, baseUrl: options.baseUrl, today: options.today, clipboard: options.clipboard };
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
		exportPdf: options.exportPdf ?? ((invoice) => exportInvoice(invoice, options.today)),
		pay: options.pay ?? ((invoice) => {
			openPayPanel(invoice, { notice: shell, clipboard: options.clipboard ?? null });
		}),
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
 * A legacy `pinv1-…` base64url blob is recognised as a blob and refused by the codec's own message, which names the retired encoding.
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
		shell.showNotice(messageOf(error), "error");
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
