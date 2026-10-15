'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { MESSAGES, validateNote, createMemoryStore, createThrottle, saveNote } = require('../notes');

describe('validateNote', () => {
  test('trims and accepts ordinary text', () => {
    assert.deepEqual(validateNote('  hello Azure  '), { ok: true, text: 'hello Azure' });
  });

  test('rejects empty, blank and missing input', () => {
    for (const input of ['', '   ', '\n\t', undefined, null, ['a', 'b'], { text: 'x' }]) {
      assert.deepEqual(validateNote(input), { ok: false, error: 'empty' }, `input ${JSON.stringify(input)}`);
    }
  });

  test('accepts exactly 80 characters and rejects 81', () => {
    assert.equal(validateNote('x'.repeat(80)).ok, true);
    assert.deepEqual(validateNote('x'.repeat(81)), { ok: false, error: 'too-long' });
  });

  test('length is checked after trimming', () => {
    assert.equal(validateNote(`  ${'x'.repeat(80)}  `).ok, true);
  });

  test('counts characters, not UTF-16 code units (emoji count as one)', () => {
    assert.equal(validateNote('🙂'.repeat(80)).ok, true);
    assert.equal(validateNote('🙂'.repeat(81)).ok, false);
  });

  test('control characters such as newlines and NUL become spaces', () => {
    assert.deepEqual(validateNote('one\r\ntwo\u0000three'), { ok: true, text: 'one two three' });
  });

  test('HTML is kept as text (it is escaped on output, not stripped)', () => {
    assert.deepEqual(validateNote('<b>hi</b>'), { ok: true, text: '<b>hi</b>' });
  });

  test('every error has a friendly message', () => {
    for (const key of ['empty', 'too-long', 'too-fast']) assert.ok(MESSAGES[key].text.length > 0);
  });
});

describe('memory store', () => {
  test('lists newest first, at most the requested number', () => {
    const store = createMemoryStore();
    for (let i = 1; i <= 12; i++) store.add(`note ${i}`);
    assert.deepEqual(store.recent(10).map((n) => n.text), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map((i) => `note ${i}`));
  });

  test('keeps at most 20 notes, dropping the oldest', () => {
    const store = createMemoryStore();
    for (let i = 1; i <= 25; i++) store.add(`note ${i}`);
    assert.equal(store.count(), 20);
    assert.deepEqual(store.recent(20).at(-1).text, 'note 6');
    assert.deepEqual(store.recent(1)[0].text, 'note 25');
  });

  test('records when each note was added', () => {
    const store = createMemoryStore();
    const when = new Date('2026-10-14T12:00:00Z');
    store.add('x', when);
    assert.equal(store.recent()[0].createdAt, when);
  });
});

describe('throttle', () => {
  test('allows one note per second', () => {
    let now = 10_000;
    const allow = createThrottle(1000, () => now);
    assert.equal(allow(), true);
    now += 999;
    assert.equal(allow(), false);
    now += 1;
    assert.equal(allow(), true);
  });
});

describe('store selection (saveNote)', () => {
  function fakes(insertResult) {
    const inserted = [];
    return {
      inserted,
      memory: createMemoryStore(),
      // Records only the notes the "database" actually stored.
      insertIntoDatabase: async (text) => { if (insertResult) inserted.push(text); return insertResult; },
    };
  }

  test('database configured and accepts the insert: saved in the database only', async () => {
    const f = fakes(true);
    assert.equal(await saveNote('hi', { databaseConfigured: true, ...f }), 'database');
    assert.deepEqual(f.inserted, ['hi']);
    assert.equal(f.memory.count(), 0);
  });

  test('database configured but unreachable: saved in memory', async () => {
    const f = fakes(false);
    assert.equal(await saveNote('hi', { databaseConfigured: true, ...f }), 'memory');
    assert.equal(f.memory.count(), 1);
  });

  test('database not configured: saved in memory without trying the database', async () => {
    let tried = false;
    const memory = createMemoryStore();
    const insertIntoDatabase = async () => { tried = true; return true; };
    assert.equal(await saveNote('hi', { databaseConfigured: false, insertIntoDatabase, memory }), 'memory');
    assert.equal(tried, false);
    assert.equal(memory.count(), 1);
  });

  test('memory notes are never copied into the database when it comes back', async () => {
    const f = fakes(false);
    await saveNote('while down', { databaseConfigured: true, ...f });
    f.insertIntoDatabase = async (text) => { f.inserted.push(text); return true; };
    await saveNote('after recovery', { databaseConfigured: true, ...f });
    assert.deepEqual(f.inserted, ['after recovery']);
    assert.deepEqual(f.memory.recent().map((n) => n.text), ['while down']);
  });
});
