// Quiz: the English word, four meanings, pick one.
//
// The same four-option question the side panel's quiz asks, grown to fit the
// dialog: VT.quizOptions picks the distractors, so a C1 word is set against
// other C1 glosses here too. See practice.js for the contract.
PRACTICE.register('quiz', {
  title: 'Quiz',
  blurb: 'Pick the meaning',
  icon: '✓',
  color: 'amber',
  why: 'Needs four words with a meaning',
  eligible: (entry, pool) => !!VT.quizOptions(entry, pool),
  ask(entry, host, ctx) {
    const { node } = ctx;
    const options = VT.quizOptions(entry, ctx.pool);
    const gloss = VT.glossOf(entry);
    const root = node('div', 'pr-quiz');

    const head = node('div', 'prq-head');
    head.appendChild(node('p', 'prask', entry.word));
    const play = node('button', 'prq-play', '▶');
    play.type = 'button';
    play.title = 'Listen';
    play.setAttribute('aria-label', `Listen to ${entry.word}`);
    play.addEventListener('click', () => ctx.speak(entry));
    head.appendChild(play);
    root.appendChild(head);
    if (entry.ipa) root.appendChild(node('p', 'prhint prq-ipa', `/${entry.ipa}/`));

    const grid = node('div', 'propts');
    const buttons = options.map((option, i) => {
      const b = node('button');
      b.type = 'button';
      b.append(node('kbd', null, String(i + 1)), option.text);
      grid.appendChild(b);
      return b;
    });
    root.appendChild(grid);
    host.appendChild(root);

    return new Promise((resolve) => {
      // This question's listeners only: dropped on the first answer, and on
      // abort, so a closed dialog leaves nothing listening for 1-4.
      const done = new AbortController();
      ctx.signal.addEventListener('abort', () => done.abort(), { once: true, signal: done.signal });

      // Guarded, not just disabled: a key and a click in the same tick would
      // both get here before the buttons repaint as disabled.
      let answered = false;
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
        resolve(ctx.next(ok, `${entry.word} — ${gloss}`));
      };

      buttons.forEach((b, i) => b.addEventListener('click', () => pick(i), { signal: done.signal }));
      document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const i = Number(e.key) - 1;
        if (!(i >= 0 && i < buttons.length)) return;
        e.preventDefault();
        pick(i);
      }, { signal: done.signal });
    });
  },
  async selfTest() {
    const out = [];
    const pool = Object.values(await getWords());
    const entry = pool.find((e) => VT.quizOptions(e, pool));
    const press = (key) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    // The digits are review's grade keys too. Review stands down only while
    // the practice dialog is open, so it is open for every press below —
    // otherwise each one would grade whatever card review has showing.
    const dlg = document.getElementById('practice-dlg');
    const opened = !dlg.open;
    if (opened) dlg.showModal();
    try {
      return await checks();
    } finally {
      if (opened) dlg.close();
    }

    async function checks() {

    // One question in a detached host, with a ctx that counts verdicts instead
    // of drawing them.
    function run() {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const abort = new AbortController();
      const verdicts = [];
      const ctx = {
        pool, signal: abort.signal, speak() {}, status() {}, same: PRACTICE.same,
        node(tag, className, text) {
          const n = document.createElement(tag);
          if (className) n.className = className;
          if (text != null) n.textContent = text;
          return n;
        },
        next(ok, answer) { verdicts.push([ok, answer]); return Promise.resolve(ok); }
      };
      const done = PRACTICE.modes.get('quiz').ask(entry, host, ctx);
      const buttons = [...host.querySelectorAll('.propts button')];
      // The <kbd> digit is the first character; the rest is the gloss.
      const correct = buttons.findIndex((b) => b.textContent.slice(1) === VT.glossOf(entry));
      return { abort, verdicts, done, buttons, correct, close() { abort.abort(); host.remove(); } };
    }

    let q = run();
    const answers = q.buttons.filter((b) => b.textContent.slice(1) === VT.glossOf(entry)).length;
    out.push(['four options, exactly one of them the answer',
      q.buttons.length === 4 && answers === 1, `${q.buttons.length} options, ${answers} right`]);
    press('3');
    const first = await q.done;
    out.push(['key 3 picks the third option',
      q.verdicts.length === 1 && first === (q.correct === 2)
        && q.buttons[2].classList.contains(q.correct === 2 ? 'right' : 'wrong'),
      q.buttons.map((b) => b.className).join('|')]);
    // Answered already: neither a key nor a click may count again.
    press('1');
    q.buttons[0].click();
    await Promise.resolve();
    out.push(['answering twice records once',
      q.verdicts.length === 1 && !q.buttons[0].classList.contains('wrong'), `${q.verdicts.length} verdicts`]);
    q.close();

    q = run();
    const wrongAt = (q.correct + 1) % 4;
    q.buttons[wrongAt].click();
    const ok = await q.done;
    out.push(['a wrong pick marks it wrong and shows the right one',
      ok === false && q.buttons[wrongAt].classList.contains('wrong')
        && q.buttons[q.correct].classList.contains('right')
        && q.buttons.every((b) => b.disabled)
        && q.verdicts[0][1] === `${entry.word} — ${VT.glossOf(entry)}`,
      q.buttons.map((b) => b.className).join('|')]);
    q.close();

    q = run();
    q.abort.abort();
    press('2');
    await Promise.resolve();
    out.push(['no key listener after the dialog closes',
      q.verdicts.length === 0 && q.buttons.every((b) => !b.disabled), `${q.verdicts.length} verdicts`]);
    q.close();
    return out;
    }
  }
});
