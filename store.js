// chrome.storage access, shared by the side panel and the dashboard.
// Everything here touches Chrome APIs, so none of it is testable in the
// plain browser test page — keep pure logic in lib.js instead.

async function getWords() {
  const { words } = await chrome.storage.local.get('words');
  return words ?? {};
}

// Writes are serialised: putWord read-modify-writes the whole `words` map,
// and a lookup's fetches can finish while another is still in flight.
// Without this, the second write clobbers the first and the word is lost.
let writeQueue = Promise.resolve();

// Patches, never replaces: the caller snapshots an entry before an await
// (a storage read, a fetch), and another queued write can land in between.
// Overwriting the whole record with that stale snapshot would erase whatever
// that other write just added (e.g. a `sources` URL). Object.assign onto the
// current stored record instead, so only the fields the caller actually
// changed are applied.
function putWord(word, patch) {
  writeQueue = writeQueue.then(async () => {
    try {
      const words = await getWords();
      words[word] = Object.assign(words[word] ?? {}, patch);
      await chrome.storage.local.set({ words });
    } catch (err) {
      // Caught here, not rethrown: a rejected link in this chain would skip
      // every later queued write's callback, silently dropping them too.
      console.error('[vocab-track] save failed for', word, err);
    }
  });
  return writeQueue;
}

function removeWord(word) {
  writeQueue = writeQueue.then(async () => {
    try {
      const words = await getWords();
      delete words[word];
      await chrome.storage.local.set({ words });
    } catch (err) {
      console.error('[vocab-track] delete failed for', word, err);
    }
  });
  return writeQueue;
}

// "From reading" is synthesised rather than stored, so it exists on a fresh
// profile with no seeding step and cannot be deleted by editing storage.
async function getFolders() {
  const { folders } = await chrome.storage.local.get('folders');
  return {
    [VT.READING]: {
      id: VT.READING, name: 'From reading', auto: true,
      color: 'sage', icon: '\u{1F4D6}',
      desc: 'Everything you looked up while reading. Fills itself.'
    },
    ...(folders ?? {})
  };
}

function putFolder(folder) {
  writeQueue = writeQueue.then(async () => {
    try {
      const { folders } = await chrome.storage.local.get('folders');
      const next = folders ?? {};
      next[folder.id] = Object.assign(next[folder.id] ?? {}, folder);
      await chrome.storage.local.set({ folders: next });
    } catch (err) {
      console.error('[vocab-track] folder save failed for', folder.id, err);
    }
  });
  return writeQueue;
}

// Deleting a folder never deletes words — they only lose the tag. A word left
// with no folders reads as "From reading" again via VT.foldersOf.
function removeFolder(id) {
  if (id === VT.READING) return Promise.resolve();
  writeQueue = writeQueue.then(async () => {
    try {
      const { folders } = await chrome.storage.local.get('folders');
      const next = folders ?? {};
      delete next[id];
      const words = await getWords();
      for (const entry of Object.values(words)) {
        if (Array.isArray(entry.folders)) {
          entry.folders = entry.folders.filter((f) => f !== id);
        }
      }
      await chrome.storage.local.set({ folders: next, words });
    } catch (err) {
      console.error('[vocab-track] folder delete failed for', id, err);
    }
  });
  return writeQueue;
}

// Membership is a set on the word, so adding is idempotent.
function setWordFolders(word, ids) {
  const unique = [...new Set(ids.length ? ids : [VT.READING])];
  return putWord(word, { folders: unique });
}
