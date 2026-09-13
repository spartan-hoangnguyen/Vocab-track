let button = null;

function removeButton() {
  button?.remove();
  button = null;
}

function showButton(word, rect) {
  removeButton();
  button = document.createElement('button');
  button.textContent = '📘';
  button.title = `Look up "${word}"`;
  // Inline styles with a maximum z-index: the button must survive whatever
  // CSS the host page applies. It is removed on the next click, so it never
  // lingers over the page.
  button.style.cssText = [
    'position:absolute',
    `top:${window.scrollY + rect.bottom + 4}px`,
    `left:${window.scrollX + rect.left}px`,
    'z-index:2147483647',
    'all:revert',
    'font:14px/1 system-ui,sans-serif',
    'padding:4px 6px',
    'background:#fff',
    'border:1px solid #888',
    'border-radius:4px',
    'cursor:pointer',
    'box-shadow:0 1px 4px rgba(0,0,0,.3)'
  ].join(';');

  button.addEventListener('mousedown', (event) => {
    // Stop the page seeing this and clearing the selection first.
    event.preventDefault();
    event.stopPropagation();
    chrome.runtime.sendMessage({ type: 'lookup', word, url: location.href });
    // Clear the selection so the following mouseup finds no candidate and does not
    // re-show the button. preventDefault() above blocks the browser's default
    // selection-collapse, so it is still live and must be cleared explicitly.
    window.getSelection()?.removeAllRanges();
    removeButton();
  });

  document.body.appendChild(button);
}

document.addEventListener('mouseup', (event) => {
  if (button?.contains(event.target)) return;
  const selection = window.getSelection();
  const raw = selection?.toString() ?? '';

  if (!VT.isLookupCandidate(raw)) {
    removeButton();
    return;
  }

  const rect = selection.getRangeAt(0).getBoundingClientRect();
  showButton(VT.normaliseWord(raw), rect);
});

document.addEventListener('mousedown', (event) => {
  if (!button?.contains(event.target)) removeButton();
});

const HIGHLIGHT_NAME = 'vocab-track';

function highlightStyle() {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`::highlight(${HIGHLIGHT_NAME}) {
    background: rgba(255, 214, 0, .45);
    text-decoration: underline dotted currentColor;
  }`);
  // adoptedStyleSheets rather than a <style> element, so the page's DOM is
  // never modified.
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

function rangesFor(words) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const tag = node.parentElement?.tagName;
      // Never highlight inside code, script or editable fields.
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'CODE' || tag === 'PRE' ||
          tag === 'TEXTAREA' || node.parentElement?.isContentEditable) {
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
