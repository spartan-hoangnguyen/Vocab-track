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
    const headword = String(first.word ?? '').toLowerCase();
    const synonyms = [...new Set((syns ?? []).map((s) => s?.word).filter(Boolean))]
      .filter((word) => word.toLowerCase() !== headword)
      .slice(0, VT.MAX_XREF);

    return {
      pos: POS[abbrev] ?? (abbrev || null),
      // No grammar label, no antonyms, no "related" category in this source.
      // Kept as the fields newEntry reads, so the UI's optional rows stay hidden.
      gram: null,
      ipa: null, ipaUs: null,
      audio: null, audioUs: null,
      level: null,
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
    const defsUrl = `${DATAMUSE}?sp=${encodeURIComponent(word)}&md=dp&max=1`;
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
    parse
  });
})();
