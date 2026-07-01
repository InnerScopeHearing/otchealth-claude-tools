#!/usr/bin/env node
// selfrepair.mjs — north-star self-improving loop, ITEM #1: prompt-regression SELF-REPAIR (DRAFT mode).
//
// This is the first build of the fleet's self-improving loop (design: a 5-architect + 4-verifier
// Ultracode workshop, 2026-07-01). It sits directly ON TOP of the already-shipped prompt-regression
// gate (skills/agent-evals/promptcheck.mjs + .github/workflows/promptcheck.yml) and adds ZERO new
// store, field, or model call: trigger (a scored regression), fix (revert the regressed prompt file
// to its PR-base content), and verify (re-run the same golden tasks) are ALL computable from shipped
// code. It reuses promptcheck.mjs's exported diffScorecards() so the repair proposal and the gate's
// own PR comment can never disagree about "what regressed".
//
// TWO commands, both graduated (report first, act later — the fleet's standing autonomy discipline):
//
//   plan  (REPORT-ONLY, default; ALWAYS exits 0)
//     node selfrepair.mjs plan --base base-scorecard.json --head head-scorecard.json \
//          [--base-sha <sha>] [--out selfrepair-comment.md] [--json plan.json]
//     Reads the two scorecards the gate already produced, computes the regressions that are
//     AUTO-REPAIRABLE (a regressed golden task whose prompt_file is known), groups them by file (one
//     revert fixes every task sharing that file), and renders a "Proposed self-repair" markdown block
//     for the PR comment. It DOES NOT touch git or open a PR. This is what wires into promptcheck.yml.
//
//   draft (HARD-GATED; dormant until graduation)
//     node selfrepair.mjs draft --base b.json --head h.json --base-sha <sha> \
//          --owner <o> --repo <r> --pr <n> --head-sha <sha> --base-ref <branch> --execute
//     Only when BOTH --execute is passed AND env SELFREPAIR_EXECUTE=1: creates a fix branch off the
//     PR head, restores the regressed prompt_file(s) to their PR-base content, commits, pushes, and
//     opens a DRAFT PR via the fleet-bot GitHub App (skills/github-app/gh-app.mjs). It NEVER marks the
//     PR ready and NEVER merges — a human always acks. Without both gates it is a dry-run that prints
//     the exact git + gh-app commands it WOULD run. Not wired into any workflow yet (graduation is a
//     deliberate, separately-reviewed step, tested against a real live regression).
//
// Non-PHI ring: operates only on the 6 non-PHI golden-task surfaces the gate already covers
// (company-brain synthesis, kb-memory reflect, CTO/CFO/CLO personas, focus-group-loop). No MedReview,
// no INND/Xero/Plaid, no clo-personal.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { diffScorecards } from "./promptcheck.mjs";

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
export function planRepairs(base, head) {
  const { regressions } = base && head ? diffScorecards(base, head) : { regressions: [] };
  const annotated = regressions.map((r) => {
    const prompt_file = r.head?.prompt_file || r.base?.prompt_file || null;
    return {
      id: r.id,
      agent: r.agent,
      callsite_id: r.callsite_id,
      delta: r.delta,
      base_score: r.base?.score ?? null,
      head_score: r.head?.score ?? null,
      prompt_file,
      repairable: !!prompt_file,
    };
  });
  const repairable = annotated.filter((a) => a.repairable);
  const skipped = annotated
    .filter((a) => !a.repairable)
    .map((a) => ({ id: a.id, agent: a.agent, callsite_id: a.callsite_id, delta: a.delta, reason: "no prompt_file tag on the golden task; tag it to make this regression auto-repairable" }));

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

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function planCmd() {
  const base = loadScorecard(val("--base", ""));
  const head = loadScorecard(val("--head", ""));
  const baseSha = val("--base-sha", "");
  const plan = planRepairs(base, head);
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

function draftCmd() {
  const base = loadScorecard(val("--base", ""));
  const head = loadScorecard(val("--head", ""));
  const baseSha = val("--base-sha", "");
  const headSha = val("--head-sha", "");
  const owner = val("--owner", "");
  const repo = val("--repo", "");
  const pr = val("--pr", "");
  const baseRef = val("--base-ref", "main");
  const plan = planRepairs(base, head);
  if (!plan.primary) { console.log("no auto-repairable regression; nothing to draft."); process.exit(0); }

  const files = plan.repairs.map((r) => r.prompt_file);
  const branch = `claude/selfrepair/pr${pr || "x"}-${basename(plan.primary.prompt_file).replace(/\W+/g, "-")}`;
  const commitMsg = `self-repair: revert regressed prompt file(s) to PR-base\n\nRecovers ${fmtDelta(plan.primary.worst_delta)} pts on ${plan.primary.task_ids.join(", ")}. Draft only; a human reviews and merges.`;
  const steps = [
    ["git", ["fetch", "origin", baseSha, headSha].filter(Boolean)],
    ["git", ["checkout", "-B", branch, headSha || baseRef]],
    ...files.map((f) => ["git", ["checkout", baseSha, "--", f]]),
    ["git", ["commit", "-am", commitMsg]],
    ["git", ["push", "-u", "origin", branch]],
  ];

  const armed = has("--execute") && process.env.SELFREPAIR_EXECUTE === "1";
  if (!armed) {
    console.log("DRY-RUN (draft not armed). Pass --execute AND set SELFREPAIR_EXECUTE=1 to act.\n");
    console.log("Would run:");
    for (const [c, a] of steps) console.log(`  ${c} ${a.join(" ")}`);
    console.log(`  gh-app: POST /repos/${owner}/${repo}/pulls  {draft:true, base:${baseRef}, head:${branch}}`);
    process.exit(0);
  }
  // ARMED path — real git + a DRAFT PR via fleet-bot. Never marks ready, never merges.
  for (const [c, a] of steps) { process.stderr.write(`+ ${c} ${a.join(" ")}\n`); sh(c, a, { stdio: ["ignore", "inherit", "inherit"] }); }
  const body = { title: `[self-repair] revert regressed prompt for PR #${pr}`, head: branch, base: baseRef, draft: true,
    body: `Automated **draft** self-repair for #${pr}. Reverts the regressed prompt file(s) to their PR-base content to recover ${fmtDelta(plan.primary.worst_delta)} pts on \`${plan.primary.task_ids.join(", ")}\`.\n\nThis is a DRAFT proposal, not an auto-merge: a human reviews the golden-task re-score and decides. Files reverted: ${files.map((f) => `\`${f}\``).join(", ")}.` };
  const out = sh("node", [join(HERE, "..", "github-app", "gh-app.mjs"), "request", "POST", `/repos/${owner}/${repo}/pulls`], { input: JSON.stringify(body), stdio: ["pipe", "pipe", "inherit"] });
  console.log(out);
  process.exit(0);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (cmd === "plan") planCmd();
  else if (cmd === "draft") draftCmd();
  else { console.error("usage: selfrepair.mjs plan --base <b.json> --head <h.json> [--base-sha <sha>] [--out md] [--json plan.json]\n       selfrepair.mjs draft ... --execute  (HARD-GATED; SELFREPAIR_EXECUTE=1 required)"); process.exit(0); }
}
