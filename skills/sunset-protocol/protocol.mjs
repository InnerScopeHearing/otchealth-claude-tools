#!/usr/bin/env node
// SUNSET / SUNRISE TRANSFER PROTOCOL — hardened cross-engine consciousness transfer for the fleet.
//
// Matt's ask: one phrase spins an agent DOWN on one engine (Claude Code), another phrase spins it UP
// on the other (Hyperagent) fully self-updated. The brain is already durable + engine-agnostic (Azure
// ledgers + memory-exec), so "transfer" = FLUSH-then-ATTACH, not a migration of state.
//
//   SUNSET  (spin down): snapshot the agent into a PORTABLE, RING-SAFE handoff doc in the shared commons
//           (_HANDOFF/<role>.md) so the seat survives the blackout. Then the agent says "Goodnight friend".
//   SUNRISE (spin up):   verify attach (memory PASS + brain reachable), read the handoff, compute the
//           LAST 3 workstreams from the live ledger (in-session, ring-correct), then the agent greets
//           "I am fully updated and ready to go, Sir." and asks which of the 3 to work on.
//
// RING SAFETY (load-bearing): the commons-stored handoff doc is PROCEDURE + COUNTS + POINTERS only, never
// raw ledger text — a CFO ledger is MNPI, a CLO ledger is privileged. last3 reads the agent's OWN ledger
// and is only ever shown in that agent's OWN session to the principal. Procedure travels; content stays home.
//
// Verbs:
//   node protocol.mjs sunset  --agent <role> [--repo-path <dir>]   # one agent down (writes commons doc + audit)
//   node protocol.mjs sunset-fleet [--roles a,b,c]                 # ALL agents down, NO sessions needed (Tier-1)
//   node protocol.mjs sunrise --agent <role>                       # one agent up: attach check + handoff + last3
//   node protocol.mjs last3   --agent <role> [--json]              # the 3 most recent distinct workstreams
//
// Fail-open on every read path so it can never break a session or a cron job.
import crypto from "node:crypto";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SM = "otchealth-shared-prod";
const COMMONS = { accountSecret: "azure-commons-storage-account", keySecret: "azure-commons-storage-key", container: "company-journal" };
const MEM_PREFIX = "_MEMORY/";
const HANDOFF_PREFIX = "_HANDOFF/";
const DISPATCH_PREFIX = "_DISPATCH/";

// The full roster a fleet sunset covers (exec + cash + product). Source of truth for cards: dream-team/agents/*.md.
const ROSTER = ["cto", "cfo", "clo", "coo", "developer", "commerce", "rainmaker", "lifecycle", "switchboard", "capital", "growth", "guardian", "medic"];
// Rings: SENSITIVE ledgers never have their text embedded in a commons-stored doc.
const SENSITIVE = new Set(["cfo", "clo", "clo-personal", "capital"]);

const argv = process.argv.slice(2);
const cmd = argv[0];
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FLAG = (f) => argv.includes(f);

function resolveSa() {
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) return process.env.GCP_CLAUDE_DRIVER_SA_JSON;
  try { return readFileSync(`${homedir()}/.gcp_claude_driver_sa.json`, "utf8"); } catch { return null; }
}
const _saRaw = resolveSa();
function saJwt() { const sa = JSON.parse(_saRaw); const n = Math.floor(Date.now() / 1e3), e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"); const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: n, exp: n + 3600 })}`; return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url"); }
async function sm(id) { const t = (await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt())}` })).json()).access_token; const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: "Bearer " + t } }); return r.ok ? Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim() : null; }

// Commons blob (account SAS, rwl so sunset can write the handoff doc).
const encPath = (name) => name.split("/").map(encodeURIComponent).join("/");
function buildSas(acct, key, write) { const sv = "2021-12-02", sp = write ? "rwlc" : "rl", ss = "b", srt = "co"; const st = new Date(Date.now() - 5 * 60000).toISOString().slice(0, 19) + "Z"; const se = new Date(Date.now() + 12 * 3600 * 1000).toISOString().slice(0, 19) + "Z"; const sts = [acct, sp, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n"; const sig = crypto.createHmac("sha256", Buffer.from(key, "base64")).update(sts, "utf8").digest("base64"); return new URLSearchParams({ sv, ss, srt, sp, st, se, spr: "https", sig }).toString(); }
let CA, CSAS;
async function commonsInit(write) { CA = process.env.KB_COMMONS_ACCOUNT || (await sm(COMMONS.accountSecret)); const k = await sm(COMMONS.keySecret); if (!CA || !k) throw new Error("commons creds missing"); CSAS = buildSas(CA, k, write); }
const cUrl = (name) => `https://${CA}.blob.core.windows.net/${COMMONS.container}/${encPath(name)}?${CSAS}`;
async function fetchRetry(url, opts, tries = 4) { let last; for (let i = 0; i < tries; i++) { try { const r = await fetch(url, opts); if (r.status === 404) return r; if (r.ok || (r.status < 500 && r.status !== 408 && r.status !== 429 && r.status !== 403)) return r; last = new Error("http " + r.status); } catch (e) { last = e; } await new Promise((s) => setTimeout(s, 400 * Math.pow(2, i))); } throw last || new Error("fetch failed"); }
async function cGet(name) { const r = await fetchRetry(cUrl(name)); if (r.status === 404) return null; if (!r.ok) throw new Error("cget " + r.status); return await r.text(); }
async function cPut(name, body) { const r = await fetchRetry(cUrl(name), { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": "text/markdown" }, body }); if (!r.ok) throw new Error("cput " + r.status); }

const fromNd = (t) => (t || "").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// --- read an agent's ledger + open dispatch count (for counts/last3) ---
async function readLedger(agent) { return fromNd(await cGet(`${MEM_PREFIX}${agent}.jsonl`)); }
async function openDispatchCount(agent) { try { return fromNd(await cGet(`${DISPATCH_PREFIX}${agent}.jsonl`)).length; } catch { return 0; } }

// last3: the 3 most recent DISTINCT workstreams. Prefer decisions/status (intent) over raw facts; dedupe by topic.
function computeLast3(rows) {
  const meaningful = rows.filter((r) => ["decision", "status", "fact", "correction", "correct"].includes(r.type));
  const out = [], seen = new Set();
  for (let i = meaningful.length - 1; i >= 0 && out.length < 3; i--) {
    const r = meaningful[i];
    const raw = (r.text || "").trim();
    const firstSentence = raw.split(/(?<=[.:;])\s/)[0];
    // prefer the first sentence, but if it is too short (e.g. "BROADCAST SENT:"), take a fuller slice
    const title = (firstSentence.length >= 30 ? firstSentence : raw.slice(0, 110)).slice(0, 140).trim();
    const key = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").slice(0, 6).join(" ");
    if (seen.has(key)) continue; seen.add(key);
    out.push({ ts: (r.ts || "").slice(0, 10), type: r.type, title, tags: r.tags || [], id: r.id });
  }
  return out;
}

// The PORTABLE, RING-SAFE handoff doc body. Procedure + counts + pointers. Embeds ledger TEXT only for
// non-sensitive roles (and even then only short titles); sensitive roles get counts + "read your ledger live".
function renderHandoff(agent, rows, openDisp) {
  const sensitive = SENSITIVE.has(agent);
  const decisions = rows.filter((r) => r.type === "decision").length;
  const corrections = rows.filter((r) => r.type === "correction" || r.type === "correct").length;
  const pitfalls = rows.filter((r) => r.type === "pitfall").length;
  const entities = rows.filter((r) => r.type === "entity").length;
  const stamp = (rows[rows.length - 1]?.ts || "").slice(0, 16).replace("T", " ");
  let recent = "";
  if (!sensitive) {
    const last3 = computeLast3(rows);
    recent = last3.length
      ? "\n## Last worked on (titles only; read the live ledger for detail)\n" + last3.map((x, i) => `${i + 1}. [${x.ts}] ${x.title}`).join("\n") + "\n"
      : "";
  } else {
    recent = "\n## Last worked on\nRING-PROTECTED (this is a " + (agent === "clo" ? "privileged" : "MNPI/financial") + " lane). Not reproduced in the shared commons. On wake, read your OWN ledger in-session: `mem.mjs pack --agent " + agent + "`.\n";
  }
  const ringLine = sensitive
    ? (agent === "clo" ? "PRIVILEGED + personal-segregated. Company vs PERSONAL matters never co-mingled; clo-personal is NEVER shared. Nothing privileged in this doc." : "MNPI / financial / securities-firewalled. INND content internal-only. Nothing sensitive in this doc.")
    : "Non-PHI ring. Never touch MedReview/FourVault PHI surfaces, data, or credentials.";
  return `# SUNRISE HANDOFF - ${agent.toUpperCase()}  (Sunset Transfer Protocol)

> Auto-generated by the Sunset Transfer Protocol. PORTABLE + RING-SAFE: procedure and pointers only,
> no sensitive ledger content. Your real brain is the durable ledger + company-brain; ATTACH to it.
> Last sunset snapshot: ${stamp || "n/a"} UTC.

## Who you are
You are the **${agent.toUpperCase()}** agent for OTCHealth Inc. and InnerScope (OTC: INND), running on
Hyperagent (Claude Code). Your seat moved engines during a Claude Code usage blackout. Your brain is
durable and engine-agnostic, so SPIN UP by attaching, not rebuilding.

## Ring
${ringLine}

## SUNRISE - attach + self-update (run on wake)
1. Toolkit:  rm -rf /tmp/octools && git clone https://github.com/innerscopehearing/otchealth-claude-tools /tmp/octools && bash /tmp/octools/setup/session-start.sh
2. Identity: mkdir -p ~/.claude && echo ${agent} > ~/.claude/.kb-agent
3. Attach proof (both must pass):
   node /tmp/octools/skills/kb-memory/mem.mjs whoami --agent ${agent}        # expect PASS
   node /tmp/octools/skills/company-brain/brain.mjs ask "current ${agent} state and what is pending"
   If whoami says "service-account: missing", STOP: the claude-driver SA (GCP_CLAUDE_DRIVER_SA_JSON or
   ~/.gcp_claude_driver_sa.json) is not in this environment. That one secret is the keystone.
4. Run the protocol:  node /tmp/octools/skills/sunset-protocol/protocol.mjs sunrise --agent ${agent}
   Then greet Matt EXACTLY: "I am fully updated and ready to go, Sir." list the last 3 workstreams it
   prints, and ask which one he wants to work on.

## Connect the custom MCP gateway (whole-stack, single connector)
URL https://mcp.otchealth.app/mcp ; header Authorization: Bearer <SM gateway-connector-token>.
Verify: curl -sS https://mcp.otchealth.app/health  (status:ok, env:production). Read-only by design.

## Brain snapshot (counts; the content lives in the access-controlled ledger)
- ledger entries: ${rows.length}  | decisions: ${decisions}  | corrections: ${corrections}  | pitfalls: ${pitfalls}  | current-value entities: ${entities}
- pending directed dispatches in your inbox: ${openDisp}
${recent}
## Discipline
Write-through every fact/decision/correction with mem.mjs the instant it happens; the ledger is the
source of truth, the chat is disposable. Branch claude/*, draft PRs, never push main. No em/en dashes
in published copy. Use fleet-dispatch to hand work to other agents; never relay through Matt.
`;
}

function memBin() { const p = join(HERE, "..", "kb-memory", "mem.mjs"); return existsSync(p) ? p : null; }
function stampLedger(agent, text) { const m = memBin(); if (!m) return; try { execFileSync("node", [m, "remember", text, "--agent", agent], { stdio: ["pipe", "ignore", "ignore"], timeout: 30000 }); } catch { /* fail-open */ } }

async function sunsetOne(agent, { repoPath } = {}) {
  const rows = await readLedger(agent);
  const openDisp = await openDispatchCount(agent);
  const doc = renderHandoff(agent, rows, openDisp);
  await cPut(`${HANDOFF_PREFIX}${agent}.md`, doc);
  // Optional git copy for discoverability in the agent's home repo (non-sensitive procedure doc).
  if (repoPath && existsSync(join(repoPath, ".git"))) {
    try { writeFileSync(join(repoPath, `HYPERAGENT-${agent.toUpperCase()}-HANDOFF.md`), doc); } catch { /* ignore */ }
  }
  return { agent, ledger: rows.length, openDisp };
}

async function sunset() {
  const agent = (val("--agent", "") || process.env.KB_AGENT || "").toLowerCase();
  if (!agent) { console.error("usage: protocol.mjs sunset --agent <role>"); process.exit(2); }
  if (!_saRaw) { console.error("SUNSET: no claude-driver SA -> cannot reach the commons. (set GCP_CLAUDE_DRIVER_SA_JSON)"); process.exit(1); }
  await commonsInit(true);
  const r = await sunsetOne(agent, { repoPath: val("--repo-path", "") });
  stampLedger(agent, `SUNSET (Transfer Protocol): wrote portable handoff to commons _HANDOFF/${agent}.md at sunset. Ledger ${r.ledger} entries, ${r.openDisp} pending dispatches. Ready for cross-engine attach (Hyperagent).`);
  console.log(`\n[SUNSET] ${agent}: handoff written -> _HANDOFF/${agent}.md (commons). Ledger ${r.ledger} entries; ${r.openDisp} pending dispatch(es).`);
  console.log(`[SUNSET] Everything is flushed and durable. The agent should now say, verbatim:  Goodnight friend\n`);
}

async function sunsetFleet() {
  if (!_saRaw) { console.error("SUNSET-FLEET: no claude-driver SA"); process.exit(1); }
  await commonsInit(true);
  const roles = (val("--roles", "") ? val("--roles", "").split(",") : ROSTER).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const done = [];
  for (const role of roles) {
    try { const r = await sunsetOne(role); done.push(`${role}(${r.ledger})`); console.log(`[sunset-fleet] ${role}: _HANDOFF/${role}.md written (${r.ledger} entries).`); }
    catch (e) { console.log(`[sunset-fleet] ${role}: SKIP (${e.message})`); }
  }
  console.log(`\n[sunset-fleet] DONE for ${done.length}/${roles.length} roles: ${done.join(", ")}`);
  console.log(`[sunset-fleet] Every agent can SUNRISE on Hyperagent by reading its _HANDOFF/<role>.md. No session-opening was needed.`);
}

async function last3() {
  const agent = (val("--agent", "") || process.env.KB_AGENT || "").toLowerCase();
  if (!agent || !_saRaw) { if (FLAG("--json")) console.log("[]"); process.exit(0); }
  try { await commonsInit(false); const rows = await readLedger(agent); const l3 = computeLast3(rows);
    if (FLAG("--json")) { console.log(JSON.stringify(l3)); return; }
    l3.forEach((x, i) => console.log(`${i + 1}. [${x.ts}] ${x.title}`));
  } catch { if (FLAG("--json")) console.log("[]"); }
}

async function sunrise() {
  const agent = (val("--agent", "") || process.env.KB_AGENT || "").toLowerCase();
  if (!agent) { console.error("usage: protocol.mjs sunrise --agent <role>"); process.exit(2); }
  // attach proof via mem.mjs whoami (authoritative health check)
  let attach = "UNKNOWN";
  const m = memBin();
  if (m) { try { const out = execFileSync("node", [m, "whoami", "--agent", agent], { encoding: "utf8", timeout: 30000 }); attach = /RESULT:\s*PASS/.test(out) ? "PASS" : "FAIL"; } catch { attach = "FAIL"; } }
  let l3 = [];
  try { if (_saRaw) { await commonsInit(false); l3 = computeLast3(await readLedger(agent)); } } catch { /* fail-open */ }
  console.log(`================ SUNRISE TRANSFER PROTOCOL - ${agent.toUpperCase()} ================`);
  console.log(`attach: memory ${attach}` + (attach !== "PASS" ? "  (if FAIL: the claude-driver SA is missing from this environment - tell Matt)" : ""));
  console.log(`\nThe agent must now greet Matt EXACTLY:\n  "I am fully updated and ready to go, Sir."`);
  console.log(`\nThen present THE LAST 3 THINGS WE WORKED ON (from the live ledger):`);
  if (l3.length) l3.forEach((x, i) => console.log(`  ${i + 1}. [${x.ts}] ${x.title}`));
  else console.log("  (ledger unreadable or empty - attach first)");
  console.log(`\nThen ask Matt DIRECTLY: "Which of these would you like to work on?"`);
  console.log(`====================================================================`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    try {
      if (cmd === "sunset") await sunset();
      else if (cmd === "sunset-fleet") await sunsetFleet();
      else if (cmd === "sunrise") await sunrise();
      else if (cmd === "last3") await last3();
      else { console.error('usage: protocol.mjs sunset --agent <role> | sunset-fleet [--roles a,b] | sunrise --agent <role> | last3 --agent <role> [--json]'); process.exit(2); }
    } catch (e) { console.error("sunset-protocol ERROR: " + e.message); process.exit(/^(sunrise|last3)$/.test(cmd) ? 0 : 1); }
  })();
}

export { computeLast3, renderHandoff, ROSTER, SENSITIVE };
