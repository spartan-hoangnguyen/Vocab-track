const $ = (id) => document.getElementById(id);
const DASH = VT.DASH;
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const VIEWS = ['overview', 'words', 'review', 'stats', 'io'];

// One in-memory snapshot per render pass. Every view reads from this rather
// than hitting storage per row, and refresh() is the single place that
// reloads it, so a write anywhere is followed by exactly one re-read.
let words = {};
let folders = {};
let activeFolder = null;   // null = all words

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
  [words, folders] = await Promise.all([getWords(), getFolders()]);
  render();
}

function render() {
  const all = Object.values(words);
  renderOverview(all);
  renderWords(all);
  renderStreak(all);
  renderStats(all);
  renderCard();
}

/* ---------- overview ---------- */

function countsByFolder(all) {
  const counts = {};
  for (const entry of all) {
    for (const id of VT.foldersOf(entry)) counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

function dueCount(entries) {
  const now = Date.now();
  return entries.filter((e) => e.due <= now).length;
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

  const counts = countsByFolder(all);
  const grid = $('ov-folders');
  grid.replaceChildren();
  for (const folder of Object.values(folders)) {
    const n = counts[folder.id] ?? 0;
    const members = all.filter((e) => VT.foldersOf(e).includes(folder.id));
    const card = document.createElement('button');
    card.className = `f ${folder.color ?? 'sage'}`;
    card.addEventListener('click', () => openFolder(folder.id));

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = folder.icon ?? '\u{1F4C1}';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${folder.auto ? 'Auto' : 'Manual'} · ${n} word${n === 1 ? '' : 's'}`;
    const name = document.createElement('h3');
    name.textContent = folder.name;
    const desc = document.createElement('p');
    desc.textContent = folder.desc ?? '';
    const foot = document.createElement('div');
    foot.className = 'foot';
    const dueHere = dueCount(members);
    const dueText = document.createElement('span');
    dueText.textContent = dueHere ? `${dueHere} due today` : (n ? 'All reviewed' : 'Empty');
    foot.appendChild(dueText);
    if (dueHere) {
      const go = document.createElement('button');
      go.className = 'edit';
      go.textContent = 'Review';
      go.addEventListener('click', (event) => {
        event.stopPropagation();
        startReview(folder.id);
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
    card.append(badge, meta, name, desc, foot);
    grid.appendChild(card);
  }

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

function openFolder(id) {
  activeFolder = id;
  showView('words');
  render();
}

/* ---------- words table ---------- */

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

  $('w-title').textContent = activeFolder ? folders[activeFolder]?.name ?? 'Folder' : 'All words';
  $('w-sub').textContent = term
    ? `${shown.length} match${shown.length === 1 ? '' : 'es'} for “${term}”`
    : `${shown.length} word${shown.length === 1 ? '' : 's'}`;

  const cards = $('w-cards');
  cards.replaceChildren();
  for (const entry of shown) cards.appendChild(wordCard(entry));

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
  title.addEventListener('click', () => pronounce(entry));
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

  for (const id of VT.foldersOf(entry)) {
    const tag = el('span', 'tag clickable', folders[id]?.name ?? id);
    tag.addEventListener('click', () => openFolder(id));
    foot.appendChild(tag);
  }
  const add = el('span', 'tag clickable', '+');
  add.title = 'Add to folder';
  add.addEventListener('click', () => assignFolder(entry));
  foot.appendChild(add);

  card.appendChild(foot);
  return card;
}

async function assignFolder(entry) {
  const manual = Object.values(folders).filter((f) => !f.auto);
  if (!manual.length) {
    alert('Create a folder first.');
    return;
  }
  const names = manual.map((f, i) => `${i + 1}. ${f.name}`).join('\n');
  const pick = prompt(`Add "${entry.word}" to which folder?\n\n${names}`);
  const index = Number(pick) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= manual.length) return;
  await setWordFolders(entry.word, [...VT.foldersOf(entry), manual[index].id]);
  await refresh();
}

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
    for (const [word, incoming] of Object.entries(data.words)) {
      const existing = current[word];
      if (existing) {
        // Merge, never overwrite: the local review schedule is the thing you
        // cannot get back, so ease/interval/reps/due are left untouched and
        // only membership and sources are unioned.
        await putWord(word, {
          folders: [...new Set([...VT.foldersOf(existing), ...VT.foldersOf(incoming)])],
          sources: [...new Set([...(existing.sources ?? []), ...(incoming.sources ?? [])])]
        });
        merged++;
      } else {
        await putWord(word, incoming);
        added++;
      }
    }
    for (const folder of Object.values(data.folders ?? {})) {
      if (folder.id !== VT.READING) await putFolder(folder);
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

$('review-btn').addEventListener('click', () => {
  startReview(null);
  showView('review');
  render();
});

// Another surface (the side panel, or a lookup from a page) can write while
// this tab is open; re-read rather than showing a stale list.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.words || changes.folders)) refresh();
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

function startReview(folderId) {
  reviewScope = folderId;
  const now = Date.now();
  queue = Object.values(words)
    .filter((e) => e.due <= now)
    .filter((e) => !folderId || VT.foldersOf(e).includes(folderId))
    // Oldest due first: the most overdue card is the one most at risk.
    .sort((a, b) => a.due - b.due);
  sessionTotal = queue.length;
  revealed = false;
}

function renderCard() {
  const scopeName = reviewScope ? folders[reviewScope]?.name : null;
  $('rv-title').textContent = scopeName ? `Review · ${scopeName}` : 'Review';

  if (!queue.length) {
    $('rv-card').hidden = true;
    $('rv-empty').hidden = false;
    $('rv-exit').hidden = true;
    $('rv-sub').textContent = '';
    $('rv-prog-fill').style.width = sessionTotal ? '100%' : '0%';
    $('rv-empty-text').textContent = sessionTotal
      ? `Done — ${sessionTotal} card${sessionTotal === 1 ? '' : 's'} reviewed.`
      : 'Nothing due. Come back later.';
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

  $('rv-word').textContent = entry.word;
  $('rv-level').textContent = entry.level ?? DASH;
  $('rv-ipa').textContent = entry.ipa ? `/${entry.ipa}/` : '';
  $('rv-play').onclick = () => pronounce(entry);

  // The answer is only written into the DOM once revealed, so it is never
  // sitting in the page while you are still trying to recall it.
  $('rv-answer').hidden = !revealed;
  $('rv-reveal').hidden = revealed;
  $('rv-vi').textContent = revealed ? (entry.vi ?? DASH) : '';
  $('rv-def').textContent = revealed ? (entry.def ?? DASH) : '';
  const seen = $('rv-context');
  seen.hidden = !(revealed && entry.context);
  seen.textContent = revealed && entry.context ? entry.context : '';
}

function reveal() {
  if (revealed || !queue.length) return;
  revealed = true;
  renderCard();
  pronounce(queue[0]);
}

async function grade(quality) {
  // Re-entry guard: putWord awaits a storage round-trip during which the
  // buttons stay live, and a second press would shift a card the user never saw.
  if (grading || !revealed || !queue.length) return;
  grading = true;
  try {
    const entry = queue.shift();
    const patch = VT.sm2(entry, quality);
    Object.assign(entry, patch);
    await putWord(entry.word, patch);
    // A lapse returns to the back of this session's queue, so it is seen again
    // today; sessionTotal grows with it so the counter stays honest.
    if (quality < 3) {
      queue.push(entry);
      sessionTotal++;
    }
    revealed = false;
    words[entry.word] = entry;
    renderCard();
  } finally {
    grading = false;
  }
}

for (const g of GRADES) {
  const button = document.createElement('button');
  const label = document.createElement('b');
  label.textContent = g.label;
  const hint = document.createElement('span');
  const key = document.createElement('kbd');
  key.textContent = g.key;
  hint.append(key, g.hint);
  button.append(label, hint);
  button.addEventListener('click', () => grade(g.q));
  $('rv-grades').appendChild(button);
}

$('rv-reveal').addEventListener('click', reveal);
$('rv-back').addEventListener('click', () => { showView('overview'); render(); });

document.addEventListener('keydown', (event) => {
  if ($('view-review').hidden || document.activeElement === $('q')) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    showView('overview');
    render();
    return;
  }
  if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); reveal(); return; }
  const g = GRADES.find((x) => x.key === event.key);
  if (g) { event.preventDefault(); grade(g.q); }
});

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
    bar.title = `${point.label}: ${point.n}`;
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

  // review load, next 14 days — everything already overdue lands on today
  const dueSeries = [];
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  for (let i = 0; i < 14; i++) {
    const from = startOfToday.getTime() + i * 86400000;
    const to = from + 86400000;
    const n = all.filter((e) => (i === 0 ? e.due < to : e.due >= from && e.due < to)).length;
    dueSeries.push({ label: new Date(from).toLocaleDateString(), n });
  }
  plotSeries($('st-due'), dueSeries, false);
  const to = new Date(); to.setDate(to.getDate() + 13);
  $('st-due-to').textContent = to.toLocaleDateString();

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
