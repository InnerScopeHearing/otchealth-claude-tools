#!/usr/bin/env node
// mine-cases.mjs — generate + VALIDATE hard recall-eval cases from the REAL commons ledger.
//
// The original golden-set.json was 12 near-verbatim cases that saturated at hit@5 = 12/12, MRR 1.0 --
// too easy to detect a regression. This generator builds a large HARD set from real, already-indexed
// ledger facts: for each fact it asks Azure OpenAI (credit-funded gpt-4o) for a PARAPHRASED natural-
// language query whose answer IS that fact (low lexical overlap, so it tests SEMANTIC recall, not
// keyword), plus 1-2 distinctive VERBATIM expect substrings. It then VALIDATES each candidate by
// running it through the real `semantic.mjs recall` path and KEEPS ONLY cases that currently HIT@k --
// so every committed case is answerable-by-current-recall and a future recall regression MISSES it
// (a meaningful tripwire, not noise). Non-PHI: any fact/query/expect matching the PHI/MNPI deny regex
// is skipped. Re-runnable to grow the set; merges with (never drops) the existing golden set.
//
// LLM_PROVIDER (2026-08-27, Azure Foundry retirement port): Azure subscription 55c84f6b (the whole
// Foundry estate callChat() called exclusively) is permanently deleted -- verified 401 forever, not a
// transient outage. Default flips to 'openai' (api.openai.com, model ids from
// setup/model-routing.mjs's OPENAI_TIERS -- same 'standard' tier key, so MINE_MODEL still means the
// same override regardless of provider). LLM_PROVIDER=foundry/azure keeps the original Foundry path
// selectable, one env var away, if that estate is ever re-provisioned.
//
// Usage (creds via kvSecret / AZURE_SP or run.sh):
//   node mine-cases.mjs --agent commons --target 100 --out golden-set.json
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { kvSecret } from "../kb-memory/azure-secret.mjs";
import { chatBody, resolveTier, fetchOpenAIWithFlexRetry, positiveIntEnv, isBatchEnabled, buildBatchLine, submitBatch, awaitBatch, assertAllBatchResultsPresent } from "../../setup/model-routing.mjs";
import { logPrefixForText } from "../../setup/prompt-shape.mjs";
import { hitAtK, groupHitLines } from "./scoring.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LLM_PROVIDER = (process.env.LLM_PROVIDER || "openai").toLowerCase();
// NOTE: the OpenAI chat-completions URL is now owned by setup/model-routing.mjs's
// fetchOpenAIWithFlexRetry() (2026-08-29, the flex-processing adoption below) -- no local
// OPENAI_CHAT_URL constant is needed here any more.
const MEM = join(HERE, "..", "kb-memory", "mem.mjs");
const SEMANTIC = join(HERE, "..", "kb-memory", "semantic.mjs");
const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const AGENT = val("--agent", "commons");
const TARGET = parseInt(val("--target", "100"), 10);
const OUT = val("--out", join(HERE, "golden-set.json"));
const CORPUS_N = parseInt(val("--corpus", "300"), 10);
const CORPUS_FILE = val("--corpus-file", ""); // optional: a JSON array of fact strings (bigger than the tail view)
const BATCH = parseInt(val("--batch", "8"), 10);
const MAX_MIN = parseFloat(val("--max-minutes", "0")) || 0; // hard time budget (0 = none); saves incrementally so a time-box keeps work
const K = 5, N_RECALL = 10;
const PHI = /\b(medreview|phi\b|patient|diagnos|medication|prescrib|hipaa|audiogram|hearing\s*number)\b/i;

function corpus() {
  let facts = [];
  if (CORPUS_FILE) {
    // A pre-dumped corpus (e.g. the full shared feed) as a JSON array of fact strings -- far bigger
    // than the curated tail view, which is capped regardless of --n.
    const arr = JSON.parse(readFileSync(CORPUS_FILE, "utf8"));
    for (const t of arr) { const s = String(t || "").trim(); if (s.length >= 70 && !PHI.test(s)) facts.push(s); }
  } else {
    const out = spawnSync("node", [MEM, "tail", "--agent", AGENT, "--n", String(CORPUS_N)], { encoding: "utf8", timeout: 90000 });
    for (const l of (out.stdout || "").split(/\r?\n/)) {
      const m = l.match(/^\[(fact|decision|status|correction|pitfall)\]\s*(?:\[[0-9-]+\]\s*)?(.+)$/i);
      if (m) { const t = m[2].trim(); if (t.length >= 70 && !PHI.test(t)) facts.push(t); }
    }
  }
  // de-dupe near-identical prefixes, cap length fed to the LLM
  const seen = new Set(), uniq = [];
  for (const f of facts) { const key = f.slice(0, 80).toLowerCase(); if (!seen.has(key)) { seen.add(key); uniq.push(f.slice(0, 900)); } }
  return uniq;
}

// MINE_CASES_MAX_TOKENS 1500 -> 4000 (2026-08-30, FND-20260830-e927): resolveTier('standard','openai')
// is gpt-5.6-terra since the 2026-08-29 refresh (reasoning-family; was gpt-4.1, chat-family). Live-
// tested this exact batch-of-8-facts prompt shape 4 times at 1500: no truncation, but real variance
// (reasoning 157-553, total completion 566-945 -- one run used 63% of the budget on an EASY, clearly-
// worded batch of facts). A harder or longer real batch from the actual ledger tail could plausibly
// exceed 1500; a same-family sibling (company-brain) truncated 6/6 times on a harder prompt in this
// same sweep. 4000 leaves real margin for an 8-item JSON array at effectively no extra cost on the
// easy majority of batches. Env-overridable (MINE_CASES_MAX_TOKENS).
const MINE_CASES_MAX_TOKENS = positiveIntEnv("MINE_CASES_MAX_TOKENS", 4000);

// FLEX PROCESSING (2026-08-29, see setup/model-routing.mjs's own header for the full contract): this
// miner had NO retry-on-429 at all before (a bare `if (!r.ok) throw`), so routing the OpenAI branch
// through the shared fetchOpenAIWithFlexRetry() is a strict improvement under flex (adds a retry
// contract that never existed) and BYTE-IDENTICAL in the default/non-flex case -- its default
// `tries:1` reproduces the exact original single-attempt, immediate-throw, same-message-shape
// behavior (`chat ${status}: ${body}`). Caller label "recall-evals-mine-cases" -> env override
// OPENAI_SERVICE_TIER_RECALL_EVALS_MINE_CASES (or the fleet-wide OPENAI_SERVICE_TIER). Both unset
// (the default everywhere today) means this miner's shape and timing are untouched by this change.
//
// REASONING-TRUNCATION (2026-08-30, FND-20260830-e927): fetchOpenAIWithFlexRetry() now throws
// (tagged `.reasoningExhausted`) instead of returning "" when the response is truncated-empty (see
// that function's own comment in setup/model-routing.mjs). main()'s batch loop below already treats
// ANY thrown error from callChat() as "log it, skip this batch, continue" (see its own `catch (e)`),
// so this surfaces with a precise reason instead of a silently-empty batch of zero mined cases.
export async function callChat(system, user) {
  // Prompt-caching hygiene (2026-09-02): SYSTEM (this file's only caller of callChat) is a fully
  // static module-level constant, already sent first with the per-chunk fact batch last -- already
  // cache-friendly order, observability only, not a reorder.
  logPrefixForText("recall-evals-mine-cases", system);
  if (LLM_PROVIDER === "openai") {
    const key = process.env.OPENAI_API_KEY || (await kvSecret("openai-api-key"));
    if (!key) throw new Error("missing openai-api-key (env OPENAI_API_KEY or the fleet secret)");
    const dep = process.env.MINE_MODEL || resolveTier("standard", "openai").deployment;
    return fetchOpenAIWithFlexRetry({
      apiKey: key, deployment: dep,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      maxTokens: MINE_CASES_MAX_TOKENS, jsonMode: true, caller: "recall-evals-mine-cases",
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
  const body = chatBody(dep, { messages: [{ role: "system", content: system }, { role: "user", content: user }], maxTokens: MINE_CASES_MAX_TOKENS, jsonMode: true });
  const r = await fetch(`${ep}/openai/deployments/${dep}/chat/completions?api-version=2024-08-01-preview`, { method: "POST", headers: { "api-key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`chat ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return (await r.json()).choices?.[0]?.message?.content || "";
}

const SYSTEM = `You author RECALL-EVAL test cases for a company memory system. For each numbered internal fact, output a natural-language QUERY a colleague might ask whose answer IS that fact -- PARAPHRASED with LOW lexical overlap (do NOT reuse the fact's distinctive words in the query; test meaning, not keyword match) -- plus 1-2 "expect" substrings copied VERBATIM from the fact (short, 2-6 words, distinctive identifiers/names/numbers that would appear in the correct entry). Return STRICT JSON: {"cases":[{"i":<number>,"query":"...","expect":["...","..."]}]}. Skip any fact about patients/diagnoses/medications/PHI.`;

function validate(item) {
  return new Promise((resolve) => {
    const args = [SEMANTIC, "recall", item.query, "--n", String(N_RECALL)];
    if (item.agent) args.push("--agent", item.agent);
    const child = spawn("node", args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const to = setTimeout(() => { try { child.kill(); } catch {} resolve(false); }, 30000);
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", (code) => {
      clearTimeout(to);
      if (code !== 0) return resolve(false);
      const rawLines = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      // GROUP into one entry per retrieved memory (same fix as run-evals.mjs's runRecall) so a case
      // validated here HITS under the exact same k-means-top-k-memories scoring the nightly eval uses.
      // Without this, mine-cases.mjs and run-evals.mjs disagreed on what "top-K" meant (line vs memory),
      // which could keep a genuinely-retrievable case out of the golden set, or waste an LLM-generation
      // call on one that "hit" under a stale line-based check but not under the real scoring.
      const lines = groupHitLines(rawLines);
      resolve(hitAtK(lines, item.expect, K));
    });
    child.on("error", () => { clearTimeout(to); resolve(false); });
  });
}
// Validate a list of candidates with BOUNDED CONCURRENCY (the per-case node+recall spawn is the
// bottleneck; running them serially was ~10 min). Returns the subset that HIT@k, order-preserved.
async function validateConcurrent(items, concurrency = 8) {
  const results = new Array(items.length).fill(false);
  let idx = 0;
  async function worker() { while (idx < items.length) { const i = idx++; results[i] = await validate(items[i]); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return items.filter((_, i) => results[i]);
}

// ============================== BATCH MODE (2026-09-02, OPENAI_BATCH lever) ==============================
// Opt-in: isBatchEnabled("recall-evals-mine-cases"). Submits EVERY chunk's generation request as ONE
// Batch API job instead of one sequential fetch per chunk (50% off vs synchronous pricing, stacks with
// prompt caching -- SYSTEM is fully static across every chunk in a run, the largest realistic shared
// prefix this file has). OpenAI-provider only; LLM_PROVIDER=foundry/azure never reaches this function.
//
// ACCEPTED TRADE-OFF, disclosed rather than hidden: the SYNCHRONOUS path (below, unchanged) stops
// submitting NEW generation calls once `kept.length - existing.length >= TARGET` validated cases have
// been collected (its own for-loop condition, a real cost optimization for the common "just top up the
// golden set a bit" invocation). Batch API has no equivalent -- every chunk in the ONE submitted batch
// is billed and processed regardless of how many earlier chunks already produced enough validated
// cases. Batch mode therefore generates candidates from the WHOLE corpus (still respecting
// --corpus/--corpus-file's own size cap), then validates and keeps the first TARGET that hit, walking
// chunks in the SAME order the synchronous path would have tried them -- so the OUTPUT contract ("the
// first N validated cases encountered in corpus order") is identical; only the LLM-call cost/latency
// shape differs. This is the deliberate trade a big overnight backfill run opts into by setting
// OPENAI_BATCH=1; --max-minutes still bounds the (still-live, still per-item) VALIDATION phase that
// runs after the batch resolves.
export async function runBatchMode(facts, existing, kept, haveQ) {
  const key = process.env.OPENAI_API_KEY || (await kvSecret("openai-api-key"));
  if (!key) throw new Error("missing openai-api-key (env OPENAI_API_KEY or the fleet secret)");
  const dep = process.env.MINE_MODEL || resolveTier("standard", "openai").deployment;
  const chunks = [];
  for (let off = 0; off < facts.length; off += BATCH) chunks.push(facts.slice(off, off + BATCH));
  logPrefixForText("recall-evals-mine-cases", SYSTEM);
  const lines = chunks.map((chunk, i) => buildBatchLine({
    customId: `chunk-${i}`,
    deployment: dep,
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: chunk.map((f, j) => `${j + 1}. ${f}`).join("\n\n") }],
    maxTokens: MINE_CASES_MAX_TOKENS,
    jsonMode: true,
  }));
  console.error(`[mine] OPENAI_BATCH: submitting ${lines.length} chunk-generation request(s) as one Batch API job (50% off, up to 24h)...`);
  const batchId = await submitBatch(lines, { apiKey: key });
  console.error(`[mine] OPENAI_BATCH: batch ${batchId} submitted, waiting for it to complete...`);
  const { results } = await awaitBatch(batchId, {
    apiKey: key,
    onPoll: ({ status, elapsedMs }) => console.error(`[mine] OPENAI_BATCH: batch ${batchId} status=${status} (${Math.round(elapsedMs / 1000)}s elapsed)`),
  });
  assertAllBatchResultsPresent(lines.map((l) => l.custom_id), results);
  console.error(`[mine] OPENAI_BATCH: batch ${batchId} complete, validating candidates...`);

  let idn = existing.length, generated = 0, validated = 0;
  const START = Date.now();
  for (let i = 0; i < chunks.length && kept.length - existing.length < TARGET; i++) {
    const r = results.get(`chunk-${i}`);
    let cases = [];
    if (r.error) { console.error(`[mine] OPENAI_BATCH: chunk ${i} generation error: ${r.error}`); continue; }
    try { cases = (JSON.parse(r.content).cases || []); } catch (e) { console.error(`[mine] OPENAI_BATCH: chunk ${i} JSON parse error: ${e.message}`); continue; }
    const candidates = [];
    for (const c of cases) {
      if (!c.query || !Array.isArray(c.expect) || !c.expect.length) continue;
      if (PHI.test(`${c.query} ${c.expect.join(" ")}`)) continue;
      const q = c.query.toLowerCase();
      if (haveQ.has(q)) continue;
      haveQ.add(q); generated++;
      candidates.push({ id: `gm-${String(++idn).padStart(3, "0")}`, query: c.query, agent: AGENT, engine: "semantic", expect: c.expect.slice(0, 2), note: `mined+validated from real ${AGENT} ledger` });
    }
    const hits = await validateConcurrent(candidates, 10);
    for (const h of hits) { if (kept.length - existing.length >= TARGET) break; kept.push(h); validated++; }
    console.log(`[mine] OPENAI_BATCH chunk ${i + 1}/${chunks.length}: ${candidates.length} candidates -> ${hits.length} validated; new total ${kept.length - existing.length}/${TARGET}`);
    writeFileSync(OUT, JSON.stringify(kept, null, 2) + "\n"); // incremental save, same as the synchronous path
    if (MAX_MIN && Date.now() - START > MAX_MIN * 60000) { console.log(`[mine] --max-minutes ${MAX_MIN} budget reached during validation; stopping with ${kept.length - existing.length} new validated.`); break; }
  }
  return { generated, validated, batchesTried: chunks.length };
}

async function main() {
  const facts = corpus();
  console.log(`[mine] corpus: ${facts.length} real non-PHI ${AGENT} facts; target ${TARGET} validated hard cases.`);
  if (!facts.length) { console.error("[mine] empty corpus"); process.exit(1); }

  const existing = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : [];
  const kept = [...existing];
  const haveQ = new Set(existing.map((c) => (c.query || "").toLowerCase()));
  let generated = 0, validated = 0, batchesTried = 0;

  // BATCH_MODE (2026-09-02): OPENAI_BATCH unset (the state of every job today) means this branch never
  // runs and the ELSE branch below is the EXACT pre-existing synchronous loop, byte-identical to
  // before this lever existed. See runBatchMode()'s own header for the full contract and the one
  // disclosed behavior difference (no early-stop on the generation calls themselves).
  if (LLM_PROVIDER === "openai" && isBatchEnabled("recall-evals-mine-cases")) {
    const r = await runBatchMode(facts, existing, kept, haveQ);
    generated = r.generated; validated = r.validated; batchesTried = r.batchesTried;
  } else {
    let idn = existing.length;
    const START = Date.now();
    for (let off = 0; off < facts.length && kept.length - existing.length < TARGET; off += BATCH) {
      const batch = facts.slice(off, off + BATCH);
      batchesTried++;
      let cases = [];
      try {
        const raw = await callChat(SYSTEM, batch.map((f, i) => `${i + 1}. ${f}`).join("\n\n"));
        cases = (JSON.parse(raw).cases || []);
      } catch (e) { console.error(`[mine] batch ${batchesTried} gen error: ${e.message}`); continue; }
      const candidates = [];
      for (const c of cases) {
        if (!c.query || !Array.isArray(c.expect) || !c.expect.length) continue;
        if (PHI.test(`${c.query} ${c.expect.join(" ")}`)) continue;
        const q = c.query.toLowerCase();
        if (haveQ.has(q)) continue;
        haveQ.add(q); generated++;
        // note interpolates the REAL scanned agent (was hardcoded "commons" regardless of --agent, so
        // every mined case's own documentation lied about its source lane once mined against cto/coo/etc).
        candidates.push({ id: `gm-${String(++idn).padStart(3, "0")}`, query: c.query, agent: AGENT, engine: "semantic", expect: c.expect.slice(0, 2), note: `mined+validated from real ${AGENT} ledger` });
      }
      const hits = await validateConcurrent(candidates, 10);
      for (const h of hits) { if (kept.length - existing.length >= TARGET) break; kept.push(h); validated++; }
      console.log(`[mine] batch ${batchesTried}: ${candidates.length} candidates -> ${hits.length} validated; new total ${kept.length - existing.length}/${TARGET}`);
      writeFileSync(OUT, JSON.stringify(kept, null, 2) + "\n"); // incremental save: a crash or --max-minutes time-box keeps all work so far
      if (MAX_MIN && Date.now() - START > MAX_MIN * 60000) { console.log(`[mine] --max-minutes ${MAX_MIN} budget reached; stopping with ${kept.length - existing.length} new validated.`); break; }
    }
  }
  writeFileSync(OUT, JSON.stringify(kept, null, 2) + "\n");
  console.log(`[mine] DONE: generated ${generated}, VALIDATED ${validated} new hard cases -> ${OUT} now has ${kept.length} cases (was ${existing.length}). Batches tried: ${batchesTried}.`);
}
// isMain guard (2026-08-29, added alongside the flex-lane adoption above): mirrors
// mine-hard-negatives.mjs's existing pattern in this same directory -- purely a test-safety refactor
// so callChat can be safely `import()`-ed and exercised directly (with a mocked fetch) without main()
// executing a real corpus scan / real API calls / process.exit(). No logic inside main() changed.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((e) => { console.error("[mine] FATAL", e.message); process.exit(1); });
