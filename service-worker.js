// At top level, not in onInstalled: the setting persists per extension, so an
// install that already set it to true would keep opening the panel on click
// until it was reinstalled. Running on every worker wake is cheap and makes a
// plain reload enough.
//
// Explicitly false, because with it on Chrome swallows the action click to
// open the side panel and action.onClicked never fires. The panel is now only
// the lookup surface, reached by the button on the page; the toolbar icon goes
// to the dashboard, where browsing and review live.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
  .catch((err) => console.error('[vocab-track] setPanelBehavior failed', err));

const DASHBOARD = 'dashboard.html';

chrome.action.onClicked.addListener(() => openDashboard());

async function openDashboard() {
  const url = chrome.runtime.getURL(DASHBOARD);
  // Reuse the dashboard tab rather than piling up duplicates. The id is
  // remembered rather than looked up: finding a tab by URL needs the "tabs"
  // permission, and one stored id is not worth widening what this extension
  // can see. tabs.update throws if the tab is gone, which is the signal to
  // open a new one.
  const { dashboardTabId } = await chrome.storage.session.get('dashboardTabId');
  if (dashboardTabId !== undefined) {
    try {
      const tab = await chrome.tabs.update(dashboardTabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    } catch (err) {
      console.error('[vocab-track] dashboard tab is gone, opening a new one', err);
    }
  }
  const tab = await chrome.tabs.create({ url });
  await chrome.storage.session.set({ dashboardTabId: tab.id });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'open-dashboard') {
    openDashboard();
    return;
  }

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
