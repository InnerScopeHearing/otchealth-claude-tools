#!/usr/bin/env bash
# One-and-done: connect this CTO Claude Code Desktop session to the OTCHealth gateway on the cto lane,
# with auto-refresh before the 1h token expiry. Run on the CTO Desktop.
#   ./cto-gateway-connect.sh            # connect once + verify
#   ./cto-gateway-connect.sh --watch    # connect + auto-refresh
#   ./cto-gateway-connect.sh --verify-only
set -euo pipefail
exec node "$(cd "$(dirname "$0")" && pwd)/connect.mjs" cto "$@"
