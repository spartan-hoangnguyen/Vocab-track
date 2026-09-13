const $ = (id) => document.getElementById(id);

const VIEWS = ['lookup', 'words', 'review'];

function showView(name) {
  for (const view of VIEWS) {
    $(`view-${view}`).hidden = view !== name;
    $(`tab-${view}`).classList.toggle('active', view === name);
  }
}

$('tab-lookup').addEventListener('click', () => showView('lookup'));
$('tab-review').addEventListener('click', () => showView('review'));

const DASH = VT.DASH;

// Captured once, before renderNotFound can ever overwrite it, so the empty
// state can be restored to its original instruction rather than getting
// stuck on a stale not-found message.
const LOOKUP_EMPTY_DEFAULT = $('lookup-empty').textContent;

function renderEntry(entry, failed) {
  showView('lookup');
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
  const block = $('entry-syn-block');
  const box = $('entry-syn');
  box.replaceChildren();
  const syn = entry.synonyms ?? [];
  const rel = entry.related ?? [];
  block.hidden = !syn.length && !rel.length;
  $('entry-syn-title').textContent = syn.length ? 'Synonyms' : 'Related words';
  for (const word of (syn.length ? syn : rel)) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = word;
    box.appendChild(chip);
  }
}

function renderNotFound(word) {
  showView('lookup');
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
  if (pending) {
    lookup(pending);
  } else {
    showView('review');
    startReview();
  }
});
// Every lookup after the panel is already open arrives here instead: a
// storage write while the panel is open does not re-run this script, so this
// is the second, ongoing handoff path (the load-time read above only covers
// the first one).
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.pending) lookup(changes.pending.newValue);
});

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

let grading = false;

async function grade_(quality) {
  // Re-entry guard: putWord awaits a storage round-trip, during which the
  // buttons are still live. A second click would shift the next card and
  // silently grade a card the user never saw.
  if (grading) return;
  grading = true;
  try {
    const entry = queue.shift();
    const patch = VT.sm2(entry, quality);
    Object.assign(entry, patch);
    await putWord(entry.word, patch);
    // A lapse is re-queued at the back, so it is seen again this session.
    if (quality < 3) queue.push(entry);
    nextCard();
  } finally {
    grading = false;
  }
}

buildGradeButtons();
$('tab-review').addEventListener('click', startReview);

async function renderWords() {
  // Ruling F3: switch the view here, first, so both the tab click and the
  // filter's input handler (which also calls renderWords) keep it visible.
  showView('words');
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

$('open-dashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});
