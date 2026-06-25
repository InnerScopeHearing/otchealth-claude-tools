#!/usr/bin/env bash
# repo-freshen.sh [repo-dir] - keep the agent's WORKING repo current with origin/main, SAFELY, at every
# session start. This is the fix for "my branch is 50 commits behind main": a fresh session branch that
# was cut from a stale base. The shared TOOLKIT (otchealth-claude-tools) keeps itself current via
# octools-bootstrap + octools-sync; THIS routine is for the agent's OWN app/web repo.
#
# SAFE BY DESIGN - it never loses work and never force-resets a branch that has commits:
#   1. fetch origin's default branch (read-only).
#   2. NOT behind it            -> silent (already current).
#   3. behind, CLEAN, 0 ahead   -> fast-forward to it (nothing to lose; the common stale-base case).
#   4. behind, but has local
#      commits OR a dirty tree   -> DO NOT touch it. Print a LOUD, actionable catch-up command. The
#                                  agent's own work is never modified automatically.
# The toolkit repo is skipped (it owns its own sync). Set OCTOOLS_NO_REPO_FRESHEN=1 to disable.
# Always exits 0 - it can never block or break a session.
set +e
[ -n "${OCTOOLS_NO_REPO_FRESHEN:-}" ] && exit 0

DIR="${1:-${CLAUDE_PROJECT_DIR:-$PWD}}"
git -C "$DIR" rev-parse --git-dir >/dev/null 2>&1 || exit 0

# The toolkit syncs itself (octools-bootstrap/sync); never let repo-freshen also touch it.
REMOTE="$(git -C "$DIR" config --get remote.origin.url 2>/dev/null)"
case "$REMOTE" in *otchealth-claude-tools*) exit 0 ;; esac

BR="$(git -C "$DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)"
[ -z "$BR" ] || [ "$BR" = "HEAD" ] && exit 0   # detached HEAD: leave it alone

# Resolve the repo's default branch (usually main; fall back to master/etc.).
MB=main
if ! git -C "$DIR" fetch origin "$MB" --quiet 2>/dev/null; then
  MB="$(git -C "$DIR" remote show origin 2>/dev/null | sed -n 's/.*HEAD branch: //p' | head -1)"
  [ -z "$MB" ] && exit 0
  git -C "$DIR" fetch origin "$MB" --quiet 2>/dev/null || exit 0
fi

behind="$(git -C "$DIR" rev-list --count "HEAD..origin/$MB" 2>/dev/null || echo 0)"
ahead="$(git -C "$DIR" rev-list --count "origin/$MB..HEAD" 2>/dev/null || echo 0)"
dirty="$(git -C "$DIR" status --porcelain 2>/dev/null | head -1)"
name="$(basename "$DIR")"

[ "${behind:-0}" = "0" ] && exit 0   # already current with origin/$MB -> silent

if [ "${ahead:-0}" = "0" ] && [ -z "$dirty" ]; then
  # pristine branch behind the base -> fast-forward; there is nothing to lose.
  if git -C "$DIR" merge --ff-only "origin/$MB" --quiet 2>/dev/null; then
    echo "[repo-freshen] $name: branch '$BR' was $behind behind origin/$MB; fast-forwarded to latest ($(git -C "$DIR" rev-parse --short HEAD)). You are now current with main."
  else
    echo "[repo-freshen] $name: branch '$BR' is $behind behind origin/$MB and not a clean fast-forward. To update: git -C $DIR rebase origin/$MB"
  fi
else
  # the agent has local work -> never auto-modify; tell them exactly how to catch up.
  echo "[repo-freshen] $name: branch '$BR' is $behind behind / $ahead ahead of origin/$MB$([ -n "$dirty" ] && echo ' (uncommitted changes present)'). Your work is UNTOUCHED. To rebase onto the latest base: git -C $DIR merge origin/$MB   (or: git -C $DIR rebase origin/$MB)"
fi
exit 0
