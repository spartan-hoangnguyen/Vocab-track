# Adding Korean — research, not a plan yet

*2026-09-20. Research phase. Nothing here is implemented.*

## The one-sentence answer

The dropdown is an afternoon. What costs weeks is that **six pieces of
this codebase encode "a word is a run of `[a-z]` with ASCII word boundaries
around it"**, and every one of them fails silently — not loudly — on Hangul.
Adding `lang` to an entry is easy; making Korean *matching* work is the
project.

---

## 1. What is actually hardcoded to English

Verified by reading the files and running the regexes in `node`. Each row is
**Confirmed** unless marked.

| # | Place | What breaks on Korean | Fails how |
|---|---|---|---|
| 1 | `lib.js:23` `isLookupCandidate` — `/^[a-z]+(-[a-z]+)*$/` | Rejects every Hangul selection | Silent: the 📘 button never appears |
| 2 | `lib.js:29` `wordRegex` — `\b…\b` | `\b` is an **ASCII** `[A-Za-z0-9_]` boundary. `/\b책\b/` never matches `나는 책을 읽다` | Silent: zero matches |
| 3 | `lookup.js:15` `fetchCambridge` — `/dictionary/english/<w>` | Wrong dictionary | Returns `notFound`, word is never saved |
| 4 | `lookup.js:39` `fetchVietnamese` — `sl=en&tl=vi` | Asks Google to read Hangul as English | Garbage or null gloss |
| 5 | `lookup.js:112` `speak` — `en-GB`/`en-US` | Wrong voice | Reads Hangul with an English voice, or silence |
| 6 | `lib.js:667` `medianLevel` + `dashboard.js:3` `LEVELS` | CEFR A1–C2 does not exist for Korean; krdict grades 초급/중급/고급 | Median shows `—`, all bars land in the `—` bucket |
| 7 | `service-worker.js:141` `language: 'en-US'` | **LanguageTool has no Korean at all** (Confirmed against its `/v2/languages`) | Korean text scored as broken English |
| 8 | `lib.js:14` `normaliseWord` — no `.normalize()` | macOS hands back **NFD** Hangul: `'책'.normalize('NFD').length === 3` and `!== '책'` | Silent: the same word saved twice under two keys |

### Why #2 is the whole problem

```js
new RegExp('\\b책\\b','gi').test('나는 책을 읽다')   // false
/(?<!\p{L})책(?!\p{L})/u.test('나는 책을 읽다')      // false — 을 is a letter
'책상'.startsWith('책')                              // true  — wrong word
```

The obvious Unicode fix **also fails**, because Korean is agglutinative: the
noun 책 appears as 책을 / 책이 / 책은 / 책에서, and the verb 먹다 appears as
먹었습니다 / 먹어요 / 먹는. There is no regex that gets this right. Matching
Korean means *"an eojeol that begins with the lemma, followed by a particle or
an ending"* — a 조사 list, not a character class. And irregular verbs
(듣다 → 들어요, 춥다 → 추워요) defeat even that, because the stem itself changes.

**Everything downstream of `wordRegex` is therefore dead on Korean until this is
solved:** page highlighting (`content-script.js:138`), fill-in-the-blank
(`practice-fill.js:15,29,42`), context blanking (`dashboard.js:831`),
`sentenceAround` (`lib.js:115`), the side panel's context highlight
(`sidepanel.js:85`), and `sourceLink`'s scroll-to-text anchor.

### The entry templates are Cambridge-shaped

Separate from matching, and easy to miss: the render paths assume a Cambridge
entry, not a dictionary entry in general.

| Place | Assumption |
|---|---|
| `dashboard.html:105` `rv-voice` | A UK/US accent picker. Korean has no accent pair; the control is meaningless. |
| `dashboard.html:160` `rv-cam` | Hardcoded "Cambridge ↗". A dead link for a Korean word — should point at krdict. |
| `dashboard.html:123` `rv-ipa` | IPA. krdict gives `pronunciation` (Hangul), not IPA. |
| `sidepanel.js:29-40` + `renderProns`/`renderSenses`/`renderChips` | Level badge, UK+US prons, senses-with-levels, synonym chips — all Cambridge fields. |
| `sidepanel.js:46` | The failure warning says "Cambridge lookup failed" by name. |
| `practice-speak.js:139` | `r.lang = 'en-GB'` — this is Speech**Recognition**, a *different* call site from `speak()` in `lookup.js:112`. Both need the language. |

Open design question this raises: does a Korean word fit `newEntry`'s existing
shape — reusing `ipa` for krdict's `pronunciation`, leaving `senses[].level`
and `synonyms` empty — or does it need its own? Reusing the field names is
much lazier and keeps export/import unchanged; the cost is a field called
`ipa` that does not hold IPA.

### Smaller ones, same file sweep

- `practice-listening.js:12` `eligible` calls `isLookupCandidate` → excludes
  every Korean word from Listening by construction.
- `lib.js:260` `diffWord` runs LCS over NFC characters. One wrong jamo marks
  the **whole syllable** wrong (먹 vs 멎 = 1 char differing, not 1 of 3).
  Usable, just blunt. *(Assumption: acceptable; jamo-level diff is a later nicety.)*
- `lib.js:567` `pivotOf` (RSVP focal letter) is tuned to Latin letter counts.
  Hangul syllable blocks are ~2x wide and carry far more information per
  character, so the ORP maths and the 300 WPM default are both wrong.
  *(Assumption — no data on Korean RSVP rates.)*
- `reader.js:21` article extraction scores by prose; its junk-word list
  (`comment|sidebar|share`) is English class names, which most Korean sites
  also use. *(Likely fine.)*
- `manifest.json` `host_permissions` needs whatever new dictionary host is chosen.
- `test/run.sh` — five probe pages, all English fixtures. Korean needs its own
  parser fixture and at least one matching test.

### Not broken, worth knowing

- `normaliseWord`'s `.toLowerCase()` is a no-op on Hangul — harmless.
- `sentenceAround` splits on `[.!?]` — Korean uses the ASCII full stop, so this
  works.
- `wordAt` uses `/[\p{L}\p{N}'’-]/u` — **already Unicode-aware**, so the YouTube
  caption click path picks up 책을 as one token correctly. It is
  `isLookupCandidate` immediately after (`content-script.js:294`) that rejects it.
- IME: `practice-blast.js:207` and `practice-speak.js:175` already guard
  `e.isComposing`. The review form (`dashboard.js:1115`) and
  `practice-listening.js:59` use `submit` rather than `keydown` and are
  *probably* safe, but **Unknown** until tested with a real Korean IME — an
  Enter that commits a Hangul candidate must not also grade the card.
- Chrome's double-click word selection on Korean uses ICU dictionary
  segmentation. Whether it hands back 책을 or 책 is **Unknown** and worth ten
  minutes with a real page — it changes how much stripping the extension owes.

---

## 2. Where the language data comes from

### The gloss: already solved — **Confirmed**

`fetchVietnamese` needs one parameter changed. The same keyless endpoint the
extension already uses handles Korean source:

```
GET translate.googleapis.com/translate_a/single?client=dict-chrome-ex&sl=ko&tl=vi&dt=t&q=책
→ [[["sách","책",null,null,10]],null,"ko",null,null,null,null,[]]
```

`sl=en` → `sl=ko`, same response shape, same parse (`data[0][0][0]`). It
inherits the same known limit: unofficial, keyless, will break one day, and the
replacement goes behind that one function.

### The dictionary: krdict looks right — **Confirmed live, one blocker**

The National Institute of Korean Language's *Korean Learner's Dictionary* has a
real open API, unlike Cambridge which this project scrapes. Probed today:

```
GET https://krdict.korean.go.kr/api/search?key=<KEY>&q=책&translated=y&trans_lang=1
→ <?xml …?><error><error_code>020</error_code><message>Unregistered key</message></error>
```

**Confirmed:** the endpoint is live, it answers **XML**, and it needs a
registered key — free, but a key nonetheless, which is the first thing in this
project that is not keyless. It also **rejects non-browser user agents**
(`400 Request Blocked` from curl, fine with a Chrome UA) — a non-issue inside
an extension, where the fetch carries Chrome's own UA.

XML means `DOMParser`, which means the call must live in the side panel or the
dashboard, **exactly where `fetchCambridge` already lives** — the same reason
the README gives for keeping network out of the service worker. The
architecture already accommodates this.

Why krdict over the alternatives: it is a *learner's* dictionary, so entries
carry a difficulty grade and multilingual translations rather than the
encyclopaedic definitions of the Standard Korean Dictionary — and it is an API,
so a Korean word-list builder in `tools/` would skip the headless-Chrome parse
step `build-ielts-list.py` needs entirely.

**Not** Cambridge `english-korean`: that is an English headword with a Korean
gloss — the wrong direction, for Koreans learning English.

**What one call returns** — `word`, `pronunciation`, `pos` (명사/동사/…),
`word_grade`, `sense/definition`, and `translation` blocks selected by
`trans_lang`. Limit is ~50,000 calls/day per key.

**Likely** (from the docs, not tested): `trans_lang` **7 = Vietnamese**,
**1 = English**, `0 = all`. The live call that confirmed the response shape
used `6` (Mongolian), so the Vietnamese code itself is unverified — one call
with a real key settles it. Also **Unknown**: how many headwords actually carry
a Vietnamese translation. Your English list tracks exactly this figure
(1,937 of 1,945 have a gloss); expect to measure the same here.

So the plan is not "dictionary gloss instead of MT" but **dictionary gloss
first, MT fallback** — which is what `resolveWord`'s existing
`Promise.all([dictionary, fetchVietnamese])` already does. Point the second
one at `sl=ko` and the shape is unchanged.

One correction to carry forward: an MV3 **service worker** fetch does bypass
CORS with `host_permissions`, but that does not move this call into the worker —
the worker has no `DOMParser`, and krdict answers XML. It stays in the panel,
for the same reason the README already gives for Cambridge.

### The finding that re-phases the plan — **Confirmed**

**krdict matches headwords exactly.** Querying `했어요` does not find `하다`;
querying `책을` does not find `책`.

This moves particle-stripping out of "phase 2, for highlighting" and into
**phase 1, or lookup does not work at all** — because a word selected on a
real Korean page is almost always inflected. The two uses are still separable:

- *Lookup* needs "strip the particle, ask krdict" — one pass, one word, and a
  failed strip just means a not-found the user sees immediately.
- *Highlighting* needs "does this saved lemma occur in this page text" — every
  word against every text node, failing silently. Much harder, still phase 2.

### The level scale: krdict's `word_grade`, not TOPIK

`word_grade` is **초급 / 중급 / 고급** (beginner/intermediate/advanced) — three
tiers, API-native, free. TOPIK 1–6 is the scale people quote, but no open
licensed TOPIK word list was found (community CSVs and Anki decks exist with
unclear licensing — do not bundle one). The informal 초급≈TOPIK 1–2 mapping is
an **Assumption**; the two bodies are separate and publish no equivalence table.

So `LEVELS` becomes per-language: `['A1'…'C2']` for English, `['초급','중급','고급']`
for Korean, and `medianLevel` takes the order from the language rather than
closing over one.

### Ruled out

| Source | Why not |
|---|---|
| **Cambridge korean-english** | No such headword dictionary exists — only `english-korean` (English headword → Korean gloss, wrong direction) and `/translate/`, a sentence translator. **Drop Cambridge for Korean entirely.** |
| **Naver dictionary** | No public API, scrape-only, ToS-grey. krdict already gives Vietnamese, so there is nothing to gain. |
| **Papago** | Paid, no free tier. |
| **stdict** (Standard Korean Dictionary) | Monolingual adult reference — no `word_grade`, no translations. Only worth it as a fallback for headwords krdict lacks. |
| **Wiktionary** | Free and keyless, but HTML-section parsing with no level field. Last resort. |

### Korean text-to-speech, romanization, grammar

- **TTS:** `lang = 'ko-KR'` on `SpeechSynthesisUtterance` is **Likely** fine on
  macOS Chrome but OS-version dependent (**Unknown** whether a `ko` voice is
  always preinstalled). Cheap guard: filter `getVoices()` for `lang.startsWith('ko')`
  at runtime and, if empty, point at System Settings — the same check is worth
  having for any locale. krdict *may* carry per-entry audio (its CSP references
  `krdicmedia.korean.go.kr`) but the field was not confirmed — **Unknown**,
  one live `/api/view` call settles it.
- **Romanization:** `es-hangul` (MIT, toss/es-hangul) has `romanize()` plus the
  jamo `disassemble`/`assemble` and `josa()` helpers the particle logic wants —
  one small dependency covering both. Its strict RR-2000 correctness on liaison
  edge cases is **Likely, unverified**.
- **Grammar check:** **LanguageTool has no Korean at all** — Confirmed against
  `api.languagetool.org/v2/languages`, zero `ko` entries. There is no clean
  replacement: the 부산대 checker everyone wraps has no published ToS for
  third-party use and its API has been frozen since the 2020s over copyright
  disputes. **Hide the Writing view when the language is Korean.** That is a
  scope cut, not a gap to fill.

### Lemmatization, staged

1. **Now:** a 조사 suffix list (을/를, 이/가, 은/는, 에서, 에게, 으로/로, 의, 도, 만 …)
   plus `es-hangul` for jamo work. Near-zero cost, covers noun particles, which
   is most of what you select while reading.
2. **Later, only if the misses bite:** `garu-ko` — 1.7MB WASM, MIT, claims
   F1 96.0, real morphological analysis including irregular conjugation. This is
   the named upgrade path. (`kiwi-nlp` is 5.6MB; `mecab-ko-wasm`'s bindings are
   small but its dictionary is tens of MB; KoNLPy/Okt need a JVM and cannot run
   in a browser at all.)

---

## 3. Three architectures

### A — `entry.lang`, one store, script auto-detect *(recommended)*

Add `lang: 'en' | 'ko'` to the entry; a missing `lang` reads as `'en'`, so
**no migration and every existing export stays valid**. English and Korean
headwords cannot collide in the flat `words` map — different scripts — so the
map stays flat.

The dropdown is a **dashboard filter** (one `lang` key in `chrome.storage`),
not a mode switch. Lookups detect the script from the selection itself:

```js
isLookupCandidate(raw) {
  const w = VT.normaliseWord(raw);
  return /\p{Script=Hangul}/u.test(w) ? VT.ko.isCandidate(w) : /^[a-z]+(-[a-z]+)*$/.test(w);
}
```

so the 📘 button works on a Korean page without toggling first, and reading a
Korean page while the dashboard is set to English does the right thing anyway.

**The dropdown itself is cheap, and the code is already shaped for it.** The
dashboard loads every word once, in `refresh()` (`dashboard.js:40`), into a
module-level `words` that `render()` fans out to overview, All words, folders,
streak, stats and practice. So **one filter at that single load point** covers
all six views. The only other gate is `startReview` (`dashboard.js:804`), which
reads `Object.values(words)` itself — and it genuinely needs it, because a
mixed English/Korean queue would make you switch IME between cards.

Two call sites, then. Placement: the `.top` bar beside the theme button
(`dashboard.html:35-50`). For two languages a segmented **EN | 한** toggle is
lazier and faster to hit than a `<select>`; it becomes a dropdown at three.

- **Cost:** low. ~8 branch points + a `VT.ko` module.
- **Risk:** the branches multiply if a third language arrives.

### B — Separate namespaces (`words:en`, `words:ko`)

Cleaner isolation. Every read site changes, import/export format changes, a
migration is needed, and cross-language stats become impossible for free.
**Not worth it** — the flat map has no collision problem to solve.

### C — Full language-pack registry

`LANGS = { en: {...}, ko: {...} }` with `isCandidate / match / lemma /
fetchEntry / levels / speak / romanize` and the core calling only through it.
The right shape if a third and fourth language are coming. Today it is an
interface with two implementations, one of which does not exist yet.

**Recommendation: A now, refactored into C if and only if a third language is
added.** A's branch points are exactly C's interface, so A is not wasted work —
it is C discovered rather than guessed.

---

## 4. Phasing — what is an afternoon and what is not

| Phase | Work | Honest size |
|---|---|---|
| **0** | `normaliseWord` → `.normalize('NFC')`. Correct for English too, zero risk. | 1 line |
| **1 — usable** | Register a krdict key. `entry.lang`; script detect in `isLookupCandidate`; **particle stripping** (lookup does not work without it); krdict fetch + XML parse in the panel; `word_grade` as the level; per-language `LEVELS`/`medianLevel`/`ov-bars`; `lang='ko-KR'` in `speak` with a `getVoices()` guard; the dropdown; Writing view hidden when `lang=ko`. Review's typing card works as-is with a Korean IME. | days |
| **2 — the hard one** | Korean *matching*: eojeol-prefix + particle match replacing `wordRegex` behind a `VT.match(lang, word)` seam. Unlocks highlighting, fill-blank, context blanking, `sourceLink`. | the real work |
| **3** | Per-language practice `eligible`; a Korean word list in `data/` (krdict is an API, so the builder skips headless Chrome entirely); `romanize()` on the card; RSVP tuned or disabled for Korean. | later |

Phase 1 ships something you would actually use: select a Korean word, get a
definition and a Vietnamese gloss — from the dictionary where it has one,
machine translation where it does not — with the sentence you met it in, and
review it as a flashcard. Phase 2 is what makes it feel native.

The `ponytail:` ceiling, written down now so it is a known limit and not a bug
report later: **particle stripping is a heuristic. Regular nouns match; verb
conjugation and irregular stems (듣다 → 들어요, 춥다 → 추워요) do not.** Named
upgrade path: `garu-ko`, 1.7MB WASM — and only if the miss rate actually bites.

---

## 5. Open questions

1. Chrome's double-click on Korean: 책을 or 책? Decides how much stripping is ours.
2. IME Enter on the review card — does it grade the card while committing a syllable?
3. Vietnamese gloss (`trans_lang=7`) or English (`1`)? krdict returns both in
   one call, so this can be a setting rather than a decision.
4. Does the study language belong in export/import as a top-level field?
5. Does krdict carry per-entry audio, or is TTS the only pronunciation?
6. A free API key is the first non-keyless thing in this project. It has to
   live somewhere — a settings field the user pastes into, or committed? The
   README's "no accounts, no server" promise survives either way, but only the
   settings field survives the repo being shared.
