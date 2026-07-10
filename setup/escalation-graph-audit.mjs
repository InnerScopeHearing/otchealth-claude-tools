#!/usr/bin/env node
// escalation-graph-audit.mjs — C11-ACYCLIC-ESC: audit the fleet's escalation/dispatch chains to
// guarantee they are ACYCLIC (no A -> B -> A loop that could make two agents nudge each other forever).
//
// WHAT THIS IS: a real cycle-detection algorithm (DFS with an explicit recursion stack, i.e. the
// standard "white/gray/black" coloring) run over a small, HAND-BUILT adjacency-list manifest of
// "who escalates/dispatches to whom" edges, inferred by reading the actual escalation/dispatch call
// sites in this repo (see MANIFEST_SOURCE_NOTES below for exactly which file/line each edge came from).
//
// WHAT THIS IS NOT: a fully automatic graph extractor. This fleet has no canonical org chart / escalation
// registry as DATA (only as scattered logic + prose comments across skills), so the manifest below is a
// STARTING POINT a human (Matt / CTO) should review and refine — see "HUMAN REVIEW NEEDED" markers.
// In particular:
//   - decision-clock's sweep() nudges a row's OWNER (data-driven at runtime, not a fixed code edge) —
//     the manifest models this as "decision-clock -> <every possible owner category>" rather than one
//     fixed target, which is conservative (it may claim edges that never fire for a given fleet) but
//     never MISSES a real edge, which is the safer direction for a cycle audit.
//   - signal-radar routes to whichever OWNER constant a given detector module hardcodes (all currently
//     cto or cfo — see skills/signal-radar/detectors/*.mjs). Modeled as detector-specific edges.
//   - fleet-medic only ever dispatches within its own EXEC roster back to the SAME agent that's unhealthy
//     (self-heal directive) plus a synthetic "fleet" escalation sink for persistent failures — modeled as
//     fleet-medic -> <each roster agent> and fleet-medic -> fleet (a sink node, never escalates further).
//   - fleet-dispatch itself is a general-purpose MESSAGE BUS (any agent -> any agent), not a fixed
//     escalation policy — so it is deliberately NOT modeled as a blanket "every agent -> every agent"
//     edge set here (that would be trivially cyclic and useless as an audit). Only the CALL SITES that
//     hardcode a *specific* target via dispatch.mjs (decision-clock sweep, fleet-medic, etc.) are edges.
//     A generic "agent X dispatches to agent Y" ad-hoc message is NOT a structural escalation edge; it's
//     free-form human/agent coordination and out of scope for a cycle audit (see HUMAN REVIEW NEEDED #3).
//
// Verbs:
//   node escalation-graph-audit.mjs             # human-readable report
//   node escalation-graph-audit.mjs --json      # structured { edges, cycles, ok }
//
// Exit code: 0 if acyclic, 1 if a cycle is found (so this can gate CI / a pre-deploy check later).

// =====================================================================================================
// MANIFEST — hand-built adjacency list, sourced from reading the actual code. Each edge cites its source.
// Format: { from, to, via, source } where `via` is a short label of the mechanism and `source` is the
// file (+ line context) the edge was inferred from. `to` may be an array when one node fans out to many
// targets (e.g. "escalates to whichever owner the row/detector says", not a single fixed target).
// =====================================================================================================
export const MANIFEST_SOURCE_NOTES = `
Edges below were inferred by reading (as of 2026-07-05, this repo, otchealth-claude-tools):
  - skills/decision-clock/decision.mjs        sweep() -> fleet-dispatch send(row.owner, ...)
  - skills/fleet-medic/medic.mjs               scan() -> writes a directive for the SAME unhealthy
                                                agent (self-heal, not cross-agent) + a "fleet" sink on
                                                persistent (>=3x) DARK/NO-MEMORY escalation.
  - skills/signal-radar/radar.mjs + detectors/*.mjs
                                                scan() -> fleet-dispatch send(detector.OWNER, ...) for
                                                high-severity or consecutive-escalated signals. Each
                                                detector module's OWNER constant is a separate edge.
  - skills/fleet-dispatch/dispatch.mjs         send(): a GENERIC bus, any agent -> any agent by CLI arg.
                                                NOT modeled edge-by-edge (see note above); only the fixed
                                                callers above (decision-clock, fleet-medic, signal-radar)
                                                are modeled, since those are the only ones with a
                                                hardcoded, structural "always escalates to X" policy.
HUMAN REVIEW NEEDED:
  1. decision-clock's real target is data (whatever "owner" a decision row was opened with, e.g.
     cto/cfo/clo/growth/...), not a fixed code constant. This manifest conservatively fans it out to
     the full known owner roster below (EXEC_ROSTER) so the audit can never silently miss a possible
     target. A human should confirm this roster is complete/current.
  2. This manifest does not yet include any Slack/email/webhook-triggered agent-to-agent escalation
     that may exist outside this repo (e.g. in otchealth-mcp-server or Container Apps Jobs wiring).
  3. Ad-hoc fleet-dispatch "send" calls a human or an agent makes in the moment (not hardcoded in a
     skill) are out of scope: those are free-form coordination, not a structural escalation policy, and
     literally cannot be enumerated statically. If a real A<->B ping-pong ever happens over dispatch,
     it will show as inbox spam/cooldown behavior, not a silent infinite loop (dispatch has no
     auto-reply logic anywhere in this repo — nothing here calls dispatch.mjs send from INSIDE
     dispatch.mjs check/list, so a bare inbox message cannot self-trigger a cycle even in principle).
`;

const EXEC_ROSTER = ["coo", "cfo", "clo", "cto", "capital", "commerce", "compliance", "rainmaker", "growth", "developer"];

export const EDGES = [
  // decision-clock sweep -> the row's owner. Conservative fan-out across the known roster (see note #1).
  ...EXEC_ROSTER.map((owner) => ({ from: "decision-clock", to: owner, via: "fleet-dispatch send (sweep nudge)", source: "skills/decision-clock/decision.mjs:sweep()" })),

  // signal-radar detectors -> their hardcoded OWNER.
  { from: "signal-radar:sentry-error-spike", to: "cto", via: "fleet-dispatch send (signal escalation)", source: "skills/signal-radar/detectors/sentry-error-spike.mjs" },
  { from: "signal-radar:eval-regression", to: "cto", via: "fleet-dispatch send (signal escalation)", source: "skills/signal-radar/detectors/eval-regression.mjs" },
  { from: "signal-radar:grant-burn-expiry", to: "cfo", via: "fleet-dispatch send (signal escalation)", source: "skills/signal-radar/detectors/grant-burn-expiry.mjs" },
  { from: "signal-radar:rotate-secret-age", to: "cto", via: "fleet-dispatch send (signal escalation)", source: "skills/signal-radar/detectors/rotate-secret-age.mjs" },
  { from: "signal-radar:mark-review-overdue", to: "cto", via: "fleet-dispatch send (signal escalation)", source: "skills/signal-radar/detectors/mark-review-overdue.mjs" },
  { from: "signal-radar:contradiction-staleness", to: "cto", via: "fleet-dispatch send (signal escalation)", source: "skills/signal-radar/detectors/contradiction-staleness.mjs" },
  { from: "signal-radar:groundedness", to: "cto", via: "fleet-dispatch send (signal escalation)", source: "skills/signal-radar/detectors/groundedness.mjs" },

  // fleet-medic -> self-heal directive for the SAME agent (loop-safe by construction: A -> A is a
  // self-edge, not a multi-hop cycle; still recorded so the audit can flag self-edges distinctly).
  ...EXEC_ROSTER.map((agent) => ({ from: "fleet-medic", to: agent, via: "self-heal directive (writes to that agent's own directive lane)", source: "skills/fleet-medic/medic.mjs:scan()/remediationFor()" })),
  // fleet-medic -> "fleet" sink on persistent (>=3x) DARK/NO-MEMORY escalation. "fleet" is a terminal
  // human-facing alert sink, never itself an escalation source (no edges out of "fleet" below).
  { from: "fleet-medic", to: "fleet", via: "operator escalation alert (persistent failure)", source: "skills/fleet-medic/medic.mjs:scan() escalations.length branch" },
];

// =====================================================================================================
// PURE CORE: real cycle detection via DFS with an explicit recursion stack (white/gray/black coloring).
// Hermetically testable — takes a plain edge list, no I/O.
// =====================================================================================================
export function buildAdjacency(edges) {
  const adj = {};
  for (const e of edges) {
    (adj[e.from] ||= new Set()).add(e.to);
    if (!adj[e.to]) adj[e.to] = adj[e.to] || new Set(); // ensure sink nodes appear as vertices too
  }
  return adj;
}

/**
 * detectCycles(adj) -> { acyclic: bool, cycles: [ [nodeA, nodeB, ..., nodeA], ... ] }
 * Standard DFS cycle detection: WHITE (unvisited) -> GRAY (on the current recursion stack) -> BLACK
 * (fully explored). A back-edge to a GRAY node means we found a cycle; we reconstruct it from the
 * current recursion stack slice between that node and the top. Continues scanning after finding one
 * cycle so a single run reports ALL cycles reachable from unvisited roots, not just the first.
 */
export function detectCycles(adj) {
  const color = {}; // 0=white,1=gray,2=black
  const stack = [];
  const cycles = [];
  for (const n of Object.keys(adj)) color[n] = 0;

  function dfs(u) {
    color[u] = 1;
    stack.push(u);
    for (const v of adj[u] || []) {
      if (color[v] === 1) {
        // back-edge to a node currently on the stack -> cycle. Slice from v's position to the top.
        const idx = stack.indexOf(v);
        cycles.push([...stack.slice(idx), v]);
      } else if (color[v] === 0) {
        dfs(v);
      }
      // color[v] === 2 (black): already fully explored via a different path, not a cycle by definition.
    }
    stack.pop();
    color[u] = 2;
  }

  for (const n of Object.keys(adj)) if (color[n] === 0) dfs(n);
  return { acyclic: cycles.length === 0, cycles };
}

/**
 * Kahn's-algorithm cross-check (topological sort): a graph is acyclic iff it admits a full topological
 * order (every node eventually reaches in-degree 0). Used here purely as an independent confirmation of
 * the DFS result — if the two disagree, that's a bug in this script, not in the fleet, and should be
 * treated as "audit tooling broken", not "fleet has a hidden cycle".
 */
export function kahnAcyclic(adj) {
  const inDegree = {};
  for (const n of Object.keys(adj)) inDegree[n] = inDegree[n] || 0;
  for (const [, targets] of Object.entries(adj)) for (const t of targets) inDegree[t] = (inDegree[t] || 0) + 1;
  const queue = Object.keys(inDegree).filter((n) => inDegree[n] === 0);
  let visited = 0;
  const degree = { ...inDegree };
  while (queue.length) {
    const n = queue.shift();
    visited++;
    for (const t of adj[n] || []) { degree[t]--; if (degree[t] === 0) queue.push(t); }
  }
  return visited === Object.keys(inDegree).length;
}

function selfEdges(edges) {
  return edges.filter((e) => e.from === e.to);
}

// ================================== CLI ==================================
function main() {
  const asJson = process.argv.includes("--json");
  const adj = buildAdjacency(EDGES);
  const { acyclic, cycles } = detectCycles(adj);
  const kahn = kahnAcyclic(adj);
  const selfLoops = selfEdges(EDGES);
  const consistent = acyclic === kahn;

  if (asJson) {
    console.log(JSON.stringify({
      ok: acyclic,
      dfsAcyclic: acyclic,
      kahnAcyclic: kahn,
      crossCheckConsistent: consistent,
      nodeCount: Object.keys(adj).length,
      edgeCount: EDGES.length,
      selfEdges: selfLoops.map((e) => ({ node: e.from, via: e.via, source: e.source })),
      cycles,
      edges: EDGES,
    }, null, 2));
  } else {
    console.log(`# escalation-graph-audit ${new Date().toISOString()}`);
    console.log(`nodes: ${Object.keys(adj).length}, edges: ${EDGES.length}`);
    console.log(`DFS result: ${acyclic ? "ACYCLIC (no cycle found)" : `CYCLE(S) FOUND (${cycles.length})`}`);
    console.log(`Kahn cross-check: ${kahn ? "agrees (acyclic)" : "agrees (cyclic)"}${consistent ? "" : "  *** DISAGREES WITH DFS - AUDIT TOOLING BUG ***"}`);
    if (selfLoops.length) {
      console.log(`\nself-edges (agent escalates to itself — expected for fleet-medic self-heal, not a real cycle):`);
      for (const e of selfLoops) console.log(`  ${e.from} -> ${e.to}  (${e.via})`);
    }
    if (cycles.length) {
      console.log(`\nCYCLES:`);
      for (const c of cycles) console.log(`  ${c.join(" -> ")}`);
    } else {
      console.log(`\nNo multi-hop escalation cycles found in this manifest.`);
    }
    console.log(`\n${MANIFEST_SOURCE_NOTES}`);
  }
  process.exit(acyclic ? 0 : 1);
}

import { fileURLToPath, pathToFileURL } from "node:url";
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
