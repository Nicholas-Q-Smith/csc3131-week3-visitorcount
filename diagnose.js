'use strict';

// Turns configuration problems and database errors into a plain-English cause
// and fix that a student new to Azure can act on.
//
// Every diagnosis is { kind, message }: `kind` is a stable identifier (used by
// /api and the tests), `message` is what the page shows.

const REQUIRED = ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'];
const WHERE_TO_ADD = 'add it under Web app → Settings → Environment variables';

const CERT_ERROR_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

// Reads the PG* variables. Surrounding spaces (easy to paste into the Portal)
// are ignored, except in the password, which is used exactly as given.
function readSettings(env = process.env) {
  const clean = (value) => (value == null ? '' : String(value).trim());
  const password = env.PGPASSWORD == null ? '' : String(env.PGPASSWORD);
  const values = {
    PGHOST: clean(env.PGHOST),
    PGDATABASE: clean(env.PGDATABASE),
    PGUSER: clean(env.PGUSER),
    PGPASSWORD: password,
  };
  return {
    host: values.PGHOST,
    port: clean(env.PGPORT) === '' ? 5432 : Number(clean(env.PGPORT)),
    database: values.PGDATABASE,
    user: values.PGUSER,
    password,
    tls: clean(env.PGSSL).toLowerCase() !== 'disable',
    missing: REQUIRED.filter((name) => values[name] === ''),
  };
}

// Problems we can spot without touching the network. Returns a diagnosis, or
// null if it's worth trying to connect.
function preflight(settings) {
  if (settings.missing.length > 0) {
    return {
      kind: 'missing-settings',
      message: `These settings are missing: ${settings.missing.join(', ')}. ` +
        'Add them under Web app → Settings → Environment variables, then Apply (the app restarts).',
    };
  }
  const host = settings.host;
  if (host.includes('://') || host.includes('/') || /^[^:]+:[^:]*$/.test(host) || /\s/.test(host)) {
    return {
      kind: 'bad-host',
      message: `PGHOST should be just the server name, like psql-<name>.postgres.database.azure.com, ` +
        `with no https://, port number, slashes or spaces. It is currently "${host}".`,
    };
  }
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) {
    return {
      kind: 'bad-port',
      message: 'PGPORT must be a port number. Azure uses 5432, so set it to 5432 or remove it.',
    };
  }
  return null;
}

// Node sometimes reports a failed connection as an AggregateError (one error
// per address tried) with an empty message, so look inside it.
function errorCode(err) {
  if (!err) return undefined;
  return err.code || (Array.isArray(err.errors) && err.errors[0] && err.errors[0].code) || undefined;
}

function rawMessage(err) {
  if (!err) return '';
  if (err.message) return err.message;
  if (Array.isArray(err.errors)) {
    const inner = err.errors.map((e) => e && e.message).filter(Boolean).join('; ');
    if (inner) return inner;
  }
  return err.code ? String(err.code) : String(err);
}

function classify(err, settings = {}) {
  const code = errorCode(err);
  const message = rawMessage(err);

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return {
      kind: 'host-not-found',
      message: `PGHOST ("${settings.host || ''}") doesn't resolve. Check the spelling: ` +
        'it should look like psql-<name>.postgres.database.azure.com.',
    };
  }
  if (code === 'ECONNREFUSED') {
    return {
      kind: 'connection-refused',
      message: 'Nothing is accepting connections at that address. ' +
        'Is the server name right, and is the server running (not stopped)?',
    };
  }
  // pg-pool's own message: this request queued for one of the app's connections
  // and none came free in time. Not a firewall problem.
  if (/timeout exceeded when trying to connect/i.test(message)) {
    return {
      kind: 'pool-busy',
      message: "All of the app's database connections stayed busy for 5 seconds, so this request gave up. " +
        'Refresh in a moment. If it keeps happening, the database is slow or not answering.',
    };
  }
  // Connected, but a query got no answer: the server's statement_timeout
  // (57014) or, if the server went silent altogether, pg's query_timeout.
  if ((code === '57014' && /statement timeout/i.test(message)) || /query read timeout/i.test(message)) {
    return {
      kind: 'query-timeout',
      message: "The database accepted the connection but didn't answer within 5 seconds. It may be restarting " +
        '(Azure maintenance, or a server you have just started) or overloaded. Refresh in a minute.',
    };
  }
  if (code === 'ETIMEDOUT' || /connection timeout/i.test(message)) {
    return {
      kind: 'timeout',
      message: "The connection timed out. The database firewall is probably blocking Azure: in the database's " +
        "Networking page, tick 'Allow public access from any Azure service within Azure to this server'.",
    };
  }
  if (code === '28000' && /no pg_hba\.conf entry/i.test(message)) {
    return {
      kind: 'refused-by-hba',
      message: 'The database refused this address. Check the firewall rules (Networking) ' +
        "and that TLS is on (PGSSL must not be 'disable' on Azure).",
    };
  }
  if (code === '28P01') {
    return {
      kind: 'wrong-password',
      message: `Wrong password for user ${settings.user || '(PGUSER)'}. Check PGPASSWORD.`,
    };
  }
  if (code === '3D000') {
    return {
      kind: 'database-missing',
      message: `The database ${settings.database || '(PGDATABASE)'} doesn't exist on this server. ` +
        "Create it under the server's Settings → Databases, or fix PGDATABASE.",
    };
  }
  if (/does not support SSL/i.test(message)) {
    return {
      kind: 'server-without-tls',
      message: "This server doesn't use TLS. Locally, set PGSSL=disable. On Azure, never disable TLS.",
    };
  }
  if (CERT_ERROR_CODES.has(code) || /certificate/i.test(message)) {
    return {
      kind: 'certificate',
      message: "TLS is on, but the server's certificate couldn't be verified. Azure's certificates verify " +
        'by default, so check PGHOST is the real *.postgres.database.azure.com name (not an IP address or ' +
        'another alias). Locally, a self-signed server needs PGSSL=disable instead.',
    };
  }
  return {
    kind: 'unexpected',
    message: `Unexpected database error: ${message}`,
  };
}

module.exports = { REQUIRED, WHERE_TO_ADD, readSettings, preflight, classify, rawMessage };
