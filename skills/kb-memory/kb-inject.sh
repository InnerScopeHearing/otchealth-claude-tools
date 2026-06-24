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
DIR="$(dirname "$MEM")"   # kb-journal.mjs + reflect.mjs live alongside mem.mjs

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
    node "$MEM" pack --agent "$AG" 2>/dev/null || node "$MEM" tail --agent "$AG" --n 30 2>/dev/null || { echo "(kb-memory unavailable this session)"; exit 0; }
    echo ""
    echo "DISCIPLINE: write-through EVERY new fact/decision/correction with mem.mjs (--agent $AG) the moment it happens;"
    echo "recall before asserting any fact; if memory and the ledger disagree, THE LEDGER WINS."
    ;;
  precompact)
    # THE critical anti-forgetting moment: capture the full journal + distill durable facts to the
    # ledger BEFORE the window compacts. Automatic now (was just a reminder). Fail-open.
    INPUT="$(timeout 5 cat 2>/dev/null)"
    if [ -n "$AG" ]; then
      printf '%s' "$INPUT" | KB_AGENT="$AG" node "$DIR/kb-journal.mjs" capture --agent "$AG" >/dev/null 2>&1 || true
      printf '%s' "$INPUT" | KB_AGENT="$AG" node "$DIR/reflect.mjs" --commit --min-tools 4 >/dev/null 2>&1 || true
      echo "[kb-memory] PreCompact: journal captured + durable facts distilled to the $AG ledger before compaction."
    else
      echo "[kb-memory] CONTEXT IS ABOUT TO COMPACT and NO agent is set, so nothing is being captured. Set ~/.claude/.kb-agent (cto|cfo|clo|coo) to enable auto-capture."
    fi
    ;;
  stop)
    [ -z "$AG" ] && exit 0
    INPUT="$(timeout 5 cat 2>/dev/null)"
    # Tier-1: capture every input+output this turn (cheap, no LLM, always).
    printf '%s' "$INPUT" | KB_AGENT="$AG" node "$DIR/kb-journal.mjs" capture --agent "$AG" >/dev/null 2>&1 || true
    # Tier-2: distill to the ledger, THROTTLED to ~15 min (reflect spawns an LLM call; Stop fires every
    # turn). PreCompact + the nightly memory-librarian backstop anything a throttled window skips.
    THROT="$HOME/.claude/kb-journal/.last-reflect"
    NOW="$(date +%s 2>/dev/null || echo 0)"; LAST="$(stat -c %Y "$THROT" 2>/dev/null || echo 0)"
    if [ "$((NOW - LAST))" -gt 900 ]; then
      mkdir -p "$HOME/.claude/kb-journal" 2>/dev/null
      printf '%s' "$INPUT" | KB_AGENT="$AG" node "$DIR/reflect.mjs" --commit >/dev/null 2>&1 && touch "$THROT" || true
    fi
    ;;
esac
exit 0
