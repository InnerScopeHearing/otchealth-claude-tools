#!/bin/sh
# Nightly fleet learning loop (Container Apps Job, cron 59 23 * * *): generate the day's company
# digest, stage it to the journal commons, and index it so it is cloud-searchable. The company
# journals itself every night and the knowledge base compounds. Secrets resolve from Azure Key Vault
# via the job's managed identity (UAMI id-otc-jobs-kv): the GitHub App key, all Azure keys, the
# commons storage key. GCP Secret Manager is RETIRED; the optional B64 SA line below is a no-op unless
# GCP_CLAUDE_DRIVER_SA_JSON_B64 is explicitly set (kept only as a break-glass fallback).
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
echo "[nightly] regenerating the credential registry from Key Vault (names+metadata, no values)"
# HARD step (2026-07-14): vault-registry now reads the live Key Vault via the job's managed identity,
# so it CAN succeed here (it read retired GCP Secret Manager before and process.exit(3)'d every night,
# swallowed as "non-fatal: 3" -> the registry never regenerated). No `|| echo` mask: a real failure
# now fails the run (set -e) so the dead-man's-switch pages instead of passing green.
node "$ROOT/skills/vault-sync/vault-registry.mjs"
echo "[nightly] indexing into the commons KB"
node "$ROOT/skills/doc-indexer/indexer.mjs" index --no-ocr --profile commons --azure
# push-search writes FLAT docs to commons-company-journal. After the Phase-3 S1 cutover that room is
# CHUNKED + fed by a native S1 pull-indexer (it reads the _TEXT/ sidecars the index step just wrote),
# so a flat push would be rejected. SKIP_PUSH_SEARCH=1 (set on the daily-digest job at cutover) drops
# ONLY the push; the digest still lands in the blob + gets pulled. Default unset = push runs (no-op).
if [ "$SKIP_PUSH_SEARCH" = "1" ]; then
  echo "[nightly] SKIP_PUSH_SEARCH=1 -> skipping commons push-search (S1 pull-indexer-fed)"
else
  node "$ROOT/skills/doc-indexer/indexer.mjs" push-search --profile commons --azure
fi
echo "[nightly] refreshing the company-brain memory index (memory-exec)"
# Keep the Billion Dollar Brain's agent-memory index fresh: embed any new shared exec-feed
# entries (lessons, decisions, focus-group/shark catalog) into memory-exec. Resumable + cheap
# when nothing is new. The dedicated brain-reindex job runs this every 6h; this is the nightly belt.
node "$ROOT/skills/kb-memory/semantic.mjs" reindex || echo "[nightly] memory reindex non-fatal: $?"
# ── Fleet watcher (P0 stability): dead-man's-switch check + image-drift, staged to commons so the
# daily digest / COO surfaces silent job failures + mutable-tag drift. Fail-open; never blocks.
echo "[nightly] fleet watcher: heartbeat check + image-drift + drift-recon -> commons"
{ echo "# Fleet Watch $DATE (UTC)"; echo; echo "## Heartbeat (silence = failure)"; node "$ROOT/setup/heartbeat.mjs" check 2>&1; echo; echo "## Image drift (mutable tag = risk)"; node "$ROOT/setup/image-drift.mjs" 2>&1; echo; echo "## Digest drift-recon (stale @sha256 pin vs current main build)"; node "$ROOT/setup/drift-recon.mjs" 2>&1; } > "/tmp/fleet-watch-$DATE.md" 2>&1 || true
node "$ROOT/skills/cfo-store/store.mjs" --azure --account otchealthcommons --key-secret azure-commons-storage-key --container company-journal put "/tmp/fleet-watch-$DATE.md" "_FLEET-WATCH/$DATE.md" || echo "[nightly] fleet-watch stage non-fatal: $?"
echo "[nightly] done: $DATE digest indexed + cloud-searchable + brain memory refreshed + fleet-watch staged"
