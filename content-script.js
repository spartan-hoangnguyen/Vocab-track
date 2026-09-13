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
