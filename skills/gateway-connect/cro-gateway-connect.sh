#!/usr/bin/env bash
# One-and-done: connect this CRO Claude Code Desktop session to the OTCHealth gateway on the cro lane,
# with auto-refresh before the 1h token expiry. Run on the CRO Desktop.
#   ./cro-gateway-connect.sh            # connect once + verify
#   ./cro-gateway-connect.sh --watch    # connect + auto-refresh
#   ./cro-gateway-connect.sh --verify-only
set -euo pipefail
exec node "$(cd "$(dirname "$0")" && pwd)/connect.mjs" cro "$@"
