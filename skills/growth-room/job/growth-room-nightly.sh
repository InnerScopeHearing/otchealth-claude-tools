#!/bin/sh
# growth-room scheduled-job entrypoint (Tier-1, nightly cron): pulls cross-app growth signal
# (Capgo OTA health, RevenueCat subscription/MRR, PostHog funnel) and stages ONE dated digest into
# the commons brain, then runs the doc-indexer `index` step so its _TEXT sidecar exists and the room
# stays cloud-searchable. Mirrors nightly.sh (daily-digest) and librarian.sh's shape exactly -- see
# skills/doc-indexer/job/nightly.sh for the pattern this follows.
#
# STORAGE (ported off Azure Blob, 2026-09-03): both invocations below hardcoded `--azure`. Azure
# subscription 55c84f6b (which held the `otchealthcommons` Blob account) was permanently deleted
# 2026-08-13, so this job could never have staged a digest as written. Both calls now pass `--s3`,
# targeting the SAME logical room (`otchealthcommons/company-journal`) via the verified MIRROR row in
# skills/kb-memory/s3-blob.mjs (bucket `otchealth-brain-dr-55c84f6b`) -- the same room
# skills/doc-indexer/job/nightly.sh already reads and writes on S3.
#
# Auth: AWS SSM Parameter Store /otchealth/* (SECRET_BACKEND=ssm, the fleet default in
# skills/kb-memory/azure-secret.mjs) resolves capgo-token, posthog-personal-api-key, and
# revenuecat-secret-key; the ECS task role resolves the AWS credential the two S3 calls below need.
# No --secrets / --env-vars are needed on the task definition for either. The optional B64 SA line
# below is a break-glass no-op unless GCP_CLAUDE_DRIVER_SA_JSON_B64 is explicitly set (GCP Secret
# Manager itself is retired).
#
# Staging is on by default (no --commit gate): a read-only growth digest landing in the shared,
# non-sensitive commons room has no human-facing cost if wrong, matching every other librarian/
# nightly job in this fleet. Pass --dry-run (this script forwards "$@") to preview without staging,
# e.g. for a manual smoke test before trusting the cron.
set -e
[ -n "$GCP_CLAUDE_DRIVER_SA_JSON_B64" ] && export GCP_CLAUDE_DRIVER_SA_JSON=$(printf "%s" "$GCP_CLAUDE_DRIVER_SA_JSON_B64" | base64 -d)
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
echo "[growth-room] $(date -u +%FT%TZ) sweeping cross-app growth metrics"
node "$ROOT/skills/growth-room/growth-room.mjs" sweep --json "$@"
if [ "$1" != "--dry-run" ]; then
  echo "[growth-room] indexing the staged digest into the commons KB (writes the _TEXT sidecar)"
  node "$ROOT/skills/doc-indexer/indexer.mjs" index --no-ocr --profile commons --s3 --prefix "_DOCS/growth-room/"
else
  echo "[growth-room] --dry-run: skipping the commons index step (nothing was staged)"
fi
echo "[growth-room] sweep complete"
