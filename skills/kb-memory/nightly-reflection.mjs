#!/usr/bin/env node
// nightly-reflection -- Phase-4 B1 of the self-maintaining brain. A NIGHTLY (not per-session) pass
// that reads the last ~24h of Cosmos "episode" memories (kind=episode: the gateway's auto-journal,
// one short marker per successful mutating tool call, written by mcp-server #111) across EVERY
// agent, clusters each agent's episodes by recurring topic, and distills genuinely durable,
// RECURRING patterns into 0-N facts/decisions/pitfalls written back onto that same agent's OWN
// kb-memory ledger (mem.mjs, the Blob store), tagged nightly-reflection.
//
// This complements reflect.mjs (which distills ONE session's transcript at Stop-hook time) with a
// CROSS-SESSION, CROSS-DAY view: a pattern that only shows up when you look at a whole day's worth
// of episodes across many sessions (e.g. "this agent re-authenticates Xero three separate times
// today") would never surface to any single reflect.mjs run, because no one session sees all of it.
//
// Model choice (deliberate, do NOT default to gpt-4.1-mini here): this is QUALITY SYNTHESIS across a
// day of cross-session signal, not reflect.mjs's cheap bounded per-session capture, so it follows
// company-brain's CHAT_PROVIDERS order -- gpt-4o PRIMARY, then the Foundry "quality" tier (gpt-5.1,
// reasoning-family) as fallback. gpt-4.1-mini is BANNED for this class of work (see
// setup/model-routing.mjs and otchealth-cto/CLAUDE.md) and is never used, including as a fallback.
//
// Ring/safety notes:
//   - CORRECTED (was stale): this file used to claim "the Cosmos `memory` container already rejects
//     clo-personal writes at the source", implying clusterEpisodes' PRIVILEGED_AGENTS skip below was
//     defense-in-depth on top of an upstream guarantee. That is FALSE as of the fleet-wide ring
//     suspension (2026-07-07): the gateway's FORBIDDEN_AGENTS set is empty, so memory_write does NOT
//     reject a clo-personal write at the source today. The clusterEpisodes skip below is therefore the
//     ONLY belt on the read side of this file, a single point of failure, not one layer of several. It
//     still skips PRIVILEGED_AGENTS (today just clo-personal, kb-memory's own NO_SHARE set) via the SAME
//     shared set dedupe.mjs exports (not a local hardcoded string, so a future privileged lane is a
//     one-line addition everywhere that imports it), and enforceRingSafeShare() below is a SECOND,
//     independent belt on the --share output path specifically. Do not re-add an "upstream already
//     handles this" assumption anywhere in this file without first verifying FORBIDDEN_AGENTS is
//     actually populated again.
//   - Every distilled item is written back onto the SAME agent's OWN ledger (never cross-lane), so no
//     new ring exposure is introduced versus what already existed in the source episodes, PROVIDED it
//     stays on that ledger. The one path that DOES cross a ring boundary is `--share`: a shared entry
//     publishes to the exec-team feed (kb-memory's publishShared()), readable by the WHOLE exec roster
//     (cfo/clo/cto/capital/commerce/growth/developer/...), most of whom are NOT MNPI-authorized (see
//     company-brain/brain.mjs's MNPI_AUTHORIZED). The distillation PROMPT already asks the model not to
//     mark MNPI/PHI/privileged content share=true, but that is a soft LLM instruction with no code-level
//     backstop. enforceRingSafeShare() is the hard backstop: it force-downgrades share to false (never
//     drops the item -- the fact still lands on the agent's OWN ledger, which is not a ring violation)
//     whenever the distilled text matches the fleet's shared MNPI/PHI content wall (dedupe.mjs's
//     ringSafeCross(), byte-identical to kb-memory/mem.mjs and company-brain/brain.mjs's RING_DENY), or
//     when the agent itself is a privileged lane. Applied to every item BEFORE it is logged or written,
//     so a privileged/MNPI-flagged item can never surface cross-lane regardless of what the model said.
//   - cosmos-memory-read.mjs is READ-ONLY (no create/replace/delete exported at all); this file never
//     mutates the Cosmos memory-of-record. The only durable writes are new rows on the Blob ledger via
//     mem.mjs (never a correction/supersede -- that stays a human/agent judgment call elsewhere).
//   - DRY-RUN BY DEFAULT (mirrors reflect.mjs): only --commit actually calls mem.mjs. Always exits 0
//     (fail-open): a Cosmos outage, a throttled/unavailable model, or a parse failure skips that
//     agent (or the whole run) and logs why, but never crashes the job.
//
// Usage:
//   node nightly-reflection.mjs [--commit] [--hours 24] [--agent <lane>] [--max-items 5]
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tokenize, jaccard, ringSafeCross, PRIVILEGED_AGENTS } from "./dedupe.mjs";
import { kvSecret } from "./azure-secret.mjs";
import * as cosmosMemory from "./cosmos-memory-read.mjs";
import { TIERS, modelFamilyOf, chatBody } from "../../setup/model-routing.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SM = "otchealth-shared-prod";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const COMMIT = argv.includes("--commit");
const HOURS = parseInt(val("--hours", "24"), 10) || 24;
const AGENT_FILTER = (val("--agent", "") || "").toLowerCase();
const MAX_ITEMS = parseInt(val("--max-items", "5"), 10) || 5;

// ============================ PURE CORE (hermetically tested, no I/O) ============================

/** Default within-agent clustering threshold; matches semantic-trust's CLAIM_SIMILARITY_THRESHOLD so
 *  "the same claim worded differently" is recognized the same way everywhere in the toolkit. */
export const DEFAULT_CLUSTER_THRESHOLD = 0.5;

/**
 * Group episode rows { agent, text, ts, id?, tags? } first BY AGENT (a "recurring pattern" is scoped
 * to one agent's own repeated behavior, not a cross-agent notion here -- that is B2's job), then
 * within each agent's episodes, greedily cluster by Jaccard text similarity (reusing dedupe.mjs's
 * tokenize/jaccard, the exact near-duplicate heuristic the rest of kb-memory uses). Clusters are
 * sorted largest-first so recurring topics lead; a cluster with >= 2 episodes is flagged `recurring`.
 * Pure, no I/O.
 * @returns {Array<{agent:string, clusters:Array<{repText:string, count:number, recurring:boolean, items:Array}>}>}
 */
export function clusterEpisodes(episodes, { threshold = DEFAULT_CLUSTER_THRESHOLD } = {}) {
  const byAgent = new Map();
  for (const e of episodes || []) {
    if (!e || !e.agent || !e.text) continue;
    const agent = String(e.agent).toLowerCase();
    if (PRIVILEGED_AGENTS.has(agent)) continue; // defense in depth; Cosmos already rejects this lane at write time
    if (!byAgent.has(agent)) byAgent.set(agent, []);
    byAgent.get(agent).push(e);
  }
  const out = [];
  for (const [agent, list] of byAgent) {
    const clusters = []; // { repTokens, repText, items }
    for (const e of list) {
      const toks = tokenize(e.text);
      let target = null;
      for (const c of clusters) {
        if (jaccard(toks, c.repTokens) >= threshold) { target = c; break; }
      }
      if (!target) { target = { repTokens: toks, repText: e.text, items: [] }; clusters.push(target); }
      target.items.push(e);
    }
    clusters.sort((a, b) => b.items.length - a.items.length);
    out.push({
      agent,
      clusters: clusters.map((c) => ({ repText: c.repText, count: c.items.length, recurring: c.items.length >= 2, items: c.items })),
    });
  }
  return out;
}

/** Build the {system, user} prompt for one agent's nightly distillation pass. Pure. Mirrors
 *  reflect.mjs's prompt shape (0-N items, strict JSON array contract) adapted for a cross-session,
 *  cluster-annotated view instead of a single condensed transcript. */
export function buildDistillPrompt(agent, clusters, knownRecentText = "", { maxItems = MAX_ITEMS } = {}) {
  const lines = (clusters || []).slice(0, 40).map((c, i) => {
    const tag = c.recurring ? `RECURRING x${c.count}` : "single";
    return `${i + 1}. [${tag}] ${String(c.repText || "").replace(/\s+/g, " ").trim().slice(0, 220)}`;
  }).join("\n");
  const system = `You are the NIGHTLY memory-reflection step for agent "${agent}". Below are this agent's episode-memory clusters from roughly the last 24 hours (episodes are short auto-journaled tool-call summaries, not prose). Extract ONLY genuinely DURABLE, REUSABLE lessons that are NOT already in the agent's recent memory. Prefer clusters marked RECURRING (the same pattern showed up more than once today): a pitfall (a wrong belief or trap plus the fix), a decision (a standing choice plus why), or a fact (a stable identifier, config, or value). A single unrepeated episode is usually NOT durable on its own; skip it unless it is clearly a standing fact worth keeping. Be strict: 0 to ${maxItems} items, each one sentence, specific and self-contained. If nothing new and durable, return []. Mark share=true ONLY if it is non-sensitive and useful cross-team (no MNPI, no PHI, no privileged content). Return ONLY a JSON array: [{"type":"pitfall|decision|remember","text":"..","share":bool}].`;
  const user = `AGENT RECENT MEMORY (do NOT duplicate these):\n${knownRecentText}\n\n===== EPISODE CLUSTERS (last ~24h, ${(clusters || []).length} cluster(s)) =====\n${lines}`;
  return { system, user };
}

/** Safely parse + validate the model's JSON-array response. Pure. Never throws. */
export function parseDistillItems(raw, { maxItems = MAX_ITEMS } = {}) {
  try {
    const m = String(raw || "").match(/\[[\s\S]*\]/);
    if (!m) return [];
    const items = JSON.parse(m[0]);
    if (!Array.isArray(items)) return [];
    return items
      .filter((x) => x && typeof x.text === "string" && x.text.trim() && /^(pitfall|decision|remember)$/.test(x.type))
      .slice(0, maxItems);
  } catch {
    return [];
  }
}

/**
 * Distill one agent's clusters into 0-N candidate items. `ask(system, user) -> Promise<string>` is
 * INJECTED so this is fully testable without any real LLM call. Fail-open: if `ask` throws (model
 * unavailable / throttled), this agent's distillation is skipped for this run (logged, not fatal) and
 * an empty array is returned -- never crashes the caller.
 */
export async function distillAgent(agent, clusters, { ask, knownRecentText = "", maxItems = MAX_ITEMS } = {}) {
  if (!clusters || !clusters.length) return [];
  if (typeof ask !== "function") throw new Error("distillAgent: an ask(system, user) function is required");
  const { system, user } = buildDistillPrompt(agent, clusters, knownRecentText, { maxItems });
  let raw;
  try {
    raw = await ask(system, user);
  } catch (e) {
    console.error(`[nightly-reflection] ${agent}: LLM unavailable (${e.message}); skipping this agent this run (fail-open).`);
    return [];
  }
  return parseDistillItems(raw, { maxItems });
}

/**
 * RING/PRIVILEGE WALL for the --share output path (hard gate, not advisory). The distillation prompt
 * (buildDistillPrompt) already ASKS the model to mark share=true "ONLY if it is non-sensitive ... no
 * MNPI, no PHI, no privileged content", but that is a soft LLM instruction with no code-level backstop:
 * a model that gets it wrong would publish MNPI/PHI/privileged text straight into the shared exec-team
 * feed (kb-memory's publishShared()), which the WHOLE exec roster reads via tail/recall/team, most of
 * whom are NOT MNPI-authorized (company-brain/brain.mjs's MNPI_AUTHORIZED is only clo/cfo/capital/cto).
 *
 * This function is the hard backstop, applied to EVERY item before it is logged or written: it
 * force-downgrades share to false whenever (a) the agent itself is a privileged lane (PRIVILEGED_AGENTS
 * -- defense in depth; clusterEpisodes already drops these agents' episodes upstream, so this fires
 * only if a future caller reaches distillAgent some other way), or (b) the distilled TEXT matches the
 * fleet's shared MNPI/PHI content wall (dedupe.mjs's ringSafeCross(), byte-identical to kb-memory/
 * mem.mjs and company-brain/brain.mjs's RING_DENY). It NEVER drops the item itself and never widens
 * (only ever flips share true -> false): the underlying fact still gets written to the agent's OWN
 * private ledger when --commit is set, which is not a ring violation, it just never leaves that lane.
 * Pure aside from an stderr note on downgrade (mirrors resolveModelOverride's own pattern below).
 */
export function enforceRingSafeShare(agent, items, log = (m) => console.error(m)) {
  return (items || []).map((it) => {
    if (!it || !it.share) return it;
    if (ringSafeCross({ agent, text: it.text })) return it;
    log(`[nightly-reflection] ${agent}: downgrading share=true -> false on a privileged/MNPI/PHI-flagged item (kept on ${agent}'s own private ledger only, never published to the shared exec-team feed): "${String(it.text || "").slice(0, 100)}"`);
    return { ...it, share: false };
  });
}

// Ban guard for the two model env-overrides. gpt-4.1-mini is BANNED for quality synthesis work
// (setup/model-routing.mjs, otchealth-cto/CLAUDE.md); if an operator points either override at it
// (or any deployment in the banned set), IGNORE the override, log loudly, and use the safe default,
// so the nightly distiller can never be silently misconfigured onto the banned model. Pure; exported
// for tests.
export const BANNED_MODELS = new Set(["gpt-4.1-mini", TIERS.cheap.deployment]);
export function resolveModelOverride(envVal, defaultDep, label = "model") {
  const v = (envVal || "").trim();
  if (!v) return defaultDep;
  if (BANNED_MODELS.has(v)) {
    console.error(`[nightly-reflection] ${label}="${v}" is a BANNED model for quality synthesis (see setup/model-routing.mjs); ignoring the override and using ${defaultDep} instead.`);
    return defaultDep;
  }
  return v;
}

// ================================== Impure: Cosmos + LLM I/O ==================================

function saJwt(scope) {
  const raw = process.env.GCP_CLAUDE_DRIVER_SA_JSON;
  if (!raw) return null;
  let sa;
  try { sa = JSON.parse(raw); } catch { return null; }
  if (!sa || !sa.private_key) return null;
  const now = Math.floor(Date.now() / 1000);
  const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url");
}
async function sm(id) {
  const kv = await kvSecret(id);
  if (kv != null) return kv;
  const jwt = saJwt("https://www.googleapis.com/auth/cloud-platform");
  if (!jwt) return null;
  try {
    const r0 = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(jwt)}` });
    const t = (await r0.json()).access_token;
    if (!t) return null;
    const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } });
    if (!r.ok) return null;
    return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
  } catch {
    return null;
  }
}

let CHAT_PROVIDERS = [];
async function initModel() {
  CHAT_PROVIDERS = [];
  const primEp = (await sm("azure-openai-endpoint") || "").replace(/\/$/, "");
  const primKey = await sm("azure-openai-key");
  const fbEp = (await sm("azure-foundry-openai-endpoint") || "").replace(/\/$/, "");
  const fbKey = await sm("azure-foundry-key");
  // Primary: gpt-4o (TIERS.standard). Fallback: TIERS.quality (gpt-5.1, reasoning-family), the SAME
  // ban-compliant fallback company-brain uses -- never gpt-4.1-mini for this class of synthesis work.
  // The env overrides are ban-guarded (resolveModelOverride) so an operator cannot point the distiller
  // at gpt-4.1-mini via NIGHTLY_REFLECTION_MODEL / NIGHTLY_REFLECTION_FALLBACK_MODEL.
  if (primEp && primKey) {
    const dep = resolveModelOverride(process.env.NIGHTLY_REFLECTION_MODEL, TIERS.standard.deployment, "NIGHTLY_REFLECTION_MODEL");
    CHAT_PROVIDERS.push({ ep: primEp, key: primKey, dep, label: dep, modelFamily: modelFamilyOf(dep) });
  }
  if (fbEp && fbKey) {
    const fbDep = resolveModelOverride(process.env.NIGHTLY_REFLECTION_FALLBACK_MODEL, TIERS.quality.deployment, "NIGHTLY_REFLECTION_FALLBACK_MODEL");
    CHAT_PROVIDERS.push({ ep: fbEp, key: fbKey, dep: fbDep, label: `foundry/${fbDep}`, modelFamily: modelFamilyOf(fbDep) });
  }
}
async function callChat(p, system, user, tries) {
  const body = chatBody(p.dep, { messages: [{ role: "system", content: system }, { role: "user", content: user }], maxTokens: 700 });
  for (let a = 0; a < tries; a++) {
    const r = await fetch(`${p.ep}/openai/deployments/${p.dep}/chat/completions?api-version=2024-06-01`, { method: "POST", headers: { "api-key": p.key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 429) {
      const ra = +(r.headers.get("retry-after") || 0);
      await new Promise((s) => setTimeout(s, ra ? ra * 1000 : 1500 * (a + 1)));
      continue;
    }
    if (!r.ok) throw new Error("chat " + r.status);
    return (await r.json()).choices[0].message.content;
  }
  throw Object.assign(new Error("429"), { throttled: true });
}
async function ask(system, user) {
  let lastErr;
  for (let i = 0; i < CHAT_PROVIDERS.length; i++) {
    const p = CHAT_PROVIDERS[i];
    try {
      const out = await callChat(p, system, user, i === 0 ? 4 : 6);
      if (i > 0) console.error(`  (nightly-reflection synthesized via fallback ${p.label})`);
      return out;
    } catch (e) {
      lastErr = e;
      if (e.throttled && i < CHAT_PROVIDERS.length - 1) { console.error(`  (${p.label} throttled; falling back to ${CHAT_PROVIDERS[i + 1].label})`); continue; }
      if (e.throttled) continue;
      throw e;
    }
  }
  throw lastErr || new Error("no chat providers configured");
}

async function fetchEpisodes(hours) {
  if (!(await cosmosMemory.isConfigured())) {
    console.error("[nightly-reflection] Cosmos agent-state not configured in this environment; nothing to read.");
    return [];
  }
  const cutoff = Math.floor(Date.now() / 1000 - hours * 3600);
  const rows = await cosmosMemory.queryMemory(
    "SELECT * FROM c WHERE c.kind = @kind AND c._ts >= @cutoff",
    [{ name: "@kind", value: "episode" }, { name: "@cutoff", value: cutoff }],
  );
  return rows
    .map((r) => ({
      id: r.id,
      agent: String(r.agent || "").toLowerCase(),
      text: r.text || "",
      tags: r.tags || [],
      ts: r.ts || (r._ts ? new Date(r._ts * 1000).toISOString() : null),
    }))
    .filter((e) => e.agent && e.text);
}

function recentMemory(agent) {
  try {
    return execFileSync("node", [join(HERE, "mem.mjs"), "tail", "--agent", agent, "--n", "30"], { encoding: "utf8" }).slice(0, 6000);
  } catch {
    return "";
  }
}

async function main() {
  console.log(`[nightly-reflection] starting -- mode=${COMMIT ? "COMMIT" : "DRY-RUN"} hours=${HOURS}${AGENT_FILTER ? ` agent=${AGENT_FILTER}` : ""} max-items=${MAX_ITEMS}`);
  let episodes;
  try {
    episodes = await fetchEpisodes(HOURS);
  } catch (e) {
    console.error(`[nightly-reflection] could not read Cosmos episode memories (${e.message}); nothing to distill this run.`);
    return;
  }
  if (AGENT_FILTER) episodes = episodes.filter((e) => e.agent === AGENT_FILTER);
  if (!episodes.length) {
    console.log("[nightly-reflection] no episode memories in the window; nothing to distill.");
    return;
  }
  console.log(`[nightly-reflection] ${episodes.length} episode(s) across ${new Set(episodes.map((e) => e.agent)).size} agent(s) in the last ${HOURS}h`);

  await initModel();
  if (!CHAT_PROVIDERS.length) {
    console.error("[nightly-reflection] no Azure OpenAI/Foundry chat credentials available; skipping distillation this run (fail-open).");
    return;
  }

  const byAgent = clusterEpisodes(episodes);
  let totalCandidates = 0, totalWritten = 0;
  for (const { agent, clusters } of byAgent) {
    const knownRecentText = recentMemory(agent);
    const rawItems = await distillAgent(agent, clusters, { ask, knownRecentText, maxItems: MAX_ITEMS });
    // RING/PRIVILEGE WALL: hard-downgrade share=true on any privileged/MNPI/PHI-flagged item BEFORE it
    // is logged or written (see enforceRingSafeShare's doc comment). Never trust the model's own say-so.
    const items = enforceRingSafeShare(agent, rawItems);
    if (!items.length) {
      console.log(`[nightly-reflection] ${agent}: no new durable lessons from ${clusters.length} cluster(s).`);
      continue;
    }
    totalCandidates += items.length;
    console.log(`[nightly-reflection] ${agent}: ${items.length} candidate lesson(s) from ${clusters.length} cluster(s)${COMMIT ? " (committing)" : " (dry-run; pass --commit to write)"}:`);
    for (const it of items) {
      console.log(`  [${it.type}${it.share ? ",share" : ""}] ${it.text}`);
      if (COMMIT) {
        try {
          const a = [join(HERE, "mem.mjs"), it.type, it.text, "--agent", agent, "--tags", "nightly-reflection"];
          if (it.share) a.push("--share");
          execFileSync("node", a, { stdio: "ignore" });
          totalWritten++;
        } catch (e) {
          console.error(`  write failed for ${agent}: ${e.message}`);
        }
      }
    }
  }
  console.log(`[nightly-reflection] done. ${totalCandidates} candidate(s) total, ${COMMIT ? totalWritten + " written" : "0 written (dry-run; pass --commit to write)"}.`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((e) => { console.error("[nightly-reflection] ERROR (fail-open, exiting 0): " + e.message); process.exit(0); });
}
