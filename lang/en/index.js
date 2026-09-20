// English. The pure half: what counts as a word, how to find one in a text,
// and the level scale. No network here — the Cambridge pipeline is in
// lang/en/dictionary.js.
LANG.register('en', {
  name: 'English',
  native: 'English',

  // Latin letters. Tested against a selection to route it to this pack, so it
  // is a "does this contain" test, not an anchored one.
  script: /[A-Za-z]/,

  // The CEFR bands, easiest first. medianLevel and the dashboard's level bars
  // read the scale from here rather than closing over one.
  levels: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'],

  // A selection worth offering a lookup for: one word, letters and inner
  // hyphens only, 2 to 40 characters. Deliberately rejects digits and
  // punctuation so the button does not appear on code, prices or dates.
  isCandidate(raw) {
    const word = VT.normaliseWord(raw);
    return /^[a-z]+(-[a-z]+)*$/.test(word) && word.length >= 2 && word.length <= 40;
  },

  // Every occurrence of `word` in `text`, as {index, length} ranges.
  //
  // Ranges rather than a RegExp because the seam has to serve languages whose
  // matching a regular expression cannot express — see lang/ko. It also ends
  // the /g lastIndex hazard the callers used to have to remember: a range list
  // carries no cursor, so there is no shared object to reset.
  //
  // Word-bounded and case-insensitive, so "cat" never lights up inside
  // "category". Exact match only: "resilient" does not match "resilience".
  // Stemming is deliberately out of scope.
  match(word, text) {
    const str = String(text ?? '');
    const safe = String(word ?? '').replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
    if (!safe) return [];
    const re = new RegExp(`\\b${safe}\\b`, 'gi');
    const out = [];
    let m;
    while ((m = re.exec(str))) {
      out.push({ index: m.index, length: m[0].length });
      // A zero-length match cannot happen with a non-empty word, but an empty
      // one would spin here forever, and `safe` above is the only guard.
      if (m[0].length === 0) re.lastIndex++;
    }
    return out;
  },

  // Same contract as a practice mode's: [[name, ok, detail?], …], driven by
  // test/test.js so a pack proves itself wherever it is loaded.
  selfTest() {
    const m = (w, t) => LANG.get('en').match(w, t);
    return [
      ['finds a word', m('cat', 'a cat sat').length === 1],
      ['is word-bounded', m('cat', 'category').length === 0],
      ['is case-insensitive', m('cat', 'Cat and CAT').length === 2],
      ['keeps the text spelling',
        VT.pieces('Cat', m('cat', 'Cat')).filter((p) => p.hit)[0]?.text === 'Cat'],
      ['does not stem', m('resilient', 'resilience').length === 0],
      ['an empty word matches nothing', m('', 'anything').length === 0],
      ['a regex metacharacter is literal', m('a.b', 'axb').length === 0],
      ['accepts a plain word', LANG.get('en').isCandidate('resilient')],
      ['rejects digits', !LANG.get('en').isCandidate('covid19')],
      ['lemma is the identity', LANG.get('en').lemma('running') === 'running']
    ];
  }
});
