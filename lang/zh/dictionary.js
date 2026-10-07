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

  LANG.dictionary('zh', {
    name: 'CC-CEDICT',
    base: MDBG,
    // MDBG is CC-CEDICT's own home, so the full entry is the same data the
    // card shows, plus stroke order and examples.
    href: (word) => `${MDBG}/chinese/dictionary?wdqb=${encodeURIComponent(word)}`,

    // The four nulls and nothing else — no `failed`, no `notFound`, for the
    // reasons lang/ko/dictionary.js spells out: the MT gloss is the meaning
    // until CEDICT is wired in, and notFound would abort the save.
    async lookup() {
      return { level: null, ipa: null, def: null, audio: null };
    }
  });
})();
