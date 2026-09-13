# Vocab-track Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A personal Chrome extension that looks up an English word on the page, shows its Vietnamese translation, Cambridge CEFR level, IPA and pronunciation, saves it as an SM-2 flashcard, and highlights saved words when the page is revisited.

**Architecture:** MV3 extension, three contexts. The content script owns the page: it shows a floating button on a one-word selection and paints highlights with the CSS Custom Highlight API. The service worker only opens the side panel and hands the word over through `chrome.storage.session`. The side panel does all network and parsing work, because it is the only context with both a DOM and the CORS bypass from `host_permissions`. All pure logic lives in `lib.js`, which loads in every context and in the test page.

**Tech Stack:** Plain JavaScript, no build step, no dependencies, no framework. Chrome MV3 APIs: `storage`, `sidePanel`, `runtime`. Tests are `console.assert` in a browser page served by `python3 -m http.server`.

**Spec:** `docs/superpowers/specs/2026-09-13-vocab-track-design.md`

## Global Constraints

- `manifest_version: 3`, `minimum_chrome_version: "116"`.
- No build step, no npm dependencies, no framework. Plain `.js` files loaded directly.
- Permissions are exactly `storage` and `sidePanel`. Do not add `contextMenus`, `tabs`, or `activeTab`.
- `host_permissions` are exactly `https://dictionary.cambridge.org/*` and `https://translate.googleapis.com/*`.
- Never `fetch` from `content-script.js`. Content scripts do not get the MV3 CORS bypass.
- Never parse HTML in `service-worker.js`. Service workers have no `DOMParser`.
- Every parsed field is independently optional. A missing field is `null` and renders as `—`. A missing field never aborts a lookup.
- No silent `catch`. Every caught error is logged with the word that caused it before any fallback runs.
- `reference/` is gitignored. Read samples from it; never copy code out of it.
- Do not copy Apache licence headers from the samples into any project file.
- Commit messages use `type(scope): subject`. No `Co-Authored-By` line, no `Claude-Session` line, no generated-with footer.

## File Structure

| File | Responsibility |
|---|---|
| `manifest.json` | MV3 manifest: permissions, registrations, Chrome floor |
| `lib.js` | All pure logic. No Chrome API, no network. Defines the global `VT`. |
| `content-script.js` | Floating button on selection; applies highlights |
| `service-worker.js` | Opens the side panel, writes the handoff key |
| `sidepanel.html` | Markup for the Lookup, Words and Review views |
| `sidepanel.js` | Fetch, parse, translate, storage, render, review |
| `test/test.html` | Loads `lib.js` and `test/test.js` |
| `test/test.js` | `console.assert` checks for every `VT` function |
| `test/fixtures/*.html` | Saved Cambridge pages: `resilient`, `happy`, `ubiquitous` |

`lib.js` exists so the parser, the scheduler and the matcher can be tested without Chrome. It attaches one global, `VT`, and is listed before the consuming script everywhere it is used: in the manifest's content-script `js` array, and in `<script>` tags in `sidepanel.html` and `test/test.html`. Content scripts cannot be ES modules, which is why this is a global rather than an `export`.

**The `VT` interface, defined in Task 1-3 and used by every later task:**

```js
VT.CAMBRIDGE                      // "https://dictionary.cambridge.org"
VT.normaliseWord(raw)             // string -> string (trimmed, lowercased)
VT.isLookupCandidate(raw)         // string -> boolean
VT.wordRegex(word)                // string -> RegExp (global, case-insensitive, word-bounded)
VT.parseCambridge(html)           // string -> { level, ipa, def, audio }, each string|null
VT.sm2(card, quality)             // ({ease,interval,reps}, 0..5) -> {ease,interval,reps,due}
VT.newEntry(word, parsed, vi, url)// -> full storage entry (see spec "Data")
```

---

### Task 1: Test harness and word-matching primitives

**Files:**
- Create: `lib.js`
- Create: `test/test.html`
- Create: `test/test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `VT.CAMBRIDGE`, `VT.normaliseWord(raw)`, `VT.isLookupCandidate(raw)`, `VT.wordRegex(word)`. Every later task depends on `VT` existing as a global object.

- [ ] **Step 1: Write the failing test**

Create `test/test.html`:

```html
<!doctype html>
<meta charset="utf-8">
<title>Vocab-track tests</title>
<body><pre id="out">running…</pre>
<script src="../lib.js"></script>
<script src="test.js"></script>
```

Create `test/test.js`:

```js
let failures = 0;
const log = [];

function check(name, cond, detail) {
  if (cond) {
    log.push('PASS  ' + name);
  } else {
    failures++;
    log.push('FAIL  ' + name + (detail ? '  -> ' + detail : ''));
  }
}

function eq(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// --- normaliseWord
eq('normalise trims', VT.normaliseWord('  Resilient '), 'resilient');
eq('normalise lowercases', VT.normaliseWord('HAPPY'), 'happy');

// --- isLookupCandidate
check('accepts a plain word', VT.isLookupCandidate('resilient'));
check('accepts a hyphenated word', VT.isLookupCandidate('well-known'));
check('accepts mixed case', VT.isLookupCandidate('Ubiquitous'));
check('rejects two words', !VT.isLookupCandidate('very resilient'));
check('rejects a single letter', !VT.isLookupCandidate('a'));
check('rejects an empty string', !VT.isLookupCandidate(''));
check('rejects digits', !VT.isLookupCandidate('covid19'));
check('rejects punctuation', !VT.isLookupCandidate('resilient.'));
check('rejects over 40 chars', !VT.isLookupCandidate('a'.repeat(41)));

// --- wordRegex
const re = () => VT.wordRegex('cat');
check('matches the bare word', re().test('a cat sat'));
check('matches capitalised at sentence start', re().test('Cat sat'));
check('matches before punctuation', re().test('the cat.'));
check('matches possessive stem', re().test("the cat's bowl"));
check('does not match inside category', !re().test('category'));
check('does not match inside concatenate', !re().test('concatenate'));
check('does not match inside bobcat', !re().test('bobcat'));
eq('is global', VT.wordRegex('cat').global, true);

document.getElementById('out').textContent =
  log.join('\n') + `\n\n${failures} failure(s), ${log.length} check(s)`;
```

Create `lib.js` containing only the global, so the page loads and the tests fail rather than erroring on `VT is not defined`:

```js
// Pure logic shared by the content script, the side panel and the test page.
// No Chrome API and no network here: everything in this file must be callable
// from test/test.html in a plain browser tab.
const VT = {};
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from the repository root:

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000/test/test.html`.

The file `://` protocol is not usable: Task 2 fetches fixtures, and `file://` blocks that. Use the server from the start so the command never changes.

Expected: the page shows an uncaught `TypeError: VT.normaliseWord is not a function`, or the browser console does. Nothing passes.

- [ ] **Step 3: Write the minimal implementation**

Replace the body of `lib.js`:

```js
// Pure logic shared by the content script, the side panel and the test page.
// No Chrome API and no network here: everything in this file must be callable
// from test/test.html in a plain browser tab.
const VT = {
  CAMBRIDGE: 'https://dictionary.cambridge.org',

  normaliseWord(raw) {
    return String(raw ?? '').trim().toLowerCase();
  },

  // A selection worth offering a lookup for: one word, letters and inner
  // hyphens only, 2 to 40 characters. Deliberately rejects digits and
  // punctuation so the button does not appear on code, prices or dates.
  isLookupCandidate(raw) {
    const word = VT.normaliseWord(raw);
    return /^[a-z]+(-[a-z]+)*$/.test(word) && word.length >= 2 && word.length <= 40;
  },

  // Word-bounded and case-insensitive, so "cat" never lights up inside
  // "category". Exact match only: "resilient" does not match "resilience".
  // Stemming is deliberately out of scope.
  wordRegex(word) {
    const safe = word.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
    return new RegExp(`\\b${safe}\\b`, 'gi');
  }
};
```

Note the `g` flag: `RegExp.prototype.test` advances `lastIndex` on a global regex, so each assertion in the test calls `VT.wordRegex('cat')` afresh rather than reusing one instance. Task 6 relies on `g` to find every occurrence in a text node.

- [ ] **Step 4: Run the tests to verify they pass**

Reload `http://localhost:8000/test/test.html`.
Expected: every line reads `PASS`, and the last line reads `0 failure(s), 19 check(s)`.

- [ ] **Step 5: Commit**

```bash
git add lib.js test/test.html test/test.js
git commit -m "feat(lib): add word normalisation, candidate check and match regex"
```

---

### Task 2: Cambridge parser

**Files:**
- Modify: `lib.js`
- Modify: `test/test.js`
- Use: `test/fixtures/resilient.html`, `test/fixtures/happy.html`, `test/fixtures/ubiquitous.html`

The three fixtures are already committed. They were saved on 2026-09-13 with a browser User-Agent. To refresh one:

```bash
curl -s -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36" \
  "https://dictionary.cambridge.org/dictionary/english/resilient" -o test/fixtures/resilient.html
```

**Interfaces:**
- Consumes: `VT` from Task 1.
- Produces: `VT.parseCambridge(html)` returning `{ level, ipa, def, audio }`, each `string | null`. `audio` is an absolute URL. Task 6 calls this.

- [ ] **Step 1: Write the failing test**

Append to `test/test.js`. These expected values were read from the committed fixtures; they are exact.

```js
// --- parseCambridge, against real saved pages
async function fixture(name) {
  const res = await fetch(`fixtures/${name}.html`);
  return res.text();
}

async function parserTests() {
  const resilient = VT.parseCambridge(await fixture('resilient'));
  eq('resilient level', resilient.level, 'C2');
  eq('resilient ipa', resilient.ipa, 'rɪˈzɪl.i.ənt');
  eq('resilient def', resilient.def,
     'able to be happy, successful, etc. again after something difficult or bad has happened:');
  eq('resilient audio', resilient.audio,
     'https://dictionary.cambridge.org/media/english/uk_pron/u/ukr/ukres/ukresid009.mp3');

  const happy = VT.parseCambridge(await fixture('happy'));
  eq('happy level', happy.level, 'A1');
  eq('happy ipa', happy.ipa, 'ˈhæp.i');
  eq('happy def', happy.def, 'feeling, showing, or causing pleasure or satisfaction:');

  // The important case: a real entry with no CEFR level. "ubiquitous" is
  // outside the English Profile word list. A null level must not stop the
  // other three fields from parsing.
  const ubi = VT.parseCambridge(await fixture('ubiquitous'));
  eq('ubiquitous level is null', ubi.level, null);
  eq('ubiquitous ipa still parses', ubi.ipa, 'juːˈbɪk.wɪ.təs');
  eq('ubiquitous def still parses', ubi.def, 'seeming to be everywhere:');
  check('ubiquitous audio still parses', ubi.audio?.endsWith('.mp3'));

  // Garbage in, four nulls out. Never throws.
  const empty = VT.parseCambridge('<html><body>nothing here</body></html>');
  eq('empty level', empty.level, null);
  eq('empty ipa', empty.ipa, null);
  eq('empty def', empty.def, null);
  eq('empty audio', empty.audio, null);

  document.getElementById('out').textContent =
    log.join('\n') + `\n\n${failures} failure(s), ${log.length} check(s)`;
}
parserTests();
```

Remove the synchronous `document.getElementById('out').textContent = ...` line written at the end of Task 1, so the summary is printed once, after the async tests finish.

- [ ] **Step 2: Run the tests to verify they fail**

Reload `http://localhost:8000/test/test.html`.
Expected: `TypeError: VT.parseCambridge is not a function`. The Task 1 checks still pass.

- [ ] **Step 3: Write the minimal implementation**

Add to `VT` in `lib.js`:

```js
  // Selectors verified against the committed fixtures on 2026-09-13.
  // Each field is independent: a markup change that breaks one selector
  // yields null for that field and leaves the other three intact.
  parseCambridge(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const text = (sel) => doc.querySelector(sel)?.textContent.trim() || null;
    const audio = doc.querySelector('source[src$=".mp3"]')?.getAttribute('src');
    return {
      level: text('.epp-xref'),
      ipa: text('.ipa'),
      def: text('.def.ddef_d'),
      audio: audio ? VT.CAMBRIDGE + audio : null
    };
  },
```

The first `<source>` on the page sits inside the first `.entry-body__el`, so it belongs to the word being looked up. This was checked directly: the `ubiquitous` page yields `uktypho019.mp3`, which looks like another word but is not — `typhoon` uses `uktypho001.mp3`, and the string "typhoon" does not appear on the `ubiquitous` page. Cambridge's audio filenames are legacy-bucketed and do not track the headword.

- [ ] **Step 4: Run the tests to verify they pass**

Reload `http://localhost:8000/test/test.html`.
Expected: `0 failure(s), 34 check(s)`.

- [ ] **Step 5: Commit**

```bash
git add lib.js test/test.js
git commit -m "feat(lib): parse level, ipa, definition and audio from cambridge html"
```

---

### Task 3: SM-2 scheduler

**Files:**
- Modify: `lib.js`
- Modify: `test/test.js`

**Interfaces:**
- Consumes: `VT` from Task 1.
- Produces: `VT.sm2(card, quality)` returning `{ ease, interval, reps, due }`, and `VT.newEntry(word, parsed, vi, url)` returning a full storage entry. Task 6 calls `newEntry`, Task 8 calls `sm2`.

- [ ] **Step 1: Write the failing test**

Append to `test/test.js`, inside `parserTests()` before the final summary line:

```js
  // --- sm2
  const fresh = { ease: 2.5, interval: 0, reps: 0 };

  const first = VT.sm2(fresh, 5);
  eq('first success: reps', first.reps, 1);
  eq('first success: interval is 1 day', first.interval, 1);

  const second = VT.sm2(first, 5);
  eq('second success: reps', second.reps, 2);
  eq('second success: interval is 6 days', second.interval, 6);

  const third = VT.sm2(second, 4);
  eq('third success: interval is round(6 * ease)', third.interval, Math.round(6 * second.ease));

  // A lapse resets the schedule but not the ease factor.
  const lapsed = VT.sm2(third, 2);
  eq('lapse resets reps', lapsed.reps, 0);
  eq('lapse resets interval to 1', lapsed.interval, 1);
  check('lapse lowers ease', lapsed.ease < third.ease);

  // The 1.3 floor is part of the algorithm, not a tuning constant.
  let beaten = { ease: 2.5, interval: 0, reps: 0 };
  for (let i = 0; i < 20; i++) beaten = VT.sm2(beaten, 0);
  eq('ease floors at 1.3', beaten.ease, 1.3);

  const day = 24 * 60 * 60 * 1000;
  const due = VT.sm2(fresh, 5).due;
  check('due is about one day out', Math.abs(due - (Date.now() + day)) < 5000,
        `due delta ${due - Date.now()}`);

  // --- newEntry
  const entry = VT.newEntry('resilient', { level: 'C2', ipa: 'x', def: 'y', audio: null },
                            'kiên cường', 'https://example.com/a');
  eq('entry word', entry.word, 'resilient');
  eq('entry level', entry.level, 'C2');
  eq('entry vi', entry.vi, 'kiên cường');
  eq('entry sources', entry.sources.length, 1);
  eq('entry starts at ease 2.5', entry.ease, 2.5);
  eq('entry starts at reps 0', entry.reps, 0);
  check('entry is due immediately', entry.due <= Date.now());
```

- [ ] **Step 2: Run the tests to verify they fail**

Reload `http://localhost:8000/test/test.html`.
Expected: `TypeError: VT.sm2 is not a function`. Tasks 1 and 2 still pass.

- [ ] **Step 3: Write the minimal implementation**

Add to `VT` in `lib.js`:

```js
  // SM-2, standard formulation. quality is 0..5; below 3 is a lapse.
  // The 1.3 ease floor is part of the algorithm.
  sm2(card, quality) {
    let { ease, interval, reps } = card;
    if (quality < 3) {
      reps = 0;
      interval = 1;
    } else {
      reps += 1;
      interval = reps === 1 ? 1 : reps === 2 ? 6 : Math.round(interval * ease);
    }
    ease = Math.max(1.3, ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
    // Rounded to avoid float drift accumulating across dozens of reviews.
    ease = Math.round(ease * 1000) / 1000;
    return { ease, interval, reps, due: Date.now() + interval * 24 * 60 * 60 * 1000 };
  },

  newEntry(word, parsed, vi, url) {
    return {
      word,
      level: parsed.level,
      ipa: parsed.ipa,
      def: parsed.def,
      audio: parsed.audio,
      vi,
      sources: [url],
      added: Date.now(),
      ease: 2.5,
      interval: 0,
      reps: 0,
      due: Date.now()   // due immediately, so a new word appears in the first review
    };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Reload `http://localhost:8000/test/test.html`.
Expected: `0 failure(s), 51 check(s)`.

- [ ] **Step 5: Commit**

```bash
git add lib.js test/test.js
git commit -m "feat(lib): add sm2 scheduler and storage entry constructor"
```

---

### Task 4: Manifest, service worker, panel skeleton

From here the deliverable is checked by loading the extension, not by `test/test.html`. The pure logic is already covered.

**Files:**
- Create: `manifest.json`
- Create: `service-worker.js`
- Create: `sidepanel.html`
- Create: `sidepanel.js`

**Interfaces:**
- Consumes: `VT` from Tasks 1-3.
- Produces: the `chrome.storage.session` key `pending`, shaped `{ word, url, ts }`. Task 5 writes the message that causes it; Task 6 reads it.

- [ ] **Step 1: Write the manifest**

Create `manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "Vocab-track",
  "version": "0.1.0",
  "description": "Look up English words while reading, and review them as flashcards.",
  "minimum_chrome_version": "116",
  "permissions": ["storage", "sidePanel"],
  "host_permissions": [
    "https://dictionary.cambridge.org/*",
    "https://translate.googleapis.com/*"
  ],
  "background": { "service_worker": "service-worker.js" },
  "side_panel": { "default_path": "sidepanel.html" },
  "action": {},
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["lib.js", "content-script.js"],
      "run_at": "document_idle"
    }
  ]
}
```

`"action": {}` is an empty toolbar button. It exists so the panel can be opened for review without looking a word up first.

- [ ] **Step 2: Write the service worker**

Create `service-worker.js`:

```js
chrome.runtime.onInstalled.addListener(() => {
  // Clicking the toolbar icon opens the panel, which is the entry point to
  // flashcard review.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[vocab-track] setPanelBehavior failed', err));
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'lookup') return;

  // Open FIRST. sidePanel.open() consumes the user gesture forwarded with
  // this message, and the gesture does not survive an await. Do not reorder
  // these two calls and do not await the first one.
  chrome.sidePanel.open({ tabId: sender.tab.id })
    .catch((err) => console.error('[vocab-track] sidePanel.open failed for', message.word, err));

  // Handed over through storage rather than a message: the panel may not have
  // loaded a listener yet, and a storage write cannot be missed because the
  // panel also reads this key on load. ts makes a repeat lookup of the same
  // word a real change, so storage.onChanged still fires.
  chrome.storage.session.set({
    pending: { word: message.word, url: message.url, ts: Date.now() }
  });
});
```

- [ ] **Step 3: Write the panel skeleton**

Create `sidepanel.html`:

```html
<!doctype html>
<meta charset="utf-8">
<title>Vocab-track</title>
<link rel="stylesheet" href="sidepanel.css">
<body>
  <nav>
    <button id="tab-lookup" class="active">Lookup</button>
    <button id="tab-review">Review</button>
  </nav>

  <section id="view-lookup">
    <p id="lookup-empty">Select a word on any page and click the button that appears.</p>
    <article id="entry" hidden>
      <h1 id="entry-word"></h1>
      <p class="meta">
        <span id="entry-level" class="level"></span>
        <span id="entry-ipa"></span>
        <button id="entry-play" aria-label="Pronounce">▶</button>
      </p>
      <p id="entry-vi" class="vi"></p>
      <p id="entry-def"></p>
    </article>
  </section>

  <section id="view-review" hidden>
    <p id="review-empty">Nothing due. Come back later.</p>
    <article id="card" hidden>
      <h1 id="card-word"></h1>
      <button id="card-reveal">Show answer</button>
      <div id="card-answer" hidden>
        <p id="card-vi" class="vi"></p>
        <p id="card-def"></p>
        <div id="grades"></div>
      </div>
    </article>
    <p id="review-count"></p>
  </section>

  <script src="lib.js"></script>
  <script src="sidepanel.js"></script>
</body>
```

Create `sidepanel.css`:

```css
:root { color-scheme: light dark; }
body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 12px; }
nav { display: flex; gap: 4px; margin-bottom: 12px; }
nav button { flex: 1; padding: 6px; cursor: pointer; }
nav button.active { font-weight: 600; }
h1 { font-size: 20px; margin: 0 0 4px; }
.meta { display: flex; align-items: center; gap: 8px; color: #666; margin: 0 0 8px; }
.level { font-weight: 600; padding: 1px 6px; border: 1px solid currentColor; border-radius: 3px; }
.vi { font-size: 16px; font-weight: 600; }
#grades { display: flex; gap: 4px; margin-top: 12px; }
#grades button { flex: 1; padding: 6px; cursor: pointer; }
```

Create `sidepanel.js` with only the tab switching, so the skeleton is verifiable on its own:

```js
const $ = (id) => document.getElementById(id);

function showView(name) {
  $('view-lookup').hidden = name !== 'lookup';
  $('view-review').hidden = name !== 'review';
  $('tab-lookup').classList.toggle('active', name === 'lookup');
  $('tab-review').classList.toggle('active', name === 'review');
}

$('tab-lookup').addEventListener('click', () => showView('lookup'));
$('tab-review').addEventListener('click', () => showView('review'));
```

- [ ] **Step 4: Load the extension and verify**

1. Open `chrome://extensions`, enable Developer mode, click **Load unpacked**, select `~/work/Vocab-track`.
2. Expected: the extension loads with no manifest error and no red **Errors** badge.
3. Click the Vocab-track toolbar icon.
4. Expected: the side panel opens showing the two tabs and "Select a word on any page…".
5. Click **Review**, then **Lookup**.
6. Expected: the views swap, and the active tab is bold.
7. Open the service worker console from the **service worker** link on the extension card.
8. Expected: no errors logged.

- [ ] **Step 5: Commit**

```bash
git add manifest.json service-worker.js sidepanel.html sidepanel.css sidepanel.js
git commit -m "feat(ext): add manifest, service worker and side panel skeleton"
```

---

### Task 5: Floating lookup button

**Files:**
- Create: `content-script.js`
- Modify: `sidepanel.js`

**Interfaces:**
- Consumes: `VT.isLookupCandidate`, `VT.normaliseWord` from Task 1; the `pending` key contract from Task 4.
- Produces: a `{ type: 'lookup', word, url }` message. Task 6 replaces the temporary render with a real lookup.

- [ ] **Step 1: Write the content script**

Create `content-script.js`:

```js
let button = null;

function removeButton() {
  button?.remove();
  button = null;
}

function showButton(word, rect) {
  removeButton();
  button = document.createElement('button');
  button.textContent = '📘';
  button.title = `Look up "${word}"`;
  // Inline styles with a maximum z-index: the button must survive whatever
  // CSS the host page applies. It is removed on the next click, so it never
  // lingers over the page.
  button.style.cssText = [
    'position:absolute',
    `top:${window.scrollY + rect.bottom + 4}px`,
    `left:${window.scrollX + rect.left}px`,
    'z-index:2147483647',
    'all:revert',
    'font:14px/1 system-ui,sans-serif',
    'padding:4px 6px',
    'background:#fff',
    'border:1px solid #888',
    'border-radius:4px',
    'cursor:pointer',
    'box-shadow:0 1px 4px rgba(0,0,0,.3)'
  ].join(';');

  button.addEventListener('mousedown', (event) => {
    // Stop the page seeing this and clearing the selection first.
    event.preventDefault();
    event.stopPropagation();
    chrome.runtime.sendMessage({ type: 'lookup', word, url: location.href });
    removeButton();
  });

  document.body.appendChild(button);
}

document.addEventListener('mouseup', (event) => {
  if (button?.contains(event.target)) return;
  const selection = window.getSelection();
  const raw = selection?.toString() ?? '';

  if (!VT.isLookupCandidate(raw)) {
    removeButton();
    return;
  }

  const rect = selection.getRangeAt(0).getBoundingClientRect();
  showButton(VT.normaliseWord(raw), rect);
});

document.addEventListener('mousedown', (event) => {
  if (!button?.contains(event.target)) removeButton();
});
```

The button listens on `mousedown`, not `click`: many pages clear the selection on `mousedown`, and the handler must fire before that. `event.preventDefault()` keeps the selection alive long enough for the message to be sent.

- [ ] **Step 2: Render the received word in the panel**

This is temporary and is replaced in Task 6. It proves the handoff works before any network code is involved.

Append to `sidepanel.js`:

```js
function showWord(pending) {
  if (!pending) return;
  showView('lookup');
  $('lookup-empty').hidden = true;
  $('entry').hidden = false;
  $('entry-word').textContent = pending.word;
}

// Both paths are required. get() covers the lookup that opened this panel,
// whose write landed before any listener existed. onChanged covers every
// later lookup while the panel stays open.
chrome.storage.session.get('pending', ({ pending }) => showWord(pending));
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.pending) showWord(changes.pending.newValue);
});
```

- [ ] **Step 3: Reload and verify**

1. On `chrome://extensions`, click the reload icon on the Vocab-track card.
2. Open any English article, for example `https://en.wikipedia.org/wiki/Resilience`.
3. Reload the page, so the new content script is injected.
4. Double-click the word "resilience".
5. Expected: a small 📘 button appears just below the word.
6. Click it.
7. Expected: the side panel opens and shows "resilience" as the heading.
8. Select two words, for example "psychological resilience".
9. Expected: no button appears.
10. Select the word again and click elsewhere on the page.
11. Expected: the button disappears.

- [ ] **Step 4: Commit**

```bash
git add content-script.js sidepanel.js
git commit -m "feat(content): add floating lookup button and panel handoff"
```

---

### Task 6: Lookup, translate, save and render

**Files:**
- Modify: `sidepanel.js`

**Interfaces:**
- Consumes: `VT.parseCambridge`, `VT.newEntry`, `VT.normaliseWord`, `VT.CAMBRIDGE`.
- Produces: the `chrome.storage.local` key `words`, an object keyed by lowercase word, holding entries shaped by `VT.newEntry`. Tasks 7 and 8 read it.

- [ ] **Step 1: Write the storage helpers and the lookup flow**

Replace the temporary `showWord` from Task 5 in `sidepanel.js` with:

```js
const DASH = '—';

async function getWords() {
  const { words } = await chrome.storage.local.get('words');
  return words ?? {};
}

async function putWord(entry) {
  const words = await getWords();
  words[entry.word] = entry;
  await chrome.storage.local.set({ words });
}

async function fetchCambridge(word) {
  try {
    const res = await fetch(`${VT.CAMBRIDGE}/dictionary/english/${encodeURIComponent(word)}`);
    if (res.status === 404) return { notFound: true };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return VT.parseCambridge(await res.text());
  } catch (err) {
    // Degrade, never abort: the word is still worth saving with a translation.
    console.error('[vocab-track] cambridge lookup failed for', word, err);
    return { level: null, ipa: null, def: null, audio: null };
  }
}

async function fetchVietnamese(word) {
  // Unofficial, keyless endpoint. Acceptable for a personal tool; it will
  // break one day, and the replacement goes behind this same function.
  const url = 'https://translate.googleapis.com/translate_a/single'
    + `?client=gtx&sl=en&tl=vi&dt=t&q=${encodeURIComponent(word)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data?.[0]?.[0]?.[0] ?? null;
  } catch (err) {
    console.error('[vocab-track] translation failed for', word, err);
    return null;
  }
}

function renderEntry(entry) {
  showView('lookup');
  $('lookup-empty').hidden = true;
  $('entry').hidden = false;
  $('entry-word').textContent = entry.word;
  $('entry-level').textContent = entry.level ?? DASH;
  $('entry-ipa').textContent = entry.ipa ? `/${entry.ipa}/` : DASH;
  $('entry-vi').textContent = entry.vi ?? DASH;
  $('entry-def').textContent = entry.def ?? DASH;
  $('entry-play').onclick = () => pronounce(entry);
}

function renderNotFound(word) {
  showView('lookup');
  $('entry').hidden = true;
  $('lookup-empty').hidden = false;
  $('lookup-empty').textContent = `"${word}" is not in the Cambridge dictionary. Nothing saved.`;
}

function pronounce(entry) {
  if (entry.audio) {
    new Audio(entry.audio).play().catch((err) => {
      console.error('[vocab-track] audio playback failed for', entry.word, err);
      speak(entry.word);
    });
    return;
  }
  speak(entry.word);
}

function speak(word) {
  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = 'en-GB';
  speechSynthesis.speak(utterance);
}

async function lookup(pending) {
  if (!pending) return;
  const word = VT.normaliseWord(pending.word);
  const words = await getWords();

  // Already known: no network call. Record that it appeared on this page too,
  // so the highlighter picks it up here.
  const known = words[word];
  if (known) {
    if (!known.sources.includes(pending.url)) {
      known.sources.push(pending.url);
      await putWord(known);
    }
    renderEntry(known);
    return;
  }

  const [parsed, vi] = await Promise.all([fetchCambridge(word), fetchVietnamese(word)]);
  if (parsed.notFound) {
    renderNotFound(word);
    return;
  }

  const entry = VT.newEntry(word, parsed, vi, pending.url);
  await putWord(entry);
  renderEntry(entry);
}

chrome.storage.session.get('pending', ({ pending }) => lookup(pending));
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.pending) lookup(changes.pending.newValue);
});
```

- [ ] **Step 2: Reload and verify a full lookup**

1. Reload the extension, then reload the article page.
2. Look up "resilient".
3. Expected: the panel shows `resilient`, level `C2`, `/rɪˈzɪl.i.ənt/`, a Vietnamese translation, and the English definition.
4. Click ▶.
5. Expected: a British voice says the word.
6. Look up "ubiquitous".
7. Expected: level shows `—`, and IPA, definition and translation all still appear. This is the case the parser test covers.
8. Look up "resilient" again from a different page.
9. Expected: it renders immediately. In the panel's DevTools Network tab, no request to `dictionary.cambridge.org` is made.
10. Look up a nonsense word such as "qwertyuiop".
11. Expected: the panel says it is not in the dictionary, and nothing is saved.
12. In the panel console, run `chrome.storage.local.get('words').then(console.log)`.
13. Expected: an object containing `resilient` and `ubiquitous`, each with `ease: 2.5`, `reps: 0`, and a `sources` array.

- [ ] **Step 3: Commit**

```bash
git add sidepanel.js
git commit -m "feat(panel): look up, translate, save and render a word"
```

---

### Task 7: Highlight saved words on revisit

**Files:**
- Modify: `content-script.js`

**Interfaces:**
- Consumes: `VT.wordRegex` from Task 1; the `words` key from Task 6.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the highlighter**

Append to `content-script.js`:

```js
const HIGHLIGHT_NAME = 'vocab-track';

function highlightStyle() {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`::highlight(${HIGHLIGHT_NAME}) {
    background: rgba(255, 214, 0, .45);
    text-decoration: underline dotted currentColor;
  }`);
  // adoptedStyleSheets rather than a <style> element, so the page's DOM is
  // never modified.
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

function rangesFor(words) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const tag = node.parentElement?.tagName;
      // Never highlight inside code, script or editable fields.
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'CODE' || tag === 'PRE' ||
          tag === 'TEXTAREA' || node.parentElement?.isContentEditable) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const regexes = words.map((word) => VT.wordRegex(word));
  const ranges = [];
  let node;
  while ((node = walker.nextNode())) {
    for (const regex of regexes) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(node.nodeValue))) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        ranges.push(range);
      }
    }
  }
  return ranges;
}

async function applyHighlights() {
  const { words } = await chrome.storage.local.get('words');
  if (!words) return;

  // Per-URL: only words that were looked up on this exact page.
  const here = Object.values(words)
    .filter((entry) => entry.sources.includes(location.href))
    .map((entry) => entry.word);
  if (!here.length) return;

  const ranges = rangesFor(here);
  if (!ranges.length) return;

  highlightStyle();
  // ponytail: highlights are painted once, at document_idle. Content added
  // later by infinite scroll is not covered. Upgrade path is a debounced
  // MutationObserver calling applyHighlights again.
  CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
}

applyHighlights();
```

- [ ] **Step 2: Reload and verify**

1. Reload the extension, then reload the article page where "resilient" was looked up.
2. Expected: every occurrence of "resilient" on that page has a yellow background and a dotted underline.
3. Check a word that shares a stem, if the page has one, such as "resilience".
4. Expected: it is **not** highlighted. Exact match only is the documented behaviour.
5. Open a different page containing "resilient".
6. Expected: nothing is highlighted there, because the word's `sources` does not include that URL.
7. Use the browser's find-in-page for the word.
8. Expected: the page layout is unchanged and text selection still works normally, because the Highlight API does not touch the DOM.

- [ ] **Step 3: Commit**

```bash
git add content-script.js
git commit -m "feat(content): highlight saved words with the css highlight api"
```

---

### Task 8: Flashcard review

**Files:**
- Modify: `sidepanel.js`

**Interfaces:**
- Consumes: `VT.sm2` from Task 3; `getWords`, `putWord`, `showView`, `pronounce` from Tasks 4 and 6.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the review flow**

Append to `sidepanel.js`:

```js
const GRADES = [
  { q: 0, label: 'Blank' },
  { q: 3, label: 'Hard' },
  { q: 4, label: 'Good' },
  { q: 5, label: 'Easy' }
];

let queue = [];

async function startReview() {
  const words = await getWords();
  queue = Object.values(words).filter((entry) => entry.due <= Date.now());
  nextCard();
}

function nextCard() {
  $('review-count').textContent = queue.length ? `${queue.length} due` : '';
  if (!queue.length) {
    $('card').hidden = true;
    $('review-empty').hidden = false;
    return;
  }
  const entry = queue[0];
  $('review-empty').hidden = true;
  $('card').hidden = false;
  $('card-answer').hidden = true;
  $('card-reveal').hidden = false;
  $('card-word').textContent = entry.word;
  $('card-vi').textContent = entry.vi ?? DASH;
  $('card-def').textContent = entry.def ?? DASH;
}

$('card-reveal').addEventListener('click', () => {
  $('card-answer').hidden = false;
  $('card-reveal').hidden = true;
  pronounce(queue[0]);
});

function buildGradeButtons() {
  const container = $('grades');
  for (const grade of GRADES) {
    const button = document.createElement('button');
    button.textContent = grade.label;
    button.addEventListener('click', () => grade_(grade.q));
    container.appendChild(button);
  }
}

async function grade_(quality) {
  const entry = queue.shift();
  Object.assign(entry, VT.sm2(entry, quality));
  await putWord(entry);
  // A lapse is re-queued at the back, so it is seen again this session.
  if (quality < 3) queue.push(entry);
  nextCard();
}

buildGradeButtons();
$('tab-review').addEventListener('click', startReview);

// Opened from the toolbar with no pending lookup: go straight to review.
chrome.storage.session.get('pending', ({ pending }) => {
  if (!pending) {
    showView('review');
    startReview();
  }
});
```

- [ ] **Step 2: Reload and verify**

1. Reload the extension.
2. Look up two or three new words, so several cards exist and are due.
3. Click the **Review** tab.
4. Expected: one word is shown, with a **Show answer** button and "3 due".
5. Click **Show answer**.
6. Expected: the Vietnamese translation and the definition appear, the word is pronounced, and four grade buttons show.
7. Click **Good**.
8. Expected: the next card appears and the count drops by one.
9. Grade a card **Blank**.
10. Expected: it returns at the end of the queue rather than disappearing.
11. Work through every card.
12. Expected: "Nothing due. Come back later." is shown.
13. In the panel console, run `chrome.storage.local.get('words').then(console.log)`.
14. Expected: graded entries now have `reps: 1` and a `due` timestamp roughly a day ahead.
15. Close the panel, click the toolbar icon.
16. Expected: the panel opens on the Review tab, because there is no pending lookup.

Clearing a stale `pending` is deliberate: `chrome.storage.session` is wiped when the browser closes, so the toolbar path is correct on any fresh browser session. Within one session, after a lookup, the toolbar opens the Lookup view showing that last word — click **Review** to switch.

- [ ] **Step 3: Commit**

```bash
git add sidepanel.js
git commit -m "feat(panel): add flashcard review with sm2 grading"
```

---

### Task 9: Saved-words list

The spec's scope line reads "per-URL highlighting of saved words, plus a side
panel listing them". Tasks 1-8 never build that list, so this task adds it.

**Files:**
- Modify: `sidepanel.html`
- Modify: `sidepanel.js`

**Interfaces:**
- Consumes: `getWords`, `renderEntry`, `showView`, `DASH` from Tasks 4 and 6.
- Produces: nothing. This is the last task.

- [ ] **Step 1: Add the markup**

In `sidepanel.html`, add a third tab button inside `<nav>`, after `tab-lookup`:

```html
    <button id="tab-words">Words</button>
```

Add a third section, after `#view-lookup` and before `#view-review`:

```html
  <section id="view-words" hidden>
    <input id="words-filter" type="search" placeholder="Filter…" autocomplete="off">
    <p id="words-empty" hidden>No words saved yet.</p>
    <ul id="words-list"></ul>
  </section>
```

Add to `sidepanel.css`:

```css
#words-filter { width: 100%; padding: 6px; margin-bottom: 8px; box-sizing: border-box; }
#words-list { list-style: none; margin: 0; padding: 0; }
#words-list li { display: flex; align-items: baseline; gap: 8px; padding: 6px 4px;
                 border-bottom: 1px solid #8883; cursor: pointer; }
#words-list li:hover { background: #8882; }
#words-list .w { font-weight: 600; }
#words-list .t { color: #888; margin-left: auto; font-size: 13px; }
```

- [ ] **Step 2: Extend showView for three views**

Replace `showView` in `sidepanel.js` with a version that handles all three,
rather than adding a third pair of hard-coded lines:

```js
const VIEWS = ['lookup', 'words', 'review'];

function showView(name) {
  for (const view of VIEWS) {
    $(`view-${view}`).hidden = view !== name;
    $(`tab-${view}`).classList.toggle('active', view === name);
  }
}
```

- [ ] **Step 3: Render the list**

Append to `sidepanel.js`:

```js
async function renderWords() {
  const words = await getWords();
  // Most recently added first: the list is for reviewing what you just read.
  const all = Object.values(words).sort((a, b) => b.added - a.added);
  const term = $('words-filter').value.trim().toLowerCase();
  const shown = term
    ? all.filter((e) => e.word.includes(term) || (e.vi ?? '').toLowerCase().includes(term))
    : all;

  $('words-empty').hidden = shown.length > 0;
  $('words-empty').textContent = all.length ? 'No match.' : 'No words saved yet.';

  const list = $('words-list');
  list.replaceChildren();
  for (const entry of shown) {
    const li = document.createElement('li');
    const word = document.createElement('span');
    word.className = 'w';
    word.textContent = entry.word;
    const level = document.createElement('span');
    level.className = 'level';
    level.textContent = entry.level ?? DASH;
    const vi = document.createElement('span');
    vi.className = 't';
    vi.textContent = entry.vi ?? DASH;
    li.append(word, level, vi);
    // textContent throughout, never innerHTML: definitions come from a third
    // party and must never be parsed as markup.
    li.addEventListener('click', () => renderEntry(entry));
    list.appendChild(li);
  }
}

$('tab-words').addEventListener('click', renderWords);
$('words-filter').addEventListener('input', renderWords);
```

`renderEntry` already calls `showView('lookup')`, so clicking a row opens that
word in the Lookup view with its play button wired.

- [ ] **Step 4: Reload and verify**

1. Reload the extension and open the panel.
2. Click the **Words** tab.
3. Expected: every saved word is listed, newest first, each with its level badge and Vietnamese translation. A word with no level shows `—`.
4. Type part of a word into the filter.
5. Expected: the list narrows as you type. Filtering also matches the Vietnamese side.
6. Clear the filter and click a row.
7. Expected: the panel switches to Lookup and shows that word in full; ▶ pronounces it.
8. Type a filter matching nothing.
9. Expected: "No match."
10. In the panel console, run `chrome.storage.local.remove('words')`, then click **Words**.
11. Expected: "No words saved yet."

- [ ] **Step 5: Commit**

```bash
git add sidepanel.html sidepanel.css sidepanel.js
git commit -m "feat(panel): add saved-words list with filter"
```

---

## Done when

- `http://localhost:8000/test/test.html` reports `0 failure(s)`.
- Selecting a word on any page shows the button; clicking it opens the panel with level, IPA, translation, definition and working audio.
- A word with no CEFR level renders `—` and still shows its other fields.
- Revisiting the page highlights the words saved there.
- The Words tab lists every saved word and filters as you type.
- The toolbar icon opens a review session that schedules with SM-2.
- `chrome://extensions` shows no errors on the extension card or in the service worker console.
