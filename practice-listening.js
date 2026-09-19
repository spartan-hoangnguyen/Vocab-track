// Listening: hear the word, type it.
//
// STUB — the grid card and eligibility are final; `ask` is a placeholder until
// this mode is built. See practice.js for the contract.
PRACTICE.register('listening', {
  title: 'Listening',
  blurb: 'Hear it, type it',
  icon: '♪',
  color: 'green',
  eligible: (entry) => VT.isLookupCandidate(entry.word) || /^[a-z]+(?:[ -][a-z]+)+$/i.test(entry.word),
  ask(entry, host, ctx) {
    host.appendChild(ctx.node('p', 'prask', entry.word));
    return ctx.next(false, 'This mode is not built yet.');
  },
  selfTest() {
    return [];
  }
});
