#!/usr/bin/env node
// xero-bulk — BATCHED, rate-limit-aware bulk poster for the CFO's Xero book rebuild.
// Companion to xero.mjs (shares the exact per-org token auth + rotate-persist). Additive: does
// NOT touch xero.mjs, so the live importer is unaffected.
//
// WHY: posting one object per API call blows Xero's 60/min + 5,000/day caps (20k txns = 20k calls).
// Xero write endpoints accept an ARRAY of up to ~50-60 objects per call. Batched at 50/call,
// 20,000 transactions = ~400 calls = minutes, comfortably under both limits.
//
// HOW: reads a JSON ARRAY of objects from stdin, chunks them, POSTs each chunk as
// {<Endpoint>:[...]} with summarizeErrors=false (so one bad object never fails the batch), paces
// calls under 60/min, honors 429 Retry-After + the X-*Limit-Remaining headers, and returns a
// per-object result array (Status + any ValidationErrors) so an importer's idempotency cache can
// record successes and retry only the failures. Resumable by construction (skip what is cached).
//
// Usage (org = otchealth|innd|hearingassist|personal):
//   cat bills.json | node xero-bulk.mjs <org> post-batch Invoices            [--batch 50] [--unitdp 4]
//   cat txns.json  | node xero-bulk.mjs <org> post-batch BankTransactions
//   node xero-bulk.mjs <org> limits          # show current rate-limit headroom (1 cheap call)
// stdin JSON = an array of Xero objects WITHOUT the wrapper key (the tool wraps them).
import crypto from "node:crypto";
import { getAccessContext } from "./xero-token.mjs";
const TOKEN_URL = "https://identity.xero.com/connect/token";
const CONN_URL = "https://api.xero.com/connections";
const API = "https://api.xero.com/api.xro/2.0";
const SM_PROJECT = "otchealth-shared-prod";

const args = process.argv.slice(2);
const takeVal = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BATCH = Math.max(1, Math.min(50, parseInt(takeVal("--batch", "50"), 10) || 50));
const UNITDP = takeVal("--unitdp", "4");
const MIN_SPACING_MS = 1150; // ~52 calls/min, safe margin under Xero's 60/min

function need(n) { const v = process.env[n]; if (!v) throw new Error(`Missing env ${n}`); return v; }
function orgKeyFrom(sel) { const s = (sel || "").toLowerCase().replace(/[^a-z0-9]/g, ""); if (s.includes("otchealth")) return "otchealth"; if (s.includes("innerscope") || s.includes("innd")) return "innd"; if (s.includes("hearing")) return "hearingassist"; if (s.includes("personal") || s.includes("matt")) return "personal"; return s; }
function smAvailable() { return !!process.env.GCP_CLAUDE_DRIVER_SA_JSON; }
async function smToken() { const sa = JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON); const now = Math.floor(Date.now() / 1000); const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url"); const input = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`; const sig = crypto.createSign("RSA-SHA256").update(input).sign(sa.private_key, "base64url"); const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(input + "." + sig)}` }); if (!r.ok) throw new Error("SM token " + r.status); return (await r.json()).access_token; }
async function smReadLatest(t, id) { const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } }); if (!r.ok) return null; return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim(); }
async function smAddVersion(t, id, v) { const body = JSON.stringify({ payload: { data: Buffer.from(v, "utf8").toString("base64") } }); const add = () => fetch(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets/${id}:addVersion`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body }); let r = await add(); if (r.status === 404) { await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets?secretId=${id}`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify({ replication: { automatic: {} } }) }); r = await add(); } if (!r.ok) throw new Error("SM addVersion " + r.status); }

// Token + tenant now come from the shared broker (access-token cache + cross-process refresh lock +
// disconnect detection) — eliminates the per-invocation single-use rotation race. The legacy SM/refresh
// helpers above remain for back-compat but are off the hot path.
const _tenantByOrg = {};
async function accessToken(orgKey) { const c = await getAccessContext(orgKey); _tenantByOrg[orgKey] = c.tenantId; return c.access_token; }
async function resolveTenant(token, sel) {
  const k = orgKeyFrom(sel); if (_tenantByOrg[k]) return _tenantByOrg[k];
  const r = await fetch(CONN_URL, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }); if (!r.ok) throw new Error("connections " + r.status); const conns = await r.json(); const hit = conns.find((c) => (c.tenantName || "").toLowerCase().includes((sel || "").toLowerCase())) || conns[0]; if (!hit) throw new Error("no tenant"); return hit.tenantId;
}
function readStdin() { return new Promise((res) => { let d = ""; if (process.stdin.isTTY) return res(""); process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => res(d)); }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// rate-limited POST: paces under 60/min, honors 429 Retry-After + slows when X-MinLimit-Remaining is low
let lastCall = 0, dayRemaining = null, minRemaining = null;
async function paced(method, tenantId, ep, token, body) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const wait = MIN_SPACING_MS - (Date.now() - lastCall); if (wait > 0) await sleep(wait);
    if (minRemaining !== null && minRemaining <= 3) await sleep(20000); // near the minute ceiling -> let it reset
    lastCall = Date.now();
    const r = await fetch(`${API}${ep.startsWith("/") ? ep : "/" + ep}`, { method, headers: { Authorization: `Bearer ${token}`, "Xero-tenant-id": tenantId, Accept: "application/json", "Content-Type": "application/json" }, body });
    minRemaining = r.headers.get("X-MinLimit-Remaining") != null ? +r.headers.get("X-MinLimit-Remaining") : minRemaining;
    dayRemaining = r.headers.get("X-DayLimit-Remaining") != null ? +r.headers.get("X-DayLimit-Remaining") : dayRemaining;
    if (r.status === 429) {
      const ra = +(r.headers.get("Retry-After") || 0) || 60;
      if (ra > 300) { console.error(`  429 DAILY LIMIT exhausted (Retry-After ${ra}s ~${(ra / 3600).toFixed(1)}h). ABORTING (not waiting). Resume after the daily reset, or post to a different tenant today.`); return { status: 429, ok: false, j: { error: "daily_limit_exhausted", retry_after_s: ra } }; }
      console.error(`  429 minute-limit; sleeping ${Math.min(ra, 90)}s`); await sleep((Math.min(ra, 90) + 1) * 1000); continue;
    }
    const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
    return { status: r.status, ok: r.ok, j };
  }
  return { status: 429, ok: false, j: { error: "rate-limit retries exhausted" } };
}

async function main() {
  const [sel, cmd, endpointArg] = args;
  if (!sel || !cmd) { console.error('usage: xero-bulk.mjs <org> post-batch <Endpoint> | <org> limits'); process.exit(2); }
  const orgKey = orgKeyFrom(sel);
  const token = await accessToken(orgKey);
  const tenantId = await resolveTenant(token, sel);
  if (cmd === "limits") { const r = await paced("GET", tenantId, "/Organisation", token, undefined); console.log(JSON.stringify({ status: r.status, minute_remaining: minRemaining, day_remaining: dayRemaining }, null, 2)); process.exit(r.ok ? 0 : 1); }
  if (cmd !== "post-batch") { console.error("commands: post-batch <Endpoint> | limits"); process.exit(2); }
  const Endpoint = (endpointArg || "").replace(/^\//, ""); if (!Endpoint) { console.error("need an Endpoint (e.g. Invoices, BankTransactions, ManualJournals, Payments)"); process.exit(2); }
  const input = await readStdin(); let items; try { items = JSON.parse(input); } catch { console.error("stdin must be a JSON array of Xero objects"); process.exit(2); }
  if (!Array.isArray(items)) { console.error("stdin must be a JSON ARRAY"); process.exit(2); }
  console.error(`[xero-bulk] ${orgKey} ${Endpoint}: ${items.length} objects, batch ${BATCH} -> ~${Math.ceil(items.length / BATCH)} calls (<=52/min)`);
  const results = []; let posted = 0, failed = 0, batchNo = 0;
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH); batchNo++;
    const body = JSON.stringify({ [Endpoint]: chunk });
    const r = await paced("POST", tenantId, `/${Endpoint}?summarizeErrors=false&unitdp=${UNITDP}`, token, body);
    const returned = (r.j && r.j[Endpoint]) || [];
    if (!r.ok && !returned.length) { failed += chunk.length; for (const c of chunk) results.push({ ok: false, status: r.status, error: JSON.stringify(r.j).slice(0, 240) }); console.error(`  batch ${batchNo}: HTTP ${r.status} FAILED (${chunk.length})`); continue; }
    for (const o of returned) { const ok = (o.StatusAttributeString !== "ERROR") && !(o.ValidationErrors && o.ValidationErrors.length); if (ok) posted++; else failed++; results.push({ ok, id: o.InvoiceID || o.BankTransactionID || o.PaymentID || o.ManualJournalID || o.PurchaseOrderID, ref: o.Reference || o.InvoiceNumber, errors: (o.ValidationErrors || []).map((e) => e.Message) }); }
    console.error(`  batch ${batchNo}/${Math.ceil(items.length / BATCH)} done (posted ${posted}, failed ${failed}; min-left ${minRemaining}, day-left ${dayRemaining})`);
  }
  console.log(JSON.stringify({ endpoint: Endpoint, org: orgKey, total: items.length, posted, failed, day_remaining: dayRemaining, results }, null, 2));
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("ERROR: " + e.message); process.exit(1); });
