let button = null;

// Reloading or updating the extension cuts every content script already on an
// open page off from it: chrome.runtime.id goes undefined and sendMessage
// throws "Extension context invalidated". Nothing here can reconnect — only a
// page reload injects a fresh copy — so say that on the page instead of
// throwing into the console and leaving the click doing nothing.
function sendLookup(message) {
  if (!chrome.runtime?.id) {
    staleNotice();
    return;
  }
  chrome.runtime.sendMessage(message);
}

function staleNotice() {
  const note = document.createElement('div');
  note.setAttribute('role', 'status');
  note.textContent = 'Vocab-track was updated — reload this page to look words up again.';
  note.style.cssText = [
    'all:revert', 'position:fixed', 'bottom:16px', 'left:50%', 'transform:translateX(-50%)',
    'z-index:2147483647', 'font:13px/1.4 system-ui,sans-serif', 'padding:8px 12px',
    'background:#1c1a17', 'color:#faf7f2', 'border-radius:8px', 'box-shadow:0 1px 4px rgba(0,0,0,.3)'
  ].join(';');
  document.body.appendChild(note);
  setTimeout(() => note.remove(), STALE_NOTICE_MS);
}
const STALE_NOTICE_MS = 5000;

function removeButton() {
  button?.remove();
  button = null;
}

function showButton(word, rect, context) {
  removeButton();
  button = document.createElement('button');
  button.textContent = '📘';
  button.title = `Look up "${word}"`;
  // Inline styles with a maximum z-index: the button must survive whatever
  // CSS the host page applies. It is removed on the next click, so it never
  // lingers over the page.
  // 'all:revert' MUST come first: 'all' is a shorthand for every CSS
  // property, so if it appeared after position/top/left/z-index it would
  // revert those declarations right back out at equal specificity, leaving
  // the button static and off-screen.
  button.style.cssText = [
    'all:revert',
    'position:absolute',
    `top:${window.scrollY + rect.bottom + 4}px`,
    `left:${window.scrollX + rect.left}px`,
    'z-index:2147483647',
    'font:14px/1 system-ui,sans-serif',
    'padding:4px 6px',
    'background:#fff',
    'border:1px solid #888',
    'border-radius:4px',
    'cursor:pointer',
    'box-shadow:0 1px 4px rgba(0,0,0,.3)'
  ].join(';');

  button.addEventListener('mousedown', (event) => {
    // Reject synthetic events: a hostile page could otherwise dispatch its
    // own mousedown and write an attacker-chosen word into `pending`.
    if (!event.isTrusted) return;
    // Stop the page seeing this and clearing the selection first.
    event.preventDefault();
    event.stopPropagation();
    sendLookup({ type: 'lookup', word, url: location.href, context });
    // Clear the selection so the following mouseup finds no candidate and does not
    // re-show the button. preventDefault() above blocks the browser's default
    // selection-collapse, so it is still live and must be cleared explicitly.
    window.getSelection()?.removeAllRanges();
    removeButton();
  });

  document.body.appendChild(button);
}

// The sentence on the page that the word appeared in. Prefers the nearest
// small block: falling straight back to a div or article would hand
// sentenceAround the whole page and make the split meaningless.
const CONTEXT_BLOCKS = 'p, li, td, th, blockquote, dd, dt, figcaption, h1, h2, h3, h4, h5, h6';

function contextFor(range, word) {
  const node = range.startContainer;
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  const block = el?.closest(CONTEXT_BLOCKS) ?? el;
  try {
    return VT.sentenceAround(block?.textContent, word);
  } catch (err) {
    console.error('[vocab-track] could not read context for', word, err);
    return null;
  }
}

document.addEventListener('mouseup', (event) => {
  // Reject synthetic events: same reasoning as the button's mousedown guard.
  if (!event.isTrusted) return;
  if (button?.contains(event.target)) return;
  const selection = window.getSelection();
  const raw = selection?.toString() ?? '';

  if (!VT.isLookupCandidate(raw)) {
    removeButton();
    return;
  }

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  const word = VT.normaliseWord(raw);
  // Captured now, not on click: the click handler clears the selection so the
  // button does not re-show, which would take the context with it.
  showButton(word, rect, contextFor(range, word));
});

document.addEventListener('mousedown', (event) => {
  if (!button?.contains(event.target)) removeButton();
});

const HIGHLIGHT_NAME = 'vocab-track';
// Declared beside its sibling, not next to scrollToWord: highlightStyle()
// references it, and only the async call chain currently keeps that out of
// the temporal dead zone.
const FOCUS_NAME = 'vocab-track-focus';

let styleAdopted = false;

function highlightStyle() {
  // Adopted once: scrollToWord calls this too, and pushing the same rules onto
  // adoptedStyleSheets repeatedly would grow the array on every click.
  if (styleAdopted) return;
  styleAdopted = true;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    ::highlight(${HIGHLIGHT_NAME}) {
      background: rgba(255, 214, 0, .45);
      text-decoration: underline dotted currentColor;
    }
    ::highlight(${FOCUS_NAME}) {
      background: rgba(255, 145, 0, .85);
      color: #1c1a17;
    }
  `);
  // adoptedStyleSheets rather than a <style> element, so the page's DOM is
  // never modified.
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

// Takes entries, not strings: each word is matched by the rules of its own
// language, so `lang` has to travel with it. A bare { word } is fine — VT.find
// falls back to detecting the script.
function rangesFor(entries) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      // closest(), not parentElement.tagName: a highlighted code block nests
      // spans inside <pre><code>, so the immediate parent is not the CODE.
      if (!parent || parent.closest('script, style, code, pre, textarea') ||
          parent.isContentEditable) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const ranges = [];
  let node;
  while ((node = walker.nextNode())) {
    for (const entry of entries) {
      // Each word is matched by the rules of its own language, so an English
      // and a Korean word saved from the same page both light up.
      for (const hit of VT.find(entry.word, node.nodeValue, entry.lang)) {
        const range = document.createRange();
        range.setStart(node, hit.index);
        range.setEnd(node, hit.index + hit.length);
        ranges.push(range);
      }
    }
  }
  return ranges;
}

async function applyHighlights() {
  const { words } = await chrome.storage.local.get('words');
  if (!words) return;

  // Per-page, not per-URL: a word saved from a video carries the moment it was
  // said, so no two sources for one video are string-equal.
  const key = VT.pageKey(location.href);
  const here = Object.values(words)
    .filter((entry) => entry.sources?.some((source) => VT.pageKey(source) === key));
  if (!here.length) return;

  const ranges = rangesFor(here);
  if (!ranges.length) return;

  highlightStyle();
  // ponytail: highlights are painted once, at document_idle. Content added
  // later by infinite scroll is not covered. Upgrade path is a debounced
  // MutationObserver calling applyHighlights again.
  CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
}

applyHighlights();


/* ---------- click a highlighted word to be quizzed on it ---------- */


// The highlight is the affordance: a word painted yellow is one you saved, and
// clicking it should ask whether you still remember it. The panel decides what
// to show; this only has to say which word was hit.
//
// Hit-tests the ranges already painted rather than re-deriving which words are
// saved. rangesFor()'s acceptNode already keeps code blocks, textareas and
// editable fields out, and a second, independent membership test would fire —
// and preventDefault() — in exactly those places.
document.addEventListener('click', (event) => {
  // isTrusted for the same reason the lookup button checks it. No button
  // check: `click` never fires for the right or middle button.
  if (!event.isTrusted) return;
  const range = document.caretRangeFromPoint(event.clientX, event.clientY);
  const node = range?.startContainer;
  if (node?.nodeType !== Node.TEXT_NODE) return;
  // A real click on text targets the text node's own parent. Anything else is
  // a ghost click bubbling up from a detached element — the 📘 button removes
  // itself on mousedown, and it sits over the line below the selection, so
  // without this it could quiz the wrong word.
  if (event.target !== node.parentElement) return;
  // A drag that selected text is not a click on a word: the selection flow
  // above owns that, and it ends with the 📘 button.
  if (!window.getSelection()?.isCollapsed) return;

  // A Highlight is setlike, so its ranges iterate directly, and toString() on
  // one is the matched text.
  for (const hit of CSS.highlights.get(HIGHLIGHT_NAME) ?? []) {
    if (!hit.isPointInRange(node, range.startOffset)) continue;
    // Capture phase and both of these, so a saved word inside a link opens the
    // panel instead of navigating away.
    event.preventDefault();
    event.stopPropagation();
    sendLookup({
      type: 'lookup',
      // The word is already saved, so resolveWord answers from storage with no
      // network call, and context is left null: it is never overwritten on a
      // known word and this click is a quiz, not a save.
      mode: 'quiz',
      word: VT.normaliseWord(hit.toString()),
      url: location.href,
      context: null
    });
    return;
  }
}, true);


/* ---------- answering the side panel ---------- */


// rangesFor() already knows how to locate a word in the page, so scrolling to
// one is just taking the first range it finds.
function scrollToWord(word, lang) {
  const ranges = rangesFor([{ word, lang }]);
  if (!ranges.length) return false;

  const first = ranges[0];
  // A Range has no scrollIntoView; its client rect does, via a throwaway anchor
  // that is removed immediately so the page's DOM is not left modified.
  const rect = first.getBoundingClientRect();
  window.scrollTo({
    top: window.scrollY + rect.top - window.innerHeight / 3,
    behavior: 'smooth'
  });

  highlightStyle();
  CSS.highlights.set(FOCUS_NAME, new Highlight(first));
  // Cleared rather than left on: the focus colour means "this is the one you
  // just clicked", which stops being true the moment you click another.
  clearTimeout(scrollToWord.timer);
  scrollToWord.timer = setTimeout(() => CSS.highlights.delete(FOCUS_NAME), 2600);
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'page-info') {
    sendResponse({ url: location.href, title: document.title });
    return;
  }
  if (message?.type === 'scroll-to') {
    // In a video the word's position is a moment, not a place on the page.
    sendResponse({
      found: typeof message.t === 'number' ? seekTo(message.t) : scrollToWord(message.word, message.lang)
    });
    return;
  }
});


/* ---------- YouTube: click a word in the live captions ---------- */


// Captions are unselectable, so the selection-then-button flow above cannot
// reach them: .caption-window carries user-select:none. It does carry
// pointer-events:auto though (it is draggable), so the click itself arrives.
// Verified against www-player.css 2026-09-13.
const CAPTION = '.ytp-caption-segment';
const CAPTION_WINDOW = '.caption-window';

function captionHit(event) {
  // caretRangeFromPoint, not caretPositionFromPoint: the latter needs Chrome
  // 128 and the manifest floor is 116. Neither is affected by user-select, so
  // the unselectable caption text still resolves to a text node and an offset.
  const range = document.caretRangeFromPoint(event.clientX, event.clientY);
  const node = range?.startContainer;
  if (node?.nodeType !== Node.TEXT_NODE) return null;
  const segment = node.parentElement?.closest(CAPTION);
  if (!segment) return null;

  const raw = VT.wordAt(node.nodeValue, range.startOffset);
  if (!raw || !VT.isLookupCandidate(raw)) return null;
  return {
    word: VT.normaliseWord(raw),
    video: videoFor(segment),
    // The whole caption window, not the segment: a sentence is regularly split
    // across two segments on screen.
    caption: segment.closest(CAPTION_WINDOW)?.textContent ?? segment.textContent
  };
}

function captionClick(event) {
  // isTrusted for the same reason the button checks it; left button only, so a
  // right-click can still reach YouTube's own menu.
  if (!event.isTrusted || event.button !== 0) return;
  const hit = captionHit(event);
  if (!hit) return;

  // Pause before anything else. The caption is gone in a second or two
  // otherwise, and the panel would open over a word that is no longer on
  // screen — the whole reason this is a click and not a selection.
  const video = hit.video;
  video?.pause();
  // Stops the player starting a caption drag on this same mousedown.
  event.preventDefault();
  event.stopPropagation();

  const id = VT.youtubeId(location.href);
  const seconds = Math.floor(video?.currentTime ?? 0);
  sendLookup({
    type: 'lookup',
    word: hit.word,
    // The timestamp IS the position, the way a text fragment is on a page.
    // Rebuilt from the id rather than patched onto location.href, which drags
    // along list, index and pp.
    url: id ? `https://www.youtube.com/watch?v=${id}&t=${seconds}s` : location.href,
    context: VT.sentenceAround(hit.caption, hit.word)
  });
}

// The player a caption belongs to. A watch page holds more than one <video>:
// every hover preview in the sidebar is one, and #inline-preview-player runs
// its own captions. The bare document.querySelector is only a last resort.
function videoFor(segment) {
  return segment?.closest('.html5-video-player')?.querySelector('video')
      ?? document.querySelector('#movie_player video')
      ?? document.querySelector('video');
}

function seekTo(seconds) {
  const video = videoFor(null);
  if (!video) return false;
  video.currentTime = seconds;
  // Play state is deliberately left alone: jumping back to a word should not
  // start a video the user had paused.
  return true;
}

if (/(^|\.)youtube\.com$/.test(location.hostname)) {
  // Capture phase: the player's own handlers sit on the caption window and
  // would otherwise see this mousedown first.
  document.addEventListener('mousedown', captionClick, true);
  const sheet = new CSSStyleSheet();
  // The caption window advertises `cursor: grab` because it is draggable.
  // Over the words themselves that is now a lie.
  sheet.replaceSync(`${CAPTION} { cursor: pointer }`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}
