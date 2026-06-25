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

# Agent resolution via the shared resolver (session marker > repo .kb-agent > KB_AGENT > repo auto-claim).
SELF_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
if [ -f "$SELF_DIR/agent-id.sh" ]; then
  . "$SELF_DIR/agent-id.sh"
else
  # back-compat fallback for installs predating agent-id.sh (no auto-claim).
  SESS_MARK="$HOME/.claude/.kb-agent"; REPO_MARK="${CLAUDE_PROJECT_DIR:-.}/.kb-agent"
  read1() { head -n1 "$1" 2>/dev/null | tr -d '[:space:]'; }
  AG=""; SRC=""; FROM_MARKER=0; AUTOCLAIMED=0
  if [ -s "$SESS_MARK" ]; then AG="$(read1 "$SESS_MARK")"; SRC="session marker (~/.claude/.kb-agent)"; FROM_MARKER=1
  elif [ -s "$REPO_MARK" ]; then AG="$(read1 "$REPO_MARK")"; SRC="repo .kb-agent"; FROM_MARKER=1
  elif [ -n "${KB_AGENT:-}" ]; then AG="${KB_AGENT}"; SRC="env KB_AGENT"
  fi
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
    [ "${AUTOCLAIMED:-0}" = "1" ] && echo "NOTE: identity '${AG}' was auto-claimed from the repo name (no marker was set). If this session is a different agent, run: echo <role> > ~/.claude/.kb-agent"
    if [ "$FROM_MARKER" = "1" ] && [ -n "${KB_AGENT:-}" ] && [ "$AG" != "${KB_AGENT}" ]; then
      echo "NOTE: the shared environment's KB_AGENT='${KB_AGENT}' but THIS session is '${AG}' (the marker wins)."
      echo "      Expected when agents share one environment; the per-session marker keeps each session correct."
    fi
    node "$MEM" pack --agent "$AG" 2>/dev/null || node "$MEM" tail --agent "$AG" --n 30 2>/dev/null || { echo "(kb-memory unavailable this session)"; exit 0; }
    echo ""
    echo "DISCIPLINE: write-through EVERY new fact/decision/correction with mem.mjs (--agent $AG) the moment it happens;"
    echo "recall before asserting any fact; if memory and the ledger disagree, THE LEDGER WINS."
    # Surface any pending fleet-medic SELF-HEAL directive for this agent (auto-dispatched when the medic
    # saw this agent's memory go dark). Shows once at session start, then auto-clears. Off the hot path,
    # fail-open. THIS is how the auto-dispatched fix reaches the agent.
    MEDIC="$DIR/../fleet-medic/medic.mjs"
    [ -f "$MEDIC" ] && timeout 12 node "$MEDIC" check --agent "$AG" 2>/dev/null || true
    # Surface any pending DIRECTED dispatches for this agent (another agent handed it a message/task).
    # Auto-delivered here so a human never relays between agents. Shows once, then acks. Fail-open.
    DISPATCH="$DIR/../fleet-dispatch/dispatch.mjs"
    [ -f "$DISPATCH" ] && timeout 12 node "$DISPATCH" check --agent "$AG" 2>/dev/null || true
    # Warm the hot-path semantic cred-cache (read-only query key) in the background, so the per-prompt
    # semantic tier is ready without ever resolving Secret Manager inline on the prompt path. Fail-open.
    (node "$MEM" sem-refresh >/dev/null 2>&1 &) || true
    ;;
  precompact)
    # THE critical anti-forgetting moment: capture the full journal + distill durable facts to the
    # ledger BEFORE the window compacts. Automatic now (was just a reminder). Fail-open.
    INPUT="$(timeout 5 cat 2>/dev/null)"
    if [ -n "$AG" ]; then
      printf '%s' "$INPUT" | KB_AGENT="$AG" node "$DIR/kb-journal.mjs" capture --agent "$AG" >/dev/null 2>&1 || true
      printf '%s' "$INPUT" | KB_AGENT="$AG" node "$DIR/reflect.mjs" --commit --min-tools 4 --prefer-fallback >/dev/null 2>&1 || true
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
    # Emit the memory-health beacon to PostHog (self-throttled ~10min, BACKGROUNDED so it never blocks
    # the Stop hook). This is the real-time signal source for the operator dashboard + the auto-medic.
    [ -f "$DIR/beacon.mjs" ] && (node "$DIR/beacon.mjs" --agent "$AG" >/dev/null 2>&1 &) || true
    ;;
esac
exit 0
