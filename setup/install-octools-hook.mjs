#!/usr/bin/env node
// install-octools-hook.mjs — fleet-wide rollout of the live-sync hook, the DRY way.
//
// Instead of editing 17 app repos' committed .claude/settings.json (which would re-create the
// fragmentation we just killed), session-start.sh calls this once per session to idempotently install
// the octools-sync UserPromptSubmit hook into the USER-scope ~/.claude/settings.json. Because
// session-start runs in every app session and is itself live-synced from claude-tools/main, the rollout
// propagates to the whole fleet automatically: change it once, every app gets it.
//
// Defensive by design: missing settings -> create minimal; unparseable settings -> skip (never clobber a
// user's file); add only if absent (idempotent, no duplicates); atomic write (temp + rename); always
// exits 0 so it can never break session start. Claude Code merges user + project hooks, so this is purely
// additive to whatever an app repo already declares.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME || "/tmp";
const DIR = join(HOME, ".claude");
const F = join(DIR, "settings.json");
// Guard the file existence so a session whose /tmp/octools predates octools-sync.sh just no-ops.
const CMD = "[ -f /tmp/octools/setup/octools-sync.sh ] && bash /tmp/octools/setup/octools-sync.sh || true";

try {
  mkdirSync(DIR, { recursive: true });
  let s = {};
  if (existsSync(F)) {
    try { s = JSON.parse(readFileSync(F, "utf8")); }
    catch { process.exit(0); } // never clobber an unparseable user settings file
  }
  s.hooks = s.hooks || {};
  s.hooks.UserPromptSubmit = s.hooks.UserPromptSubmit || [];
  const already = JSON.stringify(s.hooks.UserPromptSubmit).includes("octools-sync.sh");
  if (!already) {
    s.hooks.UserPromptSubmit.push({ hooks: [{ type: "command", command: CMD }] });
    const tmp = `${F}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
    renameSync(tmp, F); // atomic
    console.log("[octools] installed live-sync (octools-sync) UserPromptSubmit hook into ~/.claude/settings.json");
  }
} catch { /* best-effort; a settings hiccup must never block session start */ }
process.exit(0);
