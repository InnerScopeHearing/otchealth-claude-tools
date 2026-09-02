#!/usr/bin/env node
// selfrepair.mjs — north-star self-improving loop, ITEMS #1 (REVERT) + #3 (REWRITE), both DRAFT-only.
//
// This is the fleet's self-improving loop (design: a 5-architect + 4-verifier Ultracode workshop,
// 2026-07-01). It sits directly ON TOP of the already-shipped prompt-regression gate
// (skills/agent-evals/promptcheck.mjs + .github/workflows/promptcheck.yml). Item #1's revert path adds
// ZERO new store, field, or model call: trigger (a scored regression), fix (revert the regressed prompt
// file to its PR-base content), and verify (re-run the same golden tasks) are ALL computable from
// shipped code. It reuses promptcheck.mjs's exported diffScorecards() so the repair proposal and the
// gate's own PR comment can never disagree about "what regressed".
//
// ITEM #3 graduates the fix side from a blunt REVERT to a gpt-5.1 REWRITE proposal: instead of throwing
// away the improvement the PR intended, it proposes a minimal rewrite of the regressed prompt hunk that
// aims to RECOVER the lost rubric criteria WHILE KEEPING the PR's intended change. This is strictly a
// PROPOSAL a human (or a separately-reviewed graduation step) reviews. The rewrite path is REPORT-ONLY
// by default and, for any future draft, is HARD-GATED behind the same --execute + SELFREPAIR_EXECUTE=1
// as the revert draft AND a mandatory full-suite re-run (see reRunFullSuiteCmd + the design's risk #1):
// a rewrite can overfit the one regressed task while silently breaking a different, untested rubric
// criterion, so the FULL agent eval suite must be re-run and show NO NEW regression before any draft PR.
//
// COMMANDS, all graduated (report first, act later — the fleet's standing autonomy discipline):
//
//   plan  (REPORT-ONLY, default; ALWAYS exits 0)
//     node selfrepair.mjs plan --base base-scorecard.json --head head-scorecard.json \
//          [--base-sha <sha>] [--out selfrepair-comment.md] [--json plan.json]
//     Reads the two scorecards the gate already produced, computes the regressions that are
//     AUTO-REPAIRABLE (a regressed golden task whose prompt_file is known), groups them by file (one
//     revert fixes every task sharing that file), and renders a "Proposed self-repair" markdown block
//     for the PR comment. It DOES NOT touch git or open a PR. This is what wires into promptcheck.yml.
//
//   rewrite  (REPORT-ONLY, item #3; ALWAYS exits 0)
//     node selfrepair.mjs rewrite --base b.json --head h.json [--out proposal.md] [--json proposal.json]
//     For the primary regressed prompt file, reads its base + head content and the failed rubric, and
//     asks gpt-5.1 (the fleet 'quality' tier; gpt-4.1-mini is BANNED for synthesis) to propose a MINIMAL
//     rewrite of the regressed hunk that recovers the lost criteria WITHOUT discarding the PR's intended
//     change. Prints a structured, clearly DRAFT-ONLY proposal. It DOES NOT edit files, touch git, or
//     open a PR — the rewrite is a proposal a human/graduation reviews. (Offline/CI-safe: if the model
//     is unavailable it still emits a well-formed abstaining proposal and exits 0.)
//
//   draft (HARD-GATED; dormant until graduation) — REVERT or REWRITE mode
//     node selfrepair.mjs draft --base b.json --head h.json --base-sha <sha> \
//          --owner <o> --repo <r> --pr <n> --head-sha <sha> --base-ref <branch> --execute [--mode rewrite]
//     Only when BOTH --execute is passed AND env SELFREPAIR_EXECUTE=1: creates a fix branch off the
//     PR head, applies the fix (revert to base content, OR — in rewrite mode — the gpt-5.1 rewritten
//     hunk), commits, pushes, and opens a DRAFT PR via the fleet-bot GitHub App
//     (skills/github-app/gh-app.mjs). It NEVER marks the PR ready and NEVER merges — a human always acks.
//     CRITICAL (design risk #1): the rewrite draft path MUST first re-run the FULL agent eval suite
//     (reRunFullSuiteCmd) and confirm NO NEW regression before opening the PR — a fix that overfits one
//     task while breaking another is otherwise invisible. Without both gates it is a dry-run that prints
//     the exact git + gh-app commands it WOULD run. Not wired into any workflow yet (graduation is a
//     deliberate, separately-reviewed step, tested against a real live regression).
//
// Non-PHI ring: operates only on the 6 non-PHI golden-task surfaces the gate already covers
// (company-brain synthesis, kb-memory reflect, CTO/CFO/CLO personas, focus-group-loop). No MedReview,
// no INND/Xero/Plaid, no clo-personal.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { diffScorecards } from "./promptcheck.mjs";
import { TIERS, chatBody, resolveTier, truncatedEmpty, positiveIntEnv } from "../../setup/model-routing.mjs";
import { logPrefixForText } from "../../setup/prompt-shape.mjs";
import { kvSecret } from "../kb-memory/azure-secret.mjs";

// LLM_PROVIDER (2026-08-27, Azure Foundry retirement port): Azure subscription 55c84f6b (the whole
// Foundry estate defaultRewriteLLM called exclusively) is permanently deleted -- verified 401 forever.
// Default flips to 'openai' (api.openai.com, model ids from setup/model-routing.mjs's OPENAI_TIERS --
// same 'quality' tier key, so SELFREPAIR_REWRITE_MODEL still means the same override regardless of
// provider). LLM_PROVIDER=foundry/azure keeps the original Foundry path selectable, one env var away,
// if that estate is ever re-provisioned.
const LLM_PROVIDER = (process.env.LLM_PROVIDER || "openai").toLowerCase();
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv[0];
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (f) => argv.includes(f);

function loadScorecard(path) {
  if (!path) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (e) { console.error(`could not read/parse ${path}: ${e.message}`); return null; }
}

// ---------------------------------------------------------------------------
// PURE CORE (no I/O, no git) — exported so tests exercise it directly.
//
// A regression is "auto-repairable" iff the regressed golden task carries a prompt_file, i.e. we know
// which single prompt surface to revert. Regressions without a prompt_file are reported as SKIPPED
// with the reason (tag the task to enable), never silently dropped. Repairs are grouped by
// prompt_file: if three tasks all regressed on the same brain.mjs change, ONE revert covers all three.
// The `primary` repair is the file whose revert recovers the single biggest drop (most-negative delta)
// — the drafter acts on primary first (largest-drop-with-a-known-file, matching the design).
// ---------------------------------------------------------------------------
// FND-20260814-bcbc SAFETY FIX (2026-08-28): a proposed revert must never target a file the PR itself
// never touched. Before this fix, `repairable` depended ONLY on whether the regressed golden task
// carried a `prompt_file` tag -- a static label on the task, not a fact about what THIS PR's diff
// contains. If that tag named a file the PR's own base..head diff never touched (a stale/wrong tag, or
// a shared file that changed on `main` via unrelated commits that happen to also be reachable from
// base_sha/head_sha), `draftCmd`'s revert steps would `git checkout base_sha -- <file>` regardless --
// silently discarding whatever UNRELATED content landed on that path between those two shas, with no
// connection to the PR under review. `opts.prFiles` closes this: when supplied, a regression is
// `repairable` only if its `prompt_file` is a member of the PR's own changed-file set.
//
// opts.prFiles is intentionally three-valued, not boolean:
//   - undefined (the default; every existing call in this file's own test suite that predates this
//     fix uses this) -- NO PR-diff context was supplied at all (a bare scorecard-vs-scorecard
//     comparison with nothing to intersect against). Behaves exactly as before this fix: unconstrained.
//   - a Set<string>  -- the PR's actual changed-file paths (computed by prDiffFiles() below, from a
//     real base_sha/head_sha). A regression's prompt_file is repairable only if it is IN this set.
//   - null           -- a real PR context was expected but the diff could NOT be computed (missing
//     base ref, git failure). FAILS CLOSED: every prompt_file is treated as out-of-diff, so NOTHING is
//     proposed, matching the fleet's rotate-on-uncertainty convention (see fleet-secret-custodian's
//     "any uncertainty -> do not rotate") rather than silently falling back to the unconstrained,
//     pre-fix behavior. See planCmd()/draftCmd() for how prFiles is actually resolved and threaded in.
export function planRepairs(base, head, opts = {}) {
  const { prFiles } = opts;
  const constrained = prFiles !== undefined; // a Set OR null both constrain; only "not supplied" does not.
  const { regressions } = base && head ? diffScorecards(base, head) : { regressions: [] };
  const annotated = regressions.map((r) => {
    const prompt_file = r.head?.prompt_file || r.base?.prompt_file || null;
    const hasFile = !!prompt_file;
    const inDiff = !constrained || (prFiles !== null && prFiles.has(prompt_file));
    return {
      id: r.id,
      agent: r.agent,
      callsite_id: r.callsite_id,
      delta: r.delta,
      base_score: r.base?.score ?? null,
      head_score: r.head?.score ?? null,
      prompt_file,
      repairable: hasFile && inDiff,
      out_of_pr_diff: hasFile && constrained && !inDiff,
    };
  });
  const repairable = annotated.filter((a) => a.repairable);
  const skipped = annotated
    .filter((a) => !a.repairable)
    .map((a) => ({
      id: a.id,
      agent: a.agent,
      callsite_id: a.callsite_id,
      delta: a.delta,
      reason: a.out_of_pr_diff
        ? "regression source is outside this PR's diff; no self-repair proposed"
        : "no prompt_file tag on the golden task; tag it to make this regression auto-repairable",
    }));

  const byFile = new Map();
  for (const a of repairable) {
    if (!byFile.has(a.prompt_file)) byFile.set(a.prompt_file, []);
    byFile.get(a.prompt_file).push(a);
  }
  const repairs = [...byFile.entries()]
    .map(([prompt_file, tasks]) => ({
      prompt_file,
      action: "revert-to-base",
      task_ids: tasks.map((t) => t.id),
      n_tasks: tasks.length,
      // worst (most-negative) delta among the tasks this revert would recover.
      worst_delta: tasks.reduce((m, t) => Math.min(m, t.delta ?? 0), 0),
    }))
    .sort((a, b) => a.worst_delta - b.worst_delta);

  return {
    total_regressions: annotated.length,
    repairable_count: repairable.length,
    repairs,
    skipped,
    primary: repairs[0] || null,
  };
}

// ---------------------------------------------------------------------------
// PURE CORE — REWRITE mode (item #3). Also no I/O in the pure function itself: the ACTUAL gpt-5.1 call
// is an INJECTED function (`llm`), so proposeRewrite() is fully unit-testable offline with a fake LLM.
//
// proposeRewrite({ regression, basePromptText, headPromptText, failedRubric }, { llm } = {})
//   Given a SINGLE regressed prompt surface (one file), its PR-BASE and PR-HEAD prompt text, and the
//   rubric criteria the head answer FAILED, propose a minimal rewrite of the regressed hunk that
//   recovers the failed criteria while keeping the PR's intended change. Returns a structured proposal:
//     { prompt_file, mode:"rewrite", draft_only:true, rationale, failed_rubric, rewritten_hunk?, abstained, abstain_reason? }
//   - ABSTAINS (no rewritten_hunk; abstained:true) when there is no failedRubric (nothing to recover
//     toward) or no prompt_file (nowhere to apply a rewrite). Abstention is a first-class, safe outcome:
//     the regression stays a normal human-routed item, never a silent drop.
//   - The injected `llm(prompt)` returns the proposed rewritten hunk text (a string). If `llm` is not
//     provided or throws, the proposal is still well-formed but abstains (offline/CI-safe). The core
//     NEVER calls the network itself; callers pass a real caller (defaultRewriteLLM) at the CLI.
// ---------------------------------------------------------------------------
export function proposeRewrite({ regression, basePromptText, headPromptText, failedRubric } = {}, { llm } = {}) {
  const prompt_file = regression?.prompt_file || regression?.head?.prompt_file || regression?.base?.prompt_file || null;
  const rubric = Array.isArray(failedRubric) ? failedRubric.filter((c) => typeof c === "string" && c.trim()) : [];
  const base = {
    prompt_file,
    mode: "rewrite",
    // draft_only is STRUCTURAL, not cosmetic: this object is a PROPOSAL a human/graduation reviews. It
    // never edits a file or opens a PR on its own. The renderer and the draft executor both honor it.
    draft_only: true,
    task_ids: regression?.task_ids || (regression?.id ? [regression.id] : []),
    agent: regression?.agent || null,
    failed_rubric: rubric,
    abstained: false,
    rationale: "",
  };
  // Guard 1: no prompt_file -> nowhere to apply a rewrite. Abstain.
  if (!prompt_file) {
    return { ...base, abstained: true, abstain_reason: "no prompt_file on the regressed task; a rewrite has no target surface", rationale: "abstained: no prompt file to rewrite" };
  }
  // Guard 2: no failed rubric -> nothing to recover toward. A rewrite with no target criteria would be
  // an unconstrained edit; abstain rather than guess.
  if (!rubric.length) {
    return { ...base, abstained: true, abstain_reason: "no failedRubric supplied; nothing to recover toward, so a rewrite would be unconstrained", rationale: "abstained: no failed rubric criteria" };
  }
  // Guard 3: no injectable LLM available -> we cannot synthesize a rewrite offline. Emit a well-formed
  // proposal that abstains from producing the hunk but records everything a human needs to do it by hand.
  if (typeof llm !== "function") {
    return { ...base, abstained: true, abstain_reason: "no LLM caller injected; rewrite hunk not synthesized (report-only offline path)", rationale: `A rewrite of \`${prompt_file}\` is warranted to recover ${rubric.length} failed rubric criterion(s), but no model caller was available to draft it. A human (or a run with the model) should draft the minimal hunk.` };
  }
  // Ask the injected model for the minimal rewrite. Any failure degrades to a safe abstention.
  let hunk = null;
  try {
    hunk = llm(buildRewritePrompt({ prompt_file, basePromptText, headPromptText, rubric }));
  } catch (e) {
    return { ...base, abstained: true, abstain_reason: `LLM caller threw (${(e && e.message) || e}); no rewrite synthesized`, rationale: "abstained: rewrite model call failed" };
  }
  if (typeof hunk !== "string" || !hunk.trim()) {
    return { ...base, abstained: true, abstain_reason: "LLM caller returned no usable rewrite text", rationale: "abstained: empty rewrite from model" };
  }
  return {
    ...base,
    rewritten_hunk: hunk.trim(),
    rationale: `Proposed DRAFT rewrite of \`${prompt_file}\` to recover ${rubric.length} failed rubric criterion(s) while keeping the PR's intended change. This is a proposal only: a human reviews it, and any draft PR must first re-run the FULL agent eval suite (see reRunFullSuiteCmd) and confirm no NEW regression.`,
  };
}

// Build the constrained instruction handed to the rewrite model. Pure string assembly (no I/O), so it
// is exercised deterministically in tests. Frames the task as MINIMAL, criteria-recovering, and
// intent-preserving, matching the design's "recover the lost rubric criteria while keeping the
// improvement the PR intended".
export function buildRewritePrompt({ prompt_file, basePromptText, headPromptText, rubric }) {
  return [
    "You are repairing a prompt-quality regression. A PR changed a prompt-bearing file and, as a side",
    "effect, a golden-task rubric criterion that used to pass now fails. Propose the MINIMAL rewrite of",
    "the changed region that RECOVERS the failed criteria WHILE KEEPING the improvement the PR intended.",
    "Do not revert the PR wholesale. Do not add unrelated changes. Output ONLY the replacement text for",
    "the regressed hunk, no commentary, no code fences.",
    "",
    `FILE: ${prompt_file}`,
    "",
    "PR-BASE version of the prompt (this passed the rubric):",
    String(basePromptText ?? "(unavailable)"),
    "",
    "PR-HEAD version of the prompt (this regressed):",
    String(headPromptText ?? "(unavailable)"),
    "",
    "RUBRIC CRITERIA THE HEAD ANSWER FAILED (recover these):",
    ...rubric.map((c, i) => `${i + 1}. ${c}`),
  ].join("\n");
}

// The EXACT full-suite re-run command a graduation step (or a human) runs before drafting a rewrite.
// Per design risk #1, a rewrite can overfit the one regressed task while breaking a different, untested
// rubric criterion, so the WHOLE agent suite must be re-run (not just the regressed task) and show no
// NEW regression. Returned as a copy-paste string; this function itself runs nothing.
export function reRunFullSuiteCmd(agent, out = "/tmp/selfrepair-fullsuite.json") {
  const a = (agent && /^[a-z0-9_-]+$/i.test(agent)) ? ` --agent ${agent}` : "";
  return `node run-evals.mjs${a} --json ${out}`;
}

function fmtDelta(d) { if (d === null || d === undefined) return "n/a"; const p = Math.round(d * 100); return p > 0 ? `+${p}` : `${p}`; }

// The revert command a graduation-step (or a human) runs to undo one regressed prompt file. Rendered
// as a copy-paste block; it is NOT executed by `plan`.
function revertCmd(promptFile, baseSha) {
  const sha = baseSha || "<PR-base-sha>";
  return `git checkout ${sha} -- ${promptFile}`;
}

export function renderMarkdown(plan, { baseSha } = {}) {
  const lines = [];
  lines.push("### Proposed self-repair (draft-mode, never auto-merges)");
  lines.push("");
  if (plan.total_regressions === 0) {
    lines.push("No regressions to repair. :white_check_mark:");
    lines.push("");
    lines.push("<sub>Self-repair is report-only phase 1: it proposes a revert of the regressed prompt file; a human (or a later, separately-reviewed graduation step) opens the draft PR. Never auto-merges. See skills/agent-evals/selfrepair.mjs.</sub>");
    return lines.join("\n");
  }
  lines.push(`${plan.repairable_count} of ${plan.total_regressions} regression(s) are auto-repairable (the regressed golden task has a known prompt file).`);
  lines.push("");
  if (plan.primary) {
    lines.push(`**Primary repair** (recovers the biggest drop, ${fmtDelta(plan.primary.worst_delta)} pts on \`${plan.primary.task_ids.join(", ")}\`):`);
    lines.push("");
    lines.push("```sh");
    lines.push(`# revert the regressed prompt file to its PR-base content, then re-run the golden tasks`);
    lines.push(revertCmd(plan.primary.prompt_file, baseSha));
    lines.push(`node skills/agent-evals/run-evals.mjs --json /tmp/repaired-scorecard.json`);
    lines.push("```");
    lines.push("");
  }
  if (plan.repairs.length > 1) {
    lines.push(`| prompt file | tasks | worst delta | action |`);
    lines.push(`|---|---|---|---|`);
    for (const r of plan.repairs) lines.push(`| \`${r.prompt_file}\` | ${r.task_ids.join(", ")} | ${fmtDelta(r.worst_delta)} pts | ${r.action} |`);
    lines.push("");
  }
  if (plan.skipped.length) {
    lines.push(`#### Not auto-repairable (${plan.skipped.length})`);
    for (const s of plan.skipped) lines.push(`- \`${s.agent}/${s.id}\` (${fmtDelta(s.delta)} pts): ${s.reason}`);
    lines.push("");
  }
  lines.push("<sub>Self-repair is report-only phase 1: it proposes a revert of the regressed prompt file; a human (or a later, separately-reviewed graduation step) opens the draft PR. Never auto-merges, never a required check. See skills/agent-evals/selfrepair.mjs.</sub>");
  return lines.join("\n");
}

// Render the REWRITE proposal (item #3) as a clearly DRAFT-ONLY Markdown block. The rewrite is a
// PROPOSAL, so the block never presents an auto-apply path: it shows the rationale, the failed rubric,
// the proposed hunk (fenced), and the MANDATORY full-suite re-run + no-new-regression gate a human must
// clear before any draft PR. Abstentions render as an explicit "abstained (reason)" note, never nothing.
export function renderRewriteMarkdown(proposal) {
  const lines = [];
  lines.push("### Proposed self-repair REWRITE (draft-only, never auto-applies, never auto-merges)");
  lines.push("");
  if (!proposal) {
    lines.push("No primary regression to rewrite. :white_check_mark:");
    lines.push("");
    lines.push("<sub>Rewrite mode is report-only: it PROPOSES a minimal rewrite of the regressed prompt hunk that recovers the lost rubric criteria while keeping the PR's intended change. A human reviews it; any draft must first re-run the full agent eval suite with no new regression. See skills/agent-evals/selfrepair.mjs.</sub>");
    return lines.join("\n");
  }
  lines.push(`**Target prompt file:** \`${proposal.prompt_file || "(none)"}\`` + (proposal.agent ? `  (agent: \`${proposal.agent}\`)` : ""));
  if (proposal.task_ids && proposal.task_ids.length) lines.push(`**Regressed task(s):** ${proposal.task_ids.map((t) => `\`${t}\``).join(", ")}`);
  lines.push("");
  if (proposal.abstained) {
    lines.push(`:warning: **Abstained (no rewrite drafted):** ${proposal.abstain_reason || "unspecified"}`);
    lines.push("");
    lines.push(proposal.rationale || "");
    lines.push("");
  } else {
    lines.push(proposal.rationale || "");
    lines.push("");
    if (proposal.failed_rubric && proposal.failed_rubric.length) {
      lines.push("**Failed rubric criteria this rewrite aims to recover:**");
      for (const c of proposal.failed_rubric) lines.push(`- ${c}`);
      lines.push("");
    }
    lines.push("**Proposed DRAFT rewrite of the regressed hunk** (a human reviews; not applied by this tool):");
    lines.push("");
    lines.push("```");
    lines.push(proposal.rewritten_hunk || "");
    lines.push("```");
    lines.push("");
  }
  // The safety gate is ALWAYS rendered, abstain or not, so the reader always sees the required check.
  lines.push("**Before any draft PR (mandatory):** re-run the FULL agent eval suite and confirm NO NEW regression (a rewrite can overfit the one regressed task while silently breaking another):");
  lines.push("");
  lines.push("```sh");
  lines.push(reRunFullSuiteCmd(proposal.agent));
  lines.push("```");
  lines.push("");
  lines.push("<sub>Rewrite mode is report-only: it PROPOSES a minimal rewrite; it does NOT edit files, touch git, or open a PR. A human reviews the proposal. Any draft PR is hard-gated (--execute + SELFREPAIR_EXECUTE=1) AND must clear the full-suite re-run above with no new regression. Never auto-merges, never a required check. See skills/agent-evals/selfrepair.mjs.</sub>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function planCmd() {
  const base = loadScorecard(val("--base", ""));
  const head = loadScorecard(val("--head", ""));
  const baseSha = val("--base-sha", "");
  const headSha = val("--head-sha", "HEAD"); // defaults to HEAD -- `plan` normally runs from inside the PR-head checkout in CI (see promptcheck.yml), so HEAD already IS the PR head commit.
  // Constrain reverts to the PR's own diff whenever we have a base ref to diff against at all
  // (FND-20260814-bcbc). Without --base-sha there is no PR to diff against (e.g. an ad hoc local
  // comparison of two scorecards with no git context) -- planRepairs runs unconstrained in that one
  // case, unchanged from before this fix. Every real caller (promptcheck.yml) always passes --base-sha.
  const plan = baseSha ? planRepairs(base, head, { prFiles: prDiffFiles(baseSha, headSha) }) : planRepairs(base, head);
  const md = renderMarkdown(plan, { baseSha });
  const outPath = val("--out", "");
  const jsonPath = val("--json", "");
  if (outPath) writeFileSync(outPath, md);
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify(plan, null, 2));
  console.log(md);
  // report-only: ALWAYS exit 0. This command never fails CI and never blocks a merge.
  process.exit(0);
}

function sh(cmd, args, opts = {}) { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }); }

// Read a file's content at a git ref (e.g. the PR-base sha). Returns null if unavailable (unknown ref,
// file added on head, not a git repo) so proposeRewrite gracefully treats it as "(unavailable)".
function fileAtRef(ref, file) {
  if (!ref || !file) return null;
  try { return sh("git", ["show", `${ref}:${file}`]); } catch { return null; }
}

// Compute the PR's own changed-file set (FND-20260814-bcbc) -- exported to planRepairs()'s opts.prFiles
// so a proposed revert can never touch a file the PR itself never changed. Returns a Set<string> of
// paths on success, or null when the diff genuinely could not be computed (missing baseRef, unresolvable
// ref, git unavailable) -- null is NOT "unrestricted"; planRepairs treats a supplied-but-null prFiles as
// "every prompt_file is out of diff" (fail closed on uncertainty, never fall back to the pre-fix
// unconstrained behavior).
//
// Uses `-C HERE` (this script's OWN directory), not the caller's CWD: `plan` is invoked from
// promptcheck.yml with CWD at the top-level runner workspace, which is a plain directory containing the
// `head/` and `base/` checkouts as subdirectories, not itself a git repo -- `HERE` (this file's own
// directory) is always inside whichever checkout is actually running the script, so it resolves
// correctly regardless of the caller's CWD.
function prDiffFiles(baseRef, headRef) {
  if (!baseRef) return null;
  try {
    const out = sh("git", ["-C", HERE, "diff", "--name-only", baseRef, headRef || "HEAD"]);
    return new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
  } catch (e) {
    console.error(`selfrepair: could not compute the PR's changed-file set (${baseRef}..${headRef || "HEAD"}): ${e.message}; treating every prompt_file as outside the PR's diff (fail closed, FND-20260814-bcbc)`);
    return null;
  }
}

// Pull the SPECIFIC rubric criteria the head answer FAILED for a given task id, from the head scorecard.
// run-evals.mjs records per-task `met` (boolean-per-criterion). We need the criterion TEXT, which lives
// in evals/<agent>.json under the same task id, so we join met[] against that task's rubric[]. Returns
// [] when the rubric text is not resolvable (proposeRewrite then abstains, which is the safe outcome).
function failedRubricFor(headScorecard, taskId) {
  const rows = headScorecard?.results || [];
  const r = rows.find((x) => x.id === taskId);
  if (!r) return [];
  const rubric = loadTaskRubric(r.agent, taskId);
  if (!rubric.length) return [];
  const met = Array.isArray(r.met) ? r.met : [];
  // A criterion is "failed" when its met flag is falsy. If met is absent/mismatched, fail-open to the
  // whole rubric (better to recover toward all criteria than to silently target none).
  const failed = rubric.filter((_, i) => met.length === rubric.length ? !met[i] : true);
  return failed.length ? failed : rubric;
}

// Resolve a task's rubric[] text from the evals/<agent>.json files (same source run-evals.mjs reads).
function loadTaskRubric(agent, taskId) {
  try {
    const dir = join(HERE, "evals");
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json") || f === "personas.json") continue;
      let arr; try { arr = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
      const t = (Array.isArray(arr) ? arr : []).find((x) => x.id === taskId && (!agent || x.agent === agent));
      if (t && Array.isArray(t.rubric)) return t.rubric.filter((c) => typeof c === "string");
    }
  } catch { /* fall through */ }
  return [];
}

// The real gpt-5.1-class rewrite caller, injected into proposeRewrite at the CLI so the pure core
// stays offline-testable. Uses the fleet 'quality' tier (gpt-4.1-mini is BANNED for synthesis) via
// setup/model-routing.mjs for the correctly-shaped request body. SYNCHRONOUS by contract (proposeRewrite
// calls llm() synchronously): callers that need the network use rewriteCmd's async wrapper, which
// resolves the hunk first and hands proposeRewrite a closure returning that resolved string.
// defaultRewriteLLM is the async resolver used to build that closure.
// REASONING-TRUNCATION (2026-08-30, FND-20260830-e927): resolveTier('quality','openai') is
// gpt-5.6-sol, reasoning-family both before and after the 2026-08-29 refresh (gpt-5.1 was already
// reasoning-family). Live-tested this exact rewrite-a-prompt-hunk shape 4 times at the existing 1200
// budget: no truncation (max observed completion 188, reasoning 51-70), so 1200 is left unchanged
// here rather than bumped speculatively. Added anyway: a `truncatedEmpty()` check on the response,
// so a rare reasoning-budget exhaustion THROWS a precise, tagged error instead of returning "" --
// proposeRewrite()'s existing `catch (e)` (see above) already converts ANY thrown error into an
// honest `abstained:true` proposal with the error message folded into `abstain_reason`, so this was
// already fail-SAFE (an empty string already hit `if (!hunk.trim())` and abstained honestly too);
// this only makes the RECORDED reason precise ("reasoning model exhausted its token budget..."
// instead of the generic "LLM caller returned no usable rewrite text"), which matters when a human
// is deciding whether to just re-run this with a bigger SELFREPAIR_REWRITE_MAX_TOKENS or investigate
// something else entirely.
//
// Exported (2026-08-30, alongside this fix) for direct unit testing with a mocked fetch, mirroring
// the same export-for-testability pattern applied to callChat/callChatOpenAI elsewhere in this sweep.
// No behavior change.
export async function defaultRewriteLLM(promptText) {
  const sys = "You rewrite a prompt hunk to recover failed rubric criteria while keeping the PR's intended change. Output ONLY the replacement hunk text, no commentary, no code fences.";
  // Prompt-caching hygiene (2026-09-02): `sys` is fully static (never depends on promptText) and is
  // already sent FIRST as the system message with the variable hunk text LAST -- already
  // cache-friendly order, so this is observability only, not a reorder.
  logPrefixForText("agent-evals:selfrepair", sys);
  if (LLM_PROVIDER === "openai") {
    const dep = process.env.SELFREPAIR_REWRITE_MODEL || resolveTier("quality", "openai").deployment;
    const key = process.env.OPENAI_API_KEY || (await smGet("openai-api-key"));
    if (!key) throw new Error("missing openai-api-key (env OPENAI_API_KEY or the fleet secret)");
    // positiveIntEnv(), not a hand-rolled Number(env) > 0 check: the raw check accepts any positive
    // value INCLUDING a sub-1 fraction and Infinity, so SELFREPAIR_REWRITE_MAX_TOKENS="0.7" would send
    // a literal fractional token budget and "Infinity" would pass straight through. That is the same
    // class the shared guard exists to close (see its floor-before-check comment) -- re-checking it by
    // hand here is exactly how the class survives its own fix.
    const maxTokens = positiveIntEnv("SELFREPAIR_REWRITE_MAX_TOKENS", 1200);
    const body = { ...chatBody(dep, { messages: [{ role: "system", content: sys }, { role: "user", content: promptText }], maxTokens }), model: dep };
    const r = await fetch(OPENAI_CHAT_URL, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("rewrite chat " + r.status + " " + (await r.text()).slice(0, 160));
    const choice = (await r.json()).choices[0];
    if (truncatedEmpty(choice)) {
      throw Object.assign(new Error(`reasoning model "${dep}" exhausted its token budget (${maxTokens}) on hidden reasoning with no visible output (finish_reason=length)`), { reasoningExhausted: true });
    }
    return choice.message.content;
  }
  // Azure/Foundry path, unchanged, selectable via LLM_PROVIDER=foundry|azure.
  // TIERS.quality.deployment (gpt-5.1, reasoning-family) only exists on the Foundry resource -- the
  // legacy azure-openai resource has no gpt-5.1 deployment at all, so pairing it with the legacy
  // endpoint/key (as this used to) always 404'd. Fixed here to resolve azure-foundry-* instead.
  const dep = process.env.SELFREPAIR_REWRITE_MODEL || TIERS.quality.deployment;
  const ep = (await smGet("azure-foundry-openai-endpoint") || "").replace(/\/$/, "");
  const key = await smGet("azure-foundry-key");
  if (!ep || !key) throw new Error("missing azure-foundry endpoint/key (Secret Manager)");
  const body = chatBody(dep, { messages: [{ role: "system", content: sys }, { role: "user", content: promptText }], maxTokens: 1200 });
  const r = await fetch(`${ep}/openai/deployments/${dep}/chat/completions?api-version=2024-02-01`, { method: "POST", headers: { "api-key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error("rewrite chat " + r.status + " " + (await r.text()).slice(0, 160));
  const choice = (await r.json()).choices[0];
  if (truncatedEmpty(choice)) {
    throw Object.assign(new Error(`reasoning model "${dep}" exhausted its token budget (1200) on hidden reasoning with no visible output (finish_reason=length)`), { reasoningExhausted: true });
  }
  return choice.message.content;
}

// Minimal GCP Secret Manager read (same JWT->token->access path run-evals.mjs uses), local to the CLI
// so the pure core imports nothing network-related.
async function smGet(id) {
  const _kv = await kvSecret(id);
  if (_kv != null) return _kv;
  if (!process.env.GCP_CLAUDE_DRIVER_SA_JSON) return null; // no GCP SA post-exit -> Key Vault only (via kvSecret above); skip the retired SM fallback
  const crypto = await import("node:crypto");
  const sa = JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const jwt = head + "." + crypto.createSign("RSA-SHA256").update(head).sign(sa.private_key, "base64url");
  const r0 = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(jwt)}` });
  const tok = (await r0.json()).access_token;
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/otchealth-shared-prod/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) return null;
  return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
}

async function rewriteCmd() {
  const base = loadScorecard(val("--base", ""));
  const head = loadScorecard(val("--head", ""));
  const baseSha = val("--base-sha", "");
  const plan = planRepairs(base, head);
  const primary = plan.primary;
  if (!primary) {
    const md = renderRewriteMarkdown(null);
    const outPath = val("--out", ""); const jsonPath = val("--json", "");
    if (outPath) writeFileSync(outPath, md);
    if (jsonPath) writeFileSync(jsonPath, JSON.stringify({ primary: null, proposal: null }, null, 2));
    console.log(md);
    process.exit(0);
  }
  const taskId = primary.task_ids[0];
  const failedRubric = failedRubricFor(head, taskId);
  // Best-effort read of the base/head prompt text at their shas; unavailable -> "(unavailable)".
  const basePromptText = fileAtRef(baseSha, primary.prompt_file);
  const headPromptText = fileAtRef(val("--head-sha", "") || "HEAD", primary.prompt_file);

  const regression = { prompt_file: primary.prompt_file, id: taskId, task_ids: primary.task_ids, agent: (head?.results || []).find((r) => r.id === taskId)?.agent || null };

  // Resolve the rewrite hunk ONCE (async network) unless offline, then hand proposeRewrite a synchronous
  // closure returning the resolved string. --offline (or no SA in env) skips the network -> a well-formed
  // abstaining proposal. This keeps the pure core synchronous while the CLI does the async work.
  let resolvedHunk = null, llmErr = null;
  const offline = has("--offline"); // Key Vault (managed-identity/OIDC) fetches azure creds without a GCP SA; a genuinely credless env still abstains via the try/catch below
  if (!offline && failedRubric.length) {
    const rewritePrompt = buildRewritePrompt({ prompt_file: primary.prompt_file, basePromptText, headPromptText, rubric: failedRubric });
    try { resolvedHunk = await defaultRewriteLLM(rewritePrompt); } catch (e) { llmErr = e; }
  }
  const llm = (offline || llmErr) ? undefined : () => resolvedHunk;
  const proposal = proposeRewrite({ regression, basePromptText, headPromptText, failedRubric }, { llm });
  // A REAL error (llmErr set) always overrides proposeRewrite()'s generic Guard-3 abstain_reason
  // ("no LLM caller injected; rewrite hunk not synthesized (report-only offline path)"), which fires
  // for ANY non-function `llm` including this one -- so the `!proposal.abstain_reason` guard this line
  // used to carry was DEAD CODE (Guard 3 always populates a non-empty string first, so the condition
  // was never true) and every real failure, including a reasoning-budget exhaustion, silently surfaced
  // as the generic offline-path message instead of the actual reason. Fixed: an actual error always
  // wins, since knowing WHY the call failed is strictly more useful than "no caller was injected" when
  // a caller WAS injected and DID run.
  if (llmErr) proposal.abstain_reason = `rewrite model call failed: ${llmErr.message}`;

  const md = renderRewriteMarkdown(proposal);
  const outPath = val("--out", ""); const jsonPath = val("--json", "");
  if (outPath) writeFileSync(outPath, md);
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify({ primary, proposal }, null, 2));
  console.log(md);
  // report-only: ALWAYS exit 0. Never touches git, never opens a PR.
  process.exit(0);
}

function draftCmd() {
  const base = loadScorecard(val("--base", ""));
  const head = loadScorecard(val("--head", ""));
  const baseSha = val("--base-sha", "");
  const headSha = val("--head-sha", "");
  const owner = val("--owner", "");
  const repo = val("--repo", "");
  const pr = val("--pr", "");
  const baseRef = val("--base-ref", "main");
  const mode = (val("--mode", "revert") || "revert").toLowerCase(); // "revert" (item #1) | "rewrite" (item #3)
  // Same PR-diff constraint as planCmd() (FND-20260814-bcbc) -- this is the path that ACTUALLY runs
  // `git checkout` against real files when armed, so it matters here even more than in the report-only
  // `plan` command above.
  const plan = baseSha ? planRepairs(base, head, { prFiles: prDiffFiles(baseSha, headSha || "HEAD") }) : planRepairs(base, head);
  if (!plan.primary) { console.log("no auto-repairable regression; nothing to draft."); process.exit(0); }

  const files = plan.repairs.map((r) => r.prompt_file);
  const branch = `claude/selfrepair/pr${pr || "x"}-${mode}-${basename(plan.primary.prompt_file).replace(/\W+/g, "-")}`;
  const primaryAgent = (head?.results || []).find((r) => r.id === plan.primary.task_ids[0])?.agent || null;

  // In REVERT mode the fix is deterministic git (restore base content). In REWRITE mode the fix is the
  // gpt-5.1 rewritten hunk applied to the ONE primary file — and per design risk #1 it is HARD-BLOCKED
  // behind a mandatory full-suite re-run showing NO NEW regression before a PR can open.
  const revertSteps = [
    ["git", ["fetch", "origin", baseSha, headSha].filter(Boolean)],
    ["git", ["checkout", "-B", branch, headSha || baseRef]],
    ...files.map((f) => ["git", ["checkout", baseSha, "--", f]]),
    ["git", ["commit", "-am", `self-repair: revert regressed prompt file(s) to PR-base\n\nRecovers ${fmtDelta(plan.primary.worst_delta)} pts on ${plan.primary.task_ids.join(", ")}. Draft only; a human reviews and merges.`]],
    ["git", ["push", "-u", "origin", branch]],
  ];

  const armed = has("--execute") && process.env.SELFREPAIR_EXECUTE === "1";

  if (mode === "rewrite") {
    // The rewrite draft is intentionally NOT auto-applied here in v1: producing the hunk needs the async
    // model call, and the SAFETY design mandates a full-suite re-run + no-new-regression check FIRST.
    // We surface the exact required sequence (the report-only `rewrite` command to get the proposal, the
    // mandatory full-suite re-run, and the confirm step) rather than silently drafting an unverified edit.
    const fullSuiteCmd = reRunFullSuiteCmd(primaryAgent);
    console.log("DRAFT REWRITE is graduation-gated and NOT auto-applied in v1 (draft-only, human-acked).\n");
    console.log("Required sequence before any rewrite draft PR can open:");
    console.log(`  1. node skills/agent-evals/selfrepair.mjs rewrite --base <b.json> --head <h.json> --base-sha ${baseSha || "<sha>"} --out /tmp/rewrite.md   # get the proposal`);
    console.log(`  2. # a human applies the reviewed hunk to ${plan.primary.prompt_file} on branch ${branch}`);
    console.log(`  3. ${fullSuiteCmd}   # MANDATORY: re-run the FULL agent suite (design risk #1)`);
    console.log(`  4. # confirm NO NEW regression vs the PR base BEFORE opening the draft PR; abort if any new task regressed`);
    console.log(`  5. gh-app: POST /repos/${owner}/${repo}/pulls  {draft:true, base:${baseRef}, head:${branch}}   # DRAFT only, never ready, never merged`);
    if (!armed) console.log("\n(Not armed anyway: pass --execute AND set SELFREPAIR_EXECUTE=1. Even armed, the full-suite gate + human application are required.)");
    process.exit(0);
  }

  // REVERT mode (item #1), unchanged.
  if (!armed) {
    console.log("DRY-RUN (draft not armed). Pass --execute AND set SELFREPAIR_EXECUTE=1 to act.\n");
    console.log("Would run:");
    for (const [c, a] of revertSteps) console.log(`  ${c} ${a.join(" ")}`);
    console.log(`  gh-app: POST /repos/${owner}/${repo}/pulls  {draft:true, base:${baseRef}, head:${branch}}`);
    process.exit(0);
  }
  // ARMED path — real git + a DRAFT PR via fleet-bot. Never marks ready, never merges.
  for (const [c, a] of revertSteps) { process.stderr.write(`+ ${c} ${a.join(" ")}\n`); sh(c, a, { stdio: ["ignore", "inherit", "inherit"] }); }
  const body = { title: `[self-repair] revert regressed prompt for PR #${pr}`, head: branch, base: baseRef, draft: true,
    body: `Automated **draft** self-repair for #${pr}. Reverts the regressed prompt file(s) to their PR-base content to recover ${fmtDelta(plan.primary.worst_delta)} pts on \`${plan.primary.task_ids.join(", ")}\`.\n\nThis is a DRAFT proposal, not an auto-merge: a human reviews the golden-task re-score and decides. Files reverted: ${files.map((f) => `\`${f}\``).join(", ")}.` };
  const out = sh("node", [join(HERE, "..", "github-app", "gh-app.mjs"), "request", "POST", `/repos/${owner}/${repo}/pulls`], { input: JSON.stringify(body), stdio: ["pipe", "pipe", "inherit"] });
  console.log(out);
  process.exit(0);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (cmd === "plan") planCmd();
  else if (cmd === "rewrite") rewriteCmd();
  else if (cmd === "draft") draftCmd();
  else { console.error("usage: selfrepair.mjs plan --base <b.json> --head <h.json> [--base-sha <sha>] [--head-sha <sha>] [--out md] [--json plan.json]\n       selfrepair.mjs rewrite --base <b.json> --head <h.json> [--base-sha <sha>] [--head-sha <sha>] [--offline] [--out md] [--json proposal.json]\n       selfrepair.mjs draft ... [--mode rewrite] --execute  (HARD-GATED; SELFREPAIR_EXECUTE=1 required; rewrite requires a full-suite re-run with no new regression)\n       (--base-sha, when passed, also constrains any proposed revert to files actually in the PR's own diff -- FND-20260814-bcbc)"); process.exit(0); }
}
