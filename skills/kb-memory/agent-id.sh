#!/usr/bin/env bash
# agent-id.sh - resolve THIS session's kb-memory agent identity. SOURCED by kb-inject.sh + kb-recall.sh
# + gateway-connect, so the resolution logic lives in ONE place (add a repo->agent mapping here and it
# propagates fleet-wide via octools-sync). Sets: AG (resolved agent or empty), SRC (where it came from),
# FROM_MARKER (1 if an explicit marker/env set it), AUTOCLAIMED (1 if this call just auto-claimed).
#
# Precedence (most-specific wins):
#   session marker > repo .kb-agent (walked up to the git root) > KB_AGENT env > repo AUTO-CLAIM.
#
# SHARED-ENV NOTE (Matt is on a consumer single-shared Claude Cloud env): per-session env vars and the
# ~/.claude session marker are GLOBAL, so the ONLY reliable per-agent discriminator is the repo's
# committed .kb-agent file. Hence we WALK UP from the session's dir to the git root to find it (so a
# session sitting in ANY subdir of the checkout still resolves its lane), and add a git-REMOTE fallback
# so a checkout folder named differently from the repo still auto-claims correctly.
SESS_MARK="$HOME/.claude/.kb-agent"
_kb_read1() { head -n1 "$1" 2>/dev/null | tr -d '[:space:]'; }

# Walk up from the project dir / pwd to the git root, returning the nearest committed .kb-agent path.
# Only honors an EXPLICIT committed marker (never a guess) -> safe for the privileged gateway lane connect.
_kb_find_repo_mark() {
  local d
  d="$(cd "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null && pwd)" || return 1
  while [ -n "$d" ] && [ "$d" != "/" ]; do
    if [ -s "$d/.kb-agent" ]; then printf '%s' "$d/.kb-agent"; return 0; fi
    if [ -d "$d/.git" ]; then break; fi   # do not cross above the repo root
    d="$(dirname "$d")"
  done
  return 1
}

# Shared repo->agent allowlist: UNAMBIGUOUS single-agent repos ONLY (used by BOTH the dir-basename and
# git-remote auto-claim). Ambiguous/multi-agent/PHI repos (otchealth-exec, medreview, voice-agent-evals,
# ...) are intentionally ABSENT -> they resolve ONLY via an explicit committed .kb-agent file, never a guess.
_kb_repo_to_agent() {
  case "$1" in
    otchealth-cto|otchealth-claude-tools|otchealth-mcp-server) echo cto ;;
    otchealth-ops) echo coo ;;
    otchealth-legal) echo clo ;;
    fourvault|iheartest|aware-aural-rehab|aware-aural-rehab-ci|otchealth-companion|plantid-app|innerease|flatstick|fictionary|innd-website|otchealthmart-shopify) echo developer ;;
  esac
}

AG=""; SRC=""; FROM_MARKER=0; AUTOCLAIMED=0
_REPO_MARK_FILE="$(_kb_find_repo_mark || true)"
if [ -s "$SESS_MARK" ]; then AG="$(_kb_read1 "$SESS_MARK")"; SRC="session marker (~/.claude/.kb-agent)"; FROM_MARKER=1
elif [ -n "$_REPO_MARK_FILE" ] && [ -s "$_REPO_MARK_FILE" ]; then AG="$(_kb_read1 "$_REPO_MARK_FILE")"; SRC="repo .kb-agent ($_REPO_MARK_FILE)"; FROM_MARKER=1
elif [ -n "${KB_AGENT:-}" ]; then AG="${KB_AGENT}"; SRC="env KB_AGENT"
fi

if [ -z "$AG" ] && [ -z "${KB_NO_AUTOCLAIM:-}" ]; then
  # 1) dir basename (original behavior)
  _kb_repo="$(basename "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null)"
  AG="$(_kb_repo_to_agent "$_kb_repo")"; _kb_detail="repo dir '$_kb_repo'"
  # 2) git remote fallback (handles a checkout folder named differently from the repo)
  if [ -z "$AG" ]; then
    _kb_remote="$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" config --get remote.origin.url 2>/dev/null)"
    if [ -n "$_kb_remote" ]; then
      _kb_rrepo="$(basename "${_kb_remote%.git}")"
      AG="$(_kb_repo_to_agent "$_kb_rrepo")"; _kb_detail="git remote '$_kb_rrepo'"
    fi
  fi
  if [ -n "$AG" ]; then
    SRC="auto-claimed from $_kb_detail"
    mkdir -p "$HOME/.claude" 2>/dev/null && printf '%s\n' "$AG" > "$SESS_MARK" 2>/dev/null && AUTOCLAIMED=1
  fi
fi
