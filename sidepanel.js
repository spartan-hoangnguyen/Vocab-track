const VIEWS = ['word', 'page'];

const $ = (id) => document.getElementById(id);

const DASH = VT.DASH;

function showView(name) {
  for (const view of VIEWS) {
    $(`view-${view}`).hidden = view !== name;
    $(`tab-${view}`).classList.toggle('active', view === name);
  }
}

$('tab-word').addEventListener('click', () => showView('word'));
$('tab-page').addEventListener('click', () => { showView('page'); renderPage(); });

// Captured once, before renderNotFound can ever overwrite it, so the empty
// state can be restored to its original instruction rather than getting
// stuck on a stale not-found message.
const LOOKUP_EMPTY_DEFAULT = $('lookup-empty').textContent;

function renderEntry(entry, failed) {
  showView('word');
  $('lookup-empty').hidden = true;
  $('lookup-empty').textContent = LOOKUP_EMPTY_DEFAULT;
  $('entry').hidden = false;

  $('entry-word').textContent = entry.word;
  $('entry-level').textContent = entry.level ?? DASH;
  $('entry-pos').textContent = entry.pos ?? '';
  $('entry-gram').textContent = entry.gram ?? '';
  $('entry-vi').textContent = entry.vi ?? DASH;

  renderProns(entry);
  renderContext(entry);
  renderLinks(entry);
  renderSenses(entry);
  renderChips(entry);

  const warn = $('entry-warn');
  warn.replaceChildren();
  warn.hidden = !failed;
  if (failed) {
    const lead = document.createElement('b');
    lead.textContent = 'Cambridge lookup failed. ';
    warn.append(lead, `Level, pronunciation and definition are missing for this reason, not because the word has none. ${failed}`);
  }
}

function renderProns(entry) {
  const box = $('entry-prons');
  box.replaceChildren();
  // Both accents when Cambridge has both; the play button always works, since
  // pronounce() falls back to speech synthesis when there is no mp3.
  const rows = [['UK', entry.ipa, entry.audio], ['US', entry.ipaUs, entry.audioUs]]
    .filter(([, ipa, audio]) => ipa || audio);
  if (!rows.length) rows.push(['UK', null, null]);
  for (const [tag, ipa, audio] of rows) {
    const row = document.createElement('div');
    row.className = 'pron';
    const label = document.createElement('span');
    label.className = 'tag';
    label.textContent = tag;
    const text = document.createElement('span');
    text.textContent = ipa ? `/${ipa}/` : DASH;
    const play = document.createElement('button');
    play.textContent = '▶';
    play.setAttribute('aria-label', `Pronounce ${entry.word} (${tag})`);
    play.addEventListener('click', () => pronounce({ ...entry, audio: audio ?? entry.audio }));
    row.append(label, text, play);
    box.appendChild(row);
  }
}

function renderContext(entry) {
  const block = $('entry-context-block');
  const quote = $('entry-context');
  quote.replaceChildren();
  block.hidden = !entry.context;
  if (!entry.context) return;
  // The word is marked inside its own sentence, built with text nodes so the
  // page's sentence can never be parsed as markup.
  const re = VT.wordRegex(entry.word);
  let last = 0;
  let match;
  while ((match = re.exec(entry.context))) {
    quote.append(entry.context.slice(last, match.index));
    const mark = document.createElement('mark');
    mark.textContent = match[0];
    quote.append(mark);
    last = match.index + match[0].length;
  }
  quote.append(entry.context.slice(last));
}

function renderLinks(entry) {
  const box = $('entry-links');
  box.replaceChildren();

  const source = entry.sources?.[entry.sources.length - 1];
  // A text fragment, so the link lands on the sentence rather than the top of
  // a long article. Falls back to the plain URL when there is no context.
  const deep = VT.sourceLink(source, entry.context, entry.word);
  if (deep) {
    let host = source;
    try { host = new URL(source).hostname.replace(/^www\./, ''); } catch { /* keep raw */ }
    const back = document.createElement('a');
    back.href = deep;
    back.target = '_blank';
    back.rel = 'noreferrer';
    back.textContent = `↩ ${host}`;
    back.title = 'Jump back to where you read it';
    box.appendChild(back);
  }

  const cam = document.createElement('a');
  cam.href = `${VT.CAMBRIDGE}/dictionary/english/${encodeURIComponent(entry.word)}`;
  cam.target = '_blank';
  cam.rel = 'noreferrer';
  cam.textContent = 'Cambridge ↗';
  cam.title = 'Full entry on Cambridge Dictionary';
  box.appendChild(cam);
}

function renderSenses(entry) {
  const list = $('entry-senses');
  list.replaceChildren();
  const senses = entry.senses?.length
    ? entry.senses
    : [{ level: entry.level, def: entry.def, example: null }];
  $('entry-senses-title').textContent = senses.length > 1 ? 'Meanings' : 'Meaning';
  for (const sense of senses) {
    const li = document.createElement('li');
    const def = document.createElement('span');
    def.className = 'd';
    def.textContent = sense.def ?? DASH;
    li.appendChild(def);
    if (sense.level) {
      const lv = document.createElement('span');
      lv.className = 'lv';
      lv.textContent = sense.level;
      li.appendChild(lv);
    }
    if (sense.example) {
      const ex = document.createElement('span');
      ex.className = 'ex';
      ex.textContent = sense.example;
      li.appendChild(ex);
    }
    list.appendChild(li);
  }
}

function renderChips(entry) {
  const box = $('entry-groups');
  box.replaceChildren();
  // Cambridge has all three for some words and none for others, so each group
  // appears only when it has something in it.
  const groups = [
    ['Synonyms', entry.synonyms],
    ['Opposites', entry.opposites],
    ['Related words', entry.related]
  ].filter(([, items]) => items?.length);

  for (const [label, items] of groups) {
    const section = document.createElement('section');
    section.className = 'block';
    const title = document.createElement('h2');
    title.textContent = label;
    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const word of items) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = word;
      chips.appendChild(chip);
    }
    section.append(title, chips);
    box.appendChild(section);
  }
}

function renderNotFound(word) {
  $('entry').hidden = true;
  $('lookup-empty').hidden = false;
  $('lookup-empty').textContent = `"${word}" is not in the Cambridge dictionary. Nothing saved.`;
}

async function lookup(pending) {
  if (!pending) return;
  // Consumed: clear it now, in lookup() itself rather than in a caller, so
  // BOTH callers below (the load-time get() and the onChanged listener)
  // clear it. Otherwise a second lookup while the panel is already open
  // (which only the onChanged path sees) would leave `pending` behind for a
  // later toolbar-only open to replay. Clearing fires onChanged again with
  // no newValue, which re-enters here and returns immediately above — no
  // loop.
  chrome.storage.session.remove('pending');
  const word = VT.normaliseWord(pending.word);
  const { entry, notFound, failed } = await resolveWord(word, pending.url, null, pending.context);
  if (notFound) {
    renderNotFound(word);
    return;
  }
  renderEntry(entry, failed);
}

// Single read of `pending` on load. Present: the panel was opened by a
// lookup (button click) that reached storage before this script started, so
// run it (lookup() itself clears the key once consumed, so a later
// toolbar-only open — which writes nothing new — lands on Review instead of
// replaying this word). Absent: opened from the toolbar icon with no lookup
// pending, land on Review directly.
chrome.storage.session.get('pending', ({ pending }) => {
  // Absent means the panel was opened from the toolbar with no lookup pending,
  // which now just shows the empty state — browsing and review live in the
  // dashboard, so the panel is only ever the lookup surface.
  if (pending) lookup(pending);
});
// Every lookup after the panel is already open arrives here instead: a
// storage write while the panel is open does not re-run this script, so this
// is the second, ongoing handoff path (the load-time read above only covers
// the first one).
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.pending) lookup(changes.pending.newValue);
});


$('open-dashboard').addEventListener('click', () => {
  // Via the worker, so this reuses the same dashboard tab the toolbar icon does
  // instead of opening a second one.
  chrome.runtime.sendMessage({ type: 'open-dashboard' });
});


/* ---------- words saved on the page you are reading ---------- */

// The active tab's id. tabs.query returns it without the "tabs" permission —
// only url and title are withheld — so the URL is asked of the content script
// instead, which knows its own location.
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

async function askPage(message) {
  const tab = await activeTab();
  if (!tab) return null;
  try {
    return { tabId: tab.id, reply: await chrome.tabs.sendMessage(tab.id, message) };
  } catch (err) {
    // No content script on chrome:// pages, the web store, PDFs, or a tab that
    // has not been reloaded since the extension was installed.
    console.error('[vocab-track] page did not answer', message.type, err);
    return null;
  }
}

async function renderPage() {
  const list = $('page-list');
  const empty = $('page-empty');
  list.replaceChildren();

  const asked = await askPage({ type: 'page-info' });
  if (!asked?.reply?.url) {
    $('page-head').textContent = '';
    empty.hidden = false;
    empty.textContent = 'This page cannot be read — try reloading it, or open a normal web page.';
    return;
  }

  const { url } = asked.reply;
  const video = VT.youtubeId(url) !== null;
  const words = await getWords();
  // By page key, not by URL: every word saved from a video carries the moment
  // it was said, so the sources for one video are all different strings.
  const key = VT.pageKey(url);
  const here = Object.values(words)
    .filter((entry) => entry.sources?.some((source) => VT.pageKey(source) === key))
    .sort((a, b) => b.added - a.added);

  let host = url;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep raw */ }
  $('page-head').textContent = here.length
    ? `${here.length} word${here.length === 1 ? '' : 's'} saved on ${host}`
    : '';

  empty.hidden = here.length > 0;
  empty.textContent = `Nothing saved on ${host} yet.`;

  for (const entry of here) {
    const li = document.createElement('li');
    li.className = 'pageword';

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
    li.title = video ? 'Jump to it in the video' : 'Scroll to it on the page';
    li.addEventListener('click', () => jumpTo(entry, li, key));
    list.appendChild(li);
  }
}

async function jumpTo(entry, li, key) {
  // Which of the word's sources is this page decides where to go: on a video
  // that source carries the timestamp to seek to.
  const source = entry.sources?.find((candidate) => VT.pageKey(candidate) === key);
  const t = VT.timestampOf(source);
  const message = { type: 'scroll-to', word: entry.word };
  if (t !== null) message.t = t;
  const asked = await askPage(message);
  // The word is saved against this URL but is not in the text any more — the
  // article changed, or it was behind something that has since collapsed.
  li.classList.toggle('missing', !asked?.reply?.found);
}

// The panel outlives the tab it was opened over, so the list must follow the
// user rather than freeze on whichever page it was first opened above.
chrome.tabs.onActivated.addListener(() => {
  if (!$('view-page').hidden) renderPage();
});
