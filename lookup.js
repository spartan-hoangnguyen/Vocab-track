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

// The whole save path for one word, with no UI in it: a known word answers
// from storage — the one exception being a gloss that never landed, which is
// asked for again — and a new word is fetched, saved and returned.
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
    // A gloss that failed the first time is retried, for the same reason a
    // missing context is filled in above: this endpoint is unofficial and
    // rate-limits, and the known path returns before any network call, so
    // without this a word saved during one bad minute has no meaning for
    // good — clicking it again cannot help, because clicking it again lands
    // here. Only a null is retried; a gloss that exists is never overwritten.
    //
    // ponytail: a word the endpoint genuinely has no translation for re-asks
    // on every click. One small request, and the alternative is storing a
    // "we tried" flag that then has to expire — the retry IS the repair, so
    // it cannot be a one-off. Store the attempt if the traffic ever shows up.
    if (!known.vi) {
      const vi = await fetchVietnamese(word, pack.id);
      if (vi) {
        known.vi = vi;
        patch.vi = vi;
      }
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
// macOS ships eight novelty Korean voices — Eddy, Flo, Grandma, Grandpa,
// Reed, Rocko, Sandy, Shelley — beside Yuna, the only real one, and Chrome
// picks among all nine when an utterance names a language and no voice. It
// picks badly. English never showed this because pronounce() plays Cambridge's
// mp3 and only falls through to synthesis when there is none; a Korean word
// has no mp3 at all, so synthesis IS the feature there.
//
// ponytail: a name list, and macOS's. It goes stale when Apple renames one,
// and it says nothing about Windows or Linux — where the filters below still
// do the useful half. The upgrade path is a real voice picker in the review
// preferences, listing what the machine actually has; this is the version
// that needs no UI and no stored preference.
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Eddy|Flo|Fred|Good News|Grandma|Grandpa|Jester|Junior|Kathy|Organ|Reed|Rocko|Sandy|Shelley|Superstar|Trinoids|Whisper|Wobble|Zarvox)\b/i;

// Pure, so the probe can drive it with a hand-made list: headless Chrome has
// no voices at all and getVoices() there is always [].
//
// Primary subtag only, because a pack says 'ko-KR' and a voice can say 'ko'.
// Order: a premium recording beats the system default, which beats anything
// local, which beats whatever is left. An empty list returns null and the
// utterance keeps the language alone — exactly the old behaviour, which is
// the right answer while getVoices() is still filling in.
function bestVoice(tag, voices) {
  const want = String(tag ?? '').toLowerCase().split(/[-_]/)[0];
  if (!want) return null;
  const matching = (voices ?? [])
    .filter((v) => String(v.lang ?? '').toLowerCase().split(/[-_]/)[0] === want);
  const serious = matching.filter((v) => !NOVELTY.test(v.name ?? ''));
  const pool = serious.length ? serious : matching;
  return pool.find((v) => /premium|enhanced|siri/i.test(v.name ?? ''))
    ?? pool.find((v) => v.default)
    ?? pool.find((v) => v.localService)
    ?? pool[0]
    ?? null;
}

function speak(word, accent = 'uk', lang) {
  const voices = LANG.pick(lang, word).voices;
  // reviewPrefs.accent is ONE string across every language, so a profile that
  // picked US in English arrives here with 'us' on a Korean word. Falling back
  // to the pack's first voice is what makes that an accent that does not apply
  // rather than utterance.lang = undefined.
  const voice = voices.find((v) => v.id === accent) ?? voices[0];
  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = voice.bcp47;
  // Named explicitly rather than left to Chrome — see bestVoice above. Null
  // is a legal value and means "you choose", which is where this started.
  utterance.voice = bestVoice(voice.bcp47, speechSynthesis.getVoices());
  // ponytail: says nothing at all when the OS has no voice for this tag —
  // Chrome neither throws nor fires an error, it just stays silent, and a Mac
  // ships no Korean voice until one is downloaded. getVoices() is the check,
  // but it fills asynchronously (voiceschanged) and this seam owns no surface
  // to warn on. The warning belongs to a caller that has one.
  speechSynthesis.speak(utterance);
}
