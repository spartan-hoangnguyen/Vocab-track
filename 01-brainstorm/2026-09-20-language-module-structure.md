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

*All three are done — see Step 4 below. The line stays as it was written so
the ledger reads as a record rather than as a plan that was quietly edited.*

**Gone for free:** the `/g` `lastIndex` hazard, along with the comment at
`practice-fill.js:29` that used to warn about it.

---

## Step 2 — done, 2026-09-20

`lang/ko/index.js`: the 조사 strip table, `lemma()`, `match()`, `isCandidate()`,
`levels` (초급/중급/고급) and a `selfTest()` that is the bulk of the file.

The design held. The one thing the plan did not have is the guard that makes it
work: **the allomorph agreement test.** Every true 조사 pair is chosen by the
받침 of the syllable in front of it — 을 after a consonant, 를 after a vowel —
so "does this particle's allomorph agree with the stem's shape" is five lines
of arithmetic on the Hangul block and a real-linguistics filter on
over-stripping. It saves 사과, 가을, 마을, 아이, 나이 and 국가 for free. The
second guard is a per-particle `minStem`, for the five particles with no pair
(도, 만, 께, 랑, 로), which saves 지도, 포도, 함께, 자랑, 도로, 별로 and 서로.

Neither guard can be the only one, and together they still leave five classes
of miss. They are written into `selfTest()` as the values they actually produce
— **the wrong answer IS the expected value** — so the ceiling is a fact under
test rather than a comment that can rot:

1. **-이 nouns.** 이 is both the subject marker and a productive nominalizer,
   and 종/고양/어린 all carry a 받침, so the allomorph agrees. 종이 → 종,
   고양이 → 고양, 어린이 → 어린. Nothing structural separates 종이 from 책이.
2. **-도 nouns.** Same shape, 도 being a productive '-degree' suffix:
   만족도 → 만족.
3. **Verbs, entirely.** Out of scope by design, and a miss is the good case —
   the dictionary form ends in 다 and never reaches the surface, so 읽었습니다
   comes back whole and the MT gloss still answers. The exception is the
   vowel-stem attributive: 하는 → 하, 보는 → 보, because 는 wants an open stem
   and 하/보 are open. Consonant stems escape by luck (먹는, 있는).
4. **Sino-Korean -과/-가.** 2-syllable nouns in -과 on a closed first syllable
   and -가 on an open one: the allomorph agrees, so every test this pack has
   reads them as stem + particle. 결과 → 결, 학과 → 학, 휴가 → 휴, 화가 → 화,
   and 고속도로 → 고속도 for -로 past `minStem`. `minStem` 2 is not the trade:
   it breaks 책과 on one side and 차가/비가 on the other, which are the real
   particles on real 1-syllable nouns.
5. **-밖 compounds.** 창밖에 → 창, 뜻밖에 → 뜻, the price of 밖에 at `minStem`
   1. `minStem` 2 only swaps which pair breaks — 나밖에 → 나 and 하나밖에 →
   하나 are correct today, and 창밖+에 and 나+밖에 are the same three syllables
   with the same shapes, so no structural test separates them. min 1 wins on
   counts: -밖 compounds are a closed handful.

`match()` is looser than `lemma()` on purpose and carries its own residue: it
does not apply `minStem`, so a 1-syllable saved word still collides with a
2-syllable noun whose tail is a pairless particle — 별로, 지도, 하나, 회의,
주의, 도로, 서로, 함께, 포도, and 자랑, where 랑 is paired but 자 is open so
the shapes genuinely agree. That is a recall tradeoff, not a bug: `match()`
already knows the word it is looking for, and a saved 별 should highlight
inside 별로.

`lemma()` is **one pass**, so an unlisted particle stack loses only its last
particle: 책에서만 → 책에서. 만 is what the single pass reaches first. The 11
common stacks are literal table entries rather than a stacking loop.

**Upgrade path, for all of the above:** garu-ko — 1.7MB WASM, MIT, claimed
F1 96.0 — is what real morphology costs. Cheaper first step, once a krdict key
exists: retry the surface form when krdict answers not-found on the lemma.

## Step 3 — registered, not built, 2026-09-20

`lang/ko/dictionary.js` exists and is fifteen lines. It supplies `name`,
`base` and `href` and a `lookup()` that returns four nulls.

**Registering a stub is not the neutral choice, it is the correct one.** Left
out, `lookup.js`'s fallback sets `failed: no dictionary registered for ko`, and
`sidepanel.js:44` renders that under a bold "Cambridge lookup failed." on every
Korean word — the wrong dictionary and the wrong category, since a pack that
was never built is not a call that failed. A missing pack also drops the full
entry link from all three surfaces, which guard on `if (dict)`.

The `href` is the **mobile Vietnamese** krdict interface, and that is not a
preference. Probed live with a Chrome UA on 2026-09-20: `/m/vie/searchResult`
answers 200 with the real 책 entry and its Vietnamese glosses in 68KB, while
every desktop path either 404s or serves krdict's own 500 page. Accepted cost:
a phone layout in a desktop tab.

**What a Korean word therefore carries today: the MT gloss and nothing else.**
No level, no pronunciation, no definition, no senses, no audio. The Vietnamese
comes from the same keyless endpoint English uses — verified `sl=ko&tl=vi` on
책 returns "sách" — which means the one unofficial dependency this repo already
had is now the *only* source of meaning for a whole language rather than a
second opinion beside Cambridge. krdict goes behind the same `lookup()` once a
key exists, reading a flat `krdictKey` off `chrome.storage.local` **inside** the
function; a top-level read would throw in `test/test.html`, which has no
`chrome`.

## Step 4 — done, 2026-09-20

The toggle is a segmented control in the dashboard's top bar (`#lang-seg`),
built from `LANG.list()` so a third pack needs no markup, and hidden entirely
while only one pack is registered — a segmented control with one segment is not
a choice. `setLang()` writes `chrome.storage.local.lang` and nothing else;
`refresh()` re-reads it, because the toggle was never the only way that key
moves (`dashboard.js:575` writes it too, when a lookup saves into the other
language).

All three step-1 leftovers are closed:

- **`LEVELS`** is gone. Every reader takes `LANG.get(activeLang).levels`, so
  the overview bars and the statistics series read 초급/중급/고급 in Korean.
- **"Cambridge lookup failed"** is now `${dict?.name ?? 'Dictionary'} lookup
  failed` (`sidepanel.js:52`), and the review card's full-entry link writes its
  label next to its href in one place (`dashboard.js:940`) so the two cannot
  name different dictionaries. The line hides for a language with no dictionary
  at all.
- **`en-GB`/`en-US`** are gone from `lookup.js`. A pack declares its voices and
  `speak()` reads `voice.bcp47`; the default registration gives a pack one
  voice labelled with its own native name, so the review's Voice picker hides
  itself on Korean rather than offering a UK/US choice that is a Cambridge fact
  and not a universal one.

Also per-language: the typing box's placeholder, written per card rather than
per page so it is right on a Korean card inside an English session; the
`maskContext` blanking; and practice `eligible()`, which now asks the entry's
own pack instead of an ASCII regex.

### The Writing view is deliberately NOT language-gated

**This is a change from the plan, and the reason is worth more than the
consistency would have been.**

Every other surface in the dashboard filters by `activeLang`, because every
other surface reads the word store, and a word in the store belongs to a
language. The Writing view does not. LanguageTool checks the prose *you type
into someone else's textarea* — third-party text on a third-party page — which
never enters the store and has no `entry.lang` to filter on. Gating it on the
toggle would mean flipping to Korean emptied a list of English writing
mistakes that are still exactly as true as they were a second earlier.

So `service-worker.js:141` pins `language: 'en-US'` and says why. LanguageTool
has no Korean at all, so there is nothing to dispatch to even if the store
could answer. `language: 'auto'` is the one-word change the day that stops
being true.

### What was deliberately not done

- **`data/ko/` and `tools/ko/`.** The tree at the top of this document has
  them; the note under it ("data/ and the builders move last, or not at all")
  is what actually happened. There is no Korean word list to put there, and
  moving the English files would break the README's documented import path and
  `build-ielts-list.py`'s output path for no behavioural gain.
- **A krdict key**, and therefore everything in step 3 above.
- **`tools/ielts-parse.html`'s staging** still copies `lib.js` and the whole
  `lang/` tree by hand, listed in `stage()` rather than read off the page's
  `<script>` tags. A fourth top-level script means one more line there.
  Parsing the page to avoid that is more machinery than the problem.
- **Contexts already saved in NFD.** `normaliseWord` NFC-folds from step 1 on,
  and the context fold landed with the Korean pack, but there is no migration.
  An old NFD context stays unmatched — and re-looking-up the word does not fix
  it, since `lookup.js` only fills a context when the entry has none. Re-saving
  the word is the only way back.
- **A guard on the first `startReview(null)`.** `queueLang` starts at
  `LANG.FALLBACK`, so a profile with `lang: 'ko'` stored runs one
  `startReview(null)` on the first `refresh()` at page load. Harmless — the
  review view is hidden, and both the nav link and the Review button call
  `startReview()` again on the way in — but it pre-sets `#rv-card`'s
  `dataset.word`, so that user's first card does not replay the 'fresh' entry
  animation. The guard costs more than the animation is worth.
- **Deduping the double `refresh()`.** In real Chrome one toggle press runs
  `refresh()` twice — `setLang`'s own call, and the `storage.onChanged` it
  fires. Only the queue rebuild is deduped, which is the part that would have
  been visible.
- **Rebuilding the queue on a word-map change.** The rebuild is keyed on the
  language alone. Another tab saving a word, or an import, still leaves an
  in-flight queue untouched — exactly as before, and deliberately: rebuilding
  mid-session on every storage write would throw away a half-answered card.
