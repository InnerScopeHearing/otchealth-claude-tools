# On-demand program queue CLI

Plan the next dependency-ready stage from a local queue of any length, including
the expanded 88-item program. Requires Python 3.10+ and no packages or credentials.

From the toolkit checkout:

```sh
python3 skills/program-queue/program_queue.py state.json --now 2026-10-05T16:00:00Z
```

The existing session-start installer copies this bundle into the same fleet
distribution. After installation, use:

```sh
python3 ~/.claude/skills/program-queue/program_queue.py state.json --now 2026-10-05T16:00:00Z
```

Print the plan to stdout by default; `--output plan.json` writes only that local
report and rejects the input-state path. Preserve original owner, acceptance,
rank, attempt receipts and history. Completed items stay completed; previously
expired blockers stay at the absolute tail. Use the queue's explicit deadline
and estimates to select the next stage. A past deadline produces no new starts.

Input schema: `schema_version: 1`, nonempty `run_id`, zoned `hard_stop_utc`,
`run_state: {owner_instance, fencing_version, owner_terminal}`, and `tasks`.
Each task has `id`, integer `build_order`/`original_rank`, `classification`,
`disposition` (`queued`, `completed`, `deferred`, `source_owner_blocked`),
`original_owner`, `original_acceptance`, and a `dependencies` list of task IDs.
Optional `attempts` and `history` are preserved. Unknown writes freeze their
exact target, or all starts when the target is unknown.

Run checks with `python3 -m unittest discover -s skills/program-queue -v`.
This CLI plans once and exits. It does not execute tasks, contact providers,
start a background loop, change ownership, or write a shared ledger.
