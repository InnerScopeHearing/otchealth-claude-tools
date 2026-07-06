#!/usr/bin/env bash
# One-and-done: connect this Developer Claude Code Desktop session to the OTCHealth gateway on the
# developer lane, with auto-refresh before the 1h token expiry. Run on the Developer Desktop.
#   ./developer-gateway-connect.sh            # connect once + verify
#   ./developer-gateway-connect.sh --watch    # connect + auto-refresh
#   ./developer-gateway-connect.sh --verify-only
set -euo pipefail
exec node "$(cd "$(dirname "$0")" && pwd)/connect.mjs" developer "$@"
