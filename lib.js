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
  parseCambridge(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const text = (sel) => doc.querySelector(sel)?.textContent.trim() || null;
    const audio = doc.querySelector('source[src$=".mp3"]')?.getAttribute('src');
    return {
      level: text('.epp-xref'),
      ipa: text('.ipa'),
      def: text('.def.ddef_d'),
      audio: audio ? VT.CAMBRIDGE + audio : null
    };
  }
};
