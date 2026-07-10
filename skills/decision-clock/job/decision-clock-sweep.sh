#!/bin/sh
# decision-clock Container Apps Job entrypoint (Tier-1, cron daily): compute overdue/near-due gates and
# fleet-dispatch one batched per-owner nudge. Mirrors doc-indexer/job/nightly.sh's shape: one secret
# (the claude-driver SA), everything else self-resolves from Secret Manager.
set -e
[ -n "$GCP_CLAUDE_DRIVER_SA_JSON_B64" ] && export GCP_CLAUDE_DRIVER_SA_JSON=$(printf "%s" "$GCP_CLAUDE_DRIVER_SA_JSON_B64" | base64 -d)
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
echo "[decision-clock] $(date -u +%FT%TZ) sweeping decisions_pending"
node "$ROOT/skills/decision-clock/decision.mjs" sweep --dispatch
echo "[decision-clock] sweep complete"
