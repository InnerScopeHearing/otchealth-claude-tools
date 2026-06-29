#!/usr/bin/env node
/**
 * sunrise.mjs — fleet-wide first-session / cold-start loader for ANY agent lane (coo, cfo, developer,
 * clo, cto, ...). Loads ALL of the lane's ledger memory, the shared exec feed, the company brain, and
 * FLEET-BULLETIN.md, then prints the CTO self-audit checklist for the agent to execute and report.
 *
 * MUST be run THROUGH the kb-memory wrapper so the GCP service account + proxy are injected:
 *   bash /agent/workspace/skills/kb-memory/run.sh node skills/agent-sunrise/sunrise.mjs --agent <lane>
 * (or, from a checkout: bash skills/kb-memory/run.sh node skills/agent-sunrise/sunrise.mjs --agent cfo)
 *
 * It performs the universal MEMORY + BULLETIN load; lane-specific state files (e.g. coo/SITUATION.md)
 * are listed as hints for the agent to read per its own system prompt. It never sends or writes anything.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const lane = (args[args.indexOf("--agent") + 1] || process.env.AGENT_LANE || "").toLowerCase();
if (!lane || args.indexOf("--agent") === -1) { console.error("usage: sunrise.mjs --agent <coo|cfo|developer|clo|cto|...>"); process.exit(2); }

const OCT = fs.existsSync("/tmp/octools/skills") ? "/tmp/octools" : ".";
const MEM = `${OCT}/skills/kb-memory/mem.mjs`;
const run = (cmd) => { try { return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return `(command failed: ${e.message.split("\n")[0]})`; } };

// lane -> known durable state files in otchealth-claude-tools (hints; the agent reads per its prompt)
const STATE = {
  coo: ["coo/SITUATION.md", "coo/PRIORITIES.md", "coo/today.md", "coo/log.md", "coo/morning-marker.md"],
  cro: ["cash.manifest (the revenue scoreboard)", "projects/medvi-operations/PLAN.md", "the cro ledger lane", "FLEET-BULLETIN.md (cro entries)", "dream-team/agents/rainmaker.md + growth.md (CRO persona source)"],
  cfo: ["FLEET-BULLETIN.md (cfo entries)", "the cfo ledger lane", "cfo-xero-migration-plan + cfo runbooks"],
  developer: ["app repo STATUS.md / RELEASE-LEDGER", "iheartest + aware app state"],
  clo: ["dream-team/clo/*", "the clo ledger lane (privileged — never --share)"],
  cto: ["otchealth-cto/CLAUDE.md", "runbooks/*", "the Portfolio Status Board"],
};

console.log("================ SUNRISE: " + lane.toUpperCase() + " ================\n");

console.log("--- 1. WHOAMI (memory online?) ---");
console.log(run(`node ${MEM} whoami --agent ${lane}`).trim() + "\n");

console.log("--- 2. PACK (curated working set) ---");
console.log(run(`node ${MEM} pack --agent ${lane}`).trim().slice(0, 6000) + "\n");

console.log("--- 3. TAIL (recent lane entries) ---");
console.log(run(`node ${MEM} tail --agent ${lane}`).trim().slice(0, 6000) + "\n");

console.log("--- 4. TEAM (shared exec feed) ---");
console.log(run(`node ${MEM} team`).trim().slice(0, 5000) + "\n");

console.log("--- 5. FLEET BULLETIN ---");
const bull = `${OCT}/FLEET-BULLETIN.md`;
console.log(fs.existsSync(bull) ? fs.readFileSync(bull, "utf8").slice(0, 5000) : "(FLEET-BULLETIN.md not found in checkout)");
console.log("");

console.log("--- 6. LANE STATE FILES TO READ (per your system prompt) ---");
console.log((STATE[lane] || ["(no preset; read your durable state per your system prompt)"]).map((s) => "  - " + s).join("\n") + "\n");

console.log(`================ CTO SELF-AUDIT — run each, report PASS/FAIL + evidence ================
A. IDENTITY/ENGINE: confirm who you are, which engine (Hyperagent vs Claude), and your shared-state locations (kb-memory ${lane} ledger + your repo files).
B. REPOS: confirm you can read the repos you own; confirm you are NOT touching medreview/PHI from a non-BAA runtime.
C. MEMORY PROCESS: whoami == PASS? can you read your PRIVATE lane AND the shared feed? rule: confidential -> private (no --share), shareable -> --share. READ FIRST, WRITE LAST.
D. TOOLS/SKILLS: list attached skills + integrations; confirm the ones your role needs are present and callable.
E. HANDS: resolve your action connectors (e.g. n8n email/calendar, Shopify, Customer.io). Do a READ-ONLY proof; send nothing.
F. BRIEFING/NUMBERS: run your daily briefing / the metric that matters for your role (read-only); confirm you get the number.
G. GATES: state your hard gates (securities/INND/IR, FDA/medical, new financial commitments, PHI) and confirm prepare-and-flag only.
H. COST/SPEED/MEMORY: subagent default = sonnet where possible; read existing docs before rebuilding; confirm any idempotency/dedupe guard your role relies on.
Output a PASS/FAIL table with a one-line remediation for each FAIL; escalate infra FAILs to the CTO.

================ THEN ================
Summarize the last 3-5 topics you and Matt worked on (from the ledger + state files), lead with the one number that matters for your role, and ASK Matt whether to CONTINUE one of them or START a new topic. 1-3 moves max.`);
