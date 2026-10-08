// English. The lookup half: the Datamuse API (api.datamuse.com).
//
// This is the second source this file has worn. Cambridge put its pages behind
// a bot wall that a background fetch cannot pass (every lookup 403'd). The Free
// Dictionary API replaced it, but it is hosted on small infrastructure and was
// slow or unreachable from some networks — a 10s timeout on every lookup and a
// retry on top, which is worse. Datamuse runs on robust infrastructure, answers
// in about 100ms, is keyless, and returns clean plain-text definitions and a
// part of speech, plus synonyms from a second endpoint.
//
// What it does NOT carry: a CEFR level (no free source does, so `level` is null
// now, exactly as it is for Korean), IPA, or a recorded pronunciation. The play
// button falls through to the system voice for English, the way it already does
// for a word saved before audio was parsed, and the "↗" link opens the full
// Wiktionary entry, which has the IPA and the recording for anyone who wants it.
//
// Parsing is JSON, so there is no DOMParser here. It is still kept out of the
// content script — fetchEntry runs in the side panel and the dashboard — because
// that is where resolveWord lives.
(() => {
  const DATAMUSE = 'https://api.datamuse.com/words';

  // Datamuse tags a definition with an abbreviated part of speech; the card
  // shows the long form the Cambridge pack used to.
  const POS = { n: 'noun', v: 'verb', adj: 'adjective', adv: 'adverb', u: null };

  // A coarse CEFR band from a word's frequency per million (Datamuse md=f), for
  // the words the curated list does not carry. Calibrated against known-level
  // words on 2026-10-09: within about one band of the real CEFR, so it is an
  // ESTIMATE the UI marks as one, not a claim of a true CEFR level. Thresholds
  // in frequency per million, most frequent first.
  function freqToLevel(freq) {
    if (!(freq > 0)) return null;
    if (freq >= 100) return 'A1';
    if (freq >= 30) return 'A2';
    if (freq >= 10) return 'B1';
    if (freq >= 4) return 'B2';
    if (freq >= 1.5) return 'C1';
    return 'C2';
  }

  // ARPAbet (the CMU Pronouncing Dictionary alphabet Datamuse returns under
  // md=r) to IPA. The lookup carries no IPA of its own, so this rebuilds the
  // pronunciation the card used to show from the phoneme string. US pronunciation
  // (CMUdict is American) and an approximation, which is what a learner needs to
  // read rather than a narrow transcription. `r` not `ɹ`, to match the delimiters
  // and style a dictionary uses.
  const ARPA = {
    AA: 'ɑ', AE: 'æ', AH: 'ʌ', AO: 'ɔ', AW: 'aʊ', AY: 'aɪ', B: 'b', CH: 'tʃ',
    D: 'd', DH: 'ð', EH: 'ɛ', ER: 'ɝ', EY: 'eɪ', F: 'f', G: 'ɡ', HH: 'h',
    IH: 'ɪ', IY: 'i', JH: 'dʒ', K: 'k', L: 'l', M: 'm', N: 'n', NG: 'ŋ',
    OW: 'oʊ', OY: 'ɔɪ', P: 'p', R: 'r', S: 's', SH: 'ʃ', T: 't', TH: 'θ',
    UH: 'ʊ', UW: 'u', V: 'v', W: 'w', Y: 'j', Z: 'z', ZH: 'ʒ'
  };
  // The phonemes a stress digit can sit on. A stressed syllable's mark belongs
  // before its ONSET (the consonants after the previous vowel), not before the
  // vowel itself, so `happy` reads ˈhæpi and not hˈæpi.
  const ARPA_VOWELS = new Set(['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER',
    'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW']);

  function arpaToIpa(pron) {
    const phones = String(pron ?? '').trim().split(/\s+/).filter(Boolean)
      .map((phone) => {
        const m = /^([A-Z]+)([0-2]?)$/.exec(phone);
        if (!m) return null;
        const base = m[1];
        const stress = m[2];
        // The only stress-driven reductions worth making: an unstressed AH is a
        // schwa, and ER is r-coloured either way.
        let sym;
        if (base === 'AH' && stress === '0') sym = 'ə';
        else if (base === 'ER') sym = stress === '0' ? 'ɚ' : 'ɝ';
        else sym = ARPA[base];
        if (sym === undefined) return null;
        return { sym, vowel: ARPA_VOWELS.has(base), stress };
      })
      .filter(Boolean);
    if (!phones.length) return null;

    const marks = new Array(phones.length).fill('');
    for (let i = 0; i < phones.length; i++) {
      if (!phones[i].vowel || (phones[i].stress !== '1' && phones[i].stress !== '2')) continue;
      let onset = i;
      while (onset > 0 && !phones[onset - 1].vowel) onset--;
      marks[onset] += phones[i].stress === '1' ? 'ˈ' : 'ˌ';
    }
    return phones.map((p, i) => marks[i] + p.sym).join('') || null;
  }

  // Build the entry shape from Datamuse's first match and its synonym list.
  // Pure, so test.js drives it from saved JSON fixtures.
  //
  // `first` is one Datamuse word object: { word, score, tags, defs }, where each
  // def is "pos\tdefinition text", e.g. "adj\tReturning quickly to normal…". A
  // non-array `defs` (or no `first`) yields the four-null shape — NOT notFound —
  // so an odd response degrades to "saved with a gloss" rather than aborting the
  // save (lookup.js:135). A real not-found is decided in lookup() below.
  function parse(first, syns) {
    if (!first || !Array.isArray(first.defs)) {
      return { level: null, ipa: null, def: null, audio: null };
    }

    const textOf = (raw) => {
      const str = String(raw ?? '');
      const tab = str.indexOf('\t');
      return (tab >= 0 ? str.slice(tab + 1) : str).trim();
    };
    const posOf = (raw) => {
      const str = String(raw ?? '');
      const tab = str.indexOf('\t');
      return tab >= 0 ? str.slice(0, tab) : '';
    };

    // Capped like the Cambridge parser was: an entry is stored whole against a
    // ~10MB quota. Datamuse carries no examples, so a sense is a level and a def.
    const senses = first.defs
      .slice(0, VT.MAX_SENSES)
      .map((raw) => ({ level: null, def: textOf(raw), example: null }))
      .filter((sense) => sense.def);

    const abbrev = posOf(first.defs[0]) || (first.tags ?? [])[0] || '';
    // The pronunciation rides in the tags as "pron:<ARPAbet>" when the lookup
    // asks for md=r. Rebuilt into IPA so the card's pronunciation line, empty
    // since the move off Cambridge, reads again.
    const pron = (first.tags ?? []).find((tag) => tag.startsWith('pron:'));
    // The level: the curated list first, else an estimate from frequency for a
    // word the list does not have. levelEst marks the estimate so the UI can
    // show it as approximate.
    const exactLevel = typeof cefrLevel === 'function' ? cefrLevel(first.word) : null;
    const freqTag = (first.tags ?? []).find((tag) => tag.startsWith('f:'));
    const level = exactLevel ?? freqToLevel(freqTag ? parseFloat(freqTag.slice(2)) : NaN);
    const headword = String(first.word ?? '').toLowerCase();
    const synonyms = [...new Set((syns ?? []).map((s) => s?.word).filter(Boolean))]
      .filter((word) => word.toLowerCase() !== headword)
      .slice(0, VT.MAX_XREF);

    return {
      pos: POS[abbrev] ?? (abbrev || null),
      // No grammar label, no antonyms, no "related" category in this source.
      // Kept as the fields newEntry reads, so the UI's optional rows stay hidden.
      gram: null,
      ipa: pron ? arpaToIpa(pron.slice(5)) : null,
      ipaUs: null,
      audio: null, audioUs: null,
      // The curated level (lang/en/cefr.js), or the frequency estimate above.
      level,
      // True when the level is the estimate, so the UI can mark it approximate.
      levelEst: !exactLevel && level != null,
      def: senses[0]?.def ?? null,
      senses,
      synonyms,
      related: [],
      opposites: []
    };
  }

  async function lookup(word) {
    // `sp` is "spelled-like": the exact word comes back first when it exists,
    // with its definitions attached by md=d (p adds the part of speech). The
    // synonyms are a second, independent endpoint, run in parallel so the two
    // do not add up. A short timeout and NO retry: Datamuse answers in ~100ms,
    // so a request that is still open at 7s is a dead network, and retrying it
    // only doubles the wait before the word saves with its gloss anyway.
    const defsUrl = `${DATAMUSE}?sp=${encodeURIComponent(word)}&md=dprf&max=1`;
    const synUrl = `${DATAMUSE}?rel_syn=${encodeURIComponent(word)}&max=${VT.MAX_XREF}`;
    try {
      const [defsRes, synRes] = await Promise.all([
        fetch(defsUrl, { signal: AbortSignal.timeout(7000) }),
        fetch(synUrl, { signal: AbortSignal.timeout(7000) })
      ]);
      if (!defsRes.ok) throw new Error(`HTTP ${defsRes.status}`);
      const defs = await defsRes.json();
      const first = defs?.[0];
      // `sp` is fuzzy: a non-word comes back as [] or as a near-miss whose
      // `word` is something else. Only an exact match that actually carries
      // definitions is a hit; anything else is a not-found, which lets
      // resolveWord fall back to the gloss (lookup.js:135).
      if (!first || first.word?.toLowerCase() !== word.toLowerCase() || !first.defs?.length) {
        return { notFound: true };
      }
      // Synonyms are a bonus: a failure there must never sink the definition.
      const syns = synRes.ok ? await synRes.json().catch(() => []) : [];
      return parse(first, syns);
    } catch (err) {
      // Degrade, never abort: the word is still worth saving with its gloss.
      console.error('[vocab-track] datamuse lookup failed for', word, err);
      // `failed` distinguishes "the dictionary call did not happen" from "the
      // entry has no level", which are otherwise the same four nulls.
      return { level: null, ipa: null, def: null, audio: null, failed: String(err) };
    }
  }

  LANG.dictionary('en', {
    // The human-facing name, used for the "↗" link and the "… lookup failed"
    // warning. Wiktionary, because that is where the link goes — the full entry
    // there carries the IPA and the recording this API does not.
    name: 'Wiktionary',
    base: 'https://api.datamuse.com',
    href: (word) => `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`,
    lookup,
    parse,
    // Exposed for the test; the pack has no other reason to reach them.
    arpaToIpa,
    freqToLevel
  });
})();
