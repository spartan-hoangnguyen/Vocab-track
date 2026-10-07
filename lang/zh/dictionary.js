// Chinese. The lookup half: CC-CEDICT, bundled in data/zh/ (T006/T007).
//
// A stub until the trimmed CEDICT lands, registered anyway for the reason
// lang/ko/dictionary.js gives: without a dictionary, lookup.js reports
// `failed: no dictionary registered for zh`, the panel shows a lookup-failed
// warning on every Chinese word, and the "full entry ↗" link disappears.
//
// Not loaded into the content script, like every dictionary.js.
(() => {
  const MDBG = 'https://www.mdbg.net';
  const level = (word) => (typeof hskLevel === 'function' ? hskLevel(word) : null);

  LANG.dictionary('zh', {
    name: 'CC-CEDICT',
    base: MDBG,
    // MDBG is CC-CEDICT's own home, so the full entry is the same data the
    // card shows, plus stroke order and examples.
    href: (word) => `${MDBG}/chinese/dictionary?wdqb=${encodeURIComponent(word)}`,

    // The HSK 2.0 level from lang/zh/hsk.js, loaded beside this file. Guarded
    // like en's cefrLevel, so a page without the list degrades to no level.
    level,

    // No `failed`, no `notFound`, for the reasons lang/ko/dictionary.js spells
    // out: the MT gloss is the meaning until CEDICT is wired in, and notFound
    // would abort the save.
    async lookup(word) {
      return { level: level(word), ipa: null, def: null, audio: null };
    }
  });
})();
