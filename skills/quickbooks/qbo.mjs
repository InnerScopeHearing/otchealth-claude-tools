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

async function accessToken(refresh) {
  const basic = Buffer.from(`${need("QBO_CLIENT_ID")}:${need("QBO_CLIENT_SECRET")}`).toString("base64");
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refresh)}`,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error(`token refresh failed ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    process.exit(1);
  }
  if (j.refresh_token && j.refresh_token !== refresh) {
    console.error("NOTE: Intuit rotated the refresh token. Persist the new value to the vault for this company.");
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
  console.error(`HTTP ${r.status} ${method} ${path}`);
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
const realm = need(`QBO_REALM_${KEY}`);
const refresh = need(`QBO_REFRESH_${KEY}`);
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
} else {
  console.error("commands: company-info | query \"SELECT ...\" | request <METHOD> <path>");
  process.exit(2);
}
