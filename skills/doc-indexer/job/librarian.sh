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
echo "[librarian] profile=$PROFILE $*"
node "$ROOT/skills/doc-indexer/indexer.mjs" index --profile "$PROFILE" --azure "$@"
node "$ROOT/skills/doc-indexer/indexer.mjs" understand --profile "$PROFILE" --azure "$@"
# push-search writes FLAT docs (contentVector, key=id) to the room index. After the Phase-3 S1
# cutover the doc rooms are CHUNKED (text_vector, key=chunk_id) and fed by native S1 pull-indexers,
# so a flat push would be rejected (schema mismatch) and turn the job RED for nothing. Set
# SKIP_PUSH_SEARCH=1 on a doc-room librarian job at cutover to drop ONLY the push step; index +
# understand still run, keeping the _TEXT/ sidecars fresh (that is exactly what the S1 pull-indexer
# reads). Default (unset) = push-search runs as before, so this is a no-op until the flag is set.
if [ "$SKIP_PUSH_SEARCH" = "1" ]; then
  echo "[librarian] SKIP_PUSH_SEARCH=1 -> skipping push-search ($PROFILE is now S1 pull-indexer-fed)"
else
  node "$ROOT/skills/doc-indexer/indexer.mjs" push-search --profile "$PROFILE" --azure "$@"
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
