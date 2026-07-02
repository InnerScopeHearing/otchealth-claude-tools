#!/usr/bin/env bash
# One-and-done: connect this CFO Claude Code Desktop session to the OTCHealth gateway on the cfo lane,
# with auto-refresh before the 1h token expiry. Run on the CFO Desktop.
#   ./cfo-gateway-connect.sh            # connect once + verify
#   ./cfo-gateway-connect.sh --watch    # connect + auto-refresh
#   ./cfo-gateway-connect.sh --verify-only
set -euo pipefail
exec node "$(cd "$(dirname "$0")" && pwd)/connect.mjs" cfo "$@"
