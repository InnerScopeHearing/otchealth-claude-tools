#!/usr/bin/env node
// ring-parity-canary.mjs -- Wave 3.1 evidence tool: objectively flags EXEC_RING members whose
// standing privilege (finance-MNPI + company-legal read via otchealth-mcp-server's EXEC_RING) is
// not backed by a real operating identity.
//
// CALIBRATION NOTE (2026-07-22): v1 of this tool used raw Cosmos memory-record volume/recency as
// the dormancy signal. That was WRONG -- validating it against coo/cro (already removed from
// EXEC_RING as "dormant over-privilege") showed 66 and 75 memory records each, most recent within
// 2 weeks, i.e. it would have called them ACTIVE. Cosmos records tagged agent=<role> can be OTHER
// agents writing notes ABOUT that role, not evidence the role itself ever operated. Company-brain
// confirmed the REAL criteria the coo/cro removal actually used:
//   1. a documented persona:      dream-team/agents/<role>.md exists
//   2. real operating connectivity: skills/gateway-connect/connect.mjs's LANES registry has an
//      entry for <role> (an oauth-lane-<role>-id/secret pair -- the thing that lets a session
//      actually mint a gateway token AS that identity, not just reference the name)
// coo/cro both have (1) and (2) -- they are real, developed, actively-connectable personas; their
// EXEC_RING removal was a least-privilege call (their mandate doesn't need financial/legal MNPI),
// not "this identity never runs." A role with NEITHER (1) nor (2) is a materially stronger case:
// genuinely no standing operator has ever been able to act as that identity through any first-class
// path, yet it still carries the EXEC_RING grant.
//
// READ-ONLY. Produces evidence for Matt's one-sentence keep-or-cut call per ring member; it does
// NOT decide or change any ring membership itself (ring edits are src/tools/kb/search-privileged.ts
// in otchealth-mcp-server, a separate, deliberate code change with its own review + deploy).
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LANES } from "../gateway-connect/connect.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.resolve(HERE, "../../dream-team/agents");

// Mirrors EXEC_RING + PERSONAL_LEGAL_RING in otchealth-mcp-server/src/tools/kb/search-privileged.ts
// as of the coo/cro removal (PR #144) -- kept as a literal here (this script lives in a different
// repo/runtime than the gateway and cannot import TS across repos). A mismatch would only ever make
// this canary miss a ring member, never fabricate a false one, so the failure mode is safe. Update
// this list if EXEC_RING changes again.
export const RING_AGENTS = ["cfo", "clo", "cpo", "cco", "exec", "clo-personal"];

export function evidenceFor(agent) {
  const personaFile = path.join(AGENTS_DIR, `${agent}.md`);
  const hasPersona = existsSync(personaFile);
  const hasLane = Object.prototype.hasOwnProperty.call(LANES, agent);
  // "exec" and "clo-personal" are ring NAMES, not standing individual operator identities (exec is
  // the cross-team aggregate tier; clo-personal is CLO's own personal-matter lane, backed by the
  // clo.md persona + the clo-personal LANES entry) -- exclude them from the dormancy verdict, they
  // are structural, not provisioned-and-forgotten roles.
  const structural = agent === "exec" || agent === "clo-personal";
  const dormant = !structural && !hasPersona && !hasLane;
  return { agent, hasPersona, hasLane, structural, dormant };
}

function main() {
  const asJson = process.argv.includes("--json");
  const results = RING_AGENTS.map(evidenceFor);
  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  console.log("Ring-parity canary -- EXEC_RING member vs real operating identity (persona file + gateway-connect LANES entry)\n");
  const w = { agent: 14, persona: 10, lane: 8, note: 12 };
  console.log("agent".padEnd(w.agent) + "persona.md".padEnd(w.persona) + "LANES".padEnd(w.lane) + "verdict");
  for (const r of results) {
    const verdict = r.structural ? "STRUCTURAL" : r.dormant ? "DORMANT" : "ACTIVE";
    console.log(r.agent.padEnd(w.agent) + (r.hasPersona ? "yes" : "no").padEnd(w.persona) + (r.hasLane ? "yes" : "no").padEnd(w.lane) + verdict);
  }
  const dormantAgents = results.filter((r) => r.dormant).map((r) => r.agent);
  console.log(`\nDORMANT (no persona file AND no LANES connectivity -- evidence for a keep-or-cut ring-removal decision): ${dormantAgents.length ? dormantAgents.join(", ") : "none"}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
