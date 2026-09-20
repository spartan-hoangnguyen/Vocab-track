// Korean. The lookup half: krdict (국립국어원 한국어기초사전).
//
// A stub, and registered anyway. Leaving it out is not the neutral choice:
// lookup.js's fallback for an unregistered language sets
// `failed: no dictionary registered for ko`, and sidepanel.js:44 renders that
// under a bold "Cambridge lookup failed." on every Korean word — the wrong
// dictionary, and the wrong category, since a pack that was never built is not
// a call that failed. A missing pack also drops the "full entry ↗" link from
// all three surfaces, which all guard on `if (dict)` (sidepanel.js:117,
// dashboard.js:371, dashboard.js:930). Fifteen lines buy a correct link and a
// silent degrade.
//
// Not loaded into the content script, for the reason lang/en/dictionary.js
// gives: no MV3 CORS bypass there, and the krdict parser will want DOMParser.
(() => {
  const KRDICT = 'https://krdict.korean.go.kr';

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

    // The four nulls and nothing else — no network, no `failed`, no
    // `notFound`. `failed` is reserved for "the dictionary call did not
    // happen" (lang/en/dictionary.js:107), and having no API key is a
    // configuration state, not a failure, so the side panel's warning must
    // stay hidden. `notFound` is load-bearing in the other direction:
    // lookup.js:73 aborts the whole save on it, which would throw away the
    // Vietnamese MT gloss that is the entire value of this phase.
    //
    // async for the shape, not for the await: fetchEntry returns this straight
    // through to a caller that awaits it.
    //
    // ponytail: gloss only, no dictionary — level, pronunciation, definition,
    // senses and audio are null for every Korean word until a krdict key
    // exists. krdict goes behind this same function once one does, reading a
    // flat `krdictKey` off chrome.storage.local INSIDE the function (a
    // top-level read would throw in test/test.html, which has no `chrome`).
    async lookup() {
      return { level: null, ipa: null, def: null, audio: null };
    }
  });
})();
