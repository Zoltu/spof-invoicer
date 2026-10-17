# Invoicing & Payment App

Make an invoice in your browser, share it as a link, and get paid in crypto.

## What it is

An invoice is a page you fill in, and the person you bill opens it from the link you send.
It shows what is owed and how to pay, and the crypto reaches your wallet.
There is nothing to install and no account to create.

## Screenshots

![The invoice form with a business name, two line items, and a total.](docs/screenshots/create-invoice.png)

*Start with your own details, then add what you are billing for.*

![A finished invoice with a letterhead, an itemized table, a total, and a QR code.](docs/screenshots/shared-invoice.png)

*The page the person you bill opens from your link.*

![The payment panel showing the amount, the recipient, and the network.](docs/screenshots/pay-panel.png)

*Choose how to pay, with a wallet or without one.*

![The share dialog showing a link and a copy-paste code.](docs/screenshots/share-dialog.png)

*Send the link, or the copy-paste code.*

## What you can do

- Create an invoice with line items and tax.
- Add your own logo.
- Share the invoice as a link or a copy-paste code.
- Let the person you bill see a clean invoice with a scannable QR code and a payment link.
- Save the invoice as a PDF.
- Pay from a crypto wallet (Ethereum, USDC, USDT).
- Show a QR code the person you bill can scan to pay in Zcash or Monero.

## Privacy by design

- No account and no sign-up.
- No cookies, no tracking, and no analytics.
- Nothing is uploaded: the invoice travels inside the link you share, and no company server ever holds it.
- The app itself is a set of pages, so it runs entirely in your browser rather than on a server.

## Open the app

All three links open the same app, so pick the one that suits how you browse.
IPFS is a network that serves files from many computers rather than one company.
If you do not know what IPFS is, use the hosted link below; it opens like any other website.
The long code starting `bafybei…` names the same content in all three, so the copy you are served can be checked against it.

- **Most people:** <https://bafybeic2zbzrhdemxr7c5vfnvshwo4qfap7uolqyot3qlqhusxage4pmv4.ipfs.zoltu.io/> works in any browser, because a public gateway serves it for you; that gateway is run by someone else and could change the files before serving them, so trust it only as far as you trust its operator.
- **Already use IPFS:** <ipfs://bafybeic2zbzrhdemxr7c5vfnvshwo4qfap7uolqyot3qlqhusxage4pmv4> opens the same app through your own IPFS software.
- **Run your own IPFS node:** <http://bafybeic2zbzrhdemxr7c5vfnvshwo4qfap7uolqyot3qlqhusxage4pmv4.ipfs.localhost:8080/> serves the app from your own computer.

## License

This app is in the public domain under the [Unlicense](LICENSE).
