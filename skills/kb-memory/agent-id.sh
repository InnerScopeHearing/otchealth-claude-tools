#!/usr/bin/env bash
# agent-id.sh - resolve THIS session's kb-memory agent identity. SOURCED by kb-inject.sh + kb-recall.sh
# so the resolution logic lives in ONE place (add a repo->agent mapping here and it propagates fleet-wide
# via octools-sync). Sets: AG (resolved agent or empty), SRC (where it came from), FROM_MARKER (1 if an
# explicit marker/env set it), AUTOCLAIMED (1 if this call just auto-claimed from the repo name).
#
# Precedence (most-specific wins): session marker > repo .kb-agent > KB_AGENT env > repo-name AUTO-CLAIM.
#
# AUTO-CLAIM is the self-heal for the #1 silent-off cause (a missing identity marker makes capture AND
# recall do nothing while the session looks fine). It derives the agent from the repo basename, but ONLY
# for an ALLOWLIST of UNAMBIGUOUS single-agent repos, so it can NEVER mis-home a shared/ambiguous repo
# (those stay loud-OFF, the safe default). It writes the marker so later turns/sessions inherit it, and
# the caller surfaces a one-line correctable note. Disable entirely with KB_NO_AUTOCLAIM=1.
SESS_MARK="$HOME/.claude/.kb-agent"
REPO_MARK="${CLAUDE_PROJECT_DIR:-.}/.kb-agent"
_kb_read1() { head -n1 "$1" 2>/dev/null | tr -d '[:space:]'; }

AG=""; SRC=""; FROM_MARKER=0; AUTOCLAIMED=0
if [ -s "$SESS_MARK" ]; then AG="$(_kb_read1 "$SESS_MARK")"; SRC="session marker (~/.claude/.kb-agent)"; FROM_MARKER=1
elif [ -s "$REPO_MARK" ]; then AG="$(_kb_read1 "$REPO_MARK")"; SRC="repo .kb-agent"; FROM_MARKER=1
elif [ -n "${KB_AGENT:-}" ]; then AG="${KB_AGENT}"; SRC="env KB_AGENT"
fi

if [ -z "$AG" ] && [ -z "${KB_NO_AUTOCLAIM:-}" ]; then
  _kb_repo="$(basename "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null)"
  case "$_kb_repo" in
    # CTO owns the infra/toolkit/gateway repos.
    otchealth-cto|otchealth-claude-tools|otchealth-mcp-server) AG=cto ;;
    otchealth-ops) AG=coo ;;
    otchealth-legal) AG=clo ;;
    # The master developer (hive mind) owns every app/web repo (Matt directive 2026-06-23).
    fourvault|iheartest|aware-aural-rehab|aware-aural-rehab-ci|otchealth-companion|plantid-app|innerease|flatstick|fictionary|innd-website|otchealthmart-shopify) AG=developer ;;
    # Anything not listed (otchealth-exec, medreview [PHI], voice-agent-evals, ...) stays ambiguous ->
    # loud-OFF. NEVER guess for a repo that more than one agent might work in.
  esac
  if [ -n "$AG" ]; then
    SRC="auto-claimed from repo '$_kb_repo'"
    mkdir -p "$HOME/.claude" 2>/dev/null && printf '%s\n' "$AG" > "$SESS_MARK" 2>/dev/null && AUTOCLAIMED=1
  fi
fi
