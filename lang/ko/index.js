// Korean. The pure half: what counts as a word, how to strip a 조사 off it,
// and how to find it again in a page. No network here — krdict and the
// Vietnamese gloss belong in lang/ko/dictionary.js, which stays a stub until
// a krdict key exists — until then the MT gloss is the only meaning a word
// carries.
//
// This is the pack the range-returning match() seam exists for. Korean is
// agglutinative: 책 appears on the page as 책을, 책이, 책에서는, and \b is an
// ASCII boundary that never fires between Hangul syllables. A lookaround on
// \p{L} does not help either, because the particle 을 IS a letter. So the
// matching is a scan, not a pattern, and the stripping is arithmetic on the
// syllable block rather than a dictionary.
(() => {
  // The 받침 (final consonant) of a syllable, as the arithmetic the Hangul block
  // is built on: every syllable is (초성, 중성, 종성) packed as
  // 0xAC00 + ((L * 21) + V) * 28 + T. So T === 0 means an OPEN syllable.
  //
  // This is why Korean matching needs no dictionary. The 조사 come in allomorph
  // pairs chosen by exactly this bit — 을 after a consonant, 를 after a vowel —
  // so "does the particle's allomorph agree with the stem's shape" is a free,
  // real-linguistics filter on over-stripping. Five lines of arithmetic save
  // 사과, 가을, 마을, 아이, 나이 and 국가.
  function jong(syllables) {
    return (syllables.codePointAt(syllables.length - 1) - 0xAC00) % 28;
  }

  // The strip table: [particle, minimum stem length, required stem shape].
  // LONGEST FIRST, and that order is load-bearing — 에서 must be tried before
  // 에 (or 학교에서 truncates to 학교서), 으로 before 로, 이랑 before 랑,
  // 에서는 before both 에서 and 는.
  //
  // `shape` is carried ONLY on the five true allomorph pairs (을/를, 이/가,
  // 은/는, 과/와, 이랑/랑); everywhere else it is null because there is nothing
  // to test. 으로 and its stacks are null rather than 'closed' because an open
  // stem before 으로 does not occur in real text, so the test would never fire.
  //
  // `minStem` 2 is the second guard, for the particles with no allomorph pair:
  // 도, 만, 께, 랑, 로 — it is what saves 지도, 수도, 포도, 함께, 자랑, 노랑,
  // 도로, 별로 and 서로. It cannot be the only guard, because min 2 would also
  // reject 책을 → 책, which is the primary case.
  //
  // 의 is deliberately ABSENT. The -의 noun class is large (회의, 정의, 강의,
  // 편의) and -주의 is productive (민주주의, 자본주의), which defeats any length
  // guard — while a genitive-marked selection is rare, because the reader picks
  // the head noun out of 나의 **책**. A small miss class beats a large
  // false-positive one. 의 IS in JOSA_MATCH below, where the lemma is known and
  // there is no such risk.
  //
  // The 11 common stacks are literal entries rather than a stacking loop: 11
  // strings beat a nested loop and its combinatorial ceiling.
  const JOSA = [
    ['에게서', 1, null], ['한테서', 1, null], ['으로서', 1, null], ['으로써', 1, null],
    ['에서는', 1, null], ['에서도', 1, null], ['에게는', 1, null], ['에게도', 1, null],
    ['으로는', 1, null], ['부터는', 1, null], ['까지는', 1, null],
    ['에서', 1, null], ['에게', 1, null], ['한테', 1, null], ['께서', 1, null],
    ['으로', 1, null], ['부터', 1, null], ['까지', 1, null], ['보다', 1, null],
    ['처럼', 1, null], ['마다', 1, null], ['밖에', 1, null],
    ['이랑', 1, 'closed'],
    ['을', 1, 'closed'], ['를', 1, 'open'],
    ['이', 1, 'closed'], ['가', 1, 'open'],
    ['은', 1, 'closed'], ['는', 1, 'open'],
    ['과', 1, 'closed'], ['와', 1, 'open'],
    ['에', 1, null], ['뿐', 1, null],
    ['랑', 2, 'open'], ['로', 2, null], ['께', 2, null], ['도', 2, null], ['만', 2, null]
  ];

  // What match() will accept as an eojeol's tail. A SUPERSET of the strip table:
  // every particle above regardless of its guards, plus the ones lemma() cannot
  // afford. The guards exist to decide whether an ambiguous surface form IS
  // inflected; here the lemma is already known, so that ambiguity is gone and a
  // guard would only cost recall.
  const JOSA_MATCH = new Set([...JOSA.map((entry) => entry[0]), '의', '하고', '이나', '나']);

  LANG.register('ko', {
    name: 'Korean',
    native: '한국어',
    // The toggle's label in the top bar. One syllable, so the segment beside
    // EN stays the size the bar's other controls are.
    short: '한',

    // Written out rather than left to LANG.register's default, which tags the
    // utterance with the bare id. Chrome registers its Korean voice as ko-KR,
    // and a bare 'ko' is a language match where 'ko-KR' is an exact one — one
    // line to remove the ambiguity. One voice, so the review controls' UK/US
    // picker hides itself on a Korean card.
    voices: [{ id: 'std', label: '한국어', bcp47: 'ko-KR' }],

    // The Unicode property, NOT /[가-힣]/. LANG.detect runs on the RAW string,
    // before any normalise — VT.isLookupCandidate (lib.js:23) and LANG.pick
    // (lookup.js:48) both hand it one — and no resolveWord caller passes a
    // langId (dashboard.js:519, dashboard.js:750, sidepanel.js:275), so this
    // regex is the only thing routing a Korean word to this pack. A macOS Quick
    // Action capture arrives DECOMPOSED: '책'.normalize('NFD') is three
    // conjoining jamo in U+1100–11FF, which the syllable range tests FALSE on
    // and this tests TRUE on. The syllable range here would have sent every Mac
    // capture to the English pack, silently.
    script: /\p{Script=Hangul}/u,

    // krdict's own 등급, easiest first, so VT.medianLevel and the dashboard's
    // level bars read the scale off the pack exactly as they do for CEFR.
    // Not TOPIK 1-6: no openly licensed TOPIK word list exists and the
    // 초급≈TOPIK 1-2 mapping is unofficial. Ungraded krdict entries come back
    // blank and simply do not rank — medianLevel already filters those out.
    levels: ['초급', '중급', '고급'],

    // Normalise is deliberately NOT overridden: LANG.register's default is
    // VT.normaliseWord, whose NFC step was written for Hangul in the first
    // place. .toLowerCase() is a no-op on Hangul and .trim() already takes
    // U+3000 IDEOGRAPHIC SPACE, so an override would read
    // `(raw) => VT.normaliseWord(raw)`.

    // A selection worth offering a lookup for: 1 to 12 composed syllables and
    // nothing else. Normalised FIRST, like lang/en/index.js:20 — that is what
    // composes an NFD selection into syllables so the anchored test can pass.
    //
    // The syllable-only range is right HERE (after NFC) where it is wrong in
    // `script`: it rejects bare jamo — ㅋㅋㅋ, ㅠㅠ are internet slang, not
    // words — which is this pack's equivalent of en rejecting digits. Anchored,
    // so K팝, 책2 and an internal space go too.
    //
    // A single syllable IS a candidate: 책, 물, 말, 밥, 산, 집, 돈. The
    // monosyllabic noun stock is a large share of core vocabulary, and 책 is the
    // worked example this whole feature was designed around. Upper bound 12
    // because an eojeol rarely passes 6 (읽었습니다 is 5) and compounds reach 8;
    // past that a selection is a phrase, not a word.
    isCandidate(raw) {
      const word = VT.normaliseWord(raw);
      return /^[가-힣]{1,12}$/.test(word);
    },

    lemma(raw) {
      const word = String(raw ?? '');
      // VT.find routes any word LANG.pick sends here, which need not be Hangul.
      if (!/^[가-힣]+$/.test(word)) return word;

      // ONE pass, not a loop to a fixpoint. A loop over-strips without bound —
      // 사랑을 → 사랑 → 사 — and the 받침 test cannot stop it, because every
      // intermediate looks like a valid stem. Stacked particles are covered by
      // the 11 literal stack entries in JOSA instead; the cost is that 책에서만
      // keeps its 만.
      for (const [particle, minStem, shape] of JOSA) {
        if (word.length <= particle.length || !word.endsWith(particle)) continue;
        const stem = word.slice(0, word.length - particle.length);
        if (stem.length < minStem) continue;
        // `continue`, not `return word`, on a shape mismatch. 나이랑: the
        // longest suffix 이랑 wants a closed stem and 나 is open, so it fails —
        // and the loop then reaches 랑 (open, min 2) with stem 나이 and gets it
        // right. Read this as "first particle that fits", not "longest wins".
        if (shape === 'closed' && jong(stem) === 0) continue;
        if (shape === 'open' && jong(stem) !== 0) continue;
        return stem;
      }
      return word;
    },

    // Every occurrence of `word` in `text`, as {index, length} ranges.
    //
    // A scan for maximal runs of Hangul syllables, NOT text.split(/\s+/). A
    // maximal run IS the eojeol's Hangul core, and it wins on three counts:
    // m.index is already the offset into the ORIGINAL text so there is no
    // accumulator to get wrong (and offsets are what VT.pieces slices with);
    // punctuation falls out for free, so `책을,` and `(책)` need no trimming;
    // and a mixed-script eojeol like 한국어-책을 splits at the hyphen by itself.
    //
    // The range is the WHOLE run, not just the lemma. That is what makes the
    // highlighter underline 책을 as the page spells it, hands VT.pieces the
    // surface form as its hit text (the same round-trip en asserts for
    // capitalisation), and lets VT.blank swallow the particle — so Fill the gap
    // shows `나는 … 읽었다` instead of leaking `…을` as a grammatical hint.
    match(word, text) {
      const w = String(word ?? '');
      const str = String(text ?? '');
      // An empty word would make startsWith('') true for every run and
      // slice(0) hand back the whole run as its "particle" — the same class of
      // hazard as en's empty-pattern guard at lang/en/index.js:37.
      if (!w || !/^[가-힣]+$/.test(w)) return [];

      const out = [];
      const re = /[가-힣]+/g;
      let m;
      while ((m = re.exec(str))) {
        const run = m[0];
        // startsWith ALONE is what would give 책상 for 책. The tail has to be a
        // known particle, and 상 is not one.
        const hit = run === w
          || (run.startsWith(w) && JOSA_MATCH.has(run.slice(w.length)));
        if (hit) out.push({ index: m.index, length: run.length });
      }
      return out;
    },

    // Same contract as a practice mode's: [[name, ok, detail?], …]. row[2]
    // carries what was actually produced, because ~80 vectors behind one
    // aggregate check in test/test.js would otherwise fail with only a name.
    selfTest() {
      const ko = LANG.get('ko');
      // One row per vector: name, pass, and the actual value as the detail.
      const L = (input, want) => {
        const got = ko.lemma(input);
        return [`lemma(${input}) → ${want}`, got === want, got];
      };
      // Checks the ranges, that each range slices back to the surface form the
      // vector names, and that VT.pieces round-trips the whole text.
      const M = (word, text, wants) => {
        const got = ko.match(word, text);
        const pieces = VT.pieces(text, got);
        const ok = got.length === wants.length
          && wants.every((want, i) => got[i].index === want[0]
            && got[i].length === want[1]
            && text.slice(got[i].index, got[i].index + got[i].length) === want[2])
          && pieces.map((p) => p.text).join('') === text;
        const detail = got.map((r) => `${r.index}+${r.length}=${text.slice(r.index, r.index + r.length)}`).join(' ');
        return [`match(${word || "''"}, ${text || "''"})`, ok, detail || '[]'];
      };

      return [
        // --- the primary case, and the four bare particles on a closed stem.
        L('책을', '책'), L('책이', '책'), L('책은', '책'), L('책에', '책'),
        // The open-stem allomorphs: 무 has no 받침, so 를/가/는 are the forms
        // that can follow it.
        L('나무를', '나무'), L('나무가', '나무'), L('나무는', '나무'),
        // Longest-first is load-bearing: 에 before 에서 truncates this to 학교서.
        L('학교에서', '학교'),
        // A literal stack entry, because one pass cannot strip twice.
        L('학교에서는', '학교'),

        // --- the trap the 받침 test does NOT catch. 사 is open and 랑 is the
        // post-vowel allomorph, so they agree; only minStem 2 on 랑 saves it.
        L('사랑', '사랑'), L('자랑', '자랑'), L('노랑', '노랑'),
        // And one pass is what stops 사랑을 → 사랑 → 사.
        L('사랑을', '사랑'),

        // --- saved by 받침 disagreement alone. 사/가/마/아/나 are open but
        // 과/을/이 want closed; 국 is closed but 가 wants open.
        L('사과', '사과'), L('가을', '가을'), L('마을', '마을'),
        L('아이', '아이'), L('나이', '나이'), L('국가', '국가'),

        // --- saved by minStem 2, the guard for the particles with no allomorph
        // pair (도, 만, 께, 랑, 로), where length is the only test available.
        L('지도', '지도'), L('수도', '수도'), L('포도', '포도'),
        L('함께', '함께'), L('도로', '도로'), L('별로', '별로'),
        L('서로', '서로'), L('하나', '하나'),

        // --- 의 is absent from the strip table entirely. The -의 noun class is
        // large and -주의 is productive, so it beats any length guard.
        L('회의', '회의'), L('민주주의', '민주주의'), L('거의', '거의'),

        // --- the deliberate misses, the price of the two guards above.
        // Recoverable: krdict answers not-found and the MT gloss still fills the
        // card, so the word is saved under a slightly wrong key, not lost.
        L('책도', '책도'), L('책만', '책만'), L('책의', '책의'),

        // --- 으로 (min 1) is tried before 로 (min 2), which is why no third
        // 'open-or-ㄹ' shape value is needed.
        L('집으로', '집'), L('버스로', '버스'),

        // --- the multi-syllable particles: min 1, no shape test, because no
        // Korean noun ends in 에게/까지/부터/보다/처럼/께서.
        L('선생님께', '선생님'), L('친구에게', '친구'), L('서울까지', '서울'),
        L('내일부터', '내일'), L('너보다', '너'), L('꽃처럼', '꽃'),

        // --- the 이랑/랑 pair, and the vector that pins the `continue`.
        L('책이랑', '책'), L('나무랑', '나무'), L('나이랑', '나이'),

        // --- CEILING (1): the -이 class. 이 is both the subject marker and a
        // productive nominalizer, and 종/양/린 all carry a 받침 so the allomorph
        // agrees. Nothing structural separates 종이 from 책이, and minStem does
        // not help — 고양 is already 2. The wrong answer IS the expected value.
        L('종이', '종'), L('고양이', '고양'), L('어린이', '어린'),
        // CEILING (2): -도 is likewise a productive '-degree' suffix.
        L('만족도', '만족'),

        // --- CEILING (3): verbs. A miss is the good case — the dictionary form
        // ends in 다 and never reaches the surface, so these come back whole and
        // the MT gloss still answers.
        // ponytail: 조사 only, nouns only. Real morphology (verb stems, the
        // irregulars where the stem itself changes — 듣다→들어요, 춥다→추워요)
        // wants garu-ko, 1.7MB WASM, MIT, claimed F1 96.0. Cheaper first step:
        // in lang/ko/dictionary.js, retry the surface form when krdict answers
        // not-found on the lemma.
        L('읽었습니다', '읽었습니다'), L('먹다', '먹다'), L('공부하다', '공부하다'),
        // The uglier half: a vowel-stem attributive ends in 는 after an open
        // stem, so 하는 is indistinguishable from 차는 (car + 는). Consonant
        // stems escape by luck — 는 wants open, 먹/있 are closed.
        L('하는', '하'), L('보는', '보'), L('먹는', '먹는'), L('있는', '있는'),

        // --- match: offsets, and the surface form the range slices back to.
        M('책', '나는 책을 읽었다', [[3, 2, '책을']]),
        // THE false-positive trap: 책상's tail 상 is not a particle, so the only
        // hit is the later 책이 — startsWith alone would have matched both.
        M('책', '책상 위에 책이 있다', [[6, 2, '책이']]),
        // The eojeol must be the lemma plus a known particle and nothing else.
        M('사', '사랑은 위대하다', []),
        M('나', '나무가 크다', []),
        // JOSA_MATCH is a SUPERSET of the strip table. 의 is dropped from
        // lemma() but kept here, because with the lemma already known there is
        // no over-strip risk — and dropping it from both silently returned [].
        M('책', '나의 책의 제목', [[3, 2, '책의']]),
        // Two eojeol, two different particles, a comma in between.
        M('책', '나는 책을 읽고, 그 책은 좋다', [[3, 2, '책을'], [12, 2, '책은']]),
        // Trailing punctuation drops out for free: the run scan never sees the
        // comma or the full stop, so there is no trimming and no offset fixup.
        M('책', '책, 책을. 책상', [[0, 1, '책'], [3, 2, '책을']]),
        // A stacked particle is ONE hit over the whole eojeol, so VT.blank
        // replaces all five syllables instead of leaving 에서는 dangling.
        M('학교', '학교에서는 조용하다', [[0, 5, '학교에서는']]),
        // Mixed script: the Latin run is not a Hangul run, and m.index is still
        // an index into the original string.
        M('책', 'The 책을 here', [[4, 2, '책을']]),
        // CEILING: unspaced Korean finds nothing. Korean is space-delimited, so
        // this is a stated limit rather than a bug waiting to be filed.
        M('책', '나는책을읽었다', []),
        M('', '나는 책을', []),
        M('책', '', []),

        // --- routing. The NFD form is what a macOS Quick Action hands back.
        ['NFD Hangul detects as Korean',
          LANG.detect('책'.normalize('NFD'))?.id === 'ko',
          String(LANG.detect('책'.normalize('NFD'))?.id)],
        ['NFD Hangul is a candidate', ko.isCandidate('책'.normalize('NFD'))],

        // --- isCandidate.
        ['accepts one syllable', ko.isCandidate('책')],
        ['accepts a compound', ko.isCandidate('고양이')],
        ['rejects bare jamo', !ko.isCandidate('ㅋㅋㅋ')],
        ['rejects mixed Latin', !ko.isCandidate('K팝')],
        ['rejects digits', !ko.isCandidate('책2')],
        ['rejects two words', !ko.isCandidate('책 상')],

        // --- the round-trip en asserts for capitalisation, asserted here for
        // the surface form: it is what lets Fill the gap restore the eojeol.
        ['a hit piece carries the eojeol',
          VT.pieces('나는 책을 읽었다', VT.find('책', '나는 책을 읽었다', 'ko'))
            .filter((p) => p.hit)[0]?.text === '책을',
          String(VT.pieces('나는 책을 읽었다', VT.find('책', '나는 책을 읽었다', 'ko'))
            .filter((p) => p.hit)[0]?.text)]
      ];
    }
  });
})();
