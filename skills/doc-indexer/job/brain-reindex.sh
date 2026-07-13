#!/bin/sh
# WRITER-OF-RECORD FOR: memory-exec  (and NOTHING else -- read setup/expected-indexes.json).
#
# THE NAME LIES BY ACCIDENT. This job does NOT touch the `otchealth-brain` index. It was named back
# when memory-exec WAS "the brain" (skills/company-brain/brain.mjs still labels it "(shared brain)").
# A separate, ad-hoc, WRITER-LESS index called `otchealth-brain` was later created outside IaC and wired
# into the gateway's brain_search -- and this job's green 6h "Succeeded" was then misread, for ~12 days,
# as proof that that index was being maintained. It was not. Nothing maintained it. Do not re-point this
# job at otchealth-brain; that index is tombstoned (setup/expected-indexes.json).
#
# Brain-reindex loop (Container Apps Job, cron 0 */6 * * *): keep the agent-memory index (memory-exec)
# fresh on a 6h cadence so a lesson/decision/focus-group review
# written this morning is answerable by company-brain this afternoon, not just the next night.
# Resumable + cheap when nothing new (semantic.mjs skips already-embedded entries). One secret only:
# the claude-driver SA (GCP_CLAUDE_DRIVER_SA_JSON_B64) self-resolves every Azure key from Secret Manager.
set -e
[ -n "$GCP_CLAUDE_DRIVER_SA_JSON_B64" ] && export GCP_CLAUDE_DRIVER_SA_JSON=$(printf "%s" "$GCP_CLAUDE_DRIVER_SA_JSON_B64" | base64 -d)
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
echo "[brain-reindex] $(date -u +%FT%TZ) - refreshing memory-exec from the shared exec feed"
node "$ROOT/skills/kb-memory/semantic.mjs" reindex
echo "[brain-reindex] done"
