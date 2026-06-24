#!/usr/bin/env node
// install-octools-hook.mjs — fleet-wide rollout of the session hooks, the DRY way.
//
// Instead of editing every app repo's committed .claude/settings.json (which re-creates fragmentation),
// session-start.sh calls this once per session to idempotently install the USER-scope hooks into
// ~/.claude/settings.json. Because session-start runs in every session and is itself live-synced from
// claude-tools/main, the rollout propagates to the whole fleet: change it once, every session gets it.
//
// Installs:
//   UserPromptSubmit -> octools-sync.sh        (live toolkit refresh)
//   SessionStart     -> kb-inject.sh session   (recall the agent ledger)
//   PreCompact       -> kb-inject.sh precompact (CAPTURE journal + DISTILL to ledger before compaction)
//   Stop             -> kb-inject.sh stop       (CAPTURE every turn + throttled distill)
// The kb-inject hooks point at the INSTALLED skill path ($HOME/.claude/skills/kb-memory/kb-inject.sh),
// which session-start populates, so they fire in ANY repo (not just claude-tools). Guarded so they
// no-op cleanly if the skill is not present yet. The per-session identity marker (~/.claude/.kb-agent)
// still decides which agent's ledger gets written; without it, kb-inject warns and captures nothing.
//
// Defensive: missing settings -> create minimal; unparseable -> skip (never clobber); add only if absent
// (idempotent); atomic write; always exits 0 so it can never break session start. Claude Code merges
// user + project hooks, so this is purely additive.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME || "/tmp";
const DIR = join(HOME, ".claude");
const F = join(DIR, "settings.json");
const KBI = '"$HOME/.claude/skills/kb-memory/kb-inject.sh"';
// Each hook is guarded so a session that has not installed the skill yet just no-ops (no error).
const HOOKS = [
  { event: "UserPromptSubmit", match: "octools-sync.sh", cmd: "[ -f /tmp/octools/setup/octools-sync.sh ] && bash /tmp/octools/setup/octools-sync.sh || true" },
  { event: "SessionStart", match: "kb-inject.sh", cmd: `[ -f ${KBI} ] && bash ${KBI} session || true` },
  { event: "PreCompact", match: "kb-inject.sh", cmd: `[ -f ${KBI} ] && bash ${KBI} precompact || true` },
  { event: "Stop", match: "kb-inject.sh", cmd: `[ -f ${KBI} ] && bash ${KBI} stop || true` },
];

try {
  mkdirSync(DIR, { recursive: true });
  let s = {};
  if (existsSync(F)) {
    try { s = JSON.parse(readFileSync(F, "utf8")); }
    catch { process.exit(0); } // never clobber an unparseable user settings file
  }
  s.hooks = s.hooks || {};
  let changed = false;
  for (const h of HOOKS) {
    s.hooks[h.event] = s.hooks[h.event] || [];
    if (!JSON.stringify(s.hooks[h.event]).includes(h.match)) {
      s.hooks[h.event].push({ hooks: [{ type: "command", command: h.cmd }] });
      changed = true;
    }
  }
  if (changed) {
    const tmp = `${F}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
    renameSync(tmp, F); // atomic
    console.log("[octools] installed session hooks (octools-sync + kb-memory capture/distill) into ~/.claude/settings.json");
  }
} catch { /* best-effort; a settings hiccup must never block session start */ }
process.exit(0);
