# Cloud sync setup

Cloud sync signs in with `chrome.identity.getAuthToken` and keeps one file in the
user's Google Drive `appDataFolder`. Microsoft Edge has no working
`getAuthToken`, so in Edge `cloud.js` signs in with
`chrome.identity.launchWebAuthFlow` and a second OAuth client (see
*Make the Edge client* below). Chrome binds the OAuth client to one
extension ID. The unpacked build and the store build must therefore have the
same ID. This page records how the project's client was made, so that a fork can
make its own.

## Values in this repository

| Item | Value |
|---|---|
| Chrome Web Store item ID | `peeekjnmhnjbpbkaodhhffhehmhdnlnm` |
| Google Cloud project | `vocab-track-512107` |
| OAuth client (type Chrome Extension) | `1041853444560-lraltlkbatonto7dn46rrsls0lfo5clc.apps.googleusercontent.com` |
| Scope | `https://www.googleapis.com/auth/drive.appdata` (non-sensitive) |
| OAuth client for Edge (type Web application) | `1041853444560-c03si5r8detffh30uuo281gvvr83vpua.apps.googleusercontent.com` (`WEB_CLIENT_ID` in `cloud.js`) |
| Edge redirect URI | `https://peeekjnmhnjbpbkaodhhffhehmhdnlnm.chromiumapp.org/` |

`manifest.json` holds the client ID in `oauth2.client_id` and the item's public
key in `key`. The `key` makes the unpacked build use the store item's ID.
`tools/package.sh` removes `key` from the zipped manifest, because the store
keeps the ID of the item itself.

## Make your own client

<!-- vibedoc:steps -->
- **Upload a draft** — In the Chrome Web Store Developer Dashboard, click **New item** and upload `dist/vocab-track-<version>.zip` from `bash tools/package.sh`. Do not submit it.
- **Copy the key** — On the item's **Package** tab, click **View public key**. Copy the text between the `BEGIN` and `END` lines, remove the newlines, and put it in `manifest.json` as `key`.
- **Create the project** — In Google Cloud Console, create a project and enable **Google Drive API**.
- **Configure consent** — In **Google Auth Platform**, set the app name, the support email, the audience **External**, and the contact email. Under **Data Access**, add the `drive.appdata` scope.
- **Create the client** — Under **Clients**, create a client of type **Chrome Extension** with the item ID. Put its client ID in `manifest.json` as `oauth2.client_id`.
- **Publish the app** — Under **Audience**, click **Publish app**. While the app is in **Testing**, only the listed test users can sign in.

## Make the Edge client

Edge sends the user to Google in a sign-in window, and Google sends the token
back to the extension's redirect URI. The Chrome Extension client does not
accept that redirect, and Google answers `redirect_uri_mismatch`. The Edge
path needs a client of type Web application.

<!-- vibedoc:steps -->
- **Read the redirect URI** — Load the extension in Edge. Open `edge://extensions`, click **service worker** under Sheaf, and run `chrome.identity.getRedirectURL()` in its console. With `key` in the manifest, the answer is the Edge redirect URI in the table above.
- **Create the client** — In the same Google Cloud project, under **Google Auth Platform** → **Clients**, create a client of type **Web application**. Add the redirect URI under **Authorized redirect URIs**. Leave **Authorized JavaScript origins** empty.
- **Set the client ID** — Put the new client ID in `cloud.js` as `WEB_CLIENT_ID`. It is a public value, like `oauth2.client_id`.
- **Test it** — Reload the extension in Edge and click **Sign in with Google**. Google's window opens, and after you allow access the card shows your email.

The Web application client uses the same consent screen and the same
`drive.appdata` scope, so it needs no new review.

If you publish to the Edge Add-ons store, the store gives the item its own
extension ID, because `tools/package.sh` removes `key`. That ID has its own
redirect URI. Install the store build, read `chrome.identity.getRedirectURL()`
as above, and add it to the same client as a second authorized redirect URI.
A user who installs the Chrome Web Store build in Edge gets the Chrome ID, and
the first redirect URI covers that user.

## Effect on an existing unpacked install

Chrome keys `chrome.storage.local` by extension ID. When `key` is added, an
unpacked install gets a new ID, and its words stay with the old ID. Before you
reload the unpacked build with `key`, click **Export** on the dashboard. After the
reload, click **Import** and select that file.
