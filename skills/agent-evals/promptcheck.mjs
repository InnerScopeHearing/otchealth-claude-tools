#!/usr/bin/env node
// promptcheck.mjs — PHASE 1 (REPORT-ONLY) prompt-regression shadow eval.
//
// Diffs two agent-evals scorecards (base-of-PR vs PR-head, run with the SAME judge/quality model) and
// renders a Markdown scorecard-diff for a PR comment. This is the CI-facing half of the
// prompt-regression gate described in .github/workflows/promptcheck.yml: that workflow runs
// `run-evals.mjs --json <path>` twice (once checked out at the PR base, once at the PR head) and hands
// both JSON files to this script.
//
// PHASE 1 = REPORT-ONLY BY DESIGN: this script only renders a comment. It never fails, never blocks a
// merge, and is not wired as a required check. A later phase could gate on `--fail-on-regression`, but
// that is explicitly NOT built here (see the PR description / FLEET-BULLETIN entry).
//
// Usage:
//   node promptcheck.mjs diff --base base-scorecard.json --head head-scorecard.json [--out comment.md]
import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

function loadScorecard(path) {
  if (!path) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (e) { console.error(`could not read/parse ${path}: ${e.message}`); return null; }
}

// Index a scorecard's results by task id so base/head rows line up even if task ORDER differs or the
// PR added/removed a task (a new task has no base row = "new"; a removed task has no head row = "removed").
function byId(scorecard) {
  const m = new Map();
  for (const r of (scorecard?.results || [])) m.set(r.id, r);
  return m;
}

function pct(n) { return `${Math.round((n || 0) * 100)}%`; }
function fmtDelta(d) {
  const p = Math.round(d * 100);
  if (p === 0) return "0";
  return p > 0 ? `+${p}` : `${p}`;
}

// Pure diff logic (no I/O), exported so tests can exercise it directly.
export function diffScorecards(base, head) {
  const baseMap = byId(base);
  const headMap = byId(head);
  const ids = [...new Set([...baseMap.keys(), ...headMap.keys()])].sort();
  const rows = ids.map((id) => {
    const b = baseMap.get(id);
    const h = headMap.get(id);
    const status = !b ? "new" : !h ? "removed" : "compared";
    const delta = b && h ? h.score - b.score : null;
    // A regression is a task that PASSED on base and now FAILS on head, or a meaningful score drop
    // (>= 15 percentage points) even if it still technically passes -> catches slow quality erosion,
    // not just a hard flip across the pass line.
    const regressed = status === "compared" && ((b.pass && !h.pass) || (delta !== null && delta <= -0.15));
    const improved = status === "compared" && delta !== null && delta >= 0.15 && !regressed;
    return { id, agent: (h || b)?.agent, callsite_id: (h || b)?.callsite_id || (h || b)?.agent, status, base: b || null, head: h || null, delta, regressed, improved };
  });
  const regressions = rows.filter((r) => r.regressed);
  const improvements = rows.filter((r) => r.improved);
  return { rows, regressions, improvements };
}

function renderMarkdown({ base, head, diff }) {
  const lines = [];
  lines.push("### Prompt-regression gate (report-only, phase 1)");
  lines.push("");
  lines.push(`This PR touches a prompt-bearing file. The golden-task suite ran on both the PR base and the PR head, judged by the same model (\`${head?.model || base?.model || "unknown"}\`). This comment is informational only: it never blocks merge.`);
  lines.push("");
  if (!base || !head) {
    lines.push(":warning: Could not compare (one or both scorecards were unavailable). See the workflow log.");
    return lines.join("\n");
  }
  lines.push(`| | base | head | delta |`);
  lines.push(`|---|---|---|---|`);
  lines.push(`| pass rate | ${base.passed}/${base.total} (${pct(base.avg)}) | ${head.passed}/${head.total} (${pct(head.avg)}) | ${fmtDelta(head.avg - base.avg)} pts |`);
  lines.push("");
  if (diff.regressions.length) {
    lines.push(`#### :small_red_triangle_down: Possible regressions (${diff.regressions.length})`);
    lines.push("");
    lines.push("| task | callsite | base | head | delta | notes |");
    lines.push("|---|---|---|---|---|---|");
    for (const r of diff.regressions) {
      lines.push(`| ${r.agent}/${r.id} | \`${r.callsite_id}\` | ${pct(r.base?.score)} | ${pct(r.head?.score)} | ${fmtDelta(r.delta)} pts | ${(r.head?.notes || "").slice(0, 120)} |`);
    }
    lines.push("");
  } else {
    lines.push("No regressions detected against the covered golden tasks.");
    lines.push("");
  }
  if (diff.improvements.length) {
    lines.push(`#### Improvements (${diff.improvements.length})`);
    lines.push("");
    lines.push("| task | callsite | base | head | delta |");
    lines.push("|---|---|---|---|---|");
    for (const r of diff.improvements) {
      lines.push(`| ${r.agent}/${r.id} | \`${r.callsite_id}\` | ${pct(r.base?.score)} | ${pct(r.head?.score)} | ${fmtDelta(r.delta)} pts |`);
    }
    lines.push("");
  }
  const newRows = diff.rows.filter((r) => r.status === "new");
  const removedRows = diff.rows.filter((r) => r.status === "removed");
  if (newRows.length) lines.push(`New task(s) on head (no base comparison): ${newRows.map((r) => `${r.agent}/${r.id}`).join(", ")}`);
  if (removedRows.length) lines.push(`Task(s) removed on head (no head comparison): ${removedRows.map((r) => `${r.agent}/${r.id}`).join(", ")}`);
  lines.push("");
  lines.push("<sub>Covers 6 golden-task surfaces (company-brain synthesis, reflect distillation, CTO/CFO/CLO personas, focus-group-loop). Phase 1 is report-only: comments only, never a required check, never blocks merge or auto-promotes/rolls back a prompt. See skills/agent-evals/promptcheck.mjs.</sub>");
  return lines.join("\n");
}

function diffCmd() {
  const basePath = val("--base", "");
  const headPath = val("--head", "");
  const outPath = val("--out", "");
  const base = loadScorecard(basePath);
  const head = loadScorecard(headPath);
  const diff = base && head ? diffScorecards(base, head) : { rows: [], regressions: [], improvements: [] };
  const md = renderMarkdown({ base, head, diff });
  if (outPath) writeFileSync(outPath, md);
  console.log(md);
  // report-only: ALWAYS exit 0, even with regressions or missing scorecards. This script never fails CI.
  process.exit(0);
}

import { pathToFileURL } from "node:url";
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (cmd === "diff") diffCmd();
  else { console.error("usage: promptcheck.mjs diff --base <base.json> --head <head.json> [--out <comment.md>]"); process.exit(0); }
}
