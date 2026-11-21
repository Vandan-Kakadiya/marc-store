# MARC checkout on your existing Vercel site

This update uses the latest navy-and-orange MARC design. Use your existing project and address, **marc-store-iimt.vercel.app**. Customers shop, provide their details, enter the UPI reference and attach their screenshot on the MARC website. Google sign-in returns them to checkout.

When the customer clicks **Place order**, a Vercel function sends the order to Apps Script. Apps Script saves the screenshot in your restricted Google Drive folder, records the order in **MARC Website Orders** inside the Form’s linked spreadsheet, and returns the order reference and submission timestamp. The customer sees **Order received** after both saves are confirmed. A separate background catalogue check picks up your edits to the existing Form.

## 1. Extract the repository and generate the keys

1. Download **MARC-Vercel-Checkout.zip**. In File Explorer, right-click it and choose **Extract All**.
2. Open the folder that contains `vercel.json`, `package.json`, `dist`, `api`, `server`, `scripts` and `apps-script`.
3. Install **Node.js 24** if needed. Reopen File Explorer, click that folder’s address bar, type `cmd` and press Enter. [Node.js downloads](https://nodejs.org/en/download)
4. Run the line below **twice**. Keep the two different 64-character values in your password manager. Label the first `MARC_SCRIPT_SECRET` and the second `MARC_SESSION_KEY`.

```cmd
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

The script secret goes in both Apps Script and Vercel. The session key goes only in Vercel. Save the session key for future redeployments so existing sign-ins and saved receipts remain readable.

## 2. Create the Apps Script order receiver

1. Open your old **MARC Store Backend** project. In **Project Settings → Script Properties**, copy the values of `FORM_ID`, `RESPONSE_SHEET_ID` and `SCREENSHOT_FOLDER_ID`. These are the three existing Google items.
2. In Google Drive, open **Share** for the spreadsheet and screenshot folder. Set **General access** to **Restricted** and give access to the MARC members who handle orders.
3. In Apps Script, create a standalone project named **MARC Vercel Checkout** under the account that can edit the existing Form, Sheet and Drive folder. [Google Apps Script](https://script.google.com/)
4. In the new project, replace the entire **Code.gs** with **apps-script/Code.gs** from the extracted ZIP.
5. In **Project Settings**, enable **Show “appsscript.json” manifest file in editor**. Go back to **Editor**, open **appsscript.json**, and replace its contents with **apps-script/appsscript.json** from the ZIP. Save.
6. Return to **Project Settings → Script Properties**. Use **Add script property** once per row, then click **Save script properties**.

| Property | Value |
| --- | --- |
| `FORM_ID` | The existing Google Form ID you copied |
| `RESPONSE_SHEET_ID` | The existing Form-linked spreadsheet ID you copied |
| `SCREENSHOT_FOLDER_ID` | The existing restricted Drive folder ID you copied |
| `STOREFRONT_URL` | `https://marc-store-iimt.vercel.app` |
| `PAYMENT_QR_URL` | `https://marc-store-iimt.vercel.app/assets/payment-qr.jpeg` |
| `PAYEE_NAME` | `IIMT MART` |
| `MARC_SCRIPT_SECRET` | The first 64-character value from Step 1 |
| `UPI_ID` | Optional. The exact UPI ID for the QR, if you have it |
| `LEGACY_TAB` | Optional. If you previously received payments, enter the exact tab name containing those orders, such as `Form Responses 1` |
| `LEGACY_UTR_HEADER` | Optional with `LEGACY_TAB`. Enter the exact transaction column heading if it differs from `UPI transaction ID (UTR)` |

7. Beside **Run**, select **checkOrderStorage** and click **Run**. Review and approve the script’s access for the owner account when prompted. Open **Execution log**. It should show **Order storage is ready**. This checks the Form’s linked spreadsheet and creates the order tab with its headers. If it logs **Catalogue paused**, correct the reported Form or QR setting using Step 6.
8. Select **Deploy → New deployment → Web app**. Enter **MARC Vercel checkout receiver** in the description.

| Web app setting | Select |
| --- | --- |
| Execute as | **Me** |
| Who has access | **Anyone** |

Click **Deploy** and copy the **Web app URL** ending in `/exec`. Use it as `MARC_SCRIPT_URL` in Vercel. **Anyone** lets the Vercel server call the receiver. The receiver requires a valid request signature before it reads the catalogue or writes an order. The script URL and secret belong in Vercel’s server environment. If **Anyone** is unavailable, the Workspace administrator controls that deployment setting. [Apps Script web app deployment](https://developers.google.com/apps-script/guides/web)

When you edit **Code.gs** later, save it and select **Deploy → Manage deployments → Edit → New version → Deploy** on this same deployment to keep the `/exec` URL.

## 3. Enable Google sign-in

1. Open **Google Cloud Console → Google Auth Platform** in the project you manage. If it asks you to configure the app, enter **MARC Store** and the committee’s support and developer contact email addresses. [Google Auth Platform](https://console.cloud.google.com/auth/overview)
2. In **Audience**, choose **External** if you want personal Google accounts as well as institute accounts. Use **Test users** if Google asks while testing. Complete any publication or branding requirements shown by Google before opening access to customers. The website requests `openid`, `email` and `profile`.
3. Under **Clients**, create or select a **Web application** OAuth client. Under **Authorized redirect URIs**, add this exact line.

```text
https://marc-store-iimt.vercel.app/api/auth/callback
```

4. If your branding asks for homepage and privacy links, enter `https://marc-store-iimt.vercel.app/` and `https://marc-store-iimt.vercel.app/privacy.html`. Copy the **Client ID** and **Client secret** for the next step. [Google OAuth web server setup](https://developers.google.com/identity/protocols/oauth2/web-server)

## 4. Add the settings to your current Vercel project

1. Open **Vercel → your existing MARC project → Settings → Environment Variables**. Set the variables for **Production** before deploying the updated code. [Vercel dashboard](https://vercel.com/dashboard) · [Vercel environment variables](https://vercel.com/docs/environment-variables)

| Name | Value |
| --- | --- |
| `MARC_SITE_URL` | `https://marc-store-iimt.vercel.app` |
| `MARC_SCRIPT_URL` | The new Google web app `/exec` URL from Step 2 |
| `MARC_SCRIPT_SECRET` | Exactly the same first key you set in Apps Script |
| `MARC_SESSION_KEY` | The different second key from Step 1 |
| `GOOGLE_CLIENT_ID` | Your OAuth web client’s Client ID |
| `GOOGLE_CLIENT_SECRET` | Your OAuth web client’s Client secret |

2. Under **Settings → Build and Deployment**, use your connected repository’s root folder, the one containing `vercel.json`. **Framework Preset** is **Other**. The included `vercel.json` sets the **Build Command** to `npm run build` and **Output Directory** to `dist`. It also enables the checkout API routes at the repository root. The package selects Node.js 24. [Vercel project settings](https://vercel.com/docs/project-configuration/project-settings)

Keep the keys in the private settings above. The `.env.example` file in the ZIP is a list of names with empty example values. Vercel’s Hobby terms limit usage to personal or non-commercial projects. Keep the MARC site on a plan that permits its use. [Vercel Terms of Service](https://vercel.com/legal/terms)

## 5. Upload the update to the GitHub repository connected to Vercel

1. Open the **same GitHub repository** that your Vercel project is connected to. On Windows you can clone it in **GitHub Desktop → File → Clone repository**, then open the local repository folder. If you already have it on your PC, open that copy and get the latest changes first.
2. Copy these from the ZIP into the repository root. Keep the folder names and paths exactly as shown.

| Copy from the ZIP | Destination in your repository |
| --- | --- |
| `dist/` | `dist/` for the latest store design and checkout pages |
| `api/` | `api/` for Google sign-in and the checkout endpoint |
| `server/` | `server/` for quote validation, auth and the Google connection |
| `scripts/build.mjs` | `scripts/build.mjs` for the build-time catalogue |
| `apps-script/`, `test/` | Same paths for your setup files and automated checks |
| `vercel.json`, `package.json`, `package-lock.json` | Repository root |
| `README.md`, `.env.example`, `.gitignore` | Repository root. Merge any existing ignore rules you still use |

3. In `dist/assets/`, keep extra product photos you’ve already uploaded. If your real QR is newer than the included file, place your approved QR there under the exact name `payment-qr.jpeg`. The new homepage loads `market.js` and checkout loads `checkout.js`; you can remove the previous browser `dist/config.js` references and obsolete browser checkout files after checking the new deployment.
4. Commit and push to the branch Vercel uses for **Production**. In GitHub Desktop, select **Commit to main** (or your production branch), then **Push origin**. If you use the GitHub website to upload, upload the extracted files and folders with their original paths. Vercel builds from those files.
5. In the **existing Vercel project → Deployments**, wait for the new Production deployment to show **Ready**. If it fails, open **Build Logs**. A working build says **MARC catalogue saved** and shows the number of product groups. Open `https://marc-store-iimt.vercel.app` and check for **THE CAMPUS STORE**, the two logos and the current products.

## 6. Keep editing products in the same Google Form

In the existing Form, use **Checkboxes** for **SKU catalogue** and place `[marc:catalog]` in the question description. Put each full SKU on its own checkbox option. Use **Dropdown** for **Total quantity**, with `[marc:quantity]` in the description and the separate options `1`, `2`, `3`, and so on.

```text
POLO-WHITE-M | MARC Polo | White | M | 799 | assets/polo-white.png
```

Use the actual SKU, product, colour, size and INR price. The image field is optional. Use an existing `assets/filename` path or a direct HTTPS image URL. Use the same image for each size of the same product and colour. The Form description becomes the order and delivery information at checkout. Publish the Form if required and turn on **Accepting responses** when you open orders.

To activate automatic SKU updates after the first successful Vercel deploy:

1. Open **Vercel project → Settings → Git → Deploy Hooks**. Create **MARC catalogue update**, selecting the existing production branch. Copy the generated hook URL. [Vercel Deploy Hooks](https://vercel.com/docs/deploy-hooks)
2. Add `VERCEL_DEPLOY_HOOK` in **MARC Vercel Checkout → Project Settings → Script Properties** and paste the URL. Keep that URL private.
3. In the Apps Script editor select **installCatalogueSync → Run**. Check for **Five-minute background catalogue check is installed**. Confirm **publishCatalogueIfChanged** appears once in **Triggers**.
4. Catalogue edits appear after the next check and successful Vercel build. For an immediate rebuild request, use **publishCatalogueIfChanged → Run**. Once the deployment is Ready, refresh the site on your phone or PC.

The storefront loads the latest published catalogue from Vercel. The customer can see both the catalogue and checkout while Apps Script is idle. The Form’s Accepting responses switch applies to new quotes after the next catalogue deployment. Buyers who already reached the QR can submit proof at their quoted total for up to seven days. Change the QR image filename if the account changes so already quoted orders retain the correct image.

## 7. Test and reconcile an order on the existing domain

1. Open your store in a private browser tab. Choose a size and **Add to bag**. Open the same product and click **Buy now**. The summary should show one selected item and keep the item in the earlier bag.
2. Click **Continue with Google**. After the Google account step, confirm the browser returns to the MARC address. Check the customer’s verified email, phone and affiliation. Each PGPM cohort requires a roll number. **Staff** and **Other** hide it.
3. Click **Continue to payment**. Confirm the amount and scan the QR to check the recipient reads **IIMT MART**. To test the screen without a payment, stop here or cancel the unpaid checkout.
4. For the first authorized order, enter the real **12-digit UPI transaction ID**, attach a PNG, JPG or WebP screenshot up to **4 MB**, and click **Place order**. While Google saves it the website says **Saving your order and screenshot**. Once the save is confirmed, the same page shows **Order received**, a reference and the submission time in IST.
5. In the existing linked spreadsheet, open **MARC Website Orders**. Find the same reference. Check the timestamp (stored in UTC), contact and item details, UTR, **Under review** status and the **Private screenshot** link. Open the link using a MARC account with access to the folder. Compare the actual UPI credit to the amount and reference, then record the verified status in the Sheet.
6. Once previous checkouts are reconciled, switch the MARC buying links to the updated checkout on Vercel. Preserve the old spreadsheet tab for historical orders. The Form’s own Responses tab counts direct Google Form submissions. The website writes its orders to **MARC Website Orders** in that same spreadsheet.

If the upload is interrupted, stay in the same checkout tab and retry **Place order** with the same UTR and screenshot. The same order reference can recover a completed save. Keep a copy of that order reference after submitting. **My orders** displays the saved receipts for the signed-in account on the browser used to place them.

## Troubleshooting

| What you see | What to check |
| --- | --- |
| Build fails with a script or JSON error | Compare `MARC_SCRIPT_URL` and `MARC_SCRIPT_SECRET` in both services. Check the web app deployment is **Anyone**, the file is saved and the deployment uses the current version. |
| Catalogue is empty or ordering is paused | Run **checkOrderStorage**. Check the SKU options, quantity choices, Form publication and Accepting responses. Request a new catalogue build after correcting them. |
| Google `redirect_uri_mismatch` | Paste the exact callback from Step 3 into **Authorized redirect URIs**. Use the production MARC address for this production OAuth configuration. |
| “Open the official MARC store address” | Use the `marc-store-iimt.vercel.app` production domain registered in `MARC_SITE_URL`. The random Vercel Preview hostname uses a different origin. |
| Screenshot is too large | Upload a readable PNG, JPG or WebP of 4 MB or less. |
| Save is unconfirmed after payment | Retry with the same UTR and screenshot. Use the same browser tab and Google account. Ask MARC to check the order reference before making any further payment. |
| Drive or Sheets save fails | Run **checkOrderStorage** and inspect **Executions**. Check the authorized owner can edit the spreadsheet and folder, and both are Restricted. |
| Product images load slowly or fail | Use small WebP or JPEG assets in `dist/assets/`. Check the filename in the SKU matches the deployed file. |

Run `npm test` from the extracted project folder to exercise checkout with simulated Google sign-in, Sheets and Drive. The browser preview and these tests use simulated orders. The first real order verifies the connection in your own Vercel and Google accounts.
