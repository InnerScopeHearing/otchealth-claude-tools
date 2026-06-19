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
node "$ROOT/skills/doc-indexer/indexer.mjs" push-search --profile "$PROFILE" --azure "$@"
echo "[librarian] done: $PROFILE refreshed"
