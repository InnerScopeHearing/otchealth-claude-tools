#!/usr/bin/env node
// ring-memory-index — keep each RING-ISOLATED agent memory ledger semantically recallable.
//
// WHY: the shared exec brain (_MEMORY/_exec/*) is indexed into Azure AI Search `memory-exec`, so every
// agent recalls SHARED memory by meaning. But every agent also keeps its real work in a PRIVATE ledger,
// which the shared reindex never touches:
//   - CLO (legal ring):    otchealthlegalstore / personal        / _MEMORY/clo-personal.jsonl -> legal-personal-memory
//   - CFO (finance ring):  otchealthcfodata    / cfo-source-docs / _MEMORY/cfo.jsonl           -> finance-cfo-memory
//   - COO/CCO/CRO/CPO/developer (non-privileged, commons store): otchealthcommons / company-journal /
//     _MEMORY/<agent>.jsonl -> commons-<agent>-memory (one index per agent, even though they share a store)
// Those ledgers were only FLAT-readable (slow keyword scan over a large growing jsonl). This embeds each
// agent's ledger into its own AI Search index (BM25 + text-embedding-3-large vector + semantic ranker), so
// the agent recalls its OWN decisions/status/facts by meaning, fast — the same upgrade memory-exec gave
// the shared brain, applied per agent. The DOCUMENT corpora (legal-personal, finance-cfo-source-docs) are
// indexed separately by doc-indexer; this is specifically the agent's memory ledger.
//
// RING SAFETY: each row is embedded ONLY into its own index — never crosses into another agent's index,
// even when two rows share a store (the commons agents share otchealthcommons/company-journal, but each
// still gets its own commons-<agent>-memory index). Content is never printed. Creds self-resolve per row
// from Secret Manager via the claude-driver SA. Idempotent (mergeOrUpload by stable id) and fail-safe PER
// ROW — one row's failure never blocks the others. Safe to run on a schedule.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const SM = "otchealth-shared-prod";
const API = "2023-11-01";
const DIMS = 3072;
const EMBED_BATCH = 16;
const PUSH_BATCH = 48;

// The ring registry. Add a row to onboard a new ring-isolated agent memory ledger. `storeAcctSecret`/
// `storeKeySecret` name the ring store's SM secrets; `container`+`ledger` locate the jsonl; `index` is
// the per-ring target AI Search index (created here if absent).
export const RINGS = [
  {
    label: "clo-personal",
    storeAcctSecret: "azure-legal-storage-account",
    storeKeySecret: "azure-legal-storage-key",
    container: "personal",
    ledger: "_MEMORY/clo-personal.jsonl",
    index: "legal-personal-memory",
    idPrefix: "clop",
  },
  {
    label: "cfo",
    storeAcctSecret: "azure-cfo-storage-account",
    storeKeySecret: "azure-cfo-storage-key",
    container: "cfo-source-docs",
    ledger: "_MEMORY/cfo.jsonl",
    index: "finance-cfo-memory",
    idPrefix: "cfom",
  },
  // Non-privileged agents keep their PRIVATE lane in the shared COMMONS store (fleet commons /
  // company-journal), one ledger per agent at _MEMORY/<agent>.jsonl. Unlike CLO/CFO these agents
  // share a STORE but each still gets its own target index (commons-<agent>-memory) — no agent's
  // private ledger is ever embedded into another agent's index.
  {
    label: "coo",
    storeAcctSecret: "azure-commons-storage-account",
    storeKeySecret: "azure-commons-storage-key",
    container: "company-journal",
    ledger: "_MEMORY/coo.jsonl",
    index: "commons-coo-memory",
    idPrefix: "coom",
  },
  {
    label: "cco",
    storeAcctSecret: "azure-commons-storage-account",
    storeKeySecret: "azure-commons-storage-key",
    container: "company-journal",
    ledger: "_MEMORY/cco.jsonl",
    index: "commons-cco-memory",
    idPrefix: "ccom",
  },
  {
    label: "cro",
    storeAcctSecret: "azure-commons-storage-account",
    storeKeySecret: "azure-commons-storage-key",
    container: "company-journal",
    ledger: "_MEMORY/cro.jsonl",
    index: "commons-cro-memory",
    idPrefix: "crom",
  },
  {
    label: "cpo",
    storeAcctSecret: "azure-commons-storage-account",
    storeKeySecret: "azure-commons-storage-key",
    container: "company-journal",
    ledger: "_MEMORY/cpo.jsonl",
    index: "commons-cpo-memory",
    idPrefix: "cpom",
  },
  {
    label: "developer",
    storeAcctSecret: "azure-commons-storage-account",
    storeKeySecret: "azure-commons-storage-key",
    container: "company-journal",
    ledger: "_MEMORY/developer.jsonl",
    index: "commons-developer-memory",
    idPrefix: "devm",
  },
];

function saRaw() {
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) return process.env.GCP_CLAUDE_DRIVER_SA_JSON;
  return readFileSync(`${homedir()}/.gcp_claude_driver_sa.json`, "utf8");
}
function saJwt(scope) {
  const sa = JSON.parse(saRaw());
  const now = Math.floor(Date.now() / 1000);
  const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url");
}
async function gtoken() {
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt("https://www.googleapis.com/auth/cloud-platform"))}` });
  return (await r.json()).access_token;
}
async function sm(id, tok) {
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: "Bearer " + tok } });
  if (!r.ok) return null;
  return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
}
function blobSas(acct, key) {
  const sv = "2021-12-02", sp = "rl", ss = "b", srt = "co";
  const st = new Date(Date.now() - 3e5).toISOString().slice(0, 19) + "Z";
  const se = new Date(Date.now() + 72e5).toISOString().slice(0, 19) + "Z";
  const sts = [acct, sp, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n";
  const sig = crypto.createHmac("sha256", Buffer.from(key, "base64")).update(sts, "utf8").digest("base64");
  return new URLSearchParams({ sv, ss, srt, sp, st, se, spr: "https", sig }).toString();
}
const docId = (s) => String(s).replace(/[^A-Za-z0-9_\-=]/g, "_").slice(0, 900);

async function ensureIndex(AIS, AK, index) {
  const schema = { name: index, fields: [
    { name: "id", type: "Edm.String", key: true },
    { name: "type", type: "Edm.String", filterable: true, facetable: true },
    { name: "ts", type: "Edm.String", filterable: true, sortable: true },
    { name: "tags", type: "Edm.String", searchable: true },
    { name: "text", type: "Edm.String", searchable: true },
    { name: "contentVector", type: "Collection(Edm.Single)", searchable: true, retrievable: false, dimensions: DIMS, vectorSearchProfile: "vp" },
  ], vectorSearch: { algorithms: [{ name: "hnsw", kind: "hnsw" }], profiles: [{ name: "vp", algorithm: "hnsw" }] },
    semantic: { configurations: [{ name: "sem", prioritizedFields: { prioritizedContentFields: [{ fieldName: "text" }], prioritizedKeywordsFields: [{ fieldName: "tags" }] } }] } };
  const r = await fetch(`${AIS}/indexes/${index}?api-version=${API}`, { method: "PUT", headers: { "api-key": AK, "Content-Type": "application/json" }, body: JSON.stringify(schema) });
  if (!r.ok && r.status !== 204 && r.status !== 201 && r.status !== 200) throw new Error(`ensureIndex ${index}: ${r.status} ${(await r.text()).slice(0, 160)}`);
}
async function embed(AOAI, AOK, DEP, texts) {
  for (let a = 0; a < 6; a++) {
    const r = await fetch(`${AOAI}/openai/deployments/${DEP}/embeddings?api-version=2024-02-01`, { method: "POST", headers: { "api-key": AOK, "Content-Type": "application/json" }, body: JSON.stringify({ input: texts }) });
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 1500 * (a + 1))); continue; }
    if (!r.ok) throw new Error("embed " + r.status);
    return (await r.json()).data.map((d) => d.embedding);
  }
  throw new Error("embed 429 exhausted");
}
function entryText(eR) {
  const tags = Array.isArray(eR.tags) ? eR.tags.join(" ") : eR.tags || "";
  return `[${eR.type || "entry"}] ${eR.text || eR.evalue || eR.value || ""} ${tags}`.trim().slice(0, 8000);
}

/** Index one ring's ledger into its index. Returns {label, indexed, total} or {label, error}. Fail-safe. */
export async function indexRing(ring, azure, tok) {
  try {
    const [acct, key] = await Promise.all([sm(ring.storeAcctSecret, tok), sm(ring.storeKeySecret, tok)]);
    if (!acct || !key) return { label: ring.label, error: "ring store creds missing" };
    const sas = blobSas(acct, key);
    const rr = await fetch(`https://${acct}.blob.core.windows.net/${ring.container}/${ring.ledger.split("/").map(encodeURIComponent).join("/")}?${sas}`);
    if (!rr.ok) return { label: ring.label, error: `ledger read ${rr.status}` };
    const rows = (await rr.text()).split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    await ensureIndex(azure.AIS, azure.AK, ring.index);
    const prep = rows.map((eR, k) => ({
      id: docId(eR.id || `${ring.idPrefix}-${k}-${(eR.ts || "").slice(0, 19)}`),
      type: eR.type || "", ts: eR.ts || "",
      tags: Array.isArray(eR.tags) ? eR.tags.join(", ") : eR.tags || "",
      text: entryText(eR),
    })).filter((d) => d.text);
    let indexed = 0, buf = [];
    for (let i = 0; i < prep.length; i += EMBED_BATCH) {
      const chunk = prep.slice(i, i + EMBED_BATCH);
      let vecs;
      try { vecs = await embed(azure.AOAI, azure.AOK, azure.DEP, chunk.map((c) => c.text)); } catch { continue; }
      chunk.forEach((c, j) => buf.push({ "@search.action": "mergeOrUpload", id: c.id, type: c.type, ts: c.ts, tags: c.tags, text: c.text.slice(0, 16000), contentVector: vecs[j] }));
      if (buf.length >= PUSH_BATCH) { await fetch(`${azure.AIS}/indexes/${ring.index}/docs/index?api-version=${API}`, { method: "POST", headers: { "api-key": azure.AK, "Content-Type": "application/json" }, body: JSON.stringify({ value: buf }) }); indexed += buf.length; buf = []; }
    }
    if (buf.length) { await fetch(`${azure.AIS}/indexes/${ring.index}/docs/index?api-version=${API}`, { method: "POST", headers: { "api-key": azure.AK, "Content-Type": "application/json" }, body: JSON.stringify({ value: buf }) }); indexed += buf.length; }
    return { label: ring.label, index: ring.index, indexed, total: rows.length };
  } catch (e) {
    return { label: ring.label, error: String((e && e.message) || e) };
  }
}

export async function run(filterLabel) {
  const tok = await gtoken();
  const [ep, AK, aoaiA, aoaiB, keyA, keyB, dep] = await Promise.all([
    sm("azure-search-endpoint", tok), sm("azure-search-admin-key", tok),
    sm("azure-foundry-openai-endpoint", tok), sm("azure-openai-endpoint", tok),
    sm("azure-foundry-key", tok), sm("azure-openai-key", tok),
    sm("azure-openai-embedding-deployment", tok),
  ]);
  const azure = { AIS: (ep || "").replace(/\/$/, ""), AK, AOAI: ((aoaiA || aoaiB) || "").replace(/\/$/, ""), AOK: keyA || keyB, DEP: dep || "text-embedding-3-large" };
  const rings = RINGS.filter((r) => !filterLabel || filterLabel === "all" || r.label === filterLabel);
  const out = [];
  for (const ring of rings) out.push(await indexRing(ring, azure, tok)); // sequential: fail-safe, bounded quota
  return out;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const arg = process.argv.slice(2).find((a) => !a.startsWith("--")) || "all";
  run(arg).then((res) => { for (const r of res) console.log(r.error ? `RING ${r.label}: ERROR ${r.error}` : `RING ${r.label}: indexed ${r.indexed}/${r.total} -> ${r.index}`); })
    .catch((e) => { console.error("ring-memory-index fatal:", e.message); process.exit(1); });
}

export default { RINGS, indexRing, run };
