#!/usr/bin/env node
// bulletin.mjs — the Fleet Bulletin: the CTO -> fleet changelog that travels WITH claude-tools.
//
// Why it exists: the shared toolkit (skills, SOPs, agent defs) is live-pulled by octools-sync, but a
// code diff alone does not TELL an agent "the CTO changed how we do X, here is why." The bulletin does.
// It is a committed file in claude-tools, so a change and its announcement propagate ATOMICALLY on the
// same git pull. Every agent's octools-sync + session-start surfaces the entries it has not seen yet,
// so a CTO decision reaches every agent on its next prompt, with no restart and no lost context.
//
// Usage:
//   node setup/bulletin.mjs add "<one-line fleet-affecting change>"   # CTO writes (then commit + push)
//   node setup/bulletin.mjs since                                     # show entries new to THIS agent
//
// `since` tracks a per-environment marker (~/.claude/.octools-bulletin-seen = count of entries already
// shown here), so each agent sees each entry exactly once. A brand-new environment sees only the last
// few (an intro), not the whole history.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BULLETIN = join(HERE, "..", "FLEET-BULLETIN.md");
const SEEN_DIR = join(process.env.HOME || "/tmp", ".claude");
const SEEN = join(SEEN_DIR, ".octools-bulletin-seen");
const ENTRY_RE = /^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z \| /;
const HEADER = "# Fleet Bulletin\n\n" +
  "CTO -> fleet changelog. One line per fleet-affecting change (a new SOP, a tooling change, a\n" +
  "decision every agent must honor). Travels with claude-tools; every agent's octools-sync surfaces\n" +
  "new entries on its next prompt, so the whole fleet stays on the same page without a restart.\n" +
  "Write with: node setup/bulletin.mjs add \"<line>\"\n\n";

const entryLines = () => (existsSync(BULLETIN) ? readFileSync(BULLETIN, "utf8").split("\n").filter((l) => ENTRY_RE.test(l)) : []);
const cmd = process.argv[2];

if (cmd === "add") {
  const line = process.argv.slice(3).join(" ").trim();
  if (!line) { console.error('usage: bulletin.mjs add "<line>"'); process.exit(1); }
  const ts = new Date().toISOString().slice(0, 16) + "Z";
  const body = existsSync(BULLETIN) ? readFileSync(BULLETIN, "utf8") : HEADER;
  writeFileSync(BULLETIN, body.replace(/\n*$/, "\n") + `- ${ts} | ${line}\n`);
  console.log(`[bulletin] added: ${ts} | ${line}`);
  console.log("[bulletin] commit + push claude-tools so it reaches the fleet.");
} else if (cmd === "since") {
  const lines = entryLines();
  if (!lines.length) process.exit(0);
  let seen = 0;
  if (existsSync(SEEN)) seen = parseInt(readFileSync(SEEN, "utf8").trim(), 10) || 0;
  else seen = Math.max(0, lines.length - 3); // fresh env: show only the last few, not all history
  const unseen = seen < lines.length ? lines.slice(seen) : [];
  if (unseen.length) {
    console.log(`[fleet-bulletin] ${unseen.length} update(s) since you last synced:`);
    for (const l of unseen) console.log("  " + l.replace(/^- /, ""));
  }
  try { mkdirSync(SEEN_DIR, { recursive: true }); writeFileSync(SEEN, String(lines.length)); } catch { /* best-effort */ }
} else {
  console.error('usage: bulletin.mjs add "<line>" | since');
  process.exit(1);
}
