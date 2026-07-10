#!/bin/sh
# ledger-compaction (Container Apps Job, scheduled e.g. weekly): reads each agent's kb-memory ledger
# and writes a compacted, human-readable markdown summary next to it. Report/summarize only; never
# mutates or deletes the source ledger. One secret: the claude-driver SA self-resolves every Azure key
# from Secret Manager, same as the rest of the fleet tooling. Fail-open by design (run-compaction.mjs
# always exits 0, even on an internal error; a single agent's failure is logged and skipped).
set -e
[ -n "$GCP_CLAUDE_DRIVER_SA_JSON_B64" ] && export GCP_CLAUDE_DRIVER_SA_JSON=$(printf "%s" "$GCP_CLAUDE_DRIVER_SA_JSON_B64" | base64 -d)
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
echo "[ledger-compaction] $(date -u +%FT%TZ) - reading agent ledgers -> compacted, non-destructive summaries"
node "$ROOT/skills/ledger-compaction/job/run-compaction.mjs" "$@"
echo "[ledger-compaction] done"
