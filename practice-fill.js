// Fill the gap: a sentence with the word blanked out, pick the word.
//
// STUB — the grid card and eligibility are final; `ask` is a placeholder until
// this mode is built. See practice.js for the contract.
PRACTICE.register('fill', {
  title: 'Fill the gap',
  blurb: 'Pick the word for the sentence',
  icon: 'T',
  color: 'red',
  why: 'Needs saved sentences or examples',
  eligible: (entry, pool) => pool.length >= 4 && [entry.context, ...(entry.senses ?? []).map((s) => s.example)]
    .some((text) => text && VT.wordRegex(entry.word).test(text)),
  ask(entry, host, ctx) {
    host.appendChild(ctx.node('p', 'prask', entry.word));
    return ctx.next(false, 'This mode is not built yet.');
  },
  selfTest() {
    return [];
  }
});
