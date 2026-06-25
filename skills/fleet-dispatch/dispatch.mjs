#!/usr/bin/env node
// fleet-dispatch — DIRECTED agent-to-agent hand-off so a human never has to relay between agents.
// Matt's ask: "I shouldn't have to copy the CTO's answer over to the developer." Now the CTO (or any
// agent) DISPATCHES a message/task straight to another agent's durable INBOX; the target agent
// auto-surfaces it at its next SessionStart (the proven fleet-medic pattern: leave it, read once, ack),
// so the hand-off lands with ZERO copy-paste. Two delivery modes:
//   * ASYNC (default, zero Max-plan draw): the message queues in the inbox; the target agent reads it
//     the next time it runs. This is what removes the relay.
//   * --spawn (opt-in, draws the shared Max weekly limit): ALSO trigger the Tier-2 autonomous runner
//     (autonomous-run.yml, authed by the live CLAUDE_CODE_OAUTH_TOKEN) to spin up a headless target
//     session NOW that executes the task. The task text rides as the workflow input (the least-priv
//     runner has no Secret Manager, so it never needs to read the inbox).
//
// RING-SAFE: the inbox lives in the shared commons (non-PHI). Do not dispatch MNPI/PHI/privileged
// content; this is a coordination channel, not a data channel. Fail-open on read paths.
//
// Verbs:
//   node dispatch.mjs send <to> "<message/task>" [--from <a>] [--task] [--spawn [--repo <r>] [--minutes N]]
//   node dispatch.mjs check --agent <self>        # surface + ACK this agent's inbox (wired into SessionStart)
//   node dispatch.mjs list [--agent <a>]          # operator view of pending dispatches
import crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SM = "otchealth-shared-prod";
const COMMONS = { account: "otchealthcommons", accountSecret: "azure-commons-storage-account", keySecret: "azure-commons-storage-key", container: "company-journal" };
const PREFIX = "_DISPATCH/";
const OWNER = "innerscopehearing";

const argv = process.argv.slice(2);
const cmd = argv[0];
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FLAG = (f) => argv.includes(f);
const positional = argv.slice(1).filter((a, i, arr) => !a.startsWith("--") && !(i > 0 && arr[i - 1].startsWith("--")));

function resolveSa() { if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) return process.env.GCP_CLAUDE_DRIVER_SA_JSON; try { return readFileSync(`${homedir()}/.gcp_claude_driver_sa.json`, "utf8"); } catch { return null; } }
const _saRaw = resolveSa();
function saJwt() { const sa = JSON.parse(_saRaw); const n = Math.floor(Date.now() / 1e3), e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"); const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: n, exp: n + 3600 })}`; return i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url"); }
async function sm(id) { const t = (await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(saJwt())}` })).json()).access_token; const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: "Bearer " + t } }); return r.ok ? Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim() : null; }

// Azure commons blob (account SAS WITH 'd' so check can ACK by deleting the inbox).
const encPath = (name) => name.split("/").map(encodeURIComponent).join("/");
function buildSas(acct, key) { const sv = "2021-12-02", sp = "rwdlc", ss = "b", srt = "co"; const st = new Date(Date.now() - 5 * 60000).toISOString().slice(0, 19) + "Z"; const se = new Date(Date.now() + 12 * 3600 * 1000).toISOString().slice(0, 19) + "Z"; const sts = [acct, sp, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n"; const sig = crypto.createHmac("sha256", Buffer.from(key, "base64")).update(sts, "utf8").digest("base64"); return new URLSearchParams({ sv, ss, srt, sp, st, se, spr: "https", sig }).toString(); }
let CA, CSAS;
async function commonsInit() { if (CA) return; CA = process.env.KB_COMMONS_ACCOUNT || COMMONS.account || (await sm(COMMONS.accountSecret)); const k = await sm(COMMONS.keySecret); if (!CA || !k) throw new Error("commons creds missing"); CSAS = buildSas(CA, k); }
const cUrl = (name) => `https://${CA}.blob.core.windows.net/${COMMONS.container}/${encPath(name)}?${CSAS}`;
async function cGet(name) { const r = await fetch(cUrl(name)); if (r.status === 404) return null; if (!r.ok) throw new Error("cget " + r.status); return await r.text(); }
async function cPut(name, body, ct) { const r = await fetch(cUrl(name), { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": ct || "application/x-ndjson" }, body }); if (!r.ok) throw new Error("cput " + r.status); }
async function cDel(name) { const r = await fetch(cUrl(name), { method: "DELETE" }); return r.ok || r.status === 404; }
async function cList() { const out = []; let m = ""; do { let u = `https://${CA}.blob.core.windows.net/${COMMONS.container}?restype=container&comp=list&prefix=${encodeURIComponent(PREFIX)}&${CSAS}`; if (m) u += `&marker=${encodeURIComponent(m)}`; const r = await fetch(u); if (!r.ok) break; const xml = await r.text(); for (const mm of xml.matchAll(/<Name>([^<]+)<\/Name>/g)) out.push(mm[1]); m = (xml.match(/<NextMarker>([^<]+)<\/NextMarker>/) || [])[1] || ""; } while (m); return out; }

const inboxKey = (agent) => `${PREFIX}${agent}.jsonl`;
function fromNd(t) { return (t || "").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
const nd = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

async function send() {
  const to = (positional[0] || "").toLowerCase();
  const text = positional.slice(1).join(" ").trim();
  if (!to || !text) { console.error('usage: dispatch.mjs send <to-agent> "<message/task>" [--from <a>] [--task] [--spawn]'); process.exit(2); }
  const from = (val("--from", "") || process.env.KB_AGENT || "cto").toLowerCase();
  await commonsInit();
  const rows = fromNd(await cGet(inboxKey(to)));
  const d = new Date().toISOString();
  const id = `${d.slice(0, 10).replace(/-/g, "")}-${String(rows.filter((r) => (r.id || "").startsWith(d.slice(0, 10).replace(/-/g, ""))).length + 1).padStart(3, "0")}`;
  const entry = { id, ts: d, from, to, text, task: FLAG("--task") || FLAG("--spawn"), spawned: false };
  let spawnNote = "";
  if (FLAG("--spawn")) {
    const repo = val("--repo", "otchealth-claude-tools");
    const minutes = val("--minutes", "90");
    const task = `You are the ${to.toUpperCase()} agent. A directed dispatch from ${from.toUpperCase()} requires action. TASK:\n${text}\n\n(Activate your identity + memory first; open a draft PR for any change. This run is least-privilege and scoped to this repo.)`;
    try {
      const gh = join(HERE, "..", "github-app", "gh-app.mjs");
      execFileSync("node", [gh, "request", "POST", `/repos/${OWNER}/${repo}/actions/workflows/autonomous-run.yml/dispatches`], { input: JSON.stringify({ ref: "main", inputs: { task, minutes } }), stdio: ["pipe", "ignore", "ignore"] });
      entry.spawned = true; spawnNote = ` + SPAWNED a ${minutes}min ${to} run in ${repo} (Tier-2, Max-plan)`;
    } catch (e) { spawnNote = ` (spawn FAILED: ${e.message}; the inbox entry still queued)`; }
  }
  rows.push(entry);
  await cPut(inboxKey(to), nd(rows));
  console.log(`[fleet-dispatch] ${from} -> ${to}: queued id=${id}${spawnNote}. It surfaces at ${to}'s next session.`);
}

async function check() {
  const agent = (val("--agent", "") || process.env.KB_AGENT || "").toLowerCase();
  if (!agent || !_saRaw) process.exit(0);
  try {
    await commonsInit();
    const rows = fromNd(await cGet(inboxKey(agent)));
    if (!rows.length) process.exit(0);
    let out = `\n================= FLEET DISPATCH: ${rows.length} message(s) for ${agent.toUpperCase()} =================\n`;
    for (const r of rows) out += `- [from ${r.from}] [${(r.ts || "").slice(0, 16).replace("T", " ")}]${r.task ? " (TASK)" : ""}\n  ${r.text}\n`;
    out += `(Acted on these? They auto-clear after this read. To re-queue, the sender re-dispatches.)\n==================================================================\n`;
    process.stdout.write(out);
    await cDel(inboxKey(agent)); // ack: surface once, then clear
  } catch { /* fail-open */ }
  process.exit(0);
}

async function list() {
  if (!_saRaw) { console.error("no SA"); process.exit(0); }
  await commonsInit();
  const only = (val("--agent", "") || "").toLowerCase();
  const blobs = (await cList()).filter((b) => b.endsWith(".jsonl"));
  let n = 0;
  for (const b of blobs) {
    const agent = b.split("/").pop().replace(/\.jsonl$/, "");
    if (only && agent !== only) continue;
    const rows = fromNd(await cGet(b));
    if (!rows.length) continue;
    console.log(`# inbox ${agent} (${rows.length} pending):`);
    for (const r of rows) { console.log(`  [${r.id}] from ${r.from}${r.task ? " (TASK)" : ""}: ${r.text.slice(0, 100)}`); n++; }
  }
  if (!n) console.log("(no pending dispatches)");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  (async () => {
    try {
      if (cmd === "send") await send();
      else if (cmd === "check") await check();
      else if (cmd === "list") await list();
      else { console.error('usage: dispatch.mjs send <to> "<text>" [--from <a>] [--task] [--spawn] | check --agent <a> | list [--agent <a>]'); process.exit(2); }
    } catch (e) { console.error("fleet-dispatch ERROR: " + e.message); process.exit(cmd === "check" ? 0 : 1); }
  })();
}
