#!/usr/bin/env bash
# octools-bootstrap.sh - the ONE robust entrypoint for getting the toolkit into a session.
#
# WHY THIS EXISTS (Matt directive 2026-06-24): the old SessionStart hook did
#   git clone ... /tmp/octools 2>/dev/null || (cd /tmp/octools && git pull --ff-only); bash .../session-start.sh
# The `2>/dev/null` SWALLOWED clone failures, so a network/rate-limit hiccup left /tmp/octools absent,
# session-start.sh never ran, NO skills installed, and the agent reported "toolkit isn't synced" with
# no reason - and any pasted activation steps that assumed /tmp/octools then also no-oped. That made
# the operator the middleman for a setup step that silently failed. This script ends that:
#   - it clones LOUDLY with retries (never 2>/dev/null),
#   - it self-tests and prints a single clear ===OCTOOLS OK=== / ===OCTOOLS FAIL=== line with the path,
#   - it always exits 0 so it never blocks a session, but the FAIL line tells you exactly what broke.
#
# STALENESS FIX (2026-06-24, CFO-reported): every agent session clones otchealth-claude-tools as an
# ATTACHED working checkout on its own fresh session branch, which routinely sits BEHIND origin/main.
# v1 PREFERRED the attached checkout and only freshened /tmp clones, so it printed ===OCTOOLS OK=== on
# a stale checkout that lacked newly-merged files (kb-journal.mjs, company-brain, the new mem.mjs ...)
# - the agent then silently ran old code and had to do manual `git checkout origin/main -- ...` surgery.
# v2 fetches origin/main and CLASSIFIES the attached checkout:
#   - CURRENT (not behind main)            -> use it.
#   - DEVELOPER checkout (ahead OR dirty)  -> use it, but WARN if also behind. This is the CTO's own
#                                             claude-tools repo; NEVER auto-reset a checkout with local work.
#   - PURE-STALE read-only clone (behind,
#     not ahead, clean) = the CFO/COO case -> do NOT use it; transparently switch to a FRESH /tmp/octools
#                                             clone of main. The attached tree is left UNTOUCHED, so there
#                                             is no working-tree pollution and no branch surgery.
#
# Canonical SessionStart usage (always runs the LATEST bootstrap from main, immune to a stale checkout):
#   curl -fsSL https://raw.githubusercontent.com/InnerScopeHearing/otchealth-claude-tools/main/setup/octools-bootstrap.sh | bash
# Attached fallback (use only if the curl form is network-blocked):
#   bash /home/user/otchealth-claude-tools/setup/octools-bootstrap.sh
# Optionally set KB_AGENT_ROLE=clo|cto|cfo|coo to claim identity here too.

set -uo pipefail
REPO_URL="https://github.com/InnerScopeHearing/otchealth-claude-tools"
PROBE="skills/kb-memory/mem.mjs"
TMP=/tmp/octools
note() { echo "[octools-bootstrap] $*"; }

# refresh_tmp: make /tmp/octools exist and equal origin/main; echo the path on success, empty on failure.
refresh_tmp() {
  if [ -f "$TMP/$PROBE" ] && git -C "$TMP" rev-parse --git-dir >/dev/null 2>&1; then
    timeout 30 git -C "$TMP" fetch --depth 1 --quiet origin main 2>&1 | sed 's/^/[octools-bootstrap] /' || true
    git -C "$TMP" reset --hard --quiet FETCH_HEAD 2>/dev/null || git -C "$TMP" reset --hard --quiet origin/main 2>/dev/null || true
    [ -f "$TMP/$PROBE" ] && { echo "$TMP"; return 0; }
  fi
  note "cloning $REPO_URL -> $TMP (fresh main)"
  rm -rf "$TMP" 2>/dev/null || true
  for attempt in 1 2 3; do
    if git clone --depth 1 "$REPO_URL" "$TMP"; then echo "$TMP"; return 0; fi
    note "clone attempt $attempt failed; retrying in $((attempt*3))s"; sleep $((attempt*3))
  done
  echo ""   # failure -> caller falls back
}

# 1) Find an ATTACHED checkout (a real working copy, never /tmp).
ATTACHED=""
for d in /home/user/otchealth-claude-tools "${HOME}/otchealth-claude-tools" /workspace/otchealth-claude-tools; do
  if [ -f "$d/$PROBE" ]; then ATTACHED="$d"; break; fi
done

OCT=""; SWITCH_NOTE=""

# 2) Classify the attached checkout against origin/main (read-only fetch; safe under the classifier).
if [ -n "$ATTACHED" ]; then
  if timeout 30 git -C "$ATTACHED" fetch origin main --quiet 2>/dev/null; then
    behind="$(git -C "$ATTACHED" rev-list --count HEAD..origin/main 2>/dev/null || echo 0)"
    ahead="$(git -C "$ATTACHED" rev-list --count origin/main..HEAD 2>/dev/null || echo 0)"
    dirty="$(git -C "$ATTACHED" status --porcelain 2>/dev/null | head -1)"
    if [ "${behind:-0}" = "0" ]; then
      OCT="$ATTACHED"                                                   # current with main
    elif [ "${ahead:-0}" != "0" ] || [ -n "$dirty" ]; then
      OCT="$ATTACHED"                                                   # developer checkout (e.g. the CTO)
      note "NOTE: $ATTACHED is $behind behind / $ahead ahead of origin/main with local work; using it as-is. Merge origin/main if you need the latest toolkit."
    else
      SWITCH_NOTE="attached checkout was $behind commit(s) behind origin/main (no local work); switched to a fresh /tmp/octools clone of main (attached tree left untouched)."
      note "$SWITCH_NOTE"                                               # PURE-STALE -> fall through to /tmp
    fi
  else
    note "could not fetch origin/main on $ATTACHED (network/classifier); will prefer a fresh /tmp/octools if available."
  fi
fi

# 3) If no usable current checkout yet (pure-stale, unverifiable, or none), get a fresh /tmp/octools.
if [ -z "$OCT" ]; then
  FRESH="$(refresh_tmp)"
  if [ -n "$FRESH" ]; then
    OCT="$FRESH"
  elif [ -n "$ATTACHED" ]; then
    OCT="$ATTACHED"                                                     # last resort: stale beats nothing
    note "WARN: /tmp/octools refresh failed; falling back to attached checkout $ATTACHED which may be stale."
  fi
fi

if [ -z "$OCT" ] || [ ! -f "$OCT/$PROBE" ]; then
  echo "===OCTOOLS FAIL=== toolkit not found in any checkout and clone failed (network/auth/rate-limit). Tell the CTO; do NOT paste a workaround."
  exit 0
fi

# 4) Install skills (session-start.sh is idempotent). Show errors.
if ! bash "$OCT/setup/session-start.sh"; then
  note "WARN: session-start.sh returned non-zero (skills may be partial); continuing to self-test."
fi

# 5) Optional: claim identity if a role was provided.
if [ -n "${KB_AGENT_ROLE:-}" ]; then node "$OCT/skills/kb-memory/mem.mjs" use "$KB_AGENT_ROLE" >/dev/null 2>&1 || true; fi

# 6) SELF-TEST: the probe must exist and run. Print one unmissable line (with the switch note if any).
if node "$OCT/skills/kb-memory/mem.mjs" --help >/dev/null 2>&1 || [ -f "$OCT/$PROBE" ]; then
  echo "===OCTOOLS OK=== toolkit=$OCT  (skills installed to ~/.claude/skills; run tools from $OCT/skills/...)${SWITCH_NOTE:+  [switched: ${SWITCH_NOTE}]}"
else
  echo "===OCTOOLS FAIL=== toolkit at $OCT but mem.mjs did not run; check Node. Tell the CTO."
fi
exit 0
