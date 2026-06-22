#!/bin/sh
# Brain-reindex loop (Container Apps Job, cron 0 */6 * * *): keep the Billion Dollar Brain's
# agent-memory index (memory-exec) fresh on a 6h cadence so a lesson/decision/focus-group review
# written this morning is answerable by company-brain this afternoon, not just the next night.
# Resumable + cheap when nothing new (semantic.mjs skips already-embedded entries). One secret only:
# the claude-driver SA (GCP_CLAUDE_DRIVER_SA_JSON_B64) self-resolves every Azure key from Secret Manager.
set -e
[ -n "$GCP_CLAUDE_DRIVER_SA_JSON_B64" ] && export GCP_CLAUDE_DRIVER_SA_JSON=$(printf "%s" "$GCP_CLAUDE_DRIVER_SA_JSON_B64" | base64 -d)
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
echo "[brain-reindex] $(date -u +%FT%TZ) - refreshing memory-exec from the shared exec feed"
node "$ROOT/skills/kb-memory/semantic.mjs" reindex
echo "[brain-reindex] done"
