#!/usr/bin/env node
// company-brain — ask ONE question, get a cited answer grounded across EVERYTHING the company
// knows: the agent lessons/decisions (memory-exec), the legal data room, the CFO finance room, the
// commerce room, and the company journal. Federates the per-room Azure AI Search indexes (hybrid
// keyword + vector), then synthesizes a cited answer with gpt-4o. The "billion-dollar brain" query.
//
// RING SAFETY: legal-personal (attorney-privileged) is EXCLUDED by default and only included with
// --include-personal AND --agent clo. MedReview/PHI is never indexed here. Non-PHI ring.
//
// Usage:
//   node brain.mjs ask "<question>" [--rooms memory,legal,finance,commerce,journal] [--n 6] [--agent clo --include-personal]
//   node brain.mjs rooms                      # list the indexes it can search
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
const SM = "otchealth-shared-prod";
const AIS_API = "2023-11-01";
const argv = process.argv.slice(2);
const cmd = argv[0];
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const QUERY = argv.slice(1).filter((a, i, arr) => !a.startsWith("--") && !(i > 0 && arr[i - 1].startsWith("--"))).join(" ").trim();
const PERK = parseInt(val("--n", "6"), 10) || 6;
const AGENT = (val("--agent", "") || "").toLowerCase();
// The --include-personal privilege gate is enforced in selectRooms() (single source of truth).

// room -> AI Search index. (Indexes built by doc-indexer per profile/container + kb-memory semantic.)
const ROOMS = {
  memory:   { index: "memory-exec",                 label: "agent lessons + decisions (shared brain)" },
  legal:    { index: "legal-company",               label: "company legal: contracts, litigation, securities" },
  finance:  { index: "finance-cfo-source-docs",     label: "CFO finance data room" },
  commerce: { index: "commerce-commerce-source-docs",label: "commerce / store data room" },
  journal:  { index: "commons-company-journal",     label: "daily company journal + digests" },
};
const PERSONAL = { index: "legal-personal", label: "PRIVILEGED personal legal (CLO only)" };

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

function saJwt(scope) { const sa = JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON); const now = Math.floor(Date.now() / 1000); const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"); const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`; return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url"); }
async function sm(id) { const r0 = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt("https://www.googleapis.com/auth/cloud-platform"))}` }); const t = (await r0.json()).access_token; const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } }); if (!r.ok) return null; return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim(); }
let AIS_EP, AIS_KEY, AOAI_EP, AOAI_KEY, AOAI_DEP, CHAT_PROVIDERS = [];
async function init() {
  AIS_EP = (await sm("azure-search-endpoint") || "").replace(/\/$/, ""); AIS_KEY = await sm("azure-search-admin-key");
  AOAI_EP = ((await sm("azure-foundry-openai-endpoint")) || (await sm("azure-openai-endpoint")) || "").replace(/\/$/, ""); AOAI_KEY = (await sm("azure-foundry-key")) || (await sm("azure-openai-key")); AOAI_DEP = (await sm("azure-openai-embedding-deployment")) || "text-embedding-3-large";
  // Chat synthesis routes through a PRIMARY then a FALLBACK deployment so a transient throttle on
  // one Azure OpenAI deployment never silences the brain (down-payment on model-routing, initiative #5).
  const primEp = (await sm("azure-openai-endpoint") || "").replace(/\/$/, ""); const primKey = await sm("azure-openai-key");
  const fbEp = (await sm("azure-foundry-openai-endpoint") || "").replace(/\/$/, ""); const fbKey = await sm("azure-foundry-key");
  if (primEp && primKey) CHAT_PROVIDERS.push({ ep: primEp, key: primKey, dep: process.env.BRAIN_MODEL || "gpt-4o", label: "gpt-4o" });
  if (fbEp && fbKey) CHAT_PROVIDERS.push({ ep: fbEp, key: fbKey, dep: process.env.BRAIN_FALLBACK_MODEL || "gpt-4.1-mini", label: "foundry/gpt-4.1-mini" });
  if (!AIS_EP || !AIS_KEY) throw new Error("missing azure-search creds");
  if (!CHAT_PROVIDERS.length) throw new Error("no chat provider creds");
}
async function embed(text) { for (let a = 0; a < 6; a++) { const r = await fetch(`${AOAI_EP}/openai/deployments/${AOAI_DEP}/embeddings?api-version=2024-02-01`, { method: "POST", headers: { "api-key": AOAI_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ input: [text] }) }); if (r.status === 429) { const ra = +(r.headers.get("retry-after") || 0); await new Promise(s => setTimeout(s, (ra ? ra * 1000 : 1500 * (a + 1)))); continue; } if (!r.ok) throw new Error("embed " + r.status); return (await r.json()).data[0].embedding; } throw new Error("embed 429 exhausted"); }
async function searchIndex(index, vec, query) {
  // vector_semantic_hybrid: BM25 keyword + vector fused by RRF, then the L2 SEMANTIC RERANKER
  // (every room index carries the "sem" semantic config). This is the Microsoft-benchmarked default
  // that fixes weak keyword-only recall. Falls back to plain hybrid if semantic errors (missing
  // config / quota exhausted) so recall NEVER regresses below what we had.
  const base = { search: query, top: PERK, vectorQueries: [{ kind: "vector", vector: vec, fields: "contentVector", k: PERK }] };
  const url = `${AIS_EP}/indexes/${index}/docs/search?api-version=${AIS_API}`;
  const hdr = { "api-key": AIS_KEY, "Content-Type": "application/json" };
  let r = await fetch(url, { method: "POST", headers: hdr, body: JSON.stringify({ ...base, queryType: "semantic", semanticConfiguration: "sem" }) });
  if (!r.ok) r = await fetch(url, { method: "POST", headers: hdr, body: JSON.stringify(base) });
  if (!r.ok) return [];
  // With the semantic reranker present, @search.rerankerScore (0-4) is the authoritative relevance;
  // fall back to @search.score when a room had to use plain hybrid.
  return ((await r.json()).value || []).map(h => ({ score: h["@search.rerankerScore"] ?? h["@search.score"] ?? 0, text: (h.content || h.text || "").slice(0, 1200), path: h.path || h.title || "", entity: h.entity || "", agent: h.agent || "", type: h.type || "" }));
}
async function callChat(p, system, user, tries) {
  for (let a = 0; a < tries; a++) {
    const r = await fetch(`${p.ep}/openai/deployments/${p.dep}/chat/completions?api-version=2024-06-01`, { method: "POST", headers: { "api-key": p.key, "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 900, temperature: 0.2 }) });
    if (r.status === 429) { const ra = +(r.headers.get("retry-after") || 0); await new Promise(s => setTimeout(s, ra ? ra * 1000 : 2000 * (a + 1))); continue; }
    if (!r.ok) throw new Error("chat " + r.status);
    return (await r.json()).choices[0].message.content;
  }
  throw Object.assign(new Error("429"), { throttled: true });
}
async function chat(system, user) {
  // Try each provider in order (primary gpt-4o, then foundry fallback). A throttle on one falls
  // through to the next instead of failing the query. Fewer retries on the primary so we reach the
  // fallback faster when it is sustained-busy.
  let lastErr;
  for (let i = 0; i < CHAT_PROVIDERS.length; i++) {
    const p = CHAT_PROVIDERS[i];
    try { const out = await callChat(p, system, user, i === 0 ? 4 : 6); if (i > 0) console.error(`  (brain synthesized via fallback ${p.label})`); return out; }
    catch (e) { lastErr = e; if (e.throttled && i < CHAT_PROVIDERS.length - 1) { console.error(`  (${p.label} throttled; falling back to ${CHAT_PROVIDERS[i + 1].label})`); continue; } if (e.throttled) continue; throw e; }
  }
  throw new Error("all chat providers throttled (Azure OpenAI busy; retry shortly)");
}

async function ask() {
  if (!QUERY) { console.error('ask "<question>"'); process.exit(2); }
  const targets = selectRooms({ rooms: val("--rooms", ""), agent: AGENT, includePersonal: argv.includes("--include-personal") });
  await init();
  const vec = await embed(QUERY);
  const all = [];
  for (const t of targets) { const hits = await searchIndex(t.index, vec, QUERY); for (const h of hits) all.push({ ...h, room: t.room }); console.error(`  ${t.room}: ${hits.length} hit(s)`); }
  all.sort((a, b) => b.score - a.score);
  const top = all.slice(0, 14);
  if (!top.length) { console.log("No grounded results across the company brain for that question."); process.exit(0); }
  const sources = top.map((h, i) => `[${i + 1}] room=${h.room}${h.agent ? ` agent=${h.agent}` : ""}${h.entity ? ` entity=${h.entity}` : ""} ${h.path ? `(${h.path})` : ""}\n${h.text}`).join("\n\n");
  const sys = "You are the OTCHealth/InnerScope company brain. Answer the question using ONLY the provided sources from the company's own data rooms and agent memory. Cite each fact with its [n]. If the sources do not answer it, say so. Be concrete and decision-useful. Do not invent.";
  const answer = await chat(sys, `QUESTION: ${QUERY}\n\nSOURCES:\n${sources}`);
  console.log(`\n================ COMPANY BRAIN ================\nQ: ${QUERY}\n`);
  console.log(answer);
  console.log(`\n--- grounded in ${top.length} sources across ${[...new Set(top.map(h => h.room))].join(", ")} ---`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    try {
      if (cmd === "ask") await ask();
      else if (cmd === "rooms") { console.log("Company-brain rooms (Azure AI Search indexes):"); for (const [k, v] of Object.entries(ROOMS)) console.log(`  ${k.padEnd(9)} ${v.index.padEnd(28)} ${v.label}`); console.log(`  personal  (CLO-only, --include-personal --agent clo) ${PERSONAL.label}`); }
      else { console.error('usage: brain.mjs ask "<question>" [--rooms ...] [--n 6] | rooms'); process.exit(2); }
    } catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
  })();
}
