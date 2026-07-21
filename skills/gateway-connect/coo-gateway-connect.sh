#!/usr/bin/env bash
# One-and-done: connect this COO Claude Code Desktop session to the OTCHealth gateway on the coo lane,
# with auto-refresh before the 1h token expiry. Run on the COO Desktop.
#   ./coo-gateway-connect.sh            # connect once + verify
#   ./coo-gateway-connect.sh --watch    # connect + auto-refresh
#   ./coo-gateway-connect.sh --verify-only
set -euo pipefail
exec node "$(cd "$(dirname "$0")" && pwd)/connect.mjs" coo "$@"
