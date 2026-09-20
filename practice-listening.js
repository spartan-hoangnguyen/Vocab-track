// Listening: hear the word, type it.
//
// Nothing on screen gives the word away until you answer — no letters, no
// gloss — so the only way in is the sound. Graded exactly (ctx.same): a near
// miss is still a miss here, but the diff shows which letters it was, the
// same marks review uses.
PRACTICE.register('listening', {
  title: 'Listening',
  blurb: 'Hear it, type it',
  icon: '♪',
  color: 'green',
  // A phrase is candidate words joined by a space or a hyphen, which covers the
  // single-word case for free ('cat'.split(/[ -]/) is ['cat']) — so one clause
  // replaces the two this had, and no language needs a branch. The clause it
  // replaces was /^[a-z]+(?:[ -][a-z]+)+$/i, the saved-phrase escape hatch for
  // "give up": ASCII-anchored, so no Korean phrase could ever pass it.
  //
  // Through the entry's own pack rather than VT.isLookupCandidate, which would
  // re-detect the script once per part. One behaviour change, accepted: en's
  // isCandidate wants two letters, so "a b" is no longer eligible.
  eligible: (entry) => {
    const pack = LANG.of(entry);
    return String(entry.word).split(/[ -]/).every((part) => pack.isCandidate(part));
  },
  ask(entry, host, ctx) {
    const { node } = ctx;
    const root = node('div', 'pr-listening');
    // Ends with the question, and with the dialog: the replay shortcut must
    // not outlive either.
    const done = new AbortController();
    ctx.signal.addEventListener('abort', () => done.abort(), { once: true, signal: done.signal });

    // A form, so Enter is the native submit and not another key handler.
    const form = node('form', 'prlform');
    const input = node('input', 'prinput');
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Type what you hear');
    form.appendChild(input);

    // A button, not a letter key: every letter belongs to the input. Tab
    // reaches it, and Ctrl+Space replays without leaving the box.
    const play = node('button', 'btn ghost prlplay', '▶ Play again');
    play.type = 'button';
    play.title = 'Ctrl+Space';
    play.addEventListener('click', () => {
      ctx.speak(entry);
      if (!input.disabled) input.focus();
    });

    root.append(
      play,
      node('p', 'prhint', 'Type what you hear'),
      form
    );
    host.appendChild(root);

    root.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.code === 'Space') {
        // Consumed here: Space is review's reveal key, and this one is ours.
        e.preventDefault();
        e.stopPropagation();
        ctx.speak(entry);
      }
    }, { signal: done.signal });

    ctx.speak(entry);
    input.focus();

    return new Promise((resolve) => {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        done.abort();
        input.disabled = true;
        const typed = input.value;
        // Empty is "I don't know": wrong, and nothing to diff.
        const ok = typed.trim() !== '' && ctx.same(typed, entry.word);

        // Diff first, the word under it: what you typed, then what it was.
        if (!ok && typed.trim()) {
          // Marked up rather than described: seeing `pi[d]geon` is the
          // correction. Nodes, never innerHTML — this is whatever was typed.
          const diff = node('p', 'prldiff');
          for (const mark of VT.diffWord(typed, entry.word).typed) {
            diff.appendChild(node(mark.ok ? 'span' : 'u', null, mark.text));
          }
          root.appendChild(diff);
        }
        // Now the word can show: what it was, how it sounds, what it means.
        const reveal = node('div', 'prlreveal');
        reveal.appendChild(node('p', 'prask', entry.word));
        if (entry.ipa) reveal.appendChild(node('p', 'prlipa', `/${entry.ipa}/`));
        const gloss = VT.glossOf(entry);
        if (gloss) reveal.appendChild(node('p', 'prhint', gloss));
        root.appendChild(reveal);

        const answer = ok ? null : typed.trim() ? `It was “${entry.word}”` : "You didn't answer";
        resolve(ctx.next(ok, answer));
      }, { once: true, signal: ctx.signal });
    });
  },
  async selfTest() {
    const entry = { word: 'Strategy', ipa: 'ˈstrætədʒi', vi: 'chiến lược' };
    // Answers one question with `typed` in a detached host and reports what
    // the shell would have seen.
    const attempt = async (typed) => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const ac = new AbortController();
      let spoke = 0;
      let verdict = null;
      const ctx = {
        pool: [entry],
        signal: ac.signal,
        speak: () => { spoke++; },
        next: (correct, answer) => { verdict = { correct, answer }; return Promise.resolve(correct); },
        record() {},
        same: PRACTICE.same,
        node: (tag, cls, text) => {
          const n = document.createElement(tag);
          if (cls) n.className = cls;
          if (text != null) n.textContent = text;
          return n;
        },
        status() {}
      };
      const pending = this.ask(entry, host, ctx);
      const spokeOnShow = spoke;
      const input = host.querySelector('.prinput');
      const focused = document.activeElement === input;
      // Ctrl+Space in the box replays and leaves the box alone.
      const ev = new KeyboardEvent('keydown', { code: 'Space', key: ' ', ctrlKey: true, bubbles: true, cancelable: true });
      input.dispatchEvent(ev);
      const replayed = spoke === spokeOnShow + 1 && ev.defaultPrevented;
      input.value = typed;
      host.querySelector('form').requestSubmit();
      const ok = await pending;
      // After the answer the shortcut is gone. Not bubbling: with no listener
      // left to stop it, it would reach review's Space and reveal a card.
      host.querySelector('.pr-listening').dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', ctrlKey: true }));
      const out = {
        ok, verdict, spokeOnShow, focused, replayed,
        lateSpeak: spoke !== spokeOnShow + 1,
        marks: host.querySelectorAll('.prldiff u').length,
        revealed: host.querySelector('.prlreveal')?.textContent ?? ''
      };
      ac.abort();
      host.remove();
      return out;
    };

    // ask() takes focus, as it should in the dialog. Handed back after, so
    // whatever the page had focused (the review box) is left as it was found.
    const had = document.activeElement;
    const exact = await attempt('  strATEGY ');
    const near = await attempt('stratgey');
    const blank = await attempt('');
    had?.focus?.();
    return [
      ['listening: the word is spoken once on show', exact.spokeOnShow === 1, `spoke ${exact.spokeOnShow}`],
      ['listening: the input is focused on show', exact.focused],
      ['listening: Ctrl+Space replays, and the key does not reach the input', exact.replayed],
      ['listening: the replay shortcut is removed once answered', !exact.lateSpeak],
      ['listening: the exact word in any case is correct', exact.ok === true && exact.verdict?.correct === true],
      ['listening: a near miss is wrong', near.ok === false && near.verdict?.correct === false],
      ['listening: a near miss shows <u> marks', near.marks > 0, `marks ${near.marks}`],
      ['listening: an empty Enter is wrong', blank.ok === false && blank.verdict?.correct === false],
      ['listening: the answer reveals word, IPA and gloss',
       ['Strategy', '/ˈstrætədʒi/', 'chiến lược'].every((t) => near.revealed.includes(t)), near.revealed]
    ];
  }
});
