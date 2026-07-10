#!/usr/bin/env bash
# HyperAgent wrapper for token-keeper: normalize the injected claude-driver SA + set the sandbox proxy,
# then exec the keeper. On Claude Code you do NOT need this wrapper — run `node keeper.mjs ...` directly
# (native SA + direct egress). Usage (via RunWithCredentials):
#   bash skills/token-keeper/run.sh node skills/token-keeper/keeper.mjs status
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

# Reuse kb-memory's SA normalizer if present (same injected SA), else expect the SA already on disk.
if [ -f "$DIR/../kb-memory/sa-normalize.mjs" ]; then
  node "$DIR/../kb-memory/sa-normalize.mjs" || true
fi
if [ -f "$HOME/.gcp_claude_driver_sa.json" ]; then
  GCP_CLAUDE_DRIVER_SA_JSON="$(cat "$HOME/.gcp_claude_driver_sa.json")"
  export GCP_CLAUDE_DRIVER_SA_JSON
fi

# HyperAgent egress needs the sandbox proxy; harmless on Claude Code.
export NODE_USE_ENV_PROXY=1

# Ensure the toolkit is present (idempotent clone) when run outside a checkout.
[ -d /tmp/octools/skills ] || git clone --depth 1 https://github.com/innerscopehearing/otchealth-claude-tools /tmp/octools >/dev/null 2>&1

exec "$@"
