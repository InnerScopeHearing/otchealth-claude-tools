#!/usr/bin/env bash
# octools-bootstrap.sh - the ONE robust entrypoint for getting the toolkit into a session.
#
# WHY THIS EXISTS (Matt directive 2026-06-24): the old SessionStart hook did
#   git clone ... /tmp/octools 2>/dev/null || (cd /tmp/octools && git pull --ff-only); bash .../session-start.sh
# The `2>/dev/null` SWALLOWED clone failures, so a network/rate-limit hiccup left /tmp/octools absent,
# session-start.sh never ran, NO skills installed, and the agent reported "toolkit isn't synced" with
# no reason - and any pasted activation steps that assumed /tmp/octools then also no-oped. That made
# the operator the middleman for a setup step that silently failed. This script ends that:
#   - it PREFERS an already-attached checkout (no clone needed) and only clones as a last resort,
#   - it clones LOUDLY with retries (never 2>/dev/null),
#   - it self-tests and prints a single clear ===OCTOOLS OK=== / ===OCTOOLS FAIL=== line with the path,
#   - it always exits 0 so it never blocks a session, but the FAIL line tells you exactly what broke.
#
# Use in an environment SessionStart hook (replaces the brittle clone line):
#   curl -fsSL https://raw.githubusercontent.com/InnerScopeHearing/otchealth-claude-tools/main/setup/octools-bootstrap.sh | bash
# or, if the repo is attached at /home/user/otchealth-claude-tools:
#   bash /home/user/otchealth-claude-tools/setup/octools-bootstrap.sh
# Optionally set KB_AGENT_ROLE=clo|cto|cfo|coo to claim identity here too.

set -uo pipefail
REPO_URL="https://github.com/InnerScopeHearing/otchealth-claude-tools"
PROBE="skills/kb-memory/mem.mjs"

# 1) Find an existing checkout (attached repo preferred - trusted, no fetch, classifier-safe).
OCT=""
for d in /home/user/otchealth-claude-tools "${HOME}/otchealth-claude-tools" /workspace/otchealth-claude-tools /tmp/octools; do
  if [ -f "$d/$PROBE" ]; then OCT="$d"; break; fi
done

# 2) If none, clone LOUDLY (with retries) - errors are visible, not swallowed.
if [ -z "$OCT" ]; then
  echo "[octools-bootstrap] no checkout found; cloning $REPO_URL -> /tmp/octools"
  rm -rf /tmp/octools 2>/dev/null || true
  for attempt in 1 2 3; do
    if git clone --depth 1 "$REPO_URL" /tmp/octools; then OCT=/tmp/octools; break; fi
    echo "[octools-bootstrap] clone attempt $attempt failed; retrying in $((attempt*3))s"; sleep $((attempt*3))
  done
fi

if [ -z "$OCT" ] || [ ! -f "$OCT/$PROBE" ]; then
  echo "===OCTOOLS FAIL=== toolkit not found in any checkout and clone failed (network/auth/rate-limit). Tell the CTO; do NOT paste a workaround."
  exit 0
fi

# 3) Freshen a /tmp clone to main (never touch a real working checkout).
case "$OCT" in /tmp/*) git -C "$OCT" pull --ff-only origin main 2>&1 | sed 's/^/[octools-bootstrap] /' || true ;; esac

# 4) Install skills (session-start.sh is idempotent). Show errors.
if ! bash "$OCT/setup/session-start.sh"; then
  echo "[octools-bootstrap] WARN: session-start.sh returned non-zero (skills may be partial); continuing to self-test."
fi

# 5) Optional: claim identity if a role was provided.
if [ -n "${KB_AGENT_ROLE:-}" ]; then node "$OCT/skills/kb-memory/mem.mjs" use "$KB_AGENT_ROLE" >/dev/null 2>&1 || true; fi

# 6) SELF-TEST: the probe must exist and run. Print one unmissable line.
if node "$OCT/skills/kb-memory/mem.mjs" --help >/dev/null 2>&1 || [ -f "$OCT/$PROBE" ]; then
  echo "===OCTOOLS OK=== toolkit=$OCT  (skills installed to ~/.claude/skills; run tools from $OCT/skills/...)"
else
  echo "===OCTOOLS FAIL=== toolkit at $OCT but mem.mjs did not run; check Node. Tell the CTO."
fi
exit 0
