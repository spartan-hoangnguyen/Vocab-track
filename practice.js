// Practice modes: extra drill on the words in scope, run as tabs beside the
// review card rather than in a dialog over it.
//
// Practice MOVES the schedule, but never begins one. An answer is graded into
// FSRS only when the word is already due (or within AHEAD_MS of it) and has
// been introduced at least once — so drilling before bed pulls tomorrow's
// revision forward instead of duplicating it, while a mode that is a game
// (schedules:false) and a word you have never been shown are left alone. The
// old promise here was the opposite one, "practice never writes ease, interval
// or due", which meant ten right answers in a row still left every card due;
// the books practice keeps for itself — the per-mode daily count and the miss
// tally in store.js — stay exactly as they were.
//
// Each mode lives in its own practice-<id>.js and registers itself here.
// Loaded before dashboard.js and touching none of its globals at load time;
// dashboard.js calls renderTabs() and supplies the hooks below.
const PRACTICE = (() => {
  // Ten questions is the daily goal — two minutes — and the other two lengths
  // are for a sitting that wants more. 0 is "all of them".
  const SESSIONS = [10, 25, 0];
  const DAILY_GOAL = 10;
  // How far ahead of a card's due date an answer still counts as that review.
  // Half a day: enough that an evening round covers tomorrow morning's cards,
  // short enough that it cannot reach the day after.
  const AHEAD_MS = 12 * 60 * 60 * 1000;
  // The default ceiling for "fast", per mode (mode.fast, 0 for never). It
  // cannot be one global number: Speak asks you to compose and say a five-word
  // sentence, which takes fifteen seconds when it goes well, so a flat four
  // seconds would silently mean "Speak never grants Easy".
  const FAST_MS = 6000;
  // Tab order, not registration order, so script tags can be in any order.
  // The flashcard is the first tab and is not a mode: it is the review card
  // that was always in this cell.
  const FLASHCARD = 'flashcard';
  const ORDER = ['quiz', 'listening', 'fill', 'speak', 'blast', 'mix'];
  const modes = new Map();

  // Filled in by dashboard.js. `scheduled` is the one seam through which an
  // answer reaches the schedule — dashboard.js:applyGrade, the single writer,
  // shared with the review card — so nothing here touches word storage.
  // `misses` hands over the practice book's per-word tally, which is what
  // bands the queue below; reading it from store.js here would put a second
  // storage caller inside a file whose point is that it has none.
  const hooks = {
    speak: (entry) => pronounce(entry),
    changed: () => {},
    scheduled: () => {},
    misses: () => ({}),
    settings: () => ({}),
    saveSettings: () => {},
    // Back to the flashcard: the review queue has to be rebuilt, because
    // practice just moved cards that are sitting in it.
    flashcard: () => {}
  };

  // Resolved in place of an answer when the question ends without one.
  const GAVE_UP = Symbol('gave up');

  let abort = null;
  // The mode whose tab is showing, or null for the flashcard. Read by
  // dashboard.js through active(), which is what stands renderCard() and
  // review's keyboard down.
  let current = null;
  // The last entry the running question said out loud, which is what Space
  // replays. Remembered rather than recomputed: replaying means "say that
  // again", so a mode that has not spoken yet — Fill never does before the
  // answer — must make Space do nothing rather than read the answer out.
  let spoken = null;
  // Open testHost() claims. A selfTest drives real questions with real digit
  // keys and needs review to stand down for them, with no tab running.
  let claims = 0;
  // What the live strip was last drawn from, so a tab click knows its pool.
  let tabPool = [];
  let tabCounts = {};

  // mode: {
  //   title, blurb, icon, color      — the tab, and the panel header
  //   eligible(entry, pool) → bool   — can this word be asked in this mode
  //   min                            — eligible words needed to open it (default 1)
  //   why                            — shown on the tab when there are too few
  //   produces                       — true = the answer is the word itself
  //   schedules                      — false = a game; never moves the schedule
  //   fast                           — ms under which a right answer is Easy (0 = never)
  //   directions                     — ['w2m'] etc; the control hides below two
  //   ask(entry, host, ctx) → Promise<boolean>   one question; the shell loops
  //   run(entries, host, ctx) → Promise<void>    OR a whole session (a game);
  //                                              it records through ctx.record
  //   hint(entry, ctx) → node        — optional; the shell owns the button
  //   selfTest() → [[name, ok, detail?], …]      checks for test/practice-probe.html,
  //                                              or a Promise of them; may drive
  //                                              ask/run in a PRACTICE.testHost()
  // }
  function register(id, mode) {
    modes.set(id, {
      id, min: 1, why: 'Not enough words for this yet',
      produces: false, schedules: true, fast: FAST_MS, directions: ['w2m'],
      ...mode
    });
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

  function button(className, text) {
    const b = node('button', className, text);
    b.type = 'button';
    return b;
  }

  // Grades a typed answer the same way every mode does: case and outer spaces
  // never count against you.
  function same(typed, word) {
    return String(typed ?? '').trim().toLowerCase() === String(word ?? '').trim().toLowerCase();
  }

  function active() { return current !== null; }
  // Who owns the keyboard. Wider than active(), because a selfTest presses the
  // very digits review grades with and has no tab of its own to hide behind.
  function owns() { return current !== null || claims > 0; }

  /* ---------- the tab strip ---------- */

  // The session length the user picked, as a count, or 0 for "all".
  function sessionSize() {
    const saved = hooks.settings().practiceSession;
    return SESSIONS.includes(saved) ? saved : SESSIONS[0];
  }

  function tabs() {
    return [{ id: FLASHCARD, title: 'Flashcard', blurb: 'The review card', icon: '▤' }, ...list()];
  }

  // Attribute-only after the first render, and deliberately so: render() runs
  // on every storage change, which includes the write practice itself makes
  // after each answer. Rebuilding the strip would be harmless, but the habit
  // is not — the panel below is never touched here for the same reason, and a
  // strip that rebuilds is one edit away from a panel that does.
  //
  // Eligibility runs per mode per word and must stay a filter: calling
  // VT.quizOptions here once made this O(n²), ten seconds a render at 3,000
  // words, and test/practice-probe.html pins that it never happens again.
  function renderTabs(host, pool, counts = {}) {
    // Only the live strip's pool is remembered: a detached host (the probe
    // measures one) must not become what the next tab click asks about.
    if (host === document.getElementById('pr-tabs')) {
      tabPool = pool;
      tabCounts = counts;
    }
    const all = tabs();
    if (host.children.length !== all.length) {
      host.replaceChildren(...all.map(buildTab));
    }
    all.forEach((mode, i) => paintTab(host.children[i], mode, pool, counts));
  }

  function buildTab(mode) {
    const tab = button(`rvopt prtab ${mode.color ?? ''}`.trim());
    tab.setAttribute('role', 'tab');
    tab.dataset.mode = mode.id;
    tab.append(
      node('span', 'prtabglyph', mode.icon ?? '•'),
      node('span', 'prtablabel', mode.title),
      // Built empty rather than on demand: a count going from 0 to 1 must be a
      // text change, not an append, or the update pass stops being attribute-only.
      node('span', 'prbadge')
    );
    tab.addEventListener('click', () => pick(mode.id));
    return tab;
  }

  function paintTab(tab, mode, pool, counts) {
    const open = mode.id === FLASHCARD || eligibleFor(mode, pool).length >= mode.min;
    tab.setAttribute('aria-selected', String((current ?? FLASHCARD) === mode.id));
    tab.setAttribute('aria-disabled', String(!open));
    tab.title = open ? (mode.blurb ?? '') : mode.why;
    // The reason is on the label, not only in the title: a title is a hover,
    // and the people most likely to need the reason are the ones who will
    // never see one.
    tab.setAttribute('aria-label', open ? mode.title : `${mode.title} — ${mode.why}`);
    const done = counts[mode.id]?.total ?? 0;
    const badge = tab.querySelector('.prbadge');
    badge.hidden = !done;
    badge.textContent = done >= DAILY_GOAL ? `✓ ${done}` : `${done}/${DAILY_GOAL}`;
  }

  function paintTabs() {
    const host = document.getElementById('pr-tabs');
    if (host?.children.length) renderTabs(host, tabPool, tabCounts);
  }

  function pick(id) {
    const host = document.getElementById('pr-tabs');
    const tab = host?.querySelector(`[data-mode="${id}"]`);
    if (tab?.getAttribute('aria-disabled') === 'true') return;
    if (id === FLASHCARD) {
      stop();
      hooks.flashcard();
      return;
    }
    start(id, tabPool);
  }

  /* ---------- the panel ---------- */

  // The verdict line every ask-mode ends a question with. Resolves once you
  // have read it, on Enter or a click, with the verdict passed in — so a mode
  // can `return ctx.next(ok, answer)`.
  function next(host, correct, answer) {
    return new Promise((resolve) => {
      const bar = node('div', `prverdict ${correct ? 'good' : 'bad'}`);
      // role=status, so the verdict is spoken; the glyph, so right and wrong
      // are not told apart by the green and the red alone.
      bar.setAttribute('role', 'status');
      bar.appendChild(node('b', null, correct ? '✓ Correct' : '✕ Not quite'));
      if (answer != null) {
        bar.appendChild(typeof answer === 'string' ? node('span', null, answer) : answer);
      }
      const go = button('btn', 'Continue ');
      go.appendChild(node('kbd', null, 'enter'));
      go.addEventListener('click', () => { bar.remove(); resolve(correct); }, { once: true });
      bar.appendChild(go);
      host.appendChild(bar);
      // Focused, so Enter is the native button press: no key handler to leak.
      go.focus();
    });
  }

  // Bands the words rather than shuffling them flat: a word that is due, and a
  // word you have got wrong before, are the two things worth asking first, and
  // VT.shuffled treated a word missed three times exactly like one you have
  // never seen. Shuffled inside each band so the same round is not the same
  // order twice.
  function weighted(entries, misses) {
    const now = Date.now();
    const bands = new Map();
    for (const entry of entries) {
      const band = (entry.due <= now ? 2 : 0) + Math.min(misses[entry.word] ?? 0, 3);
      if (!bands.has(band)) bands.set(band, []);
      bands.get(band).push(entry);
    }
    return [...bands.keys()].sort((a, b) => b - a)
      .flatMap((band) => VT.shuffled(bands.get(band)));
  }

  // Which FSRS grade an answer earns. Recognition caps at Hard because picking
  // one of four options is a weaker signal than producing the word, which is
  // what the review card asks for — and Hard in FSRS is precisely "got it,
  // weakly": a Good on a new card leaves stability 2.3065 (due in two days)
  // where Hard leaves 1.2931 (due tomorrow), and on a mature card Hard damps
  // the stability increase by w[15]=0.6014 (lib.js:154). A hint means you were
  // helped to it, so it is capped the same way.
  function gradeFor(mode, correct, fast, hinted) {
    if (mode.schedules === false) return null;
    if (!correct) return 0;
    if (!mode.produces || hinted) return 3;
    return fast ? 5 : 4;
  }

  // Practice may move a schedule, never begin one.
  //
  // The due window needs no "already graded this word today" bookkeeping: any
  // grade sets interval >= 1 (lib.js:163), so the new due is at least a day
  // out and falls outside this window for the rest of the sitting. That holds
  // only while AHEAD_MS is under a day — widen it and a word can be graded
  // twice in one round.
  //
  // The reps/interval clause is the other half: an imported list holds a
  // thousand words back at twenty a day with a future due and reps 0
  // (newCards, dashboard.js:970). Without it a quiz round quietly eats
  // tomorrow's new cards and the review opens empty.
  function movable(entry) {
    return entry.due <= Date.now() + AHEAD_MS && (entry.reps > 0 || entry.interval > 0);
  }

  async function start(id, pool, only = null) {
    const mode = modes.get(id);
    if (!mode) return;
    abort?.abort();
    abort = new AbortController();
    const { signal } = abort;
    current = id;

    const panel = document.getElementById('pr-panel');
    // The shell owns which of the three fills this cell, because renderCard()
    // stands down while a tab is active and nothing else would un-hide them.
    document.getElementById('rv-card').hidden = true;
    document.getElementById('rv-empty').hidden = true;
    document.getElementById('rv-exit').hidden = true;
    panel.hidden = false;
    // The panel is one element reused by seven tabs, so its name has to say
    // which one is in it; role=tabpanel alone announces "tab panel".
    panel.setAttribute('aria-label', mode.title);
    const ui = buildPanel(mode);
    panel.replaceChildren(ui.root);
    paintTabs();

    let right = 0;
    let total = 0;
    let streak = 0;
    let hinted = false;
    let gaveUp = false;
    let recorded = false;
    // What the mode said the answer was, kept for the end-of-session miss list.
    let shown = null;
    // When the question went up. Zero for a run-mode: a game resolves its cards
    // on its own clock, so none of them can earn Easy.
    let asked = 0;
    // And when it was answered, which is not when ask() resolves. Every mode
    // ends `return ctx.next(ok, …)`, and next() resolves on Continue (:220),
    // so reading the clock there would count the seconds spent reading the
    // verdict as thinking time: "fast" would have meant "answered AND
    // dismissed inside six seconds", and Easy would be all but unreachable.
    let answered = 0;
    const missed = [];

    const paintCount = () => {
      ui.count.textContent = `${total} / ${ui.picks()} · ${right} right · ${streak} streak`;
      ui.fill.style.width = `${ui.picks() ? (total / ui.picks()) * 100 : 0}%`;
    };

    const record = async (entry, correct, modeId = id) => {
      if (signal.aborted) return;
      recorded = true;
      total++;
      if (correct) { right++; streak++; } else { streak = 0; missed.push({ entry, shown }); }
      // The mode that actually drew the question, which is Mix's whole problem:
      // a quiz question inside Mix is a quiz answer, and counting it as Mix
      // would also grade it with Mix's own `produces`.
      const drawn = modes.get(modeId) ?? mode;
      await recordPractice(modeId, entry.word, correct);
      const fast = asked > 0 && (answered || Date.now()) - asked <= drawn.fast;
      const quality = gradeFor(drawn, correct, fast, hinted);
      if (quality !== null && movable(entry)) await hooks.scheduled(entry, quality);
      paintCount();
      hooks.changed();
    };

    const ctx = {
      pool,
      signal,
      speak: (entry) => { spoken = entry; return hooks.speak(entry); },
      next: (correct, answer) => {
        shown = typeof answer === 'string' ? answer : shown;
        // The clock stops as the verdict paints, not when Continue is pressed.
        answered = Date.now();
        return next(ui.body, correct, answer);
      },
      record,
      same,
      node,
      status: (text) => { ui.status.textContent = text; },
      // A mode showing its own hint goes through here so the cap applies to it
      // too; the footer button is the shell's way of calling mode.hint().
      hint: (n) => { hinted = true; if (n) ui.body.appendChild(n); },
      skipped: () => gaveUp,
      direction: mode.directions[0],
      settings: hooks.settings()
    };

    const eligible = eligibleFor(mode, pool);
    const size = sessionSize();
    const ordered = only ?? weighted(eligible, hooks.misses());
    const picks = size ? ordered.slice(0, size) : ordered;
    ui.setPicks(picks.length);
    paintCount();

    try {
      if (mode.run) {
        ui.foot.hidden = true;
        await Promise.race([mode.run(picks, ui.body, ctx), settled(signal)]);
      } else {
        for (let i = 0; i < picks.length; i++) {
          if (signal.aborted) return;
          const entry = picks[i];
          // A question of its own, so a mode's listeners die with the question
          // and not only with the session: giving up on question three must not
          // leave its digit handler alive under question four.
          const question = new AbortController();
          ctx.signal = AbortSignal.any([signal, question.signal]);
          hinted = false;
          gaveUp = false;
          recorded = false;
          shown = null;
          spoken = null;
          answered = 0;
          ui.status.textContent = `Question ${i + 1} / ${picks.length}`;
          ui.body.replaceChildren();
          let give;
          const over = new Promise((resolve) => {
            give = () => { gaveUp = true; shown = 'skipped'; resolve(GAVE_UP); };
          });
          // The session ending is a give-up too, or a mode that never resolves
          // on its signal would hold this loop open after the tab has changed.
          signal.addEventListener('abort', () => give(), { once: true });
          ui.setGiveUp(give);
          ui.setHint(mode.hint ? () => ctx.hint(mode.hint(entry, ctx)) : null);
          asked = Date.now();
          let ok;
          try {
            // Raced, not awaited: no ask-mode resolves on ctx.signal, so a
            // close used to leave this await pending for good.
            ok = await Promise.race([mode.ask(entry, ui.body, ctx), over]);
          } finally {
            question.abort();
          }
          if (signal.aborted) return;
          if (ok === GAVE_UP) {
            await next(ui.body, false, answerOf(entry));
            if (signal.aborted) return;
          }
          if (!recorded) await record(entry, ok === GAVE_UP ? false : !!ok);
        }
      }
    } catch (err) {
      // A throw inside a mode used to leave an empty body and an unhandled
      // rejection, which reads as the feature simply not working.
      console.error('[vocab-track] practice mode failed', id, err);
      if (!signal.aborted) broke(ui, err);
      return;
    }
    if (signal.aborted) return;
    ctx.signal = signal;
    summary(ui, { right, total, missed, mode, pool });
  }

  // The right answer, for a question nobody answered.
  function answerOf(entry) {
    const gloss = VT.glossOf(entry);
    return gloss ? `${entry.word} — ${gloss}` : entry.word;
  }

  // Resolves when the session is abandoned, so a run-mode that ignores its
  // signal still lets start() finish rather than hanging on its promise.
  function settled(signal) {
    return new Promise((resolve) => {
      if (signal.aborted) resolve(GAVE_UP);
      else signal.addEventListener('abort', () => resolve(GAVE_UP), { once: true });
    });
  }

  function buildPanel(mode) {
    const root = node('div', 'prpanelin');
    const head = node('div', 'prphead');
    head.appendChild(node('span', `pricon ${mode.color ?? ''}`.trim(), mode.icon ?? '•'));
    const title = node('div', 'prptitle');
    // An <h2>, and outside every button: practice.js used to put an <h3> inside
    // the mode's own <button>, which is a heading you cannot navigate to.
    title.append(node('h2', null, mode.title), node('p', null, mode.blurb ?? ''));
    head.appendChild(title);
    const count = node('div', 'rvcount');
    head.appendChild(count);

    const full = button('btn ghost prpbtn', '⛶ Fullscreen');
    full.title = 'Fill the screen';
    full.addEventListener('click', () => {
      // documentElement, never .rvbody or the review section: a modal <dialog>
      // paints above a fullscreen element only when it descends from it, and
      // #tag-dlg is a body-level sibling (dashboard.html:341). Anything smaller
      // here makes 't' on the flashcard tab open a picker nobody can see.
      const request = document.fullscreenElement
        ? document.exitFullscreen() : document.documentElement.requestFullscreen();
      request?.catch?.((err) => console.error('[vocab-track] fullscreen refused', err));
    });
    const exit = button('btn ghost prpbtn', 'Exit');
    exit.addEventListener('click', () => pick(FLASHCARD));
    head.append(full, exit);

    const prog = node('div', 'rvprog');
    const fill = node('span');
    prog.appendChild(fill);

    const ctl = node('div', 'rvctl');
    ctl.append(...sessionControl(mode), ...directionControl(mode));

    const status = node('p', 'prstatus');
    // The one place progress is announced, so a screen reader hears the next
    // question start without the mode having to say so.
    status.setAttribute('aria-live', 'polite');

    const body = node('div', 'prbody');
    // showModal used to focus the first control for us; without it a mode with
    // no input of its own (Quiz, Fill) starts with focus back on the page.
    // The body takes it instead; a mode that has an input moves it on.
    body.tabIndex = -1;

    const foot = node('div', 'prfoot');
    const hint = button('btn ghost prhintbtn', '❓ Hint');
    hint.title = 'h — costs you the Easy';
    const give = button('btn ghost prgivebtn', "I don't know");
    // Not "Skip". #rv-skip on the review card means "don't ask again", and
    // dashboard.html:131 carries the comment explaining why the two must not
    // share a word.
    give.title = '? — graded as wrong';
    foot.append(hint, give);

    root.append(head, prog, ctl, status, body, foot);
    let picks = 0;
    const ui = {
      root, body, status, count, fill, foot, hint, give,
      picks: () => picks,
      setPicks: (n) => { picks = n; },
      setGiveUp(fn) {
        give.onclick = fn;
        give.disabled = !fn;
      },
      setHint(fn) {
        hint.onclick = fn ? () => { fn(); hint.disabled = true; } : null;
        // Shown only for a mode that supplied one, so the row never offers
        // help that does not exist.
        hint.hidden = !fn;
        hint.disabled = !fn;
      }
    };
    ui.setGiveUp(null);
    ui.setHint(null);
    body.focus();
    return ui;
  }

  // 10 / 25 / all, saved with the other review settings so the length you
  // chose is still chosen tomorrow. Changing it restarts the round: a control
  // that visibly does nothing until the next session reads as broken.
  function sessionControl(mode) {
    const label = node('span', 'prlen', 'Length');
    const buttons = SESSIONS.map((n) => {
      const b = button('rvopt', n ? String(n) : 'All');
      b.setAttribute('aria-pressed', String(n === sessionSize()));
      b.addEventListener('click', () => {
        hooks.saveSettings({ practiceSession: n });
        start(mode.id, tabPool);
      });
      return b;
    });
    return [label, ...buttons];
  }

  // Hidden below two, which is every mode today: a toggle on all seven tabs
  // that only Quiz will ever have two sides of is dead chrome on six of them.
  function directionControl(mode) {
    if (mode.directions.length < 2) return [];
    const LABELS = { w2m: 'Word \u2192 meaning', m2w: 'Meaning \u2192 word' };
    return mode.directions.map((id, i) => {
      const b = button('rvopt', LABELS[id] ?? id);
      b.setAttribute('aria-pressed', String(i === 0));
      return b;
    });
  }

  function broke(ui, err) {
    ui.body.replaceChildren(
      node('p', 'prask', 'That mode stopped'),
      node('p', 'prerror', String(err?.message ?? err)),
      node('p', 'prhint', 'Pick another tab, or the flashcard.')
    );
    ui.foot.hidden = true;
    ui.status.textContent = '';
  }

  function summary(ui, { right, total, missed, mode, pool }) {
    ui.body.replaceChildren();
    ui.status.textContent = '';
    ui.foot.hidden = true;
    const box = node('div', 'prsummary');
    box.append(
      node('p', 'prscore', `${right} / ${total}`),
      node('p', null, total ? (right === total ? 'Every one right.' : 'right this round.') : 'Nothing to practise.')
    );

    if (missed.length) {
      const misses = node('ul', 'prmisses');
      for (const { entry, shown } of missed) {
        const row = node('li', 'prmiss');
        row.append(node('b', null, entry.word), node('span', null, VT.glossOf(entry) ?? ''));
        // What the question ended up telling you, when it told you anything —
        // the modes hand their verdict line to ctx.next and that is the only
        // record of the attempt the shell has.
        if (shown) row.appendChild(node('i', null, shown));
        misses.appendChild(row);
      }
      box.appendChild(misses);
    }

    const row = node('div', 'dlgrow');
    if (missed.length) {
      const drill = button('btn ghost', 'Drill the misses');
      // The same mode over just these words, bypassing the band queue: you
      // already know which ones they are.
      drill.addEventListener('click', () => start(mode.id, pool, missed.map((m) => m.entry)));
      row.appendChild(drill);
    }
    const again = button('btn ghost', 'Again');
    again.addEventListener('click', () => start(mode.id, pool));
    const done = button('btn', 'Done');
    done.addEventListener('click', () => pick(FLASHCARD));
    row.append(again, done);
    box.appendChild(row);
    ui.body.appendChild(box);
    done.focus();
  }

  /* ---------- keyboard ---------- */

  // One map for every mode. The digits are not here: Quiz and Fill bind their
  // own on the document and phase 2 is where they hand them over. Everything
  // else is the shell's, and review's handler (dashboard.js:1332) stands down
  // for all of it while owns() is true.
  document.addEventListener('keydown', (event) => {
    if (!active()) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const panel = document.getElementById('pr-panel');
    if (event.key === 'Escape') {
      event.preventDefault();
      pick(FLASHCARD);
      return;
    }
    // Every letter belongs to the box while there is one: 'h' is a letter of
    // the word you are typing.
    if (event.target.closest?.('input, textarea, select')) return;
    if (event.key === ' ') {
      // A focused button owns its own Space — that is how Continue is pressed
      // — and Listening binds Ctrl+Space inside its box, which never reaches
      // here.
      if (event.target.closest?.('button') || !spoken) return;
      event.preventDefault();
      hooks.speak(spoken);
      return;
    }
    if (event.key === 'h' || event.key === 'H') {
      event.preventDefault();
      panel?.querySelector('.prhintbtn')?.click();
      return;
    }
    if (event.key === '?') {
      event.preventDefault();
      panel?.querySelector('.prgivebtn')?.click();
    }
  });

  /* ---------- for the self-tests ---------- */

  // A live host with review's keyboard stood down, which is the only reason
  // four selfTests used to open the dialog. Inside the panel and with the
  // panel shown, not beside it: focus() does nothing under a display:none
  // ancestor, and Speak's checks turn on whether its box took focus.
  function testHost() {
    const panel = document.getElementById('pr-panel');
    const host = node('div', 'prtesthost');
    if (panel) {
      panel.hidden = false;
      panel.appendChild(host);
    } else {
      document.body.appendChild(host);
    }
    claims++;
    return {
      host,
      done() {
        claims = Math.max(0, claims - 1);
        host.remove();
        // The teardown every caller used to write by hand: close the host and
        // halt whatever it started.
        if (!claims) stop();
      }
    };
  }

  // Leaving a tab stops the mode: timers and listeners hang off this signal, so
  // a game cannot keep ticking behind a flashcard. The panel is emptied and
  // hidden here; renderCard() decides what fills the cell once active() is
  // false again.
  function stop() {
    abort?.abort();
    abort = null;
    current = null;
    spoken = null;
    const panel = document.getElementById('pr-panel');
    if (panel) {
      panel.replaceChildren();
      panel.hidden = true;
    }
    paintTabs();
    hooks.changed();
  }

  return {
    register, list, modes, eligibleFor, renderTabs, start, stop, pick, testHost,
    active, owns, hooks, same, weighted, gradeFor, movable,
    FLASHCARD, SESSIONS, DAILY_GOAL, AHEAD_MS, FAST_MS
  };
})();
