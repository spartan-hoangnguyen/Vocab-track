const $ = (id) => document.getElementById(id);
const DASH = VT.DASH;
const VIEWS = ['overview', 'words', 'review', 'stats', 'writing', 'io'];

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
let pins = [];
// The GIPHY key, mirrored here only so renderCard can decide whether to offer a
// Find GIF button without an async read per card. giphy.js re-reads storage for
// the actual search, so this copy is never the source of truth for a request.
let giphyKey = '';
// How a review session runs. A key missing from storage is a default, not
// false: a profile that never touched the switch still hears the word.
const REVIEW_DEFAULTS = { shuffle: false, autoplay: true, accent: 'uk', practiceSession: 10 };
let prefs = { ...REVIEW_DEFAULTS };

function showView(name) {
  // A Card Blast round hangs off its own signal and would keep ticking behind
  // whichever view you walked to; nothing else stops it, because the panel
  // going display:none is not an event.
  if (name !== 'review' && typeof PRACTICE !== 'undefined' && PRACTICE.active()) PRACTICE.stop();
  for (const view of VIEWS) $(`view-${view}`).hidden = view !== name;
  // Redundant once you are in the review, and it competes with Show answer
  // for the same attention and roughly the same click.
  $('review-btn').hidden = name === 'review';
  for (const a of document.querySelectorAll('nav a')) {
    a.classList.toggle('on', a.dataset.view === name);
  }
}

for (const a of document.querySelectorAll('nav a')) {
  a.addEventListener('click', (event) => {
    event.preventDefault();
    if (a.dataset.view === 'words') activeFolder = null;
    if (a.dataset.view === 'review') startReview(null);
    showView(a.dataset.view);
    render();
  });
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

async function refresh() {
  [words, folders, writing, practice, prefs, pins, activeLang, giphyKey] = await Promise.all(
    [getWords(), getFolders(), getWriting(), getPractice(), getReviewPrefs(), getPins(),
     getLang(), getGiphyKey()]);
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

// Bumped when lang/en/cefr.js is regenerated, so the backfill runs again over
// words it could not place before.
const CEFR_VERSION = 1;

// Give a level to English words that have none. The dictionary stopped carrying
// a CEFR level when the lookup moved off Cambridge, so every word saved in
// between sits under "—" in the level charts. This reads the level from the
// bundled list for those words, once — a word that genuinely has no level (a
// proper noun, a word outside the list) is left alone and simply skipped next
// run by the stored version flag. Runs on boot, after the first load populated
// `words`, and re-renders only when it actually changed something.
async function backfillCefr() {
  if (typeof cefrLevel !== 'function') return;
  const { cefrBackfill } = await chrome.storage.local.get('cefrBackfill');
  if (cefrBackfill === CEFR_VERSION) return;
  const patches = {};
  for (const [word, entry] of Object.entries(words)) {
    if (!entry || entry.level || LANG.of(entry).id !== 'en') continue;
    const level = cefrLevel(word);
    if (level) patches[word] = { level };
  }
  if (Object.keys(patches).length) {
    await putWords(patches);
    for (const [word, patch] of Object.entries(patches)) {
      if (words[word]) words[word].level = patch.level;
    }
    render();
  }
  await chrome.storage.local.set({ cefrBackfill: CEFR_VERSION });
}

function render() {
  // The one load point every view fans out from, so filtering here is what
  // makes the toggle reach all of them. The exception is the streak below.
  const all = Object.values(words).filter((e) => LANG.of(e).id === activeLang);
  renderOverview(all);
  renderWords(all);
  renderLang();
  // The Push to Anki card names the language it will push, so it follows the
  // toggle like everything else.
  $('anki-lang').textContent = LANG.get(activeLang).name;
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
  // The active language's scale, read per render rather than closed over: the
  // toggle changes it, and `all` holds only that language's words. Passed
  // explicitly even though lib.js:629 would now default to the same list —
  // the call says which scale it means.
  const levels = LANG.get(activeLang).levels;
  $('ov-total').textContent = all.length;
  $('ov-due').textContent = due;
  $('ov-median').textContent = VT.medianLevel(all, levels) ?? DASH;
  $('ov-sub').textContent =
    `${all.length} word${all.length === 1 ? '' : 's'} collected while reading · ` +
    `${shown.length} folder${shown.length === 1 ? '' : 's'}`;
  $('review-btn').textContent = due ? `Review ${due} due` : 'Review';

  // One hue, not one per level: the axis already names the level, so colouring
  // by level would encode nothing the label does not already say.
  const buckets = [...levels, DASH].map((l) => [
    l, all.filter((e) => (e.level ?? DASH) === l).length
  ]);
  const max = Math.max(1, ...buckets.map((b) => b[1]));
  const bars = $('ov-bars');
  bars.replaceChildren();
  for (const [label, n] of buckets) {
    const wrap = document.createElement('span');
    const bar = document.createElement('i');
    bar.style.height = `${(n / max) * 26 + 3}px`;
    bar.title = `${label}: ${n}`;
    const cap = document.createElement('u');
    cap.textContent = label;
    wrap.append(bar, cap);
    bars.appendChild(wrap);
  }

  const live = pins.filter((id) => folders[id] && mine(folders[id]));
  fillGrid('ov-pinned', live.map((id) => folderCard(folders[id], members[id])));
  // suggestFolders needs no language filter of its own: it drops anything that
  // scores zero (lib.js:391), and a folder with no words in this language has
  // nothing due, nothing missed and nothing learning. A second guard here
  // would only restate the first.
  const suggested = VT.suggestFolders(
    Object.values(folders).map((folder) => ({ folder, members: members[folder.id] })),
    Date.now(), practice.misses, live);
  fillGrid('ov-suggest',
    suggested.map(({ folder, reason }) => folderCard(folder, members[folder.id], reason)));

  const grid = $('ov-folders');
  grid.replaceChildren(...shown
    .filter((folder) => !live.includes(folder.id))
    .map((folder) => folderCard(folder, members[folder.id])));

  const add = document.createElement('button');
  add.className = 'f new';
  const plus = document.createElement('span');
  plus.className = 'plus';
  plus.textContent = '+';
  const label = document.createElement('b');
  label.textContent = 'New folder';
  add.append(plus, label);
  add.addEventListener('click', () => editFolder(null));
  grid.appendChild(add);
}

// A grid and its heading show only when the grid has cards.
function fillGrid(id, cards) {
  $(id).replaceChildren(...cards);
  $(`${id}-head`).hidden = !cards.length;
  $(id).hidden = !cards.length;
}

function folderCard(folder, members, reason) {
  const n = members.length;
  const card = document.createElement('button');
  card.className = `f ${folder.color ?? 'sage'}`;
  card.dataset.folder = folder.id;
  card.addEventListener('click', () => openFolder(folder.id));

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = folder.icon ?? '\u{1F4C1}';
  const pinned = pins.includes(folder.id);
  const pin = document.createElement('button');
  pin.className = `pin${pinned ? ' on' : ''}`;
  pin.title = pinned ? 'Unpin' : 'Pin to the top';
  pin.textContent = '\u{1F4CC}';
  pin.addEventListener('click', (event) => { event.stopPropagation(); togglePin(folder.id); });
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${folder.auto ? 'Auto' : 'Manual'} · ${n} word${n === 1 ? '' : 's'}`;
  const name = document.createElement('h3');
  name.textContent = folder.name;
  const desc = document.createElement('p');
  desc.textContent = reason ?? folder.desc ?? '';
  if (reason) desc.className = 'why';
  card.append(badge, pin, meta, name, desc);

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
  const dueHere = dueCount(members);
  const freshHere = newCards(members).length;
  const dueText = document.createElement('span');
  dueText.textContent = dueHere
    ? `${dueHere} due today`
    : (freshHere ? `${freshHere} to learn` : (n ? 'All reviewed' : 'Empty'));
  foot.appendChild(dueText);
  if (dueHere || freshHere) {
    const go = document.createElement('button');
    go.className = 'edit';
    go.textContent = dueHere ? 'Review' : 'Learn';
    go.addEventListener('click', (event) => {
      event.stopPropagation();
      startReview(folder.id, { ahead: true });
      showView('review');
      render();
    });
    foot.appendChild(go);
  }
  if (!folder.auto) {
    const edit = document.createElement('button');
    edit.className = 'edit';
    edit.textContent = 'Edit';
    edit.addEventListener('click', (event) => { event.stopPropagation(); editFolder(folder); });
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

function renderWords(all) {
  const term = VT.normaliseWord($('q').value);
  const scope = activeFolder
    ? all.filter((e) => VT.foldersOf(e).includes(activeFolder))
    : all;
  const shown = (term
    ? scope.filter((e) => e.word.includes(term) || (e.vi ?? '').toLowerCase().includes(term))
    : scope
  ).sort((a, b) => b.added - a.added);

  // An imported word list runs to thousands of entries, and a card is 16
  // elements: 1,900 words measured at 30,578 of them, rebuilt on every
  // keystroke in the search box, because typing re-renders. The cap is what
  // keeps the search box responsive; the count below says what is not shown.
  const page = shown.slice(0, WORDS_SHOWN);
  const more = shown.length - page.length;

  $('w-title').textContent = activeFolder ? folders[activeFolder]?.name ?? 'Folder' : 'All words';
  $('w-sub').textContent = (term
    ? `${shown.length} match${shown.length === 1 ? '' : 'es'} for “${term}”`
    : `${shown.length} word${shown.length === 1 ? '' : 's'}`)
    + (more ? ` · newest ${page.length} shown, search to reach the rest` : '');

  // A folder you can open but not study is a dead end: this is the way into a
  // review scoped to it, whether or not anything is due today.
  const study = $('w-review');
  const due = dueCount(scope);
  const fresh = newCards(scope).length;
  study.hidden = !activeFolder || !(due || fresh);
  study.textContent = due
    ? `Review ${due} due`
    : `Learn ${Math.min(AHEAD_BATCH, fresh)} new`;

  const cards = $('w-cards');
  cards.replaceChildren();
  for (const entry of page) cards.appendChild(wordCard(entry));

  const empty = $('w-empty');
  empty.replaceChildren();
  empty.hidden = shown.length > 0;
  if (!shown.length) {
    if (term && VT.isLookupCandidate(term)) {
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
    } else {
      empty.className = 'empty';
      empty.textContent = term ? 'No match.' : 'No words here yet.';
    }
  }
}

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

function wordCard(entry) {
  const card = el('article', 'wcard');

  // --- headline row
  const head = el('div', 'wc-head');
  const title = el('h3', 'wc-word', entry.word);
  title.title = 'Pronounce';
  title.addEventListener('click', () => speakWord(entry));
  head.appendChild(title);
  if (entry.level) head.appendChild(el('span', 'lvl', entry.level));
  if (entry.pos) head.appendChild(el('span', 'wc-pos', entry.pos));
  if (entry.ipa) head.appendChild(el('span', 'wc-ipa', `/${entry.ipa}/`));

  const spacer = el('span', 'wc-spacer');
  head.appendChild(spacer);
  head.appendChild(el('span', 'when', relative(entry.added)));
  const del = el('button', 'rowdel', '×');
  del.title = `Delete ${entry.word}`;
  del.addEventListener('click', async () => {
    if (!confirm(`Delete "${entry.word}"? This cannot be undone.`)) return;
    await removeWord(entry.word);
    await refresh();
  });
  head.appendChild(del);
  card.appendChild(head);

  // --- meaning
  if (entry.vi) card.appendChild(el('p', 'wc-vi', entry.vi));
  card.appendChild(el('p', 'wc-def', entry.def ?? DASH));
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
  if (entry.context) {
    const quote = el('blockquote', 'wc-seen');
    for (const piece of VT.pieces(entry.context, VT.find(entry.word, entry.context, entry.lang))) {
      if (piece.hit) quote.appendChild(el('mark', null, piece.text));
      else quote.append(piece.text);
    }
    card.appendChild(quote);
  }

  // --- synonyms
  if (entry.synonyms?.length) {
    const chips = el('div', 'wc-chips');
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
    const link = el('a', 'wc-link', `↩ ${host}`);
    // A text fragment, so this lands on the sentence rather than the top of a
    // long article. Falls back to the plain URL when there is no context.
    link.href = VT.sourceLink(source, entry.context, entry.word, entry.lang);
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.title = `Jump back to where you read it\n${source}`;
    foot.appendChild(link);
  }

  const dict = LANG.dict(LANG.of(entry).id);
  if (dict) {
    const cam = el('a', 'wc-link', `${dict.name} ↗`);
    cam.href = dict.href(entry.word);
    cam.target = '_blank';
    cam.rel = 'noreferrer';
    cam.title = `Full entry on ${dict.name}`;
    foot.appendChild(cam);
  }

  foot.appendChild(el('span', 'wc-spacer'));

  // The only way back into the rotation, so it sits with the other membership
  // tags rather than behind a menu.
  if (!VT.isLearnable(entry)) {
    const back = el('span', 'tag clickable', 'Skipped ↩');
    back.title = 'Start asking about this word again';
    back.addEventListener('click', async () => {
      await putWord(entry.word, { skipped: false });
      await refresh();
    });
    foot.appendChild(back);
  }

  for (const id of VT.foldersOf(entry)) {
    const tag = el('span', 'tag clickable', folders[id]?.name ?? id);
    tag.addEventListener('click', () => openFolder(id));
    foot.appendChild(tag);
  }
  const add = el('span', 'tag clickable', '+');
  add.title = 'Tags';
  add.addEventListener('click', () => openTagPicker(entry));
  foot.appendChild(add);

  card.appendChild(foot);
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
  const btn = el('button', 'wc-gifbtn', '\u{1F39E} Find GIF');
  btn.addEventListener('click', () => cardFindGif(entry, btn));
  box.appendChild(btn);
  return box;
}

async function cardFindGif(entry, btn) {
  // One search at a time, shared with the review card's guard: a 42-an-hour
  // budget cannot afford a double-click.
  if (finding) return;
  finding = true;
  const label = btn.textContent;
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
    btn.textContent = label;
    btn.closest('.wc-gif')?.appendChild(el('p', 'wc-gifmsg', failed
      ? `Could not fetch a GIF — ${failed}`
      : `No GIF found for “${giphyQuery(entry).q}”.`));
  } catch (err) {
    finding = false;
    console.error('[vocab-track] card find gif failed for', entry.word, err);
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* ---------- tag picker ---------- */

// The word the open picker is filing. A word, not an entry: refresh() swaps
// every entry object for a fresh one whenever storage changes.
let tagging = null;

function openTagPicker(entry) {
  tagging = entry.word;
  $('tag-title').textContent = `Tags · ${entry.word}`;
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
  const lang = LANG.of(words[tagging]).id;
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
  const mine = VT.foldersOf(words[tagging]);
  const list = $('tag-list');
  list.replaceChildren();
  for (const tag of tagOptions().filter((t) => t.name.toLowerCase().includes(q))) {
    const row = el('label', tag.suggested ? 'tagrow suggested' : 'tagrow');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = mine.includes(tag.id);
    box.addEventListener('change', () => toggleTag(tag, box.checked));
    row.append(box, el('span', null, `${tag.icon ?? '\u{1F4C1}'} ${tag.name}`));
    list.appendChild(row);
  }
  if (q && !tagOptions().some((t) => t.name.toLowerCase() === q)) {
    const create = el('button', 'tagrow create', `+ Create “${typed}”`);
    create.type = 'button';
    create.addEventListener('click', createTag);
    list.appendChild(create);
  }
}

// Adds or removes one folder on one word, in storage and in memory.
async function fileWord(word, id, on) {
  const mine = VT.foldersOf(words[word]);
  await setWordFolders(word, on ? [...mine, id] : mine.filter((f) => f !== id));
  // Read back rather than recomputed, so setWordFolders stays the one place
  // that decides what an emptied list means. The review queue holds its own
  // entry objects, and the card's tag label reads from those.
  const saved = (await getWords())[word]?.folders;
  for (const entry of [words[word], ...queue.filter((e) => e.word === word)]) {
    if (entry) entry.folders = saved;
  }
}

async function toggleTag(tag, on) {
  // The word's own language, not activeLang: the card being tagged can be a
  // Korean one reached from an English session.
  const id = tag.suggested
    ? await folderForName(tag.name, LANG.of(words[tagging]).id)
    : tag.id;
  await fileWord(tagging, id, on);
  folders = await getFolders();
  renderTags();
  // Behind the modal, so the card's label and the word list are already right
  // when it closes — however it closes: Done, Esc or Enter.
  render();
}

async function createTag() {
  const name = $('tag-q').value.trim();
  if (!name) return;
  const id = await folderForName(name, LANG.of(words[tagging]).id);
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
  await toggleTag(match, !VT.foldersOf(words[tagging]).includes(match.id));
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
  const payload = JSON.stringify({
    exported: new Date().toISOString(),
    words: await getWords(),
    folders: (await chrome.storage.local.get('folders')).folders ?? {}
  }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `vocab-track-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$('import-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const note = $('io-note');
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data.words !== 'object') throw new Error('no words in this file');

    let added = 0;
    let merged = 0;
    const current = await getWords();
    // Collected, then written once: a word list can hold thousands of entries,
    // and a putWord per word rewrites the whole map per word.
    const patches = {};
    for (const [word, incoming] of Object.entries(data.words)) {
      const existing = current[word];
      if (existing) {
        // Merge, never overwrite: the local review schedule is the thing you
        // cannot get back, so ease/interval/reps/due are left untouched and
        // only membership and sources are unioned.
        patches[word] = {
          folders: [...new Set([...VT.foldersOf(existing), ...VT.foldersOf(incoming)])],
          sources: [...new Set([...(existing.sources ?? []), ...(incoming.sources ?? [])])]
        };
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
    // Name the language when the file lands somewhere this session is not
    // looking. Folders are language-scoped now, so importing the Korean list
    // from an English session puts 3,900 words and three folders on screen
    // nowhere at all — and an import that appears to do nothing reads as an
    // import that failed.
    const elsewhere = [...new Set(Object.values(data.words).map((e) => LANG.of(e).id))]
      .filter((id) => id !== activeLang)
      .map((id) => LANG.get(id)?.name ?? id);
    note.textContent = `Imported: ${added} new, ${merged} merged with existing entries.`
      + (elsewhere.length
        ? ` In ${elsewhere.join(' and ')} — switch the language toggle to see them.`
        : '');
    await refresh();
  } catch (err) {
    console.error('[vocab-track] import failed', err);
    note.textContent = `Could not import that file: ${err.message}`;
  } finally {
    event.target.value = '';
  }
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
  return `Anki error: ${msg}`;
}

async function testAnki() {
  const note = $('anki-note');
  note.textContent = 'Testing…';
  try {
    const version = await ankiInvoke('version');
    note.textContent = `Connected to AnkiConnect (version ${version}).`;
  } catch (err) {
    note.textContent = ankiMessage(err);
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
    note.textContent = `No ${lang.name} words to push.`;
    return;
  }
  pushingAnki = true;
  const btn = $('anki-push');
  btn.disabled = true;
  note.textContent = `Pushing ${scope.length} ${lang.name} word${scope.length === 1 ? '' : 's'}…`;
  try {
    const deckName = `Vocab-track::${lang.name}`;
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
    note.textContent = `Added ${added} to “${deckName}” · ${skipped} already in Anki.`;
  } catch (err) {
    note.textContent = ankiMessage(err);
  } finally {
    pushingAnki = false;
    btn.disabled = false;
  }
}

$('anki-origin').textContent = ankiOrigin();
$('anki-test').addEventListener('click', testAnki);
$('anki-push').addEventListener('click', pushToAnki);

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
  }
});

/* ---------- theme ---------- */

// Paper is the default and stays the default; night is opt-in. The choice is
// saved to chrome.storage like every other setting, and mirrored to
// localStorage only so theme-boot.js can apply it before the first paint.
function applyTheme(theme) {
  const night = theme === 'night';
  if (night) document.documentElement.dataset.theme = 'night';
  else delete document.documentElement.dataset.theme;
  $('theme-btn').setAttribute('aria-pressed', String(night));
  $('theme-btn').title = night ? 'Light theme' : 'Night theme';
  $('theme-btn').setAttribute('aria-label', $('theme-btn').title);
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

// Built from the registry, so a third pack appears here the moment its script
// is loaded. Hidden below two: a segmented control with one segment is not a
// choice, and every surface downstream already defaults to the one pack.
function renderLang() {
  const packs = LANG.list();
  const seg = $('lang-seg');
  seg.hidden = packs.length < 2;
  if (seg.hidden) return;
  seg.replaceChildren(...packs.map((pack) => {
    const btn = el('button', 'rvopt', pack.short ?? pack.id.toUpperCase());
    btn.dataset.lang = pack.id;
    btn.title = pack.name;
    // aria-pressed, not a class: it is the state the .rvopt styling already
    // reads, in both themes, and it is what a screen reader announces.
    btn.setAttribute('aria-pressed', String(pack.id === activeLang));
    btn.addEventListener('click', () => setLang(pack.id));
    return btn;
  }));
}

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

// The GIPHY key: a flat key like `theme`, saved as you type. The module copy is
// updated here too so a card rendered before the next refresh() still sees the
// key. Trimmed on write for the reason getGiphyKey trims on read.
$('giphy-key').addEventListener('input', (event) => {
  giphyKey = event.target.value.trim();
  chrome.storage.local.set({ giphyKey });
});
chrome.storage.local.get('giphyKey').then(({ giphyKey: stored }) => {
  $('giphy-key').value = stored ?? '';
});

$('review-btn').addEventListener('click', () => {
  startReview(null);
  showView('review');
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

refresh().then(backfillCefr).then(drainCaptures);


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
// What was typed for the card on screen, kept so the diff survives a re-render.
let typed = '';
// A card can only ask "type the word" if it has something to ask WITH. An entry
// saved while the dictionary and the translator were both down has neither a
// definition nor a Vietnamese gloss, and prompting with a blank card is
// unanswerable — those fall back to the old recognition card.
let canType = false;

const GRADE_FOR = { exact: 4, near: 3, wrong: 0 };
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
  if (PRACTICE.active()) return;
  if (!queue.length) {
    $('rv-card').hidden = true;
    $('rv-empty').hidden = false;
    $('rv-exit').hidden = true;
    $('rv-sub').textContent = '';
    $('rv-prog-fill').style.width = sessionTotal ? '100%' : '0%';
    $('rv-empty-text').textContent = sessionTotal
      ? `Done — ${sessionTotal} card${sessionTotal === 1 ? '' : 's'} reviewed.`
      : 'Nothing due. Come back later.';
    // Without this the only way to the next twenty is back to the overview and
    // into the folder again — four clicks to keep doing the thing you are
    // already doing.
    const waiting = newCards(inScope(reviewScope)).length;
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
  $('rv-level').textContent = entry.level ?? DASH;
  // Instruction text, and wrong on screen the moment a Korean card appears. Per
  // card rather than per toggle, because the card is the thing being asked for;
  // dashboard.html's attribute is only the value before the first render.
  $('rv-input').placeholder = `type the ${LANG.of(entry).name} word`;

  // The prompt is the meaning; the word is what you produce. A card with
  // nothing to prompt with shows the word instead and goes back to being a
  // recognition card.
  $('rv-vi').textContent = canType ? (entry.vi ?? '') : '';
  $('rv-def').textContent = canType ? (entry.def ?? '') : '';
  const seen = $('rv-context');
  const context = entry.context
    ? (revealed ? entry.context : maskContext(entry.context, entry.word, entry.lang))
    : '';
  seen.hidden = !context;
  seen.textContent = context;

  // The IPA and the play button are the answer's shape and the answer's sound.
  // Both would hand it to you, so neither appears until you have committed.
  //
  // ponytail: the /…/ delimiters assume IPA. Nothing to do yet — a Korean entry
  // has no `ipa` at all while its dictionary is MT-only, so this line is hidden
  // — but a pack that one day supplies romanisation wants its own delimiters.
  $('rv-ipa').hidden = !(revealed && entry.ipa);
  $('rv-ipa').textContent = entry.ipa ? `/${entry.ipa}/` : '';
  $('rv-play').hidden = !revealed;
  $('rv-play').onclick = () => speakWord(entry);

  // Labelled with where the word already is, so the card answers "did I file
  // this one?" without opening anything.
  const filed = VT.foldersOf(entry).filter((id) => folders[id] && !folders[id].auto)
    .map((id) => folders[id].name);
  $('rv-tag').hidden = !revealed;
  $('rv-tag').replaceChildren(el('span', null, filed.length ? `# ${filed.join(', ')}` : '# Tag'), kbd('t'));
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
    $('rv-cam').textContent = `${dict.name} ↗`;
  } else {
    $('rv-cam').removeAttribute('href');
  }
  renderFull(revealed ? entry : null);
  renderGif(revealed ? entry : null);
  renderDiff(revealed && canType ? VT.diffWord(typed, entry.word) : null);
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
  const btn = el('button', 'rvgifbtn', '🎞 Find GIF');
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
  const d = VT.diffWord(typed, queue[0]?.word);
  if (d.exact) return GRADE_FOR.exact;
  if (d.near) return GRADE_FOR.near;
  return GRADE_FOR.wrong;
}

function renderDiff(diff) {
  const node = $('rv-diff');
  node.replaceChildren();
  node.hidden = !diff;
  if (!diff) return;

  if (diff.exact) {
    node.className = 'rvdiff good';
    node.textContent = 'Correct';
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
    node.textContent = 'Skipped';
  }
}

// Enter from the typing form. Commits whatever is in the box — including
// nothing, which is how you say "no idea" without reaching for the mouse.
function submitAnswer() {
  if (revealed || !queue.length) return;
  typed = canType ? $('rv-input').value : '';
  revealed = true;
  // Blurred before the grades appear, or 1-4 would type digits into the box
  // instead of grading. This is what lets one set of keys serve both halves of
  // the card.
  $('rv-input').blur();
  renderCard();
  if (prefs.autoplay) speakWord(queue[0]);
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
    await applyGrade(entry, quality);
    // A lapse returns to the back of this session's queue, so it is seen again
    // today; sessionTotal grows with it so the counter stays honest.
    if (quality < 3) {
      queue.push(entry);
      sessionTotal++;
    }
    revealed = false;
    typed = '';
    $('rv-input').value = '';
    renderCard();
  } finally {
    grading = false;
  }
}

// Rebuilt per card rather than built once, because which button Enter will
// press changes with what you typed and the marking has to move with it.
function renderGrades(suggested) {
  const host = $('rv-grades');
  host.replaceChildren();
  if (suggested === null) return;
  for (const g of GRADES) {
    const button = document.createElement('button');
    const label = document.createElement('b');
    label.textContent = g.label;
    const hint = document.createElement('span');
    hint.append(kbd(g.key), g.hint);
    button.append(label, hint);
    if (g.q === suggested) {
      button.className = 'pick';
      hint.replaceChildren(kbd(g.key), kbd('enter'));
    }
    button.addEventListener('click', () => grade(g.q));
    host.appendChild(button);
  }
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
      const li = el('li', null, sense.def ?? DASH);
      if (sense.level) li.appendChild(el('span', 'lvl', sense.level));
      if (sense.example) li.appendChild(el('span', 'ex', sense.example));
      list.appendChild(li);
    }
    body.appendChild(list);
  }

  for (const [label, items] of groups) {
    body.appendChild(el('h3', null, label));
    const chips = el('div', 'chips');
    for (const word of items) chips.appendChild(el('span', 'tag', word));
    body.appendChild(chips);
  }
}

$('rv-full').addEventListener('toggle', () => { fullOpen = $('rv-full').open; });

// Not a delete and not a grade: the word leaves the rotation and keeps
// everything else. No confirm() — it is undone with one click in All words,
// and a dialog on a button pressed dozens of times a session is the wrong tax.
async function skipCard() {
  if (grading || !queue.length) return;
  grading = true;
  try {
    const entry = queue.shift();
    await putWord(entry.word, { skipped: true });
    entry.skipped = true;
    words[entry.word] = entry;
    revealed = false;
    typed = '';
    $('rv-input').value = '';
    renderCard();
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
  // The picker owns the keyboard while it is open: typing a tag name must not
  // grade the card, and Esc closes the picker rather than the session.
  if ($('tag-dlg').open) return;
  if (event.key === 'Escape') {
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
  if (event.target.closest?.('.rvctl, .prtabs, #rv-star, #theme-btn')) return;
  // While the box has focus every other key belongs to it — a digit is a digit
  // and `r` is a letter. Enter is the exception, and the form handles that.
  if (document.activeElement === $('rv-input')) return;

  if (event.key === 'Enter') {
    event.preventDefault();
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
}

// A click moves focus off the typing box; give it back, or the next letters
// typed go nowhere. Not renderCard(): that would re-run the card for nothing.
function refocusCard() {
  if (!revealed && canType && queue.length && !$('view-review').hidden) $('rv-input').focus();
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

function renderStar(entry) {
  const on = VT.foldersOf(entry).includes(VT.STARRED);
  $('rv-star').textContent = on ? '★' : '☆';
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
  // The same set the session queues from, so "3 words left to master" counts
  // the cards you are actually going to be asked.
  const scope = inScope(reviewScope);
  const mastered = scope.filter((e) => VT.isMastered(e)).length;
  const left = scope.length - mastered;
  const pct = scope.length ? Math.round((mastered / scope.length) * 100) : 0;
  // One segment per fifth mastered; the level is one ahead of them, so an
  // empty set is Level 1 rather than Level 0.
  const filled = Math.floor(pct / 20);
  const level = Math.min(5, 1 + filled);

  $('rv-cheer').textContent = CHEERS.filter(([from]) => pct >= from).pop()[1];
  $('rv-left').textContent = `${left} word${left === 1 ? '' : 's'} left to master`;
  $('rv-mlevel').textContent = `Level ${level}`;
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
  [...$('rv-segs').children].forEach((seg, i) => seg.classList.toggle('on', i < filled));
}

/* ---------- practice ---------- */

// Every place the dashboard says a word goes through here, so an accent or
// autoplay setting has exactly one seam to change.
function speakWord(entry) {
  // Resolved against the ENTRY's pack, never activeLang: PRACTICE.hooks.speak
  // and the words-view title click can both be handed a word from outside the
  // current filter. Same fallback as the picker — one stored accent, many
  // languages, and 'uk' means nothing on a Korean voice list.
  const voices = LANG.of(entry).voices;
  pronounce(entry, voices.some((v) => v.id === prefs.accent) ? prefs.accent : voices[0].id);
}

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

function plotSeries(node, series, caption) {
  node.replaceChildren();
  const max = Math.max(1, ...series.map((s) => s.n));
  for (const point of series) {
    const col = document.createElement('span');
    col.className = 'col';
    const bar = document.createElement('i');
    bar.style.height = `${(point.n / max) * 100}%`;
    if (!point.n) bar.className = 'none';
    bar.title = point.title ?? `${point.label}: ${point.n}`;
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
    addedSeries.push({ label: d.toLocaleDateString(), n: added.get(d.toDateString()) ?? 0 });
  }
  plotSeries($('st-added'), addedSeries, false);
  const from = new Date(); from.setDate(from.getDate() - 29);
  $('st-added-from').textContent = from.toLocaleDateString();

  // review load, next 14 days: FSRS played forward, new words shown lighter
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const load = VT.forecast(all, startOfToday.getTime());
  const dueSeries = load.map(({ fresh, review }, i) => {
    const label = new Date(startOfToday.getTime() + i * 86400000).toLocaleDateString();
    return { label, n: fresh + review, part: fresh,
             title: `${label}: ${review} review${review === 1 ? '' : 's'} + ${fresh} new` };
  });
  plotSeries($('st-due'), dueSeries, false);
  const to = new Date(); to.setDate(to.getDate() + 13);
  $('st-due-to').textContent = to.toLocaleDateString();
  const total = dueSeries.reduce((sum, d) => sum + d.n, 0);
  const peak = dueSeries.reduce((a, d) => (d.n > a.n ? d : a), dueSeries[0]);
  $('st-due-sum').textContent = total
    ? `About ${Math.round(total / dueSeries.length)} a day · busiest ${peak.label} with ${peak.n} ` +
      `(${peak.part} new) · if every answer is Good`
    : 'Nothing due in the next two weeks.';

  // levels — the active language's scale, hoisted here rather than module-wide
  // for the reason renderOverview gives.
  const levelSeries = [...LANG.get(activeLang).levels, DASH].map((l) => ({
    label: l, n: all.filter((e) => (e.level ?? DASH) === l).length
  }));
  plotSeries($('st-levels'), levelSeries, true);
  $('st-levels-axis').textContent = '';

  // where they came from
  const hosts = new Map();
  for (const entry of all) {
    // Deduped by page key: a word clicked twice in one video has two sources
    // that differ only by their timestamp, and that is one place it was met.
    const seen = new Set();
    for (const url of entry.sources ?? []) {
      if (!url || seen.has(VT.pageKey(url))) continue;
      seen.add(VT.pageKey(url));
      let host;
      try { host = new URL(url).hostname.replace(/^www\./, ''); }
      catch { continue; }   // a saved entry may carry a non-URL source
      hosts.set(host, (hosts.get(host) ?? 0) + 1);
    }
  }
  const list = $('st-sources');
  list.replaceChildren();
  const ranked = [...hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (!ranked.length) {
    const li = document.createElement('li');
    li.textContent = 'No pages recorded yet.';
    list.appendChild(li);
  }
  for (const [host, n] of ranked) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'host';
    name.textContent = host;
    const count = document.createElement('span');
    count.className = 'n';
    count.textContent = `${n} word${n === 1 ? '' : 's'}`;
    li.append(name, count);
    list.appendChild(li);
  }
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

$('wr-add').addEventListener('submit', (event) => {
  event.preventDefault();
  const raw = $('wr-host').value.trim();
  if (!raw) return;
  let host;
  // Through URL rather than a regex: someone will paste a whole address, and
  // storing "https://mail.google.com/chat" as a hostname would match nothing.
  try { host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname; }
  catch { return; }
  $('wr-host').value = '';
  setWriteOff([...writing.off, host]);
});

$('wr-reset').addEventListener('click', async () => {
  if (!confirm('Forget every mistake counted so far? This cannot be undone.')) return;
  await chrome.storage.local.set({ writeMistakes: {} });
  await refresh();
});
