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
// Usage (creds via kvSecret / AZURE_SP or run.sh):
//   node mine-cases.mjs --agent commons --target 100 --out golden-set.json
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { kvSecret } from "../kb-memory/azure-secret.mjs";
import { TIERS, chatBody } from "../../setup/model-routing.mjs";
import { hitAtK, groupHitLines } from "./scoring.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
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

async function callChat(system, user) {
  const ep = (await kvSecret("azure-openai-endpoint") || "").replace(/\/$/, "");
  const key = await kvSecret("azure-openai-key");
  const dep = process.env.MINE_MODEL || TIERS.standard.deployment;
  if (!ep || !key) throw new Error("missing azure-openai endpoint/key");
  const body = chatBody(dep, { messages: [{ role: "system", content: system }, { role: "user", content: user }], maxTokens: 1500, jsonMode: true });
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

async function main() {
  const facts = corpus();
  console.log(`[mine] corpus: ${facts.length} real non-PHI ${AGENT} facts; target ${TARGET} validated hard cases.`);
  if (!facts.length) { console.error("[mine] empty corpus"); process.exit(1); }

  const existing = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : [];
  const kept = [...existing];
  const haveQ = new Set(existing.map((c) => (c.query || "").toLowerCase()));
  let idn = existing.length, generated = 0, validated = 0, batchesTried = 0;
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
  writeFileSync(OUT, JSON.stringify(kept, null, 2) + "\n");
  console.log(`[mine] DONE: generated ${generated}, VALIDATED ${validated} new hard cases -> ${OUT} now has ${kept.length} cases (was ${existing.length}). Batches tried: ${batchesTried}.`);
}
main().catch((e) => { console.error("[mine] FATAL", e.message); process.exit(1); });
