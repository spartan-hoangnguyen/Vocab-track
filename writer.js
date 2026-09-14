// Live grammar checking in the page's own fields: attach on focus, debounce,
// ask the worker, underline what comes back, offer the replacement.
//
// Loaded last and sharing the scope of content-script.js and reader.js, so
// every top-level name in this file is prefixed `write`/`WRITE`. A single
// collision here is a SyntaxError that silently takes the whole file out.


/* ---------- settings ---------- */


const WRITE_DEBOUNCE = 1200;
// A privacy floor, not an optimisation. Below this a field is a search box, a
// username, a 2FA code or a URL — short strings that are nobody's business and
// that a grammar checker has nothing to say about anyway. Real prose is longer
// than forty characters before it is worth checking.
const WRITE_MIN_CHARS = 40;
const WRITE_HIGHLIGHT = 'vocab-write';
const WRITE_RED = '#e5534b';
const WRITE_MAX_RULES = 200;
const WRITE_MAX_REPLACEMENTS = 3;
const WRITE_TOP = 2147483647;

// Privacy guard. autocomplete="off" is a page saying "do not remember what is
// typed here" and "one-time-code" is an SMS code; either way the text has no
// business on a third-party server. closest(), because the attribute is
// routinely set on the <form> rather than the field. The `i` flag is
// load-bearing: attribute selectors match case-sensitively by default and
// pages in the wild write autocomplete="OFF".
const WRITE_NO_AUTO = '[autocomplete="off" i], [autocomplete="one-time-code" i]';

let writeEnabled = true;
let writeSkipHosts = [];

function writeSettings(stored) {
  // Absent means on: the checker is the point of installing this, and a user
  // who has never opened the dashboard should still get it.
  writeEnabled = stored.writeOn !== false;
  writeSkipHosts = Array.isArray(stored.writeOff) ? stored.writeOff : [];
}

function writeAllowed() {
  return writeEnabled && !writeSkipHosts.includes(location.hostname);
}

chrome.storage.local.get(['writeOn', 'writeOff'])
  .then((stored) => {
    writeSettings(stored);
    if (!writeAllowed()) writeDetach();
  })
  .catch((err) => console.error('[vocab-track] could not read writing settings', err));

// Subscribed as well as read once, so switching the toggle off in the
// dashboard stops the checking in every open tab immediately. Without this the
// user would have to reload every page they had open to make "off" mean off,
// which for a privacy switch is not good enough.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!('writeOn' in changes) && !('writeOff' in changes)) return;
  if ('writeOn' in changes) writeEnabled = changes.writeOn.newValue !== false;
  if ('writeOff' in changes) {
    writeSkipHosts = Array.isArray(changes.writeOff.newValue) ? changes.writeOff.newValue : [];
  }
  if (!writeAllowed()) writeDetach();
});


/* ---------- attach / detach ---------- */


let writeEl = null;
let writeMode = null;      // 'plain' (textarea/input) | 'rich' (contenteditable)
let writeIndex = null;     // { text, nodes } — see writeIndexOf
let writeMatches = [];
let writeLast = '';        // the text of the last request, so a no-op recheck is skipped
let writeTimer = 0;
// `ruleId\0the offending text`, for everything counted since this field took
// focus. See writeCount.
let writeCounted = new Set();

// Which fields are checkable, and which are refused outright.
//
// `el.type` is the entire input rule: the property reflects to 'text' when the
// attribute is absent or unrecognised, and password, email, url, tel, number
// and search each report their own type and fall straight out. That one
// comparison is a privacy guard — those are exactly the fields whose contents
// must never leave the machine.
function writeKind(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
  if (el.tagName === 'TEXTAREA') return 'plain';
  if (el.tagName === 'INPUT') return el.type === 'text' ? 'plain' : null;
  return el.isContentEditable ? 'rich' : null;
}

function writeAttach(el) {
  if (el === writeEl) return;
  writeDetach();
  if (!writeAllowed()) return;
  const kind = writeKind(el);
  if (!kind) return;
  if (el.closest(WRITE_NO_AUTO)) return;

  writeEl = el;
  writeMode = kind;
  el.addEventListener('input', writeOnInput);
  el.addEventListener('click', writeOnClick);
  el.addEventListener('scroll', writeSync);
  // Capture on window scroll, because the field's own scrolling ancestor is
  // whatever the page decided and its scroll event does not reach window on
  // the bubble path.
  window.addEventListener('scroll', writeReposition, true);
  window.addEventListener('resize', writeReposition);
}

function writeDetach() {
  if (!writeEl) return;
  clearTimeout(writeTimer);
  writeEl.removeEventListener('input', writeOnInput);
  writeEl.removeEventListener('click', writeOnClick);
  writeEl.removeEventListener('scroll', writeSync);
  window.removeEventListener('scroll', writeReposition, true);
  window.removeEventListener('resize', writeReposition);
  writeClosePop();
  writeClear();
  writeEl = null;
  writeMode = null;
  writeIndex = null;
  writeMatches = [];
  // Reset, or refocusing the same field and typing the same text would be
  // skipped as unchanged and never paint its underlines again.
  writeLast = '';
  writeCounted = new Set();
}

// Capture, so a page that stops focusin on the way up cannot hide its fields
// from the checker. isTrusted for the reason content-script.js gives: a page
// can dispatch its own focusin and would otherwise choose which element this
// starts reading.
document.addEventListener('focusin', (event) => {
  if (!event.isTrusted) return;
  writeAttach(event.target);
}, true);

document.addEventListener('focusout', (event) => {
  if (event.target === writeEl) writeDetach();
}, true);

// document_idle can land after the page has already focused a field itself —
// a search page, a reply box, anything with autofocus.
writeAttach(document.activeElement);


/* ---------- the check cycle ---------- */


function writeOnInput() {
  // Underlines are drawn against the text the response was computed from. One
  // keystroke moves every offset after the caret, so they are wrong the moment
  // anything is typed. Clearing is cheaper and more honest than trying to
  // shift them; the debounce repaints in a moment.
  writeClosePop();
  writeClear();
  writeMatches = [];
  clearTimeout(writeTimer);
  writeTimer = setTimeout(writeCheck, WRITE_DEBOUNCE);
}

async function writeCheck() {
  if (!writeEl || !writeAllowed()) return;
  const el = writeEl;
  const { text } = writeIndexOf(el, writeMode);
  if (text.length < WRITE_MIN_CHARS) return;
  if (text === writeLast) return;
  writeLast = text;

  let reply;
  try {
    reply = await chrome.runtime.sendMessage({ type: 'grammar', text });
  } catch (err) {
    console.error('[vocab-track] grammar check went nowhere', err);
    return;
  }

  if (reply?.throttled) {
    // Not an error and not logged: the rate limiter saying no is it working.
    // writeLast is cleared so the next debounce is not skipped as a repeat of
    // text that was never actually checked.
    writeLast = '';
    return;
  }
  if (reply?.error) {
    // The previous underlines are deliberately left alone. A dropped network
    // request does not make the errors already on screen untrue.
    console.error('[vocab-track] grammar check failed', reply.error);
    return;
  }

  // The reply is a list of offsets into `text`. If the field moved on while it
  // was in flight the offsets address nothing, and the index is rebuilt rather
  // than reused because a framework can re-render the same text into new
  // nodes, which would leave every recorded node detached.
  if (el !== writeEl) return;
  const index = writeIndexOf(el, writeMode);
  if (index.text !== text) return;

  writeIndex = index;
  writeMatches = (reply?.matches ?? []).slice().sort((a, b) => a.offset - b.offset);
  writeRender();
  writeCount(writeMatches, text);
}


/* ---------- plain text, and the way back to the DOM ---------- */


// Elements that put a line break in the rendered text. <br> is in the list and
// carries no text node of its own, which is why this walk looks at elements
// and not only at text.
const WRITE_BLOCKS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DIV', 'DL', 'DT',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HR', 'LI', 'MAIN', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TD',
  'TH', 'TR', 'UL'
]);

// { text, nodes } — the field as one plain string, plus where each text node
// starts in it. Everything downstream is built on this: the request body, both
// renderers, the click hit-test and the replacement. It is a per-check
// snapshot and deliberately not cached, because it is only valid for exactly
// the text it was built from.
//
// For a contenteditable the string is built by the same walk that maps back.
// innerText cannot be used: it collapses runs of whitespace and drops hidden
// nodes, so an innerText offset does not address any character in any node and
// there is no way home from it. Plain textContent has the opposite fault — it
// runs the end of one paragraph into the start of the next, and LanguageTool
// then reports a spelling error on a word that does not exist. Walking and
// emitting a newline at each block boundary gives a string that is both
// mappable and shaped like sentences.
function writeIndexOf(el, kind) {
  if (kind !== 'rich') return { text: el.value ?? '', nodes: null };

  const nodes = [];
  let text = '';
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      // Collapsed, so nested block markup (<div><p>) cannot emit two newlines
      // where the reader sees one break.
      if (WRITE_BLOCKS.has(node.tagName) && text && !text.endsWith('\n')) text += '\n';
      continue;
    }
    nodes.push({ node: node, start: text.length });
    text += node.nodeValue;
  }
  return { text, nodes };
}

// The Range covering [offset, offset + length) of the index's text. Null when
// the span lies entirely in the synthetic newlines between blocks, which
// belong to no node.
function writeRangeFor(index, offset, length) {
  if (!index?.nodes) return null;
  const end = offset + length;
  let range = null;
  for (const entry of index.nodes) {
    const stop = entry.start + entry.node.nodeValue.length;
    if (stop <= offset) continue;
    if (entry.start >= end) break;
    if (!range) {
      range = document.createRange();
      range.setStart(entry.node, offset - entry.start);
    }
    range.setEnd(entry.node, Math.min(entry.node.nodeValue.length, end - entry.start));
  }
  return range;
}

// The plain-text offset of a DOM position, which is the inverse of the walk
// above. -1 for a position in a node the walk never recorded.
function writeOffsetOf(index, node, offset) {
  if (!index?.nodes) return -1;
  for (const entry of index.nodes) {
    if (entry.node === node) return entry.start + offset;
  }
  return -1;
}

// Where the caret is, in plain-text offsets.
function writeCaretOffset(el, kind, event) {
  if (kind !== 'rich') return el.selectionStart ?? -1;
  // caretRangeFromPoint, not caretPositionFromPoint: the latter needs Chrome
  // 128 and the manifest floor is 116. content-script.js relies on the same.
  const range = document.caretRangeFromPoint(event.clientX, event.clientY);
  if (range?.startContainer?.nodeType !== Node.TEXT_NODE) return -1;
  return writeOffsetOf(writeIndex, range.startContainer, range.startOffset);
}


/* ---------- drawing the underlines ---------- */


let writeSheetAdopted = false;
let writeMirrorEl = null;

function writeStyle() {
  // Adopt once. Pushing the same rules onto adoptedStyleSheets on every check
  // would grow the array all afternoon.
  if (writeSheetAdopted) return;
  writeSheetAdopted = true;
  const sheet = new CSSStyleSheet();
  // skip-ink off because a wavy underline that breaks around every descender
  // stops reading as one continuous mark under one word.
  sheet.replaceSync(`
    ::highlight(${WRITE_HIGHLIGHT}) {
      text-decoration: underline wavy ${WRITE_RED};
      text-decoration-skip-ink: none;
    }
  `);
  // adoptedStyleSheets, not a <style> element, so the page's DOM is untouched
  // and a strict style-src CSP cannot drop it.
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

function writeClear() {
  CSS.highlights.delete(WRITE_HIGHLIGHT);
  writeMirrorEl?.remove();
  writeMirrorEl = null;
}

function writeRender() {
  writeClear();
  if (!writeMatches.length) return;
  if (writeMode === 'rich') writeHighlights(); else writeMirror();
}

// A contenteditable has real text nodes, so the Custom Highlight API can paint
// straight over them and nothing is added to the page's DOM at all.
function writeHighlights() {
  const ranges = writeMatches
    .map((match) => writeRangeFor(writeIndex, match.offset, match.length))
    .filter(Boolean);
  if (!ranges.length) return;
  writeStyle();
  CSS.highlights.set(WRITE_HIGHLIGHT, new Highlight(...ranges));
}

// The properties that decide where each character lands. Anything missed here
// shifts the mirror's text away from the field's and puts every underline
// under the wrong word. line-height comes after font on purpose: the `font`
// shorthand carries one, and the longhand has to win.
const WRITE_MIRROR_COPY = [
  'font', 'letter-spacing', 'word-spacing', 'text-transform', 'text-indent',
  'line-height', 'padding', 'border-width', 'direction', 'text-align'
];
const WRITE_MIRROR_FONT = ['font-style', 'font-variant', 'font-weight', 'font-size', 'font-family'];

const WRITE_UNDERLINE = [
  'text-decoration:underline wavy ' + WRITE_RED + '!important',
  'text-decoration-skip-ink:none!important',
  'color:transparent!important'
].join(';');

// A textarea holds no nodes — its text is painted by the widget itself — so
// there is no Range for CSS.highlights to reach and no way to mark a word
// inside it. The only thing that works is to render the same text, in the same
// font, at the same size and scroll position, directly on top, invisible
// except for the underlines.
function writeMirror() {
  const el = writeEl;
  const rect = el.getBoundingClientRect();
  const computed = getComputedStyle(el);

  const decls = [
    // 'all' first, for the reason content-script.js documents: it is a
    // shorthand for every property and would revert what follows it. Then
    // !important throughout, for reader.js's reason: an inline style without
    // it loses to a page's `div{...!important}` rule, and a mirror that has
    // lost its font is worse than no mirror.
    'all:initial!important',
    'display:block!important',
    'position:fixed!important',
    `top:${rect.top}px!important`,
    `left:${rect.left}px!important`,
    `width:${rect.width}px!important`,
    `height:${rect.height}px!important`,
    // Forced, never copied from the field. getBoundingClientRect() measures the
    // BORDER box, so the width above is only the right number under
    // border-box; on a content-box field, copying its box-sizing lays the
    // mirror's text out in a box wider than the field by its padding and
    // border. Measured on a 300px content-box textarea with 11px padding and a
    // 3px border: the mirror's content box came out 328px against the field's
    // 300px, so the same sentence wrapped a word later and every underline
    // below the first line sat under the wrong word.
    'box-sizing:border-box!important',
    'overflow:hidden!important',
    'color:transparent!important',
    'background:transparent!important',
    // Never in the hit-testing tree. The click that opens the popover has to
    // reach the real field, or the caret would not move and the page's own
    // editor would never see it.
    'pointer-events:none!important',
    `z-index:${WRITE_TOP - 1}!important`,
    // The border is copied for its WIDTH alone, because that width is what
    // insets the first character from the field's edge. A copied border-width
    // with the initial border-style:none occupies nothing, so the style has to
    // be forced on and the colour made invisible instead.
    'border-style:solid!important',
    'border-color:transparent!important',
    // An <input> is a single line that never wraps and scrolls sideways
    // instead; pre-wrap there would fold its text onto a second line that the
    // field does not have.
    el.tagName === 'INPUT'
      ? 'white-space:pre!important'
      : 'white-space:pre-wrap!important',
    'overflow-wrap:break-word!important'
  ];

  for (const prop of WRITE_MIRROR_COPY) {
    const value = computed.getPropertyValue(prop);
    // getComputedStyle().font serialises to the empty string whenever the
    // longhands cannot be expressed as the shorthand, which is most real
    // pages. Falling back to the longhands is what stops the mirror rendering
    // in the page default face with every offset wrong.
    if (prop === 'font' && !value) {
      for (const part of WRITE_MIRROR_FONT) decls.push(`${part}:${computed.getPropertyValue(part)}!important`);
      continue;
    }
    if (value) decls.push(`${prop}:${value}!important`);
  }

  writeMirrorEl = document.createElement('div');
  writeMirrorEl.style.cssText = decls.join(';');
  writeMirrorFill(writeMirrorEl, el.value, writeMatches);
  document.body.appendChild(writeMirrorEl);
  writeSync();
}

// The field's text with each match wrapped, built out of nodes.
//
// textContent and append(string), never innerHTML. This is the user's own
// typing: an "<img onerror=alert(1)>" in a draft email must stay twenty-four
// characters of text and must not become an element in the page. Building
// nodes is the guard — there is no escaping step to forget.
function writeMirrorFill(mirror, text, matches) {
  const frag = document.createDocumentFragment();
  let at = 0;
  for (const match of matches) {
    // Overlapping matches: the earlier one wins, because two spans over the
    // same characters would duplicate the text and shift everything after it.
    if (match.offset < at) continue;
    frag.append(text.slice(at, match.offset));
    const span = document.createElement('span');
    span.textContent = text.slice(match.offset, match.offset + match.length);
    span.style.cssText = WRITE_UNDERLINE;
    frag.append(span);
    at = match.offset + match.length;
  }
  frag.append(text.slice(at));
  mirror.replaceChildren(frag);
}

function writeSync() {
  if (!writeMirrorEl || !writeEl) return;
  writeMirrorEl.scrollTop = writeEl.scrollTop;
  writeMirrorEl.scrollLeft = writeEl.scrollLeft;
}

// ponytail: the mirror follows the field on scroll and resize and on nothing
// else. A textarea dragged by its resize grip, or one the page re-lays-out
// without either event firing, leaves the underlines behind until the next
// check. Upgrade path is a ResizeObserver on the field plus an IntersectionObserver
// for the move; both postdate nothing in the manifest floor, they are simply
// more machinery than a misplaced underline for a second is worth.
function writeReposition() {
  if (!writeEl) return;
  if (writeMirrorEl) {
    const rect = writeEl.getBoundingClientRect();
    const set = (prop, value) => writeMirrorEl.style.setProperty(prop, value, 'important');
    set('top', `${rect.top}px`);
    set('left', `${rect.left}px`);
    set('width', `${rect.width}px`);
    set('height', `${rect.height}px`);
    writeSync();
  }
  writePopMove();
}


/* ---------- clicking an error ---------- */


let writePopEl = null;
let writePopMatch = null;

// One hit test for both kinds of field, via the caret.
//
// The mirror is pointer-events:none and the Custom Highlight API paints
// outside the hit-testing tree, so neither renderer can be clicked on. What
// both kinds DO report is where the caret ended up, and the caret is already
// in plain-text offsets — the same coordinates the matches are in. That is
// why the whole design is built on one offset index: it collapses two
// renderers into one click handler.
function writeOnClick(event) {
  if (!event.isTrusted || !writeIndex || !writeMatches.length) return;
  const at = writeCaretOffset(writeEl, writeMode, event);
  if (at < 0) return;
  const hit = writeMatches.find((match) => at >= match.offset && at < match.offset + match.length);
  if (!hit) {
    writeClosePop();
    return;
  }
  writeOpenPop(hit);
}


/* ---------- the popover ---------- */


// 'all' first and !important on every declaration, for the reasons reader.js
// sets out. Not a <dialog>: this is not modal, the field behind it stays
// live and typing through it must keep working.
//
// ponytail: a page that puts its own element in a higher stacking context —
// a top-layer dialog of its own, say — can cover this, and there is no
// z-index above 2147483647 to answer with. The top layer would, at the cost
// of the dialog's modality. Not worth it until a real site does it.
const WRITE_POP_CSS = [
  'all:initial!important',
  'display:block!important',
  'direction:ltr!important',
  'position:fixed!important',
  `z-index:${WRITE_TOP}!important`,
  'box-sizing:border-box!important',
  'max-width:320px!important',
  'padding:8px 10px!important',
  'background:#fff!important',
  'color:#1c1a17!important',
  'font:13px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif!important',
  'border:1px solid #c9c2b2!important',
  'border-radius:6px!important',
  'box-shadow:0 2px 10px rgba(0,0,0,.28)!important'
].join(';');

const WRITE_POP_BUTTON = [
  'all:initial!important',
  'display:inline-block!important',
  'font:13px/1.2 ui-sans-serif,system-ui,-apple-system,sans-serif!important',
  'margin:6px 6px 0 0!important',
  'padding:4px 8px!important',
  'background:#f3efe6!important',
  'color:#1c1a17!important',
  'border:1px solid #c9c2b2!important',
  'border-radius:4px!important',
  'cursor:pointer!important'
].join(';');

function writeClosePop() {
  writePopEl?.remove();
  writePopEl = null;
  writePopMatch = null;
}

function writePopButton(label, onClick) {
  const button = document.createElement('button');
  button.textContent = label;
  button.style.cssText = WRITE_POP_BUTTON;
  button.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    onClick();
  });
  return button;
}

function writeOpenPop(match) {
  writeClosePop();
  const pop = document.createElement('div');
  pop.style.cssText = WRITE_POP_CSS;
  // Load-bearing twice over, and it must be mousedown rather than click.
  // Focus leaves the field on mousedown, which runs focusout, which runs
  // writeDetach, which removes this popover — before the button's click event
  // ever fires. Blocking the default also leaves the caret in the field, and
  // the caret is what execCommand('insertText') writes into.
  pop.addEventListener('mousedown', (event) => event.preventDefault());

  const message = document.createElement('div');
  message.textContent = match.message;
  message.style.cssText = 'all:initial!important;display:block!important;'
    + 'font:13px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif!important;color:#1c1a17!important';
  pop.append(message);

  for (const value of (match.replacements ?? []).slice(0, WRITE_MAX_REPLACEMENTS)) {
    pop.append(writePopButton(value, () => writeApply(match, value)));
  }
  pop.append(writePopButton('Dismiss', writeClosePop));

  document.body.appendChild(pop);
  writePopEl = pop;
  writePopMatch = match;
  writePopMove();
}

function writePopMove() {
  if (!writePopEl || !writeEl) return;
  // A contenteditable can say exactly where the error is, because the Range
  // over its text nodes has a rect.
  //
  // ponytail: a textarea cannot, so the popover anchors to the whole field.
  // Per-character geometry inside a textarea means measuring a Range in the
  // mirror, which means the mirror has to exist and be in sync before the
  // popover can be placed. For a one-line field the anchor is already right;
  // for a paragraph it is a few lines low. Upgrade path is exactly that Range
  // over the mirror's own text nodes.
  const range = writeMode === 'rich' && writePopMatch
    ? writeRangeFor(writeIndex, writePopMatch.offset, writePopMatch.length)
    : null;
  const rect = (range ?? writeEl).getBoundingClientRect();
  const set = (prop, value) => writePopEl.style.setProperty(prop, value, 'important');
  set('top', `${rect.bottom + 6}px`);
  set('left', `${Math.max(4, Math.min(rect.left, window.innerWidth - 328))}px`);
}


/* ---------- applying a replacement ---------- */


function writeApply(match, value) {
  const el = writeEl;
  if (!el) return;

  if (writeMode === 'rich') {
    const range = writeRangeFor(writeIndex, match.offset, match.length);
    if (!range) return;
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    el.setSelectionRange(match.offset, match.offset + match.length);
  }

  // execCommand is deprecated and is still the only thing that does this job.
  // It replaces the selection through the browser's own editing pipeline, so
  // two things happen that nothing else gives: the page's framework sees the
  // real input event it listens for (React and Draft.js both keep their own
  // copy of the value and would overwrite the edit on their next render), and
  // the change lands on the native undo stack, so the user's Cmd-Z takes it
  // back. setRangeText and a plain `el.value = ...` do neither — they fire
  // nothing and they wipe the undo history. This is not the line to modernise.
  document.execCommand('insertText', false, value);

  writeClosePop();
  writeClear();
  writeMatches = [];
  // Every offset after this one has just moved by the length difference, and
  // the ones before it may have too if the page's own editor reformatted.
  // execCommand fires input, so the debounce is already scheduled; clearing
  // writeLast is what stops that recheck being skipped as a repeat.
  writeLast = '';
}


/* ---------- the recurring-mistakes counter ---------- */


// ponytail: read-modify-write, so two tabs finishing a check in the same
// millisecond cost one lost count. Single user, and the number is a "you do
// this a lot" signal rather than a ledger — a transaction is not worth it.
//
// Counted once per distinct mistake per field, which is what makes the number
// mean anything. The naive version — one increment per match per response —
// counts the same uncorrected error again on every 1.2s debounce, so a single
// their/they're slip in an email you spent two minutes on reports as a dozen.
// Measured: three checks over one unchanged sentence recorded n=3 for one
// mistake. The key is the rule plus the exact text it fired on, so the same
// rule firing on a different word still counts, and the set is dropped when
// the field loses focus.
//
// ponytail: within one focus, two genuinely separate instances of the same
// slip on the same word count once. That undercount is the right side to err
// on for a list whose question is "which mistakes do I repeat", not "how many
// did I make".
async function writeCount(matches, text) {
  const fresh = matches.filter((match) => {
    const key = match.ruleId + '\u0000' + String(text ?? '').slice(match.offset, match.offset + match.length);
    if (writeCounted.has(key)) return false;
    writeCounted.add(key);
    return true;
  });
  if (!fresh.length) return;
  try {
    const stored = await chrome.storage.local.get('writeMistakes');
    const mistakes = stored.writeMistakes ?? {};
    for (const match of fresh) {
      const seen = mistakes[match.ruleId];
      mistakes[match.ruleId] = {
        n: (seen?.n ?? 0) + 1,
        msg: match.message,
        cat: match.cat
      };
    }
    // Bounded, because LanguageTool has thousands of rule ids and this object
    // is rewritten whole on every check. The lowest counts go: a rule seen
    // once is noise, and the point of the list is the handful of mistakes the
    // user actually repeats.
    const ids = Object.keys(mistakes);
    if (ids.length > WRITE_MAX_RULES) {
      ids.sort((a, b) => mistakes[b].n - mistakes[a].n);
      for (const id of ids.slice(WRITE_MAX_RULES)) delete mistakes[id];
    }
    await chrome.storage.local.set({ writeMistakes: mistakes });
  } catch (err) {
    console.error('[vocab-track] could not record mistakes', err);
  }
}
