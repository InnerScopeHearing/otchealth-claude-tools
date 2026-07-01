// signal-radar/common.mjs — shared I/O helpers for the radar core + detectors.
// Dependency-free (no npm packages), mirrors the fleet-medic / vault-registry style: a single
// claude-driver SA JWT resolves everything else out of otchealth-shared-prod Secret Manager.
// Every helper here fails CLOSED to the CALLER (throws), so each detector's own try/catch decides
// fail-open behavior; this file does not itself hide errors.
import crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";

export const SM = "otchealth-shared-prod";

// ---------------------------- GCP Secret Manager (claude-driver SA) ----------------------------
function resolveSaRaw() {
  if (process.env.GCP_CLAUDE_DRIVER_SA_JSON) return process.env.GCP_CLAUDE_DRIVER_SA_JSON;
  try { return readFileSync(`${homedir()}/.gcp_claude_driver_sa.json`, "utf8"); } catch { return null; }
}
export const SA_RAW = resolveSaRaw();

let _gcpToken = null, _gcpTokenExp = 0;
async function gcpToken() {
  if (_gcpToken && Date.now() < _gcpTokenExp - 30000) return _gcpToken;
  if (!SA_RAW) throw new Error("no GCP service account (GCP_CLAUDE_DRIVER_SA_JSON unset)");
  const sa = JSON.parse(SA_RAW);
  const n = Math.floor(Date.now() / 1000);
  const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: n, exp: n + 3600 })}`;
  const jwt = i + "." + crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(jwt)}` });
  const j = await r.json();
  if (!j.access_token) throw new Error("GCP token exchange failed: " + JSON.stringify(j).slice(0, 200));
  _gcpToken = j.access_token; _gcpTokenExp = Date.now() + 3500 * 1000;
  return _gcpToken;
}

const _smCache = new Map();
/** Fetch a secret's latest version. Returns null (not an error) on 404/missing so callers can feature-detect. */
export async function sm(id) {
  if (_smCache.has(id)) return _smCache.get(id);
  const t = await gcpToken();
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: "Bearer " + t } });
  const val = r.ok ? Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim() : null;
  _smCache.set(id, val);
  return val;
}

/** List every secret id + its createTime (for the rotate-age detector). */
export async function listSecrets() {
  const t = await gcpToken();
  const out = []; let pt = "";
  do {
    const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets?pageSize=200${pt ? `&pageToken=${pt}` : ""}`, { headers: { Authorization: "Bearer " + t } });
    if (!r.ok) break;
    const j = await r.json();
    for (const s of (j.secrets || [])) out.push({ id: s.name.split("/secrets/")[1], created: s.createTime || null });
    pt = j.nextPageToken || "";
  } while (pt);
  return out;
}

// ------------------------------------- PostHog (Fleet Agents) -------------------------------------
let _phCreds = null;
async function phCreds() {
  if (_phCreds) return _phCreds;
  const key = await sm("posthog-personal-api-key");
  const pid = await sm("posthog-fleet-project-id");
  if (!key || !pid) throw new Error("PostHog fleet creds missing (posthog-personal-api-key / posthog-fleet-project-id)");
  _phCreds = { key, pid };
  return _phCreds;
}

/** Run a HogQL query against the Fleet Agents PostHog project. Returns {columns, results} raw rows. */
export async function posthogQuery(hql) {
  const { key, pid } = await phCreds();
  const r = await fetch(`https://us.posthog.com/api/projects/${pid}/query/`, {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query: hql } }),
  });
  if (!r.ok) throw new Error(`PostHog query ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return { columns: j.columns || [], results: j.results || [] };
}

/** Emit an event into the Fleet Agents PostHog project (best-effort; never throws). */
export async function posthogEmit(event, distinctId, properties) {
  try {
    const ingestKey = await sm("posthog-fleet-ingest-key");
    if (!ingestKey) return false;
    await fetch("https://us.i.posthog.com/capture/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: ingestKey, event, distinct_id: distinctId, timestamp: new Date().toISOString(), properties: { $lib: "signal-radar", ...properties } }),
    });
    return true;
  } catch { return false; }
}

// ----------------------------------------- Sentry (org otchealth-inc) -----------------------------------------
const SENTRY_ORG = "otchealth-inc";
export async function sentryRequest(path) {
  const token = await sm("sentry-auth-token");
  if (!token) throw new Error("sentry-auth-token missing");
  const r = await fetch(`https://sentry.io/api/0${path}`, { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) throw new Error(`Sentry ${path} -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
export const SENTRY_ORG_SLUG = SENTRY_ORG;

// --------------------------------------- Azure ARM (azure-sp, read-only use here) ---------------------------------------
let _armToken = null, _armTokenExp = 0;
export async function armToken() {
  if (_armToken && Date.now() < _armTokenExp - 30000) return _armToken;
  const cid = await sm("azure-sp-client-id"), csec = await sm("azure-sp-client-secret"), tid = await sm("azure-sp-tenant-id");
  if (!cid || !csec || !tid) throw new Error("azure-sp credentials missing");
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: cid, client_secret: csec, scope: "https://management.azure.com/.default" });
  const r = await fetch(`https://login.microsoftonline.com/${tid}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const j = await r.json();
  if (!j.access_token) throw new Error("ARM token exchange failed: " + JSON.stringify(j).slice(0, 200));
  _armToken = j.access_token; _armTokenExp = Date.now() + 3500 * 1000;
  return _armToken;
}

// ------------------------------------ Cosmos DB for NoSQL (signals container) ------------------------------------
// Dependency-free REST data-plane client, same auth scheme as otchealth-mcp-server's
// src/agentstate/cosmos.ts (master-key HMAC). Kept local (not imported cross-repo) because this
// repo is a plain-Node skills toolkit with no build step; the auth math is intentionally identical.
function cosmosAuthToken(verb, resType, resourceLink, date, masterKey) {
  const stringToSign = `${verb.toLowerCase()}\n${resType.toLowerCase()}\n${resourceLink}\n${date.toLowerCase()}\n\n`;
  const sig = crypto.createHmac("sha256", Buffer.from(masterKey, "base64")).update(stringToSign, "utf8").digest("base64");
  return encodeURIComponent(`type=master&ver=1.0&sig=${sig}`);
}

let _cosmosCfg = null;
/** Resolve {endpoint, key, db} from Secret Manager. Returns null (feature-detect) if not provisioned. */
export async function cosmosConfig() {
  if (_cosmosCfg !== null) return _cosmosCfg || null;
  const endpoint = await sm("cosmos-endpoint");
  const key = await sm("cosmos-key");
  const db = await sm("cosmos-db");
  if (!endpoint || !key || !db) { _cosmosCfg = false; return null; }
  _cosmosCfg = { endpoint: endpoint.replace(/\/+$/, ""), key, db };
  return _cosmosCfg;
}

async function cosmosRequest(verb, resType, resourceLink, urlPath, opts = {}) {
  const c = await cosmosConfig();
  if (!c) throw new Error("Cosmos not configured (cosmos-endpoint/cosmos-key/cosmos-db secrets missing)");
  const date = new Date().toUTCString();
  const headers = {
    Authorization: cosmosAuthToken(verb, resType, resourceLink, date, c.key),
    "x-ms-date": date, "x-ms-version": "2018-12-31", Accept: "application/json",
  };
  if (opts.pk !== undefined) headers["x-ms-documentdb-partitionkey"] = JSON.stringify([opts.pk]);
  if (opts.isQuery) { headers["Content-Type"] = "application/query+json"; headers["x-ms-documentdb-isquery"] = "true"; }
  else if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.upsert) headers["x-ms-documentdb-is-upsert"] = "true";
  const r = await fetch(`${c.endpoint}/${urlPath}`, { method: verb, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const txt = await r.text();
  let body = null; try { body = txt ? JSON.parse(txt) : null; } catch { body = { raw: txt }; }
  return { status: r.status, ok: r.ok, body };
}

/** Write a Signal doc into the `signals` container, partitioned by owner. Idempotent upsert. */
export async function cosmosPutSignal(doc) {
  const c = await cosmosConfig();
  if (!c) return { ok: false, reason: "not-configured" };
  const link = `dbs/${c.db}/colls/signals`;
  const res = await cosmosRequest("POST", "docs", link, `${link}/docs`, { pk: doc.owner, body: doc, upsert: true });
  if (!res.ok) throw new Error(`Cosmos put signal -> ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
  return { ok: true };
}

/** Query the `signals` container for a single owner partition (used for cooldown/consecutive lookups). */
export async function cosmosQuerySignals(owner, query, parameters = []) {
  const c = await cosmosConfig();
  if (!c) return [];
  const link = `dbs/${c.db}/colls/signals`;
  const res = await cosmosRequest("POST", "docs", link, `${link}/docs`, { isQuery: true, pk: owner, body: { query, parameters } });
  if (!res.ok) return [];
  return (res.body && res.body.Documents) || [];
}

// ------------------------------------------- fleet-dispatch -------------------------------------------
// Route a signal to its owning agent's inbox via the existing fleet-dispatch skill (subprocess, so this
// file stays dependency-free and does not need to duplicate dispatch.mjs's Azure-commons blob logic).
export async function dispatchToOwner(owner, text, { execFileSync, dispatchPath } = {}) {
  if (!execFileSync || !dispatchPath) return false;
  try {
    execFileSync("node", [dispatchPath, "send", owner, text, "--from", "signal-radar"], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch { return false; }
}
