// English. The lookup half: Cambridge.
//
// Not loaded into the content script. It needs DOMParser to read the page it
// fetches, and the MV3 CORS bypass to fetch it at all — which is the side
// panel, the dashboard, and test/test.html, where the parser runs against
// saved fixtures.
(() => {
  const CAMBRIDGE = 'https://dictionary.cambridge.org';

  // Selectors verified against real Cambridge pages on 2026-09-13.
  // Each field is independent: a markup change that breaks one selector
  // yields null for that field and leaves the others intact.
  //
  // Scoped to the first `.entry-body__el` (the actual dictionary entry),
  // not the whole document: an off-entry page (e.g. the dictionary index a
  // not-found lookup redirects to) carries a Word-of-the-Day promo block
  // with its own `.ipa` and `source[src$=".mp3"]`, which would otherwise be
  // picked up as if they belonged to the looked-up word.
  //
  // level/ipa/def/audio stay top level and describe the FIRST sense, so
  // entries saved before senses existed keep rendering unchanged.
  function parse(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const root = doc.querySelector('.entry-body__el');
    if (!root) return { level: null, ipa: null, def: null, audio: null };

    const text = (el, sel) => el?.querySelector(sel)?.textContent.trim() || null;
    const audioIn = (el) => {
      const src = el?.querySelector('source[src$=".mp3"]')?.getAttribute('src');
      return src ? CAMBRIDGE + src : null;
    };
    const uk = root.querySelector('.uk.dpron-i');
    const us = root.querySelector('.us.dpron-i');

    // Capped deliberately: every sense and example is stored per word, and
    // chrome.storage.local is ~10MB. Three senses with one example each keeps
    // an entry near 1KB, so the quota still holds roughly 10,000 words.
    const senses = [...root.querySelectorAll('.def-block.ddef_block')]
      .slice(0, VT.MAX_SENSES)
      .map((block) => ({
        level: text(block, '.epp-xref'),
        def: text(block, '.def.ddef_d'),
        example: text(block, '.examp.dexamp')
      }))
      .filter((sense) => sense.def);

    // The headword, so it can be filtered out of its own synonym list —
    // Cambridge's thesaurus block lists the word itself first.
    const headword = text(root, '.hw.dhw')?.toLowerCase() ?? null;

    const collect = (sel) => [...root.querySelectorAll(sel)]
      .map((el) => el.textContent.trim())
      .filter(Boolean);

    const clean = (items) => [...new Set(items)]
      .filter((item) => item.toLowerCase() !== headword)
      .slice(0, VT.MAX_XREF);

    // Two sources, because either alone is thin. `.xref.synonym` is a curated
    // cross-reference that most entries lack; the `.daccord` thesaurus block
    // is richer but absent on others. Measured over eight words: xref alone
    // covered three, the thesaurus block six, the two together seven.
    const synonyms = clean([
      ...collect('.xref.synonym .x-h'),
      ...collect('.daccord li.had.t-i > a')
    ]);

    return {
      pos: text(root, '.pos.dpos'),
      gram: text(root, '.gram.dgram'),
      ipa: text(uk, '.ipa') ?? text(root, '.ipa'),
      ipaUs: text(us, '.ipa'),
      audio: audioIn(uk) ?? audioIn(root),
      audioUs: audioIn(us),
      level: senses[0]?.level ?? text(root, '.epp-xref'),
      def: senses[0]?.def ?? text(root, '.def.ddef_d'),
      senses,
      synonyms,
      related: clean(collect('.xref.related_word .x-h')),
      opposites: clean(collect('.xref.opposite .x-h'))
    };
  }

  async function lookup(word) {
    try {
      // credentials:'omit' is load-bearing, not tidiness. Chrome attaches the
      // user's dictionary.cambridge.org cookies to this cross-origin fetch, and
      // that request shape — cors mode, sec-fetch-site: none, carrying cookies —
      // trips Cambridge's bot protection, which answers 403. The identical
      // request without cookies returns 200. Verified in the panel console
      // 2026-09-13: with cookies 403, with credentials:'omit' 200.
      const res = await fetch(`${CAMBRIDGE}/dictionary/english/${encodeURIComponent(word)}`,
                              { credentials: 'omit' });
      // Cambridge never 404s an unknown word: it 302-redirects to the
      // dictionary index, which fetch follows, so res.ok is true and
      // res.status is useless here. res.redirected is ALSO not a valid test —
      // a known word like "cats" legitimately 302s to a real entry
      // (.../dictionary/english/cat). The only reliable signal is where the
      // redirect actually landed: only the bare index path means not-found.
      if (new URL(res.url).pathname === '/dictionary/english/') return { notFound: true };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parse(await res.text());
    } catch (err) {
      // Degrade, never abort: the word is still worth saving with a translation.
      console.error('[vocab-track] cambridge lookup failed for', word, err);
      // `failed` distinguishes "the dictionary call did not happen" from "the
      // entry has no CEFR level", which are otherwise the same four nulls and
      // read identically in the UI.
      return { level: null, ipa: null, def: null, audio: null, failed: String(err) };
    }
  }

  LANG.dictionary('en', {
    name: 'Cambridge',
    base: CAMBRIDGE,
    href: (word) => `${CAMBRIDGE}/dictionary/english/${encodeURIComponent(word)}`,
    lookup,
    parse
  });
})();
