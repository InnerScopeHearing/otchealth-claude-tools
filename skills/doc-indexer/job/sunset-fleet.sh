#!/usr/bin/env bash
# Tier-1 autonomous FLEET SUNSET (Azure Container Apps Job, zero Max-plan draw, no session-opening).
# Writes every agent's portable ring-safe handoff (_HANDOFF/<role>.md) from its already-durable ledger,
# so the whole fleet can SUNRISE on the other engine without the operator opening a single session.
# Fail-open per role; never blocks. The SA is provided via the job's sab64 secret (same as the librarians).
set +e
cd /app 2>/dev/null || cd "$(dirname "$0")/../../.." || exit 0
if [ -n "${SAB64:-}" ]; then export GCP_CLAUDE_DRIVER_SA_JSON="$(printf '%s' "$SAB64" | base64 -d 2>/dev/null)"; fi
echo "[sunset-fleet] $(date -u +%FT%TZ) starting fleet sunset"
node skills/sunset-protocol/protocol.mjs sunset-fleet ${SUNSET_ROLES:+--roles "$SUNSET_ROLES"}
echo "[sunset-fleet] done"
exit 0
