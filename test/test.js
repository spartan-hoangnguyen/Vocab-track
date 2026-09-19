let failures = 0;
const log = [];

function check(name, cond, detail) {
  if (cond) {
    log.push('PASS  ' + name);
  } else {
    failures++;
    log.push('FAIL  ' + name + (detail ? '  -> ' + detail : ''));
  }
}

function eq(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// --- normaliseWord
eq('normalise trims', VT.normaliseWord('  Resilient '), 'resilient');
eq('normalise lowercases', VT.normaliseWord('HAPPY'), 'happy');

// --- isLookupCandidate
check('accepts a plain word', VT.isLookupCandidate('resilient'));
check('accepts a hyphenated word', VT.isLookupCandidate('well-known'));
check('accepts mixed case', VT.isLookupCandidate('Ubiquitous'));
check('rejects two words', !VT.isLookupCandidate('very resilient'));
check('rejects a single letter', !VT.isLookupCandidate('a'));
check('rejects an empty string', !VT.isLookupCandidate(''));
check('rejects digits', !VT.isLookupCandidate('covid19'));
check('rejects punctuation', !VT.isLookupCandidate('resilient.'));
check('rejects over 40 chars', !VT.isLookupCandidate('a'.repeat(41)));

// --- wordRegex
const re = () => VT.wordRegex('cat');
check('matches the bare word', re().test('a cat sat'));
check('matches capitalised at sentence start', re().test('Cat sat'));
check('matches before punctuation', re().test('the cat.'));
check('matches possessive stem', re().test("the cat's bowl"));
check('does not match inside category', !re().test('category'));
check('does not match inside concatenate', !re().test('concatenate'));
check('does not match inside bobcat', !re().test('bobcat'));
eq('is global', VT.wordRegex('cat').global, true);

// --- isLearnable
check('a plain entry is learnable', VT.isLearnable({ word: 'cat' }));
check('skipped:false is learnable', VT.isLearnable({ word: 'cat', skipped: false }));
check('a skipped entry is not', !VT.isLearnable({ word: 'cat', skipped: true }));
check('nothing is not learnable either', !VT.isLearnable(undefined));

// --- glossOf / quizOptions
eq('gloss prefers the translation', VT.glossOf({ vi: 'con mèo', def: 'a small animal' }), 'con mèo');
eq('gloss falls back to the definition', VT.glossOf({ vi: null, def: 'a small animal' }), 'a small animal');
eq('gloss is null with neither', VT.glossOf({ vi: null, def: null }), null);
eq('gloss ignores whitespace-only', VT.glossOf({ vi: '   ' }), null);

// A fixed rand pins the shuffle, so these assertions are about content only.
const pinned = () => 0;
const q = (word, vi, level, folders) => ({ word, vi, level, folders });
const quizPool = [
  q('cat', 'con mèo', 'A1'),
  q('dog', 'con chó', 'A1'),
  q('bird', 'con chim', 'A1'),
  q('fish', 'con cá', 'A1'),
  q('ubiquitous', 'phổ biến khắp nơi', 'C2')
];

const opts = VT.quizOptions(quizPool[0], quizPool, pinned);
eq('a quiz has four options', opts.length, 4);
eq('exactly one is correct', opts.filter((o) => o.correct).length, 1);
eq('the correct option is the word\'s own gloss', opts.find((o) => o.correct).text, 'con mèo');
check('the word itself is never a distractor', !opts.some((o) => !o.correct && o.word === 'cat'));
eq('no two options read the same', new Set(opts.map((o) => o.text)).size, 4);
check('same-level distractors are preferred',
      !opts.some((o) => !o.correct && o.word === 'ubiquitous'),
      'a C2 gloss among A1 ones gives the answer away by register');

// Same gloss on two words would put two right-looking answers on screen.
const twins = [...quizPool, q('kitten', 'con mèo', 'A1'), q('puppy', 'con chó', 'A1')];
const twinOpts = VT.quizOptions(twins[0], twins, pinned);
eq('a duplicate of the answer is never offered', twinOpts.filter((o) => o.text === 'con mèo').length, 1);
eq('duplicate distractors collapse', new Set(twinOpts.map((o) => o.text)).size, 4);

check('too few glossed words means no quiz',
      VT.quizOptions(quizPool[0], [quizPool[0], quizPool[1], q('x', null, 'A1')], pinned) === null);
check('a word with no gloss cannot be quizzed',
      VT.quizOptions(q('blank', null, 'A1'), quizPool, pinned) === null);

// A folder shared with the entry counts as near; "From reading" does not,
// because foldersOf hands it to every word that was never filed.
const filed = [
  q('cat', 'con mèo', null, ['f_pets']),
  q('dog', 'con chó', null, ['f_pets']),
  q('bird', 'con chim', null, ['f_pets']),
  q('fish', 'con cá', null, ['f_pets']),
  q('ubiquitous', 'phổ biến khắp nơi', null, ['f_ielts'])
];
check('a shared folder makes a distractor near',
      !VT.quizOptions(filed[0], filed, pinned).some((o) => o.word === 'ubiquitous'));

// --- shuffled
const source = [1, 2, 3, 4, 5];
eq('shuffled keeps every item', VT.shuffled(source, pinned).slice().sort().join(), '1,2,3,4,5');
eq('shuffled does not touch the caller\'s array', source.join(), '1,2,3,4,5');

// --- parseCambridge, against real saved pages
async function fixture(name) {
  const res = await fetch(`fixtures/${name}.html`);
  return res.text();
}

async function parserTests() {
  const resilient = VT.parseCambridge(await fixture('resilient'));
  eq('resilient level', resilient.level, 'C2');
  eq('resilient ipa', resilient.ipa, 'rɪˈzɪl.i.ənt');
  eq('resilient def', resilient.def,
     'able to be happy, successful, etc. again after something difficult or bad has happened:');
  eq('resilient audio', resilient.audio,
     'https://dictionary.cambridge.org/media/english/uk_pron/u/ukr/ukres/ukresid009.mp3');

  const happy = VT.parseCambridge(await fixture('happy'));
  eq('happy level', happy.level, 'A1');
  eq('happy ipa', happy.ipa, 'ˈhæp.i');
  eq('happy def', happy.def, 'feeling, showing, or causing pleasure or satisfaction:');

  // The important case: a real entry with no CEFR level. "ubiquitous" is
  // outside the English Profile word list. A null level must not stop the
  // other three fields from parsing.
  const ubi = VT.parseCambridge(await fixture('ubiquitous'));
  eq('ubiquitous level is null', ubi.level, null);
  eq('ubiquitous ipa still parses', ubi.ipa, 'juːˈbɪk.wɪ.təs');
  eq('ubiquitous def still parses', ubi.def, 'seeming to be everywhere:');
  check('ubiquitous audio still parses', ubi.audio?.endsWith('.mp3'));

  // notfound.html: saved 2026-09-13 via
  // `curl -sL -A "Mozilla/5.0 ..." https://dictionary.cambridge.org/dictionary/english/zzqqxwv`
  // — the page Cambridge 302-redirects an unknown word to. It has no
  // `.entry-body__el`, but does carry a Word-of-the-Day promo block with its
  // own `.ipa` and `source[src$=".mp3"]`. All four fields must come back
  // null, proving the entry-scoped parse does not pick up that promo block.
  const notfound = VT.parseCambridge(await fixture('notfound'));
  eq('not-found level is null', notfound.level, null);
  eq('not-found ipa is null', notfound.ipa, null);
  eq('not-found def is null', notfound.def, null);
  eq('not-found audio is null', notfound.audio, null);

  // Garbage in, four nulls out. Never throws.
  const empty = VT.parseCambridge('<html><body>nothing here</body></html>');
  eq('empty level', empty.level, null);
  eq('empty ipa', empty.ipa, null);
  eq('empty def', empty.def, null);
  eq('empty audio', empty.audio, null);

  // --- diffWord
  const shown = (marks) => marks.map((m) => (m.ok ? m.text : `[${m.text}]`)).join('');

  const same = VT.diffWord('pigeon', 'pigeon');
  eq('diffWord: an exact answer is exact', same.exact, true);
  eq('diffWord: an exact answer is not also "near"', same.near, false);
  // Case and stray space are never what a vocabulary review is testing.
  eq('diffWord: case and space do not make it wrong', VT.diffWord('  PIGEON ', 'pigeon').exact, true);
  eq('diffWord: the typed text is echoed as typed, not lowercased',
     shown(VT.diffWord('  PIGEON ', 'pigeon').typed), '  PIGEON ');

  const slip = VT.diffWord('pidgeon', 'pigeon');
  eq('diffWord: one extra letter marks just that letter', shown(slip.typed), 'pi[d]geon');
  eq('diffWord: and leaves the answer unmarked', shown(slip.answer), 'pigeon');
  eq('diffWord: one letter out is near', slip.near, true);

  const missing = VT.diffWord('runing', 'running');
  eq('diffWord: a dropped letter is marked on the answer', shown(missing.answer), 'run[n]ing');
  eq('diffWord: and the typed word stays clean', shown(missing.typed), 'runing');

  // A transposition is two edits, which is the boundary `near` is drawn at.
  eq('diffWord: i-before-e is still near', VT.diffWord('recieve', 'receive').near, true);

  // Runs, not confetti: three consecutive wrong letters are one thing to look
  // at, so they must come back as one mark.
  const runs = VT.diffWord('pigeonxyz', 'pigeon');
  eq('diffWord: consecutive wrong letters collapse into one mark', shown(runs.typed), 'pigeon[xyz]');
  eq('diffWord: three letters out is not near', runs.near, false);

  const other = VT.diffWord('elephant', 'pigeon');
  eq('diffWord: a different word is not near', other.near, false);

  // Short answers are excluded from "near" deliberately: on a three-letter
  // word a single edit is a different word, not a slip.
  eq('diffWord: one edit on a 3-letter word is not near', VT.diffWord('cut', 'cat').near, false);
  eq('diffWord: the same edit on a longer word is', VT.diffWord('breed', 'bread').near, true);

  const blank = VT.diffWord('', 'pigeon');
  eq('diffWord: an empty answer marks the whole word missing', shown(blank.answer), '[pigeon]');
  eq('diffWord: and produces no typed marks at all', blank.typed.length, 0);
  eq('diffWord: an empty answer is not near', blank.near, false);
  eq('diffWord: null is treated as empty', VT.diffWord(null, 'pigeon').typed.length, 0);

  // --- schedule (FSRS-6). Expected numbers come from ts-fsrs 's own
  // FSRSAlgorithm.next_state with default parameters, run 2026-09-19.
  {
    const D = 24 * 60 * 60 * 1000;
    eq('FSRS: 21 default weights', VT.FSRS_W.length, 21);
    eq('FSRS: weights pinned to ts-fsrs defaults', VT.FSRS_W.join(),
       '0.212,1.2931,2.3065,8.2956,6.4133,0.8334,3.0194,0.001,1.8722,0.1666,0.796,1.4835,0.0614,0.2629,1.6483,0.6014,1.8729,0.5425,0.0912,0.0658,0.1542');
    const near = (x, want) => Math.abs(x - want) < 1e-3;

    // Good every time it is due: day 0, 2, 13 — mastered on the third review.
    let c = { reps: 0, interval: 0, due: 0 };
    const goods = [];
    let t = 0;
    for (let i = 0; i < 3; i++) {
      c = { ...c, ...VT.schedule(c, 4, t) };
      goods.push(c);
      t = c.due;
    }
    check('FSRS: Good ×3 matches ts-fsrs stability',
          near(goods[0].stability, 2.3065) && near(goods[1].stability, 10.9643) && near(goods[2].stability, 46.2802),
          goods.map((g) => g.stability).join());
    check('FSRS: and difficulty', near(goods[2].difficulty, 2.1043), String(goods[2].difficulty));
    eq('FSRS: intervals are the rounded stability', goods.map((g) => g.interval).join(), '2,11,46');
    eq('FSRS: reps still counts correct answers in a row', goods[2].reps, 3);
    check('FSRS: three Goods on time master a word', VT.isMastered(goods[2]) && !VT.isMastered(goods[1]));

    const first = (q) => VT.schedule({ reps: 0, interval: 0 }, q, 0);
    check('FSRS: Easy > Good > Hard > Blank on a new word',
          first(5).stability > first(4).stability && first(4).stability > first(3).stability
          && first(3).stability > first(0).stability);
    check('FSRS: Hard is not a lapse', first(3).reps === 1);

    const lapse = VT.schedule({ stability: 30, difficulty: 5, lastReview: 0, reps: 4, interval: 30 }, 0, 30 * D);
    check('FSRS: a lapse after 30 days matches ts-fsrs',
          near(lapse.stability, 2.324) && near(lapse.difficulty, 8.3418), JSON.stringify(lapse));
    eq('FSRS: a lapse resets reps', lapse.reps, 0);

    // Blank, then right later the same session: the short-term update.
    const again = VT.schedule({ stability: 0.212, difficulty: 6, lastReview: 0, reps: 0, interval: 1 }, 4, 3600e3);
    check('FSRS: a same-day review uses the short-term update',
          near(again.stability, 0.2467) && again.interval === 1, JSON.stringify(again));

    // A card the old SM-2 scheduled: its interval becomes its stability, so
    // it is reviewed as if nothing changed, and its reps keep counting.
    const old = { ease: 2.2, interval: 15, reps: 3, due: 100 * D };
    const moved = VT.schedule(old, 4, 100 * D);
    check('FSRS: an SM-2 card carries on from its interval',
          moved.interval > 15 && moved.reps === 4 && moved.stability > 15, JSON.stringify(moved));
    check('FSRS: a harder SM-2 card starts harder',
          VT.schedule({ ...old, ease: 1.3 }, 4, 100 * D).difficulty > moved.difficulty);
    check('FSRS: due is interval days after the review',
          moved.due === 100 * D + moved.interval * D && moved.lastReview === 100 * D);
    eq('dayKey is the local date', VT.dayKey(new Date(2026, 0, 5, 23, 59).getTime()), '2026-01-05');
  }

  // --- forecast: every return inside the window counts, not just the next one
  {
    const D = 24 * 60 * 60 * 1000;
    const load = VT.forecast([
      { word: 'n', reps: 0, interval: 0, due: -3 * D },   // new and overdue: today
      { word: 'r', reps: 3, interval: 10, stability: 10, difficulty: 5, lastReview: -5 * D, due: 5 * D },
      { word: 's', reps: 0, interval: 0, due: 0, skipped: true }
    ], 0, 14);
    eq('forecast: 14 days', load.length, 14);
    eq('forecast: an overdue new word is today, as new', JSON.stringify(load[0]), '{"fresh":1,"review":0}');
    eq('forecast: a new word Good today returns on day 2, then day 13',
       [2, 13].map((d) => load[d].review).join(), '1,1');
    eq('forecast: a review lands on its due day', load[5].review, 1);
    eq('forecast: skipped words are left out, and nothing else is counted',
       load.reduce((n, d) => n + d.fresh + d.review, 0), 4);
  }

  // --- newEntry
  const entry = VT.newEntry('resilient', { level: 'C2', ipa: 'x', def: 'y', audio: null },
                            'kiên cường', 'https://example.com/a');
  eq('entry word', entry.word, 'resilient');
  eq('entry level', entry.level, 'C2');
  eq('entry vi', entry.vi, 'kiên cường');
  eq('entry sources', entry.sources.length, 1);
  eq('entry starts at reps 0', entry.reps, 0);
  check('entry is due immediately', entry.due <= Date.now());

  // --- folders: membership lives on the word, and pre-folder entries have none
  eq('foldersOf defaults to reading', VT.foldersOf({ word: 'old' })[0], VT.READING);
  eq('foldersOf defaults on empty array', VT.foldersOf({ folders: [] })[0], VT.READING);
  eq('foldersOf keeps explicit ids', VT.foldersOf({ folders: ['f_1', 'f_2'] }).join(), 'f_1,f_2');
  check('newEntry starts in From reading',
        VT.foldersOf(VT.newEntry('x', { level: null, ipa: null, def: null, audio: null }, null, 'u'))
          .includes(VT.READING));

  const folder = VT.newFolder('  Academic writing  ');
  eq('newFolder trims the name', folder.name, 'Academic writing');
  check('newFolder id is generated, not derived', folder.id.startsWith('f_') && folder.id.length > 2);
  check('newFolder ids are unique', VT.newFolder('a').id !== VT.newFolder('a').id);
  eq('newFolder is not auto', folder.auto, false);

  // --- preset topics: fixed ids, so picking one twice is one folder
  const topicIds = VT.TOPICS.map((t) => t.id);
  eq('preset topic ids are unique', new Set(topicIds).size, topicIds.length);
  check('preset topic ids cannot collide with generated or built-in ones',
        topicIds.every((id) => id.startsWith('t_') && id !== VT.READING));
  check('every preset topic has a name and an icon', VT.TOPICS.every((t) => t.name && t.icon));

  // --- progressOf: learned / learning / new, skipped words left out
  eq('progressOf splits learned, learning and new',
     JSON.stringify(VT.progressOf([
       { reps: 0, interval: 0 },                 // never reviewed
       { reps: 0, interval: 1 },                 // a lapse: still learning
       { reps: 2, interval: 6 },
       { reps: 4, interval: 30 },                // mastered
       { reps: 4, interval: 30, skipped: true }  // out of rotation
     ])), JSON.stringify({ learned: 1, learning: 2, fresh: 1 }));

  // --- suggestFolders: due, misses and half-done folders; pins and idle folders left out
  {
    const now = Date.now();
    const f = (id) => ({ id, name: id });
    const w = (word, extra) => ({ word, reps: 0, interval: 0, due: now + 1e9, ...extra });
    const list = [
      { folder: f('due'), members: [w('a', { due: now - 1 }), w('b', { due: now - 1 })] },
      { folder: f('missed'), members: [w('c')] },
      { folder: f('half'), members: [w('d', { reps: 1, interval: 1 }), w('e', { reps: 4, interval: 30 })] },
      { folder: f('idle'), members: [w('f')] },
      { folder: f('pinned'), members: [w('g', { due: now - 1 })] }
    ];
    const got = VT.suggestFolders(list, now, { c: 1 }, ['pinned']);
    eq('suggestFolders ranks by score and skips pinned and idle folders',
       got.map((s) => s.folder.id).join(), 'due,missed,half');
    eq('each suggestion says why', got.map((s) => s.reason).join(' | '),
       '2 due today | 1 miss in practice | 1 in progress · 50% learned');
    eq('suggestFolders stops at n', VT.suggestFolders(list, now, { c: 1 }, [], 2).length, 2);
  }

  // --- medianLevel: ignores entries with no level, never throws on an empty set
  eq('median of one level', VT.medianLevel([{ level: 'B2' }]), 'B2');
  eq('median ignores nulls', VT.medianLevel([{ level: null }, { level: 'C1' }, { level: null }]), 'C1');
  eq('median picks the middle',
     VT.medianLevel([{ level: 'A1' }, { level: 'B2' }, { level: 'C2' }]), 'B2');
  eq('median of nothing is null', VT.medianLevel([]), null);
  eq('median of only-null levels is null', VT.medianLevel([{ level: null }]), null);

  // --- richer parse fields, read from the same three fixtures
  const rich = VT.parseCambridge(await fixture('resilient'));
  eq('resilient part of speech', rich.pos, 'adjective');
  eq('resilient US ipa', rich.ipaUs, 'rɪˈzɪl.jənt');
  check('resilient US audio is a cambridge mp3', rich.audioUs?.startsWith(VT.CAMBRIDGE));
  check('resilient US audio differs from UK', rich.audioUs !== rich.audio);
  eq('resilient sense count', rich.senses.length, 2);
  eq('resilient first example', rich.senses[0].example,
     "She's a resilient girl - she won't be unhappy for long.");
  eq('resilient related words', rich.related.join(), 'resilience');
  // Synonyms come from two sources merged: the sparse .xref.synonym
  // cross-reference and the richer .daccord thesaurus block.
  eq('resilient synonyms', rich.synonyms.join(), 'strong,powerful,muscular,muscled');
  check('synonyms are deduplicated',
        new Set(rich.synonyms).size === rich.synonyms.length);
  check('a word is never its own synonym',
        !rich.synonyms.some((w) => w.toLowerCase() === 'resilient'));

  const happyRich = VT.parseCambridge(await fixture('happy'));
  eq('happy grammar label', happyRich.gram, '[ before noun ]');
  eq('happy sense count', happyRich.senses.length, 3);
  check('every parsed sense has a definition', happyRich.senses.every((s) => s.def));

  const ubiRich = VT.parseCambridge(await fixture('ubiquitous'));
  eq('ubiquitous synonym', ubiRich.synonyms.join(), 'omnipresent');
  eq('happy synonyms', happyRich.synonyms.join(), 'cheerful,in a good mood,pleased,glad');
  check('synonyms are capped', rich.synonyms.length <= VT.MAX_XREF);
  // Top-level level/def still describe the first sense, so entries saved
  // before senses existed keep rendering identically.
  eq('top-level def still mirrors sense 0', ubiRich.def, ubiRich.senses[0].def);

  // Caps exist because every sense is stored per word against a ~10MB quota.
  check('senses are capped', VT.MAX_SENSES <= 5 && rich.senses.length <= VT.MAX_SENSES);

  // A page with no entry yields nulls and empty lists, never a throw.
  const none = VT.parseCambridge('<html><body>nothing</body></html>');
  eq('no-entry page has null pos', none.pos ?? null, null);
  eq('no-entry page has no senses', (none.senses ?? []).length, 0);
  eq('no-entry page has no synonyms', (none.synonyms ?? []).length, 0);

  // --- sentenceAround: the line from the page that the word appeared in
  const para = 'The system failed. Engineers called it resilient anyway! Then it fell over.';
  eq('picks the sentence containing the word',
     VT.sentenceAround(para, 'resilient'), 'Engineers called it resilient anyway!');
  eq('picks the first sentence when the word is there',
     VT.sentenceAround(para, 'system'), 'The system failed.');
  eq('null when the word is absent', VT.sentenceAround(para, 'banana'), null);
  eq('null on empty input', VT.sentenceAround('', 'x'), null);
  eq('null on missing input', VT.sentenceAround(null, 'x'), null);
  // Word-bounded, like the highlighter: a substring match is not the sentence.
  eq('does not match inside a longer word',
     VT.sentenceAround('Category theory is fun.', 'cat'), null);
  eq('collapses whitespace',
     VT.sentenceAround('  The   word\n\nis   here.  ', 'word'), 'The word is here.');
  const long = VT.sentenceAround('x '.repeat(200) + 'resilient end.', 'resilient');
  eq('long context is capped', long.length, VT.MAX_CONTEXT);
  check('capped context is marked with an ellipsis', long.endsWith('…'));

  // --- sourceLink: jump back to the exact spot on the page
  // Deliberately more than FRAGMENT_WORDS on each side, so the window test bites.
  const CTX = 'Against every forecast the global supply chains proved unusually resilient through the long winter, despite three separate shocks hitting at once.';
  const link = VT.sourceLink('https://example.com/a', CTX, 'resilient');
  check('builds a text fragment', link.includes('#:~:text='));
  check('fragment contains the word', decodeURIComponent(link).includes('resilient'));
  check('fragment is a window, not the whole sentence',
        !decodeURIComponent(link).includes('Against every forecast'));
  check('window keeps the words nearest the match',
        decodeURIComponent(link).includes('proved unusually resilient through'));
  eq('fragment window size',
     decodeURIComponent(link.split('#:~:text=')[1]).split(' ').length, VT.FRAGMENT_WORDS * 2 + 1);
  eq('no url means no link', VT.sourceLink(null, CTX, 'x'), null);
  eq('no context falls back to the plain url',
     VT.sourceLink('https://example.com/a', null, 'x'), 'https://example.com/a');
  eq('word absent from context falls back to the plain url',
     VT.sourceLink('https://example.com/a', CTX, 'banana'), 'https://example.com/a');
  // A truncated context ends in an ellipsis that does not exist on the page.
  check('ellipsis is never part of the fragment',
        !decodeURIComponent(VT.sourceLink('https://e.com', 'a b resilient c d…', 'resilient'))
          .includes('…'));
  // The saved URL may already carry a fragment; two would be invalid.
  check('existing fragment is replaced, not appended',
        VT.sourceLink('https://e.com/p#section', CTX, 'resilient').split('#').length === 2);

  // --- youtubeId
  const WATCH = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=94s';
  eq('reads the video id', VT.youtubeId(WATCH), 'dQw4w9WgXcQ');
  eq('ignores list, index and friends',
     VT.youtubeId('https://www.youtube.com/watch?v=abc123&list=PL9&index=4&pp=xyz'), 'abc123');
  eq('a channel page is not a watch page',
     VT.youtubeId('https://www.youtube.com/@someone'), null);
  eq('the youtube home page is not a watch page',
     VT.youtubeId('https://www.youtube.com/'), null);
  eq('a watch url with no v is not a video',
     VT.youtubeId('https://www.youtube.com/watch?list=PL9'), null);
  eq('another host is never a video', VT.youtubeId('https://example.com/watch?v=abc'), null);
  // The regex must anchor the host: notyoutube.com is a different site.
  eq('a lookalike host is not youtube',
     VT.youtubeId('https://notyoutube.com/watch?v=abc'), null);
  eq('a subdomain still is', VT.youtubeId('https://m.youtube.com/watch?v=abc'), 'abc');
  eq('a non-url is not a video', VT.youtubeId('not a url'), null);

  // --- pageKey: the same video at different moments is the same page
  eq('two moments in one video share a key',
     VT.pageKey('https://www.youtube.com/watch?v=abc&t=12s'),
     VT.pageKey('https://www.youtube.com/watch?v=abc&t=300s'));
  check('two different videos do not',
        VT.pageKey('https://www.youtube.com/watch?v=abc&t=12s') !==
        VT.pageKey('https://www.youtube.com/watch?v=xyz&t=12s'));
  eq('a playlist does not change the key',
     VT.pageKey('https://www.youtube.com/watch?v=abc&list=PL9&index=2'),
     VT.pageKey('https://www.youtube.com/watch?v=abc'));
  eq('an ordinary page keys on its url',
     VT.pageKey('https://example.com/a'), 'https://example.com/a');
  eq('a text fragment does not change an ordinary key',
     VT.pageKey('https://example.com/a#:~:text=hello'), 'https://example.com/a');
  check('a query string still does',
        VT.pageKey('https://example.com/a?p=1') !== VT.pageKey('https://example.com/a'));
  eq('no url means no key', VT.pageKey(null), null);

  // --- timestampOf
  eq('reads the seconds', VT.timestampOf(WATCH), 94);
  eq('zero is a real timestamp',
     VT.timestampOf('https://www.youtube.com/watch?v=abc&t=0s'), 0);
  eq('no t means no timestamp', VT.timestampOf('https://www.youtube.com/watch?v=abc'), null);
  eq('an ordinary page has no timestamp', VT.timestampOf('https://example.com/a'), null);
  eq('a non-url has no timestamp', VT.timestampOf('nonsense'), null);

  // --- wordAt: clicking a caption, where there is no selection to read
  const LINE = 'the supply chains proved well-known and resilient';
  eq('caret inside a word', VT.wordAt(LINE, 6), 'supply');
  eq('caret at the first letter', VT.wordAt(LINE, 4), 'supply');
  eq('caret just past the last letter', VT.wordAt(LINE, 10), 'supply');
  eq('caret at the very start', VT.wordAt(LINE, 0), 'the');
  eq('caret at the very end', VT.wordAt(LINE, LINE.length), 'resilient');
  eq('a hyphenated word comes back whole', VT.wordAt(LINE, 27), 'well-known');
  eq('caret on a space between words', VT.wordAt('a  b', 2), null);
  eq('trailing punctuation is not part of the word', VT.wordAt('resilient, truly', 3), 'resilient');
  eq('an edge hyphen is trimmed', VT.wordAt('a -- b', 3), null);
  // A whole token, not just the letters isLookupCandidate would accept:
  // slicing at the apostrophe would turn "don't" into the real word "don" and
  // save that instead of doing nothing.
  eq("a contraction comes back whole", VT.wordAt("I don't know", 4), "don't");
  check("a contraction is not a lookup candidate", !VT.isLookupCandidate("don't"));
  eq('a curly apostrophe too', VT.wordAt('I don\u2019t know', 4), 'don\u2019t');
  eq('an accented word comes back whole', VT.wordAt('caf\u00e9 au lait', 1), 'caf\u00e9');
  check('an accented word is not a lookup candidate', !VT.isLookupCandidate('caf\u00e9'));
  eq('a word with digits comes back whole', VT.wordAt('covid19 spread', 2), 'covid19');
  check('a word with digits is not a lookup candidate', !VT.isLookupCandidate('covid19'));
  eq('edge quotes are trimmed', VT.wordAt("'quoted' word", 3), 'quoted');
  eq('empty text has no word', VT.wordAt('', 0), null);
  eq('null text has no word', VT.wordAt(null, 0), null);
  eq('an offset past the end has no word', VT.wordAt('abc', 9), null);
  eq('a negative offset has no word', VT.wordAt('abc', -1), null);

  // --- sourceLink: a video link is already a position
  eq('a video url is returned untouched', VT.sourceLink(WATCH, CTX, 'resilient'), WATCH);
  check('a video url never gets a text fragment',
        !VT.sourceLink(WATCH, 'the chains proved resilient', 'resilient').includes('#:~:text='));

  // --- tokenise
  eq('splits on whitespace', VT.tokenise('a b c').length, 3);
  eq('collapses runs of whitespace', VT.tokenise('a   b\n\n c').length, 3);
  eq('punctuation stays with its word', VT.tokenise('the winter.')[1], 'winter.');
  eq('a non-breaking space splits', VT.tokenise('a b').length, 2);
  eq('leading whitespace makes no empty token', VT.tokenise('   a')[0], 'a');
  eq('empty text tokenises to nothing', VT.tokenise('').length, 0);
  eq('null tokenises to nothing', VT.tokenise(null).length, 0);

  // --- pivotOf: the table every RSVP reader uses
  eq('pivot of a 1-letter word', VT.pivotOf('a'), 0);
  eq('pivot at the 2 boundary', VT.pivotOf('in'), 1);
  eq('pivot at the 5 boundary', VT.pivotOf('tree.'.slice(0, 5)), 1);
  eq('pivot at 5 letters', VT.pivotOf('trees'), 1);
  eq('pivot at the 6 boundary', VT.pivotOf('winter'), 2);
  eq('pivot at the 9 boundary', VT.pivotOf('resilient'), 2);
  eq('pivot at the 10 boundary', VT.pivotOf('resilience'), 3);
  eq('pivot at the 13 boundary', VT.pivotOf('extraordinary'), 3);
  eq('pivot at the 14 boundary', VT.pivotOf('extraordinarily'.slice(0, 14)), 4);
  eq('pivot never past 4', VT.pivotOf('antidisestablishmentarianism'), 4);
  // A leading quote must not steal the focus letter.
  eq('leading punctuation is skipped', VT.pivotOf('"The'), 2);
  eq('and the word underneath still decides', VT.pivotOf('"resilient"'), 3);
  // Trailing punctuation is not part of the word for sizing purposes.
  eq('trailing punctuation does not lengthen', VT.pivotOf('winter.'), VT.pivotOf('winter'));
  // An all-punctuation token must not index past its own end.
  eq('an em dash has a valid pivot', VT.pivotOf('—'), 0);
  eq('empty token has a valid pivot', VT.pivotOf(''), 0);
  check('pivot is always inside the token', ['a', 'in', '—', '"The', 'x.'].every(
    (t) => VT.pivotOf(t) >= 0 && (t.length === 0 || VT.pivotOf(t) < t.length)));

  // --- holdFor
  const BASE = 200;   // 300 wpm
  eq('a plain word holds the base', VT.holdFor('winter', BASE, false), 200);
  eq('a long word holds longer', VT.holdFor('resilience', BASE, false), 260);
  eq('a comma holds half again', VT.holdFor('winter,', BASE, false), 300);
  eq('a full stop holds double', VT.holdFor('winter.', BASE, false), 400);
  // The closing-quote class is the point: `said,"` and `(above).` are prose.
  eq('a full stop behind a bracket still counts',
     VT.holdFor('(above).', BASE, false), VT.holdFor('above.', BASE, false));
  eq('a comma behind a quote still counts', VT.holdFor('said,"', BASE, false), 300);
  eq('a curly close-quote counts too', VT.holdFor('said.”', BASE, false), 400);
  // else-if, not two ifs: a token cannot end in both.
  eq('long word and full stop compound', VT.holdFor('resilience.', BASE, false), 520);
  eq('a paragraph break holds longest', VT.holdFor('winter', BASE, true), 500);
  eq('a question mark is a sentence end', VT.holdFor('why?', BASE, false), 400);
  eq('a mid-word hyphen is not punctuation', VT.holdFor('well-known', BASE, false), 260);

  // --- captureWord: text selected in some other Mac app
  eq('a single selected word is the word', VT.captureWord('resilient').word, 'resilient');
  eq('a single word carries no context', VT.captureWord('resilient').context, null);
  eq('surrounding whitespace is trimmed', VT.captureWord('  ubiquitous \n').word, 'ubiquitous');
  eq('trailing punctuation is stripped', VT.captureWord('resilient.').word, 'resilient');
  eq('quotes around a word are stripped', VT.captureWord('"resilient"').word, 'resilient');
  // A phrase: the longest candidate, not the first — nobody looks up "the".
  eq('a phrase yields its longest word',
     VT.captureWord('the resilient supply chains').word, 'resilient');
  check('a phrase keeps itself as context',
        VT.captureWord('the resilient supply chains').context.includes('supply chains'));
  eq('a phrase with no real word is rejected', VT.captureWord('42 -- 7'), null);
  eq('empty selection is rejected', VT.captureWord(''), null);
  eq('whitespace-only selection is rejected', VT.captureWord('   '), null);
  eq('null selection is rejected', VT.captureWord(null), null);
  // Long selections are capped the same way a page context is — sentenceAround
  // truncates at MAX_CONTEXT and then adds the ellipsis, so the cap is +1.
  const longCap = VT.captureWord('resilient ' + 'padding '.repeat(200)).context;
  check('a very long selection is capped', longCap.length <= VT.MAX_CONTEXT + 1, String(longCap.length));
  check('and marked as truncated', longCap.endsWith('…'));

  // --- sourceLink only links things a browser can open
  eq('a mac app source is not a link', VT.sourceLink('macos:Kindle', 'a resilient b', 'resilient'), null);
  eq('a non-url source is not a link', VT.sourceLink('Preview', null, 'x'), null);
  eq('a file url is not a link', VT.sourceLink('file:///Users/me/a.pdf', null, 'x'), null);
  check('an http url still links', VT.sourceLink('http://e.com/a', null, 'x') === 'http://e.com/a');

  // --- source guard: the Cambridge fetch must not send cookies
  // Not a behaviour test (the fetch needs Chrome), but this option is a
  // one-word deletion away from a silent 403 on every lookup, so it is worth
  // pinning where a test run will catch it. Comments are stripped first: the
  // comment justifying the option also contains the string, and matching that
  // made an earlier version of this check pass with the option deleted.
  const lookupSrc = await (await fetch('../lookup.js?t=' + Date.now())).text();
  const cambridgeFn = lookupSrc.slice(lookupSrc.indexOf('async function fetchCambridge'),
                                      lookupSrc.indexOf('async function fetchVietnamese'));
  const cambridgeCode = cambridgeFn.replace(/^\s*\/\/.*$/gm, '');
  check('cambridge fetch omits credentials', /credentials:\s*'omit'/.test(cambridgeCode),
        'Cambridge 403s when Chrome attaches cookies to this cross-origin fetch');

  document.getElementById('out').textContent =
    log.join('\n') + `\n\n${failures} failure(s), ${log.length} check(s)`;
}
parserTests();
