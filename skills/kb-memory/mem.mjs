#!/usr/bin/env node
// kb-memory — durable, append-only WORKING MEMORY for agents. Defeats context-window compaction:
// facts / decisions / corrections / pitfalls / status are externalized the INSTANT they are stated,
// and re-read on wake, so the chat window is disposable and nothing established is lost or silently
// changed. Per-agent and RING-CORRECT (the private ledger co-locates inside the agent's own store).
// Dependency-free; self-resolves creds from Secret Manager via the claude-driver SA.
//
// THE MODEL: the ledger is the source of truth; recall by READING it, never by trusting in-session
// memory. Append-only + temporal supersession (corrections keep WAS->NOW). PITFALLS capture the
// recurring WRONG beliefs the AI keeps forming.
//
// CONNECTED EXEC MEMORY: each agent keeps a PRIVATE lane (ring-correct). `status` (always) and any
// entry written with `--share` ALSO publish a copy to the broadly-readable EXEC TEAM feed
// (otchealthcommons/company-journal/_MEMORY/_exec/<agent>.jsonl, ONE file per agent = no clobber),
// which every agent's tail / recall / team automatically reads. So the whole exec team shares facts
// and sees each other's project status, while privilege / MNPI DETAIL stays in each private lane
// (only what you explicitly `status` / `--share` ever leaves your lane). The CLO PERSONAL lane is
// HARD-EXCLUDED from sharing (attorney privilege).
//
// Verbs:
//   remember "<fact>"   --agent cfo [--tags a,b] [--source "..."] [--share]
//   decision "<made>"   --agent cfo [...] [--share]
//   correct  "<right>"  --agent cfo --was "<wrong>" [--supersedes id] [--share]
//   pitfall  "<lesson>" --agent cfo [--share]
//   status   "<what I'm working on / project status>" --agent cfo    # ALWAYS shared to the exec team
//   entity   set <key> "<value>" --agent cfo [--source ..] [--share]  # deterministic current-value ("what is X now")
//   entity   get <key> --agent cfo | list | alias "<from>" <to>       # latest-wins per key; alias many phrasings -> 1 key
//   recall   "<query>"  --agent cfo [--n 25]    # searches YOUR lane + the shared TEAM feed
//   tail     --agent cfo [--n 40]               # YOUR pitfalls/recent + the TEAM feed (company-wide)
//   team     [--agent x] [--n 60]               # the whole exec team feed: who is working on what
//   render   --agent cfo  |  list-agents
import crypto from "node:crypto";
import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const HERE = dirname(fileURLToPath(import.meta.url)); // for spawning sibling scripts (index-one.mjs)

const SM = "otchealth-shared-prod";
const AGENTS = {
  cfo:            { account: "otchealthcfodata",    accountSecret: "azure-cfo-storage-account",    keySecret: "azure-cfo-storage-key",    container: "cfo-source-docs", ring: "finance (MNPI/private)" },
  clo:            { account: "otchealthlegalstore", accountSecret: "azure-legal-storage-account",  keySecret: "azure-legal-storage-key",  container: "company",         ring: "legal company (privileged)" },
  "clo-personal": { account: "otchealthlegalstore", accountSecret: "azure-legal-storage-account",  keySecret: "azure-legal-storage-key",  container: "personal",        ring: "legal PERSONAL (privileged + confidential, segregated)" },
  commons:        { account: "otchealthcommons",    accountSecret: "azure-commons-storage-account", keySecret: "azure-commons-storage-key", container: "company-journal", ring: "fleet commons (shared)" },
};
// The executive team: agents whose status + shared facts flow into the connected team feed. Any agent
// can publish/read; this set is documentation + the default `team` roster.
const EXEC = ["coo", "cfo", "clo", "cto", "capital", "commerce", "compliance", "rainmaker", "growth", "developer"];
const NO_SHARE = new Set(["clo-personal"]); // privilege wall: personal-matter memory never leaves its lane

// ---- args ----
const argv = process.argv.slice(2);
const cmd = argv[0];
const takeVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const positional = argv.slice(1).filter((a, i, arr) => !a.startsWith("--") && !(i > 0 && arr[i - 1].startsWith("--")));
const TEXT = positional.join(" ").trim();
const AGENT = (takeVal("--agent", "") || "").toLowerCase();
const A = AGENTS[AGENT] || (AGENT ? { ...AGENTS.commons, _file: AGENT } : null);
const TAGS = (takeVal("--tags", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const SOURCE = takeVal("--source", "");
const WAS = takeVal("--was", "");
const SUPERSEDES = takeVal("--supersedes", "");
const SHARE = argv.includes("--share");
const N = parseInt(takeVal("--n", "40"), 10) || 40;
const QUERY = takeVal("--query", "");

// ---- Secret Manager (claude-driver SA) ----
// Resolve the claude-driver SA from the env var OR, failing that, from disk. This closes the
// silent-failure pitfall: a fresh shell has no env var, JSON.parse(undefined) throws an opaque
// "undefined is not valid JSON", and every write/read vanishes -> the agent silently "forgets".
function resolveSaJson() {
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) return process.env.GCP_CLAUDE_DRIVER_SA_JSON;
  // HOME-relative only: this is the canonical hydration path (session-start writes it here, vault-sync
  // reads it here) AND it respects a test's temp HOME, so hermetic tests stay hermetic.
  const p = `${homedir()}/.gcp_claude_driver_sa.json`;
  try { if (existsSync(p)) return readFileSync(p, "utf8"); } catch {}
  return null;
}
function saJwt(scope) {
  const raw = resolveSaJson();
  if (!raw) { console.error("kb-memory: MEMORY IS OFF - no service account. Set GCP_CLAUDE_DRIVER_SA_JSON, or place ~/.gcp_claude_driver_sa.json (run /tmp/octools/setup/session-start.sh)."); process.exit(3); }
  const sa = JSON.parse(raw);
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

// ---- Azure Blob (account SAS) ----
const encPath = (name) => name.split("/").map(encodeURIComponent).join("/");
function buildSas(acct, key) {
  const sv = "2021-12-02", sp = "rwlc", ss = "b", srt = "co";
  const st = new Date(Date.now() - 5 * 60000).toISOString().slice(0, 19) + "Z";
  const se = new Date(Date.now() + 12 * 3600 * 1000).toISOString().slice(0, 19) + "Z";
  const sts = [acct, sp, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n";
  const sig = crypto.createHmac("sha256", Buffer.from(key, "base64")).update(sts, "utf8").digest("base64");
  return new URLSearchParams({ sv, ss, srt, sp, st, se, spr: "https", sig }).toString();
}
// --- the agent's own private lane ---
let ACCT, AKEY, AZ_SAS, KEYBASE, JSONL, MD;
async function initStore() {
  if (!A) { console.error("need --agent <cfo|clo|clo-personal|commons|...>"); process.exit(2); }
  ACCT = process.env.KB_ACCOUNT || A.account || (await sm(A.accountSecret));
  AKEY = process.env.KB_KEY || (await sm(A.keySecret));
  if (!ACCT || !AKEY) { console.error(`Missing storage creds for agent '${AGENT}' (account ${A.account}, key secret ${A.keySecret}).`); process.exit(2); }
  AZ_SAS = buildSas(ACCT, AKEY);
  KEYBASE = A._file || AGENT;
  JSONL = `_MEMORY/${KEYBASE}.jsonl`; MD = `_MEMORY/${KEYBASE}.md`;
}
const url = (name) => `https://${ACCT}.blob.core.windows.net/${A.container}/${encPath(name)}?${AZ_SAS}`;
// Transient-fault retry for the blob ops. A memory WRITE must not be lost to a transient proxy/SAS 403,
// a 429, or a 5xx: those used to throw straight out, so a `mem.mjs remember` silently failed = the exact
// forgetting this whole program fights (seen live 2026-06-25: "ERROR: get 403", fine on a plain retry).
// Bounded short backoff (~300/600/1200ms); a REAL 403 (bad key) just exhausts the few tries then surfaces.
// 404 is NOT retried - for the GETs it is a valid "absent" answer, not a fault.
const RETRYABLE = new Set([403, 408, 429, 500, 502, 503, 504]);
async function fetchRetry(u, opts, tries = 4) {
  let last;
  for (let a = 0; a < tries; a++) {
    try { const r = await fetch(u, opts); if (r.status === 404 || r.ok || !RETRYABLE.has(r.status) || a === tries - 1) return r; last = r; }
    catch (e) { last = e; if (a === tries - 1) throw e; }
    await new Promise((s) => setTimeout(s, 300 * Math.pow(2, a)));
  }
  return last;
}
async function getText(name) { const r = await fetchRetry(url(name)); if (r.status === 404) return null; if (!r.ok) throw new Error("get " + r.status); return await r.text(); }
async function putText(name, body, ct) { const r = await fetchRetry(url(name), { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": ct || "text/plain; charset=utf-8" }, body }); if (!r.ok) throw new Error("put " + r.status + " " + (await r.text()).slice(0, 160)); }

// --- the shared EXEC team feed (commons; one file per agent => no cross-agent clobber) ---
const C = AGENTS.commons;
const SHARED_PREFIX = "_MEMORY/_exec/";
let C_ACCT, C_SAS;
async function commonsInit() { if (C_ACCT) return; C_ACCT = process.env.KB_COMMONS_ACCOUNT || C.account || (await sm(C.accountSecret)); const k = await sm(C.keySecret); if (!C_ACCT || !k) throw new Error("commons creds missing"); C_SAS = buildSas(C_ACCT, k); }
const cUrl = (name) => `https://${C_ACCT}.blob.core.windows.net/${C.container}/${encPath(name)}?${C_SAS}`;
async function cGet(name) { const r = await fetchRetry(cUrl(name)); if (r.status === 404) return null; if (!r.ok) throw new Error("cget " + r.status); return await r.text(); }
async function cPut(name, body) { const r = await fetchRetry(cUrl(name), { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": "application/x-ndjson" }, body }); if (!r.ok) throw new Error("cput " + r.status + " " + (await r.text()).slice(0, 160)); }
async function cList(prefix) { const out = []; let marker = ""; do { let u = `https://${C_ACCT}.blob.core.windows.net/${C.container}?restype=container&comp=list&prefix=${encodeURIComponent(prefix)}&${C_SAS}`; if (marker) u += `&marker=${encodeURIComponent(marker)}`; const r = await fetch(u); if (!r.ok) break; const xml = await r.text(); for (const m of xml.matchAll(/<Name>([^<]+)<\/Name>/g)) out.push(m[1]); marker = (xml.match(/<NextMarker>([^<]+)<\/NextMarker>/) || [])[1] || ""; } while (marker); return out; }
const sharedKey = (agent) => `${SHARED_PREFIX}${agent}.jsonl`;
async function publishShared(agent, entry) {
  if (NO_SHARE.has(agent)) { console.error(`[kb-memory] NOTE: ${agent} is privileged; entry kept in the private lane only (NOT shared to the exec team).`); return false; }
  await commonsInit();
  const t = await cGet(sharedKey(agent));
  const rows = t ? t.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  rows.push({ ...entry, agent });
  await cPut(sharedKey(agent), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return true;
}
async function readSharedAll() {
  await commonsInit();
  const blobs = (await cList(SHARED_PREFIX)).filter((n) => n.endsWith(".jsonl"));
  const all = [];
  for (const b of blobs) { const t = await cGet(b); if (!t) continue; for (const l of t.split(/\r?\n/).filter(Boolean)) { try { all.push(JSON.parse(l)); } catch {} } }
  return all.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
}

// ---- local write-through cache: the per-prompt recall hook reads the ledger from a LOCAL file (fast,
//      no network) and refreshes from Blob only on a throttle, so continuous injection never hits Azure
//      on every prompt (the "network on every turn" cost). A mem write updates the cache immediately
//      (write-through), so a just-stated fact is recallable on the very next prompt. Fail-open.
const CACHE_DIR = `${homedir()}/.claude/kb-cache`;
const cacheFile = (kb) => `${CACHE_DIR}/${kb}.jsonl`;
const TEAM_CACHE = `${CACHE_DIR}/_team.jsonl`;
const toNdjson = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const fromNdjson = (t) => t.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
function writeCacheRows(kb, rows) { try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(cacheFile(kb), toNdjson(rows)); } catch {} }
function readCacheRows(kb) { try { return fromNdjson(readFileSync(cacheFile(kb), "utf8")); } catch { return null; } }
function writeTeamCache(rows) { try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(TEAM_CACHE, toNdjson(rows)); } catch {} }
function readTeamCache() { try { return fromNdjson(readFileSync(TEAM_CACHE, "utf8")); } catch { return null; } }
function ageMs(p) { try { return Date.now() - statSync(p).mtimeMs; } catch { return Infinity; } }

// ---- READ-SIDE ring wall (defense in depth): when building ONE agent's per-prompt pack, never inject
//      another lane's sensitive content. clo-personal / NO_SHARE agents do not read the shared feed at
//      all; and any CROSS-agent line matching MNPI (INND securities) or PHI markers is dropped even if it
//      was shared. The agent's OWN lane is never filtered (own ring). Can only REFUSE, never widen.
const RING_DENY = /\b(innd|inscope hearing|otcmkts|ticker|reg\s*[da]\b|rule\s*144|form\s*s-?1|8-?k|10-?[qk]|share\s*price|stock\s*price|materially?\s*non.?public|mnpi|reg\s*fd|dividend|patient|\bphi\b|diagnos|medication|prescrib|hipaa|audiogram|hearing\s*number)\b/i;
const ringSafeCross = (r) => !RING_DENY.test(`${r.text || ""} ${(r.tags || []).join(" ")} ${r.was || ""}`);

// ---- hot-path SEMANTIC tier: when an agent's LOCAL keyword pack is thin, reach into the shared exec
//      brain (the memory-exec AI Search index) BY MEANING and pull a couple of related entries. Uses
//      ONLY a READ-ONLY query key + the search endpoint (cached locally; refreshed off the hot path) and
//      the server-side SEMANTIC RANKER, so there is NO admin key and NO embedding key on the hot path
//      and NO client-side embed call. ONE bounded call (AbortController), thin-triggered + throttled +
//      ring-filtered + fail-open. The query key only ever reads; the code only ever queries memory-exec
//      (the already-ring-safe shared feed), and cross-agent hits still pass the RING_DENY wall.
const SEM_CRED_FILE = `${CACHE_DIR}/.sem-creds.json`;
const SEM_STAMP = `${CACHE_DIR}/.last-sem`;
function readSemCredsCache() { try { const c = JSON.parse(readFileSync(SEM_CRED_FILE, "utf8")); if (c.searchEp && c.queryKey && Date.now() - (c.ts || 0) < 6 * 3600 * 1000) return c; } catch {} return null; }
function spawnSemRefresh() { try { spawn(process.execPath, [join(HERE, "mem.mjs"), "sem-refresh"], { detached: true, stdio: "ignore" }).unref(); } catch {} }
async function semanticHits(prompt, creds, excludePrefixes) {
  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 2000);
  try {
    const r = await fetch(`${creds.searchEp}/indexes/memory-exec/docs/search?api-version=2023-11-01`, { method: "POST", signal: ac.signal, headers: { "api-key": creds.queryKey, "Content-Type": "application/json" }, body: JSON.stringify({ search: String(prompt).slice(0, 400), queryType: "semantic", semanticConfiguration: "sem", top: 6, select: "agent,type,ts,text,tags" }) });
    if (!r.ok) return [];
    const out = [];
    for (const h of (await r.json()).value || []) {
      const text = (h.text || "").trim(); if (!text) continue;
      if (excludePrefixes.has(text.slice(0, 40).toLowerCase())) continue;                  // already in the local pack
      if (h.agent !== AGENT && !ringSafeCross({ text, tags: (h.tags || "").split(", ") })) continue; // cross-agent ring wall
      out.push({ agent: h.agent, type: h.type, text });
      if (out.length >= 3) break;
    }
    return out;
  } catch { return []; }                                                                   // timeout / error -> fail-open
  finally { clearTimeout(to); }
}

async function load() { const t = await getText(JSONL); if (!t) return []; return t.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
function newId(rows) { const d = new Date().toISOString().slice(0, 10).replace(/-/g, ""); const n = rows.filter((r) => (r.id || "").startsWith(d)).length + 1; return `${d}-${String(n).padStart(3, "0")}`; }

function renderMd(rows) {
  const fmt = (r) => `- [${(r.ts || "").slice(0, 10)}] ${r.text}${r.tags && r.tags.length ? `  _(#${r.tags.join(" #")})_` : ""}${r.source ? `  - ${r.source}` : ""}  \`${r.id}\``;
  const active = rows.filter((r) => !rows.some((x) => x.supersedes === r.id));
  const sortNew = (a, b) => (b.ts || "").localeCompare(a.ts || "");
  const sec = (t) => active.filter((r) => r.type === t).sort(sortNew);
  const pit = sec("pitfall"), dec = sec("decision"), fac = sec("fact"), sta = sec("status"), cor = rows.filter((r) => r.type === "correction").sort(sortNew);
  const ent = active.filter((r) => r.type === "entity").sort((a, b) => (a.ekey || "").localeCompare(b.ekey || "")); // current value per key (superseded dropped)
  let md = `# ${KEYBASE.toUpperCase()} Memory Ledger\n\n`;
  md += `> SOURCE OF TRUTH. Read this; do not trust in-session recall. Append-only, dated, newest-wins.\n`;
  md += `> Updated ${new Date().toISOString()} - ${rows.length} entries (${pit.length} pitfalls, ${dec.length} decisions, ${fac.length} facts, ${ent.length} current-values, ${sta.length} status, ${cor.length} corrections).\n\n`;
  md += `## PITFALLS - common mistakes / incorrect beliefs the AI keeps forming. DO NOT REPEAT.\n` + (pit.length ? pit.map(fmt).join("\n") : "- (none yet)") + "\n\n";
  md += `## CURRENT VALUES (entities - latest wins per key; the deterministic "what is X now")\n` + (ent.length ? ent.map((r) => `- \`${r.ekey}\` = ${r.evalue}${r.source ? `  (src: ${r.source})` : ""}  \`${r.id}\``).join("\n") : "- (none yet)") + "\n\n";
  md += `## STATUS - current projects / what I am working on (shared to the exec team)\n` + (sta.length ? sta.map(fmt).join("\n") : "- (none yet)") + "\n\n";
  md += `## DECISIONS (what we decided, and why)\n` + (dec.length ? dec.map(fmt).join("\n") : "- (none yet)") + "\n\n";
  md += `## FACTS (established, current)\n` + (fac.length ? fac.map(fmt).join("\n") : "- (none yet)") + "\n\n";
  md += `## CORRECTIONS (history - what was wrong vs what is right; old is retained on purpose)\n` + (cor.length ? cor.map((r) => `- [${(r.ts || "").slice(0, 10)}] WAS: ${r.was || "?"}  ->  NOW: ${r.text}${r.source ? `  - ${r.source}` : ""}  \`${r.id}\``).join("\n") : "- (none yet)") + "\n";
  return md;
}

async function append(type, share) {
  if (!TEXT) { console.error(`need text: mem.mjs ${type} "<text>" --agent <a>`); process.exit(2); }
  await initStore();
  const rows = await load();
  const entry = { id: newId(rows), ts: new Date().toISOString(), type, text: TEXT, tags: TAGS, source: SOURCE || undefined, was: WAS || undefined, supersedes: SUPERSEDES || undefined };
  rows.push(entry);
  await putText(JSONL, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "application/x-ndjson");
  writeCacheRows(KEYBASE, rows); // write-through: a just-stated fact is instantly in the local recall cache
  await putText(MD, renderMd(rows), "text/markdown; charset=utf-8");
  let shared = false;
  if (share || type === "status") shared = await publishShared(AGENT, entry);
  maybeIndex(entry, shared);
  console.log(`[kb-memory] ${type} -> ${AGENT} (${A.ring}) id=${entry.id}. Private ledger ${rows.length} entries${shared ? "; PUBLISHED to exec team feed" : ""}.`);
}

// write-through SEMANTIC index for a SHARED entry: embed + upsert it into the memory-exec AI Search
// index NOW (detached, fire-and-forget) so it is recallable BY MEANING this minute, not only after the
// next 6h/nightly reindex. RING-SAFE: gated on `shared` being true, so it only ever indexes content
// publishShared() let through (never a private / clo-personal lane). Never blocks the write (unref'd);
// index-one.mjs is fail-open. Shared by append() + entity set.
// Index-retry queue (#1+#2): when a synchronous index attempt fails (timeout / non-zero exit) the entry
// is queued here and DRAINED (idempotent upsert-by-id) on the next shared write + by the `index-catchup`
// verb (wired into the daily memory-sweep). Self-heals any miss between the sync write and the 6h reindex.
// RING-SAFE: only ever holds already-`shared` entries. FAIL-OPEN throughout (never blocks the ledger write).
const INDEX_RETRY_FILE = `${CACHE_DIR}/.index-retry.jsonl`;
function indexOne(entry) {
  try { const r = spawnSync(process.execPath, [join(HERE, "index-one.mjs"), AGENT, JSON.stringify(entry)], { stdio: "ignore", timeout: 25000 }); return !r.error && r.status === 0; } catch { return false; }
}
function queueIndexFailure(entry) {
  try { mkdirSync(CACHE_DIR, { recursive: true }); const prev = existsSync(INDEX_RETRY_FILE) ? readFileSync(INDEX_RETRY_FILE, "utf8") : ""; writeFileSync(INDEX_RETRY_FILE, prev + JSON.stringify({ agent: AGENT, entry }) + "\n"); } catch {}
}
function drainIndexRetry(max = 25) {
  try {
    if (!existsSync(INDEX_RETRY_FILE)) return;
    const lines = readFileSync(INDEX_RETRY_FILE, "utf8").split("\n").filter(Boolean);
    if (!lines.length) return;
    const keep = []; let done = 0;
    for (const ln of lines) {
      if (done >= max) { keep.push(ln); continue; }
      let row; try { row = JSON.parse(ln); } catch { continue; }
      done++; if (!indexOne(row.entry)) keep.push(ln); // still failing -> requeue
    }
    writeFileSync(INDEX_RETRY_FILE, keep.length ? keep.join("\n") + "\n" : "");
  } catch {}
}

function maybeIndex(entry, shared) {
  if (!shared) return;
  // HYPERAGENT FIX (2026-06-26): under RunWithCredentials a detached/unref'd child is KILLED on return,
  // so fire-and-forget never finishes -> shared facts miss memory-exec until the 6h reindex (invisible
  // to semantic recall / per-prompt pack / company-brain / MCP for up to 6h). On that runtime index
  // SYNCHRONOUSLY (bounded, fail-open) AND drain the retry queue (catch-up). Claude Code (long-lived)
  // keeps the non-blocking detached spawn. RING-SAFE: gated on `shared`.
  const syncIndex = process.env.KB_SYNC_INDEX === "1"
    || process.env.NODE_USE_ENV_PROXY === "1"
    || (process.env.HOME || "").startsWith("/agent");
  if (syncIndex) {
    if (!indexOne(entry)) queueIndexFailure(entry); // #2: queue on failure
    drainIndexRetry();                              // #1: catch-up previously-missed shared entries
  } else {
    try { spawn(process.execPath, [join(HERE, "index-one.mjs"), AGENT, JSON.stringify(entry)], { detached: true, stdio: "ignore" }).unref(); } catch {}
  }
}

// ---- typed ENTITY / current-value layer (Wave 3): answer "what is X NOW?" deterministically. An
//      entity is a normal ledger row (type "entity", {ekey, evalue}), so it rides the SAME write-through
//      cache + share + semantic-index plumbing as every other entry; latest row per key WINS (history is
//      retained via supersedes). normKey collapses casing/punctuation so "iHEARtest Build" == "iheartest
//      _build". An optional alias map (type "alias") points many phrasings at one canonical key. This is
//      a thin keyed VIEW over the flat ledger, NOT a knowledge-graph service.
const normKey = (s) => (s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
function resolveAlias(rows, key) {
  let k = normKey(key); const seen = new Set();
  for (let i = 0; i < 8 && !seen.has(k); i++) {
    seen.add(k);
    const a = rows.filter((r) => r.type === "alias" && r.ekey === k).sort((x, y) => (y.ts || "").localeCompare(x.ts || ""))[0];
    if (!a || !a.evalue || a.evalue === k) break;
    k = a.evalue;
  }
  return k;
}
const currentEntity = (rows, k) => rows.filter((r) => r.type === "entity" && r.ekey === k).sort((x, y) => (y.ts || "").localeCompare(x.ts || ""))[0] || null;

async function entityCmd() {
  const sub = (positional[0] || "").toLowerCase();
  await initStore();
  const rows = await load();
  if (sub === "get") {
    const k = resolveAlias(rows, positional[1] || "");
    if (!k) { console.error('usage: mem.mjs entity get <key> --agent <a>'); process.exit(2); }
    const cur = currentEntity(rows, k);
    if (!cur) { console.log(`(no current value for '${k}' in the ${AGENT} ledger)`); process.exit(0); }
    console.log(`${k} = ${cur.evalue}`);
    console.error(`  [recorded ${(cur.ts || "").slice(0, 10)} id=${cur.id}${cur.source ? ` src=${cur.source}` : ""}${cur.was ? ` was=${cur.was}` : ""}] NB: this is the last RECORDED value; verify against the live source for authoritative state.`);
    return;
  }
  if (sub === "list") {
    const keys = [...new Set(rows.filter((r) => r.type === "entity").map((r) => r.ekey))].sort();
    console.log(`# CURRENT VALUES (${AGENT} ledger) - ${keys.length} entities`);
    for (const k of keys) { const c = currentEntity(rows, k); if (c) console.log(`${k} = ${c.evalue}   [${(c.ts || "").slice(0, 10)} ${c.id}]`); }
    const aliases = rows.filter((r) => r.type === "alias").sort((x, y) => (y.ts || "").localeCompare(x.ts || ""));
    if (aliases.length) { console.log("## aliases"); const seen = new Set(); for (const a of aliases) { if (seen.has(a.ekey)) continue; seen.add(a.ekey); console.log(`${a.ekey} -> ${a.evalue}`); } }
    return;
  }
  if (sub === "alias") {
    const from = normKey(positional[1] || ""), to = normKey(positional[2] || "");
    if (!from || !to) { console.error('usage: mem.mjs entity alias "<from-phrasing>" <to-canonical-key> --agent <a>'); process.exit(2); }
    const entry = { id: newId(rows), ts: new Date().toISOString(), type: "alias", ekey: from, evalue: to, text: `alias ${from} -> ${to}`, tags: TAGS };
    rows.push(entry);
    await putText(JSONL, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "application/x-ndjson");
    writeCacheRows(KEYBASE, rows);
    console.log(`[kb-memory] alias ${from} -> ${to} -> ${AGENT} id=${entry.id}.`);
    return;
  }
  if (sub === "set") {
    const k = resolveAlias(rows, positional[1] || "");
    const value = positional.slice(2).join(" ").trim();
    if (!k || !value) { console.error('usage: mem.mjs entity set <key> "<value>" --agent <a> [--source "..."] [--share]'); process.exit(2); }
    const prev = currentEntity(rows, k);
    const entry = { id: newId(rows), ts: new Date().toISOString(), type: "entity", ekey: k, evalue: value, text: `${k} = ${value}`, tags: TAGS, source: SOURCE || undefined, was: prev ? prev.evalue : undefined, supersedes: prev ? prev.id : undefined };
    rows.push(entry);
    await putText(JSONL, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "application/x-ndjson");
    writeCacheRows(KEYBASE, rows);
    await putText(MD, renderMd(rows), "text/markdown; charset=utf-8");
    let shared = false;
    if (SHARE) shared = await publishShared(AGENT, entry);
    maybeIndex(entry, shared);
    console.log(`[kb-memory] entity ${k} = ${value} -> ${AGENT} id=${entry.id}${prev ? ` (was: ${prev.evalue})` : ""}${shared ? "; shared+indexed" : ""}.`);
    return;
  }
  console.error('usage: mem.mjs entity set <key> "<value>" | get <key> | list | alias "<from>" <to>   --agent <a> [--share]');
  process.exit(2);
}

function matchq(r, terms) { const hay = `${r.type} ${r.text} ${r.was || ""} ${(r.tags || []).join(" ")} ${r.source || ""} ${r.agent || ""}`.toLowerCase(); return terms.every((t) => hay.includes(t)); }
function teamLines(shared) {
  // latest status per agent + recent shared facts/decisions
  const latestStatus = {};
  for (const r of shared) { if (r.type === "status" && !latestStatus[r.agent]) latestStatus[r.agent] = r; }
  return { latestStatus };
}

// ---- pack: the per-prompt WORKING-MEMORY block. LLM-free, local-cache-first (no Azure on the hot
//      path), ranked to the prompt, ring-correct, token-budgeted, with a health beacon. This is what
//      the UserPromptSubmit hook injects every turn so a just-compacted agent gets its durable facts
//      back into context with zero action. Reads the prompt from --stdin-json (UserPromptSubmit JSON;
//      NEVER interpolated through a shell) or --query.
async function runPack() {
  if (!A) { process.stdout.write("<<<WORKING-MEMORY>>>\nMEMORY: OFF (no agent) -> echo <role> > ~/.claude/.kb-agent\n<<<END>>>\n"); return; }
  const kb = A._file || AGENT;
  const THROTTLE = (parseInt(process.env.KB_PACK_THROTTLE_S || "120", 10) || 120) * 1000;
  // own ledger: LOCAL cache fast-path; refresh from Blob only when stale AND the SA exists (no hard exit).
  let rows = readCacheRows(kb), refreshed = false;
  if (!rows || ageMs(cacheFile(kb)) > THROTTLE) {
    if (resolveSaJson()) { try { await initStore(); rows = await load(); writeCacheRows(kb, rows); refreshed = true; } catch { rows = rows || []; } }
    else { rows = rows || []; } // no SA -> stale-local, fail-open (never the saJwt hard exit on the hot path)
  }
  // query terms: UserPromptSubmit stdin JSON (safe parse, no shell interpolation) or --query.
  // Score by term-OVERLAP (not strict AND) so a long natural-language prompt still ranks; drop short
  // words + stopwords so the signal terms drive the match.
  const STOP = new Set("the and for that this with you your our can could should would will does how what why are was were from into about".split(" "));
  let terms = [], rawPrompt = "";
  if (argv.includes("--stdin-json")) {
    try { const j = JSON.parse(readFileSync(0, "utf8")); rawPrompt = `${j.prompt || j.user_prompt || j.message || ""}`; terms = rawPrompt.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); } catch {}
  } else if (QUERY) { rawPrompt = QUERY; terms = QUERY.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }
  terms = [...new Set(terms.filter((t) => t.length >= 3 && !STOP.has(t)))].slice(0, 24);
  const scoreq = (r, ts) => { const hay = `${r.text} ${r.was || ""} ${(r.tags || []).join(" ")} ${r.source || ""}`.toLowerCase(); return ts.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0); }; // NB: exclude r.type so a query word like "status"/"fact" does not inflate every row of that type

  const byNew = (a, b) => (b.ts || "").localeCompare(a.ts || "");
  const active = rows.filter((r) => !rows.some((x) => x.supersedes === r.id)); // drop superseded (newest-wins)
  const pitfalls = active.filter((r) => r.type === "pitfall").sort(byNew).slice(0, 12);
  const decisions = active.filter((r) => r.type === "decision").sort(byNew).slice(0, 6);
  const corrections = rows.filter((r) => r.type === "correction").sort(byNew).slice(0, 5);
  const entities = active.filter((r) => r.type === "entity").sort(byNew).slice(0, 8); // current-values, most-recently-set first
  const always = new Set([...pitfalls, ...decisions, ...corrections, ...entities].map((r) => r.id));
  const ranked = terms.length
    ? active.filter((r) => !always.has(r.id)).map((r) => [r, scoreq(r, terms)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1] || byNew(a[0], b[0])).slice(0, 6).map(([r]) => r)
    : [];
  const rankedIds = new Set(ranked.map((r) => r.id));
  const recent = active.filter((r) => !always.has(r.id) && !rankedIds.has(r.id)).sort(byNew).slice(0, 4);

  // team awareness: latest status per OTHER exec agent, RING-DENY-filtered. Privileged lanes never read it.
  let team = [];
  if (!NO_SHARE.has(AGENT) && resolveSaJson()) {
    let shared = readTeamCache();
    if (!shared || ageMs(TEAM_CACHE) > 300 * 1000) { try { shared = await readSharedAll(); writeTeamCache(shared); } catch { shared = shared || []; } }
    const { latestStatus } = teamLines(shared || []);
    team = Object.keys(latestStatus).filter((a) => a !== AGENT).map((a) => latestStatus[a]).filter(ringSafeCross).slice(0, 8);
  }

  // hot-path SEMANTIC tier: only when the local keyword pack came up THIN (the agent's own ledger did
  // not match the prompt well), reach into the shared exec brain BY MEANING. Thin-triggered + throttled
  // so MOST prompts skip it entirely; ONE bounded read-only call; fail-open to the local pack.
  let semantic = [];
  const SEM_MIN = parseInt(process.env.KB_SEM_MIN || "3", 10) || 3;
  const SEM_THROTTLE = (parseInt(process.env.KB_SEM_THROTTLE_S || "60", 10) || 60) * 1000;
  if (!process.env.KB_SEM_DISABLE && rawPrompt && terms.length >= 2 && ranked.length < SEM_MIN && !NO_SHARE.has(AGENT) && ageMs(SEM_STAMP) > SEM_THROTTLE) {
    const creds = readSemCredsCache();
    if (creds) {
      try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(SEM_STAMP, String(Date.now())); } catch {} // stamp EARLY so a slow/failed call still respects the window
      const excl = new Set([...ranked, ...recent, ...pitfalls, ...decisions, ...corrections, ...entities].map((r) => (r.text || "").slice(0, 40).toLowerCase()));
      semantic = await semanticHits(rawPrompt, creds, excl);
    } else if (resolveSaJson()) spawnSemRefresh(); // not cached -> warm it off the hot path for next time; skip this turn
  }

  // beacon: LIVE only if the ledger is actually readable + non-empty (proves FUNCTION, not just wiring).
  const tss = rows.map((r) => r.ts).filter(Boolean).sort();
  const lastTs = tss[tss.length - 1] || "";
  const ageMin = lastTs ? Math.round((Date.now() - Date.parse(lastTs)) / 60000) : -1;
  const beacon = rows.length
    ? `MEMORY: LIVE agent=${AGENT} | ledger=${rows.length} | last-write=${ageMin >= 0 ? ageMin + "m" : "?"}${refreshed ? " | refreshed" : " | cached"}`
    : `MEMORY: DARK agent=${AGENT} | ledger empty/unreadable -> check ~/.claude/.kb-agent + the service account`;

  // RELEVANT-to-the-prompt goes FIRST (never starved by the always-set), then current-truth, then the
  // recurring-mistake guardrails, then context. Each line is CLIPPED to a cue (the full text is in the
  // ledger; this block is a pointer, not the record).
  const clip = (s, n = 200) => { s = (s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; };
  const L = (r) => `[${r.type}] [${(r.ts || "").slice(0, 10)}] ${clip(r.text)}${r.was ? `  (was: ${clip(r.was, 80)})` : ""}`;
  const out = ["<<<WORKING-MEMORY>>>", beacon];
  if (ranked.length) { out.push("## RELEVANT TO THIS PROMPT:"); for (const r of ranked) out.push(L(r)); }
  if (entities.length) { out.push("## CURRENT VALUES (latest wins; deterministic):"); for (const r of entities) out.push(`- ${r.ekey} = ${clip(r.evalue, 120)}`); }
  if (corrections.length) { out.push("## CORRECTIONS (NOW, not the old belief):"); for (const r of corrections) out.push(`- NOW: ${clip(r.text)}${r.was ? `  (was: ${clip(r.was, 80)})` : ""}`); }
  if (pitfalls.length) { out.push("## PITFALLS (do not repeat):"); for (const r of pitfalls) out.push(`- ${clip(r.text)}`); }
  if (decisions.length) { out.push("## DECISIONS (current):"); for (const r of decisions) out.push(`- ${clip(r.text)}`); }
  if (recent.length) { out.push("## RECENT:"); for (const r of recent) out.push(L(r)); }
  if (semantic.length) { out.push("## RELATED (shared brain, by meaning):"); for (const r of semantic) out.push(`- [${r.agent}/${r.type}] ${clip(r.text, 140)}`); }
  if (team.length) { out.push("## TEAM (other agents, latest status):"); for (const r of team) out.push(`- [${r.agent}] ${clip(r.text, 120)}`); }

  // hard char budget: keep the front (beacon + pitfalls), trim trailing sections so the block can never
  // itself bloat the freshly-compacted window. ~4800 chars ≈ ~1200 tokens.
  const BUDGET = parseInt(process.env.KB_PACK_BUDGET || "4800", 10) || 4800;
  let body = out.join("\n");
  if (body.length > BUDGET) { const cut = body.lastIndexOf("\n", BUDGET); body = body.slice(0, cut > 0 ? cut : BUDGET); }
  process.stdout.write(body + "\n<<<END>>>\n");
}

(async () => {
  if (["remember", "fact"].includes(cmd)) return append("fact", SHARE);
  if (cmd === "decision") return append("decision", SHARE);
  if (cmd === "pitfall") return append("pitfall", SHARE);
  if (cmd === "status") return append("status", true);
  if (cmd === "correct") { if (!WAS) console.error("(tip: pass --was \"<wrong belief>\" so the correction records what to stop believing)"); return append("correction", SHARE); }
  if (cmd === "index-catchup") { drainIndexRetry(200); console.log("[kb-memory] index-catchup: drained the write-through index retry queue"); return; }
  if (cmd === "entity") return entityCmd();
  if (cmd === "list-agents") { for (const [k, v] of Object.entries(AGENTS)) console.log(`${k.padEnd(14)} ${v.account}/${v.container}  [${v.ring}]`); console.log(`exec team: ${EXEC.join(", ")}`); return; }
  if (cmd === "use") {
    const who = (positional[0] || AGENT || "").toLowerCase();
    if (!who) { console.error("usage: mem.mjs use <role>   (cfo | clo | coo | cto | ...)"); process.exit(2); }
    mkdirSync(`${homedir()}/.claude`, { recursive: true });
    writeFileSync(`${homedir()}/.claude/.kb-agent`, who + "\n");
    console.log(`identity claimed: this session's memory is homed to '${who}'. Verify: node ${process.argv[1]} whoami --agent ${who}`);
    return;
  }
  if (cmd === "whoami") {
    const read1 = (p) => { try { return existsSync(p) ? readFileSync(p, "utf8").trim().split(/\s+/)[0] : ""; } catch { return ""; } };
    const sessMark = read1(`${homedir()}/.claude/.kb-agent`);
    const repoMark = read1(`${process.env.CLAUDE_PROJECT_DIR || "."}/.kb-agent`);
    const envAg = (process.env.KB_AGENT || "").trim();
    const resolved = sessMark || repoMark || envAg;
    const src = sessMark ? "session marker (~/.claude/.kb-agent)" : repoMark ? "repo .kb-agent" : envAg ? "env KB_AGENT" : "(none)";
    const saOk = !!resolveSaJson();
    console.log("# kb-memory whoami");
    console.log(`resolved identity (the hooks use this): ${resolved || "(NONE - auto-recall OFF)"}  [via ${src}]`);
    if (sessMark && envAg && sessMark !== envAg) console.log(`note: session marker '${sessMark}' overrides shared env KB_AGENT '${envAg}' (correct when agents share one environment).`);
    console.log(`service-account: ${saOk ? "present" : "MISSING - writes will fail"}`);
    if (!AGENT) { console.log(resolved ? `tip: run 'whoami --agent ${resolved}' to probe its ledger, or 'use <role>' to claim.` : "RESULT: FAIL - no identity. Run 'mem.mjs use <role>' then re-run."); return; }
    if (resolved && resolved !== AGENT) console.log(`WARNING: this session resolves to '${resolved}', not '${AGENT}'. Claim it: mem.mjs use ${AGENT}`);
    try {
      await initStore();
      const rows = await load();
      const last = rows[rows.length - 1];
      console.log(`ledger '${AGENT}' (${A.ring}): ${rows.length} entries; latest ${last ? `[${(last.ts || "").slice(0, 10)}] ${last.text.slice(0, 80)}` : "(empty)"}`);
      const ok = saOk && resolved === AGENT;
      console.log(`RESULT: ${ok ? `PASS - memory is ON and homed to '${AGENT}' (${rows.length} entries)` : `NEEDS-FIX (SA=${saOk}, resolved='${resolved || "none"}', expected '${AGENT}')`}`);
    } catch (e) { console.log(`RESULT: FAIL - cannot reach the '${AGENT}' ledger: ${e.message}`); }
    return;
  }
  if (cmd === "pack") return runPack();
  if (cmd === "sem-refresh") {
    // warm the hot-path semantic cred-cache (read-only query key + search endpoint) OFF the prompt path,
    // so the per-prompt semantic tier never resolves Secret Manager inline. Fail-open, mode 0600.
    try {
      const ep = (await sm("azure-search-endpoint") || "").replace(/\/$/, "");
      const qk = await sm("azure-search-query-key");
      if (ep && qk) { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(SEM_CRED_FILE, JSON.stringify({ searchEp: ep, queryKey: qk, ts: Date.now() })); try { chmodSync(SEM_CRED_FILE, 0o600); } catch {} console.error("[kb-memory] semantic cred-cache refreshed"); }
    } catch {}
    return;
  }
  if (cmd === "team-health") {
    // Operator-visible cross-agent memory health: per exec agent, how long since they last shared
    // anything (a proxy for "is this agent's memory live + active"). Feeds the COO daily brief so Matt
    // sees a green/red line per agent. --json for machine consumption (the brief / a PostHog emit).
    let shared = [];
    try { shared = await readSharedAll(); } catch (e) { console.log("team-health: shared feed unavailable (" + e.message + ")"); return; }
    const now = Date.now();
    const lastBy = {}, statusBy = {};
    for (const r of shared) {
      if (!lastBy[r.agent] || (r.ts || "") > lastBy[r.agent]) lastBy[r.agent] = r.ts || "";
      if (r.type === "status" && (!statusBy[r.agent] || (r.ts || "") > (statusBy[r.agent].ts || ""))) statusBy[r.agent] = r;
    }
    const STALE = parseInt(process.env.KB_HEALTH_STALE_MIN || "1440", 10) || 1440; // LIVE if shared within 24h
    const rows = EXEC.map((a) => {
      const ts = lastBy[a];
      const ageMin = ts ? Math.round((now - Date.parse(ts)) / 60000) : null;
      return { agent: a, status: ageMin === null ? "NO-DATA" : ageMin <= STALE ? "LIVE" : "STALE", last_shared_age_min: ageMin, working_on: (statusBy[a]?.text || "").replace(/\s+/g, " ").slice(0, 90) || null };
    });
    if (argv.includes("--json")) { console.log(JSON.stringify(rows)); return; }
    const age = (m) => m === null ? "no shared activity" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
    console.log(`# EXEC MEMORY HEALTH (last shared activity per agent; LIVE = within ${Math.round(STALE / 60)}h)`);
    for (const r of rows) console.log(`[${(r.status === "LIVE" ? "LIVE " : r.status === "STALE" ? "STALE" : "  -  ")}] ${r.agent.padEnd(11)} ${age(r.last_shared_age_min).padEnd(18)}${r.working_on ? "  " + r.working_on : ""}`);
    return;
  }
  if (cmd === "team") {
    const shared = await readSharedAll();
    const { latestStatus } = teamLines(shared);
    console.log(`# EXEC TEAM feed - what every agent is working on + shared facts (${shared.length} shared entries)`);
    console.log("## CURRENT STATUS (latest per agent):");
    for (const ag of Object.keys(latestStatus).sort()) { const r = latestStatus[ag]; console.log(`- [${ag}] [${(r.ts || "").slice(0, 10)}] ${r.text}`); }
    console.log("## RECENT SHARED (facts / decisions / status, newest first):");
    for (const r of shared.slice(0, N)) console.log(`[${r.agent}] [${r.type}] [${(r.ts || "").slice(0, 10)}] ${r.text}`);
    return;
  }
  if (!A) { console.error("need --agent <cfo|clo|clo-personal|commons|...>"); process.exit(2); }
  await initStore();
  const rows = await load();
  if (cmd === "render") { await putText(MD, renderMd(rows), "text/markdown; charset=utf-8"); console.log(`rendered ${MD} (${rows.length} entries)`); return; }
  if (cmd === "recall") {
    const terms = TEXT.toLowerCase().split(/\s+/).filter(Boolean);
    const own = rows.filter((r) => matchq(r, terms)).sort((a, b) => (b.ts || "").localeCompare(a.ts || "")).slice(0, N);
    let team = [];
    try { team = (await readSharedAll()).filter((r) => r.agent !== AGENT && matchq(r, terms)).slice(0, N); } catch {}
    console.log(`# recall "${TEXT}" @ ${AGENT} - ${own.length} in your lane, ${team.length} in the team feed`);
    console.log("## YOUR LANE:"); for (const r of own) console.log(`[${r.type}] [${(r.ts || "").slice(0, 10)}] ${r.text}${r.was ? `  (was: ${r.was})` : ""}  \`${r.id}\``);
    console.log("## TEAM:"); for (const r of team) console.log(`[${r.agent}] [${r.type}] [${(r.ts || "").slice(0, 10)}] ${r.text}`);
    return;
  }
  if (cmd === "tail") {
    const pit = rows.filter((r) => r.type === "pitfall");
    const rest = rows.filter((r) => r.type !== "pitfall").sort((a, b) => (b.ts || "").localeCompare(a.ts || "")).slice(0, N);
    console.log(`# ${AGENT} ledger + TEAM view (source of truth)`);
    console.log(`## YOUR PITFALLS (${pit.length}, do not repeat):`); for (const r of pit) console.log(`- ${r.text}  \`${r.id}\``);
    console.log("## YOUR RECENT (facts / decisions / status / corrections):"); for (const r of rest.slice().reverse()) console.log(`[${r.type}] [${(r.ts || "").slice(0, 10)}] ${r.text}${r.was ? `  (was: ${r.was})` : ""}`);
    try {
      const shared = await readSharedAll();
      const { latestStatus } = teamLines(shared);
      const others = Object.keys(latestStatus).filter((a) => a !== AGENT).sort();
      console.log("## TEAM - company-wide, what every OTHER exec agent is working on (latest status):");
      if (!others.length) console.log("- (no team status published yet)");
      for (const ag of others) { const r = latestStatus[ag]; console.log(`- [${ag}] [${(r.ts || "").slice(0, 10)}] ${r.text}`); }
      const recentShared = shared.filter((r) => r.agent !== AGENT && r.type !== "status").slice(0, 10);
      if (recentShared.length) { console.log("## TEAM - recent shared facts/decisions:"); for (const r of recentShared) console.log(`[${r.agent}] [${r.type}] ${r.text}`); }
    } catch (e) { console.log("## TEAM - (feed unavailable: " + e.message + ")"); }
    return;
  }
  console.error("verbs: remember | decision | correct | pitfall | status | entity | recall | tail | team | render | whoami | use | list-agents");
  process.exit(2);
})().catch((e) => { console.error("ERROR: " + e.message); process.exit(1); });
