#!/usr/bin/env node
// datadog.mjs — the fleet Datadog skill. Observability: metrics, events, monitors,
// dashboards, synthetic uptime checks, and the Azure cloud integration. Wielded by the
// CTO / medic / growth agents. Dependency-free (Node 18+).
//
// Auth (env first, else Secret Manager via the claude-driver SA):
//   DD_API_KEY  (datadog-api-key)   — metric/event submission + validate
//   DD_APP_KEY  (datadog-app-key)   — management API (monitors/dashboards/synthetics/integrations)
//   DD_SITE     (datadog-site)      — e.g. us3.datadoghq.com  (API base = https://api.<site>)
//
// PHI WALL: do NOT point Datadog APM/logs at MedReview or Companion (PHI/BAA) until a
// Datadog BAA is signed + PHI scrubbing is configured. Non-PHI apps + infra are fine.
//
// Usage:
//   node datadog.mjs verify                                    # validate keys + print org
//   node datadog.mjs metric <name> <value> [--tags a:b,c:d] [--type gauge|count|rate]
//   node datadog.mjs event "<title>" "<text>" [--tags ...]
//   node datadog.mjs monitors                                  # list monitors
//   node datadog.mjs monitor "<type>" "<query>" "<name>" ["<message>"]
//   node datadog.mjs dashboards                                # list dashboards
//   node datadog.mjs dashboard <file.json>                     # create a dashboard from JSON
//   node datadog.mjs synthetic <url> "<name>" [--tags ...]     # HTTP uptime test (every 5m)
//   node datadog.mjs azure-integration                         # wire the Azure cloud integration (azure-sp)
//   node datadog.mjs azure-list                                # list configured Azure integrations
//   node datadog.mjs request <METHOD> <path> [body<stdin]      # generic API passthrough

import crypto from "node:crypto";

const SM = "otchealth-shared-prod";
// ---- Azure Key Vault (fleet secret store; GCP Secret Manager retired, billing off) ----
// Inlined (not imported) because this skill documents itself as dependency-free above; mirrors the
// shared skills/kb-memory/azure-secret.mjs helper 1:1.
let _kvTok = null, _kvExp = 0;
async function kvToken() {
  const t = process.env.AZURE_SP_TENANT_ID, c = process.env.AZURE_SP_CLIENT_ID, s = process.env.AZURE_SP_CLIENT_SECRET;
  if (!t || !c || !s) return null;
  const now = Date.now();
  if (_kvTok && _kvExp - now > 60000) return _kvTok;
  try {
    const r = await fetch(`https://login.microsoftonline.com/${t}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: c, client_secret: s, scope: "https://vault.azure.net/.default" }) });
    const j = await r.json();
    if (!j.access_token) return null;
    _kvTok = j.access_token; _kvExp = now + (Number(j.expires_in) || 3600) * 1000; return _kvTok;
  } catch { return null; }
}
async function kvRead(name) {
  const vault = process.env.AZURE_KEYVAULT_NAME || "kv-otc-55c84f6bef";
  const tok = await kvToken(); if (!tok) return null;
  try {
    const r = await fetch(`https://${vault}.vault.azure.net/secrets/${name}?api-version=7.4`, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) return null;
    const v = (await r.json()).value;
    return v == null ? null : String(v).trim() || null;
  } catch { return null; }
}
async function smToken() {
  const sa = JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const e = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const i = `${e({ alg: "RS256", typ: "JWT" })}.${e({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const s = crypto.createSign("RSA-SHA256").update(i).sign(sa.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(i + "." + s)}` });
  if (!r.ok) throw new Error("SM auth " + r.status);
  return (await r.json()).access_token;
}
async function smRead(id) {
  // Azure Key Vault FIRST (GCP Secret Manager retired). Secret names are identical.
  const kv = await kvRead(id);
  if (kv != null) return kv;
  // Legacy GCP fallback ONLY if a claude-driver SA is present (else smToken's JSON.parse would throw).
  if (!process.env.GCP_CLAUDE_DRIVER_SA_JSON) return null;
  try {
    const t = await smToken();
    const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${t}` } });
    if (!r.ok) return null;
    return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
  } catch { return null; }
}
async function cred(env, id) { return process.env[env] || (await smRead(id)); }

const SITE = (await cred("DD_SITE", "datadog-site")) || "datadoghq.com";
const BASE = `https://api.${SITE}`;
let API_KEY, APP_KEY;
async function keys() {
  API_KEY = API_KEY || (await cred("DD_API_KEY", "datadog-api-key"));
  APP_KEY = APP_KEY || (await cred("DD_APP_KEY", "datadog-app-key"));
  if (!API_KEY) { console.error("Missing DD_API_KEY (secret datadog-api-key)."); process.exit(2); }
}
function H(appNeeded) {
  const h = { "DD-API-KEY": API_KEY, "Content-Type": "application/json" };
  if (appNeeded) { if (!APP_KEY) { console.error("Missing DD_APP_KEY (secret datadog-app-key) for management API."); process.exit(2); } h["DD-APPLICATION-KEY"] = APP_KEY; }
  return h;
}
async function dd(method, path, body, appNeeded = true) {
  const r = await fetch(BASE + path, { method, headers: H(appNeeded), body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  if (!r.ok) { console.error(`Datadog HTTP ${r.status} ${method} ${path}: ${txt.slice(0, 300)}`); process.exit(1); }
  try { return JSON.parse(txt); } catch { return txt; }
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const tags = (flag("tags") || "").split(",").map((s) => s.trim()).filter(Boolean);
const pos = argv.slice(1).filter((a, i, arr) => !a.startsWith("--") && !(arr[i - 1] || "").startsWith("--"));

await keys();
try {
  if (cmd === "verify") {
    const v = await dd("GET", "/api/v1/validate", null, false);
    console.log("API key valid:", v.valid === true);
    const org = await dd("GET", "/api/v1/org");
    const o = (org.orgs && org.orgs[0]) || {};
    console.log(`org: ${o.name} | public_id: ${o.public_id} | site: ${SITE}`);

  } else if (cmd === "metric") {
    const [name, value] = pos;
    if (!name || value === undefined) { console.error('usage: metric <name> <value> [--tags a:b] [--type gauge|count|rate]'); process.exit(2); }
    const typeMap = { unspecified: 0, count: 1, rate: 2, gauge: 3 };
    const body = { series: [{ metric: name, type: typeMap[flag("type") || "gauge"] ?? 3, points: [{ timestamp: Math.floor(Date.now() / 1000), value: Number(value) }], tags }] };
    await dd("POST", "/api/v2/series", body);
    console.log(`submitted ${name}=${value} ${tags.length ? "tags=" + tags.join(",") : ""}`);

  } else if (cmd === "event") {
    const [title, text] = pos;
    if (!title || !text) { console.error('usage: event "<title>" "<text>" [--tags ...]'); process.exit(2); }
    const r = await dd("POST", "/api/v1/events", { title, text, tags }, false);
    console.log("event posted:", r.event?.id || "ok");

  } else if (cmd === "monitors") {
    const m = await dd("GET", "/api/v1/monitor");
    console.log(`${m.length} monitor(s):`);
    for (const x of m) console.log(`  ${x.id} | ${x.type} | ${x.name} | ${x.overall_state}`);

  } else if (cmd === "monitor") {
    const [type, query, name, message] = pos;
    if (!type || !query || !name) { console.error('usage: monitor "<type>" "<query>" "<name>" ["<message>"]'); process.exit(2); }
    const r = await dd("POST", "/api/v1/monitor", { type, query, name, message: message || "", tags });
    console.log(`created monitor ${r.id}: ${r.name}`);

  } else if (cmd === "dashboards") {
    const d = await dd("GET", "/api/v1/dashboard");
    console.log(`${(d.dashboards || []).length} dashboard(s):`);
    for (const x of (d.dashboards || [])) console.log(`  ${x.id} | ${x.title}  https://${SITE}${x.url || ""}`);

  } else if (cmd === "dashboard") {
    const file = pos[0];
    if (!file) { console.error("usage: dashboard <file.json>"); process.exit(2); }
    const body = JSON.parse((await import("node:fs")).readFileSync(file, "utf8"));
    const r = await dd("POST", "/api/v1/dashboard", body);
    console.log(`created dashboard ${r.id}: ${r.title}  https://${SITE}${r.url || ""}`);

  } else if (cmd === "synthetic") {
    const [url, name] = pos;
    if (!url || !name) { console.error('usage: synthetic <url> "<name>" [--tags ...]'); process.exit(2); }
    const body = {
      name, type: "api", subtype: "http", message: "", tags,
      config: { request: { method: "GET", url }, assertions: [{ type: "statusCode", operator: "is", target: 200 }, { type: "responseTime", operator: "lessThan", target: 5000 }] },
      locations: ["aws:us-east-1", "aws:us-west-1"],
      options: { tick_every: 300, min_failure_duration: 0, min_location_failed: 1 },
    };
    const r = await dd("POST", "/api/v1/synthetics/tests", body);
    console.log(`created synthetic ${r.public_id}: ${name} -> ${url}`);

  } else if (cmd === "azure-integration") {
    // Wire the Azure cloud integration using the azure-sp (Reader/Contributor on the sub).
    const tenant = await cred("AZURE_SP_TENANT_ID", "azure-sp-tenant-id") || await smRead("azure-tenant-id");
    const clientId = await cred("AZURE_SP_CLIENT_ID", "azure-sp-client-id");
    const clientSecret = await cred("AZURE_SP_CLIENT_SECRET", "azure-sp-client-secret");
    if (!tenant || !clientId || !clientSecret) { console.error("Missing azure-sp creds (azure-sp-tenant-id/client-id/client-secret) to wire the Azure integration."); process.exit(2); }
    const r = await dd("POST", "/api/v1/integration/azure", { tenant_name: tenant, client_id: clientId, client_secret: clientSecret, host_filters: "" });
    console.log("Azure integration wired:", JSON.stringify(r).slice(0, 120) || "ok");

  } else if (cmd === "azure-list") {
    const r = await dd("GET", "/api/v1/integration/azure");
    console.log(JSON.stringify(r, null, 2).slice(0, 800));

  } else if (cmd === "request") {
    const method = (pos[0] || "GET").toUpperCase(), path = pos[1];
    if (!path) { console.error("usage: request <METHOD> <path> [body<stdin]"); process.exit(2); }
    let body = null;
    if (["POST", "PUT", "PATCH"].includes(method) && !process.stdin.isTTY) { body = JSON.parse(await new Promise((res) => { let d = ""; process.stdin.on("data", (c) => d += c); process.stdin.on("end", () => res(d || "null")); })); }
    console.log(JSON.stringify(await dd(method, path, body), null, 2));

  } else {
    console.error('commands: verify | metric <name> <value> | event "<t>" "<x>" | monitors | monitor "<type>" "<query>" "<name>" | dashboards | dashboard <file.json> | synthetic <url> "<name>" | azure-integration | azure-list | request <M> <path>');
    process.exit(2);
  }
} catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
