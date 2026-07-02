#!/usr/bin/env bash
# One-and-done: connect this CLO Claude Code Desktop session to the OTCHealth gateway on the clo lane,
# and keep it connected (auto re-mint before the 1h token expiry). Run on the CLO Desktop.
#   ./clo-gateway-connect.sh            # connect once + verify
#   ./clo-gateway-connect.sh --watch    # connect + auto-refresh (leave running / nohup / cron)
#   ./clo-gateway-connect.sh --verify-only   # prove the lane works WITHOUT touching your MCP config
set -euo pipefail
exec node "$(cd "$(dirname "$0")" && pwd)/connect.mjs" clo "$@"
