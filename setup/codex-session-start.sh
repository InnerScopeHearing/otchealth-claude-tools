#!/usr/bin/env bash
# Minimal setup entrypoint for Codex Cloud environments. Configure this as the
# environment's setup script after cloning this repository to /tmp/octools.
set -euo pipefail

TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "${TOOLS_DIR}/setup/hydrate-skills.sh" "${HOME}/.agents"
if git -C "$TOOLS_DIR" rev-parse HEAD >/dev/null 2>&1; then
  mkdir -p "${HOME}/.agents"
  git -C "$TOOLS_DIR" rev-parse HEAD > "${HOME}/.agents/.octools-installed-commit"
fi
