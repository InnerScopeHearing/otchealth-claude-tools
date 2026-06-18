#!/usr/bin/env node
// QuickBooks Online multi-company helper for the CFO data pipeline.
// ONE Intuit app, MANY companies. Per-company realmId + refresh token from env.
// Auth: refresh_token -> access_token (Basic client creds), then v3 API with Bearer.
// NO single-connector limit: this is how the CFO drives 4 books from one place.
//
// Credentials from env (hydrated from otchealth-shared-prod via setup/fetch-secrets.mjs):
//   QBO_CLIENT_ID, QBO_CLIENT_SECRET        (the one Intuit app; required)
//   QBO_ENV                                 (production | sandbox; default production)
// Per company <KEY>: QBO_REALM_<KEY>, QBO_REFRESH_<KEY>
//   otchealth -> QBO_REALM_OTCHEALTH / QBO_REFRESH_OTCHEALTH
//   innd, hearingassist, personal -> same pattern
//
// IMPORTANT: Intuit ROTATES the refresh token on use (100-day expiry resets each time).
// A recurring sync MUST persist the new refresh token back to the vault or it dies in
// ~100 days. This CLI flags rotation on stderr; the n8n job will write it back.
//
// Usage:
//   node qbo.mjs <company> company-info
//   node qbo.mjs <company> query "SELECT * FROM Account MAXRESULTS 50"
//   node qbo.mjs <company> request <GET|POST|PUT> <path>   (JSON body on stdin for writes)

import { mkdirSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";

const SM_PROJECT = "otchealth-shared-prod";

const ENV = (process.env.QBO_ENV || "production").toLowerCase();
const API = ENV === "sandbox" ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const MINOR = "73"; // QBO API minor version

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env ${name}. Store the QBO creds in Secret Manager and hydrate them first.`);
    process.exit(2);
  }
  return v;
}

// ── Secret Manager write (persist Intuit's rotated refresh token) ──
function smAvailable() { return !!process.env.GCP_CLAUDE_DRIVER_SA_JSON; }
async function smToken() {
  const sa = JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const input = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const sig = crypto.createSign("RSA-SHA256").update(input).sign(sa.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(input + "." + sig)}` });
  if (!r.ok) throw new Error("SM auth " + r.status);
  return (await r.json()).access_token;
}
async function smAddVersion(t, id, v) {
  const body = JSON.stringify({ payload: { data: Buffer.from(v, "utf8").toString("base64") } });
  const add = () => fetch(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets/${id}:addVersion`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body });
  let r = await add();
  if (r.status === 404) {
    const c = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets?secretId=${id}`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify({ replication: { automatic: {} } }) });
    if (!c.ok && c.status !== 409) throw new Error("SM create " + c.status);
    r = await add();
  }
  if (!r.ok) throw new Error("SM addVersion " + r.status);
}
// Read the latest secret version (the live, rotated refresh token).
async function smReadLatest(t, id) {
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("SM access " + r.status);
  return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
}

async function accessToken(refresh) {
  const basic = Buffer.from(`${need("QBO_CLIENT_ID")}:${need("QBO_CLIENT_SECRET")}`).toString("base64");
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refresh)}`,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const tid = r.headers.get("intuit_tid") || "";
    console.error(`token refresh failed ${r.status}${tid ? ` intuit_tid=${tid}` : ""}: ${JSON.stringify(j).slice(0, 300)}`);
    process.exit(1);
  }
  if (j.refresh_token && j.refresh_token !== refresh) {
    if (smAvailable()) {
      try { const t = await smToken(); await smAddVersion(t, SREFRESH, j.refresh_token); console.error(`Intuit rotated ${KEY} refresh token -> persisted (${SREFRESH}).`); }
      catch (e) { console.error(`ROTATE PERSIST FAILED for ${KEY} (${e.message}): new refresh token NOT saved.`); }
    } else {
      console.error(`NOTE: Intuit rotated the ${KEY} refresh token but no SA to persist. Update qbo-refresh-${KEY} or it will expire.`);
    }
  }
  return j.access_token;
}

async function api(method, realm, path, token, body) {
  const r = await fetch(`${API}/v3/company/${realm}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
    body: body || undefined,
  });
  const text = await r.text();
  // Capture Intuit's transaction id (intuit_tid) from response headers for support/troubleshooting.
  const tid = r.headers.get("intuit_tid") || "";
  console.error(`HTTP ${r.status} ${method} ${path}${tid ? ` intuit_tid=${tid}` : ""}`);
  if (!r.ok) console.error(`ERROR body: ${text.slice(0, 500)}`);
  try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log(text); }
  process.exit(r.ok ? 0 : 1);
}

function readStdin() {
  return new Promise((res) => {
    let d = "";
    if (process.stdin.isTTY) return res("");
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => res(d));
  });
}

const [company, cmd, a1, a2] = process.argv.slice(2);
if (!company || !cmd) {
  console.error("usage: qbo.mjs <company> <company-info|query|request> ...   (company: otchealth|innd|hearingassist|personal)");
  process.exit(2);
}
const KEY = company.toUpperCase().replace(/[^A-Z0-9]/g, "");
const SREFRESH = `qbo-refresh-${KEY.toLowerCase()}`;   // the Secret Manager id (matches fetch-secrets)
const realm = need(`QBO_REALM_${KEY}`);
// Resolve the refresh token FRESH from Secret Manager every call so a 2-call sequence never
// presents the stale env token (which makes Intuit revoke the whole token family). The env
// var QBO_REFRESH_<KEY> is only a fallback (first run before anything is persisted, or no SA).
async function resolveRefresh() {
  if (smAvailable()) {
    try {
      const live = await smReadLatest(await smToken(), SREFRESH);
      if (live) { console.error(`refresh token: read fresh from Secret Manager (${SREFRESH}).`); return live; }
    } catch (e) { console.error(`WARN: could not read ${SREFRESH} from SM (${e.message}); falling back to env.`); }
  }
  return need(`QBO_REFRESH_${KEY}`);
}
const refresh = await resolveRefresh();
const token = await accessToken(refresh);

if (cmd === "company-info") {
  await api("GET", realm, `/companyinfo/${realm}?minorversion=${MINOR}`, token);
} else if (cmd === "query") {
  if (!a1) { console.error('usage: qbo.mjs <company> query "SELECT ..."'); process.exit(2); }
  await api("GET", realm, `/query?query=${encodeURIComponent(a1)}&minorversion=${MINOR}`, token);
} else if (cmd === "request") {
  if (!a1 || !a2) { console.error("usage: qbo.mjs <company> request <METHOD> <path>"); process.exit(2); }
  const m = a1.toUpperCase();
  const body = ["POST", "PUT", "PATCH"].includes(m) ? await readStdin() : null;
  const path = (a2.startsWith("/") ? a2 : `/${a2}`) + (a2.includes("minorversion") ? "" : (a2.includes("?") ? "&" : "?") + `minorversion=${MINOR}`);
  await api(m, realm, path, token, body || null);
} else if (cmd === "export") {
  // Full company dump for migration/backup. Every migration path needs this EXTRACT step;
  // also a clean audit backup if staying on QBO. Writes JSON per entity + key reports.
  const outDir = a1 || `qbo-export-${KEY.toLowerCase()}`;
  mkdirSync(outDir, { recursive: true });
  const entities = ["CompanyInfo", "Account", "Customer", "Vendor", "Employee", "Item", "Class", "Department", "TaxCode", "TaxRate", "Term", "PaymentMethod", "Invoice", "Bill", "BillPayment", "Payment", "Purchase", "JournalEntry", "Deposit", "Transfer", "CreditMemo", "VendorCredit", "SalesReceipt", "RefundReceipt", "Estimate", "PurchaseOrder"];
  for (const e of entities) {
    let start = 1, all = [], page;
    do {
      const q = encodeURIComponent(`SELECT * FROM ${e} STARTPOSITION ${start} MAXRESULTS 1000`);
      const r = await fetch(`${API}/v3/company/${realm}/query?query=${q}&minorversion=${MINOR}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      if (!r.ok) { console.error(`  ${e}: HTTP ${r.status}${r.headers.get("intuit_tid") ? ` intuit_tid=${r.headers.get("intuit_tid")}` : ""} (skipped)`); break; }
      const j = await r.json();
      page = (j.QueryResponse && j.QueryResponse[e]) || [];
      all = all.concat(page);
      start += 1000;
    } while (page && page.length === 1000);
    writeFileSync(`${outDir}/${e}.json`, JSON.stringify(all, null, 2));
    console.error(`  ${e}: ${all.length}`);
  }
  const today = new Date().toISOString().slice(0, 10);
  const reports = { TrialBalance: `start_date=2015-01-01&end_date=${today}`, GeneralLedger: `start_date=2015-01-01&end_date=${today}`, ProfitAndLoss: `start_date=2015-01-01&end_date=${today}`, BalanceSheet: `end_date=${today}` };
  for (const [name, qs] of Object.entries(reports)) {
    const r = await fetch(`${API}/v3/company/${realm}/reports/${name}?${qs}&minorversion=${MINOR}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!r.ok) { console.error(`  report ${name}: HTTP ${r.status}${r.headers.get("intuit_tid") ? ` intuit_tid=${r.headers.get("intuit_tid")}` : ""} (skipped)`); continue; }
    writeFileSync(`${outDir}/report-${name}.json`, await r.text());
    console.error(`  report ${name}: saved`);
  }
  console.log(`Export complete -> ${outDir}/`);
  process.exit(0);
} else {
  console.error("commands: company-info | query \"SELECT ...\" | request <METHOD> <path> | export [outDir]");
  process.exit(2);
}
