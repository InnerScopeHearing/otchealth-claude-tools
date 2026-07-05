#!/usr/bin/env node
// cold-resume-test.mjs — the P0-DURABLE-HANDOFF acceptance test: "can a cold fresh instance resume
// from the ledger alone?" This script deliberately reads ONLY the typed _STATE/<agent>.json doc
// (mem.mjs's `state` verb) — no chat history, no JSONL ledger, no other file — and renders exactly
// what a brand-new instance would know if that were its ENTIRE context. If the printed brief is
// enough to act on, the handoff is durable; if it's empty/stale, the agent isn't maintaining its
// state doc and needs to start calling `mem.mjs state --set` as it works.
//
// Usage: node cold-resume-test.mjs --agent <a> [--max-age-hours 48]
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const AGENT = val("--agent", "");
const MAX_AGE_H = parseFloat(val("--max-age-hours", "48"));
if (!AGENT) { console.error("usage: cold-resume-test.mjs --agent <a> [--max-age-hours 48]"); process.exit(2); }

let raw;
try {
  raw = execFileSync("node", [join(HERE, "mem.mjs"), "state", "--get", "--agent", AGENT, "--json"], { encoding: "utf8", timeout: 30000 });
} catch (e) {
  console.log(`COLD RESUME: FAIL — could not read state doc for ${AGENT} (${e.message}).`);
  process.exit(1);
}
let st;
try { st = JSON.parse(raw); } catch { console.log("COLD RESUME: FAIL — state doc is not valid JSON."); process.exit(1); }

const problems = [];
if (!st.goal) problems.push("no goal set — a fresh instance would not know what it's working toward");
if (!st.updated_at) problems.push("never updated — this agent has not adopted the state doc");
else {
  const ageH = (Date.now() - Date.parse(st.updated_at)) / 36e5;
  if (ageH > MAX_AGE_H) problems.push(`stale: last updated ${ageH.toFixed(1)}h ago (> ${MAX_AGE_H}h) — may not reflect current reality`);
}
if (!st.last_state) problems.push("no last_state — a fresh instance would not know what was happening when the previous session ended");

console.log(`# COLD RESUME BRIEF — ${AGENT} (reading ONLY _STATE/${AGENT}.json, nothing else)`);
console.log(`\nIf I were a brand-new instance with zero chat history, this is everything I'd know:\n`);
console.log(`GOAL: ${st.goal || "(unknown)"}`);
console.log(`CONSTRAINTS: ${(st.constraints || []).join(" | ") || "(none recorded)"}`);
console.log(`OPEN DECISIONS AWAITING RESOLUTION: ${(st.open_decisions || []).join(" | ") || "(none recorded)"}`);
console.log(`WHAT WAS HAPPENING WHEN THE LAST SESSION ENDED: ${st.last_state || "(unknown)"}`);
console.log(`(doc version ${st.version ?? "?"}, last touched ${st.updated_at || "never"} by ${st.updated_by || "?"})`);

console.log(`\nCOLD RESUME: ${problems.length ? "MARGINAL" : "PASS"}`);
for (const p of problems) console.log(`  - ${p}`);
process.exit(problems.length ? 1 : 0);
