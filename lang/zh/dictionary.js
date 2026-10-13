// Chinese. The lookup half: CC-CEDICT, bundled as data/zh/cedict.json
// (tools/zh/build-cedict.py), and the HSK level from lang/zh/hsk.js.
//
// No network: the dictionary ships with the extension, so a lookup is a read
// of a file the extension already has. The file is fetched once, on the first
// Chinese lookup, and kept for the life of the page — it is 8 MB, so nothing
// loads it until a Chinese word is asked for.
//
// Not loaded into the content script, like every dictionary.js.
(() => {
  const MDBG = 'https://www.mdbg.net';
  const level = (word) => (typeof hskLevel === 'function' ? hskLevel(word) : null);
  // Resolved against this script rather than chrome.runtime.getURL, so the
  // same line works in the extension (chrome-extension://…/data/zh/…) and on
  // the test page, which has no `chrome`.
  const CEDICT = new URL('../../data/zh/cedict.json', document.currentScript.src).href;

  LANG.dictionary('zh', {
    name: 'CC-CEDICT',
    base: MDBG,
    // MDBG is CC-CEDICT's own home, so the full entry is the same data the
    // card shows, plus stroke order and examples.
    href: (word) => `${MDBG}/chinese/dictionary?wdqb=${encodeURIComponent(word)}`,

    // The HSK 2.0 level from lang/zh/hsk.js, loaded beside this file. Guarded
    // like en's cefrLevel, so a page without the list degrades to no level.
    level,

    // Where the table comes from, and the one load of it. Properties rather
    // than closure state so test.js can point it at a small fixture.
    url: CEDICT,
    table: null,

    // { word: [[pinyin, [sense, …]], …] }, one pair per reading.
    async load() {
      this.table ??= fetch(this.url).then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      });
      try {
        return await this.table;
      } catch (err) {
        // Not cached: the next lookup tries again.
        this.table = null;
        throw err;
      }
    },

    // A word CEDICT does not have is the four nulls, not `notFound`: the MT
    // gloss still carries it, and notFound would abort the save
    // (lookup.js resolveWord). A file that would not load is `failed`, which
    // is a real failure and the panel says so.
    async lookup(word) {
      let readings;
      try {
        readings = (await this.load())?.[word];
      } catch (err) {
        console.error('[vocab-track] CC-CEDICT did not load', err);
        return { level: level(word), ipa: null, def: null, audio: null,
                 failed: `CC-CEDICT did not load (${err.message})` };
      }
      if (!Array.isArray(readings) || !readings.length) {
        return { level: level(word), ipa: null, def: null, audio: null };
      }

      // Every reading's pinyin, and the senses interleaved by reading so the
      // cap does not spend all its room on the first one: 行 is háng first in
      // CEDICT, but xíng is the reading a learner meets first. With more than
      // one reading, each sense names the one it belongs to.
      const many = readings.length > 1;
      const senses = [];
      for (let i = 0; senses.length < VT.MAX_SENSES; i++) {
        const round = readings.filter(([, defs]) => defs[i]);
        if (!round.length) break;
        for (const [py, defs] of round) {
          if (senses.length === VT.MAX_SENSES) break;
          senses.push({ level: null, def: many ? `(${py}) ${defs[i]}` : defs[i], example: null });
        }
      }
      return {
        level: level(word),
        ipa: readings.map(([py]) => py).join(' / '),
        def: senses[0]?.def ?? null,
        audio: null,
        senses
      };
    }
  });
})();
