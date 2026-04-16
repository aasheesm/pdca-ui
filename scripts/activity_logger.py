#!/usr/bin/env python3
"""
Activity Log CLI — Log and query agent activities in SQLite.
Integrates with PDCA: activities can link to pdca_items and pdca_sessions.

Usage:
  # Log a direct action (no PDCA link)
  python3 activity_logger.py log --agent glm-coder --model ollama-cloud/glm-5.1 \
      --type direct_action --summary "Fixed login bug" --status success \
      --detail "Changed auth flow" --files '["src/auth.ts"]'

  # Log a delegation
  python3 activity_logger.py log --agent glm-coder --model ollama-cloud/glm-5.1 \
      --type delegation_out --summary "Delegate reasoning" --status success \
      --source glm-coder --target minimax-reasoner --purpose "Probability calc"

  # Link to PDCA item
  python3 activity_logger.py log --agent glm-coder --model ollama-cloud/glm-5.1 \
      --type direct_action --summary "Implemented auth guard" --status success \
      --pdca-item 42 --pdca-phase do

  # Link to PDCA session
  python3 activity_logger.py log --agent glm-coder --model ollama-cloud/glm-5.1 \
      --type direct_action --summary "Completed PDCA cycle" --status success \
      --pdca-session 5 --pdca-phase act

  # Query
  python3 activity_logger.py query --project expresolve --last 7d
  python3 activity_logger.py query --agent glm-coder --status failed
  python3 activity_logger.py summary --project expresolve
  python3 activity_logger.py orphans --project expresolve  # activities with no PDCA link
  python3 activity_logger.py pdca-coverage --project expresolve  # % of PDCA items with activities
"""

import argparse
import json
import sqlite3
import sys
from pathlib import Path

DB_PATH = Path("/root/data/assistant/tasks.db")

VALID_TYPES = [
    "delegation_out",
    "delegation_return",
    "direct_action",
    "verification",
    "file_edit",
    "bash_command",
    "decision",
    "error",
    "slash_command",
]
VALID_STATUSES = ["running", "success", "partial", "failed", "cancelled"]
VALID_CONFIDENCES = ["high", "medium", "low"]
VALID_PHASES = ["plan", "do", "check", "act"]


def get_conn():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def log_activity(args):
    conn = get_conn()
    files_json = json.dumps(json.loads(args.files)) if args.files else "[]"
    pdca_item = args.pdca_item if args.pdca_item else None
    pdca_session = args.pdca_session if args.pdca_session else None
    pdca_phase = args.pdca_phase if args.pdca_phase else None

    cursor = conn.execute(
        """INSERT INTO activity_log
           (project, agent, model, activity_type, task_summary, status,
            detail, files_modified, source_agent, target_agent,
            delegation_purpose, confidence, duration_secs,
            pdca_item_id, pdca_session_id, pdca_phase, auto_logged)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)""",
        [
            args.project or "expresolve",
            args.agent,
            args.model,
            args.type,
            args.summary,
            args.status,
            args.detail,
            files_json,
            args.source,
            args.target,
            args.purpose,
            args.confidence,
            args.duration,
            pdca_item,
            pdca_session,
            pdca_phase,
        ],
    )
    conn.commit()
    row_id = cursor.lastrowid
    conn.close()
    pdca_str = f" [PDCA item#{pdca_item}]" if pdca_item else ""
    print(f"Logged #{row_id}: [{args.status}] {args.agent} → {args.summary}{pdca_str}")
    return row_id


def complete_activity(args):
    conn = get_conn()
    conn.execute(
        "UPDATE activity_log SET status = ?, completed_at = datetime('now','localtime'), "
        "detail = COALESCE(?, detail), verified_by = COALESCE(?, verified_by), "
        "duration_secs = COALESCE(?, duration_secs) WHERE id = ?",
        [args.status, args.detail, args.verified_by, args.duration, args.id],
    )
    conn.commit()
    conn.close()
    print(f"Updated #{args.id}: status={args.status}")


def query_activities(args):
    conn = get_conn()
    where_clauses = []
    params = []

    if args.project:
        where_clauses.append("project = ?")
        params.append(args.project)
    if args.agent:
        where_clauses.append("agent = ?")
        params.append(args.agent)
    if args.type:
        where_clauses.append("activity_type = ?")
        params.append(args.type)
    if args.status:
        where_clauses.append("status = ?")
        params.append(args.status)
    if args.model:
        where_clauses.append("model = ?")
        params.append(args.model)
    if args.pdca_item:
        where_clauses.append("pdca_item_id = ?")
        params.append(args.pdca_item)
    if args.unlinked:
        where_clauses.append("pdca_item_id IS NULL")
    if args.last:
        unit = args.last[-1]
        val = int(args.last[:-1])
        delta = (
            f"-{val} days"
            if unit == "d"
            else f"-{val} hours"
            if unit == "h"
            else f"-{val} minutes"
        )
        where_clauses.append(f"created_at >= datetime('now','localtime','{delta}')")

    where_sql = " AND ".join(where_clauses) if where_clauses else "1=1"
    rows = conn.execute(
        f"SELECT * FROM activity_log WHERE {where_sql} ORDER BY created_at DESC LIMIT ?",
        params + [args.limit],
    ).fetchall()

    if not rows:
        print("No activities found.")
        conn.close()
        return

    for row in rows:
        ts = row["created_at"]
        pdca = (
            f" [PDCA#{row['pdca_item_id']}:{row['pdca_phase']}]"
            if row["pdca_item_id"]
            else ""
        )
        print(
            f"  #{row['id']:04d} [{row['status']:8s}] {row['agent']:20s} → {row['activity_type']}{pdca}"
        )
        print(f"           {row['task_summary']}")
        if row["source_agent"] or row["target_agent"]:
            print(
                f"           {row['source_agent'] or '—'} → {row['target_agent'] or '—'} ({row['delegation_purpose'] or ''})"
            )
        if row["detail"]:
            print(f"           {row['detail'][:120]}")
        if row["files_modified"] and row["files_modified"] != "[]":
            files = json.loads(row["files_modified"])
            print(f"           Files: {', '.join(files[:5])}")
        print(f"           {ts}")

    conn.close()


def show_summary(args):
    conn = get_conn()
    project = args.project or "expresolve"

    print(f"\n{'=' * 70}")
    print(f"  ACTIVITY LOG SUMMARY — Project: {project}")
    print(f"{'=' * 70}\n")

    total = conn.execute(
        "SELECT COUNT(*) FROM activity_log WHERE project = ?", [project]
    ).fetchone()[0]
    print(f"  Total activities: {total}")

    print(f"\n  By Agent:")
    for row in conn.execute(
        "SELECT agent, COUNT(*) as cnt FROM activity_log WHERE project = ? GROUP BY agent ORDER BY cnt DESC",
        [project],
    ):
        print(f"    {row['agent']:25s} {row['cnt']:5d}")

    print(f"\n  By Type:")
    for row in conn.execute(
        "SELECT activity_type, COUNT(*) as cnt FROM activity_log WHERE project = ? GROUP BY activity_type ORDER BY cnt DESC",
        [project],
    ):
        print(f"    {row['activity_type']:25s} {row['cnt']:5d}")

    print(f"\n  By Status:")
    for row in conn.execute(
        "SELECT status, COUNT(*) as cnt FROM activity_log WHERE project = ? GROUP BY status ORDER BY cnt DESC",
        [project],
    ):
        print(f"    {row['status']:25s} {row['cnt']:5d}")

    if total > 0:
        success = conn.execute(
            "SELECT COUNT(*) FROM activity_log WHERE project = ? AND status = 'success'",
            [project],
        ).fetchone()[0]
        print(f"\n  Success Rate: {success}/{total} ({success / total * 100:.1f}%)")

    delegations = conn.execute(
        "SELECT source_agent, target_agent, COUNT(*) as cnt FROM activity_log "
        "WHERE project = ? AND activity_type IN ('delegation_out','delegation_return') "
        "GROUP BY source_agent, target_agent ORDER BY cnt DESC",
        [project],
    ).fetchall()
    if delegations:
        print(f"\n  Delegation Flows:")
        for row in delegations:
            print(
                f"    {row['source_agent']:20s} → {row['target_agent']:20s} ({row['cnt']}x)"
            )

    # PDCA coverage
    pdca_linked = conn.execute(
        "SELECT COUNT(*) FROM activity_log WHERE project = ? AND pdca_item_id IS NOT NULL",
        [project],
    ).fetchone()[0]
    orphan_count = total - pdca_linked
    print(
        f"\n  PDCA Coverage: {pdca_linked}/{total} activities linked to PDCA items ({orphan_count} orphans)"
    )
    if orphan_count > 0:
        print(
            f"    ⚠  {orphan_count} activities have no PDCA link — consider creating PDCA items for them"
        )

    recent = conn.execute(
        "SELECT created_at, agent, activity_type, task_summary, status FROM activity_log "
        "WHERE project = ? ORDER BY created_at DESC LIMIT 5",
        [project],
    ).fetchall()
    if recent:
        print(f"\n  Last 5 Activities:")
        for row in recent:
            pdca_flag = (
                "📋"
                if row["activity_type"] in ("delegation_out", "delegation_return")
                else "⚡"
                if row["activity_type"] == "direct_action"
                else "🔍"
                if row["activity_type"] == "verification"
                else "📝"
            )
            print(
                f"    {pdca_flag} {row['created_at']} {row['agent']:15s} {row['activity_type']:20s} [{row['status']:8s}] {row['task_summary'][:60]}"
            )

    print(f"\n{'=' * 70}")
    conn.close()


def show_orphans(args):
    conn = get_conn()
    project = args.project or "expresolve"

    rows = conn.execute(
        "SELECT * FROM activity_log WHERE project = ? AND pdca_item_id IS NULL ORDER BY created_at DESC",
        [project],
    ).fetchall()

    if not rows:
        print("No orphan activities found. All activities are linked to PDCA items.")
        conn.close()
        return

    print(f"\nOrphan Activities (no PDCA link) — {len(rows)} total\n")
    for row in rows:
        print(
            f"  #{row['id']:04d} [{row['status']:8s}] {row['agent']:20s} → {row['task_summary'][:80]}"
        )
        print(
            f"           {row['created_at']} | {row['activity_type']} | model: {row['model']}"
        )

    print(f"\nTip: Link orphans to PDCA items with:")
    print(
        f"  python3 scripts/activity_logger.py link --activity-id <ID> --pdca-item <ID> [--pdca-phase do]"
    )
    conn.close()


def link_to_pdca(args):
    conn = get_conn()
    conn.execute(
        "UPDATE activity_log SET pdca_item_id = ?, pdca_phase = COALESCE(?, pdca_phase) WHERE id = ?",
        [args.pdca_item, args.pdca_phase, args.activity_id],
    )
    conn.commit()
    conn.close()
    print(f"Linked activity #{args.activity_id} → PDCA item #{args.pdca_item}")


def pdca_coverage(args):
    conn = get_conn()
    project = args.project or "expresolve"

    items = conn.execute(
        "SELECT id, slug, title, status, phase, agent_assigned FROM pdca_items WHERE project_id = ? OR project_dir LIKE ? ORDER BY id DESC",
        [project, f"%{project}%"],
    ).fetchall()

    if not items:
        print(f"No PDCA items found for project '{project}'")
        conn.close()
        return

    print(f"\nPDCA Items with Activity Coverage — Project: {project}\n")
    print(
        f"  {'ID':>4} {'Phase':6} {'Status':12} {'Agent':20} {'Activities':>10} {'Last Activity'}"
    )
    print(f"  {'─' * 4} {'─' * 6} {'─' * 12} {'─' * 20} {'─' * 10} {'─' * 30}")

    for item in items:
        act_count = conn.execute(
            "SELECT COUNT(*) FROM activity_log WHERE pdca_item_id = ?", [item["id"]]
        ).fetchone()[0]
        last_act = conn.execute(
            "SELECT created_at FROM activity_log WHERE pdca_item_id = ? ORDER BY created_at DESC LIMIT 1",
            [item["id"]],
        ).fetchone()
        last_str = last_act["created_at"] if last_act else "—"
        title_short = item["title"][:50] if item["title"] else item["slug"]
        print(
            f"  {item['id']:4} {item['phase']:6} {item['status']:12} {(item['agent_assigned'] or '—'):20} {act_count:10} {last_str}"
        )

    conn.close()


def main():
    parser = argparse.ArgumentParser(
        description="Activity Logger — PDCA-integrated agent activity tracking"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # log
    p_log = sub.add_parser("log", help="Log a new activity")
    p_log.add_argument("--agent", required=True)
    p_log.add_argument("--model", required=True)
    p_log.add_argument("--type", required=True, choices=VALID_TYPES)
    p_log.add_argument("--summary", required=True)
    p_log.add_argument(
        "--status", required=True, choices=VALID_STATUSES, default="success"
    )
    p_log.add_argument("--detail", default=None)
    p_log.add_argument("--files", default="[]", help="JSON array of modified files")
    p_log.add_argument("--source", default=None, help="Source agent for delegations")
    p_log.add_argument("--target", default=None, help="Target agent for delegations")
    p_log.add_argument("--purpose", default=None, help="Delegation purpose")
    p_log.add_argument("--confidence", default=None, choices=VALID_CONFIDENCES)
    p_log.add_argument("--project", default="expresolve")
    p_log.add_argument("--duration", type=float, default=None)
    p_log.add_argument(
        "--pdca-item", type=int, default=None, help="Link to PDCA item ID"
    )
    p_log.add_argument(
        "--pdca-session", type=int, default=None, help="Link to PDCA session ID"
    )
    p_log.add_argument("--pdca-phase", default=None, choices=VALID_PHASES)

    # complete
    p_comp = sub.add_parser("complete", help="Mark an activity as completed")
    p_comp.add_argument("--id", required=True, type=int)
    p_comp.add_argument("--status", required=True, choices=VALID_STATUSES)
    p_comp.add_argument("--detail", default=None)
    p_comp.add_argument("--verified-by", default=None)
    p_comp.add_argument("--duration", type=float, default=None)

    # query
    p_query = sub.add_parser("query", help="Query activities with filters")
    p_query.add_argument("--project", default=None)
    p_query.add_argument("--agent", default=None)
    p_query.add_argument("--type", default=None, choices=VALID_TYPES)
    p_query.add_argument("--status", default=None, choices=VALID_STATUSES)
    p_query.add_argument("--model", default=None)
    p_query.add_argument("--pdca-item", type=int, default=None)
    p_query.add_argument(
        "--unlinked", action="store_true", help="Only activities with no PDCA link"
    )
    p_query.add_argument("--last", default=None, help="Time window: 7d, 24h, 30m")
    p_query.add_argument("--limit", type=int, default=20)

    # summary
    p_sum = sub.add_parser("summary", help="Show project summary")
    p_sum.add_argument("--project", default="expresolve")

    # orphans
    p_orphans = sub.add_parser("orphans", help="Show activities without PDCA links")
    p_orphans.add_argument("--project", default="expresolve")

    # link
    p_link = sub.add_parser("link", help="Link an activity to a PDCA item")
    p_link.add_argument("--activity-id", required=True, type=int)
    p_link.add_argument("--pdca-item", required=True, type=int)
    p_link.add_argument("--pdca-phase", default=None, choices=VALID_PHASES)

    # pdca-coverage
    p_cov = sub.add_parser(
        "pdca-coverage", help="Show PDCA items with their activity coverage"
    )
    p_cov.add_argument("--project", default="expresolve")

    # recent
    p_recent = sub.add_parser("recent", help="Show last N activities")
    p_recent.add_argument("--limit", type=int, default=10)

    args = parser.parse_args()

    if args.command == "log":
        log_activity(args)
    elif args.command == "complete":
        complete_activity(args)
    elif args.command == "query":
        query_activities(args)
    elif args.command == "summary":
        show_summary(args)
    elif args.command == "orphans":
        show_orphans(args)
    elif args.command == "link":
        link_to_pdca(args)
    elif args.command == "pdca-coverage":
        pdca_coverage(args)
    elif args.command == "recent":
        args.project = None
        args.agent = None
        args.type = None
        args.status = None
        args.model = None
        args.pdca_item = None
        args.unlinked = False
        args.last = None
        query_activities(args)


if __name__ == "__main__":
    main()
