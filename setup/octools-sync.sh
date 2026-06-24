#!/usr/bin/env bash
# octools-sync.sh — in-session AUTO-refresh of the shared toolkit (the live-pull half of octools-version).
#
# Why: session-start.sh force-syncs the toolkit to origin/main AT SESSION START. A long-running session
# that began before a fix/SOP was merged keeps the OLD copy until it restarts (this caused the "the CTO
# changed something and the other agents are not connected to it" fragmentation). Wired as a
# UserPromptSubmit hook, this makes a running agent pick up changes to claude-tools/main on its NEXT
# prompt, with no restart and no lost context. main is the single source of truth; every agent re-pulls it.
#
# Safe by design: the auto-reset is throttled (default 300s, no per-message latency) and GUARDED to /tmp
# so it can NEVER reset a real working checkout (the CTO's own claude-tools checkout is left alone). The
# fleet-bulletin surfacing runs in any session. Always exits 0 so it can never block a prompt.
set -u
TOOLS_DIR="${OCTOOLS_DIR:-/tmp/octools}"
THROTTLE="${OCTOOLS_SYNC_THROTTLE:-300}"
STAMP="${HOME}/.claude/.octools-sync-last"
SKILLS_DST="${HOME}/.claude/skills"
MARKER="${HOME}/.claude/.octools-installed-commit"

git -C "$TOOLS_DIR" rev-parse --git-dir >/dev/null 2>&1 || exit 0

# --- Auto-refresh: ONLY for an ephemeral /tmp consumption clone, never a real working checkout. ---
case "$TOOLS_DIR" in
  /tmp/*)
    now="$(date +%s 2>/dev/null || echo 0)"
    last="$(cat "$STAMP" 2>/dev/null || echo 0)"
    if [ "$now" -le 0 ] || [ $((now - last)) -ge "$THROTTLE" ]; then
      mkdir -p "${HOME}/.claude" 2>/dev/null || true
      echo "$now" > "$STAMP" 2>/dev/null || true
      if timeout 20 git -C "$TOOLS_DIR" fetch --depth 1 --quiet origin main 2>/dev/null; then
        remote="$(git -C "$TOOLS_DIR" rev-parse FETCH_HEAD 2>/dev/null || echo none)"
        installed="$(cat "$MARKER" 2>/dev/null || git -C "$TOOLS_DIR" rev-parse HEAD 2>/dev/null || echo none)"
        if [ "$remote" != "none" ] && [ "$remote" != "$installed" ] && git -C "$TOOLS_DIR" reset --hard --quiet FETCH_HEAD 2>/dev/null; then
          if [ -d "$TOOLS_DIR/skills" ]; then
            for skdir in "$TOOLS_DIR/skills/"*/; do
              sk="$(basename "$skdir")"
              rm -rf "${SKILLS_DST:?}/${sk}" 2>/dev/null || true
              cp -R "$skdir" "${SKILLS_DST}/${sk}" 2>/dev/null || true
            done
          fi
          # Re-wire user-scope hooks idempotently so a NEWLY-ADDED hook (e.g. kb-recall) reaches an
          # already-RUNNING session on its next refresh, not only on the next fresh session. Additive,
          # only writes when changed, always exits 0.
          [ -f "$TOOLS_DIR/setup/install-octools-hook.mjs" ] && node "$TOOLS_DIR/setup/install-octools-hook.mjs" >/dev/null 2>&1 || true
          git -C "$TOOLS_DIR" rev-parse HEAD > "$MARKER" 2>/dev/null || true
          echo "[octools-sync] shared toolkit refreshed ${installed:0:7} -> ${remote:0:7} (live, no restart needed)."
        fi
      fi
    fi
    ;;
esac

# --- Fleet bulletin: surface what changed + why (any session; cheap local read). ---
node "$TOOLS_DIR/setup/bulletin.mjs" since 2>/dev/null || true
exit 0
