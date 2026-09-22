// Fill the gap: a sentence with the word blanked out — pick the word, or type it.
//
// The sentence is one the word actually appears in: the one you saved it from,
// and every dictionary example that still holds it. Which of them is asked is
// drawn at random, so meeting a word twice in a round is not the same question
// twice.
//
// Two variants of the one question. Picking is recognition — the options are
// words, not meanings, because the sentence is the question and the choice is
// which word fits it. Typing is production, and `produces` follows the choice
// so the schedule is moved by what the answer was actually worth
// (practice.js:264). See practice.js for the contract.
//
// Wrapped so nothing here becomes a page global another mode could collide with.
(() => {
  const BLANK = '_____';

  // Every sentence that still holds the word: the one you met it in first, then
  // the dictionary's own examples. All of them, where this used to stop at the
  // first — a word with a saved context and two examples is three different
  // questions, and asking only ever the first is how a sentence stops being
  // read and starts being recognised by its shape.
  //
  // A filter where eligible() once short-circuited on the context, which costs
  // one array of at most senses+1 strings per word per render. Nothing like the
  // scar practice.js:152 carries: that one built a whole quiz question per word.
  function sentencesOf(entry) {
    return [entry.context, ...(entry.senses ?? []).map((s) => s.example)]
      .filter((text) => text && VT.has(entry.word, text, entry.lang));
  }

  // `rand` is a parameter only so the test can pin the draw, the same seam
  // VT.quizOptions leaves open for the same reason (lib.js:307).
  function sentenceOf(entry, rand = Math.random) {
    return VT.shuffled(sentencesOf(entry), rand)[0] ?? '';
  }

  // Up to three other words. Same level first, like the quiz, so register does
  // not give the answer away. A word already in the sentence is out: offering
  // "tentative" for "a _____, tentative plan" reads as a trick, not a question.
  function optionsFor(entry, sentence, pool) {
    const near = [];
    const far = [];
    const seen = new Set([entry.word.toLowerCase()]);
    for (const other of pool ?? []) {
      const key = other?.word?.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (VT.has(other.word, sentence, other.lang)) continue;
      (other.level && other.level === entry.level ? near : far).push(other.word);
    }
    const picked = [...VT.shuffled(near), ...VT.shuffled(far)].slice(0, 3);
    return VT.shuffled([entry.word, ...picked]);
  }

  // The sentence as text with a span per match, so each blank can later be
  // filled in place with the word exactly as the sentence spelled it.
  function blanked(sentence, word, node, lang) {
    const p = node('p', 'prsentence');
    for (const piece of VT.pieces(sentence, VT.find(word, sentence, lang))) {
      if (!piece.hit) {
        p.append(piece.text);
        continue;
      }
      const gap = node('span', 'prgap', BLANK);
      // The word as the SENTENCE spelled it, so filling the blank back in
      // keeps the original capitalisation.
      gap.dataset.word = piece.text;
      p.appendChild(gap);
    }
    return p;
  }

  // The blanks of the question on screen, for hint(): the shell hands it the
  // entry and the ctx, and neither of those knows which sentence was drawn or
  // where its gaps fell. One variable says it because one question is live at a
  // time — the shell asks them strictly in sequence (practice.js:372).
  let gaps = [];

  // Typing the word is producing it and picking it from four is not, which is
  // the whole difference between a Hard and an Easy (practice.js:267). Written
  // onto the registered mode because that is the object the shell looks up when
  // it grades (practice.js:335), and written here rather than at register time
  // because the saved settings have not reached PRACTICE yet when a mode file
  // loads — dashboard.js:1590 supplies the hooks afterwards. ask() is early
  // enough: the grade is read after ask() resolves.
  function setProduces(typed) {
    const mode = PRACTICE.modes.get('fill');
    if (mode) mode.produces = typed;
  }

  // Read through the hook every time, never snapshotted: setReviewPrefs
  // replaces the settings object rather than editing it (dashboard.js:1417), so
  // ctx.settings is the one from when the session started and stops answering
  // the moment the switch below saves. The shell reads its own length setting
  // through the hook for the same reason (practice.js:137).
  function typedOn() {
    return !!PRACTICE.hooks.settings().fillTyped;
  }

  // Say the word — offered only once it is no longer the answer. This is the
  // one mode that must stay silent while the question is up, because here the
  // word IS the answer: practice.js:68 keeps the shell's Space replay quiet
  // until a mode has spoken, and test/practice-probe.html:405 pins that Fill is
  // the mode that never does. Drawing the button from the start and disabling
  // it until the answer was the alternative — dead chrome for the whole
  // question, inviting the click it refuses.
  function playButton(entry, ctx) {
    const b = ctx.node('button', 'prf-play', '▶ Say it');
    b.type = 'button';
    b.setAttribute('aria-label', `Listen to ${entry.word}`);
    b.addEventListener('click', () => ctx.speak(entry));
    return b;
  }

  // The first letter, written into the gap rather than into a line under the
  // sentence: the gap is where the eye already is, and "s____" is the shape the
  // blank already had. Nothing is returned — ctx.hint appends only what it is
  // given (practice.js:354) — because the help is on screen by then.
  //
  // A one-syllable Korean word's hint is the whole word. That is the honest
  // answer to "the first letter" there, and a hint caps the grade at Hard
  // either way (practice.js:267), so it costs what it should.
  function hint(entry) {
    const first = [...String(entry.word)][0] ?? '';
    for (const gap of gaps) gap.textContent = first + BLANK.slice(first.length);
    return null;
  }

  function ask(entry, host, ctx) {
    const sentence = sentenceOf(entry);
    // Drawn once for the question and not once per view: flipping the variant
    // must not deal a fresh set of distractors, which reads as the question
    // being replaced rather than restated.
    const options = optionsFor(entry, sentence, ctx.pool);
    const line = blanked(sentence, entry.word, ctx.node, entry.lang);
    gaps = [...line.querySelectorAll('.prgap')];
    // What the sentence itself spelled, which is what a typist types. Korean is
    // why: ko.match ranges cover the whole 어절, so the gap in "나는 _____
    // 읽었다" is 책을, and grading only against 책 would call the sentence's own
    // word wrong. English never needs the second spelling — en.match is exact
    // and only the case can differ (lang/en/index.js:61), which ctx.same
    // already forgives — but one array is cheaper than a language branch.
    const spellings = [entry.word, ...gaps.map((gap) => gap.dataset.word)];
    const gloss = VT.glossOf(entry);
    const root = ctx.node('div', 'pr-fill');
    host.appendChild(root);
    setProduces(typedOn());

    return new Promise((resolve) => {
      // The question. Listeners end with it or with the session, whichever is
      // first.
      const done = new AbortController();
      ctx.signal?.addEventListener('abort', () => done.abort(), { once: true, signal: done.signal });
      // The view inside the question. A variant swap redraws in place, and the
      // options it removes have to take their keys with them: the digits are
      // bound on the document, where a discarded grid's handler would go on
      // answering for a grid nobody can see.
      let view = null;

      const reveal = (ok, told) => {
        done.abort();
        // The blanks take the word, so the sentence is read whole once.
        for (const gap of gaps) gap.replaceWith(ctx.node('mark', null, gap.dataset.word));
        gaps = [];
        root.appendChild(playButton(entry, ctx));
        resolve(ctx.next(ok, told));
      };

      const picking = () => {
        const grid = ctx.node('div', 'propts');
        const buttons = options.map((word, i) => {
          const b = ctx.node('button');
          b.type = 'button';
          b.dataset.word = word;
          b.append(ctx.node('kbd', null, String(i + 1)), word);
          grid.appendChild(b);
          return b;
        });
        root.appendChild(grid);

        const pick = (b) => {
          const ok = b.dataset.word === entry.word;
          for (const other of buttons) {
            other.disabled = true;
            if (other.dataset.word === entry.word) other.classList.add('right');
          }
          if (!ok) b.classList.add('wrong');
          reveal(ok, ok ? null : entry.word);
        };

        for (const b of buttons) b.addEventListener('click', () => pick(b), { signal: view.signal });
        document.addEventListener('keydown', (e) => {
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          const b = buttons[Number(e.key) - 1];
          if (!b) return;
          e.preventDefault();
          pick(b);
        }, { signal: view.signal });
      };

      const typing = () => {
        // A form, so Enter is the native submit and not one more key handler —
        // and no digit listener anywhere in this view, or a "1" typed into the
        // box would answer the question instead of landing in it.
        const form = ctx.node('form', 'prfform');
        const input = ctx.node('input', 'prinput');
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.setAttribute('aria-label', 'Type the missing word');
        form.appendChild(input);
        root.appendChild(form);
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          input.disabled = true;
          const typed = input.value.trim();
          // Empty is "I don't know": wrong, and nothing to quote back.
          const ok = typed !== '' && spellings.some((word) => ctx.same(typed, word));
          // What you wrote goes in the verdict on purpose: the shell's miss
          // list shows whatever string reached ctx.next (practice.js:576), and
          // without it the round ends with no record of the attempt at all.
          reveal(ok, ok ? null
            : typed ? `You typed “${typed}” — it was “${entry.word}”`
            : "You didn't answer");
        }, { once: true, signal: view.signal });
        input.focus();
      };

      // Two .rvopt buttons, which already are a segmented control
      // (dashboard.css:455). The switch takes effect on the question in front
      // of you rather than on the next one, for the reason the length control
      // beside it carries (practice.js:521): a control that visibly does
      // nothing reads as a broken one.
      const variantRow = (typed) => {
        const row = ctx.node('div', 'prfvariant');
        for (const [want, label] of [[false, 'Pick it'], [true, 'Type it']]) {
          const b = ctx.node('button', 'rvopt', label);
          b.type = 'button';
          b.setAttribute('aria-pressed', String(want === typed));
          b.addEventListener('click', () => {
            if (want === typed) return;
            PRACTICE.hooks.saveSettings({ fillTyped: want });
            setProduces(want);
            draw(want);
          }, { signal: view.signal });
          row.appendChild(b);
        }
        return row;
      };

      // The same sentence node through every redraw, never a rebuilt one: the
      // gaps carry the spelling the fill and the hint put back, and a second
      // blanked() would also re-run the matcher for a sentence that has not
      // changed.
      const draw = (typed) => {
        view?.abort();
        view = new AbortController();
        done.signal.addEventListener('abort', () => view.abort(), { once: true, signal: view.signal });
        root.replaceChildren(variantRow(typed), line);
        if (gloss) root.appendChild(ctx.node('p', 'prhint', gloss));
        (typed ? typing : picking)();
      };

      draw(typedOn());
    });
  }

  // ctx.node for the self-test, the same shape practice.js hands a mode.
  function node(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  // Driven in a detached host against a hand-made pool, so it checks this mode
  // and not whatever words the page happens to hold. The sentence holds the
  // word twice (once capitalised) and one pool word, which must not be offered.
  async function selfTest() {
    const w = (word, level, context) => ({ word, level, vi: 'vi ' + word, context, senses: [] });
    const entry = w('strategy', 'B2', 'Our strategy beat their Strategy, a tentative plan.');
    const pool = [entry, w('tentative', 'B2', 'x'), w('leverage', 'B2', 'x'),
      w('scarce', 'B2', 'x'), w('candid', 'C1', 'x'), w('nuance', 'C1', 'x')];
    const out = [];

    // The variant is kept with the review settings, and the probe page loads
    // dashboard.js — so the real hook would write "type it" into storage and
    // hand the live fill session at test/practice-probe.html:399 a variant
    // nobody asked for. Borrowed for the run and put back after, the way
    // practice-listening's checks borrow getVoices.
    const realSettings = PRACTICE.hooks.settings;
    const realSave = PRACTICE.hooks.saveSettings;
    const wasProduces = PRACTICE.modes.get('fill').produces;
    let saved = {};
    PRACTICE.hooks.settings = () => saved;
    PRACTICE.hooks.saveSettings = (patch) => { saved = { ...saved, ...patch }; };
    try {
      return await checks();
    } finally {
      PRACTICE.hooks.settings = realSettings;
      PRACTICE.hooks.saveSettings = realSave;
      setProduces(wasProduces);
    }

    async function checks() {
      // how: 'key' presses the right option's number, 'click' clicks a wrong
      // one, 'type' submits `text`, 'digit' presses 1 without meaning to
      // answer, 'switch' clicks the other variant, 'hint' asks for the letter.
      // null only draws the question.
      const drive = async (how, opts = {}) => {
        const { subject = entry, words = pool, text = '', typed = false } = opts;
        saved = { ...saved, fillTyped: typed };
        const host = document.createElement('div');
        document.body.appendChild(host);
        const abort = new AbortController();
        let spoke = 0;
        let told = null;
        const ctx = {
          pool: words, signal: abort.signal, node, same: PRACTICE.same,
          speak: () => { spoke++; },
          next: async (ok, answer) => { told = answer; return ok; },
          record() {}, status() {}, skipped: () => false,
          hint: (n) => { if (n) host.appendChild(n); },
          direction: 'w2m', settings: saved
        };
        const result = ask(subject, host, ctx);
        const options = () => [...host.querySelectorAll('.propts button')];
        const sentence = () => host.querySelector('.prsentence')?.textContent ?? '';
        const offered = options().map((b) => b.dataset.word);
        const shown = sentence();
        // Before anything is answered: the mode that must not speak has not
        // even offered the button yet.
        const playedEarly = !!host.querySelector('.prf-play');
        let hinted;

        if (how === 'key' || how === 'digit') {
          // With the keyboard claimed, as in use: a bare "1" on the document is
          // also a review grade, and review only stands aside while practice
          // owns the keys.
          const claim = PRACTICE.testHost();
          const key = how === 'key' ? String(offered.indexOf(subject.word) + 1) : '1';
          document.dispatchEvent(new KeyboardEvent('keydown', { key }));
          claim.done();
        } else if (how === 'click') {
          options().find((b) => b.dataset.word !== subject.word).click();
        } else if (how === 'type') {
          host.querySelector('.prinput').value = text;
          host.querySelector('form').requestSubmit();
        } else if (how === 'switch') {
          host.querySelectorAll('.prfvariant .rvopt')[typed ? 0 : 1].click();
        } else if (how === 'hint') {
          hinted = hint(subject, ctx);
        }

        // 'digit' and 'switch' answer nothing, so awaiting them would hang:
        // an unanswered ask() is left pending for good, which practice.js's
        // Promise.race is built around.
        const answered = how === 'key' || how === 'click' || how === 'type';
        const ok = answered ? await result : null;
        const quiet = spoke;
        const play = host.querySelector('.prf-play');
        play?.click();
        const state = {
          ok, told, offered, hinted, quiet, said: spoke,
          text: shown, after: sentence(),
          marks: [...host.querySelectorAll('mark')].map((m) => m.textContent),
          gaps: [...host.querySelectorAll('.prgap')].map((g) => g.textContent),
          wrong: host.querySelectorAll('.propts .wrong').length,
          right: host.querySelectorAll('.propts .right').length,
          playedEarly, played: !!play,
          typing: !!host.querySelector('.prinput'),
          picking: options().length > 0
        };
        abort.abort();
        host.remove();
        return state;
      };

      const a = await drive('key');
      const list = a.offered.join(', ');
      out.push(['blanked sentence no longer holds the word', !VT.has(entry.word, a.text, entry.lang), a.text]);
      out.push(['every match is blanked', a.text.split(BLANK).length === 3, a.text]);
      out.push(['four options, the word exactly once',
        a.offered.length === 4 && a.offered.filter((x) => x === entry.word).length === 1, list]);
      out.push(['no option already in the sentence',
        a.offered.every((x) => x === entry.word || !VT.has(x, entry.context, entry.lang)), list]);
      out.push(['same-level words come first',
        a.offered.includes('leverage') && a.offered.includes('scarce'), list]);
      out.push(['the right key resolves true', a.ok === true]);
      out.push(['blanks filled with the word as spelled', a.marks.join('|') === 'strategy|Strategy', a.marks.join('|')]);
      // The word is the answer here, so it cannot be said until it has been
      // given — and then it can, which is what the button is for.
      out.push(['nothing is said while the question is up, and the word can be heard after',
        !a.playedEarly && a.played && a.quiet === 0 && a.said === 1,
        `early ${a.playedEarly}, quiet ${a.quiet}, said ${a.said}`]);

      const b = await drive('click');
      out.push(['a wrong click resolves false, marks it and the answer',
        b.ok === false && b.wrong === 1 && b.right === 1]);

      const tiny = { ...entry, context: 'A strategy.' };
      const c = await drive(null, { subject: tiny, words: [tiny, pool[1]] });
      out.push(['works with fewer than four options', c.offered.length === 2, c.offered.join(', ')]);

      // A Korean entry, which nothing drove before. Everything here routes
      // through the entry's own pack — blanked() via VT.find, optionsFor via
      // VT.has — so the interesting part is the range: ko.match returns the
      // whole 어절, so the gap swallows 책을 and the fill has to put back what
      // the sentence said, particle and all. An English-shaped blank would
      // leave 을 stranded beside the gap and give the answer away.
      const k = (word, vi, context) => ({ word, lang: 'ko', level: '초급', vi, context, senses: [] });
      const koEntry = k('책', 'sách', '나는 책을 읽었다');
      // 나 is the distractor that matters: it IS in the sentence, as 나는, and
      // only the Korean matcher can see it there — \b never fires between
      // Hangul syllables, so an English-shaped check would offer it as a wrong
      // answer that is sitting in plain view two words away.
      const koPool = [koEntry, k('신문', 'báo', 'x'), k('학교', 'trường', 'x'),
        k('친구', 'bạn', 'x'), k('나', 'tôi', 'x')];
      const d = await drive('key', { subject: koEntry, words: koPool });
      out.push(['a Korean blank takes the whole 어절',
        d.marks.join('|') === '책을', d.marks.join('|')]);
      out.push(['and the blanked sentence no longer holds the word',
        !VT.has(koEntry.word, d.text, koEntry.lang), d.text]);
      out.push(['four Korean options, the word exactly once',
        d.offered.length === 4 && d.offered.filter((x) => x === koEntry.word).length === 1,
        d.offered.join(', ')]);
      out.push(['and the right key still resolves true on a Korean card', d.ok === true]);
      out.push(['no Korean option is already in the sentence behind a particle',
        !d.offered.includes('나'), d.offered.join(', ')]);

      /* ---- the typed variant ---- */

      const t = await drive('type', { typed: true, text: '  STRATEGY ' });
      out.push(['typed — the word in any case is right, with no options offered',
        t.ok === true && t.typing && !t.picking && t.played,
        `ok ${t.ok}, typing ${t.typing}, picking ${t.picking}`]);
      const miss = await drive('type', { typed: true, text: 'tactic' });
      out.push(['typed — a wrong word is wrong, and the verdict quotes what you typed',
        miss.ok === false && /tactic/.test(miss.told ?? '') && /strategy/i.test(miss.told ?? ''), miss.told]);
      const blank = await drive('type', { typed: true, text: '   ' });
      out.push(['typed — an empty answer is wrong', blank.ok === false && blank.told === "You didn't answer", blank.told]);
      // The digits belong to the picking view alone. In the box they are
      // characters, and a listener left on the document would spend one of them
      // on the question.
      const digit = await drive('digit', { typed: true });
      out.push(['typed — a digit on the document does not answer for you',
        digit.marks.length === 0 && digit.typing, digit.marks.join('|')]);
      // Grading against the word alone would reject the sentence's own spelling.
      const koTyped = await drive('type', { subject: koEntry, words: koPool, typed: true, text: '책을' });
      const koWord = await drive('type', { subject: koEntry, words: koPool, typed: true, text: '책' });
      out.push(['typed — the gap as the sentence spelled it is accepted, and so is the word',
        koTyped.ok === true && koWord.ok === true, `어절 ${koTyped.ok}, word ${koWord.ok}`]);

      /* ---- the switch between them ---- */

      const toTyped = await drive('switch');
      out.push(['the switch redraws the same question in the other variant, and remembers it',
        toTyped.typing && !toTyped.picking && toTyped.after === toTyped.text && saved.fillTyped === true,
        `typing ${toTyped.typing}, sentence kept ${toTyped.after === toTyped.text}`]);
      // Recognition and production are graded apart (practice.js:267), so the
      // switch has to move `produces` with it — and before the answer, because
      // the shell reads it once the question has resolved.
      const graded = PRACTICE.modes.get('fill').produces;
      const toPicking = await drive('switch', { typed: true });
      out.push(['typing is graded as production, picking is not',
        graded === true && toPicking.picking && !toPicking.typing
        && PRACTICE.modes.get('fill').produces === false && saved.fillTyped === false,
        `typed ${graded}, picking ${PRACTICE.modes.get('fill').produces}`]);

      /* ---- which sentence gets asked ---- */

      const twice = { ...entry, senses: [{ example: 'A sound strategy takes years.' }] };
      out.push(['a word with a saved sentence and an example can be asked with either',
        sentencesOf(twice).length === 2 && sentenceOf(twice, () => 0) !== sentenceOf(twice, () => 0.99),
        sentencesOf(twice).join(' | ')]);
      const example = { ...twice, context: 'Nothing of the sort here.' };
      out.push(['a context without the word falls through to the example',
        PRACTICE.modes.get('fill').eligible(example) && sentenceOf(example) === example.senses[0].example,
        sentenceOf(example)]);
      out.push(['a word in neither is not asked at all',
        !PRACTICE.modes.get('fill').eligible({ ...entry, context: 'Nothing of the sort here.' })]);

      /* ---- the hint ---- */

      const h = await drive('hint');
      out.push(['the hint puts the first letter in every gap, and nothing under the sentence',
        h.gaps.length === 2 && h.gaps.every((g) => g === 's____') && h.hinted === null, h.gaps.join('|')]);
      const koHint = await drive('hint', { subject: koEntry, words: koPool });
      out.push(['and on a Korean card the first syllable, the gap still a gap',
        koHint.gaps.join('') === '책____', koHint.gaps.join('')]);
      return out;
    }
  }

  PRACTICE.register('fill', {
    title: 'Fill the gap',
    blurb: 'Put the word back in the sentence',
    icon: 'T',
    color: 'red',
    // Four, for four options to pick from. A count, so it lives in min and the
    // tab says so, rather than in eligible where it read as "no sentences".
    // Kept for the typed variant too, which needs only the one word: the
    // variant is a button on the question, so a tab opened with three words
    // could be flipped to picking and have no question left to ask.
    min: 4,
    // The starting variant, and only that: ask() sets it from the saved choice
    // on every question (setProduces above), because at this point the settings
    // have not reached PRACTICE yet.
    produces: false,
    why: 'Needs four words with a saved sentence',
    eligible: (entry) => sentencesOf(entry).length > 0,
    ask,
    hint,
    selfTest
  });
})();
