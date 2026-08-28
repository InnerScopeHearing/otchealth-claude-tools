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
#   - commerce                   -> --s3 as of 2026-08-19 (RESOLVED; this entry used to read
#                                   "STAYS --azure, no MIRROR row, do not guess a bucket"). The
#                                   follow-up audit that entry asked for was done: a paginated
#                                   ListObjectsV2 found the room at otchealth-brain-dr-55c84f6b
#                                   under otchealthcommerce/commerce-source-docs/ (32 objects: 12
#                                   source docs, their 12 _TEXT/ sidecars, 6 _CATALOG/ files, 2
#                                   _REVIEW/ csvs), and the same listing against the other
#                                   candidate bucket, otchealth-finance-legal-dr-55c84f6b, returned
#                                   ZERO under "otchealthcommerce/". Observed, and disambiguated
#                                   against the alternative -- not inferred from IAM. Row added to
#                                   s3-blob.mjs's MIRROR table with that evidence recorded inline.
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
if [ "$PROFILE" = "finance" ] || [ "$PROFILE" = "commerce" ] || [ "$PROFILE" = "commons" ] \
   || { [ "$PROFILE" = "legal" ] && [ "$CONTAINER_ARG" = "company" ]; }; then
  BACKEND_FLAG="--s3"
else
  BACKEND_FLAG="--azure"
  echo "[librarian] NOTE: profile=$PROFILE container=${CONTAINER_ARG:-<default>} stays on --azure (write-blocked) -- see the backend-selection comment at the top of this script for why."
fi

echo "[librarian] profile=$PROFILE backend=$BACKEND_FLAG $*"
node "$ROOT/skills/doc-indexer/indexer.mjs" index --profile "$PROFILE" $BACKEND_FLAG "$@"
# SKIP_UNDERSTAND=1 (added 2026-08-28): `understand` is the Azure Content Understanding enrichment
# pass, and that service died with the permanently deleted Azure subscription -- a librarian run
# that reaches it exits 1 on CU's 401 BEFORE push-search ever runs, so the ingest step a run exists
# for never happens (observed live on the first post-#474 commerce run, task ea9e14b6). Until a CU
# replacement lands (the Bedrock deep-pass lane is the metadata-enrichment successor), the ECS
# librarian jobs set SKIP_UNDERSTAND=1 so index -> push-search still run; invoking understand
# EXPLICITLY (flag unset) still fails loud rather than pretending CU works.
if [ "${SKIP_UNDERSTAND:-}" = "1" ]; then
  echo "[librarian] SKIP_UNDERSTAND=1 -> skipping understand (Azure CU is retired; enrichment moves to the deep-pass lane)"
else
  node "$ROOT/skills/doc-indexer/indexer.mjs" understand --profile "$PROFILE" $BACKEND_FLAG "$@"
fi
# push-search writes FLAT docs (contentVector, key=id) to a flat room, or CHUNK docs (text_vector,
# key=chunk_id) to a CHUNKED room -- indexer.mjs detects the live room's shape itself and dispatches
# accordingly (skills/doc-indexer/indexer.mjs's CHUNKED-room ingest section, 2026-08-28). All four
# doc rooms this script can target (finance/commerce/legal-company/legal-personal) are CHUNKED on
# the live OpenSearch brain, so a run with SKIP_PUSH_SEARCH unset now genuinely CHUNKS + EMBEDS +
# PUSHES any new catalog documents into the room, not merely a no-op safety check. This corrects an
# earlier version of this comment (pre-2026-08-28) that described push-search as unconditionally
# rejected against a chunked room ("fed by native S1 pull-indexers" -- that was true only of the old
# Azure S1 service, which no longer exists; there is no pull-indexer on OpenSearch). SKIP_PUSH_SEARCH
# remains a valid escape hatch for a job that wants index+understand to keep the _TEXT/ sidecars
# fresh WITHOUT paying the chunk/embed/push cost on every run (e.g. daily-digest, which defers that
# cost elsewhere) -- it is a deliberate cost/latency choice now, not a workaround for a rejected write.
if [ "$SKIP_PUSH_SEARCH" = "1" ]; then
  echo "[librarian] SKIP_PUSH_SEARCH=1 -> skipping push-search for $PROFILE (deliberate cost/latency opt-out, not a schema-mismatch workaround)"
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
#
# TWO BACKENDS, TWO AXES (2026-08-19). This block used to pass a hardcoded `--azure`, which after
# the Azure lockdown meant BOTH of enrich.mjs's backends pointed at dead infrastructure: it could
# not read the source text (storage) and could not write the enriched fields (search). That is why
# entity/graph coverage sat at ~0% and why "just flip ENRICH=1" was never going to work.
#   storage -> $BACKEND_FLAG, the SAME per-room, evidence-gated choice the steps above use, so
#              enrichment can never read from a different place than indexing wrote to.
#   search  -> $ENRICH_SEARCH_BACKEND (default opensearch, the live brain). Override per job only
#              if a room is genuinely still on Azure AI Search.
# ensure-schema is skipped on the opensearch path BY DESIGN, not as a shortcut: it provisions an
# Azure AI Search index schema, and OpenSearch accepts new domain-pack fields through ordinary
# dynamic mapping (no `dynamic:strict` on any doc room). Running it would just fail against a
# search service this room does not use.
ENRICH_SEARCH_BACKEND="${ENRICH_SEARCH_BACKEND:-opensearch}"
if [ "$ENRICH" = "1" ]; then
  echo "[librarian] ENRICH=1 -> enriching $PROFILE (storage=$BACKEND_FLAG search=$ENRICH_SEARCH_BACKEND)"
  if [ "$ENRICH_SEARCH_BACKEND" = "azure" ]; then
    node "$ROOT/skills/doc-indexer/enrich.mjs" ensure-schema --profile "$PROFILE" $BACKEND_FLAG "$@"
  else
    echo "[librarian] search=$ENRICH_SEARCH_BACKEND -> skipping ensure-schema (Azure-AI-Search-only; OpenSearch uses dynamic mapping)"
  fi
  node "$ROOT/skills/doc-indexer/enrich.mjs" run --profile "$PROFILE" $BACKEND_FLAG \
    --search-backend "$ENRICH_SEARCH_BACKEND" "$@"
else
  echo "[librarian] ENRICH not set -> skipping the metadata-enrichment pass for $PROFILE (opt-in per room; see skills/doc-indexer/enrich.mjs)"
fi
echo "[librarian] done: $PROFILE refreshed"
