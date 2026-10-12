// English. The pure half: what counts as a word, how to find one in a text,
// and the level scale. No network here — the Cambridge pipeline is in
// lang/en/dictionary.js.
LANG.register('en', {
  name: 'English',
  native: 'English',
  // The toggle's label, which has to fit a segment in the top bar. Not
  // id.toUpperCase(): an id is a key, and '한' is not 'KO'.
  short: 'EN',

  // Latin letters. Tested against a selection to route it to this pack, so it
  // is a "does this contain" test, not an anchored one.
  script: /[A-Za-z]/,

  // The CEFR bands, easiest first. medianLevel and the dashboard's level bars
  // read the scale from here rather than closing over one.
  levels: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'],

  // The two accents Cambridge records, which is why this is the one pack with a
  // choice to make. The ids are NOT free strings: reviewPrefs.accent stores one
  // of them, and lookup.js's pronounce() picks entry.audioUs over entry.audio by
  // the id 'us'. The tags are what reaches SpeechSynthesisUtterance.lang.
  voices: [{ id: 'uk', label: 'UK', bcp47: 'en-GB' },
           { id: 'us', label: 'US', bcp47: 'en-US' }],

  // The forms that count as "the word" when it is looked for in a spoken
  // sentence: itself, +s/es/ed/d/ing, and a final e dropped before ing/ed
  // (accelerate → accelerating, accelerated). Not y→ied or doubled consonants:
  // a looser rule starts accepting neighbours ("accelerator" is a different
  // word), and "studies" is always there.
  //
  // The mirror of lemma(): that strips a surface form back to the saved word,
  // this grows the saved word back out to the forms a sentence may use it in.
  // It lives on the pack for the same reason lemma() does — it was English
  // morphology sitting inside practice-speak.js, a mode shared by every
  // language.
  inflections(word) {
    const w = String(word ?? '').trim().toLowerCase();
    if (!w) return [];
    const out = [w, `${w}s`, `${w}es`, `${w}ed`, `${w}d`, `${w}ing`];
    if (w.endsWith('e')) out.push(`${w.slice(0, -1)}ing`, `${w.slice(0, -1)}ed`);
    return out;
  },

  // English words are separated tokens, so the highlighter reads a page once
  // and looks each token up (VT.indexHits) instead of running match() once
  // per saved word.
  indexed: true,

  // The forms the page highlighter looks for: inflections() and then the
  // spellings it deliberately leaves out — y→ies/ied, a doubled final
  // consonant, the irregular verbs in lang/en/irregular.js, and a short list
  // of derivations (resilient → resilience). Wider than inflections() because
  // a false highlight costs a glance, while a false Speak pass costs a grade.
  //
  // Every rule grows the SAVED word, keyed on the ending it already has, so a
  // rule that misfires makes a spelling no page contains ("visitted"), not a
  // neighbouring word: "accelerate" never reaches "accelerator".
  //
  // ponytail: a fixed suffix list. decide → decision and other stem changes do
  // not highlight; a lemmatiser is the upgrade if that gap shows in use.
  forms(word) {
    const w = String(word ?? '').trim().toLowerCase();
    if (!w) return [];
    const out = new Set(this.inflections(w));
    const add = (...forms) => forms.forEach((form) => out.add(form));
    const stem = (n) => w.slice(0, -n);

    if (/[^aeiou]y$/.test(w)) {
      add(`${stem(1)}ies`, `${stem(1)}ied`, `${stem(1)}ily`, `${stem(1)}iness`);
    }
    if (w.endsWith('ie')) add(`${stem(2)}ying`);
    // Consonant–vowel–consonant: stop → stopped, run → running.
    if (/[^aeiou][aeiou][b-df-hj-np-tvz]$/.test(w)) {
      add(`${w}${w.at(-1)}ed`, `${w}${w.at(-1)}ing`);
    }
    add(...(EN_IRREGULAR[w] ?? []));

    if (/[ae]nt$/.test(w)) add(`${stem(1)}ce`, `${stem(1)}cy`);
    if (/[ae]nc[ey]$/.test(w)) add(`${stem(2)}t`);
    if (w.endsWith('ate')) add(`${stem(1)}ion`, `${stem(1)}ions`);
    if (w.endsWith('ble')) add(`${stem(3)}bility`, `${stem(1)}y`);
    if (w.endsWith('ic')) add(`${w}ally`);
    // Short words stay out: ear → early and on → only are different words.
    if (w.length >= 4 && !/(y|le)$/.test(w)) add(`${w}ly`, `${w}ness`);
    return [...out];
  },

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
      ['lemma is the identity', LANG.get('en').lemma('running') === 'running'],
      ...[['resilient', 'resilience'], ['run', 'ran'], ['run', 'running'], ['study', 'studied'],
          ['stop', 'stopped'], ['give', 'gave'], ['happy', 'happiness'], ['able', 'ability'],
          ['resilience', 'resilient'], ['accelerate', 'acceleration']]
        .map(([w, form]) => [`forms: ${w} reaches ${form}`, LANG.get('en').forms(w).includes(form)]),
      ...[['accelerate', 'accelerator'], ['cat', 'category'], ['pass', 'passage'], ['ear', 'early']]
        .map(([w, form]) => [`forms: ${w} does not reach ${form}`, !LANG.get('en').forms(w).includes(form)]),
      ['forms leave inflections() alone', !LANG.get('en').inflections('run').includes('ran')]
    ];
  }
});
