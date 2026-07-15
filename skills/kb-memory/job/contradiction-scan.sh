#!/bin/sh
# contradiction-scan (Container Apps Job, scheduled nightly, e.g. cron 45 2 * * *): scans the shared
# exec feed (Blob) plus the Cosmos memory store for cross-agent contradictions and opens ONE
# decision-clock proposal per contested claim. Phase-4 B2 (the self-maintaining brain). NEVER
# auto-resolves a contradiction; every action is a proposal a human/agent later confirms or corrects.
# One secret: the claude-driver SA (or Key Vault via managed identity) self-resolves every Azure key.
# Dry-run by default -- pass --commit as a job arg to actually open proposals. Always exits 0.
set -e
[ -n "$GCP_CLAUDE_DRIVER_SA_JSON_B64" ] && export GCP_CLAUDE_DRIVER_SA_JSON=$(printf "%s" "$GCP_CLAUDE_DRIVER_SA_JSON_B64" | base64 -d)
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
echo "[contradiction-scan] $(date -u +%FT%TZ) - scanning for cross-agent memory contradictions"
node "$ROOT/skills/kb-memory/contradiction-scan.mjs" "$@"
echo "[contradiction-scan] done"
