# Payment Safety Design Memo

This memo answers four questions about paying an invoice here: easier address verification, a guard against an accidental double payment, whether blockies avatars are feasible, and whether a local address book is feasible.
Each question ends with one recommendation and its cost.
Nothing here has been implemented, and no code was changed to write it.
Every claim carries one of four labels.

- `[verified in this repository]` — read in this repository's code, configuration, or tests; the file is named.
- `[reported from an external source]` — a study, package listing, or vendor statement, cited and not rechecked here.
- `[unverified]` — asserted or plausible, but neither checked here nor cited.
- `[accepted risk]` — a hazard the owner has chosen to live with, recorded so it is not read as an oversight.

Effort figures are marked `(estimate)`: the author's judgement, not measurements.
No wallet was exercised and no payer was tested for this memo.

## 1. Easier Address Verification

### What the App Shows Today

The invoice shows the payee address in full as one selectable text run with a Copy button, and draws the payment link as a QR symbol. `[verified in this repository]` — `paymentValue` in `app/ts/ui/payment-section.ts` builds one text node, a copy control, and a print-only twin; `renderPaymentSection` adds `qrBlock` of the same link.

A recent change made that display safe: `app/ts/ui/fit-value.ts` keeps each verbatim value on one line at the largest rung of a size ladder that fits, 13px down to a 10px floor, then a stacked phase, then a residual rung with a visible scrollbar; print uses 9, 8, 7, and 6 point before it wraps. `[verified in this repository]`
The floors exist because below them a monospaced address stops separating `0` from `O` and `l` from `1`.
That removed a hazard, since a payer can only check what they see whole, but not the hard part: the payer still compares a long string, and the comparison is where people fail.

### What the Evidence Shows

The baseline to beat is "tell the user to verify the address over a secondary channel". The evidence says that instruction mostly fails.

- No published study measures whether an identicon or avatar reduces address-substitution losses. `[unverified]` — an absence of evidence, not evidence of absence.
- Forced side-by-side comparison still produced undetected attacks: hex 10.44%, Base32 8.50%, PGP words 8.78%, numeric 6.34%, Peerio words 5.75%, sentences 2.99%, over 1,047 participants. `[reported from an external source]` — Dechand et al., USENIX Security 2016.
- Visual fingerprints scored well on accuracy and speed with 436 participants, but the same literature notes fingerprint verification is seldom performed in practice. `[reported from an external source]` — Hsiao et al.
- So graphics help only when a comparison already happens.
- The dominant attack is address poisoning: 270 million attempts, 17.4 million victim addresses, 50.1 million lookalikes, 6,633 successful payoffs, at least $83.8 million lost on Ethereum and BSC between July 2022 and June 2024, roughly 0.01% success, plus 681 typo transfers worth $5.5 million. `[reported from an external source]` — Tsuchiya et al., USENIX Security 2025.
- Their lookalike threshold was at least three matching leading and four matching trailing characters, chosen because that is how interfaces abbreviate addresses on screen. `[reported from an external source]` — same study.
- In June 2026 MetaMask's response to poisoning was detection plus more characters (`0xEdf89FdA047F28…C6341a8ff7ED`), explicitly not avatars, conceding "at a glance, virtually no one catches the difference." `[reported from an external source]` — MetaMask, June 2026.

The last two are the uncomfortable ones: the abbreviation a payer sees is the attack surface, and the largest wallet vendor's conclusion is that the difference is invisible at a glance.

### The Six Options, Ranked

**(a) Remember the last paid address per payee, warning when a new invoice for that payee names a different one.** The only option that removes the comparison burden: the payer answers "this is different from last time" instead of "does this match a string I cannot remember". It needs local storage, so it lands or falls with section 2. Estimated effort: two to four days `(estimate)`.

**(b) Show the address in groups of four.** The separators are not what a wallet takes verbatim: the value is one text node whose copy is byte-for-byte pinned by "the amount, the payee address, and the payment link copy byte for byte, at the widest values a legal invoice carries" in `tests/view.test.mjs`, and grouping lengthens the string, pushing the fitter toward a smaller rung. `[verified in this repository]` No evidence supports the benefit. `[unverified]` Estimated effort: one to two days `(estimate)`; not worth doing alone.

**(c) Emphasise the first and last characters while keeping the whole string.** Emphasis needs per-character markup, turning one text node into many and colliding with the same copy, print twin, and focus stop (`tests/view.test.mjs`'s "a printed payment value is the whole value, sized by its length and wrapped only past the floor" and its "a verbatim payment value is a named focus stop with its own ring, and the residual rung is the visible cue that it scrolls"). Estimated effort: one to two days `(estimate)`; not recommended.

**(d) Tell the payer to confirm the recipient in the wallet's own confirmation screen at signature time.** The wallet's window is a trusted display rather than a second channel: the attacker does not render it, and it shows the address the transaction will pay. The panel's resting status already names that screen, so this is prominence, not new machinery. `[verified in this repository]` Estimated effort: half a day `(estimate)`.

**(e) Pay by scanning the QR instead of copying the string.** Scanning removes the clipboard as a substitution surface, so malware that rewrites a copied address has nothing to rewrite. The symbol encodes the app's own `ethereum:`, `zcash:`, or `monero:` link (`paymentQr` in `app/ts/ui/presentation.ts`). `[verified in this repository]` Whether a wallet scans an `ethereum:` URI correctly is outside this repository. `[unverified]` Estimated effort: under a day `(estimate)`.

**(f) Identicons as a weak recognition aid.** An identicon gives a payer who already knows the payee's avatar a fast "not the usual picture" signal, cheaply, and does not defend against a phishing invoice, which carries the attacker's address and therefore the attacker's matching avatar. Decoration only, never the sole identifier (section 3). Estimated effort: two to five days `(estimate)`.

### Recommendation

Adopt (a) with section 2's storage decision, and adopt (d) and (e) now as wording and guidance.
Do not spend effort on (b) or (c): they carry regression risk against the display work just finished, and no study supports them. Treat (f) as decoration.
Only (a) changes the payer's task from memory to difference.

### What Cannot Be Done Without a Server

- **A payee directory.** "Is this the real Acme?" needs an authoritative stored list, and the invoice travels inside its own link.
- **ENS or DNS lookups.** A lookup is a network query, forbidden by `connect-src 'none'` and the sweep `[verified in this repository]` (`app/index.html`, and the `NETWORK_APIS` sweep in `tests/slow/acceptance.test.mjs`), and it would leak which payee is about to be paid.
- **Confirmation from the payee.** Asking "did you send this?" needs a channel, and the app has none.

### The Residual Risk, Stated Plainly

An attacker who controls the link controls every pixel the payer sees.
Nothing inside a tampered invoice can prove the payee's identity, because by the time it renders, the invoice is the attacker's document.
No option above changes that; they change only how likely a payer is to notice a substituted address in a document they already trust.

## 2. A Privacy-Preserving Double-Payment Guard

### What the Guard Does Today

The guard exists and is deliberately memory-only, so it protects one page session: a reload or a second tab is an ordinary action that defeats it.

- The `sendAttempted` latch in `app/ts/ui/pay-flow.ts` is set the instant a transaction is handed to the wallet, and cleared only on an explicit decline. `[verified in this repository]`
- A per-invoice map refuses reopening the panel for an invoice already attempted here (the `attemptedPayments` map and `claimPayment` in `app/ts/ui/pay.ts`). `[verified in this repository]`
- The refusal says reloading is the only way to start over (`REOPEN_MESSAGE` in `app/ts/ui/pay.ts`, and `SEND_CLAIMED_ELSEWHERE_MESSAGE` in `app/ts/ui/pay-flow.ts`). `[verified in this repository]`
- A reload or a second tab wipes the guard, because nothing is written (the comment on `attemptedPayments` in `app/ts/ui/pay.ts`). `[verified in this repository]`
- The app cannot confirm anything on chain: `connect-src 'none'`, and the `NETWORK_APIS` sweep in `tests/slow/acceptance.test.mjs`. `[verified in this repository]`

### Three Options

**Option A — memory plus a channel between tabs only.** A `BroadcastChannel` tells other open tabs an invoice was claimed. It survives neither a reload nor the case that matters most: a payer who reloads because the wallet was unclear, then pays again. The storage sweep does not name `BroadcastChannel` `[verified in this repository]` (`STORAGE_APIS` in `tests/slow/acceptance.test.mjs` names only `localStorage`, `sessionStorage`, `indexedDB`, `history`, `window.name`, `document.cookie`), so using it would pass the gate silently; the entry must be written deliberately. Estimated effort: about a day `(estimate)`.

**Option B — one opaque salted hash record in local storage, plus a cross-tab notification.** One string per invoice survives a reload, a second tab, a browser restart, and back-and-forward navigation. Estimated effort: two to three days `(estimate)`, plus a gate change and README rewording. Recommended.

**Option C — a fuller record.** Per-invoice entries with timestamp, status, and optionally payee name and amount: a payment history in everything but name, and worse on a shared device. Not recommended. Estimated effort: four to six days `(estimate)`.

### Recommendation: Option B, and Exactly What It Stores

Store, under one storage key, one line per attempted invoice:

```
<version>:<hex digest>
```

The digest is SHA-256 over a fixed application salt concatenated with the invoice's canonical serialization, which the guard already uses as its key (`paymentKey` in `app/ts/ui/pay.ts` returns `serializeInvoice(invoice)`). `[verified in this repository]` No new dependency is needed: `app/ts/util/encoding.ts` already re-exports `sha256`, `utf8ToBytes`, and `toHex`. `[verified in this repository]`

Deliberately not stored: address, amount, payee name, invoice text, invoice id, and any timestamp that identifies a person. A record cannot be read back as "who was paid, how much, when", and it is not a list of invoices.

The salt is a constant compiled into the app rather than a value chosen per page load, which is why the guard works across tabs: two tabs derive the same digest for the same invoice, whereas a per-page salt would break the guard after a reload. So the record hides the invoice from anyone without the link, not from anyone holding it.

Retention: keep a small fixed number of records, newest kept, oldest dropped, and add a Forget control in the payment panel beside the refusal, labelled "Forget this invoice's payment attempt".

On a shared browser a later payer of the same invoice is refused although they never attempted it; Forget clears that, but they must be told about it where they are refused. The record also reveals that somebody tried to pay this invoice, and the record cap plus Forget are the only mitigation available without a server.

### The Wording After an Unclear Wallet Result

When the wallet gives no clear answer, the honest reading is "it may already be sent", so the screen must not offer a fresh start as if nothing happened.

Primary button: unchanged at `Try sending again`, which is already the safe retry, repeating only the send rather than discovery, connection, or the funds check. `[verified in this repository]` — `app/ts/ui/pay.ts` binds it to `flow.retrySend()`, and `resend` in `app/ts/ui/pay-flow.ts` re-sends only.

Replacement for "reloading the page is the only way to start over", in both messages:

- "A payment for this invoice was already attempted from this browser. Check your wallet's activity before trying again. To start over on this device, use Forget this invoice's payment attempt."
- "Another payment for this invoice is already under way from this page, so this one was not sent. Check your wallet's activity before trying again. To start over on this device, use Forget this invoice's payment attempt."

Caution line with the ambiguous result: "Your wallet did not confirm the transaction. It may still have been sent, so check your wallet's activity before trying again."

No wording may imply that forgetting undoes a payment: the label says "attempt", and the caution line stays the only statement about what was broadcast.

### What Must Change Together

- "No cookies, no tracking, and no analytics" in `README.md`'s "Privacy over features" `[verified in this repository]` must say what the browser keeps: one anonymous marker per attempted invoice, with a Forget control in the payment panel.
- "The app keeps no list of the invoices you made" stays true only if that section also says the marker is a digest rather than an invoice.
- The no-storage note on `attemptedPayments` in `app/ts/ui/pay.ts` ("The record lives only in memory…") becomes false and must describe the digest, its retention, and Forget. `[verified in this repository]`
- The hard gate: `STORAGE_APIS` in `tests/slow/acceptance.test.mjs`, and the assertion of that file's "no served runtime module can build markup, evaluate code, or reach the network" sweep, forbid any storage API in every runtime file. The change must be a content-specific exemption of the kind the sweep already uses, as `isSanctionedElementBuilder` and `isSanctionedSvgNamespace` are: a named module plus an exact statement, not a looser pattern. `[verified in this repository]`
- The wording tests match `/already attempted/`: "the send attempt is surfaced the instant the transaction leaves for the wallet" in `tests/pay-flow.test.mjs`, and "a panel reopened for the same invoice refuses a second payment" beside "navigating away and back to the same invoice cannot re-arm the payment latch" in `tests/wallet.test.mjs`. `[verified in this repository]`

The owner has to sign the storage decision explicitly: the sweep exists because no-storage was a hard rule, and a rule widened quietly is worse than one narrowed in a named place.

### What a Device-Side Guard Cannot Do

A guard on the payer's device cannot stop a determined double payment: another browser, a private window, cleared site data, or a second device never consults the record.
The chain is the only authority, and this app cannot ask it, because `connect-src 'none'` means it reaches no node and the wallet's own report is all it sees.
The guard's job is the ordinary accident, and the wording should say so.

## 3. Blockies Feasibility (Investigate Only)

### The Candidates

- Original `ethereum/blockies`: archived, last push March 2022, no licence file and no licence grant, so it cannot be vendored, because this project redistributes what it vendors. `[reported from an external source]`
- `@metamask/jazzicon`: CommonJS only, roughly 4–5 kB, unreleased since 2020, and its common address adapter uses only the first 8 hex characters as an integer seed. `[reported from an external source]`
- `blo` 2.1.1: MIT, zero dependencies, pure ESM, about 0.7 kB gzipped, actively maintained, produces the blockies look MetaMask and Etherscan users recognise, lowercases the seed, and returns a `data:` SVG URL. `[reported from an external source]` The best fit.
- `minidenticons`: MIT, 311 bytes gzipped, smaller but unrecognisable to anyone who has not seen it. `[reported from an external source]`
- Hand-rolled: about 30 lines, no smaller than `minidenticons`, and it becomes code this project owns and tests. `(estimate)`

### What the Family Computes

It runs an xorshift over character codes rather than a cryptographic hash, and builds a mirrored 32-cell grid. `[reported from an external source]`
Any address string works as a seed, so there is nothing to validate; case folding matters, though, because the EIP-55 mixed-case and lowercase spellings of one address must map to the same avatar, which is what `blo`'s lowercasing gives. The invoice path stores and displays the checksummed spelling (`requireInvoiceAddress` in `app/ts/wallet/address.ts`). `[verified in this repository]`
Canvas-based libraries cost roughly 100 to 1000 times more per icon, and collisions are essentially unmeasured; the one published figure is `minidenticons` reporting 294,912 distinct icons and 1.63% duplicates at 10,000. `[reported from an external source]`

### What It Would Take in This Repository

There is no bundler, so an ESM file is vendored as the three existing packages are: a copied file, a `SHA256SUMS` entry, a `VENDOR_PINS` entry in `scripts/vendor-pins.mjs`, a `SOURCES` entry in `scripts/fetch-vendor.mjs`, and a licence block in `vendor-src/THIRD-PARTY-NOTICES`. `[verified in this repository]`

Files touched: `package.json` and `bun.lock`; both vendor scripts, plus a `HAND_WRITTEN_FILES` entry if a `.d.ts` shim is hand-written as the current three need; `vendor-src/blo/` and a re-blessed `vendor-src/SHA256SUMS` from `bun run vendor -- --add-new`; `vendor-src/THIRD-PARTY-NOTICES`; a new runtime module importing `../../js/vendor/blo/…` as `app/ts/util/encoding.ts` does; call sites in `app/ts/ui/pay.ts` and `app/ts/ui/payment-section.ts`; and sizing rules in `app/stylesheets/invoice.css` and `app.css`.

The owner should see one gate problem before that work starts. The app's single image sink accepts only a branded SVG data URL with the exact `data:image/svg+xml;base64,` prefix and a bounded base64 payload, and `h()` refuses anything else (`checkedAttributeValue` in `app/ts/util/dom.ts`, `isSvgDataUrl` in `app/ts/util/data-url.ts`). `[verified in this repository]` The CSP already permits `data:` images, but this app-level gate is stricter, and `blo` returns a non-base64 SVG data URL. `[reported from an external source]` Integration needs a re-encode into the admitted shape or a new sanctioned sink: an edit to a security gate, and a decision for the owner.

Tests needed: the bundle sweeps pick the new file up automatically, since they derive their list from `SOURCES` (`tests/helpers/vendor-bundles.mjs`, and "every vendored bundle is self-contained and free of network APIs" beside "the page entry and vendored modules load with every network API blocked" in `tests/slow/vendor.test.mjs`), and a shim's exports are checked against the bundle beside it by that file's "every name a hand-written shim declares is an export of the vendored bundle beside it". `[verified in this repository]` New unit tests cover the seed fold, empty alternative text, the avatar never being the only identifier, and the image-gate decision itself.

Estimated effort: two to five days `(estimate)`, dominated by the gate decision and the vendoring ceremony rather than the drawing code.

### Recommendation

Do not ship blockies as a safety measure. They help a payer who already knows the payee's avatar, and they do not defend against a phishing invoice, because that invoice carries the attacker's address and therefore the attacker's matching avatar: the picture agrees with the string.
An avatar used as an identifier also fails every payer with low vision or colour-vision deficiency, and every payer who has never seen the avatar before. `[accepted risk]`
As decoration, `blo` 2.1.1 is the right package, the work is two to five days `(estimate)`, and it starts with an explicit decision on the image gate.

## 4. Local Address Book Feasibility (Investigate Only)

### What It Takes, and Where It Collides

The app would store, per payee, an association between a payee identity and an address, compare it at pay time, and warn when they disagree.
It needs section 2's storage mechanism, and a payee identity that survives across invoices.
That identity is the hard part: the only payee fields an invoice carries are the free-text ones the payee typed (`app/ts/invoice/model.ts`'s `Payee`), so the rule is attacker-controlled text, where a lookalike name creates a false alarm and a loose rule lets a lookalike overwrite the saved address. `[verified in this repository]`

The collision is with the README's privacy section, which says the app keeps no list of invoices because saved history would show who paid whom and how much. `[verified in this repository]` An address book is not a list of invoices, but it is a list of who this device pays: the same harm in a smaller package.

### What Must Change Together

The same set as section 2: the code, the README privacy section, `STORAGE_APIS` in `tests/slow/acceptance.test.mjs` with that sweep's assertion, and the no-storage sentence on `attemptedPayments` in `app/ts/ui/pay.ts`. `[verified in this repository]`
If both features land, they land as one storage design with one exemption, one retention policy, and one Forget control.

### The Labelling Question

The label cannot be the typed name alone. The workable shape: save under the normalised payee name, show the saved address's first and last few characters beside the label, and let the payer rename or delete an entry. Renaming matters, because "Acme Ltd" and "Acme Limited" are not a mismatch worth shouting about.

### The Shared-Device Risk

On a shared browser an address book is a list of the people the previous user pays, with readable labels, worse than section 2's opaque marker. Without a server the only mitigations are visible Forget controls and a first-use explanation; a shared browser cannot be made safe for this, only made obviously the payer's choice.

### The Payoff, and the Recommendation

The payoff is one warning, and it is the most useful this app could show: "This address is not the one saved for this payee." It catches the misuse the poisoning study measures because the app compares, not the person.
Recommendation: do not build the address book alone. Build it as the second step of section 1, on the same storage decision, after the last-paid memory has been in use and the identity rule tested against real names. Estimated effort for the pair: five to eight days `(estimate)`.

## A Plain-Language Note on Address Lengths

Address lengths look arbitrary and are not. `[verified in this repository]`

- A Zcash transparent address (`t1…` or `t3…`) is 35 characters — a version, a 20-byte hash, and a checksum in Base58Check, bounded at 36 before decoding (the bound `MAX_TRANSPARENT_TEXT_LENGTH` in `app/ts/wallet/zcash-address.ts`).
- A Zcash Sapling address (`zs1…`) is 78 characters — Bech32 over a 43-byte payment address (same file's `SAPLING_PAYLOAD_BYTES`).
- A Zcash unified address (`u1…`) runs to 311 characters — `MAX_ZCASH_ADDRESS_LENGTH` in `app/ts/payment/schemes.ts`, derived as the widest symbol the app draws, less what a `zcash:` link spends besides the address, less an 8-byte margin.
- A Monero address is 95 characters, or 106 for an integrated one (the `MoneroForm` table in `app/ts/wallet/monero-address.ts`).

A unified address is long because it carries several receivers at once, so one string lets a sender pay whichever form the recipient supports. That is normal, not a defect, and it is why the display and print ladders exist.

## The Risk We Accepted: Embedding

The page may be embedded by another page on purpose: the dev server sends no `X-Frame-Options` and no `frame-ancestors`, and the meta-delivered policy cannot carry `frame-ancestors` anyway (`serve.mjs`, `app/index.html`). `[verified in this repository]`
Framing protection is out of scope by the owner's decision, comparable to defending against a malicious browser. `[accepted risk]`
Two controls remain unchanged: no wallet is touched until the payer's own click on Connect wallet & pay, and a window another page opened is still refused (`openPayPanel` and `openerRefusal` in `app/ts/ui/pay.ts`). `[verified in this repository]`
What becomes possible is a host page overlaying or driving the controls it frames, which the README's security section already states. `[accepted risk]`
