#!/usr/bin/env bash
# Fleet working-memory session integration. FAIL-SAFE by design: it must never break or block a
# session. Modes: session (SessionStart -> inject the agent's ledger), precompact (PreCompact ->
# remind to persist before the window compacts), stop (Stop -> remind to flush before ending).
#
# AGENT RESOLUTION (most-specific signal wins). A single shared KB_AGENT env var CANNOT label
# multiple agents that share ONE cloud environment (our case: CTO/CFO/CLO/COO sessions run in the
# same environment, so one KB_AGENT would mis-home all but one). So each SESSION declares itself:
#   1. ~/.claude/.kb-agent             session-local marker  (claim per session: `echo cfo > ~/.claude/.kb-agent`)
#   2. $CLAUDE_PROJECT_DIR/.kb-agent    repo default          (one app repo = one agent)
#   3. $KB_AGENT (env)                  shared-environment fallback
# A session marker / repo default WINS over the shared env var (and a mismatch is surfaced, not hidden).
# Set KB_MEMORY_OPTOUT=1 to silence the "memory off" notice for a session that genuinely wants none.
set +e
MODE="${1:-session}"

SESS_MARK="$HOME/.claude/.kb-agent"
REPO_MARK="${CLAUDE_PROJECT_DIR:-.}/.kb-agent"
read1() { head -n1 "$1" 2>/dev/null | tr -d '[:space:]'; }
AG=""; SRC=""; FROM_MARKER=0
if [ -s "$SESS_MARK" ]; then AG="$(read1 "$SESS_MARK")"; SRC="session marker (~/.claude/.kb-agent)"; FROM_MARKER=1
elif [ -s "$REPO_MARK" ]; then AG="$(read1 "$REPO_MARK")"; SRC="repo .kb-agent"; FROM_MARKER=1
elif [ -n "${KB_AGENT:-}" ]; then AG="${KB_AGENT}"; SRC="env KB_AGENT"
fi

MEM="${CLAUDE_PROJECT_DIR:-.}/skills/kb-memory/mem.mjs"
[ -f "$MEM" ] || MEM="$HOME/.claude/skills/kb-memory/mem.mjs"
[ -f "$MEM" ] || exit 0

case "$MODE" in
  session)
    if [ -z "$AG" ]; then
      # No agent resolved => working memory is OFF (no ledger recall, no write-through). This is the
      # silent-disable that bit the CFO. Warn LOUDLY. KB_MEMORY_OPTOUT=1 silences for a no-memory session.
      [ -n "${KB_MEMORY_OPTOUT:-}" ] && exit 0
      echo "================================ WORKING MEMORY IS OFF ================================"
      echo "No agent resolved for this session: no ~/.claude/.kb-agent marker, no repo .kb-agent, and"
      echo "KB_AGENT is unset. This session will NOT recall from or write to any persistent ledger, and"
      echo "long sessions compact and WILL silently forget facts, decisions, and corrections."
      echo "FIX (claim THIS session's identity -- works even when agents share ONE cloud environment):"
      echo "     mkdir -p ~/.claude && echo <role> > ~/.claude/.kb-agent     # e.g. cto, cfo, clo, coo"
      echo "   then continue. (Or set KB_AGENT in the environment only if it is dedicated to one agent.)"
      echo "(Intentionally running without memory? set KB_MEMORY_OPTOUT=1 to silence this notice.)"
      echo "======================================================================================"
      exit 0
    fi
    echo "===== WORKING MEMORY: ${AG} ledger  [via ${SRC}]  (SOURCE OF TRUTH - read before trusting recall) ====="
    if [ "$FROM_MARKER" = "1" ] && [ -n "${KB_AGENT:-}" ] && [ "$AG" != "${KB_AGENT}" ]; then
      echo "NOTE: the shared environment's KB_AGENT='${KB_AGENT}' but THIS session is '${AG}' (the marker wins)."
      echo "      Expected when agents share one environment; the per-session marker keeps each session correct."
    fi
    node "$MEM" tail --agent "$AG" --n 30 2>/dev/null || { echo "(kb-memory unavailable this session)"; exit 0; }
    echo ""
    echo "DISCIPLINE: write-through EVERY new fact/decision/correction with mem.mjs (--agent $AG) the moment it happens;"
    echo "recall before asserting any fact; if memory and the ledger disagree, THE LEDGER WINS."
    ;;
  precompact)
    echo "[kb-memory] CONTEXT IS ABOUT TO COMPACT (older turns get summarized; exact facts can be lost)."
    echo "Persist anything not yet in the ledger NOW so it survives:"
    echo "  node \"$MEM\" remember|decision|correct|pitfall \"...\" --agent ${AG:-<agent>}"
    ;;
  stop)
    [ -z "$AG" ] && exit 0
    echo "[kb-memory] Before ending: confirm new facts/decisions/corrections are written to the $AG ledger (mem.mjs ... --agent $AG)."
    ;;
esac
exit 0
