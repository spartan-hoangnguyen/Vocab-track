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
// often enough to teach you to ignore it. Both of those rules are on screen as
// a checklist while you write, for the same reason they are shallow: a rule you
// can watch yourself satisfy is one you can trust, while the same rule sprung
// on you at the verdict reads as an opinion about your sentence.
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

  // Both rules answered at once, which is the one thing grade() cannot say: it
  // stops at the first failure so that it can name a single reason. The
  // checklist needs the other rule's state too, and a sentence that is short
  // AND missing the word must not tick "long enough" on the strength of
  // grade() having never reached it.
  function coverage(sentence, word, pack) {
    const hit = findWord(sentence, word, pack);
    const words = wordCount(sentence);
    return { hit, used: !!hit, words, long: words >= MIN_WORDS };
  }

  // Pure, so selfTest can pin the rules without a DOM. The word is checked
  // first: a two-word answer that also misses the word needs the word more.
  // `pack` is optional here for the same reason it is in findWord, which is
  // where an omitted one gets filled in.
  function grade(sentence, word, pack) {
    const { hit, used, long } = coverage(sentence, word, pack);
    if (!used) return { ok: false, hit, reason: 'Use the word itself' };
    if (!long) return { ok: false, hit, reason: `Make it a full sentence — at least ${MIN_WORDS} words` };
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
    // session, whichever is first.
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
    // The seconds left of the listening window. Before this the mic simply went
    // quiet at LISTEN_MS, in the middle of a sentence, and read as the mic
    // having broken. Visual only (aria-hidden): the ring already announces the
    // open mic, and a digit read out every second would talk over the sentence
    // you are in the middle of saying. An animated ring lost to digits because
    // "it will stop soon" is not the news you need — "two seconds" is.
    const count = node('span', 'pr-speak-count');
    count.setAttribute('aria-hidden', 'true');
    const live = node('p', 'pr-speak-live');
    const reason = node('p', 'pr-speak-reason');
    reason.setAttribute('role', 'status');
    const box = node('textarea', 'prinput pr-speak-box');
    box.rows = 2;
    box.placeholder = '…or type your sentence';
    box.setAttribute('aria-label', 'Your sentence');
    // The whole of the grading, in the order grade() applies it. Not a live
    // region: it changes on every keystroke, and a screen reader that read each
    // change aloud would drown the sentence — the verdict's reason says the
    // same thing once, at the end, where it is news.
    const checks = node('ul', 'pr-speak-checks');
    const usedRow = node('li', 'pr-speak-check', `Uses “${entry.word}”`);
    const longRow = node('li', 'pr-speak-check');
    checks.append(usedRow, longRow);
    const send = node('button', 'btn pr-speak-send', 'Check it ');
    send.type = 'button';
    send.appendChild(node('kbd', null, 'enter'));
    root.append(mic, count, live, reason, box, checks, send);
    host.appendChild(root);

    const fallback = (text) => {
      reason.textContent = text;
      box.focus();
    };

    // Reads the box and never the interim transcript: the box holds the text
    // that will actually be graded, and ticking on words the recogniser is
    // still revising would un-tick itself a word later.
    const paint = () => {
      const seen = coverage(box.value, entry.word, pack);
      usedRow.classList.toggle('on', seen.used);
      longRow.classList.toggle('on', seen.long);
      longRow.textContent = seen.long ? `${seen.words} words` : `${seen.words} of ${MIN_WORDS} words`;
    };

    return new Promise((resolve) => {
      let rec = null;
      let timer = null;
      let finished = false;

      const stopListening = () => {
        clearInterval(timer);
        count.textContent = '';
        mic.classList.remove('on');
        // abort, not stop: stop would still deliver a result after we have
        // moved on. Cleared first, so its own onend/onerror see it is stale.
        const r = rec;
        rec = null;
        r?.abort();
      };

      // The controls after this question has been answered for you — by the
      // grade below, or by the shell's give-up, which aborts ctx.signal and
      // paints its verdict over the top. Without this the mic under that
      // verdict was still live, and clicking it opened a recogniser for a
      // question that no longer existed.
      const freeze = () => { mic.disabled = true; box.disabled = true; send.disabled = true; };

      const submit = (sentence) => {
        const text = String(sentence ?? '').trim();
        if (finished) return;
        if (!text) {
          // An empty send used to be a silent no-op, which left the question
          // with exactly one exit: closing practice. The exit is the shell's
          // give-up button (practice.js:488) and this is where it gets named,
          // because the footer is not where you are looking.
          fallback('Say or type a sentence — or press "I don\'t know" below to skip it.');
          return;
        }
        finished = true;
        stopListening();
        done.abort();
        freeze();
        const result = grade(text, entry.word, pack);
        root.appendChild(said(text, result.hit, node, ctx.speak));
        resolve(ctx.next(result.ok, result.reason));
      };

      // What was heard goes into the box — to read, to fix, or to say again
      // over the top with another click of the mic. Grading the recogniser's
      // final result where it arrived was the old behaviour and it was
      // one-shot: a transcript that mangled the word was graded wrong before
      // you had seen it, for a sentence you had said correctly.
      const land = (r) => {
        if (rec !== r) return;
        stopListening();
        if (live.textContent) box.value = live.textContent;
        // Cleared, or the take shows twice: once here and once in the box.
        live.textContent = '';
        mic.setAttribute('aria-label', 'Say it again');
        box.focus();
        paint();
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
          if (e.results[e.results.length - 1].isFinal) land(r);
        };
        r.onerror = (e) => {
          if (rec !== r || e.error === 'aborted') return;
          stopListening();
          fallback(REASONS[e.error] ?? `Speech recognition failed (${e.error}) — type your sentence instead.`);
        };
        // Silence, or the window running out: both end the same way as a
        // sentence heard in full, in the box.
        r.onend = () => land(r);
        try {
          r.start();
        } catch (err) {
          console.error('[vocab-track] speech recognition would not start', err);
          fallback('The microphone would not start — type your sentence instead.');
          return;
        }
        rec = r;
        mic.classList.add('on');
        // One interval does both jobs the lone setTimeout did not: it shows the
        // window shrinking and it closes the mic at the end of it.
        let left = Math.round(LISTEN_MS / 1000);
        count.textContent = `${left}s`;
        timer = setInterval(() => {
          left -= 1;
          count.textContent = left > 0 ? `${left}s` : '';
          // Cleared before stop(), not by it: a real recogniser answers stop()
          // with onend a few hundred ms later, and a tick in between would ask
          // it to stop a second time.
          if (left <= 0) { clearInterval(timer); rec?.stop(); }
        }, 1000);
      };

      mic.addEventListener('click', listen, { signal });
      send.addEventListener('click', () => submit(box.value), { signal });
      box.addEventListener('input', paint, { signal });
      box.addEventListener('keydown', (e) => {
        // Enter sends; Shift+Enter is the newline, as in every chat box.
        if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
        e.preventDefault();
        submit(box.value);
      }, { signal });
      // Leaving the tab mid-sentence must not leave the mic open, and giving up
      // aborts this same signal — so both also close the controls down.
      ctx.signal.addEventListener('abort', () => { stopListening(); freeze(); },
        { once: true, signal: done.signal });

      paint();
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

  return { findWord, coverage, grade, ask };
})();

PRACTICE.register('speak', {
  title: 'Speak',
  blurb: 'Make a sentence, say it',
  icon: '🎙',
  color: 'purple',
  // A sentence of your own is production at its hardest.
  produces: true,
  // No right answer here is fast. Composing a sentence and saying it aloud
  // takes fifteen seconds when it goes well, so the shell's six-second default
  // (practice.js:30) would have meant Speak never granting Easy — true, but
  // true by accident, and reading as a bug the first time someone timed it.
  // Zero says it on purpose: this mode tops out at Good.
  fast: 0,
  // Not Chinese yet: recognition has no zh-CN tag until T008, and MIN_WORDS
  // counts spaces, which a Chinese sentence has none of — it could never pass.
  eligible: (entry) => !!entry.word && LANG.of(entry).id !== 'zh',
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
    // What the checklist needs and grade() cannot give: the rule grade()
    // returned on, AND the one it stopped short of.
    const both = SPEAK.coverage('Prices accelerated fast', 'accelerate');
    out.push(['coverage answers the rule grade stopped short of',
      both.used === true && both.long === false && both.words === 3, JSON.stringify(both)]);
    const neither = SPEAK.coverage('It went fast', 'accelerate');
    out.push(['and a short sentence missing the word fails both',
      neither.used === false && neither.long === false, JSON.stringify(neither)]);

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
      // Inside a claimed host, as every real question is: its Enter bubbles to
      // the document, and review only stands aside while practice owns the
      // keys. Inside the panel, not beside it — focus() does nothing under a
      // display:none ancestor and every check below turns on the box taking it.
      const claim = PRACTICE.testHost();
      const host = document.createElement('div');
      claim.host.appendChild(host);
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
        // ctl is passed on: give-up and a closed tab both reach a mode as this
        // signal aborting, and one case below has to fire it mid-question.
        got.result = await drive(host, SPEAK.ask(entry, host, ctx), ctl);
        got.mark = host.querySelector('mark')?.textContent;
        return got;
      } finally {
        ctl.abort();
        host.remove();
        claim.done();
        [window.SpeechRecognition, window.webkitSpeechRecognition] = saved;
      }
    };
    // Typing, as typing happens: an input event per change and then Enter.
    const type = (host, text) => {
      const box = host.querySelector('textarea');
      box.value = text;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    };
    const reasonOf = (host) => host.querySelector('.pr-speak-reason').textContent;
    const boxFocused = (host) => document.activeElement === host.querySelector('textarea');
    const ticks = (host) => [...host.querySelectorAll('.pr-speak-check')].map((li) => li.classList.contains('on'));

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

    // The checklist, watched through one sentence being written: neither rule,
    // then each alone, then both — and the send button as the way out, since
    // the mic path now leaves a sentence sitting in the box waiting for it.
    const list = await run(undefined, async (host, asked) => {
      const box = host.querySelector('textarea');
      const seen = [];
      const write = (text) => {
        box.value = text;
        box.dispatchEvent(new Event('input', { bubbles: true }));
        seen.push(ticks(host));
      };
      write('');
      write('The car went much faster than before');
      write('Costs accelerate');
      write('Costs accelerate when nobody watches');
      const words = host.querySelectorAll('.pr-speak-check')[1].textContent;
      host.querySelector('.pr-speak-send').click();
      return { seen, words, ok: await asked };
    });
    out.push(['the checklist ticks each rule on its own as you write',
      JSON.stringify(list.result.seen) === JSON.stringify([[false, false], [false, true], [true, false], [true, true]]),
      JSON.stringify(list.result.seen)]);
    out.push(['and counts the words you have against the five you need',
      list.result.words === '5 words', list.result.words]);
    out.push(['the send button grades the sentence', list.result.ok === true && list.mark === 'accelerate',
      JSON.stringify(list)]);

    // Sending nothing used to do nothing at all. It now says where the exit is.
    const empty = await run(undefined, async (host, asked) => {
      type(host, '');
      const r = { reason: reasonOf(host), shut: host.querySelector('textarea').disabled };
      type(host, 'Costs accelerate when nobody is watching.');
      r.ok = await asked;
      return r;
    });
    out.push(['an empty send names the way out rather than doing nothing',
      /I don't know/.test(empty.result.reason) && !empty.result.shut && empty.result.ok === true,
      JSON.stringify(empty.result)]);

    // A recognizer that hears one final sentence as soon as it starts, whose
    // stop() ends it the way a real one does, and which says how many times it
    // has been opened.
    class Heard {
      static starts = 0;
      static text = 'The car accelerates up the steep hill';
      start() {
        Heard.starts++;
        setTimeout(() => this.onresult?.({
          results: [Object.assign([{ transcript: Heard.text }], { isFinal: true })]
        }));
      }
      stop() { this.onend?.(); }
      abort() {}
    }
    const heard = await run(Heard, async (host, asked) => {
      const mic = host.querySelector('.pr-speak-mic');
      const box = host.querySelector('textarea');
      mic.click();
      // Read before the result lands: start() defers it, as a mic does.
      const ticking = host.querySelector('.pr-speak-count').textContent;
      await new Promise((r) => setTimeout(r, 10));
      const first = { text: box.value, count: host.querySelector('.pr-speak-count').textContent,
                      over: box.disabled, live: host.querySelector('.pr-speak-live').textContent,
                      ticked: ticks(host) };
      Heard.text = 'The car accelerated up the steep hill instead';
      mic.click();
      await new Promise((r) => setTimeout(r, 10));
      const second = box.value;
      host.querySelector('.pr-speak-send').click();
      return { ticking, first, second, ok: await asked };
    });
    out.push(['the listening window counts down and clears when it closes',
      heard.result.ticking === '8s' && heard.result.first.count === '',
      JSON.stringify([heard.result.ticking, heard.result.first.count])]);
    out.push(['a heard sentence lands in the box instead of being graded there',
      /steep hill/.test(heard.result.first.text) && heard.result.first.over === false
        && heard.result.first.live === '' && JSON.stringify(heard.result.first.ticked) === '[true,true]',
      JSON.stringify(heard.result.first)]);
    out.push(['and the mic says it again over the top', /accelerated .* instead/.test(heard.result.second),
      heard.result.second]);
    out.push(['then the send button grades what is in the box',
      heard.result.ok === true && heard.mark === 'accelerated' && Heard.starts === 2,
      JSON.stringify([heard.mark, Heard.starts])]);

    // Give-up and a closed tab reach a mode the same way: ctx.signal aborts.
    // Neither may leave the mic open or the controls live under the verdict
    // the shell paints on top.
    const gone = await run(Heard, async (host, asked, ctl) => {
      const mic = host.querySelector('.pr-speak-mic');
      const opened = Heard.starts;
      mic.click();
      ctl.abort();
      const r = { open: mic.classList.contains('on'), count: host.querySelector('.pr-speak-count').textContent,
                  shut: mic.disabled && host.querySelector('textarea').disabled };
      // A disabled button dispatches no click, which is the point of freezing
      // them: there is nothing left here to start a recogniser with.
      mic.click();
      r.reopened = Heard.starts - opened - 1;
      return r;
    });
    out.push(['giving up closes the mic and the controls with it',
      gone.result.open === false && gone.result.count === '' && gone.result.shut && gone.result.reopened === 0,
      JSON.stringify(gone.result)]);

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
