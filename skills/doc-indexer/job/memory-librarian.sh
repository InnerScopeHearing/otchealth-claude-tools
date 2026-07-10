#!/bin/sh
# memory-librarian (Container Apps Job, nightly): the fleet's memory "secretary". Reads every session
# JOURNAL kb-journal captured during the day, writes a per-agent DAILY DIGEST, distills durable
# facts/decisions the live capture throttle missed into each agent ledger (deduped, ring-correct),
# re-indexes the shared brain memory, and reports gaps (an agent whose journal was active but whose
# ledger barely moved). One secret only: the claude-driver SA self-resolves every Azure key from SM.
set -e
[ -n "$GCP_CLAUDE_DRIVER_SA_JSON_B64" ] && export GCP_CLAUDE_DRIVER_SA_JSON=$(printf "%s" "$GCP_CLAUDE_DRIVER_SA_JSON_B64" | base64 -d)
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
echo "[memory-librarian] $(date -u +%FT%TZ) - cataloging session journals -> digests + ledgers + brain"
node "$ROOT/skills/kb-memory/memory-librarian.mjs" "$@"
echo "[memory-librarian] done"
