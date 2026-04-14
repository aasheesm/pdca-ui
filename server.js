'use strict';

const express = require('express');
const Database = require('better-sqlite3');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const PORT = 7010;
const DB_PATH = '/root/data/assistant/tasks.db';
const AUTH_USER = 'ashish@konzult.in';
const AUTH_HASH = '$2a$14$WDKpUrU7Xiu.QWRb4ZFq5.OQjIGCu6HmAl8pBP3Zu9AKhoXrniNsS';

let db;

try {
  db = new Database(DB_PATH, { readonly: true });
  db.pragma('journal_mode = WAL');
} catch (err) {
  console.error('Failed to open database:', err.message);
  process.exit(1);
}

const app = express();

const BetterSqliteStore = require('better-sqlite3-session-store')(session);
const sessionDb = new (require('better-sqlite3'))('/root/data/assistant/pdca-sessions.db');

app.use(cookieParser());
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.PDCA_SESSION_SECRET || 'pdca-dashboard-secret-2026',
  resave: false,
  saveUninitialized: false,
  store: new BetterSqliteStore({ client: sessionDb, expired: { clear: true, intervalMs: 900000 } }),
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path === '/login') return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  res.redirect('/login');
}
app.use(requireAuth);

// Request logger
app.use((req, res, next) => {
  console.log(new Date().toISOString(), req.method, req.url);
  next();
});

// ── Auth Routes ───────────────────────────────────────────────────────────────

app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(LOGIN_HTML);
});

app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const { username, password } = req.body;
  if (username === AUTH_USER && bcrypt.compareSync(password, AUTH_HASH)) {
    req.session.authenticated = true;
    req.session.user = username;
    return res.redirect('/');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(LOGIN_HTML.replace('<!--ERROR-->', '<div class="error">Invalid credentials</div>'));
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ── API Routes ────────────────────────────────────────────────────────────────

app.get('/api/projects', (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT DISTINCT project_id FROM pdca_items ORDER BY project_id'
    ).all();
    res.json(rows.map(r => r.project_id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/performance', (req, res) => {
  try {
    const { project } = req.query;
    let stmt;
    if (project) {
      stmt = db.prepare('SELECT * FROM pdca_performance WHERE project_id = ?');
      res.json(stmt.all(project));
    } else {
      stmt = db.prepare('SELECT * FROM pdca_performance');
      res.json(stmt.all());
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/items', (req, res) => {
  try {
    const { project } = req.query;
    if (!project) return res.status(400).json({ error: 'project param required' });
    const rows = db.prepare(`
      SELECT *,
        CASE priority
          WHEN 'critical' THEN 1
          WHEN 'high'     THEN 2
          WHEN 'medium'   THEN 3
          ELSE 4
        END AS priority_rank
      FROM pdca_items
      WHERE project_id = ?
      ORDER BY priority_rank, created_at
    `).all(project);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions', (req, res) => {
  try {
    const { project } = req.query;
    if (!project) return res.status(400).json({ error: 'project param required' });
    const rows = db.prepare(`
      SELECT * FROM pdca_sessions
      WHERE project_id = ?
      ORDER BY id DESC
      LIMIT 20
    `).all(project);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/next-actions', (req, res) => {
  try {
    const { project } = req.query;
    if (!project) return res.status(400).json({ error: 'project param required' });
    const rows = db.prepare(`
      SELECT * FROM pdca_next_actions
      WHERE project_id = ? AND is_blocked = 0
    `).all(project);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cycles', (req, res) => {
  try {
    const { project, limit } = req.query;
    if (!project) return res.status(400).json({ error: 'project param required' });
    const lim = Math.min(parseInt(limit) || 200, 500);
    const rows = db.prepare(`
      SELECT * FROM pdca_cycles
      WHERE project_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(project, lim);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/file-changes', (req, res) => {
  try {
    const { project, limit } = req.query;
    if (!project) return res.status(400).json({ error: 'project param required' });
    const lim = Math.min(parseInt(limit) || 200, 500);
    const rows = db.prepare(`
      SELECT * FROM pdca_file_changes
      WHERE project_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(project, lim);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Login HTML ────────────────────────────────────────────────────────────────

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PDCA Dashboard — Login</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f1117; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: #1a1d27; border: 1px solid #2d3148; border-radius: 12px; padding: 40px; width: 100%; max-width: 400px; }
  .logo { font-size: 28px; font-weight: 700; color: #3b82f6; margin-bottom: 4px; }
  .sub { color: #64748b; font-size: 14px; margin-bottom: 32px; }
  label { display: block; font-size: 13px; color: #94a3b8; margin-bottom: 6px; }
  input { width: 100%; background: #0f1117; border: 1px solid #2d3148; border-radius: 6px; color: #e2e8f0; font-size: 14px; padding: 10px 12px; outline: none; transition: border-color .2s; }
  input:focus { border-color: #3b82f6; }
  .field { margin-bottom: 18px; }
  button { width: 100%; background: #3b82f6; border: none; border-radius: 6px; color: #fff; cursor: pointer; font-size: 14px; font-weight: 600; padding: 11px; margin-top: 8px; transition: background .2s; }
  button:hover { background: #2563eb; }
  .error { background: #7f1d1d; border: 1px solid #ef4444; border-radius: 6px; color: #fca5a5; font-size: 13px; margin-bottom: 18px; padding: 10px 12px; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">PDCA</div>
  <div class="sub">Dashboard — sign in to continue</div>
  <!--ERROR-->
  <form method="POST" action="/login">
    <div class="field"><label>Email</label><input type="email" name="username" value="ashish@konzult.in" required autocomplete="username"></div>
    <div class="field"><label>Password</label><input type="password" name="password" required autocomplete="current-password" autofocus></div>
    <button type="submit">Sign In</button>
  </form>
</div>
</body>
</html>`;

// ── Dashboard HTML ────────────────────────────────────────────────────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PDCA Dashboard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:        #0f1117;
    --sidebar:   #111827;
    --card:      #1a1d27;
    --thead:     #1e2233;
    --hover:     #252a3a;
    --expand-bg: rgba(19,22,32,0.6);
    --border:    #2d3148;
    --text:      #e2e8f0;
    --muted:     #64748b;
    --blue:      #3b82f6;
    --green:     #22c55e;
    --red:       #ef4444;
    --orange:    #f97316;
    --yellow:    #eab308;
    --purple:    #a855f7;
    --mono:      'JetBrains Mono', 'Fira Code', 'Courier New', monospace;
    --sidebar-w: 240px;
  }

  /* ── Traffic light dots ── */
  .tl-dot {
    display: inline-block;
    width: 16px; height: 16px;
    border-radius: 50%;
    font-size: 16px;
    line-height: 1;
    cursor: default;
  }
  .tl-red    { color: #ef4444; }
  .tl-amber  { color: #eab308; }
  .tl-green  { color: #22c55e; }
  .tl-gray   { color: #64748b; }
  .tl-dark   { color: #374151; }
  .tl-purple { color: #a855f7; }

  /* ── Tabs ── */
  .tab-bar {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border);
    margin-bottom: 14px;
  }
  .tab-btn {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--muted);
    padding: 8px 18px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.12s;
    margin-bottom: -1px;
  }
  .tab-btn:hover { color: var(--text); }
  .tab-btn.active { color: var(--blue); border-bottom-color: var(--blue); }

  /* ── Traffic light filter bar ── */
  .tl-filter-bar {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 14px;
    flex-wrap: wrap;
  }
  .tl-filter-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    background: #1a1d2e;
    border: 1px solid var(--border);
    border-radius: 20px;
    color: var(--muted);
    padding: 6px 14px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }
  .tl-filter-btn:hover { border-color: #4b5563; color: var(--text); background: #1e2235; }
  .tl-filter-btn.tl-active { border-color: #4b5563; color: var(--text); background: #23283d; box-shadow: 0 0 0 1px #4b5563; }
  .tl-meta { display: inline-flex; flex-direction: column; align-items: flex-end; margin-left: 4px; line-height: 1.2; }
  .tl-cnt { font-size: 11px; font-weight: 700; color: var(--text); background: rgba(255,255,255,0.08); border-radius: 8px; padding: 0 5px; min-width: 18px; text-align: center; }
  .tl-filter-btn.tl-active .tl-cnt { background: rgba(255,255,255,0.15); }
  .tl-time-lbl { font-size: 9px; color: var(--muted); white-space: nowrap; }

  /* ── Pagination ── */
  .pagination-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    color: var(--muted);
    gap: 10px;
    flex-wrap: wrap;
  }
  .pg-info { flex: 1; }
  .pg-controls { display: flex; align-items: center; gap: 8px; }
  .pg-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: 5px;
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.12s;
  }
  .pg-btn:hover:not(:disabled) { border-color: var(--blue); color: var(--blue); }
  .pg-btn:disabled { opacity: 0.35; cursor: default; }
  .pg-size-sel {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 5px;
    padding: 4px 8px;
    font-size: 12px;
    cursor: pointer;
  }
  .pg-page-label { font-size: 12px; color: var(--muted); white-space: nowrap; }

  /* ── Activity Feed ── */
  .activity-feed { display: flex; flex-direction: column; gap: 0; }
  .activity-item {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 16px;
    border-bottom: 1px solid rgba(255,255,255,0.04);
    font-size: 13px;
  }
  .activity-item:last-child { border-bottom: none; }
  .activity-time { color: var(--muted); font-size: 11px; white-space: nowrap; min-width: 60px; }
  .activity-project { font-family: var(--mono); font-size: 11px; color: var(--muted); min-width: 100px; }
  .activity-title { flex: 1; color: var(--text); }
  .activity-phase { }

  /* ── Done This Week ── */
  .done-list { display: flex; flex-direction: column; gap: 0; }
  .done-item {
    display: flex; align-items: center; gap: 12px;
    padding: 9px 16px;
    border-bottom: 1px solid rgba(255,255,255,0.04);
    font-size: 13px;
  }
  .done-item:last-child { border-bottom: none; }
  .done-check { color: var(--green); font-size: 15px; flex-shrink: 0; }
  .done-title { flex: 1; color: var(--text); }
  .done-meta { color: var(--muted); font-size: 11px; white-space: nowrap; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px;
    line-height: 1.5;
    min-height: 100vh;
    display: flex;
  }

  /* ── Sidebar ── */
  #sidebar {
    width: var(--sidebar-w);
    min-width: var(--sidebar-w);
    background: var(--sidebar);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    height: 100vh;
    position: sticky;
    top: 0;
    overflow: hidden;
    transition: width 0.2s ease, min-width 0.2s ease;
    z-index: 200;
  }
  #sidebar.collapsed {
    width: 56px;
    min-width: 56px;
  }
  .sb-logo {
    padding: 18px 16px 14px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .sb-logo .logo-full { display: flex; align-items: baseline; gap: 6px; }
  .sb-logo .logo-abbr { display: none; font-size: 18px; font-weight: 800; color: var(--blue); }
  #sidebar.collapsed .logo-full { display: none; }
  #sidebar.collapsed .logo-abbr { display: block; }
  .logo-pdca {
    font-size: 20px;
    font-weight: 800;
    letter-spacing: -0.5px;
    color: var(--blue);
  }
  .logo-sub {
    font-size: 11px;
    color: var(--muted);
    font-weight: 500;
    letter-spacing: 0.5px;
  }
  .sb-project {
    padding: 12px 12px 8px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .sb-project label {
    display: block;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.8px;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 6px;
  }
  #sidebar.collapsed .sb-project label { display: none; }
  #sidebar.collapsed .sb-project { padding: 8px; }
  select {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 13px;
    cursor: pointer;
    outline: none;
    width: 100%;
  }
  select:focus { border-color: var(--blue); }
  #sidebar.collapsed #projectSelect { display: none; }
  .sb-nav {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
  }
  .nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    cursor: pointer;
    border-left: 3px solid transparent;
    color: var(--muted);
    font-size: 13px;
    font-weight: 500;
    transition: all 0.12s;
    white-space: nowrap;
    overflow: hidden;
  }
  .nav-item:hover { background: rgba(255,255,255,0.04); color: var(--text); }
  .nav-item.active {
    border-left-color: var(--blue);
    background: rgba(59,130,246,0.08);
    color: var(--text);
  }
  .nav-item .nav-icon { font-size: 16px; flex-shrink: 0; width: 20px; text-align: center; }
  .nav-item .nav-label { }
  #sidebar.collapsed .nav-label { display: none; }
  #sidebar.collapsed .nav-item { padding: 10px; justify-content: center; border-left: none; border-right: 3px solid transparent; }
  #sidebar.collapsed .nav-item.active { border-right-color: var(--blue); background: rgba(59,130,246,0.08); }
  .sb-footer {
    padding: 10px 12px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }
  .collapse-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: 6px;
    padding: 7px 10px;
    font-size: 12px;
    cursor: pointer;
    width: 100%;
    transition: all 0.12s;
    white-space: nowrap;
    overflow: hidden;
  }
  .collapse-btn:hover { border-color: var(--blue); color: var(--blue); }
  #sidebar.collapsed .collapse-btn { justify-content: center; padding: 7px; }
  #sidebar.collapsed .collapse-label { display: none; }

  /* ── Main wrapper ── */
  #app {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
  }

  /* ── Top bar ── */
  .topbar {
    background: var(--card);
    border-bottom: 1px solid var(--border);
    padding: 0 24px;
    height: 56px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky;
    top: 0;
    z-index: 100;
    flex-shrink: 0;
  }
  .topbar-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .page-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--text);
  }
  .topbar-right {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .topbar-meta {
    font-size: 12px;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .refresh-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .refresh-btn:hover { border-color: var(--blue); color: var(--blue); }
  .auto-refresh-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
    cursor: pointer;
    user-select: none;
  }
  .toggle-switch {
    width: 32px; height: 18px;
    background: var(--border);
    border-radius: 9px;
    position: relative;
    transition: background 0.15s;
    cursor: pointer;
  }
  .toggle-switch.on { background: var(--blue); }
  .toggle-switch::after {
    content: '';
    width: 12px; height: 12px;
    background: #fff;
    border-radius: 50%;
    position: absolute;
    top: 3px; left: 3px;
    transition: left 0.15s;
  }
  .toggle-switch.on::after { left: 17px; }
  .countdown-badge {
    font-size: 11px;
    background: rgba(59,130,246,0.12);
    color: var(--blue);
    border-radius: 4px;
    padding: 2px 6px;
    font-family: var(--mono);
  }
  .spinning { animation: spin 0.7s linear infinite; display: inline-block; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Page content ── */
  #pageContent {
    flex: 1;
    padding: 24px;
    overflow-y: auto;
  }

  /* ── Toast ── */
  #toast {
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: var(--red);
    color: #fff;
    padding: 10px 18px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    z-index: 9999;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s;
  }
  #toast.show { opacity: 1; }

  /* ── Filter bar ── */
  .filter-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: flex-start;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 16px;
    margin-bottom: 16px;
  }
  .filter-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .filter-group label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.7px;
    text-transform: uppercase;
    color: var(--muted);
  }
  .filter-group input[type="text"],
  .filter-group input[type="date"],
  .filter-group select {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 13px;
    outline: none;
    width: auto;
    min-width: 140px;
  }
  .filter-group input:focus,
  .filter-group select:focus { border-color: var(--blue); }
  .check-group {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 2px;
  }
  .check-pill {
    display: flex;
    align-items: center;
    gap: 4px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 3px 10px;
    font-size: 12px;
    cursor: pointer;
    user-select: none;
    color: var(--muted);
    transition: all 0.12s;
  }
  .check-pill input { display: none; }
  .check-pill.checked { border-color: var(--blue); color: var(--text); background: rgba(59,130,246,0.1); }
  .clear-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 12px;
    cursor: pointer;
    align-self: flex-end;
    transition: all 0.12s;
  }
  .clear-btn:hover { border-color: var(--red); color: var(--red); }
  .result-count {
    font-size: 12px;
    color: var(--muted);
    margin-bottom: 8px;
  }

  /* ── Table ── */
  .table-wrap {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }
  .table-toolbar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding: 8px 14px;
    border-bottom: 1px solid var(--border);
    gap: 10px;
  }
  .col-toggle-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: 6px;
    padding: 5px 10px;
    font-size: 12px;
    cursor: pointer;
    position: relative;
    transition: all 0.12s;
  }
  .col-toggle-btn:hover { border-color: var(--blue); color: var(--blue); }
  .col-dropdown {
    position: absolute;
    right: 0; top: calc(100% + 4px);
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 0;
    min-width: 160px;
    z-index: 500;
    display: none;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  }
  .col-dropdown.open { display: block; }
  .col-dropdown label {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    font-size: 13px;
    color: var(--text);
    cursor: pointer;
    transition: background 0.1s;
  }
  .col-dropdown label:hover { background: rgba(255,255,255,0.04); }
  .density-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: 6px;
    padding: 5px 10px;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.12s;
  }
  .density-btn:hover { border-color: var(--blue); color: var(--blue); }
  .table-scroll { overflow-x: auto; max-height: calc(100vh - 280px); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead th {
    background: var(--thead);
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.7px;
    text-transform: uppercase;
    padding: 10px 14px;
    text-align: left;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
    position: sticky;
    top: 0;
    z-index: 10;
    cursor: pointer;
    user-select: none;
  }
  thead th:hover { color: var(--text); }
  thead th.sort-asc::after { content: ' ▲'; font-size: 9px; }
  thead th.sort-desc::after { content: ' ▼'; font-size: 9px; }
  tbody tr { border-bottom: 1px solid rgba(255,255,255,0.04); transition: background 0.1s; }
  tbody tr:last-child { border-bottom: none; }
  tbody tr:hover { background: var(--hover); }
  td { padding: 10px 14px; vertical-align: top; color: var(--text); }
  table.compact td { padding: 6px 14px; }
  table.comfortable td { padding: 14px 14px; }
  td.mono { font-family: var(--mono); font-size: 12px; color: var(--muted); }
  td.dim  { color: var(--muted); }
  .col-hidden { display: none; }

  /* ── Expand rows ── */
  .expand-row td { background: var(--expand-bg); padding: 16px 20px; }
  .expand-row { display: none; }
  .expand-row.open { display: table-row; }
  .expand-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
  .expand-field label {
    display: block; font-size: 10px; font-weight: 600; letter-spacing: 0.8px;
    text-transform: uppercase; color: var(--muted); margin-bottom: 4px;
  }
  .expand-field p { font-size: 13px; color: var(--text); white-space: pre-wrap; word-break: break-word; }
  .expand-field.errors p { color: var(--red); }
  .clickable-row { cursor: pointer; }

  /* ── Badges ── */
  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 4px;
    font-size: 11px; font-weight: 600; letter-spacing: 0.3px; text-transform: uppercase;
  }
  .badge-critical { background: rgba(239,68,68,0.15); color: var(--red); }
  .badge-high     { background: rgba(249,115,22,0.15); color: var(--orange); }
  .badge-medium   { background: rgba(234,179,8,0.15); color: var(--yellow); }
  .badge-low      { background: rgba(100,116,139,0.15); color: var(--muted); }
  .badge-complete    { background: rgba(34,197,94,0.15); color: var(--green); }
  .badge-in-progress { background: rgba(59,130,246,0.15); color: var(--blue); }
  .badge-queued      { background: rgba(168,85,247,0.15); color: var(--purple); }
  .badge-open        { background: rgba(100,116,139,0.15); color: var(--muted); }
  .badge-blocked     { background: rgba(239,68,68,0.15); color: var(--red); }
  .badge-cancelled   { background: rgba(100,116,139,0.1); color: var(--muted); text-decoration: line-through; }
  .badge-pass    { background: rgba(34,197,94,0.15); color: var(--green); }
  .badge-fail    { background: rgba(239,68,68,0.15); color: var(--red); }
  .badge-partial { background: rgba(234,179,8,0.15); color: var(--yellow); }
  .badge-blocked-out { background: rgba(239,68,68,0.15); color: var(--red); }
  .badge-skipped { background: rgba(100,116,139,0.1); color: var(--muted); }
  .badge-plan  { background: rgba(168,85,247,0.15); color: var(--purple); }
  .badge-do    { background: rgba(59,130,246,0.15); color: var(--blue); }
  .badge-check { background: rgba(234,179,8,0.15); color: var(--yellow); }
  .badge-act   { background: rgba(34,197,94,0.15); color: var(--green); }
  .badge-ready { background: rgba(34,197,94,0.15); color: var(--green); }
  .badge-num   { background: rgba(59,130,246,0.12); color: var(--blue); border-radius: 12px; }

  /* ── Misc ── */
  .loading { display: flex; align-items: center; justify-content: center; padding: 60px; color: var(--muted); gap: 12px; }
  .spinner { width: 20px; height: 20px; border: 2px solid var(--border); border-top-color: var(--blue); border-radius: 50%; animation: spin 0.7s linear infinite; }
  .no-data { padding: 32px; text-align: center; color: var(--muted); font-size: 13px; }
  .tag { display: inline-block; padding: 1px 7px; border-radius: 3px; font-size: 11px; background: rgba(255,255,255,0.07); color: var(--muted); font-family: var(--mono); }
  .section { margin-bottom: 28px; }
  .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .section-title { font-size: 14px; font-weight: 600; color: var(--text); display: flex; align-items: center; gap: 8px; }
  .section-title .count { background: var(--border); color: var(--muted); border-radius: 12px; padding: 1px 8px; font-size: 11px; }
  .view-all { font-size: 12px; color: var(--blue); cursor: pointer; text-decoration: none; }
  .view-all:hover { text-decoration: underline; }
  .empty-state { text-align: center; padding: 80px 24px; color: var(--muted); }
  .empty-state .icon { font-size: 48px; margin-bottom: 16px; }
  .empty-state h2 { font-size: 18px; color: var(--text); margin-bottom: 8px; }

  /* ── Overview: perf cards ── */
  .perf-projects { display: flex; flex-direction: column; gap: 14px; margin-bottom: 28px; }
  .perf-card {
    background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px 20px;
  }
  .perf-card-header { font-size: 13px; font-weight: 600; color: var(--text); margin-bottom: 12px; }
  .perf-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
  .perf-chip {
    display: flex; flex-direction: column; align-items: center; min-width: 72px;
    background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px;
  }
  .perf-chip .chip-val { font-size: 22px; font-weight: 700; line-height: 1; }
  .perf-chip .chip-lbl { font-size: 10px; color: var(--muted); font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; margin-top: 3px; }
  .perf-chip.green .chip-val { color: var(--green); }
  .perf-chip.blue .chip-val { color: var(--blue); }
  .perf-chip.gray .chip-val { color: var(--muted); }
  .perf-chip.red .chip-val { color: var(--red); }
  .perf-chip.default .chip-val { color: var(--text); }
  .progress-bar-wrap { background: var(--border); border-radius: 4px; height: 6px; overflow: hidden; }
  .progress-bar-fill { height: 100%; border-radius: 4px; background: var(--green); transition: width 0.4s ease; }
  .progress-pct { font-size: 11px; color: var(--muted); margin-top: 4px; }

  /* ── Mobile sidebar backdrop ── */
  #sidebarBackdrop {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.5);
    z-index: 199;
  }
  #sidebarBackdrop.visible { display: block; }

  /* ── Hamburger button ── */
  #hamburgerBtn {
    display: none;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    transition: all 0.12s;
    margin-right: 6px;
  }
  #hamburgerBtn:hover { border-color: var(--blue); color: var(--blue); }

  /* ── Responsive ── */
  @media (max-width: 768px) {
    body { font-size: 13px; }

    /* Sidebar: off-canvas by default */
    #sidebar {
      position: fixed;
      top: 0; left: 0;
      height: 100vh;
      width: var(--sidebar-w) !important;
      min-width: var(--sidebar-w) !important;
      transform: translateX(-100%);
      transition: transform 0.22s ease, width 0.2s ease, min-width 0.2s ease;
      z-index: 200;
    }
    #sidebar.mobile-open {
      transform: translateX(0);
    }
    /* Keep desktop collapsed class non-breaking on mobile */
    #sidebar.collapsed {
      width: var(--sidebar-w) !important;
      min-width: var(--sidebar-w) !important;
    }
    #sidebar .logo-full { display: flex !important; }
    #sidebar .logo-abbr { display: none !important; }
    #sidebar .nav-label { display: inline !important; }
    #sidebar .nav-item { padding: 10px 14px; justify-content: flex-start; }
    #sidebar .sb-project label { display: block !important; }
    #sidebar #projectSelect { display: block !important; }
    #sidebar .collapse-label { display: inline !important; }
    .collapse-btn { justify-content: flex-start; padding: 7px 10px; }

    /* Show hamburger button */
    #hamburgerBtn { display: inline-flex; align-items: center; }

    /* Main content: no left margin offset */
    #app { margin-left: 0 !important; }

    /* Top bar: allow wrapping */
    .topbar { padding: 0 12px; height: auto; min-height: 56px; flex-wrap: wrap; gap: 6px; padding-top: 8px; padding-bottom: 8px; }
    .topbar-right { flex-wrap: wrap; gap: 8px; }
    .topbar-meta { flex-wrap: wrap; }

    /* Page title: single line with ellipsis */
    .page-title { font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px; }

    /* Performance cards: one per row */
    .perf-projects { flex-direction: column; }

    /* Table scroll */
    .table-scroll { max-height: none; overflow-x: auto; }
    table { min-width: 600px; }
    table.compact td { padding: 5px 10px; }

    /* Pagination: stack info above controls */
    .pagination-bar { flex-direction: column; align-items: center; text-align: center; }
    .pg-info { flex: none; width: 100%; text-align: center; }
    .pg-controls { justify-content: center; }

    /* Filter bar: wrap into 2-column grid */
    .filter-bar { flex-wrap: wrap; }
    .filter-group { min-width: 140px; flex: 1 1 140px; }
    .filter-group input[type="text"],
    .filter-group input[type="date"],
    .filter-group select { width: 100%; }

    /* Page content padding */
    #pageContent { padding: 14px; }
  }

  @media (max-width: 480px) {
    .filter-group { min-width: 100%; flex: 1 1 100%; }
    .page-title { max-width: 110px; }
    .topbar-right { gap: 6px; }
  }
</style>
</head>
<body>

<!-- Mobile sidebar backdrop -->
<div id="sidebarBackdrop"></div>

<!-- Sidebar -->
<aside id="sidebar">
  <div class="sb-logo">
    <div class="logo-full">
      <span class="logo-pdca">PDCA</span>
      <span class="logo-sub">Dashboard</span>
    </div>
    <div class="logo-abbr">P</div>
  </div>
  <div class="sb-project">
    <label>Project</label>
    <select id="projectSelect"><option value="">— select —</option></select>
  </div>
  <nav class="sb-nav" id="sbNav">
    <div class="nav-item active" data-page="overview"><span class="nav-icon">📊</span><span class="nav-label">Overview</span></div>
    <div class="nav-item" data-page="items"><span class="nav-icon">🗂</span><span class="nav-label">Items</span></div>
    <div class="nav-item" data-page="gantt"><span class="nav-icon">📅</span><span class="nav-label">Gantt</span></div>
    <div class="nav-item" data-page="sessions"><span class="nav-icon">📋</span><span class="nav-label">Sessions</span></div>
    <div class="nav-item" data-page="cycles"><span class="nav-icon">🔄</span><span class="nav-label">Cycles</span></div>
    <div class="nav-item" data-page="file-changes"><span class="nav-icon">📁</span><span class="nav-label">File Changes</span></div>
  </nav>
  <div class="sb-footer">
    <button class="collapse-btn" id="collapseBtn">
      <span>◀</span><span class="collapse-label"> Collapse</span>
    </button>
  </div>
</aside>

<!-- Main app -->
<div id="app">
  <div class="topbar">
    <div class="topbar-left">
      <button id="hamburgerBtn" aria-label="Open navigation">☰</button>
      <span class="page-title" id="pageTitle">Overview</span>
      <span id="fetchSpinner" style="display:none;color:var(--muted);font-size:12px">⟳ Refreshing…</span>
    </div>
    <div class="topbar-right">
      <div class="topbar-meta">
        <span id="lastUpdated"></span>
        <span id="countdownBadge" class="countdown-badge" style="display:none"></span>
      </div>
      <div class="auto-refresh-toggle" id="arToggle" title="Auto-refresh every 60s">
        <div class="toggle-switch on" id="arSwitch"></div>
        <span style="font-size:12px;color:var(--muted)">Auto</span>
      </div>
      <button class="refresh-btn" id="refreshBtn">⟳ Refresh</button>
      <a href="/logout" style="font-size:12px;color:#64748b;text-decoration:none;padding:6px 10px;border:1px solid #2d3148;border-radius:6px;white-space:nowrap;" onmouseover="this.style.color='#e2e8f0';this.style.borderColor='#64748b'" onmouseout="this.style.color='#64748b';this.style.borderColor='#2d3148'">Sign out</a>
    </div>
  </div>
  <div id="pageContent">
    <div class="empty-state">
      <div class="icon">📊</div>
      <h2>Select a project to get started</h2>
      <p>Choose a project from the sidebar dropdown.</p>
    </div>
  </div>
</div>

<div id="toast"></div>

<script>
// ── Fetch helper (always send credentials for basic-auth) ────────────────────
function apiFetch(url) {
  return fetch(url, { credentials: 'include' }).then(r => {
    if (r.status === 401) { window.location.href = '/login'; throw new Error('unauthenticated'); }
    if (!r.ok) throw new Error('HTTP ' + r.status + ' on ' + url);
    return r.json();
  });
}

// ── State ─────────────────────────────────────────────────────────────────────
let currentProject = null;
let currentPage = 'overview';
let autoRefresh = true;
let refreshTimer = null;
let countdownTimer = null;
let countdownSecs = 60;

const PAGE_TITLES = {
  overview: 'Overview', items: 'Items',
  sessions: 'Sessions',
  cycles: 'Cycles', 'file-changes': 'File Changes'
};

// Per-page cached data
const cache = {};

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function fmt(v, fallback) {
  if (fallback === undefined) fallback = '—';
  return (v === null || v === undefined || v === '') ? fallback : v;
}
function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d)) return v;
  return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'2-digit' })
    + ' ' + d.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12:false });
}
function fmtDateShort(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d)) return v;
  return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'2-digit' });
}
function timeAgo(str) {
  if (!str) return '—';
  // SQLite stores without 'Z'; treat as UTC
  const secs = Math.floor((Date.now() - new Date(str.includes('T') ? str + (str.endsWith('Z') ? '' : 'Z') : str + 'T00:00:00Z').getTime()) / 1000);
  if (isNaN(secs) || secs < 0) return fmtDate(str);
  if (secs < 60) return 'just now';
  if (secs < 3600) return Math.floor(secs/60) + 'm ago';
  if (secs < 86400) return Math.floor(secs/3600) + 'h ago';
  if (secs < 604800) return Math.floor(secs/86400) + 'd ago';
  return new Date(str).toLocaleDateString();
}
function timeAgoCell(v) {
  if (!v) return '<span style="color:var(--muted)">—</span>';
  return '<span title="' + esc(fmtDate(v)) + '">' + esc(timeAgo(v)) + '</span>';
}
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function trunc(s, n) {
  if (!s) return '—';
  s = String(s);
  return s.length > n ? s.substring(0, n) + '…' : s;
}
function truncMiddle(s, n) {
  if (!s) return '—';
  if (s.length <= n) return s;
  const keep = Math.floor((n - 3) / 2);
  return '…' + s.slice(-keep);
}
function parseArr(v) {
  if (!v) return [];
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; }
  catch { return typeof v === 'string' ? [v] : []; }
}

function priorityBadge(p) {
  const m = { critical:'badge-critical', high:'badge-high', medium:'badge-medium', low:'badge-low' };
  return '<span class="badge ' + (m[p]||'badge-low') + '">' + esc(p||'—') + '</span>';
}
function statusBadge(s) {
  const m = { complete:'badge-complete', 'in-progress':'badge-in-progress', queued:'badge-queued', open:'badge-open', blocked:'badge-blocked', cancelled:'badge-cancelled' };
  return '<span class="badge ' + (m[s]||'badge-open') + '">' + esc(s||'—') + '</span>';
}
function outcomeBadge(o) {
  const m = { pass:'badge-pass', fail:'badge-fail', partial:'badge-partial', blocked:'badge-blocked-out', skipped:'badge-skipped' };
  if (!o) return '<span style="color:var(--muted)">—</span>';
  return '<span class="badge ' + (m[o]||'badge-open') + '">' + esc(o) + '</span>';
}
function phaseBadge(p) {
  const m = { plan:'badge-plan', do:'badge-do', check:'badge-check', act:'badge-act' };
  return '<span class="badge ' + (m[p]||'badge-plan') + '">' + esc(p||'—') + '</span>';
}

function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 4000);
}

function setFetching(on) {
  $('fetchSpinner').style.display = on ? 'inline' : 'none';
}

function updateLastUpdated() {
  const now = new Date().toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
  $('lastUpdated').textContent = 'Updated ' + now;
}

// ── Sidebar collapse ──────────────────────────────────────────────────────────
(function initSidebar() {
  const sb = $('sidebar');
  const btn = $('collapseBtn');
  const collapsed = localStorage.getItem('sb-collapsed') === '1';
  if (collapsed) sb.classList.add('collapsed');
  btn.addEventListener('click', () => {
    sb.classList.toggle('collapsed');
    localStorage.setItem('sb-collapsed', sb.classList.contains('collapsed') ? '1' : '0');
  });
})();

// ── Mobile sidebar open/close ─────────────────────────────────────────────────
(function initMobileSidebar() {
  const sb = $('sidebar');
  const backdrop = $('sidebarBackdrop');
  const hamburger = $('hamburgerBtn');

  function openSidebar() {
    sb.classList.add('mobile-open');
    backdrop.classList.add('visible');
    document.body.style.overflow = 'hidden';
  }

  function closeSidebar() {
    sb.classList.remove('mobile-open');
    backdrop.classList.remove('visible');
    document.body.style.overflow = '';
  }

  hamburger.addEventListener('click', openSidebar);
  backdrop.addEventListener('click', closeSidebar);

  // Close sidebar when a nav item is tapped on mobile
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      if (window.innerWidth <= 768) closeSidebar();
    });
  });
})();

// ── Auto-refresh ──────────────────────────────────────────────────────────────
function startCountdown() {
  clearInterval(countdownTimer);
  countdownSecs = 60;
  const badge = $('countdownBadge');
  badge.style.display = 'inline';
  badge.textContent = '60s';
  countdownTimer = setInterval(() => {
    countdownSecs--;
    badge.textContent = countdownSecs + 's';
    if (countdownSecs <= 0) {
      if (autoRefresh && currentProject) loadPage(currentPage);
      countdownSecs = 60;
    }
  }, 1000);
}

function stopCountdown() {
  clearInterval(countdownTimer);
  $('countdownBadge').style.display = 'none';
}

$('arToggle').addEventListener('click', () => {
  autoRefresh = !autoRefresh;
  const sw = $('arSwitch');
  sw.classList.toggle('on', autoRefresh);
  if (autoRefresh) startCountdown(); else stopCountdown();
});

$('refreshBtn').addEventListener('click', () => {
  if (currentProject) loadPage(currentPage);
});

// ── Navigation ────────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const page = item.dataset.page;
    navigateTo(page);
  });
});

function navigateTo(page) {
  if (!currentProject && page !== 'overview') {
    showToast('Select a project first');
    return;
  }
  currentPage = page;
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.page === page);
  });
  $('pageTitle').textContent = PAGE_TITLES[page] || page;
  try { history.pushState({page}, '', '/' + (page === 'overview' ? '' : page)); } catch(e) {}
  loadPage(page);
}

// ── Project select ────────────────────────────────────────────────────────────
async function loadProjects() {
  try {
    const projects = await apiFetch('/api/projects');
    const sel = $('projectSelect');
    projects.forEach(p => {
      const opt = document.createElement('option');
      opt.value = opt.textContent = p;
      sel.appendChild(opt);
    });
    // Restore saved project from last session, then fall back to auto-select for single project
    const saved = localStorage.getItem('pdca-project');
    if (saved && projects.includes(saved)) {
      sel.value = saved;
      onProjectChange();
    } else if (projects.length === 1) {
      sel.value = projects[0];
      onProjectChange();
    }
  } catch(e) {
    showToast('Failed to load projects');
  }
}

function onProjectChange() {
  currentProject = $('projectSelect').value;
  if (!currentProject) return;
  localStorage.setItem('pdca-project', currentProject);
  Object.keys(cache).forEach(k => delete cache[k]);
  loadPage(currentPage);
  if (autoRefresh) startCountdown(); else stopCountdown();
}

$('projectSelect').addEventListener('change', onProjectChange);

// ── Page loader ───────────────────────────────────────────────────────────────
async function loadPage(page) {
  if (!currentProject) return;
  setFetching(true);
  try {
    const p = encodeURIComponent(currentProject);
    if (page === 'overview') {
      const [perf, items, cycles] = await Promise.all([
        apiFetch('/api/performance'),
        apiFetch('/api/items?project=' + p),
        apiFetch('/api/cycles?project=' + p + '&limit=200'),
      ]);
      cache.overviewPerf = perf;
      cache.items = items;
      cache.cycles = cycles;
      renderOverview(perf, items, cycles);
    } else if (page === 'items') {
      // Fetch all items; derive is_blocked client-side
      const data = await apiFetch('/api/items?project=' + p);
      cache.items = data;
      renderItemsPage(data);
    } else if (page === 'sessions') {
      const data = await apiFetch('/api/sessions?project=' + p);
      cache.sessions = data;
      renderSessionsPage(data);
    } else if (page === 'cycles') {
      const data = await apiFetch('/api/cycles?project=' + p + '&limit=200');
      cache.cycles = data;
      renderCyclesPage(data);
    } else if (page === 'gantt') {
      const data = cache.items || await apiFetch('/api/items?project=' + p);
      cache.items = data;
      renderGanttPage(data);
    } else if (page === 'file-changes') {
      const data = await apiFetch('/api/file-changes?project=' + p + '&limit=200');
      cache['file-changes'] = data;
      renderFileChangesPage(data);
    }
    updateLastUpdated();
    if (autoRefresh) { countdownSecs = 60; }
  } catch(e) {
    showToast('Failed to load data');
    $('pageContent').innerHTML = '<div class="empty-state"><div class="icon">⚠️</div><h2>Error loading data</h2><p>' + esc(e.message) + '</p></div>';
  } finally {
    setFetching(false);
  }
}

// ── Sorting ───────────────────────────────────────────────────────────────────
// sortState per page: { col: string|null, dir: 'asc'|'desc'|null }
const sortState = {};

function sortData(data, col, dir) {
  if (!col || !dir) return data;
  return [...data].sort((a, b) => {
    let av = a[col], bv = b[col];
    if (av === null || av === undefined) av = '';
    if (bv === null || bv === undefined) bv = '';
    if (typeof av === 'number' && typeof bv === 'number') {
      return dir === 'asc' ? av - bv : bv - av;
    }
    av = String(av).toLowerCase();
    bv = String(bv).toLowerCase();
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}

function attachSortHeaders(tableId, page, rerender) {
  const tbl = document.getElementById(tableId);
  if (!tbl) return;
  tbl.querySelectorAll('thead th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      const st = sortState[page] || { col: null, dir: null };
      if (st.col === col) {
        if (st.dir === 'asc') sortState[page] = { col, dir: 'desc' };
        else if (st.dir === 'desc') sortState[page] = { col: null, dir: null };
        else sortState[page] = { col, dir: 'asc' };
      } else {
        sortState[page] = { col, dir: 'asc' };
      }
      rerender();
    });
  });
}

function applyThSortClasses(tableId, page) {
  const tbl = document.getElementById(tableId);
  if (!tbl) return;
  const st = sortState[page] || {};
  tbl.querySelectorAll('thead th[data-col]').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.col === st.col) {
      if (st.dir === 'asc') th.classList.add('sort-asc');
      else if (st.dir === 'desc') th.classList.add('sort-desc');
    }
  });
}

// ── Column visibility ─────────────────────────────────────────────────────────
const colVis = {};

function initColVis(tableId, cols) {
  const saved = localStorage.getItem('colvis-' + tableId);
  if (saved) {
    try { colVis[tableId] = JSON.parse(saved); } catch(e) { colVis[tableId] = {}; }
  } else {
    colVis[tableId] = {};
    cols.forEach(c => { colVis[tableId][c.key] = true; });
  }
  // Ensure new cols default to visible
  cols.forEach(c => {
    if (colVis[tableId][c.key] === undefined) colVis[tableId][c.key] = true;
  });
}

function saveColVis(tableId) {
  localStorage.setItem('colvis-' + tableId, JSON.stringify(colVis[tableId]));
}

function applyColVis(tableId) {
  const tbl = document.getElementById(tableId);
  if (!tbl) return;
  const vis = colVis[tableId] || {};
  tbl.querySelectorAll('[data-col-key]').forEach(el => {
    el.classList.toggle('col-hidden', !vis[el.dataset.colKey]);
  });
}

function makeColToggleDropdown(tableId, cols, onToggle) {
  const vis = colVis[tableId] || {};
  const items = cols.map(c =>
    '<label><input type="checkbox" data-col="' + c.key + '" ' + (vis[c.key] ? 'checked' : '') + '> ' + esc(c.label) + '</label>'
  ).join('');
  const html = '<div style="position:relative;display:inline-block">'
    + '<button class="col-toggle-btn" onclick="this.nextSibling.classList.toggle(\\'open\\')">Columns ▾</button>'
    + '<div class="col-dropdown" id="coldrop-' + tableId + '">' + items + '</div>'
    + '</div>';
  return html;
}

function attachColDropdown(tableId, cols, onToggle) {
  const drop = document.getElementById('coldrop-' + tableId);
  if (!drop) return;
  drop.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => {
      colVis[tableId][cb.dataset.col] = cb.checked;
      saveColVis(tableId);
      applyColVis(tableId);
    });
  });
  document.addEventListener('click', function handler(e) {
    if (!drop.contains(e.target) && !drop.previousSibling.contains(e.target)) {
      drop.classList.remove('open');
    }
  }, { capture: true });
}

// ── Density toggle ────────────────────────────────────────────────────────────
const densityState = {};

function makeDensityBtn(tableId) {
  const d = densityState[tableId] || localStorage.getItem('density-' + tableId) || 'normal';
  densityState[tableId] = d;
  return '<button class="density-btn" id="densitybtn-' + tableId + '" onclick="cycleDensity(\\'' + tableId + '\\')">'
    + (d === 'compact' ? 'Compact' : d === 'comfortable' ? 'Comfortable' : 'Normal') + '</button>';
}

function cycleDensity(tableId) {
  const cur = densityState[tableId] || 'normal';
  const next = cur === 'normal' ? 'compact' : cur === 'compact' ? 'comfortable' : 'normal';
  densityState[tableId] = next;
  localStorage.setItem('density-' + tableId, next);
  const tbl = document.getElementById(tableId);
  if (tbl) { tbl.classList.remove('compact','comfortable'); if (next !== 'normal') tbl.classList.add(next); }
  const btn = document.getElementById('densitybtn-' + tableId);
  if (btn) btn.textContent = next.charAt(0).toUpperCase() + next.slice(1);
}

function applyDensity(tableId) {
  const d = densityState[tableId] || localStorage.getItem('density-' + tableId) || 'normal';
  densityState[tableId] = d;
  const tbl = document.getElementById(tableId);
  if (tbl) { tbl.classList.remove('compact','comfortable'); if (d !== 'normal') tbl.classList.add(d); }
}

// ── Expand rows ───────────────────────────────────────────────────────────────
function attachExpand(tableEl) {
  if (!tableEl) return;
  tableEl.querySelectorAll('.clickable-row').forEach(row => {
    row.addEventListener('click', () => {
      const expandRow = document.getElementById(row.dataset.expand);
      if (expandRow) expandRow.classList.toggle('open');
    });
  });
}

// ── Result count ──────────────────────────────────────────────────────────────
function resultCount(shown, total, containerId) {
  const el = document.getElementById(containerId);
  if (el) el.textContent = 'Showing ' + shown + ' of ' + total;
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE: Overview
// ─────────────────────────────────────────────────────────────────────────────
function trafficDot(isBlocked, completionPct, inProgressCount) {
  if (isBlocked) return '<span class="tl-dot tl-red" title="Has blocked items">●</span>';
  if (completionPct >= 80) return '<span class="tl-dot tl-green" title="On track (≥80% complete)">●</span>';
  if (completionPct < 50 && inProgressCount > 0) return '<span class="tl-dot tl-amber" title="In progress, <50% complete">●</span>';
  return '<span class="tl-dot tl-gray" title="Not yet started or moderate progress">●</span>';
}

function renderOverview(perf, items, cycles) {
  // Performance cards — all projects
  const perfCards = perf.map(p => {
    const pct = p.completion_pct || 0;
    const dot = trafficDot(p.blocked > 0, pct, p.in_progress || 0);
    return '<div class="perf-card">'
      + '<div class="perf-card-header">' + dot + ' ' + esc(p.project_id) + '</div>'
      + '<div class="perf-chips">'
      + '<div class="perf-chip default"><span class="chip-val">' + fmt(p.total_items, 0) + '</span><span class="chip-lbl">Total</span></div>'
      + '<div class="perf-chip green"><span class="chip-val">' + fmt(p.completed, 0) + '</span><span class="chip-lbl">Done</span></div>'
      + '<div class="perf-chip blue"><span class="chip-val">' + fmt(p.in_progress, 0) + '</span><span class="chip-lbl">Active</span></div>'
      + '<div class="perf-chip gray"><span class="chip-val">' + fmt(p.open_items, 0) + '</span><span class="chip-lbl">Open</span></div>'
      + '<div class="perf-chip red"><span class="chip-val">' + fmt(p.blocked, 0) + '</span><span class="chip-lbl">Blocked</span></div>'
      + '</div>'
      + '<div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:' + Math.min(pct,100) + '%"></div></div>'
      + '<div class="progress-pct">' + pct + '% complete</div>'
      + '</div>';
  }).join('');

  // Done This Week — items completed in last 7 days for current project
  const sevenDaysAgo = Date.now() - 7 * 86400 * 1000;
  const doneItems = items.filter(i => {
    if (i.status !== 'complete' || !i.completed_at) return false;
    const ts = new Date(i.completed_at.includes('T') ? i.completed_at + (i.completed_at.endsWith('Z') ? '' : 'Z') : i.completed_at + 'T00:00:00Z').getTime();
    return !isNaN(ts) && ts >= sevenDaysAgo;
  }).sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));

  const doneHtml = doneItems.length
    ? '<div class="done-list">' + doneItems.map(i =>
        '<div class="done-item">'
        + '<span class="done-check">✅</span>'
        + '<span class="done-title">' + esc(i.title) + '</span>'
        + '<span class="done-meta" title="' + esc(fmtDate(i.completed_at)) + '">' + esc(timeAgo(i.completed_at)) + (i.agent_assigned ? '   ' + esc(i.agent_assigned) : '') + '</span>'
        + '</div>'
      ).join('') + '</div>'
    : '<div style="padding:16px;color:var(--muted);font-size:13px">No items completed in the last 7 days.</div>';

  // Activity Feed — last 10 cycles
  const feedCycles = cycles.slice(0, 10);
  const feedHtml = feedCycles.length
    ? '<div class="activity-feed">' + feedCycles.map(c =>
        '<div class="activity-item">'
        + '<span class="activity-time" title="' + esc(fmtDate(c.ended_at)) + '">' + esc(timeAgo(c.ended_at)) + '</span>'
        + '<span class="activity-project">' + esc(c.project_id || currentProject) + '</span>'
        + '<span class="activity-title">' + esc(trunc(c.plan_notes || c.actual_notes || '—', 70)) + '</span>'
        + '<span class="activity-phase">' + phaseBadge(c.phase) + '</span>'
        + outcomeBadge(c.outcome)
        + '</div>'
      ).join('') + '</div>'
    : '<div style="padding:16px;color:var(--muted);font-size:13px">No cycle activity yet.</div>';

  $('pageContent').innerHTML =
    '<div class="section"><div class="section-header"><div class="section-title">📊 Project Performance</div></div>'
    + '<div class="perf-projects">' + (perfCards || '<div class="no-data">No performance data.</div>') + '</div></div>'
    + '<div class="section"><div class="section-header"><div class="section-title">✅ Done This Week <span class="count">' + doneItems.length + '</span></div>'
    + '<a class="view-all" onclick="navigateTo(\\'items\\')">View all →</a></div>'
    + '<div class="table-wrap">' + doneHtml + '</div></div>'
    + '<div class="section"><div class="section-header"><div class="section-title">🔄 Activity Feed <span class="count">' + feedCycles.length + '</span></div>'
    + '<a class="view-all" onclick="navigateTo(\\'cycles\\')">View all →</a></div>'
    + '<div class="table-wrap">' + feedHtml + '</div></div>';
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE: Items (merged — Pending / All / Blocked tabs)
// ─────────────────────────────────────────────────────────────────────────────
let itemsFilter = { search:'', priority:[], phase:[], status:[], agent:'' };
let itemsTab = 'all'; // 'all' | 'pending' | 'complete' | 'blocked' | 'queued' | 'not-started' | 'dropped'
let itemsPage = 1;
let itemsPageSize = 10;
var ganttShowCritical = false;

// Derive is_blocked: item has depends_on set AND the parent's status is not 'complete'
function deriveBlocked(items) {
  const statusById = {};
  items.forEach(i => { statusById[i.id] = i.status; });
  return items.map(i => {
    const blocked = !!(i.depends_on && statusById[i.depends_on] && statusById[i.depends_on] !== 'complete')
      || i.status === 'blocked';
    return Object.assign({}, i, { _is_blocked: blocked });
  });
}

function itemTrafficDot(item) {
  if (item._is_blocked || item.status === 'blocked') return '<span class="tl-dot tl-red" title="Blocked — waiting on dependency">●</span>';
  if (item.status === 'complete') return '<span class="tl-dot tl-green" title="Complete">●</span>';
  if (item.status === 'queued') return '<span class="tl-dot tl-purple" title="Queued — dispatched, waiting for LLM pickup">●</span>';
  if (item.status === 'in-progress' || item.phase === 'check') return '<span class="tl-dot tl-amber" title="In progress">●</span>';
  if (item.status === 'dropped' || item.status === 'cancelled') return '<span class="tl-dot tl-gray" title="Dropped / cancelled">●</span>';
  return '<span class="tl-dot tl-gray" title="Open — not started">●</span>';
}

// ─────────────────────────────────────────────────────────────────────────────
// Gantt Page — dependency chart
// ─────────────────────────────────────────────────────────────────────────────
function renderGanttPage(rawData) {
  var data = deriveBlocked(rawData);
  var ROW_H = 44, PAD = 12, BAR_H = 22, BAR_Y_OFF = (ROW_H - BAR_H) / 2;
  var AXIS_H = 36, PX_PER_DAY = 20;

  // Topological sort
  var byId = {};
  data.forEach(function(i) { byId[i.id] = i; });
  var visited = new Set(), order = [];
  function visit(item) {
    if (visited.has(item.id)) return;
    visited.add(item.id);
    if (item.depends_on && byId[item.depends_on]) visit(byId[item.depends_on]);
    order.push(item);
  }
  data.forEach(function(i) { visit(i); });

  // Date-anchored scale: 20px/day makes SVG wider than viewport → real horizontal scroll
  var MS = 60000, DAY_MS = 86400000;
  var rawMin = Math.min.apply(null, order.map(function(i) {
    return i.created_at ? new Date(i.created_at).getTime() : Date.now();
  }));
  var axisStart = new Date(rawMin);
  axisStart.setHours(0, 0, 0, 0);
  var axisStartMs = axisStart.getTime();

  var rawMaxEnd = Math.max.apply(null, order.map(function(i) {
    var sMs = i.created_at ? new Date(i.created_at).getTime() : Date.now();
    return sMs + (i.actual_mins || i.estimated_mins || 60) * MS;
  }));
  var axisEndMs = Math.max(rawMaxEnd, Date.now() + 14 * DAY_MS);
  var axisEnd = new Date(axisEndMs);
  axisEnd.setHours(0, 0, 0, 0);
  axisEnd.setDate(axisEnd.getDate() + 1);
  axisEndMs = axisEnd.getTime();
  var totalDays = Math.ceil((axisEndMs - axisStartMs) / DAY_MS);

  var svgW = Math.max(600, totalDays * PX_PER_DAY + PAD * 2);
  var svgH = order.length * ROW_H + AXIS_H;
  var todayX = PAD + (Date.now() - axisStartMs) / DAY_MS * PX_PER_DAY;

  function iStartPx(item) {
    return PAD + (item.created_at ? (new Date(item.created_at).getTime() - axisStartMs) / DAY_MS * PX_PER_DAY : 0);
  }
  function iWidthPx(item) {
    return Math.max(30, (item.actual_mins || item.estimated_mins || 60) * PX_PER_DAY / 1440);
  }
  function iEndPx(item) { return iStartPx(item) + iWidthPx(item); }

  // Colour helpers
  function dotC(item) {
    if (item._is_blocked) return '#ef4444';
    if (item.status === 'complete') return '#22c55e';
    if (item.status === 'in-progress') return '#eab308';
    if (item.status === 'dropped' || item.status === 'cancelled') return '#64748b';
    return '#4b5563';
  }
  function barFill(item) {
    if (item._is_blocked) return 'rgba(239,68,68,0.22)';
    if (item.status === 'complete') return 'rgba(34,197,94,0.22)';
    if (item.status === 'in-progress') return 'rgba(234,179,8,0.22)';
    return 'rgba(75,85,99,0.18)';
  }
  function barSt(item) {
    if (item._is_blocked) return '#ef4444';
    if (item.status === 'complete') return '#22c55e';
    if (item.status === 'in-progress') return '#eab308';
    return '#4b5563';
  }

  var rowIdx = {};
  order.forEach(function(item, idx) { rowIdx[item.id] = idx; });

  // Critical path (by estimated_mins chain length)
  var longestPath = {};
  order.forEach(function(item) {
    var ownDur = item.estimated_mins || 60;
    longestPath[item.id] = ((item.depends_on && longestPath[item.depends_on]) ? longestPath[item.depends_on] : 0) + ownDur;
  });
  var maxPathLen = 0;
  order.forEach(function(item) { if (longestPath[item.id] > maxPathLen) maxPathLen = longestPath[item.id]; });
  var cpEnd = null;
  order.forEach(function(item) { if (!cpEnd && longestPath[item.id] === maxPathLen) cpEnd = item; });
  var cpIdsArr = [];
  if (cpEnd) { var cur = cpEnd; while (cur) { cpIdsArr.push(cur.id); cur = cur.depends_on ? byId[cur.depends_on] : null; } }

  // Date tick labels
  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var tickEvery = totalDays <= 14 ? 1 : totalDays <= 60 ? 7 : 30;
  var ticks = '', td2 = new Date(axisStartMs), dc = 0;
  while (td2.getTime() <= axisEndMs) {
    if (dc % tickEvery === 0) {
      var tx2 = PAD + dc * PX_PER_DAY;
      ticks += '<line x1="' + tx2 + '" y1="' + AXIS_H + '" x2="' + tx2 + '" y2="' + svgH + '" stroke="#1e2235" stroke-width="1"/>'
        + '<text x="' + tx2 + '" y="' + (AXIS_H - 6) + '" font-size="10" fill="#4b5563" text-anchor="middle" font-family="monospace">'
        + MONTHS[td2.getMonth()] + ' ' + td2.getDate() + '</text>';
    }
    td2.setDate(td2.getDate() + 1); dc++;
  }

  // Today vertical marker
  var todayMarker = (todayX >= 0 && todayX <= svgW)
    ? '<line x1="' + todayX + '" y1="2" x2="' + todayX + '" y2="' + svgH
      + '" stroke="#3b82f6" stroke-width="2" stroke-dasharray="4,3" opacity="0.9"/>'
      + '<rect x="' + (todayX - 18) + '" y="2" width="36" height="15" rx="4" fill="#1d4ed8" opacity="0.3"/>'
      + '<text x="' + todayX + '" y="13" font-size="9" fill="#93c5fd" text-anchor="middle" font-family="monospace" font-weight="700">TODAY</text>'
    : '';

  // SVG bar rows (labels live in the left HTML panel — no label column in SVG)
  var rows = order.map(function(item, idx) {
    var y = AXIS_H + idx * ROW_H;
    var xS = iStartPx(item), bW = iWidthPx(item), bY = y + BAR_Y_OFF;
    var bf = barFill(item), bs = barSt(item);
    var pct = item.status === 'complete' ? 100
      : (item.actual_mins && item.estimated_mins ? Math.min(100, Math.round(item.actual_mins / item.estimated_mins * 100))
      : (item.status === 'in-progress' ? 40 : 0));
    var pW = bW * pct / 100;
    var bgFill = idx % 2 === 0 ? 'rgba(255,255,255,0.012)' : 'transparent';
    var durLbl = item.actual_mins ? (item.actual_mins + 'm') : (item.estimated_mins ? (item.estimated_mins + 'm est') : '');
    var tooltip = '#' + item.id + ' ' + item.title + ' | ' + item.status + ' | est: ' + (item.estimated_mins || '-') + 'm | actual: ' + (item.actual_mins || '-') + 'm';
    var prog = pW > 0 ? ('<rect x="' + xS + '" y="' + bY + '" width="' + pW + '" height="' + BAR_H + '" rx="4" fill="' + bs + '" opacity="0.5"/>') : '';
    return '<g class="gantt-bar" data-id="' + item.id + '" data-orig-bg="' + bgFill + '">'
      + '<rect class="gantt-bar-bg" x="0" y="' + y + '" width="' + svgW + '" height="' + ROW_H + '" fill="' + bgFill + '"/>'
      + '<rect x="' + xS + '" y="' + bY + '" width="' + bW + '" height="' + BAR_H + '" rx="4" fill="' + bf + '" stroke="' + bs + '" stroke-width="1"/>'
      + prog
      + '<text x="' + (xS + bW + 4) + '" y="' + (bY + 14) + '" font-size="10" fill="#64748b" font-family="monospace">' + esc(durLbl) + '</text>'
      + '<title>' + esc(tooltip) + '</title>'
      + '</g>';
  }).join('');

  // Dependency arrows
  var arrows = order.filter(function(item) {
    return item.depends_on && rowIdx[item.depends_on] !== undefined;
  }).map(function(item) {
    var fi = rowIdx[item.depends_on];
    var fromItem = byId[item.depends_on];
    var fx = Math.min(svgW - 4, iEndPx(fromItem));
    var fy = AXIS_H + fi * ROW_H + ROW_H / 2;
    var txi = iStartPx(item), ty = AXIS_H + rowIdx[item.id] * ROW_H + ROW_H / 2;
    var mx = (fx + txi) / 2;
    var col = item._is_blocked ? '#ef4444' : '#4b5563';
    var dash = item._is_blocked ? '4,3' : 'none';
    var mid = item._is_blocked ? 'red' : 'gray';
    return '<path id="garr-' + item.id + '" class="gantt-arrow" data-from="' + item.depends_on + '" data-to="' + item.id + '" data-blocked="' + (item._is_blocked ? '1' : '0') + '"'
      + ' d="M' + fx + ',' + fy + ' C' + mx + ',' + fy + ' ' + mx + ',' + ty + ' ' + txi + ',' + ty + '"'
      + ' fill="none" stroke="' + col + '" stroke-width="1.5" stroke-dasharray="' + dash + '" opacity="0.4"'
      + ' marker-end="url(#arr-' + mid + ')"/>';
  }).join('');

  // Left HTML name panel (sticky, does not scroll with chart)
  var namePanelRows = order.map(function(item, idx) {
    var lbl = item.title.length > 32 ? item.title.slice(0, 31) + '\u2026' : item.title;
    var dc3 = dotC(item);
    var bg3 = idx % 2 === 0 ? 'rgba(255,255,255,0.012)' : 'transparent';
    return '<div class="gr-name" data-id="' + item.id + '" data-orig-bg="' + bg3 + '"'
      + ' style="height:' + ROW_H + 'px;display:flex;align-items:center;gap:7px;padding:0 10px;background:' + bg3 + ';cursor:pointer;box-sizing:border-box">'
      + '<span style="width:8px;height:8px;border-radius:50%;background:' + dc3 + ';flex-shrink:0"></span>'
      + '<span style="font-size:12px;color:#e2e8f0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(item.title) + '">' + esc(lbl) + '</span>'
      + '<span style="font-size:10px;color:#64748b;font-family:monospace;flex-shrink:0">#' + item.id + '</span>'
      + '</div>';
  }).join('');

  var namePanel = '<div id="gantt-names" style="flex-shrink:0;width:260px;background:#0f1117;border-right:1px solid #1e2235;overflow:hidden">'
    + '<div style="height:' + AXIS_H + 'px;border-bottom:1px solid #1e2235;display:flex;align-items:center;padding:0 10px">'
    + '<span style="font-size:10px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.5px">Item</span>'
    + '</div>'
    + namePanelRows + '</div>';

  // SVG assembly
  var svg = '<svg id="gantt-svg" width="' + svgW + '" height="' + svgH + '" xmlns="http://www.w3.org/2000/svg" style="display:block">'
    + '<defs>'
    + '<marker id="arr-gray" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#4b5563"/></marker>'
    + '<marker id="arr-red"  markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#ef4444"/></marker>'
    + '<marker id="arr-cp"   markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#f59e0b"/></marker>'
    + '</defs>'
    + '<rect width="' + svgW + '" height="' + svgH + '" fill="#0f1117"/>'
    + '<line x1="0" y1="' + AXIS_H + '" x2="' + svgW + '" y2="' + AXIS_H + '" stroke="#1e2235" stroke-width="1"/>'
    + ticks + todayMarker + arrows + rows
    + '</svg>';

  // Legend strip
  var legend = '<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:7px 12px;'
    + 'background:rgba(255,255,255,0.03);border-radius:8px;margin:8px 0;font-size:12px;color:#64748b;border:1px solid #1e2235">'
    + '<span style="font-weight:600;color:#94a3b8">Legend:</span>'
    + '<span><span style="color:#22c55e">&#9679;</span> Complete</span>'
    + '<span><span style="color:#eab308">&#9679;</span> In Progress</span>'
    + '<span><span style="color:#ef4444">&#9679;</span> Blocked</span>'
    + '<span><span style="color:#4b5563">&#9679;</span> Open</span>'
    + '<span style="border-left:1px solid #1e2235;padding-left:12px">Bar = est. time &middot; Fill = % done &middot; Arrows = deps</span>'
    + '<span style="border-left:1px solid #1e2235;padding-left:12px"><span style="color:#60a5fa">&#9474;</span> Blue = today &middot; Hover name to trace deps</span>'
    + '</div>';

  var toolbar = '<div style="display:flex;gap:10px;align-items:center;margin-bottom:8px">'
    + '<h2 style="font-size:18px;font-weight:600;margin:0;flex:1">Gantt &mdash; Dependency View</h2>'
    + '<button id="gantt-cp-btn" style="font-size:12px;padding:5px 16px;border-radius:16px;border:1px solid #f59e0b;background:transparent;color:#f59e0b;cursor:pointer">Critical Path</button>'
    + '</div>'
    + '<p style="font-size:13px;color:#64748b;margin:0 0 4px">Items ordered by dependency. Scroll chart right &rarr;. Hover a name to trace connections.</p>';

  $('pageContent').innerHTML = toolbar + legend
    + '<div style="display:flex;border:1px solid #1e2235;border-radius:8px;overflow:hidden;background:#0f1117">'
    + namePanel
    + '<div id="gantt-scroll" style="overflow-x:auto;flex:1">' + svg + '</div>'
    + '</div>';

  // Interactivity — runs after innerHTML is set
  setTimeout(function() {
    var cpActive = false;
    var cpIds = cpIdsArr;
    var scrollEl = document.getElementById('gantt-scroll');

    // Auto-scroll: put today near left edge
    if (scrollEl && todayX > 0) { scrollEl.scrollLeft = Math.max(0, todayX - 80); }

    function allArrows() { return document.querySelectorAll('.gantt-arrow'); }

    function restoreArrows() {
      allArrows().forEach(function(el) {
        var from = parseInt(el.getAttribute('data-from'), 10);
        var to   = parseInt(el.getAttribute('data-to'),   10);
        var blocked = el.getAttribute('data-blocked') === '1';
        if (cpActive) {
          var onCp = cpIds.indexOf(from) !== -1 && cpIds.indexOf(to) !== -1;
          el.setAttribute('opacity', onCp ? '1' : '0.06');
          el.setAttribute('stroke-width', onCp ? '2.5' : '1');
          el.setAttribute('stroke', onCp ? '#f59e0b' : (blocked ? '#ef4444' : '#4b5563'));
          el.setAttribute('marker-end', onCp ? 'url(#arr-cp)' : (blocked ? 'url(#arr-red)' : 'url(#arr-gray)'));
        } else {
          el.setAttribute('opacity', '0.4');
          el.setAttribute('stroke-width', '1.5');
          el.setAttribute('stroke', blocked ? '#ef4444' : '#4b5563');
          el.setAttribute('marker-end', blocked ? 'url(#arr-red)' : 'url(#arr-gray)');
        }
      });
    }

    function restoreLabels() {
      document.querySelectorAll('.gr-name').forEach(function(el) {
        var id = parseInt(el.getAttribute('data-id'), 10);
        var span = el.querySelectorAll('span')[1];
        if (!span) return;
        var onCp = cpActive && cpIds.indexOf(id) !== -1;
        span.style.color = onCp ? '#fbbf24' : '#e2e8f0';
        span.style.fontWeight = onCp ? '700' : 'normal';
      });
    }

    // Name-row hover: highlight connected arrows
    document.querySelectorAll('.gr-name').forEach(function(nameEl) {
      var rowId = nameEl.getAttribute('data-id');
      var origBg = nameEl.getAttribute('data-orig-bg') || 'transparent';
      nameEl.addEventListener('mouseenter', function() {
        nameEl.style.background = 'rgba(255,255,255,0.05)';
        var barBg = document.querySelector('.gantt-bar[data-id="' + rowId + '"] .gantt-bar-bg');
        if (barBg) barBg.setAttribute('fill', 'rgba(255,255,255,0.05)');
        allArrows().forEach(function(el) {
          var from = el.getAttribute('data-from'), to = el.getAttribute('data-to');
          if (String(from) === rowId || String(to) === rowId) {
            el.setAttribute('opacity', '1'); el.setAttribute('stroke-width', '2.5');
          } else { el.setAttribute('opacity', '0.04'); }
        });
      });
      nameEl.addEventListener('mouseleave', function() {
        nameEl.style.background = origBg;
        var barGEl = document.querySelector('.gantt-bar[data-id="' + rowId + '"]');
        if (barGEl) {
          var bg = barGEl.querySelector('.gantt-bar-bg');
          if (bg) bg.setAttribute('fill', barGEl.getAttribute('data-orig-bg') || 'transparent');
        }
        restoreArrows();
      });
    });

    // Critical path toggle
    var cpBtn = document.getElementById('gantt-cp-btn');
    if (cpBtn) {
      cpBtn.addEventListener('click', function() {
        cpActive = !cpActive;
        cpBtn.style.background = cpActive ? '#f59e0b' : 'transparent';
        cpBtn.style.color      = cpActive ? '#000'   : '#f59e0b';
        cpBtn.textContent      = cpActive ? 'Hide Critical Path' : 'Critical Path';
        restoreArrows(); restoreLabels();
      });
    }
  }, 0);
}

function renderItemsPage(rawData) {
  const data = deriveBlocked(rawData);
  const agents = [...new Set(data.map(i => i.agent_assigned).filter(Boolean))].sort();
  const agentOpts = '<option value="">All agents</option>' + agents.map(a => '<option value="'+esc(a)+'">'+esc(a)+'</option>').join('');

  const html =
    '<div class="tl-filter-bar">'
    + '<button class="tl-filter-btn'+(itemsTab==='all'?' tl-active':'')+'" data-tab="all" onclick="setItemsTab(\\'all\\')" title="Show all items">'
    + '<span style="font-size:10px">⬜</span> All<span class="tl-meta"><span class="tl-cnt">—</span><span class="tl-time-lbl"></span></span></button>'
    + '<button class="tl-filter-btn'+(itemsTab==='not-started'?' tl-active':'')+'" data-tab="not-started" onclick="setItemsTab(\\'not-started\\')" title="Open — not started yet, no blocker">'
    + '<span class="tl-dot tl-gray" style="font-size:10px">●</span> To Be Started<span class="tl-meta"><span class="tl-cnt">—</span><span class="tl-time-lbl"></span></span></button>'
    + '<button class="tl-filter-btn'+(itemsTab==='queued'?' tl-active':'')+'" data-tab="queued" onclick="setItemsTab(\\'queued\\')" title="Blocked — queued behind a dependency">'
    + '<span class="tl-dot tl-red" style="font-size:10px;opacity:.6">●</span> In Queue<span class="tl-meta"><span class="tl-cnt">—</span><span class="tl-time-lbl"></span></span></button>'
    + '<button class="tl-filter-btn'+(itemsTab==='pending'?' tl-active':'')+'" data-tab="pending" onclick="setItemsTab(\\'pending\\')" title="In progress (active work)">'
    + '<span class="tl-dot tl-amber" style="font-size:10px">●</span> In Progress<span class="tl-meta"><span class="tl-cnt">—</span><span class="tl-time-lbl"></span></span></button>'
    + '<button class="tl-filter-btn'+(itemsTab==='blocked'?' tl-active':'')+'" data-tab="blocked" onclick="setItemsTab(\\'blocked\\')" title="Blocked — dependency not complete">'
    + '<span class="tl-dot tl-red" style="font-size:10px">●</span> Blocked<span class="tl-meta"><span class="tl-cnt">—</span><span class="tl-time-lbl"></span></span></button>'
    + '<button class="tl-filter-btn'+(itemsTab==='complete'?' tl-active':'')+'" data-tab="complete" onclick="setItemsTab(\\'complete\\')" title="Completed items">'
    + '<span class="tl-dot tl-green" style="font-size:10px">●</span> Complete<span class="tl-meta"><span class="tl-cnt">—</span><span class="tl-time-lbl"></span></span></button>'
    + '<button class="tl-filter-btn'+(itemsTab==='dropped'?' tl-active':'')+'" data-tab="dropped" onclick="setItemsTab(\\'dropped\\')" title="Dropped / cancelled">'
    + '<span class="tl-dot tl-gray" style="font-size:10px;opacity:.4">●</span> Dropped<span class="tl-meta"><span class="tl-cnt">—</span><span class="tl-time-lbl"></span></span></button>'
    + '</div>'
    + '<div class="filter-bar" id="items-filters">'
    + '<div class="filter-group"><label>Search</label><input type="text" id="items-search" placeholder="Title or plan…" value="'+esc(itemsFilter.search)+'" oninput="itemsFilter.search=this.value;itemsPage=1;redrawItems()"></div>'
    + '<div class="filter-group"><label>Priority</label><div class="check-group">'
    + ['critical','high','medium','low'].map(p=>'<label class="check-pill'+(itemsFilter.priority.includes(p)?' checked':'')+'"><input type="checkbox" '+(itemsFilter.priority.includes(p)?'checked':'')+' onchange="toggleFilter(itemsFilter.priority,\\''+p+'\\',this.checked);this.parentElement.classList.toggle(\\'checked\\',this.checked);itemsPage=1;redrawItems()"> '+p+'</label>').join('')
    + '</div></div>'
    + '<div class="filter-group"><label>Phase</label><div class="check-group">'
    + ['plan','do','check','act'].map(p=>'<label class="check-pill'+(itemsFilter.phase.includes(p)?' checked':'')+'"><input type="checkbox" '+(itemsFilter.phase.includes(p)?'checked':'')+' onchange="toggleFilter(itemsFilter.phase,\\''+p+'\\',this.checked);this.parentElement.classList.toggle(\\'checked\\',this.checked);itemsPage=1;redrawItems()"> '+p+'</label>').join('')
    + '</div></div>'
    + '<div class="filter-group"><label>Agent</label><select onchange="itemsFilter.agent=this.value;itemsPage=1;redrawItems()">' + agentOpts + '</select></div>'
    + '<button class="clear-btn" onclick="clearItemsFilters()">Clear</button>'
    + '</div>'
    + '<div class="result-count" id="items-count"></div>'
    + '<div class="table-wrap">'
    + '<div class="table-toolbar">' + makeDensityBtn('tbl-items') + '</div>'
    + '<div class="table-scroll"><table id="tbl-items">'
    + '<thead><tr>'
    + '<th style="width:30px"></th>'
    + '<th data-col="id">ID</th>'
    + '<th data-col="title">Title</th>'
    + '<th data-col="priority">Priority</th>'
    + '<th data-col="phase">Phase</th>'
    + '<th data-col="status">Status</th>'
    + '<th data-col="category">Category</th>'
    + '<th data-col="agent_assigned">Agent</th>'
    + '<th data-col="estimated_mins">Est(m)</th>'
    + '<th data-col="actual_mins">Actual(m)</th>'
    + '<th data-col="completed_at">Completed</th>'
    + '<th data-col="created_at">Created</th>'
    + '</tr></thead><tbody id="items-tbody"></tbody></table></div>'
    + '<div class="pagination-bar" id="items-pgbar"></div>'
    + '</div>';

  $('pageContent').innerHTML = html;
  applyDensity('tbl-items');
  attachSortHeaders('tbl-items', 'items', () => { itemsPage=1; redrawItems(); });
  redrawItems();
}

function setItemsTab(tab) {
  itemsTab = tab;
  itemsPage = 1;
  // Update traffic light filter button active state
  document.querySelectorAll('.tl-filter-btn').forEach(b => {
    const isActive = b.getAttribute('onclick') && b.getAttribute('onclick').includes("'" + tab + "'");
    b.classList.toggle('tl-active', isActive);
  });
  redrawItems();
}

function toggleFilter(arr, val, checked) {
  const i = arr.indexOf(val);
  if (checked && i === -1) arr.push(val);
  if (!checked && i !== -1) arr.splice(i, 1);
}

function clearItemsFilters() {
  itemsFilter = { search:'', priority:[], phase:[], status:[], agent:'' };
  itemsPage = 1;
  if (cache.items) renderItemsPage(cache.items);
}

function fmtMins(m) {
  if (!m || m <= 0) return '';
  if (m < 60) return m + 'm';
  var h = Math.floor(m / 60), min = m % 60;
  return min > 0 ? h + 'h ' + min + 'm' : h + 'h';
}

function updateTabStats(data) {
  var tabDefs = {
    'all':         data,
    'not-started': data.filter(function(i){ return i.status === 'open' && !i._is_blocked; }),
    'queued':      data.filter(function(i){ return i.status === 'queued' || (i._is_blocked && i.status === 'open'); }),
    'pending':     data.filter(function(i){ return i.status === 'in-progress' && !i._is_blocked; }),
    'blocked':     data.filter(function(i){ return i._is_blocked && i.status === 'in-progress'; }),
    'complete':    data.filter(function(i){ return i.status === 'complete'; }),
    'dropped':     data.filter(function(i){ return i.status === 'dropped' || i.status === 'cancelled'; }),
  };
  document.querySelectorAll('.tl-filter-btn[data-tab]').forEach(function(btn) {
    var tab = btn.getAttribute('data-tab');
    var items = tabDefs[tab] || [];
    var mins = items.reduce(function(sum, i) {
      // Complete: prefer actual, fallback estimated. Others: estimated only.
      var m = (tab === 'complete' || tab === 'all')
        ? (i.status === 'complete' ? (i.actual_mins || i.estimated_mins || 0) : (i.estimated_mins || 0))
        : (i.estimated_mins || 0);
      return sum + m;
    }, 0);
    var cntEl = btn.querySelector('.tl-cnt');
    var timeEl = btn.querySelector('.tl-time-lbl');
    if (cntEl) cntEl.textContent = items.length;
    if (timeEl) timeEl.textContent = fmtMins(mins);
  });
}

function redrawItems() {
  const rawData = cache.items || [];
  const data = deriveBlocked(rawData);
  const f = itemsFilter;
  const st = sortState['items'] || {};

  // Traffic light tab filter
  let filtered = data.filter(i => {
    if (itemsTab === 'pending')     return i.status === 'in-progress' && !i._is_blocked;
    if (itemsTab === 'not-started') return i.status === 'open' && !i._is_blocked;
    if (itemsTab === 'queued')      return i.status === 'queued' || (i._is_blocked && i.status === 'open');
    if (itemsTab === 'complete')    return i.status === 'complete';
    if (itemsTab === 'blocked')     return i._is_blocked && i.status === 'in-progress';
    if (itemsTab === 'dropped')     return i.status === 'dropped' || i.status === 'cancelled';
    return true; // 'all'
  });

  // Search / filter
  filtered = filtered.filter(i => {
    if (f.search) {
      const q = f.search.toLowerCase();
      if (!String(i.title||'').toLowerCase().includes(q) && !String(i.plan_description||'').toLowerCase().includes(q)) return false;
    }
    if (f.priority.length && !f.priority.includes(i.priority)) return false;
    if (f.phase.length && !f.phase.includes(i.phase)) return false;
    if (f.status.length && !f.status.includes(i.status)) return false;
    if (f.agent && i.agent_assigned !== f.agent) return false;
    return true;
  });

  filtered = sortData(filtered, st.col, st.dir);
  applyThSortClasses('tbl-items', 'items');

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / itemsPageSize));
  if (itemsPage > totalPages) itemsPage = totalPages;
  const start = (itemsPage - 1) * itemsPageSize;
  const pageSlice = filtered.slice(start, start + itemsPageSize);

  const countEl = document.getElementById('items-count');
  if (countEl) countEl.textContent = 'Showing ' + (total === 0 ? 0 : start+1) + '–' + Math.min(start+itemsPageSize, total) + ' of ' + total + ' results';

  const tbody = document.getElementById('items-tbody');
  if (!tbody) return;
  const NCOLS = 12; // including traffic dot col
  tbody.innerHTML = pageSlice.map(item => {
    const eid = 'ex-item-' + item.id;
    const hasDetail = item.plan_description || item.actual_description || item.remarks || item.errors_encountered || item.files_modified;
    const files = parseArr(item.files_modified);
    return '<tr class="'+(hasDetail?'clickable-row':'')+'" '+(hasDetail?'data-expand="'+eid+'"':'')+' title="'+(hasDetail?'Click to expand':'')+'">'
      + '<td style="text-align:center;padding:10px 6px">' + itemTrafficDot(item) + '</td>'
      + '<td class="mono">#'+item.id+'</td>'
      + '<td>'+esc(item.title)+(hasDetail?' <span style="color:var(--muted);font-size:10px">▼</span>':'')+'</td>'
      + '<td>'+priorityBadge(item.priority)+'</td>'
      + '<td>'+phaseBadge(item.phase)+'</td>'
      + '<td>'+statusBadge(item._is_blocked ? 'blocked' : item.status)+'</td>'
      + '<td class="dim">'+fmt(item.category)+'</td>'
      + '<td class="dim">'+fmt(item.agent_assigned)+'</td>'
      + '<td class="dim">'+fmt(item.estimated_mins)+'</td>'
      + '<td class="dim">'+fmt(item.actual_mins)+'</td>'
      + '<td class="dim">' + timeAgoCell(item.completed_at) + '</td>'
      + '<td class="dim">' + timeAgoCell(item.created_at) + '</td>'
      + '</tr>'
      + (hasDetail ? '<tr class="expand-row" id="'+eid+'"><td colspan="'+NCOLS+'">'
        + '<div class="expand-grid">'
        + (item.plan_description ? '<div class="expand-field"><label>Required</label><p>'+esc(item.plan_description)+'</p></div>' : '')
        + (item.actual_description ? '<div class="expand-field"><label>Done</label><p>'+esc(item.actual_description)+'</p></div>' : '')
        + (item.remarks ? '<div class="expand-field"><label>Remarks</label><p>'+esc(item.remarks)+'</p></div>' : '')
        + (item.errors_encountered ? '<div class="expand-field errors"><label>Errors</label><p>'+esc(item.errors_encountered)+'</p></div>' : '')
        + (files.length ? '<div class="expand-field"><label>Files Modified</label><p>'+files.map(f=>'<span class="tag">'+esc(f)+'</span>').join(' ')+'</p></div>' : '')
        + '</div></td></tr>' : '');
  }).join('');

  attachExpand(document.getElementById('tbl-items'));
  updateTabStats(data);
  renderPagination('items-pgbar', itemsPage, totalPages, total, itemsPageSize, start,
    (pg) => { itemsPage = pg; redrawItems(); },
    (sz) => { itemsPageSize = sz; itemsPage = 1; redrawItems(); }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Pagination helper
// ─────────────────────────────────────────────────────────────────────────────
function renderPagination(containerId, currentPg, totalPages, total, pageSize, startIdx, onPage, onSize) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const endIdx = Math.min(startIdx + pageSize, total);
  const showStr = total === 0 ? 'No results' : 'Showing ' + (startIdx+1) + '–' + endIdx + ' of ' + total + ' results';
  el.innerHTML =
    '<span class="pg-info">' + showStr + '</span>'
    + '<div class="pg-controls">'
    + '<button class="pg-btn" ' + (currentPg <= 1 ? 'disabled' : 'onclick="(' + onPage.toString() + ')(' + (currentPg-1) + ')"') + '>← Prev</button>'
    + '<span class="pg-page-label">Page ' + currentPg + ' of ' + totalPages + '</span>'
    + '<button class="pg-btn" ' + (currentPg >= totalPages ? 'disabled' : 'onclick="(' + onPage.toString() + ')(' + (currentPg+1) + ')"') + '>Next →</button>'
    + '<select class="pg-size-sel" onchange="(' + onSize.toString() + ')(parseInt(this.value))">'
    + [10,25,50].map(s => '<option value="'+s+'"'+(s===pageSize?' selected':'')+'>'+s+' per page</option>').join('')
    + '</select>'
    + '</div>';
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE: Sessions
// ─────────────────────────────────────────────────────────────────────────────
let sessFilter = { search:'', interface:'', dateFrom:'', dateTo:'' };
let sessPage = 1;
let sessPageSize = 10;

function renderSessionsPage(data) {
  const ifaces = [...new Set(data.map(s => s.interface).filter(Boolean))].sort();
  const ifaceOpts = '<option value="">All</option>' + ifaces.map(i=>'<option value="'+esc(i)+'">'+esc(i)+'</option>').join('');

  $('pageContent').innerHTML = '<div class="filter-bar">'
    + '<div class="filter-group"><label>Search</label><input type="text" placeholder="Summary…" value="'+esc(sessFilter.search)+'" oninput="sessFilter.search=this.value;sessPage=1;redrawSessions()"></div>'
    + '<div class="filter-group"><label>Interface</label><select onchange="sessFilter.interface=this.value;sessPage=1;redrawSessions()">'+ifaceOpts+'</select></div>'
    + '<div class="filter-group"><label>From</label><input type="date" value="'+sessFilter.dateFrom+'" onchange="sessFilter.dateFrom=this.value;sessPage=1;redrawSessions()"></div>'
    + '<div class="filter-group"><label>To</label><input type="date" value="'+sessFilter.dateTo+'" onchange="sessFilter.dateTo=this.value;sessPage=1;redrawSessions()"></div>'
    + '<button class="clear-btn" onclick="sessFilter={search:\\'\\',interface:\\'\\',dateFrom:\\'\\',dateTo:\\'\\'};sessPage=1;renderSessionsPage(cache.sessions||[])">Clear</button>'
    + '</div>'
    + '<div class="result-count" id="sess-count"></div>'
    + '<div class="table-wrap">'
    + '<div class="table-toolbar">' + makeDensityBtn('tbl-sessions') + '</div>'
    + '<div class="table-scroll"><table id="tbl-sessions">'
    + '<thead><tr>'
    + '<th data-col="id">ID</th><th data-col="cycles_requested">Cycles Req</th><th data-col="cycles_completed">Cycles Done</th>'
    + '<th data-col="interface">Interface</th><th data-col="items_promoted">Promoted</th><th data-col="items_failed">Failed</th>'
    + '<th data-col="summary">Summary</th><th data-col="started_at">Started</th><th data-col="ended_at">Ended</th><th data-col="duration_mins">Duration</th>'
    + '</tr></thead><tbody id="sess-tbody"></tbody></table></div>'
    + '<div class="pagination-bar" id="sess-pgbar"></div>'
    + '</div>';

  attachSortHeaders('tbl-sessions', 'sessions', () => { sessPage=1; redrawSessions(); });
  applyDensity('tbl-sessions');
  redrawSessions();
}

function redrawSessions() {
  const data = cache.sessions || [];
  const f = sessFilter;
  const st = sortState['sessions'] || {};
  let filtered = data.filter(s => {
    if (f.search && !String(s.summary||'').toLowerCase().includes(f.search.toLowerCase())) return false;
    if (f.interface && s.interface !== f.interface) return false;
    if (f.dateFrom && s.ended_at && s.ended_at < f.dateFrom) return false;
    if (f.dateTo && s.ended_at && s.ended_at > f.dateTo + 'T23:59:59') return false;
    return true;
  });
  filtered = sortData(filtered, st.col, st.dir);
  applyThSortClasses('tbl-sessions', 'sessions');

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / sessPageSize));
  if (sessPage > totalPages) sessPage = totalPages;
  const start = (sessPage - 1) * sessPageSize;
  const pageSlice = filtered.slice(start, start + sessPageSize);

  const countEl = document.getElementById('sess-count');
  if (countEl) countEl.textContent = 'Showing ' + (total===0?0:start+1) + '–' + Math.min(start+sessPageSize,total) + ' of ' + total + ' results';

  const tbody = document.getElementById('sess-tbody');
  if (!tbody) return;
  tbody.innerHTML = pageSlice.map(s => {
    const eid = 'ex-sess-' + s.id;
    const promoted = parseArr(s.items_promoted);
    const failed = parseArr(s.items_failed);
    const dur = s.started_at && s.ended_at ? Math.round((new Date(s.ended_at)-new Date(s.started_at))/60000) : null;
    return '<tr class="clickable-row" data-expand="'+eid+'">'
      + '<td class="mono">#'+s.id+'</td>'
      + '<td class="dim">'+fmt(s.cycles_requested)+'</td>'
      + '<td class="dim">'+fmt(s.cycles_completed)+'</td>'
      + '<td><span class="tag">'+esc(s.interface||'—')+'</span></td>'
      + '<td>'+(promoted.length ? '<span class="badge badge-num">'+promoted.length+'</span>' : '<span class="dim">0</span>')+'</td>'
      + '<td>'+(failed.length ? '<span class="badge badge-fail">'+failed.length+'</span>' : '<span class="dim">0</span>')+'</td>'
      + '<td style="max-width:320px"><span title="'+esc(s.summary||'')+'">'+esc(trunc(s.summary||'—', 80))+'</span></td>'
      + '<td class="dim">' + timeAgoCell(s.started_at) + '</td>'
      + '<td class="dim">' + timeAgoCell(s.ended_at) + '</td>'
      + '<td class="dim">'+(dur !== null ? dur+'m' : '—')+'</td>'
      + '</tr>'
      + '<tr class="expand-row" id="'+eid+'"><td colspan="10">'
      + '<div class="expand-grid">'
      + (s.summary ? '<div class="expand-field"><label>Full Summary</label><p>'+esc(s.summary)+'</p></div>' : '')
      + (promoted.length ? '<div class="expand-field"><label>Items Promoted</label><p>'+promoted.map(i=>'<span class="tag">'+esc(String(i))+'</span>').join(' ')+'</p></div>' : '')
      + (failed.length ? '<div class="expand-field errors"><label>Items Failed</label><p>'+failed.map(i=>'<span class="tag">'+esc(String(i))+'</span>').join(' ')+'</p></div>' : '')
      + '</div></td></tr>';
  }).join('');
  document.querySelectorAll('#tbl-sessions .clickable-row').forEach(row => {
    row.addEventListener('click', () => {
      const er = document.getElementById(row.dataset.expand);
      if (er) er.classList.toggle('open');
    });
  });
  renderPagination('sess-pgbar', sessPage, totalPages, total, sessPageSize, start,
    (pg) => { sessPage = pg; redrawSessions(); },
    (sz) => { sessPageSize = sz; sessPage = 1; redrawSessions(); }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE: Cycles
// ─────────────────────────────────────────────────────────────────────────────
let cyclesFilter = { phase:[], outcome:[], agent:'', itemId:'', dateFrom:'', dateTo:'' };
let cyclesPage = 1;
let cyclesPageSize = 10;

function renderCyclesPage(data) {
  const agents = [...new Set(data.map(c => c.agent_used).filter(Boolean))].sort();
  const agentOpts = '<option value="">All agents</option>' + agents.map(a=>'<option value="'+esc(a)+'">'+esc(a)+'</option>').join('');

  $('pageContent').innerHTML = '<div class="filter-bar">'
    + '<div class="filter-group"><label>Phase</label><div class="check-group">'
    + ['plan','do','check','act'].map(p=>'<label class="check-pill'+(cyclesFilter.phase.includes(p)?' checked':'')+'"><input type="checkbox" '+(cyclesFilter.phase.includes(p)?'checked':'')+' onchange="toggleFilter(cyclesFilter.phase,\\''+p+'\\',this.checked);this.parentElement.classList.toggle(\\'checked\\',this.checked);cyclesPage=1;redrawCycles()"> '+p+'</label>').join('')
    + '</div></div>'
    + '<div class="filter-group"><label>Outcome</label><div class="check-group">'
    + ['pass','fail','partial','skipped'].map(o=>'<label class="check-pill'+(cyclesFilter.outcome.includes(o)?' checked':'')+'"><input type="checkbox" '+(cyclesFilter.outcome.includes(o)?'checked':'')+' onchange="toggleFilter(cyclesFilter.outcome,\\''+o+'\\',this.checked);this.parentElement.classList.toggle(\\'checked\\',this.checked);cyclesPage=1;redrawCycles()"> '+o+'</label>').join('')
    + '</div></div>'
    + '<div class="filter-group"><label>Agent</label><select onchange="cyclesFilter.agent=this.value;cyclesPage=1;redrawCycles()">'+agentOpts+'</select></div>'
    + '<div class="filter-group"><label>Item ID</label><input type="text" placeholder="e.g. 42" style="width:80px" value="'+esc(cyclesFilter.itemId)+'" oninput="cyclesFilter.itemId=this.value;cyclesPage=1;redrawCycles()"></div>'
    + '<div class="filter-group"><label>From</label><input type="date" value="'+cyclesFilter.dateFrom+'" onchange="cyclesFilter.dateFrom=this.value;cyclesPage=1;redrawCycles()"></div>'
    + '<div class="filter-group"><label>To</label><input type="date" value="'+cyclesFilter.dateTo+'" onchange="cyclesFilter.dateTo=this.value;cyclesPage=1;redrawCycles()"></div>'
    + '<button class="clear-btn" onclick="cyclesFilter={phase:[],outcome:[],agent:\\'\\',itemId:\\'\\',dateFrom:\\'\\',dateTo:\\'\\'};cyclesPage=1;renderCyclesPage(cache.cycles||[])">Clear</button>'
    + '</div>'
    + '<div class="result-count" id="cycles-count"></div>'
    + '<div class="table-wrap">'
    + '<div class="table-toolbar">' + makeDensityBtn('tbl-cycles') + '</div>'
    + '<div class="table-scroll"><table id="tbl-cycles">'
    + '<thead><tr>'
    + '<th data-col="id">ID</th><th data-col="item_id">Item ID</th><th data-col="phase">Phase</th>'
    + '<th data-col="outcome">Outcome</th><th data-col="agent_used">Agent</th>'
    + '<th data-col="plan_notes">Plan Notes</th><th data-col="actual_notes">Actual Notes</th>'
    + '<th data-col="errors">Errors</th><th data-col="git_commit">Commit</th>'
    + '<th data-col="duration_mins">Dur(m)</th><th data-col="ended_at">Ended At</th>'
    + '</tr></thead><tbody id="cycles-tbody"></tbody></table></div>'
    + '<div class="pagination-bar" id="cycles-pgbar"></div>'
    + '</div>';

  attachSortHeaders('tbl-cycles', 'cycles', () => { cyclesPage=1; redrawCycles(); });
  applyDensity('tbl-cycles');
  redrawCycles();
}

function redrawCycles() {
  const data = cache.cycles || [];
  const f = cyclesFilter;
  const st = sortState['cycles'] || {};
  let filtered = data.filter(c => {
    if (f.phase.length && !f.phase.includes(c.phase)) return false;
    if (f.outcome.length && !f.outcome.includes(c.outcome)) return false;
    if (f.agent && c.agent_used !== f.agent) return false;
    if (f.itemId && String(c.item_id) !== f.itemId.trim()) return false;
    if (f.dateFrom && c.ended_at && c.ended_at < f.dateFrom) return false;
    if (f.dateTo && c.ended_at && c.ended_at > f.dateTo + 'T23:59:59') return false;
    return true;
  });
  filtered = sortData(filtered, st.col, st.dir);
  applyThSortClasses('tbl-cycles', 'cycles');

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / cyclesPageSize));
  if (cyclesPage > totalPages) cyclesPage = totalPages;
  const start = (cyclesPage - 1) * cyclesPageSize;
  const pageSlice = filtered.slice(start, start + cyclesPageSize);

  const countEl = document.getElementById('cycles-count');
  if (countEl) countEl.textContent = 'Showing ' + (total===0?0:start+1) + '–' + Math.min(start+cyclesPageSize,total) + ' of ' + total + ' results';

  const tbody = document.getElementById('cycles-tbody');
  if (!tbody) return;
  tbody.innerHTML = pageSlice.map(c => {
    const eid = 'ex-cyc-' + c.id;
    const hasDetail = c.plan_notes || c.actual_notes || c.errors || c.remarks;
    return '<tr class="'+(hasDetail?'clickable-row':'')+'" '+(hasDetail?'data-expand="'+eid+'"':'')+' title="'+(hasDetail?'Click to expand':'')+'">'
      + '<td class="mono">#'+c.id+'</td>'
      + '<td class="mono">#'+c.item_id+'</td>'
      + '<td>'+phaseBadge(c.phase)+'</td>'
      + '<td>'+outcomeBadge(c.outcome)+'</td>'
      + '<td class="dim">'+fmt(c.agent_used)+'</td>'
      + '<td class="dim" title="'+esc(c.plan_notes||'')+'">'+esc(trunc(c.plan_notes||'', 60))+'</td>'
      + '<td class="dim" title="'+esc(c.actual_notes||'')+'">'+esc(trunc(c.actual_notes||'', 60))+'</td>'
      + '<td style="color:var(--red)" title="'+esc(c.errors||'')+'">'+esc(trunc(c.errors||'', 60))+'</td>'
      + '<td class="mono">'+(c.git_commit ? '<span title="'+esc(c.git_commit)+'">'+esc(c.git_commit.substring(0,8))+'</span>' : '—')+'</td>'
      + '<td class="dim">'+fmt(c.duration_mins)+'</td>'
      + '<td class="dim">' + timeAgoCell(c.ended_at) + '</td>'
      + '</tr>'
      + (hasDetail ? '<tr class="expand-row" id="'+eid+'"><td colspan="11"><div class="expand-grid">'
        + (c.plan_notes ? '<div class="expand-field"><label>Plan Notes</label><p>'+esc(c.plan_notes)+'</p></div>' : '')
        + (c.actual_notes ? '<div class="expand-field"><label>Actual Notes</label><p>'+esc(c.actual_notes)+'</p></div>' : '')
        + (c.errors ? '<div class="expand-field errors"><label>Errors</label><p>'+esc(c.errors)+'</p></div>' : '')
        + (c.remarks ? '<div class="expand-field"><label>Remarks</label><p>'+esc(c.remarks)+'</p></div>' : '')
        + '</div></td></tr>' : '');
  }).join('');
  attachExpand(document.getElementById('tbl-cycles'));
  renderPagination('cycles-pgbar', cyclesPage, totalPages, total, cyclesPageSize, start,
    (pg) => { cyclesPage = pg; redrawCycles(); },
    (sz) => { cyclesPageSize = sz; cyclesPage = 1; redrawCycles(); }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE: File Changes
// ─────────────────────────────────────────────────────────────────────────────
let fcFilter = { search:'', changeType:'', itemId:'', commit:'', dateFrom:'', dateTo:'' };
let fcPage = 1;
let fcPageSize = 10;

function renderFileChangesPage(data) {
  const types = [...new Set(data.map(f => f.change_type).filter(Boolean))].sort();
  const typeOpts = '<option value="">All types</option>' + types.map(t=>'<option value="'+esc(t)+'">'+esc(t)+'</option>').join('');

  $('pageContent').innerHTML = '<div class="filter-bar">'
    + '<div class="filter-group"><label>File Path</label><input type="text" placeholder="Search path…" value="'+esc(fcFilter.search)+'" oninput="fcFilter.search=this.value;fcPage=1;redrawFC()"></div>'
    + '<div class="filter-group"><label>Change Type</label><select onchange="fcFilter.changeType=this.value;fcPage=1;redrawFC()">'+typeOpts+'</select></div>'
    + '<div class="filter-group"><label>Item ID</label><input type="text" placeholder="e.g. 42" style="width:80px" value="'+esc(fcFilter.itemId)+'" oninput="fcFilter.itemId=this.value;fcPage=1;redrawFC()"></div>'
    + '<div class="filter-group"><label>Git Commit</label><input type="text" placeholder="commit hash" style="width:120px" value="'+esc(fcFilter.commit)+'" oninput="fcFilter.commit=this.value;fcPage=1;redrawFC()"></div>'
    + '<div class="filter-group"><label>From</label><input type="date" value="'+fcFilter.dateFrom+'" onchange="fcFilter.dateFrom=this.value;fcPage=1;redrawFC()"></div>'
    + '<div class="filter-group"><label>To</label><input type="date" value="'+fcFilter.dateTo+'" onchange="fcFilter.dateTo=this.value;fcPage=1;redrawFC()"></div>'
    + '<button class="clear-btn" onclick="fcFilter={search:\\'\\',changeType:\\'\\',itemId:\\'\\',commit:\\'\\',dateFrom:\\'\\',dateTo:\\'\\'};fcPage=1;renderFileChangesPage(cache[\\'file-changes\\']||[])">Clear</button>'
    + '</div>'
    + '<div class="result-count" id="fc-count"></div>'
    + '<div class="table-wrap">'
    + '<div class="table-toolbar">' + makeDensityBtn('tbl-fc') + '</div>'
    + '<div class="table-scroll"><table id="tbl-fc">'
    + '<thead><tr>'
    + '<th data-col="id">ID</th><th data-col="item_id">Item ID</th><th data-col="file_path">File Path</th>'
    + '<th data-col="change_type">Change Type</th><th data-col="git_commit">Commit</th>'
    + '<th data-col="description">Description</th><th data-col="changed_at">Changed At</th>'
    + '</tr></thead><tbody id="fc-tbody"></tbody></table></div>'
    + '<div class="pagination-bar" id="fc-pgbar"></div>'
    + '</div>';

  attachSortHeaders('tbl-fc', 'fc', () => { fcPage=1; redrawFC(); });
  applyDensity('tbl-fc');
  redrawFC();
}

function redrawFC() {
  const data = cache['file-changes'] || [];
  const f = fcFilter;
  const st = sortState['fc'] || {};
  let filtered = data.filter(r => {
    if (f.search && !String(r.file_path||'').toLowerCase().includes(f.search.toLowerCase())) return false;
    if (f.changeType && r.change_type !== f.changeType) return false;
    if (f.itemId && String(r.item_id) !== f.itemId.trim()) return false;
    if (f.commit && !String(r.git_commit||'').startsWith(f.commit)) return false;
    if (f.dateFrom && r.changed_at && r.changed_at < f.dateFrom) return false;
    if (f.dateTo && r.changed_at && r.changed_at > f.dateTo + 'T23:59:59') return false;
    return true;
  });
  filtered = sortData(filtered, st.col, st.dir);
  applyThSortClasses('tbl-fc', 'fc');

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / fcPageSize));
  if (fcPage > totalPages) fcPage = totalPages;
  const start = (fcPage - 1) * fcPageSize;
  const pageSlice = filtered.slice(start, start + fcPageSize);

  const countEl = document.getElementById('fc-count');
  if (countEl) countEl.textContent = 'Showing ' + (total===0?0:start+1) + '–' + Math.min(start+fcPageSize,total) + ' of ' + total + ' results';

  const tbody = document.getElementById('fc-tbody');
  if (!tbody) return;
  tbody.innerHTML = pageSlice.map(r =>
    '<tr>'
    + '<td class="mono">#'+r.id+'</td>'
    + '<td class="mono">#'+r.item_id+'</td>'
    + '<td class="mono" style="font-size:12px" title="'+esc(r.file_path||'')+'">'+esc(truncMiddle(r.file_path||'', 60))+'</td>'
    + '<td><span class="tag">'+esc(fmt(r.change_type))+'</span></td>'
    + '<td class="mono">'+(r.git_commit ? '<span title="'+esc(r.git_commit)+'">'+esc(r.git_commit.substring(0,8))+'</span>' : '—')+'</td>'
    + '<td class="dim" title="'+esc(r.description||'')+'">'+esc(trunc(r.description||'', 60))+'</td>'
    + '<td class="dim">' + timeAgoCell(r.changed_at) + '</td>'
    + '</tr>'
  ).join('');
  renderPagination('fc-pgbar', fcPage, totalPages, total, fcPageSize, start,
    (pg) => { fcPage = pg; redrawFC(); },
    (sz) => { fcPageSize = sz; fcPage = 1; redrawFC(); }
  );
}

// ── Init ──────────────────────────────────────────────────────────────────────

// Restore page from URL on load / refresh
try {
  (function initFromUrl() {
    var VALID_PAGES = ['overview', 'items', 'gantt', 'sessions', 'cycles', 'file-changes'];
    var rawPath = window.location.pathname.slice(1) || 'overview';
    var page = VALID_PAGES.indexOf(rawPath) !== -1 ? rawPath : 'overview';
    currentPage = page;
    document.querySelectorAll('.nav-item').forEach(function(n) {
      n.classList.toggle('active', n.dataset.page === page);
    });
    var titleEl = document.getElementById('pageTitle');
    if (titleEl) titleEl.textContent = PAGE_TITLES[page] || page;
    try { history.replaceState({ page: page }, '', '/' + (page === 'overview' ? '' : page)); } catch(e2) {}
  })();
} catch(e) {
  console.error('initFromUrl failed:', e);
}

// Handle browser back / forward
window.addEventListener('popstate', e => {
  const page = (e.state && e.state.page) || 'overview';
  currentPage = page;
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.page === page);
  });
  $('pageTitle').textContent = PAGE_TITLES[page] || page;
  if (currentProject) loadPage(page);
});

loadProjects();
startCountdown();
</script>
</body>
</html>`;

// Serve dashboard for all non-API routes (SPA fallback)
app.get('*', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(DASHBOARD_HTML);
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`PDCA Dashboard running at http://0.0.0.0:${PORT}`);
});
