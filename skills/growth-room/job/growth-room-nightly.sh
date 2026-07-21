#!/bin/sh
# growth-room Container Apps Job entrypoint (Tier-1, nightly cron): pulls cross-app growth signal
# (Capgo OTA health, RevenueCat subscription/MRR, PostHog funnel) and stages ONE dated digest into
# the commons brain, then runs the doc-indexer `index` step so its _TEXT sidecar exists for the S1
# ixr-commons-docs pull-indexer to pick up on its own schedule. Mirrors nightly.sh (daily-digest) and
# librarian.sh's shape exactly -- see skills/doc-indexer/job/nightly.sh for the pattern this follows.
#
# Auth: the job's managed identity (id-otc-jobs-kv) resolves every secret (capgo-token,
# posthog-personal-api-key, revenuecat-secret-key, azure-commons-storage-key) from Key Vault via
# skills/kb-memory/azure-secret.mjs's kvSecret() -- no --secrets / --env-vars needed on the job spec,
# same pattern as cfo-reconstruction-nightly (see runbooks/cfo-reconstruction-job.md for why this is
# the current canonical shape vs the older gcpsa-secret jobs).
#
# Staging is on by default (no --commit gate): a read-only growth digest landing in the shared,
# non-sensitive commons room has no human-facing cost if wrong, matching every other librarian/
# nightly job in this fleet. Pass --dry-run (this script forwards "$@") to preview without staging,
# e.g. for a manual `az containerapp job start ... --args '.../growth-room-nightly.sh' '--dry-run'`
# smoke test before trusting the cron.
set -e
[ -n "$GCP_CLAUDE_DRIVER_SA_JSON_B64" ] && export GCP_CLAUDE_DRIVER_SA_JSON=$(printf "%s" "$GCP_CLAUDE_DRIVER_SA_JSON_B64" | base64 -d)
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
echo "[growth-room] $(date -u +%FT%TZ) sweeping cross-app growth metrics"
node "$ROOT/skills/growth-room/growth-room.mjs" sweep --json "$@"
if [ "$1" != "--dry-run" ]; then
  echo "[growth-room] indexing the staged digest into the commons KB (writes the _TEXT sidecar the S1 pull-indexer reads)"
  node "$ROOT/skills/doc-indexer/indexer.mjs" index --no-ocr --profile commons --azure --prefix "_DOCS/growth-room/"
else
  echo "[growth-room] --dry-run: skipping the commons index step (nothing was staged)"
fi
echo "[growth-room] sweep complete"
