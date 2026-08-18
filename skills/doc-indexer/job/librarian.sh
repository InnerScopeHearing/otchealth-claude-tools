#!/bin/sh
# Librarian loop (Container Apps Job, scheduled per domain): keep a data room's knowledge fresh by
# re-running index -> understand -> push-search (and, opt-in per room, the metadata-enrichment pass).
# Resumable, so it only processes new docs. Arg 1 = the doc-indexer profile (finance | legal | commerce
# | commons). One secret only: the claude-driver SA (GCP_CLAUDE_DRIVER_SA_JSON) self-resolves all
# Azure keys from Secret Manager.
set -e
[ -n "$GCP_CLAUDE_DRIVER_SA_JSON_B64" ] && export GCP_CLAUDE_DRIVER_SA_JSON=$(printf "%s" "$GCP_CLAUDE_DRIVER_SA_JSON_B64" | base64 -d)
# Resolve the repo root from this script's own location so it runs identically inside the
# container (/app) and from a checkout (~/otchealth-claude-tools) in Cloud Shell.
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
PROFILE="${1:-finance}"
shift 2>/dev/null || true

# STORAGE BACKEND SELECTION (2026-08-18). Every Azure Blob storage account this job could target
# is write-blocked (every PUT -> 403 AuthorizationPermissionMismatch; GET/LIST still work -- see
# skills/kb-memory/s3-blob.mjs's header). This script used to force --azure unconditionally for
# every profile, so the "index" step's final catalog write was silently failing for ALL FOUR
# librarian profiles (finance/commerce/legal-company/legal-personal share this exact defect, not
# just finance). The move to --s3 is per-room and evidence-gated, NOT a blanket flip:
#   - finance                    -> --s3. Verified S3 mirror row + a 2026-08-18 completeness audit
#                                   (runbooks/2026-08-18-azure-to-s3-completeness-audit.md) found
#                                   71,142/71,155 objects already present (99.98%). Live-verified
#                                   fixed this same session (a real `index` run against production
#                                   flushed 269 pending docs to S3 with exit 0).
#   - legal --container company  -> --s3. Same audit: 17,797/17,790 objects present, zero gap.
#   - commerce                   -> STAYS --azure (still broken). otchealthcommerce/commerce-
#                                   source-docs has NO row in s3-blob.mjs's MIRROR table -- the
#                                   2026-08-18 audit explicitly left it out of scope ("no Azure
#                                   credentials for it were requested or fetched") and recommended
#                                   a dedicated follow-up audit before trusting any bucket for it.
#                                   Guessing one here would violate "choose the bucket from an
#                                   OBSERVED S3 listing, never inferred from IAM." Reported, not
#                                   fixed; --s3 would fail loud anyway (s3LocationFor returns null)
#                                   but reads would ALSO stop working, which --azure still allows.
#   - legal --container personal -> STAYS --azure (still broken). otchealthlegalstore/personal IS
#                                   in the S3 MIRROR table (its own dedicated bucket,
#                                   otchealth-legal-personal-dr-55c84f6b), so this is not a missing-
#                                   evidence problem the way commerce is. It is a RING decision: this
#                                   room is attorney-privileged (a live CA family matter involving
#                                   minors). Granting it a new write path is Matt/CLO's call, not a
#                                   mechanical bug fix -- so it is deliberately left broken and
#                                   reported here rather than silently repointed.
CONTAINER_ARG=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--container" ]; then CONTAINER_ARG="$arg"; fi
  prev="$arg"
done
if [ "$PROFILE" = "finance" ] || { [ "$PROFILE" = "legal" ] && [ "$CONTAINER_ARG" = "company" ]; }; then
  BACKEND_FLAG="--s3"
else
  BACKEND_FLAG="--azure"
  echo "[librarian] NOTE: profile=$PROFILE container=${CONTAINER_ARG:-<default>} stays on --azure (write-blocked) -- see the backend-selection comment at the top of this script for why."
fi

echo "[librarian] profile=$PROFILE backend=$BACKEND_FLAG $*"
node "$ROOT/skills/doc-indexer/indexer.mjs" index --profile "$PROFILE" $BACKEND_FLAG "$@"
node "$ROOT/skills/doc-indexer/indexer.mjs" understand --profile "$PROFILE" $BACKEND_FLAG "$@"
# push-search writes FLAT docs (contentVector, key=id) to the room index. After the Phase-3 S1
# cutover the doc rooms are CHUNKED (text_vector, key=chunk_id) and fed by native S1 pull-indexers,
# so a flat push would be rejected (schema mismatch) and turn the job RED for nothing. Set
# SKIP_PUSH_SEARCH=1 on a doc-room librarian job at cutover to drop ONLY the push step; index +
# understand still run, keeping the _TEXT/ sidecars fresh (that is exactly what the S1 pull-indexer
# reads). Default (unset) = push-search runs as before, so this is a no-op until the flag is set.
if [ "$SKIP_PUSH_SEARCH" = "1" ]; then
  echo "[librarian] SKIP_PUSH_SEARCH=1 -> skipping push-search ($PROFILE is now S1 pull-indexer-fed)"
else
  node "$ROOT/skills/doc-indexer/indexer.mjs" push-search --profile "$PROFILE" $BACKEND_FLAG "$@"
fi
# METADATA ENRICHMENT (opt-in per room, default OFF; commerce is the 2026-07-21 proving ground -- see
# skills/doc-indexer/enrich.mjs + skills/doc-indexer/metadata-schema.mjs). Universal-core + a
# per-profile domain pack layered on top of CU `understand` + deep-pass.mjs output, written as blob
# metadata on the _TEXT sidecar and projected onto every chunk via the S1 blob indexer's fieldMappings
# + the skillset's index projections. Incremental (skips docs already enriched at the same sha256) and
# gpt-4.1-mini only. Finance/legal/commons roll out ONE ROOM AT A TIME by setting ENRICH=1 on that
# room's job env after a parity check against the live index -- do not flip it fleet-wide blind.
if [ "$ENRICH" = "1" ]; then
  echo "[librarian] ENRICH=1 -> ensuring the metadata schema + enriching $PROFILE"
  node "$ROOT/skills/doc-indexer/enrich.mjs" ensure-schema --profile "$PROFILE" --azure "$@"
  node "$ROOT/skills/doc-indexer/enrich.mjs" run --profile "$PROFILE" --azure "$@"
else
  echo "[librarian] ENRICH not set -> skipping the metadata-enrichment pass for $PROFILE (opt-in per room; see skills/doc-indexer/enrich.mjs)"
fi
echo "[librarian] done: $PROFILE refreshed"
