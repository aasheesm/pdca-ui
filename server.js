'use strict';

const express = require('express');
const Database = require('better-sqlite3');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const PORT = 7010;
const DB_PATH = '/root/data/assistant/tasks.db';
const AUTH_USER = 'ashish@konzult.in';
const AUTH_HASH = '$2b$14$N0/MVQbizO9uAx/6AP6dWO6EKsRTMixRdQjo/Kc/TMg2wXHwdyKXC';

let db;

try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec("CREATE TABLE IF NOT EXISTS pdca_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, line TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')))");

  // ── PDCA v2 migration: chain columns + pdca_projects table ──────────────────
  (function runMigrations() {
    const cols = new Set(db.prepare('PRAGMA table_info(pdca_items)').all().map(c => c.name));
    const addCol = (col, type) => {
      if (!cols.has(col)) db.prepare(`ALTER TABLE pdca_items ADD COLUMN ${col} ${type}`).run();
    };
    // Chain-tracking columns
    const chainCols = ['source_id','chain_root_id','iteration','chain_status','escalated_to','check_verdict','check_score','check_evidence','act_learnings'];
    chainCols.forEach(col => addCol(col, 'TEXT'));
    // Additional chain-tracking columns (v2 migration)
    addCol('stuck_count', 'INTEGER NOT NULL DEFAULT 0');
    addCol('notified_at', 'DATETIME');
    addCol('project_dir', 'TEXT');
    // Lean PDCA fields (v2 migration)
    addCol('hypothesis', 'TEXT');
    addCol('acceptance_criteria', 'TEXT');
    addCol('check_gaps', 'TEXT');
    // Indexes
    db.exec(`CREATE INDEX IF NOT EXISTS idx_pdca_chain_root  ON pdca_items(chain_root_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_pdca_source     ON pdca_items(source_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_pdca_status_phase ON pdca_items(status, phase)`);
    // pdca_projects table — v2 schema
    const hasProjectsTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pdca_projects'").get();
    if (!hasProjectsTable) {
      db.exec(`CREATE TABLE pdca_projects (
        project_id      TEXT PRIMARY KEY,
        project_dir     TEXT NOT NULL,
        default_agent   TEXT,
        max_iterations  INTEGER NOT NULL DEFAULT 3,
        check_strategy  TEXT NOT NULL DEFAULT 'typecheck'
                         CHECK(check_strategy IN ('typecheck','server-smoke','curl-endpoint','expo-start','manual')),
        active          INTEGER NOT NULL DEFAULT 1
      )`);
      // Seed known projects
      const insertProject = db.prepare(
        'INSERT INTO pdca_projects (project_id, project_dir, default_agent, max_iterations, check_strategy, active) VALUES (?,?,?,?,?,?)'
      );
      const seedProjects = [
        ['WorkBuddy', '/root/projects/workbuddy', 'workbuddy-agent', 3, 'expo-start',    1],
        ['pdca-ui',   '/root/projects/pdca-ui',   'general-purpose', 3, 'server-smoke',  1],
        ['ERP',       '/root/projects/ERP',        'erp-agent',       3, 'server-smoke',  1],
        ['Konzult',   '/root/projects/sitegen',    'konzult-agent',   3, 'curl-endpoint', 1],
        ['Pulse',     '/root/projects/pulse',      'pulse-agent',     3, 'typecheck',     1],
      ];
      seedProjects.forEach(row => { try { insertProject.run(...row); } catch (_) {} });
    }
    // Backfill legacy rows with chain metadata
    db.prepare(`UPDATE pdca_items SET chain_root_id = CAST(id AS TEXT) WHERE chain_root_id IS NULL OR chain_root_id = ''`).run();
    db.prepare(`UPDATE pdca_items SET iteration = '1' WHERE iteration IS NULL OR iteration = ''`).run();
    db.prepare(`UPDATE pdca_items SET chain_status = CASE
      WHEN status = 'complete' THEN 'complete'
      WHEN status IN ('cancelled','dropped') THEN 'abandoned'
      ELSE 'active' END
      WHERE chain_status IS NULL OR chain_status = ''`).run();
  })();
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
  // Allow internal localhost API calls (auto-queue from queue processor)
  if (req.path.match(/\/api\/items\/\d+\/auto-queue-dependents$/) && (req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1')) return next();
  if (req.path === '/api/batch-unlock' && (req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1')) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  res.redirect('/login');
}

// ── GlitchTip Webhook → PDCA Integration ──────────────────────────────────────
// Receives error alerts from GlitchTip and auto-creates PDCA items.
// Must be BEFORE the auth middleware since GlitchTip calls us without session.
app.post('/api/glitchtip-webhook', express.json(), (req, res) => {
  try {
    const body = req.body;
    const data = body.data || body;
    const issue = data.issue || {};

    // Extract info from GlitchTip alert payload
    const issueTitle = issue.title || data.title || data.message || 'Untitled Error';
    const issueUrl = issue.url || '';
    const projectSlug = (issue.project?.slug || data.project?.slug || 'unknown').toLowerCase();
    const level = issue.level ?? data.level ?? 'error';
    const culprit = issue.culprit || '';
    const eventCount = issue.count || 1;
    const userCount = issue.userCount || 0;
    const firstSeen = issue.firstSeen || '';
    const lastSeen = issue.lastSeen || '';
    const tags = issue.tags || [];
    const environment = (tags.find(t => t?.key === 'environment') || {}).value || 'production';
    const release = (tags.find(t => t?.key === 'release') || {}).value || 'unknown';

    // Map severity: fatal/critical → critical, error → high, warning → medium, else → low
    let priority = 'medium';
    if (level === 'fatal' || level === 4 || String(level) === 'critical') priority = 'critical';
    else if (level === 'error' || level === 3) priority = 'high';
    else if (level === 'warning' || level === 2) priority = 'medium';
    else priority = 'low';

    // Map project slug to PDCA project
    let pdcaProjectId = 'WorkBuddy';
    if (projectSlug.includes('native') || projectSlug.includes('mobile') || projectSlug.includes('app')) {
      pdcaProjectId = 'WorkBuddy';
    } else if (projectSlug.includes('backend') || projectSlug.includes('api') || projectSlug.includes('server')) {
      pdcaProjectId = 'WorkBuddy';
    }

    // Build slug from title
    const slugBase = issueTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
    const slug = 'glitch-' + slugBase + '-' + Date.now().toString(36);

    // Rich description with source tracking
    const planDesc = [
      'Source: GlitchTip (glitchtip.konzult.in)',
      'Project: ' + projectSlug,
      'Environment: ' + environment,
      'Level: ' + level,
      'Release: ' + release,
      'Occurrences: ' + eventCount,
      'Users affected: ' + userCount,
      lastSeen ? 'Last seen: ' + lastSeen : '',
      firstSeen ? 'First seen: ' + firstSeen : '',
      culprit ? 'Location: ' + culprit : '',
      issueUrl ? 'GlitchTip URL: ' + issueUrl : '',
      '---',
      'This issue was auto-reported from the live production server.',
      'Fix this and mark the PDCA item as complete.'
    ].filter(Boolean).join('\n');

    const actualDesc = 'Auto-created from GlitchTip alert. ' + eventCount + ' occurrence(s) from ' + environment + '. ' + userCount + ' user(s) affected.';

    // Avoid duplicates: check if similar open issue exists
    const existing = db.prepare(
      "SELECT id, status FROM pdca_items WHERE project_id = ? AND title LIKE ? AND status IN ('open','in-progress','queued') ORDER BY id DESC LIMIT 1"
    ).get(pdcaProjectId, '%' + issueTitle.slice(0, 50) + '%');

    if (existing) {
      // Update existing item with new occurrence info
      db.prepare("UPDATE pdca_items SET actual_description = ? WHERE id = ?")
        .run(actualDesc, existing.id);
      db.prepare("INSERT INTO pdca_logs (item_id, line, created_at) VALUES (?, ?, datetime('now','localtime'))")
        .run(existing.id, '[GlitchTip] Recurring error: +1 occurrence | Total: ' + eventCount + ' | Users: ' + userCount);
      return res.json({ ok: true, action: 'updated', id: existing.id });
    }

    // Create new PDCA item
    const result = db.prepare(`
      INSERT INTO pdca_items (
        project_id, slug, title, phase, status, priority, category,
        plan_description, actual_description, agent_assigned,
        created_at, started_at, hypothesis, acceptance_criteria
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'), ?, ?)
    `).run(
      pdcaProjectId,
      slug,
      '[GlitchTip] ' + issueTitle,
      'plan',
      'open',
      priority,
      'bug',
      planDesc,
      actualDesc,
      'glitchtip-webhook',
      'Error originates from ' + environment + ' environment on the live production server.',
      'Error no longer appears in GlitchTip dashboard and no users are affected.'
    );

    const itemId = result.lastInsertRowid;

    // Log the creation
    db.prepare("INSERT INTO pdca_logs (item_id, line, created_at) VALUES (?, ?, datetime('now','localtime'))")
      .run(itemId, '[GlitchTip] New error reported: ' + issueTitle + ' | Project: ' + projectSlug + ' | Env: ' + environment + ' | Level: ' + level + ' | Count: ' + eventCount);

    console.log('[GlitchTip→PDCA] Created #' + itemId + ': ' + issueTitle + ' [' + priority + '] from ' + projectSlug);
    res.json({ ok: true, action: 'created', id: itemId, slug, priority });
  } catch (err) {
    console.error('[GlitchTip→PDCA] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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
      SELECT i.*,
        CASE i.priority
          WHEN 'critical' THEN 1
          WHEN 'high'     THEN 2
          WHEN 'medium'   THEN 3
          ELSE 4
        END AS priority_rank,
        COALESCE(dep.blocks_count, 0) AS blocks_count,
        blocker.title AS blocked_by_title
      FROM pdca_items i
      LEFT JOIN (
        SELECT depends_on, COUNT(*) AS blocks_count
        FROM pdca_items
        WHERE status IN ('open','queued','in-progress') AND depends_on IS NOT NULL
        GROUP BY depends_on
      ) dep ON dep.depends_on = i.id
      LEFT JOIN pdca_items blocker ON blocker.id = i.depends_on
        AND blocker.status != 'complete'
      WHERE i.project_id = ?
      ORDER BY priority_rank, i.created_at
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

app.get('/api/activities', (req, res) => {
  try {
    const { project, status, type, limit } = req.query;
    if (!project) return res.status(400).json({ error: 'project param required' });
    const lim = Math.min(parseInt(limit) || 200, 500);

    // Match by: (1) direct project column, OR (2) linked PDCA item in this project, OR (3) global/cross-project activities
    let whereClause = 'WHERE (a.project = ? OR a.project = ?)';
    const params = [project, 'global'];
    // Also include activities linked to PDCA items in this project
    whereClause += ' OR a.pdca_item_id IN (SELECT id FROM pdca_items WHERE project_id = ?)';
    params.push(project);

    if (status) {
      whereClause += ' AND a.status = ?';
      params.push(status);
    }

    if (type) {
      whereClause += ' AND a.activity_type = ?';
      params.push(type);
    }

    const rows = db.prepare(`
      SELECT a.* FROM activity_log a
      ${whereClause}
      ORDER BY a.id DESC
      LIMIT ?
    `).all(...params, lim);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chains', (req, res) => {
  try {
    const { project } = req.query;
    if (!project) return res.status(400).json({ error: 'project param required' });

    const itemCols = new Set(
      db.prepare('PRAGMA table_info(pdca_items)').all().map(col => col.name)
    );
    const requiredCols = [
      'source_id', 'chain_root_id', 'iteration', 'chain_status',
      'escalated_to', 'check_verdict', 'check_score', 'check_evidence',
      'act_learnings'
    ];
    const missing = requiredCols.filter(col => !itemCols.has(col));
    const hasProjectsTable = !!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='pdca_projects'"
    ).get();

    if (missing.length || !hasProjectsTable) {
      return res.json({
        supported: false,
        missing_columns: missing,
        missing_tables: hasProjectsTable ? [] : ['pdca_projects'],
        chains: []
      });
    }

    const chains = db.prepare(`
      SELECT
        chain_root_id,
        project_id,
        MAX(CASE WHEN id = chain_root_id THEN title END) AS root_title,
        MAX(COALESCE(chain_status, 'active')) AS chain_status,
        MAX(COALESCE(iteration, 1)) AS max_iteration,
        MAX(COALESCE(check_score, 0)) AS latest_check_score,
        MAX(CASE WHEN phase = 'check' THEN check_verdict END) AS latest_check_verdict,
        MAX(CASE WHEN escalated_to IS NOT NULL THEN escalated_to END) AS escalated_to,
        SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS completed_items,
        COUNT(*) AS total_items,
        MAX(created_at) AS last_activity_at
      FROM pdca_items
      WHERE project_id = ?
        AND chain_root_id IS NOT NULL
      GROUP BY chain_root_id, project_id
      ORDER BY last_activity_at DESC, chain_root_id DESC
    `).all(project);

    res.json({ supported: true, chains });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Dependency Chain Helpers ───────────────────────────────────────────────────
// Walk the depends_on ancestry chain recursively
function getAncestorChain(itemById, startId) {
  const visited = new Set();
  const chain = [];
  let current = startId;
  while (current && !visited.has(current)) {
    visited.add(current);
    const item = itemById[current];
    if (!item) break;
    chain.push(item);
    current = item.depends_on;
  }
  return chain; // [startItem, parentItem, grandparentItem, ...]
}

// Walk all descendants (items that depend_on this item, recursively)
function getDescendantChain(items, startId) {
  const childMap = {};
  items.forEach(i => {
    if (i.depends_on) {
      if (!childMap[i.depends_on]) childMap[i.depends_on] = [];
      childMap[i.depends_on].push(i);
    }
  });
  const visited = new Set();
  const chain = [];
  const stack = [startId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    const children = childMap[id] || [];
    children.forEach(c => {
      chain.push(c);
      stack.push(c.id);
    });
  }
  return chain; // [childItem, grandchildItem, ...]
}

// ── Get full dependency chain for an item ─────────────────────────────────────
app.get('/api/items/:id/dependency-chain', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const item = db.prepare('SELECT * FROM pdca_items WHERE id = ?').get(id);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    // Fetch all items in same project for chain resolution
    const projectItems = db.prepare('SELECT * FROM pdca_items WHERE project_id = ?').all(item.project_id);
    const itemById = {};
    projectItems.forEach(i => { itemById[i.id] = i; });

    const ancestors = getAncestorChain(itemById, id);
    const descendants = getDescendantChain(projectItems, id);

    // Check if all ancestors are complete → determines "ready" state
    const incompleteAncestors = ancestors.filter(a => a.id !== id && a.status !== 'complete' && a.status !== 'cancelled' && a.status !== 'dropped');

    res.json({
      item: { id: item.id, title: item.title, status: item.status, phase: item.phase, depends_on: item.depends_on },
      ancestors: ancestors.filter(a => a.id !== id).map(a => ({ id: a.id, title: a.title, status: a.status, phase: a.phase, depends_on: a.depends_on })),
      descendants: descendants.map(d => ({ id: d.id, title: d.title, status: d.status, phase: d.phase, depends_on: d.depends_on })),
      ready: incompleteAncestors.length === 0,
      blocked_by: incompleteAncestors.map(a => ({ id: a.id, title: a.title, status: a.status }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Queue a single item (open → queued). Zero LLM calls — just state change + kick processor.
// ENFORCED: No item can be queued if any transitive dependency (ancestor) is not complete.
app.post('/api/items/:id/queue', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const row = db.prepare('SELECT id, status, agent_assigned, depends_on, project_id FROM pdca_items WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Item not found' });
    if (!['open'].includes(row.status)) {
      return res.json({ ok: false, message: `Item is already ${row.status} — cannot queue` });
    }

    // ── Hierarchical dependency gate ────────────────────────────────────────
    // Walk the entire depends_on chain and verify ALL ancestors are complete
    if (row.depends_on) {
      const projectItems = db.prepare('SELECT id, title, status, depends_on FROM pdca_items WHERE project_id = ?').all(row.project_id);
      const itemById = {};
      projectItems.forEach(i => { itemById[i.id] = i; });

      const ancestors = getAncestorChain(itemById, id);
      const incompleteAncestors = ancestors.filter(a => a.id !== id && a.status !== 'complete' && a.status !== 'cancelled' && a.status !== 'dropped');

      if (incompleteAncestors.length > 0) {
        const blockers = incompleteAncestors.map(a => `#${a.id} ${a.title} (${a.status})`);
        return res.json({
          ok: false,
          message: `Cannot queue: ${incompleteAncestors.length} incomplete ancestor(s). All dependencies must be complete before queueing.`,
          blocked_by: incompleteAncestors.map(a => ({ id: a.id, title: a.title, status: a.status }))
        });
      }
    }

    db.prepare("UPDATE pdca_items SET status='queued', started_at=datetime('now', 'localtime') WHERE id=?").run(id);

    // Kick the queue processor in the background (non-blocking)
    const { spawn } = require('child_process');
    spawn('/root/scripts/pdca-queue-processor.sh', [row.agent_assigned || ''], {
      detached: true, stdio: 'ignore'
    }).unref();

    res.json({ ok: true, message: 'Queued' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Auto-queue unlocked items when a dependency completes ────────────────────
// BFS through descendants: find all items that depend (transitively) on the completed item.
// For each such item that is in 'open' status and has ALL ancestors complete, auto-queue it.
function autoQueueUnlockedItems(completedItemId) {
  const completed = db.prepare('SELECT id, project_id FROM pdca_items WHERE id = ?').get(completedItemId);
  if (!completed) return [];

  const allProjectItems = db.prepare('SELECT id, title, status, depends_on, agent_assigned FROM pdca_items WHERE project_id = ?').all(completed.project_id);
  const itemById = {};
  allProjectItems.forEach(i => { itemById[i.id] = i; });

  // Build child map: parent_id → [children]
  const childMap = {};
  allProjectItems.forEach(i => {
    if (i.depends_on) {
      if (!childMap[i.depends_on]) childMap[i.depends_on] = [];
      childMap[i.depends_on].push(i);
    }
  });

  // BFS: find all descendants of the completed item
  const visited = new Set();
  const queue = [completedItemId];
  while (queue.length > 0) {
    const parentId = queue.shift();
    if (visited.has(parentId)) continue;
    visited.add(parentId);
    const children = childMap[parentId] || [];
    children.forEach(child => { queue.push(child.id); });
  }

  const autoQueued = [];

  // For each descendant in 'open' status, check if all ancestors are now complete
  allProjectItems.forEach(item => {
    if (item.status !== 'open') return;
    if (!visited.has(item.id)) return; // not a descendant
    if (!item.depends_on) return; // root item — don't auto-queue

    const ancestors = getAncestorChain(itemById, item.id);
    const incompleteAncestors = ancestors.filter(a => a.id !== item.id && a.status !== 'complete' && a.status !== 'cancelled' && a.status !== 'dropped');

    if (incompleteAncestors.length === 0) {
      try {
        db.prepare("UPDATE pdca_items SET status='queued', started_at=datetime('now', 'localtime') WHERE id=?").run(item.id);
        db.prepare("INSERT INTO pdca_logs (item_id, line, created_at) VALUES (?, ?, datetime('now','localtime'))").run(
          item.id,
          '[Auto-Queue] All dependencies now complete (ancestor #' + completedItemId + ' completed). Auto-queued.'
        );
        autoQueued.push({ id: item.id, title: item.title });
      } catch (e) {
        console.error('[Auto-Queue] Failed to auto-queue #' + item.id + ':', e.message);
      }
    }
  });

  // Kick the queue processor if we auto-queued anything
  if (autoQueued.length > 0) {
    const { spawn } = require('child_process');
    spawn('/root/scripts/pdca-queue-processor.sh', [], { detached: true, stdio: 'ignore' }).unref();
  }

  return autoQueued;
}

// ── Mark item as complete (with auto-queue of unlocked children) ──────────────
app.post('/api/items/:id/complete', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { actual_description, check_verdict } = req.body || {};
    const row = db.prepare('SELECT id, status, project_id FROM pdca_items WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Item not found' });

    const updates = ["status='complete'", "completed_at=datetime('now', 'localtime')", "chain_status='complete'"];
    if (actual_description) updates.push("actual_description='" + String(actual_description).replace(/'/g, "''") + "'");
    if (check_verdict) updates.push("check_verdict='" + String(check_verdict).replace(/'/g, "''") + "'");

    db.prepare('UPDATE pdca_items SET ' + updates.join(', ') + ' WHERE id = ?').run(id);

    // Auto-queue any items that were blocked by this one and are now unblocked
    const autoQueued = autoQueueUnlockedItems(id);

    db.prepare("INSERT INTO pdca_logs (item_id, line, created_at) VALUES (?, ?, datetime('now','localtime'))").run(
      id,
      '[Complete] Item marked complete.' + (autoQueued.length > 0 ? ' Auto-queued ' + autoQueued.length + ' dependent item(s): ' + autoQueued.map(a => '#' + a.id).join(', ') : '')
    );

    res.json({ ok: true, message: 'Item #' + id + ' marked complete.', auto_queued: autoQueued });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Auto-queue dependents after completion (internal, called by queue processor) ──
app.post('/api/items/:id/auto-queue-dependents', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const autoQueued = autoQueueUnlockedItems(id);
    res.json({ ok: true, auto_queued: autoQueued });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Batch unlock: auto-queue all open items whose ancestors are all complete ──
app.post('/api/batch-unlock', (req, res) => {
  try {
    const { project } = req.body || {};
    if (!project) return res.status(400).json({ error: 'project param required' });

    const items = db.prepare("SELECT id, title, status, depends_on FROM pdca_items WHERE project_id = ? AND status = 'open'").all(project);
    const itemById = {};
    items.forEach(i => { itemById[i.id] = i; });

    const unlocked = [];

    items.forEach(item => {
      if (!item.depends_on) return; // root items — don't auto-queue
      const ancestors = getAncestorChain(itemById, item.id);
      const incompleteAncestors = ancestors.filter(a => a.id !== item.id && a.status !== 'complete' && a.status !== 'cancelled' && a.status !== 'dropped');

      if (incompleteAncestors.length === 0) {
        db.prepare("UPDATE pdca_items SET status='queued', started_at=datetime('now', 'localtime') WHERE id=?").run(item.id);
        db.prepare("INSERT INTO pdca_logs (item_id, line, created_at) VALUES (?, ?, datetime('now','localtime'))").run(
          item.id,
          '[Batch Unlock] All dependencies complete. Auto-queued via batch unlock.'
        );
        unlocked.push({ id: item.id, title: item.title });
      }
    });

    if (unlocked.length > 0) {
      const { spawn } = require('child_process');
      spawn('/root/scripts/pdca-queue-processor.sh', [], { detached: true, stdio: 'ignore' }).unref();
    }

    res.json({ ok: true, unlocked_count: unlocked.length, unlocked: unlocked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trigger-cycle', (_req, res) => {
  const { spawn } = require('child_process');
  const proc = spawn('/root/scripts/pdca-workbuddy-trigger.sh', [], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  proc.stdout.on('data', d => { output += d.toString(); });
  proc.stderr.on('data', d => { output += d.toString(); });

  proc.on('close', code => {
    // Extract last meaningful log lines (strip timestamps, dedupe)
    const lines = [...new Set(
      output.split('\n')
        .map(l => l.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] /, '').trim())
        .filter(Boolean)
    )];
    res.json({ ok: code === 0, exitCode: code, lines });
  });

  proc.on('error', err => {
    res.status(500).json({ ok: false, error: err.message });
  });
});

// ── Log Endpoints ────────────────────────────────────────────────────────────

app.post('/api/items/:id/logs', express.json(), (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { line } = req.body;
    if (!line) return res.status(400).json({ error: 'line is required' });
    const item = db.prepare('SELECT id FROM pdca_items WHERE id = ?').get(id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    db.prepare("INSERT INTO pdca_logs (item_id, line, created_at) VALUES (?, ?, datetime('now', 'localtime'))").run(id, line);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/items/:id/logs/stream', (req, res) => {
  const id = parseInt(req.params.id);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let lastId = 0;

  function sendLogs() {
    try {
      const item = db.prepare('SELECT status, phase FROM pdca_items WHERE id = ?').get(id);
      if (!item) {
        res.write('event: close\ndata: {"reason":"not_found"}\n\n');
        return cleanup();
      }
      const rows = db.prepare(
        'SELECT id, line, created_at FROM pdca_logs WHERE item_id = ? AND id > ? ORDER BY id ASC'
      ).all(id, lastId);
      rows.forEach(function(row) {
        lastId = row.id;
        const payload = JSON.stringify({ id: row.id, line: row.line, ts: row.created_at });
        res.write('data: ' + payload + '\n\n');
      });
      if (item.status !== 'in-progress' && item.status !== 'queued') {
        if (lastId > 0) {
          res.write('event: close\ndata: {"reason":"completed","status":"' + item.status + '"}\n\n');
          return cleanup();
        }
      }
    } catch (err) {
      console.error('SSE error:', err.message);
    }
  }

  sendLogs();
  const interval = setInterval(sendLogs, 2000);

  function cleanup() {
    clearInterval(interval);
    try { res.end(); } catch(e) {}
  }

  req.on('close', cleanup);
  req.on('error', cleanup);
});

app.get('/api/items/:id/logs', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const rows = db.prepare(
      'SELECT id, line, created_at FROM pdca_logs WHERE item_id = ? ORDER BY id ASC'
    ).all(id);
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

  /* ── Log Modal ── */
  #log-modal-overlay {
    display: none; position: fixed; inset: 0;
    background: rgba(0,0,0,0.75); z-index: 1000;
    align-items: center; justify-content: center;
  }
  #log-modal-overlay.open { display: flex; }
  #log-modal {
    background: #0d1117; border: 1px solid #30363d; border-radius: 10px;
    width: min(860px, 95vw); max-height: 80vh;
    display: flex; flex-direction: column; overflow: hidden;
    box-shadow: 0 24px 64px rgba(0,0,0,0.6);
  }
  #log-modal-header {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 16px; border-bottom: 1px solid #21262d; flex-shrink: 0;
  }
  #log-modal-title {
    flex: 1; font-size: 13px; font-weight: 600; color: #e6edf3;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #log-modal-live-badge {
    display: inline-flex; align-items: center; gap: 5px;
    background: rgba(34,197,94,0.12); border: 1px solid rgba(34,197,94,0.3);
    border-radius: 12px; color: #22c55e; font-size: 11px; font-weight: 700;
    padding: 2px 10px; letter-spacing: 0.5px;
  }
  #log-modal-live-badge .live-dot {
    width: 6px; height: 6px; background: #22c55e; border-radius: 50%;
    animation: livePulse 1.2s ease-in-out infinite;
  }
  #log-modal-live-badge.disconnected {
    background: rgba(100,116,139,0.12); border-color: rgba(100,116,139,0.3); color: #64748b;
  }
  #log-modal-live-badge.disconnected .live-dot { background: #64748b; animation: none; }
  @keyframes livePulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  #log-modal-close {
    background: transparent; border: none; color: #8b949e; cursor: pointer;
    font-size: 18px; line-height: 1; padding: 2px 6px; border-radius: 4px;
    transition: color 0.1s, background 0.1s;
  }
  #log-modal-close:hover { color: #e6edf3; background: #21262d; }
  #log-modal-body {
    flex: 1; overflow-y: auto; padding: 12px 16px;
    font-family: 'JetBrains Mono', 'Fira Code', 'Courier New', monospace;
    font-size: 12px; line-height: 1.6; color: #8b949e; background: #0d1117;
  }
  .log-line { display: flex; gap: 10px; padding: 1px 0; }
  .log-ts { color: #484f58; white-space: nowrap; flex-shrink: 0; }
  .log-text { color: #c9d1d9; word-break: break-all; }
  .log-empty { color: #484f58; font-style: italic; }
  #log-modal-footer {
    padding: 8px 16px; border-top: 1px solid #21262d; font-size: 11px; color: #484f58;
    flex-shrink: 0; display: flex; gap: 12px; align-items: center;
  }
  .log-btn {
    background: transparent; border: 1px solid #30363d; border-radius: 5px;
    color: #8b949e; cursor: pointer; font-size: 11px; padding: 3px 10px; transition: all 0.1s;
  }
  .log-btn:hover { border-color: #58a6ff; color: #58a6ff; }

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
  .done-check { color: var(--green); flex-shrink: 0; display: inline-flex; align-items: center; }
  .done-check svg { width: 15px; height: 15px; }
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
  .nav-item .nav-icon { flex-shrink: 0; width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; }
  .nav-item .nav-icon svg { width: 16px; height: 16px; }
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
  .run-now-btn {
    background: rgba(59,130,246,0.1);
    border: 1px solid var(--blue);
    color: var(--blue);
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .run-now-btn:hover { background: rgba(59,130,246,0.2); }
  .run-now-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .row-trigger-btn {
    background: rgba(59,130,246,0.08);
    border: 1px solid rgba(59,130,246,0.35);
    color: var(--blue);
    border-radius: 4px;
    padding: 2px 7px;
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s;
    line-height: 1.4;
  }
  .row-trigger-btn:hover { background: rgba(59,130,246,0.2); }
  .row-trigger-btn:disabled { opacity: 0.4; cursor: not-allowed; }
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
    background: var(--card);
    color: var(--text);
    border: 1px solid var(--border);
    border-left: 4px solid var(--muted);
    padding: 10px 18px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    z-index: 9999;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  #toast.show { opacity: 1; }
  #toast[data-type="success"] { border-left-color: var(--green); }
  #toast[data-type="warn"]    { border-left-color: #eab308; }
  #toast[data-type="error"]   { border-left-color: var(--red); }
  #toast[data-type="info"]    { border-left-color: var(--blue); }

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
  .blocks-badge  { display:inline-block; margin-left:6px; padding:1px 6px; border-radius:4px; font-size:10px; font-weight:600; background:rgba(239,68,68,0.15); color:#f87171; vertical-align:middle; }
  .waiting-badge { display:inline-block; margin-left:6px; padding:1px 6px; border-radius:4px; font-size:10px; font-weight:500; background:rgba(251,191,36,0.12); color:#fbbf24; vertical-align:middle; }
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
    .badge-medium { background: rgba(251,191,36,0.15); color: #fbbf24; }
    .badge-low { background: rgba(100,116,139,0.15); color: var(--muted); }

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
  .empty-state .icon { width: 48px; height: 48px; margin: 0 auto 16px; color: var(--muted); opacity: 0.5; }
  .empty-state .icon svg { width: 48px; height: 48px; }
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
  /* ── Item Cards (mobile view) ── */
  .items-card-view {
    display: none;
    flex-direction: column;
    gap: 10px;
    padding: 2px 0 12px;
  }
  .item-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px;
    cursor: default;
    transition: background 0.1s;
  }
  .item-card.clickable { cursor: pointer; }
  .item-card.clickable:hover { background: var(--hover); }
  .item-card-header {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin-bottom: 10px;
  }
  .item-card-dot { flex-shrink: 0; margin-top: 2px; }
  .item-card-title {
    flex: 1;
    font-size: 13px;
    font-weight: 500;
    color: var(--text);
    line-height: 1.4;
  }
  .item-card-id {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    flex-shrink: 0;
  }
  .item-card-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
  }
  .item-card-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    font-size: 11px;
    color: var(--muted);
  }
  .item-card-meta-item {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .item-card-meta-label { opacity: 0.6; }
  .item-card-expand {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
    display: none;
  }
  .item-card-expand.open { display: block; }
  .item-card-expand .expand-grid { grid-template-columns: 1fr; }

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

    /* Items page: hide table, show cards on mobile */
    .items-table-view { display: none !important; }
    .items-card-view { display: flex !important; }
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
    <div class="nav-item active" data-page="overview"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="10" width="3" height="8" rx="0.5"/><rect x="8.5" y="6" width="3" height="12" rx="0.5"/><rect x="15" y="2" width="3" height="16" rx="0.5"/></svg></span><span class="nav-label">Overview</span></div>
    <div class="nav-item" data-page="items"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 5h13M3.5 10h13M3.5 15h13"/><circle cx="1" cy="5" r="0.5" fill="currentColor"/><circle cx="1" cy="10" r="0.5" fill="currentColor"/><circle cx="1" cy="15" r="0.5" fill="currentColor"/></svg></span><span class="nav-label">Items</span></div>
    <div class="nav-item" data-page="gantt"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3.5" width="15" height="14" rx="2"/><path d="M6.5 2v3M13.5 2v3M2.5 8h15"/><circle cx="7" cy="12" r="1" fill="currentColor"/><circle cx="10" cy="12" r="1" fill="currentColor"/><circle cx="13" cy="12" r="1" fill="currentColor"/></svg></span><span class="nav-label">Gantt</span></div>
    <div class="nav-item" data-page="chains"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 3a1.5 1.5 0 0 1 1.5-1.5h3.879a1.5 1.5 0 0 1 1.06.44l3.122 3.12a1.5 1.5 0 0 1 .44 1.06V15.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 4.5 15.5v-12z"/><path d="M8 7h4M8 10.5h4M8 14h2"/><circle cx="6" cy="7" r="0.75" fill="currentColor"/><circle cx="6" cy="10.5" r="0.75" fill="currentColor"/><circle cx="6" cy="14" r="0.75" fill="currentColor"/></svg></span><span class="nav-label">Chains</span></div>
    <div class="nav-item" data-page="flow"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="10" r="2.5"/><circle cx="16" cy="4" r="2.5"/><circle cx="16" cy="16" r="2.5"/><path d="M6.5 10h4.5M13.5 5.5l-4.5 3.5M13.5 14.5l-4.5-3.5"/></svg></span><span class="nav-label">Flow</span></div>
    <div class="nav-item" data-page="sessions"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h7l4 4v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M12 3v4h4M7 9h6M7 12h6M7 15h4"/></svg></span><span class="nav-label">Sessions</span></div>
    <div class="nav-item" data-page="cycles"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 10a6.5 6.5 0 0 1-11.13 4.58"/><path d="M3.5 10A6.5 6.5 0 0 1 14.63 5.42"/><path d="M14.63 5.42L16 4m-1.37 1.42L16 7.5"/><path d="M5.37 14.58L4 16m1.37-1.42L4 12.5"/></svg></span><span class="nav-label">Cycles</span></div>
    <div class="nav-item" data-page="file-changes"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6a2 2 0 0 1 2-2h3.172a2 2 0 0 1 1.414.586l1.414 1.414H16a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6z"/></svg></span><span class="nav-label">File Changes</span></div>
    <div class="nav-item" data-page="activities"><span class="nav-icon"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg></span><span class="nav-label">Activity Log</span></div>
  </nav>
  <div class="sb-footer">
    <button class="collapse-btn" id="collapseBtn">
      <span><svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 16l-5-6 5-6" stroke-width="2"/></svg></span><span class="collapse-label"> Collapse</span>
    </button>
  </div>
</aside>

<!-- Main app -->
<div id="app">
  <div class="topbar">
    <div class="topbar-left">
      <button id="hamburgerBtn" aria-label="Open navigation"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 5h14M3 10h14M3 15h14"/></svg></button>
      <span class="page-title" id="pageTitle">Overview</span>
      <span id="fetchSpinner" style="display:none;color:var(--muted);font-size:12px"><svg class="spinning" width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle"><path d="M16.5 10a6.5 6.5 0 0 1-11.13 4.58"/><path d="M3.5 10A6.5 6.5 0 0 1 14.63 5.42"/><path d="M14.63 5.42L16 4m-1.37 1.42L16 7.5"/></svg> Refreshing…</span>
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
      <button class="run-now-btn" id="runNowBtn" title="Manually trigger the PDCA cron cycle now"><svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" style="vertical-align:middle"><path d="M6.3 2.84A1.5 1.5 0 0 0 4 4.11v11.78a1.5 1.5 0 0 0 2.3 1.27l9.344-5.891a1.5 1.5 0 0 0 0-2.538L6.3 2.84z"/></svg> Run Now</button>
      <button class="refresh-btn" id="refreshBtn"><svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle"><path d="M16.5 10a6.5 6.5 0 0 1-11.13 4.58"/><path d="M3.5 10A6.5 6.5 0 0 1 14.63 5.42"/><path d="M14.63 5.42L16 4m-1.37 1.42L16 7.5"/></svg> Refresh</button>
      <a href="/logout" style="font-size:12px;color:#64748b;text-decoration:none;padding:6px 10px;border:1px solid #2d3148;border-radius:6px;white-space:nowrap;" onmouseover="this.style.color='#e2e8f0';this.style.borderColor='#64748b'" onmouseout="this.style.color='#64748b';this.style.borderColor='#2d3148'">Sign out</a>
    </div>
  </div>
  <div id="pageContent">
    <div class="empty-state">
      <div class="icon"><svg width="48" height="48" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="10" width="3" height="8" rx="0.5"/><rect x="8.5" y="6" width="3" height="12" rx="0.5"/><rect x="15" y="2" width="3" height="16" rx="0.5"/></svg></div>
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

// ── SVG Icon constants ─────────────────────────────────────────────────────────
const ICONS = {
  overview:    '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="10" width="3" height="8" rx="0.5"/><rect x="8.5" y="6" width="3" height="12" rx="0.5"/><rect x="15" y="2" width="3" height="16" rx="0.5"/></svg>',
  overview14:  '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="10" width="3" height="8" rx="0.5"/><rect x="8.5" y="6" width="3" height="12" rx="0.5"/><rect x="15" y="2" width="3" height="16" rx="0.5"/></svg>',
  overview48:  '<svg width="48" height="48" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="10" width="3" height="8" rx="0.5"/><rect x="8.5" y="6" width="3" height="12" rx="0.5"/><rect x="15" y="2" width="3" height="16" rx="0.5"/></svg>',
  items:       '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 5h13M3.5 10h13M3.5 15h13"/><circle cx="1" cy="5" r="0.5" fill="currentColor"/><circle cx="1" cy="10" r="0.5" fill="currentColor"/><circle cx="1" cy="15" r="0.5" fill="currentColor"/></svg>',
  gantt:       '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3.5" width="15" height="14" rx="2"/><path d="M6.5 2v3M13.5 2v3M2.5 8h15"/><circle cx="7" cy="12" r="1" fill="currentColor"/><circle cx="10" cy="12" r="1" fill="currentColor"/><circle cx="13" cy="12" r="1" fill="currentColor"/></svg>',
  chains:      '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 3a1.5 1.5 0 0 1 1.5-1.5h3.879a1.5 1.5 0 0 1 1.06.44l3.122 3.12a1.5 1.5 0 0 1 .44 1.06V15.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 4.5 15.5v-12z"/><path d="M8 7h4M8 10.5h4M8 14h2"/><circle cx="6" cy="7" r="0.75" fill="currentColor"/><circle cx="6" cy="10.5" r="0.75" fill="currentColor"/><circle cx="6" cy="14" r="0.75" fill="currentColor"/></svg>',
  chains48:    '<svg width="48" height="48" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 3a1.5 1.5 0 0 1 1.5-1.5h3.879a1.5 1.5 0 0 1 1.06.44l3.122 3.12a1.5 1.5 0 0 1 .44 1.06V15.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 4.5 15.5v-12z"/><path d="M8 7h4M8 10.5h4M8 14h2"/><circle cx="6" cy="7" r="0.75" fill="currentColor"/><circle cx="6" cy="10.5" r="0.75" fill="currentColor"/><circle cx="6" cy="14" r="0.75" fill="currentColor"/></svg>',
  sessions:    '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h7l4 4v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M12 3v4h4M7 9h6M7 12h6M7 15h4"/></svg>',
  cycles:      '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 10a6.5 6.5 0 0 1-11.13 4.58"/><path d="M3.5 10A6.5 6.5 0 0 1 14.63 5.42"/><path d="M14.63 5.42L16 4m-1.37 1.42L16 7.5"/><path d="M5.37 14.58L4 16m1.37-1.42L4 12.5"/></svg>',
  cycles14:    '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 10a6.5 6.5 0 0 1-11.13 4.58"/><path d="M3.5 10A6.5 6.5 0 0 1 14.63 5.42"/><path d="M14.63 5.42L16 4m-1.37 1.42L16 7.5"/><path d="M5.37 14.58L4 16m1.37-1.42L4 12.5"/></svg>',
  fileChanges: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6a2 2 0 0 1 2-2h3.172a2 2 0 0 1 1.414.586l1.414 1.414H16a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6z"/></svg>',
  refresh:     '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 10a6.5 6.5 0 0 1-11.13 4.58"/><path d="M3.5 10A6.5 6.5 0 0 1 14.63 5.42"/><path d="M14.63 5.42L16 4m-1.37 1.42L16 7.5"/><path d="M5.37 14.58L4 16m1.37-1.42L4 12.5"/></svg>',
  play:        '<svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path d="M6.3 2.84A1.5 1.5 0 0 0 4 4.11v11.78a1.5 1.5 0 0 0 2.3 1.27l9.344-5.891a1.5 1.5 0 0 0 0-2.538L6.3 2.84z"/></svg>',
  checkCircle: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8"/><path d="M6.5 10l2.5 2.5 4.5-4.5"/></svg>',
  checkCircle14:'<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8"/><path d="M6.5 10l2.5 2.5 4.5-4.5"/></svg>',
  warning:     '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L18 17H2L10 3z"/><path d="M10 8v4M10 14.5v.5"/></svg>',
  warning48:   '<svg width="48" height="48" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L18 17H2L10 3z"/><path d="M10 8v4M10 14.5v.5"/></svg>',
  xCircle:     '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8"/><path d="M7 7l6 6M13 7l-6 6"/></svg>',
  clock:       '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8"/><path d="M10 5v5l3 3"/></svg>',
  checkSmall:  '<svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10l5 5 7-8"/></svg>',
  chevronLeft: '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 16l-5-6 5-6" stroke-width="2"/></svg>',
  chevronDown: '<svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l5 5 5-5"/></svg>',
  grid:        '<svg width="10" height="10" viewBox="0 0 20 20" fill="currentColor" opacity="0.4"><rect x="2" y="2" width="7" height="7" rx="1"/><rect x="11" y="2" width="7" height="7" rx="1"/><rect x="2" y="11" width="7" height="7" rx="1"/><rect x="11" y="11" width="7" height="7" rx="1"/></svg>'
};

// ── Toast icon map ──────────────────────────────────────────────────────────────
const TOAST_ICONS = {
  success: ICONS.checkCircle,
  warn:    ICONS.warning,
  error:   ICONS.xCircle,
  info:    '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8"/><path d="M10 8v0M10 14v-3.5"/></svg>'
};

// ── State ─────────────────────────────────────────────────────────────────────
let currentProject = null;
let currentPage = 'overview';
let autoRefresh = true;
let refreshTimer = null;
let countdownTimer = null;
let countdownSecs = 60;

const PAGE_TITLES = {
  overview: 'Overview', items: 'Items',
  chains: 'Chains',
  flow: 'Flow',
  sessions: 'Sessions',
  cycles: 'Cycles', 'file-changes': 'File Changes', 'activities': 'Activity Log'
};

// Per-page cached data
const cache = {};

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function fmt(v, fallback) {
  if (fallback === undefined) fallback = '—';
  return (v === null || v === undefined || v === '') ? fallback : v;
}
function parseDbDate(v) {
  if (!v) return null;
  const raw = String(v).trim();
  if (!raw) return null;
  // SQLite datetime format: '2025-04-14 10:30:00' (IST local time, stored via localtime)
  // Don't append 'Z' - treat as local time by using direct Date constructor
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(raw)) {
    const d = new Date(raw.replace(' ', 'T'));
    return isNaN(d.getTime()) ? null : d;
  }
  // ISO format with or without timezone
  const hasZone = /(?:Z|[+-]\d{2}:\d{2})$/.test(raw);
  const iso = hasZone ? raw : raw + 'Z';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}
function fmtDate(v) {
  if (!v) return '—';
  const d = parseDbDate(v);
  if (isNaN(d)) return v;
  return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'2-digit' })
    + ' ' + d.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12:false });
}
function fmtDateShort(v) {
  if (!v) return '—';
  const d = parseDbDate(v);
  if (isNaN(d)) return v;
  return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'2-digit' });
}
function timeAgo(str) {
  if (!str) return '—';
  const d = parseDbDate(str);
  if (!d) return fmtDate(str);
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (isNaN(secs) || secs < 0) return fmtDate(str);
  if (secs < 60) return 'just now';
  if (secs < 3600) return Math.floor(secs/60) + 'm ago';
  if (secs < 86400) return Math.floor(secs/3600) + 'h ago';
  if (secs < 604800) return Math.floor(secs/86400) + 'd ago';
  return d.toLocaleDateString();
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

function showToast(msg, duration, type) {
  var icon = type && TOAST_ICONS[type] ? '\x3cspan style="display:inline-flex;vertical-align:middle;margin-right:6px">' + TOAST_ICONS[type] + '\x3c/span>' : '';
  var t = $('toast');
  t.innerHTML = icon + esc(msg);
  t.classList.add('show');
  t.dataset.type = type || 'info';
  setTimeout(() => { t.classList.remove('show'); delete t.dataset.type; }, duration || 4000);
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

$('runNowBtn').addEventListener('click', async () => {
  const btn = $('runNowBtn');
  btn.disabled = true;
  btn.innerHTML = '\x3csvg class="spinning" width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle">\x3cpath d="M16.5 10a6.5 6.5 0 0 1-11.13 4.58"/>\x3cpath d="M3.5 10A6.5 6.5 0 0 1 14.63 5.42"/>\x3cpath d="M14.63 5.42L16 4m-1.37 1.42L16 7.5"/>\x3cpath d="M5.37 14.58L4 16m1.37-1.42L4 12.5"/>\x3c/svg> Running…';
  try {
    const res = await fetch('/api/trigger-cycle', { method: 'POST' });
    const data = await res.json();
    const summary = data.lines.slice(-6).join(' · ') || 'Cycle complete';
    showToast(summary, data.ok ? 3500 : 5000, data.ok ? 'success' : 'warn');
    if (currentProject) loadPage(currentPage);
  } catch (e) {
    showToast('Failed to trigger cycle: ' + e.message, 5000, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = ICONS.play + ' Run Now';
  }
});

async function queueItem(evt, itemId) {
  evt.stopPropagation(); // don't expand the row
  const btn = evt.currentTarget;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const res = await fetch('/api/items/' + itemId + '/queue', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      showToast('#' + itemId + ' queued — agent will pick it up shortly', 4000, 'info');
      if (currentProject) setTimeout(() => loadPage(currentPage), 800);
    } else {
      showToast(data.message, 4000, 'warn');
      btn.disabled = false;
      btn.innerHTML = ICONS.play;
    }
  } catch (e) {
    showToast(e.message, 5000, 'error');
    btn.disabled = false;
    btn.innerHTML = ICONS.play;
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const page = item.dataset.page;
    navigateTo(page);
  });
});

function navigateTo(page) {
  if (!currentProject && page !== 'overview') {
    showToast('Select a project first', 4000, 'info');
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
    // Restore saved project from last session, or fall back to first project
    const saved = localStorage.getItem('pdca-project');
    if (saved && projects.includes(saved)) {
      sel.value = saved;
      onProjectChange();
    } else if (projects.length >= 1) {
      sel.value = projects[0];
      onProjectChange();
    }
  } catch(e) {
    showToast('Failed to load projects', 4000, 'error');
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
    } else if (page === 'chains') {
      const data = await apiFetch('/api/chains?project=' + p);
      cache.chains = data;
      renderChainsPage(data);
    } else if (page === 'flow') {
      const data = cache.items || await apiFetch('/api/items?project=' + p);
      cache.items = data;
      renderFlowPage(data);
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
    } else if (page === 'activities') {
      const data = await apiFetch('/api/activities?project=' + p + '&limit=200');
      cache.activities = data;
      renderActivitiesPage(data);
    }
    updateLastUpdated();
    if (autoRefresh) { countdownSecs = 60; }
  } catch(e) {
    showToast('Failed to load data', 4000, 'error');
    $('pageContent').innerHTML = '<div class="empty-state"><div class="icon">' + ICONS.warning48 + '</div><h2>Error loading data</h2><p>' + esc(e.message) + '</p></div>';
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
    + '<button class="col-toggle-btn" onclick="this.nextSibling.classList.toggle(&#39;open&#39;)">Columns ' + ICONS.chevronDown + '</button>'
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
  return '<button class="density-btn" id="densitybtn-' + tableId + '" onclick="cycleDensity(&#39;' + tableId + '&#39;)">'
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
    const dt = parseDbDate(i.completed_at);
    const ts = dt ? dt.getTime() : NaN;
    return !isNaN(ts) && ts >= sevenDaysAgo;
  }).sort((a, b) => {
    const bt = parseDbDate(b.completed_at);
    const at = parseDbDate(a.completed_at);
    return (bt ? bt.getTime() : 0) - (at ? at.getTime() : 0);
  });

  const doneHtml = doneItems.length
    ? '<div class="done-list">' + doneItems.map(i =>
        '<div class="done-item">'
        + '<span class="done-check">' + ICONS.checkCircle + '</span>'
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
    '<div class="section"><div class="section-header"><div class="section-title"><span style="display:inline-flex;vertical-align:middle;margin-right:6px">' + ICONS.overview14 + '</span>Project Performance</div></div>'
    + '<div class="perf-projects">' + (perfCards || '<div class="no-data">No performance data.</div>') + '</div></div>'
    + '<div class="section"><div class="section-header"><div class="section-title"><span style="display:inline-flex;vertical-align:middle;margin-right:6px">' + ICONS.checkCircle14 + '</span>Done This Week <span class="count">' + doneItems.length + '</span></div>'
    + '<a class="view-all" onclick="navigateTo(&#39;items&#39;)">View all →</a></div>'
    + '<div class="table-wrap">' + doneHtml + '</div></div>'
    + '<div class="section"><div class="section-header"><div class="section-title"><span style="display:inline-flex;vertical-align:middle;margin-right:6px">' + ICONS.cycles14 + '</span>Activity Feed <span class="count">' + feedCycles.length + '</span></div>'
    + '<a class="view-all" onclick="navigateTo(&#39;cycles&#39;)">View all →</a></div>'
    + '<div class="table-wrap">' + feedHtml + '</div></div>';
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE: Items (merged — Pending / All / Blocked tabs)
// ─────────────────────────────────────────────────────────────────────────────
let itemsFilter = { search:'', priority:[], phase:[], status:[], agent:'' };
let itemsTab = 'not-started'; // 'all' | 'pending' | 'complete' | 'blocked' | 'queued' | 'not-started' | 'dropped'
let itemsPage = 1;
let itemsPageSize = 10;
var ganttShowCritical = false;
var ganttZoom = 'week'; // day | week | month

// Derive is_blocked: item has depends_on set AND the parent's status is not 'complete'
function deriveBlocked(items) {
  const statusById = {};
  const itemById = {};
  items.forEach(i => {
    statusById[i.id] = i.status;
    itemById[i.id] = i;
  });

  // Check transitive dependency: walk up the depends_on chain
  // An item is blocked if ANY ancestor in its chain is not complete/cancelled/dropped
  function isAnyAncestorIncomplete(item) {
    const visited = new Set();
    let current = item.depends_on;
    while (current && !visited.has(current)) {
      visited.add(current);
      const ancestor = itemById[current];
      if (!ancestor) break; // dependency not in this project — assume not blocking
      if (ancestor.status !== 'complete' && ancestor.status !== 'cancelled' && ancestor.status !== 'dropped') {
        return true; // ancestor is incomplete → blocked
      }
      current = ancestor.depends_on;
    }
    return false;
  }

  // Check if an item is "locked" (has incomplete ancestors AND is in open/queued status — literally cannot start)
  function isLocked(item) {
    if (item.status === 'complete' || item.status === 'cancelled' || item.status === 'dropped') return false;
    if (!item.depends_on) return false; // root items are never locked
    return isAnyAncestorIncomplete(item);
  }

  // Check if an item is "ready" (all ancestors complete, open status, can be started now)
  function isReady(item) {
    if (item.status === 'complete' || item.status === 'cancelled' || item.status === 'dropped') return false;
    if (item.status === 'in-progress') return false;
    return !isAnyAncestorIncomplete(item);
  }

  return items.map(i => {
    const blocked = isAnyAncestorIncomplete(i) || i.status === 'blocked';
    const locked = isLocked(i);
    const ready = isReady(i);
    return Object.assign({}, i, { _is_blocked: blocked, _is_locked: locked, _is_ready: ready });
  });
}

function itemTrafficDot(item) {
  if (item._is_locked) return '<span class="tl-dot" style="color:#ef4444" title="Locked — waiting on incomplete dependency (cannot start)">🔒</span>';
  if (item._is_blocked || item.status === 'blocked') return '<span class="tl-dot tl-red" title="Blocked — waiting on dependency">●</span>';
  if (item.status === 'complete') return '<span class="tl-dot tl-green" title="Complete">●</span>';
  if (item.status === 'queued') return '<span class="tl-dot tl-purple" title="Queued — dispatched, waiting for LLM pickup">●</span>';
  if (item.status === 'in-progress' || item.phase === 'check') return '<span class="tl-dot tl-amber" title="In progress">●</span>';
  if (item._is_ready) return '<span class="tl-dot tl-green" title="Ready — all dependencies complete, can be started now">●</span>';
  if (item.status === 'dropped' || item.status === 'cancelled') return '<span class="tl-dot tl-gray" title="Dropped / cancelled">●</span>';
  return '<span class="tl-dot tl-gray" title="Open — not started">●</span>';
}

// ─────────────────────────────────────────────────────────────────────────────
// Gantt Page — dependency chart
// ─────────────────────────────────────────────────────────────────────────────
function renderGanttPage(rawData) {
  var data = deriveBlocked(rawData);
  var ROW_H = 44, PAD = 12, BAR_H = 22, BAR_Y_OFF = (ROW_H - BAR_H) / 2;
  var AXIS_H = 36;
  var PX_PER_DAY = ganttZoom === 'day' ? 60 : ganttZoom === 'month' ? 5 : 20;

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
  var tickEvery = ganttZoom === 'day' ? 1 : ganttZoom === 'month' ? 30 : (totalDays <= 14 ? 1 : totalDays <= 60 ? 7 : 30);
  var ticks = '', td2 = new Date(axisStartMs), dc = 0;
  while (td2.getTime() <= axisEndMs) {
    var showTick = false;
    if (ganttZoom === 'month') {
      showTick = td2.getDate() === 1;
    } else {
      showTick = dc % tickEvery === 0;
    }
    if (showTick) {
      var tx2 = PAD + dc * PX_PER_DAY;
      var tickLabel = ganttZoom === 'month'
        ? MONTHS[td2.getMonth()] + ' ' + td2.getFullYear().toString().slice(2)
        : MONTHS[td2.getMonth()] + ' ' + td2.getDate();
      ticks += '<line x1="' + tx2 + '" y1="' + AXIS_H + '" x2="' + tx2 + '" y2="' + svgH + '" stroke="#1e2235" stroke-width="1"/>'
        + '<text x="' + tx2 + '" y="' + (AXIS_H - 6) + '" font-size="10" fill="#4b5563" text-anchor="middle" font-family="monospace">'
        + tickLabel + '</text>';
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

  // Dependency arrows — with vertical stagger for parallel arrows from same row
  var arrowData = order.filter(function(item) {
    return item.depends_on && rowIdx[item.depends_on] !== undefined;
  }).map(function(item) {
    var fi = rowIdx[item.depends_on];
    var fromItem = byId[item.depends_on];
    return {
      item: item,
      fi: fi,
      fx: Math.min(svgW - 4, iEndPx(fromItem)),
      ti: rowIdx[item.id],
      txi: iStartPx(item),
      col: item._is_blocked ? '#ef4444' : '#4b5563',
      dash: item._is_blocked ? '4,3' : 'none',
      mid: item._is_blocked ? 'red' : 'gray'
    };
  });
  // Compute per-source-row counts for stagger
  var _fromCounts = {}, _fromSeq = {};
  arrowData.forEach(function(a) { _fromCounts[a.fi] = (_fromCounts[a.fi] || 0) + 1; });
  arrowData.forEach(function(a) {
    var seq = (_fromSeq[a.fi] = (_fromSeq[a.fi] || 0));
    a.fyOffset = (seq - (_fromCounts[a.fi] - 1) / 2) * 4;
    _fromSeq[a.fi]++;
  });
  var arrows = arrowData.map(function(a) {
    var fy = AXIS_H + a.fi * ROW_H + ROW_H / 2 + a.fyOffset;
    var ty = AXIS_H + a.ti * ROW_H + ROW_H / 2;
    var mx = (a.fx + a.txi) / 2;
    return '<path id="garr-' + a.item.id + '" class="gantt-arrow" data-from="' + a.item.depends_on + '" data-to="' + a.item.id + '" data-blocked="' + (a.item._is_blocked ? '1' : '0') + '"'
      + ' d="M' + a.fx + ',' + fy + ' C' + mx + ',' + fy + ' ' + mx + ',' + ty + ' ' + a.txi + ',' + ty + '"'
      + ' fill="none" stroke="' + a.col + '" stroke-width="1.5" stroke-dasharray="' + a.dash + '" opacity="0.2"'
      + ' marker-end="url(#arr-' + a.mid + ')"/>';
  }).join('');

  // Left HTML name panel (sticky, does not scroll with chart)
  var namePanelRows = order.map(function(item, idx) {
    var dc3 = dotC(item);
    var bg3 = idx % 2 === 0 ? 'rgba(255,255,255,0.012)' : 'transparent';
    var descSnippet = item.plan_description ? item.plan_description.slice(0, 100) + (item.plan_description.length > 100 ? '\u2026' : '') : '';
    return '<div class="gr-name" data-id="' + item.id + '" data-orig-bg="' + bg3 + '"'
      + ' data-title="' + esc(item.title) + '"'
      + ' data-desc="' + esc(descSnippet) + '"'
      + ' data-status="' + esc(item.status || '') + '"'
      + ' style="height:' + ROW_H + 'px;display:flex;align-items:center;gap:7px;padding:0 10px;background:' + bg3 + ';cursor:pointer;box-sizing:border-box">'
      + '<span style="width:8px;height:8px;border-radius:50%;background:' + dc3 + ';flex-shrink:0"></span>'
      + '<span style="font-size:12px;color:#e2e8f0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(item.title) + '">' + esc(item.title) + '</span>'
      + '<span style="font-size:10px;color:#64748b;font-family:monospace;flex-shrink:0">#' + item.id + '</span>'
      + '</div>';
  }).join('');

  var namePanel = '<div id="gantt-names" style="flex-shrink:0;width:320px;background:#0f1117;border-right:1px solid #1e2235;overflow:hidden">'
    + '<div style="height:' + AXIS_H + 'px;border-bottom:1px solid #1e2235;display:flex;align-items:center;padding:0 10px">'
    + '<span style="font-size:10px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.5px">Item</span>'
    + '</div>'
    + namePanelRows + '</div>';

  // SVG assembly
  var svg = '<svg id="gantt-svg" width="' + svgW + '" height="' + svgH + '" xmlns="http://www.w3.org/2000/svg" style="display:block">'
    + '<defs>'
    + '<marker id="arr-gray"   markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#4b5563"/></marker>'
    + '<marker id="arr-red"    markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#ef4444"/></marker>'
    + '<marker id="arr-cp"     markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#f59e0b"/></marker>'
    + '<marker id="arr-accent" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#818cf8"/></marker>'
    + '</defs>'
    + '<rect width="' + svgW + '" height="' + svgH + '" fill="#0f1117"/>'
    + '<line x1="0" y1="' + AXIS_H + '" x2="' + svgW + '" y2="' + AXIS_H + '" stroke="#1e2235" stroke-width="1"/>'
    + ticks + todayMarker + arrows + rows
    + '</svg>';

  // Legend strip — collapsible
  var legend = '<div id="gantt-legend-wrap" style="margin:6px 0 10px">'
    // Toggle button row
    + '<button id="gantt-legend-btn" onclick="(function(){'
    +   'var b=document.getElementById(&#39;gantt-legend-body&#39;);'
    +   'var btn=document.getElementById(&#39;gantt-legend-btn&#39;);'
    +   'var open=b.style.display!==&#39;none&#39;;'
    +   'b.style.display=open?&#39;none&#39;:&#39;flex&#39;;'
    +   'btn.setAttribute(&#39;aria-expanded&#39;,open?&#39;false&#39;:&#39;true&#39;);'
    +   'btn.querySelector(&#39;.gl-chevron&#39;).style.transform=open?&#39;rotate(0deg)&#39;:&#39;rotate(180deg)&#39;;'
    + '})()" aria-expanded="false" style="display:flex;align-items:center;gap:6px;background:transparent;border:none;cursor:pointer;padding:0;color:#64748b;font-size:12px">'
    + '<span style="font-weight:600;color:#94a3b8;font-size:12px">Legend</span>'
    + '<span class="gl-chevron" style="display:inline-block;transition:transform 0.2s;font-size:10px;line-height:1">&#9660;</span>'
    + '</button>'
    // Collapsible body — hidden by default
    + '<div id="gantt-legend-body" style="display:none;flex-wrap:wrap;gap:0;margin-top:5px;'
    +   'background:rgba(255,255,255,0.03);border:1px solid #1e2235;border-radius:8px;overflow:hidden">'
    // Section 1: Status dots
    + '<div style="display:flex;gap:12px;align-items:center;padding:7px 14px;border-right:1px solid #1e2235;flex-shrink:0">'
    +   '<span style="font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px">Status</span>'
    +   '<span style="font-size:12px;color:#cbd5e1"><span style="color:#22c55e;font-size:14px">&#9679;</span> Complete</span>'
    +   '<span style="font-size:12px;color:#cbd5e1"><span style="color:#eab308;font-size:14px">&#9679;</span> In Progress</span>'
    +   '<span style="font-size:12px;color:#cbd5e1"><span style="color:#ef4444;font-size:14px">&#9679;</span> Blocked</span>'
    +   '<span style="font-size:12px;color:#cbd5e1"><span style="color:#4b5563;font-size:14px">&#9679;</span> Open</span>'
    + '</div>'
    // Section 2: Bar encoding
    + '<div style="display:flex;gap:10px;align-items:center;padding:7px 14px;border-right:1px solid #1e2235;flex-shrink:0">'
    +   '<span style="font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px">Bars</span>'
    +   '<svg width="48" height="14" style="vertical-align:middle"><rect x="0" y="2" width="48" height="10" rx="3" fill="#1e3a5f"/><rect x="0" y="2" width="28" height="10" rx="3" fill="#3b82f6"/></svg>'
    +   '<span style="font-size:12px;color:#64748b">Width &prop; <strong style="color:#94a3b8">estimated mins</strong>, fill = % done</span>'
    + '</div>'
    // Section 3: Arrows
    + '<div style="display:flex;gap:10px;align-items:center;padding:7px 14px;border-right:1px solid #1e2235;flex-shrink:0">'
    +   '<span style="font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px">Arrows</span>'
    +   '<svg width="42" height="14" style="vertical-align:middle"><defs><marker id="lg-arr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L0,6 L6,3 z" fill="#4b5563"/></marker><marker id="lg-arr-r" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L0,6 L6,3 z" fill="#ef4444"/></marker></defs><line x1="2" y1="7" x2="34" y2="7" stroke="#4b5563" stroke-width="1.5" marker-end="url(#lg-arr)"/></svg>'
    +   '<span style="font-size:12px;color:#64748b">Grey = <strong style="color:#94a3b8">dependency</strong></span>'
    +   '<svg width="42" height="14" style="vertical-align:middle"><line x1="2" y1="7" x2="34" y2="7" stroke="#ef4444" stroke-width="1.5" marker-end="url(#lg-arr-r)"/></svg>'
    +   '<span style="font-size:12px;color:#64748b">Red = blocked dep</span>'
    + '</div>'
    // Section 4: Today line
    + '<div style="display:flex;gap:10px;align-items:center;padding:7px 14px;flex-shrink:0">'
    +   '<svg width="14" height="14" style="vertical-align:middle"><line x1="7" y1="0" x2="7" y2="14" stroke="#60a5fa" stroke-width="2" stroke-dasharray="3,2"/></svg>'
    +   '<span style="font-size:12px;color:#64748b">Blue dashed = <strong style="color:#94a3b8">today</strong></span>'
    +   '<span style="font-size:12px;color:#64748b;border-left:1px solid #1e2235;padding-left:10px">Hover a name to trace connections</span>'
    + '</div>'
    + '</div>'
    + '</div>';

  var zoomBtnStyle = function(z) {
    return 'font-size:12px;padding:5px 14px;border-radius:16px;border:1px solid ' + (ganttZoom===z?'#3b82f6':'#2d3148') + ';background:' + (ganttZoom===z?'rgba(59,130,246,0.15)':'transparent') + ';color:' + (ganttZoom===z?'#60a5fa':'#64748b') + ';cursor:pointer';
  };
  var toolbar = '<div style="display:flex;gap:10px;align-items:center;margin-bottom:8px;flex-wrap:wrap">'
    + '<h2 style="font-size:18px;font-weight:600;margin:0;flex:1">Gantt &mdash; Dependency View</h2>'
    + '<div style="display:flex;gap:4px;background:#1a1d27;border:1px solid #2d3148;border-radius:20px;padding:3px">'
    + '<button onclick="setGanttZoom(&quot;day&quot;)" style="' + zoomBtnStyle('day') + '">Day</button>'
    + '<button onclick="setGanttZoom(&quot;week&quot;)" style="' + zoomBtnStyle('week') + '">Week</button>'
    + '<button onclick="setGanttZoom(&quot;month&quot;)" style="' + zoomBtnStyle('month') + '">Month</button>'
    + '</div>'
    + '<button id="gantt-cp-btn" style="font-size:12px;padding:5px 16px;border-radius:16px;border:1px solid #f59e0b;background:transparent;color:#f59e0b;cursor:pointer">Critical Path</button>'
    + '</div>'
    + '<p style="font-size:13px;color:#64748b;margin:0 0 4px">Items ordered by dependency. Scroll chart right &rarr;. Hover a name to trace connections. Click a name to see full title &amp; description.</p>';

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
          el.setAttribute('opacity', '0.2');
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
        span.style.color = onCp ? '#fbbf24' : (cpActive ? '#475569' : '#e2e8f0');
        span.style.fontWeight = onCp ? '700' : 'normal';
        el.style.opacity = (!cpActive || onCp) ? '1' : '0.3';
      });
    }

    function restoreBars() {
      document.querySelectorAll('.gantt-bar').forEach(function(g) {
        var id = parseInt(g.getAttribute('data-id'), 10);
        var onCp = cpActive && cpIds.indexOf(id) !== -1;
        var opacity = (!cpActive || onCp) ? '1' : '0.2';
        g.setAttribute('opacity', opacity);
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
            el.setAttribute('opacity', '1');
            el.setAttribute('stroke-width', '2.5');
            el.setAttribute('stroke', '#818cf8');
            el.setAttribute('marker-end', 'url(#arr-accent)');
          } else {
            el.setAttribute('opacity', '0.04');
          }
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
        restoreArrows(); restoreLabels(); restoreBars();
      });
    }

    // Click-to-expand: show full title + description in a fixed card
    var existingCard = document.getElementById('gr-expand-card');
    if (existingCard) existingCard.remove();
    var expandCard = document.createElement('div');
    expandCard.id = 'gr-expand-card';
    expandCard.style.cssText = 'display:none;position:fixed;background:#1a1f2e;border:1px solid #334155;border-radius:8px;padding:10px 14px;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,0.7);max-width:340px;min-width:200px;word-break:break-word';
    document.body.appendChild(expandCard);
    var expandedId = null;

    document.querySelectorAll('.gr-name').forEach(function(nameEl) {
      var rowId = nameEl.getAttribute('data-id');

      // Long-press for mobile tooltip (title attr handles native tooltip on desktop)
      var lpTimer;
      nameEl.addEventListener('touchstart', function() {
        lpTimer = setTimeout(function() {
          nameEl.style.background = 'rgba(255,255,255,0.08)';
          setTimeout(function() { nameEl.style.background = nameEl.getAttribute('data-orig-bg') || 'transparent'; }, 600);
        }, 500);
      }, { passive: true });
      nameEl.addEventListener('touchend', function() { clearTimeout(lpTimer); }, { passive: true });

      nameEl.addEventListener('click', function(e) {
        e.stopPropagation();
        if (expandedId === rowId) {
          expandedId = null;
          expandCard.style.display = 'none';
          return;
        }
        expandedId = rowId;
        var title = nameEl.getAttribute('data-title') || '';
        var desc  = nameEl.getAttribute('data-desc')  || '';
        var status = nameEl.getAttribute('data-status') || '';
        expandCard.innerHTML =
          '<div style="font-size:12px;font-weight:700;color:#e2e8f0;line-height:1.4;margin-bottom:' + (desc ? '6' : '0') + 'px">' + esc(title) + '</div>'
          + (desc ? '<div style="font-size:11px;color:#94a3b8;line-height:1.5;border-top:1px solid #1e2235;padding-top:6px">' + esc(desc) + '</div>' : '')
          + '<div style="font-size:10px;color:#64748b;margin-top:6px;border-top:1px solid #1e2235;padding-top:5px">Status: <span style="color:#94a3b8">' + esc(status) + '</span> &middot; #' + esc(rowId) + '</div>';
        expandCard.style.display = 'block';
        var rect = nameEl.getBoundingClientRect();
        var cardW = expandCard.offsetWidth;
        var cardH = expandCard.offsetHeight;
        var left = rect.right + 10;
        if (left + cardW > window.innerWidth - 8) left = rect.left - cardW - 10;
        if (left < 8) left = 8;
        var top = rect.top;
        if (top + cardH > window.innerHeight - 8) top = window.innerHeight - cardH - 8;
        if (top < 8) top = 8;
        expandCard.style.left = left + 'px';
        expandCard.style.top  = top  + 'px';
      });
    });

    document.addEventListener('click', function() {
      if (expandedId) { expandedId = null; expandCard.style.display = 'none'; }
    });
  }, 0);
}

function setGanttZoom(zoom) {
  ganttZoom = zoom;
  if (cache.items) renderGanttPage(cache.items);
}

function renderItemsPage(rawData) {
  const data = deriveBlocked(rawData);
  const agents = [...new Set(data.map(i => i.agent_assigned).filter(Boolean))].sort();
  const agentOpts = '<option value="">All agents</option>' + agents.map(a => '<option value="'+esc(a)+'">'+esc(a)+'</option>').join('');

  const html =
    '<div class="tl-filter-bar">'
    + '<button class="tl-filter-btn'+(itemsTab==='all'?' tl-active':'')+'" data-tab="all" onclick="setItemsTab(&#39;all&#39;)" title="Show all items">'
    + '<span style="font-size:10px;display:inline-flex;vertical-align:middle">' + ICONS.grid + '</span> All<span class="tl-meta"><span class="tl-cnt">—</span><span class="tl-time-lbl"></span></span></button>'
    + '<button class="tl-filter-btn'+(itemsTab==='not-started'?' tl-active':'')+'" data-tab="not-started" onclick="setItemsTab(&#39;not-started&#39;)" title="Open — not started yet, no blocker">'
    + '<span class="tl-dot tl-gray" style="font-size:10px">●</span> To Be Started<span class="tl-meta"><span class="tl-cnt">—</span><span class="tl-time-lbl"></span></span></button>'
    + '<button class="tl-filter-btn'+(itemsTab==='queued'?' tl-active':'')+'" data-tab="queued" onclick="setItemsTab(&#39;queued&#39;)" title="Blocked — queued behind a dependency">'
    + '<span class="tl-dot tl-red" style="font-size:10px;opacity:.6">●</span> In Queue<span class="tl-meta"><span class="tl-cnt">—</span><span class="tl-time-lbl"></span></span></button>'
    + '<button class="tl-filter-btn'+(itemsTab==='pending'?' tl-active':'')+'" data-tab="pending" onclick="setItemsTab(&#39;pending&#39;)" title="In progress (active work)">'
    + '<span class="tl-dot tl-amber" style="font-size:10px">●</span> In Progress<span class="tl-meta"><span class="tl-cnt">—</span><span class="tl-time-lbl"></span></span></button>'
    + '<button class="tl-filter-btn'+(itemsTab==='blocked'?' tl-active':'')+'" data-tab="blocked" onclick="setItemsTab(&#39;blocked&#39;)" title="Blocked — dependency not complete">'
    + '<span class="tl-dot tl-red" style="font-size:10px">●</span> Blocked<span class="tl-meta"><span class="tl-cnt">—</span><span class="tl-time-lbl"></span></span></button>'
    + '<button class="tl-filter-btn'+(itemsTab==='complete'?' tl-active':'')+'" data-tab="complete" onclick="setItemsTab(&#39;complete&#39;)" title="Completed items">'
    + '<span class="tl-dot tl-green" style="font-size:10px">●</span> Complete<span class="tl-meta"><span class="tl-cnt">—</span><span class="tl-time-lbl"></span></span></button>'
    + '<button class="tl-filter-btn'+(itemsTab==='dropped'?' tl-active':'')+'" data-tab="dropped" onclick="setItemsTab(&#39;dropped&#39;)" title="Dropped / cancelled">'
    + '<span class="tl-dot tl-gray" style="font-size:10px;opacity:.4">●</span> Dropped<span class="tl-meta"><span class="tl-cnt">—</span><span class="tl-time-lbl"></span></span></button>'
    + '</div>'
    + '<div class="filter-bar" id="items-filters">'
    + '<div class="filter-group"><label>Search</label><input type="text" id="items-search" placeholder="Title or plan…" value="'+esc(itemsFilter.search)+'" oninput="itemsFilter.search=this.value;itemsPage=1;redrawItems()"></div>'
    + '<div class="filter-group"><label>Priority</label><div class="check-group">'
    + ['critical','high','medium','low'].map(p=>'<label class="check-pill'+(itemsFilter.priority.includes(p)?' checked':'')+'"><input type="checkbox" '+(itemsFilter.priority.includes(p)?'checked':'')+' onchange="toggleFilter(itemsFilter.priority,&#39;'+p+'&#39;,this.checked);this.parentElement.classList.toggle(&#39;checked&#39;,this.checked);itemsPage=1;redrawItems()"> '+p+'</label>').join('')
    + '</div></div>'
    + '<div class="filter-group"><label>Phase</label><div class="check-group">'
    + ['plan','do','check','act'].map(p=>'<label class="check-pill'+(itemsFilter.phase.includes(p)?' checked':'')+'"><input type="checkbox" '+(itemsFilter.phase.includes(p)?'checked':'')+' onchange="toggleFilter(itemsFilter.phase,&#39;'+p+'&#39;,this.checked);this.parentElement.classList.toggle(&#39;checked&#39;,this.checked);itemsPage=1;redrawItems()"> '+p+'</label>').join('')
    + '</div></div>'
    + '<div class="filter-group"><label>Agent</label><select onchange="itemsFilter.agent=this.value;itemsPage=1;redrawItems()">' + agentOpts + '</select></div>'
    + '<button class="clear-btn" onclick="clearItemsFilters()">Clear</button>'
    + '</div>'
    + '<div class="result-count" id="items-count"></div>'
    + '<div class="items-card-view" id="items-cards"></div>'
    + '<div class="table-wrap items-table-view">'
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
    + '<th style="width:38px"></th>'
    + '</tr></thead><tbody id="items-tbody"></tbody></table></div>'
    + '<div class="pagination-bar" id="items-pgbar"></div>'
    + '</div>'
    + '<div class="pagination-bar items-card-view" id="items-pgbar-cards"></div>';

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

function depGoto(id) {
  setItemsTab('all');
  setTimeout(function() {
    var r = document.querySelector('tr[data-expand="ex-item-' + id + '"]');
    if (r) r.click();
  }, 200);
}

function closeFlowDetail() {
  var p = document.getElementById('flow-detail');
  if (p) p.style.display = 'none';
}

function buildDepInspector(item, allItems) {
  // Find what this item depends on (blockers)
  var blockerHtml = '';
  if (item.depends_on) {
    var blocker = allItems.find(function(i) { return i.id === item.depends_on; });
    blockerHtml = '<div style="margin-bottom:6px">'
      + '<span style="font-size:11px;color:#64748b">Blocked by:</span> '
      + (blocker
        ? '<a href="#" onclick="event.preventDefault();depGoto(' + blocker.id + ')" style="color:#60a5fa;text-decoration:none;font-size:12px">'
          + '<span class="badge badge-num">#'+blocker.id+'</span> '+esc(blocker.title)+'</a>'
          + ' <span class="badge '+(blocker.status==='complete'?'badge-complete':blocker.status==='in-progress'?'badge-in-progress':'badge-open')+'">'+esc(blocker.status)+'</span>'
        : '<span style="color:#64748b;font-size:12px">#'+item.depends_on+' (not loaded)</span>')
      + '</div>';
  }
  // Find tasks that depend on this item (dependents)
  var dependents = allItems.filter(function(i) { return i.depends_on === item.id; });
  var dependentsHtml = '';
  if (dependents.length) {
    dependentsHtml = '<div>'
      + '<span style="font-size:11px;color:#64748b">Blocks ' + dependents.length + ' item' + (dependents.length>1?'s':'') + ':</span> '
      + dependents.map(function(d) {
          return '<a href="#" onclick="event.preventDefault();depGoto(' + d.id + ')" style="color:#60a5fa;text-decoration:none;font-size:12px">'
            + '<span class="badge badge-num">#'+d.id+'</span> '+esc(d.title)+'</a>'
            + ' <span class="badge '+(d.status==='complete'?'badge-complete':d._is_blocked?'badge-blocked':d.status==='in-progress'?'badge-in-progress':'badge-open')+'">'+esc(d.status)+'</span>';
        }).join('  ')
      + '</div>';
  }
  if (!blockerHtml && !dependentsHtml) return '';
  return '<div class="expand-field" style="grid-column:1/-1">'
    + '<label>Dependencies</label>'
    + '<div style="display:flex;flex-direction:column;gap:6px;font-size:13px">'
    + blockerHtml
    + dependentsHtml
    + '</div>'
    + '</div>';
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
  const NCOLS = 13; // traffic dot + 11 data cols + trigger col
  tbody.innerHTML = pageSlice.map(item => {
    const eid = 'ex-item-' + item.id;
    const hasDetail = item.plan_description || item.actual_description || item.remarks || item.errors_encountered || item.files_modified;
    const files = parseArr(item.files_modified);
    const canQueue = item.status === 'open';
    const blocksCount = item.blocks_count || 0;
    const blockedByTitle = item.blocked_by_title || null;
    const blockerTag = blocksCount > 0
      ? ' <span class="blocks-badge" title="This item must complete before '+blocksCount+' other item'+(blocksCount>1?'s':'')+' can start">⬆ blocks '+blocksCount+'</span>'
      : '';
    const waitingTag = blockedByTitle
      ? ' <span class="waiting-badge" title="Waiting for: '+esc(blockedByTitle)+'">' + ICONS.clock + ' waiting for #'+item.depends_on+'</span>'
      : '';
    const triggerBtn = canQueue
      ? '<button class="row-trigger-btn" onclick="queueItem(event,'+item.id+')" title="Queue this item now">' + ICONS.play + '</button>'
      : item.status==='in-progress'
        ? '<button class="log-btn" style="padding:2px 8px;font-size:11px" onclick="event.stopPropagation();openLogModal('+item.id+',&#39;'+esc(item.title).replace(/'/g,'').slice(0,40)+'&#39;)" title="View live logs">Logs</button>'
      : '<span style="color:var(--muted);font-size:11px;display:inline-flex;vertical-align:middle">'+(item.status==='queued'?ICONS.clock:item.status==='complete'?ICONS.checkSmall:'—')+'</span>';
    return '<tr class="'+(hasDetail?'clickable-row':'')+'" '+(hasDetail?'data-expand="'+eid+'"':'')+' title="'+(hasDetail?'Click to expand':'')+'">'
      + '<td style="text-align:center;padding:10px 6px">' + itemTrafficDot(item) + '</td>'
      + '<td class="mono">#'+item.id+'</td>'
      + '<td>'+esc(item.title)+blockerTag+waitingTag+(hasDetail?' <span style="color:var(--muted);font-size:10px">▼</span>':'')+'</td>'
      + '<td>'+priorityBadge(item.priority)+'</td>'
      + '<td>'+phaseBadge(item.phase)+'</td>'
      + '<td>'+statusBadge(item._is_blocked ? 'blocked' : item.status)+'</td>'
      + '<td class="dim">'+fmt(item.category)+'</td>'
      + '<td class="dim">'+fmt(item.agent_assigned)+'</td>'
      + '<td class="dim">'+fmt(item.estimated_mins)+'</td>'
      + '<td class="dim">'+fmt(item.actual_mins)+'</td>'
      + '<td class="dim">' + timeAgoCell(item.completed_at) + '</td>'
      + '<td class="dim">' + timeAgoCell(item.created_at) + '</td>'
      + '<td style="text-align:center;width:38px">' + triggerBtn + '</td>'
      + '</tr>'
      + (hasDetail ? '<tr class="expand-row" id="'+eid+'"><td colspan="'+NCOLS+'">'
        + '<div class="expand-grid">'
        + (item.plan_description ? '<div class="expand-field"><label>Required</label><p>'+esc(item.plan_description)+'</p></div>' : '')
        + (item.actual_description ? '<div class="expand-field"><label>Done</label><p>'+esc(item.actual_description)+'</p></div>' : '')
        + (item.remarks ? '<div class="expand-field"><label>Remarks</label><p>'+esc(item.remarks)+'</p></div>' : '')
        + (item.errors_encountered ? '<div class="expand-field errors"><label>Errors</label><p>'+esc(item.errors_encountered)+'</p></div>' : '')
        + (files.length ? '<div class="expand-field"><label>Files Modified</label><p>'+files.map(f=>'<span class="tag">'+esc(f)+'</span>').join(' ')+'</p></div>' : '')
        + buildDepInspector(item, cache.items || [])
        + '</div></td></tr>' : '');
  }).join('');

  attachExpand(document.getElementById('tbl-items'));

  // Mobile card view
  const cardsEl = document.getElementById('items-cards');
  if (cardsEl) {
    cardsEl.innerHTML = pageSlice.map(item => {
      const cid = 'cx-item-' + item.id;
      const hasDetail = !!(item.plan_description || item.actual_description || item.remarks || item.errors_encountered || item.files_modified);
      const cardFiles = parseArr(item.files_modified);
      const estMins = item.estimated_mins ? fmtMins(item.estimated_mins) : null;
      const actMins = item.actual_mins ? fmtMins(item.actual_mins) : null;
      const canQueue = item.status === 'open';
      return '<div class="item-card'+(hasDetail?' clickable':'')+'" '+(hasDetail?'onclick="toggleItemCard(&#39;'+cid+'&#39;)"':'')+' >'
        + '<div class="item-card-header">'
        + '<span class="item-card-dot">' + itemTrafficDot(item) + '</span>'
        + '<span class="item-card-title">'+esc(item.title)+(hasDetail?' <span style="color:var(--muted);font-size:10px">▼</span>':'')+'</span>'
        + '<span class="item-card-id">#'+item.id+'</span>'
        + '</div>'
        + '<div class="item-card-badges">'
        + statusBadge(item._is_blocked ? 'blocked' : item.status)
        + ' ' + priorityBadge(item.priority)
        + ' ' + phaseBadge(item.phase)
        + (canQueue ? ' <button class="row-trigger-btn" onclick="event.stopPropagation();queueItem(event,'+item.id+')" title="Queue this item now">' + ICONS.play + ' Queue</button>' : '')
        + '</div>'
        + '<div class="item-card-meta">'
        + (item.category ? '<span class="item-card-meta-item"><span class="item-card-meta-label">cat</span>&nbsp;'+esc(item.category)+'</span>' : '')
        + (item.agent_assigned ? '<span class="item-card-meta-item"><span class="item-card-meta-label">agent</span>&nbsp;'+esc(item.agent_assigned)+'</span>' : '')
        + (estMins ? '<span class="item-card-meta-item"><span class="item-card-meta-label">est</span>&nbsp;'+estMins+'</span>' : '')
        + (actMins ? '<span class="item-card-meta-item"><span class="item-card-meta-label">actual</span>&nbsp;'+actMins+'</span>' : '')
        + '</div>'
        + (hasDetail ? '<div class="item-card-expand" id="'+cid+'">'
          + '<div class="expand-grid" style="grid-template-columns:1fr">'
          + (item.plan_description ? '<div class="expand-field"><label>Required</label><p>'+esc(item.plan_description)+'</p></div>' : '')
          + (item.actual_description ? '<div class="expand-field"><label>Done</label><p>'+esc(item.actual_description)+'</p></div>' : '')
          + (item.remarks ? '<div class="expand-field"><label>Remarks</label><p>'+esc(item.remarks)+'</p></div>' : '')
          + (item.errors_encountered ? '<div class="expand-field errors"><label>Errors</label><p>'+esc(item.errors_encountered)+'</p></div>' : '')
          + (cardFiles.length ? '<div class="expand-field"><label>Files Modified</label><p>'+cardFiles.map(f=>'<span class="tag">'+esc(f)+'</span>').join(' ')+'</p></div>' : '')
          + '</div></div>' : '')
        + '</div>';
    }).join('');
  }

  updateTabStats(data);
  renderPagination('items-pgbar', itemsPage, totalPages, total, itemsPageSize, start,
    (pg) => { itemsPage = pg; redrawItems(); },
    (sz) => { itemsPageSize = sz; itemsPage = 1; redrawItems(); }
  );
  renderPagination('items-pgbar-cards', itemsPage, totalPages, total, itemsPageSize, start,
    (pg) => { itemsPage = pg; redrawItems(); },
    (sz) => { itemsPageSize = sz; itemsPage = 1; redrawItems(); }
  );
}

function toggleItemCard(id) {
  var el = document.getElementById(id);
  if (el) el.classList.toggle('open');
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE: Chains
// ─────────────────────────────────────────────────────────────────────────────
function renderChainsPage(payload) {
  const data = payload && Array.isArray(payload.chains) ? payload.chains : [];
  if (!payload || payload.supported === false) {
    const parts = [];
    if (payload && payload.missing_columns && payload.missing_columns.length) {
      parts.push('Missing columns: ' + payload.missing_columns.join(', '));
    }
    if (payload && payload.missing_tables && payload.missing_tables.length) {
      parts.push('Missing tables: ' + payload.missing_tables.join(', '));
    }
    $('pageContent').innerHTML = '<div class="empty-state">'
      + '<div class="icon">' + ICONS.chains48 + '</div>'
      + '<h2>Chains view is waiting on the PDCA v2 migration</h2>'
      + '<p>' + esc(parts.join(' | ') || 'Chain schema has not been applied yet.') + '</p>'
      + '</div>';
    return;
  }

  if (!data.length) {
    $('pageContent').innerHTML = '<div class="empty-state">'
      + '<div class="icon">' + ICONS.chains48 + '</div>'
      + '<h2>No chains found for this project</h2>'
      + '<p>Once PDCA v2 items are created, chain summaries will appear here.</p>'
      + '</div>';
    return;
  }

  $('pageContent').innerHTML = '<div class="result-count">Showing ' + data.length + ' chain' + (data.length === 1 ? '' : 's') + '</div>'
    + '<div class="table-wrap"><div class="table-toolbar">' + makeDensityBtn('tbl-chains') + '</div>'
    + '<div class="table-scroll"><table id="tbl-chains">'
    + '<thead><tr>'
    + '<th>Chain Root</th><th>Title</th><th>Status</th><th>Iteration</th><th>Check</th><th>Progress</th><th>Last Activity</th>'
    + '</tr></thead><tbody>'
    + data.map(function(row) {
      const score = row.latest_check_score || 0;
      const progress = Math.max(0, Math.min(100, row.total_items ? Math.round((row.completed_items / row.total_items) * 100) : 0));
      return '<tr>'
        + '<td class="mono">#' + esc(row.chain_root_id) + '</td>'
        + '<td>' + esc(row.root_title || '—') + (row.escalated_to ? ' <span class="waiting-badge">escalated</span>' : '') + '</td>'
        + '<td>' + statusBadge(row.chain_status || 'open') + '</td>'
        + '<td class="dim">' + esc(String(row.max_iteration || 1)) + '</td>'
        + '<td>' + outcomeBadge(row.latest_check_verdict) + (row.latest_check_verdict ? ' <span class="dim">' + esc(String(score)) + '/100</span>' : '') + '</td>'
        + '<td class="dim">' + esc(String(progress)) + '%</td>'
        + '<td class="dim">' + timeAgoCell(row.last_activity_at) + '</td>'
        + '</tr>';
    }).join('')
    + '</tbody></table></div></div>';
  applyDensity('tbl-chains');
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE: Flow — layered dependency DAG
// ─────────────────────────────────────────────────────────────────────────────
function renderFlowPage(rawData) {
  var data = deriveBlocked(rawData);
  var byId = {};
  data.forEach(function(i) { byId[i.id] = i; });

  // Compute topological layers (depth from root)
  var depth = {};
  function computeDepth(item) {
    if (depth[item.id] !== undefined) return depth[item.id];
    if (!item.depends_on || !byId[item.depends_on]) {
      depth[item.id] = 0;
      return 0;
    }
    depth[item.id] = computeDepth(byId[item.depends_on]) + 1;
    return depth[item.id];
  }
  data.forEach(function(i) { computeDepth(i); });

  // Group items by layer
  var layers = {};
  var maxLayer = 0;
  data.forEach(function(i) {
    var d = depth[i.id] || 0;
    if (!layers[d]) layers[d] = [];
    layers[d].push(i);
    if (d > maxLayer) maxLayer = d;
  });

  // Layout constants
  var NODE_W = 160, NODE_H = 52, NODE_RX = 8;
  var COL_GAP = 80, ROW_GAP = 20;
  var PAD_X = 40, PAD_Y = 40;

  // Compute positions
  var positions = {};
  var svgW = 0, svgH = 0;
  for (var layer = 0; layer <= maxLayer; layer++) {
    var items = layers[layer] || [];
    var colX = PAD_X + layer * (NODE_W + COL_GAP);
    var totalH = items.length * (NODE_H + ROW_GAP) - ROW_GAP;
    items.forEach(function(item, idx) {
      var y = PAD_Y + idx * (NODE_H + ROW_GAP);
      positions[item.id] = { x: colX, y: y, cx: colX + NODE_W / 2, cy: y + NODE_H / 2 };
      if (colX + NODE_W + PAD_X > svgW) svgW = colX + NODE_W + PAD_X;
      if (y + NODE_H + PAD_Y > svgH) svgH = y + NODE_H + PAD_Y;
    });
  }
  if (svgW < 400) svgW = 400;
  if (svgH < 300) svgH = 300;

  // Colour helpers — now includes "ready" state (all ancestors complete, can be worked on)
  function nodeStroke(item) {
    if (item._is_blocked) return '#ef4444';
    if (item.status === 'complete') return '#22c55e';
    if (item.status === 'in-progress') return '#eab308';
    if (item.status === 'dropped' || item.status === 'cancelled') return '#4b5563';
    if (item._is_ready) return '#22c55e'; // ready = all deps complete, can start now
    return '#3b82f6';
  }
  function nodeFill(item) {
    if (item._is_blocked) return 'rgba(239,68,68,0.12)';
    if (item.status === 'complete') return 'rgba(34,197,94,0.12)';
    if (item.status === 'in-progress') return 'rgba(234,179,8,0.12)';
    if (item.status === 'dropped' || item.status === 'cancelled') return 'rgba(75,85,99,0.12)';
    if (item._is_ready) return 'rgba(34,197,94,0.08)'; // subtle green tint for ready
    return 'rgba(30,34,51,0.9)';
  }
  // Ready indicator — small green dot to show "ready to start"
  function nodeReadyIndicator(item) {
    if (item._is_ready) return '<circle cx="' + (NODE_W - 8) + '" cy="8" r="4" fill="#22c55e" opacity="0.9"/><title>Ready — all dependencies complete</title>';
    return '';
  }

  // Draw edges (dependency arrows)
  var arrows = data.filter(function(item) {
    return item.depends_on && positions[item.depends_on] && positions[item.id];
  }).map(function(item) {
    var from = positions[item.depends_on];
    var to = positions[item.id];
    // from right edge of blocker, to left edge of dependent
    var x1 = from.x + NODE_W;
    var y1 = from.cy;
    var x2 = to.x;
    var y2 = to.cy;
    var mx = (x1 + x2) / 2;
    var col = item._is_blocked ? '#ef4444' : '#374151';
    var dash = item._is_blocked ? '4,3' : 'none';
    return '<path class="flow-arrow" data-from="' + item.depends_on + '" data-to="' + item.id + '"'
      + ' d="M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2 + '"'
      + ' fill="none" stroke="' + col + '" stroke-width="1.5" stroke-dasharray="' + dash + '" opacity="0.4"'
      + ' marker-end="url(#flow-arr-' + (item._is_blocked?'red':'gray') + ')"/>';
  }).join('');

  // Draw nodes — with ready indicator (green dot) and hierarchical status
  var nodes = data.map(function(item) {
    var pos = positions[item.id];
    if (!pos) return '';
    var stroke = nodeStroke(item);
    var fill = nodeFill(item);
    var titleText = item.title.length > 18 ? item.title.slice(0,18) + '…' : item.title;
    var statusText = item.status;
    if (item._is_blocked) statusText = 'blocked';
    else if (item._is_ready) statusText = 'ready';
    return '<g class="flow-node" data-id="' + item.id + '" data-status="' + esc(item.status) + '" data-title="' + esc(item.title) + '"'
      + ' style="cursor:pointer" transform="translate(' + pos.x + ',' + pos.y + ')">'
      + '<rect x="0" y="0" width="' + NODE_W + '" height="' + NODE_H + '" rx="' + NODE_RX + '"'
      + ' fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5" class="flow-node-rect"/>'
      + nodeReadyIndicator(item)
      + '<text x="' + (NODE_W/2) + '" y="18" font-size="11" fill="#e2e8f0" text-anchor="middle" font-family="sans-serif" font-weight="600">#' + item.id + '</text>'
      + '<text x="' + (NODE_W/2) + '" y="32" font-size="10" fill="#94a3b8" text-anchor="middle" font-family="sans-serif">' + esc(titleText) + '</text>'
      + '<text x="' + (NODE_W/2) + '" y="46" font-size="9" fill="' + stroke + '" text-anchor="middle" font-family="monospace">' + esc(statusText) + '</text>'
      + '<title>' + esc(item.title) + ' | ' + esc(item.status) + (item.priority?' | '+item.priority:'') + (item._is_ready?' | READY':'') + '</title>'
      + '</g>';
  }).join('');

  // Layer headers
  var layerLabels = '';
  for (var l = 0; l <= maxLayer; l++) {
    var lx = PAD_X + l * (NODE_W + COL_GAP) + NODE_W / 2;
    layerLabels += '<text x="' + lx + '" y="18" font-size="10" fill="#4b5563" text-anchor="middle" font-family="monospace" font-weight="700">Layer ' + l + '</text>';
  }

  var svg = '<svg id="flow-svg" width="' + svgW + '" height="' + svgH + '" xmlns="http://www.w3.org/2000/svg" style="display:block;min-width:' + svgW + 'px">'
    + '<defs>'
    + '<marker id="flow-arr-gray" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#374151"/></marker>'
    + '<marker id="flow-arr-red"  markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#ef4444"/></marker>'
    + '<marker id="flow-arr-hl"   markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#818cf8"/></marker>'
    + '</defs>'
    + '<rect width="' + svgW + '" height="' + svgH + '" fill="#0a0c14"/>'
    + layerLabels
    + arrows + nodes
    + '</svg>';

  // Detail panel HTML (shows on click)
  var detailPanel = '<div id="flow-detail" style="display:none;position:fixed;right:24px;top:80px;width:380px;max-height:80vh;overflow-y:auto;background:#1a1d27;border:1px solid #334155;border-radius:10px;padding:16px;z-index:500;box-shadow:0 8px 32px rgba(0,0,0,0.7)">'
    + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">'
    + '<span style="font-size:14px;font-weight:700;color:#e2e8f0;flex:1" id="flow-detail-title">—</span>'
    + '<button onclick="closeFlowDetail()" style="background:transparent;border:none;color:#64748b;cursor:pointer;font-size:16px;padding:0 4px">x</button>'
    + '</div>'
    + '<div id="flow-detail-body" style="font-size:13px;color:#94a3b8;line-height:1.6"></div>'
    + '</div>';

  $('pageContent').innerHTML =
    '<div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap">'
    + '<h2 style="font-size:18px;font-weight:600;margin:0;flex:1">Flow &mdash; Dependency DAG</h2>'
    + '<span style="font-size:13px;color:#64748b">' + data.length + ' nodes &middot; Layered by dependency depth &middot; Hover to trace chain &middot; Click for full dependency detail</span>'
    + '</div>'
    + '<div style="background:#1a1d27;border:1px solid #1e2235;border-radius:8px;overflow-x:auto;padding:8px">'
    + svg + '</div>'
    + detailPanel;

  // Interactivity
  setTimeout(function() {
    var flowSvg = document.getElementById('flow-svg');
    if (!flowSvg) return;

    function allArrows() { return flowSvg.querySelectorAll('.flow-arrow'); }
    function allNodes() { return flowSvg.querySelectorAll('.flow-node'); }

    function resetHighlight() {
      allArrows().forEach(function(el) {
        el.setAttribute('opacity', '0.4');
        el.setAttribute('stroke-width', '1.5');
        var isBlocked = el.getAttribute('stroke') === '#ef4444';
        el.setAttribute('marker-end', 'url(#flow-arr-' + (isBlocked?'red':'gray') + ')');
      });
      allNodes().forEach(function(g) {
        g.querySelector('.flow-node-rect').setAttribute('opacity', '1');
      });
    }

    // Hover highlight — trace full ancestor + descendant chain
    allNodes().forEach(function(g) {
      var nodeId = g.getAttribute('data-id');
      g.addEventListener('mouseenter', function() {
        // Build ancestor and descendant chain IDs for this node
        var chainIds = {};
        chainIds[nodeId] = true;
        // Walk ancestors
        var cur = (cache.items||[]).find(function(i) { return String(i.id) === nodeId; });
        while (cur && cur.depends_on) {
          chainIds[cur.depends_on] = true;
          cur = (cache.items||[]).find(function(i) { return i.id === cur.depends_on; });
        }
        // Walk descendants
        var childMap = {};
        (cache.items||[]).forEach(function(i) { if (i.depends_on) { if (!childMap[i.depends_on]) childMap[i.depends_on] = []; childMap[i.depends_on].push(i); } });
        var descStack = [nodeId];
        while (descStack.length > 0) {
          var pid = descStack.pop();
          (childMap[pid] || []).forEach(function(c) { chainIds[c.id] = true; descStack.push(c.id); });
        }

        allArrows().forEach(function(el) {
          var from = el.getAttribute('data-from');
          var to = el.getAttribute('data-to');
          if (chainIds[from] && chainIds[to]) {
            el.setAttribute('opacity', '1');
            el.setAttribute('stroke-width', '2.5');
            el.setAttribute('stroke', '#818cf8');
            el.setAttribute('marker-end', 'url(#flow-arr-hl)');
          } else {
            el.setAttribute('opacity', '0.08');
          }
        });
        allNodes().forEach(function(gn) {
          var nid = gn.getAttribute('data-id');
          if (!chainIds[nid]) gn.querySelector('.flow-node-rect').setAttribute('opacity', '0.3');
        });
      });
      g.addEventListener('mouseleave', function() {
        resetHighlight();
      });

      // Click: show detail panel with full dependency chain
      g.addEventListener('click', function() {
        var item = (cache.items||[]).find(function(i) { return String(i.id) === nodeId; });
        if (!item) return;
        var panel = document.getElementById('flow-detail');
        var titleEl = document.getElementById('flow-detail-title');
        var bodyEl = document.getElementById('flow-detail-body');
        if (!panel || !titleEl || !bodyEl) return;

        // ── Walk ancestor chain (depends_on → depends_on → ...) ──────────────
        var ancestorChain = [];
        var visited = {};
        var curId = item.depends_on;
        while (curId && !visited[curId]) {
          visited[curId] = true;
          var ancestor = (cache.items||[]).find(function(i) { return i.id === curId; });
          if (!ancestor) break;
          ancestorChain.push(ancestor);
          curId = ancestor.depends_on;
        }

        // ── Walk descendant chain (items that depend on this, recursively) ──
        var byParentId = {};
        (cache.items||[]).forEach(function(i) {
          if (i.depends_on) {
            if (!byParentId[i.depends_on]) byParentId[i.depends_on] = [];
            byParentId[i.depends_on].push(i);
          }
        });
        var descendantChain = [];
        var descVisited = {};
        var descStack = [item.id];
        while (descStack.length > 0) {
          var parentId = descStack.pop();
          if (descVisited[parentId]) continue;
          descVisited[parentId] = true;
          var children = byParentId[parentId] || [];
          children.forEach(function(c) {
            descendantChain.push(c);
            descStack.push(c.id);
          });
        }

        // ── Determine blocked status based on transitive ancestors ─────────
        var incompleteAncestors = ancestorChain.filter(function(a) {
          return a.status !== 'complete' && a.status !== 'cancelled' && a.status !== 'dropped';
        });
        var allDepsComplete = incompleteAncestors.length === 0;

        titleEl.textContent = '#' + item.id + ' ' + item.title;

        // ── Build ancestor chain HTML ───────────────────────────────────────
        var ancestorHtml = '';
        if (ancestorChain.length > 0) {
          ancestorHtml = '<div style="margin-bottom:8px"><span style="color:#64748b;font-size:11px;text-transform:uppercase;font-weight:600">ANCESTOR CHAIN (UPSTREAM DEPENDENCIES)</span><br>';
          ancestorHtml += '<div style="margin-top:4px">';
          ancestorChain.forEach(function(a, idx) {
            var isComplete = a.status === 'complete' || a.status === 'cancelled' || a.status === 'dropped';
            var statusColor = isComplete ? '#22c55e' : (a.status === 'in-progress' ? '#eab308' : '#ef4444');
            var arrow = idx < ancestorChain.length - 1 ? ' <span style="color:#4b5563">→</span> ' : '';
            ancestorHtml += '<span class="badge badge-num" style="margin-right:2px">#' + a.id + '</span> '
              + '<span style="color:' + statusColor + ';font-size:11px">' + esc(a.title.slice(0,25)) + (a.title.length > 25 ? '…' : '') + '</span>'
              + ' <span style="font-size:10px;color:#64748b">(' + esc(a.status) + ')</span>'
              + arrow;
          });
          ancestorHtml += '</div></div>';
        } else {
          ancestorHtml = '<div style="margin-bottom:8px"><span style="color:#64748b;font-size:11px;text-transform:uppercase;font-weight:600">ANCESTOR CHAIN</span><br><span style="font-size:12px;color:#64748b">No dependencies — this is a root task</span></div>';
        }

        // ── Build descendant chain HTML ──────────────────────────────────────
        var descendantHtml = '';
        if (descendantChain.length > 0) {
          descendantHtml = '<div style="margin-bottom:8px"><span style="color:#64748b;font-size:11px;text-transform:uppercase;font-weight:600">DESCENDANT CHAIN (BLOCKS DOWNSTREAM)</span><br>';
          descendantHtml += '<div style="margin-top:4px">';
          descendantChain.slice(0, 8).forEach(function(d) {
            var statusColor = d.status === 'complete' ? '#22c55e' : (d.status === 'in-progress' ? '#eab308' : '#64748b');
            descendantHtml += '<div style="margin-left:4px;padding:1px 0"><span class="badge badge-num">#' + d.id + '</span> '
              + '<span style="color:' + statusColor + ';font-size:11px">' + esc(d.title.slice(0,30)) + (d.title.length > 30 ? '…' : '') + '</span>'
              + ' <span style="font-size:10px;color:#64748b">(' + esc(d.status) + ')</span></div>';
          });
          if (descendantChain.length > 8) {
            descendantHtml += '<div style="font-size:11px;color:#64748b;margin-left:4px">+ ' + (descendantChain.length - 8) + ' more</div>';
          }
          descendantHtml += '</div></div>';
        }

        // ── Readiness banner ────────────────────────────────────────────────
        var readinessHtml = '';
        if (item.status === 'complete' || item.status === 'cancelled' || item.status === 'dropped') {
          // already done — no readiness message
        } else if (item._is_blocked || incompleteAncestors.length > 0) {
          readinessHtml = '<div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:12px">'
            + '<span style="color:#ef4444;font-weight:600">⏸ Blocked</span> — '
            + incompleteAncestors.length + ' incomplete ancestor(s). Cannot start until all upstream dependencies are complete.'
            + '</div>';
        } else {
          readinessHtml = '<div style="background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);border-radius:6px;padding:8px 10px;margin-bottom:10px;font-size:12px">'
            + '<span style="color:#22c55e;font-weight:600">✓ Ready</span> — All dependencies complete. This task can be started now.'
            + '</div>';
        }

        bodyEl.innerHTML = readinessHtml
          + '<div style="margin-bottom:8px"><span style="color:#64748b;font-size:11px">STATUS</span><br>'
          + '<span class="badge ' + (item.status==='complete'?'badge-complete':item._is_blocked?'badge-blocked':item.status==='in-progress'?'badge-in-progress':item._is_ready?'badge-ready':'badge-open') + '">' + esc(item._is_blocked?'blocked':item._is_ready?'ready':item.status) + '</span>'
          + ' <span class="badge ' + (item.priority==='critical'?'badge-critical':item.priority==='high'?'badge-high':item.priority==='medium'?'badge-medium':'badge-low') + '">' + esc(item.priority||'—') + '</span>'
          + '</div>'
          + (item.plan_description ? '<div style="margin-bottom:8px"><span style="color:#64748b;font-size:11px">DESCRIPTION</span><br><span style="font-size:12px">' + esc(item.plan_description.slice(0,200)) + (item.plan_description.length>200?'…':'') + '</span></div>' : '')
          + ancestorHtml
          + descendantHtml;
        panel.style.display = 'block';
      });
    });

    // Click outside to close detail
    document.addEventListener('click', function(e) {
      var panel = document.getElementById('flow-detail');
      var svg = document.getElementById('flow-svg');
      if (panel && !panel.contains(e.target) && !(svg && svg.contains(e.target))) {
        panel.style.display = 'none';
      }
    });
  }, 0);
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
    + '<button class="clear-btn" onclick="sessFilter={search:&#39;&#39;,interface:&#39;&#39;,dateFrom:&#39;&#39;,dateTo:&#39;&#39;};sessPage=1;renderSessionsPage(cache.sessions||[])">Clear</button>'
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
    + ['plan','do','check','act'].map(p=>'<label class="check-pill'+(cyclesFilter.phase.includes(p)?' checked':'')+'"><input type="checkbox" '+(cyclesFilter.phase.includes(p)?'checked':'')+' onchange="toggleFilter(cyclesFilter.phase,&#39;'+p+'&#39;,this.checked);this.parentElement.classList.toggle(&#39;checked&#39;,this.checked);cyclesPage=1;redrawCycles()"> '+p+'</label>').join('')
    + '</div></div>'
    + '<div class="filter-group"><label>Outcome</label><div class="check-group">'
    + ['pass','fail','partial','skipped'].map(o=>'<label class="check-pill'+(cyclesFilter.outcome.includes(o)?' checked':'')+'"><input type="checkbox" '+(cyclesFilter.outcome.includes(o)?'checked':'')+' onchange="toggleFilter(cyclesFilter.outcome,&#39;'+o+'&#39;,this.checked);this.parentElement.classList.toggle(&#39;checked&#39;,this.checked);cyclesPage=1;redrawCycles()"> '+o+'</label>').join('')
    + '</div></div>'
    + '<div class="filter-group"><label>Agent</label><select onchange="cyclesFilter.agent=this.value;cyclesPage=1;redrawCycles()">'+agentOpts+'</select></div>'
    + '<div class="filter-group"><label>Item ID</label><input type="text" placeholder="e.g. 42" style="width:80px" value="'+esc(cyclesFilter.itemId)+'" oninput="cyclesFilter.itemId=this.value;cyclesPage=1;redrawCycles()"></div>'
    + '<div class="filter-group"><label>From</label><input type="date" value="'+cyclesFilter.dateFrom+'" onchange="cyclesFilter.dateFrom=this.value;cyclesPage=1;redrawCycles()"></div>'
    + '<div class="filter-group"><label>To</label><input type="date" value="'+cyclesFilter.dateTo+'" onchange="cyclesFilter.dateTo=this.value;cyclesPage=1;redrawCycles()"></div>'
    + '<button class="clear-btn" onclick="cyclesFilter={phase:[],outcome:[],agent:&#39;&#39;,itemId:&#39;&#39;,dateFrom:&#39;&#39;,dateTo:&#39;&#39;};cyclesPage=1;renderCyclesPage(cache.cycles||[])">Clear</button>'
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
    + '<button class="clear-btn" onclick="fcFilter={search:&#39;&#39;,changeType:&#39;&#39;,itemId:&#39;&#39;,commit:&#39;&#39;,dateFrom:&#39;&#39;,dateTo:&#39;&#39;};fcPage=1;renderFileChangesPage(cache[&#39;file-changes&#39;]||[])">Clear</button>'
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

// ─────────────────────────────────────────────────────────────────────────────
// PAGE: Activities
// ─────────────────────────────────────────────────────────────────────────────
let actFilter = { search:'', status:'', type:'', agent:'' };
let actPage = 1;
let actPageSize = 10;

function renderActivitiesPage(data) {
  const agents = [...new Set(data.map(a => a.agent).filter(Boolean))].sort();
  const agentOpts = '<option value="">All agents</option>' + agents.map(a=>'<option value="'+esc(a)+'">'+esc(a)+'</option>').join('');
  const types = ['delegation_out','delegation_return','direct_action','verification','file_edit','bash_command','decision','error','slash_command'];
  const typeOpts = '<option value="">All types</option>' + types.map(t=>'<option value="'+t+'">'+t.replace(/_/g,' ').toUpperCase()+'</option>').join('');
  const statuses = ['running','success','partial','failed','cancelled'];
  const statusOpts = '<option value="">All statuses</option>' + statuses.map(s=>'<option value="'+s+'">'+s.toUpperCase()+'</option>').join('');

  // Calculate summary stats
  const total = data.length;
  const successCount = data.filter(a => a.status === 'success').length;
  const successRate = total > 0 ? Math.round((successCount / total) * 100) : 0;
  const sevenDaysAgo = Date.now() - 7 * 86400 * 1000;
  const recentCount = data.filter(a => {
    if (!a.created_at) return false;
    const dt = parseDbDate(a.created_at);
    return dt && dt.getTime() >= sevenDaysAgo;
  }).length;

  $('pageContent').innerHTML = '<div class="section"><div class="section-header"><div class="section-title">Activity Summary</div></div>'
    + '<div class="perf-chips" style="margin-bottom:16px">'
    + '<div class="perf-chip default"><span class="chip-val">'+total+'</span><span class="chip-lbl">Total</span></div>'
    + '<div class="perf-chip green"><span class="chip-val">'+successRate+'%</span><span class="chip-lbl">Success Rate</span></div>'
    + '<div class="perf-chip blue"><span class="chip-val">'+recentCount+'</span><span class="chip-lbl">Last 7 Days</span></div>'
    + '</div></div>'
    + '<div class="filter-bar">'
    + '<div class="filter-group"><label>Search</label><input type="text" placeholder="Summary…" value="'+esc(actFilter.search)+'" oninput="actFilter.search=this.value;actPage=1;redrawActivities()"></div>'
    + '<div class="filter-group"><label>Type</label><select onchange="actFilter.type=this.value;actPage=1;redrawActivities()">'+typeOpts+'</select></div>'
    + '<div class="filter-group"><label>Status</label><select onchange="actFilter.status=this.value;actPage=1;redrawActivities()">'+statusOpts+'</select></div>'
    + '<div class="filter-group"><label>Agent</label><select onchange="actFilter.agent=this.value;actPage=1;redrawActivities()">'+agentOpts+'</select></div>'
    + '<button class="clear-btn" onclick="actFilter={search:&#39;&#39;,status:&#39;&#39;,type:&#39;&#39;,agent:&#39;&#39;};actPage=1;renderActivitiesPage(cache.activities||[])">Clear</button>'
    + '</div>'
    + '<div class="result-count" id="act-count"></div>'
    + '<div class="table-wrap">'
    + '<div class="table-toolbar">' + makeDensityBtn('tbl-act') + '</div>'
    + '<div class="table-scroll"><table id="tbl-act">'
    + '<thead><tr>'
    + '<th data-col="id">ID</th><th data-col="created_at">Time</th><th data-col="agent">Agent</th><th data-col="activity_type">Type</th>'
    + '<th data-col="task_summary">Summary</th><th data-col="status">Status</th><th data-col="pdca_item_id">PDCA Link</th>'
    + '</tr></thead><tbody id="act-tbody"></tbody></table></div>'
    + '<div class="pagination-bar" id="act-pgbar"></div>'
    + '</div>';

  attachSortHeaders('tbl-act', 'activities', function() { actPage=1; redrawActivities(); });
  applyDensity('tbl-act');
  redrawActivities();
}

function activityStatusBadge(s) {
  const m = { success:'badge-complete', failed:'badge-fail', running:'badge-in-progress', partial:'badge-partial', cancelled:'badge-cancelled' };
  return '<span class="badge ' + (m[s]||'badge-open') + '">' + esc(s||'—') + '</span>';
}

function activityTypeBadge(t) {
  const colors = {
    delegation_out: 'badge-queued',
    delegation_return: 'badge-complete',
    direct_action: 'badge-do',
    verification: 'badge-check',
    file_edit: 'badge-plan',
    bash_command: 'badge-act',
    decision: 'badge-medium',
    error: 'badge-fail',
    slash_command: 'badge-low'
  };
  return '<span class="badge ' + (colors[t]||'badge-low') + '">' + esc(t||'—').replace(/_/g,' ').toUpperCase() + '</span>';
}

function redrawActivities() {
  const data = cache.activities || [];
  const f = actFilter;
  const st = sortState['activities'] || {};
  let filtered = data.filter(a => {
    if (f.search && !String(a.task_summary||'').toLowerCase().includes(f.search.toLowerCase())) return false;
    if (f.status && a.status !== f.status) return false;
    if (f.type && a.activity_type !== f.type) return false;
    if (f.agent && a.agent !== f.agent) return false;
    return true;
  });
  filtered = sortData(filtered, st.col, st.dir);
  applyThSortClasses('tbl-act', 'activities');

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / actPageSize));
  if (actPage > totalPages) actPage = totalPages;
  const start = (actPage - 1) * actPageSize;
  const pageSlice = filtered.slice(start, start + actPageSize);

  const countEl = document.getElementById('act-count');
  if (countEl) countEl.textContent = 'Showing ' + (total===0?0:start+1) + '–' + Math.min(start+actPageSize,total) + ' of ' + total + ' results';

  const tbody = document.getElementById('act-tbody');
  if (!tbody) return;
  tbody.innerHTML = pageSlice.map(a => {
    const eid = 'ex-act-' + a.id;
    const hasDetail = a.detail || a.files_modified;
    const files = parseArr(a.files_modified);
    const pdcaLink = a.pdca_item_id ? '<a href="#" onclick="navigateTo(&#39;items&#39;);setTimeout(function(){window.location.hash=&#39;item-'+a.pdca_item_id+'&#39;},100);return false;" class="badge badge-num">#'+a.pdca_item_id+'</a>' : '—';
    return '<tr class="'+(hasDetail?'clickable-row':'')+'" '+(hasDetail?'data-expand="'+eid+'"':'')+' title="'+(hasDetail?'Click to expand':'')+'">'
      + '<td class="mono">#'+a.id+'</td>'
      + '<td class="dim">' + timeAgoCell(a.created_at) + '</td>'
      + '<td class="dim">'+fmt(a.agent)+'</td>'
      + '<td>'+activityTypeBadge(a.activity_type)+'</td>'
      + '<td style="max-width:320px"><span title="'+esc(a.task_summary||'')+'">'+esc(trunc(a.task_summary||'—', 80))+'</span></td>'
      + '<td>'+activityStatusBadge(a.status)+'</td>'
      + '<td>'+pdcaLink+'</td>'
      + '</tr>'
      + (hasDetail ? '<tr class="expand-row" id="'+eid+'"><td colspan="7"><div class="expand-grid">'
        + (a.detail ? '<div class="expand-field"><label>Detail</label><p>'+esc(a.detail)+'</p></div>' : '')
        + (files.length ? '<div class="expand-field"><label>Files Modified</label><p>'+files.map(f=>'<span class="tag">'+esc(f)+'</span>').join(' ')+'</p></div>' : '')
        + (a.model ? '<div class="expand-field"><label>Model</label><p>'+esc(a.model)+'</p></div>' : '')
        + (a.duration_secs ? '<div class="expand-field"><label>Duration</label><p>'+a.duration_secs+'s</p></div>' : '')
        + '</div></td></tr>' : '');
  }).join('');
  attachExpand(document.getElementById('tbl-act'));
  renderPagination('act-pgbar', actPage, totalPages, total, actPageSize, start,
    function(pg) { actPage = pg; redrawActivities(); },
    function(sz) { actPageSize = sz; actPage = 1; redrawActivities(); }
  );
}

// ── Init ──────────────────────────────────────────────────────────────────────

// Restore page from URL on load / refresh
try {
  (function initFromUrl() {
    var VALID_PAGES = ['overview', 'items', 'gantt', 'chains', 'flow', 'sessions', 'cycles', 'file-changes', 'activities'];
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

// ── Log Modal ─────────────────────────────────────────────────────────────────

var _logModalEs = null;
var _logModalItemId = null;
var _logAutoScroll = true;

function openLogModal(itemId, title) {
  _logModalItemId = itemId;
  _logAutoScroll = true;
  var overlay = document.getElementById('log-modal-overlay');
  var titleEl = document.getElementById('log-modal-title');
  var body = document.getElementById('log-modal-body');
  var badge = document.getElementById('log-modal-live-badge');
  var footerCount = document.getElementById('log-modal-footer-count');
  if (!overlay) return;
  titleEl.textContent = '#' + itemId + ' ' + title;
  body.innerHTML = '<div class="log-empty">Connecting...</div>';
  badge.className = '';
  badge.innerHTML = '<span class="live-dot"></span> LIVE';
  if (footerCount) footerCount.textContent = '0 lines';
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';

  if (_logModalEs) { try { _logModalEs.close(); } catch(e) {} _logModalEs = null; }

  var es = new EventSource('/api/items/' + itemId + '/logs/stream');
  _logModalEs = es;
  var lineCount = 0;

  es.onmessage = function(e) {
    try {
      var data = JSON.parse(e.data);
      if (lineCount === 0) body.innerHTML = '';
      lineCount++;
      var div = document.createElement('div');
      div.className = 'log-line';
      var ts = data.ts ? data.ts.replace('T',' ').slice(0,19) : '';
      div.innerHTML = '<span class="log-ts">' + ts + '</span><span class="log-text">' + escLog(data.line) + '</span>';
      body.appendChild(div);
      if (_logAutoScroll) body.scrollTop = body.scrollHeight;
      if (footerCount) footerCount.textContent = lineCount + ' line' + (lineCount === 1 ? '' : 's');
    } catch(err) {}
  };

  es.addEventListener('close', function(e) {
    badge.className = 'disconnected';
    try {
      var d = JSON.parse(e.data);
      badge.innerHTML = '<span class="live-dot"></span> ' + (d.status || 'DONE').toUpperCase();
    } catch(ex) {
      badge.innerHTML = '<span class="live-dot"></span> CLOSED';
    }
    if (lineCount === 0) body.innerHTML = '<div class="log-empty">No logs for this item yet.</div>';
    es.close();
  });

  es.onerror = function() {
    badge.className = 'disconnected';
    badge.innerHTML = '<span class="live-dot"></span> ERR';
    if (lineCount === 0) body.innerHTML = '<div class="log-empty">Could not connect to log stream.</div>';
  };
}

function closeLogModal() {
  if (_logModalEs) { try { _logModalEs.close(); } catch(e) {} _logModalEs = null; }
  var overlay = document.getElementById('log-modal-overlay');
  if (overlay) overlay.classList.remove('open');
  document.body.style.overflow = '';
  _logModalItemId = null;
}

function escLog(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

document.addEventListener('click', function(e) {
  var overlay = document.getElementById('log-modal-overlay');
  if (overlay && e.target === overlay) closeLogModal();
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeLogModal();
});

document.addEventListener('scroll', function(e) {
  var body = document.getElementById('log-modal-body');
  if (body && e.target === body) {
    _logAutoScroll = body.scrollTop + body.clientHeight >= body.scrollHeight - 30;
  }
}, true);

</script>

<!-- Log Modal -->
<div id="log-modal-overlay">
  <div id="log-modal">
    <div id="log-modal-header">
      <div id="log-modal-title">Logs</div>
      <div id="log-modal-live-badge"><span class="live-dot"></span> LIVE</div>
      <button id="log-modal-close" onclick="closeLogModal()" title="Close (Esc)">x</button>
    </div>
    <div id="log-modal-body"></div>
    <div id="log-modal-footer">
      <span id="log-modal-footer-count">0 lines</span>
      <button class="log-btn" onclick="(function(){var b=document.getElementById('log-modal-body');if(b){b.scrollTop=b.scrollHeight;_logAutoScroll=true;}})()">Scroll to bottom</button>
      <button class="log-btn" onclick="closeLogModal()">Close</button>
    </div>
  </div>
</div>
</body>
</html>`;

// Serve dashboard for all non-API routes (SPA fallback)
app.get('*', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(DASHBOARD_HTML);
});

// ── Start ─────────────────────────────────────────────────────────────────────
// Bind to localhost — pdca.konzult.in via Caddy is the only public ingress.
// Override with LISTEN_HOST=0.0.0.0 only if you deliberately need direct access.
const LISTEN_HOST = process.env.LISTEN_HOST || '127.0.0.1';
app.listen(PORT, LISTEN_HOST, () => {
  console.log(`PDCA Dashboard running at http://${LISTEN_HOST}:${PORT}`);
});
