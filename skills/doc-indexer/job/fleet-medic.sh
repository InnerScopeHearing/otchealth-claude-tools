#!/bin/sh
# fleet-medic (Container Apps Job, every ~30 min): the auto-dispatch MEDIC for fleet working memory.
# Scans every exec agent's memory health (team-health spine + PostHog memory_beacon) and, for any agent
# running with its memory OFF, leaves a targeted self-heal directive the agent picks up on its next
# prompt + emits a medic_dispatch alert. Tier-1 autonomy (Azure cron, ZERO Max-plan draw). One secret:
# the claude-driver SA self-resolves every Azure/PostHog key from Secret Manager. Fail-open by design.
set -e
[ -n "$GCP_CLAUDE_DRIVER_SA_JSON_B64" ] && export GCP_CLAUDE_DRIVER_SA_JSON=$(printf "%s" "$GCP_CLAUDE_DRIVER_SA_JSON_B64" | base64 -d)
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
echo "[fleet-medic] $(date -u +%FT%TZ) - scanning fleet memory health -> auto-dispatch on dark"
node "$ROOT/skills/fleet-medic/medic.mjs" scan --dispatch "$@"
echo "[fleet-medic] done"
