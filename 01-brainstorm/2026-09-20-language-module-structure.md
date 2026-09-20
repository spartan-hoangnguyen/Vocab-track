# Language modules — folder structure

*2026-09-20. Supersedes the "Option A" recommendation in
`2026-09-20-multi-language-korean.md` §3: more languages are planned, so the
registry is the target, not the fallback.*

## The constraint that decides the shape

**No build step.** Scripts load through `<script src>` and the manifest's
`content_scripts` array. So a "module" here is a plain script that registers
itself into a global — which is exactly what `practice-*.js` already does:

```js
PRACTICE.register('quiz', { title, eligible, ask, selfTest });
```

Mirror it. Nothing new to learn, and `test/practice-probe.html` already proves
the pattern is testable.

**And the purity rule.** `lib.js`'s header: *"No Chrome API and no network
here: everything in this file must be callable from test/test.html in a plain
browser tab."* The content script loads `lib.js`; it must not gain a network
dependency. So each language splits the same way the repo already splits — pure
logic separate from the fetch.

## The tree

```
lang/
  lang.js              LANG registry: register(), dictionary(), get(), detect(), list()
  en/
    index.js           pure — isCandidate, match, levels, selfTest
    dictionary.js      network — Cambridge fetch + parseCambridge
  ko/
    index.js           pure — isCandidate, lemma (조사 strip), match, levels, selfTest
    dictionary.js      network — krdict fetch + XML parse

data/
  en/ielts-c1-c2.json
  en/phrasal-verbs.json
  ko/…

tools/
  en/build-ielts-list.py, build-phrasal-list.py, ielts-parse.html
  ko/…
```

`index.js` loads everywhere (content script, panel, dashboard, tests).
`dictionary.js` loads everywhere **except the content script** — it needs a
`DOMParser` and the MV3 CORS bypass, which is the panel, the dashboard, and
`test/test.html` (the `parseCambridge` fixture tests live there). The split is
"not in the content script", not "network".

`tools/install-macos.sh`, `vocab-capture.sh` and `vocab-host.py` are
language-neutral and stay at the root of `tools/`.

**`data/` and the builders move last, or not at all.** The README documents
`data/ielts-c1-c2.json` as the import path and `build-ielts-list.py` writes
there; moving them breaks both for no behavioural gain. Korean files can land
in `data/ko/` while the English ones stay put — asymmetric on disk, which is
ugly, and cheaper than a rename with no payoff.

## The interface

```js
LANG.register('ko', {
  name: 'Korean',
  native: '한국어',
  script: /\p{Script=Hangul}/u,   // how detect() routes a selection
  levels: ['초급', '중급', '고급'], // replaces the CEFR array in dashboard.js:3

  normalise(raw),                 // NFC + whatever the script needs
  isCandidate(word),              // replaces VT.isLookupCandidate
  lemma(word),                    // 책을 → 책. Identity for English.
  match(word, text),              // replaces VT.wordRegex. Returns [{index, length}]
  selfTest()                      // same contract as a practice mode
});
```

```js
LANG.dictionary('ko', {
  lookup(word),                   // → the parsed shape VT.newEntry takes
  href(word)                      // the "Cambridge ↗" link, per language
});
```

Two calls rather than one, so `index.js` stands alone in the content script.

### Routing a saved word to its pack

Needed from step 2 onward, not step 4: `applyHighlights` (`content-script.js:157`)
iterates every saved word, and `practice-fill.js:30` matches *other* words
against a sentence. Both must know which pack each entry belongs to.

```js
LANG.of = (entry) => LANG.get(entry.lang) ?? LANG.detect(entry.word) ?? LANG.get('en');
```

A missing `entry.lang` falls back to script detection and then to English, so
every word already in storage routes correctly with **no migration**.

### `lemma()` — scope, and its ceiling

Called once, in `resolveWord` (`lookup.js:55`): `lang.lemma(lang.normalise(raw))`
becomes `entry.word`, while `context` keeps the surface form the user actually
met. For English it is the identity function.

For Korean, phase 1 is **a 조사 list — nouns only**. `읽었어요 → 읽다` needs
ending-stripping plus re-attaching `다`, and irregular stems (`들어요 → 듣다`)
need real morphology. Verbs are not phase 1; the interface is the same either
way, which is the point of putting it behind `lemma()` now.

**`match()` returning ranges, not a RegExp, is the load-bearing change.**
Korean matching is not expressible as a regular expression, so the seam cannot
be "give me a pattern" — it has to be "find the occurrences". Every current
caller of `VT.wordRegex` either tests, replaces, or iterates matches, so all
three are expressible over a range list.

## What moves out of `lib.js`

| Moves to `lang/en/` | Stays in `lib.js` (language-neutral) |
|---|---|
| `isLookupCandidate` | `schedule` / `FSRS_W`, `diffWord`, `quizOptions`, `shuffled` |
| `wordRegex` | `isLearnable`, `isMastered`, `progressOf`, `suggestFolders`, `forecast` |
| `parseCambridge`, `CAMBRIDGE` | `foldersOf`, `newFolder`, `TOPICS`, `READING`, `STARRED` |
| `medianLevel`'s CEFR order | `youtubeId`, `pageKey`, `timestampOf`, `sourceLink`, `dayKey` |
| | `wordAt`, `tokenise`, `pivotOf`, `holdFor` — RSVP, neutral for now |
| | `newEntry`, `glossOf`, `normaliseWord` (gains `.normalize('NFC')`) |

`medianLevel` and `sentenceAround` stay but take the language, so they read the
scale and the matcher from the pack rather than closing over English.

## Blast radius of the move

34 call sites — but **keeping `VT.*` as thin facades cuts step 1 to about 11.**

```js
VT.isLookupCandidate = (raw) => LANG.detect(raw)?.isCandidate(raw) ?? false;
VT.medianLevel = (entries) => …dispatch through LANG.of…
```

Those two dispatch and every existing caller keeps working unchanged. What
cannot be faced off is `wordRegex → match()`, because the return type changes
from a `RegExp` to a range list — **11 real sites**: `content-script.js:138`,
`practice-fill.js:15,30,42` (+3 in its `selfTest`), `dashboard.js:337,831`,
`sidepanel.js:85`, `lib.js:114,645`, `tools/ielts-parse.html:62`.

Two of those need range helpers worth naming now:

- `dashboard.js:831` blanks the word out of its own context sentence —
  `String.replace` becomes "splice the ranges, right to left" so earlier
  indices stay valid.
- `lib.js:645` `sourceLink` slices a window around the hit for the
  scroll-to-text anchor — it needs the index, which a range list gives directly.

A bonus: the `/g` `lastIndex` hazard the codebase already comments on
(`practice-fill.js:29`, "A fresh regex each time … a reused one keeps
lastIndex") **disappears** — a range list is stateless.

Three things that are easy to miss:

- **`tools/ielts-parse.html`** is served next to a *copy* of `lib.js` by
  `build-ielts-list.py`, and calls `VT.parseCambridge`, `VT.newEntry`,
  `VT.wordRegex`. The builder's copy step must copy the language pack too.
- **9 HTML files load `lib.js`** — 4 test probes, 2 extension pages,
  `test/test.html`, `test/yt-probe.html`, `tools/ielts-parse.html`. Each needs
  the new `<script>` tags, in order: `lib.js` → `lang/lang.js` → `lang/*/index.js`.
  There is no module system, so load order is the dependency graph.
- **`manifest.json` `content_scripts.js`** — same ordering, and
  `web_accessible_resources` is not needed since nothing is fetched at runtime.

## Sequence

Tests stay green at every step.

1. `lang/lang.js` + `lang/en/*` + `LANG.of` and `entry.lang` (defaulted, so no
   migration) — move English across, no behaviour change. `bash test/run.sh` is
   the proof. One honest exception: `test/test.js:33-41` asserts
   `wordRegex('cat')` *is a RegExp* (`.global === true`); those assertions are
   rewritten against `match()`, not just renamed. Everything else passes as-is.
2. `lang/ko/index.js` — the 조사 stripper and `match()`, with `selfTest()`.
   Pure logic, no network, no key. **This is the hard part, and it is testable
   before anything else exists.**
3. `lang/ko/dictionary.js` — MT gloss first (keyless, already verified working),
   krdict swapped in behind the same `lookup()` once a key exists.
4. The toggle, per-language levels, practice `eligible`, the Cambridge-shaped
   templates.

Step 1 is a refactor with a green suite on both sides of it. Step 2 is the only
step where something genuinely new has to be got right.

---

## Step 1 — done, 2026-09-20

674 checks, 0 failures, `test/run.sh` exit 0. 20 files touched, nothing
committed.

**Two deliberate behaviour changes**, both improvements, neither a side effect:

1. `normaliseWord` NFC-folds. A macOS Quick Action capture that used to land
   under a decomposed key now lands under the composed one — the same key the
   extension writes.
2. `resolveWord` runs `pack.lemma(pack.normalise(raw))` on the **known-word
   path too**, not only on a new word. Identity for English, so nothing moves
   today; once the Korean lemma exists, a second click on `책을` correctly
   finds the `책` already saved instead of creating a twin.

**One bug fixed that the tests could not have caught.** `medianLevel`'s default
scale came from `LANG.of(entries[0])`, and `dashboard.js` passes an unfiltered
list — one Korean word at the head of it would have scored every CEFR level
against `초급/중급/고급` and reported no median at all. `dashboard.js:69` now
passes the scale explicitly. Fixtures are all English, so no assertion would
ever have failed.

**Still English-only, left for step 4:** `dashboard.js:3` `LEVELS` and its two
readers (`:77` bars, `:1405` stats series), `sidepanel.js:46`'s "Cambridge
lookup failed" by name, and `speak()`'s `en-GB`/`en-US` in `lookup.js`.

**Gone for free:** the `/g` `lastIndex` hazard, along with the comment at
`practice-fill.js:29` that used to warn about it.
