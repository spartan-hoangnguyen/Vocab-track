// Push saved words to Anki, through the AnkiConnect add-on's local API at
// http://127.0.0.1:8765. Network lives here; loaded by the dashboard, where the
// push button is, and by the test page for the pure note builder.
//
// AnkiConnect checks the request's Origin against its webCorsOriginList, so the
// user adds this extension's origin — chrome-extension://<id> — to that list
// once. The dashboard shows the exact origin, read from chrome.runtime.id.
//
// What is pushed: the word, its meaning, definition, example, level and GIF, as
// a recognition card (word on the front). What is NOT pushed: the review
// schedule — Anki runs its own algorithm, so FSRS state is meaningless there —
// and the source URLs, which are not card content.

const ANKI_URL = 'http://127.0.0.1:8765';

// AnkiConnect's envelope: { action, version: 6, params } -> { result, error }.
// A non-null `error` is the add-on reporting a problem (a bad deck, a disallowed
// origin). A thrown fetch is Anki not running at all. The two want different
// sentences, so this throws the add-on's own message and the caller tells them
// apart by the text.
async function ankiInvoke(action, params = {}) {
  const res = await fetch(ANKI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, version: 6, params }),
    // Short: a localhost call either answers at once or is refused at once, so a
    // long timeout would only delay the "Anki is not running" message.
    signal: AbortSignal.timeout(5000)
  });
  if (!res.ok) throw new Error(`AnkiConnect HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

// & < > " ' escaped, so a definition or gloss from a third party cannot smuggle
// markup into an Anki field. Anki renders a field as HTML, in a desktop app with
// scripting on, so an unescaped `<img onerror=…>` from the translator would run.
function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// A folder name as an Anki tag: no spaces, because a space separates tags.
function ankiTag(name) {
  return String(name ?? '').trim().replace(/\s+/g, '_');
}

// One AnkiConnect note for a word: a recognition card, the word on the front and
// everything else on the back. Pure, so test.js drives it.
//
// The Front is the BARE word and nothing else. AnkiConnect's allowDuplicate
// compares the first field, so a stable front is what makes a re-push skip a
// word already there rather than add it twice. The IPA lives on the back for the
// same reason: it can arrive on a later lookup and must not change the front.
//
// Every text field is escaped. The one intentional markup is the GIF <img>, and
// only once VT.giphyOk has cleared its URL — the same gate the card uses, which
// also keeps an imported-export URL out of an <img src>.
function ankiNote(entry, deckName, folderNames = []) {
  const back = [];
  if (entry.ipa) back.push(`<div style="color:#888">/${escapeHtml(entry.ipa)}/</div>`);
  if (entry.vi) back.push(`<div style="font-size:1.3em"><b>${escapeHtml(entry.vi)}</b></div>`);
  if (entry.def) back.push(`<div>${escapeHtml(entry.def)}</div>`);
  const example = (entry.senses ?? []).find((sense) => sense.example)?.example || entry.context;
  if (example) back.push(`<div style="color:#666;font-style:italic">${escapeHtml(example)}</div>`);
  if (entry.level) back.push(`<div style="color:#888;font-size:.85em">${escapeHtml(entry.level)}</div>`);
  if (entry.gif && VT.giphyOk(entry.gif)) {
    back.push(`<div><img src="${escapeHtml(entry.gif)}" style="max-height:160px"></div>`);
  }
  return {
    deckName,
    modelName: 'Basic',
    fields: { Front: escapeHtml(entry.word), Back: back.join('\n') },
    tags: ['vocab-track', `lang::${LANG.of(entry).id}`,
      ...folderNames.map(ankiTag).filter(Boolean)],
    // Skip a word already in this deck rather than add a second copy, so a
    // re-push only fills in what is new.
    options: { allowDuplicate: false, duplicateScope: 'deck' }
  };
}
