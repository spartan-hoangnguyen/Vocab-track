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

const DASH = '—';

async function getWords() {
  const { words } = await chrome.storage.local.get('words');
  return words ?? {};
}

// Writes are serialised: putWord read-modify-writes the whole `words` map,
// and a lookup's fetches can finish while another is still in flight.
// Without this, the second write clobbers the first and the word is lost.
let writeQueue = Promise.resolve();

// Patches, never replaces: the caller snapshots an entry before an await
// (a storage read, a fetch), and another queued write can land in between.
// Overwriting the whole record with that stale snapshot would erase whatever
// that other write just added (e.g. a `sources` URL). Object.assign onto the
// current stored record instead, so only the fields the caller actually
// changed are applied.
function putWord(word, patch) {
  writeQueue = writeQueue.then(async () => {
    try {
      const words = await getWords();
      words[word] = Object.assign(words[word] ?? {}, patch);
      await chrome.storage.local.set({ words });
    } catch (err) {
      // Caught here, not rethrown: a rejected link in this chain would skip
      // every later queued write's callback, silently dropping them too.
      console.error('[vocab-track] save failed for', word, err);
    }
  });
  return writeQueue;
}

async function fetchCambridge(word) {
  try {
    const res = await fetch(`${VT.CAMBRIDGE}/dictionary/english/${encodeURIComponent(word)}`);
    // Cambridge never 404s an unknown word: it 302-redirects to the
    // dictionary index, which fetch follows, so res.ok is true and
    // res.status is useless here. res.redirected is ALSO not a valid test —
    // a known word like "cats" legitimately 302s to a real entry
    // (.../dictionary/english/cat). The only reliable signal is where the
    // redirect actually landed: only the bare index path means not-found.
    if (new URL(res.url).pathname === '/dictionary/english/') return { notFound: true };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return VT.parseCambridge(await res.text());
  } catch (err) {
    // Degrade, never abort: the word is still worth saving with a translation.
    console.error('[vocab-track] cambridge lookup failed for', word, err);
    return { level: null, ipa: null, def: null, audio: null };
  }
}

async function fetchVietnamese(word) {
  // Unofficial, keyless endpoint (dict-chrome-ex client). Acceptable for a
  // personal tool; it will break one day, and the replacement goes behind
  // this same function.
  const url = 'https://translate.googleapis.com/translate_a/single'
    + `?client=dict-chrome-ex&sl=en&tl=vi&dt=t&q=${encodeURIComponent(word)}`;
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

// Captured once, before renderNotFound can ever overwrite it, so the empty
// state can be restored to its original instruction rather than getting
// stuck on a stale not-found message.
const LOOKUP_EMPTY_DEFAULT = $('lookup-empty').textContent;

function renderEntry(entry) {
  showView('lookup');
  $('lookup-empty').hidden = true;
  $('lookup-empty').textContent = LOOKUP_EMPTY_DEFAULT;
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
  // Consumed: clear it now, in lookup() itself rather than in a caller, so
  // BOTH callers below (the load-time get() and the onChanged listener)
  // clear it. Otherwise a second lookup while the panel is already open
  // (which only the onChanged path sees) would leave `pending` behind for a
  // later toolbar-only open to replay. Clearing fires onChanged again with
  // no newValue, which re-enters here and returns immediately above — no
  // loop.
  chrome.storage.session.remove('pending');
  const word = VT.normaliseWord(pending.word);
  const words = await getWords();

  // Already known: no network call. Record that it appeared on this page too,
  // so the highlighter picks it up here.
  const known = words[word];
  if (known) {
    if (!known.sources.includes(pending.url)) {
      known.sources.push(pending.url);
      await putWord(word, { sources: known.sources });
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
  await putWord(word, entry);
  renderEntry(entry);
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
