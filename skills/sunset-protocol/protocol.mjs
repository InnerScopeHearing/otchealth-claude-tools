#!/usr/bin/env node
// SUNSET / SUNRISE TRANSFER PROTOCOL — hardened cross-engine consciousness transfer for the fleet.
//
// Matt's ask: one phrase spins an agent DOWN on one engine, another phrase spins it UP on the other,
// fully self-updated. The brain is already durable + engine-agnostic (Azure ledgers + memory-exec), so
// "transfer" = FLUSH-then-ATTACH, not a migration of state.
//
// 2026-07-12 CORRECTION (Matt, direct): the Executive-side agents (cto/cfo/clo/coo/cro) run in
// Claude CHAT, not Claude Code. Do not assume "Claude Code" fleet-wide just because Developer (and
// possibly other non-exec roster roles) legitimately does. See otherEngineLabel() below -- role-aware,
// not a blanket assumption. This was a real, demonstrated failure mode: the auto-generated handoff doc
// itself said "running on Hyperagent (Claude Code)" for the CTO, which is wrong.
//
// 2026-07-13 FIX: fixing the ENGINE LABEL alone was not enough -- the actual SUNRISE steps and gateway
// connection instructions were still Claude-Code-shaped for every role (git clone + session-start.sh +
// a ~/.claude/.kb-agent file marker + a static Bearer token), none of which apply on Claude Chat. Claude
// Chat has no filesystem, no shell, no session-start hook -- it only has whatever MCP connector Matt has
// configured in Settings > Connectors (a human action the agent cannot do itself). Both blocks below are
// now role-aware via isClaudeChat(agent), matching the real Claude Chat connector confirmed live 2026-07-12
// (name "OTCHealth Brain - <ROLE>", URL https://mcp.otchealth.app/mcp?agent=<role>, screenshot-verified).
// Whether that connector's actual auth is Descope OAuth, the legacy homegrown OAuth, or is bound purely by
// the ?agent= query param is EXPLICITLY LEFT OPEN for the Claude-Chat-side agent itself to verify -- see
// REGRESSION-LEDGER.md tag:descope-provisioned-but-never-used-in-production for the evidence gathered so
// far (provisioned + gateway-accepted for all 9 lanes, but zero real token-exchange activity since
// 2026-07-08 provisioning day). Do not have this template assert an answer to that question.
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
import { kvSecret } from "../kb-memory/azure-secret.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SM = "otchealth-shared-prod";
const COMMONS = { accountSecret: "azure-commons-storage-account", keySecret: "azure-commons-storage-key", container: "company-journal" };
const MEM_PREFIX = "_MEMORY/";
const HANDOFF_PREFIX = "_HANDOFF/";
const DISPATCH_PREFIX = "_DISPATCH/";

// The full roster a fleet sunset covers (exec + cash + product). Source of truth for cards: dream-team/agents/*.md.
const ROSTER = ["cto", "cfo", "clo", "coo", "cro", "developer", "commerce", "rainmaker", "lifecycle", "switchboard", "capital", "growth", "guardian", "medic"];
// Rings: SENSITIVE ledgers never have their text embedded in a commons-stored doc.
const SENSITIVE = new Set(["cfo", "clo", "clo-personal", "capital"]);
// Executive-side roster runs on Claude Chat (Matt, 2026-07-12), NOT Claude Code. Everyone else on this
// roster defaults to Claude Code (dev-tooling roles) unless/until corrected the same way. Keep this map,
// not a blanket string, so the next correction is a one-line edit instead of a repo-wide sweep.
const EXEC_ENGINE = { cto: "Claude Chat", cfo: "Claude Chat", clo: "Claude Chat", coo: "Claude Chat", cro: "Claude Chat" };
function otherEngineLabel(agent) { return EXEC_ENGINE[agent] || "Claude Code"; }
function isClaudeChat(agent) { return EXEC_ENGINE[agent] === "Claude Chat"; }

const argv = process.argv.slice(2);
const cmd = argv[0];
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FLAG = (f) => argv.includes(f);

function resolveSa() {
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) return process.env.GCP_CLAUDE_DRIVER_SA_JSON;
  try { try { return readFileSync(`${homedir()}/.gcp_claude_driver_sa.json`, "utf8"); } catch { return null; } } catch { return null; }
}
const _saRaw = resolveSa();
function saJwt() { const __r=_saRaw;if(!__r){return null;}let sa;try{sa=JSON.parse(__r);}catch{return null;}if(!sa||!sa.private_key){return null;} const n = Math.floor(Date.now() / 1e3), e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"); const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: n, exp: n + 3600 })}`; return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url"); }
async function sm(id) { const _kv = await kvSecret(id); if (_kv != null) return _kv; const t = (await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt())}` })).json()).access_token; const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: "Bearer " + t } }); return r.ok ? Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim() : null; }

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

// Role-aware SUNRISE steps + gateway-connect block. Claude Chat has no filesystem/shell/hooks -- only
// whatever MCP connector Matt has already configured in Settings > Connectors. The agent cannot install
// or fix that connector itself; it can only verify it and report back if something is missing.
function sunriseStepsBlock(agent) {
  if (isClaudeChat(agent)) {
    return `## SUNRISE - attach + self-update (run on wake, Claude Chat)
1. You have NO filesystem, shell, or session-start hook here -- do not attempt git clone/bash steps, they will not work. Your only tools are whatever MCP connector(s) Matt has configured in Settings > Connectors.
2. Confirm the connector "OTCHealth Brain - ${agent.toUpperCase()}" is present and connected (URL pattern \`https://mcp.otchealth.app/mcp?agent=${agent}\`, confirmed live 2026-07-12 via screenshot). If it is missing or disconnected, STOP and tell Matt directly -- you cannot add or fix a connector yourself.
3. Attach proof: call whatever memory/brain tool this connector exposes (e.g. a "Brain search" or "Agent dispatch" tool) and ask for "current ${agent} state and what is pending." If no such tool is available, say so plainly rather than guessing at state.
4. Run the protocol via that connector if it exposes a way to invoke \`sunset-protocol/protocol.mjs sunrise --agent ${agent}\` server-side; otherwise read your \`_HANDOFF/${agent}.md\` and \`last3\` content directly through whatever read tool is available.
5. OPEN, NOT YOUR JOB TO ASSUME AN ANSWER TO: whether this connector authenticates via Descope OAuth, the legacy homegrown gateway OAuth, or is identified purely by the \`?agent=\` URL parameter is unconfirmed as of 2026-07-12 (see REGRESSION-LEDGER.md tag:descope-provisioned-but-never-used-in-production). If you can determine this from your own session (e.g. an auth/connector-status tool), report it and flush the answer to the ledger. If you cannot, say so rather than asserting either answer.`;
  }
  return `## SUNRISE - attach + self-update (run on wake)
1. Toolkit:  rm -rf /tmp/octools && git clone https://github.com/innerscopehearing/otchealth-claude-tools /tmp/octools && bash /tmp/octools/setup/session-start.sh
2. Identity: mkdir -p ~/.claude && echo ${agent} > ~/.claude/.kb-agent
3. Attach proof (both must pass):
   node /tmp/octools/skills/kb-memory/mem.mjs whoami --agent ${agent}        # expect PASS
   node /tmp/octools/skills/company-brain/brain.mjs ask "current ${agent} state and what is pending"
   If whoami says "service-account: missing", STOP: the claude-driver SA (GCP_CLAUDE_DRIVER_SA_JSON or
   ~/.gcp_claude_driver_sa.json) is not in this environment. That one secret is the keystone.
4. Run the protocol:  node /tmp/octools/skills/sunset-protocol/protocol.mjs sunrise --agent ${agent}
   Then greet Matt EXACTLY: "I am fully updated and ready to go, Sir." list the last 3 workstreams it
   prints, and ask which one he wants to work on.`;
}
function gatewayConnectBlock(agent) {
  if (isClaudeChat(agent)) {
    return `## Connect the custom MCP gateway (Claude Chat connector, already configured by Matt)
Connector name: "OTCHealth Brain - ${agent.toUpperCase()}". URL: \`https://mcp.otchealth.app/mcp?agent=${agent}\` (confirmed live via screenshot, 2026-07-12). This is set up in Claude Chat Settings > Connectors -- you cannot create or repair it yourself; if it is missing, tell Matt.
Do NOT assume the old static-Bearer-token instructions below apply here (they described the legacy Claude Code connection method, not Claude Chat): the actual auth mechanism behind this URL (Descope OAuth vs. legacy homegrown OAuth vs. the \`?agent=\` param alone) is an open, unverified question as of 2026-07-12 -- see the note in the SUNRISE steps above.`;
  }
  return `## Connect the custom MCP gateway (whole-stack, single connector)
URL https://mcp.otchealth.app/mcp ; header Authorization: Bearer <SM gateway-connector-token>.
Verify: curl -sS https://mcp.otchealth.app/health  (status:ok, env:production). Read-only by design.`;
}

// The PORTABLE, RING-SAFE handoff doc body. Procedure + counts + pointers. Embeds ledger TEXT only for
// non-sensitive roles (and even then only short titles); sensitive roles get counts + "read your ledger live".
function renderHandoff(agent, rows, openDisp) {
  const sensitive = SENSITIVE.has(agent);
  const engine = otherEngineLabel(agent);
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
Hyperagent. Your seat moved engines during an engine outage/rotation. Your OTHER engine for this role is
**${engine}** (verified 2026-07-12 -- do not assume otherwise even if an older doc says differently). Your
brain is durable and engine-agnostic, so SPIN UP by attaching, not rebuilding.

## Ring
${ringLine}

${sunriseStepsBlock(agent)}

${gatewayConnectBlock(agent)}

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
  stampLedger(agent, `SUNSET (Transfer Protocol): wrote portable handoff to commons _HANDOFF/${agent}.md at sunset. Ledger ${r.ledger} entries, ${r.openDisp} pending dispatches. Ready for cross-engine attach (other engine: ${otherEngineLabel(agent)}).`);
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
  console.log(`[sunset-fleet] Every agent can SUNRISE on its other engine by reading its _HANDOFF/<role>.md. No session-opening was needed.`);
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
