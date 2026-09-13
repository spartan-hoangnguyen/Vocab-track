// The RSVP speed reader: one word at a time at a fixed focal point, so the eye
// never travels. Extraction, overlay and the timer loop live here; the
// arithmetic (tokenise, pivotOf, holdFor) is in lib.js so tests can reach it.
//
// Loaded after content-script.js, and shares its global scope — removeButton()
// below is that file's.


/* ---------- what to read ---------- */


const RSVP_BLOCKS = 'p, li, blockquote, h1, h2, h3, h4, h5, h6';
// The exclusions rangesFor() already uses, plus the page furniture a reader
// must never start in. Highlighting a word in a nav link is harmless;
// reading the nav aloud is not.
const RSVP_SKIP = 'script, style, code, pre, textarea, nav, header, footer, aside, form';
// Comment threads are the one thing that reliably outscores an article — they
// are prose, they are long, and on a busy post there is more of them. Matched
// on class and id because the markup is otherwise identical to the article's.
const RSVP_JUNK =
  /(^|[^a-z])(comment|disqus|sidebar|footer|nav|promo|related|share|social|reply)/i;
// Below this the extraction has failed (a paywall, a lazy-loaded body) and the
// whole page is a better guess than four words.
const RSVP_MIN_TEXT = 400;

function rsvpVisible(el) {
  // Every checkVisibility option defaults to false, and a bare call returns
  // true for both visibility:hidden and opacity:0 — which is exactly how a
  // hidden mobile/desktop duplicate is built. Legacy option names on purpose:
  // visibilityProperty/opacityProperty postdate the manifest's Chrome 116
  // floor. contentVisibilityAuto is deliberately NOT passed — it reports a
  // real article paragraph as invisible merely for being below the fold.
  if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  // Screen-reader-only text passes every CSS check; it is parked off-canvas.
  const rect = el.getBoundingClientRect();
  return rect.right > 0 && rect.bottom > 0;
}

function rsvpJunky(el) {
  for (let node = el; node && node !== document.body; node = node.parentElement) {
    // getAttribute, not .className: on an SVG element that is an
    // SVGAnimatedString and stringifies to "[object SVGAnimatedString]".
    if (RSVP_JUNK.test(`${node.getAttribute?.('class') ?? ''} ${node.id ?? ''}`)) return true;
  }
  return false;
}

// A list of links reads like prose to a text-length score. This is what keeps
// "Related stories" and tag clouds out.
function rsvpLinkDensity(el) {
  const total = el.innerText.length;
  if (!total) return 1;
  let linked = 0;
  for (const link of el.querySelectorAll('a')) linked += link.innerText.length;
  return linked / total;
}

// innerText, not textContent, throughout: it already drops display:none
// descendants, collapses whitespace, and turns <br>-separated pseudo-paragraphs
// into real line breaks. It is layout-dependent and therefore not cheap, which
// is fine on a user gesture.
function rsvpBlocks(root) {
  return [...root.querySelectorAll(RSVP_BLOCKS)].filter((el) =>
    !el.closest(RSVP_SKIP) &&
    el.innerText.trim() &&
    !rsvpJunky(el) &&
    rsvpVisible(el) &&
    rsvpLinkDensity(el) < 0.5);
}

// The container the article actually lives in.
//
// Scoring every ancestor by the text of its descendants cannot work: a
// parent's descendants are a superset of its child's, so <body> always wins
// and the reader starts in the comments. Readability's answer, and this one:
// credit each block's PARENT in full and its GRANDPARENT at half. Not
// monotonic, so it converges on the article's own wrapper — and the
// grandparent half-credit is what survives the per-paragraph wrapper divs that
// Medium and Substack emit.
function rsvpRoot() {
  // Longest, not first: querySelector('article') on a blog index returns the
  // first teaser, and <main> on an app is the whole shell.
  const semantic = [...document.querySelectorAll('article, main, [role=main]')]
    .sort((a, b) => b.innerText.length - a.innerText.length)[0];
  const blocks = rsvpBlocks(semantic ?? document.body);
  if (!blocks.length) return rsvpBlocks(document.body);

  const score = new Map();
  const credit = (el, n) => { if (el) score.set(el, (score.get(el) ?? 0) + n); };
  for (const block of blocks) {
    const n = block.innerText.trim().length;
    const parent = block.parentElement;
    // A container holding exactly one block is packaging, not a candidate.
    // Medium and Substack wrap every paragraph in its own div; crediting those
    // wrappers in full while the article's real wrapper gets only half-credit
    // lets any plainly-nested section elsewhere on the page outscore the
    // article. Skipping the wrapper hands its credit to the element that
    // actually holds the prose.
    if (parent && parent.querySelectorAll(RSVP_BLOCKS).length === 1) {
      credit(parent.parentElement, n);
    } else {
      credit(parent, n);
      credit(parent?.parentElement, n / 2);
    }
  }

  let best = null;
  let top = 0;
  for (const [el, n] of score) if (n > top) { top = n; best = el; }
  const inner = best ? rsvpBlocks(best) : [];
  return inner.length ? inner : blocks;
}

// { tokens, marks, ends }. `marks` maps a token index back to the element it
// came from, so closing the reader can scroll there; `ends` is the set of token
// indices that finish a paragraph, which holdFor turns into a pause.
function rsvpRead(selected) {
  if (selected) return { tokens: VT.tokenise(selected), marks: [], ends: new Set() };

  const tokens = [];
  const marks = [];
  const ends = new Set();
  for (const block of rsvpRoot()) {
    const words = VT.tokenise(block.innerText);
    if (!words.length) continue;
    marks.push({ i: tokens.length, el: block });
    tokens.push(...words);
    ends.add(tokens.length - 1);
  }

  if (tokens.join(' ').length >= RSVP_MIN_TEXT) return { tokens, marks, ends };
  // Extraction failed. The whole page is ugly but readable; four words is not.
  const whole = VT.tokenise(document.body.innerText);
  return whole.length > tokens.length
    ? { tokens: whole, marks: [], ends: new Set() }
    : { tokens, marks, ends };
}


/* ---------- the overlay ---------- */


const WPM_MIN = 100;
const WPM_MAX = 700;
const WPM_STEP = 25;
const WPM_DEFAULT = 300;   // the rate non-native readers comprehend at

const READER_CSS = `
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%}
body{direction:ltr;background:#14120f;color:#efece6;
  font:400 13px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  display:flex;align-items:center;justify-content:center;
  user-select:none;overflow:hidden;cursor:default}
.stage{width:min(92vw,940px);display:flex;flex-direction:column;align-items:center}
.rail{width:100%;height:11px;position:relative;flex:none}
.rail::after{content:"";position:absolute;left:50%;width:1px;height:11px;background:#57503f}
.rail.top::after{bottom:0}
.rail.bot::after{top:0}
.word{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);width:100%;
  font:400 clamp(30px,6vw,64px)/1.25 Georgia,"Times New Roman",serif;
  font-kerning:none;font-variant-ligatures:none;padding:10px 0}
/* Two independent guards hold the pivot still, and EITHER alone is enough —
   measured: with both gone the focal letter drifts 187px on a 28-character
   word. minmax(0,1fr) stops the fr track inheriting min-width:auto from its
   content; overflow:hidden makes the span a scroll container, whose automatic
   minimum size is zero. overflow:hidden also earns its place by clipping a
   very long word instead of letting it run off screen. nowrap because a
   column that CAN shrink will take any break opportunity it finds — a hyphen. */
.word span{white-space:nowrap;overflow:hidden}
.b{text-align:right}
.a{text-align:left}
.p{color:#e8643c}
.bar{width:100%;height:2px;background:#2b2721;margin:34px 0 12px;flex:none}
.bar i{display:block;height:100%;width:0;background:#8a8172;transition:width .12s linear}
.meta{width:100%;display:flex;justify-content:space-between;color:#8a8172;
  font-variant-numeric:tabular-nums}
.hint{margin-top:26px;color:#5f584c;font-size:12px;text-align:center}
kbd{font:inherit;color:#8a8172}
`;

const READER_HTML = `
<div class="stage">
  <div class="rail top"></div>
  <div class="word"><span class="b"></span><span class="p"></span><span class="a"></span></div>
  <div class="rail bot"></div>
  <div class="bar"><i></i></div>
  <div class="meta"><span class="pos"></span><span class="wpm"></span></div>
  <div class="hint">
    <kbd>space</kbd> play / pause &nbsp;·&nbsp; <kbd>←</kbd> <kbd>→</kbd> step
    &nbsp;·&nbsp; <kbd>↑</kbd> <kbd>↓</kbd> speed &nbsp;·&nbsp; <kbd>esc</kbd> close
  </div>
</div>
`;

let rsvp = null;
// Separate from `rsvp` because opening awaits a storage read: two fast presses
// of the shortcut would both pass an `if (rsvp)` check and build two overlays.
let rsvpOpening = false;

async function openReader() {
  if (rsvp || rsvpOpening) return;
  rsvpOpening = true;
  try {
    await buildReader();
  } finally {
    rsvpOpening = false;
  }
}

async function buildReader() {
  // Before anything else touches the DOM: showModal() and the focus move both
  // collapse the selection, and the selection is the whole point of "read just
  // this bit".
  const selected = window.getSelection()?.toString().trim() || null;
  // The lookup button must not be left sitting over the reader.
  removeButton();

  const { tokens, marks, ends } = rsvpRead(selected && selected.length > 1 ? selected : null);
  if (!tokens.length) {
    console.error('[vocab-track] nothing readable on this page');
    return;
  }

  const stored = await chrome.storage.local.get('rsvpWpm');
  const host = document.createElement('dialog');
  // 'all' first, for the reason content-script.js already documents. Then
  // !important on every declaration: an inline style without it LOSES to a
  // page rule like `div{display:none!important}`, which would leave the reader
  // invisible. direction is spelled out because it and unicode-bidi are
  // excluded from the `all` shorthand and leak in from an RTL page.
  // Verified in Chrome 2026-09-13.
  host.style.cssText = [
    'all:initial!important', 'display:block!important', 'direction:ltr!important',
    'position:fixed!important', 'inset:0!important',
    'width:100vw!important', 'height:100vh!important',
    'max-width:none!important', 'max-height:none!important',
    'border:0!important', 'padding:0!important', 'margin:0!important',
    'background:#14120f!important', 'z-index:2147483647!important'
  ].join(';');
  document.body.appendChild(host);
  // showModal, not a plain fixed div: the top layer is the only thing that
  // paints above a :fullscreen element (fullscreen YouTube) and that survives a
  // transform on <html>, which would otherwise make position:fixed
  // body-relative instead of viewport-relative.
  host.showModal();

  // The reader lives in its own document. That is what makes its keys
  // unreachable: a page listener registered on window in the capture phase at
  // load time beats anything added at document_idle, but an event raised in
  // another document never reaches the parent window at all.
  const frame = document.createElement('iframe');
  frame.style.cssText = 'all:initial!important;display:block!important;border:0!important;'
    + 'width:100%!important;height:100%!important';
  // Appended once: re-parenting an iframe reloads its document.
  host.appendChild(frame);

  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  // new win.CSSStyleSheet(), not new CSSStyleSheet(): a sheet constructed in
  // this document is rejected with NotAllowedError when adopted into another.
  // adoptedStyleSheets rather than a <style> element because the page's CSP is
  // inherited by the about:blank frame, and style-src 'none' would silently
  // drop the element.
  const sheet = new win.CSSStyleSheet();
  sheet.replaceSync(READER_CSS);
  doc.adoptedStyleSheets = [sheet];
  doc.body.innerHTML = READER_HTML;

  const pick = (sel) => doc.querySelector(sel);
  rsvp = {
    host, win, doc, tokens, marks, ends,
    cur: 0,
    playing: false,
    timer: 0,
    wpm: clampWpm(stored.rsvpWpm ?? WPM_DEFAULT),
    el: {
      word: pick('.word'), b: pick('.b'), p: pick('.p'), a: pick('.a'),
      fill: pick('.bar i'), pos: pick('.pos'), wpm: pick('.wpm')
    }
  };

  doc.body.tabIndex = 0;
  doc.body.focus();
  win.addEventListener('keydown', onReaderKey);
  doc.body.addEventListener('click', toggleReader);
  // A background tab clamps timers to about a second, so a reader left running
  // drifts and then dumps a burst of words when you come back.
  document.addEventListener('visibilitychange', pauseOnHide);

  paintReader();
  playReader();
}

function clampWpm(wpm) {
  return Math.min(WPM_MAX, Math.max(WPM_MIN, Math.round(wpm / WPM_STEP) * WPM_STEP));
}

function paintReader() {
  const { tokens, cur, el } = rsvp;
  const token = tokens[cur] ?? '';
  const at = VT.pivotOf(token);
  el.b.textContent = token.slice(0, at);
  el.p.textContent = token.slice(at, at + 1);
  el.a.textContent = token.slice(at + 1);
  el.fill.style.width = `${((cur + 1) / tokens.length) * 100}%`;
  el.pos.textContent = `${cur + 1} / ${tokens.length}`;
  el.wpm.textContent = `${rsvp.wpm} wpm`;
}

function tickReader() {
  clearTimeout(rsvp.timer);
  if (!rsvp.playing) return;
  if (rsvp.cur >= rsvp.tokens.length - 1) { pauseReader(); return; }
  const hold = VT.holdFor(rsvp.tokens[rsvp.cur], 60000 / rsvp.wpm, rsvp.ends.has(rsvp.cur));
  rsvp.timer = setTimeout(() => {
    rsvp.cur++;
    paintReader();
    tickReader();
  }, hold);
}

function playReader() {
  if (rsvp.cur >= rsvp.tokens.length - 1) rsvp.cur = 0;
  rsvp.playing = true;
  paintReader();
  tickReader();
}

function pauseReader() {
  rsvp.playing = false;
  clearTimeout(rsvp.timer);
  paintReader();
}

function toggleReader() {
  if (rsvp.playing) pauseReader(); else playReader();
}

function pauseOnHide() {
  if (rsvp && document.hidden && rsvp.playing) pauseReader();
}

function stepReader(delta) {
  pauseReader();
  rsvp.cur = Math.min(rsvp.tokens.length - 1, Math.max(0, rsvp.cur + delta));
  paintReader();
}

function speedReader(delta) {
  rsvp.wpm = clampWpm(rsvp.wpm + delta);
  paintReader();
  // Restart the pending hold so the new speed is felt on the next word rather
  // than after the current one finishes at the old rate.
  if (rsvp.playing) tickReader();
}

function onReaderKey(event) {
  const keys = {
    ' ': () => toggleReader(),
    ArrowLeft: () => stepReader(-1),
    ArrowRight: () => stepReader(1),
    ArrowUp: () => speedReader(WPM_STEP),
    ArrowDown: () => speedReader(-WPM_STEP),
    Escape: () => closeReader()
  };
  const action = keys[event.key];
  if (!action) return;
  event.preventDefault();
  action();
}

function closeReader() {
  if (!rsvp) return;
  const { host, marks, cur, wpm } = rsvp;
  clearTimeout(rsvp.timer);
  document.removeEventListener('visibilitychange', pauseOnHide);
  // Removed outright rather than closed: all:initial has already defeated the
  // UA's `dialog:not([open]){display:none}` rule, so a merely-closed dialog
  // would stay on screen.
  host.remove();
  rsvp = null;

  chrome.storage.local.set({ rsvpWpm: wpm })
    .catch((err) => console.error('[vocab-track] could not save reading speed', err));

  // Land back on the page where you stopped reading. Selection mode has no
  // blocks, so there is nothing to scroll to.
  marks.findLast?.((mark) => mark.i <= cur)?.el
    .scrollIntoView({ block: 'center', behavior: 'smooth' });
}

chrome.runtime.onMessage.addListener((message) => {
  // Its own listener: chrome.runtime.onMessage takes as many as it is given,
  // and this handles a type content-script.js knows nothing about, so that
  // file needs no edit at all.
  if (message?.type === 'speed-read') openReader();
});
