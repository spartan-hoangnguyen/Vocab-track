// Card Blast: meanings fall, type the word to blast them.
//
// A game, so it takes the whole session (run) instead of one question at a
// time (ask) — which also keeps Mix from drawing it. The rules live in a plain
// state object moved by step() and tryBlast(); the requestAnimationFrame loop
// only feeds them time and paints the result. That split is what lets
// selfTest play a whole round with fake time in a headless page where rAF may
// never fire — and it is why pausing is a field on the state rather than a
// stopped loop: a paused round has to be something the tests can assert.
const BLAST = (() => {
  const LIVES = 3;
  // Speeds are in arena heights per millisecond: 1/7000 is seven seconds from
  // the top to the floor, slow enough to read a gloss and type the word.
  const FALL = 1 / 7000;
  // Each blast adds 6% to the fall speed and takes 150ms off the gap between
  // cards, down to a floor — so the first cards come one at a time and the
  // last few overlap.
  const FALL_GAIN = 0.06;
  const GAP = 4200;
  const GAP_STEP = 150;
  const GAP_MIN = 1100;
  // What prefers-reduced-motion is worth in a mode whose whole content is
  // motion. It used to reach only practice-blast.css, where it dropped the
  // boom and the flash — the decoration — and left twenty cards falling down
  // the arena at full speed, which is the movement somebody asking for less of
  // it is actually looking at. Six tenths of the speed, with the spawn gap
  // stretched by the same factor: slowing the fall alone would leave cards on
  // screen far longer, pile the sky up and hand a reduced-motion player a
  // harder round than everybody else's.
  const CALM = 0.6;
  // A frame that arrives long after the last one — a garbage collection, an OS
  // dialog — would otherwise drop every card on the floor at once. This used
  // to read "a tab switch pauses rAF"; a tab switch now pauses the round
  // itself (the blur listener in run), so what is left for this cap is the
  // late frame that arrives with no blur in front of it.
  const MAX_DT = 100;

  const fallSpeed = (score, calm) => FALL * (1 + score * FALL_GAIN) * (calm ? CALM : 1);
  const spawnGap = (score, calm) => Math.max(GAP_MIN, GAP - score * GAP_STEP) / (calm ? CALM : 1);

  // on: {spawn(card), land(card), blast(card)} — how the game tells whoever is
  // painting (or testing) what just happened. Every callback is optional.
  function create(entries, on = {}, calm = false) {
    // Every card it was given. The twenty-card cap that used to sit here was
    // the dialog's own idea of how long a round should be, and since the shell
    // began handing a run-mode a session-sized list (practice.js:363) it could
    // only disagree with the counter above the arena: at a length of 25 the
    // header promised five cards this file would never drop. The Length
    // control is the round length now.
    const queue = entries.slice();
    return {
      queue, on, calm,
      total: queue.length,
      cards: [],
      lives: LIVES,
      score: 0,
      resolved: 0,
      // Zero, so the first step puts one card on screen straight away.
      spawnIn: 0,
      paused: false,
      over: queue.length === 0
    };
  }

  function spawn(state) {
    const card = { entry: state.queue.shift(), x: Math.random(), y: 0 };
    state.cards.push(card);
    state.spawnIn = spawnGap(state.score, state.calm);
    state.on.spawn?.(card);
  }

  function finish(state) {
    if (state.lives <= 0 || state.resolved >= state.total) state.over = true;
  }

  // Moves time forward dtMs: cards fall, the ones at the floor cost a life,
  // and a new card drops when the gap is up — or at once if the sky is empty,
  // so you are never left staring at nothing. A paused round takes no time at
  // all, which is the whole of what pausing means here.
  function step(state, dtMs) {
    if (state.over || state.paused) return state;
    const dt = Math.min(Math.max(dtMs, 0), MAX_DT);
    const v = fallSpeed(state.score, state.calm);
    for (const card of [...state.cards]) {
      card.y += v * dt;
      if (card.y < 1) continue;
      card.y = 1;
      state.cards.splice(state.cards.indexOf(card), 1);
      state.lives--;
      state.resolved++;
      state.on.land?.(card);
      finish(state);
      if (state.over) return state;
    }
    state.spawnIn -= dt;
    if (state.queue.length && (state.spawnIn <= 0 || !state.cards.length)) spawn(state);
    return state;
  }

  // Blasts the card whose word was typed; the lowest one if two could match,
  // since that is the one about to cost you. Returns it, or null for a miss —
  // a wrong word costs nothing but the time it took to type. Nothing can be
  // blasted while the round is paused: the curtain is over the arena, so a hit
  // there would be at a card the player cannot see.
  function tryBlast(state, typed) {
    if (state.over || state.paused) return null;
    const hits = state.cards.filter((card) => PRACTICE.same(typed, card.entry.word));
    if (!hits.length) return null;
    const card = hits.reduce((a, b) => (b.y > a.y ? b : a));
    state.cards.splice(state.cards.indexOf(card), 1);
    state.score++;
    state.resolved++;
    state.on.blast?.(card);
    finish(state);
    return card;
  }

  const hearts = (lives) => {
    const left = Math.max(lives, 0);
    return '♥'.repeat(left) + '♡'.repeat(LIVES - left);
  };

  // The best score, kept per language beside the words. One global number
  // measured a five-card round of Korean against a hundred cards of English
  // and called the smaller one a failure. A storage hiccup must not cost you
  // the round, so this only ever falls back to the score just played. The bare
  // number the single-score version left behind is not migrated: which
  // language it was won in is a guess, and it is an arcade score, not
  // somebody's words. Spreading a number yields {}, so the old value simply
  // gives way to the map.
  async function best(lang, score) {
    try {
      const { blastBest } = await chrome.storage.local.get('blastBest');
      const kept = Number(blastBest?.[lang]) || 0;
      const top = Math.max(kept, score);
      if (top !== kept) await chrome.storage.local.set({ blastBest: { ...blastBest, [lang]: top } });
      return top;
    } catch (err) {
      console.warn('Card Blast: could not keep the best score', err);
      return score;
    }
  }

  function run(entries, host, ctx) {
    return new Promise((resolve) => {
      const { node } = ctx;
      // One controller for the round's listeners and loop, cut by the round
      // ending or by the tab changing — whichever comes first.
      const round = new AbortController();
      const end = () => { round.abort(); resolve(); };
      if (ctx.signal.aborted) return end();
      const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
      // The pool is one language's words (dashboard.js:97), so the first card
      // says which language's best this round is played against.
      const lang = entries[0] ? LANG.of(entries[0]).id : LANG.FALLBACK;

      const root = node('div', 'pr-blast');
      const hud = node('div', 'blhud');
      const life = node('span', 'bllives');
      const hold = node('button', 'btn ghost blhold');
      hold.type = 'button';
      hold.title = 'p — the window losing focus pauses too';
      const points = node('span', 'blscore');
      hud.append(life, hold, points);
      const arena = node('div', 'blarena');
      const input = node('input', 'prinput');
      input.placeholder = 'Type the word, then Enter';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('aria-label', 'Word to blast');
      root.append(hud, arena, input);
      host.appendChild(root);

      // Cards sit at a fraction of the room left once their own size is taken
      // off (see .blcard), so none hangs out of the arena at either edge.
      const place = (el, card) => { el.style.left = `calc(${card.x} * (100% - var(--blw)))`; };
      const els = new Map();

      const state = create(entries, {
        spawn(card) {
          const el = node('div', 'blcard');
          // The gloss in a child of its own, because a card that clamps its
          // text has to be a -webkit-box and the card itself has to stay the
          // grid that centres it (practice-blast.css:.bltext).
          el.appendChild(node('span', 'bltext', VT.glossOf(card.entry)));
          place(el, card);
          els.set(card, el);
          arena.appendChild(el);
        },
        land(card) {
          els.get(card)?.remove();
          els.delete(card);
          ctx.record(card.entry, false);
          // The word you missed, where it landed — the one thing to learn
          // from a card you did not catch.
          const flash = node('div', 'blflash', card.entry.word);
          place(flash, card);
          arena.appendChild(flash);
          setTimeout(() => flash.remove(), 1400);
        },
        blast(card) {
          const el = els.get(card);
          els.delete(card);
          ctx.record(card.entry, true);
          if (!el) return;
          if (calm) return el.remove();
          el.classList.add('boom');
          setTimeout(() => el.remove(), 320);
        }
      }, calm);

      // Read once at the start and shown all round, which is where a best
      // score is worth anything: it is the number you are chasing while you
      // play. It used to appear only on this mode's own game-over card, and
      // that card is gone.
      let top = 0;
      const keep = () => best(lang, state.score).then((t) => { top = t; paint(); });

      const paint = () => {
        life.textContent = hearts(state.lives);
        points.textContent = `Score ${state.score} · Best ${Math.max(top, state.score)}`;
        hold.textContent = state.paused ? '▶ Resume' : '⏸ Pause';
        // The status line is the shell's one polite live region
        // (practice.js:478), so saying it here is also how a pause is
        // announced to a screen reader.
        ctx.status(state.paused ? 'Paused' : `${state.resolved} / ${state.total}`);
        for (const [card, el] of els) el.style.top = `calc(${card.y} * (100% - var(--blh)))`;
      };

      // Pausing draws a curtain over the arena. A pause you can read the
      // falling cards through is just unlimited time to think, which is the
      // one thing this mode exists to withhold.
      let curtain = null;
      const resume = () => {
        if (!state.paused) return;
        state.paused = false;
        curtain?.remove();
        curtain = null;
        input.disabled = false;
        input.focus();
        paint();
      };
      const pause = () => {
        if (state.over || state.paused) return;
        state.paused = true;
        input.disabled = true;
        curtain = node('div', 'blcurtain');
        curtain.append(node('p', 'prask', 'Paused'), node('p', 'prhint', 'p, or the button above'));
        arena.appendChild(curtain);
        // Focus off the box and onto the button — which is also what puts the
        // p key back within reach, since the handler below leaves every letter
        // to the box while the box has the focus.
        hold.focus();
        paint();
      };
      hold.addEventListener('click', () => { if (state.paused) resume(); else pause(); },
                            { signal: round.signal });

      // p, and never from inside the box: every letter there belongs to the
      // word being typed, exactly as the shell has it (practice.js:617), so p
      // pauses whenever the focus is anywhere else and the button is what a
      // player reaches for mid-word. Escape could not take this job — it is
      // the shell's, and it leaves the tab (practice.js:610) — and Ctrl+P is
      // the browser's print dialog.
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'p' && e.key !== 'P') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.target.closest?.('input, textarea, select')) return;
        e.preventDefault();
        if (state.paused) resume(); else pause();
      }, { signal: round.signal });

      // A round still falling behind another window is a round you lose
      // without watching it happen.
      window.addEventListener('blur', pause, { signal: round.signal });

      // Leaving mid-round still played the round, so the score it reached is
      // still a score; the read that fills in Best is the same call.
      ctx.signal.addEventListener('abort', () => { keep(); end(); }, { signal: round.signal });

      let ended = false;
      const gameOver = async () => {
        if (ended) return;
        ended = true;
        // No ending of its own. The shell paints the summary every other mode
        // ends on (practice.js:558) the moment run() resolves, and this mode
        // used to paint a game-over card under it — one ending to dismiss
        // before the real one, with the same score on both.
        await keep();
        end();
      };

      input.addEventListener('keydown', (e) => {
        // Enter, not match-as-you-type: typing "car" must not blast "car"
        // while you are on your way to "carpet".
        if (e.key !== 'Enter' || e.isComposing) return;
        e.preventDefault();
        if (tryBlast(state, input.value)) input.value = '';
        else input.select();
        paint();
        if (state.over) gameOver();
      }, { signal: round.signal });

      let last = null;
      const frame = (now) => {
        if (round.signal.aborted || state.over) return;
        // last is stamped even while paused, so resuming costs one frame of
        // fall rather than however long the player was away.
        if (last != null) step(state, now - last);
        last = now;
        paint();
        if (state.over) return gameOver();
        requestAnimationFrame(frame);
      };

      // The first card is on screen before the first frame, not a frame later.
      step(state, 0);
      keep();
      paint();
      if (state.over) gameOver();
      else requestAnimationFrame(frame);
      input.focus();
    });
  }

  return { create, step, tryBlast, run, best, fallSpeed, spawnGap, LIVES };
})();

PRACTICE.register('blast', {
  title: 'Card Blast',
  blurb: 'Type the word before it lands',
  icon: '◎',
  color: 'blue',
  min: 5,
  why: 'Needs five words with a meaning',
  // A game, and the only mode that never moves a schedule: a card reaching the
  // floor is a clock running out, not a memory failing, and a timed arcade
  // round must not lapse a word you actually know — which is what three lives
  // gone would otherwise do to everything still in the sky.
  schedules: false,
  eligible: (entry) => !!VT.glossOf(entry),
  run: BLAST.run,
  async selfTest() {
    const out = [];
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].map((word) => ({ word, vi: 'nghĩa ' + word }));
    const log = [];
    const on = {
      land: (card) => log.push([card.entry.word, false]),
      blast: (card) => log.push([card.entry.word, true])
    };

    let s = BLAST.create(words, on);
    BLAST.step(s, 0);
    out.push(['one card on screen at the start', s.cards.length === 1, s.cards.length]);
    const first = s.cards[0];
    BLAST.step(s, 50);
    out.push(['a card falls with time', first.y > 0, first.y]);

    // Paused is time not passing, not a loop that stopped calling step: the
    // rAF loop keeps feeding it frames while the curtain is up.
    s.paused = true;
    const held = first.y;
    for (let i = 0; i < 20; i++) BLAST.step(s, 50);
    out.push(['a paused round takes no time', first.y === held, `${held} → ${first.y}`]);
    out.push(['and nothing can be blasted through the curtain',
      BLAST.tryBlast(s, first.entry.word) === null && s.score === 0]);
    s.paused = false;
    BLAST.step(s, 50);
    out.push(['resuming moves it again', first.y > held, `${held} → ${first.y}`]);

    // Run the clock until the first card hits the floor.
    for (let i = 0; i < 400 && s.cards.includes(first); i++) BLAST.step(s, 50);
    out.push(['reaching the floor costs a life', s.lives === BLAST.LIVES - 1, s.lives]);
    out.push(['and records it as a miss', log.some(([w, ok]) => w === first.entry.word && !ok), JSON.stringify(log)]);

    const target = s.cards[0];
    const before = s.cards.length;
    out.push(['a wrong word blasts nothing', BLAST.tryBlast(s, 'nope') === null && s.cards.length === before]);
    const hit = BLAST.tryBlast(s, '  ' + target.entry.word.toUpperCase() + ' ');
    out.push(['the right word blasts that card', hit === target && !s.cards.includes(target) && s.score === 1]);
    out.push(['and records it as right', log.some(([w, ok]) => w === target.entry.word && ok), JSON.stringify(log)]);

    out.push(['speed grows with score',
      BLAST.fallSpeed(5) > BLAST.fallSpeed(0) && BLAST.spawnGap(5) < BLAST.spawnGap(0)]);

    // The reduced-motion promise, and the one the CSS could not make: the fall
    // is slower, and the gap is wider by the same factor so the sky holds no
    // more cards than it would have.
    out.push(['reduced motion slows the fall itself',
      BLAST.fallSpeed(0, true) < BLAST.fallSpeed(0, false), BLAST.fallSpeed(0, true)]);
    out.push(['and spaces the cards out to match',
      BLAST.spawnGap(0, true) > BLAST.spawnGap(0, false), BLAST.spawnGap(0, true)]);
    const quiet = BLAST.create(words, {}, true);
    const loud = BLAST.create(words, {});
    BLAST.step(quiet, 0); BLAST.step(loud, 0);
    for (let i = 0; i < 10; i++) { BLAST.step(quiet, 50); BLAST.step(loud, 50); }
    out.push(['a calm round is lower down the arena after the same time',
      quiet.cards[0].y < loud.cards[0].y, `${quiet.cards[0].y} vs ${loud.cards[0].y}`]);

    // Let every card land: three misses and the round is over.
    s = BLAST.create(words, on);
    for (let i = 0; i < 2000 && !s.over; i++) BLAST.step(s, 100);
    out.push(['no lives left ends the round', s.over && s.lives === 0, `${s.lives} lives, over=${s.over}`]);
    const frozen = s.cards.map((c) => c.y).join();
    BLAST.step(s, 1000);
    out.push(['and nothing moves after it', s.cards.map((c) => c.y).join() === frozen]);

    // Blast everything as it arrives: the round ends when every card is resolved.
    s = BLAST.create(words.slice(0, 3), on);
    for (let i = 0; i < 100 && !s.over; i++) {
      BLAST.step(s, 100);
      for (const card of [...s.cards]) BLAST.tryBlast(s, card.entry.word);
    }
    out.push(['clearing every card ends the round', s.over && s.score === 3 && s.lives === BLAST.LIVES]);

    // Invented language ids, so these rows say something about the keying and
    // nothing about whatever the live rounds below leave in storage.
    out.push(['a best score is kept per language',
      (await BLAST.best('xx', 5)) === 5 && (await BLAST.best('yy', 1)) === 1
      && (await BLAST.best('xx', 0)) === 5]);
    await chrome.storage.local.set({ blastBest: 9 });
    out.push(['and the old single number is read past, not crashed on',
      (await BLAST.best('xx', 2)) === 2]);

    // The real thing, in a host of its own: Enter blasts, and closing stops it.
    // Inside a claimed host, as in use: the Enter bubbles to the document, and
    // review only stands aside while practice owns the keys.
    const claim = PRACTICE.testHost();
    const host = document.createElement('div');
    claim.host.appendChild(host);
    const ac = new AbortController();
    const recorded = [];
    const ctx = {
      pool: words, signal: ac.signal, speak() {}, next: async (c) => c,
      record: async (entry, ok) => { recorded.push([entry.word, ok]); },
      same: PRACTICE.same,
      node: (tag, cls, text) => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
      },
      status() {}
    };
    let finished = false;
    const done = BLAST.run(words, host, ctx).then(() => { finished = true; });
    const card = host.querySelector('.pr-blast .blcard');
    const falling = words.find((w) => w.vi === card?.querySelector('.bltext')?.textContent);
    out.push(['run drops a card whose meaning is in a clamped line of its own', !!falling, card?.textContent]);
    const input = host.querySelector('.pr-blast input');
    input.value = falling?.word ?? '';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    out.push(['Enter blasts it and records it right',
      recorded.length === 1 && recorded[0][1] === true && input.value === '', JSON.stringify(recorded)]);

    // p where the word is typed is the letter p. The event's own target is what
    // decides that, here and in the shell, so dispatching on the box is the
    // same test as typing into it.
    const curtain = () => host.querySelector('.blcurtain');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
    out.push(['p inside the box is a letter, not a pause', !curtain()]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
    out.push(['p anywhere else pauses the round', !!curtain() && input.disabled]);
    const blocked = recorded.length;
    input.value = words.find((w) => w !== falling).word;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    out.push(['a paused round records nothing', recorded.length === blocked, JSON.stringify(recorded)]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
    out.push(['and p again lifts the curtain', !curtain() && !input.disabled]);
    window.dispatchEvent(new Event('blur'));
    out.push(['leaving the window pauses it too', !!curtain()]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));

    ac.abort();
    await Promise.race([done, new Promise((r) => setTimeout(r, 200))]);
    out.push(['leaving the tab ends the run', finished]);
    input.value = words.find((w) => w !== falling).word;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    out.push(['and its keys stop listening', recorded.length === 1, JSON.stringify(recorded)]);
    host.remove();

    // One card, so blasting it resolves the round: the ending arrives with no
    // frame ever having fired, which is the only way a headless page can watch
    // this mode end at all.
    const solo = document.createElement('div');
    claim.host.appendChild(solo);
    const only = [{ word: 'foxtrot', vi: 'nghĩa foxtrot', lang: 'ko' }];
    const was = await BLAST.best('ko', 0);
    let cleared = false;
    const lone = BLAST.run(only, solo, { ...ctx, signal: new AbortController().signal })
      .then(() => { cleared = true; });
    const box = solo.querySelector('.pr-blast input');
    box.value = 'foxtrot';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.race([lone, new Promise((r) => setTimeout(r, 200))]);
    out.push(['clearing the last card ends the run', cleared]);
    out.push(['leaving the ending to the shell, with none of its own',
      !solo.querySelector('.blcurtain') && solo.querySelector('.pr-blast')?.childElementCount === 3]);
    out.push(['the round just played is kept as that language’s best',
      (await BLAST.best('ko', 0)) === was + 1, `${was} → ${await BLAST.best('ko', 0)}`]);
    solo.remove();
    claim.done();
    return out;
  }
});
