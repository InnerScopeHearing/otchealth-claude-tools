#!/bin/sh
# nightly-reflection (Container Apps Job, scheduled nightly, e.g. cron 30 2 * * *): distills the last
# ~24h of Cosmos episode memories (kind=episode, the gateway's auto-journal) into durable per-agent
# facts/decisions/pitfalls on the kb-memory Blob ledger. Phase-4 B1 (the self-maintaining brain).
# Report/distill only; every write is a NEW ledger row (never a mutation of an existing one). One
# secret: the claude-driver SA (or Key Vault via managed identity) self-resolves every Azure key.
# Dry-run by default -- pass --commit as a job arg to actually write. Always exits 0 (fail-open).
set -e
[ -n "$GCP_CLAUDE_DRIVER_SA_JSON_B64" ] && export GCP_CLAUDE_DRIVER_SA_JSON=$(printf "%s" "$GCP_CLAUDE_DRIVER_SA_JSON_B64" | base64 -d)
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
echo "[nightly-reflection] $(date -u +%FT%TZ) - distilling the last ~24h of episode memories"
node "$ROOT/skills/kb-memory/nightly-reflection.mjs" "$@"
echo "[nightly-reflection] done"
