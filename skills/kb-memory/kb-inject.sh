#!/usr/bin/env bash
# Fleet working-memory session integration. FAIL-SAFE by design: it must never break or block a
# session. Modes: session (SessionStart -> inject the agent's ledger), precompact (PreCompact ->
# remind to persist before the window compacts), stop (Stop -> remind to flush before ending).
# Enable per agent by exporting KB_AGENT=cfo|clo|clo-personal|<name> in that session/repo.
set +e
MODE="${1:-session}"
AG="${KB_AGENT:-}"
MEM="${CLAUDE_PROJECT_DIR:-.}/skills/kb-memory/mem.mjs"
[ -f "$MEM" ] || MEM="$HOME/.claude/skills/kb-memory/mem.mjs"
[ -f "$MEM" ] || exit 0

case "$MODE" in
  session)
    [ -z "$AG" ] && exit 0
    echo "===== WORKING MEMORY: ${AG} ledger (SOURCE OF TRUTH - read before trusting recall) ====="
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
