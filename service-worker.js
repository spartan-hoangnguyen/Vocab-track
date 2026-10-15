// lib.js is only `const VT = {...}`: the backup's payload and file name.
// cloud.js is Google Drive sync, and needs VT, so it comes second.
importScripts('lib.js', 'cloud.js');

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


/* ---------- cloud sync ---------- */


// The dashboard's Cloud sync card. Every handler catches its own failures and
// records them in `cloud.error`, so the reply is always the state to show.
// Returns true for the same reason as the grammar listener above.
const CLOUD_HANDLERS = {
  'cloud-signin': signIn,
  'cloud-signout': signOut,
  'cloud-sync': sync,
  'cloud-status': async () => {}
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = CLOUD_HANDLERS[message?.type];
  if (!handler) return;
  handler()
    .catch((err) => console.error('[vocab-track]', message.type, 'failed', err))
    .then(() => chrome.storage.local.get('cloud'))
    .then(({ cloud }) => sendResponse(cloud ?? { signedIn: false }))
    .catch((err) => sendResponse({ signedIn: false, error: String(err?.message ?? err) }));
  return true;
});


/* ---------- automatic backup ---------- */


// A dated file in Downloads/vocab-track, written a minute after the last
// change to anything you would miss: re-creating the alarm resets it, so a
// review session ends in one backup, not one per grade. One file per day and
// seven days kept — a single rolling file would let a fresh profile overwrite
// the only backup with a one-word store before you restore it. Nothing leaves
// the machine. Registered at top level so a worker woken by the event sees it.
const BACKUP_ALARM = 'backup';
const BACKUP_KEEP = 7;
const BACKUP_DELAY_MIN = 1;
const BACKUP_TIMEOUT_MS = 60000;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  // lastBackup is not watched, so recording a backup cannot schedule another.
  if (!Object.keys(changes).some((key) => ['words', 'folders', 'pins'].includes(key)
      || key.startsWith('history:'))) return;
  chrome.alarms.create(BACKUP_ALARM, { delayInMinutes: BACKUP_DELAY_MIN })
    .catch((err) => console.error('[vocab-track] backup alarm failed', err));
});

// A worker evicted mid-backup never reached its `finally`; a fresh one turns
// the bubble back on, since no backup can be running in a worker just started.
chrome.downloads.setUiOptions({ enabled: true })
  .catch((err) => console.error('[vocab-track] could not re-enable the download bubble', err));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BACKUP_ALARM) backup();
});

// Resolves with the download's end state: 'complete' or 'interrupted'.
function downloadSettled(id) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish('timeout'), BACKUP_TIMEOUT_MS);
    function finish(state) {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(state);
    }
    function onChanged(delta) {
      if (delta.id === id && delta.state && delta.state.current !== 'in_progress') {
        finish(delta.state.current);
      }
    }
    chrome.downloads.onChanged.addListener(onChanged);
    // It may have finished before the listener was attached.
    chrome.downloads.search({ id }).then(([item]) => {
      if (item && item.state !== 'in_progress') finish(item.state);
    });
  });
}

async function backup() {
  let offscreen = false;
  let uiHidden = false;
  try {
    const dump = await chrome.storage.local.get(null);
    const words = Object.keys(dump.words ?? {}).length;
    if (!words) return;
    const now = Date.now();
    const file = VT.backupFileName(now);
    await chrome.offscreen.createDocument({
      url: 'offscreen.html', reasons: ['BLOBS'], justification: 'Write the backup file'
    }).catch((err) => {
      // Left open by a backup the worker was evicted in the middle of.
      if (!String(err?.message).includes('single offscreen')) throw err;
    });
    offscreen = true;
    const url = await chrome.runtime.sendMessage({
      type: 'backup-blob', json: JSON.stringify(VT.backupPayload(dump, now))
    });
    // Browser-wide while off, so it goes back on in `finally` whatever happens.
    await chrome.downloads.setUiOptions({ enabled: false });
    uiHidden = true;
    const id = await chrome.downloads.download({
      url, filename: file, conflictAction: 'overwrite', saveAs: false
    });
    const state = await downloadSettled(id);
    if (state !== 'complete') throw new Error(`backup download ${state}`);
    await chrome.storage.local.set({ lastBackup: { at: now, file, words } });
    await pruneBackups();
  } catch (err) {
    console.error('[vocab-track] automatic backup failed', err);
  } finally {
    if (uiHidden) {
      await chrome.downloads.setUiOptions({ enabled: true })
        .catch((err) => console.error('[vocab-track] could not re-enable the download bubble', err));
    }
    if (offscreen) {
      await chrome.offscreen.closeDocument()
        .catch((err) => console.error('[vocab-track] offscreen close failed', err));
    }
  }
}

async function pruneBackups() {
  const items = (await chrome.downloads.search({ filenameRegex: 'vocab-track[/\\\\]backup-' }))
    .filter((item) => item.byExtensionId === chrome.runtime.id);
  const { remove, erase } = VT.backupsToPrune(items, BACKUP_KEEP);
  for (const id of remove) {
    // Several entries can name one old file; after the first the file is gone.
    await chrome.downloads.removeFile(id)
      .catch((err) => console.error('[vocab-track] old backup already gone', id, err));
  }
  for (const id of [...remove, ...erase]) await chrome.downloads.erase({ id });
}
