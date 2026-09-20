// Fill the gap: a sentence with the word blanked out, pick the word.
//
// The sentence is the one you saved the word from when it still contains the
// word, else the first dictionary example that does. The options are words,
// not meanings: the sentence is the question, so the choice is which word
// fits it. See practice.js for the contract.
//
// Wrapped so nothing here becomes a page global another mode could collide with.
(() => {
  const BLANK = '_____';

  // The saved sentence first: it is the one you met the word in.
  function sentenceOf(entry) {
    return [entry.context, ...(entry.senses ?? []).map((s) => s.example)]
      .find((text) => text && VT.has(entry.word, text, entry.lang)) ?? '';
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

  function ask(entry, host, ctx) {
    const sentence = sentenceOf(entry);
    const root = ctx.node('div', 'pr-fill');
    const line = blanked(sentence, entry.word, ctx.node, entry.lang);
    root.appendChild(line);
    const gloss = VT.glossOf(entry);
    if (gloss) root.appendChild(ctx.node('p', 'prhint', gloss));

    const grid = ctx.node('div', 'propts');
    const buttons = optionsFor(entry, sentence, ctx.pool).map((word, i) => {
      const b = ctx.node('button');
      b.type = 'button';
      b.dataset.word = word;
      b.append(ctx.node('kbd', null, String(i + 1)), word);
      grid.appendChild(b);
      return b;
    });
    root.appendChild(grid);
    host.appendChild(root);

    return new Promise((resolve) => {
      // Listeners end with the question or with the dialog, whichever is first.
      const done = new AbortController();
      ctx.signal?.addEventListener('abort', () => done.abort(), { once: true, signal: done.signal });

      const pick = (b) => {
        done.abort();
        const ok = b.dataset.word === entry.word;
        for (const other of buttons) {
          other.disabled = true;
          if (other.dataset.word === entry.word) other.classList.add('right');
        }
        if (!ok) b.classList.add('wrong');
        // The blank takes the word, so the sentence is read whole once.
        for (const gap of line.querySelectorAll('.prgap')) {
          gap.replaceWith(ctx.node('mark', null, gap.dataset.word));
        }
        resolve(ctx.next(ok, ok ? null : entry.word));
      };

      for (const b of buttons) b.addEventListener('click', () => pick(b), { signal: done.signal });
      document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const b = buttons[Number(e.key) - 1];
        if (!b) return;
        e.preventDefault();
        pick(b);
      }, { signal: done.signal });
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

    // how: 'key' presses the right option's number, 'click' clicks a wrong one.
    const drive = async (how, subject = entry, words = pool) => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const abort = new AbortController();
      const ctx = { pool: words, signal: abort.signal, node, same: PRACTICE.same, next: async (ok) => ok };
      const result = ask(subject, host, ctx);
      const buttons = [...host.querySelectorAll('.propts button')];
      const offered = buttons.map((b) => b.dataset.word);
      const text = host.querySelector('.prsentence').textContent;
      if (how === 'key') {
        // With the dialog open, as in use: a bare "1" on the document is also
        // a review grade, and the review only stands aside while it is open.
        const dlg = document.getElementById('practice-dlg');
        const opened = dlg && !dlg.open;
        if (opened) dlg.showModal();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: String(offered.indexOf(subject.word) + 1) }));
        if (opened) dlg.close();
      } else if (how === 'click') {
        buttons.find((b) => b.dataset.word !== subject.word).click();
      }
      const ok = how ? await result : null;
      const marks = [...host.querySelectorAll('mark')].map((m) => m.textContent);
      const wrong = host.querySelectorAll('.propts .wrong').length;
      const right = host.querySelectorAll('.propts .right').length;
      abort.abort();
      host.remove();
      return { ok, offered, text, marks, wrong, right };
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

    const b = await drive('click');
    out.push(['a wrong click resolves false, marks it and the answer',
      b.ok === false && b.wrong === 1 && b.right === 1]);

    const tiny = { ...entry, context: 'A strategy.' };
    const c = await drive(null, tiny, [tiny, pool[1]]);
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
    const d = await drive('key', koEntry, koPool);
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
    return out;
  }

  PRACTICE.register('fill', {
    title: 'Fill the gap',
    blurb: 'Pick the word for the sentence',
    icon: 'T',
    color: 'red',
    // Four, for four options to pick from. A count, so it lives in min and the
    // card says so, rather than in eligible where it read as "no sentences".
    min: 4,
    why: 'Needs four words with a saved sentence',
    eligible: (entry) => [entry.context, ...(entry.senses ?? []).map((s) => s.example)]
      .some((text) => text && VT.has(entry.word, text, entry.lang)),
    ask,
    selfTest
  });
})();
