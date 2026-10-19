# Cloud sync setup

Cloud sync signs in with `chrome.identity.getAuthToken` and keeps one file in the
user's Google Drive `appDataFolder`. Chrome binds the OAuth client to one
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

## Effect on an existing unpacked install

Chrome keys `chrome.storage.local` by extension ID. When `key` is added, an
unpacked install gets a new ID, and its words stay with the old ID. Before you
reload the unpacked build with `key`, click **Export** on the dashboard. After the
reload, click **Import** and select that file.
