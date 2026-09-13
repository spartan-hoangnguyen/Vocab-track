chrome.runtime.onInstalled.addListener(() => {
  // Clicking the toolbar icon opens the panel, which is the entry point to
  // flashcard review.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[vocab-track] setPanelBehavior failed', err));
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'lookup') return;

  // Open FIRST. sidePanel.open() consumes the user gesture forwarded with
  // this message, and the gesture does not survive an await. Do not reorder
  // these two calls and do not await the first one.
  chrome.sidePanel.open({ tabId: sender.tab.id })
    .catch((err) => console.error('[vocab-track] sidePanel.open failed for', message.word, err));

  // Handed over through storage rather than a message: the panel may not have
  // loaded a listener yet, and a storage write cannot be missed because the
  // panel also reads this key on load. ts makes a repeat lookup of the same
  // word a real change, so storage.onChanged still fires.
  chrome.storage.session.set({
    pending: { word: message.word, url: message.url,
               context: message.context ?? null, ts: Date.now() }
  });
});
