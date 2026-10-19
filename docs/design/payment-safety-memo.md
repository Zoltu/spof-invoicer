# Payment Safety Design Memo

This memo answers four questions about paying an invoice here: easier address verification, a guard against an accidental double payment, whether blockies avatars are feasible, and whether a local address book is feasible.
Each question ends with one recommendation and its cost.
No option this memo recommends has been implemented; the only display change it describes is the fitting that has landed. `[verified in this repository]` — the fitting is in `app/ts/ui/fit-value.ts`, and no runtime file names a storage API, which the sweep at `tests/slow/acceptance.test.mjs:810` enforces.
Every claim carries one of four labels.

- `[verified in this repository]` — read in this repository's code, configuration, or tests; the file is named.
- `[reported from an external source]` — a study, package listing, or vendor statement, cited and not rechecked here.
- `[unverified]` — asserted or plausible, but neither checked here nor cited.
- `[accepted risk]` — a hazard the owner has chosen to live with, recorded so it is not read as an oversight.

A sentence that states a proposal, a recommendation, a judgement, or an effort figure is not a claim and carries no label; every sentence that asserts a fact about this repository, a study, a package, or the world does.
In a list, the label on the sentence that introduces the list covers its items, and each item still names its own source.
Effort figures are marked `(estimate)`: the author's judgement, not measurements.
No wallet was exercised and no payer was tested for this memo.

## 1. Easier Address Verification

### What the App Shows Today

The invoice shows the payee address in full as one selectable text run with a Copy button, and draws the payment link as a QR symbol. `[verified in this repository]` — `paymentValue` in `app/ts/ui/payment-section.ts` builds one text node, a copy control, a print-only twin, and a status for each term a wallet takes verbatim, and `renderPaymentSection` adds `qrBlock` of the view model's `paymentQr`.

A recent change made that display safe: `app/ts/ui/fit-value.ts` keeps each verbatim value on one line at the largest rung of a size ladder that fits, 13px down to a 10px floor, then a stacked phase, then a residual rung with a visible scrollbar. `[verified in this repository]` — `FIT_LADDER` and `fitValue` in `app/ts/ui/fit-value.ts`; the document's rung rules are in `app/stylesheets/invoice.css` from `:472`, the payment panel's in `app/stylesheets/app.css` from `:722`.

The screen floors exist because below them a monospaced address stops separating `0` from `O` and `l` from `1`. `[verified in this repository]` — the `FIT_LADDER` comment in `app/ts/ui/fit-value.ts`.

Print cannot be measured from script, so the printed twin is sized from its character count against the real page geometry: a 7in column between `print.css`'s page margins, which is 672 CSS pixels, against a 0.62em bound on the widest monospace advance a printer substitutes. `[verified in this repository]` — `PRINT_VALUE_WIDTH_PX` and `MONO_ADVANCE_EM` at `app/ts/ui/fit-value.ts:17`, and "the print ladder's break points follow print.css's own page geometry" in `tests/fit-value.test.mjs:267`, which derives the same figures from `print.css`'s own `@page` block.

On that geometry 9pt holds up to 90 characters, 8pt 101, 7pt 116, and 6pt 135, so a Sapling address at 78 characters and a Monero integrated address at 106 both print at 9pt, and only a value past 135 characters — a Zcash unified address, or the `zcash:` link carrying it — reaches the rung that wraps. `[verified in this repository]` — `printFitRung` and `printedCharacters` in `app/ts/ui/fit-value.ts`, with the lengths at "a printed payment value is the whole value, sized by its length and wrapped only past the floor" in `tests/view.test.mjs:899`.

The payment panel fits the same two values the payer's document fits — the amount row and the recipient row — while the asset and network rows keep the size the stylesheet states, because neither is a string a wallet takes verbatim. `[verified in this repository]` — `paySummary` at `app/ts/ui/pay.ts:418` hands the fitting to the amount and recipient terms only, and the `payTerm` comment beside it states the trade.

Every surface that subscribes to something hands its teardown back on the element it built, and the shell keeps one release slot, so the fitting above cannot be left watching a row the page has dropped. `[verified in this repository]` — `Release`, `ReleasableElement` and `releasable` at `app/ts/ui/release.ts:29`, the element each renderer returns (`renderPaymentSection`, `renderInvoiceView` at `app/ts/ui/view.ts:56`, `renderCreateView` at `app/ts/ui/create.ts:613`, `buildPayDialog` in `app/ts/ui/pay.ts`), and the one `contentRelease` slot at `app/ts/app/shell.ts:96`.

That removed one hazard, since a payer can only check what they see whole. `[verified in this repository]` — the residual rung is what a value takes when no size holds it, and `fitValue` leaves an unmeasurable box at its current rung rather than guessing that it fits.

The comparison remains the hard part: even a forced side-by-side comparison of a correct string left substituted addresses undetected at the rates below. `[reported from an external source]` — Dechand et al., USENIX Security 2016.

### What the Evidence Shows

The options below are judged against the instruction to verify the address over a secondary channel.

- No published study measures whether an identicon or avatar reduces address-substitution losses. `[unverified]` — an absence of evidence, not evidence of absence.
- Forced side-by-side comparison still produced undetected attacks: hex 10.44%, Base32 8.50%, PGP words 8.78%, numeric 6.34%, Peerio words 5.75%, sentences 2.99%, over 1,047 participants. `[reported from an external source]` — Dechand et al., USENIX Security 2016.
- The same study ran a chunk-size experiment: 400 participants, chunk sizes 2 to 8, and chunks of three or four characters were the fastest to compare, with no significant effect on the detection fail rate. `[reported from an external source]` — Dechand et al., USENIX Security 2016.
- Visual fingerprints scored well on both accuracy and speed with 436 participants. `[reported from an external source]` — Hsiao et al.
- The further note that fingerprint verification is seldom performed in practice is a related-work claim by the later authors, not a finding of the 436-participant study. `[reported from an external source]` — Dechand et al., USENIX Security 2016, reporting on Hsiao et al.
- A graphical aid therefore helps only where a comparison already happens. `[reported from an external source]` — the two studies above, read together.
- The dominant attack is address poisoning: 270 million attempts, 17.4 million victim addresses, 6,633 successful payoffs, and at least $83.8 million lost on Ethereum and BSC between July 2022 and June 2024. `[reported from an external source]` — Tsuchiya et al., USENIX Security 2025.
- 6,633 payoffs against 270 million attempts is about 0.0025% across both chains, which is this memo's division of two figures the study reports rather than a rate the study states. `[reported from an external source]` — the same study's attempt and payoff counts.
- The lookalike counts, a figure of 681 typo transfers worth $5.5 million, and a "roughly 0.01% success" rate that appear in secondary coverage of the same study were not confirmed against the paper and are not relied on here. `[unverified]`
- Their lookalike threshold was at least three matching leading and four matching trailing characters, chosen because that is how interfaces abbreviate addresses on screen. `[reported from an external source]` — same study.
- In June 2026 MetaMask's response to poisoning was detection plus more characters (`0xEdf89FdA047F28…C6341a8ff7ED`), conceding "at a glance, virtually no one catches the difference." `[reported from an external source]` — MetaMask, June 2026.

The uncomfortable pair is the abbreviation and the vendor's conclusion: the characters a payer sees are the attack surface, and the largest wallet vendor's surviving difference is a longer string. `[reported from an external source]` — the two sources above.

### The Six Options, Ranked

**(a) Remember the last paid address per payee, warning when a new invoice for that payee names a different one.** The only option that removes the comparison burden: the payer answers "this is different from last time" instead of "does this match a string I cannot remember". It needs local storage, so it lands or falls with section 2's storage decision, but it cannot ride on section 2's record: that record deliberately stores no address, amount, or payee name, so this option needs a second record — payee identity to address — and that record is a readable list of who this device pays, which is section 4's harm in a smaller package. Estimated effort: three to five days `(estimate)`, the second record and its Forget control included.

**(b) Show the address in groups of four.** The separators are not what a wallet takes verbatim: the value is one text node whose copy is byte-for-byte pinned by "the amount, the payee address, and the payment link copy byte for byte, at the widest values a legal invoice carries" in `tests/view.test.mjs:1460`, and grouping lengthens the string, pushing the fitter toward a smaller rung. `[verified in this repository]` The only direct evidence on grouping is the chunk-size experiment above, where three- and four-character chunks were fastest with no significant change in the detection fail rate, so grouping buys speed and buys no accuracy. `[reported from an external source]` — Dechand et al., USENIX Security 2016. Estimated effort: one to two days `(estimate)`; not worth doing alone.

**(c) Emphasise the first and last characters while keeping the whole string.** Emphasis needs per-character markup, turning one text node into many and colliding with the same copy, print twin, and focus stop. `[verified in this repository]` — `paymentValue` in `app/ts/ui/payment-section.ts` draws the verbatim value as one text node, and "a verbatim payment value is a named focus stop with its own ring, and the residual rung is the visible cue that it scrolls" in `tests/view.test.mjs:1871` pins that presentation. Estimated effort: one to two days `(estimate)`; not recommended.

**(d) Tell the payer to confirm the recipient in the wallet's own confirmation screen at signature time.** The wallet's window is a trusted display rather than a second channel: the attacker does not render it, and it shows the address the transaction will pay. The panel's resting status already names that screen, so this is prominence, not new machinery. `[verified in this repository]` — the ready-state message "Your wallet will show the amount and the recipient before you approve" at `app/ts/ui/pay.ts:278`.

What (d) adds is the instruction at the moment of signing; it adds nothing to the comparison itself, because the same evidence shows that being told to compare a correct string still leaves 8.5% (Base32) to 10.44% (hex) of substitutions undetected. `[reported from an external source]` — Dechand et al., USENIX Security 2016.

What it cannot add is anything beyond the characters the wallet chooses to show: a wallet that abbreviates the address hands the payer the same short prefix and suffix the poisoning study targets, and no wording changes that. `[reported from an external source]` — Tsuchiya et al., USENIX Security 2025.

It stays recommended as wording rather than as a control: it costs half a day `(estimate)`, and it moves the comparison onto a surface this page cannot draw, which no in-page option can claim. `[verified in this repository]` — this page reaches no network (`connect-src 'none'` in `app/index.html`, and the `NETWORK_APIS` sweep at `tests/slow/acceptance.test.mjs:90`), so nothing it renders can reach that screen.

**(e) Pay by scanning the QR instead of copying the string.** Scanning removes the clipboard as a substitution surface, so malware that rewrites a copied address has nothing to rewrite. The symbol encodes the app's own `ethereum:`, `zcash:`, or `monero:` link. `[verified in this repository]` — `PAYMENT_SCHEME_PREFIXES` in `app/ts/payment/scheme-prefixes.ts`, `buildPaymentLink` in `app/ts/payment/links.ts`, and `paymentQr: encodeQr(paymentLink)` at `app/ts/ui/presentation.ts:351`. Whether a wallet scans an `ethereum:` URI correctly is outside this repository. `[unverified]` Estimated effort: under a day `(estimate)`.

**(f) Identicons as a weak recognition aid.** An identicon gives a payer who already knows the payee's avatar a fast "not the usual picture" signal, cheaply, and does not defend against a phishing invoice, which carries the attacker's address and therefore the attacker's matching avatar. `[verified in this repository]` — an avatar built from the invoice's own `payee.address` is derived from whatever the fragment decodes to (`decodeShare` in `app/ts/invoice/share.ts`), so a tampered invoice draws its own picture. Decoration only, never the sole identifier (section 3). No study measures the aid's effect on losses. `[unverified]` — the absence recorded above. Estimated effort: two to five days `(estimate)`.

### Recommendation

Adopt (a) with section 2's storage decision and the second record (a) needs, and adopt (d) and (e) now as wording and guidance.
Do not spend effort on (b) or (c): they carry regression risk against the display work just finished — the copy, print-twin and focus-stop guarantees named above — and the one study that tested grouping found it faster without being more accurate. `[reported from an external source]` — Dechand et al., USENIX Security 2016.
Treat (f) as decoration.
Only (a) changes the payer's task from memory to difference. `[unverified]` — an argument from what each option asks of the payer, not a measurement.

### What Cannot Be Done Without a Server

- **A payee directory.** "Is this the real Acme?" needs an authoritative stored list, and this app has none: the invoice travels inside its own link. `[verified in this repository]` — `encodeShare` in `app/ts/invoice/share.ts` puts the whole invoice in the URL fragment.
- **ENS or DNS lookups.** A lookup is a network query, forbidden by `connect-src 'none'` and the sweep `[verified in this repository]` (`app/index.html`, and the `NETWORK_APIS` sweep at `tests/slow/acceptance.test.mjs:90`), and it would leak which payee is about to be paid.
- **Confirmation from the payee.** Asking "did you send this?" needs a channel, and the app has none it may use. `[verified in this repository]` — the same `connect-src 'none'` policy.

### The Residual Risk, Stated Plainly

An attacker who controls the link controls every pixel the payer sees. `[verified in this repository]` — the document is built from the fragment the visitor opened (`decodeShare` in `app/ts/invoice/share.ts`).
Nothing inside a tampered invoice can prove the payee's identity, because by the time it renders the invoice is the attacker's document, and no field in it is signed or authenticated. `[verified in this repository]` — `app/ts/invoice/codec.ts` serializes and decodes the invoice as plain JSON with no key, digest, or message authentication code.
No option above changes that; they change only how likely a payer is to notice a substituted address in a document they already trust. `[unverified]` — a summary of the options' scope, not a measurement.

## 2. A Privacy-Preserving Double-Payment Guard

### What the Guard Does Today

The guard exists and is deliberately memory-only, so it protects one page session: a reload or a second tab is an ordinary action that defeats it. `[verified in this repository]` — `attemptedPayments` at `app/ts/ui/pay.ts:53` is a module-scope `Map`, and its comment states that the record lives only in memory so a genuine reload starts over.

- The `sendAttempted` latch in `app/ts/ui/pay-flow.ts` is set the instant a transaction is handed to the wallet, and cleared only on an explicit decline. `[verified in this repository]` — `sendAttempted` at `app/ts/ui/pay-flow.ts:114` is set at `:296` inside the send callback and cleared at `:308` only for a wallet rejection of the transaction.
- A per-invoice map refuses reopening the panel for an invoice already attempted here (the `attemptedPayments` map and `claimPayment` in `app/ts/ui/pay.ts`). `[verified in this repository]` — the refusal on `attemptedPayments.has(key)` is at `:130`.
- The refusal says reloading is the only way to start over (`REOPEN_MESSAGE` at `app/ts/ui/pay.ts:77`, and `SEND_CLAIMED_ELSEWHERE_MESSAGE` at `app/ts/ui/pay-flow.ts:100`). `[verified in this repository]`
- A reload or a second tab wipes the guard, because nothing is written (the comment on `attemptedPayments` in `app/ts/ui/pay.ts`). `[verified in this repository]`
- The app cannot confirm anything on chain: `connect-src 'none'`, and the `NETWORK_APIS` sweep in `tests/slow/acceptance.test.mjs`. `[verified in this repository]`

### Three Options

**Option A — memory plus a channel between tabs only.** A `BroadcastChannel` would tell other open tabs that an invoice was claimed, and the record would survive neither a reload nor the case that matters most: a payer who reloads because the wallet was unclear, then pays again. The storage sweep does not name `BroadcastChannel` `[verified in this repository]` (`STORAGE_APIS` at `tests/slow/acceptance.test.mjs:92` names only `localStorage`, `sessionStorage`, `indexedDB`, `history`, `window.name`, `document.cookie`), so using it would pass the gate silently; the entry must be written deliberately. Estimated effort: about a day `(estimate)`.

**Option B — one opaque salted hash record in local storage, plus a cross-tab notification.** One string per invoice would survive a reload, a second tab, a browser restart, and back-and-forward navigation. Estimated effort: two to three days `(estimate)`, plus a gate change and README rewording. Recommended.

**Option C — a fuller record.** Per-invoice entries with timestamp, status, and optionally payee name and amount: a payment history in everything but name. `[unverified]` — an argument from the fields it would hold, not a measurement. Not recommended. Estimated effort: four to six days `(estimate)`.

### Recommendation: Option B, and Exactly What It Stores

Store, under one storage key, one line per attempted invoice:

```
<version>:<hex digest>
```

The digest is SHA-256 over a fixed application salt concatenated with the invoice's canonical serialization, which the guard already uses as its key (`paymentKey` at `app/ts/ui/pay.ts:56` returns `serializeInvoice(invoice)`). `[verified in this repository]` No new dependency is needed: `app/ts/util/encoding.ts` already re-exports `sha256`, `utf8ToBytes`, and `toHex`. `[verified in this repository]`

Deliberately not stored: address, amount, payee name, invoice text, invoice id, and any timestamp that identifies a person.
The record holds a version and an opaque digest, so it cannot be turned into "who was paid, how much, when", and it is not a list of invoices.

The salt is a constant compiled into the app rather than a value chosen per page load, which is why the guard works across tabs: two tabs derive the same digest for the same invoice, whereas a per-page salt would break the guard after a reload.

The record therefore hides which invoice was attempted from anyone scanning the browser's storage, and hides nothing from anyone who holds the link, since they can compute the same digest. `[unverified]` — an argument about what a salted digest can hide, not a measurement.

Retention: keep a small fixed number of records, newest kept, oldest dropped, and give the payer a Forget control that clears this device's record for the invoice.

The Forget control cannot sit in the payment panel or in the refusal notice. `[verified in this repository]` — the refusal path builds no panel: `openPayPanel` reports the refusal through the notice region and returns `null` (`app/ts/ui/pay.ts:123`, `:130`), the notice region is one text paragraph with no controls (`showNotice` at `app/ts/app/shell.ts:98`), and `NoticeApi` offers only `showNotice` and `clearNotice` (`app/ts/ui/notice.ts:13`).

The affordance therefore belongs in the payer's document actions — the region `documentActions` builds beside Pay and Save as PDF (`app/ts/ui/view.ts:209`) — shown only when this device holds a record for the invoice, and the refusal's wording names it there.

A later payer of the same invoice on a shared browser is refused although they never attempted it: the refusal tests only whether the invoice's key is already claimed, not who claimed it. `[verified in this repository]` — the refusal is `attemptedPayments.has(key)` at `app/ts/ui/pay.ts:130`.
Forget clears that, but they must be told about it where they are refused.

The record also reveals that somebody tried to pay this invoice, and the record cap plus Forget are the only mitigation available without a server. `[unverified]` — no server-side state is available to bound it further.

### The Wording After an Unclear Wallet Result

The screen treats an unclear wallet result as "it may already be sent", so it does not offer a fresh start as if nothing happened. `[verified in this repository]` — the `send-failed` frame offers a send-only "Try sending again" and an "I already sent it" exit rather than the whole-flow retry (`app/ts/ui/pay.ts`, and `afterSendFailureMessage` in `app/ts/ui/pay-flow.ts`).

Primary button: unchanged at `Try sending again`, which is already the safe retry, repeating only the send rather than discovery, connection, or the funds check. `[verified in this repository]` — `app/ts/ui/pay.ts:254` binds it to `flow.retrySend()`, and `resend` at `app/ts/ui/pay-flow.ts:329` re-sends only.

Replacement for "reloading the page is the only way to start over", in both messages:

- "A payment for this invoice was already attempted from this browser. Check your wallet's activity before trying again. To start over on this device, use Forget this invoice's payment attempt beside the Pay button."
- "Another payment for this invoice is already under way from this page, so this one was not sent. Check your wallet's activity before trying again. To start over on this device, use Forget this invoice's payment attempt beside the Pay button."

Caution line with the ambiguous result: "Your wallet did not confirm the transaction. It may still have been sent, so check your wallet's activity before trying again."

No wording may imply that forgetting undoes a payment: the label says "attempt", and the caution line stays the only statement about what was broadcast.

### What Must Change Together

- "No cookies, no tracking, and no analytics" in `README.md`'s "Privacy over features" `[verified in this repository]` — `README.md:24` — must say what the browser keeps: one anonymous marker per attempted invoice, with a Forget control in the invoice's document actions.
- "The app keeps no list of the invoices you made" stays true only if that section also says the marker is a digest rather than an invoice. `[verified in this repository]` — `README.md:27`.
- The no-storage note on `attemptedPayments` in `app/ts/ui/pay.ts` ("The record lives only in memory…") becomes false and must describe the digest, its retention, and Forget. `[verified in this repository]`
- The hard gate: `STORAGE_APIS` at `tests/slow/acceptance.test.mjs:92`, and its two assertions — the runtime one at `:810` in "no served runtime module can build markup, evaluate code, or reach the network" and the vendored one at `:1120` — forbid any storage API in every runtime file and in every vendored bundle. `[verified in this repository]` The change must be a content-specific exemption of the kind the sweep already uses, as `isSanctionedElementBuilder` and `isSanctionedSvgNamespace` are: a named module plus an exact statement, not a looser pattern.
- The runtime blocker: `tests/helpers/network-block.mjs` installs stubs over `localStorage`, `sessionStorage`, `indexedDB`, `history`, `window.name` and `document.cookie` that record the call and throw, and the app's own suites load under it. `[verified in this repository]` — "the runtime blocker records the storage and side-channel sinks the runtime sweep relies on" at `tests/security.test.mjs:135`, and every slow-gate load of the page or a vendored module through `tests/helpers/vendor-network-smoke.mjs`, spawned by "the page entry and vendored modules load with every network API blocked" at `tests/slow/vendor.test.mjs:424`. A storage-backed guard therefore cannot even be loaded under those runs — the first `setItem` throws — so the design must also state what the guard does when storage is unavailable, and the suites must be able to inject a storage double for the one module that uses it.
- The wording tests match `/already attempted/`, which is `REOPEN_MESSAGE`'s phrase, not the new wording's: the matchers are at `tests/pay-flow.test.mjs:671` inside the three "dismissing the panel with … while a send is in flight still latches the payment" tests, and at `tests/wallet.test.mjs:1025` and `:1059` inside "a panel reopened for the same invoice refuses a second payment" and "navigating away and back to the same invoice cannot re-arm the payment latch". `[verified in this repository]` The test "the send attempt is surfaced the instant the transaction leaves for the wallet" at `tests/pay-flow.test.mjs:593` asserts the `onSendAttempt` callback and no wording. `SEND_CLAIMED_ELSEWHERE_MESSAGE` is asserted nowhere: no test names its phrase "already under way". `[verified in this repository]`

The owner has to sign the storage decision explicitly: the sweep exists because no-storage was a hard rule, and a rule widened quietly is worse than one narrowed in a named place.

### What a Device-Side Guard Cannot Do

A guard on the payer's device cannot stop a determined double payment: another browser, a private window, cleared site data, or a second device never consults the record, because the record lives in one browser's storage and nowhere else. `[unverified]` — a consequence of the design, not a measurement.
The chain is the only authority, and this app cannot ask it, because `connect-src 'none'` means it reaches no node and the wallet's own report is all it sees. `[verified in this repository]` — `app/index.html`'s policy and the `NETWORK_APIS` sweep.
The guard's job is the ordinary accident, and the wording should say so.

## 3. Blockies Feasibility (Investigate Only)

### The Candidates

- Original `ethereum/blockies`: archived, last push March 2022, no licence file and no licence grant, so it cannot be vendored, because this project redistributes what it vendors. `[reported from an external source]` — the repository's own archive notice and file listing.
- `@metamask/jazzicon`: CommonJS only, roughly 4–5 kB, unreleased since 2020, and its common address adapter uses only the first 8 hex characters as an integer seed. `[reported from an external source]` — the package's listing and source.
- `blo` 2.1.1: MIT, zero dependencies, pure ESM, about 0.7 kB gzipped, actively maintained, produces the blockies look MetaMask and Etherscan users recognise, and lowercases the seed. `[reported from an external source]` — the package's listing and source. The best fit.
- `minidenticons`: MIT, smaller than `blo` but unrecognisable to anyone who has not seen it. `[reported from an external source]` — the package's listing.
- Hand-rolled: about 30 lines, no smaller than `minidenticons`, and it becomes code this project owns and tests. `(estimate)`

### What the Family Computes

It runs an xorshift over character codes rather than a cryptographic hash, and builds a mirrored grid of cells. `[reported from an external source]` — the `blo` source.
Any address string works as a seed, so there is nothing to validate. `[reported from an external source]` — the same source.
Case folding matters, though, because the EIP-55 mixed-case and lowercase spellings of one address must map to the same avatar, which is what `blo`'s lowercasing gives. `[reported from an external source]` — the same source.
The invoice path stores and displays the checksummed spelling (`requireInvoiceAddress` in `app/ts/wallet/address.ts`). `[verified in this repository]`
Canvas-based libraries are said to cost far more per icon than a pure SVG builder, and identicon collisions are essentially unmeasured. `[unverified]` — no source was confirmed for either claim; a rendering-cost figure would need a browser and a stopwatch, and a collision figure would need a birthday trial over the candidate's own seeds.

### What It Would Take in This Repository

There is no bundler, so an ESM file is vendored as the three existing packages are: a copied file, a `SHA256SUMS` entry, a `VENDOR_PINS` entry in `scripts/vendor-pins.mjs`, a `SOURCES` entry in `scripts/fetch-vendor.mjs`, and a licence block in `vendor-src/THIRD-PARTY-NOTICES`. `[verified in this repository]`

Files touched: `package.json` and `bun.lock`; both vendor scripts, plus a `HAND_WRITTEN_FILES` entry if a `.d.ts` shim is hand-written as the current three need; `vendor-src/blo/` and a re-blessed `vendor-src/SHA256SUMS` from `bun run vendor -- --add-new`; `vendor-src/THIRD-PARTY-NOTICES`; a new runtime module importing `../../js/vendor/blo/…` as `app/ts/util/encoding.ts` does; call sites in `app/ts/ui/pay.ts` and `app/ts/ui/payment-section.ts`; and sizing rules in `app/stylesheets/invoice.css` and `app/stylesheets/app.css`.

The data-URL shape costs nothing. The app's single image sink accepts only an SVG data URL with the exact `data:image/svg+xml;base64,` prefix and a bounded base64 payload, and `h()` refuses anything else (`checkedAttributeValue` in `app/ts/util/dom.ts`, `isSvgDataUrl` in `app/ts/util/data-url.ts`). `[verified in this repository]`

`blo` 2.1.1 builds exactly that shape: its `dist/esm/index.js` spells `"data:image/svg+xml;base64," + btoa(bloSvg(address, size))`, which is the same prefix `SVG_DATA_URL_PREFIX` states. `[reported from an external source]` — `blo@2.1.1`, `dist/esm/index.js`, read from the published package and not rechecked here.

So no re-encode and no new sanctioned sink are needed for the data-URL shape, and the image gate stays as it is. `[reported from an external source]` — that file's prefix, against `SVG_DATA_URL_PREFIX` in `app/ts/util/data-url.ts` and the sink `h()` enforces in `app/ts/util/dom.ts`.

What remains open is the payload bound the sink enforces: the base64 payload may decode to at most `MAX_ICON_SVG_BYTES`, which is 8,192 bytes, and its length is capped by `MAX_SVG_DATA_URL_PAYLOAD` before it is ever copied. `[verified in this repository]` — `app/ts/util/icon-capacity.ts:11` and `app/ts/util/data-url.ts:30`. Whether a blockies SVG stays inside that bound is unmeasured here, because `blo` is not vendored in this repository. `[unverified]`

Branding and asset size remain open too: an avatar is not the app's brand, and the vendored file plus its shim is a new asset this project carries and has to keep pinned. `[unverified]`

Tests needed: the bundle sweeps pick the new file up automatically, since they derive their list from `SOURCES` (`tests/helpers/vendor-bundles.mjs`, and "every vendored bundle is self-contained and free of network APIs" at `tests/slow/vendor.test.mjs:395` beside "the page entry and vendored modules load with every network API blocked" at `:424`), and a shim's exports are checked against the bundle beside it by that file's "every name a hand-written shim declares is an export of the vendored bundle beside it" at `:351`. `[verified in this repository]` New unit tests cover the seed fold, empty alternative text, the avatar never being the only identifier, and that a payload past the bound is refused.

Estimated effort: two to four days `(estimate)`, dominated by the vendoring ceremony rather than the drawing code; the earlier range was two to five days and included a decision on the image gate that this correction removes.

### Recommendation

Do not ship blockies as a safety measure. They help a payer who already knows the payee's avatar, and they do not defend against a phishing invoice, because that invoice carries the attacker's address and therefore the attacker's matching avatar: the picture agrees with the string. `[verified in this repository]` — the avatar is derived from the invoice's own address, as in section 1's option (f).
An avatar used as an identifier also fails every payer with low vision or colour-vision deficiency, and every payer who has never seen the avatar before. `[accepted risk]`
As decoration, `blo` 2.1.1 is the right package, the work is two to four days `(estimate)`, and it starts with the payload-bound check above rather than with a gate decision.

## 4. Local Address Book Feasibility (Investigate Only)

### What It Takes, and Where It Collides

The app would store, per payee, an association between a payee identity and an address, compare it at pay time, and warn when they disagree.
It needs section 2's storage mechanism, and a payee identity that survives across invoices.
The payee record an invoice carries holds a name, the payout address, and optional free-text contact and notes (`Payee` at `app/ts/invoice/model.ts:104`), so the address is present but cannot be the identity: it is the value the comparison exists to check. `[verified in this repository]`
That leaves the typed name as the only stable handle, and it is attacker-controlled free text, where a lookalike name creates a false alarm and a loose rule lets a lookalike overwrite the saved address. `[verified in this repository]` — `Payee.name` and `Payee.email` are the free-text fields, bounded and validated for display but carrying no authority (`app/ts/invoice/model.ts`).

The collision is with the README's privacy section, which says the app keeps no list of invoices because saved history would show who paid whom and how much. `[verified in this repository]` — `README.md:27`.
An address book is not a list of invoices, but it is a list of who this device pays: the same harm in a smaller package. `[verified in this repository]` — the record it needs holds exactly the payee name and address those sentences promise the app does not keep.

### What Must Change Together

The same set as section 2: the code, the README privacy section, `STORAGE_APIS` at `tests/slow/acceptance.test.mjs:92` with that sweep's two assertions at `:810` and `:1120`, the runtime blocker described in section 2, and the no-storage sentence on `attemptedPayments` in `app/ts/ui/pay.ts`. `[verified in this repository]`

If both features land they share one storage decision and one named sweep exemption, but they are two records: section 2's opaque digest, and a separate payee-to-address record that is readable. `[verified in this repository]` — section 2's record is a version and a digest over the invoice's canonical text (`paymentKey` at `app/ts/ui/pay.ts:56`), so no payee field is readable from it.

The price of the second record is that it becomes the readable list this section warns about: it would hold the payee name beside the address, which is what `README.md:27` rules out keeping. `[verified in this repository]`
Both records would sit under one retention policy and one Forget control.

### The Labelling Question

The label cannot be the typed name alone. `[unverified]` — an argument from the free-text field, not a measurement.
The workable shape: save under the normalised payee name, show the saved address's first and last few characters beside the label, and let the payer rename or delete an entry.
Renaming matters, because "Acme Ltd" and "Acme Limited" are not a mismatch worth shouting about. `[unverified]` — a judgement about names, not a measurement.

### The Shared-Device Risk

On a shared browser an address book is a list of the people the previous user pays, with readable labels, worse than section 2's opaque marker. `[unverified]` — an argument against a design that stores payee names beside addresses, not a measurement.
Without a server the only mitigations are visible Forget controls and a first-use explanation; a shared browser cannot be made safe for this, only made obviously the payer's choice.

### The Payoff, and the Recommendation

The payoff is one warning, and it is the most useful this app could show: "This address is not the one saved for this payee."
It addresses the misuse the poisoning study measures because the app compares, not the person; no measurement of that effect exists. `[unverified]`
Recommendation: do not build the address book alone. Build it as the second step of section 1, on the same storage decision, after the last-paid memory has been in use and the identity rule tested against real names. Estimated effort for the pair: five to eight days `(estimate)`.

## A Plain-Language Note on Address Lengths

Address lengths look arbitrary and are not. `[verified in this repository]`

- A Zcash transparent address (`t1…` or `t3…`) is 35 characters — a version, a 20-byte hash, and a checksum in Base58Check, bounded at 36 before decoding (the bound `MAX_TRANSPARENT_TEXT_LENGTH` at `app/ts/wallet/zcash-address.ts:51`).
- A Zcash Sapling address (`zs1…`) is 78 characters — Bech32 over a 43-byte payment address (same file's `SAPLING_PAYLOAD_BYTES` at `:71`).
- A Zcash unified address (`u1…`) runs to 311 characters — `MAX_ZCASH_ADDRESS_LENGTH` at `app/ts/payment/schemes.ts:81`, derived as the widest symbol the app draws, less what a `zcash:` link spends besides the address, less an 8-byte margin.
- A Monero address is 95 characters, or 106 for an integrated one (the `MONERO_FORMS` table at `app/ts/wallet/monero-address.ts:50`).

A unified address is long because its container concatenates several receivers, so one string lets a sender pay whichever form the recipient supports. `[verified in this repository]` — the container-as-item-list grammar at `app/ts/wallet/zcash-address.ts:145`, and the 311-character bound at `app/ts/payment/schemes.ts:81`; the validator measures that container's payload and never reads the receivers inside it.
That is normal, not a defect, and it is why the display and print ladders exist.

## The Risk We Accepted: Embedding

The page may be embedded by another page on purpose: the dev server sends no `X-Frame-Options` and no `frame-ancestors`, and the meta-delivered policy cannot carry `frame-ancestors` anyway (`serve.mjs`, `app/index.html`). `[verified in this repository]`
Framing protection is out of scope by the owner's decision, comparable to defending against a malicious browser. `[accepted risk]`
Two controls remain unchanged: no wallet is touched until the payer's own click on Connect wallet & pay, and a window another page opened is still refused (`openPayPanel` and `openerRefusal` in `app/ts/ui/pay.ts`). `[verified in this repository]`
What becomes possible is a host page overlaying or driving the controls it frames, which the README's security section already states. `[accepted risk]`

## The Label Audit

Every claim in this memo carries one of the four labels above, and this audit was performed by hand — reading each section against the rule in the preamble — not by an automated check.
The sections that carried unlabelled claim sentences before this revision are recorded here with what changed.

| Section | Unlabelled claims found | Now |
| --- | --- | --- |
| Section 1, "What the App Shows Today" and "What the Evidence Shows" | The purpose of the screen floors; the closing "graphics help only when a comparison already happens"; the commentary on the abbreviation and the vendor's concession | Each carries a label and a named source |
| Section 2, the digest and salt paragraph | What the record hides, and from whom | `[unverified]`, with the argument stated as an argument |
| Section 4 | The identity claim, and the shared-record sentence | The payee fields are `[verified in this repository]`; the shared record is stated as a design price |
| A Plain-Language Note on Address Lengths | The closing sentence on unified addresses | `[verified in this repository]`, with the decoder's own limits named |

Unlabelled claims remaining: none.
