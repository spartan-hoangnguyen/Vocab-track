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

  // Garbage in, four nulls out. Never throws.
  const empty = VT.parseCambridge('<html><body>nothing here</body></html>');
  eq('empty level', empty.level, null);
  eq('empty ipa', empty.ipa, null);
  eq('empty def', empty.def, null);
  eq('empty audio', empty.audio, null);

  document.getElementById('out').textContent =
    log.join('\n') + `\n\n${failures} failure(s), ${log.length} check(s)`;
}
parserTests();
