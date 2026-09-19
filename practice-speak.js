// Speak: make a sentence with the word and say it aloud.
//
// STUB — the grid card and eligibility are final; `ask` is a placeholder until
// this mode is built. See practice.js for the contract.
PRACTICE.register('speak', {
  title: 'Speak',
  blurb: 'Make a sentence, say it',
  icon: '🎙',
  color: 'purple',
  eligible: (entry) => !!entry.word,
  ask(entry, host, ctx) {
    host.appendChild(ctx.node('p', 'prask', entry.word));
    return ctx.next(false, 'This mode is not built yet.');
  },
  selfTest() {
    return [];
  }
});
