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
- **Keep the context.** The sentence the word appeared in is saved with it, and
  clicking the source link jumps back to that exact line using Chrome's
  scroll-to-text-fragment.
- **See what you saved here.** The panel's *On this page* tab lists the words
  saved on the page you are reading; clicking one scrolls to it.
- **Organise.** Everything lands in *From reading* automatically; create your
  own folders on top.
- **Review.** SM-2 spaced repetition, in the dashboard or the panel.
- **Own your data.** Export and re-import the whole store as JSON.

## Install

No build step.

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Pin it. The toolbar icon opens the dashboard.

Requires Chrome 116 or later (`chrome.sidePanel.open` from a content script).

## How it is put together

| File | Responsibility |
|---|---|
| `lib.js` | All pure logic — parser, SM-2, word matching, text fragments. No Chrome API, no network. |
| `store.js` | `chrome.storage` access and the serialised write queue |
| `lookup.js` | Cambridge + translation pipeline, pronunciation |
| `content-script.js` | The floating button, highlighting, scroll-to-word |
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

Serves the repo, runs `test/test.html` in headless Chrome, and exits non-zero
unless every assertion passes. The Cambridge parser is checked against four
real saved pages, including one with no CEFR level and one that is not a
dictionary entry at all.

Chrome-facing behaviour cannot be tested this way — `docs/smoke-test.md` is the
manual checklist for it.

## Known limits

- **Cambridge is scraped, not an API.** Selector changes will break fields one
  at a time; each degrades to `—` rather than failing the lookup.
- **The translation endpoint is unofficial** and keyless. It works today and
  will stop one day; the replacement goes behind one function.
- **Highlighting is exact-match.** `resilient` does not highlight `resilience`.
- **Highlights paint once at page load**, so infinite-scroll content is missed.
- **Storage is local to this Chrome profile.** Export is the only backup.
- Roughly 1 word in 8 has no synonyms on Cambridge.
