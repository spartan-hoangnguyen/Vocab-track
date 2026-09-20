// Pure logic shared by the content script, the side panel and the test page.
// No Chrome API and no network here: everything in this file must be callable
// from test/test.html in a plain browser tab.
const VT = {
  // Storage caps. Entries are stored whole, and chrome.storage.local is
  // about 10MB, so these bound how much one word can cost.
  MAX_SENSES: 3,
  MAX_XREF: 6,
  MAX_CONTEXT: 220,
  FRAGMENT_WORDS: 4,

  // NFC, because a macOS Quick Action capture can hand back DECOMPOSED
  // Hangul: '책'.normalize('NFD') is three code points and compares unequal to
  // the one-code-point form, so the same word would be saved twice under two
  // keys. A no-op on Latin text, so English is unaffected.
  normaliseWord(raw) {
    return String(raw ?? '').trim().toLowerCase().normalize('NFC');
  },

  // Dispatched to the language the selection is written in. A script no pack
  // is registered for is not a candidate, so the button stays hidden rather
  // than offering a lookup nothing can answer.
  isLookupCandidate(raw) {
    return LANG.detect(raw)?.isCandidate(raw) ?? false;
  },

  // Every occurrence of `word` in `text`, as {index, length} ranges, found by
  // the rules of that word's language.
  //
  // Ranges rather than a RegExp — which is what this used to hand back — so
  // the seam can serve a language whose matching no regular expression can
  // express. It also ends the /g lastIndex hazard every caller had to
  // remember: a range list carries no cursor.
  //
  // `lang` is optional. Without it the script decides, which is what lets a
  // word saved before the field existed still match.
  find(word, text, lang) {
    return LANG.pick(lang, word).match(word, String(text ?? ''));
  },

  has(word, text, lang) {
    return VT.find(word, text, lang).length > 0;
  },

  // A text and its ranges as alternating pieces: [{ text, hit }]. Four places
  // mark a word inside its own sentence — the panel, the words view, the
  // review prompt and Fill the gap — and each used to walk the regex itself.
  // A hit piece carries the word as the TEXT spelled it, which is what lets a
  // blank be filled back in with the original capitalisation.
  pieces(text, ranges) {
    const str = String(text ?? '');
    const out = [];
    let at = 0;
    for (const range of ranges) {
      if (range.index > at) out.push({ text: str.slice(at, range.index), hit: false });
      out.push({ text: str.slice(range.index, range.index + range.length), hit: true });
      at = range.index + range.length;
    }
    if (at < str.length) out.push({ text: str.slice(at), hit: false });
    return out;
  },

  // Every occurrence replaced by one mark. Built on pieces, so it cannot
  // disagree with what the highlighter found.
  blank(text, ranges, mark = '\u2026') {
    return VT.pieces(text, ranges).map((piece) => (piece.hit ? mark : piece.text)).join('');
  },

  // The sentence in the page that the looked-up word appeared in, so a saved
  // word keeps the context that made it worth saving. Pure: the content
  // script hands in the surrounding block's text.
  sentenceAround(blockText, word, lang) {
    // NFC for the same reason normaliseWord does it, and HERE rather than in
    // match(): the word is already composed, so a DECOMPOSED haystack — a
    // macOS capture, a page serving NFD — matches nothing and the sentence is
    // silently dropped. This is the one place the fold is free: what this
    // returns IS the stored context, so nobody holds an index into the
    // pre-fold string. Folding inside match() would shift every m.index off
    // the caller's own text and corrupt the ranges it slices with.
    const text = String(blockText ?? '').replace(/\s+/g, ' ').trim().normalize('NFC');
    if (!text) return null;
    // Split after . ! ? followed by a space — deliberately naive. It can cut
    // an abbreviation ("Dr. Smith") in two; a wrong sentence boundary costs a
    // slightly odd quote, which is not worth a parser to avoid.
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      if (VT.has(word, sentence, lang)) {
        const trimmed = sentence.trim();
        return trimmed.length > VT.MAX_CONTEXT
          ? trimmed.slice(0, VT.MAX_CONTEXT).trimEnd() + '…'
          : trimmed;
      }
    }
    return null;
  },

  // A local calendar day as YYYY-MM-DD, for keys that sort by date.
  dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  // FSRS-6 with its default weights, ported from ts-fsrs
  // (packages/fsrs/src/algorithm.ts + constant.ts). Aimed at 90% recall, where
  // the next interval equals the stability. Left out on purpose: fuzz, and
  // Anki's minute-long learning steps — a lapse already comes back later in
  // the same session, which FSRS schedules as a same-day (short-term) review.
  FSRS_W: [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666,
    0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542],

  // quality is the review's 0..5: 0 Blank, 3 Hard, 4 Good, 5 Easy (below 3 is
  // a lapse). `reps` keeps its old meaning — correct answers in a row, reset
  // by a lapse — because mastery and the new-card queue read it.
  // `now` is a parameter so tests, and the "next to master" preview, can pin it.
  schedule(card, quality, now = Date.now()) {
    const w = VT.FSRS_W;
    const DAY = 24 * 60 * 60 * 1000;
    const g = quality >= 5 ? 4 : quality === 4 ? 3 : quality === 3 ? 2 : 1;
    const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
    const decay = -w[20];
    const factor = Math.pow(0.9, 1 / decay) - 1;
    const initD = (grade) => w[4] - Math.exp((grade - 1) * w[5]) + 1;

    let { stability: s, difficulty: d, lastReview } = card;
    const seen = card.reps > 0 || card.interval > 0;
    if (s == null && seen) {
      // A card scheduled by the old SM-2. At 90% recall the interval IS the
      // stability, so this keeps the schedule it already had.
      // ponytail: ease → difficulty is a straight line from SM-2's 2.5 (FSRS's
      // Good start) to its 1.3 floor (hardest); nothing to fit it against yet.
      s = Math.max(card.interval, 0.1);
      d = clamp(initD(3) + (2.5 - (card.ease ?? 2.5)) * ((10 - initD(3)) / 1.2), 1, 10);
      lastReview = (card.due ?? now) - card.interval * DAY;
    }

    let next;
    if (s == null) {
      next = { s: Math.max(w[g - 1], 0.1), d: clamp(initD(g), 1, 10) };
    } else {
      const t = Math.max(0, Math.floor((now - (lastReview ?? now)) / DAY));
      const r = Math.pow(1 + (factor * t) / s, decay);
      let ns;
      if (t === 0) {
        // Seen again the same day: FSRS's short-term update.
        const sinc = Math.pow(s, -w[19]) * Math.exp(w[17] * (g - 3 + w[18]));
        ns = s * (g >= 2 ? Math.max(sinc, 1) : sinc);
      } else if (g === 1) {
        const forget = w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1)
          * Math.exp((1 - r) * w[14]);
        ns = Math.min(s / Math.exp(w[17] * w[18]), forget);
      } else {
        ns = s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9])
          * (Math.exp((1 - r) * w[10]) - 1) * (g === 2 ? w[15] : 1) * (g === 4 ? w[16] : 1));
      }
      const nd = d + (-w[6] * (g - 3) * (10 - d)) / 9;
      next = {
        s: clamp(ns, 0.001, 36500),
        d: clamp(w[7] * initD(4) + (1 - w[7]) * nd, 1, 10)
      };
    }
    const interval = clamp(Math.round(next.s), 1, 36500);
    // Rounded so stored numbers stay short and stable across devices.
    return {
      stability: Math.round(next.s * 1e4) / 1e4,
      difficulty: Math.round(next.d * 1e4) / 1e4,
      interval,
      reps: g === 1 ? 0 : (card.reps ?? 0) + 1,
      lastReview: now,
      due: now + interval * DAY
    };
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
    //
    // ponytail: calibrated in Latin letters, and that shows on a short
    // Hangul answer — a two- or three-syllable word can never be graded
    // "almost", which dashboard.js's suggestedGrade turns straight into a 0
    // rather than a 3. The LCS also runs over composed NFC syllables, so one
    // wrong jamo reads as a whole-syllable miss. Upgrade path: a per-pack
    // `near` threshold, or decompose to jamo before the LCS.
    return { exact: false, near: wrong > 0 && wrong <= 2 && y.length >= 4,
             typed: typedMarks, answer: answerMarks };
  },

  // The gloss a quiz asks about: the Vietnamese, or the dictionary definition when
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

  // Anki's "mature": seen right three times running and spaced three weeks
  // out. The review's Mastery card counts these; nothing schedules off it.
  isMastered(entry) {
    return (entry?.reps ?? 0) >= 3 && (entry?.interval ?? 0) >= 21;
  },

  // Where a folder stands: learned (mastered), learning (seen at least once),
  // fresh (never reviewed). A lapse sets interval to 1, so a word you forgot
  // is still "learning", not new again. Skipped words are out of the count.
  progressOf(entries) {
    const out = { learned: 0, learning: 0, fresh: 0 };
    for (const e of entries) {
      if (!VT.isLearnable(e)) continue;
      if (VT.isMastered(e)) out.learned++;
      else if (!e.reps && !e.interval) out.fresh++;
      else out.learning++;
    }
    return out;
  },

  // Up to n folders worth opening now, each with the reason it was picked.
  // list is [{ folder, members }]; misses is practice's word → miss count.
  // ponytail: raw counts, so big folders win; weigh by folder size if small
  // folders never get suggested.
  suggestFolders(list, now, misses = {}, pinned = [], n = 3) {
    const scored = [];
    for (const { folder, members } of list) {
      if (pinned.includes(folder.id)) continue;
      const live = members.filter((e) => VT.isLearnable(e));
      const due = live.filter((e) => e.due <= now).length;
      const missed = live.reduce((sum, e) => sum + (misses[e.word] ?? 0), 0);
      const p = VT.progressOf(live);
      const score = due * 3 + missed * 2 + p.learning;
      if (!score) continue;
      const parts = [
        [due * 3, `${due} due today`],
        [missed * 2, `${missed} miss${missed === 1 ? '' : 'es'} in practice`],
        [p.learning, `${p.learning} in progress · ${Math.round((p.learned / live.length) * 100)}% learned`]
      ];
      const reason = parts.reduce((a, b) => (b[0] > a[0] ? b : a))[1];
      scored.push({ folder, reason, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, n)
      .map(({ folder, reason }) => ({ folder, reason }));
  },

  // Reviews per day for the next `days` days, split into words met for the
  // first time and words coming back. Each word is played forward through
  // the scheduler as if every answer were Good, so a word seen on day 2 is
  // counted again when it returns on day 4 — counting only the next due date
  // undercounts. Anything overdue lands on today. `start` is local midnight.
  // ponytail: all-Good is the optimistic case; lapses add a little on top.
  forecast(entries, start, days = 14) {
    const DAY = 24 * 60 * 60 * 1000;
    const out = Array.from({ length: days }, () => ({ fresh: 0, review: 0 }));
    const end = start + days * DAY;
    for (const entry of entries) {
      if (!VT.isLearnable(entry)) continue;
      let card = entry;
      // A cap, not a real bound: intervals are at least a day.
      for (let step = 0; step < days && card.due < end; step++) {
        const at = Math.max(card.due, start);
        const day = Math.floor((at - start) / DAY);
        const isNew = !card.reps && !card.interval;
        out[day][isNew ? 'fresh' : 'review']++;
        card = { ...card, ...VT.schedule(card, 4, at) };
      }
    }
    return out;
  },

  foldersOf(entry) {
    const ids = entry?.folders;
    return Array.isArray(ids) && ids.length ? ids : [VT.READING];
  },

  // Folder ids are generated, never derived from the name, so renaming a
  // folder cannot strand the words that point at it.
  newFolder(name, { color = 'sage', icon = '\u{1F4C1}', desc = '', lang = null } = {}) {
    return {
      id: 'f_' + Math.random().toString(36).slice(2, 10),
      name: String(name).trim(),
      color, icon, desc, lang,
      auto: false,
      added: Date.now()
    };
  },

  // Which language's session a folder belongs in, or null for "every one".
  //
  // Same shape as LANG.of for a word, and for the same reason: `lang` is a new
  // field, every folder already in storage predates it, and a migration that
  // rewrites someone's folders to add one is a worse idea than inferring it.
  // So: what it says, else what its words say, else everyone's.
  //
  // The inference reads ALL the words, not the active language's — the whole
  // point is to answer "whose folder is this" for a folder the current session
  // is filtering out, and a filtered list would say "nobody's" every time.
  //
  // Null covers three real cases and they all want the same answer. An `auto`
  // folder (From reading, Starred) collects in every language by definition. A
  // folder you just made is empty, and it must not vanish from the session you
  // made it in. And a folder holding both languages is genuinely both — hiding
  // it from either would strand the words inside it.
  //
  // Contents beat the stored `lang`, and the asymmetry with LANG.of is the
  // point: a word has exactly one language, so its field is the truth; a
  // folder can hold two, so its words are. The field only answers for a folder
  // with nothing in it to look at yet.
  //
  // Which matters because folderForName reuses a folder by NAME. Tag 책 with
  // Science in a Korean session and t_science is stamped 'ko'; tag
  // photosynthesis with Science later and it lands in that same folder. If the
  // stamp won, Science would be invisible in English from then on, with an
  // English word sitting inside it.
  folderLang(folder, entries) {
    if (!folder || folder.auto) return null;
    const langs = new Set((entries ?? []).map((e) => LANG.of(e).id));
    if (langs.size === 1) return [...langs][0];
    if (!langs.size) return folder.lang ?? null;
    return null;
  },

  // Does this folder belong on screen in `lang`'s session?
  inLang(folder, entries, lang) {
    const owner = VT.folderLang(folder, entries);
    return owner === null || owner === lang;
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

  // ponytail: this and pivotOf above are tuned to Latin and stay that way.
  // tokenise splits on whitespace, which Korean 어절 respect, and pivotOf's
  // classes are \p{L}-based, so neither breaks on Hangul — but the ORP formula
  // is calibrated to Latin letter widths, and the long-word beat below never
  // fires on an 어절, which is rarely over four characters. Upgrade path:
  // per-pack pivotOf/holdFor overrides. reader.js needs no edit either way.
  //
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
    // Composed before anything reads it, not just before sentenceAround: the
    // Quick Action hands back DECOMPOSED Hangul, and the context branch below
    // has a `?? text.slice()` fallback that bypasses sentenceAround's own fold
    // — the branch every NFD selection TOOK, back when match() could not find
    // the composed word in a decomposed sentence.
    const text = String(selection ?? '').replace(/\s+/g, ' ').trim().normalize('NFC');
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
  sourceLink(url, context, word, lang) {
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
    const [hit] = VT.find(word, clean, lang);
    if (!hit) return url;

    const before = clean.slice(0, hit.index).split(' ').filter(Boolean);
    const after = clean.slice(hit.index + hit.length).split(' ').filter(Boolean);
    const snippet = [
      ...before.slice(-VT.FRAGMENT_WORDS),
      clean.slice(hit.index, hit.index + hit.length),
      ...after.slice(0, VT.FRAGMENT_WORDS)
    ].join(' ').trim();
    if (!snippet) return url;

    // Strip any fragment the saved URL already had: two #s would be invalid.
    const base = url.split('#')[0];
    return `${base}#:~:text=${encodeURIComponent(snippet)}`;
  },

  // Median level across entries that have one. Reported instead of a
  // "mastered" count, which nothing in the data defines.
  //
  // The scale comes from the language, not from here: CEFR A1-C2 for English,
  // 초급/중급/고급 for Korean. `levels` is taken from the first entry's pack
  // when not given, which for a single-language list is the right one and for
  // a mixed list is the only sensible guess — the dashboard filters by
  // language before calling this, so it never sees a mixed list in practice.
  medianLevel(entries, levels) {
    const order = levels ?? LANG.of(entries[0] ?? {}).levels;
    const ranks = entries
      .map((e) => order.indexOf(e.level))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b);
    if (!ranks.length) return null;
    return order[ranks[Math.floor(ranks.length / 2)]];
  },

  // `lang` is the pack the word belongs to. Detected from the script when not
  // given, so a caller that predates languages — tools/ielts-parse.html, the
  // tests — keeps producing exactly what it did before.
  newEntry(word, parsed, vi, url, lang) {
    return {
      word,
      lang: lang ?? LANG.detect(word)?.id ?? LANG.FALLBACK,
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
      interval: 0,
      reps: 0,
      due: Date.now()   // due immediately, so a new word appears in the first review
    };
  }
};
