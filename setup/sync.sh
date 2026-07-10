#!/usr/bin/env bash
# sync.sh — catch a long-lived Claude Code session's working repo up to origin/main WITHOUT losing work.
# repo-freshen.sh deliberately refuses to touch a dirty/committed branch (protects your work), which is
# why a days-old session goes stale and never sees live pushes. This is the on-demand override: stash ->
# fetch -> ff/merge origin/main -> restore stash. Also refreshes the /tmp/octools toolkit clone. Run from
# inside the repo:  octsync
set +e
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO_ROOT" ]; then echo "[octsync] not inside a git repo (cd into your repo first)"; exit 0; fi
cd "$REPO_ROOT" || exit 0
BR="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
echo "[octsync] $REPO_ROOT (branch: $BR) -> catching up to origin/main ..."
STASHED=0
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null || [ -n "$(git ls-files --others --exclude-standard 2>/dev/null)" ]; then
  git stash push -u -m "octsync $(date -u +%FT%TZ)" >/dev/null 2>&1 && { STASHED=1; echo "[octsync] stashed your local changes"; }
fi
git fetch origin main >/dev/null 2>&1
if git merge --ff-only origin/main >/dev/null 2>&1; then
  echo "[octsync] fast-forwarded to origin/main"
elif git merge --no-edit origin/main >/dev/null 2>&1; then
  echo "[octsync] merged origin/main into $BR"
else
  echo "[octsync] MERGE CONFLICT — resolve manually; your work is safe (git status)"
fi
if [ "$STASHED" = 1 ]; then
  git stash pop >/dev/null 2>&1 && echo "[octsync] restored your local changes" \
    || echo "[octsync] NOTE: stash pop hit a conflict; your changes are safe in 'git stash list'"
fi
# refresh the toolkit clone too, so skills/hooks are current this session
if [ -d /tmp/octools/.git ]; then
  git -C /tmp/octools fetch --depth 1 origin main >/dev/null 2>&1 && git -C /tmp/octools reset --hard FETCH_HEAD >/dev/null 2>&1 \
    && echo "[octsync] toolkit /tmp/octools -> $(git -C /tmp/octools rev-parse --short HEAD)"
fi
echo "[octsync] DONE. Now at origin/main $(git rev-parse --short origin/main 2>/dev/null)."
