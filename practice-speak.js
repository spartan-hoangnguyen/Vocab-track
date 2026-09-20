// Speak: make a sentence with the word and say it aloud.
//
// Producing the word is the hardest step of knowing it, and a sentence of your
// own is the smallest proof you can use it. The mic is the point, but it is
// not known whether the Web Speech API works on a chrome-extension:// page
// (it streams audio to Google, and an extension origin may be refused), so
// the typed box is always there and every way the mic can fail lands in it.
//
// Grading is deliberately shallow: at least five words, and the word itself or
// a plain inflection of it. Whether the sentence is GOOD is for you to judge
// when you hear it read back — a checker that pretended to know would be wrong
// often enough to teach you to ignore it.
const SPEAK = (() => {
  // Long enough for a sentence said slowly; short enough that a mic left open
  // by a distracted click does not sit there listening.
  const LISTEN_MS = 8000;
  // ponytail: five of anything, counted by whitespace. Five 어절 is a longer
  // sentence in Korean than five words are in English. Per-pack minimum if it
  // proves annoying in use.
  const MIN_WORDS = 5;
  const UNAVAILABLE = 'Speech recognition is not available here — type your sentence instead.';

  // One line per recognition error, each ending where to go next: the box.
  // 'aborted' is missing on purpose — that is us stopping it.
  const REASONS = {
    'not-allowed': 'Microphone blocked — type your sentence instead.',
    'service-not-allowed': 'Speech recognition is not allowed here — type your sentence instead.',
    'audio-capture': 'No microphone found — type your sentence instead.',
    network: 'Speech recognition needs a connection — type your sentence instead.',
    'no-speech': 'Didn\'t hear anything — try again, or type it.'
  };

  // The first form of the word found in the sentence, as {index, text}, or null.
  //
  // Which forms those are belongs to the language (pack.inflections), and so
  // does what "found" means (pack.match). This used to build one
  // \b(?:a|b|c)\b alternation, which is the wall step 1 hit everywhere else:
  // \b is an ASCII boundary and never fires between Hangul syllables, so a
  // Korean sentence could never contain its own word. Longest form first for
  // the reason the alternation needed it — the earliest hit wins, but a shorter
  // form must not claim a position a longer one also covers.
  //
  // The pack defaults off the word's own script, so the selfTest below and any
  // future caller can still pass two arguments.
  function findWord(sentence, word, pack = LANG.pick(null, word)) {
    const text = String(sentence ?? '');
    let best = null;
    for (const form of pack.inflections(word).sort((a, b) => b.length - a.length)) {
      const at = pack.match(form, text)[0];
      if (at && (!best || at.index < best.index)) {
        // Sliced out of the sentence rather than taken from the form: the
        // marked text has to keep the spelling that was actually said.
        best = { index: at.index, text: text.slice(at.index, at.index + at.length) };
      }
    }
    return best;
  }

  function wordCount(sentence) {
    return String(sentence ?? '').trim().split(/\s+/).filter(Boolean).length;
  }

  // Pure, so selfTest can pin the rules without a DOM. The word is checked
  // first: a two-word answer that also misses the word needs the word more.
  // `pack` is optional here for the same reason it is in findWord, which is
  // where an omitted one gets filled in.
  function grade(sentence, word, pack) {
    const hit = findWord(sentence, word, pack);
    if (!hit) return { ok: false, hit, reason: 'Use the word itself' };
    if (wordCount(sentence) < MIN_WORDS) {
      return { ok: false, hit, reason: `Make it a full sentence — at least ${MIN_WORDS} words` };
    }
    return { ok: true, hit, reason: null };
  }

  // Looked up at call time, not load time, so selfTest can take it away.
  const recognizer = () => window.SpeechRecognition || window.webkitSpeechRecognition;

  function ask(entry, host, ctx) {
    const { node } = ctx;
    // The word's own pack, resolved once: it says which forms count as the word
    // and which language the recogniser listens in.
    const pack = LANG.of(entry);
    // Everything this question hangs listeners on dies with it — or with the
    // dialog, whichever is first.
    const done = new AbortController();
    const signal = AbortSignal.any([done.signal, ctx.signal]);

    const root = node('div', 'pr-speak');
    root.appendChild(node('p', 'prask', entry.word));
    if (entry.ipa) root.appendChild(node('p', 'prhint', `/${entry.ipa}/`));
    const gloss = VT.glossOf(entry);
    if (gloss) root.appendChild(node('p', 'prhint', gloss));
    root.appendChild(node('p', 'prhint pr-speak-task', 'Make a sentence with this word and say it aloud.'));

    const mic = node('button', 'pr-speak-mic', '🎙');
    mic.type = 'button';
    mic.setAttribute('aria-label', 'Speak your sentence');
    const live = node('p', 'pr-speak-live');
    const reason = node('p', 'pr-speak-reason');
    reason.setAttribute('role', 'status');
    const box = node('textarea', 'prinput pr-speak-box');
    box.rows = 2;
    box.placeholder = '…or type your sentence';
    box.setAttribute('aria-label', 'Your sentence');
    root.append(mic, live, reason, box);
    host.appendChild(root);

    const fallback = (text) => {
      reason.textContent = text;
      box.focus();
    };

    return new Promise((resolve) => {
      let rec = null;
      let timer = null;
      let finished = false;

      const stopListening = () => {
        clearTimeout(timer);
        mic.classList.remove('on');
        // abort, not stop: stop would still deliver a result after we have
        // moved on. Cleared first, so its own onend/onerror see it is stale.
        const r = rec;
        rec = null;
        r?.abort();
      };

      const submit = (sentence) => {
        const text = String(sentence ?? '').trim();
        if (finished || !text) return;
        finished = true;
        stopListening();
        done.abort();
        mic.disabled = true;
        box.disabled = true;
        const result = grade(text, entry.word, pack);
        root.appendChild(said(text, result.hit, node, ctx.speak));
        resolve(ctx.next(result.ok, result.reason));
      };

      const listen = () => {
        // A second click while listening is "I'm done", not a second session.
        if (rec) { rec.stop(); return; }
        const Rec = recognizer();
        if (!Rec) { fallback(UNAVAILABLE); return; }
        reason.textContent = '';
        live.textContent = '';
        const r = new Rec();
        // The pack's first voice, not prefs.accent: recognition wants the
        // language, and choosing between two English accents for it buys
        // nothing. This line said 'en-GB' regardless even while speak() was
        // honouring the UK/US picker.
        r.lang = pack.voices[0].bcp47;
        r.interimResults = true;
        r.onresult = (e) => {
          if (rec !== r) return;
          const text = Array.from(e.results, (res) => res[0].transcript).join('');
          live.textContent = text;
          if (e.results[e.results.length - 1].isFinal) submit(text);
        };
        r.onerror = (e) => {
          if (rec !== r || e.error === 'aborted') return;
          stopListening();
          fallback(REASONS[e.error] ?? `Speech recognition failed (${e.error}) — type your sentence instead.`);
        };
        // Ended without a final result (silence, the timeout): what was heard
        // goes into the box to fix up and send, rather than being lost.
        r.onend = () => {
          if (rec !== r) return;
          stopListening();
          if (live.textContent) box.value = live.textContent;
          box.focus();
        };
        try {
          r.start();
        } catch (err) {
          console.error('[vocab-track] speech recognition would not start', err);
          fallback('The microphone would not start — type your sentence instead.');
          return;
        }
        rec = r;
        mic.classList.add('on');
        timer = setTimeout(() => rec?.stop(), LISTEN_MS);
      };

      mic.addEventListener('click', listen, { signal });
      box.addEventListener('keydown', (e) => {
        // Enter sends; Shift+Enter is the newline, as in every chat box.
        if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
        e.preventDefault();
        submit(box.value);
      }, { signal });
      // Closing the dialog mid-sentence must not leave the mic open.
      ctx.signal.addEventListener('abort', stopListening, { once: true, signal: done.signal });

      if (!recognizer()) fallback(UNAVAILABLE);
      else box.focus();
    });
  }

  // Your sentence back, the word marked, with a button to hear it said.
  function said(text, hit, node, say) {
    const row = node('div', 'pr-speak-said');
    const p = node('p', 'prsentence');
    if (hit) {
      p.append(text.slice(0, hit.index), node('mark', null, hit.text), text.slice(hit.index + hit.text.length));
    } else {
      p.textContent = text;
    }
    const hear = node('button', 'btn ghost', '🔊 Hear it');
    hear.type = 'button';
    // Through ctx.speak, so it keeps the UK/US voice you picked: an entry with
    // no recording is read by speechSynthesis, and the sentence is just that.
    hear.addEventListener('click', () => say({ word: text }));
    row.append(p, hear);
    return row;
  }

  return { findWord, grade, ask };
})();

PRACTICE.register('speak', {
  title: 'Speak',
  blurb: 'Make a sentence, say it',
  icon: '🎙',
  color: 'purple',
  eligible: (entry) => !!entry.word,
  ask: SPEAK.ask,
  async selfTest() {
    const out = [];
    const has = (s, w) => !!SPEAK.findWord(s, w);
    out.push(['inflections of accelerate match',
      ['accelerated', 'accelerating', 'accelerates', 'accelerate'].every((f) => has(`It ${f} fast`, 'accelerate'))]);
    out.push(['accelerator is not accelerate', !has('The accelerator is stuck', 'accelerate')]);
    out.push(['+es and +d count', has('She watches it', 'watch') && has('We moved it', 'move')]);
    const short = SPEAK.grade('Prices accelerated fast', 'accelerate');
    out.push(['under 5 words fails', !short.ok && /5 words/.test(short.reason), short.reason]);
    const missing = SPEAK.grade('The car went much faster then', 'accelerate');
    out.push(['sentence without the word fails', !missing.ok && missing.reason === 'Use the word itself']);

    // A non-English pack, which nothing reached until now: findWord takes one
    // explicitly and also defaults it off the word's own script, and both
    // routes have to land on the Korean pack. ko.match returns the whole
    // 어절, so the hit text is 책을 rather than 책 — the same rule English
    // follows, that the mark keeps the spelling that was actually said.
    const koHit = SPEAK.findWord('나는 책을 읽었다', '책', LANG.get('ko'));
    out.push(['a Korean word is found behind its particle',
      koHit?.index === 3 && koHit?.text === '책을', JSON.stringify(koHit)]);
    out.push(['and the pack defaults off the script when none is passed',
      SPEAK.findWord('나는 책을 읽었다', '책')?.text === '책을']);
    out.push(['a Korean sentence that omits the word still fails',
      !SPEAK.grade('나는 신문을 읽었다', '책').ok]);
    // ponytail's ceiling, pinned rather than described: MIN_WORDS counts
    // whitespace, so five 어절 is a longer sentence than five English words.
    const koShort = SPEAK.grade('나는 책을 읽었다', '책');
    out.push(['and five 어절 is the bar, counted the same way as words',
      !koShort.ok && /5 words/.test(koShort.reason), koShort.reason]);

    // Drives ask() in a detached host with a hand-made ctx whose next()
    // records what it was given and resolves at once. Rec replaces the
    // browser's recognizer for the run: undefined is "no speech API".
    const entry = { word: 'accelerate', ipa: 'əkˈseləreɪt', vi: 'tăng tốc' };
    const run = async (Rec, drive) => {
      const saved = [window.SpeechRecognition, window.webkitSpeechRecognition];
      window.SpeechRecognition = Rec;
      window.webkitSpeechRecognition = Rec;
      // Inside the open dialog, as every real question is: its Enter bubbles
      // to the document, and review only stands aside while the dialog is
      // open. Inside it, not beside it, or the modal makes the box unfocusable.
      const dlg = document.getElementById('practice-dlg');
      const opened = !dlg.open;
      if (opened) dlg.showModal();
      const host = document.createElement('div');
      document.getElementById('pr-body').appendChild(host);
      const ctl = new AbortController();
      const got = {};
      const ctx = {
        pool: [], signal: ctl.signal, speak() {}, record() {}, status() {}, same: PRACTICE.same,
        node(tag, cls, text) {
          const n = document.createElement(tag);
          if (cls) n.className = cls;
          if (text != null) n.textContent = text;
          return n;
        },
        next(ok, answer) { got.answer = answer; return Promise.resolve(ok); }
      };
      try {
        got.result = await drive(host, SPEAK.ask(entry, host, ctx));
        got.mark = host.querySelector('mark')?.textContent;
        return got;
      } finally {
        ctl.abort();
        host.remove();
        if (opened) dlg.close();
        [window.SpeechRecognition, window.webkitSpeechRecognition] = saved;
      }
    };
    const type = (host, text) => {
      const box = host.querySelector('textarea');
      box.value = text;
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    };
    const reasonOf = (host) => host.querySelector('.pr-speak-reason').textContent;
    const boxFocused = (host) => document.activeElement === host.querySelector('textarea');

    const none = await run(undefined, async (host, asked) => {
      const r = { reason: reasonOf(host), focused: boxFocused(host) };
      // The mic is still live without recognition: clicking it says why.
      host.querySelector('.pr-speak-reason').textContent = '';
      host.querySelector('.pr-speak-mic').click();
      r.again = reasonOf(host);
      type(host, 'Our team accelerated the launch by a week.');
      r.ok = await asked;
      return r;
    });
    out.push(['no recognition shows why and focuses the box',
      /not available/.test(none.result.reason) && none.result.focused, JSON.stringify(none.result)]);
    out.push(['mic without recognition is not dead', /not available/.test(none.result.again)]);
    out.push(['typed good sentence is right, word marked',
      none.result.ok === true && none.mark === 'accelerated', JSON.stringify(none)]);

    const bad = await run(undefined, async (host, asked) => {
      // Shift+Enter is a newline, not a send.
      const box = host.querySelector('textarea');
      box.value = 'Too short';
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
      const sentEarly = box.disabled;
      type(host, 'I like fast cars a lot.');
      return { sentEarly, ok: await asked };
    });
    out.push(['typed sentence without the word is wrong',
      bad.result.ok === false && !bad.result.sentEarly && bad.answer === 'Use the word itself', JSON.stringify(bad)]);

    const tooShort = await run(undefined, async (host, asked) => {
      type(host, 'Cars accelerate fast.');
      return asked;
    });
    out.push(['typed short sentence is wrong with its reason',
      tooShort.result === false && /at least 5 words/.test(tooShort.answer), JSON.stringify(tooShort)]);

    // A recognizer that hears one final sentence as soon as it starts.
    class Heard {
      start() {
        setTimeout(() => this.onresult?.({
          results: [Object.assign([{ transcript: 'The car accelerates up the steep hill' }], { isFinal: true })]
        }));
      }
      stop() {}
      abort() {}
    }
    const heard = await run(Heard, async (host, asked) => {
      host.querySelector('.pr-speak-mic').click();
      return asked;
    });
    out.push(['a final speech result is graded', heard.result === true && heard.mark === 'accelerates',
      JSON.stringify(heard)]);

    // One that is refused, the way an extension page may well be.
    class Blocked {
      start() { setTimeout(() => this.onerror?.({ error: 'not-allowed' })); }
      stop() {}
      abort() {}
    }
    const blocked = await run(Blocked, async (host, asked) => {
      host.querySelector('.pr-speak-mic').click();
      await new Promise((r) => setTimeout(r, 10));
      const r = { reason: reasonOf(host), focused: boxFocused(host) };
      type(host, 'Costs accelerate when nobody is watching.');
      r.ok = await asked;
      return r;
    });
    out.push(['mic blocked falls back to the box',
      /blocked/.test(blocked.result.reason) && blocked.result.focused && blocked.result.ok === true,
      JSON.stringify(blocked.result)]);

    // And one whose start() throws outright.
    class Throws { start() { throw new Error('nope'); } stop() {} abort() {} }
    const threw = await run(Throws, async (host, asked) => {
      host.querySelector('.pr-speak-mic').click();
      const r = { reason: reasonOf(host), focused: boxFocused(host) };
      type(host, 'Costs accelerate when nobody is watching.');
      await asked;
      return r;
    });
    out.push(['start() throwing falls back to the box',
      /would not start/.test(threw.result.reason) && threw.result.focused, JSON.stringify(threw.result)]);
    return out;
  }
});
