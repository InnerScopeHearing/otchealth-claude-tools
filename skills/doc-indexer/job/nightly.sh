#!/bin/sh
# Nightly fleet learning loop (Container Apps Job, cron 59 23 * * *): generate the day's company
# digest, stage it to the journal commons, and index it so it is cloud-searchable. The company
# journals itself every night and the knowledge base compounds. One secret only: the claude-driver
# SA (GCP_CLAUDE_DRIVER_SA_JSON) self-resolves the GitHub App key + all Azure keys from Secret Manager.
set -e
[ -n "$GCP_CLAUDE_DRIVER_SA_JSON_B64" ] && export GCP_CLAUDE_DRIVER_SA_JSON=$(printf "%s" "$GCP_CLAUDE_DRIVER_SA_JSON_B64" | base64 -d)
DATE=$(date -u +%F)
echo "[nightly] $DATE - generating digest"
node /app/skills/daily-digest/digest.mjs --out "/tmp/$DATE.md"
echo "[nightly] staging to journal commons"
node /app/skills/cfo-store/store.mjs --azure --account otchealthcommons --key-secret azure-commons-storage-key --container company-journal put "/tmp/$DATE.md" "_DAILY/$DATE.md"
echo "[nightly] indexing into the commons KB"
node /app/skills/doc-indexer/indexer.mjs index --no-ocr --profile commons --azure
node /app/skills/doc-indexer/indexer.mjs push-search --profile commons --azure
echo "[nightly] done: $DATE digest indexed + cloud-searchable"
