#!/usr/bin/env bash
# kb-recall.sh - per-prompt WORKING-MEMORY injection (UserPromptSubmit hook). The READ-BACK half of
# the anti-forgetting loop. kb-inject writes memory OUTWARD (capture + distill at PreCompact/Stop);
# this reads it BACK INTO CONTEXT on EVERY prompt, including the first prompt after a compaction, so a
# just-compacted agent gets its durable facts back with zero action. This closes the open edge that
# caused "forgets what happened 20 minutes ago": before this, memory was injected only once, at
# SessionStart, and a mid-session compaction never re-fired that read.
#
# DESIGN (the critic's blockers are honored here):
#  - FAIL-OPEN: set +e, always exit 0, time-bounded; a hook can never block or break a prompt.
#  - LLM-FREE + LOCAL-CACHE-FIRST: `mem.mjs pack` reads a local write-through cache, refreshing from
#    Azure only on a throttle, so there is no network call on the typical prompt (no per-turn latency).
#  - RING-CORRECT: pack hard-excludes other lanes' MNPI/PHI and never reads the shared feed for a
#    privileged (clo-personal) lane. The agent's OWN lane is its own ring.
#  - NO SHELL INJECTION: the prompt text is read by mem.mjs from THIS hook's stdin JSON (--stdin-json);
#    it is NEVER interpolated into a shell command.
#  - NO IDENTITY GUESSING: resolves the agent from the same explicit markers as kb-inject; it does NOT
#    guess-and-persist a role from the repo name (that would risk silently mis-homing a shared env).
# Silence for a deliberately memory-less session with KB_MEMORY_OPTOUT=1.
set +e
[ -n "${KB_MEMORY_OPTOUT:-}" ] && exit 0

# --- agent resolution: shared resolver (session marker > repo .kb-agent > KB_AGENT > repo auto-claim) ---
SELF_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
if [ -f "$SELF_DIR/agent-id.sh" ]; then
  . "$SELF_DIR/agent-id.sh"
else
  # back-compat fallback for installs predating agent-id.sh (no auto-claim).
  SESS_MARK="$HOME/.claude/.kb-agent"; REPO_MARK="${CLAUDE_PROJECT_DIR:-.}/.kb-agent"; AG=""; AUTOCLAIMED=0
  [ -s "$SESS_MARK" ] && AG="$(head -n1 "$SESS_MARK" 2>/dev/null | tr -d '[:space:]')"
  [ -z "$AG" ] && [ -s "$REPO_MARK" ] && AG="$(head -n1 "$REPO_MARK" 2>/dev/null | tr -d '[:space:]')"
  [ -z "$AG" ] && AG="${KB_AGENT:-}"
fi

# No agent -> one-line beacon so it is VISIBLE (not a silent off, not a multi-line nag every turn).
if [ -z "$AG" ]; then
  echo "MEMORY: OFF (no agent this session) -> claim it once: mkdir -p ~/.claude && echo <role> > ~/.claude/.kb-agent   (cto|cfo|clo|coo|developer)"
  exit 0
fi
# If we just auto-claimed from the repo name, say so once (correctable). Prints only the turn it claims;
# next turn the marker exists, so it resolves silently via the marker.
[ "${AUTOCLAIMED:-0}" = "1" ] && echo "MEMORY: auto-claimed agent='$AG' from this repo's name (no marker was set). If that is wrong: echo <role> > ~/.claude/.kb-agent"

MEM="${CLAUDE_PROJECT_DIR:-.}/skills/kb-memory/mem.mjs"
[ -f "$MEM" ] || MEM="$HOME/.claude/skills/kb-memory/mem.mjs"
[ -f "$MEM" ] || exit 0

# Inject the per-prompt memory block. mem.mjs reads the prompt from this hook's stdin JSON via
# --stdin-json (safe parse, no shell interpolation). Time-bounded so a slow throttled refresh can
# never stall the prompt; on any failure, emit a one-line note and continue (the ledger is intact).
timeout 12 node "$MEM" pack --agent "$AG" --stdin-json 2>/dev/null \
  || echo "MEMORY: recall unavailable this turn (ledger intact; run: node $MEM tail --agent $AG)"
exit 0
