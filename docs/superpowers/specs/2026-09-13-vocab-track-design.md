# Vocab-track — Design

Date: 2026-09-13
Status: Approved

## Purpose

A personal Chrome extension for learning English vocabulary while reading
English web pages. Select an unknown word, get its Vietnamese translation,
its Cambridge CEFR level, its pronunciation, and save it as a flashcard.
Words saved on a page are highlighted when that page is revisited.

Single user. No accounts, no sync, no server.

## Scope

In scope:

- Vietnamese translation of a single word.
- Cambridge Dictionary lookup: CEFR level, IPA, definition, audio URL.
- Pronunciation playback.
- Flashcard review with SM-2 scheduling.
- Per-URL highlighting of saved words, plus a side panel listing them.

Out of scope (deliberate, add later if missed):

- Cloud sync, accounts, multi-device.
- Languages other than English to Vietnamese.
- Phrase or sentence lookup. Single words only.
- Anki export.
- An options page. Constants live in the source.
- Stemming or inflection matching.

## Verified facts

Confirmed by fetching `https://dictionary.cambridge.org/dictionary/english/<word>`
with a normal browser User-Agent on 2026-09-13. HTTP 200, plain HTML, no
Cloudflare challenge.

| Field | Markup | Example |
|---|---|---|
| CEFR level | `<span class="epp-xref dxref C2">C2</span>` | `resilient` -> C2, `happy` -> A1 |
| IPA | `<span class="ipa dipa ...">rɪˈzɪl.i.ənt</span>` | present on all entries checked |
| Definition | `<div class="def ddef_d db">...</div>` | first occurrence is the primary sense |
| Audio | `<source src="/media/english/uk_pron/....mp3">` | path is relative, needs host prefix |

Not every word carries a CEFR level. `ubiquitous` returned a full entry with
no `epp-xref` span, because it is outside the English Profile word list. The
parser must return `null` for a missing level and the UI must render `—`.

## Relationship to the official Chrome samples

Conventions are taken from `GoogleChrome/chrome-extensions-samples`, not the
code: file naming (`service-worker.js`, `content-script.js`), the
`storage.session` handoff from `sample.sidepanel-dictionary`, and the
content-script-to-`sidePanel.open()` path from `cookbook.sidepanel-open`. The
repository is not vendored and no sample file is copied, so the Apache
licence headers those files carry do not apply here.

## Architecture

```
  web page                  service worker            side panel
  ────────                  ──────────────            ──────────
  select "resilient"
  floating button  ──msg──> sidePanel.open()  ──────> fetch Cambridge
                                                      fetch translate
                                                      parse (has DOM)
                                                      |
                            chrome.storage.local <────┘ save
                                    |
  on page load ──────────────────> read words whose
                                   sources include this URL
  CSS.highlights.set(...)  <───────┘
```

### Why the side panel performs network work

An MV3 service worker can `fetch` past CORS through `host_permissions`, but
it has no `DOMParser`, so it cannot parse the Cambridge HTML. A content
script has a DOM but does not receive the CORS bypass in MV3. The side panel
is an extension page: it has both. All fetching and parsing happens there.

The service worker only relays messages and opens the side panel.

## Components

Five files. Plain JavaScript, no build step, no dependencies. Loaded through
`chrome://extensions` with Load unpacked.

| File | Responsibility | Depends on |
|---|---|---|
| `manifest.json` | MV3 manifest, permissions, registrations | — |
| `content-script.js` | Floating button on selection; applies highlights | `chrome.storage`, `chrome.runtime` |
| `service-worker.js` | Opens the side panel, hands off the word | `chrome.sidePanel`, `chrome.storage` |
| `sidepanel.html` | Markup for the Lookup and Review views | — |
| `sidepanel.js` | Fetch, parse, translate, storage, SM-2 | `chrome.storage` |

### manifest.json

- `manifest_version: 3`
- `minimum_chrome_version: "116"` — the floor for `chrome.sidePanel.open()`
  from a content-script message. It also clears the CSS Custom Highlight API
  (Chrome 105) and `chrome.storage.session` (Chrome 102), so neither needs a
  capability check.
- `permissions`: `storage`, `sidePanel`. Not `contextMenus`: the trigger is a
  floating button, and the official sample only asks for it because its
  trigger is a context menu.
- `host_permissions`: `https://dictionary.cambridge.org/*`,
  `https://translate.googleapis.com/*`
- `content_scripts`: `content-script.js` on `<all_urls>` at `document_idle`
- `background.service_worker`: `service-worker.js`
- `side_panel.default_path`: `sidepanel.html`
- `action: {}` — an empty toolbar action, so clicking the extension icon
  opens the panel. This is the only entry point to flashcard review that does
  not require looking a word up first.
- `icons` optional. Chrome supplies a default for an unpacked extension.

### content-script.js

Two independent jobs.

1. On `mouseup`, if the selection is a single word (no whitespace, letters
   and hyphens only, 2 to 40 characters), position a small button near the
   selection. Clicking it sends `{type: "lookup", word, url}` to the service
   worker. Any other click or a new selection removes the button.

2. On `document_idle`, read `words` from storage, filter to entries whose
   `sources` array contains `location.href`, and highlight them using the CSS
   Custom Highlight API.

   Highlighting walks text nodes with a `TreeWalker`, matches each saved word
   with a case-insensitive word-boundary regex, builds a `Range` per match,
   and registers one `Highlight` under the name `vocab-track`. The
   `::highlight(vocab-track)` rule is injected with a constructable
   `CSSStyleSheet` through `document.adoptedStyleSheets`, so no `<style>`
   element is added to the page.

   The CSS Custom Highlight API does not mutate the DOM, so it cannot break
   page layout or be undone by a framework re-render of the same nodes.

   Highlights are applied once, at load. Content added later by infinite
   scroll is not highlighted. Mark this with a `ponytail:` comment naming a
   debounced `MutationObserver` as the upgrade path.

### service-worker.js

On a `lookup` message: open the side panel, then hand the word off through
`chrome.storage.session`. This follows `functional-samples/sample.sidepanel-dictionary`,
which uses session storage rather than a message to the panel. A message can
be sent before the panel has loaded a listener; a storage write cannot be
missed, because the panel reads the key on load as well as watching it.

```js
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type !== 'lookup') return;
  // Open FIRST. sidePanel.open() consumes a user gesture, and the gesture
  // does not survive an await. Do not reorder these two lines.
  chrome.sidePanel.open({ tabId: sender.tab.id });
  chrome.storage.session.set({
    pending: { word: message.word, url: message.url, ts: Date.now() }
  });
});
```

The `ts` field exists because `storage.onChanged` does not fire when the
written value equals the stored value. Without it, looking up the same word
twice in a row would not wake the panel the second time.

On `onInstalled`, call
`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` so the
toolbar icon opens the panel for a review session.

### sidepanel.js

The panel picks up a word two ways, both required, per the dictionary
sample: `chrome.storage.session.get('pending')` once on load, for the case
where the panel was opened by this lookup and missed the write, and
`chrome.storage.session.onChanged` for every lookup after that while the
panel stays open. A `pending` value of `undefined` means the panel was opened
from the toolbar for review; show the Review view instead of the Lookup view.

Lookup flow for a word:

1. Normalise: trim, lowercase.
2. If the word is already in storage, render it from storage and append the
   current URL to `sources` if absent. No network call.
3. Otherwise fetch Cambridge and the translation endpoint in parallel.
4. Parse the Cambridge HTML with `DOMParser`:
   - level: `.epp-xref` textContent, or `null`
   - ipa: first `.ipa` textContent, or `null`
   - def: first `.def.ddef_d` textContent, trimmed, or `null`
   - audio: first `source[src$=".mp3"]` src, prefixed with
     `https://dictionary.cambridge.org`, or `null`
   Every field is independently optional. A missing field renders as `—`; it
   never aborts the lookup.
5. Translate through `https://translate.googleapis.com/translate_a/single?client=dict-chrome-ex&sl=en&tl=vi&dt=t&q=<word>`.
   `client=gtx` was the original choice and is now rate-limited to HTTP 429
   from ordinary clients; `client=dict-chrome-ex` returns HTTP 200 with the
   same response shape, so the `data[0][0][0]` parse is unchanged. Verified
   2026-09-13.
   This endpoint is unofficial and keyless. It is acceptable for a personal
   tool and will break without notice. On failure, `vi` is `null` and the
   entry still saves.
6. Save the entry with SM-2 fields initialised: `ease: 2.5`, `interval: 0`,
   `reps: 0`, `due: Date.now()`.
7. Render: word, level badge, IPA, play button, definition, Vietnamese.

Pronunciation: play the Cambridge mp3 through `new Audio(url)`. When `audio`
is `null`, fall back to `speechSynthesis` with an `en-GB` voice.

Review flow: cards with `due <= Date.now()`, shown one at a time. Show the
word, reveal the translation and definition on demand, then grade 0 to 5.
Apply SM-2 and write the card back.

SM-2, standard formulation:

```
if q < 3:  reps = 0; interval = 1
else:
  reps += 1
  interval = reps == 1 ? 1 : reps == 2 ? 6 : round(interval * ease)
ease = max(1.3, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)))
due  = now + interval days
```

The `ease` floor of 1.3 is part of the algorithm, not an arbitrary constant.

## Data

One `chrome.storage.local` key, `words`, an object keyed by lowercase word.

```js
{
  words: {
    resilient: {
      word: "resilient",
      level: "C2",
      ipa: "rɪˈzɪl.i.ənt",
      audio: "https://dictionary.cambridge.org/media/...mp3",
      def: "able to recover quickly after something unpleasant",
      vi: "kiên cường",
      sources: ["https://example.com/article"],
      added: 1757740000000,
      ease: 2.5, interval: 0, reps: 0, due: 1757740000000
    }
  }
}
```

One key means one read and one write per operation, and no migration
machinery. `chrome.storage.local` allows 10 MB, which holds tens of thousands
of entries at this size. If that limit is ever reached, add the
`unlimitedStorage` permission.

`sources` holds full URLs including query strings. Two URLs that differ only
by a tracking parameter are treated as different pages. Acceptable; URL
normalisation is not worth the code for a single user.

## Error handling

Every failure degrades rather than aborts.

| Failure | Behaviour |
|---|---|
| Cambridge returns non-200 | Save with `level`, `ipa`, `def`, `audio` all `null`. Panel shows the word and the translation. |
| Cambridge markup changed, a selector misses | That field is `null` and renders `—`. Other fields are unaffected. |
| Translation endpoint fails | `vi` is `null`, entry still saves, panel shows `—`. |
| Word not in the dictionary (404) | Panel states the word was not found. Nothing is saved. |
| `sidePanel.open()` rejects | Log it. The word is already in `storage.session`, so the user clicks the toolbar icon and the panel reads `pending` on load. Nothing is lost. |
| Audio playback rejects | Fall back to `speechSynthesis`. |

No silent catches. Every caught error is logged with the word that caused it
before the fallback runs.

## Testing

One `test.html` opened in the browser, using `console.assert`. No framework,
no runner, no fixtures directory beyond the saved HTML.

Covered, because each has a branch that can silently produce a wrong result:

1. `parseCambridge(html)` against saved fixtures for `resilient` (C2, full
   entry), `happy` (A1), and `ubiquitous` (no CEFR level). Asserts that the
   third returns `level === null` and still returns IPA and a definition.
2. `sm2(card, quality)` for: a failed card resetting `reps` to 0 and
   `interval` to 1; first and second successful reviews giving 1 and 6 days;
   the `ease` floor holding at 1.3 after repeated low grades.
3. The word-boundary regex: `cat` must not match inside `category` or
   `concatenate`, must match `Cat` at the start of a sentence and `cat.`
   before punctuation.

The Chrome APIs — storage, side panel, highlights, context of the content
script — are verified by loading the extension and using it. Mocking them
would test the mocks.

## Build and install

No build step. `chrome://extensions`, enable Developer mode, Load unpacked,
select the repository root. Reload the extension after editing
`service-worker.js` or `manifest.json`; content script changes need a page
reload.

## Open risks

1. The Google translate endpoint is unofficial and load-bearing. When it
   breaks, the replacement is a different endpoint behind the same function.
   This is the only unofficial dependency left; `sidePanel.open()` from a
   content-script message is an officially supported path, demonstrated in
   `functional-samples/cookbook.sidepanel-open`.
2. Cambridge may add bot protection. If it does, the fetch moves to the
   content script of a real Cambridge tab, which is considerably more work.
3. Exact-match highlighting means `resilient` does not highlight
   `resilience`. Accepted. Revisit only if it proves annoying in real use.
