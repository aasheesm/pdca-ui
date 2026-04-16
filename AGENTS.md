# Master Rule: PDCA-First Implementation

**Source of truth:** `/root/projects/vault/instructions/PDCA-FIRST.md` (auto-loaded by Kilo into every session). All implementation across all products must be tracked via PDCA items before code changes. No ghost commits.

---

# Repository Guidelines

## Project Structure & Module Organization
This repository is a small Node.js dashboard app centered on [server.js](/root/projects/pdca-ui/server.js). Application routes, auth, API handlers, and inline HTML/CSS currently live in that file. Runtime process settings are in [ecosystem.config.js](/root/projects/pdca-ui/ecosystem.config.js). Package metadata and scripts are in [package.json](/root/projects/pdca-ui/package.json). GitHub automation lives under `.github/workflows/`.

There is no dedicated `src/`, `tests/`, or static asset directory yet. If the app grows, prefer extracting route handlers and UI templates into focused modules rather than expanding `server.js` further.

## Build, Test, and Development Commands
Use:

- `npm install` to install dependencies.
- `npm start` to run the Express server locally on port `7010`.
- `node --check server.js` to catch syntax errors before committing.
- `npx pm2 start ecosystem.config.js` to run the app with the repository's PM2 config.

No build step is defined; this is a direct Node runtime project.

## Coding Style & Naming Conventions
Follow the existing style in `server.js`: 2-space indentation, semicolons, single quotes, and `const` by default. Use `UPPER_SNAKE_CASE` for configuration constants such as `PORT` and `DB_PATH`, and `camelCase` for variables and functions such as `requireAuth`.

Keep route handlers small and defensive. Return JSON errors for `/api/*` endpoints and preserve the current explicit status checks and input validation patterns.

## Testing Guidelines
There is no automated test framework configured yet. Until one is added, contributors should:

- run `node --check server.js`
- start the app with `npm start`
- manually verify login flow and affected `/api/*` endpoints

When adding tests, place them in a top-level `tests/` directory and name files `*.test.js`.

## Commit & Pull Request Guidelines
Recent commits use short, imperative subjects such as `Add manual deploy workflow` and `Fix SSH port to 2222 in deploy workflow". Keep commit messages focused on one change and start with a verb.

PRs should include:

- a concise summary of behavior changes
- linked issue or task reference when available
- screenshots or response samples for UI/API changes
- notes about manual verification performed

## Security & Configuration Tips
Avoid hardcoding new secrets. Prefer environment variables for credentials and session settings, following the existing `PDCA_SESSION_SECRET` pattern. Be careful with absolute filesystem paths like `/root/data/assistant/...`; document any new path dependency in the PR.

---

# PDCA Orchestration System

This dashboard is an **orchestration layer** that governs multiple projects on the VPS using a PDCA (Plan-Do-Check-Act) workflow system.

## Overview

- **Dashboard URL:** `pdca.konzult.in` → Caddy → `localhost:7010`
- **PM2 Process:** `pdca-dashboard`
- **Database:** `/root/data/assistant/tasks.db` (SQLite, WAL mode)
- **Auth:** `ashish@konzult.in` (credentials in server.js)

```bash
pm2 restart pdca-dashboard   # Restart after edits
pm2 logs pdca-dashboard --lines 20 --nostream  # Check logs
```

## Architecture

```
Telegram ──► Claude Channels ──► orchestrator.sh
                                            │
           ┌─────────────────────────────────┴────────────────────────┐
           │                                                          │
    pdca-workbuddy-trigger.sh                   pdca-queue-processor.sh
    (WorkBuddy autonomous cycle)                (general queue dispatcher)
    every 15 min cron                          every 2 min cron + on-demand
           │                                            │
    pdca-workbuddy-worker.sh                     pdca-v2-phase-worker.sh
    (WorkBuddy-specific agent)                  (general phase worker)
           │                                            │
           └──────────────────────────┬─────────────────┘
                                      │
                              pdca-items table
                                      │
                        ┌─────────────┼─────────────────┐
                        │             │                  │
                    Dashboard    pdca-stuck-reset    pdca-escalate
                    (UI :7010)    (every 30 min)      (manual)
```

## Projects Under Orchestration

| Project ID | Directory | Agent | Check Strategy | Description |
|------------|-----------|-------|---------------|-------------|
| `WorkBuddy` | `/root/projects/workbuddy` | workbuddy-agent | `expo-start` | Sales CRM (React Native) |
| `ERP` | `/root/projects/ERP` | erp-agent | `server-smoke` | Manufacturing ERP |
| `pdca-ui` | `/root/projects/pdca-ui` | ops-agent | `server-smoke` | This dashboard |
| `Konzult` | `/root/projects/sitegen` | konzult-agent | `curl-endpoint` | Website builder |
| `Pulse` | `/root/projects/pulse` | pulse-agent | `typecheck` | AI chief of staff |

Stored in `pdca_projects` table with `max_iterations=3` per item chain.

## PDCA Serial Number System

Tasks are referenced by **serial number (item ID)** in the dashboard:

| Serial | Project | Example Task |
|--------|---------|-------------|
| #37 | WorkBuddy | Add Challenges + KRA targets to offline sync |
| #39 | pdca-ui | Fix Done This Week — broken SQLite date parsing |
| #42-46 | pdca-ui | PDCA v2 — DB migration, phase worker, queue processor, etc. |

When instructing agents via Telegram, use the format:
> "Work on PDCA item #42" or "Start item #37"

## PDCA Phases

Each task moves through four phases:

```
plan → do → check → act
```

| Phase | Description | Worker Action |
|-------|-------------|---------------|
| **plan** | Analyze requirements, produce implementation spec | Create DO item with spec |
| **do** | Execute implementation | Make code changes, tests |
| **check** | Verify against requirements | Score 0-100, verdict pass/partial/fail |
| **act** | Capture learnings, determine next steps | Update chain status, create follow-ups |

## PDCA v2 Chain System

Each **improvement chain** is a series of related PDCA items. An item is born from the previous phase and carries chain context.

**Chain fields:**

| Field | Meaning |
|-------|---------|
| `chain_root_id` | ID of the root item in the chain — same for whole chain |
| `source_id` | ID of the item that *spawned* this one (direct parent) |
| `iteration` | 1-based iteration number within the chain |
| `chain_status` | `active` → one phase incomplete · `complete` → all phases done · `abandoned` → cancelled/dropped |
| `escalated_to` | Agent escalated to (e.g., `planner`) |
| `check_verdict` | `pass` · `partial` · `fail` — set by check phase |
| `check_score` | 0–100 quality score from check phase |
| `act_learnings` | Documentation of what was learned |
| `stuck_count` | How many times this item has been auto-reset from in-progress |

**Chain flow:**

```
plan item (source_id: null, chain_root: own_id, iteration: 1)
    └─► do item (source_id: plan_id, chain_root: same, iteration: 1)
            └─► check item (source_id: do_id, same chain, iteration: 1)
                    ├─► pass → act item (source_id: check_id) → chain complete
                    └─► fail/partial → act item + new plan item (iteration: 2)
```

**Max iterations:** 3 per chain (enforced by `pdca_projects.max_iterations`).

## Database Schema

### pdca_items (core table)

```sql
pdca_items (
  id                  INTEGER PRIMARY KEY
, project_id          TEXT     -- references pdca_projects.project_id
, slug                TEXT     -- unique within project
, title               TEXT
, phase               TEXT     -- plan | do | check | act
, status              TEXT     -- open | queued | in-progress | blocked | complete | cancelled | dropped
, priority            TEXT     -- critical | high | medium | low
, category            TEXT     -- feature | bug | security | docs | infra | research
, plan_description    TEXT     -- spec for plan phase, summary for do phase
, actual_description TEXT
, remarks             TEXT
, errors_encountered  TEXT
, files_modified      TEXT     -- JSON array of file paths
, estimated_mins      INTEGER
, actual_mins         INTEGER
, agent_assigned      TEXT     -- workbuddy-agent | erp-agent | konzult-agent | ops-agent | pulse-agent
, doc_path            TEXT     -- path to spec/design doc
, depends_on          INTEGER  -- FK to another pdca_items.id (dependency chain)
, started_at          DATETIME
, completed_at        DATETIME
, due_date            DATE
, cycle_count         INTEGER
, source_id           TEXT     -- PDCA v2: points to original item that spawned this
, chain_root_id       TEXT     -- PDCA v2: root of this improvement chain
, iteration           TEXT     -- PDCA v2: iteration number (1, 2, 3...)
, chain_status        TEXT     -- PDCA v2: active | complete | abandoned
, escalated_to        TEXT     -- PDCA v2: planner | specific agent
, check_verdict       TEXT     -- PDCA v2: pass | partial | fail
, check_score         TEXT     -- PDCA v2: 0-100 score
, check_evidence      TEXT     -- PDCA v2: check phase findings
, act_learnings       TEXT     -- PDCA v2: learnings JSON
, stuck_count         INTEGER  -- PDCA v2: how many times reset from stuck
, notified_at         DATETIME
, project_dir         TEXT
, hypothesis          TEXT     -- PDCA v2: lean hypothesis
, acceptance_criteria TEXT     -- PDCA v2: criteria for check phase
, check_gaps          TEXT     -- PDCA v2: gaps found in check
, UNIQUE(project_id, slug)
)
Indexes: idx_pdca_chain_root, idx_pdca_source, idx_pdca_status_phase
```

### pdca_cycles (phase execution log — one row per phase run)

```sql
pdca_cycles (
  id            INTEGER PRIMARY KEY
, item_id       INTEGER  -- FK to pdca_items
, session_id    INTEGER
, project_id    TEXT
, phase         TEXT     -- plan | do | check | act
, outcome       TEXT     -- pass | fail | partial | blocked | skipped
, agent_used    TEXT
, git_commit    TEXT
, plan_notes    TEXT
, actual_notes  TEXT
, errors        TEXT
, remarks       TEXT
, started_at    DATETIME
, ended_at      DATETIME
, duration_mins INTEGER
)
```

### pdca_sessions (grouped batch of cycles)

```sql
pdca_sessions (
  id               INTEGER PRIMARY KEY
, project_id       TEXT
, cycles_requested INTEGER
, cycles_completed INTEGER
, items_promoted   TEXT  -- JSON array of pdca_item IDs
, items_failed     TEXT  -- JSON array
, summary          TEXT
, interface        TEXT  -- vscode | telegram | terminal
, started_at       DATETIME
, ended_at         DATETIME
)
```

### pdca_file_changes (files touched per cycle)

```sql
pdca_file_changes (
  id          INTEGER PRIMARY KEY
, item_id     INTEGER  -- FK to pdca_items
, cycle_id    INTEGER
, session_id  INTEGER
, project_id  TEXT
, file_path   TEXT
, change_type TEXT     -- added | modified | deleted | renamed
, old_path    TEXT
, git_commit  TEXT
, description TEXT
, changed_at  DATETIME
)
```

### pdca_logs (live agent output stream)

```sql
pdca_logs (
  id         INTEGER PRIMARY KEY
, item_id    INTEGER  -- FK to pdca_items
, line       TEXT
, created_at DATETIME
)
```

### pdca_projects (project registry)

```sql
pdca_projects (
  project_id      TEXT PRIMARY KEY
, project_dir     TEXT
, default_agent   TEXT
, max_iterations  INTEGER  -- default 3
, check_strategy  TEXT     -- typecheck | server-smoke | curl-endpoint | expo-start | manual
, active          INTEGER  -- 1 or 0
)
```

### Views

- **`pdca_performance`** — per-project aggregate: total, completed, in-progress, blocked, open, cancelled, estimation ratio, completion %
- **`pdca_next_actions`** — open/queued items sorted by priority, excluding blocked ones

### Query Examples

```bash
# List all open items
sqlite3 /root/data/assistant/tasks.db "SELECT id, project_id, title, phase, priority FROM pdca_items WHERE status='open';"

# Get item details
sqlite3 /root/data/assistant/tasks.db "SELECT * FROM pdca_items WHERE id=42;"

# List projects
sqlite3 /root/data/assistant/tasks.db "SELECT project_id, default_agent FROM pdca_projects;"

# Chain view
sqlite3 /root/data/assistant/tasks.db "SELECT * FROM pdca_items WHERE chain_root_id IS NOT NULL;"
```

## Worker Scripts

| Script | Purpose | Run Frequency |
|--------|---------|---------------|
| `pdca-queue-processor.sh` | Dispatch queued items to agents | Every 2 min (cron) + on-demand |
| `pdca-v2-phase-worker.sh` | Phase worker — picks up from queue processor, builds phase-specific prompt, calls Claude | On-demand |
| `pdca-stuck-reset.sh` | Detect stuck items, auto-reset/escalate | Every 30 min (cron) |
| `pdca-escalate.sh` | Manual escalation to different agent | Manual |
| `pdca-workbuddy-trigger.sh` | WorkBuddy autonomous trigger — probes Claude, reverts stale queued, claims up to 3 items, spawns workers, sends Telegram summary | Every 15 min (cron) |
| `pdca-workbuddy-worker.sh` | WorkBuddy-specific worker (called by trigger) | On-demand |

### Queue Processor Safety Guards

- **Global limit:** Max 5 items in-progress across all agents
- **Worker timeout:** 30 minutes per item
- **System guards:** CPU/memory checks before dispatch
- **Failure backoff:** After 3 consecutive failures, pauses 10 min
- **Stale detection:** Items stuck >30 min are auto-reset to queued

### Stuck Item Behavior

| Time Stuck | Action |
|------------|--------|
| >30 min | Log warning |
| >60 min | Auto-escalate to `planner` |
| >120 min | Auto-reset to `queued` for retry |

## Agent Routing

Agents are assigned based on `project_id`:

| Project | Agent | Model |
|---------|-------|-------|
| WorkBuddy | workbuddy-agent | Sonnet |
| ERP | erp-agent | Sonnet |
| pdca-ui | ops-agent | Sonnet |
| Konzult | konzult-agent | Sonnet |
| Pulse | pulse-agent | Sonnet |
| (fallback) | general-purpose | Sonnet |
| (planning) | planner | Opus |

## Dashboard Pages

The UI has 7 pages:

| Page | Route | Data |
|------|-------|------|
| **Overview** | `/` | Performance chips per project, done-this-week feed, activity feed |
| **Items** | `/items` | Sortable/filterable table, by-project, open/queued/in-progress/blocked views, traffic light dots, item cards (mobile), real-time SSE log modal |
| **Gantt** | `/gantt` | SVG dependency chart, topological sort, critical path highlighting, today marker |
| **Chains** | `/chains` | Chain grouping by `chain_root_id`, iteration status, check scores |
| **Sessions** | `/sessions` | Batch session history per project |
| **Cycles** | `/cycles` | All phase executions with outcome badges |
| **File Changes** | `/file-changes` | Files modified per item/cycle/project |

### Traffic Light System

Each item gets a colored dot:
- 🔴 **Red** — blocked (dependency not complete) or status=`blocked`
- 🟡 **Amber** — in-progress or check phase active
- 🟢 **Green** — complete
- 🟣 **Purple** — queued (dispatched, waiting for LLM)
- ⚫ **Gray** — open/not started

### Live Log Streaming (SSE)

Click any in-progress item → real-time log stream via Server-Sent Events at `GET /api/items/:id/logs/stream`. Worker appends to `pdca_logs`. UI polls every 2s via `EventSource`.

## API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/projects` | List all project IDs |
| GET | `/api/performance?project=X` | Project performance aggregates |
| GET | `/api/items?project=X` | All items for a project (full detail) |
| GET | `/api/sessions?project=X` | Recent sessions |
| GET | `/api/next-actions?project=X` | Open items not blocked |
| GET | `/api/cycles?project=X&limit=N` | Cycles history |
| GET | `/api/file-changes?project=X&limit=N` | File changes |
| GET | `/api/chains?project=X` | Chain groups |
| POST | `/api/items/:id/queue` | Queue a single item (open→queued), fires queue processor |
| POST | `/api/trigger-cycle` | Manually run trigger cycle (WorkBuddy) |
| GET | `/api/items/:id/logs` | All logs for item |
| GET | `/api/items/:id/logs/stream` | SSE live log stream |
| POST | `/api/items/:id/logs` | Append a log line |
| GET/POST | `/login`, `/logout` | Auth |

## Auto-Operation (Zero-Human Workflow)

```
Telegram message "run pdca" or cron tick (15 min)
    │
    ▼
pdca-workbuddy-trigger.sh
    │  1. Probe Claude availability (backoff if rate-limited)
    │  2. Auto-revert stale queued items (>30min unclaimed → open)
    │  3. Claim up to 3 open items (atomic UPDATE)
    │  4. Spawn workers in parallel
    ▼
pdca-workbuddy-worker.sh / pdca-v2-phase-worker.sh
    │  1. Set status = in-progress
    │  2. cd into project_dir
    │  3. Call Claude with phase-specific prompt + chain context
    │  4. Worker creates next-phase item with chain fields
    │  5. Worker marks self complete/partial/blocked
    │  6. Output "PDCA_RESULT:outcome|detail"
    ▼
Trigger collects results → Telegram summary
    │
    ▼ (next 15-min tick or 2-min queue processor if new items queued)
pdca-queue-processor.sh (general)
    │  1. Resource guards
    │  2. Per-agent: skip if already busy
    │  3. Dispatch highest-priority queued item per agent
    ▼
pdca-stuck-reset.sh (every 30 min)
    │  stuck >120min → reset to queued
    │  stuck >60min  → escalate to planner
    ▼
```

**Concurrency:** Max 5 global in-progress; unlimited agents but typically 1 per project.

## Agent Prompts (PDCA v2)

Each worker receives a system prompt defining its phase. Key rules:
- Always `cd` to `$PDCA_PROJECT_DIR` before working
- Create next phase item with `source_id`, `chain_root_id`, `iteration` fields
- Mark self `complete` (or `blocked` / `partial`) when done
- Only escalate to `planner` (Opus) for architecture/refactoring or if `escalated_to=planner`
- Parse Claude output for `PDCA_RESULT:outcome|detail` line
- Max iteration enforcement: if `iteration >= max_iterations` (from `pdca_projects`), halt the chain

## Known Gaps / TODOs

- `pdca-migrate-v2.sh` ran a one-time schema migration (chain columns + `pdca_projects` table); check it for v2 schema completeness.
- Project mapping in `pdca-queue-processor.sh` hardcodes paths for known projects; new projects need manual entry.
- Chaining logic lives in the Claude LLM prompts (worker scripts), not in SQL — chain integrity depends on LLM following instructions.
- `check_strategy` (how to verify) is declarative but not auto-executed — LLM decides how to implement it.
- `pdca_v2_phase_worker.sh` is the active worker; `pdca-workbuddy-worker.sh` coexists but may be WorkBuddy-specific fallback.

## Quick Reference

```bash
# Restart dashboard after changes
pm2 restart pdca-dashboard

# Check queue processor logs
tail -f /root/logs/pdca-queue-processor.log

# Check stuck reset logs
tail -f /root/logs/pdca-stuck-reset.log

# Force queue processor
/root/scripts/pdca-queue-processor.sh

# Clear Claude backoff (if stuck)
/root/scripts/pdca-queue-processor.sh
rm -f /tmp/pdca-claude-backoff

# Manual escalation
/root/scripts/pdca-escalate.sh <item_id> [to_agent] [reason]
```