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
- **Database:** `/root/data/assistant/tasks.db` (SQLite)
- **Auth:** `ashish@konzult.in` (credentials in server.js)

```bash
pm2 restart pdca-dashboard   # Restart after edits
pm2 logs pdca-dashboard --lines 20 --nostream  # Check logs
```

## Projects Under Orchestration

| Project ID | Directory | Agent | Description |
|------------|-----------|-------|-------------|
| `WorkBuddy` | `/root/projects/workbuddy` | workbuddy-agent | Sales CRM (React Native) |
| `ERP` | `/root/projects/ERP` | erp-agent | Manufacturing ERP |
| `pdca-ui` | `/root/projects/pdca-ui` | ops-agent | This dashboard |
| `Konzult` | `/root/projects/sitegen` | konzult-agent | Website builder |
| `Pulse` | `/root/projects/pulse` | pulse-agent | AI chief of staff |

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

Items can be chained together for iterative improvement:

| Field | Description |
|-------|-------------|
| `source_id` | ID of the item that triggered this one |
| `chain_root_id` | ID of the root item in the chain |
| `iteration` | Iteration number (1, 2, 3...) |
| `chain_status` | Current status of the whole chain |
| `escalated_to` | Agent escalated to (e.g., `planner`) |
| `check_verdict` | pass / partial / fail |
| `check_score` | 0-100 quality score |

## Database Schema

```sql
-- Main items table
pdca_items (
  id, project_id, slug, title, phase, status, priority, category,
  plan_description, actual_description, remarks, errors_encountered,
  files_modified, estimated_mins, actual_mins, agent_assigned,
  depends_on, created_at, started_at, completed_at, due_date, cycle_count,
  -- PDCA v2 fields:
  source_id, chain_root_id, iteration, chain_status, escalated_to,
  check_verdict, check_score, check_evidence, act_learnings
)

-- Projects table
pdca_projects (
  project_id, project_dir, default_agent, max_iterations, check_strategy, active
)

-- PDCA cycle history
pdca_cycles (id, project_id, phase, plan_notes, actual_notes, outcome, ...)
```

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
| `pdca-queue-processor.sh` | Dispatch queued items to agents | Every 2 min (cron) |
| `pdca-v2-phase-worker.sh` | Execute a single PDCA item (phase-aware) | On-demand |
| `pdca-stuck-reset.sh` | Detect stuck items, auto-reset/escalate | Every 30 min (cron) |
| `pdca-escalate.sh` | Manual escalation to different agent | Manual |

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

## PDCA API Endpoints

```bash
# Get items for a project
GET /api/items?project=WorkBuddy

# Get chains view
GET /api/chains?project=pdca-ui

# Queue an item (triggers queue processor)
POST /api/items/:id/queue

# Get cycles
GET /api/cycles?project=WorkBuddy

# Get next actions
GET /api/next-actions?project=WorkBuddy
```

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
