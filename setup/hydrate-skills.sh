#!/usr/bin/env bash
# Copy the repository's governed skill tree and sibling shared modules into a
# host's global Agent Skills directory. The same layout supports Claude's
# ~/.claude/skills and Codex's ~/.agents/skills.
set -euo pipefail

TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_ROOT="${1:-${HOME}/.agents}"
SKILLS_DST="${DEST_ROOT}/skills"
SETUP_DST="${DEST_ROOT}/setup"

mkdir -p "$SKILLS_DST" "$SETUP_DST"
for skdir in "${TOOLS_DIR}/skills/"*/; do
  [ -d "$skdir" ] || continue
  sk="$(basename "$skdir")"
  rm -rf "${SKILLS_DST:?}/${sk}"
  cp -R "$skdir" "${SKILLS_DST}/${sk}"
done

# Skills that import ../../setup/<module>.mjs need the sibling setup/ tree too.
# Runtime scripts, credentials, and other setup files are not installed here.
if ! cp -f "${TOOLS_DIR}/setup/"*.mjs "$SETUP_DST/" 2>/dev/null; then
  echo "[octools] WARN: could not install shared setup modules -> ${SETUP_DST}" >&2
fi
echo "[octools] Installed governed skills and shared modules -> ${DEST_ROOT}"
