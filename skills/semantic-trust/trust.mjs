#!/usr/bin/env node
// semantic-trust / trust.mjs -- pure, dependency-free CROSS-AGENT corroboration and trust scoring on
// top of the kb-memory ledger (skills/kb-memory) and the structured-notes schema
// (skills/structured-notes/note-schema.mjs).
//
// kb-memory's dedupe.mjs (Wave 1) is INTRA-agent: it stops one agent from piling up near-duplicate
// rows in its OWN private lane, or silently restating a changed value instead of writing a
// `correct --was ... --supersedes` row. This module is the next step: once facts flow into the
// shared exec team feed (`--share` / `status`, see kb-memory SKILL.md "Connected executive memory"),
// the SAME real-world claim often gets asserted independently by MULTIPLE agents in their own words.
// That is a much stronger truth signal than one agent repeating itself, so it deserves its own model:
//
//   unverified -> corroborated -> durable         (more DISTINCT agents agree, over time)
//                       \-> contested             (agents disagree and the conflict is not resolved)
//
// This module does not read/write the ledger or the shared feed itself. It is a pure scoring layer:
// callers (an orchestrator, a nightly job, a human) hand it row-shaped data and get back a score and
// an ADVISORY recommendation. See promoteRecommendation(): promotion to a shared "semantic/durable"
// layer is a SUGGESTION only. This skill never mutates the ledger, never writes to the shared feed,
// and never deletes or supersedes anything. It is purely additive.
//
// Reuses tokenize/jaccard from kb-memory/dedupe.mjs (same near-duplicate-text heuristic that Wave 1
// uses intra-agent) rather than reimplementing similarity from scratch, so "the same claim worded
// differently" is recognized the same way everywhere in the toolkit.

import { tokenize, jaccard } from "../kb-memory/dedupe.mjs";

// ---- tunable defaults (all overridable per call; never hidden global state) ----
export const DEFAULT_DURABLE_N = 3; // distinct corroborating agents required for "durable"
export const DEFAULT_HALF_LIFE_DAYS = 30; // trust contribution halves every this many days
export const DEFAULT_PROMOTE_THRESHOLD = 0.75; // trust cutoff for promoteRecommendation()
export const CONTRADICTION_PENALTY = 0.6; // sharp multiplier-style penalty weight per distinct contradicting agent
export const CONTESTED_TRUST_CEILING = 0.55; // if contradictions exist and post-penalty trust falls at/below this, contested
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Age-decayed weight of a single assertion/contradiction. Half-life decay: weight halves every
// halfLifeMs of age. confidence defaults to 1 when omitted. Never negative; ages before nowMs only
// (a "future" timestamp is clamped to age 0, i.e. full weight, rather than producing weight > 1).
function decayedWeight(ts, nowMs, halfLifeMs, confidence = 1) {
  const ageMs = Math.max(0, nowMs - Number(ts || 0));
  const c = Number.isFinite(confidence) ? confidence : 1;
  return c * Math.pow(0.5, ageMs / halfLifeMs);
}

// Dedupe a list of { agent, ts, confidence? } entries down to ONE entry per distinct agent: the
// entry with the LATEST ts wins (a later, presumably more current, restatement replaces an earlier
// one for weighting purposes; repeating the same claim does not stack). This is the mechanism that
// enforces "the SAME agent asserting 3 times does not count as 3 corroborations".
function dedupeByAgent(entries) {
  const byAgent = new Map();
  for (const e of entries || []) {
    if (!e || !e.agent) continue;
    const prev = byAgent.get(e.agent);
    if (!prev || Number(e.ts || 0) > Number(prev.ts || 0)) byAgent.set(e.agent, e);
  }
  return [...byAgent.values()];
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/**
 * Score a single claim's cross-agent trust at a point in time.
 * @param {object} args
 * @param {string} [args.subject]
 * @param {string} [args.claim]
 * @param {Array<{agent:string, ts:number, confidence?:number}>} args.assertions - one entry per
 *   agent asserting THIS claim value. Multiple entries from the same agent are deduped (latest wins)
 *   before scoring, so repeated self-assertions never inflate distinct-agent corroboration.
 * @param {Array<{agent:string, ts:number, confidence?:number}>} [args.contradictions] - entries from
 *   agents asserting a CONFLICTING value for the same subject. Deduped by agent the same way.
 * @param {number} [args.nowMs] - epoch ms "now" for decay math. MUST be supplied by callers that need
 *   determinism; defaults to Date.now() only as a last-resort fallback (tests always pass it).
 * @param {number} [args.N] - distinct-agent threshold for "durable" (default 3).
 * @param {number} [args.halfLifeDays] - trust half-life in days (default 30).
 * @returns {{trust:number, status:string, corroborations:number, distinctAgents:number, rationale:string}}
 */
export function scoreClaim({
  subject,
  claim,
  assertions = [],
  contradictions = [],
  nowMs = Date.now(),
  N = DEFAULT_DURABLE_N,
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
} = {}) {
  const halfLifeMs = halfLifeDays * MS_PER_DAY;

  // corroborations = count of RAW assertion rows given (pre-dedupe), so a caller can see how many
  // total assertion events fed the score. distinctAgents = count AFTER dedupe-by-agent, which is the
  // number that actually matters for status/threshold decisions (see module doc for this distinction).
  const corroborations = (assertions || []).length;
  const dedupedAssertions = dedupeByAgent(assertions);
  const distinctAgents = dedupedAssertions.length;
  const dedupedContradictions = dedupeByAgent(contradictions);
  const distinctContradictingAgents = dedupedContradictions.length;

  // Sum of decayed weights, one term per distinct agent (post-dedupe).
  const corroborationWeight = dedupedAssertions.reduce(
    (sum, a) => sum + decayedWeight(a.ts, nowMs, halfLifeMs, a.confidence),
    0
  );
  const contradictionWeight = dedupedContradictions.reduce(
    (sum, c) => sum + decayedWeight(c.ts, nowMs, halfLifeMs, c.confidence),
    0
  );

  // Base trust: more distinct corroborating agents -> more trust, saturating towards 1 rather than
  // growing unbounded. Using 1 - 0.5^(weight) gives a smooth diminishing-returns curve: one fresh
  // full-confidence agent (weight 1) -> 0.5; two -> 0.75; three -> 0.875, before any penalty.
  const baseTrust = 1 - Math.pow(0.5, corroborationWeight);

  // Contradiction penalty: sharp, proportional to contradiction weight, subtracted directly (not
  // multiplicatively) so even a single fresh contradicting agent visibly cuts trust.
  const penalty = CONTRADICTION_PENALTY * contradictionWeight;
  const trust = clamp01(baseTrust - penalty);

  // ---- status, in documented precedence order: contested > durable > corroborated > unverified ----
  // "Contested" fires when contradictions exist AND are not clearly outweighed by corroboration.
  // Deterministic rule (two conditions, either one triggers contested):
  //   (a) distinct contradicting agents >= distinct corroborating agents (conflict not outnumbered), or
  //   (b) post-penalty trust has fallen to/below CONTESTED_TRUST_CEILING (penalty dominated the score).
  // This matches the spec's "if contradictions exist and are not clearly outweighed" rule while
  // staying a single deterministic formula (no ambiguity for callers or tests).
  const contradictionsUnresolved =
    distinctContradictingAgents > 0 &&
    (distinctContradictingAgents >= distinctAgents || trust <= CONTESTED_TRUST_CEILING);

  let status;
  if (contradictionsUnresolved) {
    status = "contested";
  } else if (distinctAgents >= N) {
    status = "durable";
  } else if (distinctAgents >= 2) {
    status = "corroborated";
  } else {
    status = "unverified";
  }

  // ---- rationale ----
  const newestAssertion = dedupedAssertions.reduce(
    (max, a) => (Number(a.ts || 0) > Number(max || 0) ? Number(a.ts) : max),
    0
  );
  const newestAgeDays = newestAssertion ? Math.round((nowMs - newestAssertion) / MS_PER_DAY) : null;
  const parts = [];
  parts.push(
    distinctAgents === 1
      ? "1 agent asserts this claim"
      : `${distinctAgents} distinct agents corroborate`
  );
  if (newestAgeDays !== null) parts.push(`newest assertion ${newestAgeDays} day(s) old`);
  if (distinctContradictingAgents > 0) {
    parts.push(`${distinctContradictingAgents} distinct agent(s) contradict`);
    parts.push(contradictionsUnresolved ? "contradiction unresolved -> contested" : "contradiction outweighed by corroboration");
  } else {
    parts.push("no contradictions");
  }
  parts.push(`status=${status}`, `trust=${trust.toFixed(3)}`);
  const rationale = parts.join("; ");

  return { trust, status, corroborations, distinctAgents, rationale };
}

// Similarity threshold used to decide "this row's text is the SAME claim as the group's" (jaccard on
// tokenize()). Reuses the exact heuristic kb-memory/dedupe.mjs uses for near-duplicate text, applied
// ACROSS agents instead of within one agent's own rows.
const CLAIM_SIMILARITY_THRESHOLD = 0.5;

// Pull a comparable subject key + claim text out of either ledger shape:
//   - kb-memory ledger row: { ekey, evalue, text, tags, source, agent, id, ts }
//   - structured-notes shape: { subject, claim, evidence, confidence }
// A row missing both ekey/subject falls back to null subject (grouped by text similarity alone).
function extractSubjectClaim(row) {
  const subject = row.subject || row.ekey || null;
  const claimText = row.claim || row.evalue || row.text || "";
  return { subject, claimText };
}

/**
 * Group ledger-shaped and/or structured-notes-shaped rows into candidate claims by (subject, claim
 * text similarity), so the SAME real-world claim asserted by different agents in different words is
 * recognized as one claim with multiple corroborating assertions, rather than N unrelated rows.
 *
 * HEURISTIC (documented, deterministic):
 *   1. Rows are first bucketed by subject key when present (ekey or subject field, case-insensitive,
 *      trimmed). Rows with no subject key fall into a single "(no-subject)" bucket and are grouped by
 *      text similarity only within that bucket.
 *   2. Within a subject bucket, rows are clustered greedily in input order: a row joins the first
 *      existing cluster in that bucket whose representative (first) claim text has
 *      jaccard(tokenize(a), tokenize(b)) >= CLAIM_SIMILARITY_THRESHOLD; otherwise it starts a new
 *      cluster. This mirrors dedupe.mjs's nearDuplicate() comparison, just applied across agents
 *      instead of within one agent's rows.
 *   3. Within a subject bucket, the cluster with the MOST rows becomes the bucket's "majority claim".
 *      Rows in every OTHER cluster in that same bucket are treated as CONTRADICTIONS of the majority
 *      claim (same subject, but their text is NOT jaccard-similar to the majority wording, i.e. they
 *      assert a conflicting value) and are attached to the majority group's `contradictions` list
 *      instead of becoming their own standalone claim group.
 *   4. A bucket with only one cluster produces a single group with an empty `contradictions` list.
 *
 * @param {Array<object>} rows - ledger rows and/or structured notes (see extractSubjectClaim()).
 * @returns {Array<{subject:string|null, claim:string, assertions:Array, contradictions:Array}>}
 */
export function groupAssertions(rows) {
  const buckets = new Map(); // subjectKey -> array of clusters; cluster = { repText, rows: [] }

  for (const row of rows || []) {
    if (!row) continue;
    const { subject, claimText } = extractSubjectClaim(row);
    if (!claimText) continue;
    const subjectKey = subject ? String(subject).trim().toLowerCase() : "(no-subject)";
    if (!buckets.has(subjectKey)) buckets.set(subjectKey, []);
    const clusters = buckets.get(subjectKey);

    const qTokens = tokenize(claimText);
    let target = null;
    for (const cluster of clusters) {
      if (jaccard(qTokens, cluster.repTokens) >= CLAIM_SIMILARITY_THRESHOLD) {
        target = cluster;
        break;
      }
    }
    if (!target) {
      target = { repText: claimText, repTokens: qTokens, subject, rows: [] };
      clusters.push(target);
    }
    target.rows.push(row);
  }

  const groups = [];
  for (const clusters of buckets.values()) {
    if (!clusters.length) continue;
    // majority cluster = most rows (ties broken by first-seen, i.e. Array.reduce keeps the earliest
    // cluster on equal counts since we require STRICTLY greater to replace it).
    let majority = clusters[0];
    for (const c of clusters) if (c.rows.length > majority.rows.length) majority = c;

    const assertions = majority.rows.map((r) => ({
      agent: r.agent,
      ts: typeof r.ts === "number" ? r.ts : Date.parse(r.ts || 0) || 0,
      confidence: normalizeConfidence(r.confidence),
      row: r,
    }));

    const contradictions = [];
    for (const c of clusters) {
      if (c === majority) continue;
      for (const r of c.rows) {
        contradictions.push({
          agent: r.agent,
          ts: typeof r.ts === "number" ? r.ts : Date.parse(r.ts || 0) || 0,
          confidence: normalizeConfidence(r.confidence),
          row: r,
        });
      }
    }

    groups.push({
      subject: majority.subject,
      claim: majority.repText,
      assertions,
      contradictions,
    });
  }
  return groups;
}

// structured-notes confidence is "low"|"med"|"high" (or absent); scoreClaim wants a 0..1 number.
// Ledger rows may already carry a numeric confidence (kb-memory has no such field today, but future
// callers might set one) so numbers pass through unchanged.
function normalizeConfidence(c) {
  if (typeof c === "number" && Number.isFinite(c)) return c;
  if (c === "low") return 0.4;
  if (c === "med") return 0.7;
  if (c === "high") return 1;
  return 1; // default: full confidence when unspecified, matching scoreClaim's own default
}

/**
 * ADVISORY-ONLY promotion recommendation. Never mutates any shared index, ledger, or feed; purely a
 * pure function of the scored result. A human/orchestrator/CTO-level process decides whether to act
 * on this recommendation and performs any actual write to a shared "semantic/durable" layer.
 * @param {{trust:number, status:string}} scored - output of scoreClaim().
 * @param {{threshold?: number}} [opts]
 * @returns {{promote:boolean, toStatus:string}}
 */
export function promoteRecommendation(scored, { threshold = DEFAULT_PROMOTE_THRESHOLD } = {}) {
  const trust = (scored && scored.trust) || 0;
  const status = scored && scored.status;
  // Contested claims are NEVER promoted regardless of trust number: status gates promotion, not just
  // the numeric score, so a high raw trust that happens to coexist with an unresolved contradiction
  // (edge case, should be rare given CONTESTED_TRUST_CEILING) still cannot be recommended.
  const promote = status === "durable" && trust >= threshold;
  const toStatus = promote ? "semantic/durable" : status || "none";
  return { promote, toStatus };
}

// ---- CLI ----
// Usage:
//   node trust.mjs score '<json args for scoreClaim>'
//   node trust.mjs group '<json array of rows>'
//   node trust.mjs promote '<json scored>' [threshold]
function isMain() {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
}
if (isMain()) {
  const [cmd, ...rest] = process.argv.slice(2);
  const tryParseJson = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  if (cmd === "score") {
    const args = tryParseJson(rest[0]) || {};
    console.log(JSON.stringify(scoreClaim(args)));
  } else if (cmd === "group") {
    const rows = tryParseJson(rest[0]) || [];
    console.log(JSON.stringify(groupAssertions(rows)));
  } else if (cmd === "promote") {
    const scored = tryParseJson(rest[0]) || {};
    const threshold = rest[1] !== undefined ? Number(rest[1]) : undefined;
    console.log(JSON.stringify(promoteRecommendation(scored, threshold !== undefined ? { threshold } : {})));
  } else {
    console.error("usage: trust.mjs score|group|promote '<json>' [threshold]");
    process.exit(2);
  }
}
