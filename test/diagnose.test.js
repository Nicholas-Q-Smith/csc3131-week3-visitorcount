'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { readSettings, preflight, classify, rawMessage } = require('../diagnose');

const AZURE_ENV = {
  PGHOST: 'psql-abc123.postgres.database.azure.com',
  PGDATABASE: 'visits',
  PGUSER: 'csc3131admin',
  PGPASSWORD: 'Secret!pass 1',
};
const settings = readSettings(AZURE_ENV);

// Builds an error shaped like the ones node / pg produce.
function fakeError(message, props = {}) {
  return Object.assign(new Error(message), props);
}

describe('readSettings', () => {
  test('reads a complete Azure configuration with TLS on and port 5432 by default', () => {
    assert.deepEqual(settings, {
      host: 'psql-abc123.postgres.database.azure.com',
      port: 5432,
      database: 'visits',
      user: 'csc3131admin',
      password: 'Secret!pass 1',
      tls: true,
      missing: [],
    });
  });

  test('lists every missing required setting, treating blank values as missing', () => {
    assert.deepEqual(readSettings({}).missing, ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']);
    assert.deepEqual(readSettings({ ...AZURE_ENV, PGHOST: '   ', PGPASSWORD: '' }).missing, ['PGHOST', 'PGPASSWORD']);
  });

  test('trims pasted spaces from names but keeps the password exactly', () => {
    const s = readSettings({ ...AZURE_ENV, PGHOST: ' h.example ', PGUSER: 'u ', PGPASSWORD: ' p ' });
    assert.equal(s.host, 'h.example');
    assert.equal(s.user, 'u');
    assert.equal(s.password, ' p ');
  });

  test('PGSSL=disable (any case) turns TLS off; anything else leaves it on', () => {
    assert.equal(readSettings({ PGSSL: 'disable' }).tls, false);
    assert.equal(readSettings({ PGSSL: ' DISABLE ' }).tls, false);
    assert.equal(readSettings({ PGSSL: 'require' }).tls, true);
    assert.equal(readSettings({ PGSSL: '' }).tls, true);
  });

  test('reads PGPORT', () => {
    assert.equal(readSettings({ PGPORT: '6432' }).port, 6432);
  });
});

describe('preflight', () => {
  test('a complete configuration is worth trying', () => {
    assert.equal(preflight(settings), null);
  });

  test('missing settings are reported by name, before any connection', () => {
    const d = preflight(readSettings({ PGDATABASE: 'visits', PGPASSWORD: 'x' }));
    assert.equal(d.kind, 'missing-settings');
    assert.match(d.message, /^These settings are missing: PGHOST, PGUSER\./);
  });

  for (const host of [
    'https://psql-abc123.postgres.database.azure.com',
    'psql-abc123.postgres.database.azure.com:5432',
    'psql-abc123.postgres.database.azure.com/',
    'psql abc123.postgres.database.azure.com',
  ]) {
    test(`PGHOST "${host}" is rejected as not just a server name`, () => {
      const d = preflight(readSettings({ ...AZURE_ENV, PGHOST: host }));
      assert.equal(d.kind, 'bad-host');
      assert.match(d.message, /just the server name/);
    });
  }

  test('an IPv6 literal is not mistaken for host:port', () => {
    assert.equal(preflight(readSettings({ ...AZURE_ENV, PGHOST: '::1' })), null);
  });

  test('a non-numeric PGPORT is reported', () => {
    const d = preflight(readSettings({ ...AZURE_ENV, PGPORT: 'postgres' }));
    assert.equal(d.kind, 'bad-port');
  });
});

describe('classify', () => {
  test('ENOTFOUND: PGHOST does not resolve', () => {
    const d = classify(fakeError('getaddrinfo ENOTFOUND psql-abc123.postgres.database.azure.com', { code: 'ENOTFOUND' }), settings);
    assert.equal(d.kind, 'host-not-found');
    assert.match(d.message, /doesn't resolve\. Check the spelling: it should look like psql-<name>\.postgres\.database\.azure\.com\./);
    assert.match(d.message, /psql-abc123/);
  });

  test('EAI_AGAIN: also a name that does not resolve', () => {
    assert.equal(classify(fakeError('getaddrinfo EAI_AGAIN db', { code: 'EAI_AGAIN' }), settings).kind, 'host-not-found');
  });

  test('ECONNREFUSED: nothing listening', () => {
    const d = classify(fakeError('connect ECONNREFUSED 10.0.0.5:5432', { code: 'ECONNREFUSED' }), settings);
    assert.equal(d.kind, 'connection-refused');
    assert.match(d.message, /^Nothing is accepting connections at that address\./);
  });

  test('ECONNREFUSED reported as an AggregateError with an empty message', () => {
    const err = new AggregateError([
      fakeError('connect ECONNREFUSED ::1:5432', { code: 'ECONNREFUSED' }),
      fakeError('connect ECONNREFUSED 127.0.0.1:5432', { code: 'ECONNREFUSED' }),
    ], '');
    assert.equal(classify(err, settings).kind, 'connection-refused');
    assert.equal(rawMessage(err), 'connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432');
  });

  test('pg connection timeout: firewall blocking Azure', () => {
    const d = classify(fakeError('Connection terminated due to connection timeout'), settings);
    assert.equal(d.kind, 'timeout');
    assert.match(d.message, /Allow public access from any Azure service within Azure to this server/);
  });

  test('pg-pool checkout timeout is also a timeout', () => {
    assert.equal(classify(fakeError('timeout exceeded when trying to connect'), settings).kind, 'timeout');
  });

  test('ETIMEDOUT is a timeout', () => {
    assert.equal(classify(fakeError('connect ETIMEDOUT 20.0.0.1:5432', { code: 'ETIMEDOUT' }), settings).kind, 'timeout');
  });

  test('28000 no pg_hba.conf entry: firewall or TLS off', () => {
    const err = fakeError('no pg_hba.conf entry for host "20.1.2.3", user "csc3131admin", database "visits", no encryption', { code: '28000' });
    const d = classify(err, settings);
    assert.equal(d.kind, 'refused-by-hba');
    assert.match(d.message, /PGSSL must not be 'disable' on Azure/);
  });

  test('28000 without the pg_hba message falls through to unexpected', () => {
    const d = classify(fakeError('role "x" is not permitted to log in', { code: '28000' }), settings);
    assert.equal(d.kind, 'unexpected');
  });

  test('28P01: wrong password, naming the user', () => {
    const d = classify(fakeError('password authentication failed for user "csc3131admin"', { code: '28P01' }), settings);
    assert.equal(d.kind, 'wrong-password');
    assert.equal(d.message, 'Wrong password for user csc3131admin. Check PGPASSWORD.');
  });

  test('3D000: database does not exist, naming it', () => {
    const d = classify(fakeError('database "visits" does not exist', { code: '3D000' }), settings);
    assert.equal(d.kind, 'database-missing');
    assert.match(d.message, /^The database visits doesn't exist on this server\./);
  });

  test('server without TLS (local Postgres, PGSSL not disabled)', () => {
    const d = classify(fakeError('The server does not support SSL connections'), settings);
    assert.equal(d.kind, 'server-without-tls');
    assert.match(d.message, /Locally, set PGSSL=disable\. On Azure, never disable TLS\./);
  });

  for (const code of ['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
    test(`${code}: certificate verification problem`, () => {
      const d = classify(fakeError('some TLS failure', { code }), settings);
      assert.equal(d.kind, 'certificate');
      assert.match(d.message, /certificate couldn't be verified/);
      assert.match(d.message, /Azure's certificates verify by default/);
    });
  }

  test('a certificate message without a known code is still a certificate problem', () => {
    assert.equal(classify(fakeError('self-signed certificate in certificate chain'), settings).kind, 'certificate');
  });

  test('anything else: unexpected, with the raw message', () => {
    const d = classify(fakeError('relation "visits" is locked', { code: '55P03' }), settings);
    assert.equal(d.kind, 'unexpected');
    assert.equal(d.message, 'Unexpected database error: relation "visits" is locked');
  });

  test('copes with odd error values', () => {
    assert.equal(classify({ code: 'WEIRD' }, settings).message, 'Unexpected database error: WEIRD');
    assert.equal(classify(undefined, settings).kind, 'unexpected');
  });

  test('never includes the password', () => {
    const errors = [
      fakeError('x', { code: 'ENOTFOUND' }), fakeError('x', { code: '28P01' }), fakeError('x', { code: '3D000' }),
      fakeError('no pg_hba.conf entry', { code: '28000' }), fakeError('anything'),
    ];
    for (const err of errors) assert.ok(!classify(err, settings).message.includes(AZURE_ENV.PGPASSWORD));
  });
});
