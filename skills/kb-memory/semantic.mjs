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
//   node semantic.mjs recall "<query>" [--n 12] [--agent cto] [--type pitfall] [--include-ops]
//
// Recall-quality safeguards (gateway parity, 2026-07-21): recall() drops retracted/superseded rows and,
// by default, operational-exhaust chatter (status/episode/heartbeat/digest); pass --include-ops to see
// the exhaust types too. See filterHygiene() below.
import crypto from "node:crypto";
import { mergeSchemaAdditive } from "../doc-indexer/schema-merge.mjs";
import { pathToFileURL } from "node:url";
// Same-skill, dependency-free import: the near-duplicate similarity heuristic used to cluster like
// recall hits across agents for trust scoring (see rankHitsByTrust). Always present alongside this file.
import { tokenize, jaccard } from "./dedupe.mjs";
import { kvSecret } from "./azure-secret.mjs";
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
const INCLUDE_OPS = argv.includes("--include-ops"); // bypass the exhaust-type room-hygiene filter (see filterHygiene)

function saJwt(scope) {
  const __r=process.env.GCP_CLAUDE_DRIVER_SA_JSON;if(!__r){return null;}let sa;try{sa=JSON.parse(__r);}catch{return null;}if(!sa||!sa.private_key){return null;}
  const now = Math.floor(Date.now() / 1000);
  const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url");
}
async function sm(id) { const _kv = await kvSecret(id); if (_kv != null) return _kv;
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
      // Retraction/supersession parity with the gateway's brain_search safeguards (defect-2 fix,
      // 2026-07-21): true when this entry's ledger id is SOME OTHER entry's `supersedes` target anywhere
      // in the exec feed, i.e. the fleet has since corrected/retracted it (see reindex() below). Additive
      // field (mergeSchemaAdditive keeps the PUT below non-destructive on the live index); recall()
      // treats an absent value (pre-fix docs, or an index not yet reindexed) as NOT retracted, fail-open.
      { name: "retracted", type: "Edm.Boolean", filterable: true },
      { name: "contentVector", type: "Collection(Edm.Single)", searchable: true, retrievable: false, dimensions: EMB_DIMS, vectorSearchProfile: "vp" },
    ],
    vectorSearch: { algorithms: [{ name: "hnsw", kind: "hnsw" }], profiles: [{ name: "vp", algorithm: "hnsw" }] },
    semantic: { configurations: [{ name: "sem", prioritizedFields: { prioritizedContentFields: [{ fieldName: "text" }], prioritizedKeywordsFields: [{ fieldName: "tags" }] } }] },
  };
  // SKEW-PROOF (2026-07-14). THIS IS THE SAME BUG CLASS THAT KILLED daily-digest ON 2026-07-13, and it
  // was still armed here -- on `memory-exec`, THE FLEET'S ACTUAL LIVE BRAIN, written by brain-reindex
  // every 6h and by the nightly digest. An index PUT that omits a field the LIVE index already has is
  // rejected by Azure ("Existing field(s) 'X' cannot be deleted"), so the moment ANYONE adds a field to
  // memory-exec, this writer -- whose schema is hardcoded below -- would hard-fail on every run, exactly
  // as indexer.mjs did the night `indexed_at` was backfilled. indexer.mjs was fixed; this was not. The
  // fix must be applied to the CLASS, not the instance: GET the live index and merge additively so the
  // PUT is always a non-destructive superset.
  let putSchema = schema;
  try {
    const g = await fetch(`${AIS_EP}/indexes/${IDX}?api-version=${AIS_API}`, { headers: { "api-key": AIS_KEY } });
    if (g.ok) putSchema = mergeSchemaAdditive(schema, await g.json());
  } catch { /* index absent or transient GET error -> PUT the code schema as-is (first-create path) */ }
  const r = await fetch(`${AIS_EP}/indexes/${IDX}?api-version=${AIS_API}`, { method: "PUT", headers: { "api-key": AIS_KEY, "Content-Type": "application/json" }, body: JSON.stringify(putSchema) });
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
async function aisDelete(ids) {
  for (let i = 0; i < (ids || []).length; i += 1000) {
    const batch = ids.slice(i, i + 1000).map((id) => ({ "@search.action": "delete", id }));
    const r = await fetch(`${AIS_EP}/indexes/${IDX}/docs/index?api-version=${AIS_API}`, { method: "POST", headers: { "api-key": AIS_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ value: batch }) });
    if (!r.ok) throw new Error("delete " + r.status + " " + (await r.text()).slice(0, 200));
  }
}

// read every shared exec-feed file. Exported so other kb-memory tooling (e.g. contradiction-scan.mjs)
// reuses the SAME Blob-listing + credential-resolution logic instead of duplicating it; behavior is
// unchanged for the existing internal caller (reindex()).
export async function readExecFeed() {
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

// Stable short content hash for collision disambiguation (assignDocIds below). Not security-sensitive;
// it only has to be deterministic and well-distributed so two DIFFERENT texts sharing one base key get
// different suffixes. sha1 -> first 12 hex chars, already inside the Azure AI Search key charset.
const shortHash = (text) => crypto.createHash("sha1").update(String(text == null ? "" : text)).digest("hex").slice(0, 12);

// Assign a STABLE, INJECTIVE index doc-key to every entry (tagging each with `_docId`) and return the
// set of base keys that had a genuine collision (>=2 entries with DIFFERENT text under one base key).
//
// THE BUG THIS FIXES (gs-10 -- a real data-integrity loss in the live brain): nextId() historically
// produced un-salted 2-segment ids (e.g. "20260701-044"), so two different ledger entries could share
// an id. docId() maps both to the SAME base key `agent__id`, and reindex()'s mergeOrUpload (plus its
// skip-if-already-indexed filter) then silently keeps only ONE of them -- the other fact is permanently
// absent from `memory-exec` and can never be recalled. Measured 18 such suppressed facts on the live
// feed. (nextId() now appends a random salt, so new ids do not collide; this handles the historical
// ones and is future-proof against any residual collision.)
//
// Minimal-churn by design: the common (unique) case KEEPS its bare `agent__id` key, so the ~4.7k
// healthy docs stay in the index untouched (no re-embed). ONLY the colliding entries get a
// `__<contentHash>` suffix so each distinct fact gets its own key. Idempotent: same entry -> same key
// every run. Same-text entries within a colliding group still share a key (correct -- they are the same
// fact). Pure (no I/O); exported for tests.
export function assignDocIds(entries) {
  const groups = new Map(); // baseKey -> entries[]
  for (const e of entries || []) {
    if (!e || !e.id) continue;
    const base = docId(e._agent, e.id);
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(e);
  }
  const collidedBaseKeys = new Set();
  for (const [base, arr] of groups) {
    const distinctText = new Set(arr.map((e) => (e.text || "").trim()));
    if (distinctText.size < 2) { for (const e of arr) e._docId = base; continue; }
    collidedBaseKeys.add(base);
    for (const e of arr) e._docId = `${base}__${shortHash(e.text)}`.replace(/[^A-Za-z0-9_\-=]/g, "_");
  }
  return collidedBaseKeys;
}

// Trust-rank + annotate recall hits using an INJECTED semantic-trust module (so this is pure and unit-
// testable offline: the caller passes the dynamically-imported trust module, or null). Returns:
//   { annot: Array|null, order: number[] }
// annot[i] = { status, trust, distinct } for hit i, or null when trust scoring was unavailable (module
// missing / wrong shape / threw), in which case order is the identity order and the caller prints the
// plain score-ordered list. FAIL-OPEN by construction: any throw -> {annot:null, order}.
//
// CORROBORATION-ONLY by design. Recall hits are SUBJECT-LESS (the exec-feed index has no ekey/subject
// field), so semantic-trust's groupAssertions() contradiction model does NOT fit here: it would bucket
// every subject-less hit together and mislabel unrelated claims as mutual "contradictions", dragging even
// a well-corroborated cluster to "contested". Instead we cluster hits by CLAIM-TEXT similarity (the same
// tokenize/jaccard heuristic semantic-trust itself uses across agents) and score each cluster's distinct-
// agent corroboration with scoreClaim() and NO contradictions. So "N distinct agents independently
// recorded this same memory" floats ahead of a single unverified assertion; we do not fabricate
// contradictions between memories that are simply about different things.
const _TRUST_RANK = { durable: 0, corroborated: 1, unverified: 2, contested: 3 };
const _CLAIM_SIM = 0.5; // matches semantic-trust's CLAIM_SIMILARITY_THRESHOLD
export function rankHitsByTrust(hits, trust, nowMs = Date.now()) {
  const order = hits.map((_, i) => i);
  try {
    if (!trust || typeof trust.scoreClaim !== "function") return { annot: null, order };
    // Greedy cluster by claim-text similarity across agents (reuses kb-memory/dedupe.mjs's own
    // tokenize/jaccard, the exact near-duplicate heuristic used intra-agent and by semantic-trust).
    const clusters = []; // { repTokens, idxs: number[] }
    hits.forEach((h, i) => {
      const toks = tokenize(h.text || "");
      let tgt = null;
      for (const c of clusters) { if (jaccard(toks, c.repTokens) >= _CLAIM_SIM) { tgt = c; break; } }
      if (!tgt) { tgt = { repTokens: toks, idxs: [] }; clusters.push(tgt); }
      tgt.idxs.push(i);
    });
    const annot = new Array(hits.length).fill(null);
    for (const c of clusters) {
      const assertions = c.idxs.map((i) => ({ agent: hits[i].agent, ts: typeof hits[i].ts === "number" ? hits[i].ts : Date.parse(hits[i].ts || 0) || 0 }));
      const scored = trust.scoreClaim({ assertions, nowMs });
      for (const i of c.idxs) annot[i] = { status: scored.status, trust: scored.trust, distinct: scored.distinctAgents };
    }
    // Stable re-order by trust rank (durable first), preserving search-score order within a rank.
    order.sort((a, b) => {
      const ra = _TRUST_RANK[annot[a] && annot[a].status] ?? 2, rb = _TRUST_RANK[annot[b] && annot[b].status] ?? 2;
      return ra !== rb ? ra - rb : a - b;
    });
    return { annot, order };
  } catch {
    return { annot: null, order: hits.map((_, i) => i) };
  }
}

// Operational-exhaust "room hygiene": types that are ops chatter, not durable knowledge, and crowd out
// real facts in a top-N recall (a heartbeat/digest/status ping displacing an actual fact). Mirrors the
// gateway's brain_search room-hygiene filter (otchealth-mcp-server PR #110) so a local Claude Code
// recall() gives the same quality result the gateway would. Exported so the exact set is test-pinned.
export const EXHAUST_TYPES = new Set(["status", "episode", "heartbeat", "digest"]);

// Room-hygiene + retraction filter (defect-2 parity fix, 2026-07-21): drop rows the fleet has
// superseded/retracted (retracted===true, see reindex()) and, unless includeOps or an explicit
// typeFilter was requested, operational-exhaust chatter (EXHAUST_TYPES) -- the two safeguards the
// gateway's brain_search already applies that this local recall path lacked. `typeFilter` suppresses the
// exhaust check on purpose: if the caller explicitly asked for `--type status`, honor it rather than
// stripping every result back out. Pure, fail-open by construction (any throw returns the input
// unmodified, mirroring rankHitsByTrust's own fail-open contract above); exported for unit tests.
export function filterHygiene(hits, { includeOps = false, typeFilter = "" } = {}) {
  try {
    return (hits || []).filter((h) => {
      if (h && h.retracted === true) return false;
      if (!includeOps && !typeFilter && h && EXHAUST_TYPES.has(String(h.type || "").toLowerCase())) return false;
      return true;
    });
  } catch {
    return hits || [];
  }
}

// Which ledger ids are RETRACTED (superseded by some other entry), over a full entries list. The same
// supersededIds-Set idiom mem.mjs's `active` filter, dedupe.mjs's `activeRowsOfType`, and
// contradiction-scan.mjs's `dropSuperseded` already use elsewhere in this toolkit -- extracted here as
// its own pure, exported, directly-testable function (mirrors assignDocIds/rankHitsByTrust/filterHygiene
// above: a pure core plus a thin I/O caller) rather than left inline in reindex(), so the PRODUCER side
// of retraction (which ids get tagged) is pinned by a test independent of the CONSUMER side
// (filterHygiene, above). Pure, no I/O.
export function computeRetractedIds(entries) {
  return new Set((entries || []).filter((e) => e && e.supersedes).map((e) => e.supersedes));
}

async function reindex() {
  await init(); await ensureIndex();
  const entries = await readExecFeed();
  const have = await existingIds();
  // Assign a stable, injective key to every entry: bare `agent__id` for the unique common case (kept
  // as-is in the index, no re-embed), a content-hash-suffixed key ONLY for genuinely colliding entries
  // so no distinct fact is silently dropped (the gs-10 id-collision bug).
  const collidedBaseKeys = assignDocIds(entries);
  // RETRACTION (defect-2 fix, 2026-07-21): computed ONCE over the full feed -- an entry's id landing in
  // this set means some OTHER entry `--supersedes`s it, i.e. the fleet has corrected/retracted it. Baked
  // into every doc as `retracted` (inline below, plus a retroactive refresh pass after the main loop) so
  // recall() can drop it cheaply -- a stored field, no extra network call.
  const supersededIds = computeRetractedIds(entries);
  const todo = entries.filter(e => e.id && e._docId && !have.has(e._docId));
  console.error(`[memory-semantic] ${entries.length} exec entries; ${have.size} already indexed; ${todo.length} to embed; ${collidedBaseKeys.size} colliding base key(s) to de-duplicate; ${supersededIds.size} superseded id(s)`);
  let n = 0, buf = [], bufIds = [];
  const embedded = new Set(); // _docIds confirmed upserted this run (added only after a successful push)
  const flush = async () => { if (!buf.length) return; await aisPush(buf); for (const id of bufIds) embedded.add(id); n += buf.length; buf = []; bufIds = []; };
  for (const e of todo) {
    const text = `[${e.type}] ${e.text || ""} ${(e.tags || []).join(" ")}`.slice(0, 8000);
    let vec; try { vec = (await embed([text]))[0]; } catch (err) { console.error("  embed fail " + e.id + ": " + err.message); continue; }
    buf.push({ "@search.action": "mergeOrUpload", id: e._docId, agent: e._agent, type: e.type || "", ts: e.ts || "", tags: (e.tags || []).join(", "), text: (e.text || "").slice(0, 16000), retracted: supersededIds.has(e.id), contentVector: vec });
    bufIds.push(e._docId);
    if (buf.length >= 64) { await flush(); console.error(`  indexed ${n}/${todo.length}`); }
  }
  await flush();
  // RETROACTIVE RETRACTION (defect-2 fix): an entry that gets superseded by a LATER correction, AFTER it
  // was already embedded in a prior run, is never revisited by the todo-only loop above (todo = not-yet-
  // indexed only) -- so its `retracted` flag would otherwise stay false forever and recall() would keep
  // surfacing a belief the fleet already corrected. No re-embed needed: a partial mergeOrUpload of just
  // {id, retracted:true} updates ONLY that field (Azure AI Search merges named fields; text/contentVector
  // already on the doc are untouched). The ledger is append-only and supersession is monotonic (once
  // retracted, never un-retracted), so it is always correct to write retracted:true here, never false.
  const validEntries = entries.filter((e) => e.id && e._docId);
  const toRetract = validEntries.filter((e) => supersededIds.has(e.id));
  let retractedNow = 0;
  for (let i = 0; i < toRetract.length; i += 1000) {
    const batch = toRetract.slice(i, i + 1000).map((e) => ({ "@search.action": "mergeOrUpload", id: e._docId, retracted: true }));
    try { await aisPush(batch); retractedNow += batch.length; } catch (err) { console.error("  retracted-flag refresh batch failed: " + err.message); }
  }
  if (toRetract.length) console.error(`[memory-semantic] marked ${retractedNow}/${toRetract.length} superseded doc(s) retracted:true`);
  // Prune the now-stale bare `agent__id` doc of each collided group: its fact has just been re-indexed
  // under a `__<hash>` key (alongside the sibling the collision previously hid), so the bare key is a
  // duplicate. SAFETY: delete a base key ONLY when EVERY entry of its group is confirmed present under
  // its hashed key -- already in the index (have) OR successfully upserted this run (embedded). If an
  // embed failed for any group member, keep the bare key as a fallback so no fact is lost; the next run
  // retries. (Deletes run AFTER all upserts, so a partial feed read / embed failure can never orphan a
  // live fact.)
  const groupDocIds = new Map(); // base -> Set(_docId) over the FULL feed
  for (const e of entries) { if (e.id && e._docId) { const b = docId(e._agent, e.id); if (!groupDocIds.has(b)) groupDocIds.set(b, new Set()); groupDocIds.get(b).add(e._docId); } }
  const groupSafe = (b) => [...(groupDocIds.get(b) || [])].every(d => have.has(d) || embedded.has(d));
  const orphans = [...collidedBaseKeys].filter(b => have.has(b) && groupSafe(b));
  if (orphans.length) { await aisDelete(orphans); console.error(`  pruned ${orphans.length} stale bare-key duplicate(s)`); }
  console.log(`memory-semantic: indexed ${n} new entries into ${IDX} (~${have.size + n - orphans.length} total after pruning ${orphans.length} duplicate(s)).`);
}

async function recall() {
  if (!QUERY) { console.error('need a query: semantic.mjs recall "<query>" [--n 12] [--agent x] [--type pitfall] [--include-ops]'); process.exit(2); }
  await init();
  const vec = (await embed([QUERY]))[0];
  const filters = [];
  if (AGENT_FILTER) filters.push(`agent eq '${AGENT_FILTER.replace(/'/g, "''")}'`);
  if (TYPE_FILTER) filters.push(`type eq '${TYPE_FILTER.replace(/'/g, "''")}'`);
  const SELECT_FULL = "agent,type,ts,text,tags,retracted";
  const SELECT_LEGACY = "agent,type,ts,text,tags"; // fallback: index not yet reindexed since `retracted` shipped
  let baseBody = { search: QUERY, top: N, select: SELECT_FULL, vectorQueries: [{ kind: "vector", vector: vec, fields: "contentVector", k: N }] };
  if (filters.length) baseBody.filter = filters.join(" and ");
  // Invoke the Azure AI Search L2 SEMANTIC RERANKER. The memory-exec index provisions a "sem" semantic
  // config (see ensureIndex above) but this recall path never used it -- it returned pure hybrid
  // BM25+vector. queryType:"semantic" reorders the fused top-k by a cross-encoder relevance model:
  // materially better recall at $0 (the S1 service already bills for semantic capacity). Mirrors the
  // gateway's own hybridSearch (otchealth-mcp-server src/azure/search.ts). FAIL-OPEN, exactly like the
  // gateway: a semantic-ranker 400 (config/capacity/tier) must never take recall down, so retry once as
  // plain hybrid and carry on.
  const doSearch = (semantic) => fetch(`${AIS_EP}/indexes/${IDX}/docs/search?api-version=${AIS_API}`, {
    method: "POST", headers: { "api-key": AIS_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(semantic ? { ...baseBody, queryType: "semantic", semanticConfiguration: "sem" } : baseBody),
  });
  let r = await doSearch(true);
  // FAIL-OPEN on ANY semantic failure, not just 400: the semantic ranker can also return 402 (monthly
  // free-tier quota exhausted before semantic billing is enabled) or 403, and recall must NEVER break
  // just because the reranker is unavailable -- fall straight back to the plain hybrid query that has
  // always worked.
  if (!r.ok) { console.error(`[recall] semantic ranker unavailable (${r.status}); falling back to plain hybrid`); r = await doSearch(false); }
  // FAIL-OPEN on the `retracted` field not existing yet (an index that has not been reindexed since this
  // shipped): Azure 400s a $select naming an unknown field. Drop it and retry the same semantic/non-
  // semantic dance once more, so recall NEVER breaks on a stale schema; it just runs one cycle without
  // the extra safeguard field until the next reindex backfills it.
  if (!r.ok && r.status === 400) {
    console.error("[recall] 'retracted' field not yet in the live schema (run reindex to backfill); retrying without it");
    baseBody = { ...baseBody, select: SELECT_LEGACY };
    r = await doSearch(true);
    if (!r.ok) r = await doSearch(false);
  }
  if (!r.ok) { console.error("search " + r.status + " " + (await r.text()).slice(0, 200)); process.exit(1); }
  let hits = (await r.json()).value || [];

  // Room-hygiene + retraction filter (defect-2 parity fix): see filterHygiene() above. Fail-open by
  // construction (filterHygiene never throws); `hits` is only ever reassigned to its own filtered output.
  const hygieneHits = filterHygiene(hits, { includeOps: INCLUDE_OPS, typeFilter: TYPE_FILTER });
  if (hygieneHits.length !== hits.length) console.error(`[recall] filtered ${hits.length - hygieneHits.length} retracted/exhaust row(s)${INCLUDE_OPS ? "" : " (pass --include-ops to include status/episode/heartbeat/digest chatter)"}`);
  hits = hygieneHits;

  // semantic-trust wiring (ADVISORY, FAIL-OPEN): the shared exec feed is CROSS-AGENT, so the same
  // real-world claim is often asserted independently by several agents in their own words. semantic-trust
  // recognizes that (jaccard grouping of like claims across agents) and scores corroboration with time
  // decay, so recall can float memories MULTIPLE agents agree on ahead of a single unverified assertion,
  // and flag claims agents CONTRADICT each other on as contested. Purely additive: it re-orders and
  // annotates the hits, never drops one. Any failure (module missing, scorer throws) degrades to the
  // plain score-ordered print below.
  const trust = await import("../semantic-trust/trust.mjs").catch(() => null);
  const { annot, order } = rankHitsByTrust(hits, trust, Date.now());

  console.log(`# semantic recall "${QUERY}"${AGENT_FILTER ? ` @${AGENT_FILTER}` : ""} - ${hits.length} hit(s)${annot ? " (trust-ranked: durable > corroborated > unverified, by cross-agent corroboration)" : ""}\n`);
  for (const i of order) {
    const h = hits[i];
    const t = annot ? annot[i] : null;
    const trustTag = t ? ` | trust: ${t.status} t=${(t.trust || 0).toFixed(2)}, ${t.distinct} agent${t.distinct === 1 ? "" : "s"}` : "";
    console.log(`[${h.agent}] [${h.type}] ${(h.ts || "").slice(0, 10)} (score ${(h["@search.score"] || 0).toFixed(3)}${trustTag})\n  ${(h.text || "").slice(0, 320)}${h.tags ? `\n  tags: ${h.tags}` : ""}\n`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    try {
      if (cmd === "reindex") await reindex();
      else if (cmd === "recall") await recall();
      else { console.error('usage: semantic.mjs reindex | recall "<query>" [--n 12] [--agent x] [--type pitfall] [--include-ops]'); process.exit(2); }
    } catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
  })();
}
