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
  FRAGMENT_WORDS: 4,

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

    // The headword, so it can be filtered out of its own synonym list —
    // Cambridge's thesaurus block lists the word itself first.
    const headword = text(root, '.hw.dhw')?.toLowerCase() ?? null;

    const collect = (sel) => [...root.querySelectorAll(sel)]
      .map((el) => el.textContent.trim())
      .filter(Boolean);

    const clean = (items) => [...new Set(items)]
      .filter((item) => item.toLowerCase() !== headword)
      .slice(0, VT.MAX_XREF);

    // Two sources, because either alone is thin. `.xref.synonym` is a curated
    // cross-reference that most entries lack; the `.daccord` thesaurus block
    // is richer but absent on others. Measured over eight words: xref alone
    // covered three, the thesaurus block six, the two together seven.
    const synonyms = clean([
      ...collect('.xref.synonym .x-h'),
      ...collect('.daccord li.had.t-i > a')
    ]);

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
      synonyms,
      related: clean(collect('.xref.related_word .x-h')),
      opposites: clean(collect('.xref.opposite .x-h'))
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

  // The other built-in folder: the words you starred on a card. Membership is
  // an ordinary folder id on the word, so review, practice and the overview
  // count it with no special case.
  STARRED: 'starred',

  // Topics the tag picker suggests before you have made any of your own —
  // the IELTS writing and speaking themes. They are not folders until you
  // first tag a word with one, so the overview never fills with empty cards.
  // The ids are fixed rather than generated so picking one twice, or
  // importing another profile's export, lands in the same folder.
  TOPICS: [
    { id: 't_environment', name: 'Environment', icon: '\u{1F331}' },
    { id: 't_education', name: 'Education', icon: '\u{1F393}' },
    { id: 't_health', name: 'Health', icon: '\u{1FA7A}' },
    { id: 't_technology', name: 'Technology', icon: '\u{1F4BB}' },
    { id: 't_work', name: 'Work & Business', icon: '\u{1F4BC}' },
    { id: 't_economy', name: 'Economy & Money', icon: '\u{1F4B0}' },
    { id: 't_politics', name: 'Politics & Government', icon: '\u{1F3DB}\u{FE0F}' },
    { id: 't_law', name: 'Law & Crime', icon: '\u{2696}\u{FE0F}' },
    { id: 't_society', name: 'Society & Culture', icon: '\u{1F465}' },
    { id: 't_science', name: 'Science', icon: '\u{1F52C}' },
    { id: 't_travel', name: 'Travel & Transport', icon: '\u{2708}\u{FE0F}' },
    { id: 't_media', name: 'Media & Communication', icon: '\u{1F4F0}' },
    { id: 't_food', name: 'Food & Drink', icon: '\u{1F35C}' },
    { id: 't_emotions', name: 'Emotions & Personality', icon: '\u{1F60A}' },
    { id: 't_arts', name: 'Arts & Entertainment', icon: '\u{1F3A8}' },
    { id: 't_nature', name: 'Nature & Animals', icon: '\u{1F43E}' }
  ],

  // Folder membership lives on the word, and words saved before folders
  // existed have no `folders` field at all. A missing field reads as "in
  // From reading" rather than "in nothing", so old entries need no
  // migration pass and can never become orphans.
  // What you typed against what the card wanted, as runs of matching and
  // non-matching characters — the thing that turns "wrong" into "one letter
  // out". Returns a mark-up of BOTH strings: the typed one so you can see
  // which letters to unlearn, the answer so you can see what belonged there.
  //
  // Character-level, not word-level, because a review answer is one word and
  // the interesting failure is a transposition or a doubled letter. A plain
  // equality test would call `pidgeon` and `elephant` equally wrong, and they
  // are not — one is a spelling slip you should grade Hard and the other is a
  // blank you should grade Blank.
  //
  // Longest common subsequence, the same shape Anki uses. O(n*m) over two
  // strings that are single words, so the table is tiny.
  diffWord(typed, answer) {
    const a = String(typed ?? '');
    const b = String(answer ?? '');
    // Case and surrounding space are never the point of a vocabulary review.
    const x = a.trim().toLowerCase();
    const y = b.trim().toLowerCase();
    if (x === y) {
      return { exact: true, near: false,
               typed: a ? [{ text: a, ok: true }] : [],
               answer: [{ text: b, ok: true }] };
    }

    // lcs[i][j] = length of the longest common subsequence of x[i:] and y[j:].
    // Built from the end so the walk below reads forwards, which is the order
    // the marks have to come out in.
    const lcs = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }

    const typedMarks = [];
    const answerMarks = [];
    // Runs, not single characters: three wrong letters in a row is one mistake
    // to look at, and marking each separately would render as confetti.
    const push = (marks, ch, ok) => {
      const last = marks[marks.length - 1];
      if (last && last.ok === ok) last.text += ch;
      else marks.push({ text: ch, ok });
    };

    let i = 0, j = 0, wrong = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) {
        push(typedMarks, a[i], true);
        push(answerMarks, b[j], true);
        i++; j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        push(typedMarks, a[i], false);   // typed something that does not belong
        i++; wrong++;
      } else {
        push(answerMarks, b[j], false);  // missed something that did
        j++; wrong++;
      }
    }
    while (i < x.length) { push(typedMarks, a[i], false); i++; wrong++; }
    while (j < y.length) { push(answerMarks, b[j], false); j++; wrong++; }

    // "Near" is what decides whether the UI says "almost" or just "no". Two
    // edits on a long word is a slip; two on a three-letter word is a
    // different word. Requiring an answer of at least 4 characters keeps
    // `cat`/`cut` out of it.
    return { exact: false, near: wrong > 0 && wrong <= 2 && y.length >= 4,
             typed: typedMarks, answer: answerMarks };
  },

  // The gloss a quiz asks about: the Vietnamese, or the English definition when
  // there is no translation. Null when the entry has neither — a word saved
  // while both the dictionary and the translator were down cannot be an
  // option, right or wrong.
  glossOf(entry) {
    const gloss = String(entry?.vi ?? entry?.def ?? '').trim();
    return gloss || null;
  },

  // Four options for one word: its own gloss and three others, shuffled.
  //
  // Distractors come from words at the same CEFR level or sharing a folder
  // first — a C2 word among three A1 glosses gives itself away by register
  // before you have read any of them — and are topped up at random when that
  // pool is short. Returns null when three usable others cannot be found,
  // which is the signal to skip the quiz and just show the entry.
  //
  // `rand` is a parameter only so the test can pin the shuffle.
  quizOptions(entry, pool, rand = Math.random) {
    const answer = VT.glossOf(entry);
    if (!answer) return null;
    const same = (text) => text.trim().toLowerCase() === answer.trim().toLowerCase();
    const folders = VT.foldersOf(entry);

    const near = [];
    const far = [];
    // Two saved words can share one gloss ("con mèo" for both cat and kitten).
    // Offering it twice would put two right-looking answers on screen.
    const seen = new Set();
    for (const other of pool ?? []) {
      if (!other || other.word === entry.word) continue;
      const gloss = VT.glossOf(other);
      // An identical gloss marked wrong is a bug, not a hard question.
      if (!gloss || same(gloss)) continue;
      const key = gloss.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      // Sharing "From reading" is not a signal: foldersOf gives it to every
      // word that was never filed, so counting it would make the whole store
      // near and throw the level preference away.
      const close = (other.level && other.level === entry.level)
        || VT.foldersOf(other).some((id) => id !== VT.READING && folders.includes(id));
      (close ? near : far).push({ word: other.word, text: gloss, correct: false });
    }

    const picked = [...VT.shuffled(near, rand), ...VT.shuffled(far, rand)].slice(0, 3);
    if (picked.length < 3) return null;
    return VT.shuffled([{ word: entry.word, text: answer, correct: true }, ...picked], rand);
  },

  // Fisher-Yates on a copy. The caller's array is never reordered.
  shuffled(items, rand = Math.random) {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  },

  // A word you have skipped is still yours — it stays in All words and still
  // highlights on a page — it is only out of the learning rotation. One
  // predicate, so the four places that build a queue or count what is due
  // cannot drift apart.
  isLearnable(entry) {
    return !!entry && !entry.skipped;
  },

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

  // The video id, or null for anything that is not a YouTube watch page.
  // Only `v` is read: a watch URL routinely also carries list, index, pp and
  // ab_channel, none of which say which video is playing.
  youtubeId(url) {
    try {
      const parsed = new URL(url);
      if (!/(^|\.)youtube\.com$/.test(parsed.hostname)) return null;
      if (parsed.pathname !== '/watch') return null;
      return parsed.searchParams.get('v') || null;
    } catch {
      return null;
    }
  },

  // "Is this word saved on this page?" cannot be a URL equality test any more:
  // every word saved from a video carries the moment it was said (`&t=`), so no
  // two saves of the same video share a URL. Comparing page keys instead folds
  // a video down to its id and an ordinary page down to its hash-less URL.
  pageKey(url) {
    if (!url) return null;
    const id = VT.youtubeId(url);
    if (id) return 'yt:' + id;
    try {
      const parsed = new URL(url);
      parsed.hash = '';
      return parsed.href;
    } catch {
      return url;
    }
  },

  // Seconds into the video the word was saved at. Null for a URL without a
  // `t=`, which is every source that did not come from a video.
  timestampOf(url) {
    try {
      const seconds = parseInt(new URL(url).searchParams.get('t'), 10);
      return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
    } catch {
      return null;
    }
  },

  // The word under a caret offset. Needed because YouTube's captions set
  // user-select:none, so there is no selection to read — a click resolves to a
  // caret position and the word has to be grown out of it in both directions.
  // Grabs the whole token deliberately, rather than only the characters
  // isLookupCandidate accepts: captions are full of contractions, and a class
  // that stopped at the apostrophe would turn "don't" into the real word "don"
  // and save it. Taking the token whole lets isLookupCandidate be the only
  // gate, so "don't", "caf\u00e9" and "covid19" are each rejected as a unit
  // and the click does nothing at all.
  wordAt(text, offset) {
    const str = String(text ?? '');
    if (!Number.isInteger(offset) || offset < 0 || offset > str.length) return null;
    const isWord = (ch) => /[\p{L}\p{N}'\u2019-]/u.test(ch ?? '');

    let start = offset;
    // A caret resting just past the last letter still belongs to that word:
    // clicking the right-hand half of a character puts it there.
    if (!isWord(str[start]) && isWord(str[start - 1])) start--;
    if (!isWord(str[start])) return null;

    while (isWord(str[start - 1])) start--;
    let end = start;
    while (isWord(str[end])) end++;
    // Hyphens and quotes are word characters inside a word but not at either
    // edge: a click on 'quoted' should give back quoted.
    return str.slice(start, end).replace(/^['\u2019-]+|['\u2019-]+$/g, '') || null;
  },

  // --- speed reading (RSVP) ---------------------------------------------
  //
  // Everything the reader needs that is not DOM: splitting prose into the
  // tokens it flashes, finding each token's focal letter, and deciding how
  // long to hold it. reader.js owns the page and the overlay; this owns the
  // arithmetic, so test/test.js can pin it.

  // Whitespace split, nothing else. Punctuation stays attached to its word:
  // the reader shows "winter." as one flash, and holdFor reads that full stop
  // to decide the pause. \s covers the non-breaking space prose is full of.
  tokenise(text) {
    return String(text ?? '').match(/\S+/g) ?? [];
  },

  // The Optimal Recognition Point: the letter the eye should land on, which is
  // slightly left of centre and moves further left as the word grows. This is
  // the whole reason RSVP works — the pivot is pinned to one spot on screen so
  // the eye never travels.
  //
  //   length 1 -> 0,  2-5 -> 1,  6-9 -> 2,  10-13 -> 3,  14+ -> 4
  //
  // which is Math.min(4, (n + 2) >> 2). Measured from the first LETTER, not
  // the first character: `"The` would otherwise put the focus on the quote
  // mark. Clamped, so an all-punctuation token ("—") cannot index past its end.
  pivotOf(token) {
    const str = String(token ?? '');
    const lead = /^[^\p{L}\p{N}]*/u.exec(str)[0].length;
    const core = str.slice(lead).replace(/[^\p{L}\p{N}]+$/u, '').length;
    if (!core) return 0;
    return Math.min(str.length - 1, lead + (core < 2 ? 0 : Math.min(4, (core + 2) >> 2)));
  },

  // Milliseconds to hold one token. A flat 60000/wpm reads like a metronome
  // and loses every sentence boundary; these are the pauses a real reader
  // takes anyway.
  //
  // The punctuation classes must look past a closing quote or bracket —
  // `(see above).` and `he said,"` are ordinary prose, not edge cases — and
  // they are else-if because a token cannot end in both.
  //
  // A long word AND a full stop compound to 2.6x. That is deliberate: the
  // longest words are where a reader most needs the extra beat.
  holdFor(token, baseMs, endsBlock) {
    const str = String(token ?? '');
    let ms = baseMs;
    if (str.length > 8) ms *= 1.3;
    if (/[.!?]['"’”)\]]*$/.test(str)) ms *= 2;
    else if (/[,;:]['"’”)\]]*$/.test(str)) ms *= 1.5;
    // The paragraph break is the biggest comprehension aid after being able to
    // step backwards: it is where you catch up on what you just read.
    if (endsBlock) ms *= 2.5;
    return Math.round(ms);
  },

  // A word captured from another Mac app arrives as whatever was selected,
  // which is a single word if you double-clicked one and a phrase if you
  // dragged. Returns { word, context } or null.
  //
  // For a phrase, the LONGEST candidate word wins rather than the first: the
  // word you stopped to look up is almost never "the", and length is the one
  // signal available without a dictionary call.
  captureWord(selection) {
    const text = String(selection ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return null;

    const candidates = VT.tokenise(text)
      .map((token) => VT.normaliseWord(token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')))
      .filter((word) => VT.isLookupCandidate(word));
    if (!candidates.length) return null;

    const word = candidates.reduce((a, b) => (b.length > a.length ? b : a));
    // A one-word selection carries no sentence; a phrase is its own context.
    const context = VT.tokenise(text).length > 1
      ? VT.sentenceAround(text, word) ?? text.slice(0, VT.MAX_CONTEXT)
      : null;
    return { word, context };
  },

  // A link back to the exact place the word was read, using Chrome's native
  // scroll-to-text-fragment (`#:~:text=`). The page needs no cooperation and
  // nothing extra is stored — the saved sentence is the anchor.
  //
  // A short window around the word rather than the whole sentence: the browser
  // must match the page's rendered text exactly, and the longer the snippet
  // the more likely some markup inside it (a link, an emphasis span) makes the
  // match fail. Roughly four words either side is distinctive enough to land
  // on the right occurrence without being brittle.
  sourceLink(url, context, word) {
    if (!url) return null;
    // Only a web page can be navigated back to. A word captured from Kindle or
    // Preview records the app it came from, which is not a link — rendering it
    // as one would give a dead anchor in the panel and the dashboard.
    let scheme = null;
    try { scheme = new URL(url).protocol; } catch { return null; }
    if (scheme !== 'http:' && scheme !== 'https:') return null;
    // A video URL already points at the moment the word was said. A text
    // fragment on top of that would match nothing — the caption is not in the
    // page's text — and Chrome would silently drop the whole link.
    if (VT.youtubeId(url)) return url;
    if (!context) return url;
    // A truncated context ends in an ellipsis that is not on the page.
    const clean = context.replace(/…$/, '').trim();
    const re = VT.wordRegex(word);
    re.lastIndex = 0;
    const match = re.exec(clean);
    if (!match) return url;

    const before = clean.slice(0, match.index).split(' ').filter(Boolean);
    const after = clean.slice(match.index + match[0].length).split(' ').filter(Boolean);
    const snippet = [
      ...before.slice(-VT.FRAGMENT_WORDS),
      match[0],
      ...after.slice(0, VT.FRAGMENT_WORDS)
    ].join(' ').trim();
    if (!snippet) return url;

    // Strip any fragment the saved URL already had: two #s would be invalid.
    const base = url.split('#')[0];
    return `${base}#:~:text=${encodeURIComponent(snippet)}`;
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
