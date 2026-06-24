#!/bin/sh
# Deep-pass job (Container Apps Job, per data room): HIGH-POWER re-summarization + signature/execution
# detection + confidence-gated outlier flagging via gpt-4.1. The fix for botched gpt-4.1-mini summaries.
# Resumable (skips rows already marked .deep). Arg 1 = doc-indexer profile (legal | finance); remaining
# args pass through to deep-pass.mjs (e.g. --container personal --max-minutes 200 --concurrency 10).
# One secret only: the claude-driver SA (GCP_CLAUDE_DRIVER_SA_JSON / _B64) self-resolves every Azure
# storage key AND the Foundry gpt-4.1 key from Secret Manager. Runs on Azure credits, zero Max draw.
set -e
[ -n "$GCP_CLAUDE_DRIVER_SA_JSON_B64" ] && export GCP_CLAUDE_DRIVER_SA_JSON=$(printf "%s" "$GCP_CLAUDE_DRIVER_SA_JSON_B64" | base64 -d)
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
PROFILE="${1:-legal}"
shift 2>/dev/null || true
echo "[deep-pass] profile=$PROFILE $*"
node "$ROOT/skills/doc-indexer/deep-pass.mjs" --profile "$PROFILE" "$@"
echo "[deep-pass] done: $PROFILE"
