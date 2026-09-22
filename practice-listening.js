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
    // You type the word from the sound alone, with nothing on screen to
    // recognise it from — the same production the review card asks for, so a
    // right answer here is worth Good, and a quick one Easy.
    produces: true,
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
      // One saved accent across every language, resolved against the entry's
      // own pack inside utter() below — the same shape dashboard.js:1555 uses.
      const accent = ctx.settings?.accent;
      const root = node('div', 'pr-listening');
      host.appendChild(root);

      // A card can still arrive with nothing to play: eligible() ran while the
      // voice list was empty (the async fill above), and the list that turned
      // up has no voice for this pack. speak() in lookup.js cannot say so — it
      // owns no surface — so this is the caller that has one. Saying nothing is
      // the defect: the card plays silence and the only way out is a wrong
      // answer.
      //
      // A recording is the case that guard cannot see. speakable() asks about
      // synthesis, and pronounce() plays a Cambridge mp3 on a machine with no
      // voices installed at all (lookup.js:157) — so a word that has one is
      // never mute, which is most English words on a machine missing the pack.
      const canSay = speakable(pack);
      if (!canSay && !entry.audio) return unplayable(entry, pack, root, ctx);

      // Ends with the question, and with the session: the replay shortcuts must
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

      // Counted, never capped and never graded: playing a word eight times is
      // this mode working rather than someone cheating at it — the hint is what
      // costs you the Easy (practice.js:264). The count is here so that "I
      // needed eight" is something you can see instead of something you feel,
      // and so the two speeds are told apart by their effect and not only by
      // their labels.
      let plays = 0;
      const tally = node('p', 'prlplays');
      const played = () => {
        plays++;
        tally.textContent = plays === 1 ? 'Played once' : `Played ${plays} times`;
      };

      // Through ctx.speak, not an utterance of our own: it is the seam that
      // applies the saved accent and remembers what was said, which is what the
      // shell's Space replays (practice.js:346).
      const say = () => { played(); ctx.speak(entry); };
      const slow = () => { played(); slowly(entry, accent); };
      // The buttons hand focus back rather than keeping it: you are mid-word in
      // the box, and a press that costs you the caret costs more than it gives.
      const back = () => { if (!input.disabled) input.focus(); };

      // A button, not a letter key: every letter belongs to the input. Tab
      // reaches it, and Ctrl+Space replays without leaving the box.
      const play = node('button', 'btn ghost prlplay', '▶ Play again');
      play.type = 'button';
      play.title = 'Ctrl+Space';
      play.addEventListener('click', () => { say(); back(); });

      // Beside the normal speed, never instead of it: slow is for the syllable
      // you cannot place, and the next thing you want after placing it is the
      // word said properly again to check it against.
      const slower = node('button', 'btn ghost prlslow', '🐢 Slower');
      slower.type = 'button';
      slower.title = 'Ctrl+Shift+Space — 0.6× speed';
      slower.addEventListener('click', () => { slow(); back(); });

      const row = node('div', 'prlrow');
      row.append(play, slower);

      // The sentence the word was saved from, played and never printed: it has
      // the word in it, so putting it on screen would hand over the answer the
      // mode exists to withhold. Heard, it is the opposite — a word inside a
      // sentence is where the run-together consonants and the unstressed vowel
      // actually live, and that is the thing dictation is hard for.
      //
      // Synthesis only, so unlike the word it needs a voice for this language:
      // a word with a recording and no pack voice plays, its sentence cannot.
      const sentence = canSay ? sentenceOf(entry) : '';
      if (sentence) {
        const quote = node('button', 'btn ghost prlsentence', '❝ Play the sentence');
        quote.type = 'button';
        quote.addEventListener('click', () => {
          // Not counted: the tally answers "how many times did I need the
          // WORD", and this is a different sound.
          utter(sentence, entry, accent, 1);
          back();
        });
        row.appendChild(quote);
      }

      root.append(row, tally, node('p', 'prhint', 'Type what you hear'), form);

      root.addEventListener('keydown', (e) => {
        if (!e.ctrlKey || e.code !== 'Space') return;
        // Consumed here: Space is review's reveal key and the shell's replay,
        // and this one is ours.
        e.preventDefault();
        e.stopPropagation();
        // Shift is the only modifier left to hang the second speed on, and that
        // is also why the sentence has no shortcut at all: every letter belongs
        // to the input, and the sentence is the one of the three you reach for
        // least, so it is the one that pays for it with a Tab.
        if (e.shiftKey) slow(); else say();
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

          // The buttons stay alive on purpose, though the shortcut does not:
          // hearing the word once more while looking at how it is spelled is
          // the whole lesson of a miss.
          const answer = ok ? null
            : typed.trim() ? `It was “${entry.word}”`
            : "You didn't answer";
          resolve(ctx.next(ok, answer));
        }, { once: true, signal: ctx.signal });
      });
    },
    // The first letter and how long the word is: enough to unstick a word you
    // heard perfectly well and cannot spell — /ˈnjuːɑːns/ is "nuance" or
    // "newance" until something rules one out — without spelling it for you,
    // which a mode whose answer IS the spelling cannot afford to do. Graded
    // like every hint, which caps the answer at Good (practice.js:264).
    //
    // Whitespace is all that comes out: a hyphen is a key you have to press, so
    // x-ray is five. Code points, so a Korean syllable block counts as the one
    // letter it is typed as rather than the three jamo it decomposes to.
    hint(entry, ctx) {
      const letters = [...String(entry.word ?? '')].filter((c) => !/\s/.test(c));
      return ctx.node('p', 'prhint',
                      `Starts with “${letters[0] ?? '?'}” · ${letters.length} letters`);
    },
    async selfTest() {
      const entry = { word: 'Strategy', ipa: 'ˈstrætədʒi', vi: 'chiến lược',
                      context: 'The company announced a new long-term strategy for Europe.' };
      // Answers one question with `typed` in a detached host and reports what
      // the shell would have seen. Takes the entry rather than closing over the
      // English one: the voice checks below drive a Korean card through it.
      //
      // speechSynthesis.speak and Audio are captured as well as ctx.speak,
      // because the slow replay and the sentence deliberately do NOT go through
      // the hook — utter() and slowly() are the only place they can be seen.
      // Both are put back on the way out: practice-speak's selfTest runs after
      // this one on the same page.
      const attempt = async (typed, asked = entry) => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const ac = new AbortController();
        let spoke = 0;
        let verdict = null;
        const said = [];
        const players = [];
        const realSpeak = speechSynthesis.speak;
        const realAudio = window.Audio;
        speechSynthesis.speak = (u) => { said.push({ text: u.text, rate: u.rate }); };
        window.Audio = class {
          constructor(src) { this.src = src; players.push(this); }
          play() { return Promise.resolve(); }
        };
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
          status() {},
          settings: { accent: 'uk' }
        };
        try {
          const pending = this.ask(asked, host, ctx);
          const spokeOnShow = spoke;
          // A card with nothing to play stages no question: no input, no form,
          // and it has already resolved through ctx.next by the time ask()
          // returns. Everything below would be reaching into furniture that is
          // deliberately not there.
          const mute = !!host.querySelector('.prlmute');
          // Read before any key is pressed: the show itself is one play, and
          // its singular wording is the only place the plural branch is not.
          const playsOnShow = host.querySelector('.prlplays')?.textContent ?? '';
          let focused = false;
          let replayed = false;
          if (!mute) {
            const input = host.querySelector('.prinput');
            focused = document.activeElement === input;
            // Ctrl+Space in the box replays and leaves the box alone; the same
            // key with Shift is the slow one.
            const press = (shift) => {
              const ev = new KeyboardEvent('keydown',
                { code: 'Space', key: ' ', ctrlKey: true, shiftKey: shift, bubbles: true, cancelable: true });
              input.dispatchEvent(ev);
              return ev.defaultPrevented;
            };
            replayed = press(false) && spoke === spokeOnShow + 1;
            press(true);
            host.querySelector('.prlsentence')?.click();
            input.value = typed;
            host.querySelector('form').requestSubmit();
          }
          const ok = await pending;
          // After the answer the shortcut is gone. Not bubbling: with no
          // listener left to stop it, it would reach review's Space and reveal
          // a card.
          host.querySelector('.pr-listening')
              .dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', ctrlKey: true }));
          return {
            ok, verdict, spokeOnShow, focused, replayed, said, players, playsOnShow,
            lateSpeak: spoke !== spokeOnShow + 1,
            spoke,
            plays: host.querySelector('.prlplays')?.textContent ?? '',
            muted: host.querySelector('.prlmute')?.textContent ?? '',
            noPlay: !host.querySelector('.prlplay'),
            sentence: !!host.querySelector('.prlsentence'),
            shown: host.textContent,
            marks: host.querySelectorAll('.prldiff u').length,
            revealed: host.querySelector('.prlreveal')?.textContent ?? ''
          };
        } finally {
          speechSynthesis.speak = realSpeak;
          window.Audio = realAudio;
          ac.abort();
          host.remove();
        }
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

      // ask() takes focus, as it should in the panel. Handed back after, so
      // whatever the page had focused (the review box) is left as it was found.
      const had = document.activeElement;
      const exact = await attempt('  strATEGY ');
      const near = await attempt('stratgey');
      const blank = await attempt('');
      // Nothing saved to play but the word itself.
      const alone = await attempt('', { word: 'nuance', vi: 'sắc thái' });
      // No voice for the card's language and no recording: it shows the word
      // instead of asking for it.
      const silent = await withVoices(en, () => attempt('', ko));
      // And the list that has one is back to an ordinary card.
      const heard = await withVoices([...en, { lang: 'ko_KR' }], () => attempt('', ko));
      // A recording is a voice this device does have, whatever getVoices says.
      const taped = await withVoices([{ lang: 'ko' }],
                                     () => attempt('strategy', { word: 'strategy', lang: 'en', audio: 'uk.mp3' }));
      const hinted = this.hint(entry, { node: (tag, cls, text) => {
        const n = document.createElement(tag);
        if (text != null) n.textContent = text;
        return n;
      } }).textContent;
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

        // The two speeds. The slow one is not the hook's to make, so it is
        // counted where it is made.
        // Not `=== SLOW`: utterance.rate is a float and reads back as
        // 0.6000000238418579, so the check has to be the one the ear makes.
        ['listening: Ctrl+Shift+Space says the same word at 0.6×',
         exact.said.some((u) => Math.abs(u.rate - 0.6) < 0.01 && u.text === 'Strategy'),
         JSON.stringify(exact.said)],
        ['listening: a word with a recording slows the recording, not a second voice',
         taped.players.some((p) => p.src === 'uk.mp3' && p.playbackRate === 0.6),
         JSON.stringify(taped.players.map((p) => ({ src: p.src, rate: p.playbackRate })))],
        ['listening: every play of the WORD is counted, and the sentence is not one',
         /3 times/.test(exact.plays), `${exact.plays} after two replays and a sentence`],
        ['listening: the first play, the one nobody asked for, reads as one',
         alone.playsOnShow === 'Played once', alone.playsOnShow],

        // The sentence: heard, never seen.
        ['listening: the saved sentence is offered and spoken whole',
         exact.sentence && exact.said.some((u) => u.text === entry.context && Math.abs(u.rate - 1) < 0.01),
         JSON.stringify(exact.said)],
        ['listening: and is never printed, which would give the word away',
         !exact.shown.includes('long-term'), exact.shown.slice(0, 120)],
        ['listening: a word with no saved sentence offers no sentence button', !alone.sentence],

        ['listening: the hint gives the first letter and the length, not the word',
         hinted.includes('S') && /8 letters/.test(hinted) && !/Strategy/.test(hinted), hinted],

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
        ['listening: a card with nothing to play shows the word rather than asking for it',
         silent.spoke === 0 && silent.noPlay && /Korean voice/.test(silent.muted) && silent.muted.includes('책'),
         JSON.stringify(silent)],
        ['listening: and needs no answer — it ends itself, blaming the voice',
         silent.ok === false && /nothing to hear/.test(silent.verdict?.answer ?? ''), JSON.stringify(silent.verdict)],
        ['listening: with the voice installed the same card speaks normally',
         heard.spokeOnShow === 1 && !heard.muted && !heard.noPlay, JSON.stringify(heard)],
        ['listening: a word with a recording is playable with no voice for its language',
         !taped.muted && taped.spokeOnShow === 1 && taped.ok === true, JSON.stringify(taped)]
      ];
    }
  });

  /* ---- the two sounds ctx.speak cannot make ----

     The normal play goes through ctx.speak, which is the dashboard's one seam
     for the saved accent and is what the shell's Space replays
     (practice.js:346). Neither of the other two can: it takes an entry, so
     there is no way to say "slower" or "say this text instead". The honest
     place for both is a rate and a text on lookup.js's speak() — rejected
     because that file is every surface's pronunciation, and widening its
     signature for one mode's two buttons would leave its three other callers
     passing defaults for something only Listening has an opinion about. So
     they are made here, from the same pack voice and the same bestVoice()
     ranking pronounce() already picks with (lookup.js:198), rather than a
     second opinion about which of nine Korean voices to use.

     Below the mode rather than above it: what the top of this file has to say
     is which words can be asked at all, and that argument should not open with
     the audio plumbing. */

  // Slow enough that the syllables come apart, fast enough that what comes out
  // is still one word rather than a list of them.
  const SLOW = 0.6;

  function utter(text, entry, accent, rate) {
    const voices = LANG.of(entry).voices;
    // One stored accent, many languages: 'uk' means nothing on a Korean voice
    // list, so the pack's own first voice answers for it — the same fallback
    // dashboard.js:1555 makes before calling pronounce().
    const voice = voices.find((v) => v.id === accent) ?? voices[0];
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = voice.bcp47;
    utterance.voice = bestVoice(voice.bcp47, speechSynthesis.getVoices());
    utterance.rate = rate;
    // No cancel() first, deliberately: pronounce() does not cancel either, so
    // pressing any of the three buttons twice queues the second reading behind
    // the first, the same way on all three. Cancelling on one of them only
    // would give it a behaviour no listener could account for.
    speechSynthesis.speak(utterance);
  }

  // The recording slowed down wherever there is one, rather than the synthetic
  // voice reading slowly: playbackRate leaves Chrome's pitch correction on, so
  // this is the same voice you just heard, said slower. A different voice at
  // 0.6 would be a second pronunciation to learn rather than a closer listen at
  // the first. Accent-matched exactly as pronounce() does it (lookup.js:157),
  // or a US recording answers a UK replay.
  function slowly(entry, accent) {
    const src = accent === 'us' ? (entry.audioUs ?? entry.audio) : entry.audio;
    if (!src) {
      utter(entry.word, entry, accent, SLOW);
      return;
    }
    const audio = new Audio(src);
    audio.playbackRate = SLOW;
    audio.play().catch((err) => {
      console.error('[vocab-track] slow playback failed for', entry.word, err);
      utter(entry.word, entry, accent, SLOW);
    });
  }

  // The sentence to offer, or '' for a word that has none worth offering. The
  // same test Fill picks its sentence with (practice-fill.js:14) — a saved
  // sentence that no longer contains the word plays the word nowhere, which is
  // a button that does nothing to the one thing it promises.
  //
  // Without the ellipsis a truncated context ends in (lib.js:90): that is a
  // mark on a page, not a sound, and it is read out as a trailing pause the
  // sentence never had. sourceLink strips it for the same reason (lib.js:670).
  function sentenceOf(entry) {
    const text = String(entry.context ?? '').replace(/…$/, '').trim();
    return text && VT.has(entry.word, text, entry.lang) ? text : '';
  }

  // No voice for this language and no recording: a question with nothing in it,
  // so it is not staged as one. What stood here staged it anyway — the play
  // button, the input and "Type what you hear" all present, with the bad news
  // swapped into the hint line — and the only way past was to be marked wrong
  // for not answering something that was never asked. Now the word is shown and
  // the shell's Continue is the way on.
  //
  // The rejected alternative is exactly what was here: keep the input, because
  // a word you happen to know could still be typed. It is not worth the
  // staging — the word is on screen now, so typing it would prove nothing.
  //
  // ponytail: it still resolves false, so a due word takes an Again for a
  // missing voice. The shell records whatever ask() returns (practice.js:410)
  // and a mode has no way to say "do not count this one"; the upgrade path is a
  // skip result the shell understands, which is a change to the contract rather
  // than to this file. The mp3 clause above is what makes it rare.
  function unplayable(entry, pack, root, ctx) {
    const { node } = ctx;
    const box = node('div', 'prlmute');
    box.append(
      node('p', 'prhint', `No ${pack.name} voice is installed on this device and this word has `
                          + 'no recording, so there is nothing to play.'),
      node('p', 'prask', entry.word)
    );
    if (entry.ipa) box.appendChild(node('p', 'prlipa', `/${entry.ipa}/`));
    const gloss = VT.glossOf(entry);
    if (gloss) box.appendChild(node('p', 'prhint', gloss));
    root.appendChild(box);
    return ctx.next(false, `No ${pack.name} voice — there was nothing to hear`);
  }
})();
