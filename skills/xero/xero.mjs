#!/usr/bin/env node
// Xero multi-org (multi-tenant) helper for the CFO data pipeline.
// ONE OAuth connection reaches MANY organizations (tenants). Pick a tenant per call.
//
// Credentials from env (hydrated from otchealth-shared-prod via setup/fetch-secrets.mjs):
//   XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_REFRESH_TOKEN   (one app, one multi-tenant token)
//
// ROTATION GOTCHA: Xero rotates the refresh token on EVERY use (60-day expiry resets).
// A recurring job MUST persist the new refresh token back to the vault or it dies. This CLI
// flags rotation on stderr; the n8n job writes it back.
//
// Usage:
//   node xero.mjs connections                            # list orgs (tenantId + name) the token can reach
//   node xero.mjs <tenant> get <Endpoint>                # e.g. Organisation, Accounts, Invoices, Reports/TrialBalance
//   node xero.mjs <tenant> request <METHOD> <Endpoint>   # JSON body on stdin for writes (POST/PUT)
//   <tenant> = an org-name substring OR an exact tenantId

const TOKEN_URL = "https://identity.xero.com/connect/token";
const CONN_URL = "https://api.xero.com/connections";
const API = "https://api.xero.com/api.xro/2.0";

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env ${name}. Store the Xero creds in Secret Manager and hydrate them first.`);
    process.exit(2);
  }
  return v;
}

async function accessToken() {
  const basic = Buffer.from(`${need("XERO_CLIENT_ID")}:${need("XERO_CLIENT_SECRET")}`).toString("base64");
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(need("XERO_REFRESH_TOKEN"))}`,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error(`token refresh failed ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    process.exit(1);
  }
  if (j.refresh_token && j.refresh_token !== process.env.XERO_REFRESH_TOKEN) {
    console.error("NOTE: Xero rotated the refresh token. Persist the new value to the vault.");
  }
  return j.access_token;
}

async function connections(token) {
  const r = await fetch(CONN_URL, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!r.ok) { console.error(`connections ${r.status}: ${(await r.text()).slice(0, 200)}`); process.exit(1); }
  return await r.json(); // [{ id, tenantId, tenantType, tenantName, ... }]
}

async function resolveTenant(token, sel) {
  const conns = await connections(token);
  const hit = conns.find((c) => c.tenantId === sel) || conns.find((c) => (c.tenantName || "").toLowerCase().includes(sel.toLowerCase()));
  if (!hit) { console.error(`tenant '${sel}' not found. Available: ${JSON.stringify(conns.map((c) => c.tenantName))}`); process.exit(2); }
  return hit.tenantId;
}

async function call(method, tenantId, endpoint, token, body) {
  const ep = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const r = await fetch(`${API}${ep}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Xero-tenant-id": tenantId, Accept: "application/json", "Content-Type": "application/json" },
    body: body || undefined,
  });
  const text = await r.text();
  console.error(`HTTP ${r.status} ${method} ${ep}`);
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

const args = process.argv.slice(2);
const token = await accessToken();

if (args[0] === "connections") {
  console.log(JSON.stringify(await connections(token), null, 2));
  process.exit(0);
}
const [sel, cmd, a1, a2] = args;
if (!sel || !cmd) {
  console.error("usage: xero.mjs connections | <tenant> get <Endpoint> | <tenant> request <METHOD> <Endpoint>");
  process.exit(2);
}
const tenantId = await resolveTenant(token, sel);
if (cmd === "get") {
  if (!a1) { console.error("usage: xero.mjs <tenant> get <Endpoint>"); process.exit(2); }
  await call("GET", tenantId, a1, token);
} else if (cmd === "request") {
  if (!a1 || !a2) { console.error("usage: xero.mjs <tenant> request <METHOD> <Endpoint>"); process.exit(2); }
  const m = a1.toUpperCase();
  const body = ["POST", "PUT"].includes(m) ? await readStdin() : null;
  await call(m, tenantId, a2, token, body || null);
} else {
  console.error("commands: connections | get <Endpoint> | request <METHOD> <Endpoint>");
  process.exit(2);
}
