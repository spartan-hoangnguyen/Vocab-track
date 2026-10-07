// The language registry. One pack per language, each in lang/<id>/.
//
// Same shape as PRACTICE in practice.js, and for the same reason: there is no
// build step here, so a "module" is a plain script that registers itself into
// a global. Load order is the dependency graph — lib.js, then this, then each
// lang/<id>/index.js.
//
// A pack splits in two, mirroring the split the rest of the repo already has:
//
//   index.js       pure logic. No network, no Chrome API, no DOMParser, so it
//                  is safe in a content script and callable from test.html.
//   dictionary.js  the lookup. Needs DOMParser and the MV3 CORS bypass, so it
//                  loads everywhere EXCEPT the content script.
//
// register() and dictionary() are separate calls so index.js stands alone.
const LANG = (() => {
  const packs = new Map();
  const dicts = new Map();
  const FALLBACK = 'en';

  function register(id, pack) {
    packs.set(id, {
      id,
      // The identity lemma is the common case: a language whose written form
      // is its dictionary form needs no stripping, and saying so here keeps
      // every pack from having to write `lemma: (w) => w`.
      lemma: (word) => word,
      normalise: (raw) => VT.normaliseWord(raw),
      // One voice, labelled with the language's own name. Same reasoning as the
      // identity lemma above: a language with a single voice writes nothing, and
      // the review controls hide a picker that has only one option. The BCP-47
      // tag defaults to the id because the two agree for a bare language subtag
      // — a pack whose region is load-bearing (ko-KR) names it itself.
      voices: [{ id: 'std', label: pack.native ?? id, bcp47: id }],
      // The source language the MT gloss is asked in. The id, unless the
      // endpoint wants something more specific (zh → zh-CN).
      mt: id,
      // How the pronunciation field (`ipa`) is labelled. Null is IPA, which
      // shows bare between slashes; a romanisation names itself (zh: Pinyin).
      pronLabel: null,
      // The written forms that still count as this word when it is looked for
      // in a sentence — practice-speak's grading. English has real morphology to
      // add (lang/en/index.js); for a language that does not inflect the word it
      // is looking for, the word is the word.
      inflections: (word) => [word],
      ...pack
    });
  }

  function dictionary(id, dict) {
    dicts.set(id, dict);
  }

  function get(id) {
    return packs.get(id) ?? null;
  }

  function dict(id) {
    return dicts.get(id) ?? null;
  }

  // Registration order, which is the order the HTML loads them in.
  function list() {
    return [...packs.values()];
  }

  // Which language a piece of text is written in, by script. Deliberately
  // crude: a selection is one word, and the scripts in play do not overlap.
  // Null rather than a guess when nothing matches, so pick() can fall back
  // explicitly rather than silently calling it English.
  function detect(text) {
    const str = String(text ?? '');
    if (!str) return null;
    for (const pack of packs.values()) {
      if (pack.script?.test(str)) return pack;
    }
    return null;
  }

  // The pack to use for a word: what it was saved as, else what it looks like,
  // else English. The middle step is what makes `lang` optional — every word
  // already in storage predates the field and still routes correctly, so
  // adding it needs no migration.
  function pick(id, word) {
    return get(id) ?? detect(word) ?? get(FALLBACK);
  }

  function of(entry) {
    return pick(entry?.lang, entry?.word);
  }

  return { register, dictionary, get, dict, list, detect, pick, of, FALLBACK };
})();
