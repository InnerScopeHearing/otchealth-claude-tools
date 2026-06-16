#!/usr/bin/env node
// GitHub App installation helper -> 15k/hr GitHub REST + GraphQL as the org App identity
// (vs 5k for a user token). Mints an app JWT (RS256, the app PRIVATE KEY) -> installation
// access token, then calls the API. Dependency-free (Node built-ins).
//
// Creds: env first, else read from Secret Manager (otchealth-shared-prod) via the
// claude-driver SA (GCP_CLAUDE_DRIVER_SA_JSON). The PEM private key is SM-only by
// convention (PEMs are never emitted into the flat env), so the SA path is the norm:
//   github-app-id (or github-app-client-id) = JWT issuer
//   github-app-private-key                  = the .pem contents (15k requires THIS, not the
//                                             OAuth client secret and not the key fingerprint)
//   github-app-installation-id              = the org install id
//
// Usage:
//   node gh-app.mjs token                                  # installation token (+ expiry on stderr)
//   node gh-app.mjs verify                                 # prove identity + show rate limit (15000 = App)
//   node gh-app.mjs request <METHOD> <path> [body<stdin]   # generic REST at 15k
//   node gh-app.mjs ready-pr <owner> <repo> <number>       # un-draft a PR (GraphQL)
//   node gh-app.mjs merge-pr <owner> <repo> <number> [squash|merge|rebase]
//   node gh-app.mjs graphql                                # GraphQL query on stdin
import crypto from "node:crypto";

const API = "https://api.github.com";
const SM_PROJECT = "otchealth-shared-prod";
const GH = (token) => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });

// ---- Secret Manager (read-only) via the claude-driver SA --------------------
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
let _smTok = null;
async function smGet(id) {
  if (!smAvailable()) return null;
  if (!_smTok) _smTok = await smToken();
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${_smTok}` } });
  if (!r.ok) return null;
  return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
}
// env-first, then Secret Manager
async function cred(envName, secretId) {
  if (process.env[envName]) return process.env[envName];
  const v = await smGet(secretId);
  if (!v) throw new Error(`Missing ${envName} (env) / ${secretId} (Secret Manager). Provision the GitHub App creds first.`);
  return v;
}

async function loadCreds() {
  const iss = process.env.GITHUB_APP_ID || process.env.GITHUB_APP_CLIENT_ID || (await smGet("github-app-id")) || (await smGet("github-app-client-id"));
  if (!iss) throw new Error("Missing JWT issuer (GITHUB_APP_ID / github-app-id).");
  let key = await cred("GITHUB_APP_PRIVATE_KEY", "github-app-private-key");
  if (key.includes("\\n") && !key.includes("\n")) key = key.replace(/\\n/g, "\n"); // tolerate escaped newlines
  const installationId = await cred("GITHUB_APP_INSTALLATION_ID", "github-app-installation-id");
  return { iss, key, installationId };
}

function appJwt(iss, key) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const input = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 60, exp: now + 540, iss })}`;
  const sig = crypto.createSign("RSA-SHA256").update(input).sign(key, "base64url");
  return `${input}.${sig}`;
}
async function installationToken() {
  const { iss, key, installationId } = await loadCreds();
  const r = await fetch(`${API}/app/installations/${installationId}/access_tokens`, { method: "POST", headers: GH(appJwt(iss, key)) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`installation token ${r.status}: ${JSON.stringify(j).slice(0, 220)}`);
  return j; // { token, expires_at, permissions, repository_selection }
}
async function rest(method, path, token, body) {
  const url = path.startsWith("http") ? path : `${API}${path.startsWith("/") ? "" : "/"}${path}`;
  const r = await fetch(url, { method, headers: { ...GH(token), "Content-Type": "application/json" }, body: body || undefined });
  return { status: r.status, ok: r.ok, text: await r.text() };
}
async function graphql(query, token, variables) {
  const r = await fetch(`${API}/graphql`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables: variables || {} }) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && !j.errors, status: r.status, json: j };
}
function readStdin() { return new Promise((res) => { let d = ""; if (process.stdin.isTTY) return res(""); process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => res(d)); }); }

const [cmd, a1, a2, a3, a4] = process.argv.slice(2);
try {
  if (cmd === "token") {
    const t = await installationToken();
    console.log(t.token);
    console.error(`expires_at=${t.expires_at} repository_selection=${t.repository_selection}`);
  } else if (cmd === "verify") {
    const t = await installationToken();
    const rl = await rest("GET", "/rate_limit", t.token);
    const j = JSON.parse(rl.text);
    console.log(JSON.stringify({ installation_expires: t.expires_at, repository_selection: t.repository_selection, core_limit: j.resources.core.limit, core_remaining: j.resources.core.remaining, graphql_limit: j.resources.graphql.limit }, null, 2));
    console.error(j.resources.core.limit >= 15000 ? "OK: 15000 core limit confirms App-installation auth." : `NOTE: core limit ${j.resources.core.limit} (expected 15000 for an App installation on an enterprise org).`);
  } else if (cmd === "request") {
    if (!a1 || !a2) { console.error("usage: gh-app.mjs request <METHOD> <path> [body on stdin]"); process.exit(2); }
    const t = await installationToken();
    const m = a1.toUpperCase();
    const body = ["POST", "PUT", "PATCH", "DELETE"].includes(m) ? await readStdin() : null;
    const r = await rest(m, a2, t.token, body || null);
    console.error(`HTTP ${r.status} ${m} ${a2}`);
    try { console.log(JSON.stringify(JSON.parse(r.text), null, 2)); } catch { console.log(r.text); }
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === "ready-pr") {
    if (!a1 || !a2 || !a3) { console.error("usage: gh-app.mjs ready-pr <owner> <repo> <number>"); process.exit(2); }
    const t = await installationToken();
    const pr = await rest("GET", `/repos/${a1}/${a2}/pulls/${a3}`, t.token);
    const nodeId = JSON.parse(pr.text).node_id;
    const g = await graphql(`mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft number}}}`, t.token, { id: nodeId });
    console.log(JSON.stringify(g.json, null, 2));
    process.exit(g.ok ? 0 : 1);
  } else if (cmd === "merge-pr") {
    if (!a1 || !a2 || !a3) { console.error("usage: gh-app.mjs merge-pr <owner> <repo> <number> [squash|merge|rebase]"); process.exit(2); }
    const t = await installationToken();
    const method = a4 || "squash";
    const r = await rest("PUT", `/repos/${a1}/${a2}/pulls/${a3}/merge`, t.token, JSON.stringify({ merge_method: method }));
    console.error(`HTTP ${r.status} merge ${a1}/${a2}#${a3} (${method})`);
    console.log(r.text);
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === "graphql") {
    const t = await installationToken();
    const q = await readStdin();
    const g = await graphql(q, t.token);
    console.log(JSON.stringify(g.json, null, 2));
    process.exit(g.ok ? 0 : 1);
  } else {
    console.error("commands: token | verify | request <METHOD> <path> | ready-pr <o> <r> <n> | merge-pr <o> <r> <n> [method] | graphql");
    process.exit(2);
  }
} catch (e) { console.error("ERROR: " + e.message); process.exit(1); }
