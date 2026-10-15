'use strict';

// Notes demonstrate persistence: saved in the database when it works, otherwise
// in this container's memory (and lost when it restarts).

const MAX_LENGTH = 80;
const MEMORY_LIMIT = 20;
const SHOWN = 10;
const MIN_INTERVAL_MS = 1000;

// Friendly messages for the redirect after POST /notes. Only these fixed keys
// ever go in the URL, so no user text is reflected back into the page.
const MESSAGES = {
  'saved-database': { status: 'pass', text: 'Note saved in the database.' },
  'saved-memory': { status: 'warn', text: 'Note saved in this container only: it will be lost when the container restarts.' },
  empty: { status: 'fail', text: 'Type something before saving.' },
  'too-long': { status: 'fail', text: `Notes can be at most ${MAX_LENGTH} characters.` },
  'too-fast': { status: 'fail', text: 'Slow down: one note per second. Your note was not saved.' },
};

// Returns { ok: true, text } or { ok: false, error } where error is a MESSAGES key.
function validateNote(input) {
  const text = (typeof input === 'string' ? input : '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ') // control characters (newlines, NUL) become spaces
    .trim();
  if (text === '') return { ok: false, error: 'empty' };
  if ([...text].length > MAX_LENGTH) return { ok: false, error: 'too-long' }; // count characters, not UTF-16 units
  return { ok: true, text };
}

function createMemoryStore(limit = MEMORY_LIMIT) {
  const notes = [];
  return {
    add(text, createdAt = new Date()) {
      notes.push({ text, createdAt });
      if (notes.length > limit) notes.splice(0, notes.length - limit);
    },
    recent(count = SHOWN) {
      return notes.slice(-count).reverse();
    },
    count() {
      return notes.length;
    },
  };
}

// Allows one action per interval; `now` is injectable for tests.
function createThrottle(intervalMs = MIN_INTERVAL_MS, now = Date.now) {
  let last = -Infinity;
  return () => {
    const t = now();
    if (t - last < intervalMs) return false;
    last = t;
    return true;
  };
}

// The database when it's configured and takes the insert, otherwise memory.
// Memory notes are never copied into the database later.
async function saveNote(text, { databaseConfigured, insertIntoDatabase, memory }) {
  if (databaseConfigured && await insertIntoDatabase(text)) return 'database';
  memory.add(text);
  return 'memory';
}

module.exports = { MAX_LENGTH, SHOWN, MESSAGES, validateNote, createMemoryStore, createThrottle, saveNote };
