#!/usr/bin/env node
// kb-memory — durable, append-only WORKING MEMORY for agents. Defeats context-window compaction:
// facts / decisions / corrections / pitfalls are externalized the INSTANT they are stated, and
// re-read on wake, so the chat window is disposable and nothing established is lost or silently
// changed. Per-agent and RING-CORRECT (the ledger co-locates inside the agent's own store, so its
// access control applies). Dependency-free; self-resolves creds from Secret Manager via the
// claude-driver SA (GCP_CLAUDE_DRIVER_SA_JSON), exactly like doc-indexer.
//
// THE MODEL: the ledger is the source of truth; recall by READING it, never by trusting in-session
// memory. Append-only + temporal supersession: corrections never delete the old fact, they record
// "WAS x -> NOW y" so the history is intact (you can see how a fact changed). PITFALLS capture the
// recurring WRONG beliefs the AI keeps forming, so they are corrected at the source.
//
// Verbs:
//   remember "<fact>"            --agent cfo [--tags a,b] [--source "Matt 2026-06-19"]
//   decision "<decision made>"   --agent cfo [...]
//   correct  "<the CORRECT fact>" --agent cfo --was "<the wrong belief>" [--supersedes <id>]
//   pitfall  "<recurring mistake + the truth + the rule>" --agent cfo     # do/don't, known AI error
//   recall   "<query>"           --agent cfo [--n 25]
//   tail     --agent cfo [--n 40]        # ALL pitfalls + recent decisions/facts/corrections (wake read)
//   render   --agent cfo                 # re-render the human-readable ledger .md
//   list-agents
//
// Agents (ring-routed). Unknown agents fall back to the fleet commons namespace.
import crypto from "node:crypto";

const SM = "otchealth-shared-prod";
const AGENTS = {
  cfo:            { account: "otchealthcfodata",    accountSecret: "azure-cfo-storage-account",    keySecret: "azure-cfo-storage-key",    container: "cfo-source-docs", ring: "finance (MNPI/private)" },
  clo:            { account: "otchealthlegalstore", accountSecret: "azure-legal-storage-account",  keySecret: "azure-legal-storage-key",  container: "company",         ring: "legal company (privileged)" },
  "clo-personal": { account: "otchealthlegalstore", accountSecret: "azure-legal-storage-account",  keySecret: "azure-legal-storage-key",  container: "personal",        ring: "legal PERSONAL (privileged + confidential, segregated)" },
  commons:        { account: "otchealthcommons",    accountSecret: "azure-commons-storage-account", keySecret: "azure-commons-storage-key", container: "company-journal", ring: "fleet commons (shared)" },
};

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
const N = parseInt(takeVal("--n", "40"), 10) || 40;

// ---- Secret Manager (claude-driver SA) ----
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

// ---- Azure Blob (account SAS, like doc-indexer) ----
let ACCT, AKEY, AZ_SAS;
const encPath = (name) => name.split("/").map(encodeURIComponent).join("/");
function buildAzSas() {
  const sv = "2021-12-02", sp = "rwlc", ss = "b", srt = "co";
  const st = new Date(Date.now() - 5 * 60000).toISOString().slice(0, 19) + "Z";
  const se = new Date(Date.now() + 12 * 3600 * 1000).toISOString().slice(0, 19) + "Z";
  const sts = [ACCT, sp, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n";
  const sig = crypto.createHmac("sha256", Buffer.from(AKEY, "base64")).update(sts, "utf8").digest("base64");
  return new URLSearchParams({ sv, ss, srt, sp, st, se, spr: "https", sig }).toString();
}
let KEYBASE, JSONL, MD;
async function initStore() {
  if (!A) { console.error("need --agent <cfo|clo|clo-personal|commons|...>"); process.exit(2); }
  ACCT = process.env.KB_ACCOUNT || A.account || (await sm(A.accountSecret));
  AKEY = process.env.KB_KEY || (await sm(A.keySecret));
  if (!ACCT || !AKEY) { console.error(`Missing storage creds for agent '${AGENT}' (account ${A.account}, key secret ${A.keySecret}).`); process.exit(2); }
  AZ_SAS = buildAzSas();
  KEYBASE = A._file || AGENT;          // commons fallback uses the raw agent name as the file
  JSONL = `_MEMORY/${KEYBASE}.jsonl`;
  MD = `_MEMORY/${KEYBASE}.md`;
}
const url = (name) => `https://${ACCT}.blob.core.windows.net/${A.container}/${encPath(name)}?${AZ_SAS}`;
async function getText(name) { const r = await fetch(url(name)); if (r.status === 404) return null; if (!r.ok) throw new Error("get " + r.status); return await r.text(); }
async function putText(name, body, ct) { const r = await fetch(url(name), { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": ct || "text/plain; charset=utf-8" }, body }); if (!r.ok) throw new Error("put " + r.status + " " + (await r.text()).slice(0, 160)); }

async function load() { const t = await getText(JSONL); if (!t) return []; return t.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
function newId(rows) { const d = new Date().toISOString().slice(0, 10).replace(/-/g, ""); const n = rows.filter((r) => (r.id || "").startsWith(d)).length + 1; return `${d}-${String(n).padStart(3, "0")}`; }

function renderMd(rows) {
  const fmt = (r) => `- [${(r.ts || "").slice(0, 10)}] ${r.text}${r.tags && r.tags.length ? `  _(#${r.tags.join(" #")})_` : ""}${r.source ? `  - ${r.source}` : ""}  \`${r.id}\``;
  const active = rows.filter((r) => !rows.some((x) => x.supersedes === r.id)); // hide facts that were later superseded
  const pit = active.filter((r) => r.type === "pitfall");
  const dec = active.filter((r) => r.type === "decision");
  const fac = active.filter((r) => r.type === "fact");
  const cor = rows.filter((r) => r.type === "correction");
  const sortNew = (a, b) => (b.ts || "").localeCompare(a.ts || "");
  let md = `# ${KEYBASE.toUpperCase()} Memory Ledger\n\n`;
  md += `> SOURCE OF TRUTH. Read this; do not trust in-session recall. Append-only, dated, newest-wins.\n`;
  md += `> Updated ${new Date().toISOString()} - ${rows.length} entries (${pit.length} pitfalls, ${dec.length} decisions, ${fac.length} facts, ${cor.length} corrections).\n\n`;
  md += `## PITFALLS - common mistakes / incorrect beliefs the AI keeps forming. DO NOT REPEAT.\n`;
  md += (pit.length ? pit.sort(sortNew).map(fmt).join("\n") : "- (none yet)") + "\n\n";
  md += `## DECISIONS (what we decided, and why)\n`;
  md += (dec.length ? dec.sort(sortNew).map(fmt).join("\n") : "- (none yet)") + "\n\n";
  md += `## FACTS (established, current)\n`;
  md += (fac.length ? fac.sort(sortNew).map(fmt).join("\n") : "- (none yet)") + "\n\n";
  md += `## CORRECTIONS (history - what was wrong vs what is right; old is retained on purpose)\n`;
  md += (cor.length ? cor.sort(sortNew).map((r) => `- [${(r.ts || "").slice(0, 10)}] WAS: ${r.was || "?"}  ->  NOW: ${r.text}${r.source ? `  - ${r.source}` : ""}  \`${r.id}\``).join("\n") : "- (none yet)") + "\n";
  return md;
}

async function append(type) {
  if (!TEXT) { console.error(`need text: mem.mjs ${type} "<text>" --agent <a>`); process.exit(2); }
  await initStore();
  const rows = await load();
  const entry = { id: newId(rows), ts: new Date().toISOString(), type, text: TEXT, tags: TAGS, source: SOURCE || undefined, was: WAS || undefined, supersedes: SUPERSEDES || undefined };
  rows.push(entry);
  await putText(JSONL, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "application/x-ndjson");
  await putText(MD, renderMd(rows), "text/markdown; charset=utf-8");
  console.log(`[kb-memory] ${type} -> ${AGENT} (${A.ring}) id=${entry.id}. Ledger now ${rows.length} entries. md=${MD}`);
}

function matchq(r, terms) { const hay = `${r.type} ${r.text} ${r.was || ""} ${(r.tags || []).join(" ")} ${r.source || ""}`.toLowerCase(); return terms.every((t) => hay.includes(t)); }

(async () => {
  if (["remember", "fact"].includes(cmd)) return append("fact");
  if (cmd === "decision") return append("decision");
  if (cmd === "pitfall") return append("pitfall");
  if (cmd === "correct") { if (!WAS) console.error("(tip: pass --was \"<wrong belief>\" so the correction records what to stop believing)"); return append("correction"); }
  if (cmd === "list-agents") { for (const [k, v] of Object.entries(AGENTS)) console.log(`${k.padEnd(14)} ${v.account}/${v.container}  [${v.ring}]`); return; }
  if (!A) { console.error("need --agent <cfo|clo|clo-personal|commons|...>"); process.exit(2); }
  await initStore();
  const rows = await load();
  if (cmd === "render") { await putText(MD, renderMd(rows), "text/markdown; charset=utf-8"); console.log(`rendered ${MD} (${rows.length} entries)`); return; }
  if (cmd === "recall") {
    const terms = TEXT.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = rows.filter((r) => matchq(r, terms)).sort((a, b) => (b.ts || "").localeCompare(a.ts || "")).slice(0, N);
    console.log(`# recall "${TEXT}" @ ${AGENT} - ${hits.length} hit(s)`);
    for (const r of hits) console.log(`[${r.type}] [${(r.ts || "").slice(0, 10)}] ${r.text}${r.was ? `  (was: ${r.was})` : ""}${r.source ? `  - ${r.source}` : ""}  \`${r.id}\``);
    return;
  }
  if (cmd === "tail") {
    const pit = rows.filter((r) => r.type === "pitfall");
    const rest = rows.filter((r) => r.type !== "pitfall").sort((a, b) => (b.ts || "").localeCompare(a.ts || "")).slice(0, N);
    console.log(`# ${AGENT} ledger - ALL ${pit.length} pitfalls + ${rest.length} recent entries (source of truth)`);
    console.log("## PITFALLS (do not repeat):");
    for (const r of pit) console.log(`- ${r.text}  \`${r.id}\``);
    console.log("## RECENT:");
    for (const r of rest.reverse()) console.log(`[${r.type}] [${(r.ts || "").slice(0, 10)}] ${r.text}${r.was ? `  (was: ${r.was})` : ""}`);
    return;
  }
  console.error("verbs: remember | decision | correct | pitfall | recall | tail | render | list-agents");
  process.exit(2);
})().catch((e) => { console.error("ERROR: " + e.message); process.exit(1); });
