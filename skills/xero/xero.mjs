#!/usr/bin/env node
// Xero multi-ORG helper for the CFO. Supports PER-ORG refresh tokens (each org a separate
// Xero account/login) and multi-tenant tokens. One Xero developer app; per-org token in
// Secret Manager as `xero-refresh-token-<orgKey>`. Auto-persists Xero's rotate-on-use.
//
// Creds (SM-hydrated): XERO_CLIENT_ID, XERO_CLIENT_SECRET (the one app).
// Per org: SM `xero-refresh-token-<orgKey>` (preferred, SA-hydrated) or env
//   XERO_REFRESH_TOKEN_<ORGKEY>. orgKey: otchealth | innd | hearingassist | personal.
//   (Legacy `xero-refresh-token` / XERO_REFRESH_TOKEN is the otchealth fallback.)
// GCP_CLAUDE_DRIVER_SA_JSON enables read-latest + rotate-persist to Secret Manager.
//
// Usage:
//   node xero.mjs connections [org]                    # list reachable org(s); all known if omitted
//   node xero.mjs <org> get <Endpoint>                 # e.g. otchealth get Organisation
//   node xero.mjs <org> request <METHOD> <Endpoint>    # JSON body on stdin for writes
//   <org> = otchealth | innd | hearingassist | personal (or a name substring)
import crypto from "node:crypto";
import { getAccessContext } from "./xero-token.mjs";

const TOKEN_URL = "https://identity.xero.com/connect/token";
const CONN_URL = "https://api.xero.com/connections";
const API = "https://api.xero.com/api.xro/2.0";
const SM_PROJECT = "otchealth-shared-prod";
const ORG_KEYS = ["otchealth", "innd", "hearingassist", "personal"];

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}. Hydrate the Xero creds first.`);
  return v;
}
function orgKeyFrom(sel) {
  const s = (sel || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (s.includes("otchealth")) return "otchealth";
  if (s.includes("innerscope") || s.includes("innd")) return "innd";
  if (s.includes("hearing")) return "hearingassist";
  if (s.includes("personal") || s.includes("matt")) return "personal";
  return s;
}

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
async function smReadLatest(t, id) {
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } });
  if (!r.ok) return null;
  return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
}
async function smAddVersion(t, id, v) {
  const body = JSON.stringify({ payload: { data: Buffer.from(v, "utf8").toString("base64") } });
  const add = () => fetch(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets/${id}:addVersion`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body });
  let r = await add();
  if (r.status === 404) {
    // Secret container does not exist yet (first per-org token). Create it, then add the version.
    const c = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets?secretId=${id}`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify({ replication: { automatic: {} } }) });
    if (!c.ok && c.status !== 409) throw new Error("SM create " + c.status);
    r = await add();
  }
  if (!r.ok) throw new Error("SM addVersion " + r.status);
}

// Client creds: prefer env (Claude-side hydration), else self-fetch from SM (Hyperagent: the
// kb-memory wrapper provides only the GCP SA, not XERO_*). Makes the skill portable across engines.
async function clientBasic(smTok) {
  let id = process.env.XERO_CLIENT_ID, sec = process.env.XERO_CLIENT_SECRET;
  if ((!id || !sec) && smTok) {
    try {
      id = id || await smReadLatest(smTok, "xero-client-id");
      sec = sec || await smReadLatest(smTok, "xero-client-secret");
    } catch (e) { console.error("SM client-cred read failed: " + e.message); }
  }
  if (!id || !sec) throw new Error("Missing XERO_CLIENT_ID/SECRET (env or SM xero-client-id/xero-client-secret).");
  return Buffer.from(`${id}:${sec}`).toString("base64");
}

// Token acquisition delegates to the shared broker (access-token cache + cross-process refresh lock +
// disconnect detection). This eliminates the per-call single-use rotation race. The legacy SM/refresh
// helpers above are retained for back-compat but no longer the hot path. Stashes the resolved tenant so
// the get/request path can skip a redundant /connections call.
const _tenantByOrg = {};
async function accessToken(orgKey) {
  const c = await getAccessContext(orgKey);
  _tenantByOrg[orgKey] = c.tenantId;
  return c.access_token;
}

async function connections(token) {
  const r = await fetch(CONN_URL, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!r.ok) throw new Error(`connections ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return await r.json();
}
async function resolveTenant(token, sel) {
  const conns = await connections(token);
  if (!conns.length) throw new Error("no tenants on this token");
  const hit = conns.find((c) => c.tenantId === sel) || conns.find((c) => (c.tenantName || "").toLowerCase().includes((sel || "").toLowerCase())) || conns[0];
  return hit.tenantId;
}
async function call(method, tenantId, endpoint, token, body) {
  const ep = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const r = await fetch(`${API}${ep}`, { method, headers: { Authorization: `Bearer ${token}`, "Xero-tenant-id": tenantId, Accept: "application/json", "Content-Type": "application/json" }, body: body || undefined });
  const text = await r.text();
  console.error(`HTTP ${r.status} ${method} ${ep}`);
  try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log(text); }
  process.exit(r.ok ? 0 : 1);
}
function readStdin() { return new Promise((res) => { let d = ""; if (process.stdin.isTTY) return res(""); process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => res(d)); }); }

const args = process.argv.slice(2);
try {
  if (args[0] === "connections") {
    const orgs = args[1] ? [orgKeyFrom(args[1])] : ORG_KEYS;
    for (const ok of orgs) {
      try { const tok = await accessToken(ok); const cs = await connections(tok); for (const x of cs) console.log(`${ok}: ${x.tenantName} | ${x.tenantId}`); }
      catch (e) { console.error(`${ok}: ${e.message}`); }
    }
    process.exit(0);
  }
  const [sel, cmd, a1, a2] = args;
  if (!sel || !cmd) { console.error("usage: xero.mjs connections [org] | <org> get <Endpoint> | <org> request <METHOD> <Endpoint>"); process.exit(2); }
  const orgKey = orgKeyFrom(sel);
  const token = await accessToken(orgKey);
  const tenantId = _tenantByOrg[orgKey] || await resolveTenant(token, sel);
  if (cmd === "get") {
    if (!a1) { console.error("usage: xero.mjs <org> get <Endpoint>"); process.exit(2); }
    await call("GET", tenantId, a1, token);
  } else if (cmd === "request") {
    if (!a1 || !a2) { console.error("usage: xero.mjs <org> request <METHOD> <Endpoint>"); process.exit(2); }
    const m = a1.toUpperCase();
    const body = ["POST", "PUT"].includes(m) ? await readStdin() : null;
    await call(m, tenantId, a2, token, body || null);
  } else { console.error("commands: connections | get <Endpoint> | request <METHOD> <Endpoint>"); process.exit(2); }
} catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
