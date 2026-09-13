let button = null;

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
    chrome.runtime.sendMessage({ type: 'lookup', word, url: location.href, context });
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

function rangesFor(words) {
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

  const regexes = words.map((word) => VT.wordRegex(word));
  const ranges = [];
  let node;
  while ((node = walker.nextNode())) {
    for (const regex of regexes) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(node.nodeValue))) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        ranges.push(range);
      }
    }
  }
  return ranges;
}

async function applyHighlights() {
  const { words } = await chrome.storage.local.get('words');
  if (!words) return;

  // Per-URL: only words that were looked up on this exact page.
  const here = Object.values(words)
    .filter((entry) => entry.sources.includes(location.href))
    .map((entry) => entry.word);
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


/* ---------- answering the side panel ---------- */


// rangesFor() already knows how to locate a word in the page, so scrolling to
// one is just taking the first range it finds.
function scrollToWord(word) {
  const ranges = rangesFor([word]);
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
    sendResponse({ found: scrollToWord(message.word) });
    return;
  }
});
