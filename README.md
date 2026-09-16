# Vocab-track

A personal Chrome extension for learning English vocabulary while reading.

Select a word on any page, click the button that appears, and the side panel
shows its Cambridge entry — CEFR level, UK and US pronunciation, every sense
with its own level and example, synonyms — alongside a Vietnamese translation
and **the sentence you met it in**. Saved words are highlighted when you
revisit the page, and reviewed as flashcards on a spaced-repetition schedule.

Built for one person. No accounts, no sync, no server.

| Side panel | Dashboard |
|---|---|
| ![The side panel](docs/screenshot-panel.png) | ![The dashboard](docs/screenshot-dashboard.png) |

## What it does

- **Look up while reading.** Select a word, click 📘. No typing, no tab switch.
- **Look up while watching.** On YouTube, click a word in the subtitles. The
  video pauses, the word is saved with the line it was said in, and the source
  link takes you back to that exact second.
- **Keep the context.** The sentence the word appeared in is saved with it, and
  clicking the source link jumps back to that exact line using Chrome's
  scroll-to-text-fragment.
- **See what you saved here.** The panel's *On this page* tab lists the words
  saved on the page you are reading; clicking one scrolls to it, or seeks the
  video to the moment it was said.
- **Read faster.** `Alt+Shift+R` opens an RSVP speed reader over the page: one
  word at a time at a fixed focal point, so your eyes never travel. It reads
  your selection, or extracts the article if you have not selected anything.
  Escape drops you back at the paragraph you stopped in.
- **Save from any Mac app.** Select a word in Kindle, Preview, Notes, Mail or
  Slack and press a hotkey — a macOS Quick Action queues it, and the dashboard
  looks it up next time you open it. See *Saving from outside Chrome* below.
- **Write better.** Type in any text box on any site and mistakes are underlined
  in place; click one for the fix. The dashboard's *Writing* view keeps a count
  of the rules you break most often, which is the part a grammar checker does
  not normally tell you. See *Writing* below.
- **Organise.** Everything lands in *From reading* automatically; create your
  own folders on top.
- **Review by typing.** The card shows the meaning and you type the English
  word; Enter checks it and marks the letters you got wrong, so `pidgeon` reads
  as one slip rather than as a failure. Typing already says how well you knew
  it, so Enter also takes the grade that fits — exact goes to Good, one or two
  letters out to Hard, anything else to Blank — and `1`-`4` override it.
  SM-2 spaced repetition underneath, in the dashboard or the panel.
- **Learn a band, not just what you met.** `data/ielts-c1-c2.json` is an
  importable C1/C2 word list — the vocabulary IELTS band 7+ is made of — with
  Cambridge definitions, pronunciation and an example sentence on every card.
  See *Word lists* below.
- **Own your data.** Export and re-import the whole store as JSON.

## Install

No build step.

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Pin it. The toolbar icon toggles the side panel; the dashboard is one click
   further, from the panel's **Open dashboard →**.

Requires Chrome 116 or later (`chrome.sidePanel.open` from a content script).

## Saving from outside Chrome

```bash
./tools/install-macos.sh
```

Then assign the hotkey by hand — macOS does not let a script do this:

> System Settings → Keyboard → **Keyboard Shortcuts…** → **Services** → **Text**
> → tick **Save to Vocab-track** and click at its right to set a key.

Select a word anywhere and press it. A notification confirms the capture; the
word is looked up the next time you open the dashboard.

**How it fits together**, and why it is built this way:

| Piece | Job |
|---|---|
| `tools/vocab-capture.sh` | Appends the selection to a queue file, then exits |
| `tools/vocab-host.py` | Chrome native messaging host; hands the queue over and clears it |
| `tools/install-macos.sh` | Builds the Quick Action, registers the host, verifies both |
| `tools/uninstall-macos.sh` | Removes both |

The capture script deliberately **does not talk to Chrome**. Chrome may not be
running, and blocking on it would stall the app you are reading in. So captures
are instant and offline, and the dashboard drains the queue when it opens —
which is also when you are there to see a word that could not be found.

The drain happens in the dashboard rather than the service worker because a
service worker has no `DOMParser`, so it cannot run the Cambridge parser at all.

Re-run `install-macos.sh` if you ever move the repository: an unpacked
extension's id is derived from its folder path, and the host manifest names it.

## Writing

Focus a textarea or a rich editor, type at least 40 characters, and a second
after you stop the mistakes are underlined. Click one for LanguageTool's
explanation and up to three replacements; picking one edits the field through
the browser's own editing pipeline, so the page's editor sees it and Cmd-Z
takes it back.

Every error is also tallied by rule in **Dashboard → Writing**, so the list
answers "which mistakes do I keep making" rather than "what did I get wrong
just now". A mistake left uncorrected while you keep typing is counted once,
not once per re-check.

**What leaves your machine.** The text in the field is sent to
`api.languagetool.org` to be checked. Nothing else is sent, and these never
are:

- password, email, URL, telephone, number and search fields
- anything inside `autocomplete="off"` or `autocomplete="one-time-code"`
- anything under 40 characters, which is what keeps search queries, usernames
  and 2FA codes off the network

Turn it off globally, or per site, in **Dashboard → Writing**. The switch takes
effect in every open tab straight away. LanguageTool is open source and
self-hostable; pointing `LT_URL` in `service-worker.js` at your own container
is the whole change if you ever want nothing to leave the machine at all.

## Word lists

`data/ielts-c1-c2.json` is the same format the **Export** button writes, so
**Dashboard → Import** takes it. It lands as two folders, *IELTS C1* and
*IELTS C2*, and merges with what you already have: a word you saved yourself
keeps its review schedule and just gains the folder.

**1,945 words — 1,005 at C1, 940 at C2.** 1,901 carry a Cambridge definition
and UK pronunciation, 1,937 a Vietnamese gloss, and 1,423 an example sentence
with the word blanked out of it, which is what the typing card asks you with.
IELTS publishes no official vocabulary list, so the CEFR bands are the graded
stand-in: band 7 and up is described in C1/C2 terms.

The cards do not all arrive at once. Twenty become due a day, C1 first, so the
file behaves like a course rather than a wall — the last word is due in 97 days,
and SM-2 takes over from there. Importing twice does not reset that: an existing
word is never overwritten.

The countdown starts from the day the file was **built**, not the day you
import it: a file left for three months arrives with every card already due.
Re-running the builder re-staggers it — with the file already there that takes
a second, not another crawl.

Rebuild or extend it with:

```bash
python3 tools/build-ielts-list.py
```

It is resumable — it keeps a cache in `/tmp/vocab-track-ielts` and re-running
after a stall only fetches what is missing. Parsing is not done in the script:
each batch of cached pages is handed to headless Chrome running
`tools/ielts-parse.html`, which calls the extension's own `VT.parseCambridge`
and `VT.newEntry`. An imported word is therefore the same shape as one you
saved by clicking it, and Cambridge's markup is understood in exactly one
place in this repo.

Sources: the word list is the **Octanove Vocabulary Profile C1/C2** from
[Open Language Profiles](https://github.com/openlanguageprofiles/olp-en-cefrj),
CC BY-SA 4.0. Definitions, IPA, audio and examples are scraped from Cambridge
one page at a time, for personal use, at about a page a second.

## How it is put together

| File | Responsibility |
|---|---|
| `lib.js` | All pure logic — parser, SM-2, word matching, text fragments. No Chrome API, no network. |
| `store.js` | `chrome.storage` access and the serialised write queue |
| `lookup.js` | Cambridge + translation pipeline, pronunciation |
| `content-script.js` | The floating button, highlighting, scroll-to-word, YouTube captions |
| `reader.js` | The RSVP speed reader: article extraction, overlay, pacing |
| `tools/` | The macOS capture: Quick Action, native messaging host, installer. Also `build-ielts-list.py`, which generates `data/ielts-c1-c2.json`. |
| `service-worker.js` | Opens the panel and the dashboard, hands words over |
| `sidepanel.*` | The lookup surface |
| `dashboard.*` | Folders, all words, review, statistics, import/export |

Network and parsing live in the side panel, because it is the only context with
both a DOM and the MV3 CORS bypass: a service worker has no `DOMParser`, and a
content script gets no bypass.

## Tests

```bash
bash test/run.sh
```

Serves the repo, runs five pages in headless Chrome, and exits non-zero unless
every assertion passes:

| Page | Checks |
|---|---|
| `test.js` | Pure logic. The Cambridge parser runs against four real saved pages, including one with no CEFR level and one that is not a dictionary entry at all. |
| `yt-probe.html` | That a caret still reads caption text through YouTube's `user-select:none`. |
| `reader-probe.html` | Article extraction against a page of nav, footer and comment junk, and that the RSVP focal letter does not move. |
| `dashboard-probe.html` | The dashboard's layout, measured against a stubbed `chrome` API — view switching, control sizing, and that the review card never shows the word before you commit. It loads the real `dashboard.html`, so it cannot drift from what ships. |
| `writer-probe.html` | The textarea mirror over a content-box and a border-box field, the contenteditable offset index, and that a tag typed into a field stays text. |

The last four exist because these are failures no unit test can see: they are
about what the browser actually renders.

Chrome-facing behaviour cannot be tested this way — `docs/smoke-test.md` is the
manual checklist for it.

## Known limits

- **Cambridge is scraped, not an API.** Selector changes will break fields one
  at a time; each degrades to `—` rather than failing the lookup.
- **The translation endpoint is unofficial** and keyless. It works today and
  will stop one day; the replacement goes behind one function.
- **A card with no meaning saved cannot ask you to type.** If the dictionary
  and the translator were both down when the word was saved it has neither a
  definition nor a gloss, so it falls back to showing the word and asking you
  to recall the meaning, as before.
- **Answer checking is exact, ignoring case and spacing.** A synonym is marked
  wrong; the diff shows you why, and `1`-`4` are there to overrule it.
- **A word list is graded by the list, not by the dictionary.** The CEFR band
  on an imported word is Octanove's, because that is why the word is in the
  file; Cambridge tags senses, so its first sense can read B2 for a word that
  is C1 in the sense you want.
- **The words view builds 300 cards at a time.** A card is 16 elements and the
  view re-renders on every keystroke in the search box, so with a couple of
  thousand words saved it shows the newest 300 and the count says so. Search
  and folders reach the rest.
- **Highlighting is exact-match.** `resilient` does not highlight `resilience`.
- **Highlights paint once at page load**, so infinite-scroll content is missed.
- **Storage is local to this Chrome profile.** Export is the only backup.
- **The writing check sends your text to a third party.** `api.languagetool.org`,
  subject to the exclusions above. It is the one part of this extension that
  shows anything you write to a server you do not run.
- **LanguageTool's free tier allows 20 requests a minute per IP.** The worker
  holds one bucket across every tab and refuses at 18; over that, a check is
  silently skipped and retried on your next pause.
- **It does not catch everything.** Measured on a sentence with eight planted
  errors it found six: verb forms and spelling reliably, agreement (`three
  apple`) and confusion pairs (`their`/`they're`) not always.
- **Google Docs is a `<canvas>`** and cannot be underlined by any extension.
  Editors that rebuild their DOM under the highlights drop them; they come back
  on the next pause.
- **`<input>` fields are underlined by the same mirror as a textarea**, which
  is a plain block. An input centres its single line vertically inside a tall
  box and a block does not, so on an unusually tall input the underline can sit
  high. Rare in practice: almost every input is under the 40-character floor.
- **The textarea mirror follows the field on scroll and resize only.** A
  textarea dragged by its resize grip leaves its underlines behind until the
  next check.
- **YouTube subtitles are not highlighted on return.** A caption exists only
  while it is on screen, so there is nothing to paint over when you come back —
  the *On this page* tab is how you find those words again.
- **The caption click depends on YouTube's player classes**
  (`.ytp-caption-segment`, `.caption-window`). A player rewrite would need
  those selectors updating; `test/yt-probe.html` documents the shape they had.
- **Speed reading trades comprehension for pace.** Studies put the useful range
  at 250–350 WPM, and ~300 for non-native readers; above that comprehension
  falls off. RSVP also removes *regressions* — you cannot glance back — which is
  why `←` steps backwards. The default is 300 and the ceiling is 700 on purpose.
- **Article extraction is a heuristic, not Readability.** It scores containers
  by the prose they hold and rejects comment threads, nav, asides and
  link-dense lists by name. A page that names its article wrapper `related-*`
  or hides the body behind a paywall will read the wrong thing; select the text
  and press the shortcut instead.
- **The reader cannot open inside a page's own fullscreen video** other than by
  the top layer, and it does not open on `chrome://` pages, the web store, or a
  tab that has not been reloaded since the extension was installed.
- **The Mac capture needs a selection.** Reading the word under the pointer
  without selecting it needs the macOS Accessibility API and therefore a native
  app; this is a Quick Action, so double-click the word first. Apple's own
  three-finger-tap Look Up cannot be intercepted — it is resolved by the OS
  through `NSTextInputClient` and never becomes a DOM event.
- **Captures resolve when the dashboard opens**, not instantly. They queue
  offline in the meantime, so nothing is lost if Chrome is shut.
- Roughly 1 word in 8 has no synonyms on Cambridge.
