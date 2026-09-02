#!/usr/bin/env node
// company-brain — ask ONE question, get a cited answer grounded across EVERYTHING the company
// knows: the agent lessons/decisions (memory-exec), the legal data room, the CFO finance room, the
// commerce room, and the company journal. Federates the per-room search indexes (hybrid keyword +
// vector), then synthesizes a cited answer. The "billion-dollar brain" query.
//
// RING SAFETY: legal-personal (attorney-privileged) is EXCLUDED by default and only included with
// --include-personal AND --agent clo. MedReview/PHI is never indexed here. Non-PHI ring.
//
// ================== BACKEND SELECTORS (Azure exit, 2026-08-18) ==================
// This file used to be 100% hardcoded to Azure: init() resolved azure-search-endpoint /
// azure-search-admin-key and three tiers of Azure OpenAI chat deployments, with NO OpenSearch and no
// OpenAI-direct branch anywhere. Azure subscription 55c84f6b is PERMANENTLY GONE, so every single
// invocation threw -- and every per-repo CLAUDE.md names this tool in a mandatory GROUND-FIRST
// PROTOCOL as the first call for any company question. Three INDEPENDENT selectors now dispatch it,
// the same names and values the rest of the fleet already uses (skills/kb-memory/semantic.mjs,
// otchealth-mcp-server's src/search/index.ts + src/azure/foundry.ts):
//   SEARCH_BACKEND      opensearch (DEFAULT) | azure
//   EMBEDDINGS_PROVIDER openai     (DEFAULT) | foundry
//   LLM_PROVIDER        openai     (DEFAULT) | foundry
// They are independent on purpose: a run is only Azure-free when ALL THREE are off Azure (search,
// embeddings and chat each reach Azure separately).
//
// THE DEFAULTS ARE THE LIVE OPTIONS, NOT azure/foundry. This is a DELIBERATE DEPARTURE from the
// default('azure')/default('foundry') posture of semantic.mjs and the gateway's env schema, and it
// is the correct call now: those defaults were written while Azure was the live estate and the new
// path was the escape hatch. That is inverted. Defaulting the fleet's most-invoked tool to a
// permanently deleted subscription is not a conservative choice, it is a guaranteed outage on every
// call for anyone who has not set an env var -- which is every agent seat, since these variables are
// unset fleet-wide. Azure remains fully reachable via SEARCH_BACKEND=azure / EMBEDDINGS_PROVIDER=
// foundry / LLM_PROVIDER=foundry; nothing was deleted, and the day a vault and a search service
// exist again the old path is one env var away.
//
// EMBEDDING SPACE IS PINNED, NOT CONFIGURABLE: text-embedding-3-large @ 3072 dims, the space the
// ~492,557 live room documents were built in. OpenAI serves the identical model, so this switch
// needs no reindex. A DIFFERENT model (Bedrock Titan/Cohere, or the OpenAI `dimensions` truncation
// parameter) would produce vectors in an incompatible space, and cosine similarity between
// incompatible spaces still returns plausible numbers -- semantic search would rank garbage while
// every health check stayed green. See opensearch-rooms.mjs's assertEmbeddingSpace() guard.
//
// DIFF MODE: `brain.mjs diff "<topic>" --since <date>` walks the WARM memory-of-record (the raw
// per-agent exec-feed ledgers kb-memory writes, the same {ts, supersedes, was} rows semantic.mjs
// indexes into memory-exec) for facts/decisions/corrections touching the resolved topic whose ts OR
// whose supersedes-transition falls in the window, and renders a structured delta: added / changed
// (with the supersedes chain) / retired / still-true. This is the MINIMAL version over the existing
// {ts, supersedes} fields (no bi-temporal model, that is north-star); see diffMemory() below.
//
// Usage:
//   node brain.mjs ask "<question>" [--rooms memory,legal,finance,commerce,journal] [--n 6] [--agent clo --include-personal]
//   node brain.mjs diff "<topic>" --since <date> [--n 8] [--agent clo --include-personal] [--summarize]
//   node brain.mjs rooms                      # list the indexes it can search
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { TIERS, LEGACY_STANDARD, resolveTier, modelFamilyOf, chatBody, truncatedEmpty, positiveIntEnv } from "../../setup/model-routing.mjs";
import { logPrefixForText } from "../../setup/prompt-shape.mjs";
import { kvSecret } from "../kb-memory/azure-secret.mjs";
import { RING_DENY } from "../kb-memory/dedupe.mjs";
import { recordOpenAIUsage } from "../../setup/openai-usage.mjs";
// OpenAI-direct embeddings + credential resolution, reused from the module that already owns them
// (it is imported, never edited). resolveOpenAIKey() checks env -> AWS SSM -> Key Vault in that
// order, so it resolves with no Azure involvement at all.
import { resolveOpenAIKey, embedOpenAI, resolveOpenSearchConfig } from "../kb-memory/opensearch-write.mjs";
// The OpenSearch ROOM adapter (this skill's own new file): chunked/flat aware hybrid search over the
// federated brain rooms, plus the embedding-space guard.
import * as OSR from "./opensearch-rooms.mjs";
const SM = "otchealth-shared-prod";
const AIS_API = "2023-11-01";
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const argv = process.argv.slice(2);
const cmd = argv[0];
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const QUERY = argv.slice(1).filter((a, i, arr) => !a.startsWith("--") && !(i > 0 && arr[i - 1].startsWith("--"))).join(" ").trim();
const PERK = parseInt(val("--n", "6"), 10) || 6;
const AGENT = (val("--agent", "") || "").toLowerCase();
// The --include-personal privilege gate is enforced in selectRooms() (single source of truth).

/**
 * Resolve the three backend selectors from an env bag. PURE (takes the env, returns an object) so
 * the DEFAULTS themselves are directly unit-testable without mutating process.env -- the defaults
 * are the load-bearing part of this change, so they get a test, not a comment.
 *
 * Defaults are the LIVE options (opensearch / openai / openai), NOT azure/foundry. See this file's
 * header for why that inversion is deliberate and correct as of the Azure exit.
 */
export function resolveSelectors(env = process.env) {
  const pick = (raw, dflt) => String(raw == null || raw === "" ? dflt : raw).trim().toLowerCase();
  return {
    searchBackend: pick(env.SEARCH_BACKEND, "opensearch"),   // 'opensearch' | 'azure'
    embeddingsProvider: pick(env.EMBEDDINGS_PROVIDER, "openai"), // 'openai' | 'foundry'
    llmProvider: pick(env.LLM_PROVIDER, "openai"),           // 'openai' | 'foundry'
  };
}
const { searchBackend: SEARCH_BACKEND, embeddingsProvider: EMBEDDINGS_PROVIDER, llmProvider: LLM_PROVIDER } = resolveSelectors();

// room -> AI Search index. (Indexes built by doc-indexer per profile/container + kb-memory semantic.)
const ROOMS = {
  memory:   { index: "memory-exec",                 label: "agent lessons + decisions (shared brain)" },
  legal:    { index: "legal-company",               label: "company legal: contracts, litigation, securities" },
  finance:  { index: "finance-cfo-source-docs",     label: "CFO finance data room" },
  commerce: { index: "commerce-commerce-source-docs",label: "commerce / store data room" },
  journal:  { index: "commons-company-journal",     label: "daily company journal + digests" },
};
const PERSONAL = { index: "legal-personal", label: "PRIVILEGED personal legal (CLO only)" };
// CHUNKED doc rooms (one child doc per chunk; vector field text_vector on both engines; parent_id
// links chunks -> parent). memory-exec stays FLAT. The set is no longer duplicated here: it is
// imported from opensearch-rooms.mjs, which mirrors the gateway's single registry
// (otchealth-mcp-server/src/azure/search.ts:68-74) -- room shape is a property of the DATA, not of
// which engine serves it, which is why the gateway resolves it from one registry for both backends
// too (src/search/index.ts isChunkedRoom). Identical membership to the literal it replaces.
const DOC_ROOMS = OSR.CHUNKED_ROOMS;

// The attorney-privilege wall, isolated as a PURE function so tests/brain-rooms.test.mjs can prove it
// without any Azure call. legal-personal joins the target rooms ONLY when the caller is the CLO AND
// explicitly passes --include-personal. Every other agent, and the flag without the clo agent, gets
// the non-privileged rooms only. Single source of truth for room selection; no I/O here.
export function selectRooms({ rooms = "", agent = "", includePersonal = false } = {}) {
  const wanted = rooms ? rooms.split(",").map(s => s.trim()).filter(Boolean) : Object.keys(ROOMS);
  const targets = wanted.filter(r => ROOMS[r]).map(r => ({ room: r, ...ROOMS[r] }));
  if (includePersonal && String(agent).toLowerCase() === "clo") targets.push({ room: "personal", ...PERSONAL });
  return targets;
}

function saJwt(scope) { const __r=process.env.GCP_CLAUDE_DRIVER_SA_JSON;if(!__r){return null;}let sa;try{sa=JSON.parse(__r);}catch{return null;}if(!sa||!sa.private_key){return null;} const now = Math.floor(Date.now() / 1000); const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"); const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`; return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url"); }
async function sm(id) { const _kv = await kvSecret(id); if (_kv != null) return _kv; const r0 = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt("https://www.googleapis.com/auth/cloud-platform"))}` }); const t = (await r0.json()).access_token; const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } }); if (!r.ok) return null; return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim(); }

let AIS_EP, AIS_KEY, AOAI_EP, AOAI_KEY, AOAI_DEP, CHAT_PROVIDERS = [];
async function init() {
  // ---- SEARCH ----------------------------------------------------------------------------------
  if (SEARCH_BACKEND === "opensearch") {
    // Throws a clear, actionable message when AWS credentials are genuinely unresolvable, and never
    // touches azure-search-*. Memoized inside that module, so calling it here IS the whole setup:
    // resolving up front means a credential problem fails at init, not halfway through a federation.
    await resolveOpenSearchConfig();
  } else if (SEARCH_BACKEND === "azure") {
    AIS_EP = (await sm("azure-search-endpoint") || "").replace(/\/$/, ""); AIS_KEY = await sm("azure-search-admin-key");
    if (!AIS_EP || !AIS_KEY) throw new Error("SEARCH_BACKEND=azure but azure-search-endpoint/azure-search-admin-key are unavailable (Azure subscription 55c84f6b is retired; use the default SEARCH_BACKEND=opensearch)");
  } else {
    // A typo must not silently route the brain at nothing (and must not fall back to the dead store).
    throw new Error(`SEARCH_BACKEND="${SEARCH_BACKEND}" is not recognised (expected "opensearch" or "azure")`);
  }

  // ---- EMBEDDINGS -------------------------------------------------------------------------------
  if (EMBEDDINGS_PROVIDER === "openai") {
    await resolveOpenAIKey(); // throws a clear message if unresolvable; never touches azure-openai-*
  } else {
    AOAI_EP = ((await sm("azure-foundry-openai-endpoint")) || (await sm("azure-openai-endpoint")) || "").replace(/\/$/, "");
    AOAI_KEY = (await sm("azure-foundry-key")) || (await sm("azure-openai-key"));
    AOAI_DEP = (await sm("azure-openai-embedding-deployment")) || OSR.EMBEDDING_MODEL;
    if (!AOAI_EP || !AOAI_KEY) throw new Error("EMBEDDINGS_PROVIDER=foundry but the Azure OpenAI endpoint/key are unavailable (use the default EMBEDDINGS_PROVIDER=openai)");
  }

  // ---- CHAT SYNTHESIS ---------------------------------------------------------------------------
  // Two providers in order so a transient throttle on one never silences the brain. gpt-4.1-mini is
  // BANNED for quality/summarization work (setup/model-routing.mjs) and the brain's whole job IS
  // quality synthesis, so the fallback is the shared 'quality' tier (top reasoning tier).
  if (LLM_PROVIDER === "openai") {
    // api.openai.com. FIXED 2026-08-29: this used to default to TIERS.standard/TIERS.quality
    // (the AZURE deployment-name table) as a documented "bet that the Azure deployment was named
    // after its real underlying model" -- see git history for the original comment. That bet is now
    // moot: OPENAI_TIERS is the fleet's own, independently-live-verified OpenAI tier table (see
    // setup/model-routing.mjs's 2026-08-29 header note), so this resolves against it directly via
    // resolveTier(tier, "openai") instead of reading the Azure-named table and hoping the string
    // happens to also be a real OpenAI model id. This is the SAME "obvious misfit" class documented on
    // every other ported caller in this toolkit (critic-pass, shark-round, the signal-radar
    // detectors, ...) -- brain.mjs was the one caller still bypassing OPENAI_TIERS for its default.
    // Override with BRAIN_MODEL / BRAIN_FALLBACK_MODEL (or OPENAI_CHAT_MODEL / OPENAI_HIGH_MODEL, the
    // gateway's own names) same as before; an explicit override still wins over the tier default.
    const key = await resolveOpenAIKey();
    const dep = process.env.BRAIN_MODEL || process.env.OPENAI_CHAT_MODEL || resolveTier("standard", "openai").deployment;
    const fbDep = process.env.BRAIN_FALLBACK_MODEL || process.env.OPENAI_HIGH_MODEL || resolveTier("quality", "openai").deployment;
    CHAT_PROVIDERS.push({ kind: "openai", key, dep, label: `openai/${dep}`, modelFamily: modelFamilyOf(dep) });
    if (fbDep !== dep) CHAT_PROVIDERS.push({ kind: "openai", key, dep: fbDep, label: `openai/${fbDep}`, modelFamily: modelFamilyOf(fbDep) });
  } else {
    // Azure path, unchanged. PRIMARY + SECONDARY both live on the Foundry resource (2,000K TPM
    // GlobalStandard); the LEGACY Azure OpenAI resource (gpt-4o capped at 50K TPM regional
    // "Standard", 100% subscribed, zero headroom) stays a last-resort TERTIARY only -- primarying on
    // it caused the recurring "Azure OpenAI throttled (blocked_calls)" Datadog page (2026-08-01).
    const fEp = (await sm("azure-foundry-openai-endpoint") || "").replace(/\/$/, ""); const fKey = await sm("azure-foundry-key");
    const lEp = (await sm("azure-openai-endpoint") || "").replace(/\/$/, ""); const lKey = await sm("azure-openai-key");
    if (fEp && fKey) { const dep = process.env.BRAIN_MODEL || TIERS.standard.deployment; CHAT_PROVIDERS.push({ kind: "azure", ep: fEp, key: fKey, dep, label: `foundry/${dep}`, modelFamily: modelFamilyOf(dep) }); }
    if (fEp && fKey) { const fbDep = process.env.BRAIN_FALLBACK_MODEL || TIERS.quality.deployment; CHAT_PROVIDERS.push({ kind: "azure", ep: fEp, key: fKey, dep: fbDep, label: `foundry/${fbDep}`, modelFamily: modelFamilyOf(fbDep) }); }
    if (lEp && lKey) { const legDep = process.env.BRAIN_LEGACY_MODEL || LEGACY_STANDARD.deployment; CHAT_PROVIDERS.push({ kind: "azure", ep: lEp, key: lKey, dep: legDep, label: `legacy/${legDep}`, modelFamily: modelFamilyOf(legDep) }); }
  }
  if (!CHAT_PROVIDERS.length) throw new Error(`no chat provider creds for LLM_PROVIDER=${LLM_PROVIDER}`);
}
async function embed(text) {
  if (EMBEDDINGS_PROVIDER === "openai") {
    // Pinned to text-embedding-3-large @ 3072 inside embedOpenAI (never configurable, no `dimensions`
    // parameter). The guard below is the query-time proof that the vector is in the one space the
    // ~492,557 live room documents were embedded in.
    const vec = (await embedOpenAI([text]))[0];
    OSR.assertEmbeddingSpace(vec);
    return vec;
  }
  for (let a = 0; a < 6; a++) {
    const r = await fetch(`${AOAI_EP}/openai/deployments/${AOAI_DEP}/embeddings?api-version=2024-02-01`, { method: "POST", headers: { "api-key": AOAI_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ input: [text] }) });
    if (r.status === 429) { const ra = +(r.headers.get("retry-after") || 0); await new Promise(s => setTimeout(s, (ra ? ra * 1000 : 1500 * (a + 1)))); continue; }
    if (!r.ok) throw new Error("embed " + r.status);
    const vec = (await r.json()).data[0].embedding;
    OSR.assertEmbeddingSpace(vec);
    return vec;
  }
  throw new Error("embed 429 exhausted");
}
async function searchIndex(index, vec, query) {
  if (SEARCH_BACKEND === "opensearch") {
    // Chunked/flat awareness, the vector-field choice, RRF fusion and chunk -> parent collapsing all
    // live in the adapter. THROWS on a BM25 failure (see its header): a room that could not be
    // searched must never be reported as a room that held nothing.
    const { hits } = await OSR.searchRoom(index, { queryText: query, vector: vec, top: PERK });
    return hits;
  }
  // ---- Azure AI Search (non-default; kept intact for a future re-provisioned service) -------------
  // vector_semantic_hybrid: BM25 keyword + vector fused by RRF, then the L2 SEMANTIC RERANKER
  // (every room index carries the "sem" semantic config). This is the Microsoft-benchmarked default
  // that fixes weak keyword-only recall. Falls back to plain hybrid if semantic errors (missing
  // config / quota exhausted) so recall NEVER regresses below what we had.
  // CHUNK AWARENESS keyed on the LIVE endpoint (S1 vs Basic): zero-op while pointed at Basic (flat),
  // self-switches when azure-search-endpoint flips to S1 at the Phase-3 cutover. Chunked doc rooms use
  // the text_vector field and store one child doc per chunk, so we over-fetch then collapse to parents.
  const chunked = /otchealth-dataroom-s1/i.test(AIS_EP) && DOC_ROOMS.has(index);
  const vecField = chunked ? "text_vector" : "contentVector";
  const perk = chunked ? Math.min(50, PERK * 3) : PERK;
  const base = { search: query, top: perk, vectorQueries: [{ kind: "vector", vector: vec, fields: vecField, k: perk }] };
  if (chunked) base.select = "chunk_id,parent_id,title,path,chunk";
  const url = `${AIS_EP}/indexes/${index}/docs/search?api-version=${AIS_API}`;
  const hdr = { "api-key": AIS_KEY, "Content-Type": "application/json" };
  let r = await fetch(url, { method: "POST", headers: hdr, body: JSON.stringify({ ...base, queryType: "semantic", semanticConfiguration: "sem" }) });
  if (!r.ok) r = await fetch(url, { method: "POST", headers: hdr, body: JSON.stringify(base) });
  // Keyword-only last resort: if BOTH vector attempts fail (e.g. text_vector not present because the
  // endpoint has not cut over yet), drop the vectorQueries AND the select (a select that names a field
  // absent on the live index is itself a 400 cause) so recall degrades to keyword, never to empty.
  if (!r.ok) { const { vectorQueries, select, ...kw } = base; r = await fetch(url, { method: "POST", headers: hdr, body: JSON.stringify(kw) }); }
  // THROW, never `return []`. Returning an empty array here made a BROKEN room indistinguishable from
  // an EMPTY one: ask() then printed "No grounded results across the company brain", which reads as
  // "the company has no record of this" -- a fabricated negative finding on a ground-first tool every
  // agent is instructed to trust. The retries above are recall-preserving degradations; this is the
  // point where the room genuinely could not be searched.
  if (!r.ok) throw new Error(`azure room '${index}': search failed ${r.status} ${(await r.text()).slice(0, 200)}`);
  // With the semantic reranker present, @search.rerankerScore (0-4) is the authoritative relevance;
  // fall back to @search.score when a room had to use plain hybrid. `chunk` is the chunked-room text field.
  let hits = ((await r.json()).value || []).map((h, i) => ({
    score: h["@search.rerankerScore"] ?? h["@search.score"] ?? 0,
    text: (h.content || h.text || h.chunk || "").slice(0, 1200),
    path: h.path || h.title || "", entity: h.entity || "", agent: h.agent || "", type: h.type || "",
    _parent: String(h.parent_id ?? h.path ?? h.id ?? h.chunk_id ?? `__row${i}`),
  }));
  if (chunked) {
    // Collapse chunks to one hit per parent doc (keep the best-scored chunk), then trim to PERK so a
    // single document cannot flood the fused pool with N of its own chunks.
    const best = new Map();
    for (const h of hits) { const c = best.get(h._parent); if (!c || h.score > c.score) best.set(h._parent, h); }
    hits = [...best.values()].sort((a, b) => b.score - a.score).slice(0, PERK);
  }
  return hits.map(({ _parent, ...h }) => h);
}
/** PURE. Where one resolved chat provider's request goes and what it looks like. OpenAI addresses the
 *  model in the BODY and authenticates with a bearer token; Azure bakes the deployment into the URL
 *  and uses an api-key header. Exported so the provider split is testable without a network call. */
export function chatRequestFor(p, body) {
  if (p.kind === "openai") {
    return {
      url: OPENAI_CHAT_URL,
      headers: { Authorization: `Bearer ${p.key}`, "Content-Type": "application/json" },
      body: { ...body, model: p.dep },
    };
  }
  return {
    url: `${p.ep}/openai/deployments/${p.dep}/chat/completions?api-version=2024-06-01`,
    headers: { "api-key": p.key, "Content-Type": "application/json" },
    body,
  };
}
// BRAIN_MAX_TOKENS 900 -> 6000 (2026-08-30, FND-20260830-e927): live-reproduced against this tool's
// OWN synthesis shape (14 real sources, a genuinely demanding "walk through every incident and
// explain the connections" question, the exact prompt shape ask() builds below): 900 tokens
// truncated 6/6 times and 2000 tokens truncated 3/3 times, EVERY time finish_reason:"length" with
// ZERO visible content -- an HTTP 200, not an error. This tool is the fleet's GROUND-FIRST source of
// truth (every repo's CLAUDE.md instructs every agent to answer company questions ONLY from this
// tool's output); a silently blank answer printed between a correct header and a correct "grounded
// in N sources" footer does not read as a failure to a human or another agent, it reads as an
// authoritative non-answer. 3000+ succeeded reliably in the same live test (visible completion up to
// ~2400 tokens on the hardest question tried). 6000 leaves real margin over that observed ceiling; it
// costs nothing extra on the easy majority of questions (max_completion_tokens is a CAP billed on
// tokens actually generated, not a floor -- the very first, simpler test question in this same sweep
// used only ~300-340 total tokens even against a 900 cap) and only matters the moment a question
// genuinely needs the room. Env-overridable (BRAIN_MAX_TOKENS) for a future re-tuning with no code
// change.
const BRAIN_MAX_TOKENS = positiveIntEnv("BRAIN_MAX_TOKENS", 6000);

// Exported (2026-08-30, alongside the BRAIN_MAX_TOKENS fix) purely for direct unit testing of the
// real HTTP path with a mocked fetch and a synthetic provider object -- mirrors this file's existing
// pattern of exporting pure/testable pieces (chatRequestFor, assessSearchOutcome, ...) rather than
// leaving the whole network path only reachable through the CLI's ask()/init() flow. No behavior change.
export async function callChat(p, system, user, tries) {
  // Request-body shape (max_completion_tokens vs max_tokens+temperature) is decided ONCE, centrally,
  // in setup/model-routing.mjs so every caller in the fleet (and the gateway) agrees. It keys off the
  // model NAME, so it is correct for both providers: gpt-5.x/o-series are reasoning-family and reject
  // max_tokens + a non-default temperature on api.openai.com exactly as they do on Foundry.
  let curTokens = BRAIN_MAX_TOKENS;
  let escalated = false;
  // Prompt-caching hygiene (2026-09-02): `system` (either ask()'s or diffCmd()'s --summarize system
  // prompt, both module-level string literals) is fully static and already sent first, with the
  // per-question SOURCES/DELTA content (fully variable, never shared across calls) last -- already
  // cache-friendly order. Logged ONCE per attempt here (the single transport both callers funnel
  // through) rather than at each of the two call sites, so this never drifts if a third caller is
  // added later. company-brain is interactive/on-demand, excluded from OPENAI_BATCH by design (see
  // run-evals.mjs's BATCH MODE section header for the general rule this follows).
  logPrefixForText("company-brain", system);
  for (let a = 0; a < tries; a++) {
    const shaped = chatBody(p.dep, { messages: [{ role: "system", content: system }, { role: "user", content: user }], maxTokens: curTokens });
    const req = chatRequestFor(p, shaped);
    const r = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body) });
    if (r.status === 429) { const ra = +(r.headers.get("retry-after") || 0); await new Promise(s => setTimeout(s, ra ? ra * 1000 : 2000 * (a + 1))); continue; }
    if (!r.ok) throw new Error(`chat ${p.label} ${r.status} ${(await r.text()).slice(0, 160)}`);
    const j = await r.json();
    if (p.kind === "openai") {
      recordOpenAIUsage({
        model: p.dep,
        kind: "chat",
        promptTokens: j.usage?.prompt_tokens || 0,
        completionTokens: j.usage?.completion_tokens || 0,
        cachedTokens: j.usage?.prompt_tokens_details?.cached_tokens || 0,
        caller: "company-brain",
      });
    }
    const choice = j.choices[0];
    // On truncated-empty (the reasoning-budget-exhaustion shape, see BRAIN_MAX_TOKENS's comment
    // above), retry within the SAME existing `tries` budget the 429 path already uses, escalating
    // the token budget 2x on the FIRST such occurrence only (never repeatedly). If it is STILL
    // truncated-empty on the final attempt, THROW a clear, distinct error instead of silently
    // returning "" as if it were a real (blank) answer -- ask()/diffCmd() below have no try/catch of
    // their own around this call, so this surfaces as an unmistakable top-level "ERROR: ..." on the
    // CLI rather than a blank line between two structurally-correct-looking output lines.
    if (truncatedEmpty(choice) && a < tries - 1) { if (!escalated) { escalated = true; curTokens = curTokens * 2; } continue; }
    if (truncatedEmpty(choice)) {
      throw Object.assign(
        new Error(`chat ${p.label}: reasoning model exhausted its token budget (${curTokens}) on hidden reasoning with no visible output (finish_reason=length) even after retry+escalation -- this is an infra failure, not a real (blank) answer`),
        { reasoningExhausted: true }
      );
    }
    return choice.message.content;
  }
  throw Object.assign(new Error("429"), { throttled: true });
}
async function chat(system, user) {
  // Try each provider in order (standard -> quality [-> legacy last-resort on Azure]). A throttle
  // on one falls through to the next instead of failing the query. Fewer retries on the primary so we
  // reach the fallback faster when it is sustained-busy.
  let lastErr;
  for (let i = 0; i < CHAT_PROVIDERS.length; i++) {
    const p = CHAT_PROVIDERS[i];
    try { const out = await callChat(p, system, user, i === 0 ? 4 : 6); if (i > 0) console.error(`  (brain synthesized via fallback ${p.label})`); return out; }
    catch (e) { lastErr = e; if (e.throttled && i < CHAT_PROVIDERS.length - 1) { console.error(`  (${p.label} throttled; falling back to ${CHAT_PROVIDERS[i + 1].label})`); continue; } if (e.throttled) continue; throw e; }
  }
  throw new Error(`all chat providers failed or were throttled (LLM_PROVIDER=${LLM_PROVIDER}); last error: ${lastErr && lastErr.message}`);
}

/**
 * PURE. Decide what a federation of room searches actually PROVED, given how many rooms were
 * attempted, which ones failed, and how many hits came back.
 *
 * THIS IS THE ANTI-FALSE-NEGATIVE RULE. A ground-first tool that prints "No grounded results across
 * the company brain" when its search backend was simply unreachable is worse than one that crashes:
 * every per-repo CLAUDE.md instructs agents to answer ONLY from this tool's output and never from
 * general knowledge, so an empty-because-broken result is read as an authoritative "the company has
 * no record of this" and gets repeated as fact. Absence of evidence is only evidence of absence when
 * the search actually ran.
 *   - every room failed                -> ok:false (hard error, non-zero exit)
 *   - some rooms failed AND zero hits  -> ok:false (cannot distinguish "nothing there" from "broken")
 *   - some rooms failed AND some hits  -> ok:true, degraded:true (answer, but label it PARTIAL)
 *   - no failures                      -> ok:true (an empty result here is a real negative finding)
 * Exported for unit tests.
 */
export function assessSearchOutcome({ roomsAttempted = 0, failures = [], hits = 0 } = {}) {
  const failed = failures.length;
  const names = failures.map((f) => `${f.room || f.index || "?"}: ${f.error || f.message || "unknown error"}`).join("; ");
  if (roomsAttempted > 0 && failed >= roomsAttempted) {
    return { ok: false, degraded: true, message: `COMPANY BRAIN SEARCH FAILED: all ${roomsAttempted} room(s) errored, so NOTHING was searched. This is NOT a "no results" answer -- do not treat it as evidence that the company has no record of this. Failures: ${names}` };
  }
  if (failed > 0 && hits === 0) {
    return { ok: false, degraded: true, message: `COMPANY BRAIN SEARCH INCONCLUSIVE: ${failed} of ${roomsAttempted} room(s) errored and the rooms that did answer returned nothing, so "no results" cannot be distinguished from "search broken". Failures: ${names}` };
  }
  if (failed > 0) {
    return { ok: true, degraded: true, message: `WARNING -- PARTIAL ANSWER: ${failed} of ${roomsAttempted} room(s) could not be searched, so this answer is grounded in an incomplete corpus. Failures: ${names}` };
  }
  return { ok: true, degraded: false, message: "" };
}

async function ask() {
  if (!QUERY) { console.error('ask "<question>"'); process.exit(2); }
  const targets = selectRooms({ rooms: val("--rooms", ""), agent: AGENT, includePersonal: argv.includes("--include-personal") });
  await init();
  const vec = await embed(QUERY);
  const all = [];
  const failures = [];
  for (const t of targets) {
    // Per-room try/catch, then ONE verdict over the whole federation below: one dead room must not
    // abort a query the other five could have answered, and must not vanish either.
    try {
      const hits = await searchIndex(t.index, vec, QUERY);
      for (const h of hits) all.push({ ...h, room: t.room });
      console.error(`  ${t.room}: ${hits.length} hit(s)`);
    } catch (e) {
      failures.push({ room: t.room, index: t.index, error: e && e.message });
      console.error(`  ${t.room}: SEARCH FAILED -- ${e && e.message}`);
    }
  }
  all.sort((a, b) => b.score - a.score);
  const top = all.slice(0, 14);
  const outcome = assessSearchOutcome({ roomsAttempted: targets.length, failures, hits: all.length });
  if (!outcome.ok) { console.error(`\n${outcome.message}`); process.exit(1); }
  if (outcome.degraded) console.error(`\n${outcome.message}\n`);
  if (!top.length) { console.log("No grounded results across the company brain for that question. (All rooms were searched successfully; this is a real negative finding, not a search failure.)"); process.exit(0); }
  const sources = top.map((h, i) => `[${i + 1}] room=${h.room}${h.agent ? ` agent=${h.agent}` : ""}${h.entity ? ` entity=${h.entity}` : ""} ${h.path ? `(${h.path})` : ""}\n${h.text}`).join("\n\n");
  const sys = "You are the OTCHealth/InnerScope company brain. Answer the question using ONLY the provided sources from the company's own data rooms and agent memory. Cite each fact with its [n]. If the sources do not answer it, say so. Be concrete and decision-useful. Do not invent.";
  const answer = await chat(sys, `QUESTION: ${QUERY}\n\nSOURCES:\n${sources}`);
  console.log(`\n================ COMPANY BRAIN ================\nQ: ${QUERY}\n`);
  console.log(answer);
  console.log(`\n--- grounded in ${top.length} sources across ${[...new Set(top.map(h => h.room))].join(", ")} ---`);
  // Also on STDOUT: a reader who only sees the answer (piped, captured, pasted into a doc) must see
  // that the corpus was incomplete. A degradation only visible on stderr is a degradation that gets
  // quoted as a complete answer.
  if (outcome.degraded) console.log(`!!! ${outcome.message}`);
}

// =============================== DIFF MODE ===============================
// Same ring wall as ask/selectRooms: legal-personal / clo-personal is excluded unless the caller is
// the CLO AND passes --include-personal. Never widen; only restrict.
const isPersonalLane = (agent) => String(agent).toLowerCase() === "clo-personal";
// MNPI/PHI content wall (mirrors kb-memory's ringSafeCross): INND/securities and PHI-adjacent rows
// are internal-only, and only surfaced in a diff to an MNPI-authorized caller (clo/cfo/capital/cto).
// Every OTHER agent never sees them in a diff, even if they otherwise match the topic. RING_DENY is
// IMPORTED from kb-memory/dedupe.mjs (the one canonical copy) instead of a local literal, so this file
// can never silently drift out of sync with the shared wall; the MNPI_AUTHORIZED viewer exception below
// is specific to this file (a scheduled batch job has no such "authorized viewer" concept) and stays.
const MNPI_AUTHORIZED = new Set(["clo", "cfo", "capital", "cto"]);
export function ringSafeForDiff(row, agent) {
  if (MNPI_AUTHORIZED.has(String(agent).toLowerCase())) return true;
  return !RING_DENY.test(`${row.text || ""} ${(row.tags || []).join(" ")} ${row.was || ""}`);
}

/**
 * Decide which agent exec-feed lanes diff() is allowed to read. Pure, mirrors selectRooms()'s
 * privilege gate exactly (clo-personal only for --agent clo --include-personal) so the two entry
 * points (ask's room selection, diff's ledger walk) can never diverge on the wall. `lanes` is every
 * agent lane discoverable in the exec feed; PURE, no I/O, unit-testable.
 */
export function selectLanes(lanes, { agent = "", includePersonal = false } = {}) {
  const allowPersonal = includePersonal && String(agent).toLowerCase() === "clo";
  return lanes.filter((l) => !isPersonalLane(l) || allowPersonal);
}

/**
 * The core of diff mode: given a flat set of raw memory-of-record rows (each carrying at least
 * {id, agent, type, ts, text, was?, supersedes?}) that are candidates for the topic (already
 * topic-filtered by the caller, e.g. via a semantic search resolve step), bucket them relative to a
 * `since` window into:
 *   added    - a NEW row (fact/decision/status/entity) created inside the window that nothing later
 *              supersedes yet (still the current statement, and it is new-to-the-window).
 *   changed  - a row inside the window whose `supersedes` points at an earlier row (a correction or an
 *              entity re-set): rendered as the supersedes chain WAS -> NOW.
 *   retired  - a row that PRE-DATES the window but was superseded by something INSIDE the window (the
 *              old belief is now retired as of this window, even though it was stated earlier).
 *   stillTrue - a row that pre-dates the window, is still the active/non-superseded statement, and was
 *              NOT touched (no supersedes transition) inside the window. Context only, not a "delta".
 * Pure, no I/O, no ranking/dedup beyond a stable sort by ts -> fully unit-testable without Azure.
 */
export function diffMemory(rows, since, opts = {}) {
  const sinceMs = Date.parse(since);
  const now = opts.now ? Date.parse(opts.now) : Date.now();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const supersededBy = new Map(); // id -> the row that supersedes it (if any, anywhere in the set)
  for (const r of rows) if (r.supersedes && byId.has(r.supersedes)) supersededBy.set(r.supersedes, r);

  const inWindow = (r) => { const t = Date.parse(r.ts); return Number.isFinite(t) && t >= sinceMs && t <= now; };
  const chainFor = (r) => {
    // Walk backwards via supersedes to build the full WAS -> ... -> NOW chain for display.
    const chain = [r]; let cur = r;
    while (cur.supersedes && byId.has(cur.supersedes)) { cur = byId.get(cur.supersedes); chain.unshift(cur); }
    return chain;
  };

  const added = [], changed = [], retired = [], stillTrue = [];
  const seenChanged = new Set();
  for (const r of rows) {
    const rowInWindow = inWindow(r);
    const supersedesInWindow = r.supersedes && byId.has(r.supersedes) && rowInWindow;
    if (supersedesInWindow) {
      if (!seenChanged.has(r.id)) { changed.push({ id: r.id, agent: r.agent, type: r.type, chain: chainFor(r) }); seenChanged.add(r.id); }
      continue;
    }
    const wasRetiredInWindow = supersededBy.has(r.id) && inWindow(supersededBy.get(r.id)) && !rowInWindow;
    if (wasRetiredInWindow) { retired.push({ ...r, retiredBy: supersededBy.get(r.id).id, retiredAt: supersededBy.get(r.id).ts }); continue; }
    if (rowInWindow && !supersededBy.has(r.id)) { added.push(r); continue; }
    if (!rowInWindow && !supersededBy.has(r.id)) { stillTrue.push(r); continue; }
    // rowInWindow && supersededBy.has(r.id) but the superseding row is OUTSIDE the window (future-dated
    // relative to `now`, or a data anomaly) -> treat conservatively as added-then-later-changed; still
    // surfaces as added since the CHANGE itself is out of scope for this window.
    if (rowInWindow) added.push(r);
  }
  const byTs = (a, b) => (a.ts || "").localeCompare(b.ts || "");
  added.sort(byTs); stillTrue.sort(byTs);
  changed.sort((a, b) => byTs(a.chain[a.chain.length - 1], b.chain[b.chain.length - 1]));
  retired.sort(byTs);
  return { since, added, changed, retired, stillTrue };
}

function renderDiff(topic, delta) {
  const clip = (s, n = 160) => { s = (s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; };
  let out = `\n================ COMPANY BRAIN DIFF ================\nTopic: ${topic}\nSince: ${delta.since}\n\n`;
  out += `## ADDED (${delta.added.length})\n` + (delta.added.length ? delta.added.map((r) => `- [${r.agent}/${r.type}] [${(r.ts || "").slice(0, 10)}] ${clip(r.text)}`).join("\n") : "- (none)") + "\n\n";
  out += `## CHANGED (${delta.changed.length})\n` + (delta.changed.length ? delta.changed.map((c) => {
    const arrow = c.chain.map((r) => clip(r.text, 100)).join("\n      -> ");
    return `- [${c.agent}/${c.type}] ${c.id}\n      ${arrow}`;
  }).join("\n") : "- (none)") + "\n\n";
  out += `## RETIRED (${delta.retired.length})\n` + (delta.retired.length ? delta.retired.map((r) => `- [${r.agent}/${r.type}] ${clip(r.text)}  (retired ${r.retiredAt ? r.retiredAt.slice(0, 10) : "?"} by ${r.retiredBy})`).join("\n") : "- (none)") + "\n\n";
  out += `## STILL TRUE (${delta.stillTrue.length}, context only)\n` + (delta.stillTrue.length ? delta.stillTrue.slice(0, 10).map((r) => `- [${r.agent}/${r.type}] ${clip(r.text, 100)}`).join("\n") : "- (none)") + "\n";
  return out;
}

// read every shared exec-feed ledger row (same source semantic.mjs indexes from), ring-filtered.
//
// REMAINING AZURE DEPENDENCY, DELIBERATELY LEFT IN PLACE AND MADE LOUD (2026-08-18). Only DIFF mode
// uses this; `ask` (the ground-first path every CLAUDE.md mandates) no longer touches Azure at all.
// The warm ledger still lives in Azure Blob, and porting it to the S3 mirror is a separate migration
// item with its own layout questions, so it is NOT guessed at here. What IS fixed is the failure
// shape: this function used to swallow a failed blob listing (`if (!r.ok) break;`) and return zero
// rows, which renderDiff() then printed as "ADDED (0) / CHANGED (0) / RETIRED (0)" -- a confident
// "nothing changed on this topic" manufactured out of an unreachable storage account. It now throws.
async function readExecFeedRows({ agent, includePersonal }) {
  const acct = (await sm("azure-commons-storage-account")) || "otchealthcommons";
  const key = await sm("azure-commons-storage-key");
  if (!key) throw new Error(`company-brain diff: azure-commons-storage-key is unavailable, so the memory-of-record ledger (azure://${acct}/company-journal) cannot be read. Refusing to render an empty delta that would read as "nothing changed". Note: diff mode still depends on Azure Blob; ask mode does not.`);
  const container = "company-journal";
  const sv = "2021-12-02", sp = "rl", ss = "b", srt = "co";
  const st = new Date(Date.now() - 5 * 60000).toISOString().slice(0, 19) + "Z";
  const se = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 19) + "Z";
  const sts = [acct, sp, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n";
  const sig = crypto.createHmac("sha256", Buffer.from(key, "base64")).update(sts, "utf8").digest("base64");
  const sas = new URLSearchParams({ sv, ss, srt, sp, st, se, spr: "https", sig }).toString();
  const encPath = (name) => name.split("/").map(encodeURIComponent).join("/");
  const list = async (prefix) => {
    const out = []; let m = "";
    do { let u = `https://${acct}.blob.core.windows.net/${container}?restype=container&comp=list&prefix=${encodeURIComponent(prefix)}&${sas}`; if (m) u += `&marker=${encodeURIComponent(m)}`; const r = await fetch(u); if (!r.ok) throw new Error(`company-brain diff: listing azure://${acct}/${container}/${prefix} failed ${r.status}; refusing to report an empty memory delta from an unreadable ledger`); const xml = await r.text(); for (const mm of xml.matchAll(/<Name>([^<]+)<\/Name>/g)) out.push(mm[1]); m = (xml.match(/<NextMarker>([^<]+)<\/NextMarker>/) || [])[1] || ""; } while (m);
    return out;
  };
  const files = (await list("_MEMORY/_exec/")).filter((f) => f.endsWith(".jsonl"));
  const lanes = files.map((f) => f.split("/").pop().replace(/\.jsonl$/, ""));
  const allowedLanes = new Set(selectLanes(lanes, { agent, includePersonal }));
  const rows = [];
  for (const f of files) {
    const lane = f.split("/").pop().replace(/\.jsonl$/, "");
    if (!allowedLanes.has(lane)) continue; // privilege wall: skip a disallowed lane entirely
    const r = await fetch(`https://${acct}.blob.core.windows.net/${container}/${encPath(f)}?${sas}`);
    if (!r.ok) continue;
    for (const line of (await r.text()).split("\n")) {
      const s = line.trim(); if (!s) continue;
      try { const row = { ...JSON.parse(s), agent: lane }; if (ringSafeForDiff(row, agent)) rows.push(row); } catch {}
    }
  }
  return rows;
}

async function diffCmd() {
  const topic = QUERY;
  if (!topic) { console.error('diff "<topic>" --since <date>'); process.exit(2); }
  const since = val("--since", "");
  if (!since || !Number.isFinite(Date.parse(since))) { console.error('diff requires --since <ISO date>'); process.exit(2); }
  const includePersonal = argv.includes("--include-personal");
  await init();

  // 1. resolve the topic to candidate entry ids via the SAME semantic index the shared brain uses
  //    (memory-exec). This narrows a potentially huge ledger to what actually touches the topic.
  const vec = await embed(topic);
  const hits = await searchIndex("memory-exec", vec, topic);
  const candidateKey = new Set(hits.map((h) => `${h.agent}__${h.id || ""}`)); // best-effort; id may be absent from search doc payload
  const candidateText = hits.map((h) => (h.text || "").slice(0, 60).toLowerCase());
  console.error(`  memory-exec: ${hits.length} hit(s) for topic resolution`);

  // 2. walk the RAW exec-feed ledgers (carries {ts, supersedes, was}, which the search index does not)
  //    ring-filtered exactly like selectRooms(); then keep only rows related to the topic: either a
  //    direct semantic hit, or a row that supersedes/is-superseded-by one (so a chain is never cut off
  //    mid-way just because only one side of it matched the search).
  const allRows = await readExecFeedRows({ agent: AGENT, includePersonal });
  const byId = new Map(allRows.map((r) => [r.id, r]));
  const isHit = (r) => candidateText.some((t) => t && (r.text || "").toLowerCase().includes(t.replace(/\.\.\.$/, "")) || (r.text || "").toLowerCase().slice(0, 60) === t);
  const relatedIds = new Set();
  for (const r of allRows) if (isHit(r)) relatedIds.add(r.id);
  // pull in the rest of each related row's supersedes chain (both directions) so CHANGED/RETIRED never
  // gets cut off at the search boundary.
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of allRows) {
      if (relatedIds.has(r.id)) continue;
      const supersedesRelated = r.supersedes && relatedIds.has(r.supersedes);
      const supersededByRelated = allRows.some((x) => x.supersedes === r.id && relatedIds.has(x.id));
      if (supersedesRelated || supersededByRelated) { relatedIds.add(r.id); grew = true; }
    }
  }
  const relatedRows = allRows.filter((r) => relatedIds.has(r.id));
  const delta = diffMemory(relatedRows, since);

  if (FLAG_JSON()) { console.log(JSON.stringify(delta, null, 2)); return; }
  const rendered = renderDiff(topic, delta);
  console.log(rendered);

  if (argv.includes("--summarize") && (delta.added.length || delta.changed.length || delta.retired.length)) {
    const sys = "You are the OTCHealth/InnerScope company brain. You are given a STRUCTURED memory delta (added/changed/retired/still-true facts and decisions for one topic over a time window). Write ONE short paragraph (3-5 sentences) summarizing what changed and why it matters. Use ONLY the given structured delta; do not invent. No em dashes or en dashes.";
    const answer = await chat(sys, `TOPIC: ${topic}\n\nSTRUCTURED DELTA:\n${JSON.stringify(delta, null, 1).slice(0, 12000)}`);
    console.log("\n--- summary ---\n" + answer);
  }
}
function FLAG_JSON() { return argv.includes("--json"); }

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    try {
      if (cmd === "ask") await ask();
      else if (cmd === "diff") await diffCmd();
      else if (cmd === "rooms") {
        console.log(`Company-brain rooms (search=${SEARCH_BACKEND}, embeddings=${EMBEDDINGS_PROVIDER} [${OSR.EMBEDDING_MODEL} @ ${OSR.EMBEDDING_DIMS}], chat=${LLM_PROVIDER}):`);
        for (const [k, v] of Object.entries(ROOMS)) console.log(`  ${k.padEnd(9)} ${v.index.padEnd(30)} ${DOC_ROOMS.has(v.index) ? "chunked" : "flat   "}  ${v.label}`);
        console.log(`  personal  (CLO-only, --include-personal --agent clo) ${PERSONAL.label}`);
      }
      else { console.error('usage: brain.mjs ask "<question>" [--rooms ...] [--n 6] | diff "<topic>" --since <date> [--summarize] | rooms'); process.exit(2); }
    } catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
  })();
}
