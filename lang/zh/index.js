// Chinese (Simplified). The pure half: what counts as a word and how to find
// it again in a page. No network here — CC-CEDICT and the Vietnamese gloss
// belong in lang/zh/dictionary.js.
//
// Chinese writes no spaces, so a word has no boundary a regex can see: 学 is a
// word, and it is also the first half of 学生. A substring search would light a
// saved 学 up inside every 学生, 学习 and 大学 on the page. So matching asks
// Intl.Segmenter where the words are and only accepts whole ones.
//
// Simplified only. Traditional characters are Han too, so they route here and
// get the MT gloss, but nothing converts them and CEDICT is keyed on the
// simplified form. Japanese kanji-only selections (学生 is also Japanese) route
// here as well: script alone cannot tell them apart. Both are known ceilings.
(() => {
  // One segmenter, built on first use. Construction loads ICU's dictionary,
  // and match() runs once per text node during page highlighting.
  let segmenter = null;
  function segments(text) {
    segmenter ??= new Intl.Segmenter('zh', { granularity: 'word' });
    return [...segmenter.segment(text)];
  }

  const HAN_WORD = /^\p{Script=Han}+$/u;

  LANG.register('zh', {
    name: 'Chinese',
    native: '中文',
    // The toggle's label. One character, like ko's 한.
    short: '中',

    // Han does not overlap Latin (en) or Hangul (ko), so registration order
    // does not decide a single word. A kana+kanji selection (食べる) lands here
    // too and isCandidate turns it down.
    script: /\p{Script=Han}/u,

    // Google's MT wants the script variant: bare zh is accepted but zh-CN is
    // what pins Simplified.
    mt: 'zh-CN',

    // Mandarin as spoken in mainland China. `exact` because the primary subtag
    // is not enough here: zh-HK is Cantonese, a different spoken language, and
    // bestVoice would otherwise take it for a zh card (lookup.js).
    voices: [{ id: 'std', label: '中文', bcp47: 'zh-CN', exact: true }],

    // `ipa` holds pinyin for a Chinese word (lang/zh/dictionary.js), so the
    // panel and the card label it rather than wrap it in IPA's slashes.
    pronLabel: 'Pinyin',

    // HSK 2.0, easiest first, so VT.medianLevel reads the scale off the pack.
    levels: ['HSK 1', 'HSK 2', 'HSK 3', 'HSK 4', 'HSK 5', 'HSK 6'],

    // Chinese has no spaces, so practice-speak's "at least 5 words" counts
    // the segmenter's words instead (punctuation is not word-like).
    wordCount(text) {
      return segments(String(text ?? '')).filter((s) => s.isWordLike).length;
    },

    // NFC and trim as every pack does, plus inner whitespace: a selection that
    // crosses a line break in the page comes back as 学 生, and Chinese has no
    // word that contains a space. toLowerCase is a no-op on Han.
    normalise(raw) {
      return VT.normaliseWord(raw).replace(/\s+/g, '');
    },

    // 1 to 6 Han characters and nothing else. Anchored, so kana (a Japanese
    // selection), Latin and digits fail; 6 because HSK words stop at 4 and
    // chengyu at 4, and past that a selection is a phrase.
    isCandidate(raw) {
      return /^\p{Script=Han}{1,6}$/u.test(this.normalise(raw));
    },

    // Every occurrence of `word` in `text`, as {index, length} ranges.
    //
    // A hit is a segment that equals the word, or a run of consecutive
    // segments that joins to it exactly. The run case is for the words ICU
    // splits (图书馆 → 图书|馆, 中华人民共和国 → 中华|人民|共和国). A run must
    // START on a segment boundary and END on one, which is the whole point:
    // 学 never matches inside 学生, because 学生 is one segment.
    match(word, text) {
      const w = String(word ?? '');
      const str = String(text ?? '');
      if (!w || !HAN_WORD.test(w) || !str.includes(w)) return [];

      const segs = segments(str);
      const out = [];
      for (let i = 0; i < segs.length; i++) {
        let joined = '';
        let j = i;
        while (j < segs.length && joined.length < w.length && w.startsWith(joined + segs[j].segment)) {
          joined += segs[j].segment;
          j++;
        }
        if (joined === w) {
          out.push({ index: segs[i].index, length: w.length });
          i = j - 1;
        }
      }
      return out;
    },

    // Same contract as ko's: [[name, ok, detail?], …]. The segmenter's misses
    // are written in as the values it actually produces — the wrong answer IS
    // the expected value — so an ICU upgrade that changes a split goes red here
    // instead of silently changing what the page highlights.
    selfTest() {
      const zh = LANG.get('zh');
      const M = (word, text, wants) => {
        const got = zh.match(word, text);
        const ok = got.length === wants.length
          && wants.every((want, i) => got[i].index === want[0]
            && text.slice(got[i].index, got[i].index + got[i].length) === want[1]);
        const detail = got.map((r) => `${r.index}=${text.slice(r.index, r.index + r.length)}`).join(' ');
        return [`match(${word || "''"}, ${text || "''"})`, ok, detail || '[]'];
      };

      return [
        // --- S2: whole words only. 学 is a word, but not inside 学生.
        M('学', '我是学生', []),
        M('学生', '我是学生', [[2, '学生']]),
        M('学生', '学生们好，我是学生。', [[0, '学生'], [7, '学生']]),
        M('中文', '我喜欢学习中文', [[5, '中文']]),
        M('学习', '我喜欢学习中文', [[3, '学习']]),
        // A word ICU splits in two still matches, as a run of segments.
        M('图书馆', '他在图书馆看书', [[2, '图书馆']]),
        M('中华人民共和国', '中华人民共和国成立了', [[0, '中华人民共和国']]),
        // Mixed script: the index is into the original string.
        M('电脑', 'My 电脑 is new', [[3, '电脑']]),
        M('', '我是学生', []),
        M('学生', '', []),
        M('cat', 'the cat', []),

        // --- CEILING: ICU glues a one-character word onto its neighbour, so
        // the word is not a segment of its own and does not match. 我 in 我是,
        // 在 in 他在. The wrong answer IS the expected value.
        M('我', '我是学生', []),
        M('在', '他在图书馆看书', []),

        // --- isCandidate.
        ['accepts 学生', zh.isCandidate('学生')],
        ['accepts one character', zh.isCandidate('书')],
        ['accepts a split selection', zh.isCandidate('学 生')],
        ['rejects hiragana', !zh.isCandidate('ひらがな')],
        ['rejects kana mixed with kanji', !zh.isCandidate('食べる')],
        ['rejects Latin', !zh.isCandidate('abc')],
        ['rejects mixed Latin', !zh.isCandidate('K歌')],
        ['rejects a 10-character run', !zh.isCandidate('中华人民共和国成立了')],

        ['normalise strips inner whitespace', zh.normalise(' 学\n生 ') === '学生', zh.normalise(' 学\n生 ')],

        // --- routing, alongside the other packs.
        ['Han detects as Chinese', LANG.detect('中文')?.id === 'zh', String(LANG.detect('中文')?.id)],
        ['Hangul still detects as Korean', LANG.detect('책')?.id === 'ko', String(LANG.detect('책')?.id)],
        ['Latin still detects as English', LANG.detect('cat')?.id === 'en', String(LANG.detect('cat')?.id)],
        ['VT.find routes a Chinese word here',
          VT.find('学生', '我是学生').length === 1,
          JSON.stringify(VT.find('学生', '我是学生'))]
      ];
    }
  });
})();
