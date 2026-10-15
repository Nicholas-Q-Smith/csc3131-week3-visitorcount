'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { esc, visitorIp, renderPage } = require('../server');

test('visitorIp takes the first X-Forwarded-For entry and strips the port', () => {
  assert.equal(visitorIp('203.0.113.7:51234, 10.0.0.4'), '203.0.113.7');
  assert.equal(visitorIp('203.0.113.7'), '203.0.113.7');
  assert.equal(visitorIp('[2001:db8::1]:51234'), '2001:db8::1');
  assert.equal(visitorIp('2001:db8::1, 10.0.0.4'), '2001:db8::1');
  assert.equal(visitorIp(undefined), '');
});

test('esc escapes everything that matters in HTML text and attributes', () => {
  assert.equal(esc(`<script>alert("x" & 'y')</script>`),
    '&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;');
  assert.equal(esc(undefined), '');
  assert.equal(esc(42), '42');
});

function fakeReport(overrides = {}) {
  return {
    app: 'csc3131-visits', version: '1', databaseOk: false,
    database: { ok: false, problem: 'missing-settings', cause: 'These settings are missing: PGHOST.', error: null },
    notesStore: 'memory', noteCount: 0, checklist: [],
    request: { containerHostname: 'h', connectedFrom: '', visitorIp: '', forwardedProto: '', host: '' },
    ...overrides,
  };
}

test('note text is escaped: no HTML or links are rendered', () => {
  const html = renderPage(fakeReport(), {
    recentNotes: [{ text: `<script>alert(1)</script> <a href="https://evil.example">x</a>`, createdAt: new Date() }],
  });
  assert.ok(!html.includes('<script>alert'));
  assert.ok(!html.includes('<a href'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &lt;a href=&quot;https://evil.example&quot;&gt;x&lt;/a&gt;'));
});

test('the store label matches the active store', () => {
  assert.match(renderPage(fakeReport({ notesStore: 'memory' })), /class="box warn">Saved in this container only: lost when it restarts/);
  assert.match(renderPage(fakeReport({ notesStore: 'database', databaseOk: true,
    database: { ok: true, totalVisits: 1, latestVisit: new Date().toISOString() } })),
  /class="box pass">Saved in the database: survives restarts/);
});
