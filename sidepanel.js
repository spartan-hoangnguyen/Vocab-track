const $ = (id) => document.getElementById(id);

function showView(name) {
  $('view-lookup').hidden = name !== 'lookup';
  $('view-review').hidden = name !== 'review';
  $('tab-lookup').classList.toggle('active', name === 'lookup');
  $('tab-review').classList.toggle('active', name === 'review');
}

$('tab-lookup').addEventListener('click', () => showView('lookup'));
$('tab-review').addEventListener('click', () => showView('review'));

function showWord(pending) {
  if (!pending) return;
  showView('lookup');
  $('lookup-empty').hidden = true;
  $('entry').hidden = false;
  $('entry-word').textContent = pending.word;
}

// Both paths are required. get() covers the lookup that opened this panel,
// whose write landed before any listener existed. onChanged covers every
// later lookup while the panel stays open.
chrome.storage.session.get('pending', ({ pending }) => showWord(pending));
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.pending) showWord(changes.pending.newValue);
});
