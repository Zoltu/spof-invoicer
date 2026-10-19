# Security and Privacy over Features (SPOF) - Decentralized invoicing

Make an invoice in your browser, share it as a link, and get paid in crypto.

## What it is

An invoice is a page you fill in, and the person you bill opens it from the link you send.
It shows what is owed and how to pay, and the crypto reaches your wallet.
There is nothing to install and no account to create.

## What you can do

- Create an invoice with line items and tax.
- Add your own logo.
- Share the invoice as a link or a copy-paste code.
- Let the person you bill see a clean invoice with a scannable QR code and a payment link.
- Save the invoice as a PDF.
- Pay from a crypto wallet (Ethereum, USDC, USDT).
- Show a QR code the person you bill can scan to pay in Zcash or Monero.

## Privacy over features

- No account and no sign-up.
- No cookies, no tracking, and no analytics.
- Nothing is uploaded: the invoice travels inside the link you share, and no company server ever holds it.
- The app itself is a set of pages, so it runs entirely in your browser rather than on a server.
- The app keeps no list of the invoices you made, because saved history would show who paid whom and how much: each invoice exists only inside its link.
- You have to share the whole link, because a shorter link would need a copy stored on a server that could point back to you.
- The app doesn't index things by invoice number because that would require a server and retaining user data on a server.
- The invoice is readable by anyone who holds the link, so users have agency to decide who to share it with.

## Security over features

- The app has no way to reach an outside server, so it never contacts a tracking service.
- The app refuses to hand the payment to the crypto wallet unless the wallet reports the invoice's own network.
- Nothing touches your wallet until you click Connect wallet & pay.
- The page can be embedded by another page on purpose, because some wallets show the invoice inside their own frame: the payment panel still needs your own click and still refuses a window another page opened, but an embedding host could overlay the controls, and that is a risk this app accepts.
- Invoice text is always shown as plain text, so a link cannot add code to the page.
- Payee entered text never turns into bold or italics, because a link can come from anyone.
- You get the transaction hash, the code the wallet gives back for the payment, instead of an external link that looks up the payment.

## Open the app

All three links open the same app, so pick the one that suits how you browse.
IPFS is a network that serves files from many computers rather than one company.
If you do not know what IPFS is, use the hosted link below; it opens like any other website.
The long code starting `bafybei…` names the same content in all three, so the copy you are served can be checked against it.
The app expects to be served from its own origin: the invoice lives in the URL fragment, and anything else sharing that origin would share the trust the fragment's confidentiality rests on.

- **Most people:** <https://bafybeic2zbzrhdemxr7c5vfnvshwo4qfap7uolqyot3qlqhusxage4pmv4.ipfs.zoltu.io/> works in any browser, because a public gateway serves it for you; that gateway is run by someone else and could change the files before serving them, so trust it only as far as you trust its operator.
- **Already use IPFS:** <ipfs://bafybeic2zbzrhdemxr7c5vfnvshwo4qfap7uolqyot3qlqhusxage4pmv4> opens the same app through your own IPFS software.
- **Run your own IPFS node:** <http://bafybeic2zbzrhdemxr7c5vfnvshwo4qfap7uolqyot3qlqhusxage4pmv4.ipfs.localhost:8080/> serves the app from your own computer.

## Screenshots

![The invoice form with a business name, two line items, and a total.](docs/screenshots/create-invoice.png)

*Start with your own details, then add what you are billing for.*

![A finished invoice with a letterhead, an itemized table, a total, and a QR code.](docs/screenshots/shared-invoice.png)

*The page the person you bill opens from your link.*

![The payment panel showing the amount, the recipient, and the network.](docs/screenshots/pay-panel.png)

*Choose how to pay, with a wallet or without one.*

![The share dialog showing a link and a copy-paste code.](docs/screenshots/share-dialog.png)

*Send the link, or the copy-paste code.*

## License

This app is in the public domain under the [Unlicense](LICENSE).
