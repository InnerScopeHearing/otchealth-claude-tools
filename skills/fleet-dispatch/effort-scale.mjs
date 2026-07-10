// effort-scale: pure helper for the orchestrator effort-scaling standard (app-kit/ORCHESTRATION-STANDARD.md).
// Recommends how many subagents to fan out for a task, based on signals in the task text. Dependency-free,
// no I/O, no network: a plain function so it can be unit tested and reused from any orchestrator entry point
// (fleet-dispatch send/--spawn, autonomous-run, or a human-driven session).
//
// The lesson this codifies: do not fan out 4 agents for a single lookup (wasted verification-tractability
// budget, nothing to synthesize); do fan out for genuinely multi-facet work (comparisons, broad research,
// red-team, or a build that touches disjoint files) where parallel angles are worth more than serial focus.
// Cap at 4 regardless of signal strength: past 4 in-flight subagents, a human/orchestrator cannot verify
// every diff before it is called real, and the merge queue stops being tractable.

const MAX_AGENTS = 4;

const LOOKUP_SIGNALS = [
  /\bwhat is\b/i,
  /\bwhat's\b/i,
  /\bwho is\b/i,
  /\bwhen (is|was|did)\b/i,
  /\bwhere is\b/i,
  /\bhow many\b/i,
  /\blook ?up\b/i,
  /\bsingle fact\b/i,
  /\bquick (question|check|answer)\b/i,
  /\bone[- ]off\b/i,
];

const COMPARE_SIGNALS = [
  /\bvs\.?\b/i,
  /\bversus\b/i,
  /\bcompare\b/i,
  /\bcomparison\b/i,
  /\btrade ?offs?\b/i,
  /\bwhich (is|one) (better|best)\b/i,
  /\bpros and cons\b/i,
  /\boptions? across\b/i,
];

const RESEARCH_SIGNALS = [
  /\breverse[- ]engineer\b/i,
  /\binvestigate\b/i,
  /\bdeep dive\b/i,
  /\bmulti[- ]facet\b/i,
  /\bbroad (research|survey)\b/i,
  /\bexplore (the )?(codebase|landscape)\b/i,
  /\bevery (angle|facet)\b/i,
  /\baudit\b/i,
  /\bthe issue\b/i,
];

const REDTEAM_SIGNALS = [
  /\bred[- ]?team\b/i,
  /\bbreak it\b/i,
  /\battack\b/i,
  /\bpenetration\b/i,
  /\badversarial\b/i,
  /\bfind (the )?vulnerabilit/i,
  /\bstress[- ]test\b/i,
];

const BUILD_SIGNALS = [
  /\bbuild\b/i,
  /\bimplement\b/i,
  /\bship\b/i,
  /\bacross (disjoint|multiple|several) files\b/i,
  /\brefactor\b/i,
  /\bmigrat/i,
];

const DISJOINT_FILES_SIGNAL = /\bdisjoint files\b/i;
const BREAK_THEN_FIX_SIGNAL = /\bbreak it,?\s*then fix\b/i;

function countMatches(text, patterns) {
  return patterns.reduce((n, re) => (re.test(text) ? n + 1 : n), 0);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * recommendFanout(taskText, hints) -> { agents, mode, rationale }
 *
 * taskText: free-form description of the task the orchestrator is about to dispatch.
 * hints: optional overrides, e.g. { maxAgents: 2 } to cap below the standard's ceiling of 4,
 *        or { minAgents: 1 } to floor it. Hints always win over the text-derived recommendation,
 *        but are still clamped to [1, MAX_AGENTS] (the cap is a hard rule, not a suggestion).
 */
export function recommendFanout(taskText, hints) {
  const text = String(taskText || "");
  const h = hints || {};

  const lookupHits = countMatches(text, LOOKUP_SIGNALS);
  const compareHits = countMatches(text, COMPARE_SIGNALS);
  const researchHits = countMatches(text, RESEARCH_SIGNALS);
  const redteamHits = countMatches(text, REDTEAM_SIGNALS);
  const buildHits = countMatches(text, BUILD_SIGNALS);
  const disjoint = DISJOINT_FILES_SIGNAL.test(text);
  const breakThenFix = BREAK_THEN_FIX_SIGNAL.test(text);

  let agents = 1;
  let mode = "single";
  let rationale = "No multi-facet, comparison, research, or red-team signal found; treat as a single-fact lookup and dispatch one agent.";

  // Evaluate strongest signal first: red-team > research > compare > build > lookup.
  if (redteamHits > 0 || breakThenFix) {
    mode = "redteam";
    agents = breakThenFix ? 4 : 3;
    rationale = `Red-team signal detected (break-it-then-fix or adversarial/attack language): dispatch ${agents} agents to attack from different angles before the fix pass.`;
  } else if (researchHits > 0) {
    mode = "research";
    agents = clamp(3 + Math.min(researchHits - 1, 1), 3, 4);
    rationale = `Multi-facet research signal detected (${researchHits} match${researchHits > 1 ? "es" : ""}): broad/reverse-engineer/investigate work benefits from parallel angles, up to the cap of ${MAX_AGENTS}.`;
  } else if (compareHits > 0) {
    mode = "compare";
    agents = clamp(2 + Math.min(compareHits - 1, 1), 2, 3);
    rationale = `Comparison signal detected (${compareHits} match${compareHits > 1 ? "es" : ""}): a "vs"/compare/tradeoffs task splits cleanly across ${agents} agents, one per option or angle.`;
  } else if (buildHits > 0 && disjoint) {
    mode = "build";
    agents = 4;
    rationale = "Build task explicitly touching disjoint files: fan out one builder per file-set, up to the cap of 4, so diffs never collide and each is independently verifiable.";
  } else if (buildHits > 0) {
    mode = "build";
    agents = 3;
    rationale = "Build/implement signal without an explicit disjoint-files split: default to a modest fan-out (3) rather than assuming full parallelism.";
  } else if (lookupHits > 0) {
    mode = "single";
    agents = 1;
    rationale = "Single-fact lookup signal detected: one agent is enough; fanning out here would waste verification budget with nothing to synthesize.";
  }

  // Hints override the text-derived call, but the cap and floor are non-negotiable.
  if (Number.isFinite(h.maxAgents)) agents = Math.min(agents, h.maxAgents);
  if (Number.isFinite(h.minAgents)) agents = Math.max(agents, h.minAgents);
  agents = clamp(Math.round(agents), 1, MAX_AGENTS);

  if (Number.isFinite(h.maxAgents) || Number.isFinite(h.minAgents)) {
    rationale += ` (hint applied: ${JSON.stringify(h)}, final agents=${agents})`;
  }

  return { agents, mode, rationale };
}

export default { recommendFanout };

// CLI: node effort-scale.mjs "<task text>" [--max N] [--min N]
const isMain = (() => {
  try {
    return process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
  } catch {
    return false;
  }
})();

if (isMain) {
  const argv = process.argv.slice(2);
  const flagVal = (f) => {
    const i = argv.indexOf(f);
    return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : undefined;
  };
  const taskText = argv.filter((a, i, arr) => !a.startsWith("--") && !(i > 0 && arr[i - 1].startsWith("--"))).join(" ");
  const hints = {};
  const maxAgents = flagVal("--max");
  const minAgents = flagVal("--min");
  if (Number.isFinite(maxAgents)) hints.maxAgents = maxAgents;
  if (Number.isFinite(minAgents)) hints.minAgents = minAgents;

  if (!taskText.trim()) {
    console.error('usage: node effort-scale.mjs "<task text>" [--max N] [--min N]');
    process.exit(2);
  }

  const result = recommendFanout(taskText, hints);
  console.log(JSON.stringify(result, null, 2));
}
