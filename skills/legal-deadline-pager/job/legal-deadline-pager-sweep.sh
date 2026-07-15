#!/bin/sh
# legal-deadline-pager Container Apps Job entrypoint (Tier-1, cron: at least daily). Reads the CLO's
# legal docket, syncs verified company-namespace deadlines inside the tight window into decision-clock
# storage, and pages Matt directly for anything inside that window.
#
# SHIPS DISARMED: --commit here only arms the TRACKING side (decision-clock sync, personal cooldown
# store, heartbeat marker). Actual email sending additionally requires the environment variable
# LEGAL_PAGER_ENABLED=1, which this script deliberately does NOT set. Deploying and scheduling this job
# therefore pages nobody until a human explicitly arms it:
#   az containerapp job update -n legal-deadline-pager-sweep -g otchealth-automation-rg \
#     --set-env-vars LEGAL_PAGER_ENABLED=1
# That is a conscious, reviewable step, never a side effect of merging or deploying code.
set -e
[ -n "$GCP_CLAUDE_DRIVER_SA_JSON_B64" ] && export GCP_CLAUDE_DRIVER_SA_JSON=$(printf "%s" "$GCP_CLAUDE_DRIVER_SA_JSON_B64" | base64 -d)
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
echo "[legal-deadline-pager] $(date -u +%FT%TZ) sweeping the legal docket (LEGAL_PAGER_ENABLED=${LEGAL_PAGER_ENABLED:-0})"
node "$ROOT/skills/legal-deadline-pager/pager.mjs" sweep --commit
echo "[legal-deadline-pager] sweep complete"
