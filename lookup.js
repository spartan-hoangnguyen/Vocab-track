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

// The gloss comes from a chain of keyless sources, asked in order, and the
// first one with a translation wins (glossFor below). Each source is a URL
// builder, pure so a test can pin it without the network, and a fetcher.
//
// A fetcher returns a gloss, or null when the source answered and had nothing,
// which is a real answer about the word. It throws when the source could not
// be asked, which is a fact about the network. They are not the same and must
// not look the same.

// Unofficial, keyless endpoint (dict-chrome-ex client). Acceptable for a
// personal tool; it will break one day, which is why it is not alone.
//
// `sl` is the study language, not always English: the same endpoint answers
// for Korean unchanged (verified: sl=ko&tl=vi on 책 returns "sách").
// The pack names the code the endpoint wants (zh → zh-CN), not its id.
function googleUrl(word, lang = 'en') {
  const sl = LANG.get(lang)?.mt ?? lang;
  return 'https://translate.googleapis.com/translate_a/single'
    + `?client=dict-chrome-ex&sl=${encodeURIComponent(sl)}&tl=vi`
    + `&dt=t&q=${encodeURIComponent(word)}`;
}

async function fetchGoogle(word, lang = 'en') {
  // A timeout on every source, so one that hangs cannot keep the next one
  // from being asked.
  const res = await fetch(googleUrl(word, lang), { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data?.[0]?.[0]?.[0] ?? null;
}

// MyMemory: free and keyless, and it answers en→vi, ko→vi and zh-CN→vi with
// the same language codes Google takes.
function myMemoryUrl(word, lang = 'en') {
  const sl = LANG.get(lang)?.mt ?? lang;
  const params = new URLSearchParams({ q: String(word ?? ''), langpair: `${sl}|vi` });
  return `https://api.mymemory.translated.net/get?${params}`;
}

async function fetchMyMemory(word, lang = 'en') {
  const res = await fetch(myMemoryUrl(word, lang), { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  // MyMemory reports a used-up daily quota inside a 200: the real status is in
  // the body, and translatedText holds a "MYMEMORY WARNING" sentence that must
  // never be saved as a gloss. Thrown as an HTTP status, so a 429 in the body
  // pauses this source exactly like a 429 on the wire.
  const status = Number(data?.responseStatus ?? 200);
  if (data?.quotaFinished === true || status !== 200) {
    throw new Error(`HTTP ${status === 200 ? 429 : data?.responseStatus}`);
  }
  const vi = String(data?.responseData?.translatedText ?? '').trim();
  // The word handed back unchanged is MyMemory having nothing, not a gloss.
  if (!vi || vi.toLowerCase() === String(word).toLowerCase()) return null;
  return vi;
}

// 429 is a source saying one IP has asked too much, and it keeps saying it
// for a while. Asking again on every lookup during that window is useless AND
// part of the problem, so the first 429 stops the asking — of that source
// only, so a rate-limited Google still leaves MyMemory to answer.
//
// An object rather than bare `let`s so a test can put it back; module scope
// rather than storage because a panel reload clears it, which is the right
// failure mode — a stale pause cannot outlive the real limit by much, and
// nothing has to be migrated. `ask` looks the fetcher up at call time, so a
// test can replace one by name.
//
// ponytail: a flat ten minutes, because neither response carries a
// Retry-After header to read. Read one if it ever appears.
const GLOSS = {
  PAUSE_MS: 10 * 60 * 1000,
  sources: [
    { id: 'google', name: 'Google Translate', pausedUntil: 0,
      ask: (word, lang) => fetchGoogle(word, lang) },
    { id: 'mymemory', name: 'MyMemory', pausedUntil: 0,
      ask: (word, lang) => fetchMyMemory(word, lang) }
  ]
};

// The name a card shows for a stored `viSource`, or null for an id no source
// has (an entry saved before sources were recorded has none at all).
function glossSourceName(id) {
  return GLOSS.sources.find((src) => src.id === id)?.name ?? null;
}

function rateLimited(src) {
  const mins = Math.max(1, Math.ceil((src.pausedUntil - Date.now()) / 60000));
  return `${src.name} is rate-limiting this network — try again in about `
    + `${mins} minute${mins === 1 ? '' : 's'}`;
}

// The reason a gloss is missing, kept rather than swallowed. Both were a bare
// `—` on the card before, so a rate-limited minute and a word the endpoint
// genuinely cannot translate were indistinguishable on screen — which is what
// made this take three rounds to pin down.
//
// Returns { vi, source, failed }: `source` is the id of the source that
// answered, null when none gave a gloss. `failed` is set only when EVERY
// source failed, and names each one with its reason; a source that answered
// with nothing is a real answer, so it leaves `failed` null.
async function glossFor(word, lang) {
  const reasons = [];
  let answered = false;
  for (const src of GLOSS.sources) {
    // Checked here, per source, not once before the loop: a pause that stopped
    // the whole chain would make the fallback unreachable for exactly the ten
    // minutes it exists for.
    if (Date.now() < src.pausedUntil) {
      reasons.push(rateLimited(src));
      continue;
    }
    try {
      const vi = await src.ask(word, lang);
      if (vi) return { vi, source: src.id, failed: null };
      answered = true;
    } catch (err) {
      console.error(`[vocab-track] ${src.name} translation failed for`, word, err);
      if (/\b429\b/.test(String(err.message))) {
        src.pausedUntil = Date.now() + GLOSS.PAUSE_MS;
        reasons.push(rateLimited(src));
      } else {
        const why = err.name === 'Error' ? err.message : `${err.name}: ${err.message}`;
        reasons.push(`${src.name}: ${why}`);
      }
    }
  }
  return { vi: null, source: null, failed: answered ? null : `${reasons.join('; ')}.` };
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
    let glossFailed = null;
    if (!known.vi) {
      const gloss = await glossFor(word, pack.id);
      glossFailed = gloss.failed;
      if (gloss.vi) {
        known.vi = gloss.vi;
        known.viSource = gloss.source;
        patch.vi = gloss.vi;
        patch.viSource = gloss.source;
      }
    }
    if (Object.keys(patch).length) await putWord(word, patch);
    return { entry: known, failed: { dict: null, gloss: glossFailed } };
  }

  const [parsed, gloss] = await Promise.all([
    fetchEntry(word, pack.id),
    glossFor(word, pack.id)
  ]);
  // A dictionary 404 is NOT proof the word is not a word. The Free Dictionary
  // API (English now) and krdict both lack entries for words that plainly
  // exist — "france" 404s on the Free Dictionary — so aborting the save on a
  // not-found would lose real words the reader met. A not-found therefore ends
  // the save ONLY when there is also no gloss to fall back on: a real word the
  // dictionary missed still carries a Vietnamese translation, and that plus the
  // sentence is worth keeping. A true non-word (a typo) misses both, and that
  // alone reaches the panel's "Nothing saved."
  if (parsed.notFound && !gloss.vi) return { notFound: true };
  // When the dictionary had no entry but the gloss saved it, there is no parsed
  // data to carry: build the entry on the four nulls a keyless Korean word
  // already uses, so the card shows the gloss and blank dictionary fields.
  const parsedEntry = parsed.notFound
    ? { level: null, ipa: null, def: null, audio: null }
    : parsed;

  const entry = VT.newEntry(word, parsedEntry, gloss.vi, url, pack.id, gloss.source);
  if (context) entry.context = context;
  // Not persisted: it describes this attempt, not the word. Two channels
  // because the two failures want different sentences — a missing definition
  // and a missing gloss are different losses, and for Korean only the second
  // one is a loss at all. A clean not-found carries no dict warning: the word
  // was simply absent, which is not a call that failed.
  const failed = { dict: parsed.notFound ? null : (parsed.failed ?? null), gloss: gloss.failed };
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
    return true;
  }
  // The only caller that holds an entry, so the only place the word's language
  // can still be recovered. Without these two arguments every synthesised word
  // on every surface is English.
  return speak(entry.word, accent, entry.lang);
}

// What a caller with a surface shows when pronounce() answers false.
function voiceHint(pack) {
  return `No ${pack.name} voice is installed. Add one in System Settings → `
    + 'Accessibility → Spoken Content → System Voice → Manage Voices.';
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
//
// `exact` asks for the whole tag (zh-CN), for a pack whose regions are
// different languages: a zh-HK voice speaks Cantonese.
function bestVoice(tag, voices, exact = false) {
  const norm = (t) => String(t ?? '').toLowerCase().replace(/_/g, '-');
  const want = exact ? norm(tag) : norm(tag).split('-')[0];
  if (!want) return null;
  const matching = (voices ?? [])
    .filter((v) => (exact ? norm(v.lang) : norm(v.lang).split('-')[0]) === want);
  const serious = matching.filter((v) => !NOVELTY.test(v.name ?? ''));
  const any = serious.length ? serious : matching;
  // The asked-for region first when the machine has it: the language matches
  // on its primary subtag above, so without this a UK word was read by
  // Samantha, the en-US system default, while Daniel (en-GB) sat unused.
  const regional = any.filter((v) => norm(v.lang) === norm(tag));
  const pool = regional.length ? regional : any;
  return pool.find((v) => /premium|enhanced|siri/i.test(v.name ?? ''))
    ?? pool.find((v) => v.default)
    ?? pool.find((v) => v.localService)
    ?? pool[0]
    ?? null;
}

// Chrome loads the voice list only when something first asks for it, and fills
// it in two steps: its Google network voices first, the system's own voices
// (Tingting, Yuna, Samantha…) after. Asked for here, on page load, so the list
// is whole by the time anyone presses ▶. Without this the FIRST press found
// only network voices and spoke with one — a different, often robotic-sounding
// voice from every press after it.
globalThis.speechSynthesis?.getVoices();

function speak(word, accent = 'uk', lang) {
  const voices = LANG.pick(lang, word).voices;
  // reviewPrefs.accent is ONE string across every language, so a profile that
  // picked US in English arrives here with 'us' on a Korean word. Falling back
  // to the pack's first voice is what makes that an accent that does not apply
  // rather than utterance.lang = undefined.
  const voice = voices.find((v) => v.id === accent) ?? voices[0];
  const list = speechSynthesis.getVoices();
  // Named explicitly rather than left to Chrome — see bestVoice above. Null
  // is a legal value and means "you choose", which is where this started.
  const chosen = bestVoice(voice.bcp47, list, voice.exact);
  // The OS has voices and none of them speaks this language: Chrome would
  // stay silent (or, for zh, reach for Cantonese), so say nothing and answer
  // false — the caller owns the surface to show voiceHint() on. An EMPTY list
  // is not that: it fills asynchronously (voiceschanged), and headless Chrome
  // never has one, so it speaks and lets Chrome choose, as before.
  if (list.length && !chosen) return false;
  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = voice.bcp47;
  utterance.voice = chosen;
  speechSynthesis.speak(utterance);
  return true;
}
