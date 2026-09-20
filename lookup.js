// The lookup pipeline and pronunciation, shared by the side panel and the
// dashboard. Network lives here; it must never be loaded into a content
// script, which gets no CORS bypass in MV3.
//
// Which dictionary is asked, and how its page is parsed, belongs to the
// language pack in lang/<id>/dictionary.js. This file is the shape of a
// lookup, not the source of one.

// The dictionary call, dispatched to the language's pack. The pack owns the
// URL, the parsing and the not-found signal; this owns only the fallback for
// a language that has no dictionary registered — which is a real state while
// a pack is being built, and must degrade rather than throw.
async function fetchEntry(word, lang) {
  const dict = LANG.dict(lang);
  if (dict) return dict.lookup(word);
  return { level: null, ipa: null, def: null, audio: null,
           failed: `no dictionary registered for ${lang}` };
}

async function fetchVietnamese(word, lang = 'en') {
  // Unofficial, keyless endpoint (dict-chrome-ex client). Acceptable for a
  // personal tool; it will break one day, and the replacement goes behind
  // this same function.
  //
  // `sl` is the study language, not always English: the same endpoint answers
  // for Korean unchanged (verified: sl=ko&tl=vi on 책 returns "sách").
  const url = 'https://translate.googleapis.com/translate_a/single'
    + `?client=dict-chrome-ex&sl=${encodeURIComponent(lang)}&tl=vi`
    + `&dt=t&q=${encodeURIComponent(word)}`;
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
async function resolveWord(rawWord, url, folderIds, context, langId) {
  // The pack decides what the saved key is. For English that is the word as
  // typed; for a language that inflects, it is the lemma — 책을 is saved as
  // 책, while `context` keeps the surface form the word was actually met in.
  const pack = LANG.pick(langId, rawWord);
  const word = pack.lemma(pack.normalise(rawWord));
  const words = await getWords();

  const known = words[word];
  if (known) {
    const patch = {};
    if (url && !known.sources.includes(url)) {
      known.sources.push(url);
      patch.sources = known.sources;
    }
    // A word already saved without context gains it the next time it is met
    // in a real sentence; an existing context is never overwritten.
    if (context && !known.context) {
      known.context = context;
      patch.context = context;
    }
    if (folderIds?.length) {
      const merged = [...new Set([...VT.foldersOf(known), ...folderIds])];
      known.folders = merged;
      patch.folders = merged;
    }
    if (Object.keys(patch).length) await putWord(word, patch);
    return { entry: known };
  }

  const [parsed, vi] = await Promise.all([
    fetchEntry(word, pack.id),
    fetchVietnamese(word, pack.id)
  ]);
  if (parsed.notFound) return { notFound: true };

  const entry = VT.newEntry(word, parsed, vi, url, pack.id);
  if (context) entry.context = context;
  // Not persisted: it describes this attempt, not the word.
  const failed = parsed.failed ?? null;
  if (folderIds?.length) {
    entry.folders = [...new Set([VT.READING, ...folderIds])];
  }
  await putWord(word, entry);
  return { entry, failed };
}

// `accent` is 'uk' or 'us' and optional: the side panel calls these with one
// argument and gets the British voice it always had.
function pronounce(entry, accent = 'uk') {
  // Cambridge gives both recordings. A word saved before audioUs was parsed has
  // only the one, and the wrong accent beats falling through to the robot voice.
  const src = accent === 'us' ? (entry.audioUs ?? entry.audio) : entry.audio;
  if (src) {
    new Audio(src).play().catch((err) => {
      console.error('[vocab-track] audio playback failed for', entry.word, err);
      speak(entry.word, accent, entry.lang);
    });
    return;
  }
  // The only caller that holds an entry, so the only place the word's language
  // can still be recovered. Without these two arguments every synthesised word
  // on every surface is English.
  speak(entry.word, accent, entry.lang);
}

// `lang` is a pack id, and optional for a different reason than `accent` is.
// `accent` defaults because three call paths reach pronounce() without one
// (practice.js:22, sidepanel.js:76, sidepanel.js:412). `lang` defaults because
// pronounce() is the only caller and always passes `entry.lang` — but the field
// postdates most of the store, so an older entry passes `undefined`, and the
// script of the word itself answers for those (LANG.pick, lang/lang.js).
function speak(word, accent = 'uk', lang) {
  const voices = LANG.pick(lang, word).voices;
  // reviewPrefs.accent is ONE string across every language, so a profile that
  // picked US in English arrives here with 'us' on a Korean word. Falling back
  // to the pack's first voice is what makes that an accent that does not apply
  // rather than utterance.lang = undefined.
  const voice = voices.find((v) => v.id === accent) ?? voices[0];
  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = voice.bcp47;
  // ponytail: says nothing at all when the OS has no voice for this tag —
  // Chrome neither throws nor fires an error, it just stays silent, and a Mac
  // ships no Korean voice until one is downloaded. getVoices() is the check,
  // but it fills asynchronously (voiceschanged) and this seam owns no surface
  // to warn on. The warning belongs to a caller that has one.
  speechSynthesis.speak(utterance);
}
