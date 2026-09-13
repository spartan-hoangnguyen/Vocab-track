const $ = (id) => document.getElementById(id);
const DASH = VT.DASH;
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const VIEWS = ['overview', 'words', 'io'];

// One in-memory snapshot per render pass. Every view reads from this rather
// than hitting storage per row, and refresh() is the single place that
// reloads it, so a write anywhere is followed by exactly one re-read.
let words = {};
let folders = {};
let activeFolder = null;   // null = all words

function showView(name) {
  for (const view of VIEWS) $(`view-${view}`).hidden = view !== name;
  for (const a of document.querySelectorAll('nav a')) {
    a.classList.toggle('on', a.dataset.view === name);
  }
}

for (const a of document.querySelectorAll('nav a')) {
  a.addEventListener('click', (event) => {
    event.preventDefault();
    if (a.dataset.view === 'words') activeFolder = null;
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

  const body = $('w-rows');
  body.replaceChildren();
  for (const entry of shown) body.appendChild(wordRow(entry));

  const empty = $('w-empty');
  empty.replaceChildren();
  empty.hidden = shown.length > 0;
  if (!shown.length) {
    if (term && VT.isLookupCandidate(term)) {
      // Nothing saved matches, but it looks like a word — offer the lookup
      // rather than a dead end. This is the dashboard's own way in, for words
      // you meet away from a page you were reading.
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

function wordRow(entry) {
  const tr = document.createElement('tr');

  const term = document.createElement('td');
  const termSpan = document.createElement('span');
  termSpan.className = 'term';
  termSpan.textContent = entry.word;
  termSpan.title = 'Pronounce';
  termSpan.addEventListener('click', () => pronounce(entry));
  term.appendChild(termSpan);

  const lvl = document.createElement('td');
  const lvlSpan = document.createElement('span');
  lvlSpan.className = 'lvl';
  lvlSpan.textContent = entry.level ?? DASH;
  lvl.appendChild(lvlSpan);

  const vi = document.createElement('td');
  vi.className = 'vi';
  vi.textContent = entry.vi ?? DASH;

  const def = document.createElement('td');
  def.className = 'def';
  // textContent throughout: definitions and translations come from third
  // parties and must never be parsed as markup.
  def.textContent = entry.def ?? DASH;

  const tags = document.createElement('td');
  const tagWrap = document.createElement('div');
  tagWrap.className = 'tags';
  for (const id of VT.foldersOf(entry)) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = folders[id]?.name ?? id;
    tag.addEventListener('click', () => openFolder(id));
    tagWrap.appendChild(tag);
  }
  const assign = document.createElement('span');
  assign.className = 'tag';
  assign.textContent = '+';
  assign.title = 'Add to folder';
  assign.addEventListener('click', () => assignFolder(entry));
  tagWrap.appendChild(assign);
  tags.appendChild(tagWrap);

  const when = document.createElement('td');
  when.className = 'r when';
  when.textContent = relative(entry.added);

  const del = document.createElement('td');
  del.className = 'r';
  const delBtn = document.createElement('button');
  delBtn.className = 'rowdel';
  delBtn.textContent = '×';
  delBtn.title = `Delete ${entry.word}`;
  delBtn.addEventListener('click', async () => {
    if (!confirm(`Delete "${entry.word}"? This cannot be undone.`)) return;
    await removeWord(entry.word);
    await refresh();
  });
  del.appendChild(delBtn);

  tr.append(term, lvl, vi, def, tags, when, del);
  return tr;
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
  // Review still lives in the side panel; the dashboard hands off to it.
  chrome.runtime.sendMessage({ type: 'open-review' });
});

// Another surface (the side panel, or a lookup from a page) can write while
// this tab is open; re-read rather than showing a stale list.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.words || changes.folders)) refresh();
});

refresh();
