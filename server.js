'use strict';

const os = require('node:os');
const express = require('express');
const { Pool } = require('pg');
const { WHERE_TO_ADD, readSettings, preflight, classify, rawMessage } = require('./diagnose');

const PORT = Number(process.env.PORT) || 3000;
const APP_VERSION = process.env.APP_VERSION || 'dev';
const SETTINGS_SHOWN_AT_STARTUP = ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSSL'];

// App Service restarts the container whenever an environment variable changes,
// so reading the settings once at startup is enough.
const settings = readSettings();

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

let pool = null;
let tableReady = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      host: settings.host,
      port: settings.port,
      database: settings.database,
      user: settings.user,
      password: settings.password,
      ssl: settings.tls ? { rejectUnauthorized: true } : false,
      max: 5,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
    });
    // An idle connection dropping (server stopped, network blip) must not crash
    // the app: log it, and the next request simply connects again.
    pool.on('error', (err) => console.error(`database connection dropped: ${rawMessage(err)}`));
  }
  return pool;
}

function ensureTable(db) {
  tableReady ??= db.query(
    'CREATE TABLE IF NOT EXISTS visits (id serial PRIMARY KEY, visited_at timestamptz NOT NULL DEFAULT now())',
  );
  return tableReady;
}

// Records this visit and returns the totals, or a diagnosis of why it couldn't.
// Runs on every page load, so a fixed setup is picked up without a restart.
async function recordVisit() {
  const problem = preflight(settings);
  if (problem) return { ok: false, diagnosis: problem, raw: null };

  try {
    const db = getPool();
    await ensureTable(db);
    const { rows: [visit] } = await db.query('INSERT INTO visits DEFAULT VALUES RETURNING visited_at');
    const { rows: [stats] } = await db.query('SELECT count(*)::int AS total FROM visits');
    return { ok: true, totalVisits: stats.total, latestVisit: visit.visited_at };
  } catch (err) {
    tableReady = null; // try CREATE TABLE again next time (e.g. the database was recreated)
    return { ok: false, diagnosis: classify(err, settings), raw: rawMessage(err) };
  }
}

// ---------------------------------------------------------------------------
// What the page reports
// ---------------------------------------------------------------------------

function settingsChecklist() {
  const visible = { PGHOST: settings.host, PGDATABASE: settings.database, PGUSER: settings.user };
  const items = ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'].map((name) => {
    if (settings.missing.includes(name)) {
      return { name, status: 'fail', detail: `missing: ${WHERE_TO_ADD}` };
    }
    return { name, status: 'pass', detail: name === 'PGPASSWORD' ? 'set (hidden)' : `set: ${visible[name]}` };
  });
  items.push(settings.tls
    ? { name: 'PGSSL', status: 'pass', detail: 'TLS on (required by Azure)' }
    : { name: 'PGSSL', status: 'warn', detail: 'TLS off (PGSSL=disable, local only)' });
  return items;
}

// "203.0.113.7:51234, 10.0.0.4" -> "203.0.113.7". Azure appends the client's
// port; IPv6 arrives either bare or as "[2001:db8::1]:51234".
function visitorIp(forwardedFor) {
  if (!forwardedFor) return '';
  const first = String(forwardedFor).split(',')[0].trim();
  const bracketed = first.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1];
  if (/^[^:]+:\d+$/.test(first)) return first.slice(0, first.lastIndexOf(':'));
  return first;
}

function describeRequest(req) {
  return {
    containerHostname: os.hostname(),
    connectedFrom: req.socket.remoteAddress || '',
    visitorIp: visitorIp(req.get('x-forwarded-for')),
    forwardedProto: req.get('x-forwarded-proto') || '',
    host: req.get('host') || '',
  };
}

async function buildReport(req) {
  const db = await recordVisit();
  return {
    app: 'csc3131-visits',
    version: APP_VERSION,
    ok: db.ok,
    database: db.ok
      ? { ok: true, totalVisits: db.totalVisits, latestVisit: db.latestVisit.toISOString() }
      : { ok: false, problem: db.diagnosis.kind, cause: db.diagnosis.message, error: db.raw },
    checklist: settingsChecklist(),
    request: describeRequest(req),
  };
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function formatTime(iso) {
  return `${iso.slice(0, 19).replace('T', ' ')} UTC`;
}

const MARKS = { pass: '✓', fail: '✗', warn: '!' };

function checkRow(status, label, detailHtml) {
  return `<li class="${status}"><span class="mark" aria-hidden="true">${MARKS[status]}</span>` +
    `<span class="label">${esc(label)}</span><span class="detail">${detailHtml}</span></li>`;
}

function renderPage(report) {
  const db = report.database;
  const r = report.request;
  const shown = (value, fallback) => (value ? `<code>${esc(value)}</code>` : `<span class="muted">${esc(fallback)}</span>`);

  const counter = db.ok
    ? `<p class="count">${esc(db.totalVisits)}</p>
       <p class="muted">visits so far · latest at ${esc(formatTime(db.latestVisit))}</p>`
    : `<p class="count off">—</p>
       <p class="muted">The visit count appears once the database check below passes.</p>`;

  const dbRow = db.ok
    ? checkRow('pass', 'Database reachable and signed in', 'yes')
    : checkRow('fail', 'Database reachable and signed in',
      `${esc(db.cause)}${db.error ? `<small>${esc(db.error)}</small>` : ''}`);

  const rows = report.checklist.map((item) => checkRow(item.status, item.name, esc(item.detail)));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CSC3131 visit counter v${esc(report.version)}</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#1d2330; --muted:#6b7280; --line:#e3e6eb;
          --pass:#1a7f37; --fail:#c62828; --warn:#a15c00; --code:#eef1f5; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14171c; --card:#1d2128; --text:#e6e8eb; --muted:#9aa3ad; --line:#2d333c;
            --pass:#4ac26b; --fail:#ff6b6b; --warn:#e3a33b; --code:#262c35; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
         font:16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width:760px; margin:0 auto; padding:24px 16px 48px; }
  header { display:flex; justify-content:space-between; align-items:baseline; gap:12px; flex-wrap:wrap; }
  h1 { font-size:1.35rem; margin:0; }
  .version { font-weight:600; padding:2px 10px; border-radius:999px; background:var(--code); }
  .banner { margin:16px 0; padding:12px 16px; border-radius:8px; font-weight:600; color:#fff; }
  .banner.pass { background:var(--pass); } .banner.fail { background:var(--fail); }
  section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px 20px; margin-top:16px; }
  h2 { font-size:1rem; margin:0 0 8px; }
  .count { font-size:4.5rem; font-weight:700; line-height:1.1; margin:4px 0; font-variant-numeric:tabular-nums; }
  .count.off { color:var(--muted); }
  .muted { color:var(--muted); }
  ul { list-style:none; margin:0; padding:0; }
  li { display:grid; grid-template-columns:1.6em 11em 1fr; gap:4px 8px; padding:8px 0; border-top:1px solid var(--line); }
  li:first-child { border-top:0; }
  .mark { font-weight:700; text-align:center; }
  .pass .mark { color:var(--pass); } .fail .mark { color:var(--fail); } .warn .mark { color:var(--warn); }
  .label { font-weight:600; }
  .detail { overflow-wrap:anywhere; }
  small { display:block; margin-top:4px; color:var(--muted); font-size:.8rem; font-family:ui-monospace, Menlo, Consolas, monospace; }
  code { background:var(--code); padding:1px 5px; border-radius:4px; font-size:.9em; overflow-wrap:anywhere; }
  dl { display:grid; grid-template-columns:max-content 1fr; gap:6px 16px; margin:0; }
  dt { color:var(--muted); } dd { margin:0; overflow-wrap:anywhere; }
  @media (max-width:560px) {
    li { grid-template-columns:1.6em 1fr; } .detail { grid-column:2; }
    dl { grid-template-columns:1fr; } dd { margin-bottom:6px; }
  }
</style>
</head>
<body>
<main>
  <header>
    <h1>CSC3131 · Week 03 visit counter</h1>
    <span class="version">version ${esc(report.version)}</span>
  </header>

  <div class="banner ${report.ok ? 'pass' : 'fail'}">
    ${report.ok ? 'Everything is working.' : 'Not working yet. The setup checklist says what to fix.'}
  </div>

  <section>
    <h2>Visits</h2>
    ${counter}
  </section>

  <section>
    <h2>Setup checklist</h2>
    <ul>
      ${rows.join('\n      ')}
      ${dbRow}
    </ul>
  </section>

  <section>
    <h2>What this request looked like</h2>
    <dl>
      <dt>Container hostname</dt><dd>${shown(r.containerHostname, '(unknown)')}</dd>
      <dt>Connected to the app from</dt><dd>${shown(r.connectedFrom, '(unknown)')}</dd>
      <dt>Your IP (X-Forwarded-For)</dt><dd>${shown(r.visitorIp, '(not sent: no proxy in front of the app)')}</dd>
      <dt>X-Forwarded-Proto</dt><dd>${shown(r.forwardedProto, '(not sent: no proxy in front of the app)')}</dd>
      <dt>Host header</dt><dd>${shown(r.host, '(not sent)')}</dd>
    </dl>
    <p class="muted">Your browser spoke HTTPS to Azure's front end, which forwarded the request to this container over plain HTTP on port 3000.</p>
  </section>
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${ms.toFixed(0)}ms`);
  });
  next();
});

app.get('/', async (req, res) => {
  const report = await buildReport(req);
  res.status(report.ok ? 200 : 503).set('Cache-Control', 'no-store').type('html').send(renderPage(report));
});

app.get('/api', async (req, res) => {
  const report = await buildReport(req);
  res.status(report.ok ? 200 : 503).set('Cache-Control', 'no-store').json(report);
});

app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store').type('text').send('ok');
});

// Never show a stack trace to the browser.
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).type('text').send('Internal error: see the log stream.');
});

function start() {
  const present = SETTINGS_SHOWN_AT_STARTUP.filter((name) => (process.env[name] ?? '').trim() !== '');
  const absent = SETTINGS_SHOWN_AT_STARTUP.filter((name) => !present.includes(name));

  const server = app.listen(PORT, '0.0.0.0', (err) => {
    if (err) throw err;
    console.log(`csc3131-visits version ${APP_VERSION} listening on 0.0.0.0:${PORT}`);
    console.log(`settings present: ${present.join(', ') || '(none)'}; not set: ${absent.join(', ') || '(none)'}; ` +
      `TLS to the database: ${settings.tls ? 'on' : 'off'}`);
  });

  // App Service and docker stop send SIGTERM; finish in-flight requests and exit promptly.
  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    if (pool) pool.end().catch(() => {});
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) start();

module.exports = { app, esc, visitorIp };
