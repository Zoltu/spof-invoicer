# Invoicing & Payment SPA

A static, client-side app for creating an invoice, sharing it as a link or a copyable blob, and paying it from an injected Ethereum wallet.
There is no backend, no bundler, no analytics, and no network request from the app's own code to any destination but its own files: the built `app/` directory is the whole product and deploys to IPFS as-is, on a dedicated per-CID origin (see "Deploying to IPFS").

## What it does

**As the payee.** Open the app with no fragment, fill in your name, payout address, invoice number, dates, line items, optional tax and notes, then pick the asset you want to be paid in.
The totals are recomputed locally on every keystroke from the line items in integer base units (never floats), and the bill-to and payee details stay on the page.
A payout address that is all one case carries no EIP-55 checksum, so the form cautions you in place that a mistyped character could not be caught and asks for the checksummed (mixed-case) spelling.
"Share" produces a link whose URL fragment carries the whole invoice (`#/i/<base32>`) and a copyable `pinv1b-…` blob, and the payer's view can be exported to PDF with no network step.

**As the payer.** Open a shared link, a pasted blob, or a fragment.
The invoice is decoded and validated, then rendered as an official-looking document — letterhead, invoice number and dates, bill-to, itemized table, subtotal/tax/total, notes, and payment details (asset, chain, payee address).
"Save as PDF" writes the same layout through `pdf-lib` into a local file.
"Pay" opens a panel that restates the exact transfer — amount, asset, recipient, network — and *nothing happens to your wallet until you click "Connect wallet & pay"*; that click then discovers wallets (EIP-6963, falling back to `window.ethereum`), requests the account, checks/switches the network, reads the balance as advice, and hands the wallet one transfer to sign.
The panel is refused, with a notice and no wallet contact, while the page is displayed inside another page's frame or was opened in a window another page still holds, and for an invoice this page has already claimed a payment for — the invoice is claimed as a flow begins its send, not merely when the panel opens, so a panel dismissed during the pre-send window and a reopened panel cannot both broadcast, and dismissing the panel while the send is still in flight cannot re-arm it — the refusal is keyed on the invoice's canonical content, so it survives navigating away and back to the same fragment or re-pasting the same payload, and only a genuine page reload starts over — so one payment action can lead to at most one broadcast.
Only the hash the wallet returns is displayed.

**What it never does:** no account, no cookie, no storage, no telemetry, no remote font or image, no page-origin network request except the lazy same-origin `import()` of the app's own PDF module (a local module load that `connect-src 'none'` does not govern), no wallet access before that click, and no trust in the transported invoice: the amount is recomputed from the line items, the recipient is the validated payee address, and the asset and chain are re-derived from the registry.

## The served tree

```text
app/                       deployable root (the only thing served or pinned)
  index.html               shell; CSP + referrer policy, loads js/main.js as a native ES module
  ts/                      TypeScript sources (the source of truth)
  js/                      tsc output + copied vendor .js + source maps (committed)
  stylesheets/             app.css, invoice.css (the document), print.css (@media print)
  images/                  logo.svg + favicon.svg (copied from assets-src/images)
build.mjs                  copy vendor .js -> copy images -> tsc
serve.mjs                  dependency-free static server for app/, bound to loopback (127.0.0.1:80) by default
tsconfig.json              ES2022 / NodeNext resolution, strict, source maps, inline sources
tests/                     bun test (node:test API) suites, including the acceptance gate
tests/acceptance.test.mjs  the repo's own end-to-end acceptance gate (see "Verifying the guarantees")
tests/style.test.mjs       the repo's own style gate, derived from `.editorconfig` (see "Verifying the guarantees")
vendor-src/                vendored third-party JS, licenses, and hand-written .d.ts shims
vendor-src/SHA256SUMS      pinned versions + SHA256 of every vendor-src/ file (refreshed by `bun run vendor`)
scripts/fetch-vendor.mjs   re-acquire vendor-src/ from node_modules (refuses drift; the result is committed)
scripts/vendor-manifest.mjs render/verify SHA256SUMS; imported by build.mjs and the tests
scripts/vendor-pins.mjs    pin each package's version + lockfile integrity, checked by `bun run vendor`
assets-src/                image sources (copied to app/images by the build)
```

`assets-src/` and `vendor-src/` are both committed, alongside the `app/js/vendor/` and `app/images/` copies the build produces from them.
The image input stays optional: `build.mjs` detects the absence of `assets-src/` and skips the copy with a log line, so `bun run build` still works if the sources are removed.

## Commands

| Command             | Does                                                                       |
| ------------------- | -------------------------------------------------------------------------- |
| `bun install`       | install dev dependencies (TypeScript + the libraries vendored below)       |
| `bun run vendor`    | re-copy the pinned libraries, refresh `SHA256SUMS`; refuses a drifted tree |
| `bun run build`     | copy vendor + images, then compile `app/ts/**/*.ts` → `app/js/**/*.js`     |
| `bun run typecheck` | `tsc -p tsconfig.json --noEmit`                                            |
| `bun test tests/`   | run the test suites (the acceptance gate included)                         |
| `bun run serve`     | serve `app/` on <http://127.0.0.1:80> (loopback only; `--host` widens it)   |

`bun run vendor` is guarded rather than a blind re-copy, and it runs three gates that each abort on a divergence: an upstream cross-check byte-compares each file the vendor script's `SOURCES` table copies out of `node_modules` — the bundles, their source maps, and their license files — against the installed copy, a per-file overwrite guard overwrites a vendored file only while the installed bytes still match the blessed `SHA256SUMS`, and a manifest re-bless guard rewrites `SHA256SUMS` only while the hashed tree still matches the committed manifest.
A drifted vendor tree stops the run with a message naming what diverged instead of being blessed silently.
Two explicit overrides reach those gates.
`bun run vendor -- --force` is the override for a vendored change you intend, such as a hand-edited shim or a swapped bundle: it bypasses the per-file overwrite guard and the manifest re-bless guard.
`--force` deliberately does not reach the upstream cross-check, which runs before either hash check, so a divergence you intend to keep also needs `--allow-upstream-drift` — the flag that warns with the affected files instead of aborting and lets the run re-bless them.
A hand-edit to a copied vendored file (a bundle, a source map, or a license) whose `SHA256SUMS` entry was not re-blessed leaves the per-file overwrite guard satisfied, because that guard hashes the installed `node_modules` bytes against the blessed manifest rather than the vendored bytes — so `--allow-upstream-drift` alone warns, then overwrites the edit with the pinned `node_modules` copy, and exits 0.
The cross-check override alone stops at that guard only once the edit has been re-blessed (its manifest hash updated to match), so a re-blessed tree needs both flags: `bun run vendor -- --allow-upstream-drift --force`.

An upgraded `node_modules` is handled deliberately and separately.
`scripts/vendor-pins.mjs` pins each package's version and tarball integrity, and `bun run vendor` refuses to copy anything from an installed tree whose version disagrees with its pin, or whose `bun.lock` integrity does not match the pin, before it ever consults a file hash — so `--force` cannot paper over the mismatch.
A deliberate dependency upgrade means editing the pin table together with `bun.lock`, then re-running `bun run vendor`; the flag does not relax that guard.

`bun run serve` runs `serve.mjs`, a zero-dependency static server built on Node/Bun built-ins and bound to loopback (`127.0.0.1:80`) by default, so it never exposes the served tree — the TypeScript sources under `app/ts/` and the inline-sourced maps beside `app/js/**` — to the local network; `--host` (and `--port`) widen the bind as a deliberate opt-in, as in `bun run serve --host 0.0.0.0`, and a bind beyond loopback prints a caution naming the `app/ts/` sources and inline-sourced `app/js/**` maps the widened bind discloses. It sends `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, and an anti-framing `Content-Security-Policy: frame-ancestors 'none'` (with `X-Frame-Options: DENY` for clients that predate it).
Because it serves every file under `app/` with no filtering of the tree — the same whole tree `ipfs add -r app` pins — `serve.mjs` prints a caution at startup: keep secrets out of `app/`, since the acceptance gate's stray-file check, not the server, is what flags an unexpected file there.
Nothing a user runs downloads anything: no script in this project shells out to `npx`/`bunx`, and no script fetches code from a registry.
The only network step in the project's life is the developer's one-time `bun install` (which also retrieves the vendored libraries) followed by `bun run vendor`; both results are committed, so building, testing, and serving stay network-free.

The runtime is [Bun](https://bun.sh): in this environment `node` is a shim for `bun`, so scripts and tests are invoked through `bun`.

## Build rules

- **No bundling, no minification.** `app/js/**/*.js` is exactly what `tsc` emits, one module per file.
- Runtime imports use **relative paths ending in `.js`** (e.g. `import { h } from "../util/dom.js"`), so the emitted files load in any browser without a build step in between.
  `tsconfig.json` uses `module`/`moduleResolution` `NodeNext`, which rejects extensionless or extension-mismatched relative specifiers at compile time — the `.js` convention is enforced, not just documented.
- Build order is deliberate: vendor files and their hand-written `.d.ts` shims are copied into `app/js/vendor/` **before** `tsc` runs, so relative `.js` imports typecheck against the shims beside them.
  `allowJs` stays `false`, so `tsc` never emits or rewrites anything under `app/js/vendor/`.
- Source maps are always on and inline the TypeScript source, so `app/js/main.js.map` carries `sources: ["../ts/main.ts"]` plus `sourcesContent`; the acceptance gate checks every emitted map for that, and for the embedded source still matching `app/ts/`.
- `app/js/` is committed, and `tests/acceptance.test.mjs` builds into a scratch directory and compares the whole served tree byte for byte, so the committed `app/js/**` cannot silently drift from `app/ts/**`.
- The pdf-lib bundle (~1.4 MB) is imported lazily on the first PDF export, so it stays out of first load.

## Style and conventions

Beyond the five `.editorconfig` keys, the code follows a set of token-level conventions that the config cannot express and the gate does not check; most are held by convention and review alone, but two are machine-enforced: `verbatimModuleSyntax` in `tsconfig.json` makes a type-only import that omits `import type` a compile error, and `NodeNext` resolution enforces the `.js`-suffixed relative import (see "Build rules").
The token conventions in this section, and the `.editorconfig` `indent_style` key they extend, govern the authored tree only: the committed `app/js/**` that `tsc` emits with 4-space indentation (as in `app/js/util/decimal.js`) is a byte-held build artifact, and `.editorconfig` unsets every rule for it, just as it does for the other byte-held trees (`vendor-src/**`, `app/images/**`, `node_modules/**`) — see those `unset` sections.
The whitespace and line-ending keys (`charset`, `end_of_line`, `insert_final_newline`, `trim_trailing_whitespace`) are not confined that way: they reach every committed file outside those `unset` trees, `bun.lock` among them — the one tool-generated file the gate sweeps, held to those rules alone because its extension is outside the tab-rule section (see "Verifying the guarantees").
The SHA256 sums and the fresh-build byte comparison, not the style gate, are what hold those bytes, so reading the generated `app/js/**` as a style violation is a mistake.
String literals are double-quoted, statements end in a semicolon, multi-line literals and argument lists carry a trailing comma, every exported declaration carries a JSDoc block, and names use `camelCase` for functions and variables, `PascalCase` for types and interfaces, `UPPER_SNAKE_CASE` for fixed-literal constants, and `kebab-case` for file names.
`UPPER_SNAKE_CASE` marks genuine fixed-literal constants — numeric limits, regex literals, fixed message strings, and configuration tables — while an ordinary module-scope binding stays `camelCase` whether it holds a value read from the environment (a DOM node, a locator path) or mutable runtime state (such as a `Map` the page updates), so the rule does not reach every module-scope `const`.
JSDoc names a related declaration either with a `{@link …}` tag or as a backticked code span, whichever reads better in the sentence — `app/ts/invoice/codec.ts` writes `ShareFormatError` and `InvalidInvoiceError` as code spans, and `app/ts/assets/registry.ts` names `requireInvoiceAddress` that way.
A module-level JSDoc block, when present, goes at the very top of the file, ahead of the imports; every module block in `app/ts/**` sits there, and a file with no module block is not required to add one.
A type-only import is written `import type` (or an inline `type` modifier when a type shares one statement with value imports), and a Node built-in is imported under its `node:` prefix, as in `import { join } from "node:path"`.

Line length is deliberately uncapped: `.editorconfig` omits `max_line_length` on purpose, so long prose, JSDoc, and code lines are kept as authored rather than reflowed.
A maintainer who "fixes" a long line can diverge the emitted bytes of the committed, byte-compared `app/js/**`, so the carve-out is a convention to preserve, not an oversight to correct.

## Vendored libraries

No library is a runtime dependency of the page.
Each is vendored as plain ESM under `vendor-src/` (committed) and accompanied by a hand-written `.d.ts` shim declaring only the surface this app uses.
`bun run build` copies the vendored `.js` files, their shims, their license files, their source maps, and the shared `THIRD-PARTY-NOTICES` verbatim into `app/js/vendor/`; the `SHA256SUMS` manifest stays in `vendor-src/` and is not served.

| Package       | Version | `vendor-src/` dir | Vendored files                                                           |
| ------------- | ------- | ----------------- | ------------------------------------------------------------------------ |
| pdf-lib       | 1.17.1  | `pdf-lib/`        | `pdf-lib.esm.js`, `pdf-lib.esm.js.map`, `pdf-lib.esm.d.ts`, `LICENSE.md` |
| @noble/hashes | 2.4.0   | `noble-hashes/`   | `sha3.js`, `utils.js`, `_u64.js`, `sha3.d.ts`, `utils.d.ts`, `LICENSE`   |
| @scure/base   | 2.4.0   | `scure-base/`     | `index.js`, `index.d.ts`, `LICENSE`                                      |
| _(shared)_    | —       | `vendor-src/`     | `THIRD-PARTY-NOTICES`                                                    |

`app/ts/util/encoding.ts` wraps them, e.g. `import { keccak_256 } from "../../js/vendor/noble-hashes/sha3.js"` for a module one directory deep (from `app/ts/` itself the prefix is `../js/vendor/`); that module re-exports the digest as `keccak256` for the rest of the app.
The `ts/` and `js/` trees are siblings and the emitted module keeps the specifier unchanged, so the same relative path resolves in the browser.

Every served vendored bundle is self-contained: the only relative imports between them are noble's `sha3.js` → `./_u64.js` and `sha3.js` → `./utils.js`, which is why those files travel together, and no bare specifier ever reaches the browser.
A vendored `.js.map` is served beside its bundle — pdf-lib's `pdf-lib.esm.js` ends with `//# sourceMappingURL=pdf-lib.esm.js.map` — so devtools resolves that reference instead of 404-ing; pdf-lib's is the only source map under `vendor-src/`, and the build copies it into `app/js/vendor/` like every other vendored file except `SHA256SUMS`.

`vendor-src/SHA256SUMS` records the pinned package versions and the SHA256 of every file under `vendor-src/` (including the hand-written shims).
`bun run vendor` regenerates it, and `tests/vendor.test.mjs` fails if any file no longer matches, so tampering or bit-rot is detectable.
`tests/vendor-integrity.test.mjs` additionally byte-compares every vendored file that `bun run vendor` copies out of `node_modules` — the `.js` bundles, their `.js.map` files, and their license files — against the pinned `node_modules` copy, so re-blessing the manifest over a hand-edited bundle is caught as well.
The hand-written `.d.ts` shims and the shared `THIRD-PARTY-NOTICES` have no upstream copy to compare against, so `SHA256SUMS` and `tests/vendor.test.mjs` are what cover those.
The build itself verifies the manifest before copying a byte.

## Share formats

An invoice is canonical JSON carried in a self-describing container.
Both forms below are produced by the share dialog; both decode back to the same invoice.

```text
link        <page>#/i/<base32>        the fragment a shared URL carries (never sent to a server)
blob        pinv1b-<base32>           standalone, for pasting anywhere
```

- The JSON has a fixed key order, no whitespace, no absent optional field, text composed to NFC, and every number in its shortest exact spelling.
  The decoder refuses anything that is not byte for byte what the encoder writes, so a repeated key (the last one silently winning in `JSON.parse`), an NFD spelling, or a longer spelling of the same number cannot hide in a payload.
- `v: 1` and `t: "invoice"` version the schema; `pinv1b-` versions the container and names its encoding.
  Unknown versions are refused with a typed error, and the router turns that into a notice plus the create view rather than a crash.
  A legacy `pinv1-` (base64url) blob is still recognised as a blob and refused with a message naming the retired base64url encoding.
- Fields: `v`, `t`, `id`, `issued`, optional `due`, `payee { name, address, email?, notes? }`, optional `payer { name, email? }`, `chainId`, `asset`, `items [{ description, quantity, unitPrice }]`, optional `tax { label, rate }`, optional `notes`.
  Money is a decimal string in the asset's own units (`"150.00"`), never a JSON number and never base units; **totals are never transported** — they are recomputed from the line items at both ends.
- Limits: 64 KiB of JSON, 200 line items, names ≤ 200 chars, descriptions ≤ 500 chars, invoice notes ≤ 2000 chars, amounts within `uint256` with at most the asset's decimals and more than zero.
  The invoice payload is deliberately **not compressed** — the codec never runs a compressor, even though the vendored pdf-lib bundle embeds pako's deflate/inflate for its own PDF streams.
- Base32 is the sole encoding: its encode is a linear, uncapped pass over the bytes, so it scales with the invoice size and the 64 KiB limit above is the format's real cap.
  base58 was considered and rejected because its big-number conversion is quadratic and does not scale.

A share link carries the payload in the URL **fragment**, which browsers never send to a server — so a payee can hand the invoice to a payer through any transport without it reaching a log, a proxy, or the IPFS gateway.
The trade-off is URL length: chat clients and older browsers truncate long URLs, so a large invoice should be shared as a `pinv1b-` blob instead.

## Supported assets and chains

| id     | Asset             | Kind    | Chain              | Decimals |
| ------ | ----------------- | ------- | ------------------ | -------- |
| `eth`  | Ether             | native  | `0x1` (Ethereum)   | 18       |
| `usdc` | USD Coin (USDC)   | ERC-20  | `0x1` (Ethereum)   | 6        |
| `usdt` | Tether USD (USDT) | ERC-20  | `0x1` (Ethereum)   | 6        |

The registry lives in `app/ts/assets/registry.ts` and is the single source of truth: the asset picker, the invoice validator, the payment planner, and the chain list all derive from it.
**To add an asset, add one entry and nothing else**:

```ts
dai: {
	id: "dai",
	symbol: "DAI",
	name: "Dai Stablecoin",
	chainId: "0x1",
	decimals: 18,
	kind: "erc20",
	address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
},
```

`validateRegistry` (run at module load) enforces what would otherwise surface as a mysterious payment failure: the key must equal the `id`, the `chainId` must be canonical lower-case `0x` quantity, an ERC-20 `address` must be EIP-55 **checksummed** (the error names the correct spelling), a native asset must carry no address, `decimals` must be 0–255, and no two entries may share a `(chainId, address)` pair.
A new chain needs at least one asset and a `CHAIN_NAMES` entry in `app/ts/ui/presentation.ts` to render under its name rather than its raw id; `DEFAULT_CHAIN_ID` and `SUPPORTED_CHAIN_IDS` then include it automatically, and the payment flow will ask the wallet to `wallet_switchEthereumChain` to it.
After editing the registry run `bun run build && bun test tests/` — `tests/assets.test.mjs` checks the invariants, and the acceptance gate checks the built tree is fresh.

An invoice names its asset by id and its chain, but neither is trusted at payment time: `buildPaymentPlan` re-derives the asset from the registry, requires the chain to match it, re-checks that the payee address is payable (not the zero address, not the token contract itself), and recomputes the amount from the line items.
A payload cannot introduce an asset, a token address, or a total the registry does not know.

## Security and privacy model

- **No backend, no telemetry, no storage.** The app is static files.
  It writes no cookie, no `localStorage`/`sessionStorage`, no IndexedDB, and contacts no analytics or CDN.
  The only state is in memory and in the URL fragment.
- **No page-origin network access.** `app/index.html` pins a CSP meta tag: `default-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; manifest-src 'none'; media-src 'none'; form-action 'none'; script-src 'self'; script-src-elem 'self' 'unsafe-inline'; script-src-attr 'none'; style-src 'self'; style-src-attr 'none'; img-src 'self'; font-src 'none'; connect-src 'none'; require-trusted-types-for 'script'`.
- **`connect-src 'none'` and the wallet.** The one outbound path the app needs is the injected wallet's own transport (`window.ethereum`, or an EIP-6963 provider).
  That lives in the wallet extension's context, not the page's, so it is not a page-origin request and `connect-src` never sees it.
  The injected provider `<script>` element is the one page-context piece CSP does evaluate — `script-src-elem` above is what lets it through, though a `src` on a different origin still fails the `'self'` source check and is blocked — while every network call that provider makes still happens in the extension's context, not the page's.
  That `'self'` check is coarser than "same site": on an IPFS gateway `'self'` is the whole gateway host, not this CID's directory, so a `src` such as `/ipfs/<other-cid>/x.js` on the same gateway is same-origin and would pass — the qualification the source-level sweep and `h()`'s allow-list have to cover.
  That coarseness is also why a path-style gateway is not a safe deployment (see "Deploying to IPFS"): every sibling CID shares this origin, so it can frame and read this app, not merely load a script from it.
  `connect-src 'none'` forbids `fetch`, XHR, WebSocket, EventSource, and beacons from the page while leaving payments intact.
  The one same-origin request the app does make from its own origin is the lazy `import("../pdf/renderer.js")` on the first PDF export (`app/ts/app/shell.ts`): it is a same-origin module load, not a `fetch`/XHR, so `connect-src 'none'` does not govern it and the runtime network recorder (`tests/helpers/network-block.mjs`) cannot observe it — the deliberate carve-out in the page-origin guarantee.
  A wallet that reaches the chain over a relay or RPC endpoint instead (a QR/WalletConnect wallet, an embedded provider doing its own HTTP) would need the minimum `connect-src` entries for those endpoints; that is the one place to widen the policy, and widening it should stay a conscious decision.
- **One scoped inline-script exception, no markup sinks.** `script-src-elem 'self' 'unsafe-inline'` permits an inline `<script>` element — the single, deliberate exception that lets a Firefox wallet extension inject its provider (Mozilla bug 1267027: Firefox checks the injected element against the page's script policy instead of exempting the extension's injection).
  Whether Firefox resolves that injected element to `script-src-elem` rather than `script-src` could not be confirmed in a real Firefox in this environment, so this is an outstanding release-gating check rather than a verified result: a release must run the manual Firefox check under "Testing with a real wallet" — a pass keeps the scoped exception as documented, while a fail means the exception achieves nothing and the policy is tightened back to `script-src 'self'`.
  The exception is scoped to `script-src-elem` alone and works only because `script-src-elem` itself carries no nonce or hash source (a nonce or hash in `script-src-elem` would make its `'unsafe-inline'` ignored; a nonce or hash in `script-src` alone would not, since `script-src-elem` overrides `script-src` for script elements): `script-src` stays `'self'` and no `'unsafe-eval'` appears anywhere, so `eval` and `new Function` stay blocked and external scripts stay confined to `'self'` (the whole gateway origin on IPFS — see the caveat above).
  `script-src-attr`/`style-src-attr` stay `'none'`, so inline event handlers remain blocked everywhere.
  What is genuinely lost, in every engine that honors `script-src-elem`, is the old blanket guarantee that no inline `<script>` element anywhere can execute: a markup-injection point would become script execution.
  In CSP3 that loss reaches a `javascript:` URL too, which is checked against the same `script-src-elem` effective directive, so `'unsafe-inline'` there could re-allow a `javascript:` navigation — not exploitable here because the app never produces one (the acceptance sweep forbids it in `index.html` and `safeUrl` refuses it in every `href`).
  That is acceptable only because the app has no markup-injection point — `require-trusted-types-for 'script'` (enforced by Chromium) turns `innerHTML`, `insertAdjacentHTML`, and `eval` into loud failures, and the app builds its dynamic DOM through its own `h()` helper, which only accepts an allow-list of attributes and refuses absolute or `javascript:` URLs in `href` (the one element built outside it, the PDF download anchor in `app/ts/pdf/renderer.ts`, takes an app-generated `blob:` URL that `h()` itself would refuse).
  That mitigation is Chromium-only, though: in Firefox — the engine this workaround targets — `require-trusted-types-for` is not enforced, so there the residual risk rests only on the source-level acceptance sweep and on `h()`'s allow-list, both outside CSP.
- **The fragment is the privacy boundary.** Invoice data lives after `#`, so it is never sent to the gateway, the server, or anything else — and the browser itself keeps the fragment out of the `Referer` header and never includes it in a form submission, so no server ever sees it.
  Browser semantics hide the fragment from servers, but they do not hide it from a same-origin script: on a path-style IPFS gateway every other CID is served from this app's own origin, so a sibling page can frame this app and read the fragment straight out of the frame.
  Serving the app from a dedicated origin — a per-CID subdomain gateway, or a domain that serves only this directory — is what makes the fragment private from other pages (see "Deploying to IPFS").
  `<meta name="referrer" content="no-referrer">` and `form-action 'none'` are cheap belt-and-braces on top of that browser behavior, not the load-bearing control.
- **No auto-connect.** Importing the wallet modules touches no provider.
  Providers are discovered, `eth_requestAccounts` is sent, and the chain is read only from the payer's own click on "Connect wallet & pay"; the balance read is advisory and the transaction is built immediately before it is sent.
  The app re-reads the wallet's chain (`eth_chainId`) immediately before it builds the transaction (`app/ts/wallet/payment.ts`), so a wallet that switches networks after the earlier check refuses the transfer instead of broadcasting it on the wrong chain; the transaction object also names the invoice's own `chainId`, but that field is not part of EIP-1474's `eth_sendTransaction` params and some wallets ignore it, so the app's own pre-send re-read — not the field — is the guarantee.
  `tests/acceptance.test.mjs` asserts zero provider calls during load, render, and panel open.
- **Nothing transported is trusted.** The invoice is validated field by field with size caps and character checks (its text fields are refused control characters and the invisible-formatting class, Unicode's `Default_Ignorable_Code_Point`, which deliberately leaves the interlinear-annotation and Egyptian hieroglyph format controls, U+FFF9–FFFB and U+13430–1343F, unrefused), the payload must be canonical JSON at the current version, and the amount, recipient, asset, and chain are re-derived at payment time. A wallet's own announced label is display text rather than a stored field, so control, invisible, and bidi characters are stripped from it by the display-stripping pass before it can become a payer's picker entry, keeping one wallet from presenting itself as another.
  A hostile payload becomes a bounded notice whose control, invisible, and bidi characters are stripped before display — the same treatment a wallet's own label gets — never markup, never a transaction.
- **Everything served is local.** No remote fonts (the stacks are system fonts), no remote images (both SVGs are local), every `src`/`href`/`url()` is relative to `app/`, and the vendored bundles are pinned by SHA256 and byte-compared against their `node_modules` copies.
- **The PDF is local.** `pdf-lib` writes bytes in the page and hands them to a blob URL and a download anchor; no printer service, no upload, no remote template.

Two limits worth stating plainly: `frame-ancestors` cannot be expressed in a meta tag (and a static gateway cannot set headers), so any site can still frame the page — a cross-origin framer carries no data, makes no network request on the app's behalf, and cannot present the payment panel, which the page refuses while it is framed, while a same-origin framer on a path-style gateway can read the framed app's fragment directly, which is why the app must be served from a dedicated origin (see "Deploying to IPFS").
That panel refusal is itself a client-side check on `window.top`/`window.opener`, ordinary window properties a page can replace, so it is best-effort coverage of a cross-origin framer or opener rather than a control an adversarial embedder is bound by; the load-bearing control remains the dedicated-origin deployment rule.
And `require-trusted-types-for` is only enforced by Chromium; the innerHTML-free DOM is additionally enforced at the source level by the acceptance gate.

## Verifying the guarantees

```sh
bun install
bun run typecheck      # tsc --noEmit, strict
bun run build          # vendor + images + tsc into app/
bun test tests/        # every suite, acceptance gate included
```

`tests/acceptance.test.mjs` is the repo's own acceptance gate.
It composes one invoice at the module level — `createInvoice` → `encodeShare` → the base32 blob → decode — and then drives the payer's half through the real seams: the fragment is rendered in the real shell and router, "Save as PDF" is clicked and the downloaded bytes are reopened with pdf-lib (one US Letter page, the project's own metadata, and a layout carrying every figure the document shows), and "Pay" runs against a mock EIP-1193 wallet (asserting the exact `eth_sendTransaction` params and the returned hash).
The PDF export, Pay, and boot cases each install a network blocker for the duration of the case, and the Pay and boot cases assert that no provider call happens before the Pay click.
The create form and the share dialog themselves are covered by the UI suites (`tests/ui.test.mjs`, `tests/view.test.mjs`), not by the gate.
The gate then asserts the invariants directly: no page-origin network request anywhere except the app's own lazy same-origin PDF module import, hostile payloads and hostile invoice text refused, the CSP pinned directive by directive, no network API or markup sink anywhere in the served runtime code, every reference same-origin and present on disk, and the committed `app/` tree byte-identical to a fresh build (with the emitted modules' source maps pointing back at `app/ts/`).

`tests/style.test.mjs` is the repo's own style gate, and `.editorconfig` is its single source of truth for scope and rules: at run time it parses the config, resolves the effective properties for each governed path, and walks the tree, so which files it sweeps, which keys they carry, and whether the indentation rule applies are read from the config rather than restated in the guard.
What the guard fixes in code is how each of the five keys is checked and the shared extension-to-comment-syntax table (`languageFor` in `tests/helpers/code-only.mjs`) it needs to exempt wrapped comment lines; a value it cannot check (for example `end_of_line = crlf`), a key it does not enforce, and a glob construct it does not model are each reported rather than silently ignored, so the gate cannot quietly enforce nothing.
The indent rule is deliberately stricter than raw `indent_style = tab`: a line's leading indentation must be tabs only, so a space-indented line fails — alignment spaces included, which means a non-comment aligned continuation line is rejected too — unless the line continues a block or HTML comment.
It prunes a tree only when a section rooted at it and ending in `/**` unsets every enforced rule and no later section could match a path under it while setting one, so the byte-checked build and vendor artifacts stay out of the sweep while a shallower unset or a later re-enable can never hide a deeper governed file; the reach test is conservative — a basename-anchored pattern, or a path pattern whose leading literal segments overlap the directory, keeps it in the sweep — and it skips `.git/**` and any path matched by `.gitignore`, so most local artifacts stay out of the sweep; `unset` only stops the config from instructing an editor, while the SHA256 sums and the fresh-build comparison are what actually hold those bytes.
The `.gitignore` matcher models git's own pattern forms — `*` and `?` within a path segment, a whole-segment `**` crossing `/` (a `**` that is not a whole segment matches like `*`), `[...]` a character class, `{}` literal, and a leading `!` a negation — and is bounded to them, so a path carrying a form it does not model is still swept rather than wrongly skipped; `bun.lock`, tool-generated but outside every `unset` tree and carrying no tab-rule extension, is the one tool-generated file in scope, held to the line rules alone.
Its scope is the whole tree minus what `.gitignore` excludes, which is why `.orchestration/` is ignored: harness files never enter the sweep.
It reads only the root `.editorconfig` (and reports a missing `root = true` there), so a nested `.editorconfig` anywhere in the swept tree is reported as a problem rather than silently ignored: the gate never reports green against rules an editor would not use.
It reports each violation as `path:line — reason`.

The other suites cover their modules: `codec`, `util`, `assets`, `address`, `erc20`, `wallet`, `wallet-bounds`, `pay-flow`, `pdf`, `view`, `ui`, `clipboard`, `display-hygiene`, `security`, `serve`, `build`, `style`, `code-only`, and the two vendor suites.

## Testing with a real wallet

The mock-provider suites assert the exact RPC traffic without touching a chain.
To exercise the live path, use a throwaway account and a tiny amount — the registry is pinned to Ethereum mainnet (`0x1`), so a real payment moves real funds:

1. `bun run build && bun run serve`, then open <http://127.0.0.1:80>.
2. Create a small invoice (say `0.001` ETH, or `1` USDC) to your own address and copy the share link.
3. Open the link in a new tab; confirm the document and the PDF export.
4. Install/activate a browser wallet (MetaMask, Rabby, Frame, …) and click **Pay**, then **Connect wallet & pay**.
   Nothing should have prompted you before that click.
5. Check the prompt: the amount, the recipient, and the network must match the invoice.
   If the wallet is on another chain the app asks it to switch; if the wallet does not know `0x1` it stops with guidance instead of sending.
6. The panel shows the transaction hash.
   Keep it as the receipt — the app does not poll for a receipt.

To test against a testnet or a second chain, add registry entries for that chain (see above) and a matching `CHAIN_NAMES` entry in `app/ts/ui/presentation.ts`; the registry governs which chains are supported, but a chain with no `CHAIN_NAMES` entry renders as its raw id.

### Manual Firefox acceptance check (the scoped `'unsafe-inline'`) — an open release gate

This check is an unmet release gate, not a passing caveat: `app/index.html` ships `script-src-elem 'self' 'unsafe-inline'` on the unverified premise that Firefox resolves the wallet's injected inline `<script>` to `script-src-elem` (Mozilla bug 1267027), so no release should go out until it has been run in a real Firefox and its result recorded here.
No Node test can exercise it — it is Firefox's own CSP decision about an element the browser wallet injects — so confirm it by hand:

1. `bun run build && bun run serve`, then open <http://127.0.0.1:80> in Firefox 108+ with a browser wallet extension (e.g. MetaMask, Rabby) active.
2. Open the developer console and confirm the injected provider is present: an `eip6963:announceProvider` announcement fires and/or `window.ethereum` is defined.
3. Click **Pay**, then **Connect wallet & pay**, and confirm the flow reaches the wallet — the wallet prompts to connect, then to sign.
4. Check the console for a CSP violation naming the injected `<script>` or `script-src-elem`, and record the Firefox version tested.

**Pass** — the provider appears at step 2, the flow reaches the wallet at step 3, and step 4 logs no CSP violation for the injected script: Firefox resolves the injected element to `script-src-elem`, the scoped exception achieves its one purpose, and it stays exactly as documented (with the residual-risk note in "Security and privacy model").
**Fail** — the provider stays hidden, or the flow never reaches the wallet, or the console logs a CSP violation for the injected script: the exception is not doing anything, so tighten the policy back to `script-src 'self'` (drop `'unsafe-inline'`, keeping `script-src-elem 'self'`), update the rationale comment in `app/index.html` and the residual-risk bullet above to match, and record the failed check and its Firefox version here.

## Deploying to IPFS

The deployable artifact is the `app/` directory and nothing else:

```sh
bun run build            # app/js/** is regenerated; commit it
ipfs add -r app          # or an equivalent pinning service / `ipfs-cli`
```

`ipfs add -r app` pins the entire `app/` tree with no filtering, so anything dropped under `app/` — a key, a note, `app/wallet.json` — is published along with the app.
The build and the server do not gate that: the repo's acceptance gate (`tests/acceptance.test.mjs`) is what catches a stray file, by requiring every committed file under `app/` to be a build output or an authored source, so keep secrets out of `app/` and let the gate's stray-file check keep it that way.

Then pin the returned directory CID, and serve it from an origin that holds nothing but this app: a per-CID subdomain gateway (`https://<cid>.ipfs.<gateway>/`), or a domain that serves only this directory.
A path-style gateway (`https://<gateway>/ipfs/<cid>/index.html`) serves every other CID from this app's own origin, so a sibling page's script can frame this app and read its fragment; the fragment-privacy guarantee above holds only on a per-CID or otherwise dedicated origin, where no other page shares the app's origin.
Because every reference is relative, the app works under either form, and a share link is simply `https://<cid>.ipfs.<gateway>/#/i/<payload>` (or the equivalent on a dedicated domain) — the fragment is not part of the CID lookup and never reaches the gateway.
Re-pinning after a change yields a new CID; keep the old one pinned for as long as old links matter.

A static gateway cannot send HTTP headers, which is exactly why the security policy travels in the meta tag inside `index.html` rather than in a server config.
If you serve the same directory over HTTP yourself, the meta tag still applies; `serve.mjs` additionally sends `frame-ancestors 'none'` as a header, but a static gateway cannot set headers, so the meta tag is the portable part.

## Known limitations

- **Broadcast, not settlement.** The app shows the hash the wallet returns; it does not read the chain for a receipt, so "Transaction submitted" means the wallet accepted and broadcast it.
- **One chain family, one asset per invoice.** Every registry entry is Ethereum (`0x1`) and an invoice bills in exactly one asset.
  Another chain means registry entries plus a wallet that supports `wallet_switchEthereumChain` for it; there is no multi-asset or multi-chain invoice.
- **Injected wallets only.** A QR/relay wallet (WalletConnect-style) is unsupported by design, because supporting it means widening `connect-src`.
  Wallets must implement `eth_requestAccounts`, `eth_chainId`, `eth_sendTransaction`, and (for a switch) `wallet_switchEthereumChain`.
  Discovery waits a fixed `DISCOVERY_TIMEOUT_MS = 150` ms, so a wallet that announces later is missed and the app falls back to `window.ethereum` or reports "No Ethereum wallet was found".
  A wallet that injects its provider as an inline page `<script>` element is not blocked outright in engines that honor `script-src-elem` (Firefox 108+, the versions this workaround targets): `script-src-elem 'self' 'unsafe-inline'` is intended to permit it, though that Firefox behavior is pending the manual check in "Testing with a real wallet" rather than verified here, at the cost of the no-inline-`<script>` guarantee noted under "Security and privacy model".
  A provider injected as a page `<script>` element with a `src` on a different origin still fails the `'self'` source check and is blocked — though on an IPFS gateway `'self'` is the whole gateway host, so a `src` such as `/ipfs/<other-cid>/x.js` on the same gateway is same-origin and would pass.
- **Long links.** The whole invoice rides in the fragment; practical URL limits mean large invoices should be shared as a blob.
  There is no compression, and the size caps above are hard limits.
- **PDF glyph coverage.** Base-14 Times/Helvetica with WinAnsi encoding means text outside Latin-1 (CJK, emoji, …) folds to `?` in the PDF.
  The HTML view and the blob keep the original text.
- **Single locale.** The labels are fixed English, and dates render through a small table (day-first, e.g. `3 Oct 2026`), not `Intl`/`toLocaleDateString`; there is no i18n layer.
- **No transaction history or bookkeeping.** The app keeps nothing: no saved invoices, no list, no status, no receipt storage.
  Reloading loses whatever was typed.
- **Chromium-only enforcement** of `require-trusted-types-for 'script'`; other engines ignore that directive (the source-level acceptance sweep still applies).
