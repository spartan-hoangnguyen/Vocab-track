// Pure logic shared by the content script, the side panel and the test page.
// No Chrome API and no network here: everything in this file must be callable
// from test/test.html in a plain browser tab.
const VT = {
  CAMBRIDGE: 'https://dictionary.cambridge.org',

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

  // Selectors verified against the committed fixtures on 2026-09-13.
  // Each field is independent: a markup change that breaks one selector
  // yields null for that field and leaves the other three intact.
  //
  // Scoped to the first `.entry-body__el` (the actual dictionary entry),
  // not the whole document: an off-entry page (e.g. the dictionary index a
  // not-found lookup redirects to) carries a Word-of-the-Day promo block
  // with its own `.ipa` and `source[src$=".mp3"]`, which would otherwise be
  // picked up as if they belonged to the looked-up word. Defence in depth
  // for that case, not the only guard against it.
  parseCambridge(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const root = doc.querySelector('.entry-body__el');
    const text = (sel) => root?.querySelector(sel)?.textContent.trim() || null;
    const audio = root?.querySelector('source[src$=".mp3"]')?.getAttribute('src');
    return {
      level: text('.epp-xref'),
      ipa: text('.ipa'),
      def: text('.def.ddef_d'),
      audio: audio ? VT.CAMBRIDGE + audio : null
    };
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
