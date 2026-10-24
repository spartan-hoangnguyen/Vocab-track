# Vocab-track privacy policy

Last updated: 2026-10-15

Vocab-track is a Chrome extension for learning vocabulary while you read. This
page says what it keeps, what it sends, and to whom. It covers the version in
the Chrome Web Store.

## What it keeps, and where

Everything Vocab-track keeps is in `chrome.storage.local`, in the Chrome
profile you installed it in. That is your saved words, the sentence you met
each word in, the address of the page it came from, your review schedule, your
folders, the writing mistakes you make most often, and your settings. Unless
you sign in with Google for cloud sync (below), none of it is uploaded. There
is no Vocab-track account and no Vocab-track server. Removing the extension
deletes all of it, except the automatic backups and, if you signed in, the
copy in your Google Drive.

The automatic backup is a copy of your words in your own Downloads folder, in
`Downloads/vocab-track/backup-<date>.json`. The extension writes it a minute
after you change your words and keeps the last seven. It is not uploaded, and
it stays after you remove the extension until you delete it.

An export is a file you save yourself. It goes where you put it and nowhere
else.

## What leaves your browser

Eleven things leave your browser, each only when you do something that needs it:

| When | Goes to | What is sent |
|---|---|---|
| You click an English word | `api.datamuse.com` | the word |
| You click any word | `translate.googleapis.com` | the word, for the Vietnamese gloss |
| Google Translate fails, and you set a translation key | `translation.googleapis.com` | the word and your key, for the same gloss |
| Google Translate fails or rate-limits that lookup | `api.mymemory.translated.net` | the word, for the same gloss |
| You stop typing, with the writing check on | `api.languagetool.org` | the sentence you typed |
| You play a pronunciation | the host on the card | nothing — the audio file is streamed from the URL stored with the word |
| You press **Find GIF** on a review card | `api.giphy.com` | the word, or its Vietnamese gloss for a Korean card |
| You click a Korean word, with a krdict key saved | `krdict.korean.go.kr` | the word and your key |
| You press **Push to Anki** | `127.0.0.1:8765` | the word, meaning, example and GIF — to the Anki app on your own machine, through AnkiConnect |
| You signed in for cloud sync | `www.googleapis.com`, your own Google Drive | your whole word store, including the address of every page you saved a word on — see *Cloud sync* below |
| You press **Submit** on the feedback form | `docs.google.com`, a Google Form owned by the developer | what you typed, plus the extension version and browser name the form fills in for you — you can see and edit them before sending. Opening the form sends nothing |

Each of these services gets the request directly from your browser, so it also
sees your IP address, as with any web request. Their own privacy policies
apply to what they do with it.

**The writing check is on when you install.** It checks the English you type
into text boxes on web pages and underlines mistakes. It sends text only from
plain text fields, text areas and editable areas, and only once a field holds
at least 40 characters. It never reads password, email, URL, phone, number or
search fields, or any field the page marks as `autocomplete="off"` or as a
one-time code. To stop it, open the dashboard, go to **Writing**, and untick
**Check my writing as I type**; to stop it on one site only, add that site
under **Off on these sites** on the same page.

**GIFs are off until you add your own GIPHY API key.** The key stays in
`chrome.storage.local` and is never part of an export. Nothing is sent to
GIPHY until you press the button on a review card.

**The Google Cloud Translation key is optional.** It stays in
`chrome.storage.local` and is never part of an export. Nothing is sent to
`translation.googleapis.com` until you add one, and then only when the free
Google endpoint fails.

**Korean sends nothing to krdict until you add your own krdict key.** The key
stays in `chrome.storage.local` and is never part of an export. Without a key,
the **krdict ↗** link opens a tab when you click it. Opening the dashboard
makes no third-party request; its fonts ship inside the extension.

## Cloud sync (optional)

Cloud sync is off until you press **Sign in with Google** on the dashboard's
**Import & export** page. If you never sign in, everything above holds
and nothing is sent to Google Drive.

**What is sent.** Once you sign in, the extension uploads one file,
`vocab-track.json`, holding the same things as an export:

- every saved word, with its meanings, translation, pronunciation and GIF link;
- **the sentence you met each word in** — text copied from the page you were
  reading;
- **the address (URL) of every page you looked a word up on**, and for a
  YouTube video the second it was said at. Together these are a list of pages you
  read;
- your review schedule and review history, your folders and pins, your
  practice misses, and the list of words and folders you deleted, so a delete
  reaches your other machines.

Your settings, theme, voices, and your GIPHY, translation and krdict keys are
not part of it and stay on this machine.

**Where it goes.** To your own Google Drive, in its *app data* folder: a
hidden folder that does not show in your Drive and that only Vocab-track can
read or write. The extension asks only for that folder
(`drive.appdata`), not for the rest of your Drive. There is no Vocab-track
server; the file goes straight from your browser to Google. Google's privacy
policy applies to it there. To show which account is signed in, the extension
also asks Drive for your account's email address and keeps it in
`chrome.storage.local`; it is not sent anywhere else.

**When.** Half a minute after you change your words, when you open the
dashboard or the side panel, every 30 minutes while Chrome runs, and when you
press **Sync now**.

**How to stop it.** Press **Sign out** on the same card. Syncing stops, the
extension drops its Google sign-in token and asks Google to revoke it, and
your words on this machine stay as they are. The copy in Drive is left as it
was.

**How to delete the Drive copy.** Open Google Drive in a browser → the gear
icon → **Settings** → **Manage apps** → find **Vocab-track** → **Options** →
**Delete hidden app data**. Sign out on every machine first, or the next sync
uploads the file again.

## What it does not do

- No analytics, no tracking, no advertising.
- It does not sell or transfer your data to anyone, and does not use it for
  anything other than the features above. The cloud sync copy is used only to
  sync your own words between your own machines.
- It reads the page you are on only to find the word you clicked, its
  sentence, and your saved words to highlight. It sends nothing on its own.

## Contact

Questions or problems: open an issue at
<https://github.com/spartan-hoangnguyen/Vocab-track/issues>.
