#!/bin/sh
# Librarian loop (Container Apps Job, scheduled per domain): keep a data room's knowledge fresh by
# re-running index -> understand -> push-search. Resumable, so it only processes new docs. Arg 1 =
# the doc-indexer profile (finance | legal | commerce | commons). One secret only: the claude-driver
# SA (GCP_CLAUDE_DRIVER_SA_JSON) self-resolves all Azure keys from Secret Manager.
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
echo "[librarian] done: $PROFILE refreshed"
