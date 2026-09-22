// Quiz: recognition, either way round — the word against four meanings, or a
// meaning against four words.
//
// Word → meaning is the side panel's quiz grown to fit the panel:
// VT.quizOptions picks the distractors, so a C1 word is set against other C1
// glosses here too. Meaning → word is the mirror of it and needs WORD
// distractors, which no VT helper builds. practice-fill.js:21 already has that
// same-level picker for its own options, but a mode that reaches into another
// mode's file is how two files quietly become one, so wordOptions below is
// written again here and belongs in lib.js the day a third caller wants it.
// See practice.js for the contract.
//
// Wrapped so nothing here becomes a page global the other five modes could
// collide with — wordOptions is exactly the name two of them would pick.
(() => {
  // Both sides, in the order the shell's control draws them (practice.js:538).
  // Never reordered: the shell renders the pair straight from this array, so
  // moving the chosen side to the front would slide the buttons out from under
  // the cursor that just pressed one. `preferred` below carries the choice
  // instead.
  const DIRECTIONS = ['w2m', 'm2w'];
  // How long a right answer's verdict stays up before the round moves on.
  // Long enough to read the tick, short enough that ten wins are not ten
  // presses. A miss never auto-advances: the entry under it is the teaching.
  const ADVANCE_MS = 600;
  // The side you last chose, for the rest of the page. Not a saved review
  // pref: ctx hands a mode `settings` but no writer for them (practice.js:357),
  // and a toggle that outlives the tab is not worth a hook of its own.
  let preferred = DIRECTIONS[0];
  // The question on screen, for the direction buttons to act on. They are
  // wired once per session and outlive every question they switch, so they
  // cannot close over one; only one quiz question runs at a time.
  let live = null;

  PRACTICE.register('quiz', {
    title: 'Quiz',
    blurb: 'Pick the meaning',
    icon: '✓',
    color: 'amber',
    why: 'Needs four words with a meaning',
    // Picking one of four is recognition, so a right answer is worth Hard and
    // never Easy — practice.js:gradeFor carries the reasoning. True in both
    // directions: recognising the word among four is no harder than
    // recognising its meaning among four.
    produces: false,
    directions: DIRECTIONS,
    eligible: (entry, pool) => !!VT.glossOf(entry) && distinctGlosses(pool) >= 4,

    // The answer's first letter, which is the word one way round and the
    // meaning the other. The word's own letter would be no hint at all in
    // word → meaning: it is the thing you are already looking at.
    hint(entry, ctx) {
      const answer = ctx.direction === 'm2w' ? entry.word : (VT.glossOf(entry) ?? '');
      return ctx.node('p', 'prhint', `Starts with “${[...answer.trim()][0] ?? '?'}”`);
    },

    ask, selfTest
  });

  function ask(entry, host, ctx) {
    // Captured, because the shell points ctx.signal at a NEW question on every
    // pass of its loop (practice.js:379): an auto-advance timer left reading
    // ctx.signal would find the next question's live signal and press ITS
    // Continue for it.
    const { signal } = ctx;
    const gloss = VT.glossOf(entry);
    // This question's listeners only: dropped on the first answer, and on
    // abort, so a question left behind leaves nothing listening for 1-4.
    const done = new AbortController();
    signal.addEventListener('abort', () => done.abort(), { once: true, signal: done.signal });

    // Assigned by draw() rather than fixed, because a direction change rebuilds
    // both: the keydown handler is bound once and must always press the button
    // that is on screen now, not the one that was there when it was bound.
    let options = [];
    let buttons = [];
    let reverse = false;
    let answered = false;
    // Whether this question has spoken yet. The shell replays whatever a mode
    // last said on Space (practice.js:618) but has nothing to replay until the
    // mode has said it once, so the first press is ours and every one after is
    // the shell's — both firing would say the word twice.
    let said = false;

    return new Promise((resolve) => {
      const say = () => { said = true; ctx.speak(entry); };

      // Rebuilt, not patched, when the direction changes: a toggle that only
      // takes effect on the NEXT question reads as a control that did nothing,
      // and the question is four buttons and a heading. A hint already taken
      // goes with it — it answers the other question.
      const draw = () => {
        reverse = ctx.direction === 'm2w';
        // eligible() promises four distinct glosses, which is four words that
        // have one, so the reverse picker only comes up short on a pool that
        // changed under the round. Asking the same word the other way beats
        // throwing the session away.
        options = reverse ? wordOptions(entry, ctx.pool) : null;
        if (!options) {
          reverse = false;
          options = VT.quizOptions(entry, ctx.pool);
        }
        if (!options) throw new Error(`No other meanings left to set “${entry.word}” against`);

        const root = ctx.node('div', 'pr-quiz');
        const head = ctx.node('div', 'prq-head');
        // The prompt is whichever side is not being chosen from.
        head.appendChild(ctx.node('p', 'prask', reverse ? gloss : entry.word));
        // No ear in reverse, and no IPA either: the round is asking which word
        // this means, and the word said out loud is the answer to it.
        if (!reverse) head.appendChild(playButton(entry, ctx, say, done.signal));
        root.appendChild(head);
        if (!reverse && entry.ipa) root.appendChild(ctx.node('p', 'prhint prq-ipa', `/${entry.ipa}/`));

        const grid = ctx.node('div', 'propts');
        buttons = options.map((option, i) => {
          const b = ctx.node('button');
          b.type = 'button';
          // The digit alone in the <kbd> and the option alone beside it:
          // test/practice-probe.html:265 reads an option back as
          // textContent.slice(1) to find the right one, so a third piece of
          // text in here would make the probe answer its own questions wrong.
          b.append(ctx.node('kbd', null, String(i + 1)), ctx.node('span', 'prq-text', option.text));
          b.addEventListener('click', () => pick(i), { signal: done.signal });
          grid.appendChild(b);
          return b;
        });
        root.appendChild(grid);
        host.replaceChildren(root);
      };

      // Guarded, not just disabled: a key and a click in the same tick would
      // both get here before the buttons repaint as disabled.
      const pick = (i) => {
        if (answered) return;
        answered = true;
        done.abort();
        const ok = options[i].correct;
        buttons.forEach((b, j) => {
          b.disabled = true;
          if (options[j].correct) b.classList.add('right');
        });
        if (!ok) buttons[i].classList.add('wrong');
        // A win is a receipt, so it dismisses itself; a miss keeps the whole
        // entry on screen until you have read it, because that is the only
        // moment in the round where the word gets taught.
        const over = ctx.next(ok, ok ? `${entry.word} — ${gloss}` : fullEntry(entry, ctx));
        if (ok) advance(host, signal);
        resolve(over);
      };

      live = { ctx, redraw: () => { if (!answered) draw(); } };
      wireDirection(host, ctx);
      draw();

      document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        // Every letter and digit belongs to the box while there is one, exactly
        // as the shell's own map has it (practice.js:614).
        if (e.target.closest?.('input, textarea, select')) return;
        if (e.key === ' ') {
          // A focused button owns its Space — that is how the verdict's
          // Continue is pressed — and after the first play the shell is the
          // one replaying.
          if (said || reverse || e.target.closest?.('button')) return;
          e.preventDefault();
          say();
          return;
        }
        const i = Number(e.key) - 1;
        if (!(i >= 0 && i < buttons.length)) return;
        e.preventDefault();
        pick(i);
      }, { signal: done.signal });
    });
  }

  function playButton(entry, ctx, say, signal) {
    const play = ctx.node('button', 'prq-play', '▶');
    play.type = 'button';
    play.title = 'Listen — space';
    play.setAttribute('aria-label', `Listen to ${entry.word}`);
    play.addEventListener('click', say, { signal });
    return play;
  }

  // Auto-advance is the shell's Continue pressed for you, never a second way
  // out of the question: the verdict bar stays the one place a question ends,
  // so a click, Enter and the timer cannot resolve it three different ways.
  // Nothing to clear on abort — the bar goes with the panel, and a press on a
  // button that is no longer in the host finds nothing.
  function advance(host, signal) {
    setTimeout(() => {
      if (signal.aborted) return;
      host.querySelector('.prverdict .btn')?.click();
    }, ADVANCE_MS);
  }

  // Everything the review card would have shown, for a question that went
  // wrong: the word, how it sounds, what it means, the sentence it was saved
  // from. A node rather than a string, which costs the shell's miss list its
  // third column (practice.js:347 remembers only strings) — no loss, because
  // that row already prints the word and the gloss, and the sentence belongs
  // to the moment you got it wrong rather than to a list.
  function fullEntry(entry, ctx) {
    const box = ctx.node('span', 'prq-full');
    box.appendChild(ctx.node('b', null, entry.word));
    if (entry.ipa) box.appendChild(ctx.node('i', null, `/${entry.ipa}/`));
    const gloss = VT.glossOf(entry);
    if (gloss) box.appendChild(ctx.node('span', null, gloss));
    const sentence = entry.context ?? (entry.senses ?? []).map((s) => s.example).find(Boolean);
    if (sentence) box.appendChild(ctx.node('q', null, sentence));
    return box;
  }

  // The shell draws the pair of buttons for a mode that declares two
  // directions (practice.js:538) but binds nothing to them: phase 1 shipped
  // the control with no mode to give it behaviour. Quiz is that mode, so the
  // behaviour lives here until the shell grows its own — and a second control
  // of Quiz's own is the one thing the panel must not grow.
  //
  // Found by offset rather than by label: the control is the session buttons
  // followed by one button per direction, and matching the shell's wording
  // ("Word → meaning") would be a copy of a string that lives in another file.
  function wireDirection(host, ctx) {
    const ctl = host.closest('.prpanelin')?.querySelector('.rvctl');
    // No control at all is the normal case, not a failure: Mix draws quiz
    // questions inside a panel of its own that has no direction pair, and a
    // selfTest has no panel. Both must pass quietly.
    const all = ctl ? [...ctl.querySelectorAll('button')] : [];
    const dirs = all.slice(PRACTICE.SESSIONS.length);
    if (dirs.length !== DIRECTIONS.length) return;
    const paint = () => dirs.forEach((b, i) => b.setAttribute('aria-pressed', String(DIRECTIONS[i] === preferred)));
    // The shell opens every round at directions[0] (practice.js:356), so the
    // side you chose last round is put back here, on its first question.
    ctx.direction = preferred;
    if (dirs[0].dataset.prqdir) {
      paint();
      return;
    }
    dirs.forEach((b, i) => {
      b.dataset.prqdir = DIRECTIONS[i];
      b.addEventListener('click', () => {
        preferred = DIRECTIONS[i];
        paint();
        if (!live) return;
        live.ctx.direction = preferred;
        live.redraw();
      });
    });
    paint();
  }

  // Three other words to set against a meaning. Same level first, as
  // quizOptions does with glosses, so the level is not itself the answer.
  // A word that means the same thing is out: with the gloss as the question,
  // two words carrying it are two right answers.
  function wordOptions(entry, pool) {
    const answer = VT.glossOf(entry);
    const near = [];
    const far = [];
    const seen = new Set([entry.word.toLowerCase()]);
    for (const other of pool ?? []) {
      const key = other?.word?.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (VT.glossOf(other)?.trim().toLowerCase() === answer?.trim().toLowerCase()) continue;
      const option = { word: other.word, text: other.word, correct: false };
      (other.level && other.level === entry.level ? near : far).push(option);
    }
    const picked = [...VT.shuffled(near), ...VT.shuffled(far)].slice(0, 3);
    if (picked.length < 3) return null;
    return VT.shuffled([{ word: entry.word, text: entry.word, correct: true }, ...picked]);
  }

  // Eligibility runs for every word in scope on every render — and Mix asks it
  // again — so it must not build the question. quizOptions shuffles the whole
  // pool per call, which made the grid O(n²): ten seconds a render at 3,000
  // words. What quizOptions actually needs is three glosses other than this
  // word's own, and four distinct glosses in the pool guarantee that for any
  // word — and guarantee wordOptions its three words too, since a distinct
  // gloss is a distinct word carrying it. Counted once per pool array, since
  // one render passes the same array to every mode.
  const glossCounts = new WeakMap();
  function distinctGlosses(pool) {
    if (!glossCounts.has(pool)) {
      const seen = new Set();
      for (const entry of pool) {
        const gloss = VT.glossOf(entry);
        if (gloss) seen.add(gloss.trim().toLowerCase());
      }
      glossCounts.set(pool, seen.size);
    }
    return glossCounts.get(pool);
  }

  async function selfTest() {
    const out = [];
    const mode = PRACTICE.modes.get('quiz');
    const pool = Object.values(await getWords());
    const entry = pool.find((e) => VT.quizOptions(e, pool));
    const gloss = VT.glossOf(entry);
    const press = (key) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const node = (tag, className, text) => {
      const n = document.createElement(tag);
      if (className) n.className = className;
      if (text != null) n.textContent = text;
      return n;
    };
    // The digits are review's grade keys too. Review stands down while a
    // practice tab owns the keyboard, and a testHost is how a selfTest claims
    // that with no tab running — otherwise each press below would grade
    // whatever card review has showing.
    const claim = PRACTICE.testHost();
    // The checks below press a real direction control, which is a real choice:
    // put the page back on the side it was on for whatever runs after.
    const chosen = preferred;
    try {
      return await checks();
    } finally {
      preferred = chosen;
      claim.done();
    }

    async function checks() {

    // One question in a detached host, with a ctx that counts verdicts instead
    // of drawing them — and the shell's panel in miniature around it, because
    // the direction pair is found by its offset inside .rvctl and there is no
    // real panel here to find it in.
    function run(direction) {
      preferred = direction;
      const panel = document.createElement('div');
      panel.className = 'prpanelin';
      const ctl = document.createElement('div');
      ctl.className = 'rvctl';
      for (let i = 0; i < PRACTICE.SESSIONS.length + DIRECTIONS.length; i++) {
        ctl.appendChild(document.createElement('button'));
      }
      const host = document.createElement('div');
      panel.append(ctl, host);
      claim.host.appendChild(panel);
      const abort = new AbortController();
      const verdicts = [];
      const spoke = [];
      const ctx = {
        pool, direction, node, signal: abort.signal, status() {}, same: PRACTICE.same,
        speak(e) { spoke.push(e.word); },
        // The shell's verdict bar in miniature: ctx.next resolves on Continue
        // and on nothing else (practice.js:220), which is the button
        // auto-advance presses.
        next(ok, answer) {
          verdicts.push([ok, answer]);
          return new Promise((resolve) => {
            const bar = node('div', 'prverdict');
            const go = node('button', 'btn', 'Continue');
            go.addEventListener('click', () => { bar.remove(); resolve(ok); }, { once: true });
            bar.appendChild(go);
            host.appendChild(bar);
          });
        }
      };
      const done = mode.ask(entry, host, ctx);
      let settled = false;
      done.then(() => { settled = true; });
      const q = {
        ctx, host, verdicts, spoke, done, abort,
        dirs: [...ctl.querySelectorAll('button')].slice(PRACTICE.SESSIONS.length),
        // Re-read every time: a direction change replaces every button.
        opts: () => [...host.querySelectorAll('.propts button')],
        // The <kbd> digit is the first character; the rest is the option.
        right: () => q.opts().findIndex((b) => b.textContent.slice(1) === (q.ctx.direction === 'm2w' ? entry.word : gloss)),
        go: () => host.querySelector('.prverdict .btn'),
        settled: () => settled,
        close() { abort.abort(); panel.remove(); }
      };
      return q;
    }

    let q = run('w2m');
    const answers = q.opts().filter((b) => b.textContent.slice(1) === gloss).length;
    out.push(['four options, exactly one of them the answer',
      q.opts().length === 4 && answers === 1, `${q.opts().length} options, ${answers} right`]);
    out.push(['every option is a numbered row with its own digit',
      q.opts().every((b, i) => b.querySelector('kbd')?.textContent === String(i + 1)),
      q.opts().map((b) => b.querySelector('kbd')?.textContent).join('|')]);
    press(' ');
    press(' ');
    out.push(['space says the word, once, and leaves the replay to the shell',
      q.spoke.length === 1 && q.spoke[0] === entry.word, q.spoke.join('|')]);
    const at = q.right();
    press('3');
    out.push(['key 3 picks the third option',
      q.verdicts.length === 1 && q.opts()[2].classList.contains(at === 2 ? 'right' : 'wrong'),
      q.opts().map((b) => b.className).join('|')]);
    // Answered already: neither a key nor a click may count again.
    press('1');
    q.opts()[0].click();
    await Promise.resolve();
    out.push(['answering twice records once',
      q.verdicts.length === 1 && !q.opts()[0].classList.contains('wrong'), `${q.verdicts.length} verdicts`]);
    q.go().click();
    const first = await q.done;
    out.push(['and the question resolves with whether it was right', first === (at === 2), String(first)]);
    q.close();

    q = run('w2m');
    const wrongAt = (q.right() + 1) % 4;
    const rightAt = q.right();
    q.opts()[wrongAt].click();
    const shown = q.verdicts[0][1];
    out.push(['a wrong pick marks it wrong and shows the right one',
      q.verdicts[0][0] === false && q.opts()[wrongAt].classList.contains('wrong')
        && q.opts()[rightAt].classList.contains('right')
        && q.opts().every((b) => b.disabled),
      q.opts().map((b) => b.className).join('|')]);
    const sentence = entry.context ?? (entry.senses ?? []).map((s) => s.example).find(Boolean);
    out.push(['and the miss is taught with the whole entry, not just the gloss',
      shown?.textContent?.includes(entry.word) && shown.textContent.includes(gloss)
        && (!entry.ipa || shown.textContent.includes(entry.ipa))
        && (!sentence || shown.textContent.includes(sentence)),
      shown?.textContent]);
    // A miss is never dismissed for you, however long you leave it.
    await wait(ADVANCE_MS + 200);
    out.push(['a wrong answer waits for Continue', !q.settled() && !!q.go()]);
    q.close();

    q = run('w2m');
    q.opts()[q.right()].click();
    const walked = await Promise.race([q.done.then(() => true), wait(ADVANCE_MS + 400).then(() => false)]);
    out.push(['a right answer walks on by itself', walked === true]);
    q.close();

    q = run('m2w');
    out.push(['meaning → word asks the meaning and offers words',
      q.host.querySelector('.prask')?.textContent === gloss
        && q.opts().length === 4
        && q.opts().filter((b) => b.textContent.slice(1) === entry.word).length === 1,
      q.opts().map((b) => b.textContent).join('|')]);
    press(' ');
    out.push(['and never says the word, which would be the answer',
      q.spoke.length === 0 && !q.host.querySelector('.prq-play'), q.spoke.join('|')]);
    q.dirs[0].click();
    out.push(['the shell’s direction control turns the question over on the spot',
      q.ctx.direction === 'w2m' && q.host.querySelector('.prask')?.textContent === entry.word
        && q.dirs[0].getAttribute('aria-pressed') === 'true'
        && q.dirs[1].getAttribute('aria-pressed') === 'false',
      q.dirs.map((b) => b.getAttribute('aria-pressed')).join('|')]);
    // The keydown handler is bound once per question and the buttons under it
    // have just been replaced: it must press the one that is on screen now.
    press('2');
    out.push(['and the digits answer the question that is on screen now',
      q.verdicts.length === 1 && /right|wrong/.test(q.opts()[1].className),
      q.opts().map((b) => b.className).join('|')]);
    q.close();

    const tip = (direction) => mode.hint(entry, { direction, node }).textContent;
    out.push(['the hint is the answer’s first letter, whichever way round',
      tip('m2w').includes(`“${entry.word[0]}”`) && tip('w2m').includes(`“${gloss[0]}”`),
      `${tip('m2w')} / ${tip('w2m')}`]);

    // Abandoned, not removed: the buttons stay on the page so that a key
    // reaching one of them would still show, which is the whole check.
    q = run('w2m');
    q.abort.abort();
    press('2');
    await Promise.resolve();
    out.push(['no key listener after the session is abandoned',
      q.verdicts.length === 0 && q.opts().every((b) => !b.disabled), `${q.verdicts.length} verdicts`]);
    q.close();
    return out;
    }
  }
})();
