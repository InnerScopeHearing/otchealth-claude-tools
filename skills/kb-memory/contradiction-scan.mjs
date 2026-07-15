#!/usr/bin/env node
// contradiction-scan -- Phase-4 B2 of the self-maintaining brain. Pulls recent cross-agent assertion
// rows from BOTH memory stores (the shared exec feed on Blob, via kb-memory/semantic.mjs's
// readExecFeed(), and the gateway's Cosmos `memory` container, via cosmos-memory-read.mjs), finds
// where different agents have asserted CONFLICTING facts/decisions/corrections/pitfalls, and turns
// each unresolved conflict into exactly ONE decision-clock proposal for a human/agent to confirm.
//
// HARD RULE: this script NEVER resolves a contradiction itself. It never invokes any memory-mutating
// verb and never overwrites, deletes, or amends an existing entry. It only ever OPENS a decision-clock
// proposal (category "memory-contradiction"); a human or an agent, later, reviews the two claims and
// decides which one (if either) is right. "Confirmable proposal, never silent mutation." A static test
// (tests/contradiction-scan.test.mjs) asserts this file's source carries none of the mutation tokens,
// so a future edit cannot quietly turn a proposal into an in-place edit.
//
// PRECISION GATE (added after an adversarial-review false-positive repro): a shared-vocabulary topic
// cluster is NOT a contradiction just because two claims overlap in tokens. Templated same-shape,
// different-IDENTIFIER facts (two "ROTATE-BEFORE-LAUNCH: <different secrets>" lines from different
// agents; two "PENDING (Matt): <different item>" notes) score ~0.38 Jaccard and would otherwise become
// a bogus proposal. So a contested group is only surfaced when a genuine VALUE conflict exists between
// the majority claim and a contradiction, via dedupe.possibleContradiction (the same same-wording /
// DIFFERENT-VALUE heuristic used elsewhere in kb-memory). Real conflicts (e.g. a Xero rate-limit stated
// as 5000 vs 900) still fire; two lists of different secrets, or two different pending items, do not.
//
// WHY A TOPIC PARTITION STEP, NOT groupAssertions() ON THE RAW ROW LIST DIRECTLY: our rows carry no
// subject/ekey field (unlike semantic-trust's own worked examples, which key on an explicit `ekey`).
// Without a subject, groupAssertions() buckets EVERY row into one giant "(no-subject)" bucket and
// treats whichever cluster is NOT the single largest as a "contradiction" of the majority -- which is
// exactly right for two claims about the SAME narrow topic, but is nonsense across a whole day of
// otherwise-unrelated facts (semantic.mjs's own rankHitsByTrust hit this same wall and deliberately
// avoided groupAssertions' contradiction feature for that reason, staying corroboration-only). Here we
// still want real contradiction detection, so partitionBySubject() does a first, LOOSER pass
// (Jaccard >= DEFAULT_PARTITION_THRESHOLD, below groupAssertions' own fixed 0.5 CLAIM_SIMILARITY
// threshold) to group rows that are roughly about the same topic, stamps a synthetic `subject` on each
// row in a partition, and only THEN hands each partition to the real, UNCHANGED groupAssertions() +
// scoreClaim() (imported straight from semantic-trust/trust.mjs, no forked copy). The actual
// majority-vs-contradiction split and the trust/contested scoring are 100% the existing pure functions;
// this file only supplies the missing "what counts as the same topic" grouping they need to see two
// same-subject rows side by side in the first place.
//
// Ring/safety notes:
//   - readExecFeed() and cosmos-memory-read.mjs are both read-only from this file's point of view;
//     this script performs exactly one kind of write: decision.mjs open (a NEW row in
//     decisions_pending), gated behind --commit, via an INJECTABLE exec function (so tests never shell
//     out or touch Cosmos).
//   - RING/PRIVILEGE WALL (hard gate, not advisory, not belt-and-suspenders on an upstream guarantee):
//     the exec-feed / Cosmos sources CAN legally contain privileged/MNPI content (a clo-personal
//     entry should never even be there, but a cfo/clo/capital/cto row legitimately CAN mention
//     INND/securities detail in THEIR OWN lane). Without a filter, this file's whole PURPOSE -- compare
//     rows ACROSS agents -- would read that content, and a "contested" MNPI claim would get its
//     verbatim text quoted into a decision-clock proposal that any caller-supplied --owner (a free-text
//     CLI flag, not a real auth boundary) could then read. So dedupe.mjs's ringSafeCross() (the SAME
//     RING_DENY wall kb-memory/mem.mjs and company-brain/brain.mjs already enforce, byte-identical) is
//     applied TWICE, independently: once in normalizeAssertionRows() (the real production load point)
//     and again at the top of findContestedGroups() (so the pure core defends itself even if a future
//     caller, or a test, hands it rows some other way). A privileged/MNPI-flagged row can therefore
//     never become an input to, or an output of, the cross-agent scan. See dedupe.test.mjs +
//     contradiction-scan.test.mjs for the enforcement tests.
//   - Only ACTIVE (non-superseded) rows are considered per source, so a retracted belief cannot be
//     flagged as still "contradicting" someone else's current claim.
//
// Usage:
//   node contradiction-scan.mjs [--commit] [--days 14] [--owner cto]
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tokenize, jaccard, possibleContradiction, ringSafeCross } from "./dedupe.mjs";
import { readExecFeed } from "./semantic.mjs";
import * as cosmosMemory from "./cosmos-memory-read.mjs";
import { groupAssertions, scoreClaim } from "../semantic-trust/trust.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DECISION_MJS = join(HERE, "..", "decision-clock", "decision.mjs");
const KEEP_TYPES = new Set(["fact", "decision", "correction", "pitfall"]);

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const COMMIT = argv.includes("--commit");
const DAYS = parseInt(val("--days", "14"), 10) || 14;
const OWNER = (val("--owner", "") || "cto").toLowerCase();

// ============================ PURE CORE (hermetically tested, no I/O) ============================

/** Drop any row a later row in the SAME set supersedes (the retracted, no-longer-current belief), so a
 *  dead claim can never be flagged as still contradicting someone else's live one. Pure. */
function dropSuperseded(rows) {
  const supersededIds = new Set((rows || []).map((r) => r && r.supersedes).filter(Boolean));
  return (rows || []).filter((r) => r && !supersededIds.has(r.id));
}

/**
 * Normalize + merge the two raw source shapes into one common assertion-row shape:
 *   { id, agent, type, text, tags, ts, source }
 * Exec-feed rows (kb-memory Blob ledger, via readExecFeed()) carry {_agent, by, id, ts, type, text,
 * tags, supersedes}; the ASSERTING agent is `by` when present (a cross-lane note is attributed to its
 * writer, not the ledger it was filed on), falling back to `_agent` (the ledger owner) for legacy rows.
 * Cosmos memory rows carry {id, agent, kind, text, tags, ts?, _ts, supersedes}. Only fact/decision/
 * correction/pitfall rows are kept from EITHER source (status/entity/alias/episode are not assertable
 * claims); rows missing an agent or text are dropped. This is also the RING/PRIVILEGE WALL load point:
 * ringSafeCross() drops any row from a privileged agent lane (clo-personal) AND any row whose own
 * text/tags matches the fleet's shared MNPI/PHI content wall, regardless of which agent asserted it --
 * see the file-header "Ring/safety notes" for why a content check is required, not just an agent check.
 * Pure.
 */
export function normalizeAssertionRows(execFeedRows, cosmosRows) {
  const execActive = dropSuperseded(execFeedRows || []);
  const cosmosActive = dropSuperseded(cosmosRows || []);
  const fromExec = execActive
    .filter((r) => r && KEEP_TYPES.has(r.type))
    .map((r) => ({
      id: r.id,
      agent: String(r.by || r._agent || r.agent || "").toLowerCase(),
      type: r.type,
      text: r.text || "",
      tags: r.tags || [],
      ts: r.ts || null,
      source: "exec-feed",
    }));
  const fromCosmos = cosmosActive
    .filter((r) => r && KEEP_TYPES.has(r.kind))
    .map((r) => ({
      id: r.id,
      agent: String(r.agent || "").toLowerCase(),
      type: r.kind,
      text: r.text || "",
      tags: r.tags || [],
      ts: r.ts || (r._ts ? new Date(r._ts * 1000).toISOString() : null),
      source: "cosmos-memory",
    }));
  return [...fromExec, ...fromCosmos].filter((r) => r.agent && r.text && ringSafeCross(r));
}

/** Recency filter for the exec-feed side (readExecFeed() itself returns the WHOLE ledger, unbounded;
 *  the Cosmos side is already time-bounded by its own query). Pure. */
export function filterRecent(rows, days, nowMs = Date.now()) {
  const cutoff = nowMs - days * 86400000;
  return (rows || []).filter((r) => {
    const t = Date.parse(r && r.ts);
    return Number.isFinite(t) && t >= cutoff;
  });
}

// Outer topic-partition threshold: deliberately LOOSER than groupAssertions' own fixed 0.5
// CLAIM_SIMILARITY_THRESHOLD (see the file-header comment for why both levels are needed).
export const DEFAULT_PARTITION_THRESHOLD = 0.35;
// Safety cap: single-link Jaccard clustering can "chain" unrelated rows together at fleet scale. A
// partition this large has very likely over-merged multiple unrelated topics, so it is skipped
// (logged, not fatal) rather than risk a noisy/bogus mass "contradiction" proposal. Mirrors the
// MAX_DELETES_PER_CONTAINER blast-radius cap already used in agent-state-janitor.mjs.
export const MAX_PARTITION_SIZE = 40;

/**
 * Best-effort topic grouping across ALL agents (NOT scoped to one agent -- the point is to find where
 * DIFFERENT agents talk about the same thing). Greedy Jaccard clustering on row text (same algorithm
 * shape as clusterEpisodes / semantic.mjs's rankHitsByTrust), then each cluster of >= 2 rows is
 * stamped with a synthetic `subject` key so groupAssertions() can bucket on it. Pure.
 * @returns {Array<Array<object>>} partitions, each an array of rows carrying a shared `subject`.
 */
export function partitionBySubject(rows, { threshold = DEFAULT_PARTITION_THRESHOLD, maxPartitionSize = MAX_PARTITION_SIZE } = {}) {
  const clusters = []; // { repTokens, rows }
  for (const r of rows || []) {
    if (!r || !r.text) continue;
    const toks = tokenize(r.text);
    let target = null;
    for (const c of clusters) {
      if (jaccard(toks, c.repTokens) >= threshold) { target = c; break; }
    }
    if (!target) { target = { repTokens: toks, rows: [] }; clusters.push(target); }
    target.rows.push(r);
  }
  const partitions = [];
  for (const c of clusters) {
    if (c.rows.length < 2) continue; // nothing to compare a lone claim against
    if (c.rows.length > maxPartitionSize) {
      console.error(`[contradiction-scan] skipping an oversized topic partition (${c.rows.length} rows > ${maxPartitionSize}); likely over-merged unrelated topics, too noisy to trust automatically.`);
      continue;
    }
    partitions.push(c.rows);
  }
  return partitions.map((rowsInPartition, i) => rowsInPartition.map((r) => ({ ...r, subject: `cluster-${i}` })));
}

// PRECISION GATE subject-similarity floor. Deliberately >= a single templated-overlap pair (~0.38)
// so two same-shape/different-identifier lines do not clear it on wording alone, yet <= a genuine
// two-agent rate-limit conflict (the Xero 5000-vs-900 fixture pair jaccard = 0.4545) so real
// contradictions still fire. Used only INSIDE the value-conflict gate; the coarse partition step keeps
// its own looser DEFAULT_PARTITION_THRESHOLD for grouping.
export const DEFAULT_CONFLICT_SUBJECT_THRESHOLD = 0.4;

/**
 * The genuine-conflict gate. Returns true only when the majority claim and at least one contradiction
 * row are about the SAME subject (non-value wording overlap >= subjectThreshold) AND assert DIFFERENT
 * numeric VALUE tokens, reusing dedupe.possibleContradiction verbatim (the exact same-wording /
 * different-value heuristic kb-memory already uses at write time). A pair with NO numeric value tokens
 * (e.g. two ROTATE-BEFORE-LAUNCH lines naming different secret NAMES) can never satisfy it, which is
 * precisely how the templated-identifier false positives are filtered. Pure, no I/O.
 * NOTE (precision-over-recall, by design): a purely lexical contradiction with no numbers (e.g. "TReO
 * is a PSAP" vs "TReO is a hearing aid") will NOT fire here; the coordinator directed the differing-
 * value heuristic as the gate because a false proposal erodes trust more than a missed lexical one.
 */
export function hasGenuineValueConflict(majorityText, contradictions, { subjectThreshold = DEFAULT_CONFLICT_SUBJECT_THRESHOLD } = {}) {
  if (!majorityText) return false;
  for (const c of contradictions || []) {
    const cText = (c && c.row && c.row.text) || (c && c.text) || "";
    if (!cText) continue;
    const cId = (c && c.row && c.row.id) || (c && c.id) || "c";
    // Pass a uniform synthetic type so possibleContradiction's type filter is a no-op here: we use it
    // purely as a same-subject/different-value comparator over the two claim texts.
    const hit = possibleContradiction(majorityText, [{ text: cText, type: "claim", id: cId }], { type: "claim", subjectThreshold });
    if (hit) return true;
  }
  return false;
}

/**
 * The full pure pipeline: partition by topic, run the UNCHANGED groupAssertions()+scoreClaim() per
 * partition, keep groups whose scored status is "contested" AND that clear the value-conflict gate
 * (so templated same-shape/different-identifier facts never become a proposal). Pure (scoreClaim's
 * nowMs defaults to Date.now() unless passed, matching semantic-trust's own contract; tests pass it).
 *
 * RING/PRIVILEGE WALL, SECOND independent gate: `rows` is re-filtered through ringSafeCross() at the
 * very top, before partitioning. normalizeAssertionRows() already applies the identical filter at the
 * real production load point (see its docstring), but this pure core enforces the SAME wall on its own
 * terms too, so a privileged/MNPI-flagged row can never become an input here even if a future caller
 * (or a test) hands findContestedGroups a row list assembled some other way. Never widens; only drops.
 * @returns {Array<{subject, claim, assertions, contradictions, scored}>}
 */
export function findContestedGroups(rows, opts = {}) {
  const safeRows = (rows || []).filter(ringSafeCross);
  const partitions = partitionBySubject(safeRows, { threshold: opts.partitionThreshold, maxPartitionSize: opts.maxPartitionSize });
  const nowMs = opts.nowMs ?? Date.now();
  const conflictSubjectThreshold = opts.conflictSubjectThreshold ?? DEFAULT_CONFLICT_SUBJECT_THRESHOLD;
  const out = [];
  for (const partitionRows of partitions) {
    const groups = groupAssertions(partitionRows); // one synthetic subject per partition -> exactly one group
    for (const g of groups) {
      const scored = scoreClaim({
        subject: g.subject,
        claim: g.claim,
        assertions: g.assertions.map((a) => ({ agent: a.agent, ts: a.ts, confidence: a.confidence })),
        contradictions: g.contradictions.map((c) => ({ agent: c.agent, ts: c.ts, confidence: c.confidence })),
        nowMs,
        N: opts.N,
        halfLifeDays: opts.halfLifeDays,
      });
      if (scored.status !== "contested") continue;
      // GATE: a "contested" score off token overlap alone is not enough; require a real value conflict
      // between the majority claim and a contradiction. Filters the templated-identifier false positive.
      if (!hasGenuineValueConflict(g.claim, g.contradictions, { subjectThreshold: conflictSubjectThreshold })) continue;
      out.push({ ...g, scored });
    }
  }
  return out;
}

/** Render a decision-clock-ready { text, evidence, majorityAgents, minorityAgents } for one contested
 *  group. Pure. No em dashes or en dashes (published-copy rule). */
export function buildProposalText(group) {
  const clip = (s, n = 140) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const majorityAgents = [...new Set(group.assertions.map((a) => a.agent))];
  const minorityAgents = [...new Set(group.contradictions.map((c) => c.agent))];
  const majoritySample = group.assertions[0] ? clip(group.assertions[0].row.text) : clip(group.claim);
  const minorityLines = group.contradictions.map((c) => `[${c.agent}] "${clip(c.row.text)}"`).join("; ");
  const text = `Cross-agent memory contradiction. Majority (${majorityAgents.join(", ") || "unknown"}) asserts: "${majoritySample}". Contradicted by ${minorityAgents.join(", ") || "unknown"}: ${minorityLines}. Trust score ${group.scored.trust.toFixed(2)} (${group.scored.rationale}). Review both claims and either confirm the majority (close this, no action needed) or amend the record on the wrong entry by hand. This proposal never auto-resolves.`;
  const evidence = [...group.assertions, ...group.contradictions]
    .map((a) => `${a.agent}:${(a.row && a.row.source) || "?"}:${(a.row && a.row.id) || "?"}`)
    .join(",");
  return { text, evidence, majorityAgents, minorityAgents };
}

/** Map contested groups -> one decision-clock proposal descriptor each. Pure. */
export function proposalsFor(groups, { owner = "cto" } = {}) {
  return (groups || []).map((g) => {
    const built = buildProposalText(g);
    return {
      category: "memory-contradiction",
      owner: String(owner || "cto").toLowerCase(),
      text: built.text,
      evidence: built.evidence,
      majorityAgents: built.majorityAgents,
      minorityAgents: built.minorityAgents,
      claim: g.claim,
    };
  });
}

// ================================== Impure: I/O ==================================

/**
 * Open (or, in dry-run, just log) one decision-clock proposal per entry in `proposals`. `exec` is
 * INJECTABLE: production wires it to a real `node decision.mjs open ...` shell-out; tests pass a
 * counting spy so "exactly ONE proposal call" is directly assertable with zero mocking of child_process
 * or Cosmos. When commit is false (the default), `exec` (real or spy) is NEVER invoked -- the dry-run
 * contract is enforced structurally, not just by convention.
 */
export async function openProposals(proposals, { commit = false, exec, decisionMjsPath = DECISION_MJS } = {}) {
  const runner = exec || (async (args) => { execFileSync("node", [decisionMjsPath, ...args], { stdio: "inherit" }); });
  const results = [];
  for (const p of proposals || []) {
    if (!commit) { results.push({ ...p, opened: false }); continue; }
    const args = ["open", "--category", p.category, "--owner", p.owner, "--text", p.text];
    if (p.evidence) args.push("--evidence", p.evidence);
    try {
      await runner(args, p);
      results.push({ ...p, opened: true });
    } catch (e) {
      console.error(`  [contradiction-scan] failed to open a proposal (owner=${p.owner}): ${e.message}`);
      results.push({ ...p, opened: false, error: e.message });
    }
  }
  return results;
}

async function fetchCosmosMemoryRows(days) {
  if (!(await cosmosMemory.isConfigured())) {
    console.error("[contradiction-scan] Cosmos agent-state not configured in this environment; continuing with the exec-feed side only.");
    return [];
  }
  const cutoff = Math.floor(Date.now() / 1000 - days * 86400);
  return cosmosMemory.queryMemory(
    "SELECT * FROM c WHERE ARRAY_CONTAINS(@kinds, c.kind) AND c._ts >= @cutoff",
    [{ name: "@kinds", value: ["fact", "decision", "correction", "pitfall"] }, { name: "@cutoff", value: cutoff }],
  );
}

async function main() {
  console.log(`[contradiction-scan] starting -- mode=${COMMIT ? "COMMIT" : "DRY-RUN"} days=${DAYS} owner=${OWNER}`);

  let execRows = [];
  try { execRows = filterRecent(await readExecFeed(), DAYS); }
  catch (e) { console.error(`[contradiction-scan] exec-feed unavailable (${e.message}); continuing with the Cosmos side only.`); }

  let cosmosRows = [];
  try { cosmosRows = await fetchCosmosMemoryRows(DAYS); }
  catch (e) { console.error(`[contradiction-scan] Cosmos memory unavailable (${e.message}); continuing with the exec-feed side only.`); }

  const rows = normalizeAssertionRows(execRows, cosmosRows);
  console.log(`[contradiction-scan] ${rows.length} candidate assertion row(s) (${execRows.length} exec-feed + ${cosmosRows.length} cosmos, last ${DAYS}d) across ${new Set(rows.map((r) => r.agent)).size} agent(s)`);
  if (!rows.length) { console.log("[contradiction-scan] nothing to scan."); return; }

  const groups = findContestedGroups(rows, { nowMs: Date.now() });
  if (!groups.length) { console.log("[contradiction-scan] no contested cross-agent claims found."); return; }

  const proposals = proposalsFor(groups, { owner: OWNER });
  console.log(`[contradiction-scan] ${proposals.length} contested group(s)${COMMIT ? " (opening decision-clock proposals)" : " (dry-run; pass --commit to open decision-clock proposals)"}:`);
  const opened = await openProposals(proposals, { commit: COMMIT });
  for (const o of opened) console.log(`  [${o.opened ? "OPENED" : "DRY-RUN"}] owner=${o.owner}${o.error ? ` ERROR=${o.error}` : ""} ${o.text.slice(0, 160)}`);
  console.log(`[contradiction-scan] done. ${proposals.length} contested group(s), ${COMMIT ? opened.filter((o) => o.opened).length + " proposal(s) opened" : "0 opened (dry-run; pass --commit)"}.`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((e) => { console.error("[contradiction-scan] ERROR (fail-open, exiting 0): " + e.message); process.exit(0); });
}
