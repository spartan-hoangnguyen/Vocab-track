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

// --- VT.find / VT.has  (what wordRegex became)
const hit = (text) => VT.has('cat', text);
check('matches the bare word', hit('a cat sat'));
check('matches capitalised at sentence start', hit('Cat sat'));
check('matches before punctuation', hit('the cat.'));
check('matches possessive stem', hit("the cat's bowl"));
check('does not match inside category', !hit('category'));
check('does not match inside concatenate', !hit('concatenate'));
check('does not match inside bobcat', !hit('bobcat'));
eq('finds every occurrence', VT.find('cat', 'cat, Cat and CAT').length, 3);
eq('a range points at the word',
   VT.find('cat', 'a cat sat')[0].index, 2);
eq('a range carries its length', VT.find('cat', 'a cat sat')[0].length, 3);
// The hazard the old /g regex had: a reused object kept lastIndex, so the
// second call silently started mid-string. A range list carries no cursor —
// but "call it twice, get the same count" cannot prove that, because a /g
// regex run to exhaustion resets lastIndex to 0 on the exec that returns
// null. It passes whether or not the object is shared, which is no test.
//
// What a stale cursor would actually corrupt is the ranges themselves, and
// pieces() is where that shows: it slices the text on them in order, so a
// range that is off by even one drops or duplicates a character. Asserting
// the round-trip is exact catches the whole class, cursor or arithmetic.
const many = 'cat, Cat and CAT';
const spans = VT.find('cat', many);
eq('ranges come back in ascending order and do not overlap',
   spans.every((r, i) => i === 0 || r.index >= spans[i - 1].index + spans[i - 1].length),
   true);
eq('pieces reassembles the text exactly, so no range is off by one',
   VT.pieces(many, spans).map((p) => p.text).join(''), many);
eq('and every hit piece is the word as the text spelled it',
   VT.pieces(many, spans).filter((p) => p.hit).map((p) => p.text).join('|'),
   'cat|Cat|CAT');
// Interleaved with a different search, which is what a shared cursor would
// break: the second call must not start where the first one left off.
eq('a search in between does not move the next one',
   (VT.find('sat', 'a cat sat'), VT.find('cat', many).length), 3);

// --- VT.pieces / VT.blank
const pieces = VT.pieces('a Cat sat', VT.find('cat', 'a Cat sat'));
eq('pieces round-trip the text', pieces.map((x) => x.text).join(''), 'a Cat sat');
eq('the hit keeps the text spelling',
   pieces.filter((x) => x.hit).map((x) => x.text).join(), 'Cat');
eq('blank replaces every occurrence',
   VT.blank('a cat and a Cat', VT.find('cat', 'a cat and a Cat')), 'a \u2026 and a \u2026');
eq('blank leaves a text with no hit alone',
   VT.blank('a dog', VT.find('cat', 'a dog')), 'a dog');

// --- the language registry
eq('English is detected from Latin script', LANG.detect('resilient')?.id, 'en');
eq('an unknown script detects as nothing', LANG.detect('\u4e2d\u6587'), null);
eq('a word with no lang falls back to English', LANG.of({ word: 'cat' }).id, 'en');
eq('an explicit lang wins', LANG.pick('en', '\uCC45').id, 'en');
eq('normalise folds NFD to NFC',
   VT.normaliseWord('\uCC45'.normalize('NFD')), '\uCC45');
// Every registered pack, not 'en' by name. A selfTest that is never invoked
// is worse than none — the suite would go green while saying nothing at all
// about the pack — so a new lang/<id>/ is covered the moment it is loaded,
// with no edit here. row[2] is the pack's own detail (what it actually
// produced), which is the only way to read a failure out of ~80 vectors
// behind one aggregate check.
for (const pack of LANG.list()) {
  const rows = pack.selfTest();
  check(`the ${pack.id} pack self-tests clean`,
        rows.every((row) => row[1]),
        rows.filter((row) => !row[1])
            .map((row) => (row[2] ? `${row[0]} [${row[2]}]` : row[0])).join('; '));
}

// --- two packs loaded at once, which is the state that only exists now.
// Script routing has to separate them in both directions, because nothing
// that calls resolveWord passes a langId.
eq('Hangul is detected as Korean', LANG.detect('책')?.id, 'ko');
eq('Latin is still detected as English', LANG.detect('cat')?.id, 'en');
eq('a Korean word with no lang routes to the Korean pack',
   LANG.of({ word: '책' }).id, 'ko');
// VT.find through the registry: the eojeol, not the bare lemma, and at the
// offset the original string has it.
const koHit = VT.find('책', '나는 책을 읽었다');
eq('find locates a Korean word behind its particle', koHit.length, 1);
eq('and the range covers the whole eojeol',
   '나는 책을 읽었다'.slice(koHit[0].index, koHit[0].index + koHit[0].length),
   '책을');
// The packs must not bleed: an English word run over Korean text goes to the
// English pack (Latin script) and finds nothing, rather than throwing.
eq('an English word does not match Korean text',
   VT.find('cat', '나는 책을 읽었다').length, 0);
eq('a Korean word does not match English text',
   VT.find('책', 'the cat sat').length, 0);

// --- what the packs carry for the UI: the voices and the inflection list.
// Both are register() defaults for every pack that says nothing, which is what
// keeps a new language from having to know these exist.
eq('English offers the two accents Cambridge records',
   LANG.get('en').voices.map((v) => `${v.id}:${v.bcp47}`).join(), 'uk:en-GB,us:en-US');
eq('Korean names its region, so the utterance is not a bare language match',
   LANG.get('ko').voices.map((v) => `${v.id}:${v.bcp47}`).join(), 'std:ko-KR');
check('every pack has at least one voice, so voices[0] is always a fallback',
      LANG.list().every((pack) => pack.voices.length >= 1
        && pack.voices.every((v) => v.id && v.bcp47)));
check('English inflects a verb for practice-speak',
      ['accelerates', 'accelerating', 'accelerated']
        .every((f) => LANG.get('en').inflections('accelerate').includes(f)),
      LANG.get('en').inflections('accelerate').join());
// The registry default. A pack that does not inflect the word it is looking
// for writes nothing and gets the identity.
eq('a pack with no morphology inflects to itself',
   LANG.get('ko').inflections('책').join(), '책');
// Pins what practice-speak's longest-form-first ordering is NOT load-bearing
// for: en.match is word-bounded, so a form can only hit where it stands alone.
eq('an inflected form does not match the bare word',
   LANG.get('en').match('accelerate', 'The car accelerates').length, 0);

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

// --- the English dictionary parser, against real saved API responses.
// The source is the Free Dictionary API now, so the fixtures are saved JSON
// rather than saved HTML — the Cambridge scrape 403s from an extension.
async function fixtureJson(name) {
  const res = await fetch(`fixtures/${name}.json`);
  return res.json();
}

async function parserTests() {
  // --- the Korean dictionary pack. Here rather than at the top level only
  // because lookup() is async and this file is a classic script.
  //
  // It is a stub with no key and no network, and every assertion below is
  // about what it must NOT say. A missing pack would set
  // `failed: no dictionary registered for ko`, which sidepanel.js:44 renders
  // as "Cambridge lookup failed." on every Korean word; a `notFound` would
  // make lookup.js:73 abort the save and throw away the MT gloss that is the
  // whole of phase 1.
  const ko = LANG.dict('ko');
  check('Korean has a dictionary registered', !!ko);
  eq('and it names itself', ko?.name, 'krdict');
  eq('and carries its base, as en does', ko?.base, 'https://krdict.korean.go.kr');
  const koLookup = await ko.lookup('책');
  eq('a keyless Korean lookup has no level', koLookup.level, null);
  eq('nor pronunciation', koLookup.ipa, null);
  eq('nor a definition', koLookup.def, null);
  eq('nor audio', koLookup.audio, null);
  check('and does not report a failure, which would fire the panel warning',
        !('failed' in koLookup), JSON.stringify(koLookup.failed));
  check('nor not-found, which would abort the save and lose the gloss',
        !('notFound' in koLookup), JSON.stringify(koLookup.notFound));
  // The encoding, not the string: the path can move (the desktop ones 404 and
  // 500, so this is the mobile Vietnamese interface, verified 2026-09-20) but
  // the word has to survive the URL either way.
  const koHref = ko.href('책');
  eq('the full-entry link points at krdict', new URL(koHref).origin, ko.base);
  check('and carries the word percent-encoded', koHref.endsWith('=%EC%B1%85'), koHref);

  const enDict = LANG.dict('en');
  eq('the English dictionary links to Wiktionary', enDict.name, 'Wiktionary');
  eq('and its full-entry link opens Wiktionary',
     new URL(enDict.href('resilient')).hostname, 'en.wiktionary.org');
  eq('and carries the word percent-encoded',
     new URL(enDict.href('déjà')).pathname, '/wiki/d%C3%A9j%C3%A0');

  // resilient from Datamuse: plain-text defs tagged "adj\t…", synonyms from the
  // second endpoint. No CEFR level, no IPA and no recorded audio from this
  // source — the play button uses the system voice and the ↗ link has the rest.
  const dmDefs = await fixtureJson('datamuse-resilient');
  const dmSyn = await fixtureJson('datamuse-resilient-syn');
  const resilient = enDict.parse(dmDefs[0], dmSyn);
  // The level is not in the Datamuse response; it comes from the bundled CEFR
  // list (lang/en/cefr.js), which parse() reads by the word.
  eq('resilient level comes from the CEFR list', resilient.level, 'C1');
  eq('resilient IPA is rebuilt from the CMU pronunciation', resilient.ipa, 'rɪˈzɪljənt');
  eq('resilient has no recorded audio', resilient.audio, null);
  eq('nor a second recording', resilient.audioUs, null);
  eq('resilient part of speech is expanded from the tag', resilient.pos, 'adjective');
  eq('resilient def is the first sense, with the pos tab stripped', resilient.def,
     'Returning quickly to normal after damaging events or conditions. (of systems, organisms or people)');
  eq('resilient def equals its first sense', resilient.def, resilient.senses[0].def);
  check('no sense leaks the pos tab', resilient.senses.every((s) => !s.def.includes('\t')));
  check('every sense has a definition', resilient.senses.every((s) => s.def));
  eq('senses are capped at MAX_SENSES', resilient.senses.length, VT.MAX_SENSES);
  eq('resilient synonyms', resilient.synonyms.join(), 'spirited,live,elastic,bouncy,springy,whippy');
  check('synonyms never include the headword', !resilient.synonyms.includes('resilient'));
  check('synonyms are capped', resilient.synonyms.length <= VT.MAX_XREF);
  check('synonyms are deduplicated',
        new Set(resilient.synonyms).size === resilient.synonyms.length);
  eq('no opposites from this source', resilient.opposites.length, 0);
  eq('and no grammar label', resilient.gram, null);

  // A miss or an odd response must degrade to the four nulls, NOT a notFound: a
  // notFound aborts the save (lookup.js:135) and loses the gloss. A real
  // not-found is decided in lookup() from the network, not here.
  const miss = enDict.parse(null, []);
  eq('parse(null) has no level', miss.level, null);
  eq('parse(null) has no def', miss.def, null);
  check('parse(null) is a soft miss, not a not-found', !miss.notFound);
  const noDefs = enDict.parse({ word: 'x' }, []);
  eq('parse of a defs-less match has no def', noDefs.def, null);
  check('and is a soft miss too', !noDefs.notFound);

  // --- the bundled CEFR list (lang/en/cefr.js). The level the lookup no longer
  // carries, read from a word list instead.
  eq('cefrLevel reads a listed word', cefrLevel('abandon'), 'B1');
  eq('cefrLevel is case-insensitive', cefrLevel('HAPPY'), 'A1');
  eq('cefrLevel de-inflects a plural not in the list', cefrLevel('studies'), 'A1');
  eq('cefrLevel de-inflects an -ing form not in the list', cefrLevel('abandoning'), 'B1');
  eq('cefrLevel is null for a word outside the list', cefrLevel('zxqwv'), null);
  eq('cefrLevel is null for the empty string', cefrLevel(''), null);

  // --- ARPAbet (CMU) -> IPA, the pronunciation rebuilt from Datamuse md=r.
  const ipa = enDict.arpaToIpa;
  eq('arpaToIpa places stress before the onset', ipa('HH AE1 P IY0'), 'ˈhæpi');
  eq('arpaToIpa handles a cluster onset', ipa('S T R AE1 T AH0 JH IY0'), 'ˈstrætədʒi');
  eq('arpaToIpa reduces an unstressed AH to schwa', ipa('R IH0 Z IH1 L Y AH0 N T'), 'rɪˈzɪljənt');
  eq('arpaToIpa is null on empty input', ipa(''), null);
  eq('arpaToIpa is null on unknown phonemes', ipa('?? !!'), null);

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
  eq('newFolder has no language unless it is given one', folder.lang, null);
  eq('newFolder keeps the language it is given',
     VT.newFolder('\ud559\uc2b5', { lang: 'ko' }).lang, 'ko');

  /* --- which session a folder belongs in ---------------------------------
     The bug this pins: the dashboard filtered WORDS by the active language and
     never the folder list, so a Korean session showed IELTS C1 and Phrasal A1
     as empty cards. `lang` is new, so every folder already in storage has to
     be placed by inference rather than by a migration — same contract LANG.of
     gives a word that predates entry.lang. */
  const enWord = { word: 'strategy' };
  const koWord = { word: '\ucc45', lang: 'ko' };
  const plain = VT.newFolder('IELTS C1');
  eq('a folder with no lang is placed by the words in it',
     VT.folderLang(plain, [enWord, enWord]), 'en');
  eq('and by their script, not by a stored field',
     VT.folderLang(plain, [koWord, koWord]), 'ko');
  eq('what the words say beats the lang it was stamped with',
     VT.folderLang(VT.newFolder('x', { lang: 'ko' }), [enWord, enWord]), 'en');
  eq('the stamp answers while there is nothing in it to read',
     VT.folderLang(VT.newFolder('x', { lang: 'ko' }), []), 'ko');
  // folderForName reuses a folder by NAME across languages: a preset topic
  // stamped 'ko' that later takes an English word must become everyone's, not
  // stay Korean with an English word stranded inside it.
  eq('and stops answering once a second language is in the folder',
     VT.folderLang(VT.newFolder('x', { lang: 'ko' }), [enWord, koWord]), null);
  eq('an empty folder belongs to everyone, so a new one cannot vanish',
     VT.folderLang(plain, []), null);
  eq('and so does a folder holding both languages',
     VT.folderLang(plain, [enWord, koWord]), null);
  eq('From reading collects in every language',
     VT.folderLang({ id: VT.READING, auto: true }, [enWord, enWord]), null);

  check('an English folder is hidden from a Korean session',
        !VT.inLang(plain, [enWord, enWord], 'ko'));
  check('and shown in an English one', VT.inLang(plain, [enWord, enWord], 'en'));
  check('a universal folder is shown in both',
        VT.inLang(plain, [], 'ko') && VT.inLang(plain, [], 'en'));

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

  // (The English parser's full invariants — caps, dedupe, soft-miss, pos
  // expansion — are asserted on the Datamuse fixtures above.)

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

  // --- the NFD path. A Quick Action capture of a Korean sentence arrives
  // DECOMPOSED, while the word is saved composed (normaliseWord). A context
  // left in NFD is one match() can never hit, so it would be stored and then
  // never highlight, never blank, and never answer a Fill-the-gap card. The
  // fold belongs where the context is BUILT, not in match(), which hands back
  // indices into the caller's own string.
  const nfd = '나는 책을 읽었다'.normalize('NFD');
  eq('an NFD sentence yields a composed context',
     VT.sentenceAround(nfd, '책'), '나는 책을 읽었다'.normalize('NFC'));
  // The whole-selection fallback too: captureWord takes it whenever
  // sentenceAround finds no sentence, and it does not pass through the fold.
  const koCap = VT.captureWord(nfd);
  check('an NFD capture is matched by its own word',
        VT.has(koCap.word, koCap.context), `${koCap.word} / ${koCap.context}`);
  eq('and its context is stored composed',
     koCap.context, koCap.context.normalize('NFC'));

  // --- sourceLink only links things a browser can open
  eq('a mac app source is not a link', VT.sourceLink('macos:Kindle', 'a resilient b', 'resilient'), null);
  eq('a non-url source is not a link', VT.sourceLink('Preview', null, 'x'), null);
  eq('a file url is not a link', VT.sourceLink('file:///Users/me/a.pdf', null, 'x'), null);
  check('an http url still links', VT.sourceLink('http://e.com/a', null, 'x') === 'http://e.com/a');

  // --- source guard: the English lookup hits the Free Dictionary API, not the
  // Cambridge scrape it replaced. Not a behaviour test (the fetch needs Chrome),
  // but a regression back to a dictionary.cambridge.org fetch would 403 every
  // English lookup silently, so the source URL is pinned here where a run catches
  // it. Comments are stripped first, the way the old credentials check did it:
  // the header comment names Cambridge, and matching that would hide a regression.
  const dictSrc = await (await fetch('../lang/en/dictionary.js?t=' + Date.now())).text();
  const dictCode = dictSrc.replace(/^\s*\/\/.*$/gm, '');
  check('the English lookup uses the Datamuse API',
        /api\.datamuse\.com/.test(dictCode));
  check('and no longer fetches Cambridge', !/cambridge\.org/.test(dictCode),
        'a cambridge.org fetch 403s from an extension — that is why this moved');

  // --- GIFs on cards (giphy.js). The pure halves only: the query, the URL and
  // the pick. giphyFind needs the network and chrome.storage, so it is not here.

  // VT.giphyOk gates what reaches an <img src>, including a URL out of an
  // imported export, so the host check has to reject a look-alike domain.
  check('giphyOk accepts an https giphy cdn url', VT.giphyOk('https://media.giphy.com/media/x/200.gif'));
  check('giphyOk accepts a numbered media host', VT.giphyOk('https://media3.giphy.com/media/x/200.gif'));
  check('giphyOk rejects http', !VT.giphyOk('http://media.giphy.com/media/x/200.gif'));
  check('giphyOk rejects another host', !VT.giphyOk('https://evil.test/x.gif'));
  check('giphyOk rejects a look-alike host', !VT.giphyOk('https://giphy.com.evil.test/x.gif'));
  check('giphyOk rejects junk', !VT.giphyOk('not a url'));
  check('giphyOk rejects null', !VT.giphyOk(null));

  // giphyQuery: English searches its word; a Korean card searches its
  // Vietnamese gloss, because GIPHY indexes neither Hangul nor the word itself.
  eq('en searches the word', giphyQuery({ word: 'cat', lang: 'en' }).q, 'cat');
  eq('en searches in english', giphyQuery({ word: 'cat', lang: 'en' }).lang, 'en');
  eq('ko searches the vietnamese gloss', giphyQuery({ word: '고양이', lang: 'ko', vi: 'con mèo' }).q, 'con mèo');
  eq('ko searches in vietnamese', giphyQuery({ word: '고양이', lang: 'ko', vi: 'con mèo' }).lang, 'vi');
  eq('ko with no gloss falls back to the word', giphyQuery({ word: '고양이', lang: 'ko' }).q, '고양이');

  const gurl = new URL(giphyUrl('KEY123', 'con mèo', 'vi'));
  eq('giphyUrl carries the key', gurl.searchParams.get('api_key'), 'KEY123');
  eq('giphyUrl encodes the query', gurl.searchParams.get('q'), 'con mèo');
  eq('giphyUrl carries the language', gurl.searchParams.get('lang'), 'vi');
  eq('giphyUrl keeps it roughly sfw', gurl.searchParams.get('rating'), 'pg-13');

  const gjson = { data: [
    { images: { fixed_height: { url: 'https://media.giphy.com/media/a/200.gif' } } },
    { images: { fixed_width: { url: 'https://media1.giphy.com/media/b/200w.gif' } } },
    { images: { fixed_height: { url: 'https://evil.test/c.gif' } } }  // dropped by giphyOk
  ] };
  eq('giphyPick takes the first with a pinned rand', giphyPick(gjson, () => 0),
     'https://media.giphy.com/media/a/200.gif');
  eq('giphyPick re-rolls to the second', giphyPick(gjson, () => 0.5),
     'https://media1.giphy.com/media/b/200w.gif');
  check('giphyPick never returns an off-giphy url',
        giphyPick(gjson, () => 0.99) !== 'https://evil.test/c.gif');
  eq('giphyPick returns null on no results', giphyPick({ data: [] }), null);
  eq('giphyPick returns null on a junk response', giphyPick(null), null);

  // --- push to Anki (anki.js). The pure note builder only; ankiInvoke is
  // network. Anki renders a field as HTML, so third-party text must be escaped.
  eq('escapeHtml neutralises angle brackets', escapeHtml('<b>'), '&lt;b&gt;');
  eq('escapeHtml neutralises ampersand and quotes', escapeHtml('a&"\''), 'a&amp;&quot;&#39;');
  eq('ankiTag strips spaces', ankiTag('IELTS C1'), 'IELTS_C1');

  const aNote = ankiNote(
    { word: 'resilient', lang: 'en', ipa: 'rɪˈzɪljənt', vi: 'kiên cường',
      def: 'able to recover', level: 'C1', senses: [{ example: 'a resilient girl' }] },
    'Vocab-track::English', ['IELTS C1']);
  eq('the front is the bare word, for stable dedupe', aNote.fields.Front, 'resilient');
  eq('the note uses the Basic model', aNote.modelName, 'Basic');
  eq('and the deck it was given', aNote.deckName, 'Vocab-track::English');
  check('the back carries the meaning', aNote.fields.Back.includes('kiên cường'));
  check('the back carries the IPA', aNote.fields.Back.includes('/rɪˈzɪljənt/'));
  check('the back carries the example', aNote.fields.Back.includes('a resilient girl'));
  check('a re-push skips duplicates', aNote.options.allowDuplicate === false);
  check('tags carry the source, language and folder',
        aNote.tags.includes('vocab-track') && aNote.tags.includes('lang::en')
        && aNote.tags.includes('IELTS_C1'));

  // The injection path: a gloss or definition from the translator, rendered as
  // HTML in Anki. It must come out escaped, never as a live tag.
  const aEvil = ankiNote({ word: 'w', lang: 'en', def: '<img src=x onerror=alert(1)>' }, 'D');
  check('a definition cannot smuggle a live tag into Anki',
        !aEvil.fields.Back.includes('<img src=x onerror')
        && aEvil.fields.Back.includes('&lt;img src=x onerror=alert(1)&gt;'),
        aEvil.fields.Back);

  // The GIF is the one allowed <img>, and only when VT.giphyOk passes its URL.
  const aGif = ankiNote({ word: 'w', lang: 'en', gif: 'https://media.giphy.com/media/a/200.gif' }, 'D');
  check('a valid giphy url becomes an image',
        aGif.fields.Back.includes('<img src="https://media.giphy.com/media/a/200.gif"'));
  const aBadGif = ankiNote({ word: 'w', lang: 'en', gif: 'https://evil.test/x.gif' }, 'D');
  check('an off-giphy gif url is never an image', !aBadGif.fields.Back.includes('<img'));

  document.getElementById('out').textContent =
    log.join('\n') + `\n\n${failures} failure(s), ${log.length} check(s)`;
}
parserTests();
