#!/usr/bin/env node
// alert-issue.mjs -- the GUARANTEED pager channel: one tracking GitHub issue per alerting workflow.
//
// WHY THIS EXISTS (2026-10-07; a REGRESSION of the July "silent monitor" family). setup/page-on-failure.mjs
// pages by email (graph_send_email via a cto-lane bearer) and falls back to a PostHog event. BOTH channels
// read their credentials from AWS SSM (/otchealth/oauth-lane-cto-id, /otchealth/oauth-lane-cto-secret,
// /otchealth/posthog-fleet-ingest-key). A nightly job that authenticates with a deliberately least-privilege
// OIDC role (otchealth-aws-dr-canary is read-only by design, no secret-store grant) can read none of them, so
// the pager crashed in the SAME shape as the monitor it was paging for: Nightly AWS DR Canary was red every day
// 2026-09-29..2026-10-06, its pager step failed every time, and no human was ever told.
//
// The fix for the CLASS is a channel whose only dependency is something every Actions job already has: the
// job's own GITHUB_TOKEN (plus `permissions: issues: write` in the workflow). It opens ONE issue per workflow
// (exact title match among OPEN issues) and comments on it for every later alert; closing the issue is the
// acknowledgement, and the next red run opens a fresh one. The CTO reads these through github_issue_list /
// github_issue_get, and an optional @mention (PAGE_GITHUB_MENTION) makes GitHub itself email/push the owner.
//
// SECRET HYGIENE. The body carries check names, statuses, reason strings and log tails only. Every string that
// goes into it passes through redactSecrets() (the same credential SHAPES skills/kb-memory/azure-secret.mjs's
// safeDetail() strips: bearer tokens, AWS key ids, Credential= pairs, key:value credential pairs, long
// hex/base64 runs), and nothing here ever reads, logs or forwards a secret VALUE or the GitHub token.
//
// Dependency-free (node builtins + fetch). All I/O takes an injectable fetch so tests/alert-issue.test.mjs is
// hermetic. The CLI contract lives in page-on-failure.mjs: `--github-issue "<exact issue title>"` (or
// PAGE_GITHUB_ISSUE_TITLE) turns the channel on; without it nothing here runs and behavior is byte-for-byte the
// old email-then-PostHog pager.

export const DEFAULT_API = "https://api.github.com";
export const ISSUE_ATTEMPT_TIMEOUT_MS = 30000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_CHARS = 60000;

// ---------------------------------------------------------------------------------------------------
// Redaction (shape based, applied where the string is PRINTED, never trusting that a secret was kept out).
const CREDENTIAL_SHAPES = [
  /\bBearer\s+[\w.\-~+/]+=*/gi,
  // AWS unique-id prefixes; ASIA = temporary/STS credentials, the OIDC-role case this pager runs under.
  /\b(?:AKIA|ASIA|ABIA|ACCA|AIDA|AROA|ANPA|ANVA|APKA)[0-9A-Z]{16}\b/g,
  /\bCredential=[^\s,;]+/gi,
  /\b(?:authorization|x-amz-security-token|password|secret|api[_-]?key|token)\b\s*[:=]\s*\S+/gi,
  /\b[0-9a-f]{40,}\b/gi,
];
const LONG_RUN = /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g;
const LOOKS_LIKE_PATH_OR_KEBAB = /^[a-z0-9/-]+$/;

/** Strip credential-shaped substrings from a (possibly multi-line) string. Pure. */
export function redactSecrets(text) {
  let d = String(text ?? "");
  for (const re of CREDENTIAL_SHAPES) d = d.replace(re, "[redacted]");
  return d.replace(LONG_RUN, (m) => (LOOKS_LIKE_PATH_OR_KEBAB.test(m) ? m : "[redacted]"));
}

/** "@octocat @org/team" (space or comma separated) -> only well-formed GitHub handles, max 5. Pure. Anything
 *  else is dropped, so a stray repo variable can never inject markup into the issue body. */
export function parseMentions(raw) {
  const out = [];
  for (const t of String(raw ?? "").split(/[\s,]+/)) {
    if (!t) continue;
    if (/^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9_-]{1,100})?$/.test(t) && !out.includes(t)) out.push(t);
    if (out.length >= 5) break;
  }
  return out.join(" ");
}

/** "canary=failure heartbeat=success" (space/comma/semicolon separated) -> [[step, outcome], ...]. Pure. */
export function parseStepOutcomes(raw) {
  const out = [];
  for (const part of String(raw ?? "").split(/[\s,;]+/)) {
    const m = part.match(/^([A-Za-z0-9_.-]{1,40})=([A-Za-z_]{1,20})$/);
    if (m) out.push([m[1], m[2]]);
  }
  return out;
}

const CHECK_LINE_RE = /^\[(STALE|ERROR|LEAK)\s*\]\s+(.*)$/;
/** The anomaly rows of a canary-style log table ("[STALE   ] name   detail"), whitespace-collapsed. Pure. */
export function extractFailedChecks(sections) {
  const out = [];
  for (const s of sections || []) {
    for (const line of String(s).split("\n")) {
      const m = line.trim().match(CHECK_LINE_RE);
      if (m) out.push(`${m[1]} ${m[2]}`.replace(/\s+/g, " "));
    }
  }
  return out;
}

function fence(text) {
  return "```text\n" + String(text).replace(/```/g, "'''") + "\n```";
}

/** The issue/comment body. Pure. No em/en dashes (fleet copy convention). In self-test mode a loud banner
 *  says so first, so a self-test comment can never be mistaken for an incident. */
export function buildAlertBody({
  workflow, runUrl, testMode = false, severity = "red", message = null, stepOutcomes = "",
  delivery = [], diag = [], logSections = [], mention = "", now = new Date(),
} = {}) {
  const outcomes = parseStepOutcomes(stepOutcomes);
  const failedSteps = outcomes.filter(([, v]) => v === "failure").map(([k]) => k);
  const state = testMode ? "PAGER SELF-TEST (not a real incident)" : severity === "info" ? "INFO" : "RED";
  const L = [`**${workflow}: ${state}**`];
  if (testMode) {
    L.push("", "THIS IS A PAGER SELF-TEST. No real incident occurred and no action is needed. It proves the paging pipeline fires end to end.");
  } else if (severity === "info") {
    L.push("", message || "Informational notice (no message supplied).");
  } else {
    L.push("", `${workflow} failed on its schedule${failedSteps.length ? ` (failed steps: ${failedSteps.join(", ")})` : ""}.`);
  }
  L.push("", `- Run: ${runUrl}`, `- At (UTC): ${now.toISOString()}`);
  if (outcomes.length) L.push(`- Step outcomes: ${outcomes.map(([k, v]) => `${k}=${v}`).join(", ")}`);

  const dl = (delivery || []).filter(Boolean);
  if (dl.length) {
    L.push("", "Delivery:");
    for (const d of dl) L.push(`- ${redactSecrets(d).replace(/\s+/g, " ").slice(0, 400)}`);
  }
  if (dl.some((d) => /FAILED/.test(d))) {
    L.push(
      "",
      "Degraded channel: the email and PostHog channels both read credentials from AWS SSM (/otchealth/oauth-lane-cto-id, " +
        "/otchealth/oauth-lane-cto-secret, /otchealth/posthog-fleet-ingest-key). A least-privilege OIDC role that cannot read them " +
        "leaves only this issue channel. Fix without widening the role: set the repo secret POSTHOG_FLEET_INGEST_KEY (read from the " +
        "environment first), or grant ssm:GetParameter on those parameters to this job's role.",
    );
  }

  const checks = extractFailedChecks(logSections);
  if (checks.length) {
    L.push("", "Failed checks (from the log):");
    for (const c of checks.slice(0, 30)) L.push(`- ${redactSecrets(c).slice(0, 500)}`);
  }
  const diagText = (diag || []).map(String).join("\n");
  if (diagText.trim()) L.push("", "Pager diagnostics (the pager's own stderr, secret-redacted):", fence(redactSecrets(diagText).slice(-3000)));
  const logs = (logSections || []).map((s) => redactSecrets(s).slice(-6000)).filter(Boolean);
  if (logs.length) {
    L.push("", "Log tail (secret-redacted):");
    for (const s of logs) L.push(fence(s));
  }
  if (mention && !testMode) L.push("", `cc ${mention}`);
  L.push("", "Source: setup/page-on-failure.mjs, GitHub issue channel (fires only from the workflow's own failure step). Close this issue to acknowledge; the next red run opens a fresh one.");
  return L.join("\n").slice(0, MAX_BODY_CHARS);
}

// ---------------------------------------------------------------------------------------------------
// GitHub REST (injectable fetch).
async function ghCall(fetchImpl, api, token, method, path, json, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`${api}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "otchealth-fleet-pager",
        "Content-Type": "application/json",
      },
      body: json === undefined ? undefined : JSON.stringify(json),
      signal: ctrl.signal,
    });
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* non-JSON error page: keep the raw text */ }
    return { ok: !!r.ok, status: r.status, json: parsed, text };
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error(`GitHub ${method} ${path.split("?")[0]} timed out after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

function ghError(what, r) {
  const msg = r.json && r.json.message ? String(r.json.message) : String(r.text || "").slice(0, 200);
  const hint = r.status === 403 || r.status === 404 ? " (the step needs env GITHUB_TOKEN and the workflow permission issues: write)" : "";
  return new Error(`${what} HTTP ${r.status}: ${redactSecrets(msg).slice(0, 200)}${hint}`);
}

/** Find the OPEN issue whose title is exactly `title` (pull requests are ignored) and comment on it, else open a
 *  new one. Returns { action: "commented"|"created", number, url }. Throws on any failure so the caller can
 *  report it; never logs the token. */
export async function upsertAlertIssue({
  repo, token, title, body, api = DEFAULT_API, fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS, maxPages = 3,
} = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo || ""))) throw new Error("GITHUB_REPOSITORY is not set to owner/repo");
  if (!token) throw new Error("GITHUB_TOKEN is not in this step's environment");
  if (!title) throw new Error("no issue title configured");
  for (let page = 1; page <= maxPages; page++) {
    const r = await ghCall(fetchImpl, api, token, "GET", `/repos/${repo}/issues?state=open&per_page=100&page=${page}`, undefined, timeoutMs);
    if (!r.ok) throw ghError("list issues", r);
    const rows = Array.isArray(r.json) ? r.json : [];
    const hit = rows.find((i) => i && !i.pull_request && i.title === title);
    if (hit) {
      const c = await ghCall(fetchImpl, api, token, "POST", `/repos/${repo}/issues/${hit.number}/comments`, { body }, timeoutMs);
      if (!c.ok) throw ghError("comment on issue", c);
      return { action: "commented", number: hit.number, url: hit.html_url || (c.json && c.json.html_url) || "" };
    }
    if (rows.length < 100) break;
  }
  const c = await ghCall(fetchImpl, api, token, "POST", `/repos/${repo}/issues`, { title, body }, timeoutMs);
  if (!c.ok || !c.json || !c.json.number) throw ghError("create issue", c);
  return { action: "created", number: c.json.number, url: c.json.html_url || "" };
}

// ---------------------------------------------------------------------------------------------------
// Wiring helpers for setup/page-on-failure.mjs.

/** Tee console.error into a bounded buffer so the pager's OWN stderr (e.g. the [kv-secret] ACCESS DENIED line
 *  that names the missing SSM grant) can be quoted, redacted, in the issue. stop() restores console.error. */
export function startDiagCapture(max = 60) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => {
    try {
      lines.push(args.map((a) => (typeof a === "string" ? a : String((a && a.stack) || a))).join(" "));
      if (lines.length > max) lines.shift();
    } catch { /* capture is best-effort; never break the real log line */ }
    orig.apply(console, args);
  };
  return { lines, stop() { console.error = orig; } };
}

/** Read the issue-channel settings from argv + env. Pure. `title` empty means the channel is OFF. */
export function issueConfigFromArgv(argv, env = process.env) {
  const val = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith("--") ? String(argv[i + 1]) : "";
  };
  return {
    title: (val("--github-issue") || env.PAGE_GITHUB_ISSUE_TITLE || "").trim(),
    mention: parseMentions(val("--github-mention") || env.PAGE_GITHUB_MENTION || ""),
    stepOutcomes: env.PAGE_STEP_OUTCOMES || "",
  };
}

/** Run the channel for one page. Never throws. Returns { issued, error }: issued is the upsert result or null. */
export async function deliverIssueChannel({
  cfg, workflow, runUrl, testMode = false, severity = "red", message = null, delivery = [], diag = [], logSections = [],
  env = process.env, upsert = upsertAlertIssue, timeoutMs = ISSUE_ATTEMPT_TIMEOUT_MS,
} = {}) {
  if (!cfg || !cfg.title) return { issued: null, error: null };
  const body = buildAlertBody({
    workflow, runUrl, testMode, severity, message, stepOutcomes: cfg.stepOutcomes, delivery, diag, logSections, mention: cfg.mention,
  });
  let timer;
  try {
    const attempt = Promise.resolve().then(() => upsert({
      repo: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN || env.GH_TOKEN, title: cfg.title, body, api: env.GITHUB_API_URL || DEFAULT_API,
    }));
    attempt.catch(() => {}); // a late rejection after the timeout wins the race must not surface as unhandled
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`github issue attempt timed out after ${timeoutMs}ms`)), timeoutMs); });
    return { issued: await Promise.race([attempt, timeout]), error: null };
  } catch (e) {
    return { issued: null, error: redactSecrets(String((e && e.message) || e)).slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}
