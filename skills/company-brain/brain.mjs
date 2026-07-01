#!/usr/bin/env node
// company-brain — ask ONE question, get a cited answer grounded across EVERYTHING the company
// knows: the agent lessons/decisions (memory-exec), the legal data room, the CFO finance room, the
// commerce room, and the company journal. Federates the per-room Azure AI Search indexes (hybrid
// keyword + vector), then synthesizes a cited answer with gpt-4o. The "billion-dollar brain" query.
//
// RING SAFETY: legal-personal (attorney-privileged) is EXCLUDED by default and only included with
// --include-personal AND --agent clo. MedReview/PHI is never indexed here. Non-PHI ring.
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
import { TIERS, modelFamilyOf, chatBody } from "../../setup/model-routing.mjs";
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
  // FALLBACK: gpt-4.1-mini is BANNED for quality/summarization work (see setup/model-routing.mjs). The
  // brain's whole job IS quality synthesis, so the fallback defaults to the shared 'quality' tier
  // (gpt-5.1, reasoning-family) via model-routing.mjs, the single source of truth for tier + body shape.
  const primEp = (await sm("azure-openai-endpoint") || "").replace(/\/$/, ""); const primKey = await sm("azure-openai-key");
  const fbEp = (await sm("azure-foundry-openai-endpoint") || "").replace(/\/$/, ""); const fbKey = await sm("azure-foundry-key");
  if (primEp && primKey) { const dep = process.env.BRAIN_MODEL || TIERS.standard.deployment; CHAT_PROVIDERS.push({ ep: primEp, key: primKey, dep, label: dep, modelFamily: modelFamilyOf(dep) }); }
  if (fbEp && fbKey) { const fbDep = process.env.BRAIN_FALLBACK_MODEL || TIERS.quality.deployment; CHAT_PROVIDERS.push({ ep: fbEp, key: fbKey, dep: fbDep, label: `foundry/${fbDep}`, modelFamily: modelFamilyOf(fbDep) }); }
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
  // Request-body shape (max_completion_tokens vs max_tokens+temperature) is decided ONCE, centrally,
  // in setup/model-routing.mjs so every Foundry caller in the fleet (and the gateway) agrees.
  const body = chatBody(p.dep, { messages: [{ role: "system", content: system }, { role: "user", content: user }], maxTokens: 900 });
  for (let a = 0; a < tries; a++) {
    const r = await fetch(`${p.ep}/openai/deployments/${p.dep}/chat/completions?api-version=2024-06-01`, { method: "POST", headers: { "api-key": p.key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
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

// =============================== DIFF MODE ===============================
// Same ring wall as ask/selectRooms: legal-personal / clo-personal is excluded unless the caller is
// the CLO AND passes --include-personal. Never widen; only restrict.
const isPersonalLane = (agent) => String(agent).toLowerCase() === "clo-personal";
// MNPI/PHI content wall (mirrors kb-memory's ringSafeCross): INND/securities and PHI-adjacent rows
// are internal-only, and only surfaced in a diff to an MNPI-authorized caller (clo/cfo/capital/cto).
// Every OTHER agent never sees them in a diff, even if they otherwise match the topic.
const RING_DENY = /\b(innd|inscope hearing|otcmkts|ticker|reg\s*[da]\b|rule\s*144|form\s*s-?1|8-?k|10-?[qk]|share\s*price|stock\s*price|materially?\s*non.?public|mnpi|reg\s*fd|dividend|patient|\bphi\b|diagnos|medication|prescrib|hipaa|audiogram|hearing\s*number)\b/i;
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
async function readExecFeedRows({ agent, includePersonal }) {
  const acct = (await sm("azure-commons-storage-account")) || "otchealthcommons";
  const key = await sm("azure-commons-storage-key");
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
    do { let u = `https://${acct}.blob.core.windows.net/${container}?restype=container&comp=list&prefix=${encodeURIComponent(prefix)}&${sas}`; if (m) u += `&marker=${encodeURIComponent(m)}`; const r = await fetch(u); if (!r.ok) break; const xml = await r.text(); for (const mm of xml.matchAll(/<Name>([^<]+)<\/Name>/g)) out.push(mm[1]); m = (xml.match(/<NextMarker>([^<]+)<\/NextMarker>/) || [])[1] || ""; } while (m);
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
      else if (cmd === "rooms") { console.log("Company-brain rooms (Azure AI Search indexes):"); for (const [k, v] of Object.entries(ROOMS)) console.log(`  ${k.padEnd(9)} ${v.index.padEnd(28)} ${v.label}`); console.log(`  personal  (CLO-only, --include-personal --agent clo) ${PERSONAL.label}`); }
      else { console.error('usage: brain.mjs ask "<question>" [--rooms ...] [--n 6] | diff "<topic>" --since <date> [--summarize] | rooms'); process.exit(2); }
    } catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
  })();
}
