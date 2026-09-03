#!/bin/sh
# ledger-compaction (scheduled job, e.g. daily): reads each agent's kb-memory ledger and writes a
# compacted, human-readable markdown summary next to it. Report/summarize only; never mutates or
# deletes the source ledger.
#
# STORAGE (ported to S3, 2026-09-03): run-compaction.mjs's storage calls now go through AWS S3 (see
# that file's own header for the full defect this fixes). Auth is the ECS task role / AWS env; no
# Azure key is resolved here any more. The optional B64 SA line below is a break-glass no-op unless
# GCP_CLAUDE_DRIVER_SA_JSON_B64 is explicitly set (GCP Secret Manager itself is retired).
#
# EXIT CODE (changed, 2026-09-03): a missing AWS credential on every path still fails open (exit 0).
# An agent that DOES have a credential but cannot reach or write its S3 room now makes the whole
# process exit non-zero with a clear summary line -- `set -e` below means that failure propagates
# straight through this wrapper, so a scheduled run that could not actually compact anything is
# reported as failed, never as a silent "done".
set -e
[ -n "$GCP_CLAUDE_DRIVER_SA_JSON_B64" ] && export GCP_CLAUDE_DRIVER_SA_JSON=$(printf "%s" "$GCP_CLAUDE_DRIVER_SA_JSON_B64" | base64 -d)
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
echo "[ledger-compaction] $(date -u +%FT%TZ) - reading agent ledgers -> compacted, non-destructive summaries"
node "$ROOT/skills/ledger-compaction/job/run-compaction.mjs" "$@"
echo "[ledger-compaction] done"
