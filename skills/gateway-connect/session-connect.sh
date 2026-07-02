#!/usr/bin/env bash
# session-connect.sh — AGENT ONBOARDING hook: on session start, auto-connect THIS agent's Claude Code
# session to the gateway on its own ring-scoped lane (if it has one). Wired into setup/session-start.sh.
#
# FAIL-OPEN + SAFE by construction: always exits 0 (never blocks session start); no-ops cleanly when
# (a) there's no `claude` CLI (web/job env, not a Desktop), (b) the agent has no gateway lane (--if-lane),
# or (c) the SA/creds aren't present. Resolves the agent via the shared kb-memory resolver (session
# marker > repo .kb-agent > KB_AGENT > repo auto-claim) so clo->clo lane, cfo->cfo lane, etc. One-shot
# mint+register (token is valid ~1h, covering a typical session); for a long-running session, run
# `clo-gateway-connect.sh --watch` to auto-refresh.
set +e
SELF_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"

# Only meaningful on a Desktop with the Claude CLI (that's where an MCP server gets registered).
command -v claude >/dev/null 2>&1 || { exit 0; }
# Need the SA to mint the lane token.
[ -n "${GCP_CLAUDE_DRIVER_SA_JSON:-}" ] || [ -f "${HOME}/.gcp_claude_driver_sa.json" ] || exit 0

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
