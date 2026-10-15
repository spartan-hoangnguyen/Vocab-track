# Chrome Web Store listing

The text entered in the store dashboard for each release, kept here so the next
release reuses it. It describes the **store** build from `tools/package.sh`,
whose manifest has no `nativeMessaging`. The facts come from the README
*Privacy* section and [PRIVACY.md](../PRIVACY.md); if they change, change all
three.

## Store listing

**Name:** Vocab-track

**Summary** (≤132 characters):

> Look up words while you read, keep the sentence you met them in, and review them as flashcards on a spaced-repetition schedule.

**Description:**

> Select a word on any page and click the button that appears. The side panel
> shows its meanings, part of speech, synonyms and a Vietnamese translation,
> and saves the word with the sentence you met it in. The source link takes you
> back to that exact line later.
>
> Saved words are highlighted on every page you read, and reviewed as
> flashcards on a spaced-repetition schedule (FSRS), with a few practice games
> alongside.
>
> On YouTube, click a word in the subtitles: the video pauses and the word is
> saved with the line it was said in.
>
> A writing check underlines mistakes in the English you type into text boxes
> on web pages. It is on when you install, and can be turned off in the
> dashboard, everywhere or per site.
>
> English and Korean. Korean is newer and thinner: a Vietnamese gloss, the
> sentence, highlighting and review, with no dictionary behind it yet.
>
> No Vocab-track account and no Vocab-track server. Your words stay in this
> Chrome profile, unless you choose to sign in with Google: then they sync to
> every Chrome you sign in to, through a hidden app folder in your own Google
> Drive that only Vocab-track can read. The synced file includes the sentences
> you saved and the addresses of the pages you saved words on.
> Privacy policy: https://github.com/spartan-hoangnguyen/Vocab-track/blob/main/PRIVACY.md

**Category:** Productivity › Education

**Language:** English

## Screenshots

1280×800, in `docs/store/`:

1. `1-dashboard.png` — the dashboard's *All words* list.
2. `2-side-panel.png` — a word's entry in the side panel.

## Privacy practices

**Single purpose:**

> Help you learn vocabulary from what you read and write on the web: look up a
> word on a page, save it with its sentence, review it later, and check the
> English you type. Optionally, sync those words between your own computers
> through your own Google Drive.

**Permission justifications** — one per permission and host in the store
manifest, and no others:

| Permission | Justification |
|---|---|
| `storage` | Keeps your saved words, their sentences and review schedule, and your settings in `chrome.storage.local` on this device. Nothing is uploaded unless you sign in for cloud sync (`identity`). |
| `sidePanel` | The side panel is where a looked-up word's entry is shown and saved. |
| `downloads` | Writes the automatic backup of your words to `Downloads/vocab-track/backup-<date>.json` on this device, and removes backups older than the last seven. |
| `downloads.ui` | Keeps the browser's download bubble from opening each time the automatic backup is written. |
| `alarms` | Writes the automatic backup a minute after your last change, and keeps one backup per day. |
| `identity` | Optional cloud sync. Only when you press **Sign in with Google**, Chrome's own sign-in (`chrome.identity.getAuthToken`) gets a token for the `drive.appdata` scope, so your words can be kept in a hidden app folder of your own Google Drive and synced to your other computers. Never used if you do not sign in. |
| `offscreen` | A service worker cannot make a file to download. An offscreen document makes the backup file for `downloads`. |
| Content script on `<all_urls>` | The content script has to be on the page you are reading for a click to look a word up, and there is no way to know in advance which page that is. It reads the word you clicked and its sentence, highlights words you saved, and runs the writing check in text boxes. It sends nothing on its own. |
| `api.datamuse.com` | When you click an English word, the word is sent here for its meanings, part of speech and synonyms. |
| `translate.googleapis.com` | When you click any word, the word is sent here for its Vietnamese translation. |
| `translation.googleapis.com` | Only after you add your own Google Cloud Translation key, and only when the free endpoint above fails: the word and your key are sent here for the same translation. |
| `api.mymemory.translated.net` | Only when the endpoints above fail or are rate-limited: the word is sent here for the same translation. |
| `api.languagetool.org` | With the writing check on, a sentence you type into a text box on a page is sent here to be checked. Password, email, URL, phone, number, search and `autocomplete="off"` fields are never read, nor any field under 40 characters. |
| `api.giphy.com` | Only after you add your own GIPHY API key and press **Find GIF** on a review card: the word, or its Vietnamese gloss, is sent here to find a GIF for the card. |
| `krdict.korean.go.kr` | Only after you add your own krdict API key: when you click a Korean word, the word and your key are sent here for its definition, pronunciation and level. |
| `www.googleapis.com` | Only after you sign in for cloud sync: reads and writes one file, `vocab-track.json`, in your own Google Drive's hidden `appDataFolder` (Drive API v3), and reads your account's email from Drive to show which account is signed in. The file holds your saved words with their sentences, the addresses of the pages they came from, and your review schedule. No other Drive file is reachable with this scope. |
| `127.0.0.1:8765` | Only when you press **Push to Anki**: the word, its meaning, example and GIF are sent to the AnkiConnect add-on of the Anki app on your own machine. Nothing leaves the machine. |

**Remote code:** No. All JavaScript ships inside the package.

**Data usage** — what the dashboard's checkboxes should say:

| Category | Collected? | Why |
|---|---|---|
| Personally identifiable information | No | With cloud sync, the account email is read from Google Drive only to show it on this device; it is not sent anywhere. |
| Health information | No | |
| Financial and payment information | No | |
| Authentication information | No | Password fields are never read. Google sign-in is Chrome's own; its token goes only to Google. |
| Personal communications | No | |
| Location | No | |
| Web history | **Yes** | The address of each page you saved a word on is kept with the word. It leaves the device only if you sign in for cloud sync, and then only to your own Google Drive, to sync your words. Not sold, not used for anything else. |
| User activity | No | |
| Website content | **Yes** | The word you click, and text you type when the writing check is on, are sent to the services above to look it up, translate it or check it. With cloud sync on, the sentence each word was found in is also sent to your own Google Drive, to sync your words. Not sold, not used for anything else. |

Certify all three:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://github.com/spartan-hoangnguyen/Vocab-track/blob/main/PRIVACY.md
