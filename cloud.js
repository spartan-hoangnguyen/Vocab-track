// Cloud sync: one file, vocab-track.json, in the user's own Google Drive
// appDataFolder — hidden from their Drive and readable only by this extension.
// Loaded by the service worker after lib.js, and the only file that talks to
// Drive. The dashboard reaches it through the cloud-* messages that
// service-worker.js routes here; state the dashboard shows lives in
// chrome.storage.local `cloud`: { signedIn, lastSync, email, error, fileId }.
//
// Two machines can push at once, and the later upload wins on Drive. That is
// acceptable: each machine keeps its own copy, and VT.mergePayload is
// symmetric, so the losing side's next sync merges its changes back in and
// uploads them again. Nothing is lost, it is only late by one sync.

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const DRIVE_ABOUT = 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)';
const REVOKE_URL = 'https://accounts.google.com/o/oauth2/revoke?token=';
const CLOUD_FILE = 'vocab-track.json';
const CLOUD_TIMEOUT_MS = 30000;
// ponytail: simple and multipart uploads stop at 5 MB. Below it with room to
// spare; a store bigger than this gets a clear error instead of a sync. A
// resumable upload (uploadType=resumable) is the fix if anyone gets there —
// at a few hundred bytes a word that is well over ten thousand words.
const CLOUD_MAX_BYTES = 4.5 * 1024 * 1024;

async function setCloud(patch) {
  const { cloud } = await chrome.storage.local.get('cloud');
  await chrome.storage.local.set({ cloud: { ...cloud, ...patch } });
}

// A Drive request with the cached token. A 401 means the token expired or was
// revoked: drop it from Chrome's cache and try once more with a fresh one.
// Resolves null on a 404 when the caller asked for that (a file deleted under
// a cached id); every other failure throws a sentence the card can show.
async function driveFetch(url, init = {}, { allow404 = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    let token;
    try {
      ({ token } = await chrome.identity.getAuthToken({ interactive: false }));
    } catch (err) {
      console.error('[vocab-track] no Google token', err);
      throw new Error('Your Google sign-in has expired. Sign out and sign in again.');
    }
    let res;
    try {
      res = await fetch(url, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS)
      });
    } catch (err) {
      console.error('[vocab-track] Google Drive unreachable', url, err);
      throw new Error('Could not reach Google Drive. Check your connection and try again.');
    }
    if (res.status === 401 && attempt === 0) {
      await chrome.identity.removeCachedAuthToken({ token });
      continue;
    }
    if (res.status === 404 && allow404) return null;
    if (!res.ok) {
      console.error('[vocab-track] Google Drive HTTP', res.status, url, await res.text().catch(() => ''));
      throw new Error(res.status === 401
        ? 'Google turned down the sign-in. Sign out and sign in again.'
        : `Google Drive answered with an error (HTTP ${res.status}). Try again later.`);
    }
    return res;
  }
}

async function findCloudFile() {
  const q = encodeURIComponent(`name='${CLOUD_FILE}'`);
  const res = await driveFetch(`${DRIVE_FILES}?spaces=appDataFolder&q=${q}&fields=files(id)`);
  return (await res.json()).files?.[0]?.id ?? null;
}

// The payload in the file, or undefined when the id no longer names a file.
async function downloadCloudFile(id) {
  const res = await driveFetch(`${DRIVE_FILES}/${id}?alt=media`, {}, { allow404: true });
  if (!res) return undefined;
  let data;
  try {
    data = await res.json();
  } catch (err) {
    console.error('[vocab-track] Drive copy is not JSON', err);
  }
  if (!data || typeof data.words !== 'object') {
    throw new Error('The copy in your Google Drive is not a Vocab-track file. Nothing was changed.');
  }
  return data;
}

// Updates the file in place, or creates it in appDataFolder. Returns its id.
async function uploadCloudFile(id, json) {
  if (id) {
    await driveFetch(`${DRIVE_UPLOAD}/${id}?uploadType=media`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: json
    });
    return id;
  }
  const boundary = `vocab-track-${crypto.randomUUID()}`;
  const meta = JSON.stringify({ name: CLOUD_FILE, parents: ['appDataFolder'] });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`
    + `--${boundary}\r\nContent-Type: application/json\r\n\r\n${json}\r\n--${boundary}--`;
  const res = await driveFetch(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id`, {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body
  });
  return (await res.json()).id;
}

// One sync at a time: a second call while one runs gets the same promise.
let cloudInflight = null;

function sync() {
  cloudInflight ??= runSync().finally(() => { cloudInflight = null; });
  return cloudInflight;
}

async function runSync() {
  const { cloud } = await chrome.storage.local.get('cloud');
  // Signed out: no token asked for and no request made.
  if (!cloud?.signedIn) return;
  try {
    let fileId = cloud.fileId ?? await findCloudFile();
    let remote = fileId ? await downloadCloudFile(fileId) : null;
    if (remote === undefined) {
      // The cached id is stale (the file was deleted); look it up again.
      fileId = await findCloudFile();
      remote = fileId ? await downloadCloudFile(fileId) : null;
    }
    // Read local only now, after the download, so the gap in which a save
    // from the panel or dashboard could land unseen is the merge itself, not
    // a network round trip.
    // ponytail: still not zero — store.js's writeQueue lives in each page and
    // cannot be joined from here. A word saved inside that gap is overwritten
    // locally; it is still on whichever side it was not, so the next sync
    // brings it back unless it was new on this machine and saved in that same
    // millisecond window.
    const dump = await chrome.storage.local.get(null);
    const merged = VT.mergePayload(VT.backupPayload(dump), remote ?? {});
    // Written directly, not through putWord: that would stamp `updated` on
    // every word and make this machine's copy look newer than it is. The
    // session flag lets the automatic trigger (T183) ignore this echo.
    const writes = VT.payloadWrites(merged, dump);
    if (Object.keys(writes).length) {
      await chrome.storage.session.set({ syncing: true });
      try {
        await chrome.storage.local.set(writes);
      } finally {
        await chrome.storage.session.set({ syncing: false });
      }
    }
    const json = JSON.stringify(merged);
    const same = remote && JSON.stringify({ ...remote, exported: null }) === JSON.stringify({ ...merged, exported: null });
    if (!same) {
      if (new Blob([json]).size > CLOUD_MAX_BYTES) {
        throw new Error('Your words are over 4.5 MB, too big to sync yet. They are safe on this machine.');
      }
      fileId = await uploadCloudFile(fileId, json);
    }
    await setCloud({ fileId, lastSync: Date.now(), error: null });
  } catch (err) {
    console.error('[vocab-track] cloud sync failed', err);
    await setCloud({ error: err.message });
  }
}

async function signIn() {
  try {
    await chrome.identity.getAuthToken({ interactive: true });
  } catch (err) {
    // Also what happens until a real OAuth client id is in manifest.json.
    console.error('[vocab-track] Google sign-in failed', err);
    await chrome.storage.local.set({
      // Chrome's own wording ("The user did not approve access.") stays in the
      // console; the card says what happened and what to press.
      cloud: {
        signedIn: false,
        error: /did not approve|cancel|closed/i.test(err?.message ?? '')
          ? 'Sign-in was cancelled. Press Sign in with Google to try again.'
          : 'Could not sign in with Google. Check your connection, then try again.'
      }
    });
    return;
  }
  // Drive's about.get, so no identity.email permission (an install warning)
  // is needed. Hidden when Drive will not say.
  let email = null;
  try {
    const res = await driveFetch(DRIVE_ABOUT);
    email = (await res.json()).user?.emailAddress ?? null;
  } catch (err) {
    console.error('[vocab-track] could not read the account email', err);
  }
  await chrome.storage.local.set({ cloud: { signedIn: true, email, lastSync: null, error: null } });
  await sync();
}

// Local words and the Drive file are both left as they are.
async function signOut() {
  await cloudInflight;
  try {
    const { token } = await chrome.identity.getAuthToken({ interactive: false });
    if (token) {
      await chrome.identity.removeCachedAuthToken({ token });
      // no-cors: the request is all that matters, and the endpoint's reply is
      // not one this page is allowed to read.
      await fetch(REVOKE_URL + encodeURIComponent(token), { mode: 'no-cors' })
        .catch((err) => console.error('[vocab-track] token revoke failed', err));
    }
  } catch (err) {
    console.error('[vocab-track] no Google token to revoke at sign-out', err);
  }
  await chrome.storage.local.remove('cloud');
}
