// Mix: every question in a different mode, drawn from whichever of the others
// can ask about that word. The only mode with no question of its own, and the
// games (a `run` mode) sit out — a falling-card round is not one question.
//
// The draw is weighted rather than uniform, because being eligible is not the
// same as being suited. Speak takes any word at all (practice-speak.js:230)
// while Quiz insists on a gloss and Fill on a saved sentence, so a flat coin
// gave the one question nothing can check — compose a sentence, judge it
// yourself — the same share as the two that hold material about this very
// word. Eligibility already carries what the word has; the shares below only
// have to say what a mode is worth once it is in the running.
//
// Rejected: also gating the draw on each mode's `min`, the way the tab strip
// does. It would cost a pool walk per mode per question, and Quiz's eligible()
// already walks the pool for distinct glosses (practice-quiz.js:15), so the
// round would go quadratic in the store to protect Fill — which does not need
// protecting: short of other words it simply offers the few it found
// (practice-fill.js:21).
(() => {
  // Shares, not probabilities: the draw normalises over whatever is in the
  // running. Quiz and Fill lead because the question arrives with its own
  // material. Listening trails them by one — it asks a real production answer
  // but only about the sound. Speak is last on purpose: it is the mode that
  // can always ask, so it should stand aside whenever another one can.
  const SHARE = { quiz: 3, fill: 3, listening: 2, speak: 1 };

  function shareOf(mode, entry) {
    // Fill is worth more when the sentence is the one you met the word in
    // rather than a dictionary example — the same order Fill itself reads them
    // in (practice-fill.js:13).
    if (mode.id === 'fill') return VT.has(entry.word, entry.context, entry.lang) ? 3 : 2;
    // 1 rather than 0 for an id this table has never heard of: a mode added
    // tomorrow should be drawn rarely until someone weighs it, not silently
    // dropped out of Mix. selfTest is what notices the omission.
    return SHARE[mode.id] ?? 1;
  }

  // `rand` is a parameter only so selfTest can pin the draw, the seam
  // VT.quizOptions leaves for its shuffle (lib.js:307).
  function draw(choices, entry, rand = Math.random) {
    const shares = choices.map((mode) => shareOf(mode, entry));
    let left = rand() * shares.reduce((sum, share) => sum + share, 0);
    // The last choice also catches rand() landing on 1 and the float drift of
    // summing the shares twice, neither of which may leave the draw empty.
    return choices.find((_, i) => (left -= shares[i]) < 0) ?? choices[choices.length - 1];
  }

  function askers(entry, pool) {
    return PRACTICE.list().filter((m) => m.id !== 'mix' && m.ask && !m.run && m.eligible(entry, pool));
  }

  PRACTICE.register('mix', {
    title: 'Mix',
    blurb: 'A bit of every mode',
    icon: '✦',
    color: 'magenta',
    // Never read: every question Mix draws is recorded under the mode that
    // actually asked it, so the grade comes from that mode's own `produces`.
    // The one question the shell records for Mix is a give-up, and a wrong
    // answer is 0 before gradeFor reaches `produces` at all (practice.js:266).
    produces: false,
    eligible: (entry, pool) => askers(entry, pool).length > 0,
    async ask(entry, host, ctx) {
      const mode = draw(askers(entry, ctx.pool), entry);
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
      const drawable = others.filter((m) => m.ask && !m.run);
      // Stand-ins rather than the registered modes, because Listening's
      // eligible() answers differently on a machine with no voice installed
      // and a draw test has to mean the same thing everywhere.
      const quiz = { id: 'quiz' };
      const speak = { id: 'speak' };
      const word = { word: 'accelerate' };
      const met = { word: 'accelerate', context: 'Prices accelerate when rates fall' };
      const book = { word: 'accelerate', senses: [{ example: 'Prices accelerate when rates fall' }] };
      return [
        ['never draws itself or a game', askers({ word: 'x' }, []).every((m) => m.id !== 'mix' && !m.run)],
        ['every other mode is registered', others.length === 5, others.map((m) => m.id).join()],
        ['every mode it can draw has a share of the draw',
         drawable.every((m) => m.id in SHARE), drawable.map((m) => m.id).filter((id) => !(id in SHARE)).join()],
        ['speak stands aside for a mode that has material',
         shareOf(speak, word) < shareOf(quiz, word)],
        // 3 against 1: the first three quarters of the line are the quiz's and
        // the last quarter is Speak's, ends included.
        ['the draw walks the shares in order',
         draw([quiz, speak], word, () => 0) === quiz
           && draw([quiz, speak], word, () => 0.7) === quiz
           && draw([quiz, speak], word, () => 0.8) === speak
           && draw([quiz, speak], word, () => 1) === speak],
        ['the sentence you met the word in outranks a dictionary example',
         shareOf({ id: 'fill' }, met) > shareOf({ id: 'fill' }, book)]
      ];
    }
  });
})();
