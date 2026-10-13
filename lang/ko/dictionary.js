// Korean. The lookup half: krdict (국립국어원 한국어기초사전).
//
// Keyed: with a free krdict Open API key in Dashboard → Import & export
// (`krdictKey` in chrome.storage.local), a lookup fills the definition,
// senses, pronunciation and 초급/중급/고급 grade. Without one it returns the
// four nulls and the word saves with its MT gloss, as it always did.
//
// Registered even keyless. Leaving it out is not the neutral choice:
// lookup.js's fallback for an unregistered language sets
// `failed: no dictionary registered for ko`, and sidepanel.js:44 renders that
// under a bold "Cambridge lookup failed." on every Korean word — the wrong
// dictionary, and the wrong category, since a pack that was never built is not
// a call that failed. A missing pack also drops the "full entry ↗" link from
// all three surfaces, which all guard on `if (dict)` (sidepanel.js:117,
// dashboard.js:371, dashboard.js:930). A registered pack buys a correct link
// and a silent degrade.
//
// Not loaded into the content script, for the reason lang/en/dictionary.js
// gives: no MV3 CORS bypass there, and the krdict parser uses DOMParser.
(() => {
  const KRDICT = 'https://krdict.korean.go.kr';
  const NONE = () => ({ level: null, ipa: null, def: null, audio: null });

  // krdict's search response as the entry shape VT.newEntry reads. Pure, so
  // test.js drives it from saved XML. Schema per krdict's Open API guide
  // (krdict.korean.go.kr/kor/openApi/openApiInfo): channel > item > word,
  // sup_no, pronunciation, word_grade, pos, sense > (sense_order, definition).
  //
  // Homographs come back as several items (책 冊, 책 責 …), and an item may
  // carry another headword (an affix such as -책), so the FIRST item whose
  // word is the one looked up wins. None → notFound, which resolveWord turns into "saved with
  // its gloss". An <error> root (bad key, daily limit) → `failed`, so the
  // panel says why instead of looking like an entry with no data.
  function parse(xmlText, word) {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    const text = (node, tag) => node?.getElementsByTagName(tag)[0]?.textContent.trim() || null;
    const error = doc.getElementsByTagName('error')[0];
    if (error || doc.getElementsByTagName('parsererror').length) {
      const reason = error
        ? `krdict error ${text(error, 'error_code') ?? '?'}: ${text(error, 'message') ?? ''}`.trim()
        : 'krdict returned unreadable XML';
      return { ...NONE(), failed: reason };
    }
    const item = [...doc.getElementsByTagName('item')].find((it) => text(it, 'word') === word);
    if (!item) return { notFound: true };

    const senses = [...item.getElementsByTagName('sense')]
      .map((sense) => ({ level: null, def: text(sense, 'definition'), example: null }))
      .filter((sense) => sense.def)
      .slice(0, VT.MAX_SENSES);
    const grade = text(item, 'word_grade');
    // krdict's own Vietnamese for the headword: the first sense's trans_word.
    // The request asks for Vietnamese only (trans_lang=7), and the guide's
    // example names the language in Korean (영어), so 베트남어 is expected;
    // the bare code is accepted in case it comes back as the request spelled
    // it. Anything else is null, and resolveWord falls back to the MT gloss.
    const firstSense = item.getElementsByTagName('sense')[0];
    const vi = [...(firstSense?.getElementsByTagName('translation') ?? [])]
      .filter((tr) => ['베트남어', '7'].includes(text(tr, 'trans_lang')))
      .map((tr) => text(tr, 'trans_word'))
      .find(Boolean) ?? null;
    return {
      // Only krdict's three grades; an ungraded entry comes back blank, and
      // anything else would not rank on the pack's scale.
      level: LANG.get('ko').levels.includes(grade) ? grade : null,
      // Hangul, not IPA — the pack's pronLabel prints it as "발음: 책".
      ipa: text(item, 'pronunciation'),
      def: senses[0]?.def ?? null,
      audio: null, audioUs: null, ipaUs: null,
      pos: text(item, 'pos'),
      gram: null,
      senses,
      synonyms: [], related: [], opposites: [],
      vi
    };
  }

  // `surface` is the word as it was selected, before the 조사 stripper ran.
  // When krdict has no entry for the lemma (the stripper over-strips 고양이 to
  // 고양), the surface form is asked once more — only on a not-found, never
  // on `failed`, where a bad key or a dead network would just fail twice.
  // A hit is still saved under the lemma: resolveWord owns the key.
  async function lookup(word, { surface } = {}) {
    // Read here, never at the top level: test/test.html has no `chrome`.
    const stored = await globalThis.chrome?.storage?.local?.get('krdictKey');
    const key = String(stored?.krdictKey ?? '').trim();
    if (!key) return NONE();
    const first = await search(key, word);
    if (!first.notFound || !surface || surface === word) return first;
    return search(key, surface);
  }

  async function search(key, word) {
    const url = `${KRDICT}/api/search?key=${encodeURIComponent(key)}`
      + `&q=${encodeURIComponent(word)}&part=word&method=exact`
      + '&translated=y&trans_lang=7';
    try {
      // The same 7s and no retry as the English pack, for its reason.
      const res = await fetch(url, { signal: AbortSignal.timeout(7000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parse(await res.text(), word);
    } catch (err) {
      console.error('[vocab-track] krdict lookup failed for', word, err);
      return { ...NONE(), failed: String(err) };
    }
  }

  LANG.dictionary('ko', {
    name: 'krdict',
    // Carried for parity with the English pack, where test.js:398 asserts the
    // audio URL starts with it.
    base: KRDICT,

    // The MOBILE Vietnamese interface, and that is not a preference. Probed
    // live 2026-09-20 with a Chrome UA: /m/vie/searchResult answers 200 with
    // the real 책 entry and its Vietnamese glosses ("sách", 18×) in 68KB,
    // while the desktop paths do not work at all — /kor/dicSearch/SearchView
    // serves the site's own 500 page, /dicSearch/search and /{kor,vie}/
    // searchResult 404. nationCode, ParaWordNo and nation are all optional.
    // /m/eng/searchResult is the same page in English, if the gloss language
    // ever becomes a setting. Accepted cost: a phone layout in a desktop tab.
    href: (word) => `${KRDICT}/m/vie/searchResult?mainSearchWord=${encodeURIComponent(word)}`,

    // Keyless, this is the four nulls and nothing else — no network, no
    // `failed`, no `notFound`. `failed` is reserved for "the dictionary call
    // did not happen" (lang/en/dictionary.js:107), and having no API key is a
    // configuration state, not a failure, so the side panel's warning must
    // stay hidden. `notFound` is load-bearing in the other direction:
    // lookup.js:73 aborts the whole save on it, which would throw away the
    // Vietnamese MT gloss — so it is only ever said when krdict itself
    // answered and had no such headword.
    lookup,
    parse
  });
})();
