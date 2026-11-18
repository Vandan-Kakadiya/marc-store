# MARC loading-speed update

Apply this to your existing `marc-store` website and your two existing Apps Script projects. Your GitHub Pages URL, checkout URL (A), catalogue URL (B), Form, responses and Script Properties stay the same.

## 1. Upload the smaller website files

In your GitHub repository, open `dist` and choose **Add file → Upload files**. Upload `app.js` and `store-core.js` from this update's `dist` folder. Commit the changes.

Then open `dist/assets` and upload these five new files from the update's `dist/assets` folder:

- `polo-white.webp`
- `polo-maroon.webp`
- `polo-white-480.webp`
- `polo-maroon-480.webp`
- `linkedin-icon-small.png`

Keep your existing `config.js`, `payment-qr.jpeg`, original PNG files and other assets. Your configured PUBLIC CATALOGUE URL (B) is already in your own `config.js`; this update does not contain a replacement config file.

## 2. Edit your existing homepage

In GitHub, open **dist → index.html → Edit ✏️**. Keep your own headings, descriptions and other text. Make the following small changes in that existing file.

Near the top, update the CSS and JavaScript references to:

```html
<link rel="preconnect" href="https://script.google.com">
<link rel="dns-prefetch" href="https://script.googleusercontent.com">
<link rel="stylesheet" href="styles.css?v=20261118-speed1">
<script src="config.js?v=20261118-speed1" defer></script>
<script src="store-core.js?v=20261118-speed1" defer></script>
<script src="app.js?v=20261118-speed1" defer></script>
```

Replace your current stylesheet/script lines rather than adding a second copy. These version suffixes make browsers request the updated files. For a later release that changes a CSS/JS file, update that file's `v=` value again.

Find the two shirt image elements in the hero (the large illustration near the top). Change those two image elements to:

```html
<img class="hero-maroon" src="assets/polo-maroon.webp?v=speed1"
     srcset="assets/polo-maroon-480.webp?v=speed1 480w, assets/polo-maroon.webp?v=speed1 1068w"
     sizes="(max-width: 700px) 56vw, 31vw" decoding="async"
     alt="Maroon IIM Trichy polo cutout" width="1068" height="1473">
<img class="hero-white" src="assets/polo-white.webp?v=speed1"
     srcset="assets/polo-white-480.webp?v=speed1 480w, assets/polo-white.webp?v=speed1 1098w"
     sizes="(max-width: 700px) 56vw, 31vw" decoding="async" fetchpriority="high"
     alt="White IIM Trichy polo cutout" width="1098" height="1433">
```

In the footer LinkedIn image, replace `src="assets/linkedin-icon.png"` with `src="assets/linkedin-icon-small.png?v=speed1"`. Keep its link and 18 × 18 display size.

Commit. Wait for the newest **Actions** run to turn green. Your existing Pages workflow still publishes `dist`.

For your source records, also upload the update’s `backend` folder and `scripts/build-catalogue.cjs` to the same paths in GitHub. Those backend files run in Apps Script only after the deployments in steps 3 and 4 below.

## 3. Update the existing checkout project

Open your **MARC Store Backend** project in Apps Script. Replace both file contents:

| File in this update | Existing Apps Script file |
| --- | --- |
| `backend/Code.gs` | `Code.gs` |
| `backend/Checkout.html` | `Checkout.html` (the Checkout HTML file) |

Save both files. Keep the existing manifest and all Script Properties, including `FORM_ID`, `RESPONSE_SHEET_ID`, `SCREENSHOT_FOLDER_ID`, `STOREFRONT_URL`, `PAYMENT_QR_URL`, `PAYEE_NAME` and optional `UPI_ID`.

Select **inspectForm → Run** once. Then choose **Deploy → Manage deployments → select the existing checkout deployment → Edit ✏️ → Version: New version → Deploy**.

Keep:

- **Execute as:** Me
- **Who has access:** Anyone with Google account

Editing the existing deployment keeps URL A unchanged. This update needs both `Code.gs` and the Checkout HTML together: the new page receives its initial data from the new `doGet` function.

## 4. Update the existing public catalogue project

Open your separate **MARC Public Catalogue** Apps Script project. Replace its `Code.gs` with **`backend/catalogue/Code.gs`** from this update. This nested file is different from the checkout's `backend/Code.gs`.

Save. Keep its existing manifest and Script Properties, especially `CHECKOUT_URL` pointing to A. Select **inspectCatalogue → Run**.

Choose **Deploy → Manage deployments → select the existing catalogue deployment → Edit ✏️ → Version: New version → Deploy**.

Keep:

- **Execute as:** Me
- **Who has access:** Anyone

Editing the existing deployment keeps URL B unchanged. The two projects still need their different access settings.

## 5. Check the result

1. Open your GitHub Pages website in a fresh private/incognito tab on your phone and computer.
2. The main shirt images should appear normally. Product cards also use the new WebP files, even if your Form choices still say `assets/polo-white.png` or `assets/polo-maroon.png`.
3. Add a product to the bag and choose **Continue with Google**. After Google's sign-in page, checkout should render the bag and contact fields without making another `getCheckoutData` request.
4. Check that your real QR and payee **IIMT MART** appear. You do not need to pay or submit a test order to check loading.
5. For later Form catalogue edits, the website's **Refresh** button bypasses the catalogue cache. Without pressing it, automatic updates may take about 90 seconds: up to 30 seconds of server cache plus the existing 60-second browser refresh interval. Network/Google delays can add time.

## What changed

- The two original hero PNGs total **4,491,903 bytes**. Full-size transparent WebP copies total **531,626 bytes** (about **88% smaller**). The two 480-pixel copies total **67,454 bytes**; the browser chooses a suitable size for its screen and pixel density.
- The embedded checkout footer icon is about 2.4 KB instead of 64.8 KB of PNG data.
- The public catalogue can reuse a read-only result for **30 seconds** instead of reopening the Form and checking Drive for every visitor. Cache failures fall back to reading the live Form.
- Checkout receives its fresh catalogue, fields and bag with the page. It no longer waits for the normal link's `getLocation` and `getCheckoutData` calls after the HTML opens. Older hash-based bag links remain supported.
- Checkout and order submission still read the current Form directly. Prices, closed ordering, payment evidence and duplicate-order checks remain enforced by the server. No customer responses or payment screenshots are cached in the public catalogue.

**Measured limits:** Image byte reductions and 32 automated checks were verified locally, with browser checks of the storefront and a checkout fixture. Live timings in your Google account have not been measured. Google's sign-in screen, Apps Script startup, network conditions and any additional images you upload still affect loading time; this update cannot guarantee an instant checkout.

## Restore the previous version if needed

GitHub retains the earlier file versions in commit history. Apps Script **Manage deployments → Edit → Version** can select your previous deployed version. Restore the checkout's Code and HTML together if reverting that project.
