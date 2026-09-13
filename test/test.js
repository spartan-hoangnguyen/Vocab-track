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

document.getElementById('out').textContent =
  log.join('\n') + `\n\n${failures} failure(s), ${log.length} check(s)`;
