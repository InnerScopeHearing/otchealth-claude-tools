#!/bin/sh
# Nightly fleet learning loop (Container Apps Job, cron 59 23 * * *): generate the day's company
# digest, stage it to the journal commons, and index it so it is cloud-searchable. The company
# journals itself every night and the knowledge base compounds. One secret only: the claude-driver
# SA (GCP_CLAUDE_DRIVER_SA_JSON) self-resolves the GitHub App key + all Azure keys from Secret Manager.
set -e
[ -n "$GCP_CLAUDE_DRIVER_SA_JSON_B64" ] && export GCP_CLAUDE_DRIVER_SA_JSON=$(printf "%s" "$GCP_CLAUDE_DRIVER_SA_JSON_B64" | base64 -d)
# Resolve the repo root from this script's own location so it runs identically inside the
# container (/app) and from a checkout (~/otchealth-claude-tools) in Cloud Shell.
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
DATE=$(date -u +%F)
echo "[nightly] $DATE - generating digest"
node "$ROOT/skills/daily-digest/digest.mjs" --out "/tmp/$DATE.md"
echo "[nightly] staging to journal commons"
node "$ROOT/skills/cfo-store/store.mjs" --azure --account otchealthcommons --key-secret azure-commons-storage-key --container company-journal put "/tmp/$DATE.md" "_DAILY/$DATE.md"
echo "[nightly] regenerating the credential registry from Secret Manager (names+metadata, no values)"
node "$ROOT/skills/vault-sync/vault-registry.mjs" || echo "[nightly] vault-registry non-fatal: $?"
echo "[nightly] indexing into the commons KB"
node "$ROOT/skills/doc-indexer/indexer.mjs" index --no-ocr --profile commons --azure
node "$ROOT/skills/doc-indexer/indexer.mjs" push-search --profile commons --azure
echo "[nightly] refreshing the company-brain memory index (memory-exec)"
# Keep the Billion Dollar Brain's agent-memory index fresh: embed any new shared exec-feed
# entries (lessons, decisions, focus-group/shark catalog) into memory-exec. Resumable + cheap
# when nothing is new. The dedicated brain-reindex job runs this every 6h; this is the nightly belt.
node "$ROOT/skills/kb-memory/semantic.mjs" reindex || echo "[nightly] memory reindex non-fatal: $?"
# ── Fleet watcher (P0 stability): dead-man's-switch check + image-drift, staged to commons so the
# daily digest / COO surfaces silent job failures + mutable-tag drift. Fail-open; never blocks.
echo "[nightly] fleet watcher: heartbeat check + image-drift -> commons"
{ echo "# Fleet Watch $DATE (UTC)"; echo; echo "## Heartbeat (silence = failure)"; node "$ROOT/setup/heartbeat.mjs" check 2>&1; echo; echo "## Image drift (mutable tag = risk)"; node "$ROOT/setup/image-drift.mjs" 2>&1; } > "/tmp/fleet-watch-$DATE.md" 2>&1 || true
node "$ROOT/skills/cfo-store/store.mjs" --azure --account otchealthcommons --key-secret azure-commons-storage-key --container company-journal put "/tmp/fleet-watch-$DATE.md" "_FLEET-WATCH/$DATE.md" || echo "[nightly] fleet-watch stage non-fatal: $?"
echo "[nightly] done: $DATE digest indexed + cloud-searchable + brain memory refreshed + fleet-watch staged"
