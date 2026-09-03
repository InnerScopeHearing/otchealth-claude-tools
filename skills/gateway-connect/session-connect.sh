#!/usr/bin/env bash
# session-connect.sh — AGENT ONBOARDING hook: on session start, auto-connect THIS agent's Claude Code
# session to the gateway on its own ring-scoped lane (if it has one). Wired into setup/session-start.sh.
#
# FAIL-OPEN + SAFE by construction: always exits 0 (never blocks session start); no-ops cleanly when
# (a) there's no `claude` CLI (web/job env, not a Desktop), (b) the agent has no gateway lane (--if-lane),
# or (c) the SA/creds aren't present. Resolves the agent via the shared kb-memory resolver (session
# marker > repo .kb-agent > KB_AGENT > repo auto-claim) so clo->clo lane, cfo->cfo lane, etc. One-shot
# mint+register (token is valid 24h, OAUTH_CC_TTL_SECONDS on the gateway, covering a typical session). Registration also sets a dynamic
# `headersHelper` (headers-helper.mjs) by default, so once the workspace is trusted Claude Code
# re-mints on its own past that window with no further action here; GATEWAY_CONNECT_HEADERS_HELPER=0
# reverts to the old static-header-only registration. Either way, `clo-gateway-connect.sh --watch`
# remains available for a long-running session or a client that doesn't support headersHelper.
set +e
SELF_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"

# Only meaningful on a Desktop with the Claude CLI (that's where an MCP server gets registered).
command -v claude >/dev/null 2>&1 || { exit 0; }
# Need SOME credential to mint the lane token. connect.mjs's laneCreds() resolves lane creds via
# kvSecret(): Key Vault (managed identity -> AZURE_SP_* -> az-CLI/OIDC) THEN, on failure, the AWS SSM
# mirror -- see kb-memory/azure-secret.mjs's own header. Accept any of those; a still-present GCP SA is
# honored last, purely as harmless legacy.
#
# AWS/OTC_AWS_* CHECK ADDED 2026-08-18 (the agent-seat credential bootstrap fix): this gate used to
# check ONLY the Azure/GCP paths, so a seat with NO Azure creds but a WORKING AWS credential (via the
# SSM mirror connect.mjs's underlying kvSecret() already supports) silently `exit 0`d here and never
# even attempted connect.mjs -- the exact "still silently no-ops on a seat with a valid credential"
# failure this fix exists to close, on a DIFFERENT script than the one the original bug report named.
# The "prox"-prefix check mirrors aws-secret.mjs's awsCreds() guard against the sandbox proxy's
# placeholder key; without it this gate would report "present" for a credential that cannot sign
# anything, and connect.mjs would then fail anyway two steps later -- silence traded for a slower silence.
_kb_gw_aws_ok() {
  [ -n "${AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:-}" ] && return 0
  [ -n "${AWS_CONTAINER_CREDENTIALS_FULL_URI:-}" ] && return 0
  if [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] \
     && ! printf '%s' "${AWS_ACCESS_KEY_ID}" | grep -qi '^prox'; then return 0; fi
  if [ -n "${OTC_AWS_ACCESS_KEY_ID:-}" ] && [ -n "${OTC_AWS_SECRET_ACCESS_KEY:-}" ] \
     && ! printf '%s' "${OTC_AWS_ACCESS_KEY_ID}" | grep -qi '^prox'; then return 0; fi
  return 1
}
{ [ -n "${AZURE_SP_CLIENT_ID:-}" ] && [ -n "${AZURE_SP_CLIENT_SECRET:-}" ] && [ -n "${AZURE_SP_TENANT_ID:-}" ]; } \
  || { [ -n "${IDENTITY_ENDPOINT:-}" ] && [ -n "${IDENTITY_HEADER:-}" ]; } \
  || command -v az >/dev/null 2>&1 \
  || _kb_gw_aws_ok \
  || [ -n "${GCP_CLAUDE_DRIVER_SA_JSON:-}" ] || [ -f "${HOME}/.gcp_claude_driver_sa.json" ] \
  || exit 0

# Resolve this agent (reuse the kb-memory resolver; do NOT auto-claim here — an unidentified session
# should not guess a privileged lane).
AG=""
if [ -f "${SELF_DIR}/../kb-memory/agent-id.sh" ]; then
  KB_NO_AUTOCLAIM=1 . "${SELF_DIR}/../kb-memory/agent-id.sh" 2>/dev/null
fi
[ -z "$AG" ] && AG="${KB_AGENT:-}"
[ -z "$AG" ] && { echo "[gateway-connect] no agent identity this session; skipping gateway auto-connect."; exit 0; }

# Connect the agent's lane if one exists (--if-lane no-ops for agents without a gateway lane).
timeout 45 node "${SELF_DIR}/connect.mjs" "$AG" --if-lane 2>&1 | sed 's/^/[gateway-connect] /'
exit 0
