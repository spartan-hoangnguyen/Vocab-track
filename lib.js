// Pure logic shared by the content script, the side panel and the test page.
// No Chrome API and no network here: everything in this file must be callable
// from test/test.html in a plain browser tab.
const VT = {
  CAMBRIDGE: 'https://dictionary.cambridge.org',

  // Storage caps. Entries are stored whole, and chrome.storage.local is
  // about 10MB, so these bound how much one word can cost.
  MAX_SENSES: 3,
  MAX_XREF: 6,
  MAX_CONTEXT: 220,

  normaliseWord(raw) {
    return String(raw ?? '').trim().toLowerCase();
  },

  // A selection worth offering a lookup for: one word, letters and inner
  // hyphens only, 2 to 40 characters. Deliberately rejects digits and
  // punctuation so the button does not appear on code, prices or dates.
  isLookupCandidate(raw) {
    const word = VT.normaliseWord(raw);
    return /^[a-z]+(-[a-z]+)*$/.test(word) && word.length >= 2 && word.length <= 40;
  },

  // Word-bounded and case-insensitive, so "cat" never lights up inside
  // "category". Exact match only: "resilient" does not match "resilience".
  // Stemming is deliberately out of scope.
  wordRegex(word) {
    const safe = word.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
    return new RegExp(`\\b${safe}\\b`, 'gi');
  },

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
  parseCambridge(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const root = doc.querySelector('.entry-body__el');
    if (!root) return { level: null, ipa: null, def: null, audio: null };

    const text = (el, sel) => el?.querySelector(sel)?.textContent.trim() || null;
    const audioIn = (el) => {
      const src = el?.querySelector('source[src$=".mp3"]')?.getAttribute('src');
      return src ? VT.CAMBRIDGE + src : null;
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

    const xref = (kind) => {
      const items = [...root.querySelectorAll(`.xref.${kind} .x-h`)]
        .map((el) => el.textContent.trim())
        .filter(Boolean);
      return [...new Set(items)].slice(0, VT.MAX_XREF);
    };

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
      synonyms: xref('synonym'),
      related: xref('related_word')
    };
  },

  // The sentence in the page that the looked-up word appeared in, so a saved
  // word keeps the context that made it worth saving. Pure: the content
  // script hands in the surrounding block's text.
  sentenceAround(blockText, word) {
    const text = String(blockText ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    const re = VT.wordRegex(word);
    // Split after . ! ? followed by a space — deliberately naive. It can cut
    // an abbreviation ("Dr. Smith") in two; a wrong sentence boundary costs a
    // slightly odd quote, which is not worth a parser to avoid.
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      re.lastIndex = 0;
      if (re.test(sentence)) {
        const trimmed = sentence.trim();
        return trimmed.length > VT.MAX_CONTEXT
          ? trimmed.slice(0, VT.MAX_CONTEXT).trimEnd() + '…'
          : trimmed;
      }
    }
    return null;
  },

  // SM-2, standard formulation. quality is 0..5; below 3 is a lapse.
  // The 1.3 ease floor is part of the algorithm.
  sm2(card, quality) {
    let { ease, interval, reps } = card;
    if (quality < 3) {
      reps = 0;
      interval = 1;
    } else {
      reps += 1;
      interval = reps === 1 ? 1 : reps === 2 ? 6 : Math.round(interval * ease);
    }
    ease = Math.max(1.3, ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
    // Rounded to avoid float drift accumulating across dozens of reviews.
    ease = Math.round(ease * 1000) / 1000;
    return { ease, interval, reps, due: Date.now() + interval * 24 * 60 * 60 * 1000 };
  },

  // The em dash every UI shows for a field that is null.
  DASH: '\u2014',

  // The one folder that always exists and cannot be deleted. Words saved
  // while reading land here.
  READING: 'reading',

  // Folder membership lives on the word, and words saved before folders
  // existed have no `folders` field at all. A missing field reads as "in
  // From reading" rather than "in nothing", so old entries need no
  // migration pass and can never become orphans.
  foldersOf(entry) {
    const ids = entry?.folders;
    return Array.isArray(ids) && ids.length ? ids : [VT.READING];
  },

  // Folder ids are generated, never derived from the name, so renaming a
  // folder cannot strand the words that point at it.
  newFolder(name, { color = 'sage', icon = '\u{1F4C1}', desc = '' } = {}) {
    return {
      id: 'f_' + Math.random().toString(36).slice(2, 10),
      name: String(name).trim(),
      color, icon, desc,
      auto: false,
      added: Date.now()
    };
  },

  // Median CEFR level across entries that have one. Reported instead of a
  // "mastered" count, which nothing in the data defines.
  medianLevel(entries) {
    const order = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
    const ranks = entries
      .map((e) => order.indexOf(e.level))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b);
    if (!ranks.length) return null;
    return order[ranks[Math.floor(ranks.length / 2)]];
  },

  newEntry(word, parsed, vi, url) {
    return {
      word,
      folders: [VT.READING],
      level: parsed.level,
      ipa: parsed.ipa,
      def: parsed.def,
      audio: parsed.audio,
      pos: parsed.pos ?? null,
      gram: parsed.gram ?? null,
      ipaUs: parsed.ipaUs ?? null,
      audioUs: parsed.audioUs ?? null,
      senses: parsed.senses ?? [],
      synonyms: parsed.synonyms ?? [],
      related: parsed.related ?? [],
      context: null,
      vi,
      sources: [url],
      added: Date.now(),
      ease: 2.5,
      interval: 0,
      reps: 0,
      due: Date.now()   // due immediately, so a new word appears in the first review
    };
  }
};
