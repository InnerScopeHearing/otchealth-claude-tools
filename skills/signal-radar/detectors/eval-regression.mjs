// Detector 3: agent-evals score regression vs the immediately-prior run of the SAME golden task.
// HIGH PRECISION rationale: this is a same-task, same-rubric, deterministic-judge comparison (no
// cross-task noise), only fires on a HARD drop (default >=0.34, i.e. losing at least one full rubric
// criterion out of a typical 3-item rubric) so judge-noise jitter of one criterion flip does not fire,
// and only compares the two MOST RECENT runs (so an old regression that already recovered stays quiet).
import { posthogQuery } from "../common.mjs";
import { makeSignal } from "../schema.mjs";

export const NAME = "eval-regression";
export const OWNER = "cto"; // agent quality is an infra/portfolio concern

const DROP_THRESHOLD = 0.34; // fires only on a genuine rubric-criterion-level regression

/** Pure core: given eval_result rows [{agent, task_id, score, ts}] (any order), find the latest two
 * runs per (agent, task_id) and flag a regression when score dropped by >= threshold. Exported for
 * hermetic unit testing. */
export function findRegressions(rows, threshold = DROP_THRESHOLD) {
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.agent}::${r.task_id}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  const regressions = [];
  for (const [key, runs] of byKey) {
    const sorted = [...runs].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)); // newest first
    if (sorted.length < 2) continue;
    const [latest, prior] = sorted;
    const drop = prior.score - latest.score;
    if (drop >= threshold) {
      regressions.push({ key, agent: latest.agent, task_id: latest.task_id, latestScore: latest.score, priorScore: prior.score, drop, latestTs: latest.ts, priorTs: prior.ts });
    }
  }
  return regressions;
}

export async function run() {
  const notes = [];
  const { results } = await posthogQuery(
    `SELECT properties.agent AS agent, properties.task_id AS task_id, properties.score AS score, timestamp AS ts
     FROM events WHERE event = 'eval_result' AND timestamp > now() - INTERVAL 60 DAY`
  );
  const rows = results.map(([agent, task_id, score, ts]) => ({ agent, task_id, score: Number(score), ts }))
    .filter((r) => r.agent && r.task_id && Number.isFinite(r.score));
  if (!rows.length) { notes.push("no eval_result history in the last 60 days"); return { signals: [], notes }; }

  const regressions = findRegressions(rows);
  const signals = regressions.map((r) => makeSignal({
    detector: NAME, owner: OWNER, subject: `${r.agent}/${r.task_id}`,
    severity: r.drop >= 0.67 ? "high" : "medium",
    why: `agent-evals ${r.agent}/${r.task_id}: ${(r.priorScore * 100).toFixed(0)}% -> ${(r.latestScore * 100).toFixed(0)}% (dropped ${(r.drop * 100).toFixed(0)} pts vs its own immediately-prior run)`,
    evidence_link: null,
    suggested_action: `Run: node skills/agent-evals/run-evals.mjs --agent ${r.agent} --task ${r.task_id} and diff the judge notes against the prior pass.`,
  }));
  return { signals, notes };
}
