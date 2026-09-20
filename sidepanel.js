const VIEWS = ['word', 'page', 'quiz'];

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
$('tab-quiz').addEventListener('click', () => openQuiz());

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
  renderTags(entry.word);
  renderSenses(entry);
  renderChips(entry);

  const warn = $('entry-warn');
  warn.replaceChildren();
  warn.hidden = !failed;
  if (failed) {
    const lead = document.createElement('b');
    // The dictionary that failed is the word's own, the way the "full entry"
    // link below already reads it (sidepanel.js:126). `?? 'Dictionary'` because
    // lookup.js:13-18 supports a language with no dictionary registered, and
    // "no dictionary registered for ko" is itself one of the `failed` strings
    // that reach here.
    lead.textContent = `${LANG.dict(LANG.of(entry).id)?.name ?? 'Dictionary'} lookup failed. `;
    warn.append(lead, `Level, pronunciation and definition are missing for this reason, not because the word has none. ${failed}`);
  }
}

function renderProns(entry) {
  const box = $('entry-prons');
  box.replaceChildren();
  // The pack names the accents; this file used to hardcode UK and US, which
  // put a Cambridge accent on a Korean word — 책 rendered a row labelled "UK"
  // reading "—", and the screen reader said "Pronounce 책 (UK)".
  //
  // entry.ipa/audio is the FIRST voice and ipaUs/audioUs the SECOND: that is
  // what those two field names have always meant, so the pairing is positional
  // rather than a new per-voice schema on the entry. A one-voice pack reads
  // the first pair and ignores the second, which for Korean is null anyway.
  // register() guarantees every pack at least one voice (lang/lang.js:34), so
  // voices[0] is always there.
  const pairs = [[entry.ipa, entry.audio], [entry.ipaUs, entry.audioUs]];
  const all = LANG.of(entry).voices
    .map((voice, i) => [voice.label, ...(pairs[i] ?? [null, null])]);
  // Both accents when Cambridge has both; the play button always works, since
  // pronounce() falls back to speech synthesis when there is no mp3 — which is
  // why an entry with no pronunciation at all still keeps one row rather than
  // losing the only way to hear it. For Korean that row is the whole feature.
  const rows = all.filter(([, ipa, audio]) => ipa || audio);
  if (!rows.length) rows.push(all[0]);
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
  for (const piece of VT.pieces(entry.context, VT.find(entry.word, entry.context, entry.lang))) {
    if (!piece.hit) {
      quote.append(piece.text);
      continue;
    }
    const mark = document.createElement('mark');
    mark.textContent = piece.text;
    quote.append(mark);
  }
}

function renderLinks(entry) {
  const box = $('entry-links');
  box.replaceChildren();

  const source = entry.sources?.[entry.sources.length - 1];
  // A text fragment, so the link lands on the sentence rather than the top of
  // a long article. Falls back to the plain URL when there is no context.
  const deep = VT.sourceLink(source, entry.context, entry.word, entry.lang);
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

  // The dictionary is the language's, so its name and URL come from the pack.
  const dict = LANG.dict(LANG.of(entry).id);
  if (dict) {
    const cam = document.createElement('a');
    cam.href = dict.href(entry.word);
    cam.target = '_blank';
    cam.rel = 'noreferrer';
    cam.textContent = `${dict.name} ↗`;
    cam.title = `Full entry on ${dict.name}`;
    box.appendChild(cam);
  }
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

/* ---------- topics: file the word while you read ---------- */

// Only ever a word the panel has just saved, so there is always an entry.
let shownWord = null;

async function renderTags(word) {
  shownWord = word;
  const [words, folders] = await Promise.all([getWords(), getFolders()]);
  if (word !== shownWord) return;   // a newer lookup took over while this read
  const mine = VT.foldersOf(words[word]).filter((id) => folders[id] && !folders[id].auto);
  const box = $('entry-tags');
  box.replaceChildren();
  for (const id of mine) {
    const chip = document.createElement('button');
    chip.className = 'chip on';
    chip.textContent = `${folders[id].name} ×`;
    chip.title = 'Take the word out of this topic';
    chip.addEventListener('click', async () => {
      await setWordFolders(word, VT.foldersOf(words[word]).filter((f) => f !== id));
      renderTags(word);
    });
    box.appendChild(chip);
  }
  box.hidden = !mine.length;
  const own = Object.values(folders).filter((f) => !f.auto);
  // `taken` is over ALL your folders; the offered list is only this word's
  // language. Same split as the dashboard's tag picker, and for the same
  // reason — see tagOptions in dashboard.js. The chips above are NOT filtered:
  // a folder the word is already in has to stay removable whatever language it
  // reads as.
  const taken = new Set(own.map((f) => f.name.toLowerCase()));
  const lang = LANG.of(words[word]).id;
  const owners = {};
  for (const entry of Object.values(words)) {
    for (const id of VT.foldersOf(entry)) (owners[id] ??= []).push(entry);
  }
  const names = [
    ...own.filter((f) => !mine.includes(f.id) && VT.inLang(f, owners[f.id], lang))
      .map((f) => f.name),
    ...VT.TOPICS.filter((t) => !folders[t.id] && !taken.has(t.name.toLowerCase())).map((t) => t.name)
  ];
  $('entry-tag-options').replaceChildren(...names.map((value) => Object.assign(
    document.createElement('option'), { value })));
}

async function addTag() {
  const input = $('entry-tag-q');
  const name = input.value.trim();
  if (!name || !shownWord) return;
  const word = shownWord;
  input.value = '';
  const saved = (await getWords())[word];
  const id = await folderForName(name, LANG.of(saved).id);
  await setWordFolders(word, [...VT.foldersOf(saved), id]);
  renderTags(word);
}

$('entry-tag-q').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  addTag();
});
// Picking from the datalist is a choice already made; making you press Enter
// on top of it would be asking twice. Typing is not, or "Science" would file
// itself before you could finish "Sciences".
$('entry-tag-q').addEventListener('input', (event) => {
  if (event.inputType === 'insertReplacementText' || event.inputType === undefined) addTag();
});

function renderNotFound(word) {
  $('entry').hidden = true;
  $('lookup-empty').hidden = false;
  // Only a word reaches here, never an entry — nothing was saved — so the pack
  // comes from the script, the same route resolveWord took to get the answer.
  const dict = LANG.dict(LANG.pick(null, word).id);
  // The dictionary's name is an ADJECTIVE here, never the object of "in".
  // "is not in ${name}" read as an unfinished sentence the moment the name
  // stopped being hard-coded — "is not in Cambridge" wants "dictionary" after
  // it, and "is not in krdict" wants nothing after it at all. Naming it before
  // the noun reads for both, and for the no-pack fallback on its own.
  $('lookup-empty').textContent =
    `No ${dict?.name ?? 'dictionary'} entry for "${word}". Nothing saved.`;
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
  // A click on a highlighted word asks instead of tells: you saved this one
  // already, so the useful question is whether you still know it.
  //
  // Answered from storage and nothing else, deliberately before resolveWord:
  // highlights are painted once at document_idle and never hear about a
  // deletion, so a word deleted in the dashboard stays yellow on an open page.
  // Through resolveWord that stale click would fetch the word from Cambridge
  // and save it again — a quiz is not a save.
  if (pending.mode === 'quiz') {
    const known = (await getWords())[word];
    if (known) await startQuiz(known);
    else quizNothing(`"${word}" is not saved any more.`);
    return;
  }
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




/* ---------- quiz: four meanings, one of them the word's ---------- */


let quizEntry = null;
// Nothing on screen counts as finished, so the first tab click draws a word.
let quizAnswered = true;

function openQuiz() {
  showView('quiz');
  // A question already on screen and unanswered is the one you were in the
  // middle of. Only a finished one is replaced.
  if (quizEntry && !quizAnswered) return;
  return quizRandom();
}

// Due words first — reading is the moment to catch the ones the schedule says
// you are about to forget — falling back to anything quizzable at all.
async function quizRandom() {
  const pool = Object.values(await getWords()).filter((entry) => VT.glossOf(entry));
  // Checked here rather than left to quizOptions: its null means "show the
  // entry instead", which is right for a word you just clicked and wrong for
  // the tab, where it would strand you on the Word view with a random word.
  if (pool.length < 4) {
    quizNothing('Save a few words first — a question needs four meanings to choose between.');
    return;
  }
  const now = Date.now();
  const due = pool.filter((entry) => entry.due <= now);
  const from = due.length ? due : pool;
  return startQuiz(from[Math.floor(Math.random() * from.length)]);
}

function quizNothing(text) {
  showView('quiz');
  quizEntry = null;
  quizAnswered = true;
  $('quiz-card').hidden = true;
  $('quiz-empty').hidden = false;
  $('quiz-empty').textContent = text;
}

async function startQuiz(entry) {
  const options = VT.quizOptions(entry, Object.values(await getWords()));
  // Too few glossed words saved to build a question. Showing the entry is
  // better than showing an apology — it is what the old click did anyway.
  if (!options) {
    renderEntry(entry);
    return;
  }

  showView('quiz');
  quizEntry = entry;
  quizAnswered = false;
  $('quiz-empty').hidden = true;
  $('quiz-card').hidden = false;
  $('quiz-word').textContent = entry.word;
  $('quiz-verdict').hidden = true;
  $('quiz-full').hidden = true;
  $('quiz-next').hidden = true;

  const list = $('quiz-options');
  list.replaceChildren();
  for (const option of options) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'quizopt';
    // textContent, never innerHTML: a gloss is a stored string.
    button.textContent = option.text;
    // Marked on the node rather than kept in a closure variable, so revealing
    // the right answer after a wrong guess is a query, not bookkeeping.
    if (option.correct) button.dataset.correct = '1';
    button.addEventListener('click', () => answerQuiz(option.correct, button));
    li.appendChild(button);
    list.appendChild(li);
  }
}

function answerQuiz(correct, button) {
  if (quizAnswered) return;
  quizAnswered = true;

  const buttons = [...$('quiz-options').querySelectorAll('button')];
  for (const other of buttons) other.disabled = true;
  button.classList.add(correct ? 'right' : 'wrong');
  // The right answer is shown either way: a wrong guess you are not corrected
  // on is a wrong guess you keep.
  if (!correct) buttons.find((b) => b.dataset.correct)?.classList.add('right');

  const verdict = $('quiz-verdict');
  verdict.hidden = false;
  verdict.className = correct ? 'good' : 'bad';
  verdict.textContent = correct ? 'Correct' : 'Not this time';
  $('quiz-full').hidden = false;
  $('quiz-next').hidden = false;
  // Deliberately no putWord and no VT.sm2. This is self-testing while you
  // read; ease, interval and due only move in the dashboard's review, where
  // you chose to sit down and be graded.
  pronounce(quizEntry);
}

$('quiz-full').addEventListener('click', () => {
  // renderEntry already switches to the Word view.
  if (quizEntry) renderEntry(quizEntry);
});
$('quiz-next').addEventListener('click', () => quizRandom());



$('open-dashboard').addEventListener('click', () => {
  // Via the worker, so every route to the dashboard lands on the one tab it
  // remembers instead of opening a second one.
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

// Focus stays in the panel after this, so the first space goes nowhere until
// the reader is clicked once. The keyboard shortcut has no such problem; this
// button exists so the feature is findable at all.
$('speed-read').addEventListener('click', () => askPage({ type: 'speed-read' }));

// The panel outlives the tab it was opened over, so the list must follow the
// user rather than freeze on whichever page it was first opened above.
chrome.tabs.onActivated.addListener(() => {
  if (!$('view-page').hidden) renderPage();
});
