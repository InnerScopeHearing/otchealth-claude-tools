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
      # silent-disable that bit the CFO. Warn LOUDLY. KB_MEMORY_OPTOUT=1 silences for a no-memory session
      # (an explicit, accepted opt-out is not an anomaly, so it silences the durable beacon below too).
      [ -n "${KB_MEMORY_OPTOUT:-}" ] && exit 0
      # W1-5 KB_AGENT PROPAGATION FIX: the stdout banner below only reaches a human reading THIS exact
      # output at THIS exact moment -- it leaves no durable trace (there's no agent identity to write a
      # ledger entry OR a memory_beacon under). Make it CANARY-DETECTABLE: fire a best-effort, throttled
      # kb_agent_unset PostHog event so "a session ran with memory silently off" is queryable later, not
      # just an eyeball-only banner. Backgrounded + fail-open; never delays or blocks the session.
      [ -f "$DIR/agent-unset-beacon.mjs" ] && (node "$DIR/agent-unset-beacon.mjs" --reason "session start: no marker, no repo default, KB_AGENT unset" >/dev/null 2>&1 &) || true
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
    # WAKE FIRST-DUTY — CROSS-AGENT INBOUND. Another exec agent may have written on THIS agent's ledger
    # (an info hand-off or a suggested correction, always attributed by=<writer>, append-only). Surface it
    # at wake with an explicit RECONCILE directive, so the first thing this session does is take in its own
    # ledger (the pack above) and then ingest + reconcile what other agents left. Off the hot path, fail-open.
    INB="$(timeout 12 node "$MEM" inbound --agent "$AG" 2>/dev/null)"
    if printf '%s' "$INB" | grep -q '\[by '; then
      echo ""
      echo "📥 WAKE FIRST-DUTY — INBOUND FROM OTHER AGENTS on your ($AG) ledger:"
      printf '%s\n' "$INB"
      echo "ACTION (do this now): review each note; fold anything valid into YOUR ledger with mem.mjs (--agent $AG);"
      echo "       then ACK so it stops re-surfacing:  node $MEM reconcile --agent $AG"
    fi
    # Warm the hot-path semantic cred-cache (read-only query key) in the background, so the per-prompt
    # semantic tier is ready without ever resolving Secret Manager inline on the prompt path. Fail-open.
    (node "$MEM" sem-refresh >/dev/null 2>&1 &) || true
    ;;
  precompact)
    # THE critical anti-forgetting moment: capture the full journal + distill durable facts to the
    # ledger BEFORE the window compacts. Automatic now (was just a reminder). Fail-open.
    INPUT="$(timeout 5 cat 2>/dev/null)"
    # CBP-1 (Checkpoint Bridge Protocol, 2026-07-05): best-effort session_id extraction from the
    # already-captured hook stdin payload (reuse $INPUT, never re-read stdin). Never crash the hook.
    SESSION_ID="$(printf '%s' "$INPUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const o=JSON.parse(d||"{}");process.stdout.write(String(o.session_id||""))}catch(e){}})' 2>/dev/null || true)"
    if [ -n "$AG" ]; then
      export KB_SYNC_SOURCE=precompact
      export KB_SESSION_ID="$SESSION_ID"
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
    # CBP-1 (Checkpoint Bridge Protocol, 2026-07-05): best-effort session_id extraction from the
    # already-captured hook stdin payload (reuse $INPUT, never re-read stdin). Never crash the hook.
    SESSION_ID="$(printf '%s' "$INPUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const o=JSON.parse(d||"{}");process.stdout.write(String(o.session_id||""))}catch(e){}})' 2>/dev/null || true)"
    export KB_SESSION_ID="$SESSION_ID"
    # Tier-1: capture every input+output this turn (cheap, no LLM, always).
    printf '%s' "$INPUT" | KB_AGENT="$AG" node "$DIR/kb-journal.mjs" capture --agent "$AG" >/dev/null 2>&1 || true
    # Tier-2: distill to the ledger, THROTTLED to ~15 min (reflect spawns an LLM call; Stop fires every
    # turn). PreCompact + the nightly memory-librarian backstop anything a throttled window skips.
    #
    # CBP-1a (tool-call-count OR-trigger, 2026-07-05): fire ALSO if ~100 tool calls have happened
    # since the last checkpoint, using the SAME shared counter file as periodic-check) above (one
    # "activity since last checkpoint" count, reset by whichever hook fires first — avoids two
    # independent counters drifting out of sync). This is a PROXY FOR ACTIVITY VOLUME, NOT a token
    # count — Claude Code's JSONL token-usage fields are known-unreliable (see
    # anthropics/claude-code#25941, #27361, #28197), so we count tool calls, not tokens.
    THROT="$HOME/.claude/kb-journal/.last-reflect"
    CALLCOUNT="$HOME/.claude/kb-journal/.checkpoint-call-count"
    mkdir -p "$HOME/.claude/kb-journal" 2>/dev/null
    NOW="$(date +%s 2>/dev/null || echo 0)"; LAST="$(stat -c %Y "$THROT" 2>/dev/null || echo 0)"
    ELAPSED_DUE=0; [ "$((NOW - LAST))" -gt 900 ] && ELAPSED_DUE=1
    CALLS="$(cat "$CALLCOUNT" 2>/dev/null || echo 0)"
    case "$CALLS" in *[!0-9]*|"") CALLS=0 ;; esac
    CALLS_DUE=0; [ "$CALLS" -ge 100 ] && CALLS_DUE=1
    if [ "$ELAPSED_DUE" -eq 1 ] || [ "$CALLS_DUE" -eq 1 ]; then
      export KB_SYNC_SOURCE=stop
      printf '%s' "$INPUT" | KB_AGENT="$AG" node "$DIR/reflect.mjs" --commit >/dev/null 2>&1 && { touch "$THROT"; printf '%s' 0 > "$CALLCOUNT" 2>/dev/null; } || true
    fi
    # Emit the memory-health beacon to PostHog (self-throttled ~10min, BACKGROUNDED so it never blocks
    # the Stop hook). This is the real-time signal source for the operator dashboard + the auto-medic.
    [ -f "$DIR/beacon.mjs" ] && (node "$DIR/beacon.mjs" --agent "$AG" >/dev/null 2>&1 &) || true
    ;;
  periodic-check)
    # CBP-1 (Checkpoint Bridge Protocol, 2026-07-05): PostToolUse safety net for long single-turn
    # tool-call sequences that never hit Stop naturally. Cheap stat/date elapsed-time check, NO
    # network/LLM call on the common (not-yet-due) path — only fires the capture+reflect sequence
    # once per 900s (15 min), matching the existing Stop-hook throttle. Fail-open throughout.
    #
    # CBP-1a (tool-call-count OR-trigger, 2026-07-05): this fires on EVERY PostToolUse event, so we
    # also maintain a cheap call-count file as a SECOND, independent trigger alongside the 900s
    # elapsed-time backstop above. ~100 tool calls since last checkpoint is a PROXY FOR ACTIVITY
    # VOLUME, NOT a token count — Claude Code's JSONL token-usage fields are known-unreliable (see
    # anthropics/claude-code#25941, #27361, #28197: usage fields off by 4x-170x in some cases), so we
    # count tool calls instead of attempting to derive real token usage. The counter file is SHARED
    # with the stop) case below (one "activity since last checkpoint" counter, reset by whichever
    # trigger fires first) so the two hooks can never drift out of sync with independent counts.
    if [ -z "$AG" ]; then
      # W1-5 KB_AGENT PROPAGATION FIX: this used to be a SILENT exit -- the exact gap for a long
      # single-turn (or auto-mode) session that never resolves an identity: it would run for however
      # long with memory off and get NOT ONE reminder past the SessionStart banner (easy to scroll past,
      # and this hook fires far more often, every ~15min/100 tool-calls, than SessionStart's one-shot).
      # Re-fire the SAME throttled, durable beacon SessionStart uses (its own internal throttle -- default
      # 30 min -- makes calling it on every periodic-check cheap/safe; KB_MEMORY_OPTOUT is honored the
      # same way). Still exits 0 immediately after: there is no agent identity to capture/reflect under.
      if [ -z "${KB_MEMORY_OPTOUT:-}" ] && [ -f "$DIR/agent-unset-beacon.mjs" ]; then
        (node "$DIR/agent-unset-beacon.mjs" --reason "periodic-check: still no agent resolved mid-session" >/dev/null 2>&1 &) || true
      fi
      exit 0
    fi
    PTHROT="$HOME/.claude/kb-journal/.last-periodic-checkpoint"
    CALLCOUNT="$HOME/.claude/kb-journal/.checkpoint-call-count"
    mkdir -p "$HOME/.claude/kb-journal" 2>/dev/null
    # Cheap read-increment-write, no parsing of hook payload needed. Fail-open: a bad/missing counter
    # file is just treated as zero, never blocks the hook.
    CALLS="$(cat "$CALLCOUNT" 2>/dev/null || echo 0)"
    case "$CALLS" in *[!0-9]*|"") CALLS=0 ;; esac
    CALLS=$((CALLS + 1))
    printf '%s' "$CALLS" > "$CALLCOUNT" 2>/dev/null || true
    NOW="$(date +%s 2>/dev/null || echo 0)"; LAST="$(stat -c %Y "$PTHROT" 2>/dev/null || echo 0)"
    ELAPSED_DUE=0; [ -f "$PTHROT" ] || ELAPSED_DUE=1; [ "$((NOW - LAST))" -ge 900 ] && ELAPSED_DUE=1
    CALLS_DUE=0; [ "$CALLS" -ge 100 ] && CALLS_DUE=1
    if [ "$ELAPSED_DUE" -eq 0 ] && [ "$CALLS_DUE" -eq 0 ]; then
      exit 0
    fi
    touch "$PTHROT" 2>/dev/null
    printf '%s' 0 > "$CALLCOUNT" 2>/dev/null || true
    INPUT="$(timeout 5 cat 2>/dev/null)"
    export KB_SYNC_SOURCE=periodic
    printf '%s' "$INPUT" | KB_AGENT="$AG" node "$DIR/kb-journal.mjs" capture --agent "$AG" >/dev/null 2>&1 || true
    printf '%s' "$INPUT" | KB_AGENT="$AG" node "$DIR/reflect.mjs" --commit --min-tools 4 >/dev/null 2>&1 || true
    ;;
esac
exit 0
