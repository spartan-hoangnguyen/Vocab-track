// Practice modes: extra drill on the words in scope, on top of review.
//
// Practice never writes ease, interval or due. Review is the schedule; this is
// playing with the words in between, and a session of ten quiz questions must
// not quietly reshuffle a month of spacing. What it does keep is its own
// count per mode per day (the "4/10 today" badge) and a running tally of
// misses per word — recordPractice in store.js.
//
// Each mode lives in its own practice-<id>.js and registers itself here.
// Loaded before dashboard.js and touching none of its globals at load time;
// dashboard.js calls renderGrid() and supplies the hooks below.
const PRACTICE = (() => {
  // A session is ten questions — a daily goal you can finish in two minutes.
  const SESSION = 10;
  const DAILY_GOAL = 10;
  // Grid order, not registration order, so script tags can be in any order.
  const ORDER = ['quiz', 'listening', 'fill', 'speak', 'blast', 'mix'];
  const modes = new Map();

  // Filled in by dashboard.js: how to say a word (accent and audio settings
  // live there), and what to redraw after an answer is recorded.
  const hooks = { speak: (entry) => pronounce(entry), changed: () => {} };

  let abort = null;

  // mode: {
  //   title, blurb, icon, color      — the grid card
  //   eligible(entry, pool) → bool   — can this word be asked in this mode
  //   min                            — eligible words needed to open it (default 1)
  //   why                            — shown on the card when there are too few
  //   ask(entry, host, ctx) → Promise<boolean>   one question; the shell loops
  //   run(entries, host, ctx) → Promise<void>    OR a whole session (a game);
  //                                              it records through ctx.record
  //   selfTest() → [[name, ok, detail?], …]      checks for test/practice-probe.html,
  //                                              or a Promise of them; may drive
  //                                              ask/run in a detached host
  // }
  function register(id, mode) {
    modes.set(id, { id, min: 1, why: 'Not enough words for this yet', ...mode });
  }

  function list() {
    return ORDER.map((id) => modes.get(id)).filter(Boolean);
  }

  function eligibleFor(mode, pool) {
    return pool.filter((entry) => mode.eligible(entry, pool));
  }

  function node(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  // Grades a typed answer the same way every mode does: case and outer spaces
  // never count against you.
  function same(typed, word) {
    return String(typed ?? '').trim().toLowerCase() === String(word ?? '').trim().toLowerCase();
  }

  function renderGrid(host, pool, counts = {}) {
    host.replaceChildren();
    for (const mode of list()) {
      const n = eligibleFor(mode, pool).length;
      const open = n >= mode.min;
      const card = node('button', `prmode ${mode.color ?? ''}`);
      card.type = 'button';
      card.dataset.mode = mode.id;
      card.disabled = !open;
      const done = counts[mode.id]?.total ?? 0;
      if (done) {
        card.appendChild(node('span', 'prbadge',
          done >= DAILY_GOAL ? `✓ ${done} today` : `${done}/${DAILY_GOAL} today`));
      }
      card.append(
        node('span', 'pricon', mode.icon ?? '•'),
        node('h3', null, mode.title),
        node('p', null, open ? mode.blurb : mode.why)
      );
      if (open) card.addEventListener('click', () => start(mode.id, pool));
      host.appendChild(card);
    }
  }

  // The verdict line every ask-mode ends a question with. Resolves once you
  // have read it, on Enter or a click, with the verdict passed in — so a mode
  // can `return ctx.next(ok, answer)`.
  function next(host, correct, answer) {
    return new Promise((resolve) => {
      const bar = node('div', `prverdict ${correct ? 'good' : 'bad'}`);
      bar.appendChild(node('b', null, correct ? 'Correct' : 'Not quite'));
      if (answer != null) {
        bar.appendChild(typeof answer === 'string' ? node('span', null, answer) : answer);
      }
      const go = node('button', 'btn', 'Continue ');
      go.type = 'button';
      go.appendChild(node('kbd', null, 'enter'));
      go.addEventListener('click', () => { bar.remove(); resolve(correct); }, { once: true });
      bar.appendChild(go);
      host.appendChild(bar);
      // Focused, so Enter is the native button press: no key handler to leak.
      go.focus();
    });
  }

  async function start(id, pool) {
    const mode = modes.get(id);
    if (!mode) return;
    abort?.abort();
    abort = new AbortController();
    const { signal } = abort;

    const dlg = document.getElementById('practice-dlg');
    const body = document.getElementById('pr-body');
    const status = document.getElementById('pr-status');
    document.getElementById('pr-title').textContent = mode.title;
    body.replaceChildren();
    status.textContent = '';
    if (!dlg.open) dlg.showModal();
    // showModal focuses the first control, which is the ✕, and a mode with
    // no input of its own (Quiz, Fill) then shows a focus ring on "close".
    // The body takes focus instead; a mode that has an input moves it on.
    body.tabIndex = -1;
    body.focus();

    let right = 0;
    let total = 0;
    const record = async (entry, correct) => {
      if (signal.aborted) return;
      total++;
      if (correct) right++;
      await recordPractice(id, entry.word, correct);
      hooks.changed();
    };
    const ctx = {
      pool,
      signal,
      speak: (entry) => hooks.speak(entry),
      next: (correct, answer) => next(body, correct, answer),
      record,
      same,
      node,
      status: (text) => { status.textContent = text; }
    };

    const eligible = VT.shuffled(eligibleFor(mode, pool));
    if (mode.run) {
      await mode.run(eligible, body, ctx);
    } else {
      const picks = eligible.slice(0, SESSION);
      for (let i = 0; i < picks.length; i++) {
        if (signal.aborted) return;
        ctx.status(`${i + 1} / ${picks.length} · ${right} right`);
        body.replaceChildren();
        const ok = await mode.ask(picks[i], body, ctx);
        await record(picks[i], !!ok);
      }
    }
    if (signal.aborted) return;
    summary(body, right, total, () => start(id, pool), () => dlg.close());
  }

  function summary(host, right, total, again, done) {
    host.replaceChildren();
    document.getElementById('pr-status').textContent = '';
    const box = node('div', 'prsummary');
    box.append(
      node('p', 'prscore', `${right} / ${total}`),
      node('p', null, total ? (right === total ? 'Every one right.' : 'right this round.') : 'Nothing to practise.')
    );
    const row = node('div', 'dlgrow');
    const a = node('button', 'btn ghost', 'Again');
    a.type = 'button';
    a.addEventListener('click', again);
    const d = node('button', 'btn', 'Done');
    d.type = 'button';
    d.addEventListener('click', done);
    row.append(a, d);
    box.appendChild(row);
    host.appendChild(box);
    d.focus();
  }

  // Closing mid-session (Esc, ✕) stops the mode: timers and listeners hang off
  // this signal, so a game cannot keep ticking behind a closed dialog.
  function stop() {
    abort?.abort();
    abort = null;
    hooks.changed();
  }

  return { register, list, modes, eligibleFor, renderGrid, start, stop, hooks, same, SESSION, DAILY_GOAL };
})();
