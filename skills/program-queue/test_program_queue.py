"""Synthetic contract tests for variable-length offline program queue."""
import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import program_queue as q


NOW = "2026-10-05T07:10:00Z"


def task(task_id, order, *, deps=None, disposition="queued", classification="business", rank=None):
    return {
        "id": task_id,
        "classification": classification,
        "disposition": disposition,
        "build_order": order,
        "original_rank": order if rank is None else rank,
        "original_owner": f"owner-{task_id}",
        "original_acceptance": f"accept-{task_id}",
        "dependencies": deps or [],
        "attempts": [{"attempt": 1, "receipt": f"receipt-{task_id}"}],
        "history": [{"event": "created"}],
    }


def state(tasks, **extra):
    data = {
        "schema_version": 1,
        "run_id": "SYNTHETIC-QUEUE",
        "hard_stop_utc": "2026-10-05T08:00:00Z",
        "run_state": {"owner_instance": "worker-a", "fencing_version": 4, "owner_terminal": False},
        "tasks": tasks,
        "unknown_writes": [],
    }
    data.update(extra)
    return data


class ProgramQueueTests(unittest.TestCase):
    def test_dynamic_ids_and_classification_are_independent_of_disposition(self):
        s = state([task("BUS-901", 20, classification="growth"), task("OPS-new", 10, classification="ops")])
        p = q.plan(s, NOW)
        self.assertEqual([t["id"] for t in p["next_ready_stage"]], ["OPS-new"])
        self.assertEqual(p["next_ready_build_order"], 10)
        self.assertEqual(p["remaining_count"], 2)

    def test_strict_dependencies_and_completed_not_replayed(self):
        s = state([task("A", 1, disposition="completed"), task("B", 2, deps=["A"]), task("C", 3, deps=["B"])])
        p = q.plan(s, NOW)
        self.assertEqual([t["id"] for t in p["next_ready_stage"]], ["B"])
        self.assertNotIn("A", [t["id"] for t in p["next_ready_stage"]])
        self.assertEqual(p["remaining_count"], 2)

    def test_missing_dependency_fails_closed(self):
        with self.assertRaisesRegex(q.QueueError, "missing dependency"):
            q.plan(state([task("A", 1, deps=["does-not-exist"])]), NOW)

    def test_cycle_fails_closed(self):
        with self.assertRaisesRegex(q.QueueError, "dependency cycle"):
            q.plan(state([task("A", 1, deps=["B"]), task("B", 2, deps=["A"])]), NOW)

    def test_explicit_bounded_scope_exception_requires_named_evidence(self):
        s = state([task("A", 1, disposition="source_owner_blocked"), task("B", 2, deps=["A"])])
        with self.assertRaisesRegex(q.QueueError, "bounded_scope"):
            q.plan({**s, "tasks": [s["tasks"][0], {**s["tasks"][1], "dependency_exceptions": {"A": {"approved": True}}}]}, NOW)
        s["tasks"][1]["dependency_exceptions"] = {"A": {"approved": True, "bounded_scope": "synthetic-only", "evidence": "fixture:case-7"}}
        self.assertEqual([t["id"] for t in q.plan(s, NOW)["next_ready_stage"]], ["B"])

    def test_unknown_write_freezes_exact_target_only(self):
        s = state([task("A", 1), task("B", 2)], unknown_writes=[{"target_id": "A"}])
        p = q.plan(s, NOW)
        self.assertEqual(p["frozen_targets"], ["A"])
        self.assertEqual([t["id"] for t in p["next_ready_stage"]], ["B"])
        self.assertFalse(p["global_unknown_write_freeze"])

    def test_missing_unknown_write_target_freezes_all_new_starts(self):
        s = state([task("A", 1), task("B", 2)], unknown_writes=[{"scope": "unknown"}])
        p = q.plan(s, NOW)
        self.assertTrue(p["global_unknown_write_freeze"])
        self.assertEqual(p["next_ready_stage"], [])

    def test_stale_owner_or_fence_cannot_update_and_no_expiry_takeover(self):
        s = state([task("A", 1)])
        with self.assertRaisesRegex(q.QueueError, "stale owner/fencing"):
            q.apply_updates(s, [{"task_id":"A", "disposition":"completed"}], owner_instance="worker-old", fencing_version=4)
        with self.assertRaisesRegex(q.QueueError, "stale owner/fencing"):
            q.apply_updates(s, [], owner_instance="worker-a", fencing_version=3)
        p = q.plan(s, NOW)
        self.assertFalse(p["handoff_allowed"])
        self.assertNotIn("takeover", str(p).lower())

    def test_owner_terminal_is_required_for_handoff_and_blocks_updates(self):
        s = state([task("A", 1)])
        s["run_state"]["owner_terminal"] = True
        self.assertTrue(q.plan(s, NOW)["handoff_allowed"])
        with self.assertRaisesRegex(q.QueueError, "owner is terminal"):
            q.apply_updates(s, [], owner_instance="worker-a", fencing_version=4)

    def test_completed_task_cannot_be_reopened(self):
        s = state([task("A", 1, disposition="completed")])
        with self.assertRaisesRegex(q.QueueError, "cannot be replayed"):
            q.apply_updates(s, [{"task_id":"A", "disposition":"queued"}], owner_instance="worker-a", fencing_version=4)

    def test_unknown_target_id_is_rejected_on_update(self):
        s = state([task("A", 1)])
        with self.assertRaisesRegex(q.QueueError, "unknown task id"):
            q.apply_updates(s, [{"task_id":"missing", "disposition":"completed"}], owner_instance="worker-a", fencing_version=4)

    def test_expiry_moves_exact_row_to_tail_once_and_preserves_history_attempts_rank(self):
        s = state([task("A", 1), task("B", 2), task("C", 3)])
        s["tasks"][0]["stage_deadline_utc"] = "2026-10-05T07:09:00Z"
        before = copy.deepcopy(s["tasks"][0])
        once = q.expire_blocker(s, "A", owner_instance="worker-a", fencing_version=4, now_utc=NOW, reason="source receipt did not arrive")
        twice = q.expire_blocker(once, "A", owner_instance="worker-a", fencing_version=4, now_utc=NOW, reason="duplicate expiry")
        self.assertEqual(once["tasks"][0]["build_order"], before["build_order"])
        self.assertEqual(once["tasks"][0]["original_rank"], before["original_rank"])
        self.assertEqual(once["tasks"][0]["attempts"], before["attempts"])
        self.assertEqual(len(once["tasks"][0]["history"]), len(before["history"]) + 1)
        self.assertEqual(twice, once)
        planned = q.plan(once, NOW)
        self.assertEqual(planned["full_rows"][-1]["id"], "A")
        self.assertIn("expired blocker moved", " ".join(planned["blockers"][0]["reasons"]))

    def test_cannot_expire_a_blocker_before_its_stage_deadline(self):
        a = task("A", 1)
        a["stage_deadline_utc"] = "2026-10-05T07:09:00Z"
        s = state([a])
        with self.assertRaisesRegex(q.QueueError, "has not expired"):
            q.expire_blocker(s, "A", owner_instance="worker-a", fencing_version=4,
                             now_utc="2026-10-05T07:08:59Z", reason="too early")

    def test_empty_ready_queue_reports_blockers_and_remaining(self):
        s = state([task("A", 1, disposition="deferred"), task("B", 2, deps=["A"])])
        p = q.plan(s, NOW)
        self.assertEqual(p["next_ready_stage"], [])
        self.assertEqual(p["remaining_count"], 1)
        self.assertEqual({b["id"] for b in p["blockers"]}, {"A", "B"})

    def test_explicit_hard_stop_blocks_new_starts(self):
        s = state([task("A", 1)], hard_stop_utc="2026-10-05T07:10:00Z")
        p = q.plan(s, NOW)
        self.assertTrue(p["new_starts_blocked"])
        self.assertEqual(p["next_ready_stage"], [])

    def test_stage_that_exactly_fits_hard_stop_may_start(self):
        a = task("A", 1, classification="engineering")
        a["stage_deadline_utc"] = "2026-10-05T14:53:00Z"
        s = state([a], hard_stop_utc="2026-10-05T14:52:40Z", planned_stage_minutes=20)
        p = q.plan(s, "2026-10-05T14:32:40Z")
        self.assertEqual([t["id"] for t in p["next_ready_stage"]], ["A"])
        self.assertTrue(p["stage_fits_deadline"])

    def test_stage_one_second_too_late_does_not_start(self):
        a = task("A", 1)
        a["stage_deadline_utc"] = "2026-10-05T14:53:00Z"
        s = state([a], hard_stop_utc="2026-10-05T14:52:40Z", planned_stage_minutes=20)
        p = q.plan(s, "2026-10-05T14:32:41Z")
        self.assertEqual(p["next_ready_stage"], [])
        self.assertTrue(p["new_starts_blocked"])
        self.assertIn("cross hard stop", " ".join(p["blockers"][0]["reasons"]))

    def test_145239_cannot_start_default_20_minute_stage(self):
        s = state([task("A", 1)], hard_stop_utc="2026-10-05T14:52:40Z")
        p = q.plan(s, "2026-10-05T14:52:39Z")
        self.assertEqual(p["estimated_stage_minutes"], 20)
        self.assertEqual(p["next_ready_stage"], [])
        self.assertTrue(p["new_starts_blocked"])

    def test_expired_queued_stage_deadline_blocks_start(self):
        a = task("A", 1)
        a["stage_deadline_utc"] = "2026-10-05T07:09:59Z"
        p = q.plan(state([a], hard_stop_utc="2026-10-05T08:00:00Z"), NOW)
        self.assertEqual(p["next_ready_stage"], [])
        self.assertIn("stage deadline expired", " ".join(p["blockers"][0]["reasons"]))

    def test_task_implementation_bound_controls_hard_stop_fit(self):
        a = task("A", 1)
        a["implementation_minutes"] = 10
        s = state([a], hard_stop_utc="2026-10-05T14:52:40Z")
        fits = q.plan(s, "2026-10-05T14:42:40Z")
        too_late = q.plan(s, "2026-10-05T14:42:41Z")
        self.assertEqual([t["id"] for t in fits["next_ready_stage"]], ["A"])
        self.assertEqual(too_late["next_ready_stage"], [])

    def test_invalid_stage_cap_fails_closed(self):
        for invalid in [0, -1, float("nan"), "20"]:
            with self.subTest(invalid=invalid):
                with self.assertRaisesRegex(q.QueueError, "positive finite number"):
                    q.plan(state([task("A", 1)], planned_stage_minutes=invalid), NOW)
                a = task("A", 1)
                a["implementation_minutes"] = invalid
                with self.assertRaisesRegex(q.QueueError, "positive finite number"):
                    q.plan(state([a]), NOW)

    def test_requested_145240_utc_deadline_blocks_new_starts(self):
        s = state([task("A", 1)], hard_stop_utc="2026-10-05T14:52:40Z")
        p = q.plan(s, "2026-10-05T14:52:40Z")
        self.assertTrue(p["new_starts_blocked"])
        self.assertEqual(p["next_ready_stage"], [])

    def test_input_is_not_mutated_by_planning(self):
        s = state([task("A", 1)])
        before = copy.deepcopy(s)
        q.plan(s, NOW)
        self.assertEqual(s, before)

    def test_cli_rejects_input_as_output_and_preserves_original_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            original = json.dumps(state([task("A", 1)]))
            path.write_text(original)
            result = subprocess.run([sys.executable, q.__file__, str(path), "--now", NOW,
                                     "--output", str(path)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn("output must differ", result.stderr)
            self.assertEqual(path.read_text(), original)

    def test_cli_handles_88_rows_and_preserves_owner_criteria_history_and_tail(self):
        tasks = [task(f"ITEM-{i:03d}", i) for i in range(88)]
        tasks[0]["expired_to_tail"] = True
        tasks[0]["history"].append({"event": "blocker_expired_to_tail", "at_utc": NOW})
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            original = json.dumps(state(tasks))
            path.write_text(original)
            result = subprocess.run([sys.executable, q.__file__, str(path), "--now", NOW],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads(result.stdout)
            self.assertEqual(len(plan["full_rows"]), 88)
            self.assertEqual(plan["next_ready_stage"][0]["id"], "ITEM-001")
            self.assertEqual(plan["full_rows"][-1]["id"], "ITEM-000")
            by_id = {row["id"]: row for row in plan["full_rows"]}
            for row in tasks:
                for key in ("original_owner", "original_acceptance", "original_rank", "history", "attempts"):
                    self.assertEqual(by_id[row["id"]][key], row[key])
            self.assertEqual(path.read_text(), original)


if __name__ == "__main__":
    unittest.main()
