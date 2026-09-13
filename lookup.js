// The Cambridge + translation pipeline and pronunciation, shared by the side
// panel and the dashboard. Network lives here; it must never be loaded into a
// content script, which gets no CORS bypass in MV3.

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
    // `failed` distinguishes "the dictionary call did not happen" from "the
    // entry has no CEFR level", which are otherwise the same four nulls and
    // read identically in the UI.
    return { level: null, ipa: null, def: null, audio: null, failed: String(err) };
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

// The whole save path for one word, with no UI in it: known words short-
// circuit without a network call, new words are fetched, saved and returned.
// Returns { entry } or { notFound: true }.
async function resolveWord(rawWord, url, folderIds) {
  const word = VT.normaliseWord(rawWord);
  const words = await getWords();

  const known = words[word];
  if (known) {
    const patch = {};
    if (url && !known.sources.includes(url)) {
      known.sources.push(url);
      patch.sources = known.sources;
    }
    if (folderIds?.length) {
      const merged = [...new Set([...VT.foldersOf(known), ...folderIds])];
      known.folders = merged;
      patch.folders = merged;
    }
    if (Object.keys(patch).length) await putWord(word, patch);
    return { entry: known };
  }

  const [parsed, vi] = await Promise.all([fetchCambridge(word), fetchVietnamese(word)]);
  if (parsed.notFound) return { notFound: true };

  const entry = VT.newEntry(word, parsed, vi, url);
  // Not persisted: it describes this attempt, not the word.
  const failed = parsed.failed ?? null;
  if (folderIds?.length) {
    entry.folders = [...new Set([VT.READING, ...folderIds])];
  }
  await putWord(word, entry);
  return { entry, failed };
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
