// Card Blast: meanings fall, type the word to blast them.
//
// STUB — the grid card and eligibility are final; `ask` is a placeholder until
// this mode is built. See practice.js for the contract.
PRACTICE.register('blast', {
  title: 'Card Blast',
  blurb: 'Type the word before it lands',
  icon: '◎',
  color: 'blue',
  min: 5,
  why: 'Needs five words with a meaning',
  eligible: (entry) => !!VT.glossOf(entry),
  ask(entry, host, ctx) {
    host.appendChild(ctx.node('p', 'prask', entry.word));
    return ctx.next(false, 'This mode is not built yet.');
  },
  selfTest() {
    return [];
  }
});
