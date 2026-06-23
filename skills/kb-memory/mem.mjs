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
//   recall   "<query>"  --agent cfo [--n 25]    # searches YOUR lane + the shared TEAM feed
//   tail     --agent cfo [--n 40]               # YOUR pitfalls/recent + the TEAM feed (company-wide)
//   team     [--agent x] [--n 60]               # the whole exec team feed: who is working on what
//   render   --agent cfo  |  list-agents
import crypto from "node:crypto";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

const SM = "otchealth-shared-prod";
const AGENTS = {
  cfo:            { account: "otchealthcfodata",    accountSecret: "azure-cfo-storage-account",    keySecret: "azure-cfo-storage-key",    container: "cfo-source-docs", ring: "finance (MNPI/private)" },
  clo:            { account: "otchealthlegalstore", accountSecret: "azure-legal-storage-account",  keySecret: "azure-legal-storage-key",  container: "company",         ring: "legal company (privileged)" },
  "clo-personal": { account: "otchealthlegalstore", accountSecret: "azure-legal-storage-account",  keySecret: "azure-legal-storage-key",  container: "personal",        ring: "legal PERSONAL (privileged + confidential, segregated)" },
  commons:        { account: "otchealthcommons",    accountSecret: "azure-commons-storage-account", keySecret: "azure-commons-storage-key", container: "company-journal", ring: "fleet commons (shared)" },
};
// The executive team: agents whose status + shared facts flow into the connected team feed. Any agent
// can publish/read; this set is documentation + the default `team` roster.
const EXEC = ["coo", "cfo", "clo", "cto", "capital", "commerce", "compliance", "rainmaker", "growth"];
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
async function getText(name) { const r = await fetch(url(name)); if (r.status === 404) return null; if (!r.ok) throw new Error("get " + r.status); return await r.text(); }
async function putText(name, body, ct) { const r = await fetch(url(name), { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": ct || "text/plain; charset=utf-8" }, body }); if (!r.ok) throw new Error("put " + r.status + " " + (await r.text()).slice(0, 160)); }

// --- the shared EXEC team feed (commons; one file per agent => no cross-agent clobber) ---
const C = AGENTS.commons;
const SHARED_PREFIX = "_MEMORY/_exec/";
let C_ACCT, C_SAS;
async function commonsInit() { if (C_ACCT) return; C_ACCT = process.env.KB_COMMONS_ACCOUNT || C.account || (await sm(C.accountSecret)); const k = await sm(C.keySecret); if (!C_ACCT || !k) throw new Error("commons creds missing"); C_SAS = buildSas(C_ACCT, k); }
const cUrl = (name) => `https://${C_ACCT}.blob.core.windows.net/${C.container}/${encPath(name)}?${C_SAS}`;
async function cGet(name) { const r = await fetch(cUrl(name)); if (r.status === 404) return null; if (!r.ok) throw new Error("cget " + r.status); return await r.text(); }
async function cPut(name, body) { const r = await fetch(cUrl(name), { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": "application/x-ndjson" }, body }); if (!r.ok) throw new Error("cput " + r.status + " " + (await r.text()).slice(0, 160)); }
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

async function load() { const t = await getText(JSONL); if (!t) return []; return t.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
function newId(rows) { const d = new Date().toISOString().slice(0, 10).replace(/-/g, ""); const n = rows.filter((r) => (r.id || "").startsWith(d)).length + 1; return `${d}-${String(n).padStart(3, "0")}`; }

function renderMd(rows) {
  const fmt = (r) => `- [${(r.ts || "").slice(0, 10)}] ${r.text}${r.tags && r.tags.length ? `  _(#${r.tags.join(" #")})_` : ""}${r.source ? `  - ${r.source}` : ""}  \`${r.id}\``;
  const active = rows.filter((r) => !rows.some((x) => x.supersedes === r.id));
  const sortNew = (a, b) => (b.ts || "").localeCompare(a.ts || "");
  const sec = (t) => active.filter((r) => r.type === t).sort(sortNew);
  const pit = sec("pitfall"), dec = sec("decision"), fac = sec("fact"), sta = sec("status"), cor = rows.filter((r) => r.type === "correction").sort(sortNew);
  let md = `# ${KEYBASE.toUpperCase()} Memory Ledger\n\n`;
  md += `> SOURCE OF TRUTH. Read this; do not trust in-session recall. Append-only, dated, newest-wins.\n`;
  md += `> Updated ${new Date().toISOString()} - ${rows.length} entries (${pit.length} pitfalls, ${dec.length} decisions, ${fac.length} facts, ${sta.length} status, ${cor.length} corrections).\n\n`;
  md += `## PITFALLS - common mistakes / incorrect beliefs the AI keeps forming. DO NOT REPEAT.\n` + (pit.length ? pit.map(fmt).join("\n") : "- (none yet)") + "\n\n";
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
  await putText(MD, renderMd(rows), "text/markdown; charset=utf-8");
  let shared = false;
  if (share || type === "status") shared = await publishShared(AGENT, entry);
  console.log(`[kb-memory] ${type} -> ${AGENT} (${A.ring}) id=${entry.id}. Private ledger ${rows.length} entries${shared ? "; PUBLISHED to exec team feed" : ""}.`);
}

function matchq(r, terms) { const hay = `${r.type} ${r.text} ${r.was || ""} ${(r.tags || []).join(" ")} ${r.source || ""} ${r.agent || ""}`.toLowerCase(); return terms.every((t) => hay.includes(t)); }
function teamLines(shared) {
  // latest status per agent + recent shared facts/decisions
  const latestStatus = {};
  for (const r of shared) { if (r.type === "status" && !latestStatus[r.agent]) latestStatus[r.agent] = r; }
  return { latestStatus };
}

(async () => {
  if (["remember", "fact"].includes(cmd)) return append("fact", SHARE);
  if (cmd === "decision") return append("decision", SHARE);
  if (cmd === "pitfall") return append("pitfall", SHARE);
  if (cmd === "status") return append("status", true);
  if (cmd === "correct") { if (!WAS) console.error("(tip: pass --was \"<wrong belief>\" so the correction records what to stop believing)"); return append("correction", SHARE); }
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
  console.error("verbs: remember | decision | correct | pitfall | status | recall | tail | team | render | whoami | use | list-agents");
  process.exit(2);
})().catch((e) => { console.error("ERROR: " + e.message); process.exit(1); });
