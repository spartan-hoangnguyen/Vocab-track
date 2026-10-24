const $ = (id) => document.getElementById(id);
const DASH = VT.DASH;
const VIEWS = ['overview', 'words', 'review', 'stats', 'writing', 'io', 'settings'];

// One in-memory snapshot per render pass. Every view reads from this rather
// than hitting storage per row, and refresh() is the single place that
// reloads it, so a write anywhere is followed by exactly one re-read.
let words = {};
let folders = {};
let writing = { on: true, off: [], mistakes: {} };
let activeFolder = null;   // null = all words
// Which language you are studying right now. Not a const and not a pack: the
// toggle moves it between renders, so every reader hoists what it needs off
// LANG.get(activeLang) locally rather than closing over a scale that was right
// when the file loaded.
let activeLang = LANG.FALLBACK;
// The language `queue` below was built from. Declared up here beside the value
// it is compared against rather than beside the queue itself, because refresh()
// is what compares the two.
let queueLang = LANG.FALLBACK;
let practice = { counts: {}, misses: {} };
// The last HISTORY_DAYS of grades, every language; render() filters it.
let reviewLog = [];
let pins = [];
// The GIPHY key, mirrored here only so renderCard can decide whether to offer a
// Find GIF button without an async read per card. giphy.js re-reads storage for
// the actual search, so this copy is never the source of truth for a request.
let giphyKey = '';
// Whether AnkiConnect has been reached at least once. Gates the per-word Push to
// Anki control on a word card, so the cards stay clean for anyone who does not
// use Anki, and fill with the control once a connection has worked.
let ankiReady = false;
// The deck last chosen in the picker, persisted. ankiReady outlives a session
// but the picker's selection does not, so without this a per-word push on a
// fresh dashboard open would land in the default deck rather than the one the
// user picked last time.
let ankiDeck = '';
// How a review session runs. A key missing from storage is a default, not
// false: a profile that never touched the switch still hears the word.
// `voices` is { [packId]: voiceURI }; a language with no key is Automatic.
const REVIEW_DEFAULTS = { shuffle: false, autoplay: true, accent: 'uk', practiceSession: 10, voices: {} };
let prefs = { ...REVIEW_DEFAULTS };
// How All words is narrowed and drawn, per viewer: a flat key of its own, read
// with the rest in refresh(). `level` '' is every level; `status` is a
// VT.statusOf value, 'due' or 'all'. `density` '' is not chosen yet: Cards
// for a handful of words, List past WORDS_CARDS_UP_TO, where forty cards run
// to 8,500px of mostly repeated footers.
const WORDS_VIEW_DEFAULTS = { status: 'all', level: '', sort: 'newest', density: '' };
const WORDS_CARDS_UP_TO = 12;
let wordsView = { ...WORDS_VIEW_DEFAULTS };
// The List rows open right now, by word, so a re-render (a tag click, a word
// arriving from another tab) does not fold them all shut again.
const openRows = new Set();
// The List rows ticked for a bulk action, by word, and the row a shift-click
// ranges from. Pruned on every render to the rows on screen, so an action
// never reaches a word a search or filter has hidden (renderWords).
const pickedRows = new Set();
let pickAnchor = null;
// The words on this page of the List, in order: what shift-click ranges over
// and Select all ticks. Empty in Cards density, which has no selection.
let pageWords = [];

// The view in the address bar, so a view can be bookmarked, opened in a new
// tab, and walked back to with the browser's Back. Anything else after the #
// is not ours and reads as no view at all.
function viewFromHash() {
  const name = location.hash.slice(1);
  return VIEWS.includes(name) ? name : null;
}

// `push` false is for arriving at a view from the address (boot, Back), which
// is already in the history; every other call is a step the user took.
function showView(name, { push = true } = {}) {
  if (push && location.hash !== `#${name}`) history.pushState(null, '', `#${name}`);
  // A Card Blast round hangs off its own signal and would keep ticking behind
  // whichever view you walked to; nothing else stops it, because the panel
  // going display:none is not an event.
  if (name !== 'review' && typeof PRACTICE !== 'undefined' && PRACTICE.active()) PRACTICE.stop();
  for (const view of VIEWS) $(`view-${view}`).hidden = view !== name;
  // Redundant once you are in the review, and it competes with Show answer
  // for the same attention and roughly the same click.
  $('review-btn').hidden = name === 'review';
  for (const a of document.querySelectorAll('nav a[data-view]')) {
    a.classList.toggle('on', a.dataset.view === name);
    // .on is the look; aria-current is the same fact for a screen reader.
    if (a.dataset.view === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  // Below 900px the links are one row that scrolls sideways, and the current
  // one can be off its end (Settings, opened from a bookmark). At full width
  // the row is display:contents and never scrolls.
  const row = document.querySelector('.navs');
  const current = row.querySelector('a.on');
  if (current && row.scrollWidth > row.clientWidth) {
    const box = row.getBoundingClientRect();
    const link = current.getBoundingClientRect();
    if (link.left < box.left || link.right > box.right) row.scrollLeft += link.left - box.left - 16;
  }
}

for (const a of document.querySelectorAll('nav a[data-view]')) {
  a.addEventListener('click', (event) => {
    // A modified click is the browser's: the href is the view, so Cmd-click
    // opens it in a tab of its own.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (a.dataset.view === 'words') activeFolder = null;
    if (a.dataset.view === 'review') startReview(null);
    showView(a.dataset.view);
    render();
  });
}

// Shown before the first refresh, so a bookmarked view does not flash the
// overview first. A review reached this way gets its queue once the words are
// in (see openReviewByAddress, at the boot refresh).
showView(viewFromHash() ?? 'overview', { push: false });
window.addEventListener('popstate', () => { routeFromHash(); render(); });

// The Help links leave for the feedback form, so they are real links rather
// than views, and the handler above skips them.
for (const kind of ['feature', 'bug']) {
  $(`fb-${kind}`).href = VT.feedbackUrl(kind, chrome.runtime.getManifest().version, navigator.userAgent);
}

// A flat key of its own, like `theme`, not a field of reviewPrefs: reviewPrefs
// is how one review session runs, and this governs six views. Routed through
// LANG.get rather than read raw, so an id whose pack has been removed falls
// back once here instead of throwing on every render.
async function getLang() {
  const { lang } = await chrome.storage.local.get('lang');
  return LANG.get(lang)?.id ?? LANG.FALLBACK;
}

// A flat key like `lang` and `theme`, trimmed so a stray space pasted after the
// key does not read as a configured-but-wrong key.
async function getGiphyKey() {
  const { giphyKey } = await chrome.storage.local.get('giphyKey');
  return String(giphyKey ?? '').trim();
}

async function getAnkiReady() {
  const { ankiReady } = await chrome.storage.local.get('ankiReady');
  return ankiReady === true;
}

async function getAnkiDeck() {
  const { ankiDeck } = await chrome.storage.local.get('ankiDeck');
  return typeof ankiDeck === 'string' ? ankiDeck : '';
}

// Set once, the first time AnkiConnect answers. No render here; the caller
// renders, because the two callers already do for their own reasons.
async function markAnkiReady() {
  if (ankiReady) return;
  ankiReady = true;
  await chrome.storage.local.set({ ankiReady: true });
}

async function refresh() {
  [words, folders, writing, practice, prefs, pins, activeLang, giphyKey, reviewLog, ankiReady,
   ankiDeck, wordsView] = await Promise.all(
    [getWords(), getFolders(), getWriting(), getPractice(), getReviewPrefs(), getPins(),
     getLang(), getGiphyKey(), getHistory(), getAnkiReady(), getAnkiDeck(), getWordsView()]);
  // `queue` is the one piece of state no render() reaches — it is built once per
  // session from the word map — so the language moving under it leaves the old
  // language's cards on screen beneath a switched toggle. The rebuild belongs
  // here rather than to setLang() because this is the single place that re-reads
  // the key, so every path that writes it arrives: the toggle, lookupNew
  // following a word into its own language, and another dashboard tab through
  // storage.onChanged. Keyed off the queue's own language, not off a before/after
  // pair, so the two refreshes one toggle press causes — its own and the
  // onChanged it fires — rebuild once between them.
  if (queueLang !== activeLang) startReview(reviewScope);
  // And the words view's scope, for the same reason and one level down: a
  // folder this language does not show cannot stay the thing you are looking
  // at. Flipping to Korean while inside IELTS C1 otherwise leaves that name
  // over an empty list. One pass over the word map, and only when there is a
  // folder open to invalidate.
  if (activeFolder && folders[activeFolder]
      && !VT.inLang(folders[activeFolder], ownersOf(activeFolder), activeLang)) {
    activeFolder = null;
  }
  render();
}

// Every word in a folder, in every language — which is what decides whose
// folder it is. The language-filtered list cannot answer that: it says "empty"
// for exactly the folders the question is about.
function ownersOf(id) {
  return Object.values(words).filter((e) => VT.foldersOf(e).includes(id));
}

// Bumped when a bundled level list (lang/en/cefr.js, lang/zh/hsk.js) is
// regenerated, so the backfill runs again over words it could not place before.
const LEVEL_VERSION = 1;

// Give a level to words that have none, from their language's bundled list.
// English lost its CEFR level when the lookup moved off Cambridge, and Chinese
// words saved before the HSK list existed never had one, so both sit under "—"
// in the level charts. The list comes from the word's dictionary (`level`), so
// a language without one (Korean) is skipped. Once per version — a word that
// genuinely has no level (a proper noun, a word outside the list) is left
// alone. Runs on boot, after the first load populated `words`, and re-renders
// only when it actually changed something.
async function backfillLevels() {
  const { levelBackfill } = await chrome.storage.local.get('levelBackfill');
  if (levelBackfill === LEVEL_VERSION) return;
  const patches = {};
  for (const [word, entry] of Object.entries(words)) {
    if (!entry || entry.level) continue;
    const level = LANG.dict(LANG.of(entry).id)?.level?.(word);
    if (level) patches[word] = { level };
  }
  if (Object.keys(patches).length) {
    await putWords(patches);
    for (const [word, patch] of Object.entries(patches)) {
      if (words[word]) words[word].level = patch.level;
    }
    render();
  }
  await chrome.storage.local.set({ levelBackfill: LEVEL_VERSION });
}

function render() {
  // The one load point every view fans out from, so filtering here is what
  // makes the toggle reach all of them. The exception is the streak below.
  const all = Object.values(words).filter((e) => LANG.of(e).id === activeLang);
  renderOverview(all);
  // Every language: the hint is about the whole profile being worth syncing.
  showCloudHint();
  renderWords(all);
  renderLang();
  // The Push to Anki card names the language it will push, so it follows the
  // toggle like everything else. The deck picker's default option follows too.
  $('anki-lang').textContent = LANG.get(activeLang).name;
  syncAnkiDeck();
  // Unfiltered, and deliberately: "days with a new word" is a habit, not a view
  // of the language being studied. Halving the streak on a toggle press would
  // read as data loss for something the toggle did not touch.
  renderStreak(Object.values(words));
  renderStats(all);
  renderPrefs();
  renderCard();
  renderPractice(all);
  renderWriting();
}

/* ---------- overview ---------- */

function dueCount(entries) {
  const now = Date.now();
  return entries.filter((e) => VT.isLearnable(e) && e.due <= now).length;
}

// The folders Suggested for you shows, held until the language changes
// (renderOverview).
let suggestPick = null;

function renderOverview(all) {
  // One pass over the words, not one filter per folder. Twice over, because
  // the two maps answer different questions: `members` is what a card COUNTS,
  // and that is this language's words only; `owners` is what decides whether
  // the card is shown at all, and that has to see every word, or a folder the
  // filter is already hiding would look empty and therefore universal.
  const members = {};
  const owners = {};
  for (const id of Object.keys(folders)) { members[id] = []; owners[id] = []; }
  for (const entry of all) {
    for (const id of VT.foldersOf(entry)) members[id]?.push(entry);
  }
  for (const entry of Object.values(words)) {
    for (const id of VT.foldersOf(entry)) owners[id]?.push(entry);
  }
  const mine = (folder) => VT.inLang(folder, owners[folder.id], activeLang);
  const shown = Object.values(folders).filter(mine);

  const due = dueCount(all);
  // No words in this language: the three steps instead of the numbers and
  // the folders, which would only be zeros and "Empty". The numbers below are
  // still written, just not shown, so they are right the moment a word lands.
  const first = !all.length;
  $('ov-start').hidden = !first;
  for (const id of ['ov-sub', 'ov-stats', 'ov-folders-head', 'ov-folders']) $(id).hidden = first;
  // The active language's scale, read per render rather than closed over: the
  // toggle changes it, and `all` holds only that language's words. Passed
  // explicitly even though lib.js:629 would now default to the same list —
  // the call says which scale it means.
  const levels = LANG.get(activeLang).levels;
  $('ov-total').textContent = all.length;
  $('ov-median').textContent = VT.medianLevel(all, levels) ?? DASH;
  $('ov-sub').textContent =
    `${all.length} word${all.length === 1 ? '' : 's'} collected while reading · ` +
    `${shown.length} folder${shown.length === 1 ? '' : 's'}`;
  renderToday(all, due);
  $('review-btn').textContent = due ? `Review ${due} due` : 'Review';
  // The darkest button on the page only when there is something to review:
  // with nothing due, or no words yet, it would point at an empty session.
  $('review-btn').classList.toggle('ghost', !due);

  // One hue, not one per level: the axis already names the level, so colouring
  // by level would encode nothing the label does not already say.
  const buckets = levelBuckets(all, levels);
  const max = Math.max(1, ...buckets.map((b) => b.n));
  const bars = $('ov-bars');
  bars.replaceChildren();
  for (const { label, name, n } of buckets) {
    // The name and count on the column, not the bar: a level at 0 hides its
    // bar, and the column still has to say so.
    const wrap = document.createElement('span');
    wrap.setAttribute('role', 'img');
    wrap.title = `${name}: ${n} word${n === 1 ? '' : 's'}`;
    wrap.setAttribute('aria-label', wrap.title);
    const bar = document.createElement('i');
    bar.style.height = `${(n / max) * 26 + 3}px`;
    // A level nobody has reached draws no bar: a 3px stub reads as a count.
    bar.hidden = !n;
    const cap = document.createElement('u');
    cap.textContent = label;
    wrap.append(bar, cap);
    bars.appendChild(wrap);
  }

  const live = pins.filter((id) => folders[id] && mine(folders[id]));
  fillGrid('ov-pinned', first ? [] : live.map((id) => folderCard(folders[id], members[id])));
  // suggestFolders needs no language filter of its own: it drops anything that
  // scores zero (lib.js:579), and a folder with no words in this language has
  // nothing due, nothing missed and nothing learning. A second guard here
  // would only restate the first.
  //
  // Only folders made for you: one you made yourself is already in your list,
  // and lifting it out of there is moving your things around. The pick is
  // held per language, so a grade or a pin a moment later does not reshuffle
  // the sections under the cursor; the reasons stay live. A reload or the
  // language toggle picks again, and so does an empty pick, or the first
  // word saved would never be suggested.
  const scored = VT.suggestFolders(
    Object.values(folders).filter((folder) => folder.auto)
      .map((folder) => ({ folder, members: members[folder.id] })),
    Date.now(), practice.misses, live);
  if (suggestPick?.lang !== activeLang || !suggestPick.ids.length) {
    suggestPick = { lang: activeLang, ids: scored.map(({ folder }) => folder.id) };
  }
  const reasons = new Map(scored.map(({ folder, reason }) => [folder.id, reason]));
  const suggested = suggestPick.ids.filter((id) => folders[id] && !live.includes(id));
  fillGrid('ov-suggest', suggested.map((id) =>
    folderCard(folders[id], members[id], reasons.get(id))));

  // Each folder once: a pinned or suggested card is already on screen above.
  const above = new Set([...live, ...suggested]);
  $('ov-folders-title').textContent = above.size ? 'Other folders' : 'All folders';
  const grid = $('ov-folders');
  grid.replaceChildren(...shown
    .filter((folder) => !above.has(folder.id))
    .map((folder) => folderCard(folder, members[folder.id])));

  const add = document.createElement('button');
  add.className = 'f new';
  const plus = document.createElement('span');
  plus.className = 'plus';
  plus.textContent = '+';
  plus.setAttribute('aria-hidden', 'true');
  const label = document.createElement('b');
  label.textContent = 'New folder';
  add.append(plus, label);
  add.addEventListener('click', () => editFolder(null));
  grid.appendChild(add);
}

// How many due words the overview names before handing over to the review.
const TODAY_SHOWN = 6;

// The words due now, in the order the review will ask them (startReview's
// sort, without its shuffle), each with its meaning and the sentence it came
// from. A preview, so nothing here is a control except the one Start review.
function renderToday(all, due) {
  const now = Date.now();
  const next = all.filter((e) => VT.isLearnable(e) && e.due <= now)
    .sort((a, b) => a.due - b.due)
    .slice(0, TODAY_SHOWN);
  fillGrid('ov-today', next.map((entry) => {
    const item = el('li');
    // The whole word on hover, for one the column cuts short.
    item.title = entry.word;
    item.append(inLang(el('b', 'today-word', entry.word), wordLang(entry)),
      inLang(el('span', 'today-gloss', VT.glossOf(entry) ?? DASH), glossLang(entry)));
    if (entry.context) item.appendChild(seenQuote(entry));
    return item;
  }));
  $('ov-today-title').textContent = due > next.length
    ? `Due today · ${next.length} of ${due}` : 'Due today';
}

// A grid and its heading show only when the grid has cards.
function fillGrid(id, cards) {
  $(id).replaceChildren(...cards);
  $(`${id}-head`).hidden = !cards.length;
  $(id).hidden = !cards.length;
}

function folderCard(folder, members, reason) {
  const n = members.length;
  // An <article>, not a <button>: the card holds its own pin, Review and Edit
  // buttons, and a button inside a button is invalid and unreachable by
  // keyboard. The title is the card's one primary button; its ::after stretches
  // over the whole card (dashboard.css .fopen), so a click anywhere still opens
  // the folder, and the other buttons sit above that layer.
  const card = document.createElement('article');
  card.className = `f ${folder.color ?? 'sage'}`;
  card.dataset.folder = folder.id;

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.setAttribute('aria-hidden', 'true');
  badge.textContent = folder.icon ?? '\u{1F4C1}';
  const pinned = pins.includes(folder.id);
  const pin = document.createElement('button');
  pin.type = 'button';
  pin.className = `pin${pinned ? ' on' : ''}`;
  pin.title = pinned ? 'Unpin' : 'Pin to the top';
  // One fixed name and the state in aria-pressed, rather than a label that
  // flips between Pin and Unpin.
  pin.setAttribute('aria-label', `Pin ${folder.name}`);
  pin.setAttribute('aria-pressed', String(pinned));
  pin.appendChild(VT.icon('pin'));
  pin.addEventListener('click', () => togglePin(folder.id));
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${folder.auto ? 'Made for you' : 'Your folder'} · ${n} word${n === 1 ? '' : 's'}`;
  // What the two kinds mean, on every card that names one. Above the
  // title's stretched ::after like the pin, so it opens help, not the folder.
  const what = el('button', 'helpq', '?');
  what.type = 'button';
  what.setAttribute('aria-label', 'What Made for you and Your folder mean');
  what.addEventListener('click', () => openHelp('how-dlg', 'how-folders'));
  meta.appendChild(what);
  const name = document.createElement('h3');
  const open = el('button', 'fopen', folder.name);
  open.type = 'button';
  open.addEventListener('click', () => openFolder(folder.id));
  name.appendChild(open);
  const dueHere = dueCount(members);
  const freshHere = newCards(members).length;
  const footText = dueHere
    ? `${dueHere} due today`
    : (freshHere ? `${freshHere} to learn` : (n ? 'All reviewed' : 'Empty'));
  // A reason the footer already gives ("3 due today") is not said twice, and
  // a folder suggested for its progress has none (lib.js suggestFolders): the
  // card keeps its own description instead.
  const why = reason && reason !== footText ? reason : null;
  const desc = document.createElement('p');
  desc.textContent = why ?? folder.desc ?? '';
  if (why) desc.className = 'why';
  // The pin is drawn in the corner but comes after the title in the DOM, so
  // Tab reaches the card's primary action first. The eyebrow too, now that it
  // holds the (?): it follows the title in the DOM and is drawn above it
  // (dashboard.css .f .meta order).
  card.append(badge, name, meta, pin, desc);

  const p = VT.progressOf(members);
  if (p.learned + p.learning + p.fresh) {
    const bar = document.createElement('div');
    bar.className = 'fprog';
    for (const [cls, count] of [['m', p.learned], ['l', p.learning], ['n', p.fresh]]) {
      const seg = document.createElement('i');
      seg.className = cls;
      seg.style.flex = count;
      bar.appendChild(seg);
    }
    const counts = document.createElement('div');
    counts.className = 'fcounts';
    counts.textContent = `${p.learned} learned · ${p.learning} learning · ${p.fresh} new`;
    card.append(bar, counts);
  }

  const foot = document.createElement('div');
  foot.className = 'foot';
  const dueText = document.createElement('span');
  dueText.textContent = footText;
  foot.appendChild(dueText);
  if (dueHere || freshHere) {
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'edit';
    go.textContent = dueHere ? 'Review' : 'Learn';
    go.setAttribute('aria-label', `${go.textContent} ${folder.name}`);
    go.addEventListener('click', () => {
      startReview(folder.id, { ahead: true });
      showView('review');
      render();
    });
    foot.appendChild(go);
  }
  if (!folder.auto) {
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'edit';
    edit.textContent = 'Edit';
    edit.setAttribute('aria-label', `Edit ${folder.name}`);
    edit.addEventListener('click', () => editFolder(folder));
    foot.appendChild(edit);
  }
  card.appendChild(foot);
  return card;
}

function openFolder(id) {
  activeFolder = id;
  showView('words');
  render();
}

/* ---------- words table ---------- */

const WORDS_SHOWN = 300;

function relative(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  const days = Math.round(mins / 1440);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

// When a word comes up next, for a List row: relative()'s future-tense twin.
// A skipped word has no next time.
function dueWhen(entry) {
  if (!VT.isLearnable(entry)) return 'Not asked';
  const mins = Math.round((entry.due - Date.now()) / 60000);
  if (mins <= 0) return 'Due now';
  if (mins < 60) return `in ${mins}m`;
  if (mins < 1440) return `in ${Math.round(mins / 60)}h`;
  const days = Math.round(mins / 1440);
  return days === 1 ? 'tomorrow' : `in ${days}d`;
}

async function getWordsView() {
  const { wordsView: stored } = await chrome.storage.local.get('wordsView');
  return { ...WORDS_VIEW_DEFAULTS, ...stored };
}

// Straight to storage and a render, no refresh(): nothing else reads it.
function setWordsView(patch) {
  wordsView = { ...wordsView, ...patch };
  render();
  return chrome.storage.local.set({ wordsView });
}

// Whether a word passes a status chip. Due cuts across the other four: a word
// saved today is both New and due, as it is in the overview's Due count.
function statusMatch(entry, status, now) {
  if (status === 'all') return true;
  if (status === 'due') return VT.isLearnable(entry) && entry.due <= now;
  return VT.statusOf(entry) === status;
}

const WORD_SORTS = {
  newest: (a, b) => b.added - a.added,
  // Skipped words last: they have a due date but are never asked.
  due: (a, b) => VT.isLearnable(b) - VT.isLearnable(a) || a.due - b.due,
  az: (a, b) => a.word.localeCompare(b.word)
};

function renderWords(all) {
  const term = VT.normaliseWord($('q').value);
  const now = Date.now();
  const scope = activeFolder
    ? all.filter((e) => VT.foldersOf(e).includes(activeFolder))
    : all;
  const matched = term
    ? scope.filter((e) => e.word.includes(term) || (e.vi ?? '').toLowerCase().includes(term))
    : scope;
  // The active language's scale, read per render. A level kept from another
  // language's scale reads as every level, not as an empty list.
  const levels = LANG.get(activeLang).levels;
  const level = levels.includes(wordsView.level) ? wordsView.level : '';
  const leveled = level ? matched.filter((e) => e.level === level) : matched;
  const sort = WORD_SORTS[wordsView.sort] ?? WORD_SORTS.newest;
  const shown = leveled.filter((e) => statusMatch(e, wordsView.status, now))
    // An exact match first: searching "cat" should open cat, not category.
    .sort((a, b) => (b.word === term) - (a.word === term) || sort(a, b));
  const filtered = wordsView.status !== 'all' || !!level;
  // The filters are remembered across sessions, so a search days later can
  // run inside a Not asked · B2 the user has forgotten. The sub-line names them
  // and counts what they hide, rather than reading as "this word is not saved".
  const chip = $('w-filter').querySelector(`[data-status="${wordsView.status}"]`);
  const filterName = [wordsView.status !== 'all' && chip?.firstChild.textContent.trim(), level]
    .filter(Boolean).join(' · ');
  const hidden = matched.length - shown.length;
  const density = wordsView.density || (scope.length > WORDS_CARDS_UP_TO ? 'list' : 'cards');
  renderWordFilter(leveled, levels, level, scope.length > 0, now, density);

  // An imported word list runs to thousands of entries, and a card is 16
  // elements: 1,900 words measured at 30,578 of them, rebuilt on every
  // keystroke in the search box, because typing re-renders. The cap is what
  // keeps the search box responsive; the count below says what is not shown.
  const page = shown.slice(0, WORDS_SHOWN);
  const more = shown.length - page.length;

  $('w-title').textContent = activeFolder ? folders[activeFolder]?.name ?? 'Folder' : 'All words';
  $('w-sub').textContent = more
    ? `Showing ${page.length} of ${shown.length} — narrow with search or filters`
    : term ? `${shown.length} match${shown.length === 1 ? '' : 'es'} for “${term}”`
      + (filterName ? ` in ${filterName}` : '')
      + (hidden ? ` · ${hidden} hidden by filters` : '')
    : filtered ? `${shown.length} of ${scope.length} word${scope.length === 1 ? '' : 's'}`
    : `${shown.length} word${shown.length === 1 ? '' : 's'}`;

  // A folder you can open but not study is a dead end: this is the way into a
  // review scoped to it, whether or not anything is due today.
  const study = $('w-review');
  const due = dueCount(scope);
  const fresh = newCards(scope).length;
  study.hidden = !activeFolder || !(due || fresh);
  study.textContent = due
    ? `Review ${due} due`
    : `Learn ${Math.min(AHEAD_BATCH, fresh)} new`;

  const list = density === 'list';
  pageWords = list ? page.map((e) => e.word) : [];
  const onPage = new Set(pageWords);
  for (const word of pickedRows) if (!onPage.has(word)) pickedRows.delete(word);
  const cards = $('w-cards');
  cards.classList.toggle('list', list);
  cards.replaceChildren(...page.map((entry) => (list ? wordRow(entry) : wordCard(entry))));
  $('w-all-wrap').hidden = !list || !page.length;
  syncPicked();

  const empty = $('w-empty');
  empty.replaceChildren();
  empty.hidden = shown.length > 0;
  if (!shown.length) {
    // The lookup only when nothing saved matches at all: a word the filters
    // hide is already yours, and looking it up again would be a detour.
    if (term && !matched.length && VT.isLookupCandidate(term)) {
      empty.className = 'lookupcta';
      const line = document.createElement('div');
      const strong = document.createElement('b');
      strong.textContent = term;
      line.append('No saved word matches ', strong, '.');
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.style.marginTop = '14px';
      // Named after the dictionary the term's own script will actually be sent
      // to — the same detect() isLookupCandidate just ran. A language with no
      // dictionary yet still offers the lookup: the Vietnamese gloss arrives
      // either way (lookup.js:13-18).
      const dict = LANG.dict(LANG.detect(term)?.id);
      btn.textContent = dict ? `Look up “${term}” on ${dict.name}` : `Look up “${term}”`;
      btn.addEventListener('click', () => lookupNew(term, btn));
      empty.append(line, btn);
    } else if (filtered && matched.length) {
      empty.className = 'empty';
      const clear = el('button', 'btn ghost small', term ? 'Show all' : 'Clear filters');
      clear.type = 'button';
      clear.addEventListener('click', () => {
        setWordsView({ status: 'all', level: '' });
        // The button goes with the empty state; focus lands on what it reset.
        $('w-filter').querySelector('[data-status="all"]').focus();
      });
      empty.append(term
        ? `${hidden} match${hidden === 1 ? '' : 'es'} hidden by filters. `
        : 'No words with these filters. ', clear);
    } else {
      empty.className = 'empty';
      empty.textContent = term ? 'No match.' : 'No words here yet.';
    }
  }
}

// The filter row's state: the pressed chips, each status chip's count over the
// words the search and level leave, and this language's level options.
function renderWordFilter(pool, levels, level, any, now, density) {
  const row = $('w-filter');
  // Nothing to narrow: an empty folder or a language with no words yet.
  row.hidden = !any;
  for (const chip of row.querySelectorAll('[data-status]')) {
    const status = chip.dataset.status;
    chip.setAttribute('aria-pressed', String(status === wordsView.status));
    chip.querySelector('span').textContent = pool.filter((e) => statusMatch(e, status, now)).length;
  }
  for (const button of row.querySelectorAll('[data-density]')) {
    button.setAttribute('aria-pressed', String(button.dataset.density === density));
  }
  const select = $('w-level');
  // Rebuilt only when the scale changes (the language toggle), so an open
  // select is not pulled out from under the pointer by an unrelated render.
  if (select.dataset.scale !== levels.join()) {
    select.replaceChildren(new Option('All', ''), ...levels.map((l) => new Option(l, l)));
    select.dataset.scale = levels.join();
  }
  select.value = level;
  $('w-sort').value = wordsView.sort in WORD_SORTS ? wordsView.sort : 'newest';
}

for (const chip of $('w-filter').querySelectorAll('[data-status]')) {
  chip.addEventListener('click', () => setWordsView({ status: chip.dataset.status }));
}
for (const button of $('w-filter').querySelectorAll('[data-density]')) {
  button.addEventListener('click', () => setWordsView({ density: button.dataset.density }));
}
$('w-level').addEventListener('change', (event) => setWordsView({ level: event.target.value }));
$('w-sort').addEventListener('change', (event) => setWordsView({ sort: event.target.value }));

// A List row: the word, its meaning, level and when it is next due on one
// line, opening into the full card. A <details>, so the platform carries the
// open state, Enter and Space; the card is built on first open, which keeps
// 300 closed rows to a handful of elements each.
function wordRow(entry) {
  // The tick box sits beside the <details>, not in its <summary>: a control
  // inside the summary is a control inside a button.
  const wrap = el('div', 'wline');
  wrap.dataset.word = entry.word;
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'wsel';
  box.checked = pickedRows.has(entry.word);
  box.setAttribute('aria-label', `Select ${entry.word}`);
  // click, not change: change carries no shiftKey.
  box.addEventListener('click', (event) => pickRow(entry.word, box.checked, event.shiftKey));
  const row = el('details', 'wrow');
  const line = el('summary');
  // Space on the focused row ticks it, as it would the box; Enter still opens
  // it. Both halves stopped: the summary toggles on keyup.
  line.addEventListener('keydown', (event) => {
    if (event.key !== ' ') return;
    event.preventDefault();
    if (!event.repeat) pickRow(entry.word, !pickedRows.has(entry.word), event.shiftKey);
  });
  line.addEventListener('keyup', (event) => { if (event.key === ' ') event.preventDefault(); });
  line.append(inLang(el('b', 'wrow-word', entry.word), wordLang(entry)),
    inLang(el('span', 'wrow-gloss', VT.glossOf(entry) ?? DASH), glossLang(entry)),
    el('span', 'wrow-lvl', VT.levelText(entry) ?? ''),
    el('span', 'wrow-due', dueWhen(entry)));
  row.appendChild(line);
  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    row.appendChild(wordCard(entry));
  };
  if (openRows.has(entry.word)) {
    build();
    row.open = true;
  }
  row.addEventListener('toggle', () => {
    if (!row.open) { openRows.delete(entry.word); return; }
    openRows.add(entry.word);
    build();
  });
  wrap.append(box, row);
  return wrap;
}

/* ---------- bulk actions on the List ---------- */

// Ticks or unticks one row, or with shift every row from the last one ticked
// to this one, all to this row's new state.
function pickRow(word, on, range) {
  const from = range && pickAnchor ? pageWords.indexOf(pickAnchor) : -1;
  const to = pageWords.indexOf(word);
  const span = from < 0 || to < 0
    ? [word] : pageWords.slice(Math.min(from, to), Math.max(from, to) + 1);
  for (const w of span) on ? pickedRows.add(w) : pickedRows.delete(w);
  pickAnchor = word;
  syncPicked();
}

function clearPicked() {
  pickedRows.clear();
  pickAnchor = null;
  syncPicked();
}

// The boxes, Select all and the bar, from `picked`. In place rather than a
// render(): ticking forty rows should not rebuild the list forty times.
function syncPicked() {
  for (const box of $('w-cards').querySelectorAll('.wsel')) {
    box.checked = pickedRows.has(box.closest('.wline').dataset.word);
  }
  const all = $('w-all');
  all.checked = pageWords.length > 0 && pickedRows.size === pageWords.length;
  all.indeterminate = pickedRows.size > 0 && !all.checked;
  const bar = $('w-bulk');
  const n = pickedRows.size;
  // The button that was pressed can take the bar away with it (Ask again under
  // the Not asked filter empties the selection); focus would fall to the top of
  // the page, so it goes to the view's heading instead.
  if (!n && !bar.hidden && bar.contains(document.activeElement)) $('w-title').focus();
  bar.hidden = !n;
  if (!n) return;
  const entries = [...pickedRows].map((w) => words[w]).filter(Boolean);
  $('wb-count').textContent = `${n} selected`;
  const unfile = $('wb-unfile');
  // From reading is where a word with no folder already is, so it has no way out.
  unfile.hidden = !activeFolder || activeFolder === VT.READING;
  unfile.textContent = `Remove from ${folders[activeFolder]?.name ?? 'folder'}`;
  $('wb-unskip').hidden = !entries.some((e) => !VT.isLearnable(e));
  $('wb-anki').hidden = !ankiReady;
}

$('w-all').addEventListener('change', (event) => {
  for (const w of pageWords) event.target.checked ? pickedRows.add(w) : pickedRows.delete(w);
  pickAnchor = null;
  syncPicked();
});
$('wb-clear').addEventListener('click', () => {
  clearPicked();
  announce('Selection cleared.');
});
$('wb-folder').addEventListener('click', () => openTagPicker([...pickedRows]));
$('wb-unfile').addEventListener('click', async () => {
  const list = [...pickedRows];
  const name = folders[activeFolder]?.name ?? 'the folder';
  await fileWords(list, activeFolder, false);
  await refresh();
  announce(`Removed ${plural(list.length, 'word')} from ${name}.`);
});
$('wb-unskip').addEventListener('click', async () => {
  const back = [...pickedRows].filter((w) => words[w] && !VT.isLearnable(words[w]));
  await putWords(Object.fromEntries(back.map((w) => [w, { skipped: false }])));
  await refresh();
  announce(`${plural(back.length, 'word')} back in review.`);
});
$('wb-anki').addEventListener('click', async () => {
  const btn = $('wb-anki');
  const entries = [...pickedRows].map((w) => words[w]).filter(Boolean);
  btn.disabled = true;
  btn.textContent = 'Pushing…';
  try {
    const result = await pushEntriesToAnki(entries);
    if (result) {
      announce(`Added ${result.added} to “${result.deck}” · ${result.skipped} already in Anki.`);
    }
  } catch (err) {
    announce(ankiMessage(err));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Push to Anki';
  }
});
$('wb-delete').addEventListener('click', async () => {
  const gone = [...pickedRows].filter((w) => words[w])
    .map((word) => ({ word, snapshot: structuredClone(words[word]) }));
  // Cleared before the write, so the bar is gone and a double-click's second
  // half has nothing left to delete twice.
  clearPicked();
  await removeWords(gone.map((d) => d.word));
  await refresh();
  // The toast says it (role=status) and takes focus; its Undo puts every one back.
  showDeleted(gone);
});

const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

// A link's visible label, e.g. "en.wikipedia.org". Returns null for anything
// that is not a real URL, so a malformed source never renders a dead link.
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return null; }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  // textContent everywhere: definitions, translations and page sentences are
  // third-party text and must never be parsed as markup.
  if (text !== undefined) node.textContent = text;
  return node;
}

// A clickable chip on a word card. A real button, so Tab and Enter reach it;
// dashboard.css takes the button chrome back off so it still reads as a tag.
// An interface icon (lib.js VT.ICONS) put before the node's text, or after
// it for the trailing kind: an external link's arrow reads after the name.
function withIcon(node, name, after = false) {
  const icon = VT.icon(name);
  if (after) {
    icon.classList.add('after');
    node.append(icon);
  } else {
    node.prepend(icon);
  }
  return node;
}

function tagButton(extra, text) {
  const button = el('button', `tag clickable${extra}`, text);
  button.type = 'button';
  return button;
}

// The page is English (<html lang="en">); the text a word brings with it is
// not. Marked so a screen reader switches voice and the browser picks the
// right glyphs and line breaks: the word, its sentence and its examples in the
// word's language, the gloss in Vietnamese. A definition is in the word's
// language only where the dictionary is monolingual — krdict for Korean;
// Cambridge and CC-CEDICT define in English. glossLang mirrors VT.glossOf.
const wordLang = (entry) => LANG.of(entry).id;
const defLang = (entry) => (wordLang(entry) === 'ko' ? 'ko' : 'en');
const glossLang = (entry) => (entry.vi != null ? 'vi' : defLang(entry));
function inLang(node, lang) {
  node.lang = lang;
  return node;
}

// The sentence a word was met in, with the word marked. Shared by the word
// card and the overview's due list, so the two quote it the same way.
function seenQuote(entry) {
  const quote = inLang(el('blockquote', 'wc-seen'), wordLang(entry));
  for (const piece of VT.pieces(entry.context, VT.find(entry.word, entry.context, entry.lang))) {
    if (piece.hit) quote.appendChild(el('mark', null, piece.text));
    else quote.append(piece.text);
  }
  return quote;
}

function wordCard(entry) {
  const card = el('article', 'wcard');
  card.dataset.word = entry.word;

  // --- headline row
  const head = el('div', 'wc-head');
  // An h2 under the view's h1. The word is a button inside the heading, so
  // the heading still reads as the word and the control is reachable by Tab;
  // the title is its description ("pigeon, button, Pronounce").
  const title = el('h2', 'wc-word');
  const say = inLang(el('button', 'wc-say', entry.word), wordLang(entry));
  say.type = 'button';
  say.title = 'Pronounce';
  say.addEventListener('click', () => speakWord(entry));
  title.appendChild(say);
  head.appendChild(title);
  if (entry.level) {
    const lvl = el('span', 'lvl', VT.levelText(entry));
    if (entry.levelEst) lvl.title = 'Estimated from word frequency, not a looked-up CEFR level';
    head.appendChild(lvl);
  }
  if (entry.pos) head.appendChild(el('span', 'wc-pos', entry.pos));
  if (entry.ipa) head.appendChild(el('span', 'wc-ipa', VT.pronText(entry.ipa, LANG.of(entry))));

  const spacer = el('span', 'wc-spacer');
  head.appendChild(spacer);
  head.appendChild(el('span', 'when', relative(entry.added)));
  const del = el('button', 'rowdel', '×');
  del.title = `Delete ${entry.word}`;
  del.setAttribute('aria-label', del.title);
  // No confirm(): the delete happens, and the toast offers it back. The
  // snapshot is the whole stored record — folders, schedule, GIF — and putting
  // it back is an ordinary putWords, which clears the tombstone removeWord
  // left, so sync sees a word edited after its delete rather than a deleted one.
  del.addEventListener('click', async () => {
    // The card below slides up and its × lands under the pointer, so the
    // second click of a double-click would take the next word with it.
    if (performance.now() - lastDelete < DELETE_GUARD_MS) return;
    lastDelete = performance.now();
    const snapshot = structuredClone(words[entry.word] ?? entry);
    await removeWord(entry.word);
    await refresh();
    showDeleted([{ word: entry.word, snapshot }]);
  });
  card.appendChild(head);

  // --- meaning
  if (entry.vi) card.appendChild(inLang(el('p', 'wc-vi', entry.vi), 'vi'));
  card.appendChild(inLang(el('p', 'wc-def', entry.def ?? DASH), defLang(entry)));
  if (entry.senses?.length > 1) {
    // Senses only exist where a dictionary parsed them, so the name is there
    // too; the fallback is for a pack whose dictionary was removed under
    // entries it had already saved.
    const dict = LANG.dict(LANG.of(entry).id);
    card.appendChild(el('p', 'wc-more',
      `+${entry.senses.length - 1} more meaning${entry.senses.length > 2 ? 's' : ''} ` +
      `on ${dict?.name ?? 'the dictionary'}`));
  }

  // --- the sentence it was met in, with the word marked
  if (entry.context) card.appendChild(seenQuote(entry));

  // --- synonyms
  if (entry.synonyms?.length) {
    const chips = inLang(el('div', 'wc-chips'), wordLang(entry));
    for (const word of entry.synonyms.slice(0, 5)) chips.appendChild(el('span', 'tag', word));
    card.appendChild(chips);
  }

  // --- a GIF mnemonic, on the card where the word is browsed. Shown as a stored
  // image, else a Find button once a GIPHY key is set, else nothing — the same
  // three states the review card has, built here so the words list can find a
  // GIF without opening the review.
  card.appendChild(gifSection(entry));

  // --- footer: where it came from, where to read more, which folders
  const foot = el('div', 'wc-foot');

  const source = entry.sources?.[entry.sources.length - 1];
  const host = source ? hostOf(source) : null;
  if (host) {
    const link = withIcon(el('a', 'wc-link', host), 'back');
    // A text fragment, so this lands on the sentence rather than the top of a
    // long article. Falls back to the plain URL when there is no context.
    link.href = VT.sourceLink(source, entry.context, entry.word, entry.lang);
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.title = `Jump back to where you read it\n${source}`;
    foot.appendChild(link);
  }

  foot.appendChild(el('span', 'wc-spacer'));

  // The only way back into the rotation, so it sits with the other membership
  // tags rather than behind a menu.
  if (!VT.isLearnable(entry)) {
    const back = withIcon(tagButton('', 'Ask again'), 'back', true);
    back.title = 'Start asking about this word again';
    back.addEventListener('click', async () => {
      await putWord(entry.word, { skipped: false });
      await refresh();
    });
    foot.appendChild(back);
  }
  // Switched off from the side panel's quiz after a right answer; this is the
  // only way back on.
  if (entry.noHighlight) {
    const relight = withIcon(tagButton('', 'Not highlighted'), 'back', true);
    relight.title = 'Highlight this word on pages again';
    relight.addEventListener('click', async () => {
      await putWord(entry.word, { noHighlight: false });
      await refresh();
    });
    foot.appendChild(relight);
  }

  for (const id of VT.foldersOf(entry)) {
    const tag = tagButton('', folders[id]?.name ?? id);
    tag.addEventListener('click', () => openFolder(id));
    foot.appendChild(tag);
  }
  // Filing a word is a core task, so this sits at full weight with the folder
  // tags and reads the same as the review card's '+ Folder'.
  const add = tagButton('', '+ Folder');
  add.title = 'Add to folder';
  add.setAttribute('aria-label', `Add ${entry.word} to a folder`);
  add.addEventListener('click', () => openTagPicker(entry));
  foot.appendChild(add);

  // The actions a card is rarely opened for: the dictionary and Anki. Drawn
  // dimmed until the card is hovered or focused (dashboard.css), so forty cards
  // do not repeat them forty times at full weight; still in the tab order, and
  // tabbing into one is what draws them.
  const extra = el('span', 'wc-extra');
  const dict = LANG.dict(LANG.of(entry).id);
  if (dict) {
    const cam = withIcon(el('a', 'wc-link', dict.name), 'external', true);
    cam.href = dict.href(entry.word);
    cam.target = '_blank';
    cam.rel = 'noreferrer';
    cam.title = `Full entry on ${dict.name}`;
    extra.appendChild(cam);
  }
  // Push to Anki, and whether it is already there. Shown once a connection has
  // worked, or the word has already been pushed. Both states push on click: a
  // re-push is dedup-safe and re-adds a card that was deleted in Anki.
  if (ankiReady || entry.anki) {
    const inAnki = !!entry.anki;
    const chip = withIcon(tagButton(inAnki ? ' anki-on' : '', 'Anki'), inAnki ? 'check' : 'upload');
    chip.title = inAnki
      ? `In Anki deck “${entry.anki.deck}”. Click to push again.`
      : 'Push this word to Anki';
    chip.addEventListener('click', () => pushWordToAnki(entry, chip));
    extra.appendChild(chip);
  }
  foot.appendChild(extra);

  card.appendChild(foot);
  // Last in the DOM so it is the card's last Tab stop, not the one straight
  // after the word; dashboard.css still draws it in the headline's corner.
  card.appendChild(del);
  return card;
}

// The GIF control for a words-list card: a stored image with Try another /
// Remove, else a Find button once a key is set, else an empty box that CSS
// (:empty) collapses so it costs no space. Appended unconditionally so wordCard
// stays a straight line of appends.
function gifSection(entry) {
  const box = el('div', 'wc-gif');
  if (entry.gif && VT.giphyOk(entry.gif)) {
    const img = el('img', 'wc-gifimg');
    img.src = entry.gif;
    img.alt = `A GIF for ${entry.word}`;
    img.loading = 'lazy';
    const row = el('div', 'wc-gifrow');
    const again = el('button', 'wc-gifbtn', 'Try another');
    again.addEventListener('click', () => cardFindGif(entry, again));
    const drop = el('button', 'wc-gifbtn', 'Remove');
    drop.addEventListener('click', async () => {
      await putWord(entry.word, { gif: null });
      await refresh();
    });
    // "via GIPHY" is the attribution GIPHY's terms ask for, beside the image.
    row.append(el('span', 'wc-gifvia', 'via GIPHY'), again, drop);
    box.append(img, row);
    return box;
  }
  if (!giphyKey) return box;
  const btn = withIcon(el('button', 'wc-gifbtn', 'Find GIF'), 'film');
  btn.addEventListener('click', () => cardFindGif(entry, btn));
  box.appendChild(btn);
  return box;
}

async function cardFindGif(entry, btn) {
  // One search at a time, shared with the review card's guard: a 42-an-hour
  // budget cannot afford a double-click.
  if (finding) return;
  finding = true;
  // The nodes, not the text: textContent would put the label back without its icon.
  const label = [...btn.childNodes];
  btn.disabled = true;
  btn.textContent = 'Searching GIPHY…';
  try {
    const { url, failed } = await searchGif(entry);
    finding = false;
    // A found GIF rebuilds the whole words view, so the card comes back with the
    // image in place of the button — the same refresh() the delete and skip
    // controls on this card already use.
    if (url) { await refresh(); return; }
    btn.disabled = false;
    btn.replaceChildren(...label);
    btn.closest('.wc-gif')?.appendChild(el('p', 'wc-gifmsg', failed
      ? `Could not fetch a GIF — ${failed}`
      : `No GIF found for “${giphyQuery(entry).q}”.`));
  } catch (err) {
    finding = false;
    console.error('[vocab-track] card find gif failed for', entry.word, err);
    btn.disabled = false;
    btn.replaceChildren(...label);
  }
}

/* ---------- tag picker ---------- */

// The words the open picker is filing: one from a card, many from the List's
// bulk bar. Words, not entries: refresh() swaps every entry object for a fresh
// one whenever storage changes.
let tagging = [];

// `target` is an entry, or an array of words.
function openTagPicker(target) {
  tagging = Array.isArray(target) ? target : [target.word];
  $('tag-title').textContent = `Add to folder · ${tagging.length > 1
    ? `${tagging.length} words` : tagging[0]}`;
  $('tag-q').value = '';
  renderTags();
  $('tag-dlg').showModal();
  $('tag-q').focus();
}

// Your own folders first, then the preset topics you have not used yet. A
// preset stops being a suggestion the moment it becomes a folder.
//
// Scoped to the language of the word being tagged, not to activeLang: the
// picker opens on a card, and a card can be Korean inside an English session.
// Offering IELTS C1 for 책 is not just noise — filing it there would put an
// English list folder into the Korean overview permanently, because a folder
// holding both languages reads as everyone's (VT.folderLang). Deliberately
// mixing one is still possible, by typing the folder's name: folderForName
// matches on name and hands back the folder you meant.
function tagOptions() {
  const lang = LANG.of(words[tagging[0]]).id;
  const owners = {};
  for (const entry of Object.values(words)) {
    for (const id of VT.foldersOf(entry)) (owners[id] ??= []).push(entry);
  }
  const own = Object.values(folders).filter((f) => !f.auto);
  // `taken` stays over ALL your folders, not the shown ones: a preset whose
  // name you already used in the other language must not be offered again, or
  // accepting it makes a second folder with the same name under a new id.
  const taken = new Set(own.map((f) => f.name.toLowerCase()));
  const suggested = VT.TOPICS.filter((t) => !folders[t.id] && !taken.has(t.name.toLowerCase()))
    .map((t) => ({ ...t, suggested: true }));
  return [...own.filter((f) => VT.inLang(f, owners[f.id], lang)), ...suggested];
}

function renderTags() {
  const typed = $('tag-q').value.trim();
  const q = typed.toLowerCase();
  const filed = tagCounts();
  const list = $('tag-list');
  list.replaceChildren();
  const shown = tagOptions().filter((t) => t.name.toLowerCase().includes(q));
  // Two groups, so a preset never sits among your own folders looking like
  // one: 🎓 Education next to 🎓 IELTS Academic read as the same kind of thing.
  const groups = [['Your folders', shown.filter((t) => !t.suggested)],
                  ['Suggested', shown.filter((t) => t.suggested)]];
  for (const [label, tags] of groups) {
    if (!tags.length) continue;
    const group = el('div', 'taggroup');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    group.appendChild(el('p', 'taghead', label)).setAttribute('aria-hidden', 'true');
    for (const tag of tags) {
      const row = el('label', tag.suggested ? 'tagrow suggested' : 'tagrow');
      const box = document.createElement('input');
      box.type = 'checkbox';
      // Mixed when only some of a bulk selection are in it; a click files all.
      box.checked = filed[tag.id] === tagging.length;
      box.indeterminate = !box.checked && filed[tag.id] > 0;
      box.addEventListener('change', () => toggleTag(tag, box.checked));
      row.append(box, el('span', null, `${tag.icon ?? '\u{1F4C1}'} ${tag.name}`));
      group.appendChild(row);
    }
    list.appendChild(group);
  }
  if (q && !tagOptions().some((t) => t.name.toLowerCase() === q)) {
    const create = el('button', 'tagrow create', `+ New folder “${typed}”`);
    create.type = 'button';
    create.addEventListener('click', createTag);
    list.appendChild(create);
  }
}

// How many of the words being filed are in each folder, by folder id.
function tagCounts() {
  const counts = {};
  for (const word of tagging) {
    for (const id of VT.foldersOf(words[word])) counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

// Adds or removes one folder on one word, in storage and in memory.
function fileWord(word, id, on) {
  return fileWords([word], id, on);
}

// The same for many words, in one storage write. A word deleted meanwhile is
// left out rather than written back as a stub.
async function fileWords(list, id, on) {
  const live = list.filter((word) => words[word]);
  await setWordsFolders(Object.fromEntries(live.map((word) => {
    const mine = VT.foldersOf(words[word]);
    return [word, on ? [...mine, id] : mine.filter((f) => f !== id)];
  })));
  // Read back rather than recomputed, so store.js stays the one place that
  // decides what an emptied list means. The review queue holds its own entry
  // objects, and the card's tag label reads from those.
  const stored = await getWords();
  for (const word of live) {
    for (const entry of [words[word], ...queue.filter((e) => e.word === word)]) {
      if (entry) entry.folders = stored[word]?.folders;
    }
  }
}

async function toggleTag(tag, on) {
  // The word's own language, not activeLang: the card being tagged can be a
  // Korean one reached from an English session.
  const id = tag.suggested
    ? await folderForName(tag.name, LANG.of(words[tagging[0]]).id)
    : tag.id;
  await fileWords(tagging, id, on);
  folders = await getFolders();
  // A box in the picker says what one word did; for a selection, say how many.
  if (tagging.length > 1) {
    announce(`${on ? 'Added' : 'Removed'} ${plural(tagging.length, 'word')} `
      + `${on ? 'to' : 'from'} ${folders[id]?.name ?? 'the folder'}.`);
  }
  renderTags();
  // Behind the modal, so the card's label and the word list are already right
  // when it closes — however it closes: Done, Esc or Enter.
  render();
}

async function createTag() {
  const name = $('tag-q').value.trim();
  if (!name) return;
  const id = await folderForName(name, LANG.of(words[tagging[0]]).id);
  $('tag-q').value = '';
  await toggleTag({ id }, true);
}

$('tag-q').addEventListener('input', renderTags);

// Enter takes the best match, so "pol" + Enter files the word under Politics
// without the mouse. Only when nothing matches does it make a new tag, and on
// an empty box it closes: type, Enter, Enter is the whole round trip.
$('tag-q').addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  // Stopped here because the close below happens mid-dispatch: by the time the
  // event bubbled to the review's own handler the picker would no longer be
  // open, and that same Enter would grade the card.
  event.stopPropagation();
  const q = $('tag-q').value.trim().toLowerCase();
  if (!q) {
    $('tag-dlg').close();
    return;
  }
  const options = tagOptions();
  const match = options.find((t) => t.name.toLowerCase() === q)
    ?? options.find((t) => t.name.toLowerCase().includes(q));
  if (!match) {
    await createTag();
    return;
  }
  $('tag-q').value = '';
  await toggleTag(match, tagCounts()[match.id] !== tagging.length);
});

async function lookupNew(word, button) {
  button.disabled = true;
  button.textContent = `Looking up “${word}”…`;
  const { entry, notFound } = await resolveWord(word, null, activeFolder ? [activeFolder] : []);
  if (notFound) {
    const dict = LANG.dict(LANG.pick(null, word).id);
    // Same shape as the panel's (sidepanel.js:256), and for the same reason:
    // the name reads as an adjective, never as the object of "in".
    button.textContent = `No ${dict?.name ?? 'dictionary'} entry for “${word}”`;
    return;
  }
  // Follow the word. The CTA above dispatches on the term's script, so typing 책
  // in EN mode correctly offers a Korean lookup — and then the word would save
  // into a list this page is filtering out, which reads as the lookup having
  // done nothing. refresh() below re-reads the key, so writing it is enough.
  const saved = LANG.of(entry).id;
  if (saved !== activeLang) await chrome.storage.local.set({ lang: saved });
  $('q').value = '';
  await refresh();
}

/* ---------- streak ---------- */

function renderStreak(all) {
  const days = new Set(all.map((e) => new Date(e.added).toDateString()));
  let streak = 0;
  for (let i = 0; ; i++) {
    const day = new Date();
    day.setDate(day.getDate() - i);
    if (!days.has(day.toDateString())) {
      // Today not yet counted is not a broken streak — only a gap before today is.
      if (i === 0) continue;
      break;
    }
    streak++;
  }
  $('streak-days').textContent = streak ? `${streak} day${streak === 1 ? '' : 's'}` : DASH;
  const dots = $('streak-dots');
  dots.replaceChildren();
  for (let i = 6; i >= 0; i--) {
    const day = new Date();
    day.setDate(day.getDate() - i);
    const dot = document.createElement('span');
    if (days.has(day.toDateString())) dot.className = 'on';
    dots.appendChild(dot);
  }
}

/* ---------- folder dialog ---------- */

let editing = null;

function editFolder(folder) {
  editing = folder;
  $('dlg-title').textContent = folder ? 'Edit folder' : 'New folder';
  $('dlg-name').value = folder?.name ?? '';
  $('dlg-desc').value = folder?.desc ?? '';
  $('dlg-color').value = folder?.color ?? 'sage';
  $('folder-dlg').showModal();
}

$('folder-dlg').addEventListener('close', async () => {
  if ($('folder-dlg').returnValue !== 'save') return;
  const name = $('dlg-name').value.trim();
  if (!name) return;
  const patch = { name, desc: $('dlg-desc').value.trim(), color: $('dlg-color').value };
  // A new folder belongs to the session it was made in. An edit leaves `lang`
  // alone — renaming an English folder while reading Korean must not move it.
  await putFolder(editing
    ? { ...editing, ...patch }
    : { ...VT.newFolder(name, { lang: activeLang }), ...patch });
  editing = null;
  await refresh();
});

/* ---------- import / export ---------- */

$('export-btn').addEventListener('click', async () => {
  const backup = VT.backupPayload(await chrome.storage.local.get(null));
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `vocab-track-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  // The download itself happens in Chrome's own UI, which may be collapsed;
  // say here that it went, and what it holds.
  const n = Object.keys(backup.words ?? {}).length;
  $('export-note').textContent = `Exported ${n} word${n === 1 ? '' : 's'} as ${a.download}.`;
});

// A note line that can carry a failure. `error` paints it in the danger colour
// so a failure does not read like the success line it replaced; `detail` is the
// technical cause, folded away under "Details", kept out of the sentence to act on.
function setNote(note, text, { error = false, detail = '' } = {}) {
  note.classList.toggle('err', error);
  note.replaceChildren(text);
  if (!detail) return;
  const more = el('details', 'note-detail');
  more.append(el('summary', '', 'Details'), detail);
  note.append(more);
}

const IMPORT_NOT_BACKUP = 'This is not a Vocab-track backup. Choose a .json file made with '
  + 'Export JSON, or one from Downloads/vocab-track.';
const IMPORT_DAMAGED = 'This backup is damaged, possibly cut off while it downloaded. '
  + 'Nothing was imported. Try an earlier one from Downloads/vocab-track.';

// A backup file's text, checked before anything is written. Returns { data }, or
// { error, detail } with a sentence that says what to do next. The parser's own
// message ("Unexpected token < in JSON…") is only ever the detail.
function readBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    // A backup that starts like one but does not parse was cut short; anything
    // else (a web page saved as .json, a CSV) was never a backup.
    return { error: /^\s*\{/.test(text) ? IMPORT_DAMAGED : IMPORT_NOT_BACKUP, detail: err.message };
  }
  if (!data || typeof data.words !== 'object' || Array.isArray(data.words)) {
    return { error: IMPORT_NOT_BACKUP, detail: 'No "words" list in this file.' };
  }
  const entries = Object.values(data.words);
  if (entries.some((e) => !e || typeof e !== 'object')) {
    return { error: IMPORT_DAMAGED, detail: 'Some word entries are not readable.' };
  }
  // A word tagged with a language this build has no pack for would be filed
  // under the fallback language and drill with the wrong dictionary.
  const unknown = [...new Set(entries.map((e) => e.lang).filter((id) => id && !LANG.get(id)))];
  if (unknown.length) {
    return {
      error: 'This file holds words in a language this version of Vocab-track does not have. '
        + 'Nothing was imported. Update the extension, then import it again.',
      detail: `Language code: ${unknown.join(', ')}`
    };
  }
  return { data };
}

$('import-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const note = $('io-note');
  try {
    const { data, error, detail } = readBackup(await file.text());
    if (error) setNote(note, error, { error: true, detail });
    else confirmImport(note, data, await getWords());
  } catch (err) {
    console.error('[vocab-track] import read failed', err);
    setNote(note, 'Could not read this file. Choose it again.', { error: true, detail: err.message });
  } finally {
    event.target.value = '';
  }
});

// Nothing is written until the file's effect has been read: an import merges
// into folders and pins across the whole library and has no undo, so a wrong
// or old backup is caught here, by its counts, or not at all.
function confirmImport(note, data, current) {
  const words = Object.keys(data.words);
  const merged = words.filter((word) => current[word]).length;
  const added = words.length - merged;
  setNote(note, `This file adds ${added} word${added === 1 ? '' : 's'} and merges `
    + `${merged} with words you already have.`);
  const row = el('div', 'dlgrow');
  const go = el('button', 'btn small', 'Import');
  const cancel = el('button', 'btn ghost small', 'Cancel');
  go.type = cancel.type = 'button';
  row.append(go, cancel);
  note.append(row);
  go.focus();
  cancel.addEventListener('click', () => {
    setNote(note, 'Nothing was imported.');
    $('import-file').focus();
  });
  go.addEventListener('click', async () => {
    go.disabled = cancel.disabled = true;
    await importBackup(note, data);
    $('import-file').focus();
  });
}

async function importBackup(note, data) {
  try {
    let added = 0;
    let merged = 0;
    const current = await getWords();
    // Collected, then written once: a word list can hold thousands of entries,
    // and a putWord per word rewrites the whole map per word.
    const patches = {};
    for (const [word, incoming] of Object.entries(data.words)) {
      const existing = current[word];
      if (existing) {
        // Merge, never overwrite blindly: the more recently reviewed schedule
        // wins, so an older backup cannot roll a word back.
        patches[word] = VT.mergeWord(existing, incoming);
        merged++;
      } else {
        patches[word] = incoming;
        added++;
      }
    }
    await putWords(patches);
    for (const folder of Object.values(data.folders ?? {})) {
      if (folder.id !== VT.READING && folder.id !== VT.STARRED) await putFolder(folder);
    }
    // The rest of a v2 backup. Absent in an old export or a shipped list, and
    // then nothing below writes.
    const extra = {};
    if (Array.isArray(data.pins) && data.pins.length) {
      extra.pins = [...new Set([...(await getPins()), ...data.pins])];
      extra.pinsUpdated = Date.now();
    }
    if (data.history && typeof data.history === 'object') {
      const keys = Object.keys(data.history).map((day) => 'history:' + day);
      const local = keys.length ? await chrome.storage.local.get(keys) : {};
      for (const key of keys) extra[key] = VT.mergeHistory(local[key], data.history[key.slice(8)]);
    }
    if (data.practiceMisses && typeof data.practiceMisses === 'object') {
      // Only misses are restored; today's counts belong to this machine.
      const practice = await getPractice();
      for (const [word, n] of Object.entries(data.practiceMisses)) {
        practice.misses[word] = Math.max(practice.misses[word] ?? 0, Number(n) || 0);
      }
      extra.practice = practice;
    }
    if (Object.keys(extra).length) await chrome.storage.local.set(extra);
    // Name the language when the file lands somewhere this session is not
    // looking. Folders are language-scoped now, so importing the Korean list
    // from an English session puts 3,900 words and three folders on screen
    // nowhere at all — and an import that appears to do nothing reads as an
    // import that failed.
    const elsewhere = [...new Set(Object.values(data.words).map((e) => LANG.of(e).id))]
      .filter((id) => id !== activeLang)
      .map((id) => LANG.get(id)?.name ?? id);
    setNote(note, `Imported: ${added} new, ${merged} merged with existing entries.`
      + (elsewhere.length
        ? ` In ${elsewhere.join(' and ')} — switch the language toggle to see them.`
        : ''));
    await refresh();
  } catch (err) {
    // The file read fine, so this is the browser refusing the write.
    console.error('[vocab-track] import failed', err);
    setNote(note, 'Could not save the imported words. Import the file again; '
      + 'it merges, so nothing is doubled.', { error: true, detail: err.message });
  }
}

// Written by the service worker's automatic backup (service-worker.js).
function showBackup(last) {
  $('backup-status').textContent = last
    ? `Last automatic backup: ${new Date(last.at).toLocaleString()} \u2014 Downloads/${last.file}`
    : 'No automatic backup yet.';
}
chrome.storage.local.get('lastBackup').then(({ lastBackup }) => showBackup(lastBackup));

// The Cloud sync card. cloud.js does the work in the service worker and keeps
// its state in `cloud`, so this only draws that and sends the button presses.
// Mirrored here, with the hint's dismissal, so render() can redraw the overview
// banner when the word count moves without another storage read.
let cloudState = null;
let cloudHintDismissed = false;
// Below this an empty-ish profile has nothing worth syncing yet.
const CLOUD_HINT_WORDS = 10;

// The overview banner suggesting sign-in: signed out, enough words, and not
// dismissed. The dashboard only; the side panel is used mid-reading.
function showCloudHint() {
  $('cloud-hint').hidden = !!cloudState?.signedIn || cloudHintDismissed
    || Object.keys(words).length < CLOUD_HINT_WORDS;
  // A failed sign-in from the banner says so here too, not only in the
  // Cloud sync card two views away.
  const error = cloudState?.error ?? '';
  $('cloud-hint-error').hidden = !error;
  $('cloud-hint-error').textContent = error;
}

function showCloud(cloud) {
  cloudState = cloud ?? null;
  showCloudHint();
  const signedIn = !!cloud?.signedIn;
  $('cloud-out').hidden = signedIn;
  $('cloud-in').hidden = !signedIn;
  $('cloud-email').hidden = !cloud?.email;
  $('cloud-email').textContent = cloud?.email ? `Signed in as ${cloud.email}` : '';
  $('cloud-last').textContent = cloud?.lastSync
    ? `Last synced ${new Date(cloud.lastSync).toLocaleString()}`
    : 'Not synced yet.';
  setNote($('cloud-error'), cloud?.error ?? '', { error: !!cloud?.error });
}
chrome.storage.local.get(['cloud', 'cloudHintDismissed']).then((got) => {
  cloudHintDismissed = got.cloudHintDismissed === true;
  showCloud(got.cloud);
});
// Pull what other machines saved since. Fire and forget: the result lands in
// `cloud`, which the onChanged listener below draws; signed out it does nothing.
chrome.runtime.sendMessage({ type: 'cloud-sync' })
  ?.catch((err) => console.error('[vocab-track] cloud sync on open got no answer', err));

async function cloudPress(button, type, busy) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busy;
  try {
    await chrome.runtime.sendMessage({ type });
  } catch (err) {
    console.error('[vocab-track]', type, 'got no answer', err);
    const msg = 'Something went wrong. Reload the extension and try again.';
    setNote($('cloud-error'), msg, { error: true });
    $('cloud-hint-error').hidden = false;
    $('cloud-hint-error').textContent = msg;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}
$('cloud-signin').addEventListener('click', (e) => cloudPress(e.currentTarget, 'cloud-signin', 'Signing in\u2026'));
$('cloud-sync').addEventListener('click', (e) => cloudPress(e.currentTarget, 'cloud-sync', 'Syncing\u2026'));
$('cloud-signout').addEventListener('click', (e) => cloudPress(e.currentTarget, 'cloud-signout', 'Signing out\u2026'));
$('cloud-hint-signin').addEventListener('click', (e) => cloudPress(e.currentTarget, 'cloud-signin', 'Signing in\u2026'));
$('cloud-hint-dismiss').addEventListener('click', () => {
  cloudHintDismissed = true;
  showCloudHint();
  chrome.storage.local.set({ cloudHintDismissed: true })
    .catch((err) => console.error('[vocab-track] could not save the sign-in hint dismissal', err));
});

/* ---------- push to Anki ---------- */

// The origin AnkiConnect must whitelist. Shown in the settings card so the user
// can copy it into webCorsOriginList verbatim.
function ankiOrigin() {
  return `chrome-extension://${chrome.runtime.id}`;
}

// One of three sentences, because the three failures want different fixes.
// A thrown fetch is Anki not running; an error carrying 403/CORS/origin is the
// add-on refusing this extension; anything else is the add-on's own message.
function ankiMessage(err) {
  const msg = String(err?.message ?? err);
  if (/Failed to fetch|NetworkError|ERR_CONNECTION/i.test(msg)) {
    return 'Could not reach Anki. Open the Anki desktop app with the AnkiConnect '
      + 'add-on installed, then try again.';
  }
  if (/\b403\b|cors|origin/i.test(msg)) {
    return `AnkiConnect blocked this extension. Add ${ankiOrigin()} to its `
      + 'webCorsOriginList (Anki → Tools → Add-ons → AnkiConnect → Config), then '
      + 'restart Anki.';
  }
  return `AnkiConnect turned the request down (${msg}). Close any open window in `
    + 'Anki, then try again.';
}

// The deck the push goes to when the picker's first option is chosen: a fresh
// Vocab-track deck for the active language. createDeck makes it if it is new and
// is a no-op if it already exists, so this value is always safe to push to.
function ankiDefaultDeck() {
  return `Vocab-track::${LANG.get(activeLang).name}`;
}

// The picker's first option is the new-deck default; the rest are the decks Anki
// already has, loaded on a successful connection. The deck chosen last
// (`ankiDeck`, persisted) is re-added as an option even before that load, so it
// is selectable and selected on a fresh open — otherwise a per-word push would
// go to the default rather than where the user last chose. Runs on every render,
// re-selecting the chosen deck, which the change handler keeps current.
function syncAnkiDeck() {
  const sel = $('anki-deck');
  if (!sel) return;
  const def = ankiDefaultDeck();
  if (!sel.options.length) sel.add(new Option());
  sel.options[0].value = def;
  sel.options[0].textContent = `New deck: ${def}`;
  if (ankiDeck && ankiDeck !== def && ![...sel.options].some((o) => o.value === ankiDeck)) {
    sel.add(new Option(ankiDeck, ankiDeck));
  }
  const want = ankiDeck || def;
  if ([...sel.options].some((o) => o.value === want)) sel.value = want;
}

// Fill the picker with the decks Anki already has, keeping the new-deck default
// first, then re-select the chosen deck.
async function loadAnkiDecks() {
  const names = await ankiInvoke('deckNames');
  const sel = $('anki-deck');
  const def = sel.options[0]?.value;
  while (sel.options.length > 1) sel.remove(1);
  for (const name of [...names].sort()) {
    if (name !== def) sel.add(new Option(name, name));
  }
  syncAnkiDeck();
}

async function testAnki() {
  const note = $('anki-note');
  setNote(note, 'Testing…');
  try {
    const version = await ankiInvoke('version');
    await loadAnkiDecks();
    await markAnkiReady();
    // So the per-word Push to Anki control appears on the word cards now that a
    // connection has worked.
    render();
    setNote(note, `Connected to AnkiConnect (version ${version}). Your decks are in the picker.`);
  } catch (err) {
    setNote(note, ankiMessage(err), { error: true });
  }
}

// One word to Anki, from its card. The deck is whatever the Import & export
// picker holds, so the choice is made in one place. The result is recorded on
// the word, which is what the Anki chip's check reads.
async function pushWordToAnki(entry, chip) {
  if (pushingAnki) return;
  pushingAnki = true;
  const was = [...chip.childNodes];
  chip.textContent = 'Anki…';
  try {
    const deck = $('anki-deck').value || ankiDefaultDeck();
    await ankiInvoke('createDeck', { deck });
    const folderNames = VT.foldersOf(entry)
      .filter((id) => folders[id] && !folders[id].auto)
      .map((id) => folders[id].name);
    const [id] = await ankiInvoke('addNotes', { notes: [ankiNote(entry, deck, folderNames)] });
    // A null id is "already in this deck" (a duplicate), which still means the
    // word is there — so both record the push.
    await putWord(entry.word, { anki: { deck, noteId: id ?? null, at: Date.now() } });
    words[entry.word] = { ...entry, anki: { deck, noteId: id ?? null, at: Date.now() } };
    await markAnkiReady();
    render();
  } catch (err) {
    chip.replaceChildren(...was);
    chip.title = ankiMessage(err);
    chip.classList.add('anki-err');
  } finally {
    pushingAnki = false;
  }
}

let pushingAnki = false;

async function pushToAnki() {
  if (pushingAnki) return;
  const note = $('anki-note');
  const lang = LANG.get(activeLang);
  // The same scope the review uses: this language, skipped words left out.
  const scope = Object.values(words)
    .filter((entry) => VT.isLearnable(entry) && LANG.of(entry).id === activeLang);
  if (!scope.length) {
    setNote(note, `No ${lang.name} words to push.`);
    return;
  }
  const btn = $('anki-push');
  btn.disabled = true;
  setNote(note, `Pushing ${scope.length} ${lang.name} word${scope.length === 1 ? '' : 's'}…`);
  try {
    const { added, skipped, deck } = await pushEntriesToAnki(scope);
    setNote(note, `Added ${added} to “${deck}” · ${skipped} already in Anki.`);
  } catch (err) {
    setNote(note, ankiMessage(err), { error: true });
  } finally {
    btn.disabled = false;
  }
}

// Many words to the picked deck in one addNotes, recorded on each word in one
// write: the Settings button's whole language and the List's selection.
// Resolves to { added, skipped, deck }, or null while another push runs;
// AnkiConnect's errors are thrown for the caller to word.
async function pushEntriesToAnki(scope) {
  if (pushingAnki) return null;
  pushingAnki = true;
  try {
    // Whatever deck is picked — an existing one, or the new-deck default.
    // createDeck is a no-op on a deck that already exists.
    const deckName = $('anki-deck').value || ankiDefaultDeck();
    await ankiInvoke('createDeck', { deck: deckName });
    const notes = scope.map((entry) => ankiNote(entry, deckName,
      // Real folders only, not From reading / Starred — a `From_reading` tag on
      // every single note is noise. Same auto filter renderCard uses (:1096).
      VT.foldersOf(entry)
        .filter((id) => folders[id] && !folders[id].auto)
        .map((id) => folders[id].name)));
    // addNotes returns an id per note, or null where the note was a duplicate or
    // could not be added — so the count of nulls is what was already in Anki.
    const result = await ankiInvoke('addNotes', { notes });
    const added = (result ?? []).filter((id) => id != null).length;
    const skipped = (result ?? []).length - added;
    // Record the push on every word in the batch — a null id is a duplicate
    // already in the deck, which is still "in Anki" — so the check shows.
    const at = Date.now();
    const patches = {};
    scope.forEach((entry, i) => {
      const anki = { deck: deckName, noteId: (result ?? [])[i] ?? null, at };
      patches[entry.word] = { anki };
      if (words[entry.word]) words[entry.word].anki = anki;
    });
    await putWords(patches);
    await markAnkiReady();
    render();
    return { added, skipped, deck: deckName };
  } finally {
    pushingAnki = false;
  }
}

$('anki-origin').textContent = ankiOrigin();
syncAnkiDeck();
$('anki-test').addEventListener('click', testAnki);
$('anki-push').addEventListener('click', pushToAnki);
// The chosen deck is persisted, so a per-word push on a later session lands in
// the same deck without opening this view again.
$('anki-deck').addEventListener('change', (event) => {
  ankiDeck = event.target.value;
  chrome.storage.local.set({ ankiDeck });
});

/* ---------- search & shortcuts ---------- */

$('q').addEventListener('input', () => {
  if (!$('view-words').hidden) { render(); return; }
  showView('words');
  render();
});

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
    event.preventDefault();
    $('q').focus();
    $('q').select();
  }
  if (event.key === 'Escape' && document.activeElement === $('q')) {
    $('q').value = '';
    render();
  } else if (event.key === 'Escape' && pickedRows.size && !$('view-words').hidden
      && !document.querySelector('dialog[open]')) {
    clearPicked();
    announce('Selection cleared.');
  }
  // "?" opens the shortcut sheet from anywhere, except where it is already
  // something else: a character in any box, or practice's "I don't know".
  if (event.key === '?' && !event.ctrlKey && !event.metaKey && !event.altKey
      && !event.target.closest?.('input, textarea, select, [contenteditable]')
      && !document.querySelector('dialog[open]') && !PRACTICE.owns()) {
    event.preventDefault();
    openHelp('keys-dlg');
  }
});

/* ---------- help ---------- */

// The shortcut sheet, built from the handlers' own tables so it cannot drift
// from them: GRADES for the digits, MOD_KEY for ⌘ or Ctrl. Built on open,
// because both are declared further down this file.
function renderKeys() {
  const groups = [
    ['Anywhere', [
      [[`${MOD_KEY}K`], 'Search your words'],
      [['?'], 'Show these shortcuts'],
      [['esc'], 'Clear the search, from the search box']
    ]],
    ['All words, as a list', [
      [['space'], 'Select the focused word; with shift, every word from the last one'],
      [['enter'], 'Open the focused word'],
      [['esc'], 'Clear the selection']
    ]],
    ['Reviewing a card', [
      [['enter'], 'Check what you typed, then take the grade it suggests'],
      [['space'], 'Show the answer on a card with no box to type in'],
      ...GRADES.map((g) => [[g.key], `${g.label} — ${g.hint}`]),
      [['r'], 'Hear the word again, once the answer shows'],
      [['s'], 'Star or unstar the word, when you are not typing'],
      [['t'], 'Add the word to a folder, once the answer shows'],
      [['z', `${MOD_KEY}Z`], 'Undo the last grade, for five seconds'],
      [['esc'], 'Finish for now']
    ]],
    ['Practice tabs', [
      [['h'], 'Show a hint, when the question has one'],
      [['?'], 'I don’t know — show the answer'],
      [['esc'], 'Back to the flashcard']
    ]]
  ];
  $('keys-list').replaceChildren(...groups.flatMap(([title, rows]) => {
    const dl = el('dl', 'keys');
    for (const [keys, text] of rows) {
      const dt = document.createElement('dt');
      // "z or ⌘Z": one action, on a bare card and from the typing box.
      keys.forEach((k, i) => dt.append(...(i ? [' or ', kbd(k)] : [kbd(k)])));
      const row = document.createElement('div');
      row.append(dt, el('dd', null, text));
      dl.appendChild(row);
    }
    return [el('h4', null, title), dl];
  }));
}

// The one way in for the Help items, "?" and the (?) beside Mastery and the
// folders. `section` scrolls the sheet to the part that was asked about.
function openHelp(id, section) {
  if (id === 'keys-dlg') renderKeys();
  $(id).showModal();
  $(id).scrollTop = 0;
  if (!section) return;
  $(section).scrollIntoView({ block: 'start' });
  // Onto the heading asked about, so a screen reader starts there rather than
  // at the top of the sheet.
  $(section).querySelector('h4').focus({ preventScroll: true });
}

$('help-keys').addEventListener('click', () => openHelp('keys-dlg'));
$('help-how').addEventListener('click', () => openHelp('how-dlg'));
$('rv-mastery-help').addEventListener('click', () => openHelp('how-dlg', 'how-mastery'));

/* ---------- theme ---------- */

// Paper is the default and stays the default; night is opt-in. The choice is
// saved to chrome.storage like every other setting, and mirrored to
// localStorage only so theme-boot.js can apply it before the first paint.
function applyTheme(theme) {
  const night = theme === 'night';
  if (night) document.documentElement.dataset.theme = 'night';
  else delete document.documentElement.dataset.theme;
  $('theme-btn').setAttribute('aria-pressed', String(night));
  // The name stays "Night theme" in both: a toggle's name is what pressing it
  // turns on, and aria-pressed says whether it is. A name that flips with
  // the state reads "Light theme, pressed" while night is on.
  try {
    localStorage.setItem('theme', night ? 'night' : 'light');
  } catch {
    // A blocked localStorage only costs the no-flash start; storage below
    // still holds the choice.
  }
}

function setTheme(theme) {
  applyTheme(theme);
  return chrome.storage.local.set({ theme });
}

/* ---------- the language toggle ---------- */

// Built from the registry, so a new pack appears here the moment its script
// is loaded. A dropdown at any count, not a segmented control: three short
// labels already crowd the top bar, and one path is less to keep in step.
// Hidden below two: a choice of one is not a choice, and every surface
// downstream already defaults to the one pack.
function renderLang() {
  const packs = LANG.list();
  $('lang-seg').hidden = packs.length < 2;
  if (packs.length < 2) return;
  const select = $('lang-select');
  select.replaceChildren(...packs.map((pack) => {
    const opt = el('option', null, pack.native ?? pack.name);
    opt.value = pack.id;
    return opt;
  }));
  select.value = activeLang;
}

$('lang-select').addEventListener('change', (e) => setLang(e.target.value));

async function setLang(id) {
  if (id === activeLang) return;
  await chrome.storage.local.set({ lang: id });
  // Writing the key is the whole change: refresh() re-reads it, and rebuilds the
  // session from the new language because it can see the queue no longer matches.
  // The toggle was never the only way the key moves, so it is not the place that
  // knows the session is stale.
  await refresh();
  // A click in the top bar takes focus off the typing box mid-review, which is
  // the problem the theme button already solves this way.
  refocusCard();
}

$('theme-btn').addEventListener('click', () => {
  setTheme(document.documentElement.dataset.theme === 'night' ? 'light' : 'night');
  // Mid-review the click took focus from the typing box; hand it back.
  refocusCard();
});
// chrome.storage is the truth: the mirror can be missing (cleared site data)
// or stale (the theme changed in another dashboard tab while this was shut).
chrome.storage.local.get('theme').then(({ theme }) => applyTheme(theme));

// The three API key fields: flat keys like `theme`, saved as you type, with a
// line under the field saying it went. Trimmed on write for the reason
// getGiphyKey trims on read, and the field itself trimmed once you leave it.
// A space left inside is a second paste or a copied label, never a key, so it
// is refused rather than saved to fail on the next lookup.
function keyField(id, name, onSave) {
  const field = $(id);
  const note = $(`${id}-note`);
  field.addEventListener('input', () => {
    const key = field.value.trim();
    if (/\s/.test(key)) {
      field.setAttribute('aria-invalid', 'true');
      setNote(note, 'A key has no spaces in it. Paste only the key itself.', { error: true });
      return;
    }
    field.removeAttribute('aria-invalid');
    onSave?.(key);
    chrome.storage.local.set({ [name]: key })
      .then(() => setNote(note, key ? 'Saved in this browser.' : 'Key removed.'))
      .catch((err) => {
        console.error('[vocab-track] could not save', name, err);
        setNote(note, 'Could not save the key. Reload this page and paste it again.', { error: true });
      });
  });
  field.addEventListener('change', () => { field.value = field.value.trim(); });
  chrome.storage.local.get(name).then((got) => { field.value = got[name] ?? ''; });
}
// The module copy of the GIPHY key is updated too, so a card rendered before the
// next refresh() still sees it. lookup.js and lang/ko/dictionary.js read the
// other two from storage on every lookup, so nothing here holds a copy.
keyField('giphy-key', 'giphyKey', (key) => { giphyKey = key; });
keyField('translate-key', 'translateKey');
keyField('krdict-key', 'krdictKey');

$('review-btn').addEventListener('click', () => {
  startReview(null);
  showView('review');
  render();
});
// The same session as the top bar's Review: the strip is a preview of it.
$('ov-today-go').addEventListener('click', () => $('review-btn').click());
$('ov-start-import').addEventListener('click', () => {
  showView('io');
  render();
});

// Another surface (the side panel, or a lookup from a page) can write while
// this tab is open; re-read rather than showing a stale list.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  // writeMistakes lands here while you are typing in another tab, which is the
  // only way this page ever sees the counts move.
  // Another dashboard tab flipped the theme: follow it.
  if (changes.theme) applyTheme(changes.theme.newValue);
  if (changes.lastBackup) showBackup(changes.lastBackup.newValue);
  if (changes.cloud) showCloud(changes.cloud.newValue);
  if (changes.cloudHintDismissed) {
    cloudHintDismissed = changes.cloudHintDismissed.newValue === true;
    showCloudHint();
  }
  // `lang` for the same reason as the theme, and with more at stake: it governs
  // six views, so a second dashboard tab left on the other language would keep
  // writing words into a list this one is filtering out.
  if (changes.words || changes.folders || changes.pins || changes.lang ||
      changes.writeOn || changes.writeOff || changes.writeMistakes) refresh();
});

/* ---------- words captured from other Mac apps ---------- */


// The Quick Action installed by tools/install-macos.sh queues whatever you
// selected, in any app, and exits. It deliberately does not talk to Chrome —
// Chrome may not even be running. So the queue is drained here, when you open
// the dashboard, which is also when you are present to see a word that could
// not be looked up.
//
// The service worker would be the obvious place instead, but it has no
// DOMParser, so it cannot run the Cambridge parser at all.
const CAPTURE_HOST = 'com.vocab_track.capture';

async function drainCaptures() {
  let reply;
  try {
    reply = await chrome.runtime.sendNativeMessage(CAPTURE_HOST, { cmd: 'drain' });
  } catch (err) {
    // Overwhelmingly the normal case: the host is not installed, which is fine
    // — every other part of the extension works without it.
    console.debug('[vocab-track] no capture host installed', err?.message ?? err);
    return;
  }
  const items = reply?.items ?? [];
  if (!items.length) return;

  const note = $('capture-note');
  note.hidden = false;
  note.textContent =
    `Looking up ${items.length} word${items.length === 1 ? '' : 's'} captured on your Mac…`;

  const saved = [];
  const missed = [];
  for (const item of items) {
    const parsed = VT.captureWord(item.text);
    if (!parsed) { missed.push(item.text); continue; }
    try {
      // Serial, not Promise.all: these are scraped pages, and twenty parallel
      // requests is how an IP gets rate-limited.
      const source = item.app ? `macos:${item.app}` : null;
      const result = await resolveWord(parsed.word, source, [], parsed.context);
      (result.notFound ? missed : saved).push(parsed.word);
    } catch (err) {
      console.error('[vocab-track] capture lookup failed for', parsed.word, err);
      missed.push(parsed.word);
    }
  }

  note.textContent = [
    saved.length ? `Added ${saved.length} from your Mac: ${saved.join(', ')}` : '',
    missed.length ? `Not found: ${missed.join(', ')}` : ''
  ].filter(Boolean).join('  ·  ') || 'Nothing to add.';
  await refresh();
}

refresh().then(() => {
  if (viewFromHash() !== 'review') return;
  openReviewByAddress();
  render();
}).then(backfillLevels).then(drainCaptures);


/* ---------- review ---------- */

const GRADES = [
  { q: 0, label: 'Blank', hint: 'no idea', key: '1' },
  { q: 3, label: 'Hard',  hint: 'barely',  key: '2' },
  { q: 4, label: 'Good',  hint: 'got it',  key: '3' },
  { q: 5, label: 'Easy',  hint: 'instant', key: '4' }
];

let queue = [];
let sessionTotal = 0;
let reviewScope = null;     // folder id, or null for everything due
let revealed = false;
let grading = false;
// The last grade or skip, kept for UNDO_MS so a stray key can be taken back:
// the entry's fields from before it, what was typed, and (for a grade) the
// history row's time. One slot — the next grade or skip replaces it, a new
// session drops it.
let lastGrade = null;
let undoTimer = 0;
const UNDO_MS = 5000;
// When the answer appeared. Enter both reveals and grades, so a double press
// (or a held key) would commit the suggested grade before you had read it.
let revealedAt = 0;
const ENTER_GRACE_MS = 300;
const MOD_KEY = /mac/i.test(navigator.userAgentData?.platform || navigator.platform) ? '⌘' : 'Ctrl ';
// What was typed for the card on screen, kept so the diff survives a re-render.
let typed = '';
// A card can only ask "type the word" if it has something to ask WITH. An entry
// saved while the dictionary and the translator were both down has neither a
// definition nor a Vietnamese gloss, and prompting with a blank card is
// unanswerable — those fall back to the old recognition card.
let canType = false;

const GRADE_FOR = { exact: 4, synonym: 4, near: 3, wrong: 0 };
// One day's worth, the same pace the imported list arrives at.
const AHEAD_BATCH = 20;

// The words a review session may draw from: learnable, in the active language,
// and in the folder if there is one.
//
// It has to be its own filter rather than render()'s, because `queue` is built
// once per session and survives every render — startReview reads the store
// itself, so nothing in render() can ever reach it. The language clause is not
// housekeeping either: a card is single-language by construction. The typing box
// wants one IME, VT.diffWord grades against one script, speakWord picks one
// voice and the placeholder names one language, so a Korean card inside an
// English queue means an IME switch mid-session on the one screen whose point is
// that you never touch the mouse.
function inScope(folderId) {
  return Object.values(words).filter((e) => VT.isLearnable(e)
    && LANG.of(e).id === activeLang
    && (!folderId || VT.foldersOf(e).includes(folderId)));
}

// Words that have never been graded and are not due yet — Anki's new queue.
function newCards(entries) {
  const now = Date.now();
  return entries.filter((e) => VT.isLearnable(e) && !e.reps && e.due > now)
    .sort((a, b) => a.due - b.due);
}

function startReview(folderId, { ahead = false } = {}) {
  reviewScope = folderId;
  // Recorded, not assumed: this is what lets refresh() tell a queue that has
  // gone stale from one that was just rebuilt for the same change.
  queueLang = activeLang;
  const now = Date.now();
  // isLearnable first, so a skipped word cannot be reached even by a
  // folder-scoped session or by the ahead-of-schedule new queue below.
  const scope = inScope(folderId);
  queue = scope
    .filter((e) => e.due <= now)
    // Oldest due first: the most overdue card is the one most at risk.
    .sort((a, b) => a.due - b.due);
  if (prefs.shuffle) queue = VT.shuffled(queue);
  // Anki's new cards are not overdue, they are simply not started yet, and an
  // imported word list is a thousand of them held back twenty a day. With the
  // day's work done, opening the folder has to offer the next ones rather than
  // an empty screen — the schedule is a pace, not a lock.
  if (ahead && !queue.length) {
    queue = newCards(scope).slice(0, AHEAD_BATCH);
    // Which twenty is still the schedule's call; shuffle only reorders them.
    if (prefs.shuffle) queue = VT.shuffled(queue);
  }
  sessionTotal = queue.length;
  revealed = false;
  typed = '';
  $('rv-input').value = '';
  // The queue Undo would put the card back into is gone.
  clearUndo();
}

// A review reached by address — a bookmark, Back, a typed #review — rather than
// by a Review button. The queue is the one that button would build, but only
// when no session has run yet: startReview() resets, and Back into a session
// half done must find it where it was left. Nothing is read aloud or graded.
function openReviewByAddress() {
  if (!sessionTotal) startReview(null);
}

function routeFromHash() {
  const name = viewFromHash() ?? 'overview';
  if (name === 'review') openReviewByAddress();
  showView(name, { push: false });
}

// The prompt must not contain its own answer. The sentence a word was saved
// from nearly always does, so it is blanked — VT.find is the same matcher
// the page highlighter uses, so `read` does not blank `already`.
function maskContext(text, word, lang) {
  return VT.blank(text, VT.find(word, text, lang));
}

function renderCard() {
  const scopeName = reviewScope ? folders[reviewScope]?.name : null;
  $('rv-title').textContent = scopeName ? `Review · ${scopeName}` : 'Review';

  renderSide();
  // A practice tab owns this cell while it is running, and render() runs on
  // every storage change — including the one practice itself makes after each
  // answer. Without this, un-hiding the flashcard below would put it on top of
  // a live quiz. The shell hides #rv-card and #rv-empty when a tab starts and
  // leaves them to this function once it stops.
  //
  // Undo goes with it: practice can grade the very card the snapshot holds,
  // and putting the old schedule back would erase that answer.
  if (PRACTICE.active()) { clearUndo(); return; }
  if (!queue.length) {
    $('rv-card').hidden = true;
    $('rv-empty').hidden = false;
    $('rv-exit').hidden = true;
    $('rv-sub').textContent = '';
    $('rv-prog-fill').style.width = sessionTotal ? '100%' : '0%';
    const scope = inScope(reviewScope);
    $('rv-empty-text').textContent = sessionTotal
      ? `Done — ${sessionTotal} card${sessionTotal === 1 ? '' : 's'} reviewed.`
      : (scope.length ? 'Nothing due. Come back later.'
        : 'Nothing to review yet. Save a word while you read and it comes back here as a flashcard.');
    // The locked practice tabs and what each is waiting for, in words on the
    // card: the tab's own title says it too, but only to a hover. Same test
    // and the same `why` as practice.js paintTab, so the two cannot disagree.
    const locked = PRACTICE.list()
      .filter((mode) => PRACTICE.eligibleFor(mode, scope).length < mode.min);
    $('rv-locked').hidden = !locked.length;
    $('rv-locked-list').replaceChildren(
      ...locked.map((mode) => {
        const item = el('li');
        item.append(el('b', null, mode.title), ` — ${mode.why}`);
        return item;
      }));
    // Without this the only way to the next twenty is back to the overview and
    // into the folder again — four clicks to keep doing the thing you are
    // already doing.
    const waiting = newCards(scope).length;
    $('rv-more').hidden = !waiting;
    $('rv-more').textContent = `Learn ${Math.min(AHEAD_BATCH, waiting)} more`;
    return;
  }

  const entry = queue[0];
  const done = sessionTotal - queue.length;
  $('rv-empty').hidden = true;
  $('rv-card').hidden = false;
  $('rv-exit').hidden = false;
  $('rv-sub').textContent = `${done + 1} of ${sessionTotal}`;
  $('rv-prog-fill').style.width = `${(done / sessionTotal) * 100}%`;

  // Replay the entry animation only when the card is showing a different word.
  // Re-running it on reveal would animate the answer appearing, which reads as
  // a glitch rather than as progress.
  const card = $('rv-card');
  if (card.dataset.word !== entry.word) {
    card.dataset.word = entry.word;
    card.classList.remove('fresh');
    void card.offsetWidth;   // forces the restart; without it the class re-adds in the same frame and nothing plays
    card.classList.add('fresh');
  }

  canType = !!(entry.vi || entry.def);
  $('rv-level').textContent = VT.levelText(entry) ?? DASH;
  $('rv-level').title = entry.levelEst ? 'Estimated from word frequency' : '';
  // Instruction text, and wrong on screen the moment a Korean card appears. Per
  // card rather than per toggle, because the card is the thing being asked for;
  // dashboard.html's attribute is only the value before the first render.
  $('rv-input').placeholder = `type the ${LANG.of(entry).name} word`;
  // What is typed is the word; the placeholder is English, but the box is for
  // the answer, so it takes the word's language (IME and spellcheck read it).
  $('rv-input').lang = wordLang(entry);

  // The prompt is the meaning; the word is what you produce. A card with
  // nothing to prompt with shows the word instead and goes back to being a
  // recognition card.
  $('rv-vi').textContent = canType ? (entry.vi ?? '') : '';
  $('rv-vi').lang = 'vi';
  $('rv-def').textContent = canType ? (entry.def ?? '') : '';
  $('rv-def').lang = defLang(entry);
  const seen = $('rv-context');
  seen.lang = wordLang(entry);
  const context = entry.context
    ? (revealed ? entry.context : maskContext(entry.context, entry.word, entry.lang))
    : '';
  seen.hidden = !context;
  seen.textContent = context;

  // The IPA and the play button are the answer's shape and the answer's sound.
  // Both would hand it to you, so neither appears until you have committed.
  //
  // IPA between slashes, or the pack's romanisation under its label (Pinyin).
  $('rv-ipa').hidden = !(revealed && entry.ipa);
  $('rv-ipa').textContent = VT.pronText(entry.ipa, LANG.of(entry));
  $('rv-play').hidden = !revealed;
  $('rv-play').onclick = () => speakWord(entry);

  // Labelled with where the word already is, so the card answers "did I file
  // this one?" without opening anything.
  const filed = VT.foldersOf(entry).filter((id) => folders[id] && !folders[id].auto)
    .map((id) => folders[id].name);
  $('rv-tag').hidden = !revealed;
  $('rv-tag').replaceChildren(...(filed.length ? [VT.icon('folder')] : []),
    el('span', null, filed.length ? filed.join(', ') : '+ Folder'), kbd('t'));
  $('rv-tag').setAttribute('aria-label', filed.length ? `In ${filed.join(', ')}. Change folders` : 'Add this word to a folder');
  $('rv-tag').onclick = () => openTagPicker(entry);

  $('rv-type').hidden = revealed;
  $('rv-tip').hidden = revealed || !canType;
  $('rv-input').hidden = !canType;
  $('rv-type').querySelector('button').textContent = canType ? 'Check ' : 'Show answer ';
  $('rv-type').querySelector('button').append(kbd('enter'));

  // Focused so the session is pure typing: no click is needed between cards.
  // The box is emptied where the card changes (startReview, grade, skip), not
  // here: a star or a storage change re-renders mid-answer, and that must not
  // throw away half a typed word.
  if (!revealed && canType) $('rv-input').focus();
  renderStar(entry);

  // The answer is only written into the DOM once revealed, so it is never
  // sitting in the page while you are still trying to recall it. The dictionary
  // href and the full entry are written here for the same reason: both spell
  // the word out.
  $('rv-answer').hidden = !revealed;
  $('rv-word').textContent = revealed ? entry.word : '';
  $('rv-word').lang = wordLang(entry);
  // How long the word is, for the size rule in dashboard.css: a long one is set
  // smaller to stay on one line rather than breaking mid-word at 46px.
  $('rv-word').style.setProperty('--len', [...entry.word].length);
  // The attribute is removed rather than blanked, so before the answer this is
  // an inert <a> and not a focusable link to the top of the page.
  const dict = revealed ? LANG.dict(LANG.of(entry).id) : null;
  // The label is written with the href rather than left to dashboard.html's
  // static text. The side panel (sidepanel.js:126) and the word card
  // (dashboard.js:378) already read dict.name; this was the one surface that
  // would have pointed a Korean card at krdict under a Cambridge name.
  //
  // The whole <p> goes when the language has no dictionary registered, not just
  // the href: an anchor with no href is still a line of text, and a label with
  // nothing behind it reads as a broken link rather than as an absent one.
  $('rv-cam').parentElement.hidden = !dict;
  if (dict) {
    $('rv-cam').href = dict.href(entry.word);
    $('rv-cam').replaceChildren(dict.name);
    withIcon($('rv-cam'), 'external', true);
  } else {
    $('rv-cam').removeAttribute('href');
  }
  renderFull(revealed ? entry : null);
  renderGif(revealed ? entry : null);
  renderDiff(revealed && canType ? VT.checkAnswer(typed, entry) : null, entry.word);
  renderGrades(revealed ? suggestedGrade() : null);
}

let finding = false;

// The GIF on the back of a card. Three states: a stored GIF (the image, the
// GIPHY credit, and the re-roll/remove controls), a key set but no GIF yet (the
// Find button), and no key at all (nothing on screen — the key goes in the
// Import & export view).
//
// Idempotent on the image. renderCard runs on every storage change, including a
// star press mid-card, and rebuilding the <img> each pass would re-request the
// file and flicker, so an unchanged src is left alone. VT.giphyOk is applied
// here as well as in giphy.js: a gif URL can arrive from an imported export,
// which is untrusted, so it is checked again before it reaches an <img src>.
function renderGif(entry) {
  const host = $('rv-gif');
  if (!entry) { host.hidden = true; host.replaceChildren(); return; }

  if (entry.gif && VT.giphyOk(entry.gif)) {
    host.hidden = false;
    if (host.querySelector('img')?.src === entry.gif) return;  // already on screen
    const img = el('img', 'rvgifimg');
    img.src = entry.gif;
    img.alt = `A GIF for ${entry.word}`;
    img.loading = 'lazy';
    const row = el('div', 'rvgifrow');
    const again = el('button', 'rvgifbtn', 'Try another');
    again.onclick = () => findGif(entry);
    const drop = el('button', 'rvgifbtn', 'Remove');
    drop.onclick = () => removeGif(entry);
    // "via GIPHY" is the attribution GIPHY's terms ask for, next to the image.
    row.append(el('span', 'rvgifvia', 'via GIPHY'), again, drop);
    host.replaceChildren(img, row);
    return;
  }

  // No key means no button: the feature is off until one is set, and a dead
  // button would only prompt a lookup nothing can answer.
  if (!giphyKey) { host.hidden = true; host.replaceChildren(); return; }
  host.hidden = false;
  const btn = withIcon(el('button', 'rvgifbtn', 'Find GIF'), 'film');
  btn.onclick = () => findGif(entry);
  host.replaceChildren(btn);
}

// Search GIPHY for this word and store the result on the entry. The schedule is
// never touched — a GIF is a decoration on the card, not a review of it. Shared
// by the review card and the words-list card, so both find and store a GIF the
// same way; each caller owns its own rendering.
async function searchGif(entry) {
  const { url, failed } = await giphyFind(entry);
  if (url) {
    await putWord(entry.word, { gif: url });
    entry.gif = url;
    words[entry.word] = entry;
  }
  return { url, failed };
}

async function findGif(entry) {
  // Same re-entry guard as grade()/toggleStar(): a double-click is two GIPHY
  // calls against a 42-an-hour budget.
  if (finding) return;
  finding = true;
  const host = $('rv-gif');
  host.hidden = false;
  host.replaceChildren(el('span', 'rvgifwait', 'Searching GIPHY…'));
  try {
    const { url, failed } = await searchGif(entry);
    finding = false;
    // A slow search can land after you have moved to the next card; let the new
    // card own the cell rather than painting this result over it.
    if (queue[0]?.word !== entry.word) { renderCard(); return; }
    renderGif(entry);
    if (!url) {
      host.append(el('p', 'rvgifmsg', failed
        ? `Could not fetch a GIF — ${failed}`
        : `No GIF found for “${giphyQuery(entry).q}”.`));
    }
  } catch (err) {
    finding = false;
    console.error('[vocab-track] find gif failed for', entry.word, err);
    if (queue[0]?.word === entry.word) renderGif(entry);
  }
}

async function removeGif(entry) {
  await putWord(entry.word, { gif: null });
  delete entry.gif;
  words[entry.word] = entry;
  renderGif(entry);
}

function kbd(text) {
  const el = document.createElement('kbd');
  el.textContent = text;
  return el;
}

// Which grade Enter takes. Typing already said how well you knew it, so making
// you also pick a number would be asking the same question twice; 1-4 still
// override it.
function suggestedGrade() {
  if (!canType) return null;
  const d = VT.checkAnswer(typed, queue[0]);
  if (d.exact) return GRADE_FOR.exact;
  if (d.synonym) return GRADE_FOR.synonym;
  if (d.near) return GRADE_FOR.near;
  return GRADE_FOR.wrong;
}

function renderDiff(diff, word) {
  const node = $('rv-diff');
  node.replaceChildren();
  node.hidden = !diff;
  if (!diff) return;

  if (diff.exact) {
    node.className = 'rvdiff good';
    node.textContent = 'Correct';
    return;
  }
  // Right word, just not this card's: shown as typed, never as a slip.
  if (diff.synonym) {
    node.className = 'rvdiff good';
    node.textContent = `${typed.trim()} — a synonym of ${word}`;
    return;
  }
  node.className = diff.near ? 'rvdiff near' : 'rvdiff bad';
  // Marked up rather than described: seeing `pi[d]geon` is the correction.
  // Built from nodes, never innerHTML — this string is whatever was typed.
  const line = document.createElement('span');
  for (const mark of diff.typed) {
    const part = document.createElement(mark.ok ? 'span' : 'u');
    part.textContent = mark.text;
    line.append(part);
  }
  if (diff.typed.length) {
    node.append(line, document.createTextNode(diff.near ? ' — almost' : ' — not this time'));
  } else {
    // Not "Not asked": that is a word you said not to ask again (All words'
    // filter, the undo after Don't ask again). An empty box is graded Blank.
    node.textContent = 'No answer';
  }
}

// Enter from the typing form. Commits whatever is in the box — including
// nothing, which is how you say "no idea" without reaching for the mouse.
function submitAnswer() {
  if (revealed || !queue.length) return;
  typed = canType ? $('rv-input').value : '';
  revealed = true;
  revealedAt = performance.now();
  renderCard();
  // Off the box once the grades appear, or 1-4 would type digits into it
  // instead of grading. This is what lets one set of keys serve both halves of
  // the card. Onto the grade Enter takes rather than a bare blur(), which left
  // a keyboard user on <body> with Tab starting from the top of the page.
  placeFocus();
  const diff = $('rv-diff');
  announce(`${diff.hidden ? '' : `${diff.textContent}. `}The answer is ${queue[0].word}.`);
  if (prefs.autoplay) speakWord(queue[0]);
}

// Where focus belongs after a card changes under the user's hand: the box on a
// card you type, the grade Enter takes once the answer shows, the card itself
// when it has no grades (a recognition card grades on 1-4 only), and the
// session's way on when the queue is done. Every one of these replaces the
// control that had focus, which would otherwise drop it to <body>. Called from
// the handlers, not renderCard: a storage change re-renders too, and must not
// pull focus off the star or the settings.
function placeFocus() {
  if ($('view-review').hidden) return;
  const target = !queue.length ? [$('rv-more'), $('rv-back')].find((b) => !b.hidden)
    : !revealed ? (canType ? $('rv-input') : $('rv-type').querySelector('button'))
    : $('rv-grades').querySelector('.pick') ?? $('rv-card');
  target?.focus();
}

// Review's outcomes, said aloud to a screen reader through the polite live
// region in dashboard.html. The card is redrawn in place and focus does not
// move, so without this nothing tells a non-sighted user what just happened.
// Called from the handlers, never from renderCard: render() re-runs that on
// every storage change and would repeat the line.
function announce(text) {
  $('sr-live').textContent = text;
}

// What grade() and skipCard() say once the card has moved on: the session's
// "Done" line when that was the last card, else what happened to this one.
function announceNext(said) {
  announce(queue.length ? said : $('rv-empty-text').textContent);
}

// The one function in the extension that WRITES a schedule. Review calls it
// through grade() below, practice through PRACTICE.hooks.scheduled — one seam,
// so a card cannot be moved two different ways. The scheduler is run in two
// other places, VT.forecast (lib.js:423) and the next-to-master preview in
// renderSide (:1529), and both are pure simulation: they read the answer and
// store nothing. Grepping the scheduler by name is how that invariant is
// checked, so those three call sites are the only ones there should ever be.
async function applyGrade(entry, quality) {
  const patch = VT.schedule(entry, quality);
  Object.assign(entry, patch);
  await putWord(entry.word, patch);
  recordReview(entry.word, quality, patch.lastReview);
  // Mirrored here so Statistics moves without a reload, as `words` does.
  reviewLog.push({ word: entry.word, quality, at: patch.lastReview });
  words[entry.word] = entry;
  return patch;
}

async function grade(quality) {
  // Re-entry guard: putWord awaits a storage round-trip during which the
  // buttons stay live, and a second press would shift a card the user never saw.
  if (grading || !revealed || !queue.length) return;
  grading = true;
  try {
    const entry = queue.shift();
    const before = Object.fromEntries(VT.SCHEDULE_FIELDS.map((f) => [f, entry[f]]));
    const patch = await applyGrade(entry, quality);
    // A lapse returns to the back of this session's queue, so it is seen again
    // today; sessionTotal grows with it so the counter stays honest.
    if (quality < 3) {
      queue.push(entry);
      sessionTotal++;
    }
    lastGrade = { entry, before, typed, at: patch.lastReview, lapsed: quality < 3 };
    revealed = false;
    typed = '';
    $('rv-input').value = '';
    renderCard();
    placeFocus();
    const label = GRADES.find((g) => g.q === quality)?.label ?? 'Graded';
    showUndo(`Graded ${label}`);
    announceNext(`${label}: ${entry.word}.`);
  } finally {
    grading = false;
  }
}

function showUndo(text) {
  $('rv-undo-text').textContent = text;
  // The box takes every bare letter, so a card you can type on is undone with
  // the platform's own undo chord instead of z.
  $('rv-undo-btn').replaceChildren('Undo', kbd(queue.length && canType ? `${MOD_KEY}Z` : 'z'));
  $('rv-undo').classList.add('on');
  clearTimeout(undoTimer);
  undoTimer = setTimeout(clearUndo, UNDO_MS);
}

function clearUndo() {
  lastGrade = null;
  clearTimeout(undoTimer);
  $('rv-undo').classList.remove('on');
}

// Puts the last graded card back on screen, answer showing, as it was before
// the grade: its old schedule in storage, its history row gone, and the lapse
// copy (if it was one) out of the back of the queue. The card that had moved up
// goes back to waiting behind it, unrevealed. A skip comes back the same way,
// as it was: `skipped` put back, revealed only if it had been.
// ponytail: a sync that ran inside the five seconds has already sent the graded
// copy, and mergeWord keeps the later lastReview; undo is local until it syncs.
async function undoGrade() {
  if (grading || !lastGrade || PRACTICE.active()) return;
  grading = true;
  const { entry, before, at, lapsed, typed: wasTyped, skip, wasRevealed } = lastGrade;
  clearUndo();
  try {
    if (lapsed) {
      const i = queue.findLastIndex((e) => e.word === entry.word);
      if (i >= 0) { queue.splice(i, 1); sessionTotal--; }
    }
    // undefined is dropped when chrome.storage serialises the word, which is
    // what a never-graded card's missing fields have to go back to.
    await putWord(entry.word, before);
    if (!skip) unrecordReview(entry.word, at);
    for (const [f, v] of Object.entries(before)) {
      if (v === undefined) delete entry[f];
      else entry[f] = v;
    }
    words[entry.word] = entry;
    const row = skip ? -1 : reviewLog.findLastIndex((r) => r.word === entry.word && r.at === at);
    if (row >= 0) reviewLog.splice(row, 1);
    queue.unshift(entry);
    typed = wasTyped;
    $('rv-input').value = '';
    revealed = !skip || wasRevealed;
    revealedAt = performance.now();
    renderCard();
    // Undo hides itself, so the button that was pressed is gone.
    placeFocus();
    announce(`${skip ? 'Skip' : 'Grade'} undone. ${entry.word} is back.`);
  } finally {
    grading = false;
  }
}

$('rv-undo-btn').addEventListener('click', undoGrade);

// Rebuilt per card rather than built once, because which button Enter will
// press changes with what you typed and the marking has to move with it.
function renderGrades(suggested) {
  const host = $('rv-grades');
  // A storage change re-renders the card under a focused grade; put focus back
  // on the same one, or the rebuild drops it to <body>.
  const had = [...host.children].indexOf(document.activeElement);
  host.replaceChildren();
  if (suggested === null) return;
  for (const g of GRADES) {
    const button = document.createElement('button');
    const label = document.createElement('b');
    label.textContent = g.label;
    const hint = document.createElement('span');
    hint.append(kbd(g.key), g.hint);
    button.append(label, hint);
    // Without it the name runs the parts together: "Blank 1no idea".
    button.setAttribute('aria-label', `${g.label}, ${g.hint}`);
    button.setAttribute('aria-keyshortcuts', g.key);
    if (g.q === suggested) {
      button.className = 'pick';
      hint.replaceChildren(kbd(g.key), kbd('enter'));
    }
    button.addEventListener('click', () => grade(g.q));
    host.appendChild(button);
  }
  host.children[had]?.focus();
}

// The card prompts with one definition. Everything else Cambridge gave us was
// parsed and stored at save time and then never shown anywhere but the word
// card — this is that, on the card, at the moment it is worth reading.
//
// Open state is remembered across cards: renderCard rebuilds the card on every
// grade, and wanting the detail once means wanting it on the next one too.
let fullOpen = false;

function renderFull(entry) {
  const box = $('rv-full');
  const body = $('rv-full-body');
  body.replaceChildren();
  // The first sense is already the prompt's definition, so only the rest of
  // them count as "more".
  const senses = entry?.senses?.slice(1) ?? [];
  const groups = [
    ['Synonyms', entry?.synonyms],
    ['Opposites', entry?.opposites],
    ['Related words', entry?.related]
  ].filter(([, items]) => items?.length);

  // A drawer with nothing in it is worse than no drawer.
  box.hidden = !entry || (!senses.length && !groups.length);
  if (box.hidden) return;
  box.open = fullOpen;

  if (senses.length) {
    body.appendChild(el('h3', null, senses.length === 1 ? 'Another meaning' : 'Other meanings'));
    const list = el('ol');
    for (const sense of senses) {
      const li = inLang(el('li', null, sense.def ?? DASH), defLang(entry));
      if (sense.level) li.appendChild(inLang(el('span', 'lvl', sense.level), 'en'));
      if (sense.example) li.appendChild(inLang(el('span', 'ex', sense.example), wordLang(entry)));
      list.appendChild(li);
    }
    body.appendChild(list);
  }

  for (const [label, items] of groups) {
    body.appendChild(el('h3', null, label));
    const chips = inLang(el('div', 'chips'), wordLang(entry));
    for (const word of items) chips.appendChild(el('span', 'tag', word));
    body.appendChild(chips);
  }
}

$('rv-full').addEventListener('toggle', () => { fullOpen = $('rv-full').open; });

// Not a delete and not a grade: the word leaves the rotation and keeps
// everything else. No confirm() — it is undone in place, with the grade's Undo,
// or later with one click in All words; a dialog on a button pressed dozens of
// times a session is the wrong tax.
async function skipCard() {
  if (grading || !queue.length) return;
  grading = true;
  try {
    const entry = queue.shift();
    const before = { skipped: entry.skipped };
    await putWord(entry.word, { skipped: true });
    entry.skipped = true;
    words[entry.word] = entry;
    lastGrade = { entry, before, typed, skip: true, wasRevealed: revealed };
    revealed = false;
    typed = '';
    $('rv-input').value = '';
    renderCard();
    placeFocus();
    showUndo('Won’t ask again');
    announceNext(`${entry.word} will not be asked again.`);
  } finally {
    grading = false;
  }
}

$('rv-skip').addEventListener('click', skipCard);

$('rv-type').addEventListener('submit', (event) => {
  event.preventDefault();
  submitAnswer();
});
$('w-review').addEventListener('click', () => {
  startReview(activeFolder, { ahead: true });
  showView('review');
  render();
});

$('rv-more').addEventListener('click', () => {
  startReview(reviewScope, { ahead: true });
  renderCard();
});

$('rv-back').addEventListener('click', () => { showView('overview'); render(); });

document.addEventListener('keydown', (event) => {
  if ($('view-review').hidden || document.activeElement === $('q')) return;
  // Same for a practice session: a Listening answer or a Card Blast word is
  // typed, and its digits and letters must not grade the card behind it. It
  // used to be the dialog's own open state; with practice in this view, "3" on
  // a quiz question would otherwise both answer it and grade the card behind
  // it. owns() is wider than a running tab on purpose — a selfTest presses the
  // same digits with no DOM of its own to hide behind.
  if (PRACTICE.owns()) return;
  // An open dialog owns the keyboard: typing a tag name must not grade the
  // card, "1" over the shortcut sheet must not grade the card behind it, and
  // Esc closes the dialog rather than the session.
  if (document.querySelector('dialog[open]')) return;
  if (event.key === 'Escape') {
    // A practice tab's Esc lands here too, after practice.js has already
    // handed the cell back to the flashcard; it must stay on that card.
    if (event.defaultPrevented) return;
    event.preventDefault();
    showView('overview');
    render();
    return;
  }
  // The session controls, the practice tabs, the star and the theme button own
  // their own keys: Space flips the switch, Enter presses the button, a letter
  // picks a voice. Only the bare card gets the shortcuts. The tab strip is in
  // this list because keydown runs before the click it becomes — tabbing to
  // Quiz and pressing Enter would otherwise reveal the card behind it, and
  // autoplay would read the answer out, a moment before the tab covered it up.
  if (event.target.closest?.('.rvsettings, .prtabs, #rv-star, #theme-btn')) return;
  // Undo. The chord works from an empty box too — the next card has already
  // focused it, and there is nothing in it for the browser's own undo to take
  // back. A box with text keeps the chord for its text.
  if ((event.key === 'z' || event.key === 'Z') && lastGrade) {
    const chord = event.metaKey || event.ctrlKey;
    const inBox = document.activeElement === $('rv-input');
    if (chord ? !(inBox && $('rv-input').value) : !inBox) {
      event.preventDefault();
      undoGrade();
      return;
    }
  }
  // While the box has focus every other key belongs to it — a digit is a digit
  // and `r` is a letter. Enter is the exception, and the form handles that.
  if (document.activeElement === $('rv-input')) return;
  // A focused control — the grade placeFocus put you on, one you tabbed to,
  // Pronounce — takes its own Enter and Space, so Enter on Blank grades Blank
  // rather than the suggestion. Except inside the grace window: the press that
  // revealed, held or doubled, lands here now that focus moved to a grade.
  if ((event.key === 'Enter' || event.key === ' ')
      && event.target.closest?.('button, a[href], summary')) {
    if (revealed && (event.repeat || performance.now() - revealedAt < ENTER_GRACE_MS)) event.preventDefault();
    return;
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    // A second Enter right behind the one that revealed, or the first one held
    // down, would grade a card whose answer you have not looked at yet.
    if (revealed && (event.repeat || performance.now() - revealedAt < ENTER_GRACE_MS)) return;
    if (!revealed) submitAnswer();
    else if (suggestedGrade() !== null) grade(suggestedGrade());
    return;
  }
  // Space still reveals, so a card with nothing to type against works exactly
  // as it did before.
  if (event.key === ' ' && !revealed) { event.preventDefault(); submitAnswer(); return; }
  if ((event.key === 'r' || event.key === 'R') && revealed && queue.length) {
    event.preventDefault();
    speakWord(queue[0]);
    return;
  }
  // 's' only reaches here with the box unfocused: before the answer it is a
  // letter of the word you are typing.
  if ((event.key === 's' || event.key === 'S') && queue.length) {
    event.preventDefault();
    toggleStar();
    return;
  }
  if ((event.key === 't' || event.key === 'T') && revealed && queue.length) {
    event.preventDefault();
    openTagPicker(queue[0]);
    return;
  }
  const g = GRADES.find((x) => x.key === event.key);
  if (g) { event.preventDefault(); grade(g.q); }
});

/* ---------- review controls, star, side cards ---------- */

async function getReviewPrefs() {
  const { reviewPrefs } = await chrome.storage.local.get('reviewPrefs');
  return { ...REVIEW_DEFAULTS, ...reviewPrefs };
}

function setReviewPrefs(patch) {
  prefs = { ...prefs, ...patch };
  renderPrefs();
  // Straight to storage, no refresh(): nothing else on the page reads these.
  return chrome.storage.local.set({ reviewPrefs: prefs });
}

function renderPrefs() {
  $('rv-shuffle').setAttribute('aria-pressed', String(prefs.shuffle));
  $('rv-autoplay').checked = prefs.autoplay;

  // The accents belong to the language, not to the app: English has Cambridge's
  // two recordings, Korean has one voice and nothing to choose between. A picker
  // with one option is hidden the way the card already hides an empty drawer.
  const voices = LANG.get(activeLang).voices;
  const voice = $('rv-voice');
  voice.replaceChildren(...voices.map((v) => {
    const option = document.createElement('option');
    option.value = v.id;
    option.textContent = v.label;
    return option;
  }));
  voice.parentElement.hidden = voices.length < 2;
  // reviewPrefs.accent is one string shared by every language, so on a language
  // that never heard of 'uk' it names no option here and the assignment would
  // silently keep the select empty. The options are built first for the same
  // reason: a value with no matching option does not stick.
  voice.value = voices.some((v) => v.id === prefs.accent) ? prefs.accent : voices[0].id;

  // Not the accent's hide rule: Korean has one pack voice and many OS voices.
  // A stored URI for a voice since uninstalled has no option and reads as
  // Automatic, which is also what speak() falls back to.
  const installed = globalThis.speechSynthesis?.getVoices() ?? [];
  const stored = prefs.voices?.[activeLang];
  // macOS's joke voices (Bells, Boing, Organ...) are not a pronunciation. The
  // same NOVELTY list Automatic skips, kept only when they are all there is
  // or when one is the stored choice, so the select never lies about the play button.
  const every = voicesFor(voices[0].bcp47, installed, voices[0].exact);
  const serious = every.filter((v) => !NOVELTY.test(v.name ?? '') || v.voiceURI === stored);
  const os = serious.length ? serious : every;
  const speaker = $('rv-speaker');
  // Voices, but none for this language: say so where the select was. An empty
  // list is not that — it may still be filling in — so it keeps Automatic.
  const none = installed.length > 0 && !os.length;
  speaker.parentElement.hidden = none;
  $('rv-speaker-none').hidden = !none;
  $('rv-speaker-none').textContent = none ? voiceHint(LANG.get(activeLang)) : '';
  speaker.replaceChildren(new Option('Automatic', ''), ...os.map((v) => new Option(v.name, v.voiceURI)));
  speaker.value = os.some((v) => v.voiceURI === stored) ? stored : '';
}

// A click moves focus off the typing box; give it back, or the next letters
// typed go nowhere. Not renderCard(): that would re-run the card for nothing.
function refocusCard() {
  if (!revealed && canType && queue.length && !$('view-review').hidden) $('rv-input').focus();
}

// The static controls' icons, from the same map as the built ones.
for (const [id, name] of [['rv-shuffle', 'shuffle'], ['rv-speaker-play', 'play'],
  ['rv-play', 'play'], ['rv-star', 'star']]) {
  $(id).prepend(VT.icon(name));
}

$('rv-shuffle').addEventListener('click', () => {
  setReviewPrefs({ shuffle: !prefs.shuffle });
  // Mid-session, only the cards not yet shown move: queue[0] is on screen and
  // may be half answered. sessionTotal is untouched — same cards, new order.
  const rest = queue.slice(1);
  queue = [...queue.slice(0, 1),
    ...(prefs.shuffle ? VT.shuffled(rest) : rest.sort((a, b) => a.due - b.due))];
  refocusCard();
});
$('rv-autoplay').addEventListener('change', (event) => {
  setReviewPrefs({ autoplay: event.target.checked });
  refocusCard();
});
$('rv-voice').addEventListener('change', (event) => {
  setReviewPrefs({ accent: event.target.value });
  refocusCard();
});
$('rv-speaker').addEventListener('change', (event) => {
  // Merged, never replaced: the other languages keep their choice.
  const voices = { ...prefs.voices, [activeLang]: event.target.value };
  if (!event.target.value) delete voices[activeLang];
  setReviewPrefs({ voices });
  refocusCard();
});
// Always synthesis, never the mp3: it previews the OS voice. The select's
// value rather than the stored one, which may not have landed yet. The word
// on screen when there is a card, else the language's own name.
$('rv-speaker-play').addEventListener('click', (event) => {
  event.preventDefault();   // inside the label: a click there would open the select
  const voices = LANG.get(activeLang).voices;
  const onCard = queue.length && !$('view-review').hidden;
  speak(onCard ? queue[0].word : voices[0].label,
    voices.some((v) => v.id === prefs.accent) ? prefs.accent : voices[0].id,
    activeLang, $('rv-speaker').value);
  refocusCard();
});
// getVoices() is [] on a cold load and fills in later.
globalThis.speechSynthesis?.addEventListener('voiceschanged', renderPrefs);

function renderStar(entry) {
  const on = VT.foldersOf(entry).includes(VT.STARRED);
  $('rv-star').setAttribute('aria-pressed', String(on));
  $('rv-star').title = on ? 'Unstar this word (s)' : 'Star this word (s)';
}

let starring = false;

async function toggleStar() {
  // Same re-entry guard as grade(): a double press would read the folders
  // before the first write landed and undo it.
  if (starring || !queue.length) return;
  starring = true;
  try {
    const entry = queue[0];
    await fileWord(entry.word, VT.STARRED, !VT.foldersOf(entry).includes(VT.STARRED));
    renderStar(entry);
  } finally {
    starring = false;
  }
  refocusCard();
}

$('rv-star').addEventListener('click', toggleStar);

const CHEERS = [
  [0, 'Every word starts somewhere — keep going.'],
  [40, 'Keep going, you can master this whole set.'],
  [80, 'Nearly there — a few more to master.'],
  [100, 'Every word here is mastered.']
];

function renderSide() {
  // The same set the session queues from, so the share mastered counts the
  // cards you are actually going to be asked.
  const scope = inScope(reviewScope);
  // Nothing to count yet: 0% and "keep going" over no words at all
  // would be commentary on a session that does not exist.
  $('rv-side').hidden = !scope.length;
  const mastered = scope.filter((e) => VT.isMastered(e)).length;
  const pct = scope.length ? Math.round((mastered / scope.length) * 100) : 0;

  $('rv-cheer').textContent = CHEERS.filter(([from]) => pct >= from).pop()[1];
  $('rv-pct').textContent = `${pct}%`;
  $('rv-ring').setAttribute('stroke-dasharray', `${pct} 100`);
  $('rv-mastered').replaceChildren('You have mastered ',
    el('b', null, `${mastered}/${scope.length}`), ' words in this set.');

  // Mastery takes three weeks at the very least, so 0% alone reads as
  // broken. The faint arc is how far the set has come: each word counts for
  // its interval over the 21 days mastery needs.
  const way = scope.length
    ? Math.round((scope.reduce((sum, e) => sum + Math.min(1, (e.interval ?? 0) / 21), 0) / scope.length) * 100)
    : 0;
  $('rv-ring-way').setAttribute('stroke-dasharray', `${way} 100`);
  // Which words one more Good would master, found by running the scheduler
  // itself at each word's due date rather than guessing from the numbers.
  const next = scope.filter((e) => !VT.isMastered(e) && e.reps > 0
    && VT.isMastered(VT.schedule(e, 4, Math.max(e.due, Date.now()))));
  $('rv-next').hidden = !next.length;
  if (next.length) {
    const first = new Date(Math.min(...next.map((e) => e.due)));
    const when = first <= new Date() ? 'today'
      : first.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    $('rv-next').textContent =
      `${next.length} word${next.length === 1 ? '' : 's'} can be mastered at the next review — first ${when}.`;
  }
}

/* ---------- practice ---------- */

// Every place the dashboard says a word goes through here, so an accent or
// autoplay setting has exactly one seam to change.
function speakWord(entry) {
  // Resolved against the ENTRY's pack, never activeLang: PRACTICE.hooks.speak
  // and the words-view title click can both be handed a word from outside the
  // current filter. Same fallback as the picker — one stored accent, many
  // languages, and 'uk' means nothing on a Korean voice list.
  const pack = LANG.of(entry);
  const voices = pack.voices;
  if (!pronounce(entry, voices.some((v) => v.id === prefs.accent) ? prefs.accent : voices[0].id)) {
    showVoiceHint(voiceHint(pack));
  }
}

// The voice hint's strip with an Undo in it, for an action whose control went
// away with it — a deleted word's card. Deletes pile up while it is showing:
// "Deleted 3 words", and one Undo puts all three back, so a second delete
// never costs the first its way back. Focus goes to Undo, since the button
// that was pressed is gone and would otherwise drop it to the top of the page;
// and the strip stays while focus is in it, so it cannot vanish under a
// keyboard user.
let toastDeleted = [];
let toastTimer = 0;
let lastDelete = -Infinity;
const TOAST_MS = 8000;
const DELETE_GUARD_MS = 400;

// `gone` is [{ word, snapshot }]: one from a card's ×, many from the bulk bar.
function showDeleted(gone) {
  if (!gone.length) return;
  toastDeleted.push(...gone);
  $('toast-text').textContent = toastDeleted.length > 1
    ? `Deleted ${toastDeleted.length} words` : `Deleted ${gone[0].word}`;
  $('toast').hidden = false;
  $('toast-undo').focus();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, TOAST_MS);
}

function hideToast() {
  if ($('toast').contains(document.activeElement)) {
    toastTimer = setTimeout(hideToast, TOAST_MS);
    return;
  }
  toastDeleted = [];
  $('toast').hidden = true;
}

$('toast-undo').addEventListener('click', async () => {
  const back = toastDeleted;
  toastDeleted = [];
  clearTimeout(toastTimer);
  $('toast-undo').blur();
  $('toast').hidden = true;
  if (!back.length) return;
  await putWords(Object.fromEntries(back.map((d) => [d.word, d.snapshot])));
  await refresh();
  // Back onto the first word that came back, since the Undo that had focus has
  // just gone; the view's heading when it is on another page of the list.
  // In List density that is the row's line, unless the row is open.
  const first = back[0].word;
  const card = [...document.querySelectorAll('#view-words .wcard, #view-words .wline')]
    .find((c) => c.dataset.word === first)?.querySelector('.wc-say, summary');
  (card ?? $('w-title')).focus();
  announce(back.length > 1 ? `${back.length} words restored.` : `${first} restored.`);
});

// One line at the bottom of the window, gone after a few seconds: speakWord is
// reached from the card, the words list and practice, so the hint cannot live
// in any one of them.
let voiceHintTimer = 0;
function showVoiceHint(text) {
  const box = $('voice-hint');
  box.textContent = text;
  box.hidden = false;
  clearTimeout(voiceHintTimer);
  voiceHintTimer = setTimeout(() => { box.hidden = true; }, VOICE_HINT_MS);
}
const VOICE_HINT_MS = 6000;

// The words a practice mode draws from: the review's folder when it has one,
// everything otherwise. Skipped words are out, as they are out of review.
// Filtered here rather than at the callers, because PRACTICE.hooks.changed
// re-renders from the whole store after every answer — patching only render()'s
// call would put the other language back into the pool mid-round. It is the
// same set inScope() queues the review from, which is what lets a practice
// answer grade a card the flashcard tab is holding.
function practicePool(all) {
  return all.filter((e) => VT.isLearnable(e)
    && LANG.of(e).id === activeLang
    && (!reviewScope || VT.foldersOf(e).includes(reviewScope)));
}

function renderPractice(all) {
  PRACTICE.renderTabs($('pr-tabs'), practicePool(all), practice.counts);
}

PRACTICE.hooks.speak = (entry) => speakWord(entry);
// After each answer, so the badge is right the moment the round ends. Not
// through storage.onChanged: that re-renders the whole page on every answer of
// a ten-question round. renderSide() is here because practice now grades —
// without it the mastery ring beside the quiz keeps yesterday's number.
PRACTICE.hooks.changed = async () => {
  practice = await getPractice();
  renderPractice(Object.values(words));
  renderSide();
};
// The one seam through which a practice answer reaches the schedule.
PRACTICE.hooks.scheduled = (entry, quality) => applyGrade(entry, quality);
// The miss tally, which bands practice's queue. Handed over rather than read
// from store.js inside practice.js, which owns no storage of its own.
PRACTICE.hooks.misses = () => practice.misses ?? {};
PRACTICE.hooks.settings = () => prefs;
PRACTICE.hooks.saveSettings = (patch) => setReviewPrefs(patch);
// Back to the flashcard. The queue is stale the moment practice grades a word
// sitting in it — that card is no longer due — so the session is rebuilt
// rather than resumed.
PRACTICE.hooks.flashcard = () => {
  startReview(reviewScope);
  renderCard();
};

/* ---------- statistics ---------- */

function dayKey(ts) { return new Date(ts).toDateString(); }

// "Oct 23", the one date format the dashboard shows (rv-next uses it too).
function shortDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// One column per level of the active scale, then the words with no level —
// only when there are some, so an empty "—" never sits at the end of the axis.
function levelBuckets(all, levels) {
  const count = (l) => all.filter((e) => (e.level ?? DASH) === l).length;
  const buckets = levels.map((l) => ({ label: l, name: l, n: count(l) }));
  const unknown = count(DASH);
  if (unknown) buckets.push({ label: DASH, name: 'Unknown level', n: unknown });
  return buckets;
}

// `max` pins the scale (100 for a percentage); by default it is the tallest
// bar. The top of the scale is printed on the plot (`unit` after it), so a
// tall bar reads as a number and not only as tall; an all-zero plot prints
// none rather than a made-up 1.
function plotSeries(node, series, caption, max = Math.max(1, ...series.map((s) => s.n)), unit = '') {
  node.replaceChildren();
  if (series.some((s) => s.n)) node.dataset.max = `${max}${unit}`;
  else delete node.dataset.max;
  for (const point of series) {
    const col = document.createElement('span');
    col.className = 'col';
    const bar = document.createElement('i');
    bar.style.height = `${(point.n / max) * 100}%`;
    if (!point.n) bar.className = 'none';
    bar.title = point.title ?? `${point.label}: ${point.n}`;
    // An <i> has no role to carry a name, so it takes img's.
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', bar.title);
    // An optional share of the bar drawn lighter, on top (new words in the
    // review forecast).
    if (point.part) {
      const part = document.createElement('b');
      part.style.height = `${(point.part / point.n) * 100}%`;
      bar.appendChild(part);
    }
    col.appendChild(bar);
    if (caption) {
      const cap = document.createElement('u');
      cap.textContent = point.label;
      col.appendChild(cap);
    }
    node.appendChild(col);
  }
}

function renderStats(all) {
  // The three review-history cards say nothing before the first review; one
  // note stands in for all three until there is something to plot.
  const saved = new Set(all.map((e) => e.word));
  const reviewed = reviewLog.some((row) => saved.has(row.word));
  for (const id of ['st-weak', 'st-retention', 'st-time']) $(id).closest('figure').hidden = !reviewed;
  $('st-nohistory').hidden = reviewed;
  renderWeak(all);
  renderRetention(all);
  renderTime(all);
  $('st-sub').textContent = all.length
    ? `${all.length} words · first saved ${new Date(Math.min(...all.map((e) => e.added)))
        .toLocaleDateString()}`
    : 'Nothing saved yet.';

  // added per day, last 30
  const added = new Map();
  for (const entry of all) added.set(dayKey(entry.added), (added.get(dayKey(entry.added)) ?? 0) + 1);
  const addedSeries = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    addedSeries.push({ label: shortDate(d), n: added.get(d.toDateString()) ?? 0 });
  }
  plotSeries($('st-added'), addedSeries, false);
  const from = new Date(); from.setDate(from.getDate() - 29);
  $('st-added-from').textContent = shortDate(from);

  // review load, next 14 days: FSRS played forward, new words shown lighter
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const load = VT.forecast(all, startOfToday.getTime());
  const dueSeries = load.map(({ fresh, review }, i) => {
    const label = shortDate(startOfToday.getTime() + i * 86400000);
    return { label, n: fresh + review, part: fresh,
             title: `${label}: ${review} review${review === 1 ? '' : 's'} + ${fresh} new` };
  });
  plotSeries($('st-due'), dueSeries, false);
  const to = new Date(); to.setDate(to.getDate() + 13);
  $('st-due-to').textContent = shortDate(to);
  const total = dueSeries.reduce((sum, d) => sum + d.n, 0);
  // No bars, nothing for a key to explain.
  $('st-due-legend').hidden = !total;
  const peak = dueSeries.reduce((a, d) => (d.n > a.n ? d : a), dueSeries[0]);
  $('st-due-sum').textContent = total
    ? `About ${Math.round(total / dueSeries.length)} a day · busiest ${peak.label} with ${peak.n} ` +
      `(${peak.part} new) · if every answer is Good`
    : 'Nothing due in the next two weeks.';

  // levels — the active language's scale, hoisted here rather than module-wide
  // for the reason renderOverview gives.
  const levelSeries = levelBuckets(all, LANG.get(activeLang).levels)
    .map(({ label, name, n }) => ({ label, n, title: `${name}: ${n} word${n === 1 ? '' : 's'}` }));
  plotSeries($('st-levels'), levelSeries, true);
  $('st-levels-axis').textContent = '';

  renderSources(all);
  renderFolderProgress(all);
}

// Where they came from, and how many of each site's words you have learned.
function renderSources(all) {
  const hosts = new Map();
  for (const entry of all) {
    // Deduped by page key: a word clicked twice in one video has two sources
    // that differ only by their timestamp, and that is one place it was met.
    // Once per host too: two pages of one site are one place it came from.
    const seen = new Set();
    const met = new Set();
    for (const url of entry.sources ?? []) {
      if (!url || seen.has(VT.pageKey(url))) continue;
      seen.add(VT.pageKey(url));
      let host;
      try { host = new URL(url).hostname.replace(/^www\./, ''); }
      catch { continue; }   // a saved entry may carry a non-URL source
      if (met.has(host)) continue;
      met.add(host);
      const was = hosts.get(host) ?? { n: 0, learned: 0 };
      was.n++;
      if (VT.isLearnable(entry) && VT.isMastered(entry)) was.learned++;
      hosts.set(host, was);
    }
  }
  const list = $('st-sources');
  list.replaceChildren();
  const ranked = [...hosts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8);
  if (!ranked.length) {
    const li = document.createElement('li');
    li.textContent = 'No pages recorded yet.';
    list.appendChild(li);
  }
  for (const [host, { n, learned }] of ranked) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'host';
    name.textContent = host;
    const count = document.createElement('span');
    count.className = 'n';
    count.textContent = `${n} word${n === 1 ? '' : 's'} · ${learned} learned`;
    li.append(name, count);
    list.appendChild(li);
  }
}

// Each folder with words in this language: how many of them are learned,
// best share first. Skipped words count in neither number (VT.progressOf).
const FOLDERS_SHOWN = 8;

function renderFolderProgress(all) {
  const members = {};
  for (const entry of all) {
    for (const id of VT.foldersOf(entry)) {
      if (folders[id]) (members[id] ??= []).push(entry);
    }
  }
  const rows = Object.entries(members).map(([id, entries]) => {
    const { learned, learning, fresh } = VT.progressOf(entries);
    return { folder: folders[id], learned, total: learned + learning + fresh };
  }).filter((r) => r.total)
    .sort((a, b) => b.learned / b.total - a.learned / a.total || b.total - a.total)
    .slice(0, FOLDERS_SHOWN);
  const list = $('st-folders');
  list.replaceChildren();
  if (!rows.length) {
    const li = document.createElement('li');
    li.textContent = 'No folders with words yet.';
    list.appendChild(li);
  }
  for (const { folder, learned, total } of rows) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'host';
    name.textContent = `${folder.icon ?? ''} ${folder.name}`.trim();
    const count = document.createElement('span');
    count.className = 'n';
    count.textContent = `${learned} of ${total} learned`;
    li.append(name, count);
    list.appendChild(li);
  }
}

// Words forgotten most often in the window, each one a way back to its card.
function renderWeak(all) {
  const mine = new Set(all.map((e) => e.word));
  const weak = VT.weakWords(reviewLog.filter((row) => mine.has(row.word)));
  const list = $('st-weak');
  list.replaceChildren();
  if (!weak.length) {
    const li = document.createElement('li');
    li.textContent = 'Nothing forgotten in the last 13 weeks.';
    list.appendChild(li);
  }
  for (const { word, lapses, last } of weak) {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    const name = document.createElement('span');
    name.className = 'host';
    name.textContent = word;
    const count = document.createElement('span');
    count.className = 'n';
    count.textContent = `forgot ${lapses}× · ${relative(last)}`;
    open.append(name, count);
    open.addEventListener('click', () => {
      $('q').value = word;
      activeFolder = null;
      showView('words');
      render();
    });
    li.appendChild(open);
    list.appendChild(li);
  }
}

// Retention per week, from the same first-of-day grades as the weak list.
const RETENTION_WEEKS = 13;
const FSRS_TARGET = 90;   // the recall VT.schedule aims at

function renderRetention(all) {
  const mine = new Set(all.map((e) => e.word));
  const weeks = VT.weeklyRetention(reviewLog.filter((row) => mine.has(row.word)), RETENTION_WEEKS);
  const pct = (rate) => Math.round(rate * 100);
  plotSeries($('st-retention'), weeks.map(({ start, reviews, passed, rate }) => {
    const label = `Week of ${shortDate(start)}`;
    return { label, n: rate == null ? 0 : pct(rate),
             title: reviews ? `${label}: ${pct(rate)}% · ${passed} of ${reviews} remembered`
                            : `${label}: no reviews` };
  }), false, 100, '%');
  $('st-retention-from').textContent = shortDate(weeks[0].start);
  const seen = weeks.map((w, i) => ({ ...w, ago: weeks.length - 1 - i })).filter((w) => w.reviews);
  const when = (ago) => (ago === 0 ? 'This week' : ago === 1 ? 'Last week' : `${ago} weeks ago`);
  const [first, last] = [seen[0], seen[seen.length - 1]];
  $('st-retention-sum').textContent = seen.length >= 2
    ? `${when(last.ago)} ${pct(last.rate)}% · ${when(first.ago).toLowerCase()} ${pct(first.rate)}% · ` +
      `FSRS aims for ${FSRS_TARGET}%`
    : 'Review for a few weeks to see a trend.';
}

// Minutes a day spent reviewing, last 30 days, estimated from grade gaps.
function renderTime(all) {
  const mine = new Set(all.map((e) => e.word));
  const minutes = VT.reviewMinutes(reviewLog.filter((row) => mine.has(row.word)));
  const series = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const label = shortDate(d);
    // At least a minute on a day with any review, so a short one is not "none".
    const raw = minutes.get(VT.dayKey(d.getTime())) ?? 0;
    const n = raw ? Math.max(1, Math.round(raw)) : 0;
    series.push({ label, n, title: `${label}: ${n} min` });
  }
  plotSeries($('st-time'), series, false, undefined, ' min');
  const from = new Date(); from.setDate(from.getDate() - 29);
  $('st-time-from').textContent = shortDate(from);
  const total = series.reduce((sum, d) => sum + d.n, 0);
  const span = total >= 60 ? `${Math.floor(total / 60)} h ${total % 60} min` : `${total} min`;
  $('st-time-sum').textContent = total
    ? `${total < series.length ? 'Under a minute' : `About ${Math.round(total / series.length)} min`} a day`
      + ` · ${span} in 30 days`
    : 'No reviews in the last 30 days.';
}

/* ---------- writing ---------- */

async function getWriting() {
  const got = await chrome.storage.local.get(['writeOn', 'writeOff', 'writeMistakes']);
  // `?? true`, not `||` and not a truthiness test: a profile that has never
  // opened this page has no writeOn key at all, and reading that absence as
  // false would ship the feature switched off for everyone who never touched it.
  return {
    on: got.writeOn ?? true,
    off: got.writeOff ?? [],
    mistakes: got.writeMistakes ?? {}
  };
}

// LanguageTool's category ids arrive as SCREAMING_SNAKE ("CONFUSED_WORDS").
// Printed raw next to a sentence of English they read as a log line.
function titleCase(raw) {
  return String(raw ?? '').toLowerCase().split(/[_\s]+/).filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1)).join(' ') || DASH;
}

async function setWriteOff(hosts) {
  await chrome.storage.local.set({ writeOff: [...new Set(hosts)] });
  await refresh();
}

function renderWriting() {
  $('wr-on').checked = writing.on;

  const hosts = $('wr-hosts');
  hosts.replaceChildren();
  for (const host of writing.off) {
    const row = document.createElement('li');
    const remove = el('button', 'rowdel', '×');
    remove.title = `Check on ${host} again`;
    remove.setAttribute('aria-label', remove.title);
    remove.addEventListener('click', () => setWriteOff(writing.off.filter((h) => h !== host)));
    row.append(el('span', null, host), remove);
    hosts.appendChild(row);
  }
  $('wr-hosts-empty').hidden = writing.off.length > 0;

  // Top 12 only. Below that the list is one-off typos you will never make
  // again, and a list of habits you cannot read in one screen is not a habit.
  const top = Object.values(writing.mistakes)
    .sort((a, b) => b.n - a.n)
    .slice(0, 12);
  const list = $('wr-mistakes');
  list.replaceChildren();
  for (const mistake of top) {
    const row = document.createElement('li');
    row.append(
      el('span', 'n', mistake.n),
      el('span', 'tag', titleCase(mistake.cat)),
      el('span', 'm', mistake.msg ?? '')
    );
    list.appendChild(row);
  }
  // An empty <ul> still paints its panel border, which reads as a broken panel
  // rather than as nothing to show.
  list.hidden = top.length === 0;
  $('wr-mistakes-empty').hidden = top.length > 0;
}

$('wr-on').addEventListener('change', async (event) => {
  await chrome.storage.local.set({ writeOn: event.target.checked });
  await refresh();
});

// What was typed in the Off on these sites box, as the hostname writer.js
// compares against, or null when it is not one. Through URL first: someone will
// paste a whole address, and storing "https://mail.google.com/chat" would match
// nothing. Then a shape check, because URL accepts "not a host!!" and
// percent-encodes it into a hostname no page will ever have.
function siteHost(raw) {
  let host;
  try { host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname; }
  catch { return null; }
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || host === 'localhost' ? host : null;
}

function showHostError(text) {
  $('wr-host-error').textContent = text;
  $('wr-host-error').hidden = !text;
  if (text) $('wr-host').setAttribute('aria-invalid', 'true');
  else $('wr-host').removeAttribute('aria-invalid');
}

$('wr-host').addEventListener('input', () => showHostError(''));

$('wr-add').addEventListener('submit', (event) => {
  event.preventDefault();
  const raw = $('wr-host').value.trim();
  if (!raw) {
    showHostError('Type a site, like mail.google.com, or paste its address.');
    return;
  }
  const host = siteHost(raw);
  if (!host) {
    showHostError(`“${raw}” is not a site address. Type it like mail.google.com, or paste the page's address.`);
    return;
  }
  if (writing.off.includes(host)) {
    showHostError(`Checking is already off on ${host}.`);
    return;
  }
  showHostError('');
  $('wr-host').value = '';
  setWriteOff([...writing.off, host]);
});

$('wr-reset').addEventListener('click', () => $('reset-dlg').showModal());

// On the form's submit, by which button, rather than on close by returnValue:
// returnValue survives an Esc, so a reset once confirmed would read as
// confirmed again the next time the dialog was dismissed.
$('reset-dlg').querySelector('form').addEventListener('submit', async (event) => {
  if (event.submitter?.value !== 'reset') return;
  await chrome.storage.local.set({ writeMistakes: {} });
  await refresh();
});
