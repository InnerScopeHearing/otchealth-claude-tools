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
import crypto from "node:crypto";

const API = "https://api.xero.com/api.xro/2.0";
const SM_PROJECT = "otchealth-shared-prod";
const SM_SECRET_ID = "xero-refresh-token";

// --- Secret Manager (claude-driver SA): read-latest + persist the rotated refresh token ---
// Xero rotates the refresh token on every use, so the skill reads the newest from SM and
// writes the rotated one back, surviving unattended operation. Falls back to env if no SA.
function smAvailable() { return !!process.env.GCP_CLAUDE_DRIVER_SA_JSON; }
async function smToken() {
  const sa = JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const input = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const sig = crypto.createSign("RSA-SHA256").update(input).sign(sa.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(input + "." + sig)}` });
  if (!r.ok) throw new Error("SM token " + r.status);
  return (await r.json()).access_token;
}
async function smReadLatest(t) {
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets/${SM_SECRET_ID}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } });
  if (!r.ok) return null;
  return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
}
async function smAddVersion(t, v) {
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets/${SM_SECRET_ID}:addVersion`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify({ payload: { data: Buffer.from(v, "utf8").toString("base64") } }) });
  if (!r.ok) throw new Error("SM addVersion " + r.status);
}

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
  // Prefer the latest refresh token from Secret Manager (survives rotate-on-use); else env.
  let smTok = null, refresh;
  if (smAvailable()) {
    try { smTok = await smToken(); refresh = await smReadLatest(smTok); }
    catch (e) { console.error("SM read failed, using env XERO_REFRESH_TOKEN: " + e.message); }
  }
  if (!refresh) refresh = need("XERO_REFRESH_TOKEN");
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refresh)}`,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error(`token refresh failed ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    process.exit(1);
  }
  // Xero rotates the refresh token on EVERY use; persist the new one or the connection dies.
  if (j.refresh_token && j.refresh_token !== refresh) {
    if (smTok) {
      try { await smAddVersion(smTok, j.refresh_token); console.error("Xero rotated the refresh token -> persisted to Secret Manager."); }
      catch (e) { console.error("ROTATE PERSIST FAILED (" + e.message + "): new refresh token NOT saved; connection may break."); }
    } else {
      console.error("NOTE: Xero rotated the refresh token but no SA to persist it. Update xero-refresh-token in the vault or the connection will break.");
    }
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
