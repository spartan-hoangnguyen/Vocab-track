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

// One read-modify-write for a whole batch. putWord reads and rewrites the
// entire words map per call, which is quadratic in bytes: a two-thousand-word
// import file would serialise a map that ends up megabytes long two thousand
// times over, and the dashboard would sit frozen through it. Same patch
// semantics as putWord, applied in one pass.
function putWords(patches) {
  writeQueue = writeQueue.then(async () => {
    try {
      const words = await getWords();
      for (const [word, patch] of Object.entries(patches)) {
        words[word] = Object.assign(words[word] ?? {}, patch);
      }
      await chrome.storage.local.set({ words });
    } catch (err) {
      console.error('[vocab-track] bulk save failed', err);
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
    [VT.STARRED]: {
      id: VT.STARRED, name: 'Starred', auto: true,
      color: 'ochre', icon: '\u{2B50}',
      desc: 'The words you starred on a card.'
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

// Pins are their own list, not a field on the folder: From reading and
// Starred are rebuilt by getFolders, so a field stored on them would replace
// their built-in name and description.
async function getPins() {
  const { pins } = await chrome.storage.local.get('pins');
  return Array.isArray(pins) ? pins : [];
}

function togglePin(id) {
  writeQueue = writeQueue.then(async () => {
    try {
      const pins = await getPins();
      await chrome.storage.local.set({
        pins: pins.includes(id) ? pins.filter((p) => p !== id) : [...pins, id]
      });
    } catch (err) {
      console.error('[vocab-track] pin failed for', id, err);
    }
  });
  return writeQueue;
}

// Deleting a folder never deletes words — they only lose the tag. A word left
// with no folders reads as "From reading" again via VT.foldersOf.
function removeFolder(id) {
  if (id === VT.READING || id === VT.STARRED) return Promise.resolve();
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
      const pins = (await getPins()).filter((p) => p !== id);
      await chrome.storage.local.set({ folders: next, words, pins });
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

// Every grade, kept so FSRS's weights can one day be fitted to you rather
// than to everyone. One key per day, so a grade rewrites a few KB, not the
// whole history. Rows are [word, quality, time].
// ponytail: nothing prunes it; at ~40 bytes a row the 10MB quota is about a
// quarter-million reviews away. Prune or add unlimitedStorage before then.
function recordReview(word, quality, at = Date.now()) {
  writeQueue = writeQueue.then(async () => {
    try {
      const key = 'history:' + VT.dayKey(at);
      const { [key]: rows } = await chrome.storage.local.get(key);
      await chrome.storage.local.set({ [key]: [...(rows ?? []), [word, quality, at]] });
    } catch (err) {
      console.error('[vocab-track] review log failed for', word, err);
    }
  });
  return writeQueue;
}

// Practice keeps its own books and never touches the schedule: counts per mode
// for today (the grid's "4/10 today"), and misses per word for good. The day
// rolls over on the first read of a new one; misses carry across.
async function getPractice() {
  const { practice } = await chrome.storage.local.get('practice');
  const today = new Date().toDateString();
  if (practice?.day === today) return practice;
  return { day: today, counts: {}, misses: practice?.misses ?? {} };
}

function recordPractice(mode, word, correct) {
  writeQueue = writeQueue.then(async () => {
    try {
      const practice = await getPractice();
      const was = practice.counts[mode] ?? { right: 0, total: 0 };
      practice.counts[mode] = { right: was.right + (correct ? 1 : 0), total: was.total + 1 };
      if (!correct) practice.misses[word] = (practice.misses[word] ?? 0) + 1;
      await chrome.storage.local.set({ practice });
    } catch (err) {
      console.error('[vocab-track] practice record failed for', word, err);
    }
  });
  return writeQueue;
}

// A tag name to a folder id, making the folder when the name is new. Matched
// without case against your folders first, then the preset topics — a preset
// keeps its fixed id — so typing a name you already have never makes a twin.
// `lang` is the language of the word being filed, which every caller has in
// hand — a topic invented while reading Korean is a Korean topic. Only a NEW
// folder takes it: matching an existing one by name returns that folder
// unchanged, so filing a Korean word under an English topic you already have
// widens that folder to both rather than retagging it.
async function folderForName(name, lang = null) {
  const key = String(name).trim().toLowerCase();
  const own = Object.values(await getFolders())
    .find((f) => !f.auto && f.name.toLowerCase() === key);
  if (own) return own.id;
  const topic = VT.TOPICS.find((t) => t.name.toLowerCase() === key);
  const folder = topic
    ? { ...VT.newFolder(topic.name, { icon: topic.icon, lang }), id: topic.id }
    : VT.newFolder(name, { lang });
  await putFolder(folder);
  return folder.id;
}
