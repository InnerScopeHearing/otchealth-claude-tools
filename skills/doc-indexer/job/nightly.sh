#!/bin/sh
# Nightly fleet learning loop (Container Apps Job, cron 59 23 * * *): generate the day's company
# digest, stage it to the journal commons, index it so it is cloud-searchable, and (opt-in, see the
# ENRICH gate below) run the S1 metadata-enrichment pass over the commons-company-journal room. The
# company journals itself every night and the knowledge base compounds.
#
# STORAGE (corrected 2026-09-01): every step below targets the S3 commons, not Azure Blob. This
# script hardcoded `--azure` on six invocations; Azure subscription 55c84f6b was permanently deleted
# 2026-08-13, so the FIRST of those (the digest stage, line ~18) threw under `set -e` and took the
# whole nightly loop down with it every night -- the credential-registry regen, the commons index,
# the memory reindex and the fleet-watch report never ran (observed: the scheduled task stops at
# exit 1). The commons room lives at s3://otchealth-brain-dr-55c84f6b under
# otchealthcommons/company-journal/ (the MIRROR row in skills/kb-memory/s3-blob.mjs), which is the
# same place indexer.mjs --s3 and the librarian jobs already read and write. `--key-secret` is an
# Azure-only flag and is dropped with the backend.
#
# SECRETS resolve from AWS SSM Parameter Store /otchealth/* (SECRET_BACKEND=ssm, the fleet default
# in skills/kb-memory/azure-secret.mjs). Azure Key Vault kv-otc-55c84f6bef died with the same
# subscription, and GCP Secret Manager is retired; the optional B64 SA line below is a no-op unless
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
node "$ROOT/skills/cfo-store/store.mjs" --s3 --account otchealthcommons --container company-journal put "/tmp/$DATE.md" "_DAILY/$DATE.md"
echo "[nightly] regenerating the credential registry from SSM (names+metadata, no values)"
# HARD step: vault-registry reads the live secret store and writes _VAULT/registry.{md,jsonl} to the
# commons. Its store moved Key Vault -> AWS SSM (claude-tools #487, SSM-sole-source + commons-S3
# cPut); the older "reads the live Key Vault via the job's managed identity" note is stale. No
# `|| echo` mask: a real failure fails the run (set -e) so the dead-man's-switch pages instead of
# passing green.
node "$ROOT/skills/vault-sync/vault-registry.mjs"
echo "[nightly] indexing into the commons KB"
node "$ROOT/skills/doc-indexer/indexer.mjs" index --no-ocr --profile commons --s3
# push-search: indexer.mjs detects the live room's shape and dispatches FLAT or CHUNKED itself
# (skills/doc-indexer/indexer.mjs, 2026-08-28). commons-company-journal is CHUNKED on the live
# OpenSearch brain, and there is NO pull-indexer on OpenSearch -- that only ever existed on the
# retired Azure S1 service -- so a run with SKIP_PUSH_SEARCH unset genuinely chunks, embeds and
# pushes the new digest. This corrects the older comment here, which claimed a flat push would be
# "rejected" and that an S1 pull-indexer would collect the digest instead; on AWS nothing would have
# collected it. SKIP_PUSH_SEARCH=1 remains a deliberate cost/latency opt-out, not a workaround.
if [ "$SKIP_PUSH_SEARCH" = "1" ]; then
  echo "[nightly] SKIP_PUSH_SEARCH=1 -> skipping commons push-search (deliberate cost/latency opt-out)"
else
  node "$ROOT/skills/doc-indexer/indexer.mjs" push-search --profile commons --s3
fi
# METADATA ENRICHMENT (opt-in, default OFF; commerce is the 2026-07-21 proving ground -- see
# skills/doc-indexer/enrich.mjs + skills/doc-indexer/metadata-schema.mjs). Universal-core metadata
# layered on top of CU `understand` output, written as blob metadata on the _TEXT sidecar and
# projected onto every chunk via the S1 blob indexer's fieldMappings + the skillset's index
# projections. Incremental (skips docs already enriched at the same sha256) and gpt-4.1-mini only.
# This is the SAME opt-in gate already wired into job/librarian.sh for finance/commerce/legal-company/
# legal-personal (that script takes a --profile argument; this job's profile is always commons, so the
# gate is hardcoded here rather than parameterized). Roll out via ENRICH=1 on this job's env AFTER a
# parity check against the live commons-company-journal index -- do not flip it fleet-wide blind.
if [ "$ENRICH" = "1" ]; then
  echo "[nightly] ENRICH=1 -> ensuring the metadata schema + enriching commons"
  node "$ROOT/skills/doc-indexer/enrich.mjs" ensure-schema --profile commons --s3
  node "$ROOT/skills/doc-indexer/enrich.mjs" run --profile commons --s3
else
  echo "[nightly] ENRICH not set -> skipping the metadata-enrichment pass for commons (opt-in; see skills/doc-indexer/enrich.mjs)"
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
node "$ROOT/skills/cfo-store/store.mjs" --s3 --account otchealthcommons --container company-journal put "/tmp/fleet-watch-$DATE.md" "_FLEET-WATCH/$DATE.md" || echo "[nightly] fleet-watch stage non-fatal: $?"
echo "[nightly] done: $DATE digest indexed + cloud-searchable + brain memory refreshed + fleet-watch staged"
