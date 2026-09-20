// Listening: hear the word, type it.
//
// Nothing on screen gives the word away until you answer — no letters, no
// gloss — so the only way in is the sound. Graded exactly (ctx.same): a near
// miss is still a miss here, but the diff shows which letters it was, the
// same marks review uses.
//
// Wrapped, so the voice guard below is a local and not another global on a
// page that loads every mode into one scope.
(() => {
  // The primary subtags this machine can actually speak, or null for "not
  // known yet" — which is NOT the same as "none".
  //
  // getVoices() is populated asynchronously: the first call on a cold page
  // legitimately returns [] and the real list arrives later on voiceschanged.
  // Reading [] as "no voices" would hide Listening for the first few hundred
  // milliseconds on every machine, and forever in headless Chrome, which ships
  // none at all. So [] caches nothing and answers null.
  //
  // Cached because eligible() runs for every word on every grid render
  // (practice.js:66, and Mix runs it again per word) and getVoices() builds a
  // fresh array of ~150 voice objects per call — the grid already carries one
  // O(n²) scar from doing real work in eligibility.
  let spoken = null;
  const base = (tag) => String(tag ?? '').toLowerCase().split(/[-_]/)[0];

  function voiceTags() {
    if (spoken) return spoken;
    const list = speechSynthesis?.getVoices?.() ?? [];
    if (!list.length) return null;
    spoken = new Set(list.map((v) => base(v.lang)));
    return spoken;
  }

  // Dropped, not rebuilt: the next reader rebuilds it. This is the case the
  // guard exists for — you are told no Korean voice is installed, you download
  // one, and the next grid render in this tab sees it. The next one, not this
  // instant: the grid is redrawn by refresh()/hooks.changed(), and nothing
  // here reaches in to repaint it.
  const forget = () => { spoken = null; };
  speechSynthesis?.addEventListener?.('voiceschanged', forget);

  // Primary subtag only: Chrome reports its Korean voice as ko-KR, ko_KR or
  // bare ko depending on the platform, and en-GB must satisfy an en-US pack
  // voice — a card is playable if the language can be said at all, not if the
  // accent matches.
  function speakable(pack) {
    const have = voiceTags();
    return !have || pack.voices.some((v) => have.has(base(v.bcp47)));
  }

  PRACTICE.register('listening', {
    title: 'Listening',
    blurb: 'Hear it, type it',
    icon: '♪',
    color: 'green',
    // Two ways to have nothing to ask now, so the default ("Not enough words
    // for this yet") would lie to the one that matters: fifty Korean words and
    // no Korean voice installed is not a shortage of words. One string honest
    // about both, because `why` is read at render (practice.js:80) and has no
    // pool to look at.
    why: 'No words this device can say yet',
    // A phrase is candidate words separated by whitespace, which covers the
    // single-word case for free ('cat'.split(/\s+/) is ['cat']) — so one clause
    // replaces the two this had, and no language needs a branch. The clause it
    // replaces was /^[a-z]+(?:[ -][a-z]+)+$/i, the saved-phrase escape hatch for
    // "give up": ASCII-anchored, so no Korean phrase could ever pass it.
    //
    // Whitespace ONLY, never /[ -]/. A hyphen is word-INTERNAL and en's
    // isCandidate already owns it (/^[a-z]+(-[a-z]+)*$/); splitting on it handed
    // en's two-character minimum a half-word to judge, and x-ray, e-mail,
    // t-shirt, u-turn and e-commerce all fell out of Listening silently.
    //
    // Through the entry's own pack rather than VT.isLookupCandidate, which would
    // re-detect the script once per part. One behaviour change, accepted: en's
    // isCandidate wants two letters, so "a b" is no longer eligible.
    // ponytail: that minimum is per PART, so a saved "a lot" would go with it.
    // Nothing can save one today — every resolveWord caller gates on
    // VT.isLookupCandidate, which rejects any string with a space in it
    // (content-script.js:77 and :295, dashboard.js:304, lib.js:595) — so the rule
    // costs nothing yet. Exempt multi-part words from the minimum the day a
    // phrase becomes savable.
    //
    // And the language has to be sayable here, or the question has no question in
    // it: Chrome neither throws nor fires an error on a missing voice, it is just
    // silent (lookup.js:122).
    eligible: (entry) => {
      const pack = LANG.of(entry);
      return String(entry.word).trim().split(/\s+/).every((part) => pack.isCandidate(part))
        && speakable(pack);
    },
    ask(entry, host, ctx) {
      const { node } = ctx;
      const pack = LANG.of(entry);
      // A card can still arrive mute: eligible() ran while the voice list was
      // empty (the async fill above), and the list that turned up has no voice
      // for this pack. speak() in lookup.js cannot say so — it owns no surface —
      // so this is the caller that has one. Saying nothing here is the defect:
      // the card plays silence and the only way out is a wrong answer.
      const mute = !speakable(pack);
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

      // One way to make a sound, so a mute card makes none from any of the three
      // (show, the button, the shortcut) rather than two of them.
      const say = () => { if (!mute) ctx.speak(entry); };

      // A button, not a letter key: every letter belongs to the input. Tab
      // reaches it, and Ctrl+Space replays without leaving the box.
      const play = node('button', 'btn ghost prlplay', '▶ Play again');
      play.type = 'button';
      play.title = 'Ctrl+Space';
      play.disabled = mute;
      play.addEventListener('click', () => {
        say();
        if (!input.disabled) input.focus();
      });

      root.append(
        play,
        mute
          // Named, and with the way out in the same line: the input stays, so a
          // word you happen to know can still be typed, and Enter on an empty
          // box is the skip it already was.
          ? node('p', 'prhint prlmute',
                 `No ${pack.name} voice is installed on this device — nothing to play. Press Enter to skip.`)
          : node('p', 'prhint', 'Type what you hear'),
        form
      );
      host.appendChild(root);

      root.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.code === 'Space') {
          // Consumed here: Space is review's reveal key, and this one is ours.
          e.preventDefault();
          e.stopPropagation();
          say();
        }
      }, { signal: done.signal });

      say();
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

          const answer = ok ? null
            : typed.trim() ? `It was “${entry.word}”`
            // Not "You didn't answer" when there was nothing to answer: the
            // verdict has to blame the missing voice, not you.
            : mute ? `No ${pack.name} voice — there was nothing to hear`
            : "You didn't answer";
          resolve(ctx.next(ok, answer));
        }, { once: true, signal: ctx.signal });
      });
    },
    async selfTest() {
      const entry = { word: 'Strategy', ipa: 'ˈstrætədʒi', vi: 'chiến lược' };
      // Answers one question with `typed` in a detached host and reports what
      // the shell would have seen. Takes the entry rather than closing over the
      // English one: the voice checks below drive a Korean card through it.
      const attempt = async (typed, asked = entry) => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const ac = new AbortController();
        let spoke = 0;
        let verdict = null;
        const ctx = {
          pool: [asked],
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
        const pending = this.ask(asked, host, ctx);
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
          spoke,
          muted: host.querySelector('.prlmute')?.textContent ?? '',
          playOff: !!host.querySelector('.prlplay')?.disabled,
          marks: host.querySelectorAll('.prldiff u').length,
          revealed: host.querySelector('.prlreveal')?.textContent ?? ''
        };
        ac.abort();
        host.remove();
        return out;
      };

      // Runs `fn` on a machine whose installed voices are `list`. The cache is
      // dropped on the way in AND on the way out, and getVoices is put back the
      // way it was found: practice-speak's selfTest runs after this one on the
      // same page, and the real grid is redrawn after it.
      const withVoices = async (list, fn) => {
        const real = speechSynthesis.getVoices;
        speechSynthesis.getVoices = () => list;
        forget();
        try {
          return await fn();
        } finally {
          speechSynthesis.getVoices = real;
          forget();
        }
      };
      const ko = { word: '책', lang: 'ko', vi: 'sách' };
      const en = [{ lang: 'en-GB' }, { lang: 'en-US' }];

      // ask() takes focus, as it should in the dialog. Handed back after, so
      // whatever the page had focused (the review box) is left as it was found.
      const had = document.activeElement;
      const exact = await attempt('  strATEGY ');
      const near = await attempt('stratgey');
      const blank = await attempt('');
      // No voice for the card's language: it says so instead of playing silence,
      // and empty Enter still gets you out.
      const silent = await withVoices(en, () => attempt('', ko));
      // And the list that has one is back to an ordinary card.
      const heard = await withVoices([...en, { lang: 'ko_KR' }], () => attempt('', ko));
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
         ['Strategy', '/ˈstrætədʒi/', 'chiến lược'].every((t) => near.revealed.includes(t)), near.revealed],

        // Eligibility: the hyphen is word-internal, the space is not.
        ['listening: a hyphenated word with a one-letter part is still eligible',
         ['x-ray', 'e-mail', 't-shirt', 'u-turn', 'e-commerce'].every((w) => this.eligible({ word: w, lang: 'en' })),
         ['x-ray', 'e-mail', 't-shirt', 'u-turn', 'e-commerce'].filter((w) => !this.eligible({ word: w, lang: 'en' })).join()],
        ['listening: a saved phrase is still eligible, a bare initial is not',
         this.eligible({ word: 'give up', lang: 'en' }) && !this.eligible({ word: 'a b', lang: 'en' })],

        // The voice guard. An empty getVoices() is Chrome not having filled the
        // list yet, so it must not read as "no voices installed" — that is every
        // machine for the first moment after load, and headless Chrome forever.
        ['listening: an unpopulated voice list blocks nothing',
         await withVoices([], () => this.eligible(ko) && this.eligible({ word: 'strategy', lang: 'en' }))],
        ['listening: a machine with no Korean voice does not offer Korean cards',
         await withVoices(en, () => !this.eligible(ko) && this.eligible({ word: 'strategy', lang: 'en' }))],
        ['listening: and offers them again once a Korean voice is installed',
         await withVoices([...en, { lang: 'ko' }], () => this.eligible(ko))],
        ['listening: a card that cannot be spoken says so and plays nothing',
         silent.spoke === 0 && silent.playOff && /Korean voice/.test(silent.muted), JSON.stringify(silent)],
        ['listening: and is answerable — empty Enter ends it, blaming the voice',
         silent.ok === false && /nothing to hear/.test(silent.verdict?.answer ?? ''), JSON.stringify(silent.verdict)],
        ['listening: with the voice installed the same card speaks normally',
         heard.spokeOnShow === 1 && !heard.muted && !heard.playOff, JSON.stringify(heard)]
      ];
    }
  });
})();
