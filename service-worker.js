// At top level, not in onInstalled: the setting persists per extension, so an
// install that set it once would keep the old behaviour until it was
// reinstalled. Running on every worker wake is cheap and makes a plain reload
// enough to change it.
//
// True, so the toolbar icon toggles the side panel: Chrome opens the panel on
// the click and closes it on the next one, which is the behaviour a panel
// button is expected to have and which an extension cannot implement itself —
// there is no API that reports whether the panel is currently open.
//
// The cost is that action.onClicked never fires at all with this on: Chrome
// consumes the click to work the panel. So the toolbar icon can no longer be
// the way to the dashboard, and the panel's own "Open dashboard →" button is.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('[vocab-track] setPanelBehavior failed', err));

const DASHBOARD = 'dashboard.html';

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

// A manifest `commands` entry, so no permission is added. The tab argument has
// been supplied since Chrome 93; without the "tabs" permission its url/title
// are stripped, but tab.id survives and that is all sendMessage needs.
// Browser-level, so it fires even on a page that preventDefaults every keydown.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'speed-read' || !tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'speed-read' })
    // No content script here: a chrome:// page, the web store, a PDF, or a tab
    // not reloaded since the extension was installed.
    .catch((err) => console.error('[vocab-track] speed-read went nowhere', err));
});

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
    // mode says what the panel does with the word: a quiz for a click on an
    // already-saved (highlighted) one, the full entry for everything else.
    pending: { word: message.word, url: message.url, mode: message.mode ?? null,
               context: message.context ?? null, ts: Date.now() }
  });
});


/* ---------- grammar checking ---------- */


// The fetch lives here for two reasons, and the first is the load-bearing one.
//
// LanguageTool's free tier counts 20 requests a minute PER IP, not per tab.
// Five tabs each debouncing on their own would be over that within seconds,
// and a content script cannot see the other four — the worker is the only
// place in the extension where one bucket can cover them all.
//
// Second, lookup.js already states the boundary this repo works to: network
// lives outside content scripts, which get no CORS bypass in MV3. Following it
// keeps LanguageTool's URL and its response schema in one file.
const LT_URL = 'https://api.languagetool.org/v2/check';
// 20KB per request is the documented per-request cap.
const LT_MAX_TEXT = 20000;
const LT_WINDOW_MS = 60000;
// 18, not 20: the window is measured against this machine's clock and
// LanguageTool's is its own, so the two edges do not line up.
const LT_MAX_CALLS = 18;
const LT_MAX_MATCHES = 60;
const LT_MAX_REPLACEMENTS = 3;
// ponytail: module scope, so Chrome evicting an idle worker empties the
// bucket and the following minute could carry up to 18 requests on top of the
// ones already spent. That is the accepted ceiling. Persisting it would put a
// storage read and a storage write on the path of every debounce, to defend a
// limit whose only penalty is a 429 that ltCheck already turns into an error
// the caller handles.
const ltCalls = [];

function ltAllow() {
  const now = Date.now();
  while (ltCalls.length && now - ltCalls[0] > LT_WINDOW_MS) ltCalls.shift();
  if (ltCalls.length >= LT_MAX_CALLS) return false;
  ltCalls.push(now);
  return true;
}

// LanguageTool's own schema stops at this function. The content script is
// handed offsets, a message and plain strings, so the day their response shape
// changes it is one edit here and not a hunt through the renderer.
function ltMatches(json) {
  return (json?.matches ?? []).slice(0, LT_MAX_MATCHES).map((match) => ({
    offset: match.offset,
    length: match.length,
    message: match.message,
    replacements: (match.replacements ?? [])
      .slice(0, LT_MAX_REPLACEMENTS)
      .map((replacement) => replacement.value),
    ruleId: match.rule?.id ?? 'UNKNOWN',
    cat: match.rule?.category?.id ?? 'OTHER',
    issueType: match.rule?.issueType ?? null
  }));
}

async function ltCheck(text) {
  // A URLSearchParams body sets the form content-type by itself, which is what
  // this endpoint wants.
  const body = new URLSearchParams({
    // Truncated rather than refused: a long draft should still get its opening
    // checked, and the alternative is telling the user nothing.
    text: String(text ?? '').slice(0, LT_MAX_TEXT),
    // ponytail: English only, and staying that way. LanguageTool has no Korean
    // at all, and this checks what you type in someone else's textarea — third
    // party prose, not the word store — so the dashboard's language toggle does
    // not govern it. `language: 'auto'` is the one-word change if it ever does.
    language: 'en-US',
    level: 'picky'
  });
  // A timeout, because this reply is awaited on an open message port: a
  // request that never settles would hold the port, and the worker, alive.
  const res = await fetch(LT_URL, {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`LanguageTool HTTP ${res.status}`);
  return ltMatches(await res.json());
}

// Its own listener, for the reason reader.js gives: onMessage takes as many as
// it is given, and the listener above returns undefined for everything it does
// not recognise, so the two cannot race.
//
// This one MUST return true. That is what holds the message port open until
// sendResponse is called; the listener above never needs it because it answers
// nothing. Without it the content script's await rejects the instant this
// function returns and the reply arrives to a closed port.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'grammar') return;

  if (!ltAllow()) {
    sendResponse({ throttled: true });
    return true;
  }

  ltCheck(message.text)
    .then((matches) => sendResponse({ matches }))
    // Always answers, on every path. A listener that returned true and then
    // failed to call sendResponse leaves the caller waiting until the port is
    // collected, which surfaces as "message port closed" with no clue why.
    .catch((err) => sendResponse({ error: String(err?.message ?? err) }));
  return true;
});
