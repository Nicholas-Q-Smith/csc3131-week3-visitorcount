'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { esc, visitorIp } = require('../server');

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
