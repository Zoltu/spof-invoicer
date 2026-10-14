/**
 * The repo's own acceptance gate.
 *
 * Everything else in tests/ checks one module's contract; this file walks the product end to end at the seam level.
 * The payee's half is composed at the module level — `createInvoice` → `encodeShare` → the base32 blob → decode — while the payer's half runs through the real seams: the shell and router render the decoded invoice into the fake DOM, "Save as PDF" produces real bytes that are reopened with pdf-lib, and "Pay" drives a mock EIP-1193 wallet.
 * The create form and the share dialog themselves are canvassed by tests/ui.test.mjs and tests/view.test.mjs; this file drives the form only as far as the icon path needs, from choosing the file to the share link the dialog hands out.
 * What this file proves are the promises the app makes to a payer: no page-origin network I/O, no wallet access before an explicit Pay click, and no hostile share string or hostile invoice text reaching either the DOM or a transaction.
 * The static sweeps at the end are the reproducible half of the security checks: they fail if a network API, a markup sink, an absolute URL, a remote stylesheet reference, or a stale build ever appears under app/.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { codeOnly, languageFor } from "./helpers/code-only.mjs";
import { installInteractiveDocument } from "./helpers/dom.mjs";
import { blockNetwork } from "./helpers/network-block.mjs";
import { PAYEE, XMR_PAYEE, ZEC_PAYEE, ZEC_UNIFIED_PAYEE } from "./helpers/payee-vectors.mjs";
import { imageXObjects } from "./helpers/pdf-images.mjs";
import { assertSymbolCellsInDom } from "./helpers/qr-dom.mjs";
import { assertSymbolCells } from "./helpers/qr-symbol.mjs";
import { refusalError, refusalMessage } from "./helpers/refusals.mjs";
import { servedTreeProblems } from "./helpers/served-drift.mjs";
import { USDC_LOWER } from "./helpers/tokens.mjs";
import { findAll, findButton, hasClass, inputValues, textOf } from "./helpers/tree.mjs";
import { SERVED_BUNDLES } from "./helpers/vendor-bundles.mjs";
import { nextTask, waitFor } from "./helpers/wait.mjs";
import { ACCOUNT, TX_HASH, installWindow, mockProvider } from "./helpers/wallet-mock.mjs";
import { listFiles } from "../scripts/vendor-manifest.mjs";
import { parseHash } from "../app/js/app/router.js";
import { bootApp, mountShell, renderRoute } from "../app/js/app/shell.js";
import {
	MAX_JSON_BYTES,
	MAX_PAYLOAD_CHARS,
	ShareFormatError,
	UnsupportedShareVersionError,
	decodeInvoice,
	decodeInvoiceBlob,
	encodeInvoice,
	encodeInvoiceBlob,
	serializeInvoice,
} from "../app/js/invoice/codec.js";
import { MAX_ICON_DIMENSION, MAX_ICON_SVG_BYTES } from "../app/js/invoice/icon.js";
import {
	InvalidInvoiceError,
	UnsupportedInvoiceVersionError,
	computeTotals,
	createInvoice,
} from "../app/js/invoice/model.js";
import { SHARE_FRAGMENT_PREFIX, buildShareUrl, decodeShare, encodeShare } from "../app/js/invoice/share.js";
import { buildPaymentLink } from "../app/js/payment/links.js";
import { QR_SYMBOL, buildInvoicePages, downloadPdf, invoiceFileName, renderInvoicePdf } from "../app/js/pdf/renderer.js";
import { renderCreateView } from "../app/js/ui/create.js";
import { UNSUPPORTED_WALLET_MESSAGE } from "../app/js/ui/pay.js";
import { buildInvoiceViewModel } from "../app/js/ui/presentation.js";
import { base32nopad, bech32m, utf8 } from "../app/js/util/encoding.js";
import { encodeQr } from "../app/js/util/qr.js";
import { svgDataUrl } from "../app/js/util/svg-data-url.js";
import { PDFDocument } from "../app/js/vendor/pdf-lib/pdf-lib.esm.js";
import { WalletClient, toHexQuantity } from "../app/js/wallet/eip1193.js";
import { TestnetUnifiedAddressError } from "../app/js/wallet/zcash-address.js";
import { encodeBalanceOf, encodeTransfer } from "../app/js/wallet/erc20.js";
import {
	WrongChainError,
	buildPaymentPlan,
	connectWallet,
	ensureWalletChain,
	readBalance,
	sendPayment,
} from "../app/js/wallet/payment.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "app");
const jsDir = join(appDir, "js");
const vendorDir = join(jsDir, "vendor");

const TODAY = "2026-10-03";
/** 2 × 150 + 57 = 357 USDC, plus 19% tax = 424.83 USDC. */
const USDC_TOTAL = 424830000n;
/** 1 × 1.5 ETH. */
const ETH_TOTAL = 1500000000000000000n;
const HOSTILE = "<img src=x onerror=\"alert(1)\"><script>alert(2)</script>";

/** A minimal icon document the gate accepts, and the 1 by 1 PNG a substituted rasterizer hands the export. */
const ICON_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"32\" height=\"32\"><rect width=\"32\" height=\"32\" fill=\"#123456\"/></svg>";
const ICON_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");

// The word channels, plus two that need a shape: `Image(` only when it is a bare call (the vendored pdf-lib carries `'Image'` as a PDF subtype string), and prefetch/dns-prefetch as HTML rel tokens.
const NETWORK_APIS = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|WebTransport|sendBeacon|importScripts|serviceWorker|RTCPeerConnection|ping)\b|\bImage\s*\(|\b(?:dns-)?prefetch\b/;
// The persistence and side-channel APIs the "no cookie, no storage" promise bans: a value written to any of these outlives the page or leaks the fragment to a same-origin sibling, so the sweep names them beside the network APIs.
const STORAGE_APIS = /\b(localStorage|sessionStorage|indexedDB|history)\b|\bwindow\s*\.\s*name\b|\bdocument\s*\.\s*cookie\b/;
// The markup and script sinks, plus the DOM, import, and navigation routes to executable script: a `document.createElement(...)` call, whatever tag it is handed — a variable tag can become `<script>`, and a literal one is exempt only through the allow-list below — a computed `import()`, `window.open`, and a `location` assignment are each such a route, so the sweep names them beside the literal sinks that build or load a `<script>`.
const MARKUP_SINKS = /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval|new Function|createContextualFragment)\b|createElement\s*\(\s*["'`]script["'`]|\bh\s*\(\s*["'`]script["'`]|\bscript\s*\.\s*textContent\s*=|\bdocument\s*\.\s*createElement\s*\(|\bimport\s*\(\s*[^"'`\s)]|\bwindow\s*\.\s*open\s*\(|\blocation\s*\.\s*(?:assign|replace)\s*\(|\blocation\s*\.\s*href\s*=/;
/** The one flag set every vector pattern is built with, so the composed sweep and the two patterns it is built from cannot disagree on case. */
const VECTOR_FLAGS = "i";
/** A direct `src` assignment, one of the two vectors the script-URL sweep below names. */
const SRC_ASSIGNMENT = new RegExp("\\.\\s*src\\s*=|\\[\\s*[\"'`]src[\"'`]\\s*\\]\\s*=", VECTOR_FLAGS);
/**
 * A script-bearing URL scheme in a string literal: `javascript:`, `data:`, `vbscript:`, `blob:`, or `file:` right after a quote or backtick.
 *
 * The list is the single source of truth for every scheme the script-URL sweep refuses, so a scheme added here reaches the script-URL sweep.
 * The `data:` exemption below does not consult this pattern: it admits a line only when the whole comment-stripped line equals one of {@link SANCTIONED_DATA_URL_STATEMENTS}, the leaf's declaration of its own prefix constant in either spelling it is written in, so renaming that constant drops the exemption rather than moving with it.
 */
const URL_SCHEME_LITERAL = new RegExp("[\"'`](?:javascript|data|vbscript|blob|file):", VECTOR_FLAGS);
// A direct `src` assignment and a script-bearing URL scheme in a string literal, composed from the two patterns above. Swept over the app's own runtime only: the vendored pdf-lib bundle legitimately sets `this.src` and builds `data:` URIs, so neither is a vendored-code sink.
const SCRIPT_URL_VECTORS = new RegExp(`${SRC_ASSIGNMENT.source}|${URL_SCHEME_LITERAL.source}`, VECTOR_FLAGS);

/** A deterministic half-em stand-in for font metrics; the layout only needs consistent widths. */
const PDF_METRICS = { widthOfText: (text, size) => text.length * size * 0.5 };

/** Every figure the exported PDF layout must carry for `usdcInvoice`, in the text it draws. */
const PDF_FIGURES = [
	"#INV-2026-0042",
	"150 USDC",
	"300 USDC",
	"57 USDC",
	"357 USDC",
	"VAT 19%",
	"67.83 USDC",
	"424.83 USDC",
	"USD Coin (USDC)",
	PAYEE,
];

function usdcInvoice(overrides = {}) {
	return createInvoice({
		id: "INV-2026-0042",
		issued: "2026-09-28",
		due: "2026-10-28",
		payee: {
			name: "Studio Example Ltd",
			address: PAYEE,
			email: "billing@studio.example",
			notes: "Thank you for your business.",
		},
		payer: { name: "Client Co" },
		chainId: "0x1",
		asset: "usdc",
		items: [
			{ description: "Design work", quantity: "2", unitPrice: "150" },
			{ description: "Süß — naïve 日本", quantity: "1", unitPrice: "57" },
		],
		tax: { label: "VAT 19%", rate: "19" },
		notes: "Payable within 30 days.",
		...overrides,
	});
}

function ethInvoice() {
	return createInvoice({
		id: "INV-ETH-1",
		issued: "2026-09-28",
		payee: { name: "Studio Example Ltd", address: PAYEE },
		chainId: "0x1",
		asset: "eth",
		items: [{ description: "Advice", quantity: "1", unitPrice: "1.5" }],
	});
}

/** A privacy-chain invoice: its own network slug, its own asset, and its own family's payee form. */
function zecInvoice(overrides = {}) {
	return createInvoice({
		id: "INV-ZEC-1",
		issued: "2026-09-28",
		payee: { name: "Studio Example Ltd", address: ZEC_PAYEE },
		chainId: "zcash",
		asset: "zec",
		items: [{ description: "Advice", quantity: "1", unitPrice: "1.5" }],
		...overrides,
	});
}

function xmrInvoice() {
	return createInvoice({
		id: "INV-XMR-1",
		issued: "2026-09-28",
		payee: { name: "Studio Example Ltd", address: XMR_PAYEE },
		chainId: "monero",
		asset: "xmr",
		items: [{ description: "Advice", quantity: "1", unitPrice: "1.5" }],
	});
}

/** A payload as the codec writes one: canonical JSON in the base32 container. */
function b32(text) {
	return base32nopad.encode(utf8.decode(text));
}

/** Flip the case of one hex letter — always enough to break an EIP-55 checksum. */
function breakChecksum(address) {
	const index = address.search(/[a-f]/i);
	const character = address[index];
	const flipped = character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase();
	return address.slice(0, index) + flipped + address.slice(index + 1);
}

function installLocation(value) {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
	Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value });
	return {
		restore() {
			if (previous === undefined) delete globalThis.location;
			else Object.defineProperty(globalThis, "location", previous);
		},
	};
}

/**
 * Mount the shell and render the route a link's fragment names, exactly as the page does.
 * `extra` overrides the seams the boot would otherwise default — the PDF export, the payment flow — so a case can substitute the one dependency it cannot run.
 */
function mountSharedLink(fragment, extra = {}) {
	const shell = mountShell(document.createElement("div"));
	renderRoute(shell, parseHash(fragment), {
		baseUrl: "https://gateway.example/ipfs/bafy/index.html",
		today: TODAY,
		clipboard: null,
		...extra,
	});
	return shell;
}

/** A notice sink for a view rendered without the shell, recording what it was told. */
function noticeRecorder() {
	const calls = [];
	return {
		calls,
		showNotice(message, tone) {
			calls.push({ message, tone });
		},
		clearNotice() {
			calls.push(null);
		},
	};
}

/** The form control named `name`, so a case can fill the field it names. */
function controlNamed(rootNode, name) {
	const control = findAll(rootNode, (node) => node.attributes?.name === name)[0];
	assert.ok(control, `no control named ${name}`);
	return control;
}

function setControl(rootNode, name, value) {
	const control = controlNamed(rootNode, name);
	control.value = value;
	control.dispatch("input");
}

/** The file shape the icon input reads: the byte size it claims and the text it yields. */
function iconFile(text, size = text.length) {
	return { size, text: async () => text };
}

/** Absolute paths of every file under `dir`, wrapping the shared listing the build tooling uses. */
async function filesUnder(dir) {
	return (await listFiles(dir)).map((file) => join(dir, file));
}

/**
 * Every hit `pattern` finds in one file's `source`, in line order, reported under the workspace-relative `file`.
 * A hit carries the line the pattern was tested against, so the sink pattern and the exemption it feeds read one and the same comment-stripped text: a trailing comment naming a sanctioned call cannot exempt a call on its own line.
 */
function sourceHits(file, source, pattern, scan) {
	const hits = [];
	for (const [index, line] of codeOnly(source, { ...scan, language: languageFor(file) }).split("\n").entries()) {
		if (pattern.test(line)) hits.push({ file, line: index + 1, text: line.trim() });
	}
	return hits;
}

function occurrences(files, pattern, options = {}) {
	const { except, ...scan } = options;
	const hits = [];
	for (const file of files) {
		for (const hit of sourceHits(relative(root, file), readFileSync(file, "utf8"), pattern, scan)) {
			if (except !== undefined && except(hit)) continue;
			hits.push(hit);
		}
	}
	return hits;
}

/** How many times `text` occurs in `source`, so a sentence claimed to have one spelling can be counted. */
function countOccurrences(source, text) {
	return source.split(text).length - 1;
}

/**
 * Every authored file the served tree is built from, plus the README, read as one text: the sources the app compiles from, the stylesheets it ships, the page that serves them, and the documentation describing them, so a sentence claimed to have one spelling is counted everywhere a second copy could hide.
 * The compiled `app/js/**` copy is the same sentence compiled rather than a second spelling of it, and the fresh-build gate is what holds it to the source.
 */
async function authoredTreeText() {
	const files = [
		...(await listFiles(join(appDir, "ts"))).map((file) => join(appDir, "ts", file)),
		...(await listFiles(join(appDir, "stylesheets"))).map((file) => join(appDir, "stylesheets", file)),
		join(appDir, "index.html"),
		join(root, "README.md"),
	];
	return files.map((file) => readFileSync(file, "utf8")).join("\n");
}

function isOurModule(file) {
	return file.endsWith(".js") && !file.startsWith(vendorDir + sep);
}

/**
 * The whole allow-list for the DOM-creation sweep, each site named with the justification that exempts it.
 *
 * `util/dom.ts`'s `h()` builder has one sanctioned call, `document.createElement(tag)`, safe because the tag it hands over is the parameter `h()` has already checked against its own forbidden tags.
 * Each exemption is file-scoped and site-exact: it admits one whole statement, so a `createElement` call a reported line spells beside the sanctioned one — a second tag on the same line, or another sink sharing it — is reported rather than admitted by a pattern the line merely contains.
 * The PDF export's download anchor in `pdf/renderer.ts` is one of the exceptions `README.md` documents: it is built on the fly to take an app-generated `blob:` URL that `h()` itself would refuse, and its tag is the literal `"a"`.
 * `pdf/rasterize.ts` builds the browser-only rasterizer's own two elements — the `<img>` that loads the icon leaf's data URL and the `<canvas>` its pixels are drawn into — which is the image context the icon is rendered in and neither of which can carry script.
 */
const ELEMENT_BUILDERS = new Set(["app/ts/util/dom.ts", "app/js/util/dom.js"]);
const DOWNLOAD_ANCHORS = new Set(["app/ts/pdf/renderer.ts", "app/js/pdf/renderer.js"]);
/** The rasterizer's file, in both trees. */
const RASTERIZER_SITES = new Set(["app/ts/pdf/rasterize.ts", "app/js/pdf/rasterize.js"]);
/** The builder's one sanctioned statement: `h()`'s call, which passes the tag parameter it has already refused a forbidden value for. */
const SANCTIONED_BUILDER_CALL = "const element = document.createElement(tag);";
/** The download-anchor statement: the link element whose tag is the literal "a". */
const SANCTIONED_DOWNLOAD_ANCHOR = "const link = document.createElement(\"a\");";
/** The rasterizer's two sanctioned statements, pinned whole rather than by pattern: the image element that loads the icon and the canvas it is drawn into. */
const SANCTIONED_RASTERIZER_STATEMENTS = new Set([
	'const image = document.createElement("img");',
	'const canvas = document.createElement("canvas");',
]);
function isSanctionedElementBuilder(hit) {
	if (ELEMENT_BUILDERS.has(hit.file) && hit.text === SANCTIONED_BUILDER_CALL) return true;
	if (RASTERIZER_SITES.has(hit.file) && SANCTIONED_RASTERIZER_STATEMENTS.has(hit.text)) return true;
	return DOWNLOAD_ANCHORS.has(hit.file) && hit.text === SANCTIONED_DOWNLOAD_ANCHOR;
}

/**
 * The whole allow-list for the script-URL sweep: the one runtime file that arms an icon, and the one statement it may spell there.
 *
 * `util/data-url.ts` declares the `data:image/svg+xml;base64,…` prefix an image sink loads and `util/svg-data-url.ts` composes it into that URL, so the leaf is the one place the runtime spells a `data:` scheme, and `app/js/util/data-url.js` is the compiled copy of that same statement.
 * The exemption is content-specific rather than file-wide: it admits exactly the statement that declares the leaf's prefix constant, as {@link isSanctionedElementBuilder} admits exactly the builder's one sanctioned call, so the same literal on any other line of the leaf — a `javascript:`/`vbscript:`/`blob:`/`file:` literal, a second `data:` literal, or a `.src =` assignment — is still reported.
 * The declaration is admitted in both the spellings a module can write it in, with and without the `export` keyword, because the leaf exports the constant and either line is that same statement over that same literal; the match stays whole-line and exact, so neither spelling admits a different literal, a different file, or a differently shaped statement.
 */
const DATA_URL_LEAVES = new Set(["app/ts/util/data-url.ts", "app/js/util/data-url.js"]);
/** The exact prefix literal the leaf may spell, and the only `data:` spelling any exemption covers. */
const SANCTIONED_DATA_URL_LITERAL = "data:image/svg+xml;base64,";
/** The leaf's declaration of its own prefix constant in the spelling without `export`, composed from the literal above so the two cannot disagree; it is one of the two lines the exemption admits. */
const SANCTIONED_DATA_URL_STATEMENT = `const SVG_DATA_URL_PREFIX = "${SANCTIONED_DATA_URL_LITERAL}";`;
/** The same declaration as the leaf writes it, with the `export` keyword: the two spellings are the whole allow-list, and each is the whole line the exemption tests. */
const SANCTIONED_DATA_URL_EXPORT_STATEMENT = `export ${SANCTIONED_DATA_URL_STATEMENT}`;
/** The two exact statements the exemption admits, held as one allow-list so no third spelling can be admitted by accident. */
const SANCTIONED_DATA_URL_STATEMENTS = new Set([SANCTIONED_DATA_URL_STATEMENT, SANCTIONED_DATA_URL_EXPORT_STATEMENT]);
function isSanctionedDataUrlStatement(hit) {
	return DATA_URL_LEAVES.has(hit.file) && SANCTIONED_DATA_URL_STATEMENTS.has(hit.text);
}

/**
 * The whole allow-list for the raw `src`-setter sweep: the one runtime file that owns an image sink, and the value it may hand the attribute.
 *
 * `h()` is the app's only builder, so a literal setter is a second route to an image sink that bypasses its allow-list entirely, and this sweep reports the spellings it names: a plain `setAttribute("src", …)`, a `setAttributeNS(…, "src", …)`, and — through the sibling script-URL sweep — a direct `.src =`, `.SRC =`, `["src"] =`, or `['src'] =` assignment.
 * Those spellings are enumerated rather than derived, and an enumeration cannot be exhaustive: it does not match `el["setAttribute"]("src", …)`, `el.attributes.src.value = …`, or `Object.assign(el, { src })`, and it is not meant to, so a gap here is not a reason to add a pattern.
 * What contains a bypass through any spelling is the branded `SvgDataUrl` type a `src` must be, the runtime `isSvgDataUrl` check in `h()`'s attribute builder, the `img-src 'self' data:` CSP, and the single-`data:`-literal sweep that keeps the leaf's own prefix the only `data:` URL in the served tree; this sweep is a second net beside them, never the boundary.
 * The exemption admits the setter only in the browser-only rasterizer, the one file that spells a literal `src` setter at all, and only when the whole comment-stripped line is the one statement that hands the attribute the rasterizer's own branded parameter.
 * `util/dom.ts` sets attributes from its checked bag rather than from a literal name, so it spells no literal setter and is not a sanctioned site; a literal setter there, or in any other file, is reported.
 * The rasterizer's value is its `dataUrl` parameter, which its signature declares as the branded `SvgDataUrl` the view model armed once; that declaration is pinned beside these pins, so the value the admitted statement carries is a branded one rather than a name the sweep trusts on sight.
 * The leaf's own builder `svgDataUrl(…)` is deliberately not an exempt spelling either: no file in the tree writes it, and the value this sweep sanctions is the branded parameter the rasterizer declares rather than a URL built at the sink, so a sink arming the attribute from that builder would be a second route to it. The builder's own validation is not what this pin rests on — `util/svg-data-url.ts` runs the icon gate now, so a value it returns is a validated one — but the sanctioned site stays the once-armed value the seam carries.
 * Every other spelling of that one call is reported, so a setter handing over another identifier — `url`, `value`, or a name that merely ends in `dataUrl` — or a string literal is refused by the whole-line match.
 * The exemption is content-specific rather than file-wide, exactly as the `data:`-literal exemption is: it admits exactly the one statement that sets the rasterizer's `<img>` `src` from the branded parameter, so the same call on any other line of the rasterizer — a second `setAttribute("src", dataUrl)`, a setter sharing a line with another statement, a `setAttributeNS`, or a setter handing over another value — is reported rather than admitted by a pattern the line merely contains.
 * What pins the real site beyond this line-exact allowance is the branded `SvgDataUrl` parameter type below, checked at compile time: the statement the exemption admits is the one the rasterizer's own sink writes.
 */
const SRC_SETTER_SITES = new Set(["app/ts/pdf/rasterize.ts", "app/js/pdf/rasterize.js"]);
/** A raw `setAttribute`/`setAttributeNS` `src` setter, in any casing. */
const RAW_SRC_SETTER = /\bsetAttribute\s*\(\s*["'`]src["'`]|\bsetAttributeNS\s*\(\s*[^,)]*,\s*["'`]src["'`]/i;
/** The one statement a sanctioned setter may be: the rasterizer's own `<img>` sink handed the branded `SvgDataUrl` parameter, which is the whole allow-list for this sweep. */
const SANCTIONED_SRC_SETTER_STATEMENT = 'image.setAttribute("src", dataUrl);';
function isSanctionedSrcSetter(hit) {
	return SRC_SETTER_SITES.has(hit.file) && hit.text === SANCTIONED_SRC_SETTER_STATEMENT;
}

/**
 * The containment invariant for the icon's image context: the constructs that would put an SVG document into the live DOM rather than into an image sink.
 *
 * `createElementNS` and `DOMParser` both build or parse markup rather than load an image, and an inline `h("svg", …)` would put the document's own elements — and whatever script they carry — into the page instead of rendering them in the image context's secure animated mode, where script does not run.
 */
const CONTAINMENT_SINKS = /\bcreateElementNS\b|\bDOMParser\b|\bh\s*\(\s*["'`]svg["'`]/i;

/**
 * The SVG media type, and the whole allow-list for the sweep that confines it.
 *
 * The type names an image context: an SVG document loaded as an image is rendered in secure animated mode, where script does not run and external references are not fetched, while the same text inlined as markup is not, so every spelling of the type in the served tree is pinned here rather than left to a reader's reading of the runtime.
 * The leaf's prefix declaration is the one place the type is part of a URL, the page's own favicon declaration names the type of a static same-origin asset, and the create form's file-picker filter names it to the picker alone; a spelling anywhere else, or a different one on a sanctioned line, is reported.
 */
const SVG_MEDIA_TYPE = /image\/svg\+xml/i;
const ICON_ACCEPT_LEAVES = new Set(["app/ts/ui/create.ts", "app/js/ui/create.js"]);
/** The page's own favicon declaration, the one place `index.html` names the type. */
const FAVICON_TYPE_STATEMENT = '<link rel="icon" type="image/svg+xml" href="images/favicon.svg">';
/** The create form's file-picker filter, the one place the type is named to a file input: the exact statement that builds the input, which the emitted copy spells identically, so a second `accept` line in the form is reported rather than admitted by a substring. */
const ICON_ACCEPT_STATEMENT = 'const iconInput = h("input", { type: "file", name: "icon", accept: "image/svg+xml,.svg" });';
function isSanctionedSvgMediaType(hit) {
	if (isSanctionedDataUrlStatement(hit)) return true;
	if (hit.file === "app/index.html" && hit.text === FAVICON_TYPE_STATEMENT) return true;
	return ICON_ACCEPT_LEAVES.has(hit.file) && hit.text === ICON_ACCEPT_STATEMENT;
}

test("a created invoice survives the share link and its blob container unchanged", () => {
	const invoice = usdcInvoice();
	assert.equal(computeTotals(invoice).total.text, "424.83");

	const fragment = encodeShare(invoice);
	assert.ok(fragment.startsWith(SHARE_FRAGMENT_PREFIX), "the link carries its payload on the share route");
	assert.equal(fragment, SHARE_FRAGMENT_PREFIX + encodeInvoice(invoice));
	assert.ok(!fragment.includes("?"), "the payload rides in the fragment, never in a query string");
	assert.equal(
		serializeInvoice(decodeInvoice(fragment.slice(SHARE_FRAGMENT_PREFIX.length))),
		serializeInvoice(invoice),
	);

	const url = buildShareUrl(invoice, "https://gateway.example/ipfs/bafy/index.html#/stale");
	const hashAt = url.indexOf("#");
	assert.equal(url.slice(0, hashAt), "https://gateway.example/ipfs/bafy/index.html");
	assert.equal(url.slice(hashAt), fragment, "the fragment replaces whatever the page's own URL carried");
	const fromUrl = decodeShare(url.slice(hashAt));
	assert.notEqual(fromUrl, null);
	assert.equal(serializeInvoice(fromUrl), serializeInvoice(invoice));

	const blob = encodeInvoiceBlob(invoice);
	assert.match(blob, /^pinv1b-/, "the base32 blob is self-describing");
	assert.equal(serializeInvoice(decodeInvoiceBlob(blob)), serializeInvoice(invoice));
	assert.equal(serializeInvoice(decodeShare(blob)), serializeInvoice(invoice));
});

test("a shared link renders the official document, and hostile text stays text", () => {
	const fake = installInteractiveDocument();
	try {
		const shell = mountSharedLink(encodeShare(usdcInvoice()));
		const text = textOf(shell.content);
		for (const shown of ["Studio Example Ltd", "#INV-2026-0042", "424.83 USDC", "USD Coin (USDC)", "VAT 19%"]) {
			assert.ok(text.includes(shown), `the rendered document is missing ${JSON.stringify(shown)}`);
		}
		assert.ok(findButton(shell.content, "Save as PDF"), "the export control is present");
		const pay = findButton(shell.content, "Pay");
		assert.ok(pay, "the payment control is present");
		assert.ok(!("disabled" in pay.attributes), "Pay is live for a payable invoice");

		const hostile = usdcInvoice({
			id: "INV-HOSTILE",
			payee: { name: HOSTILE, address: PAYEE },
			items: [{ description: HOSTILE, quantity: "1", unitPrice: "1" }],
			notes: HOSTILE,
		});
		const hostileShell = mountSharedLink(encodeShare(hostile));
		assert.ok(textOf(hostileShell.content).includes(HOSTILE), "the payload is shown verbatim, as text");
		assert.deepEqual(
			findAll(hostileShell.content, (node) => node.tagName === "script" || node.tagName === "img"),
			[],
			"no element was built from the payload",
		);
		for (const node of [hostileShell.content, ...findAll(hostileShell.content, () => true)]) {
			for (const value of Object.values(node.attributes)) {
				assert.ok(!String(value).includes("onerror"), `the payload reached the attribute ${value}`);
			}
		}

		// A privacy-chain invoice reaches the payer through the same shared link, and its payment link plus the symbol of that same URI are the whole payment path it offers.
		const zec = zecInvoice();
		const link = buildPaymentLink(zec);
		assert.equal(link.uri.startsWith("zcash:"), true, "the invoice's own scheme builds the link");
		const zecShell = mountSharedLink(encodeShare(zec));
		const zecText = textOf(zecShell.content);
		assert.ok(inputValues(zecShell.content).includes(ZEC_PAYEE), "the rendered document carries the address it pays to");
		assert.ok(inputValues(zecShell.content).includes("1.5"), "and the amount, in its own copy field");
		assert.ok(zecText.includes("1.5 ZEC"), "with the total due drawn in the asset's own figures");
		assert.ok(inputValues(zecShell.content).includes(link.uri), "and the payment link itself");
		assert.ok(zecText.includes(UNSUPPORTED_WALLET_MESSAGE), "beside a hint naming that hand-off");
		assert.equal(findButton(zecShell.content, "Pay"), undefined, "no injected-wallet control is offered for it");

		const grid = findAll(zecShell.content, (node) => hasClass(node, "payment-qr"))[0];
		assert.ok(grid, "the link's symbol is rendered");
		assert.equal(grid.attributes["aria-hidden"], "true", "decoration beside the link text, not a second statement of it");
		const zecView = buildInvoiceViewModel(zec, TODAY);
		assert.equal(zecView.paymentLink, link.uri, "the view model behind that document carries the URI the link text shows");
		assert.deepEqual(zecView.paymentQr.modules, encodeQr(link.uri).modules, "and its matrix is module for module the one that displayed URI encodes");
		assertSymbolCellsInDom(grid, zecView.paymentQr);

		// A Monero invoice reaches the payer the same way, through its own scheme: the link, the symbol of that same URI, and no injected-wallet control.
		const xmr = xmrInvoice();
		const xmrLink = buildPaymentLink(xmr);
		assert.equal(xmrLink.uri, `monero:${XMR_PAYEE}?tx_amount=1.5`, "the Monero link is its own scheme's spelling of the address and the amount");
		const xmrShell = mountSharedLink(encodeShare(xmr));
		const xmrText = textOf(xmrShell.content);
		assert.ok(inputValues(xmrShell.content).includes(XMR_PAYEE), "the rendered document carries the address it pays to");
		assert.ok(inputValues(xmrShell.content).includes("1.5"), "and the amount, in its own copy field");
		assert.ok(xmrText.includes("1.5 XMR"), "with the total due drawn in the asset's own figures");
		assert.ok(inputValues(xmrShell.content).includes(xmrLink.uri), "and the payment link itself");
		assert.ok(xmrText.includes(UNSUPPORTED_WALLET_MESSAGE), "beside a hint naming that hand-off");
		assert.equal(findButton(xmrShell.content, "Pay"), undefined, "no injected-wallet control is offered for it");

		const xmrGrid = findAll(xmrShell.content, (node) => hasClass(node, "payment-qr"))[0];
		assert.ok(xmrGrid, "the link's symbol is rendered");
		assert.equal(xmrGrid.attributes["aria-hidden"], "true", "decoration beside the link text, not a second statement of it");
		const xmrView = buildInvoiceViewModel(xmr, TODAY);
		assert.equal(xmrView.paymentLink, xmrLink.uri, "the view model behind that document carries the URI the link text shows");
		assert.deepEqual(xmrView.paymentQr.modules, encodeQr(xmrLink.uri).modules, "and its matrix is module for module the one that displayed URI encodes");
		assertSymbolCellsInDom(xmrGrid, xmrView.paymentQr);
	} finally {
		fake.restore();
	}
});

test("a Zcash invoice paying a mainnet unified address carries its link and its symbol, and offers no wallet control", () => {
	const invoice = zecInvoice({ payee: { name: "Studio Example Ltd", address: ZEC_UNIFIED_PAYEE } });
	const link = buildPaymentLink(invoice);
	assert.equal(link.uri, `zcash:${ZEC_UNIFIED_PAYEE}?amount=1.5`, "the unified payee reaches the link the invoice asks to be paid by");

	const fake = installInteractiveDocument();
	try {
		const shell = mountSharedLink(encodeShare(invoice));
		const text = textOf(shell.content);
		assert.ok(inputValues(shell.content).includes(ZEC_UNIFIED_PAYEE), "the rendered document carries the unified address it pays to");
		assert.ok(inputValues(shell.content).includes("1.5"), "and the amount, in its own copy field");
		assert.ok(text.includes("1.5 ZEC"), "with the total due drawn in the asset's own figures");
		assert.ok(inputValues(shell.content).includes(link.uri), "and the payment link built from it");
		assert.equal(findButton(shell.content, "Pay"), undefined, "no injected-wallet control is offered for it");

		const view = buildInvoiceViewModel(invoice, TODAY);
		assert.equal(view.paymentLink, link.uri, "the view model behind that document carries the URI the link text shows");
		assert.deepEqual(view.paymentQr.modules, encodeQr(link.uri).modules, "and its matrix is module for module the one that displayed URI encodes");
		const grid = findAll(shell.content, (node) => hasClass(node, "payment-qr"))[0];
		assert.ok(grid, "the link's symbol is rendered");
		assertSymbolCellsInDom(grid, view.paymentQr);
	} finally {
		fake.restore();
	}
});

test("Save as PDF in the rendered view downloads real PDF bytes with zero network I/O", async () => {
	const calls = [];
	const fake = installInteractiveDocument();
	const restoreNetwork = blockNetwork(calls);
	const blobs = [];
	const saved = [];
	const originalCreate = URL.createObjectURL;
	const originalRevoke = URL.revokeObjectURL;
	const prototype = globalThis.HTMLElement.prototype;
	const originalClick = prototype.click;
	URL.createObjectURL = (blob) => {
		blobs.push(blob);
		return `blob:acceptance-${blobs.length}`;
	};
	URL.revokeObjectURL = () => {};
	prototype.click = function click() {
		if (this.hasAttribute("download")) saved.push([this.getAttribute("href"), this.getAttribute("download")]);
	};
	try {
		const shell = mountSharedLink(encodeShare(usdcInvoice()));
		findButton(shell.content, "Save as PDF").dispatch("click", { type: "click" });
		await waitFor(() => saved.length > 0 || shell.notice.children.length > 0, 400);

		assert.deepEqual(saved, [["blob:acceptance-1", "invoice-INV-2026-0042.pdf"]]);
		assert.equal(shell.notice.children.length, 0, "a successful export shows no notice");
		assert.equal(blobs.length, 1, "the export produced exactly one file");
		assert.equal(blobs[0].type, "application/pdf");
		const bytes = new Uint8Array(await blobs[0].arrayBuffer());
		assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-", "the download is a real PDF");

		// The download is reopened as a real PDF and pinned to the invoice: one page, the project's own metadata, and the layout that produced those bytes carrying every figure the document shows.
		const opened = await PDFDocument.load(bytes, { updateMetadata: false });
		assert.equal(opened.getPageCount(), 1, "the exported invoice is one page");
		const { width, height } = opened.getPage(0).getSize();
		assert.deepEqual([width, height], [612, 792], "the page is US Letter");
		assert.equal(opened.getTitle(), "Invoice #INV-2026-0042");
		assert.equal(opened.getAuthor(), "Studio Example Ltd");
		assert.equal(opened.getCreator(), "Invoicing (on-chain payment invoice)");
		assert.equal(opened.getProducer(), "Invoicing (on-chain payment invoice)");

		const view = buildInvoiceViewModel(usdcInvoice(), TODAY);
		const pages = buildInvoicePages(view, PDF_METRICS);
		assert.equal(pages.length, opened.getPageCount(), "the layout paginates exactly as the exported file does");
		const drawn = pages
			.flatMap((page) => page.ops.filter((op) => op.kind === "text").map((op) => op.text))
			.join("\n");
		const drawnRun = pages.flatMap((page) => page.ops.filter((op) => op.kind === "text").map((op) => op.text)).join("");
		for (const figure of PDF_FIGURES) {
			assert.ok(drawn.includes(figure), `the exported layout loses ${JSON.stringify(figure)}`);
		}
		// The EIP-681 claim reaches the export too: the layout behind these bytes carries the invoice's own link, and the symbol beside it is that same URI's matrix, cell for cell.
		assert.ok(drawnRun.includes(buildPaymentLink(usdcInvoice()).uri), "the exported layout loses the invoice's own EIP-681 link");
		assertSymbolCells(pages[0], view);

		const direct = await renderInvoicePdf(usdcInvoice(), TODAY);
		assert.equal(new TextDecoder().decode(direct.slice(0, 5)), "%PDF-");
	} finally {
		URL.createObjectURL = originalCreate;
		URL.revokeObjectURL = originalRevoke;
		if (originalClick === undefined) delete prototype.click;
		else prototype.click = originalClick;
		restoreNetwork();
		fake.restore();
	}
	assert.deepEqual(calls, [], `the export attempted network I/O: ${calls.join(", ")}`);
});

test("Pay is the first thing that touches the wallet, and it sends one exact transfer", async () => {
	const calls = [];
	const fake = installInteractiveDocument();
	const provider = mockProvider();
	const installed = installWindow({ ethereum: provider });
	const restoreNetwork = blockNetwork(calls);
	try {
		const shell = mountSharedLink(encodeShare(usdcInvoice()));
		assert.deepEqual(provider.calls, [], "rendering the invoice touches no wallet");

		findButton(shell.content, "Pay").dispatch("click", { type: "click" });
		const connect = findButton(document.body, "Connect wallet & pay");
		assert.ok(connect, "the payment panel opened over the page");
		assert.deepEqual(provider.calls, [], "opening the payment panel touches no wallet");

		connect.dispatch("click", { type: "click" });
		await waitFor(() => provider.calls.some((call) => call.method === "eth_sendTransaction"), 200);
		await waitFor(() => textOf(shell.notice).includes(TX_HASH), 200);

		assert.deepEqual(
			provider.calls.map((call) => call.method),
			["eth_requestAccounts", "eth_chainId", "eth_chainId", "eth_call", "eth_chainId", "eth_sendTransaction"],
		);
		assert.deepEqual(provider.calls[3].params, [{ to: USDC_LOWER, data: encodeBalanceOf(ACCOUNT) }, "latest"]);
		assert.deepEqual(provider.calls.at(-1).params, [{ from: ACCOUNT, to: USDC_LOWER, value: "0x0", chainId: "0x1", data: encodeTransfer(PAYEE, USDC_TOTAL) }]);
		assert.ok(textOf(shell.notice).includes(TX_HASH), "the transaction hash is shown as the receipt");
	} finally {
		restoreNetwork();
		installed.restore();
		fake.restore();
	}
	assert.deepEqual(calls, [], `the payment flow attempted page-origin network I/O: ${calls.join(", ")}`);
});

test("the wallet layer sends value natively, calldata for a token, and refuses a wrong chain", async () => {
	const nativeProvider = mockProvider({ balance: toHexQuantity(ETH_TOTAL) });
	const nativeClient = new WalletClient(nativeProvider, "Mock");
	const nativePlan = buildPaymentPlan(ethInvoice());
	assert.equal(nativePlan.amount, ETH_TOTAL);
	const nativeSession = await connectWallet(nativeClient);
	await ensureWalletChain(nativeClient, nativePlan.chainId);
	assert.equal(
		await readBalance(nativeClient, nativePlan.asset, ACCOUNT),
		ETH_TOTAL,
		"the balance read is the wallet's own figure",
	);
	const nativeReceipt = await sendPayment(nativeClient, nativePlan, nativeSession);
	assert.equal(nativeReceipt.hash, TX_HASH);
	assert.equal(nativeReceipt.amount, ETH_TOTAL);
	assert.deepEqual(
		nativeProvider.calls.map((call) => call.method),
		["eth_requestAccounts", "eth_chainId", "eth_chainId", "eth_getBalance", "eth_chainId", "eth_sendTransaction"],
	);
	assert.deepEqual(nativeProvider.calls.at(-1).params, [{ from: ACCOUNT, to: PAYEE.toLowerCase(), value: "0x14d1120d7b160000", chainId: "0x1" }]);

	const tokenProvider = mockProvider();
	const tokenClient = new WalletClient(tokenProvider, "Mock");
	const tokenPlan = buildPaymentPlan(usdcInvoice());
	const tokenReceipt = await sendPayment(tokenClient, tokenPlan, await connectWallet(tokenClient));
	assert.equal(tokenReceipt.hash, TX_HASH);
	assert.deepEqual(tokenProvider.calls.at(-1).params, [{ from: ACCOUNT, to: USDC_LOWER, value: "0x0", chainId: "0x1", data: encodeTransfer(PAYEE, USDC_TOTAL) }]);

	const driftedProvider = mockProvider({ chainId: "0x89" });
	const driftedClient = new WalletClient(driftedProvider, "Mock");
	await assert.rejects(
		async () => sendPayment(driftedClient, tokenPlan, await connectWallet(driftedClient)),
		WrongChainError,
	);
	assert.equal(driftedProvider.calls.some((call) => call.method === "eth_sendTransaction"), false);
});

test("booting against a shared link renders it without touching the wallet or the network", () => {
	// Booting goes through the same `bootApp` the entry module calls; `tests/build.test.mjs` covers the entry module itself, and importing it here would shadow that test's own import.
	const calls = [];
	const fake = installInteractiveDocument();
	const provider = mockProvider();
	const installed = installWindow({ ethereum: provider });
	const fragment = encodeShare(usdcInvoice());
	const location = installLocation({
		href: `https://gateway.example/ipfs/bafy/index.html${fragment}`,
		hash: fragment,
	});
	const restoreNetwork = blockNetwork(calls);
	try {
		const mounted = document.createElement("div");
		const shell = bootApp(mounted, {
			baseUrl: "https://gateway.example/ipfs/bafy/index.html",
			today: TODAY,
			clipboard: null,
		});
		assert.equal(shell.content.children.length, 1, "the invoice view is mounted in the shell content region");
		assert.ok(mounted.children.length > 0, "the boot mounted the app");
		assert.ok(textOf(mounted).includes("#INV-2026-0042"), "the boot rendered the shared invoice");
		assert.ok(findButton(mounted, "Pay"), "the payment control is wired without being used");
		assert.deepEqual(provider.calls, [], "booting and rendering never asked the wallet for an account");
	} finally {
		restoreNetwork();
		location.restore();
		installed.restore();
		fake.restore();
	}
	assert.deepEqual(calls, [], `booting the page attempted network I/O: ${calls.join(", ")}`);
});

test("hostile share strings are refused, and a refused link shows a notice, not a document", () => {
	const json = serializeInvoice(usdcInvoice());
	const refusals = [
		["", ShareFormatError],
		["!!!!", ShareFormatError],
		[b32("not json"), ShareFormatError],
		[b32(json.replace("\"v\":1", "\"v\":9")), UnsupportedInvoiceVersionError],
		[b32(json.replace("\"id\"", "\"injected\":\"x\",\"id\"")), InvalidInvoiceError],
		[b32(json.replace(PAYEE, breakChecksum(PAYEE))), InvalidInvoiceError],
		[b32(json.replace("\"asset\":\"usdc\"", "\"asset\":\"dai\"")), InvalidInvoiceError],
		[b32(json.replace("\"chainId\":\"0x1\"", "\"chainId\":\"0x89\"")), InvalidInvoiceError],
		[
			b32(json.replace(`"address":"${PAYEE}"`, "\"address\":\"0x0000000000000000000000000000000000000000\"")),
			InvalidInvoiceError,
		],
		[b32(json.replace("\"quantity\":\"2\"", "\"quantity\":\"0\"")), InvalidInvoiceError],
		[b32(json.replace("\"unitPrice\":\"150\"", "\"unitPrice\":\"150.1234567\"")), InvalidInvoiceError],
		["A".repeat(MAX_PAYLOAD_CHARS + 1), ShareFormatError],
	];
	for (const [payload, error] of refusals) {
		assert.throws(() => decodeInvoice(payload), error, `decodeInvoice accepted ${JSON.stringify(payload.slice(0, 40))}`);
	}
	assert.throws(() => decodeShare(42), ShareFormatError);
	assert.throws(() => decodeInvoiceBlob("AAAA"), ShareFormatError);
	assert.throws(() => decodeInvoiceBlob("pinv1-AAAA"), ShareFormatError, "the retired base64url blob is refused");
	assert.throws(() => decodeInvoiceBlob("pinv2-AAAA"), UnsupportedShareVersionError);
	assert.equal(decodeShare("#/some/other/route"), null, "a fragment on another route falls through to the router");

	const fake = installInteractiveDocument();
	try {
		const shell = mountSharedLink(`#/i/${b32(json.replace("\"id\"", "\"injected\":\"x\",\"id\""))}`);
		assert.match(textOf(shell.notice), /invoice: /, "the refusal is shown as a notice");
		assert.ok(textOf(shell.content).includes("Create an invoice"), "the create view takes its place");
		for (const hash of ["#/i/", "#/i/!!!", "#/bogus", `#/i/${"A".repeat(MAX_PAYLOAD_CHARS + 1)}`]) {
			assert.notEqual(parseHash(hash).kind, "view", `the router rendered ${hash.slice(0, 20)}`);
		}
	} finally {
		fake.restore();
	}
});

test("a testnet unified payee is refused by name, so the link renders a notice and no document", () => {
	// The Bech32m container a testnet wallet hands out: built here from the encoder the app ships, on the part its own validator refuses.
	const testnetPayee = bech32m.encode("utest", bech32m.toWords(new Uint8Array(61)), false);
	const payee = { name: "Studio Example Ltd", address: testnetPayee };
	assert.throws(
		() => zecInvoice({ payee }),
		InvalidInvoiceError,
		"a testnet unified payee is refused where the payee creates the invoice",
	);
	const refusal = refusalMessage(() => zecInvoice({ payee }));
	assert.match(refusal, /^invoice: payee\.address: /, "the refusal reaches the payee on the field they pasted into");
	assert.match(refusal, /a testnet unified address cannot be paid from a mainnet-only invoice/, "and names the network rather than reading as a malformed paste");
	assert.match(refusal, /"utest"/, "and the human-readable part it decoded under");

	// The same payee inside a shared payload is refused again, so no link can carry one into a mainnet-only invoice.
	const payload = b32(serializeInvoice(zecInvoice()).replace(ZEC_PAYEE, testnetPayee));
	const payloadRefusal = refusalError(() => decodeInvoice(payload));
	assert.equal(payloadRefusal.name, "InvalidInvoiceError", "a shared payload carrying a testnet unified payee is refused");
	assert.ok(
		payloadRefusal.cause instanceof TestnetUnifiedAddressError,
		"and the model boundary keeps the validator's own class as the cause, so a surface above it classifies the refusal without matching the message it was wrapped into",
	);

	const fake = installInteractiveDocument();
	try {
		const shell = mountSharedLink(`#/i/${payload}`);
		assert.match(
			textOf(shell.notice),
			/invoice: payee\.address: zcash-address: a testnet unified address cannot be paid from a mainnet-only invoice/,
			"the payer is shown the refusal, with the network named",
		);
		const text = textOf(shell.content);
		assert.ok(!text.includes("#INV-ZEC-1"), "no document is rendered for it");
		assert.ok(text.includes("Create an invoice"), "the create view takes its place");
		assert.equal(findButton(shell.content, "Pay"), undefined, "and no wallet control is offered for it");
		assert.equal(findButton(shell.content, "Save as PDF"), undefined, "nor an export of a document that does not exist");
	} finally {
		fake.restore();
	}
});

/**
 * The whole allow-list for the absolute-URL sweep: the one statement that declares the SVG namespace name the icon gate's root check reads.
 *
 * That name is an absolute URL in spelling alone: a parser matches it as an XML namespace name and never dereferences it, so the runtime resolves no reference through it, while an `href` or a `src` is exactly the kind of reference this sweep exists to keep out.
 * The exemption is content-specific rather than file-wide, exactly as the `data:`-literal one is: it admits the one statement that declares the constant, so a second absolute URL in that file, in the compiled copy, or behind another spelling of the same name is still reported.
 */
const NAMESPACE_LEAVES = new Set(["app/ts/invoice/icon.ts", "app/js/invoice/icon.js"]);
/** The namespace name the icon gate requires on a root `<svg>` element, composed into the statement below so the pin and the source cannot disagree. */
const SANCTIONED_SVG_NAMESPACE = "http://www.w3.org/2000/svg";
/** The exact statement that declares it: the whole allow-list for this exemption. */
const SANCTIONED_SVG_NAMESPACE_STATEMENT = `const SVG_NAMESPACE = "${SANCTIONED_SVG_NAMESPACE}";`;
function isSanctionedSvgNamespace(hit) {
	return NAMESPACE_LEAVES.has(hit.file) && hit.text === SANCTIONED_SVG_NAMESPACE_STATEMENT;
}

test("no served runtime module can build markup, evaluate code, or reach the network", async () => {
	const runtime = [
		...(await filesUnder(join(appDir, "ts"))),
		...(await filesUnder(jsDir)).filter(isOurModule),
		...(await filesUnder(join(appDir, "stylesheets"))),
		join(appDir, "index.html"),
	];
	assert.ok(runtime.length >= 30, `the sweep found only ${runtime.length} runtime files`);
	assert.deepEqual(occurrences(runtime, NETWORK_APIS, { htmlComments: true }), [], "a runtime file names a network API");
	assert.deepEqual(occurrences(runtime, STORAGE_APIS, { htmlComments: true }), [], "a runtime file names a storage or side-channel API");
	assert.deepEqual(
		occurrences(runtime, MARKUP_SINKS, { htmlComments: true, except: isSanctionedElementBuilder }),
		[],
		"a runtime file names a markup or script sink",
	);
	assert.deepEqual(
		occurrences(runtime, SCRIPT_URL_VECTORS, { htmlComments: true, except: isSanctionedDataUrlStatement }),
		[],
		"a runtime file assigns a src or carries a script-bearing URL scheme",
	);
	assert.deepEqual(
		occurrences(runtime, RAW_SRC_SETTER, { htmlComments: true, except: isSanctionedSrcSetter }),
		[],
		"a runtime file sets a src attribute outside the sanctioned sites",
	);
	assert.deepEqual(occurrences(runtime, CONTAINMENT_SINKS, { htmlComments: true }), [], "a runtime file builds or parses inline SVG markup");
	assert.deepEqual(
		occurrences(runtime, SVG_MEDIA_TYPE, { htmlComments: true, except: isSanctionedSvgMediaType }),
		[],
		"the SVG media type is spelled outside the sanctioned statements",
	);
	assert.deepEqual(occurrences(runtime, /https?:\/\//, { htmlComments: true, except: isSanctionedSvgNamespace }), [], "a runtime file names an absolute URL outside the one statement that declares the SVG namespace name");
	assert.deepEqual(occurrences(runtime, /\.style\b/, { htmlComments: true }), [], "a runtime file styles an element from script");
});

/**
 * The runtime sweeps' own pins, in two halves: every vector each pattern names is reported, and every exemption allow-list admits exactly the sites it names and no other line of the tree.
 * Each pattern's alternatives are pinned one vector at a time — every alternative of {@link MARKUP_SINKS}, both `src`-assignment spellings and all five URL schemes of the script-URL sweep, both raw-setter alternatives, and all three containment constructs — so an alternative narrowed or widened in a pattern fails here.
 * The allow-lists exercised here are the DOM-creation sweep's ({@link isSanctionedElementBuilder}), the script-URL sweep's (the leaf's prefix declaration, in both the spellings it accepts), the raw `src`-setter sweep's ({@link isSanctionedSrcSetter}), and the SVG media-type sweep's ({@link isSanctionedSvgMediaType}); the containment pattern is exercised without one, since it exempts nothing.
 */
test("the runtime sweeps catch the vectors they name and each allow-list exempts exactly the sites it names", () => {
	// One vector per alternative MARKUP_SINKS names, so the pattern's whole set is pinned rather than a sample of it: the literal sinks and the script-building spellings, the DOM-creation route, and the import and navigation routes.
	const vectors = [
		"el.innerHTML = markup;",
		"el.outerHTML = markup;",
		"el.insertAdjacentHTML(\"beforeend\", markup);",
		"document.write(markup);",
		"eval(code);",
		"new Function(code);",
		"range.createContextualFragment(markup);",
		"const script = document.createElement(\"script\");",
		"const script = h(\"script\");",
		"script.textContent = code;",
		"const el = document.createElement(name);",
		"const mod = await import(specifier);",
		"window.open(target, \"_blank\");",
		"location.assign(target);",
		"location.replace(target);",
		"location.href = target;",
	];
	for (const vector of vectors) {
		assert.ok(MARKUP_SINKS.test(vector), `the sweep misses ${vector}`);
	}
	assert.ok(SCRIPT_URL_VECTORS.test("el.src = url;"), "the script-URL sweep catches a direct src assignment");
	assert.ok(SCRIPT_URL_VECTORS.test('el["src"] = url;'), "the script-URL sweep catches a computed-member src assignment too");
	for (const literal of ["\"javascript:alert(1)\"", "'data:text/html,x'", "\"vbscript:msgbox(1)\"", "\"blob:https://example/x\"", "'file:///etc/passwd'"]) {
		assert.ok(SCRIPT_URL_VECTORS.test(literal), `the script-URL sweep misses ${literal}`);
	}
	assert.ok(MARKUP_SINKS.test("const element = document.createElement(\"a\");"), "a DOM-creation call is a sink whatever tag it is handed, so the allow-list is what exempts one, not the tag");
	// The sweep's whole allow-list, pinned so it cannot widen unnoticed: the builder's one sanctioned call, the documented download anchor, and neither a forbidden tag literal nor any other call anywhere.
	assert.ok(
		isSanctionedElementBuilder({ file: "app/ts/util/dom.ts", text: "const element = document.createElement(tag);" }),
		"the builder's own call is exempt in it",
	);
	assert.ok(
		!isSanctionedElementBuilder({ file: "app/ts/util/dom.ts", text: 'const element = document.createElement("script");' }),
		"the builder's file exempts no forbidden tag literal",
	);
	assert.ok(
		!isSanctionedElementBuilder({ file: "app/ts/util/dom.ts", text: 'const frame = document.createElement("iframe");' }),
		"nor another literal tag in it",
	);
	assert.ok(
		!isSanctionedElementBuilder({ file: "app/ts/util/dom.ts", text: "const element = document.createElement(tagName);" }),
		"and no other createElement call in the builder's file is exempt",
	);
	assert.ok(
		!isSanctionedElementBuilder({ file: "app/ts/util/dom.ts", text: "const element = document.createElement(mytag);" }),
		"and the sanctioned identifier is word-anchored, so a longer name that merely ends in `tag` is not exempt",
	);
	assert.ok(
		isSanctionedElementBuilder({ file: "app/ts/pdf/renderer.ts", text: 'const link = document.createElement("a");' }),
		"the documented download anchor is exempt",
	);
	assert.ok(
		!isSanctionedElementBuilder({ file: "app/ts/pdf/renderer.ts", text: "const link = document.createElement(tag);" }),
		"another tag in the anchor's file is not",
	);
	assert.ok(
		!isSanctionedElementBuilder({ file: "app/ts/util/dom.ts", text: "el.innerHTML = markup; const element = document.createElement(tag);" }),
		"a sanctioned call sharing its line with an unsanctioned sink is reported, since the exemption matches the whole statement",
	);
	assert.ok(
		!isSanctionedElementBuilder({ file: "app/ts/pdf/renderer.ts", text: 'const link = document.createElement("a"); const frame = document.createElement("iframe");' }),
		"and so is the anchor's call beside a second createElement on its line",
	);
	assert.ok(
		isSanctionedElementBuilder({ file: "app/ts/pdf/rasterize.ts", text: 'const image = document.createElement("img");' }),
		"the rasterizer's image element is exempt",
	);
	assert.ok(
		isSanctionedElementBuilder({ file: "app/ts/pdf/rasterize.ts", text: 'const canvas = document.createElement("canvas");' }),
		"and the canvas it draws into",
	);
	assert.ok(
		!isSanctionedElementBuilder({ file: "app/ts/pdf/rasterize.ts", text: 'const frame = document.createElement("iframe");' }),
		"but no other tag literal in the rasterizer is",
	);
	assert.ok(
		!isSanctionedElementBuilder({ file: "app/ts/pdf/rasterize.ts", text: 'const frame = document.createElement("img"); const other = document.createElement("canvas");' }),
		"and a line that is not one of the two sanctioned statements is reported, since the rasterizer's exemption is site-exact",
	);
	assert.ok(
		!isSanctionedElementBuilder({ file: "app/ts/ui/view.ts", text: 'document.createElement("a");' }),
		"and the anchor's tag exempts nothing in another file",
	);
	// A trailing comment naming a sanctioned call exempts nothing: the sweep hands the exemption the same comment-stripped line it tests the sink pattern against.
	const commentedCall = sourceHits(
		"app/ts/util/dom.ts",
		'const frame = document.createElement("iframe"); // const element = document.createElement(tag) is sanctioned',
		MARKUP_SINKS,
		{ htmlComments: true },
	)[0];
	assert.ok(commentedCall !== undefined, "the call beside a trailing comment is reported");
	assert.equal(commentedCall.text, 'const frame = document.createElement("iframe");', "and the hit is the line's code, not the comment beside it");
	assert.ok(!isSanctionedElementBuilder(commentedCall), "so a trailing comment naming the sanctioned call exempts no other call on the line");
	// The script-URL sweep's whole allow-list, pinned the same way: the statement declaring the leaf's prefix constant is exempt through the script-URL sweep's own path, and no other spelling or line is.
	assert.deepEqual(
		occurrences([join(appDir, "ts", "util", "data-url.ts")], SCRIPT_URL_VECTORS, { htmlComments: true, except: isSanctionedDataUrlStatement }),
		[],
		"the statement declaring the leaf's prefix constant is exempt in the file the script-URL sweep reads",
	);
	assert.ok(
		isSanctionedDataUrlStatement({ file: "app/ts/util/data-url.ts", text: SANCTIONED_DATA_URL_STATEMENT }),
		"the statement declaring the leaf's prefix constant is exempt",
	);
	assert.ok(
		isSanctionedDataUrlStatement({ file: "app/ts/util/data-url.ts", text: SANCTIONED_DATA_URL_EXPORT_STATEMENT }),
		"the `export const` spelling of that same declaration is admitted as well, which is the spelling the leaf itself writes",
	);
	// Each leaf file is pinned with the spelling it actually contains — the source writes `export const`, and so does the line the compiler emits beside it — and with the other spelling too, since the allow-list pairs no file with one spelling: the four assertions around this comment are the whole cross-product of the two files and the two spellings.
	assert.ok(
		isSanctionedDataUrlStatement({ file: "app/js/util/data-url.js", text: SANCTIONED_DATA_URL_EXPORT_STATEMENT }),
		"the compiled copy writes the `export const` spelling as well, and that line is the one it carries",
	);
	assert.ok(
		isSanctionedDataUrlStatement({ file: "app/js/util/data-url.js", text: SANCTIONED_DATA_URL_STATEMENT }),
		"and the spelling without `export` is admitted in the compiled copy too, so the exemption is not a per-file pairing",
	);
	assert.ok(
		!isSanctionedDataUrlStatement({ file: "app/ts/util/data-url.ts", text: `export  ${SANCTIONED_DATA_URL_STATEMENT}` }),
		"and a stray extra space in it is a different line, so it is reported rather than admitted",
	);
	assert.ok(
		!isSanctionedDataUrlStatement({ file: "app/ts/util/data-url.ts", text: `export const SVG_DATA_URL_PREFIX = "data:text/html,x";` }),
		"and neither spelling admits a different literal behind that constant name",
	);
	assert.ok(
		!isSanctionedDataUrlStatement({ file: "app/ts/util/data-url.ts", text: 'const url = "javascript:alert(1)";' }),
		"a script-bearing scheme in the leaf is not",
	);
	assert.ok(
		!isSanctionedDataUrlStatement({ file: "app/ts/util/data-url.ts", text: 'const url = "data:text/html,x";' }),
		"nor another `data:` literal in it",
	);
	assert.ok(
		!isSanctionedDataUrlStatement({ file: "app/ts/util/data-url.ts", text: 'const url = "blob:https://example/x";' }),
		"nor a `blob:` literal in it",
	);
	assert.ok(
		!isSanctionedDataUrlStatement({ file: "app/ts/util/data-url.ts", text: 'const url = "vbscript:msgbox(1)";' }),
		"nor a `vbscript:` literal in it",
	);
	assert.ok(
		!isSanctionedDataUrlStatement({ file: "app/ts/util/data-url.ts", text: 'const url = "file:///etc/passwd";' }),
		"nor a `file:` literal in it",
	);
	assert.ok(
		!isSanctionedDataUrlStatement({ file: "app/ts/util/data-url.ts", text: `el.src = "${SANCTIONED_DATA_URL_LITERAL}";` }),
		"nor a `src` assignment carrying the sanctioned literal",
	);
	assert.ok(
		!isSanctionedDataUrlStatement({ file: "app/ts/util/data-url.ts", text: `el.href = "${SANCTIONED_DATA_URL_LITERAL}";` }),
		"nor a sibling sink handed the same literal, which the exact-statement pin reports",
	);
	assert.ok(
		SCRIPT_URL_VECTORS.test(`el.SRC = "${SANCTIONED_DATA_URL_LITERAL}";`),
		"the script-URL sweep catches a `src` assignment in any casing",
	);
	assert.ok(
		!isSanctionedDataUrlStatement({ file: "app/ts/util/data-url.ts", text: `el.SRC = "${SANCTIONED_DATA_URL_LITERAL}";` }),
		"and the exemption agrees, so a mixed-case assignment carrying the sanctioned literal is still reported",
	);
	assert.ok(
		!isSanctionedDataUrlStatement({ file: "app/ts/ui/view.ts", text: SANCTIONED_DATA_URL_STATEMENT }),
		"and the same literal in another file is not exempt",
	);
	assert.ok(!SCRIPT_URL_VECTORS.test("const record = { updateMetadata: false };"), "a plain property is not a URL scheme");
	// The containment sweeps' own pins: every construct they name is reported, the leaf's image sink is not one of them, and each allow-list admits exactly the statements it names.
	assert.ok(RAW_SRC_SETTER.test('img.setAttribute("src", url);'), "the raw-src sweep catches a literal setter");
	assert.ok(RAW_SRC_SETTER.test("img.setAttribute('SRC', url);"), "in any casing of the attribute name");
	assert.ok(
		RAW_SRC_SETTER.test('img.setAttributeNS(null, "src", url);'),
		"and a namespaced setter, whose `src` is the second argument rather than the first",
	);
	assert.ok(
		!isSanctionedSrcSetter({ file: "app/ts/pdf/rasterize.ts", text: 'img.setAttribute("src", svgDataUrl(svg));' }),
		"the leaf's builder is not an exempt spelling: the sanctioned value is the rasterizer's own branded parameter, not a URL a sink builds for itself",
	);
	assert.ok(
		isSanctionedSrcSetter({ file: "app/ts/pdf/rasterize.ts", text: 'image.setAttribute("src", dataUrl);' }),
		"the rasterizer's own sink is exempt when the whole line is the one statement handing the branded data URL the view model armed",
	);
	assert.ok(
		!isSanctionedSrcSetter({ file: "app/ts/pdf/rasterize.ts", text: 'image.setAttribute("src", dataUrl); other.setAttribute("src", url);' }),
		"a line carrying the sanctioned call beside an unsanctioned setter is reported, since the exemption matches the whole statement",
	);
	assert.ok(
		!isSanctionedSrcSetter({ file: "app/ts/pdf/rasterize.ts", text: 'img.setAttributeNS(null, "src", dataUrl);' }),
		"and a namespaced setter is reported even when it hands over the branded value, since only the plain setter is the sanctioned site",
	);
	assert.ok(
		!isSanctionedSrcSetter({ file: "app/ts/pdf/rasterize.ts", text: 'img.setAttribute("src", url);' }),
		"and not when it hands over anything else",
	);
	assert.ok(
		!isSanctionedSrcSetter({ file: "app/ts/ui/view.ts", text: 'img.setAttribute("src", svgDataUrl(svg));' }),
		"and the leaf's builder in a third file exempts nothing, since the allow-list names the rasterizer alone and the value it hands the attribute",
	);
	assert.ok(
		!isSanctionedSrcSetter({ file: "app/ts/pdf/rasterize.ts", text: 'img.setAttribute("src", value);' }),
		"a plain identifier value is refused",
	);
	assert.ok(
		!isSanctionedSrcSetter({ file: "app/ts/pdf/rasterize.ts", text: 'img.setAttribute("src", mydataUrl);' }),
		"and a longer identifier a caller might think matches is refused too, since the exemption matches the whole statement",
	);
	assert.ok(
		!isSanctionedSrcSetter({ file: "app/ts/pdf/rasterize.ts", text: 'img.setAttribute("src", "logo.svg");' }),
		"and a plain string value is refused",
	);
	assert.ok(
		!isSanctionedSrcSetter({ file: "app/ts/util/dom.ts", text: 'element.setAttribute("src", dataUrl);' }),
		"and a literal setter in the builder's file, which spells none of its own, is reported like one in any other file",
	);
	// The admitted statement carries the rasterizer's own `dataUrl` parameter, so its declaration is what makes that value the icon leaf's branded one rather than a name the sweep trusts on sight.
	assert.match(
		readFileSync(join(appDir, "ts", "pdf", "rasterize.ts"), "utf8"),
		/rasterizeSvgIcon\(dataUrl:\s*SvgDataUrl\)/,
		"the rasterizer declares its sanctioned value as the icon leaf's own `SvgDataUrl`",
	);
	for (const vector of ['document.createElementNS(ns, "svg");', "const parser = new DOMParser();", 'h("svg", {});']) {
		assert.ok(CONTAINMENT_SINKS.test(vector), `the containment sweep misses ${vector}`);
	}
	assert.ok(!CONTAINMENT_SINKS.test('h("img", { src: svgDataUrl(svg) });'), "the image sink is the sanctioned route, not a containment breach");
	assert.ok(isSanctionedSvgNamespace({ file: "app/ts/invoice/icon.ts", text: SANCTIONED_SVG_NAMESPACE_STATEMENT }), "the one statement declaring the SVG namespace name is exempt from the absolute-URL sweep");
	assert.ok(!isSanctionedSvgNamespace({ file: "app/ts/invoice/icon.ts", text: `const remote = "${SANCTIONED_SVG_NAMESPACE}/x";` }), "and no other line of that file is, a namespace literal beside the sanctioned one included");
	assert.ok(!isSanctionedSvgNamespace({ file: "app/ts/util/dom.ts", text: SANCTIONED_SVG_NAMESPACE_STATEMENT }), "nor the same statement in another file");
	assert.ok(!isSanctionedSvgNamespace({ file: "app/ts/invoice/icon.ts", text: `el.src = "${SANCTIONED_SVG_NAMESPACE}";` }), "nor a sink handed the namespace name");
	assert.ok(!isSanctionedSvgNamespace({ file: "app/ts/invoice/icon.ts", text: SANCTIONED_SVG_NAMESPACE_STATEMENT.replace("const", "let") }), "nor an assignment to the same constant name in another spelling");
	assert.deepEqual(
		occurrences([join(appDir, "index.html")], SVG_MEDIA_TYPE, { htmlComments: true, except: isSanctionedSvgMediaType }),
		[],
		"the page's own favicon declaration is the only spelling the page may carry",
	);
	assert.ok(
		isSanctionedSvgMediaType({ file: "app/index.html", text: FAVICON_TYPE_STATEMENT }),
		"the favicon declaration is exempt",
	);
	assert.ok(
		!isSanctionedSvgMediaType({ file: "app/index.html", text: '<link rel="icon" type="image/svg+xml" href="https://evil.example/x.svg">' }),
		"and another line naming the type in the page is not",
	);
	assert.ok(
		isSanctionedSvgMediaType({ file: "app/ts/ui/create.ts", text: ICON_ACCEPT_STATEMENT }),
		"the create form's file-picker filter is exempt",
	);
	assert.ok(
		!isSanctionedSvgMediaType({ file: "app/ts/ui/create.ts", text: 'accept: "image/svg+xml,.svg",' }),
		"but a second `accept` line in the create form is not",
	);
	assert.ok(
		!isSanctionedSvgMediaType({ file: "app/ts/ui/create.ts", text: 'type: "image/svg+xml",' }),
		"nor another spelling of the type in the create form",
	);
	assert.ok(
		isSanctionedSvgMediaType({ file: "app/js/ui/create.js", text: ICON_ACCEPT_STATEMENT }),
		"and the emitted copy of that same statement is exempt too",
	);
});

test("the hand-off sentence has one spelling across the authored tree and the README", async () => {
	assert.equal(
		countOccurrences(await authoredTreeText(), UNSUPPORTED_WALLET_MESSAGE),
		1,
		"the sentence has one spelling across the authored sources, the stylesheets, the page, and the README, so a copy inlined in a third authored file fails here",
	);
});

test("the vendored bundles name no network API or markup sink outside their own documentation", async () => {
	const vendor = (await filesUnder(vendorDir)).filter((file) => file.endsWith(".js"));
	// The sweep reaches only the bundles the build copied into app/js/vendor/, so a bundle missing there would silently narrow it; pin the swept set to the bundles the vendor script serves.
	assert.deepEqual(
		vendor.map((file) => relative(vendorDir, file)).sort(),
		[...SERVED_BUNDLES].sort(),
		"the sweep must cover exactly the bundles the build serves",
	);
	// `require-trusted-types-for 'script'` turns a markup sink in a vendored bundle into a hard Chromium runtime failure, so the sweep has to cover both lists, not just the network APIs.
	assert.deepEqual(occurrences(vendor, NETWORK_APIS), [], "a vendored bundle calls a network API from executable code");
	assert.deepEqual(occurrences(vendor, STORAGE_APIS), [], "a vendored bundle names a storage or side-channel API from executable code");
	assert.deepEqual(occurrences(vendor, MARKUP_SINKS), [], "a vendored bundle names a markup or script sink from executable code");
});

test("every reference the served tree makes is same-origin and present in app/", async () => {
	const html = readFileSync(join(appDir, "index.html"), "utf8");
	const references = [...html.matchAll(/\s(?:src|href)="([^"]*)"/g)].map((match) => match[1]);
	assert.ok(references.length >= 5, "index.html loads its icon, stylesheets, and entry module");
	for (const reference of references) {
		assert.doesNotMatch(reference, /^[a-z][a-z0-9+.-]*:/i, `index.html references the absolute URL ${reference}`);
		assert.doesNotMatch(reference, /^\/\//, `index.html references the cross-origin URL ${reference}`);
		assert.ok(existsSync(join(appDir, reference)), `index.html references ${reference}, which is not in app/`);
	}

	for (const file of await filesUnder(join(appDir, "stylesheets"))) {
		const css = readFileSync(file, "utf8");
		const label = relative(root, file);
		assert.ok(!/@import\b/.test(css), `${label} imports another stylesheet`);
		assert.ok(!/@font-face\b/.test(css), `${label} loads a web font`);
		for (const [, raw] of css.matchAll(/url\(([^)]*)\)/g)) {
			const reference = raw.trim().replace(/^['"]|['"]$/g, "");
			assert.doesNotMatch(reference, /^[a-z][a-z0-9+.-]*:/i, `${label} loads ${reference}`);
			assert.ok(existsSync(resolve(dirname(file), reference)), `${label} loads ${reference}, which is not in app/`);
		}
	}

	for (const file of await filesUnder(join(appDir, "images"))) {
		const svg = readFileSync(file, "utf8");
		const label = relative(root, file);
		assert.ok(!/<script\b/i.test(svg), `${label} carries a script`);
		assert.ok(!/\son[a-z]+\s*=/i.test(svg), `${label} carries an inline event handler`);
		assert.ok(!/@font-face/i.test(svg), `${label} loads a web font`);
		assert.ok(!/url\(\s*['"]?[a-z][a-z0-9+.-]*:/i.test(svg), `${label} loads a remote resource`);
		assert.ok(!/(?:xlink:)?href\s*=\s*['"]?(?:https?:)?\/\//i.test(svg), `${label} references a remote resource`);
	}
});

test("index.html pins the policy the app's guarantees rest on", () => {
	const html = readFileSync(join(appDir, "index.html"), "utf8");
	const policy = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/);
	assert.ok(policy, "index.html must carry a CSP meta tag");
	const directives = new Map(
		policy[1]
			.split(";")
			.map((entry) => entry.trim())
			.filter((entry) => entry !== "")
			.map((entry) => {
				const [name, ...values] = entry.split(/\s+/);
				return [name, values];
			}),
	);
	assert.deepEqual(Object.fromEntries(directives), {
		"default-src": ["'self'"],
		"base-uri": ["'none'"],
		"object-src": ["'none'"],
		"frame-src": ["'none'"],
		"child-src": ["'none'"],
		"worker-src": ["'none'"],
		"manifest-src": ["'none'"],
		"media-src": ["'none'"],
		"form-action": ["'none'"],
		"script-src": ["'self'"],
		"script-src-elem": ["'self'", "'unsafe-inline'"],
		"script-src-attr": ["'none'"],
		"style-src": ["'self'"],
		"style-src-attr": ["'none'"],
		"img-src": ["'self'", "data:"],
		"font-src": ["'none'"],
		"connect-src": ["'none'"],
		"require-trusted-types-for": ["'script'"],
	});
	assert.match(html, /<meta name="referrer" content="no-referrer">/, "the fragment-bearing URL is never referred");
	assert.ok(!/\son[a-z]+\s*=/i.test(html), "index.html must not use inline event handlers");
	assert.ok(!/<style\b/i.test(html), "index.html must not use inline <style> blocks");
	assert.ok(
		!/javascript:/i.test(codeOnly(html, { htmlComments: true })),
		"index.html must not carry a javascript: URL in its markup",
	);
});

test("the README quotes the policy index.html pins, verbatim and once", () => {
	const html = readFileSync(join(appDir, "index.html"), "utf8");
	const policy = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/);
	assert.ok(policy, "index.html must carry a CSP meta tag");
	const readme = readFileSync(join(root, "README.md"), "utf8");
	assert.ok(
		readme.includes(`pins a CSP meta tag: \`${policy[1]}\``),
		"the README quotes the policy index.html pins, so the documented policy cannot drift from the served one",
	);
	assert.equal(countOccurrences(readme, "default-src"), 1, "and the README spells the policy once, so no stale second copy can survive beside it");
});

test("the README's stated caps are the ones the code enforces", () => {
	const readme = readFileSync(join(root, "README.md"), "utf8");
	assert.ok(readme.includes(`${MAX_JSON_BYTES / 1024} KiB of JSON`), `the README states the payload cap the codec applies, ${MAX_JSON_BYTES} bytes`);
	assert.ok(
		readme.includes(`\`MAX_ICON_SVG_BYTES = ${MAX_ICON_SVG_BYTES}\` UTF-8 bytes`),
		`the README states the byte cap the icon gate applies, ${MAX_ICON_SVG_BYTES}`,
	);
	assert.ok(
		readme.includes(`\`MAX_ICON_DIMENSION = ${MAX_ICON_DIMENSION}\` pixels an axis`),
		`the README states the dimension cap the icon gate applies, ${MAX_ICON_DIMENSION}`,
	);
});

test("the committed app/ tree is a fresh build of its sources, with maps pointing back to ts/", async () => {
	const problems = await servedTreeProblems();
	assert.deepEqual(problems, [], problems.join("\n"));

	const emitted = (await filesUnder(jsDir)).filter(isOurModule);
	assert.ok(emitted.length >= 20, `expected the compiled modules, found ${emitted.length}`);
	for (const file of emitted) {
		const label = relative(root, file);
		const emittedPath = relative(jsDir, file);
		const sourcePath = join(appDir, "ts", emittedPath.replace(/\.js$/, ".ts"));
		const map = JSON.parse(readFileSync(`${file}.map`, "utf8"));
		assert.equal(map.version, 3, `${label} has no v3 source map`);
		assert.equal(map.file, basename(file));
		assert.deepEqual(map.sources, [relative(dirname(file), sourcePath).split(sep).join("/")]);
		assert.equal(map.sourcesContent.length, 1);
		assert.ok(existsSync(sourcePath), `${label} maps to ${sourcePath}, which does not exist`);
		assert.equal(map.sourcesContent[0], readFileSync(sourcePath, "utf8"), `${label} embeds a stale copy of its source`);
	}
});

test("a Monero invoice exports from the served page carrying its link and the symbol of that same URI", async () => {
	const invoice = xmrInvoice();
	const link = buildPaymentLink(invoice);
	assert.equal(link.uri, `monero:${XMR_PAYEE}?tx_amount=1.5`, "the invoice's own scheme builds the link");

	const calls = [];
	const fake = installInteractiveDocument();
	const restoreNetwork = blockNetwork(calls);
	const blobs = [];
	const saved = [];
	const revoked = [];
	const originalCreate = URL.createObjectURL;
	const originalRevoke = URL.revokeObjectURL;
	const prototype = globalThis.HTMLElement.prototype;
	const originalClick = prototype.click;
	URL.createObjectURL = (blob) => {
		blobs.push(blob);
		return `blob:monero-${blobs.length}`;
	};
	URL.revokeObjectURL = (url) => revoked.push(url);
	prototype.click = function click() {
		if (this.hasAttribute("download")) saved.push([this.getAttribute("href"), this.getAttribute("download")]);
	};
	try {
		const shell = mountSharedLink(encodeShare(invoice));
		findButton(shell.content, "Save as PDF").dispatch("click", { type: "click" });
		await waitFor(() => saved.length > 0 || shell.notice.children.length > 0, 400);

		assert.deepEqual(saved, [["blob:monero-1", "invoice-INV-XMR-1.pdf"]], "the served page downloads the invoice's own file");
		assert.equal(shell.notice.children.length, 0, "a successful export shows no notice");
		assert.equal(blobs.length, 1, "the export produced exactly one file");
		assert.equal(blobs[0].type, "application/pdf");
		// The renderer revokes the object URL a second after the click, so that wait is taken here rather than left to fire while another suite's spy is installed.
		await waitFor(() => revoked.length > 0, 400);
		assert.deepEqual(revoked, ["blob:monero-1"], "the object URL is released once the download is under way");

		// The reopened blob is this invoice: one page, and the layout behind those bytes carries the link the invoice asks to be paid by together with the symbol of that same URI.
		const bytes = new Uint8Array(await blobs[0].arrayBuffer());
		assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-", "the download is a real PDF");
		const opened = await PDFDocument.load(bytes, { updateMetadata: false });
		assert.equal(opened.getPageCount(), 1, "the exported Monero invoice is one page");
		assert.equal(opened.getTitle(), "Invoice #INV-XMR-1");

		const view = buildInvoiceViewModel(invoice, TODAY);
		const pages = buildInvoicePages(view, PDF_METRICS);
		assert.equal(pages.length, opened.getPageCount(), "the layout paginates exactly as the exported file does");
		const drawn = pages.flatMap((page) => page.ops.filter((op) => op.kind === "text").map((op) => op.text)).join("");
		assert.ok(drawn.includes(link.uri), "the layout behind those bytes carries the payment link");
		assert.ok(drawn.includes(XMR_PAYEE), "and the address it pays to");
		assert.ok(drawn.includes("1.5 XMR"), "and the amount it asks for");
		assertSymbolCells(pages[0], view);
	} finally {
		URL.createObjectURL = originalCreate;
		URL.revokeObjectURL = originalRevoke;
		if (originalClick === undefined) delete prototype.click;
		else prototype.click = originalClick;
		restoreNetwork();
		fake.restore();
	}
	assert.deepEqual(calls, [], `the export attempted network I/O: ${calls.join(", ")}`);
});

test("an icon chosen in the create form reaches the shared page's letterhead and the exported PDF", async () => {
	const calls = [];
	const fake = installInteractiveDocument();
	const restoreNetwork = blockNetwork(calls);
	const blobs = [];
	const saved = [];
	const revoked = [];
	const originalCreate = URL.createObjectURL;
	const originalRevoke = URL.revokeObjectURL;
	const prototype = globalThis.HTMLElement.prototype;
	const originalClick = prototype.click;
	URL.createObjectURL = (blob) => {
		blobs.push(blob);
		return `blob:icon-${blobs.length}`;
	};
	URL.revokeObjectURL = (url) => revoked.push(url);
	prototype.click = function click() {
		if (this.hasAttribute("download")) saved.push([this.getAttribute("href"), this.getAttribute("download")]);
	};
	// The browser's canvas is the one dependency this path needs and the suite has none, so the rasterizer is substituted through its seam and the PNG it returns is a real 1 by 1 image the artifact parses.
	const asked = [];
	const rasterizer = {
		async rasterize(dataUrl) {
			asked.push(dataUrl);
			return { bytes: ICON_PNG, width: 1, height: 1 };
		},
	};
	let exported = null;
	try {
		// The payee's half: the icon is chosen in the create form, and the share link is the one the form's dialog hands out.
		const create = renderCreateView({ baseUrl: "https://gateway.example/ipfs/bafy/index.html", today: TODAY, clipboard: null, notice: noticeRecorder() });
		const iconInput = controlNamed(create, "icon");
		iconInput.files = [iconFile(ICON_SVG)];
		iconInput.dispatch("change");
		await nextTask();
		assert.equal(findAll(create, (node) => hasClass(node, "icon-preview"))[0].attributes.src, svgDataUrl(ICON_SVG), "the form previews the chosen icon through the leaf's own data URL");
		setControl(create, "payeeName", "Studio Example Ltd");
		setControl(create, "payeeAddress", PAYEE);
		setControl(create, "item-0-description", "Design work");
		setControl(create, "item-0-quantity", "2");
		setControl(create, "item-0-unitPrice", "150");
		findAll(create, (node) => node.tagName === "form")[0].dispatch("submit");
		const dialog = document.body.children.find((child) => child.attributes?.class?.includes("dialog-backdrop"));
		assert.ok(dialog, "the share dialog opens for the invoice the form built");
		const url = findAll(dialog, (node) => node.attributes?.class === "share-value")[0].attributes.value;
		const fragment = url.slice(url.indexOf("#"));
		assert.equal(decodeShare(fragment).icon, ICON_SVG, "the share link's payload carries the icon the form chose");

		// The payer's half: the shared link renders that icon in the letterhead, and its export hands the same icon text to the rasterizer.
		const shell = mountSharedLink(fragment, {
			exportPdf: async (invoice) => {
				exported = invoice;
				downloadPdf(await renderInvoicePdf(invoice, TODAY, rasterizer), invoiceFileName(invoice));
			},
		});
		const letterhead = findAll(shell.content, (node) => hasClass(node, "letterhead-icon"));
		assert.equal(letterhead.length, 1, "the decoded invoice draws its icon in the letterhead");
		assert.equal(letterhead[0].tagName, "img", "as an image rather than inline markup");
		assert.equal(letterhead[0].attributes.src, svgDataUrl(ICON_SVG), "carrying the leaf's own data URL of the icon the payload carried");
		assert.equal(letterhead[0].attributes.alt, "", "decorative beside the payee's own name");
		// The leaf's own encoder runs the icon gate, so a document the gate refuses cannot be armed into a URL at all, whatever a future sink is handed.
		assert.throws(() => svgDataUrl('<svg width="32" height="32"></svg>'), /must declare xmlns/, "the leaf's encoder refuses a document the gate refuses");

		findButton(shell.content, "Save as PDF").dispatch("click", { type: "click" });
		await waitFor(() => saved.length > 0 || shell.notice.children.length > 0, 400);
		assert.equal(shell.notice.children.length, 0, "a successful export shows no notice");
		assert.deepEqual(asked, [svgDataUrl(ICON_SVG)], "the export hands the rasterizer the view model's prepared data URL");
		assert.equal(exported.icon, ICON_SVG, "and the invoice it exports is the one the shared link carried");
		assert.deepEqual(saved, [["blob:icon-1", "invoice-INV-20261003.pdf"]], "the download is the invoice's own file");
		assert.equal(blobs.length, 1, "the export produced exactly one file");
		assert.equal(blobs[0].type, "application/pdf");
		// The renderer revokes the object URL a second after the click, so that wait is taken here rather than left to fire while another suite's spy is installed.
		await waitFor(() => revoked.length > 0, 400);
		assert.deepEqual(revoked, ["blob:icon-1"], "the object URL is released once the download is under way");

		// The artifact carries the icon: one embedded image, of the pixels the rasterizer returned, and the layout behind those bytes places it first in the letterhead.
		const bytes = new Uint8Array(await blobs[0].arrayBuffer());
		assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-", "the download is a real PDF");
		const opened = await PDFDocument.load(bytes, { updateMetadata: false });
		assert.equal(opened.getPageCount(), 1, "the exported icon invoice is one page");
		assert.equal(opened.getTitle(), "Invoice #INV-20261003");
		const images = imageXObjects(opened);
		assert.equal(images.length, 1, "the icon is embedded exactly once");
		assert.deepEqual([images[0].width, images[0].height], [1, 1], "and it is the rasterizer's own PNG, read back from the artifact");
		const pages = buildInvoicePages(buildInvoiceViewModel(exported, TODAY), PDF_METRICS, { bytes: ICON_PNG, width: 1, height: 1 });
		assert.equal(pages.length, opened.getPageCount(), "the layout paginates exactly as the exported file does");
		assert.equal(pages[0].ops[0].kind, "image", "the icon is the first thing the letterhead draws");
		assert.deepEqual(pages[0].ops[0].png, ICON_PNG, "drawn from the raster the rasterizer returned");
	} finally {
		URL.createObjectURL = originalCreate;
		URL.revokeObjectURL = originalRevoke;
		if (originalClick === undefined) delete prototype.click;
		else prototype.click = originalClick;
		restoreNetwork();
		fake.restore();
	}
	assert.deepEqual(calls, [], `the icon export attempted network I/O: ${calls.join(", ")}`);
});
