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

  // --- sm2
  const fresh = { ease: 2.5, interval: 0, reps: 0 };

  const first = VT.sm2(fresh, 5);
  eq('first success: reps', first.reps, 1);
  eq('first success: interval is 1 day', first.interval, 1);

  const second = VT.sm2(first, 5);
  eq('second success: reps', second.reps, 2);
  eq('second success: interval is 6 days', second.interval, 6);

  const third = VT.sm2(second, 4);
  eq('third success: interval is round(6 * ease)', third.interval, Math.round(6 * second.ease));

  // A lapse resets the schedule but not the ease factor.
  const lapsed = VT.sm2(third, 2);
  eq('lapse resets reps', lapsed.reps, 0);
  eq('lapse resets interval to 1', lapsed.interval, 1);
  check('lapse lowers ease', lapsed.ease < third.ease);

  // The 1.3 floor is part of the algorithm, not a tuning constant.
  let beaten = { ease: 2.5, interval: 0, reps: 0 };
  for (let i = 0; i < 20; i++) beaten = VT.sm2(beaten, 0);
  eq('ease floors at 1.3', beaten.ease, 1.3);

  const day = 24 * 60 * 60 * 1000;
  const due = VT.sm2(fresh, 5).due;
  check('due is about one day out', Math.abs(due - (Date.now() + day)) < 5000,
        `due delta ${due - Date.now()}`);

  // --- newEntry
  const entry = VT.newEntry('resilient', { level: 'C2', ipa: 'x', def: 'y', audio: null },
                            'kiên cường', 'https://example.com/a');
  eq('entry word', entry.word, 'resilient');
  eq('entry level', entry.level, 'C2');
  eq('entry vi', entry.vi, 'kiên cường');
  eq('entry sources', entry.sources.length, 1);
  eq('entry starts at ease 2.5', entry.ease, 2.5);
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

  // --- medianLevel: ignores entries with no level, never throws on an empty set
  eq('median of one level', VT.medianLevel([{ level: 'B2' }]), 'B2');
  eq('median ignores nulls', VT.medianLevel([{ level: null }, { level: 'C1' }, { level: null }]), 'C1');
  eq('median picks the middle',
     VT.medianLevel([{ level: 'A1' }, { level: 'B2' }, { level: 'C2' }]), 'B2');
  eq('median of nothing is null', VT.medianLevel([]), null);
  eq('median of only-null levels is null', VT.medianLevel([{ level: null }]), null);

  document.getElementById('out').textContent =
    log.join('\n') + `\n\n${failures} failure(s), ${log.length} check(s)`;
}
parserTests();
