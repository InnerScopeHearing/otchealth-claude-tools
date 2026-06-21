#!/usr/bin/env bash
# octools-version: tell an agent whether its INSTALLED toolkit skills are current with origin/main.
#
# Why this exists: session-start.sh force-syncs the toolkit to origin/main and reinstalls every skill
# AT SESSION START. A long-running session that began BEFORE a fix was merged keeps the OLD skills and
# can silently run stale code (this bit the CFO, and made PlantID's focus-group loop collapse to zeros).
# Run this anytime to know if you are behind; if stale, refresh and the new code is live.
#
# Usage:  bash /tmp/octools/setup/octools-version.sh
# Exit:   0 = current (or offline/unknown), 2 = STALE (you should refresh)
set -u
TOOLS_DIR="${OCTOOLS_DIR:-/tmp/octools}"
MARKER="${HOME}/.claude/.octools-installed-commit"

installed="$(cat "$MARKER" 2>/dev/null || true)"
if ! git -C "$TOOLS_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  echo "octools-version: no toolkit git checkout at $TOOLS_DIR (set OCTOOLS_DIR?). Cannot check."
  exit 0
fi
# current remote main HEAD, without mutating the working tree
remote="$(git -C "$TOOLS_DIR" ls-remote origin main 2>/dev/null | awk '{print $1}')"
[ -z "$installed" ] && installed="$(git -C "$TOOLS_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"

if [ -z "$remote" ]; then
  echo "octools-version: could not reach origin/main (offline?). Installed = ${installed:0:7}."
  exit 0
fi
if [ "$installed" = "$remote" ]; then
  echo "octools-version: OK - current. Skills installed from ${installed:0:7} = origin/main."
  exit 0
fi
# count how far behind, if the remote commit is fetchable locally (best-effort)
behind="$(git -C "$TOOLS_DIR" rev-list --count "${installed}..${remote}" 2>/dev/null || echo '?')"
echo "octools-version: STALE - your skills are from ${installed:0:7}, but origin/main is ${remote:0:7} (${behind} commit(s) ahead)."
echo "  Refresh now (re-syncs main + reinstalls all skills):"
echo "    bash ${TOOLS_DIR}/setup/session-start.sh"
echo "  Or start a fresh session (it auto-syncs). New skills are most reliably picked up on a fresh session."
exit 2
