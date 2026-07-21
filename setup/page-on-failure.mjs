#!/usr/bin/env node
// page-on-failure.mjs — closes "a red monitor pages nobody." Both nightly-azure-canary.yml and
// nightly-fleet-sentinels.yml already emit a rich JSON/log summary on every run (azure-canary.log /
// gateway-canary.log / drift-sentinel.log) AND a PostHog trend event (skills/azure-canary/canary.mjs's
// own emitPosthog) — but until now NOTHING reached a human when a scheduled run actually went red.
// GitHub Actions' own failure email goes wherever the repo's notification settings point, which is easy
// to have muted/misrouted and was never this fleet's paging channel. This is a best-effort, ON-FAILURE-
// ONLY notifier: it is invoked as the LAST step of each nightly workflow with `if: failure()`, so it only
// ever runs when a prior step in that same job already failed.
//
// WHY NOT skills/m365-mail: that skill is READ-ONLY by design (its own SKILL.md: "This skill never sends
// or writes mail. Mining only.") — there is no send path there to reuse; it mines mailboxes for the CFO,
// it does not send. The fleet's REAL outbound-mail path is the gateway's `graph_send_email` tool (cto
// lane only, category write_orchestrated — see otchealth-mcp-server's tools/graph/send-email.ts +
// tools/registry.ts's high-risk CTO-only default), already used for exactly this purpose by
// skills/legal-deadline-pager/pager.mjs (paging Matt on an urgent legal deadline). This script reuses
// that SAME pattern: mint a cto-lane bearer via the shared kvSecret resolver (oauth-lane-cto-id/-secret —
// the SAME creds skills/azure-canary/canary.mjs's own ctoBearer() already resolves in this exact job) ->
// POST /mcp tools/call graph_send_email. No new GitHub secret is required: both workflows already run
// azure/login@v2 (OIDC) before any step that needs Key Vault, which is what makes kvSecret()'s az-CLI
// fallback path work here with nothing stored at rest.
//
// FALLBACK (defense in depth, not a replacement): if the email path fails for ANY reason (creds
// unavailable, gateway unreachable, the tool call itself rejected), emit a PostHog 'canary_red' capture
// event via posthog-fleet-ingest-key — the SAME secret + ingest pattern canary.mjs's own emitPosthog()
// already uses — so a red run ALWAYS leaves a durable, query-able trace even when mail is down. The
// script tries the loud channel (email) FIRST and only falls back, never the reverse: a page that
// silently degrades to "an event sat in an index nobody queried" is the exact failure class this whole
// workstream exists to close.
//
// Never logs a secret value. Exits 0 if EITHER channel got the page out; 1 if BOTH failed (so the
// notifier's own failure is visible in this step's own log — the job is already red from `if: failure()`
// regardless of this script's exit code, so a non-zero exit here can never mask the real failure).
//
// ITEM 2.2 (Wave 2, AI-OS research-pass 2026-07-21): --test / SELF-TEST MODE. Every nightly workflow's
// pager wiring (the `if: failure()` step calling this script) had never been PROVEN to actually fire in
// practice, only trusted by reading the code. .github/workflows/pager-selftest.yml exercises this exact
// script end to end from a deliberate, isolated synthetic failure (see that workflow's header). --test
// (or PAGE_TEST_MODE=1) makes that exercise SAFE to run at any time without ever being mistaken for a
// real incident: it changes the email subject / PostHog event name / body banner to unmistakably say
// SELF-TEST, so whoever receives it (Matt) can never confuse a self-test page with a real one. The
// underlying call path (mint the cto-lane bearer, call graph_send_email, fall back to the PostHog
// 'canary_red'-family capture event on failure) is IDENTICAL in both modes. A self-test that silently
// used a different, easier code path would prove nothing about whether the real pager works.
//
// Usage:
//   node setup/page-on-failure.mjs --workflow "<Workflow Name>" [--log <path>]... [--tail-lines 40] [--test]
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { kvSecret } from "../skills/kb-memory/azure-secret.mjs";

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def; };
const optAll = (name) => argv.reduce((acc, a, i) => (a === name && argv[i + 1] !== undefined ? [...acc, argv[i + 1]] : acc), []);

const GW = process.env.GATEWAY_BASE_URL || "https://mcp.otchealth.app";
const RECIPIENT = process.env.PAGE_RECIPIENT || "matthew@otchealth.app";
const WORKFLOW = opt("--workflow", process.env.GITHUB_WORKFLOW || "unknown workflow");
const TAIL_LINES = parseInt(opt("--tail-lines", "40"), 10);
const LOG_PATHS = optAll("--log");
const TEST_MODE = argv.includes("--test") || process.env.PAGE_TEST_MODE === "1";

/** The GitHub Actions run URL from the runner's own standard env vars (no new inputs needed). Pure
 *  given process.env. */
export function runUrl(env = process.env) {
  const server = env.GITHUB_SERVER_URL || "https://github.com";
  const repo = env.GITHUB_REPOSITORY || "InnerScopeHearing/otchealth-claude-tools";
  const runId = env.GITHUB_RUN_ID || "";
  return runId ? `${server}/${repo}/actions/runs/${runId}` : "(no GITHUB_RUN_ID in this environment)";
}

/** Last N lines of one log file, or a clear placeholder if it does not exist / cannot be read — never
 *  throws, so a log that was never written (the failure happened before that step) degrades gracefully
 *  instead of crashing the notifier. */
export function tailFile(path, n) {
  if (!path || !existsSync(path)) return `[${path}]: (no log file present — the failure happened before this step could write one)`;
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    const tail = lines.slice(-n).join("\n");
    return `[${path}] (last ${Math.min(n, lines.length)} of ${lines.length} lines):\n${tail}`;
  } catch (e) {
    return `[${path}]: (unreadable: ${e.message})`;
  }
}

/** Email subject line. Pure. In self-test mode the subject is unmistakably a test (never "[RED]", never
 *  "failed") so it can never be confused with a real page in an inbox or a phone notification preview,
 *  which is often just the subject line. */
export function pageSubject(workflow, testMode) {
  return testMode ? `[SELF-TEST] ${workflow} pager self-test (not a real incident)` : `[RED] ${workflow} failed`;
}

/** Which PostHog event the fallback path emits. Pure. Kept a distinct event name in self-test mode (not
 *  'canary_red' with a property flag) so a dashboard/alert built on 'canary_red' counts can never be
 *  polluted by self-test runs, and so a query for 'pager_selftest' cleanly answers "when did we last
 *  prove the pager works" on its own. */
export function posthogEventName(testMode) { return testMode ? "pager_selftest" : "canary_red"; }

/** Plain-text page body. Pure. No em/en dashes (fleet copy convention). In self-test mode a loud banner
 *  is prepended so the body itself (not just the subject) states this is not a real incident, in case a
 *  mail client shows only a body preview or the subject gets stripped by a forwarding rule. */
export function buildPageBody(workflow, url, logSections, testMode) {
  const banner = testMode
    ? [
        "THIS IS A PAGER SELF-TEST. No real incident occurred.",
        "It exists only to prove the paging pipeline (email, then PostHog fallback) actually fires end to end.",
        "No action is needed.",
        "",
      ]
    : [];
  const lines = [
    ...banner,
    testMode ? `${workflow} pager self-test (deliberate synthetic failure, see .github/workflows/pager-selftest.yml).` : `${workflow} failed on the nightly schedule.`,
    "",
    `Run: ${url}`,
    "",
    ...logSections.flatMap((s) => [s, ""]),
    "Source: setup/page-on-failure.mjs (fires only on workflow failure, from that workflow's own last step).",
  ];
  return lines.join("\n");
}

// Same client_credentials flow as skills/azure-canary/canary.mjs's own ctoBearer() (oauth-lane-cto-id/
// -secret via the shared kvSecret resolver -> POST /oauth/token). Never logs the client_secret or token.
async function ctoBearer() {
  const cid = await kvSecret("oauth-lane-cto-id");
  const csec = await kvSecret("oauth-lane-cto-secret");
  if (!cid || !csec) throw new Error("cto-lane creds unavailable (oauth-lane-cto-id/secret)");
  const r = await fetch(`${GW}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: cid, client_secret: csec }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.access_token) throw new Error(`cto-lane token mint failed: HTTP ${r.status}${j?.error ? ` (${j.error})` : ""}`);
  return j.access_token;
}

/** Send the page via the gateway's graph_send_email tool (cto lane — the same call shape
 *  skills/legal-deadline-pager/pager.mjs's defaultSendEmail() already uses in production). Throws on
 *  any failure so the caller can fall back; never logs a secret. */
async function sendPageEmail(subject, body) {
  const bearer = await ctoBearer();
  const r = await fetch(`${GW}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_send_email", arguments: { to: RECIPIENT, subject, body, body_type: "Text" } } }),
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { for (const l of text.split("\n")) if (l.startsWith("data:")) { try { j = JSON.parse(l.slice(5)); } catch {} } }
  const isError = !!j?.result?.isError;
  if (r.status < 200 || r.status >= 300 || isError) {
    const detail = j?.result?.content?.[0]?.text || j?.error?.message || `HTTP ${r.status}`;
    throw new Error(`graph_send_email rejected: ${String(detail).slice(0, 200)}`);
  }
  return true;
}

/** Fallback trace: the SAME secret + capture endpoint canary.mjs's own emitPosthog() already uses,
 *  event 'canary_red' (or 'pager_selftest' in --test mode, see posthogEventName()) instead of
 *  'azure_canary'. Throws on failure so the caller can report it. */
async function emitPosthogFallback(props, eventName) {
  const key = await kvSecret("posthog-fleet-ingest-key");
  if (!key) throw new Error("posthog-fleet-ingest-key unavailable");
  const host = process.env.POSTHOG_HOST || "https://us.i.posthog.com";
  const r = await fetch(`${host}/capture/`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: key, event: eventName, distinct_id: TEST_MODE ? "fleet-pager-selftest" : "fleet-page-on-failure", properties: props }),
  });
  if (!r.ok) throw new Error(`PostHog capture HTTP ${r.status}`);
  return true;
}

async function main() {
  const url = runUrl();
  const logSections = LOG_PATHS.length ? LOG_PATHS.map((p) => tailFile(p, TAIL_LINES)) : ["(no --log path supplied)"];
  const subject = pageSubject(WORKFLOW, TEST_MODE);
  const body = buildPageBody(WORKFLOW, url, logSections, TEST_MODE);
  const eventName = posthogEventName(TEST_MODE);

  let emailed = false, emailErr = null, posted = false, postErr = null;
  try {
    emailed = await sendPageEmail(subject, body);
  } catch (e) {
    emailErr = e.message;
    console.error(`[page-on-failure] email page failed: ${emailErr}`);
  }
  if (!emailed) {
    try {
      posted = await emitPosthogFallback({ workflow: WORKFLOW, run_url: url, test: TEST_MODE, tail: logSections.join("\n---\n").slice(0, 4000) }, eventName);
    } catch (e) {
      postErr = e.message;
      console.error(`[page-on-failure] PostHog fallback failed: ${postErr}`);
    }
  }

  const modeTag = TEST_MODE ? " [SELF-TEST]" : "";
  if (emailed) {
    console.log(`[page-on-failure]${modeTag} paged via graph_send_email to ${RECIPIENT}.`);
  } else if (posted) {
    console.log(`[page-on-failure]${modeTag} email path unavailable (${emailErr}); paged via PostHog '${eventName}' event fallback instead.`);
  } else {
    console.error(`::error::[page-on-failure]${modeTag} BOTH the email page (${emailErr}) and the PostHog fallback (${postErr}) failed — this red run left NO durable page. Check oauth-lane-cto-*/posthog-fleet-ingest-key in Key Vault and gateway reachability.`);
    process.exitCode = 1;
  }
}

// Only run as a script (not when imported, e.g. to unit-test the pure helpers above) — the same
// isMain guard convention as skills/azure-canary/canary.mjs and skills/legal-deadline-pager/pager.mjs.
// Without this guard, importing this module for its pure exports (runUrl/tailFile/buildPageBody) would
// ALSO fire a real page: exactly the class of accidental side effect this guard exists to prevent.
// (Caught live during this PR's own testing: an early version without this guard sent one real test
// page to matthew@otchealth.app when its pure helpers were imported for a local sanity check. No
// production impact — the email content itself is a harmless "[RED] unknown workflow failed" test
// artifact, self-evidently not a real incident — but it is exactly the accident this guard exists to
// prevent, so it is not a hypothetical.)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(`::error::[page-on-failure] FATAL: ${e.message}`); process.exit(1); });
}
