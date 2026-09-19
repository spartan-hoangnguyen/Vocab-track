const $ = (id) => document.getElementById(id);
const DASH = VT.DASH;
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const VIEWS = ['overview', 'words', 'review', 'stats', 'writing', 'io'];

// One in-memory snapshot per render pass. Every view reads from this rather
// than hitting storage per row, and refresh() is the single place that
// reloads it, so a write anywhere is followed by exactly one re-read.
let words = {};
let folders = {};
let writing = { on: true, off: [], mistakes: {} };
let activeFolder = null;   // null = all words
let practice = { counts: {}, misses: {} };
let pins = [];
// How a review session runs. A key missing from storage is a default, not
// false: a profile that never touched the switch still hears the word.
const REVIEW_DEFAULTS = { shuffle: false, autoplay: true, accent: 'uk' };
let prefs = { ...REVIEW_DEFAULTS };

function showView(name) {
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

async function refresh() {
  [words, folders, writing, practice, prefs, pins] = await Promise.all(
    [getWords(), getFolders(), getWriting(), getPractice(), getReviewPrefs(), getPins()]);
  render();
}

function render() {
  const all = Object.values(words);
  renderOverview(all);
  renderWords(all);
  renderStreak(all);
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
  const due = dueCount(all);
  $('ov-total').textContent = all.length;
  $('ov-due').textContent = due;
  $('ov-median').textContent = VT.medianLevel(all) ?? DASH;
  $('ov-sub').textContent =
    `${all.length} word${all.length === 1 ? '' : 's'} collected while reading · ` +
    `${Object.keys(folders).length} folder${Object.keys(folders).length === 1 ? '' : 's'}`;
  $('review-btn').textContent = due ? `Review ${due} due` : 'Review';

  // One hue, not one per level: the axis already names the level, so colouring
  // by level would encode nothing the label does not already say.
  const buckets = [...LEVELS, DASH].map((l) => [
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

  // One pass over the words, not one filter per folder.
  const members = {};
  for (const id of Object.keys(folders)) members[id] = [];
  for (const entry of all) {
    for (const id of VT.foldersOf(entry)) members[id]?.push(entry);
  }
  const live = pins.filter((id) => folders[id]);
  fillGrid('ov-pinned', live.map((id) => folderCard(folders[id], members[id])));
  const suggested = VT.suggestFolders(
    Object.values(folders).map((folder) => ({ folder, members: members[folder.id] })),
    Date.now(), practice.misses, live);
  fillGrid('ov-suggest',
    suggested.map(({ folder, reason }) => folderCard(folder, members[folder.id], reason)));

  const grid = $('ov-folders');
  grid.replaceChildren(...Object.values(folders)
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
      btn.textContent = `Look up “${term}” on Cambridge`;
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
    card.appendChild(el('p', 'wc-more',
      `+${entry.senses.length - 1} more meaning${entry.senses.length > 2 ? 's' : ''} on Cambridge`));
  }

  // --- the sentence it was met in, with the word marked
  if (entry.context) {
    const quote = el('blockquote', 'wc-seen');
    const re = VT.wordRegex(entry.word);
    let last = 0;
    let match;
    while ((match = re.exec(entry.context))) {
      quote.append(entry.context.slice(last, match.index));
      quote.appendChild(el('mark', null, match[0]));
      last = match.index + match[0].length;
    }
    quote.append(entry.context.slice(last));
    card.appendChild(quote);
  }

  // --- synonyms
  if (entry.synonyms?.length) {
    const chips = el('div', 'wc-chips');
    for (const word of entry.synonyms.slice(0, 5)) chips.appendChild(el('span', 'tag', word));
    card.appendChild(chips);
  }

  // --- footer: where it came from, where to read more, which folders
  const foot = el('div', 'wc-foot');

  const source = entry.sources?.[entry.sources.length - 1];
  const host = source ? hostOf(source) : null;
  if (host) {
    const link = el('a', 'wc-link', `↩ ${host}`);
    // A text fragment, so this lands on the sentence rather than the top of a
    // long article. Falls back to the plain URL when there is no context.
    link.href = VT.sourceLink(source, entry.context, entry.word);
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.title = `Jump back to where you read it\n${source}`;
    foot.appendChild(link);
  }

  const cam = el('a', 'wc-link', 'Cambridge ↗');
  cam.href = `${VT.CAMBRIDGE}/dictionary/english/${encodeURIComponent(entry.word)}`;
  cam.target = '_blank';
  cam.rel = 'noreferrer';
  cam.title = 'Full entry on Cambridge Dictionary';
  foot.appendChild(cam);

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
function tagOptions() {
  const own = Object.values(folders).filter((f) => !f.auto);
  const taken = new Set(own.map((f) => f.name.toLowerCase()));
  const suggested = VT.TOPICS.filter((t) => !folders[t.id] && !taken.has(t.name.toLowerCase()))
    .map((t) => ({ ...t, suggested: true }));
  return [...own, ...suggested];
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
  const id = tag.suggested ? await folderForName(tag.name) : tag.id;
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
  const id = await folderForName(name);
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
  const { notFound } = await resolveWord(word, null, activeFolder ? [activeFolder] : []);
  if (notFound) {
    button.textContent = `“${word}” is not in the Cambridge dictionary`;
    return;
  }
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
  await putFolder(editing ? { ...editing, ...patch } : { ...VT.newFolder(name), ...patch });
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
    note.textContent = `Imported: ${added} new, ${merged} merged with existing entries.`;
    await refresh();
  } catch (err) {
    console.error('[vocab-track] import failed', err);
    note.textContent = `Could not import that file: ${err.message}`;
  } finally {
    event.target.value = '';
  }
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

$('theme-btn').addEventListener('click', () => {
  setTheme(document.documentElement.dataset.theme === 'night' ? 'light' : 'night');
  // Mid-review the click took focus from the typing box; hand it back.
  refocusCard();
});
// chrome.storage is the truth: the mirror can be missing (cleared site data)
// or stale (the theme changed in another dashboard tab while this was shut).
chrome.storage.local.get('theme').then(({ theme }) => applyTheme(theme));

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
  if (changes.words || changes.folders || changes.pins ||
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

refresh().then(drainCaptures);


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

// Words that have never been graded and are not due yet — Anki's new queue.
function newCards(entries) {
  const now = Date.now();
  return entries.filter((e) => VT.isLearnable(e) && !e.reps && e.due > now)
    .sort((a, b) => a.due - b.due);
}

function startReview(folderId, { ahead = false } = {}) {
  reviewScope = folderId;
  const now = Date.now();
  // isLearnable first, so a skipped word cannot be reached even by a
  // folder-scoped session or by the ahead-of-schedule new queue below.
  const scope = Object.values(words)
    .filter((e) => VT.isLearnable(e) && (!folderId || VT.foldersOf(e).includes(folderId)));
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
// from nearly always does, so it is blanked — wordRegex is the same
// word-bounded matcher the page highlighter uses, so `read` does not blank
// `already`.
function maskContext(text, word) {
  return String(text ?? '').replace(VT.wordRegex(word), '\u2026');
}

function renderCard() {
  const scopeName = reviewScope ? folders[reviewScope]?.name : null;
  $('rv-title').textContent = scopeName ? `Review · ${scopeName}` : 'Review';

  renderSide();
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
    const waiting = newCards(Object.values(words)
      .filter((e) => !reviewScope || VT.foldersOf(e).includes(reviewScope))).length;
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

  // The prompt is the meaning; the word is what you produce. A card with
  // nothing to prompt with shows the word instead and goes back to being a
  // recognition card.
  $('rv-vi').textContent = canType ? (entry.vi ?? '') : '';
  $('rv-def').textContent = canType ? (entry.def ?? '') : '';
  const seen = $('rv-context');
  const context = entry.context
    ? (revealed ? entry.context : maskContext(entry.context, entry.word))
    : '';
  seen.hidden = !context;
  seen.textContent = context;

  // The IPA and the play button are the answer's shape and the answer's sound.
  // Both would hand it to you, so neither appears until you have committed.
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
  // sitting in the page while you are still trying to recall it. The Cambridge
  // href and the full entry are written here for the same reason: both spell
  // the word out.
  $('rv-answer').hidden = !revealed;
  $('rv-word').textContent = revealed ? entry.word : '';
  // The attribute is removed rather than blanked, so before the answer this is
  // an inert <a> and not a focusable link to the top of the page.
  if (revealed) {
    $('rv-cam').href = `${VT.CAMBRIDGE}/dictionary/english/${encodeURIComponent(entry.word)}`;
  } else {
    $('rv-cam').removeAttribute('href');
  }
  renderFull(revealed ? entry : null);
  renderDiff(revealed && canType ? VT.diffWord(typed, entry.word) : null);
  renderGrades(revealed ? suggestedGrade() : null);
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

async function grade(quality) {
  // Re-entry guard: putWord awaits a storage round-trip during which the
  // buttons stay live, and a second press would shift a card the user never saw.
  if (grading || !revealed || !queue.length) return;
  grading = true;
  try {
    const entry = queue.shift();
    const patch = VT.schedule(entry, quality);
    Object.assign(entry, patch);
    await putWord(entry.word, patch);
    recordReview(entry.word, quality, patch.lastReview);
    // A lapse returns to the back of this session's queue, so it is seen again
    // today; sessionTotal grows with it so the counter stays honest.
    if (quality < 3) {
      queue.push(entry);
      sessionTotal++;
    }
    revealed = false;
    typed = '';
    $('rv-input').value = '';
    words[entry.word] = entry;
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
  // typed, and its digits and letters must not grade the card behind it.
  if ($('practice-dlg').open) return;
  // The picker owns the keyboard while it is open: typing a tag name must not
  // grade the card, and Esc closes the picker rather than the session.
  if ($('tag-dlg').open) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    showView('overview');
    render();
    return;
  }
  // The session controls, the star and the theme button own their own keys:
  // Space flips the switch, Enter presses the button, a letter picks a voice.
  // Only the bare card gets the shortcuts.
  if (event.target.closest?.('.rvctl, #rv-star, #theme-btn')) return;
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
  $('rv-voice').value = prefs.accent;
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
  const scope = Object.values(words)
    .filter((e) => VT.isLearnable(e) && (!reviewScope || VT.foldersOf(e).includes(reviewScope)));
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
  pronounce(entry, prefs.accent);
}

// The words a practice mode draws from: the review's folder when it has one,
// everything otherwise. Skipped words are out, as they are out of review.
function practicePool(all) {
  return all.filter((e) => VT.isLearnable(e)
    && (!reviewScope || VT.foldersOf(e).includes(reviewScope)));
}

function renderPractice(all) {
  PRACTICE.renderGrid($('pr-grid'), practicePool(all), practice.counts);
}

PRACTICE.hooks.speak = (entry) => speakWord(entry);
// After each answer, so the badge behind the dialog is already right when it
// closes. Not through storage.onChanged: that re-renders the whole page on
// every answer of a ten-question round.
PRACTICE.hooks.changed = async () => {
  practice = await getPractice();
  renderPractice(Object.values(words));
};

// stop() here as well as on close: the close event is what Esc gives us, but
// the ✕ should not depend on it to halt a running game.
$('pr-close').addEventListener('click', () => { $('practice-dlg').close(); PRACTICE.stop(); });
// Only if it is still shut: a close queued by the last session's dlg.close()
// can land after a new start() has reopened it, and must not abort that one.
$('practice-dlg').addEventListener('close', () => { if (!$('practice-dlg').open) PRACTICE.stop(); });

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

  // levels
  const levelSeries = [...LEVELS, DASH].map((l) => ({
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
