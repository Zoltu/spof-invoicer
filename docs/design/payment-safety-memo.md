# Payment Safety Design Memo

This memo answers four questions about paying an invoice here: easier address verification, a guard against an accidental double payment, blockies avatars, and a local address book.
Each question carries one recommendation, alongside what that recommendation costs.
Sections 5 to 7 follow those four: a plain-language note on why an address is the length it is, the framing risk the maintainer accepts, and an audit of every label the memo carries.
Every claim carries one of four labels.

- `[verified in this repository]` — read in this repository's code, configuration, or tests; the file is named.
- `[reported from an external source]` — a study, package listing, or vendor statement, cited and not rechecked here.
- `[unverified]` — asserted or plausible, but neither checked here nor cited.
- `[accepted risk]` — a hazard the maintainer has chosen to live with, recorded so it is not read as an oversight.

A proposal, a recommendation, or an effort figure is not a claim and carries no label; a sentence that asserts a fact about this repository, a study, a package, or the world does.
A judgement offered as a preference carries no label either, and a judgement the memo argues for carries `[unverified]`, with the argument written beside it.
Every label closes the claim it marks, and a source the claim does not name in its own sentence follows the label after an em dash.
In a list, the label on the sentence that introduces the list covers its items, and each item still names its own source.
Effort is stated as an `Estimated effort:` line marked `(estimate)`: the maintainer's judgement, not measurements.
No wallet was exercised and no payer was tested for this memo. `[unverified]` — the memo's own account of how it was produced, which nothing in this repository records or can check.

## Glossary

- **ladder** — the ordered list of rungs a value may be set at; the app has two ladders, a screen ladder and a print ladder, and `FIT_RUNGS` in `app/ts/ui/fit-value.ts` is the one statement of both.
- **rung** — one entry in a ladder: on the screen ladder, one font size in one phase, or the residual rung at the screen floor, so one size can be several rungs; on the print ladder, one point size a printed value may be set at, or the wrapping rung, which states no size and lets a value past the floor break.
- **phase** — one of the two row layouts a value is tried in on screen, inline or stacked; each phase's rungs are stated largest first.
- **inline** — the phase that puts the label, the value, and the copy control on one row: the invoice's payment terms draw that row at every width, while a payment panel term carries no copy control and is stacked below 640px wide, where `app.css` gives every panel term a line of its own whatever rung the fitter writes.
- **stacked** — the phase that puts the label on a line of its own and gives the value the whole row.
- **residual rung** — the last rung of the screen ladder, taken when no size in either phase holds the value: the value at the screen floor, scrolling its overflow behind a visible scrollbar.
- **wrapping rung** — the last rung of the print ladder, taken when no sized print rung holds the value: its ladder entry states no size, and `print.css` draws it at the print floor, letting the value break rather than shrinking it further.
- **floor** — the smallest size a ladder steps down to.
- **verbatim value** — a value a wallet takes verbatim, drawn as one run the page never truncates or respaces and holds on one line by its font size rather than by wrapping, with only the print ladder's wrapping rung letting one break: here the amount, the payee address, and the payment link.
- **print twin** — a second copy of a verbatim value that only the printed page shows.
- **sweep** — a check that scans a set of the repository's files for forbidden patterns; this memo names each sweep for what it scans — the network sweep, the storage sweep, and the vendored sweeps.
- **focus stop** — a stop the payer reaches with the keyboard: the value itself takes focus, is named by its label, and carries its own focus ring.
- **release** — the way to stop everything a surface started: the subscriptions it took and the DOM changes it made, handed back with the element that surface built, so the page can run it when it drops that element, and doing nothing the second time it runs.
- **`releasable`** — the call `app/ts/ui/release.ts` exports that attaches a release to the element it belongs to.
- **`NOTHING_TO_RELEASE`** — the value `app/ts/ui/release.ts` exports for a release that does nothing: the release a surface states when it started nothing, and the subscription `app/ts/app/layout-probe.ts` returns when the engine cannot watch a box.
- **framing** — showing a page inside another page's window: a wallet host frames the invoice so the payer reads it beside the wallet they pay from, and this app permits that framing on purpose (Section 6).
- **opener** — the page that opened a window, which the browser exposes to the opened window as `window.opener`; the payment panel refuses every window that reports one, whatever page that opener names, because presence alone is what the browser reports, and an opener served from the same website is the case that matters, since it can drive the controls of the page it opened (Section 6).
- **avatar** — the small image drawn from a payee address and shown beside it, so a payer who has seen that address's avatar before has something to recognise; this memo treats an avatar as decoration, never as the sole identifier (Section 3).
- **blockies** — the avatar family Section 3 weighs: an image drawn from the address as its seed, as a mirrored grid of cells, which is the shape the libraries weighed there produce.

## 1. Easier Address Verification

### What the App Shows Today

The invoice shows the payee address in full, as text the payer can select, with a control beside it that copies the whole string, and it draws the payment link as a QR code. `[verified in this repository]` — `paymentValue` in `app/ts/ui/payment-section.ts` builds one text node, a copy control, a print twin, and a status for each verbatim term, and `renderPaymentSection` adds `qrBlock` of the view model's `paymentQr`.

The app keeps a value on one line by choosing how large it is drawn, and the choice comes from one of two ladders: the screen ladder the browser measures a value against, and the print ladder the printed page draws a value on. `[verified in this repository]` — the two ladders `FIT_RUNGS` publishes in `app/ts/ui/fit-value.ts`.
The screen ladder lists each phase's rungs from largest to smallest and finishes one phase before it tries the next, so its smallest inline rung, 10px, is tried before the larger stacked rung of 12px, rather than every rung being tried from the largest down. `[verified in this repository]` — the ladder's order in `app/ts/ui/fit-value.ts`, which `smallestFittingRung` walks in that order.
The screen search also measures once per phase rather than once per rung: with that phase's largest rung applied, it compares how wide the value is with the width of its box and takes the largest rung of the phase that holds the value on one line. `[verified in this repository]` — `smallestFittingRung` in `app/ts/ui/fit-value.ts`.
Each ladder has one floor. `[verified in this repository]` — the ladders `FIT_RUNGS` publishes in `app/ts/ui/fit-value.ts`, whose doc comment states each ladder's floor and the order the search walks its phases in, beside "the ladder is searched in two monotone phases and stops at the floor" in `tests/fit-value.test.mjs`; the document's rung rules are in `app/stylesheets/invoice.css`, and the payment panel's in `app/stylesheets/app.css`.

The app takes the first rung that keeps a verbatim value on one line inside the box that holds it, taking the phases in the ladder's own order: the inline row is kept whenever any inline rung at or above the 10px floor holds the value, and the stacked phase is tried only when none does. `[verified in this repository]` — `fitValue` in `app/ts/ui/fit-value.ts`, and the terms `app/ts/ui/presentation.ts` marks `verbatim`.
The payment panel is the one surface where an inline rung is not on the shared row the phase names: below 640px wide `app/stylesheets/app.css` gives every panel term a line of its own whatever rung it carries, so a panel term at that width is stacked either way and its value is fitted against the column the row already gives it. `[verified in this repository]` — the `@media (max-width: 640px)` block at the foot of `app/stylesheets/app.css`, which names `.pay-term`, beside the same width in `app/stylesheets/invoice.css`, which keeps the invoice's own terms on the label's rail.
That is what makes the display safe: a value the payer never sees whole can be checked only against a string that has been shortened. `[unverified]` — an argument about what a whole value buys, not a measurement.

The inline phase steps from 13px down to the screen floor at 10px; the stacked phase steps from 12px down to the same screen floor; and the residual rung holds the value at the screen floor with a visible scrollbar when no rung of either phase holds it. `[verified in this repository]` — the same screen ladder in `app/ts/ui/fit-value.ts`.

The screen floor exists because below it a monospaced address stops separating `0` from `O` and `l` from `1`. `[verified in this repository]` — the `FIT_RUNGS` doc comment in `app/ts/ui/fit-value.ts`.

Print cannot be measured from script, so the print twin is sized from its character count against the page it will be printed on: a 7in column between the page margins, which is 672 CSS pixels, and an allowance for how wide one printed character can be, set a little wider than a Courier or DejaVu Mono character, so the count holds however wide a substituted face draws. `[verified in this repository]` — the printed line width and the 0.62 bound on a character's advance in `app/ts/ui/fit-value.ts`, and "the print ladder's break points follow print.css's own page geometry" in `tests/fit-value.test.mjs`, which derives the same figures from `print.css`'s own `@page` block.

On that geometry 9pt holds up to 90 characters, 8pt 101, 7pt 116, and 6pt 135, so a Sapling address at 78 characters prints at 9pt and a Monero integrated address at 106 prints at 7pt, and only a value past 135 characters — a Zcash unified address, or the `zcash:` link carrying it — reaches the wrapping rung. `[verified in this repository]` — `printFitRung` and `printedCharacters` in `app/ts/ui/fit-value.ts`, with the lengths at "a printed payment value is the whole value, sized by its length and wrapped only past the floor" in `tests/view.test.mjs`.

The payment panel fits four values, one fitted row each — the amount due and the recipient's address, which a wallet takes verbatim, and the connected account and the wallet's balance, which are strings the wallet reports — while its asset and network rows keep the font size the stylesheet states, because neither of them is handed to the fitting. `[verified in this repository]` — the functions that draw the panel's rows, `paySummary`, `accountLine`, and `balanceLine` in `app/ts/ui/pay.ts`, hand those four values to the fitting and the asset and network rows to none, and the panel's rung rules in `app/stylesheets/app.css` name three value classes for those four fitted values, because the amount and the recipient both draw the summary term's.

A value's sizing stops when the page moves on: the page drops the row it fitted, and the measuring goes with it, so nothing keeps checking a value the payer can no longer see. `[verified in this repository]` — the release each renderer hands back with the element it built (`Release` and `releasable` in `app/ts/ui/release.ts`, and the element `renderPaymentSection`, `renderInvoiceView`, `renderCreateView`, and `buildPayDialog` return), run wherever the element is dropped: the shell's `contentRelease` in `app/ts/app/shell.ts`, the create view's own release of the section it replaces on each submit (`showCreatedPayment` in `app/ts/ui/create.ts`), and a dismissal, whose close runs the dialog's release as the overlay goes (`createOverlay` in `app/ts/ui/overlay.ts`).

Sizing the value this way removes one hazard, since a payer can only check what they see whole. `[unverified]` — an argument about what a whole value buys, resting on two checked facts: a value no rung holds takes the residual rung, and `fitValue` in `app/ts/ui/fit-value.ts` leaves an unmeasurable box at its current rung rather than guessing that it fits.

The comparison remains the hard part: even a forced side-by-side comparison of a correct string left substituted addresses undetected at the rates below. `[reported from an external source]` — Dechand et al., USENIX Security 2016.

### What the Evidence Shows

The options below are judged against the instruction to verify the address over a secondary channel. `[unverified]` — an instruction this memo adopts, neither checked here nor cited.

- No published study measures whether an avatar reduces address-substitution losses. `[unverified]` — an absence of evidence, not evidence of absence.
- Forced side-by-side comparison still produced undetected attacks: hex 10.44%, Base32 8.50%, PGP words 8.78%, numeric 6.34%, Peerio words 5.75%, sentences 2.99%, over 1,047 participants. `[reported from an external source]` — Dechand et al., USENIX Security 2016.
- The same study ran a chunk-size experiment: 400 participants, chunk sizes 2 to 8, and chunks of three or four characters were the fastest to compare, with no significant effect on the detection fail rate. `[reported from an external source]` — Dechand et al., USENIX Security 2016.
- Avatars scored well on both accuracy and speed with 436 participants. `[reported from an external source]` — Hsiao et al.
- The further note that comparing avatars is seldom performed in practice is a related-work claim by the later authors, not a finding of the 436-participant study. `[reported from an external source]` — Dechand et al., USENIX Security 2016, reporting on Hsiao et al.
- An avatar therefore helps only where a comparison already happens. `[unverified]` — the two studies above, read together by this memo, not a finding either study states.
- The dominant attack is address poisoning: 270 million attempts, 17.4 million victim addresses, 6,633 successful payoffs, and at least $83.8 million lost on Ethereum and BSC between July 2022 and June 2024. `[reported from an external source]` — Tsuchiya et al., USENIX Security 2025.
- 6,633 payoffs against 270 million attempts is about 0.0025% across both chains, which is this memo's division of two figures the study reports rather than a rate the study states. `[unverified]` — the same study's attempt and payoff counts, divided here.
- The lookalike counts, a figure of 681 typo transfers worth $5.5 million, and a "roughly 0.01% success" rate, all of which appear in secondary coverage of the same study, were not confirmed against the paper and are not relied on here. `[unverified]`
- Their lookalike threshold was at least three matching leading and four matching trailing characters, chosen because that is how interfaces abbreviate addresses on screen. `[reported from an external source]` — same study.
- In June 2026 MetaMask's response to poisoning was detection plus more characters (`0xEdf89FdA047F28…C6341a8ff7ED`), conceding "at a glance, virtually no one catches the difference." `[reported from an external source]` — MetaMask, June 2026.

The uncomfortable pair is the abbreviation and the vendor's conclusion: the characters a payer sees are the attack surface, and the largest wallet vendor's surviving difference is a longer string. `[unverified]` — the two sources above, read together by this memo, not a finding either source states.

### The Options

**Option 1A — remember the last paid address per payee, warning when a new invoice for that payee names a different one.**
The only option that removes the comparison burden: the payer answers "this is different from last time" instead of "does this match a string I cannot remember".
It needs local storage, so it lands or falls with Section 2's storage decision, but it cannot ride on Section 2's record: that record deliberately stores no address, amount, or payee name, so this option needs a second record — payee identity to address — and that record is a readable list of who this device pays, which is Section 4's harm in a smaller package.
Estimated effort: three to five days `(estimate)`, including the second record and its Forget control.

**Option 1B — show the address in groups of four.**
The separators are not what a wallet takes verbatim: the value is one text node whose copy is byte-for-byte pinned by "the amount, the payee address, and the payment link copy byte for byte, at the widest values a legal invoice carries" in `tests/view.test.mjs`, and grouping lengthens the string, pushing the fitting toward a smaller rung. `[verified in this repository]`
The only direct evidence on grouping is the chunk-size experiment above, where three- and four-character chunks were fastest with no significant change in the detection fail rate, so grouping buys speed and buys no accuracy. `[reported from an external source]` — Dechand et al., USENIX Security 2016.
Estimated effort: one to two days `(estimate)`.

**Option 1C — emphasise the first and last characters while keeping the whole string.**
Emphasis needs per-character markup, turning one text node into many and colliding with the same copy, print twin, and focus stop. `[verified in this repository]` — `paymentValue` in `app/ts/ui/payment-section.ts` draws the verbatim value as one text node, and "a verbatim payment value is a named focus stop with its own ring, and the residual rung is the visible cue that it scrolls" in `tests/view.test.mjs` pins that presentation.
Estimated effort: one to two days `(estimate)`.

**Option 1D — tell the payer to confirm the recipient in the wallet's own confirmation screen at signature time.**
The wallet's window is a trusted display rather than a second channel: the attacker does not render it, and it shows the address the transaction will pay.
The panel's resting status already names that screen, so this is prominence, not new machinery. `[verified in this repository]` — the ready-state message "Your wallet will show the amount and the recipient before you approve. Nothing leaves this page until then." in `app/ts/ui/pay.ts`.

What Option 1D adds is the instruction at the moment of signing; it adds nothing to the comparison itself, because the same evidence shows that being told to compare a correct string still leaves 8.5% (Base32) to 10.44% (hex) of substitutions undetected. `[reported from an external source]` — Dechand et al., USENIX Security 2016.

What it cannot add is anything beyond the characters the wallet chooses to show: a wallet that abbreviates the address hands the payer the same short prefix and suffix the poisoning study targets, and no wording changes that. `[reported from an external source]` — Tsuchiya et al., USENIX Security 2025.

Treat this as wording rather than as a control: it moves the comparison onto a screen this page cannot draw, which no in-page option can claim. `[verified in this repository]` — this page reaches no network (`connect-src 'none'` in `app/index.html`, and the network sweep in `tests/slow/acceptance.test.mjs`), so nothing it renders can reach that screen.
Estimated effort: half a day `(estimate)`.

**Option 1E — pay by scanning the QR instead of copying the string.**
Scanning removes the clipboard as a substitution surface, so malware that rewrites a copied address has nothing to rewrite.
The symbol encodes the app's own `ethereum:`, `zcash:`, or `monero:` link. `[verified in this repository]` — the scheme prefixes in `app/ts/payment/scheme-prefixes.ts`, `buildPaymentLink` in `app/ts/payment/links.ts`, and the `paymentQr` entry `app/ts/ui/presentation.ts` derives from that link.
Whether a wallet scans an `ethereum:` URI correctly is outside this repository. `[unverified]`
Estimated effort: under a day `(estimate)`.

**Option 1F — show avatars as a weak recognition aid.**
An avatar gives a payer who has seen the payee's before a fast "this is not the one I know" signal, cheaply. `[unverified]` — a judgement about what a glance buys, not a measurement.
It does not defend against a phishing invoice, which carries the attacker's address and would therefore carry the attacker's matching avatar. `[unverified]` — no avatar is drawn anywhere in this repository, so the claim is an argument from what an avatar would be built from: the invoice's own `payee.address` is whatever the fragment decodes to (`decodeShare` in `app/ts/invoice/share.ts`), so a tampered invoice would draw its own avatar.
No study measures the aid's effect on losses. `[unverified]` — the absence recorded above.
Estimated effort: two to four days `(estimate)`.

### Recommendation

Adopt Option 1A with Section 2's storage decision and the second record Option 1A needs, and adopt Options 1D and 1E now as wording and guidance.
Do not spend effort on Options 1B or 1C: they carry regression risk against guarantees the app already keeps — the copy, the print twin, and the focus stop named above — and the one study that tested grouping found it faster without being more accurate. `[reported from an external source]` — Dechand et al., USENIX Security 2016.
The display change this memo describes in the app is the fitting the app already performs, and the two display changes it rejects — showing the address in groups, and emphasising its first and last characters — are Options 1B and 1C. `[verified in this repository]` — the fitting in `app/ts/ui/fit-value.ts`.
Treat Option 1F as decoration, never as the sole identifier (Section 3).
Only Option 1A changes the payer's task from memory to difference. `[unverified]` — an argument from what each option asks of the payer, not a measurement.
What this memo recommends is only partly in place: the panel's resting status already tells the payer the wallet will show the amount and the recipient before approving, and the invoice already draws its payment link as a QR symbol, while the instruction to confirm the recipient at signing, the record of the last address paid to each payee, and Section 2's storage-backed guard are not implemented. `[verified in this repository]` — the ready-state message in `app/ts/ui/pay.ts`, and `qrBlock` in `app/ts/ui/payment-section.ts`.

### What Cannot Be Done Without a Server

- **A payee directory.**
"Is this the real Acme?" needs an authoritative stored list, and this app has none: the invoice travels inside its own link. `[verified in this repository]` — `encodeShare` in `app/ts/invoice/share.ts` puts the whole invoice in the URL fragment.
- **ENS or DNS lookups.**
A lookup is a network query, forbidden by `connect-src 'none'` and the network sweep, and it would leak which payee is about to be paid. `[verified in this repository]` — `app/index.html`, and the network sweep in `tests/slow/acceptance.test.mjs`.
- **Confirmation from the payee.**
Asking "did you send this?" needs a channel, and the app has none it may use. `[verified in this repository]` — the same `connect-src 'none'` policy.

### The Residual Risk, Stated Plainly

An attacker who controls the link controls every pixel the payer sees. `[verified in this repository]` — the document is built from the fragment the visitor opened (`decodeShare` in `app/ts/invoice/share.ts`).
Nothing inside a tampered invoice can prove the payee's identity, because by the time it renders the invoice is the attacker's document, and no field in it is signed or authenticated. `[verified in this repository]` — `app/ts/invoice/codec.ts` serializes and decodes the invoice as plain JSON with no key, digest, or message authentication code.
No option above changes that; they change only how likely a payer is to notice a substituted address in a document they already trust. `[unverified]` — a summary of the options' scope, not a measurement.

## 2. A Privacy-Preserving Double-Payment Guard

### What the Guard Does Today

The guard exists and is deliberately memory-only, so it protects one page session: a reload or a second tab is an ordinary action that defeats it. `[verified in this repository]` — the record of attempted payments in `app/ts/ui/pay.ts` is a module-scope map, and its comment states that the record lives only in memory so a genuine reload starts over.

- The latch that records a send attempt in `app/ts/ui/pay-flow.ts` is set inside the send callback the instant a transaction is handed to the wallet, and cleared only for a wallet rejection of the transaction. `[verified in this repository]`
- A per-invoice map refuses reopening the panel for an invoice already attempted here, through its own lookup of the invoice's key. `[verified in this repository]` — the attempted-payment record and `claimPayment` in `app/ts/ui/pay.ts`.
- The refusal says reloading is the only way to start over. `[verified in this repository]` — the reopen message in `app/ts/ui/pay.ts`, and the send-claimed-elsewhere message in `app/ts/ui/pay-flow.ts`.
- A reload or a second tab wipes the guard, because nothing is written. `[verified in this repository]` — the comment on the attempted-payment record in `app/ts/ui/pay.ts`.
- The app cannot confirm anything on chain: `connect-src 'none'`, and the network sweep in `tests/slow/acceptance.test.mjs`. `[verified in this repository]`
- No runtime file names a storage or side-channel API, which the storage sweep in `tests/slow/acceptance.test.mjs` enforces. `[verified in this repository]`

### The Options

**Option 2A — memory plus a channel between tabs only.**
A `BroadcastChannel` would tell other open tabs that an invoice was claimed, and the record would survive neither a reload nor the case that matters most: a payer who reloads because the wallet was unclear, then pays again.
The storage sweep does not name `BroadcastChannel`, so using it would pass the gate silently; the entry must be written deliberately. `[verified in this repository]` — the storage sweep's own list in `tests/slow/acceptance.test.mjs` names only `localStorage`, `sessionStorage`, `indexedDB`, `history`, `window.name`, `document.cookie`.
Estimated effort: about a day `(estimate)`.

**Option 2B — one opaque salted hash record in local storage, plus a cross-tab notification.**
One string per invoice would survive a reload, a second tab, a browser restart, and back-and-forward navigation.
Estimated effort: two to three days `(estimate)`, plus a gate change and README rewording.

**Option 2C — a fuller record.**
Per-invoice entries with timestamp, status, and optionally payee name and amount: a payment history in everything but name. `[unverified]` — an argument from the fields it would hold, not a measurement.
Estimated effort: four to six days `(estimate)`.

### Recommendation

Option 2B is the recommendation; Options 2A and 2C are not adopted, because 2A would survive neither a reload nor the payer who reloads because the wallet was unclear and then pays again, and 2C is a payment history in everything but name. `[unverified]` — the arguments each option states above.
What follows is exactly what Option 2B would store: the record it would add, not a description of the app — today the attempted payments live only in memory, and none of this storage exists. `[verified in this repository]` — `app/ts/ui/pay.ts`.

Store, under one storage key, one line per attempted invoice:

```
<version>:<hex digest>
```

The digest would be SHA-256 over a fixed application salt concatenated with the invoice's canonical serialization, which the guard already uses as its key. `[verified in this repository]` — the key helper in `app/ts/ui/pay.ts` returns that serialization.
No new dependency would be needed: `app/ts/util/encoding.ts` already re-exports `sha256`, `utf8ToBytes`, and `toHex`. `[verified in this repository]`

Deliberately not stored: address, amount, payee name, invoice text, invoice id, and any timestamp that identifies a person.
The record would hold a version and an opaque digest, so it could not be turned into "who was paid, how much, when", and it would not be a list of invoices.

The salt would be a constant compiled into the app rather than a value chosen per page load, which is why the guard would work across tabs: two tabs derive the same digest for the same invoice, whereas a per-page salt would break the guard after a reload.

The record would therefore hide which invoice was attempted from anyone scanning the browser's storage, and hide nothing from anyone who holds the link, since they can compute the same digest. `[unverified]` — an argument about what a salted digest can hide, not a measurement.

Retention: keep a small fixed number of records, newest kept, oldest dropped, and give the payer a Forget control that clears this browser's record for the invoice.

The Forget control cannot sit in the payment panel or in the refusal notice. `[verified in this repository]` — the refusal path builds no panel: `openPayPanel` reports the refusal through the notice region and builds no panel in `app/ts/ui/pay.ts`, the notice region is one text paragraph with no controls (`showNotice` in `app/ts/app/shell.ts`), and the notice interface offers only showing and clearing a notice (`app/ts/ui/notice.ts`).

The affordance would therefore sit in the payer's document actions — the region `documentActions` builds beside Pay and Save as PDF (`app/ts/ui/view.ts`) — shown only when this browser holds a record for the invoice, and the refusal's wording would name it there.

A later payer of the same invoice on a shared browser would be refused although they never attempted it: the refusal tests only whether the invoice's key is already claimed, not who claimed it. `[verified in this repository]` — the refusal is a lookup of the invoice's key in the attempted-payment record in `app/ts/ui/pay.ts`.
Forget clears that, but they must be told about it where they are refused.

The record would also reveal that somebody tried to pay this invoice, and the record cap plus Forget would be the only mitigation available without a server. `[unverified]` — no server-side state is available to bound it further.

### The Wording After an Unclear Wallet Result

The screen treats an unclear wallet result as "it may already be sent", so it does not offer a fresh start as if nothing happened. `[verified in this repository]` — the `send-failed` frame offers a send-only "Try sending again" and an "I already sent it" exit rather than the whole-flow retry (`app/ts/ui/pay.ts`, and `afterSendFailureMessage` in `app/ts/ui/pay-flow.ts`).

Primary button: unchanged at `Try sending again`, which is already the safe retry, repeating only the send rather than discovery, connection, or the funds check. `[verified in this repository]` — `app/ts/ui/pay.ts` binds that button to the flow's send-only retry, and the flow's own resend step in `app/ts/ui/pay-flow.ts` re-sends only.

Replacement for "reloading the page is the only way to start over", in both messages:

- "A payment for this invoice was already attempted from this browser. Check your wallet's activity before trying again. To start over in this browser, use Forget this invoice's payment attempt beside the Pay button."
- "Another payment for this invoice is already under way from this page, so this one was not sent. Check your wallet's activity before trying again. To start over in this browser, use Forget this invoice's payment attempt beside the Pay button."

Caution line with the ambiguous result: "Your wallet did not confirm the transaction. It may still have been sent, so check your wallet's activity before trying again."

No wording may imply that forgetting undoes a payment: the label says "attempt", and the caution line stays the only statement about what was broadcast.

### What Must Change Together

Adopting this guard changes what the app promises about privacy as well as what it does, so the app's claims, the checks that enforce them, and the tests that pin them all have to move in one step that the maintainer signs off.

- "No cookies, no tracking, and no analytics" in `README.md`'s "Privacy over features" must say what the browser keeps: one anonymous marker per attempted invoice, with a Forget control in the invoice's document actions. `[verified in this repository]`
- "The app keeps no list of the invoices you made" in `README.md`'s "Privacy over features" stays true only if that section also says the marker is a digest rather than an invoice. `[verified in this repository]`
- The no-storage note on the attempted-payment record in `app/ts/ui/pay.ts` ("The record lives only in memory…") becomes false and must describe the digest, its retention, and Forget. `[verified in this repository]`
- The hard gate: the storage sweep in `tests/slow/acceptance.test.mjs` and its two assertions — the runtime one in "no served runtime module can build markup, evaluate code, or reach the network" and the vendored one — forbid any storage API in every runtime file and in every vendored bundle. `[verified in this repository]`
  The change must be a content-specific exemption of the kind the sweeps already use, as its exemptions for the sanctioned element builder and the sanctioned SVG namespace are: a named module plus an exact statement, not a looser pattern.
- The runtime blocker: the harness the app's own suites load under stubs every storage and side-channel sink the app could reach — `localStorage`, `sessionStorage`, `indexedDB`, `history`, `window.name`, and `document.cookie` — and each stub records the call and throws. `[verified in this repository]` — the stubs in `tests/helpers/network-block.mjs`, and "the runtime blocker records the storage and side-channel sinks the runtime sweep relies on" in `tests/security.test.mjs`.
  The slow gates load the page and every vendored module under the same stubs. `[verified in this repository]` — `tests/helpers/vendor-network-smoke.mjs`, spawned by "the page entry and vendored modules load with every network API blocked" in `tests/slow/vendor.test.mjs`.
  A storage-backed guard therefore cannot even be loaded under those runs — the first `setItem` throws — so the design must also state what the guard does when storage is unavailable, and the suites must be able to inject a storage double for the one module that uses it.
- The wording tests need no change: the replacement reopen wording above keeps the phrase `already attempted` in its first sentence, so each matcher on that phrase still matches — the three in `tests/pay-flow.test.mjs`, inside the "dismissing the panel with … while a send is in flight still latches the payment" tests, and the two in `tests/wallet.test.mjs`, inside "a panel reopened for the same invoice refuses a second payment" and "navigating away and back to the same invoice cannot re-arm the payment latch". `[verified in this repository]`
  The test "the send attempt is surfaced the instant the transaction leaves for the wallet" in `tests/pay-flow.test.mjs` asserts the send-attempt callback and no wording.
  The send-claimed-elsewhere message is asserted nowhere: no test names its phrase "already under way", so replacing that message changes no assertion either. `[verified in this repository]`

The maintainer has to sign the storage decision explicitly: the storage sweep exists because no-storage was a hard rule, and a rule widened quietly is worse than one narrowed in a named place.

### What a Device-Side Guard Cannot Do

A guard on the payer's device cannot stop a determined double payment: another browser, a private window, cleared site data, or a second device never consults the record, because the record lives in one browser's storage and nowhere else. `[unverified]` — a consequence of the design, not a measurement.
The chain is the only authority, and this app cannot ask it, because `connect-src 'none'` means it reaches no node and the wallet's own report is all it sees. `[verified in this repository]` — `app/index.html`'s policy and the network sweep.
The guard's job is the ordinary accident, and the wording should say so.

## 3. Blockies as Decoration Only

### The Options

- Original `ethereum/blockies`: archived, last push March 2022, no licence file and no licence grant, so it cannot be vendored, because this project redistributes what it vendors. `[reported from an external source]` — the repository's own archive notice and file listing.
- `@metamask/jazzicon`: CommonJS only, roughly 4 to 5 kB, unreleased since 2020, and its common address adapter uses only the first 8 hex characters as an integer seed. `[reported from an external source]` — the package's listing and source.
- `blo` 2.1.1: MIT, zero dependencies, pure ESM, about 0.7 kB gzipped, actively maintained, produces the blockies look MetaMask and Etherscan users recognise, and lowercases the seed. `[reported from an external source]` — the package's listing and source.
- `minidenticons`: MIT, smaller than `blo` but unrecognisable to anyone who has not seen it. `[reported from an external source]` — the package's listing.
- Hand-rolled: no smaller than `minidenticons` `[reported from an external source]` — the package's listing, set beside this memo's own reading of the drawing code.
  It also becomes code this project owns and tests `[unverified]` — the consequence of writing it here, not a measurement.
Estimated effort: about 30 lines `(estimate)`, for the hand-rolled option.

### What the Family Computes

It runs an xorshift over character codes rather than a cryptographic hash, and builds a mirrored grid of cells. `[reported from an external source]` — the `blo` source.
Any address string works as a seed, so there is nothing to validate. `[reported from an external source]` — the same source.
Case folding matters, though, because the EIP-55 mixed-case and lowercase spellings of one address must map to the same avatar, which is what `blo`'s lowercasing gives. `[reported from an external source]` — the same source.
The invoice path stores and displays the checksummed spelling. `[verified in this repository]` — `requireInvoiceAddress` in `app/ts/wallet/address.ts`.
Canvas-based libraries are said to cost far more per avatar than a pure SVG builder, and avatar collisions are essentially unmeasured. `[unverified]` — no source was confirmed for either claim; a rendering-cost figure would need a browser and a stopwatch, and a collision figure would need a birthday trial over the candidate's own seeds.

### What It Would Take in This Repository

Adding an avatar library here is mostly paperwork: one file to copy into the project, plus the records that track where it came from, what licence it carries, and how the tests find it.

There is no bundler, so that file would be vendored the way the three existing packages are. `[verified in this repository]` — a copied file under `vendor-src/blo/` and a re-blessed `vendor-src/SHA256SUMS` from `bun run vendor -- --add-new`; a pin entry in `scripts/vendor-pins.mjs` and a source entry in `scripts/fetch-vendor.mjs`, plus a hand-written-file entry if a `.d.ts` shim is hand-written as the current three need; a licence block in `vendor-src/THIRD-PARTY-NOTICES`; `package.json` and `bun.lock`; a new runtime module importing `../../js/vendor/blo/…` as `app/ts/util/encoding.ts` does, with call sites in `app/ts/ui/pay.ts` and `app/ts/ui/payment-section.ts` and sizing rules in `app/stylesheets/invoice.css` and `app/stylesheets/app.css`.

Estimated effort: nothing `(estimate)`, for the data-URL shape of `blo`'s output, which is a piece of the work the section's closing figure covers rather than a figure of its own.
The app's single image sink accepts only an SVG data URL with the exact `data:image/svg+xml;base64,` prefix and a bounded base64 payload, and `h()` refuses anything else. `[verified in this repository]` — the attribute check in `app/ts/util/dom.ts`, and the data-URL check in `app/ts/util/data-url.ts`.

`blo` 2.1.1 builds exactly that shape: its `dist/esm/index.js` spells `"data:image/svg+xml;base64," + btoa(bloSvg(address, size))`, which is the same prefix the app's own data-URL helper states (`app/ts/util/data-url.ts`). `[reported from an external source]` — `blo@2.1.1`, `dist/esm/index.js`, read from the published package and not rechecked here.

So no re-encode and no new sanctioned sink are needed for the data-URL shape, and the image gate stays as it is. `[unverified]` — this memo's comparison of that file's prefix against the data-URL prefix `app/ts/util/data-url.ts` declares and the sink `h()` enforces in `app/ts/util/dom.ts`.

What remains open is the payload bound the sink enforces: the base64 payload may decode to at most 8,192 bytes, and its length is capped before it is ever copied. `[verified in this repository]` — the icon byte cap in `app/ts/util/icon-capacity.ts` and the payload length cap in `app/ts/util/data-url.ts`.
Whether a blockies SVG stays inside that bound is unmeasured here, because `blo` is not vendored in this repository. `[unverified]`

Branding and asset size remain open too: an avatar is not the app's brand, and the vendored file plus its shim is a new asset this project carries and has to keep pinned. `[unverified]`

Tests needed: the vendored sweeps pick the new file up automatically, since they derive their list from the vendor source list, and a shim's exports are checked against the bundle beside it by "every name a hand-written shim declares is an export of the vendored bundle beside it". `[verified in this repository]` — the list `tests/helpers/vendor-bundles.mjs` derives from the vendor source list, and the test of that name in `tests/slow/vendor.test.mjs`, beside "every vendored bundle is self-contained and free of network APIs" and "the page entry and vendored modules load with every network API blocked".
New unit tests cover the seed fold, empty alternative text, the avatar never being the only identifier, and that a payload past the bound is refused.

Estimated effort: two to four days `(estimate)` for adding the avatar here — the vendored file with its pin and licence records, the module and its shim, and the tests — dominated by the vendoring ceremony rather than the drawing code, and with the data-URL shape above adding nothing to it.

### Recommendation

Do not ship blockies as a safety measure.
They help a payer who already knows the payee's avatar. `[unverified]` — a judgement about what a glance buys, not a measurement.
They do not defend against a phishing invoice, because that invoice carries the attacker's address and therefore the attacker's matching avatar: the avatar agrees with the string. `[unverified]` — an argument from what the avatar would be built from, the invoice's own address, which is whatever the fragment decodes to (`decodeShare` in `app/ts/invoice/share.ts`), as Option 1F states; no avatar is drawn in this repository.
An avatar used as an identifier also fails every payer with low vision or colour-vision deficiency, and every payer who has never seen the avatar before. `[unverified]` — a judgement about who can read an avatar, not a measurement.
As decoration, ship `blo` 2.1.1 at the effort stated above, starting with the payload-bound check rather than with a gate decision.

## 4. The Address Book After the Last-Paid Memory

### The Shape the Record Would Take, and What It Collides With

The app would store, per payee, an association between a payee identity and an address, compare it at pay time, and warn when they disagree.
It needs Section 2's storage mechanism, and a payee identity that survives across invoices.
The payee record an invoice carries holds a name, the payout address, and optional free-text contact and notes, so the address is present but cannot be the identity: it is the value the comparison exists to check. `[verified in this repository]` — `Payee` in `app/ts/invoice/model.ts`.
That leaves the typed name as the only stable handle, and it is attacker-controlled free text, where a lookalike name creates a false alarm and a loose rule lets a lookalike overwrite the saved address. `[verified in this repository]` — `Payee.name` and `Payee.email` are the free-text fields, bounded and validated for display but carrying no authority (`app/ts/invoice/model.ts`).

The collision is with `README.md`'s "Privacy over features", which says the app keeps no list of invoices because saved history would show who paid whom and how much. `[verified in this repository]`
An address book is not a list of invoices, but it is a list of who this device pays: the same harm in a smaller package. `[unverified]` — an argument from what the record it needs would hold, exactly the payee name and address those sentences promise the app does not keep.

### What Must Change Together

The same set as Section 2: the code, `README.md`'s "Privacy over features", the storage sweep in `tests/slow/acceptance.test.mjs` with its two assertions, the runtime blocker described in Section 2, and the no-storage sentence on the attempted-payment record in `app/ts/ui/pay.ts`. `[verified in this repository]`

If both features land they share one storage decision and one named sweep exemption, but they are two records: Section 2's opaque digest, and a separate payee-to-address record that is readable. `[verified in this repository]` — Section 2's record is a version and a digest over the invoice's canonical text (the key helper in `app/ts/ui/pay.ts`), so no payee field is readable from it.

The price of the second record is that it becomes the readable list this section warns about: it would hold the payee name beside the address, which is what `README.md`'s "Privacy over features" rules out keeping. `[unverified]` — an argument from the fields the record would hold, set against the sentences in `README.md`'s "Privacy over features".
Both records would sit under one retention policy and one Forget control.

### The Labelling Question

The label cannot be the typed name alone. `[unverified]` — an argument from the free-text field, not a measurement.
The workable shape: save under the normalised payee name, show the saved address's first and last few characters beside the label, and let the payer rename or delete an entry.
Renaming matters, because "Acme Ltd" and "Acme Limited" are not a mismatch worth shouting about. `[unverified]` — a judgement about names, not a measurement.

### The Shared-Device Risk

On a shared browser an address book is a list of the people the previous user pays, with readable labels, worse than Section 2's opaque marker. `[unverified]` — an argument against a design that stores payee names beside addresses, not a measurement.
Without a server the only mitigations are visible Forget controls and a first-use explanation; a shared browser cannot be made safe for this, only made obviously the payer's choice.

### Recommendation

The payoff is one warning, and it is the most useful this app could show: "This address is not the one saved for this payee."
It addresses the misuse the poisoning study measures because the app compares, not the person; no measurement of that effect exists. `[unverified]`
Do not build the address book alone.
Build it as the second step of Section 1, on the same storage decision, after the last-paid memory has been in use and the identity rule tested against real names.
Estimated effort: five to eight days `(estimate)`, for Section 1's last-paid memory and this record together.

## 5. A Plain-Language Note on Address Lengths

Address lengths look arbitrary and are not: each of these four is a fixed amount of address data spelled in an alphabet that ends in a checksum, so one mistyped character is caught before anything is paid, and the only thing that varies is how many characters the spelling takes. `[verified in this repository]` — the four decoders named below, each of which bounds a paste's length before it decodes it.

- A Zcash transparent address (`t1…` or `t3…`) is 35 characters: 26 bytes of address data — a 2-byte version marker, a 20-byte hash, and a 4-byte checksum — spelled in Base58Check, the older Bitcoin-style alphabet, which needs no more than 36 characters for that data, so a longer paste is refused before it is decoded (the length bound in `app/ts/wallet/zcash-address.ts`).
- A Zcash Sapling address (`zs1…`) is 78 characters: 43 bytes of key data — the diversifier and the payment key the address is built from — spelled in Bech32, the newer alphabet Zcash shares with Bitcoin, which carries a six-character checksum and spends more characters on the same bytes than the older one does (the data size in the same file).
- A Zcash unified address (`u1…`) runs to 311 characters — the widest-address bound in `app/ts/payment/schemes.ts`, derived as the widest symbol the app draws, less what a `zcash:` link spends besides the address, less a margin of 8 bytes.
- A Monero address is 95 characters, or 106 for an integrated one (the form table in `app/ts/wallet/monero-address.ts`).

A unified address is long because one string has to hold a list of the recipient's addresses — one for each form of address the recipient can receive — so a sender can pay whichever form that recipient supports. `[verified in this repository]` — the container-as-item-list grammar in `app/ts/wallet/zcash-address.ts`, and the 311-character bound in `app/ts/payment/schemes.ts`; the validator checks only that the container's data is long enough to be such a list, and never reads the addresses inside it.
That is normal, not a defect, and it is why the screen ladder and the print ladder exist. `[verified in this repository]` — the two ladders `FIT_RUNGS` publishes in `app/ts/ui/fit-value.ts`, one for the screen and one for print.

## 6. The Accepted Framing Risk

Framing is permitted on purpose, and the permission accepts a framing page overlaying the controls it frames. `[accepted risk]` — recorded in `README.md`'s "Security over features" and in this memo.
That decision puts framing protection out of scope, and it shows in what the app does not send: the dev server sets no `frame-ancestors` directive and sends no `X-Frame-Options` header, and the meta-delivered policy cannot carry `frame-ancestors` anyway. `[verified in this repository]` — `serve.mjs`, `app/index.html`.
The permission serves a use case rather than leaving a gap the app could close: a wallet host shows the invoice inside its own frame, so a page that refused to be framed could not be read in the wallet the payer pays from. `[verified in this repository]` — the reason stated in the `serveFile` comment in `serve.mjs`, the policy comment in `app/index.html`, the module doc of `app/ts/ui/pay.ts`, and the framing bullet in `README.md`'s "Security over features".
The decision rests on `README.md`'s requirement, under "Open the app", that the app's website be one whose pages are trusted with the invoice: the invoice travels in the part of the link after the `#`, so any other page on the same website as the app would be trusted with it, and `README.md` says plainly that a shared gateway gives the app an address of its own but not a website of its own, leaving that trust with the gateway's operator. `[verified in this repository]` — those sentences in `README.md`, and `openerRefusal` in `app/ts/ui/pay.ts`, whose doc names the requirement as the load-bearing control.
Two controls remain unchanged: no wallet is touched until the payer's own click on Connect wallet & pay, and the per-invoice claim still lets only one flow send a given invoice. `[verified in this repository]` — `openPayPanel` and `claimPayment` in `app/ts/ui/pay.ts`.
The payment panel also refuses a window it finds opened by another page, and that refusal is not a framing control. `[verified in this repository]` — `openerRefusal` in `app/ts/ui/pay.ts` refuses the panel when `window.opener` is neither `undefined` nor `null`, whatever page that opener names, so every opener is refused; an opener served from the same website is the case that matters, because it can drive the controls the refusal keeps from it, while an opener served from another website can neither read the fragment nor reach those controls.
Its own doc states that this property is an ordinary one another page can replace, so the refusal is best-effort coverage of a script-opened window rather than a control an adversarial page is bound by. `[verified in this repository]` — the same `openerRefusal` doc in `app/ts/ui/pay.ts`.
Against a page that frames the app it covers nothing: a host page frames the app rather than opening it, so there is no opening page for the check to find, and the code treats a window that another page did not open as unopened. `[verified in this repository]` — the same `openerRefusal`, whose doc counts a direct navigation and a window that no page opened as unopened.
`README.md`'s "Security over features" states the refusal at that same strength, beside the framing permission, and does not present it as a framing control. `[verified in this repository]`
What a page that frames the app can do is overlay the controls it frames, which `README.md`'s "Security over features" states beside the framing permission. `[verified in this repository]` — the framing bullet in `README.md`.
What a page that opened the app can do is drive the controls, but only while that page and the one it opened are served from the same website. `[verified in this repository]` — the opener-refusal bullet in `README.md`, and the module doc in `app/ts/ui/pay.ts`.

## 7. The Label Audit

Every claim in this memo carries one of the four labels above, and this audit applies that rule to each section by hand.
No automated check performs the reading. `[verified in this repository]` — the style gate in `tests/style.test.mjs` holds the memo's lines to `.editorconfig` and checks none of its labels.
The rule applied is the preamble's: a proposal, a recommendation, an effort figure, or a stated preference carries no label, and every other sentence carries one, taking `[unverified]` where that label marks an argument.
The glossary's entries define the memo's own terms and carry no label, as the preamble's four label definitions carry none.
The table below records the claims the audit acts on, part by part: every row names the part it covers, then lists each claim it covers under the label that claim carries, naming the source where that label names one.
It groups a row's claims under their labels rather than restating each claim's wording, so a reader checking one sentence's label finds the claim's group here and reads the sentence itself in its section.
A row whose part also holds sentences that carry no label names the class each of those belongs to, so the audit states what it read rather than only what it labelled.

| Part | Claims | Label and source |
| --- | --- | --- |
| Preamble | The four label definitions; the rule that a proposal, a recommendation, an effort figure, or a stated preference carries no label while a sentence asserting a fact about this repository, a study, a package, or the world does; the rule on a judgement offered as a preference and on a judgement the memo argues for; the rule on where a label sits in its sentence; the rule that a list's label covers its items; the rule that an effort figure is an estimate marked as one; the memo's statement of what its own work exercised | No label on the four definitions or on the rules, which are about this memo's labelling rather than about this repository, a study, a package, or the world, and a label on them would be the memo labelling its own labelling; `[unverified]` — the statement that no wallet was exercised and no payer was tested, which nothing in this repository records, with its argument beside it |
| Section 1, "What the App Shows Today" and "What the Evidence Shows" | The mechanism of the ladder and of its search; the purpose of the screen floor; the studies' rates, counts, and participant figures; the absence of a study on an avatar's effect; the instruction the options are judged against; the closing "an avatar therefore helps only where a comparison already happens"; the commentary on the abbreviation and the vendor's concession | `[verified in this repository]` — the mechanism of the ladder and of its search, and the purpose of the screen floor, each with the file or the doc comment that states it named; `[reported from an external source]` — the studies' rates, counts, and participant figures, each cited; `[unverified]` — the absence of a study on an avatar's effect, the instruction the options are judged against, the closing judgement, and the commentary on the abbreviation and the vendor's concession, each with its argument or its recorded absence beside it |
| Section 1, "The Options" | The copy, the print twin, and the focus stop that the grouping and the emphasis options would collide with; the resting status sentence Option 1D points at; the page's own lack of a network; the schemes the QR encodes; the chunk-size result; the substitution rates an instruction cannot beat; the abbreviation the poisoning study targets; what an avatar's glance buys; why an avatar fails against a phishing invoice; the absence of a study on an avatar's effect; whether a wallet scans an `ethereum:` URI | `[verified in this repository]` — the copy, the print twin, and the focus stop, from `paymentValue` in `app/ts/ui/payment-section.ts` and the pinned presentation test in `tests/view.test.mjs`; the resting status message, from `app/ts/ui/pay.ts`; the no-network policy and its network sweep; the schemes, from `app/ts/payment/scheme-prefixes.ts`, `buildPaymentLink` in `app/ts/payment/links.ts`, and `paymentQr` in `app/ts/ui/presentation.ts`; `[reported from an external source]` — the chunk-size result and the substitution rates, cited to Dechand et al., and the abbreviation the poisoning study targets, cited to Tsuchiya et al.; `[unverified]` — what an avatar's glance buys, why it fails against a phishing invoice, and whether a wallet scans an `ethereum:` URI, each with its argument or its recorded absence beside it; an option's own statement of what it would cost, need, or buy is a proposal and carries no label, as does each `Estimated effort:` line |
| Section 1, "Recommendation" | The regression risk Options 1B and 1C carry against the copy, the print twin, and the focus stop; the grouping study's result; that the display change this memo describes is the fitting the app already performs, and that the two changes it rejects are Options 1B and 1C; the parts of the recommendation already in place | `[verified in this repository]` — the fitting in `app/ts/ui/fit-value.ts`, the ready-state message in `app/ts/ui/pay.ts`, and `qrBlock` in `app/ts/ui/payment-section.ts`; `[reported from an external source]` — the grouping study's result, cited to Dechand et al.; `[unverified]` — the argument that only Option 1A changes the payer's task from memory to difference, with its argument beside it; each sentence that adopts or rejects an option is a recommendation and carries no label |
| Section 1, "What Cannot Be Done Without a Server" | A payee directory needs an authoritative stored list this app has none of; an ENS or DNS lookup would be a network query that also leaks which payee is about to be paid; a confirmation from the payee needs a channel the app may not use | `[verified in this repository]` — the invoice that travels inside its own link, from `encodeShare` in `app/ts/invoice/share.ts`, and `connect-src 'none'` with its network sweep, in `app/index.html` and `tests/slow/acceptance.test.mjs`, cited by the bullet it settles |
| Section 1, "The Residual Risk, Stated Plainly" | An attacker who controls the link controls every pixel the payer sees; nothing in a tampered invoice proves the payee's identity; no option above changes that | `[verified in this repository]` — the document built from the fragment, from `decodeShare` in `app/ts/invoice/share.ts`, and the unsigned plain-JSON codec, from `app/ts/invoice/codec.ts`; `[unverified]` — the summary of the options' scope, with its argument beside it |
| Section 2, "What the Guard Does Today" | The guard is memory-only and protects one page session; the latch is set as the transaction is handed to the wallet and cleared only for a wallet rejection; a per-invoice map refuses a reopen; the refusal says reloading is the only way to start over; a reload or a second tab wipes the guard; the app cannot confirm anything on chain; no runtime file names a storage or side-channel API | `[verified in this repository]` — the module-scope record and its comment, `claimPayment`, and the reopen message in `app/ts/ui/pay.ts`; the latch and the send-claimed-elsewhere message in `app/ts/ui/pay-flow.ts`; the network sweep and the storage sweep in `tests/slow/acceptance.test.mjs`, each named by the bullet it settles |
| Section 2, "The Options" | That the storage sweep does not name `BroadcastChannel`, so using it would pass the gate silently; that a fuller record would be a payment history in everything but name | `[verified in this repository]` — the sweep's own list of storage and side-channel names in `tests/slow/acceptance.test.mjs`; `[unverified]` — the fuller-record judgement, argued from the fields it would hold; an option's own statement of what it would survive, store, or add is a proposal and carries no label, as does each `Estimated effort:` line |
| Section 2, "Recommendation" | The arguments that rule Options 2A and 2C out; that the record's key is the invoice's canonical serialization; that `app/ts/util/encoding.ts` already re-exports the hashing helpers; what the record would hide, and from whom; that the Forget control cannot sit in the panel or in the refusal notice; that a later payer of the same invoice on a shared browser would be refused; that the record still reveals somebody attempted the invoice | `[unverified]` — the arguments for and against the options, and what the digest hides and from whom, each with its argument stated as an argument; `[verified in this repository]` — the key helper, `openPayPanel`, the notice region `showNotice` builds in `app/ts/app/shell.ts`, the notice interface in `app/ts/ui/notice.ts`, the key lookup that refuses a reopened panel, and `documentActions` in `app/ts/ui/view.ts`; the record's own design — the version line, the fixed salt, the retention cap, the Forget label, and where it would sit — is a proposal and carries no label; each `Estimated effort:` line is an estimate |
| Section 2, "The Wording After an Unclear Wallet Result" | That the `send-failed` frame offers a send-only "Try sending again" and an "I already sent it" exit rather than the whole-flow retry; that the primary button binds the send-only retry and the flow's resend step re-sends only | `[verified in this repository]` — the `send-failed` frame in `app/ts/ui/pay.ts`, `afterSendFailureMessage` and the resend step in `app/ts/ui/pay-flow.ts`, and the retry the primary button binds; the replacement messages, the unchanged primary label, and the caution line are proposals and carry no label |
| Section 2, "What Must Change Together" | That `README.md`'s "Privacy over features" has to say what the browser keeps, and that one of its sentences stays true only if the marker is a digest; that the no-storage note on the attempted-payment record becomes false; that the storage sweep and its two assertions forbid any storage API; that the runtime blocker stubs every storage and side-channel sink and throws; that a storage-backed guard cannot load under those runs; that the wording tests need no change, and that the send-claimed-elsewhere message is asserted nowhere | `[verified in this repository]` — each of those, with `README.md`, `app/ts/ui/pay.ts`, `tests/slow/acceptance.test.mjs`, `tests/helpers/network-block.mjs`, `tests/security.test.mjs`, `tests/helpers/vendor-network-smoke.mjs`, `tests/slow/vendor.test.mjs`, `tests/pay-flow.test.mjs`, and `tests/wallet.test.mjs` named as the place it was read; that the maintainer has to sign the storage decision is a recommendation and carries no label |
| Section 2, "What a Device-Side Guard Cannot Do" | Another browser, a private window, cleared site data, or a second device never consults the record; the chain is the only authority, and the app cannot ask it | `[unverified]` — the first, as a consequence of the design rather than a measurement, with its argument beside it; `[verified in this repository]` — the second, from `app/index.html`'s policy and the network sweep; the closing sentence on what the guard's job is, and on what the wording should say, is a recommendation and carries no label |
| Section 3, "The Options", "What the Family Computes", and "What It Would Take in This Repository" | The candidates' licences, sizes, maintenance, and seeding; the family's algorithm, seed handling, and case folding; the vendoring path, the data-URL shape, and the payload bound | `[reported from an external source]` — the candidates' licences, sizes, maintenance, and seeding, the family's algorithm, seed handling, and case folding, and `blo`'s data-URL prefix, each with its listing or source named; `[verified in this repository]` — the vendoring path, the payload bound, and the length cap on it, each with the file named; `[unverified]` — the rendering-cost and collision claims, the data-URL shape's fit, and whether a blockies SVG stays inside the bound; each effort figure is stated in an `Estimated effort:` line |
| Section 3, "Recommendation" | What an avatar's glance buys; that it fails against a phishing invoice, which carries the attacker's address and therefore the attacker's matching avatar; that an avatar used as an identifier fails every payer with low vision or colour-vision deficiency, and every payer who has never seen the avatar before | `[unverified]` — each of them, with its argument beside it, including the invoice's own address the avatar would be built from (`decodeShare` in `app/ts/invoice/share.ts`); the sentence on what to ship, and the sentence against shipping blockies as a safety measure, are recommendations and carry no label |
| Section 4, "The Shape the Record Would Take, and What It Collides With" and "What Must Change Together" | The identity claim, the smaller-package judgement, and the shared-record sentence with the price of the second record | `[verified in this repository]` — the identity claim, from the payee fields named, and the shared record's own shape, from the key helper named; `[unverified]` — the smaller-package judgement and the price of the second record, each with its argument beside it |
| Section 4, "The Labelling Question" | That the typed name alone cannot be the label; that two spellings of one payee name are not a mismatch worth shouting about | `[unverified]` — both, as arguments about attacker-controlled free text and about names, not measurements; the shape of an entry — the normalised name, the saved address's first and last few characters beside it, rename and delete — is a proposal and carries no label |
| Section 4, "The Shared-Device Risk" | That on a shared browser an address book is a readable list of the people the previous user pays, worse than Section 2's opaque marker | `[unverified]` — argued from what the record would hold, not measured; the sentence on the only mitigations without a server, and on what a shared browser can and cannot be made, is a recommendation and carries no label |
| Section 4, "Recommendation" | That an address book addresses the misuse the poisoning study measures, because the app compares rather than the person, and that no measurement of that effect exists | `[unverified]` — the claim, with the absence of a measurement recorded beside it; the warning's wording, the judgement that it is the most useful warning this app could show, the order the record is built in, and the effort figure are a recommendation and an estimate, and carry no label |
| Section 5, "A Plain-Language Note on Address Lengths" | Why a unified address is long, and the closing sentence on why the two ladders exist | `[verified in this repository]` — why a unified address is long, with the decoder's own limits named, and the closing sentence on why the two ladders exist, with `FIT_RUNGS` named |
| Section 6, "The Accepted Framing Risk" | The framing the dev server permits and why; the requirement the accepted risk rests on, and what a shared gateway does and does not give; the two controls that remain; what the opener refusal does and does not cover; what a host that frames the page could do | `[accepted risk]` — the maintainer's scope decision, which accepts a framing page overlaying the controls it frames; `[verified in this repository]` — the framing the dev server permits and why, the requirement the accepted risk rests on, the gateway's own limits, the two controls, the opener refusal's scope, and the README's own statement of the overlay risk |
| Section 7, "The Label Audit" | The rule the audit applies, the scope it states for its own table, its record that no claim is left unlabelled, and its statement that no automated check performs the reading | No label on the rule or on the record, which are about this memo's labelling rather than about this repository, a study, a package, or the world, and a label on them would be the audit labelling itself; `[verified in this repository]` — the one claim the section makes about this repository, that no automated check performs the reading, with the style gate named as the check that reads the memo's lines and none of its labels |

Unlabelled claims remaining: none — every sentence the table leaves unlabelled is a proposal, a recommendation, an effort figure, a stated preference, the case an option makes for itself, which the preamble counts as part of the option's proposal, or a sentence about this memo's own labelling, which asserts no fact about this repository, a study, a package, or the world.
