// Card Blast: meanings fall, type the word to blast them.
//
// A game, so it takes the whole session (run) instead of one question at a
// time (ask) — which also keeps Mix from drawing it. The rules live in a plain
// state object moved by step() and tryBlast(); the requestAnimationFrame loop
// only feeds them time and paints the result. That split is what lets
// selfTest play a whole round with fake time in a headless page where rAF may
// never fire.
const BLAST = (() => {
  // At most twenty cards: a round is a couple of minutes, not the whole list.
  const ROUND = 20;
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
  // A tab switch pauses rAF; without a cap the first frame back would drop
  // every card on the floor at once.
  const MAX_DT = 100;

  const fallSpeed = (score) => FALL * (1 + score * FALL_GAIN);
  const spawnGap = (score) => Math.max(GAP_MIN, GAP - score * GAP_STEP);

  // on: {spawn(card), land(card), blast(card)} — how the game tells whoever is
  // painting (or testing) what just happened. Every callback is optional.
  function create(entries, on = {}) {
    const queue = entries.slice(0, ROUND);
    return {
      queue, on,
      total: queue.length,
      cards: [],
      lives: LIVES,
      score: 0,
      resolved: 0,
      // Zero, so the first step puts one card on screen straight away.
      spawnIn: 0,
      over: queue.length === 0
    };
  }

  function spawn(state) {
    const card = { entry: state.queue.shift(), x: Math.random(), y: 0 };
    state.cards.push(card);
    state.spawnIn = spawnGap(state.score);
    state.on.spawn?.(card);
  }

  function finish(state) {
    if (state.lives <= 0 || state.resolved >= state.total) state.over = true;
  }

  // Moves time forward dtMs: cards fall, the ones at the floor cost a life,
  // and a new card drops when the gap is up — or at once if the sky is empty,
  // so you are never left staring at nothing.
  function step(state, dtMs) {
    if (state.over) return state;
    const dt = Math.min(Math.max(dtMs, 0), MAX_DT);
    const v = fallSpeed(state.score);
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
  // a wrong word costs nothing but the time it took to type.
  function tryBlast(state, typed) {
    if (state.over) return null;
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

  // The best score is one number, kept beside the words. A storage hiccup
  // must not cost you the round, so it only ever falls back to this score.
  async function best(score) {
    try {
      const { blastBest } = await chrome.storage.local.get('blastBest');
      const top = Math.max(Number(blastBest) || 0, score);
      if (top !== blastBest) await chrome.storage.local.set({ blastBest: top });
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
      // ending or by the dialog closing — whichever comes first.
      const round = new AbortController();
      const end = () => { round.abort(); resolve(); };
      if (ctx.signal.aborted) return end();
      ctx.signal.addEventListener('abort', end, { signal: round.signal });
      const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

      const root = node('div', 'pr-blast');
      const hud = node('div', 'blhud');
      const life = node('span', 'bllives');
      const points = node('span', 'blscore');
      hud.append(life, points);
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
          const el = node('div', 'blcard', VT.glossOf(card.entry));
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
      });

      const paint = () => {
        life.textContent = hearts(state.lives);
        points.textContent = `Score ${state.score}`;
        ctx.status(`${state.resolved} / ${state.total}`);
        for (const [card, el] of els) el.style.top = `calc(${card.y} * (100% - var(--blh)))`;
      };

      let shown = false;
      const gameOver = async () => {
        if (shown) return;
        shown = true;
        input.disabled = true;
        const top = await best(state.score);
        if (round.signal.aborted) return;
        const note = node('div', 'blover');
        note.append(
          node('p', 'prask', state.lives > 0 ? 'Cleared' : 'Out of lives'),
          node('p', 'prhint', `Score ${state.score} · Best ${top}`)
        );
        const go = node('button', 'btn', 'Continue ');
        go.type = 'button';
        go.appendChild(node('kbd', null, 'enter'));
        // Focused, so Enter is the native button press: no key handler to leak.
        go.addEventListener('click', end, { once: true, signal: round.signal });
        note.appendChild(go);
        arena.appendChild(note);
        go.focus();
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
        if (last != null) step(state, now - last);
        last = now;
        paint();
        if (state.over) return gameOver();
        requestAnimationFrame(frame);
      };

      // The first card is on screen before the first frame, not a frame later.
      step(state, 0);
      paint();
      if (state.over) gameOver();
      else requestAnimationFrame(frame);
      input.focus();
    });
  }

  return { create, step, tryBlast, run, fallSpeed, spawnGap, LIVES, ROUND };
})();

PRACTICE.register('blast', {
  title: 'Card Blast',
  blurb: 'Type the word before it lands',
  icon: '◎',
  color: 'blue',
  min: 5,
  why: 'Needs five words with a meaning',
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

    // The real thing, in a detached host: Enter blasts, and closing stops it.
    // Inside the open dialog, as in use: the Enter bubbles to the document,
    // and review only stands aside while the dialog is open.
    const dlg = document.getElementById('practice-dlg');
    const opened = !dlg.open;
    if (opened) dlg.showModal();
    const host = document.createElement('div');
    document.getElementById('pr-body').appendChild(host);
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
    const falling = words.find((w) => w.vi === card?.textContent);
    out.push(['run drops a card showing a meaning', !!falling, card?.textContent]);
    const input = host.querySelector('.pr-blast input');
    input.value = falling?.word ?? '';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    out.push(['Enter blasts it and records it right',
      recorded.length === 1 && recorded[0][1] === true && input.value === '', JSON.stringify(recorded)]);
    ac.abort();
    await Promise.race([done, new Promise((r) => setTimeout(r, 200))]);
    out.push(['closing the dialog ends the run', finished]);
    input.value = words.find((w) => w !== falling).word;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    out.push(['and its keys stop listening', recorded.length === 1, JSON.stringify(recorded)]);
    host.remove();
    if (opened) dlg.close();
    return out;
  }
});
