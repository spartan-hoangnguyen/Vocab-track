const $ = (id) => document.getElementById(id);

function showView(name) {
  $('view-lookup').hidden = name !== 'lookup';
  $('view-review').hidden = name !== 'review';
  $('tab-lookup').classList.toggle('active', name === 'lookup');
  $('tab-review').classList.toggle('active', name === 'review');
}

$('tab-lookup').addEventListener('click', () => showView('lookup'));
$('tab-review').addEventListener('click', () => showView('review'));

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
