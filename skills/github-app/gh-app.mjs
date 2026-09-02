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
// HARDENING (2026-07-17): `token` was intermittently hanging 2-4min with no way to fail fast, because
// every outbound HTTP call in the mint path (the Secret Manager JWT-bearer request + the installation-
// token exchange) had no bounded timeout, no retry, and no caching, so a slow network path stalled the
// whole call and every subsequent invocation re-minted from scratch. Now: every fetch in the mint path
// is bounded to a ~10s timeout (AbortController) so a stall fails fast with a clear message instead of
// hanging; the installation-token exchange retries with bounded backoff on network error/timeout/5xx
// ONLY (never a 4xx -- a bad credential is a real error, not a flake); and the minted token is cached
// to a session-local temp file (chmod 600, keyed by installation id) and reused while it has >5min of
// validity left, so repeated token/verify/request/ready-pr/merge-pr/graphql calls in one session are
// instant after the first mint. See isTokenFresh()/shouldRetry() below + tests/gh-app.test.mjs.
//
// Usage:
//   node gh-app.mjs token [--no-cache]                     # installation token (+ expiry on stderr)
//   node gh-app.mjs verify [--no-cache]                    # prove identity + show rate limit (15000 = App)
//   node gh-app.mjs request <METHOD> <path> [body<stdin]   # generic REST at 15k
//   node gh-app.mjs ready-pr <owner> <repo> <number>       # un-draft a PR (GraphQL)
//   node gh-app.mjs merge-pr <owner> <repo> <number> [squash|merge|rebase]
//   node gh-app.mjs graphql                                # GraphQL query on stdin
// `--no-cache` works on every command: bypasses the token cache entirely (always mints fresh; never
// reads or writes the cache file). Useful when debugging or right after rotating the app key.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { join as joinPath } from "node:path";
import { pathToFileURL } from "node:url";
import { kvSecret } from "../kb-memory/azure-secret.mjs";

const API = "https://api.github.com";
const SM_PROJECT = "otchealth-shared-prod";
const GH = (token) => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });

// ---- network hardening: bounded timeout + retry classification --------------------------------
const REQUEST_TIMEOUT_MS = 10_000; // per-request bound; a stalled connection fails fast, not in 2-4min
const MINT_RETRY_DELAYS_MS = [1000, 2000, 4000]; // 3 retries: ~1s/2s/4s backoff (4 attempts total)
const TOKEN_CACHE_MARGIN_MS = 5 * 60 * 1000; // reuse a cached token until 5min before it actually expires

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// fetch() bounded by an AbortController timeout. Throws a clear, immediate error on abort instead of
// letting a stalled connection hang the caller for minutes (the reported bug).
async function fetchWithTimeout(url, init, timeoutMs = REQUEST_TIMEOUT_MS) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error(`request timed out after ${timeoutMs}ms: ${url}`);
    throw e;
  } finally {
    clearTimeout(to);
  }
}

// Pure: should a failed mint attempt be retried? Network-level failure (fetch threw -- includes our
// own timeout abort) or a 5xx (transient GitHub/Google trouble) -> retry. A 4xx (bad credentials, wrong
// installation id, malformed request) is a real error a retry cannot fix -> fail loud immediately.
// Exported for tests.
export function shouldRetry(status, networkError) {
  if (networkError) return true;
  return typeof status === "number" && status >= 500 && status < 600;
}

// Pure: is a cached token still safe to reuse? `expiresAt` is GitHub's `expires_at` (an ISO 8601
// string) or a millisecond-epoch number. True while more than `marginMs` of validity remains as of
// `nowMs`; false (never trust the cache) on a missing/unparsable expiry. Exported for tests.
export function isTokenFresh(expiresAt, nowMs = Date.now(), marginMs = TOKEN_CACHE_MARGIN_MS) {
  const expiryMs = typeof expiresAt === "number" ? expiresAt : Date.parse(expiresAt);
  if (!Number.isFinite(expiryMs)) return false;
  return expiryMs - marginMs > nowMs;
}

// ---- installation-token cache: session-local temp file, chmod 600, keyed by installation id ----
function tokenCacheDir() { return process.env.GH_APP_TOKEN_CACHE_DIR || os.tmpdir(); }
// Exported so tests (and callers that want to inspect/clean the cache) can compute the same path.
export function cacheFilePath(installationId) { return joinPath(tokenCacheDir(), `.gh-app-token-${installationId}.json`); }

function readTokenCache(installationId) {
  try {
    const data = JSON.parse(fs.readFileSync(cacheFilePath(installationId), "utf8"));
    if (data && typeof data.token === "string" && data.expires_at) return data;
  } catch { /* absent / corrupt / unreadable -> treat as no cache, mint fresh */ }
  return null;
}

// Write via a unique temp file + atomic rename (never write through the final path directly) so a
// pre-existing symlink at the cache path can't redirect the write (CWE-377/CWE-59 -- rename() replaces
// the directory entry itself, it does not follow a symlink there), and chmod 600 explicitly (belt +
// suspenders over the create-time `mode`, which the process umask can loosen). Caching is best-effort:
// a failure here never breaks the mint the caller is waiting on.
function writeTokenCache(installationId, tokenObj) {
  try {
    const file = cacheFilePath(installationId);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(tokenObj), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch { /* best-effort cache; never fail a mint because the cache write failed */ }
}

// ---- Secret Manager (read-only) via the claude-driver SA --------------------
function smAvailable() { return !!process.env.GCP_CLAUDE_DRIVER_SA_JSON; }
async function smToken() {
  const sa = JSON.parse(process.env.GCP_CLAUDE_DRIVER_SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const input = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const sig = crypto.createSign("RSA-SHA256").update(input).sign(sa.private_key, "base64url");
  const r = await fetchWithTimeout("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(input + "." + sig)}` });
  if (!r.ok) throw new Error("SM auth " + r.status);
  return (await r.json()).access_token;
}
let _smTok = null;
async function smGet(id) {
  if (!smAvailable()) return null;
  if (!_smTok) _smTok = await smToken();
  const r = await fetchWithTimeout(`https://secretmanager.googleapis.com/v1/projects/${SM_PROJECT}/secrets/${id}/versions/latest:access`, { headers: { Authorization: `Bearer ${_smTok}` } });
  if (!r.ok) return null;
  return Buffer.from((await r.json()).payload.data, "base64").toString("utf8").trim();
}
// env-first, then Azure Key Vault (the live store post-GCP-exit), then GCP Secret Manager (legacy).
async function cred(envName, secretId) {
  if (process.env[envName]) return process.env[envName];
  const kv = await kvSecret(secretId);
  if (kv) return kv;
  const v = await smGet(secretId);
  if (!v) throw new Error(`Missing ${envName} (env) / ${secretId} (Key Vault or Secret Manager). Provision the GitHub App creds first.`);
  return v;
}

// Just the installation id -- cheap (env-first, no network in the common hydrated-session case) and
// all a cache-read needs, so a cache HIT below never resolves or touches the private key.
async function loadInstallationId() {
  return cred("GITHUB_APP_INSTALLATION_ID", "github-app-installation-id");
}
// The JWT-signing credentials -- only resolved on a cache MISS (i.e. only when actually about to
// mint), so the private key is touched no more than necessary.
async function loadSigningCreds() {
  const iss = process.env.GITHUB_APP_ID || process.env.GITHUB_APP_CLIENT_ID
    || (await kvSecret("github-app-id")) || (await kvSecret("github-app-client-id"))
    || (await smGet("github-app-id")) || (await smGet("github-app-client-id"));
  if (!iss) throw new Error("Missing JWT issuer (GITHUB_APP_ID / github-app-id).");
  let key = await cred("GITHUB_APP_PRIVATE_KEY", "github-app-private-key");
  if (key.includes("\\n") && !key.includes("\n")) key = key.replace(/\\n/g, "\n"); // tolerate escaped newlines
  return { iss, key };
}

function appJwt(iss, key) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const input = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 60, exp: now + 540, iss })}`;
  const sig = crypto.createSign("RSA-SHA256").update(input).sign(key, "base64url");
  return `${input}.${sig}`;
}

// The actual JWT -> installation-token exchange (POST /app/installations/{id}/access_tokens): bounded
// per-request timeout + bounded exponential-backoff retry on network/timeout/5xx only, never on a 4xx.
// Takes an already-signed JWT (not iss/key) so tests never need a real RSA key to exercise this.
// Exported for tests.
export async function exchangeInstallationToken(jwt, installationId, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const retryDelaysMs = opts.retryDelaysMs ?? MINT_RETRY_DELAYS_MS;
  const url = `${API}/app/installations/${installationId}/access_tokens`;
  const maxAttempts = retryDelaysMs.length + 1;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res;
    try {
      res = await fetchWithTimeout(url, { method: "POST", headers: GH(jwt) }, timeoutMs);
    } catch (e) {
      lastError = new Error(`installation token request failed: ${e.message}`);
      if (attempt < maxAttempts && shouldRetry(undefined, true)) { await sleep(retryDelaysMs[attempt - 1]); continue; }
      throw lastError;
    }
    if (res.ok) return await res.json().catch(() => ({}));
    const j = await res.json().catch(() => ({}));
    lastError = new Error(`installation token ${res.status}: ${JSON.stringify(j).slice(0, 220)}`);
    if (attempt < maxAttempts && shouldRetry(res.status, false)) { await sleep(retryDelaysMs[attempt - 1]); continue; }
    throw lastError;
  }
  throw lastError; // unreachable (loop always returns or throws)
}

// Cache-aware installation-token mint: reuse a cached token with >5min validity left; otherwise
// resolve signing creds, mint fresh (bounded timeout + retry), and cache the result keyed by
// installation id. `noCache: true` (the CLI `--no-cache` flag) skips BOTH the cache read and the
// cache write for this call. Exported for tests and for any future in-process caller.
export async function installationToken({ noCache = false } = {}) {
  const installationId = await loadInstallationId();
  if (!noCache) {
    const cached = readTokenCache(installationId);
    if (cached && isTokenFresh(cached.expires_at)) return cached;
  }
  const { iss, key } = await loadSigningCreds();
  const t = await exchangeInstallationToken(appJwt(iss, key), installationId);
  if (!noCache) writeTokenCache(installationId, t);
  return t;
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

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
// STDOUT DRAIN, 2026-09-02. This file calls process.exit() NOWHERE, and a test enforces that. On
// POSIX, Node's stdout is SYNCHRONOUS when it is a file or a TTY but ASYNCHRONOUS when it is a PIPE,
// and process.exit() does not wait for a pending async write. Measured on this runtime: the same
// large response written with `> file.json` was 306506 bytes, while `| wc -c` returned exactly
// 65536 -- one pipe buffer, a silently truncated prefix that still parses as plausible JSON. Setting
// process.exitCode preserves the status while letting the stream flush.
//
// The dispatch below is a function purely so the argument guards can `return` after setting
// exitCode; at ESM top level they would have needed process.exit() to stop the command from running
// with missing arguments, and that single exception is what made the rule unenforceable before.
// Keep it absolute: no process.exit() on ANY path, so no future stdout write can land above one.
async function main() {
  const rawArgs = process.argv.slice(2);
  const noCache = rawArgs.includes("--no-cache");
  const [cmd, a1, a2, a3, a4] = rawArgs.filter((a) => a !== "--no-cache");
  try {
    if (cmd === "token") {
      const t = await installationToken({ noCache });
      console.log(t.token);
      console.error(`expires_at=${t.expires_at} repository_selection=${t.repository_selection}`);
    } else if (cmd === "verify") {
      const t = await installationToken({ noCache });
      const rl = await rest("GET", "/rate_limit", t.token);
      const j = JSON.parse(rl.text);
      console.log(JSON.stringify({ installation_expires: t.expires_at, repository_selection: t.repository_selection, core_limit: j.resources.core.limit, core_remaining: j.resources.core.remaining, graphql_limit: j.resources.graphql.limit }, null, 2));
      console.error(j.resources.core.limit >= 15000 ? "OK: 15000 core limit confirms App-installation auth." : `NOTE: core limit ${j.resources.core.limit} (expected 15000 for an App installation on an enterprise org).`);
    } else if (cmd === "request") {
      if (!a1 || !a2) { console.error("usage: gh-app.mjs request <METHOD> <path> [body on stdin]"); process.exitCode = 2; return; }
      const t = await installationToken({ noCache });
      const m = a1.toUpperCase();
      const body = ["POST", "PUT", "PATCH", "DELETE"].includes(m) ? await readStdin() : null;
      const r = await rest(m, a2, t.token, body || null);
      console.error(`HTTP ${r.status} ${m} ${a2}`);
      try { console.log(JSON.stringify(JSON.parse(r.text), null, 2)); } catch { console.log(r.text); }
      process.exitCode = r.ok ? 0 : 1;
    } else if (cmd === "ready-pr") {
      if (!a1 || !a2 || !a3) { console.error("usage: gh-app.mjs ready-pr <owner> <repo> <number>"); process.exitCode = 2; return; }
      const t = await installationToken({ noCache });
      const pr = await rest("GET", `/repos/${a1}/${a2}/pulls/${a3}`, t.token);
      const nodeId = JSON.parse(pr.text).node_id;
      const g = await graphql(`mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft number}}}`, t.token, { id: nodeId });
      console.log(JSON.stringify(g.json, null, 2));
      process.exitCode = g.ok ? 0 : 1;
    } else if (cmd === "merge-pr") {
      if (!a1 || !a2 || !a3) { console.error("usage: gh-app.mjs merge-pr <owner> <repo> <number> [squash|merge|rebase]"); process.exitCode = 2; return; }
      const t = await installationToken({ noCache });
      const method = a4 || "squash";
      const r = await rest("PUT", `/repos/${a1}/${a2}/pulls/${a3}/merge`, t.token, JSON.stringify({ merge_method: method }));
      console.error(`HTTP ${r.status} merge ${a1}/${a2}#${a3} (${method})`);
      console.log(r.text);
      process.exitCode = r.ok ? 0 : 1;
    } else if (cmd === "graphql") {
      const t = await installationToken({ noCache });
      const q = await readStdin();
      const g = await graphql(q, t.token);
      console.log(JSON.stringify(g.json, null, 2));
      process.exitCode = g.ok ? 0 : 1;
    } else {
      console.error("commands: token | verify | request <METHOD> <path> | ready-pr <o> <r> <n> | merge-pr <o> <r> <n> [method] | graphql");
      process.exitCode = 2;
    }
  } catch (e) { console.error("ERROR: " + e.message); process.exitCode = 1; }
}

if (isMain) await main();
