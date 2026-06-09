#!/usr/bin/env bash
# apply.sh — drop the session-handoff kit into the current repo.
#
# Run from any repo root, in any Claude Code session (the toolkit is already
# cloned to /tmp/octools at session start):
#
#   bash /tmp/octools/handoff-kit/apply.sh
#
# Idempotent and safe: it never clobbers an existing HANDOFF.md or an existing
# .claude/settings.json (it tells you to merge those by hand instead).
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Anchor to the SAME root the SessionStart hook reads: $CLAUDE_PROJECT_DIR.
# Fall back to the git toplevel, then the current dir. Anchoring to
# CLAUDE_PROJECT_DIR guarantees HANDOFF.md lands exactly where the hook looks
# for it (the project root), even when the session is cd'd into a subfolder or
# a nested git repo — the bug that once put a HANDOFF.md one level deep.
REPO="${CLAUDE_PROJECT_DIR:-}"
[ -z "$REPO" ] && REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
GITROOT="$(git -C "$REPO" rev-parse --show-toplevel 2>/dev/null || echo "$REPO")"
cd "$REPO"

echo "[handoff-kit] applying to project root: $REPO"
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ "$REPO" != "$GITROOT" ]; then
  echo "[handoff-kit] note: git toplevel is $GITROOT (nested/different git root);"
  echo "             using the Claude project root so the SessionStart hook finds HANDOFF.md."
fi

# 1. HANDOFF.md — create from the template only if it does not exist.
if [ -f HANDOFF.md ]; then
  echo "[handoff-kit] HANDOFF.md already exists — leaving it untouched."
else
  sed "s/<project name>/$(basename "$REPO")/" "$KIT/HANDOFF.template.md" > HANDOFF.md
  echo "[handoff-kit] created HANDOFF.md — fill it in from this session's context."
fi

# 2. CLAUDE.md pointer — append once so every session reads the handoff first.
POINTER='> Session start: read HANDOFF.md and continue from "Next up". Update HANDOFF.md before you stop.'
if [ -f CLAUDE.md ] && grep -qF 'read HANDOFF.md and continue' CLAUDE.md; then
  echo "[handoff-kit] CLAUDE.md already points at HANDOFF.md."
else
  { [ -f CLAUDE.md ] && echo ""; echo "$POINTER"; } >> CLAUDE.md
  echo "[handoff-kit] added the HANDOFF pointer to CLAUDE.md."
fi

# 3. SessionStart hook — installs the toolset + prints HANDOFF.md on every
#    session, including resumes (the cloud never re-runs the env setup on resume).
mkdir -p .claude
if [ ! -f .claude/settings.json ]; then
  cp "$KIT/settings.json" .claude/settings.json
  echo "[handoff-kit] created .claude/settings.json with the SessionStart hook."
elif grep -qF 'otchealth-claude-tools /tmp/octools' .claude/settings.json; then
  echo "[handoff-kit] .claude/settings.json already has the loader hook."
else
  echo "[handoff-kit] NOTE: .claude/settings.json exists without the loader hook."
  echo "             Merge the SessionStart hook from this file by hand:"
  echo "               $KIT/settings.json"
  echo "             (do not blindly overwrite your existing settings)."
fi

echo ""
echo "[handoff-kit] Done. Files are at: $REPO"
echo "[handoff-kit]   $REPO/HANDOFF.md  <- the SessionStart hook reads exactly this path"
echo "[handoff-kit] Next: fill in HANDOFF.md, then commit + push (PR to main)."
