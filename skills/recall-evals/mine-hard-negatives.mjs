#!/usr/bin/env node
// mine-hard-negatives.mjs -- mine + VALIDATE real HARD-NEGATIVE (contrastive) recall-eval cases from
// the fleet's own memory ledger, the same "corrections/decision-supersede pattern" mine-cases.mjs's
// SKILL.md and this fleet's regression-ledger both already rely on.
//
// WHAT A HARD-NEGATIVE CASE IS HERE: a real, resolvable `supersedes` link in the shared exec feed
// (otchealthcommons/company-journal/_MEMORY/_exec/<agent>.jsonl -- the EXACT corpus semantic.mjs
// indexes into memory-exec) where an OLD ledger entry and the NEW entry that supersedes it both
// discuss the SAME topic, but the NEW one is the current truth and the OLD one is now wrong/stale.
// semantic.mjs's reindex() marks every id that is SOMEONE's `supersedes` target as `retracted:true`
// (see computeRetractedIds/filterHygiene), and recall() drops retracted rows from its results. So a
// hard-negative case tests something the standard golden set (skills/recall-evals/golden-set.json)
// never exercises: not just "does the right fact show up" but "does the WRONG, semantically-similar,
// superseded fact stay correctly suppressed." A regression in retraction-filtering (a reindex bug, a
// gateway change that drops filterRetracted()) would leave the standard golden set's hit@5 looking
// fine while a hard-negative case starts failing the moment the retracted fact leaks back in.
//
// WHY ONLY `supersedes` PAIRS, NOT THE `correction`-type `was` FIELD: a `correct --was "<wrong>"` entry
// stores the wrong belief as an inline STRING annotation on ONE row; semantic.mjs's reindex() only
// embeds/selects each row's `text` field (see its aisPush buffer + SELECT_FULL), never `was`. So a
// `was` string can never itself leak back as a competing retrieved document -- there is only ever one
// document, and it already contains the current (correct) `text`. That pattern is not exploitable for
// a genuine two-document "old vs new, which one surfaces" contrastive test; only a resolvable
// `supersedes` link creates two INDEPENDENTLY RETRIEVABLE documents, which is what this harness needs.
//
// SAFETY (defense in depth, on top of a genuine need -- this script reads the WHOLE shared exec feed,
// a broader corpus than mine-cases.mjs's single-named-agent tail, because resolving a `supersedes` id
// can point at any agent's row):
//   1. AGENT ALLOWLIST: only mines pairs where BOTH the old and new row's agent are outside the
//      finance/legal/securities set (cfo, clo, clo-personal, exec, capital, commerce, cro, compliance,
//      rainmaker are never mined from here -- MNPI/privileged content has no business in a file this
//      skill commits to the repo). See UNSAFE_AGENTS.
//   2. MNPI/FINANCE KEYWORD DENY (defense in depth even within allowed agents): MNPI_DENY blocks any
//      candidate whose old OR new text mentions INND/securities/derivative/financial-raise terms.
//   3. The existing PHI_DENY vocabulary (mirrors run-evals.mjs / mine-cases.mjs) is also enforced.
//   4. PROGRESS-LOG EXCLUSION: some real `supersedes` chains are just a repeating maintenance counter
//      ("Batch tagging progress: N of 853 memories tagged...") -- textually near-identical, differing
//      only by a number, and NOT a genuine factual contradiction. isEligiblePair() rejects these via a
//      jaccard-similarity BAND (dedupe.mjs's existing tokenize/jaccard, reused rather than
//      reimplemented): too high => near-duplicate busywork log, not a real correction; too low => the
//      two rows are not actually about the same topic (a stray/incidental id collision), so mining a
//      query from them would not test anything real. See isEligiblePair()'s JACCARD_MIN/MAX.
//
// LLM_PROVIDER (2026-08-27, Azure Foundry retirement port): Azure subscription 55c84f6b (the whole
// Foundry estate callChat() called exclusively) is permanently deleted -- verified 401 forever, not a
// transient outage. Default flips to 'openai' (api.openai.com, model ids from
// setup/model-routing.mjs's OPENAI_TIERS -- same 'standard' tier key, so MINE_MODEL still means the
// same override regardless of provider). LLM_PROVIDER=foundry/azure keeps the original Foundry path
// selectable, one env var away, if that estate is ever re-provisioned.
//
// Usage (creds via kvSecret / AZURE_SP, or run.sh):
//   node mine-hard-negatives.mjs --target 10 --out hard-negative-set.json
//   node mine-hard-negatives.mjs --max-minutes 5 --out hard-negative-set.json   # time-boxed, incremental save
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { kvSecret } from "../kb-memory/azure-secret.mjs";
import { cGet, cList, commonsConfigured } from "../kb-memory/commons-store.mjs";
import { tokenize, jaccard } from "../kb-memory/dedupe.mjs";
import { chatBody, resolveTier, fetchOpenAIWithFlexRetry, positiveIntEnv } from "../../setup/model-routing.mjs";
import { hitAtK, groupHitLines } from "./scoring.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEMANTIC = join(HERE, "..", "kb-memory", "semantic.mjs");
const LLM_PROVIDER = (process.env.LLM_PROVIDER || "openai").toLowerCase();
// NOTE: the OpenAI chat-completions URL is now owned by setup/model-routing.mjs's
// fetchOpenAIWithFlexRetry() (2026-08-29, the flex-processing adoption below) -- no local
// OPENAI_CHAT_URL constant is needed here any more.

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const TARGET = parseInt(val("--target", "20"), 10);
const OUT = val("--out", join(HERE, "hard-negative-set.json"));
const MAX_MIN = parseFloat(val("--max-minutes", "0")) || 0;
const K = 5, N_RECALL = 10;

// ---- pure guards + helpers (unit-tested in tests/recall-evals-hard-negative-mining.test.mjs) ------

// Same PHI vocabulary run-evals.mjs / mine-cases.mjs already enforce, so a hard-negative case can
// never be PHI-adjacent even incidentally (defense in depth; the ledger's own RING_DENY already
// blocks PHI from reaching a SHARED entry in the first place).
export const PHI_DENY = /\b(medreview|phi\b|patient|diagnos|medication|prescrib|hipaa|audiogram|hearing\s*number)\b/i;

// Agents whose ledgers carry finance/legal/securities/MNPI-adjacent content. NEVER mine a
// hard-negative pair where either side's originating agent is in this set -- this file is committed
// to the repo and this fleet's standing rule is "never send company-confidential/MNPI content to a
// destination outside the compliance boundary" (otchealth-cto/CLAUDE.md, otchealth-claude-tools/
// CLAUDE.md ground-first protocol). cco is excluded from this set on purpose: its ledger content
// observed in this corpus is internal tooling/process notes (Notion retirement, stale-bot behavior),
// not compliance FINDINGS -- see the SKILL.md note if that ever changes.
export const UNSAFE_AGENTS = new Set(["cfo", "clo", "clo-personal", "exec", "capital", "commerce", "cro", "compliance", "rainmaker"]);

/** True when neither agent on a candidate pair is in the unsafe set. Pure. */
export function isSafeAgentPair(oldAgent, newAgent) {
  return Boolean(oldAgent) && Boolean(newAgent) && !UNSAFE_AGENTS.has(oldAgent) && !UNSAFE_AGENTS.has(newAgent);
}

// Finance/securities/MNPI keyword deny, applied to BOTH texts regardless of which agent wrote them
// (defense in depth on top of the agent allowlist -- an allowed agent could still, in principle,
// quote or reference sensitive content). Deliberately broad; false positives just mean a candidate
// is skipped, which is always the safe failure direction for this guard.
export const MNPI_DENY = /\b(mnpi|innd\b|inner\s?scope|hearingassist|series\s*[abc]\b|10-k|10-q|sec\s+filing|securities|derivative|capital\s+raise|convertible\s+note|reg[\s-]?d\b|reg[\s-]?a\b|gs\s+capital|valuation\s+model|investor\b|ipo\b)\b/i;

/** True when a string trips neither PHI_DENY nor MNPI_DENY. Pure. */
export function isContentSafe(text) {
  const t = String(text || "");
  return !PHI_DENY.test(t) && !MNPI_DENY.test(t);
}

// Room-hygiene parity with semantic.mjs's own EXHAUST_TYPES: a hard-negative case is useless if the
// NEW (current) fact is a type recall() excludes by default (status/episode/heartbeat/digest) -- it
// would never be a hit under default settings regardless of retraction correctness.
export const EXHAUST_TYPES = new Set(["status", "episode", "heartbeat", "digest"]);

// A real, identified low-value shape in this corpus: a repeating maintenance-progress counter
// ("Batch tagging progress: N of 853 memories tagged...", "COMPLETE: All 853 of 853...", "SESSION
// CLOSE..."). These chain via genuine `supersedes` links (so they pass every other filter) but they
// are not a factual CORRECTION, just a sequential log -- mining a query from one would test "did the
// latest count show up," not "did the fleet suppress a superseded WRONG belief." Excluded by content
// shape (not by jaccard alone, since a couple of these fall below the jaccard-max band by coincidence
// of wording, e.g. "Almost done, finishing final singletons" vs "Continuing ... in batches of 20").
export const PROGRESS_LOG_RE = /\bbatch tagging progress\b|\bof 853 memories\b|\bsingletons?\b/i;

/** Jaccard band (dedupe.mjs's tokenize/jaccard, reused not reimplemented): too high = near-duplicate
 *  busywork ("178 of 853" vs "158 of 853"), too low = the two rows likely are not really about the
 *  same topic (a coincidental id collision, not a genuine correction). See the header comment for the
 *  real numbers this was calibrated against (a genuine contradiction pair scored 0.11-0.26; a stray
 *  cross-topic collision scored 0.00; a near-duplicate progress-counter pair scored 0.83). */
export const JACCARD_MIN = 0.03;
export const JACCARD_MAX = 0.55;

/**
 * Full eligibility check for ONE resolved (oldRow, newRow) pair. Pure (jaccardFn injected so this is
 * independently unit-testable without importing the real dedupe.mjs tokenizer, though callers should
 * always pass the real one). Returns { eligible, reason } -- reason is always populated (useful for
 * a --verbose mining log), even when eligible is true (reason describes why it passed).
 */
export function isEligiblePair(oldRow, newRow, { jaccardFn = jaccard, tokenizeFn = tokenize } = {}) {
  if (!oldRow || !newRow) return { eligible: false, reason: "missing old or new row" };
  if (!isSafeAgentPair(oldRow.agent, newRow.agent)) return { eligible: false, reason: `unsafe agent (${oldRow.agent} -> ${newRow.agent})` };
  if (EXHAUST_TYPES.has(String(newRow.type || "").toLowerCase())) return { eligible: false, reason: `new row is exhaust-type (${newRow.type})` };
  if (!isContentSafe(oldRow.text) || !isContentSafe(newRow.text)) return { eligible: false, reason: "PHI/MNPI-adjacent content" };
  if (PROGRESS_LOG_RE.test(oldRow.text || "") && PROGRESS_LOG_RE.test(newRow.text || "")) return { eligible: false, reason: "progress-log chatter, not a real correction" };
  const j = jaccardFn(tokenizeFn(oldRow.text || ""), tokenizeFn(newRow.text || ""));
  if (j > JACCARD_MAX) return { eligible: false, reason: `near-duplicate (jaccard ${j.toFixed(3)} > ${JACCARD_MAX})` };
  if (j < JACCARD_MIN) return { eligible: false, reason: `likely unrelated topics (jaccard ${j.toFixed(3)} < ${JACCARD_MIN})` };
  return { eligible: true, reason: `same-topic correction (jaccard ${j.toFixed(3)})` };
}

/**
 * Resolve every row whose `supersedes` points at another row IN THE SAME rows array into a
 * { newRow, oldRow } pair. Pure: plain Map lookups, no IO. Rows without a resolvable `supersedes` (or
 * pointing at a row absent from this array -- e.g. it was itself later pruned) are skipped, not thrown.
 * @param {Array<object>} rows - ledger rows, each with at least {id, supersedes, agent, type, text}.
 * @returns {Array<{newRow: object, oldRow: object}>}
 */
export function resolveSupersedePairs(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byId = new Map(list.map((r) => [r && r.id, r]));
  const pairs = [];
  for (const newRow of list) {
    if (!newRow || !newRow.supersedes) continue;
    const oldRow = byId.get(newRow.supersedes);
    if (oldRow) pairs.push({ newRow, oldRow });
  }
  return pairs;
}

/**
 * Pure parse of the LLM's JSON reply for one hard-negative candidate into a validated shape. Never
 * throws; a malformed/partial reply degrades to `null` (caller skips the candidate rather than
 * mining a broken case). Mirrors the defensive-parse discipline of deep-retrieval.ts's
 * parseQueryPlan / mine-cases.mjs's inline candidate parsing.
 * @param {string} raw - the model's raw text reply, expected to be JSON.
 * @returns {{query: string, expectNew: string[], expectOld: string[]} | null}
 */
export function parseHardNegCandidate(raw) {
  try {
    const parsed = JSON.parse(raw);
    const query = typeof parsed.query === "string" ? parsed.query.trim().slice(0, 500) : "";
    const expectNew = Array.isArray(parsed.expect_new)
      ? parsed.expect_new.filter((s) => typeof s === "string" && s.trim().length > 0).map((s) => s.trim()).slice(0, 2)
      : [];
    const expectOld = Array.isArray(parsed.expect_old)
      ? parsed.expect_old.filter((s) => typeof s === "string" && s.trim().length > 0).map((s) => s.trim()).slice(0, 2)
      : [];
    if (!query || !expectNew.length || !expectOld.length) return null;
    return { query, expectNew, expectOld };
  } catch {
    return null;
  }
}

// ---- IO: fetch the whole shared exec feed (read-only; the SAME corpus semantic.mjs indexes) -------
//
// PORTED (2026-08-28, Azure Blob retirement): this used to hand-roll an Azure Blob account-SAS
// directly against otchealthcommons/company-journal -- the same (account, container) five other
// toolkit callers each duplicated identically (see commons-store.mjs's own header). That storage
// account died with the Azure subscription deletion (2026-08-13), so `kvSecret("azure-commons-
// storage-account"/"-key")` resolved to null and every call here threw immediately
// ("azure-commons-storage-account/key unavailable") -- this tool could not mine a single
// hard-negative case. Routed through the shared S3-backed commons-store.mjs facade instead, the
// SAME facade setup/heartbeat.mjs, skills/fleet-dispatch/dispatch.mjs, skills/fleet-medic/medic.mjs,
// skills/sunset-protocol/protocol.mjs, skills/fleet-search/search.mjs, and
// skills/kb-memory/memory-librarian.mjs already use -- so this reads the identical live
// `_MEMORY/_exec/<agent>.jsonl` objects those siblings do (and the exact corpus semantic.mjs indexes
// into memory-exec), never a new or different location.
//
// Dependencies are injectable (mirrors isEligiblePair's jaccardFn/tokenizeFn pattern above), purely
// so this is unit-testable with fake cList/cGet stand-ins -- no live AWS credentials, no simulated S3
// wire protocol needed. Real callers (main(), below) never pass these; they get the live facade.
//
// FAIL LOUD vs EMPTY-IS-VALID: an unresolvable AWS credential chain (commonsConfiguredFn() false) or
// any real listing/read failure (cListFn/cGetFn throw on anything but a genuine 404 -- see
// s3-blob.mjs's contract) is a DISTINCT thrown failure: "the store is unreachable." A prefix with
// zero `.jsonl` objects under it is a normal, valid state (e.g. a fresh non-prod seat with no shared
// exec ledger yet) and returns a clean `[]`, never conflated with the unreachable case.
export async function fetchAllSharedRows({ cListFn = cList, cGetFn = cGet, commonsConfiguredFn = commonsConfigured } = {}) {
  if (!(await commonsConfiguredFn())) {
    throw new Error("AWS credentials unavailable for the commons S3 mirror (checked the ECS task role, AWS_ACCESS_KEY_ID/SECRET, OTC_AWS_ACCESS_KEY_ID/SECRET); cannot read the shared exec feed.");
  }
  const names = (await cListFn("_MEMORY/_exec/")).filter((n) => n.endsWith(".jsonl"));
  const rows = [];
  for (const name of names) {
    const t = await cGetFn(name); // null ONLY on a genuine 404 (e.g. deleted mid-listing); throws loud on any other failure
    if (!t) continue;
    for (const l of t.split(/\r?\n/).filter(Boolean)) {
      try { rows.push(JSON.parse(l)); } catch { /* skip a malformed line */ }
    }
  }
  return rows;
}

// ---- IO: Azure OpenAI chat (mirrors mine-cases.mjs's callChat exactly) -----------------------------

// MINE_HARDNEG_MAX_TOKENS 500 -> 2000 (2026-08-30, FND-20260830-e927): resolveTier('standard','openai')
// is gpt-5.6-terra since the 2026-08-29 refresh (reasoning-family; was gpt-4.1, chat-family). Live-
// tested this exact single-pair prompt shape 4 times at 500 with no truncation (max total completion
// observed: 240), but the SAME model family truncated 6/6 times on a harder company-brain prompt in
// this same sweep, so a clean small sample here is not proof against a longer or more tangled real
// ledger correction. 2000 leaves real margin at effectively no extra cost on the easy majority of
// pairs (max_completion_tokens is billed on tokens actually generated, not requested). Env-overridable
// (MINE_HARDNEG_MAX_TOKENS).
const MINE_HARDNEG_MAX_TOKENS = positiveIntEnv("MINE_HARDNEG_MAX_TOKENS", 2000);

// FLEX PROCESSING (2026-08-29, see setup/model-routing.mjs's own header for the full contract): this
// miner had NO retry-on-429 at all before (a bare `if (!r.ok) throw`), so routing the OpenAI branch
// through the shared fetchOpenAIWithFlexRetry() is a strict improvement under flex (adds a retry
// contract that never existed) and BYTE-IDENTICAL in the default/non-flex case -- its default
// `tries:1` reproduces the exact original single-attempt, immediate-throw, same-message-shape
// behavior (`chat ${status}: ${body}`). Caller label "recall-evals-mine-hard-negatives" -> env
// override OPENAI_SERVICE_TIER_RECALL_EVALS_MINE_HARD_NEGATIVES (or the fleet-wide
// OPENAI_SERVICE_TIER). Both unset (the default everywhere today) means this miner's shape and
// timing are untouched by this change.
//
// REASONING-TRUNCATION (2026-08-30, FND-20260830-e927): fetchOpenAIWithFlexRetry() now throws
// (tagged `.reasoningExhausted`) instead of returning "" when the response is truncated-empty (see
// that function's own comment in setup/model-routing.mjs). This callChat()'s own OpenAI branch does
// not need its own catch for that -- main()'s loop below already treats ANY thrown error from
// callChat() as "skip this candidate, log why, continue" (see the `catch (e)` around this call), so
// the throw is caught there and reported with a precise reason instead of the generic "unparseable/
// incomplete candidate" message parseHardNegCandidate("") used to produce for the exact same event.
export async function callChat(system, user) {
  if (LLM_PROVIDER === "openai") {
    const key = process.env.OPENAI_API_KEY || (await kvSecret("openai-api-key"));
    if (!key) throw new Error("missing openai-api-key (env OPENAI_API_KEY or the fleet secret)");
    const dep = process.env.MINE_MODEL || resolveTier("standard", "openai").deployment;
    return fetchOpenAIWithFlexRetry({
      apiKey: key, deployment: dep,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      maxTokens: MINE_HARDNEG_MAX_TOKENS, jsonMode: true, caller: "recall-evals-mine-hard-negatives",
    });
  }
  // Azure/Foundry path, unchanged, selectable via LLM_PROVIDER=foundry|azure. Foundry, not the legacy
  // azure-openai resource: TIERS.standard.deployment ('gpt-4.1') only exists on Foundry (2,000K TPM
  // GlobalStandard); the legacy resource's gpt-4o deployment is capped at 50K TPM with zero headroom
  // (see setup/model-routing.mjs LEGACY_STANDARD). gpt-4.1 is CHAT-family, so this branch carries none
  // of the reasoning-truncation risk the OpenAI branch above does; left unchanged.
  const ep = (await kvSecret("azure-foundry-openai-endpoint") || "").replace(/\/$/, "");
  const key = await kvSecret("azure-foundry-key");
  const dep = process.env.MINE_MODEL || resolveTier("standard", "azure").deployment;
  if (!ep || !key) throw new Error("missing azure-foundry endpoint/key");
  const body = chatBody(dep, { messages: [{ role: "system", content: system }, { role: "user", content: user }], maxTokens: MINE_HARDNEG_MAX_TOKENS, jsonMode: true });
  const r = await fetch(`${ep}/openai/deployments/${dep}/chat/completions?api-version=2024-08-01-preview`, { method: "POST", headers: { "api-key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`chat ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return (await r.json()).choices?.[0]?.message?.content || "";
}

const SYSTEM = `You author HARD-NEGATIVE (contrastive) recall-eval test cases for a company memory system. You are given an OLD (now superseded/wrong or stale) internal note and a NEW note that corrects/supersedes it, both about the same topic. Write:
1. "query": a natural-language question a colleague might ask whose CURRENT correct answer is the NEW note. Paraphrase (low lexical overlap with either note) to test semantic recall, not keyword match.
2. "expect_new": 1-2 short (2-8 word) VERBATIM substrings copied from the NEW note that would appear in a correct, current answer.
3. "expect_old": 1-2 short (2-8 word) VERBATIM substrings copied from the OLD note that are SPECIFIC to the old/wrong/stale claim (would NOT appear in a correct, current answer -- these must not also appear in the new note).
Return STRICT JSON only: {"query": "...", "expect_new": ["...","..."], "expect_old": ["...","..."]}. Do not use em dashes or en dashes.`;

// ---- IO: live validation against the REAL recall path (mirrors mine-cases.mjs's validate()) -------

/**
 * Validate ONE candidate against the live semantic.mjs recall path: the NEW/correct expect substrings
 * must be a hit within the top-K, AND the OLD/retracted expect substrings must NOT appear (they
 * should already be filtered out by retraction-filtering). Only candidates passing BOTH are kept --
 * exactly mine-cases.mjs's "every committed case is answerable-by-current-recall" discipline, extended
 * with the negative half a hard-negative case needs.
 */
function validatePair(item) {
  return new Promise((resolve) => {
    const args = [SEMANTIC, "recall", item.query, "--n", String(N_RECALL)];
    const child = spawn("node", args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const to = setTimeout(() => { try { child.kill(); } catch {} resolve({ ok: false, newHit: 0, oldLeak: 1 }); }, 30000);
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", (code) => {
      clearTimeout(to);
      if (code !== 0) return resolve({ ok: false, newHit: 0, oldLeak: 1 });
      const rawLines = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      const lines = groupHitLines(rawLines);
      const newHit = hitAtK(lines, item.expectNew, K);
      const oldLeak = hitAtK(lines, item.expectOld, K);
      resolve({ ok: true, newHit, oldLeak });
    });
    child.on("error", () => { clearTimeout(to); resolve({ ok: false, newHit: 0, oldLeak: 1 }); });
  });
}

// ---- main --------------------------------------------------------------------------------------

async function main() {
  console.error("[mine-hardneg] fetching the shared exec feed (read-only)...");
  const rows = await fetchAllSharedRows();
  console.error(`[mine-hardneg] ${rows.length} total shared-feed rows across all agents.`);

  const allPairs = resolveSupersedePairs(rows);
  console.error(`[mine-hardneg] ${allPairs.length} resolvable supersedes pair(s) (old row present in-corpus).`);

  const eligible = [];
  for (const { newRow, oldRow } of allPairs) {
    const { eligible: ok, reason } = isEligiblePair(oldRow, newRow);
    if (ok) eligible.push({ newRow, oldRow, reason });
  }
  console.error(`[mine-hardneg] ${eligible.length} pair(s) pass the safety + quality filters (agent allowlist, PHI/MNPI deny, exhaust-type, progress-log, jaccard band).`);
  for (const e of eligible) console.error(`  - ${e.oldRow.id} -> ${e.newRow.id} (${e.reason})`);

  const existing = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : [];
  const haveOldNew = new Set(existing.map((c) => `${c.old_id}->${c.new_id}`));
  const kept = [...existing];
  let idn = existing.length, validated = 0, tried = 0;
  const START = Date.now();

  for (const { newRow, oldRow } of eligible) {
    if (kept.length - existing.length >= TARGET) break;
    const key = `${oldRow.id}->${newRow.id}`;
    if (haveOldNew.has(key)) continue;
    tried++;
    let cand;
    try {
      const raw = await callChat(SYSTEM, `OLD (superseded) note:\n${(oldRow.text || "").slice(0, 900)}\n\nNEW (current, correct) note:\n${(newRow.text || "").slice(0, 900)}`);
      cand = parseHardNegCandidate(raw);
    } catch (e) {
      console.error(`[mine-hardneg] LLM error for ${key}: ${e.message}`);
      continue;
    }
    if (!cand) { console.error(`[mine-hardneg] unparseable/incomplete candidate for ${key}; skipped`); continue; }
    if (!isContentSafe(cand.query) || !cand.expectNew.every(isContentSafe) || !cand.expectOld.every(isContentSafe)) {
      console.error(`[mine-hardneg] PHI/MNPI-flagged candidate text for ${key}; skipped`);
      continue;
    }
    const v = await validatePair(cand);
    if (v.ok && v.newHit === 1 && v.oldLeak === 0) {
      kept.push({
        id: `hn-${String(++idn).padStart(3, "0")}`,
        query: cand.query,
        expect_new: cand.expectNew,
        expect_old: cand.expectOld,
        new_id: newRow.id,
        old_id: oldRow.id,
        agent: newRow.agent,
        note: `mined+validated hard-negative: ${oldRow.id} (superseded) -> ${newRow.id} (current). ${eligible.find((e) => e.newRow === newRow)?.reason || ""}`,
      });
      validated++;
      haveOldNew.add(key);
      writeFileSync(OUT, JSON.stringify(kept, null, 2) + "\n"); // incremental save
      console.error(`[mine-hardneg] VALIDATED ${key} (new hit + no old leak) -> ${kept.length - existing.length}/${TARGET}`);
    } else {
      console.error(`[mine-hardneg] REJECTED ${key} (newHit=${v.newHit} oldLeak=${v.oldLeak}, ok=${v.ok}) -- current recall does not cleanly pass this case yet`);
    }
    if (MAX_MIN && Date.now() - START > MAX_MIN * 60000) {
      console.error(`[mine-hardneg] --max-minutes ${MAX_MIN} budget reached; stopping with ${kept.length - existing.length} new validated.`);
      break;
    }
  }
  writeFileSync(OUT, JSON.stringify(kept, null, 2) + "\n");
  console.error(`[mine-hardneg] DONE: tried ${tried}, VALIDATED ${validated} new hard-negative case(s) -> ${OUT} now has ${kept.length} (was ${existing.length}).`);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch((e) => { console.error("[mine-hardneg] FATAL", e.message); process.exit(1); });
