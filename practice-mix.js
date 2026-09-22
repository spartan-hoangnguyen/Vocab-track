// Mix: every question in a different mode, drawn from whichever of the others
// can ask about that word. The only mode with no question of its own, and the
// games (a `run` mode) sit out — a falling-card round is not one question.
PRACTICE.register('mix', {
  title: 'Mix',
  blurb: 'A bit of every mode',
  icon: '✦',
  color: 'magenta',
  // Never read: every question Mix draws is recorded under the mode that
  // actually asked it, so the grade comes from that mode's own `produces`.
  produces: false,
  eligible: (entry, pool) => askers(entry, pool).length > 0,
  async ask(entry, host, ctx) {
    const choices = askers(entry, ctx.pool);
    const mode = choices[Math.floor(Math.random() * choices.length)];
    host.appendChild(ctx.node('p', 'prmodename', mode.title));
    const ok = await mode.ask(entry, host, ctx);
    // Recorded here, with the mode that drew it, rather than left to the
    // shell: the shell only knows the tab you are on, so a quiz question
    // asked inside Mix counted as Mix — and would now also be graded with
    // Mix's `produces` rather than the quiz's.
    await ctx.record(entry, !!ok, mode.id);
    return ok;
  },
  selfTest() {
    const others = PRACTICE.list().filter((m) => m.id !== 'mix');
    return [
      ['mix never draws itself or a game', askers({ word: 'x' }, []).every((m) => m.id !== 'mix' && !m.run)],
      ['every other mode is registered', others.length === 5, others.map((m) => m.id).join()]
    ];
  }
});

function askers(entry, pool) {
  return PRACTICE.list().filter((m) => m.id !== 'mix' && m.ask && !m.run && m.eligible(entry, pool));
}
