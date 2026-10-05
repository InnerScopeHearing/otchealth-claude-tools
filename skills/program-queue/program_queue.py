#!/usr/bin/env python3
"""Pure-offline variable-length work queue planner and fenced state updater.

This module is a local contract/helper only. It is not a lease, daemon, live
CAS implementation, or provider integration.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

DISPOSITIONS = {"queued", "completed", "deferred", "source_owner_blocked"}


class QueueError(ValueError):
    """Fail-closed queue validation or update error."""


def _parse_time(value: Any, context: str) -> datetime:
    if not isinstance(value, str):
        raise QueueError(f"{context}: expected ISO-8601 UTC timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise QueueError(f"{context}: invalid timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise QueueError(f"{context}: timestamp must include timezone")
    return parsed.astimezone(timezone.utc)


def _nonempty_string(value: Any, context: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise QueueError(f"{context}: must be a non-empty string")
    return value.strip()


def _positive_minutes(value: Any, context: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value <= 0:
        raise QueueError(f"{context}: must be a positive finite number of minutes")
    return float(value)


def validate_state(state: Any) -> dict[str, Any]:
    if not isinstance(state, dict):
        raise QueueError("state must be a JSON object")
    if state.get("schema_version") != 1:
        raise QueueError("schema_version must equal 1")
    _nonempty_string(state.get("run_id"), "run_id")
    _parse_time(state.get("hard_stop_utc"), "hard_stop_utc")
    if state.get("planned_stage_minutes") is not None:
        _positive_minutes(state["planned_stage_minutes"], "planned_stage_minutes")
    runtime = state.get("run_state")
    if not isinstance(runtime, dict):
        raise QueueError("run_state must be an object")
    _nonempty_string(runtime.get("owner_instance"), "run_state.owner_instance")
    fence = runtime.get("fencing_version")
    if not isinstance(fence, int) or isinstance(fence, bool) or fence < 0:
        raise QueueError("run_state.fencing_version must be a non-negative integer")
    if not isinstance(runtime.get("owner_terminal"), bool):
        raise QueueError("run_state.owner_terminal must be boolean")
    tasks = state.get("tasks")
    if not isinstance(tasks, list):
        raise QueueError("tasks must be a list")
    ids: list[str] = []
    by_id: dict[str, dict[str, Any]] = {}
    for i, task in enumerate(tasks):
        ctx = f"tasks[{i}]"
        if not isinstance(task, dict):
            raise QueueError(f"{ctx} must be an object")
        task_id = _nonempty_string(task.get("id"), f"{ctx}.id")
        if task_id in by_id:
            raise QueueError(f"duplicate task id: {task_id}")
        ids.append(task_id)
        by_id[task_id] = task
        if not isinstance(task.get("build_order"), int) or isinstance(task.get("build_order"), bool):
            raise QueueError(f"{task_id}.build_order must be an integer")
        if not isinstance(task.get("original_rank"), int) or isinstance(task.get("original_rank"), bool):
            raise QueueError(f"{task_id}.original_rank must be an integer")
        _nonempty_string(task.get("classification"), f"{task_id}.classification")
        if task.get("disposition") not in DISPOSITIONS:
            raise QueueError(f"{task_id}.disposition must be one of {sorted(DISPOSITIONS)}")
        _nonempty_string(task.get("original_owner"), f"{task_id}.original_owner")
        _nonempty_string(task.get("original_acceptance"), f"{task_id}.original_acceptance")
        deps = task.get("dependencies")
        if not isinstance(deps, list) or any(not isinstance(dep, str) or not dep.strip() for dep in deps):
            raise QueueError(f"{task_id}.dependencies must be a list of non-empty IDs")
        if len(set(deps)) != len(deps):
            raise QueueError(f"{task_id}.dependencies contains duplicates")
        if task.get("attempts") is None:
            task["attempts"] = []
        if not isinstance(task["attempts"], list):
            raise QueueError(f"{task_id}.attempts must be a list")
        if task.get("history") is None:
            task["history"] = []
        if not isinstance(task["history"], list):
            raise QueueError(f"{task_id}.history must be a list")
        if not isinstance(task.get("expired_to_tail", False), bool):
            raise QueueError(f"{task_id}.expired_to_tail must be boolean")
        if task.get("stage_deadline_utc") is not None:
            _parse_time(task["stage_deadline_utc"], f"{task_id}.stage_deadline_utc")
        if task.get("implementation_minutes") is not None:
            _positive_minutes(task["implementation_minutes"], f"{task_id}.implementation_minutes")
        exceptions = task.get("dependency_exceptions", {})
        if not isinstance(exceptions, dict):
            raise QueueError(f"{task_id}.dependency_exceptions must be an object")
        for dep_id, exception in exceptions.items():
            if dep_id not in deps:
                raise QueueError(f"{task_id}: exception references non-dependency {dep_id}")
            if not isinstance(exception, dict):
                raise QueueError(f"{task_id}: exception for {dep_id} must be an object")
            if "approved" in exception and not isinstance(exception["approved"], bool):
                raise QueueError(f"{task_id}.{dep_id}.approved must be boolean")
            if exception.get("approved") is True:
                _nonempty_string(exception.get("bounded_scope"), f"{task_id}.{dep_id}.bounded_scope")
                _nonempty_string(exception.get("evidence"), f"{task_id}.{dep_id}.evidence")
    if len(ids) != len(set(ids)):
        raise QueueError("task IDs must be unique")
    for task_id, task in by_id.items():
        for dep in task["dependencies"]:
            if dep not in by_id:
                raise QueueError(f"{task_id}: missing dependency {dep}")
    _validate_acyclic(by_id)
    unknown_writes = state.get("unknown_writes", [])
    if not isinstance(unknown_writes, list):
        raise QueueError("unknown_writes must be a list")
    for item in unknown_writes:
        if not isinstance(item, dict):
            raise QueueError("unknown_writes entries must be objects")
        # Missing/malformed target is valid input and deliberately global-freezes.
        target = item.get("target_id")
        if target is not None and not isinstance(target, str):
            raise QueueError("unknown_writes.target_id must be a string when present")
    return state


def _validate_acyclic(by_id: dict[str, dict[str, Any]]) -> None:
    colors: dict[str, int] = {}
    stack: list[str] = []

    def visit(node: str) -> None:
        color = colors.get(node, 0)
        if color == 1:
            start = stack.index(node)
            raise QueueError("dependency cycle: " + " -> ".join(stack[start:] + [node]))
        if color == 2:
            return
        colors[node] = 1
        stack.append(node)
        for dep in by_id[node]["dependencies"]:
            visit(dep)
        stack.pop()
        colors[node] = 2

    for task_id in by_id:
        visit(task_id)


def _write_freeze(state: dict[str, Any]) -> tuple[set[str], bool, list[str]]:
    task_ids = {task["id"] for task in state["tasks"]}
    frozen: set[str] = set()
    global_freeze = False
    blockers: list[str] = []
    for entry in state.get("unknown_writes", []):
        target = entry.get("target_id")
        if not target or target not in task_ids:
            global_freeze = True
            blockers.append(f"unknown write target {target!r}; all new starts frozen")
        else:
            frozen.add(target)
            blockers.append(f"unknown write for {target}; target frozen pending reconciliation")
    return frozen, global_freeze, blockers


def _expiry_timestamp(task: dict[str, Any]) -> str:
    for event in reversed(task.get("history", [])):
        if isinstance(event, dict) and event.get("event") == "blocker_expired_to_tail":
            return str(event.get("at_utc", ""))
    return ""


def plan(state: Any, now_utc: str) -> dict[str, Any]:
    """Validate and return next strict dependency-ready stage without side effects."""
    safe = validate_state(deepcopy(state))
    now = _parse_time(now_utc, "now_utc")
    hard_stop = _parse_time(safe["hard_stop_utc"], "hard_stop_utc")
    tasks = safe["tasks"]
    by_id = {task["id"]: task for task in tasks}
    frozen, global_freeze, write_blockers = _write_freeze(safe)
    at_stop = now >= hard_stop
    blockers: list[dict[str, Any]] = []
    ready: list[dict[str, Any]] = []
    for task in tasks:
        tid = task["id"]
        reasons: list[str] = []
        disp = task["disposition"]
        if disp != "queued":
            reasons.append(f"disposition={disp}")
        stage_deadline = task.get("stage_deadline_utc")
        if disp == "queued" and stage_deadline and now >= _parse_time(stage_deadline, f"{tid}.stage_deadline_utc"):
            reasons.append("stage deadline expired; no new start")
        if task.get("expired_to_tail"):
            reasons.append("expired blocker moved to absolute tail; await owner-terminal handoff")
        if tid in frozen:
            reasons.append("unknown write freezes this exact target")
        if global_freeze:
            reasons.append("unscoped/missing-target unknown write freezes all new starts")
        if at_stop:
            reasons.append("hard stop reached; no new starts")
        task_exceptions = task.get("dependency_exceptions", {})
        for dep_id in task["dependencies"]:
            dep = by_id[dep_id]
            if dep["disposition"] == "completed":
                continue
            exception = task_exceptions.get(dep_id, {})
            if exception.get("approved") is True and exception.get("bounded_scope") and exception.get("evidence"):
                continue
            reasons.append(f"dependency {dep_id} not completed")
        if reasons:
            blockers.append({"id": tid, "reasons": reasons})
        else:
            ready.append(task)
    ready.sort(key=lambda t: (t["build_order"], t["id"]))
    first_order = ready[0]["build_order"] if ready else None
    next_stage = [t for t in ready if t["build_order"] == first_order] if ready else []
    if safe.get("planned_stage_minutes") is not None:
        stage_minutes = _positive_minutes(safe["planned_stage_minutes"], "planned_stage_minutes")
    elif next_stage:
        # Missing task estimates receive a conservative 20-minute default.
        stage_minutes = sum(_positive_minutes(t.get("implementation_minutes", 20),
                                               f"{t['id']}.implementation_minutes") for t in next_stage)
    else:
        stage_minutes = 20.0
    stage_finish = now + timedelta(minutes=stage_minutes)
    hard_stop_fit = bool(next_stage) and stage_finish <= hard_stop
    task_deadline_fit = bool(next_stage) and all(
        not t.get("stage_deadline_utc") or stage_finish <= _parse_time(t["stage_deadline_utc"], f"{t['id']}.stage_deadline_utc")
        for t in next_stage
    )
    stage_fits = not next_stage or (hard_stop_fit and task_deadline_fit)
    if next_stage and not stage_fits:
        for task in next_stage:
            reasons = []
            if not hard_stop_fit:
                reasons.append(f"estimated {stage_minutes:g}-minute stage would cross hard stop")
            if not task_deadline_fit:
                reasons.append(f"estimated {stage_minutes:g}-minute stage would cross task stage deadline")
            blockers.append({"id": task["id"], "reasons": reasons})
        next_stage = []
    ready_ids = {t["id"] for t in next_stage}
    blocker_by_id = {b["id"]: b["reasons"] for b in blockers}
    active_rows = sorted((t for t in tasks if not t.get("expired_to_tail")),
                         key=lambda t: (t["build_order"], t["original_rank"], t["id"]))
    expired_rows = sorted((t for t in tasks if t.get("expired_to_tail")),
                          key=lambda t: (_expiry_timestamp(t), t["original_rank"], t["id"]))
    for position, task in enumerate(active_rows + expired_rows, start=1):
        task["queue_position"] = position
    full_rows = active_rows + expired_rows
    remaining = sum(1 for t in tasks if t["disposition"] == "queued")
    return {
        "schema_version": 1,
        "run_id": safe["run_id"],
        "now_utc": now.isoformat().replace("+00:00", "Z"),
        "hard_stop_utc": hard_stop.isoformat().replace("+00:00", "Z"),
        "new_starts_blocked": at_stop or global_freeze or (bool(ready) and not stage_fits),
        "estimated_stage_minutes": stage_minutes,
        "stage_fits_deadline": stage_fits,
        "global_unknown_write_freeze": global_freeze,
        "frozen_targets": sorted(frozen),
        "next_ready_stage": [deepcopy(t) for t in next_stage],
        "next_ready_build_order": first_order,
        "full_rows": full_rows,
        "blockers": blockers,
        "global_blockers": write_blockers + (["hard stop reached; no new starts"] if at_stop else []) + (["next ready stage cannot finish before its deadline"] if ready and not stage_fits else []),
        "remaining_count": remaining,
        "owner": deepcopy(safe["run_state"]),
        "handoff_allowed": safe["run_state"]["owner_terminal"] is True,
        "notice": "Offline planning only; no live CAS, lease, daemon, or provider guarantee."
    }


def expire_blocker(state: Any, task_id: str, *, owner_instance: str, fencing_version: int,
                   now_utc: str, reason: str) -> dict[str, Any]:
    """Record one expiry and move that exact task to the absolute tail once."""
    safe = validate_state(deepcopy(state))
    _check_writer(safe, owner_instance, fencing_version)
    now = _parse_time(now_utc, "now_utc")
    _nonempty_string(reason, "reason")
    by_id = {task["id"]: task for task in safe["tasks"]}
    if task_id not in by_id:
        raise QueueError(f"unknown task id: {task_id}")
    task = by_id[task_id]
    if task.get("expired_to_tail"):
        return safe
    deadline_value = task.get("stage_deadline_utc")
    if deadline_value is None:
        raise QueueError(f"{task_id}: stage_deadline_utc required before expiry can be recorded")
    if now < _parse_time(deadline_value, f"{task_id}.stage_deadline_utc"):
        raise QueueError(f"{task_id}: stage deadline has not expired")
    task["expired_to_tail"] = True
    task["history"].append({"event":"blocker_expired_to_tail", "at_utc": now.isoformat().replace("+00:00", "Z"), "reason": reason,
                             "original_rank": task["original_rank"], "attempts_preserved": len(task["attempts"])})
    return safe


def _check_writer(state: dict[str, Any], owner_instance: str, fencing_version: int) -> None:
    runtime = state["run_state"]
    if owner_instance != runtime["owner_instance"] or fencing_version != runtime["fencing_version"]:
        raise QueueError("stale owner/fencing version; update rejected")
    if runtime["owner_terminal"]:
        raise QueueError("owner is terminal; no further updates permitted")


def apply_updates(state: Any, updates: list[dict[str, Any]], *, owner_instance: str,
                  fencing_version: int) -> dict[str, Any]:
    """Apply local JSON state updates only for the exact current writer fence."""
    safe = validate_state(deepcopy(state))
    _check_writer(safe, owner_instance, fencing_version)
    if not isinstance(updates, list):
        raise QueueError("updates must be a list")
    by_id = {task["id"]: task for task in safe["tasks"]}
    for update in updates:
        if not isinstance(update, dict):
            raise QueueError("each update must be an object")
        tid = _nonempty_string(update.get("task_id"), "update.task_id")
        if tid not in by_id:
            raise QueueError(f"unknown task id: {tid}")
        task = by_id[tid]
        if "disposition" in update:
            new_disp = update["disposition"]
            if new_disp not in DISPOSITIONS:
                raise QueueError(f"{tid}: invalid disposition")
            if task["disposition"] == "completed" and new_disp != "completed":
                raise QueueError(f"{tid}: completed tasks cannot be replayed or reopened")
            task["disposition"] = new_disp
        if "attempt" in update:
            attempt = update["attempt"]
            if not isinstance(attempt, dict):
                raise QueueError(f"{tid}.attempt must be an object")
            task["attempts"].append(deepcopy(attempt))
        if "history_event" in update:
            task["history"].append(deepcopy(update["history_event"]))
    validate_state(safe)
    return safe


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise QueueError(f"cannot read valid JSON: {exc}") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("state", type=Path, help="local JSON queue state")
    parser.add_argument("--now", required=True, help="current ISO-8601 timestamp")
    parser.add_argument("--output", type=Path, help="write plan JSON; stdout when omitted")
    args = parser.parse_args(argv)
    try:
        if args.output and args.output.resolve() == args.state.resolve():
            raise QueueError("output must differ from the input queue state")
        result = plan(load_json(args.state), args.now)
    except QueueError as exc:
        print(json.dumps({"error": str(exc), "fail_closed": True}), file=sys.stderr)
        return 2
    rendered = json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
    else:
        sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
