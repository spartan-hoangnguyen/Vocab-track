// GIF illustrations for flashcards, from GIPHY. A visual mnemonic: the GIF you
// find for a word is shown on the back of its review card, where the image and
// the word land together, which is what makes it stick.
//
// Network lives here, never in a content script — the same boundary lookup.js
// states. Loaded by the dashboard only, which is the one surface a GIF shows
// on, after lib.js (giphyPick calls VT.giphyOk). The pure halves — the query,
// the URL and the pick — are plain functions so test/test.html can drive them;
// only giphyFind touches the network and chrome.storage, and it reads the key
// off storage INSIDE the function, so loading this file in test.html (which has
// no `chrome`) defines everything and runs nothing that would throw.
//
// The key is the user's own GIPHY API key, set in the dashboard and kept in
// chrome.storage.local — never committed, the way lang/ko/dictionary.js plans
// the krdict key. A GIPHY key is a client-side public key, so the cost of a
// leak is someone spending its rate-limit quota, not account access; it still
// has no place in the repo.

const GIPHY_SEARCH = 'https://api.giphy.com/v1/gifs/search';
// Beta keys allow about 42 reads an hour, so every call is deliberate: the card
// has a button, nothing fetches on its own, and a found URL is stored so a word
// is never searched twice without being asked. A small batch, not one, so "Try
// another" can re-roll on the same single request instead of spending a new one.
const GIPHY_LIMIT = 5;

// What to search GIPHY for, and in which language. English indexes English, so
// an English card searches its own word. GIPHY has no Korean tag coverage worth
// a request, so a non-English card searches its Vietnamese gloss instead — which
// is the meaning the learner is pairing the image with anyway — and falls back
// to the word itself only when there is no gloss. Pure.
function giphyQuery(entry) {
  const pack = LANG.of(entry);
  if (pack.id === 'en') return { q: entry.word, lang: 'en' };
  const vi = String(entry?.vi ?? '').trim();
  if (vi) return { q: vi, lang: 'vi' };
  return { q: entry.word, lang: pack.id };
}

// The search URL. Pure, so the test pins the whole query string. `rating` pg-13
// keeps a vocabulary card roughly safe for work; `bundle` trims the response to
// the fixed-height renditions giphyPick reads, so a search is a small download.
function giphyUrl(key, q, lang) {
  const params = new URLSearchParams({
    api_key: String(key ?? ''),
    q: String(q ?? ''),
    limit: String(GIPHY_LIMIT),
    rating: 'pg-13',
    lang: lang || 'en',
    bundle: 'fixed_height'
  });
  return `${GIPHY_SEARCH}?${params}`;
}

// One GIF URL out of a GIPHY search response, or null for no usable result.
//
// A fixed-height rendition (200px) first, then fixed-width, then downsized —
// never `original`, which is regularly several megabytes and would make the
// card wait on a huge file. Every candidate goes through VT.giphyOk, so a
// response that somehow carried an off-GIPHY URL is dropped rather than shown.
//
// `rand` is a parameter only so the test can pin the pick, the same reason
// VT.quizOptions takes one: with several results, "Try another" lands on a
// different GIF on its one request instead of always returning the top hit.
function giphyPick(json, rand = Math.random) {
  const urls = (json?.data ?? [])
    .map((gif) => {
      const img = gif?.images?.fixed_height
        ?? gif?.images?.fixed_width
        ?? gif?.images?.downsized;
      return img?.url ?? null;
    })
    .filter((url) => url && VT.giphyOk(url));
  if (!urls.length) return null;
  return urls[Math.floor(rand() * urls.length)];
}

// The whole search for one entry, with no UI in it. Returns { url } or
// { url: null, failed } — the same split glossFor uses, because the two silent
// losses a card must tell apart are "GIPHY had no match" (url null, failed
// null) and "the request could not be made" (failed set). The key is read here
// rather than passed in, so this file owns the one storage access and the
// caller's button only has to know whether a key exists at all.
async function giphyFind(entry, rand = Math.random) {
  const { giphyKey } = await chrome.storage.local.get('giphyKey');
  const key = String(giphyKey ?? '').trim();
  if (!key) return { url: null, failed: 'no GIPHY key set' };
  const { q, lang } = giphyQuery(entry);
  try {
    // A timeout, so a request that never settles cannot leave the card stuck on
    // "Searching…".
    const res = await fetch(giphyUrl(key, q, lang), { signal: AbortSignal.timeout(10000) });
    // Each of these is a different sentence on the card, and none of them is
    // "no GIF for this word", which is what an empty data array means.
    if (res.status === 401 || res.status === 403) {
      return { url: null, failed: 'GIPHY rejected the key — check it in settings.' };
    }
    if (res.status === 429) {
      return { url: null, failed: 'GIPHY rate limit reached — try again later.' };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { url: giphyPick(await res.json(), rand), failed: null };
  } catch (err) {
    console.error('[vocab-track] giphy search failed for', entry.word, err);
    return { url: null, failed: `${err.name}: ${err.message}` };
  }
}
