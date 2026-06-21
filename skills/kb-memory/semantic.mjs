#!/usr/bin/env node
// kb-memory SEMANTIC layer: vector recall over the shared exec feed. Complements mem.mjs's
// keyword recall so agents find memories by MEANING (e.g. "how do we reconnect accounting"
// surfaces the Xero re-consent pitfalls even without the word "Xero"). Dependency-free; self-
// resolves creds from Secret Manager via the claude-driver SA. Reuses the fleet's Azure AI Search
// + Azure OpenAI embeddings (text-embedding-3-large), the exact infra the data-room librarians use.
//
// Ring safety: indexes ONLY the shared exec feed (otchealthcommons/company-journal/_MEMORY/_exec/*),
// which already contains only what agents chose to `status`/`--share`. It NEVER touches a private
// lane or the clo-personal lane. Index lives in the same AI Search service as the data rooms.
//
// Verbs:
//   node semantic.mjs reindex                 # (re)build the memory-exec index from the exec feed (resumable: skips already-indexed)
//   node semantic.mjs recall "<query>" [--n 12] [--agent cto] [--type pitfall]
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
const SM = "otchealth-shared-prod";
const IDX = "memory-exec";
const AIS_API = "2023-11-01";
const EMB_DIMS = 3072;

const argv = process.argv.slice(2);
const cmd = argv[0];
const takeVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const QUERY = argv.slice(1).filter((a, i, arr) => !a.startsWith("--") && !(i > 0 && arr[i - 1].startsWith("--"))).join(" ").trim();
const N = parseInt(takeVal("--n", "12"), 10) || 12;
const AGENT_FILTER = (takeVal("--agent", "") || "").toLowerCase();
const TYPE_FILTER = (takeVal("--type", "") || "").toLowerCase();

function saJwt(scope) {
  const sa = JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url");
}
async function sm(id) {
  const r0 = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt("https://www.googleapis.com/auth/cloud-platform"))}` });
  const t = (await r0.json()).access_token;
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } });
  if (!r.ok) return null;
  return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
}
const encPath = (name) => name.split("/").map(encodeURIComponent).join("/");
function buildSas(acct, key) {
  const sv = "2021-12-02", sp = "rl", ss = "b", srt = "co";
  const st = new Date(Date.now() - 5 * 60000).toISOString().slice(0, 19) + "Z";
  const se = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 19) + "Z";
  const sts = [acct, sp, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n";
  const sig = crypto.createHmac("sha256", Buffer.from(key, "base64")).update(sts, "utf8").digest("base64");
  return new URLSearchParams({ sv, ss, srt, sp, st, se, spr: "https", sig }).toString();
}

let AIS_EP, AIS_KEY, AOAI_EP, AOAI_KEY, AOAI_DEP;
async function init() {
  AIS_EP = (await sm("azure-search-endpoint") || "").replace(/\/$/, "");
  AIS_KEY = await sm("azure-search-admin-key");
  AOAI_EP = ((await sm("azure-foundry-openai-endpoint")) || (await sm("azure-openai-endpoint")) || "").replace(/\/$/, "");
  AOAI_KEY = (await sm("azure-foundry-key")) || (await sm("azure-openai-key"));
  AOAI_DEP = (await sm("azure-openai-embedding-deployment")) || "text-embedding-3-large";
  if (!AIS_EP || !AIS_KEY) throw new Error("missing azure-search-endpoint/admin-key");
  if (!AOAI_EP || !AOAI_KEY) throw new Error("missing azure-openai endpoint/key");
}
async function embed(texts) {
  for (let a = 0; a < 6; a++) {
    const r = await fetch(`${AOAI_EP}/openai/deployments/${AOAI_DEP}/embeddings?api-version=2024-02-01`, { method: "POST", headers: { "api-key": AOAI_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ input: texts }) });
    if (r.status === 429) { await new Promise(s => setTimeout(s, 1500 * (a + 1))); continue; }
    if (!r.ok) throw new Error("embed " + r.status + " " + (await r.text()).slice(0, 120));
    return (await r.json()).data.map(d => d.embedding);
  }
  throw new Error("embed 429 exhausted");
}
async function ensureIndex() {
  const schema = {
    name: IDX,
    fields: [
      { name: "id", type: "Edm.String", key: true },
      { name: "agent", type: "Edm.String", filterable: true, facetable: true, searchable: true },
      { name: "type", type: "Edm.String", filterable: true, facetable: true },
      { name: "ts", type: "Edm.String", filterable: true, sortable: true },
      { name: "tags", type: "Edm.String", searchable: true },
      { name: "text", type: "Edm.String", searchable: true },
      { name: "contentVector", type: "Collection(Edm.Single)", searchable: true, retrievable: false, dimensions: EMB_DIMS, vectorSearchProfile: "vp" },
    ],
    vectorSearch: { algorithms: [{ name: "hnsw", kind: "hnsw" }], profiles: [{ name: "vp", algorithm: "hnsw" }] },
    semantic: { configurations: [{ name: "sem", prioritizedFields: { prioritizedContentFields: [{ fieldName: "text" }], prioritizedKeywordsFields: [{ fieldName: "tags" }] } }] },
  };
  const r = await fetch(`${AIS_EP}/indexes/${IDX}?api-version=${AIS_API}`, { method: "PUT", headers: { "api-key": AIS_KEY, "Content-Type": "application/json" }, body: JSON.stringify(schema) });
  if (!r.ok) throw new Error("create index " + r.status + " " + (await r.text()).slice(0, 220));
}
async function existingIds() {
  const ids = new Set();
  for (let skip = 0; skip < 100000; skip += 1000) {
    const r = await fetch(`${AIS_EP}/indexes/${IDX}/docs?api-version=${AIS_API}&$select=id&$top=1000&$skip=${skip}`, { headers: { "api-key": AIS_KEY } });
    if (!r.ok) break;
    const v = (await r.json()).value || []; for (const d of v) ids.add(d.id); if (v.length < 1000) break;
  }
  return ids;
}
async function aisPush(batch) {
  const r = await fetch(`${AIS_EP}/indexes/${IDX}/docs/index?api-version=${AIS_API}`, { method: "POST", headers: { "api-key": AIS_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ value: batch }) });
  if (!r.ok) throw new Error("push " + r.status + " " + (await r.text()).slice(0, 200));
}

// read every shared exec-feed file
async function readExecFeed() {
  const acct = (await sm("azure-commons-storage-account")) || "otchealthcommons";
  const key = await sm("azure-commons-storage-key");
  const container = "company-journal";
  const sas = buildSas(acct, key);
  const list = async (prefix) => { const out = []; let m = ""; do { let u = `https://${acct}.blob.core.windows.net/${container}?restype=container&comp=list&prefix=${encodeURIComponent(prefix)}&${sas}`; if (m) u += `&marker=${encodeURIComponent(m)}`; const r = await fetch(u); if (!r.ok) break; const xml = await r.text(); for (const mm of xml.matchAll(/<Name>([^<]+)<\/Name>/g)) out.push(mm[1]); m = (xml.match(/<NextMarker>([^<]+)<\/NextMarker>/) || [])[1] || ""; } while (m); return out; };
  const files = (await list("_MEMORY/_exec/")).filter(f => f.endsWith(".jsonl"));
  const entries = [];
  for (const f of files) {
    const agent = f.split("/").pop().replace(/\.jsonl$/, "");
    const r = await fetch(`https://${acct}.blob.core.windows.net/${container}/${encPath(f)}?${sas}`);
    if (!r.ok) continue;
    for (const line of (await r.text()).split("\n")) { const s = line.trim(); if (!s) continue; try { const e = JSON.parse(s); e._agent = agent; entries.push(e); } catch {} }
  }
  return entries;
}
// Azure AI Search doc keys allow only [A-Za-z0-9_\-=]; this joins agent + entry id with `__` and
// sanitizes the rest so reindex is idempotent (same entry -> same key -> mergeOrUpload, never a dup).
// Exported for tests/semantic-docid.test.mjs (stability + key-charset safety). Pure.
export const docId = (agent, id) => `${agent}__${id}`.replace(/[^A-Za-z0-9_\-=]/g, "_");

async function reindex() {
  await init(); await ensureIndex();
  const entries = await readExecFeed();
  const have = await existingIds();
  const todo = entries.filter(e => e.id && !have.has(docId(e._agent, e.id)));
  console.error(`[memory-semantic] ${entries.length} exec entries; ${have.size} already indexed; ${todo.length} to embed`);
  let n = 0, buf = [];
  for (const e of todo) {
    const text = `[${e.type}] ${e.text || ""} ${(e.tags || []).join(" ")}`.slice(0, 8000);
    let vec; try { vec = (await embed([text]))[0]; } catch (err) { console.error("  embed fail " + e.id + ": " + err.message); continue; }
    buf.push({ "@search.action": "mergeOrUpload", id: docId(e._agent, e.id), agent: e._agent, type: e.type || "", ts: e.ts || "", tags: (e.tags || []).join(", "), text: (e.text || "").slice(0, 16000), contentVector: vec });
    if (buf.length >= 64) { await aisPush(buf); n += buf.length; buf = []; console.error(`  indexed ${n}/${todo.length}`); }
  }
  if (buf.length) { await aisPush(buf); n += buf.length; }
  console.log(`memory-semantic: indexed ${n} new entries into ${IDX} (${have.size + n} total).`);
}

async function recall() {
  if (!QUERY) { console.error('need a query: semantic.mjs recall "<query>" [--n 12] [--agent x] [--type pitfall]'); process.exit(2); }
  await init();
  const vec = (await embed([QUERY]))[0];
  const filters = [];
  if (AGENT_FILTER) filters.push(`agent eq '${AGENT_FILTER.replace(/'/g, "''")}'`);
  if (TYPE_FILTER) filters.push(`type eq '${TYPE_FILTER.replace(/'/g, "''")}'`);
  const body = { search: QUERY, top: N, select: "agent,type,ts,text,tags", vectorQueries: [{ kind: "vector", vector: vec, fields: "contentVector", k: N }] };
  if (filters.length) body.filter = filters.join(" and ");
  const r = await fetch(`${AIS_EP}/indexes/${IDX}/docs/search?api-version=${AIS_API}`, { method: "POST", headers: { "api-key": AIS_KEY, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) { console.error("search " + r.status + " " + (await r.text()).slice(0, 200)); process.exit(1); }
  const hits = (await r.json()).value || [];
  console.log(`# semantic recall "${QUERY}"${AGENT_FILTER ? ` @${AGENT_FILTER}` : ""} - ${hits.length} hit(s)\n`);
  for (const h of hits) console.log(`[${h.agent}] [${h.type}] ${(h.ts || "").slice(0, 10)} (score ${(h["@search.score"] || 0).toFixed(3)})\n  ${(h.text || "").slice(0, 320)}${h.tags ? `\n  tags: ${h.tags}` : ""}\n`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    try {
      if (cmd === "reindex") await reindex();
      else if (cmd === "recall") await recall();
      else { console.error('usage: semantic.mjs reindex | recall "<query>" [--n 12] [--agent x] [--type pitfall]'); process.exit(2); }
    } catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
  })();
}
