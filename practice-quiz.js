// Quiz: the English word, four meanings, pick one.
//
// STUB — the grid card and eligibility are final; `ask` is a placeholder until
// this mode is built. See practice.js for the contract.
PRACTICE.register('quiz', {
  title: 'Quiz',
  blurb: 'Pick the meaning',
  icon: '✓',
  color: 'amber',
  why: 'Needs four words with a meaning',
  eligible: (entry, pool) => !!VT.quizOptions(entry, pool),
  ask(entry, host, ctx) {
    host.appendChild(ctx.node('p', 'prask', entry.word));
    return ctx.next(false, 'This mode is not built yet.');
  },
  selfTest() {
    return [];
  }
});
