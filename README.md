# MARC Polo Store

A complete static website for GitHub Pages, with a Google Forms backend supplied as a Google Apps Script project.

**Start with [SETUP.md](SETUP.md).** You can publish the website immediately as a collection preview, then connect the backend when the real Form and prices are ready.

## Included

- White and maroon polo cutouts made from the supplied campaign images.
- The supplied MARC and IIM Trichy logos, with MARC orange and navy styling.
- Responsive product pages, colour filters, a shopping bag and Google-hosted checkout.
- Live catalogue reads from the Google Form every 60 seconds while the store tab is visible, on returning to the tab, and on Refresh.
- Form-based product prices, sizes, new SKUs, removal of old SKUs and extra supported checkout questions.
- Server checks for current prices, quantities, required answers, duplicate requests and reused payment references.
- QR payment instructions, required 12-digit UPI transaction ID, and required private payment screenshot upload (PNG/JPG/WebP, up to 5 MB).
- Designer credit: Website designed by Vandan Kakadiya.
- A GitHub Pages deployment workflow. No npm install or build is required.

## Repository layout

| Path | Purpose |
| --- | --- |
| `dist/index.html` | Website |
| `dist/styles.css` | Orange and navy styling and responsive layouts |
| `dist/app.js` | Collection, bag and catalogue refresh |
| `dist/config.js` | Paste the public Apps Script `/exec` URL here |
| `dist/store-core.js` | Shared catalogue and cart utilities |
| `dist/assets/` | Both logos and both transparent polo images |
| `backend/Code.gs` | Catalogue reader, Form creator, private payment uploads and order writer |
| `backend/Checkout.html` | Google-hosted checkout |
| `backend/appsscript.json` | Apps Script manifest |
| `.github/workflows/pages.yml` | Publishes `dist/` to GitHub Pages |
| `tests/store.test.cjs` | Backend and cart tests with a simulated Google Form |
| `SETUP.md` | Click-by-click publishing and backend instructions |
| `docs/` | Asset notes |

## Current state

`dist/config.js` intentionally has no Apps Script URL. There is no live Google Form connected and no prices or sizes are invented. The website therefore shows the supplied white and maroon designs as previews and does not accept orders. Once the backend, real payment QR and payee are configured and the Form accepts responses, actual products, prices, sizes and checkout become available.

Checkout runs on the Apps Script web app and saves the response through `FormApp`. Personal details are not sent through JSONP or placed in the bag URL. The static site only stores SKU codes and quantities in the visitor's browser.

## How automatic updates work

The designated `SKU catalogue` checkbox question contains one structured option per sellable SKU. The site reads these choices through a public, read-only Apps Script catalogue. Use the documented SKU format in `SETUP.md`; arbitrary untagged questions are not interpreted as products. New supported ordinary questions appear at checkout automatically.

No GitHub push is needed for a new SKU or a price change in that Form. New product images must already be available at the image path or HTTPS URL specified in the SKU. The app shows a photo placeholder for an item without an image.

## Local preview and tests

Open `dist/index.html` for the unconnected preview, or serve `dist/` with any static web server. For example:

```sh
python3 -m http.server 8000 --directory dist
```

Tests need Node.js 20 or newer and no third-party packages:

```sh
node --test tests/store.test.cjs
```

The tests simulate Apps Script and Google Forms. They verify catalogue changes and order rules; they do not replace a real submission after the owner deploys the Apps Script project. See the launch check in `SETUP.md`.
