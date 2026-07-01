---
name: decision-clock
description: Tracks every OPEN gate the fleet is waiting on (rotate-a-secret, a Matt-only gate, a pending review, a security finding) with an owner and an expected-by SLA, so nothing quietly ages past its deadline. One doc per gate in the decisions_pending Cosmos container (same agent-state account the gateway's task plane uses). A daily Tier-1 sweep computes overdue/near-due items and sends ONE batched per-owner nudge via fleet-dispatch (never one-per-item spam), reusing the fleet-medic cooldown/escalate discipline. Non-PHI; INND-gated rows are CFO/CLO-visible only. Use to open a gate (`decision.mjs open --category ... --owner ... --expected-by ...`), list what is open/overdue, or ack/close a gate once resolved.
---

# decision-clock — a clock on every open gate

Answers "what are we waiting on, from whom, and is it late" without anyone having to remember to
check. One document per open gate lives in the `decisions_pending` Cosmos container (partition key
`/owner`), a sibling of the fleet's existing agent-state containers (`tasks`, `memory`, `events`,
`oauthcodes`, `cache`, `turns`) in the same Cosmos account `cosmos-otc-agentstate-55c84` / db
`agent-state` that the gateway's task plane already uses.

## Use
```
node skills/decision-clock/decision.mjs open --category rotate-secret --owner cto \
  --expected-by 2026-08-01 --evidence "https://..." --text "Rotate the github-app private key"

node skills/decision-clock/decision.mjs list [--owner cto] [--overdue] [--json]
node skills/decision-clock/decision.mjs ack   <id> --owner cto
node skills/decision-clock/decision.mjs close <id> --owner cto
node skills/decision-clock/decision.mjs sweep [--dispatch] [--json]   # the daily job entrypoint
```
`--category` picks a default SLA if `--expected-by` is omitted: `rotate-secret` 14d, `matt-gate` 3d,
`review` 7d, `security-finding` 5d, else 7d (`DEFAULT_SLA_DAYS` in `decision.mjs`).

Pass `--innd` on `open` to flag a row as INND/MNPI-gated (CFO/CLO visibility only by convention; the
sweep only ever nudges the row's own owner, never a cross-owner listing).

## What the sweep does
`sweep --dispatch` (the Container Apps Job entrypoint, `job/decision-clock-sweep.sh`) queries every
open row, classifies it overdue / near-due (default: due within 2 days) / open, groups by owner, and
sends **one** fleet-dispatch message per owner listing every item that needs attention (never a
separate dispatch per row). This reuses the exact cooldown/escalate discipline fleet-medic pioneered
so a stuck gate cannot spam an owner's inbox every run; run cadence itself is the throttle (daily).

## Where it runs
`job/decision-clock-sweep.sh` mirrors the doc-indexer job scripts (`nightly.sh`, `librarian.sh`): one
secret (`GCP_CLAUDE_DRIVER_SA_JSON`), resolves every other credential (Cosmos, the fleet-dispatch
commons blob) from Secret Manager. `job/decision-clock-job.md` has the `az containerapp job create`
copy-paste to add it alongside the existing jobs on `otchealth-jobs-env` / `otchealth-automation-rg`.

## Data model
```
{ id, owner, category, text, opened_at, expected_by, status: open|ack|closed,
  evidence_link, innd?: true }
```
Append-only in spirit: `close` sets `status:"closed"` + `closed_at` rather than deleting, so a closed
gate stays as an audit record (queryable, just excluded from `sweep`/default overdue views).

## Non-goals (this PR ships the minimal version)
Auto-opening rows from ROTATE-BEFORE-LAUNCH lists or fleet-medic conditions is a documented follow-up,
not wired here; today every row is opened explicitly via `decision.mjs open`.

## Ring safety
Non-PHI. INND/MNPI-flagged rows (`--innd`) are a convention for CFO/CLO-only visibility; do not
`--include-personal`-style widen this without a legal-firewall review. Never store secret VALUES here,
only an `evidence_link` pointer.
