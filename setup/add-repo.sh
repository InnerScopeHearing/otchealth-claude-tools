#!/usr/bin/env bash
# add-repo.sh <repo> [branch] [parent-dir] - clone an InnerScopeHearing org repo into the sandbox so an
# agent can work in it RIGHT NOW, even when the session's `add_repo` tool is not exposed. This is the
# universal fallback: it authenticates with the org GitHub App installation token (the gh-app skill,
# 15k req/hr) and gives you a working tree + authenticated push, with no dependency on the web UI.
#
# Usage:
#   bash setup/add-repo.sh iheartest                 # clone InnerScopeHearing/iheartest -> /home/user/iheartest (default branch)
#   bash setup/add-repo.sh fourvault claude/my-work   # clone + checkout an existing branch
#   bash setup/add-repo.sh medreview '' /tmp          # clone into a different parent dir
#
# SCOPE NOTE: this gives you a git working tree + push via the token. It does NOT widen the GitHub-MCP
# scope allowlist - for the mcp__github__* tools to target a NEW repo, it must also be in the session's
# repo scope (the `add_repo` session tool when present, or the cloud Environment's repo list). Filesystem
# work, builds, and `git push` work regardless. Non-PHI ring (never clone a PHI repo into a non-PHI lane).
set -euo pipefail
REPO="${1:?usage: add-repo.sh <repo> [branch] [parent-dir]}"
BR="${2:-}"
PARENT="${3:-/home/user}"
OWNER="${ADD_REPO_OWNER:-InnerScopeHearing}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Mint a short-lived installation token; accept any output format (extract the ghs_ token).
TOK="$(node "$HERE/skills/github-app/gh-app.mjs" token 2>&1 | grep -oE 'gh[sou]_[A-Za-z0-9]+' | head -1)"
[ -n "$TOK" ] || { echo "[add-repo] FAILED to mint a GitHub token via gh-app (check GCP_CLAUDE_DRIVER_SA_JSON + the github-app private key)."; exit 1; }

DEST="$PARENT/$REPO"
if [ -d "$DEST/.git" ]; then
  echo "[add-repo] $DEST already exists; fetching latest."
  git -C "$DEST" fetch origin --quiet 2>/dev/null || true
else
  git clone --quiet "https://x-access-token:${TOK}@github.com/${OWNER}/${REPO}.git" "$DEST" \
    || { echo "[add-repo] clone failed for ${OWNER}/${REPO} (check the repo name and that the OTCHealth Fleet Bot app is installed on it)."; exit 1; }
fi
# Scrub the token out of the persisted remote URL (do not leave a credential on disk).
git -C "$DEST" remote set-url origin "https://github.com/${OWNER}/${REPO}.git" 2>/dev/null || true
# Optional explicit branch checkout (best-effort).
[ -n "$BR" ] && { git -C "$DEST" checkout "$BR" 2>/dev/null || echo "[add-repo] note: branch '$BR' not found; left on $(git -C "$DEST" rev-parse --abbrev-ref HEAD)."; }
# Start it current with main (safe; see repo-freshen.sh).
bash "$HERE/setup/repo-freshen.sh" "$DEST" 2>/dev/null || true

echo "[add-repo] READY: ${OWNER}/${REPO} at $DEST (branch $(git -C "$DEST" rev-parse --abbrev-ref HEAD), $(git -C "$DEST" rev-parse --short HEAD))."
echo "[add-repo] To push: the origin uses the org app token via the gh-app skill, or push with your normal GitHub identity."
