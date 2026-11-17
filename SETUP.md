# Publish your MARC store

You do not need to give anyone GitHub access. Upload this repository from your own account.

## 1. Publish the website on GitHub Pages

1. Extract `marc-store-repository.zip`.
2. On GitHub, create a new repository named `marc-store`. A public repository is the simplest choice for GitHub Pages.
3. Choose **uploading an existing file** or **Add file → Upload files**.
4. Open the extracted folder and upload **its contents**, including `dist`, `backend`, `.github`, `tests`, `docs`, `README.md` and `SETUP.md`. Do not upload the outer folder itself. The repository root must contain these folders directly.
5. Commit the files to a branch named **main**.
6. Open **Settings → Pages → Build and deployment**. Set **Source** to **GitHub Actions**.
7. Open **Actions → Publish MARC store to GitHub Pages**. If needed, choose **Run workflow → main → Run workflow**.
8. Wait for the deployment to turn green. Your actual website URL appears in **Settings → Pages** and in the workflow's deployment link. Save that URL, including the repository path and trailing slash.

The website works as a collection preview immediately. It shows the supplied polo designs and logos. It does not accept orders until the Google backend is ready.

### If `.github` was missed during upload

Use **Add file → Create new file**. Enter `.github/workflows/pages.yml` as the filename and paste the workflow from this package. Commit it to `main`, then repeat steps 6–8.

The workflow uploads only `dist/`. The backend, tests and instructions are not served as website pages. No build command or paid hosting service is required by this code.

## 2. Create the Google backend

Use the Google account that should own the Form and its responses.

1. Open Google Apps Script and create a **New project** named **MARC Store Backend**.
2. Replace the initial `Code.gs` contents with `backend/Code.gs` from this repository.
3. Click **+ → HTML**. Name the file **Checkout**. Paste the contents of `backend/Checkout.html` into it.
4. In **Project Settings**, enable **Show appsscript.json manifest file in editor**. Replace that file with `backend/appsscript.json` from this package.
5. Save the project. Select **createStarterForm** in the function dropdown and click **Run**. Review and approve Google's requested access using the owner account.
6. Open **Execution log**. It contains the new Form's edit URL and the linked response spreadsheet URL. The Form starts closed and contains a placeholder catalogue. No real price is assumed.
7. Open the new Form and configure the real SKUs as described in section 3. Add the actual deadline, delivery arrangements, cancellation rules and approved payment instructions in the Form description. This description appears at checkout.
8. In Apps Script **Project Settings → Script Properties**, add **STOREFRONT_URL** with the exact GitHub Pages URL from section 1. Keep the automatically created **FORM_ID** and **SCREENSHOT_FOLDER_ID** properties. Also set **PAYMENT_QR_URL** to the public HTTPS image URL of your actual payment QR, and **PAYEE_NAME** to the exact recipient name shown by the UPI app. **UPI_ID** is optional. See section 5 for the QR upload steps.
9. Run **inspectForm**. It must finish successfully and log the catalogue and field mapping. Fix any reported SKU or question configuration issue before continuing.
10. Choose **Deploy → New deployment → Select type → Web app**. Set **Execute as** to **Me** and **Who has access** to **Anyone**. Deploy and copy the web app URL ending in `/exec`.
11. On GitHub, edit `dist/config.js`. Paste that URL between the quotes after `appsScriptUrl:`. Commit the change to `main` and let the Pages workflow finish.
12. The storefront is connected. Keep the Form closed until the launch check in section 6 has passed. To perform the live test, temporarily turn on **Accepting responses** in the Form. If the Form shows a **Publish** control, publish it as well; an unpublished Form keeps website ordering closed.

If your organisation does not offer the **Anyone** option, this public checkout needs the organisation's permission to deploy; choosing a different access mode may require buyers to sign in and must be tested.

### Reuse a Form you create yourself

Instead of running `createStarterForm`, set the **FORM_ID** Script Property to the edit-mode Form ID. Create the required questions and role tags below, or adapt your Form to that structure. `inspectForm` checks the result.

| Question | Type | Required help-text tag |
| --- | --- | --- |
| SKU catalogue | Checkboxes | `[marc:catalog]` |
| Order lines | Paragraph | `[marc:lines]` |
| Total amount INR | Short answer | `[marc:total]` |
| Total quantity | Dropdown | `[marc:quantity]` |
| Email | Short answer, required | `[marc:email]` |
| Full name | Short answer | `[marc:name]` |
| Phone number | Short answer | `[marc:phone]` |
| UPI transaction ID (UTR) | Short answer, required | `[marc:transaction]` |
| Payment screenshot link | Short answer, required helper | `[marc:proof]` |
| Source, optional helper | Short answer | `[marc:source]` |
| Request reference, optional helper | Short answer | `[marc:request]` |

The tags go in a question's **Description**, available from its three-dot menu. Titles may be renamed or questions reordered; the code uses the tag and item ID rather than the title's position.

Use an explicit required email question. Turn off the Form's native **Collect email addresses** setting and **Limit to 1 response** setting. This relay does not implement verified Google sign-in or claim that an entered email is verified.

## 3. Add products, sizes and SKUs in the Google Form

Edit the **SKU catalogue** checkbox question. **Each choice is one sellable size/colour SKU**, in this format:

```text
SKU_CODE | Product name | Colour | Size | Price in INR | Image path or HTTPS URL
```

Template examples, which must be filled with your actual numeric price:

```text
POLO-WHITE-M | MARC Polo | White | M | YOUR_PRICE | assets/polo-white.png
POLO-WHITE-L | MARC Polo | White | L | YOUR_PRICE | assets/polo-white.png
POLO-MAROON-M | MARC Polo | Maroon | M | YOUR_PRICE | assets/polo-maroon.png
```

Replace `YOUR_PRICE` with a number such as `799` or `799.50`. That number is an example of formatting, not a recommended or assumed selling price. Do not include a currency symbol or commas. Remove the setup placeholder choice completely.

- Use a unique SKU code consisting of letters, numbers, hyphens or underscores.
- Keep the product name, colour and image identical for all sizes of one design. Those SKUs become one product card with size choices.
- Add one option for every actual size. Only sizes entered here are offered on the website.
- To add a new colour or product, add its SKU options with a new colour or product name.
- The final image column is optional. White and maroon use the included cutouts by default. Other designs without a photo show a placeholder.
- New images can be uploaded to `dist/assets/` on GitHub, then referenced as `assets/filename.png`. A public HTTPS image URL also works. A private Drive sharing page is not a direct image URL.
- Use final per-unit prices. This implementation does not add separate delivery charges, taxes or discounts; extend the total calculation if your drop needs those rules.

**Updates appear on the next refresh, within about 60 seconds while the page is visible.** Returning to the store tab or clicking Refresh also requests the latest catalogue. There is no GitHub deployment for a catalogue-only change.

Removing a SKU removes its availability. The bag is reconciled against the new catalogue. Prices are fetched again at checkout and recomputed on the server before the Form response is saved. This is not a live inventory system and does not decrement stock.

## 4. Add other Form questions

Ordinary **Short answer**, **Paragraph**, **Dropdown**, **Multiple choice**, **Checkboxes** and **Linear scale** questions appear at checkout automatically. Mark a question required in the Form to make it required at checkout. For a declaration, the buyer must select the checkbox; the code does not accept it automatically.

Keep the store-managed catalogue, total quantity, total amount, order-lines and payment screenshot link questions. The website fills these itself.

Unsupported native Form question types, including file uploads, grids, dates and conditional section branching, pause ordering rather than silently discard the question. Multiple-choice “Other” options are also unsupported. Extend the mapper before using those features. The payment screenshot is handled by the website upload step and saved as a private Drive link in the helper question, rather than through a native Form File upload question.

The relay enforces required answers, listed choices, email format, size/SKU availability and order quantity. If you add a custom validation rule such as a special phone regex or payment-reference format, implement the corresponding check in `checkedValue_` / `saveOrder_` before launching.

## 5. Payment and order limits

Checkout now requires **QR payment, a 12-digit UPI transaction ID (UTR), and a payment screenshot**.

### Add your QR code

1. Obtain the actual QR image from the authorised MARC payment account. This package deliberately includes no invented payment QR or payee.
2. Upload it to GitHub as `dist/assets/payment-qr.png` (or your actual filename), then wait for Pages deployment.
3. Copy the public HTTPS URL of that image from your published site. In Apps Script **Project Settings → Script Properties**, set **PAYMENT_QR_URL** to that URL.
4. Set **PAYEE_NAME** to the exact recipient name buyers should see. Optionally set **UPI_ID**.
5. Keep **SCREENSHOT_FOLDER_ID** pointing to the private **MARC Payment Proofs** folder created by `createStarterForm`. Do not make this folder publicly accessible. Explicitly authorised MARC reviewers can be granted access in Drive if needed.
6. Verify the QR on a real phone and confirm its recipient account before opening orders. A missing QR URL, payee name or proof-folder setting keeps ordering disabled.

### What the buyer does

1. Selects products and sizes and opens checkout.
2. Reviews the total and scans your QR with a UPI app.
3. Pays the exact amount and enters the **12-digit UPI transaction ID (UTR)**.
4. Uploads the matching **PNG, JPG or WebP screenshot, up to 5 MB**. A preview appears before submission. HEIC or PDF files must be converted first.
5. Places the order. The backend validates the cart, amount, UTR and screenshot, then saves the image in the private Drive folder. Its link is written to the **Payment screenshot link** Form question and the linked response sheet.

Both transaction ID and screenshot are required. The backend blocks reused transaction IDs received through this website. A screenshot and transaction ID are payment evidence; they do not establish that a bank transfer settled. MARC must reconcile payments against its bank/UPI records. No payment gateway or automatic bank verification is included.

If creating your own Form, add a required Short answer question tagged `[marc:transaction]`, and a Short answer helper tagged `[marc:proof]`. Do not replace the helper with a native File upload question; Apps Script `FormApp` cannot fill that type. The screenshot upload is provided by `Checkout.html` instead.

The **Total quantity** dropdown sets the per-order item limit. Its choices must be consecutive integers starting at `1`, such as `1, 2, 3, 4, 5`. The starter's limit is five; change the Form choices to change it. The backend also limits website orders to five per entered email per day. Email entry is not authentication, so this is a basic abuse limit rather than proof of identity.

Keep secrets, bank login details and personal response data out of the public repository. The website's `/exec` URL is intentionally public. The code does not send order emails or copy buyers' details to a third party.

## 6. Launch check

1. Run `inspectForm` successfully in Apps Script. Set your actual QR URL and payee name, and confirm the proof folder is private.
2. Turn on **Accepting responses** and open the website. Confirm actual prices, sizes and all required checkout fields.
3. Add one SKU in the Form and refresh the website. Confirm it appears with the correct price and image.
4. Change a price and remove a size. Confirm the website and checkout use the new values.
5. Place one clearly labelled test order using your own details. Confirm one correct Form response and its linked spreadsheet row, including quantities, total, the transaction ID and a screenshot link accessible only to authorised Drive users. Try submitting without a screenshot, with an invalid transaction ID, and with a reused transaction ID; each must fail. Repeatedly clicking Place order in that same checkout must not create duplicate responses.
6. Close the Form and confirm a new checkout cannot submit. Reopen it only when the drop is ready.
7. Check your real phone, including the browser used to open WhatsApp or Instagram links.
8. Remove the test record using the Form/Sheet interface if appropriate, and announce the website only after these checks pass.

The included eleven automated tests run with a simulated Google Form and passed during preparation. No real Google account, Form submission or GitHub Pages deployment has been tested for your account. Those checks need your owner deployment.

## Changing code later

- Website code or images: commit to GitHub and wait for the Pages workflow.
- Form SKU options, ordinary supported questions, quantity choices or description: no redeployment needed.
- Apps Script code: **Deploy → Manage deployments → Edit → Version: New version → Deploy**. Keep using the same `/exec` URL.

If a checkout says an order may already have been received, check the Form responses before starting a new checkout. Pending request claims deliberately prevent automatic duplicate submissions after an uncertain result.

## Reference documentation

- [GitHub Pages publishing sources](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
- [Apps Script Content service and read-only JSONP](https://developers.google.com/apps-script/guides/content)
- [Apps Script Form responses](https://developers.google.com/apps-script/reference/forms/form-response)
- [Google-hosted checkout client calls](https://developers.google.com/apps-script/guides/html/reference/run)
- [Google-hosted form and file uploads](https://developers.google.com/apps-script/guides/html/communication)
- [Reading the checkout URL fragment](https://developers.google.com/apps-script/guides/html/reference/url)
