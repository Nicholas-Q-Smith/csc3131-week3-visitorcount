'use strict';

const os = require('node:os');
const express = require('express');
const { Pool } = require('pg');
const { WHERE_TO_ADD, readSettings, preflight, classify, rawMessage } = require('./diagnose');
const notesLib = require('./notes');

const PORT = Number(process.env.PORT) || 3000;
const APP_VERSION = process.env.APP_VERSION || 'dev';
const SETTINGS_SHOWN_AT_STARTUP = ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSSL'];

// App Service restarts the container whenever an environment variable changes,
// so reading the settings once at startup is enough.
const settings = readSettings();
const memoryNotes = notesLib.createMemoryStore();
const noteThrottle = notesLib.createThrottle();

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

let pool = null;
let tablesReady = null;

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
      // A stuck query must not hang the page: the server cancels statements
      // after 5 s, and if the server goes silent pg gives up after 6 s.
      statement_timeout: 5000,
      query_timeout: 6000,
      keepAlive: true,
    });
    // An idle connection dropping (server stopped, network blip) must not crash
    // the app: log it, and the next request simply connects again.
    pool.on('error', (err) => console.error(`database connection dropped: ${rawMessage(err)}`));
  }
  return pool;
}

function ensureTables(db) {
  tablesReady ??= db.query(`
    CREATE TABLE IF NOT EXISTS visits (id serial PRIMARY KEY, visited_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS notes (id serial PRIMARY KEY, text varchar(80) NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
  `);
  return tablesReady;
}

// Records this visit and returns the totals and recent notes, or a diagnosis of
// why it couldn't. Runs on every page load, so a fixed setup is picked up
// without a restart.
async function checkDatabase() {
  const problem = preflight(settings);
  if (problem) return { ok: false, diagnosis: problem, raw: null };

  try {
    const db = getPool();
    await ensureTables(db);
    const { rows: [visit] } = await db.query('INSERT INTO visits DEFAULT VALUES RETURNING visited_at');
    const { rows: [counts] } = await db.query(
      'SELECT (SELECT count(*) FROM visits)::int AS visits, (SELECT count(*) FROM notes)::int AS notes');
    const { rows: notes } = await db.query(
      'SELECT text, created_at AS "createdAt" FROM notes ORDER BY id DESC LIMIT $1', [notesLib.SHOWN]);
    return { ok: true, totalVisits: counts.visits, latestVisit: visit.visited_at, noteCount: counts.notes, notes };
  } catch (err) {
    tablesReady = null; // try CREATE TABLE again next time (e.g. the database was recreated)
    return { ok: false, diagnosis: classify(err, settings), raw: rawMessage(err) };
  }
}

async function insertNoteIntoDatabase(text) {
  try {
    const db = getPool();
    await ensureTables(db);
    await db.query('INSERT INTO notes (text) VALUES ($1)', [text]);
    return true;
  } catch (err) {
    tablesReady = null;
    console.error(`note not saved in the database, keeping it in memory: ${rawMessage(err)}`);
    return false;
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

// The JSON for /api, plus the recent notes the page lists (kept out of /api).
async function buildReport(req) {
  const db = await checkDatabase();
  const report = {
    app: 'csc3131-visits',
    version: APP_VERSION,
    databaseOk: db.ok,
    database: db.ok
      ? { ok: true, totalVisits: db.totalVisits, latestVisit: db.latestVisit.toISOString() }
      : { ok: false, problem: db.diagnosis.kind, cause: db.diagnosis.message, error: db.raw },
    notesStore: db.ok ? 'database' : 'memory',
    noteCount: db.ok ? db.noteCount : memoryNotes.count(),
    checklist: settingsChecklist(),
    request: describeRequest(req),
  };
  return { report, recentNotes: db.ok ? db.notes : memoryNotes.recent(notesLib.SHOWN) };
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

function renderNotes(store, recentNotes, flash) {
  const label = store === 'database'
    ? '<p class="box pass">Saved in the database: survives restarts</p>'
    : '<p class="box warn">Saved in this container only: lost when it restarts</p>';
  const list = recentNotes.length === 0
    ? '<p class="muted">No notes yet.</p>'
    : `<ul class="notes">
      ${recentNotes.map((note) => `<li><time>${esc(formatTime(note.createdAt.toISOString()))}</time>` +
        `<span>${esc(note.text)}</span></li>`).join('\n      ')}
    </ul>`;
  return `${flash ? `<p class="box ${flash.status}" role="status">${esc(flash.text)}</p>` : ''}
    <form method="post" action="/notes">
      <input name="text" maxlength="${notesLib.MAX_LENGTH}" autocomplete="off"
             placeholder="Write a note (up to ${notesLib.MAX_LENGTH} characters)" aria-label="Note">
      <button type="submit">Save</button>
    </form>
    ${label}
    ${list}`;
}

function renderPage(report, { recentNotes = [], flash = null } = {}) {
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
  li { padding:8px 0; border-top:1px solid var(--line); }
  li:first-child { border-top:0; }
  .checks li { display:grid; grid-template-columns:1.6em 11em 1fr; gap:4px 8px; }
  .mark { font-weight:700; text-align:center; }
  .pass .mark { color:var(--pass); } .fail .mark { color:var(--fail); } .warn .mark { color:var(--warn); }
  .label { font-weight:600; }
  .detail { overflow-wrap:anywhere; }
  small { display:block; margin-top:4px; color:var(--muted); font-size:.8rem; font-family:ui-monospace, Menlo, Consolas, monospace; }
  code { background:var(--code); padding:1px 5px; border-radius:4px; font-size:.9em; overflow-wrap:anywhere; }
  form { display:flex; gap:8px; margin:4px 0 12px; }
  input { flex:1; min-width:0; font:inherit; padding:8px 10px; border:1px solid var(--line); border-radius:6px;
          background:var(--bg); color:var(--text); }
  button { font:inherit; font-weight:600; padding:8px 16px; border:0; border-radius:6px; background:var(--text); color:var(--card); cursor:pointer; }
  .box { margin:0 0 12px; padding:8px 12px; border:1px solid; border-radius:6px; font-weight:600; }
  .box.pass { color:var(--pass); background:color-mix(in srgb, var(--pass) 10%, transparent); }
  .box.warn { color:var(--warn); background:color-mix(in srgb, var(--warn) 12%, transparent); }
  .box.fail { color:var(--fail); background:color-mix(in srgb, var(--fail) 10%, transparent); }
  .notes li { display:flex; gap:12px; }
  .notes time { color:var(--muted); font-size:.85rem; white-space:nowrap; padding-top:2px; font-variant-numeric:tabular-nums; }
  .notes span { overflow-wrap:anywhere; }
  dl { display:grid; grid-template-columns:max-content 1fr; gap:6px 16px; margin:0; }
  dt { color:var(--muted); } dd { margin:0; overflow-wrap:anywhere; }
  @media (max-width:560px) {
    .checks li { grid-template-columns:1.6em 1fr; } .detail { grid-column:2; }
    .notes li { flex-direction:column; gap:0; }
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

  <div class="banner ${report.databaseOk ? 'pass' : 'fail'}">
    ${report.databaseOk ? 'Everything is working.' : 'Not working yet. The setup checklist says what to fix.'}
  </div>

  <section>
    <h2>Visits</h2>
    ${counter}
  </section>

  <section>
    <h2>Setup checklist</h2>
    <ul class="checks">
      ${rows.join('\n      ')}
      ${dbRow}
    </ul>
  </section>

  <section>
    <h2>Notes</h2>
    ${renderNotes(report.notesStore, recentNotes, flash)}
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

// Always 200 once the page renders, even with a red checklist: a 503 then only
// ever means the platform couldn't reach the app.
app.get('/', async (req, res) => {
  const { report, recentNotes } = await buildReport(req);
  const key = req.query.note;
  const flash = typeof key === 'string' && Object.hasOwn(notesLib.MESSAGES, key) ? notesLib.MESSAGES[key] : null;
  res.set('Cache-Control', 'no-store').type('html').send(renderPage(report, { recentNotes, flash }));
});

app.get('/api', async (req, res) => {
  const { report } = await buildReport(req);
  res.set('Cache-Control', 'no-store').json(report);
});

// Post/redirect/get: the browser ends up on GET /, so refreshing doesn't resubmit.
app.post('/notes', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
  const note = notesLib.validateNote(req.body && req.body.text);
  let outcome;
  if (!note.ok) {
    outcome = note.error;
  } else if (!noteThrottle()) {
    outcome = 'too-fast';
  } else {
    const store = await notesLib.saveNote(note.text, {
      databaseConfigured: preflight(settings) === null,
      insertIntoDatabase: insertNoteIntoDatabase,
      memory: memoryNotes,
    });
    outcome = `saved-${store}`;
  }
  res.redirect(303, `/?note=${outcome}`);
});

app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store').type('text').send('ok');
});

// Never show a stack trace to the browser.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.status >= 400 && err.status < 500) return res.status(err.status).type('text').send(err.message);
  console.error(err);
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

module.exports = { app, esc, visitorIp, renderPage };
