#!/usr/bin/env node
// gateway-canary.mjs — A11-CANARY (P0 stability, 2026-07-05). Synthetic multi-step canary THROUGH
// the live gateway, run CONTINUOUSLY (heartbeat-able) between deploys. deploy.yml already gates
// /health + /health/deep + a MIN_TOOLS=800 tool-count floor, but only AT deploy time — this catches
// the gap after a clean deploy: "the gateway is technically up but a specific tool's contract
// silently broke" (bad handler deploy via app-settings drift, an upstream dependency that degrades
// hours later, a hotfix that changes a tool's output shape without a full redeploy, etc).
//
// Three steps, cheapest/least-privileged first, each one gating the next:
//   1. GET /health            — no auth (same public shape deploy.yml's health gate parses).
//   2. GET /health/deep       — needs ADMIN_REVOKE_TOKEN-shaped bearer; same as deploy.yml's deep-
//                                health gate. Optional here: if the token isn't available we report
//                                'skipped', we never fail the run just because that bearer is absent
//                                (this script runs far more often than deploys, from more places).
//                                ADMIN_REVOKE_TOKEN has no self-mint path (it is a standalone admin
//                                kill-switch secret, not an OAuth lane) so this step's graceful skip
//                                is UNCHANGED and stays a deliberate, non-failing design choice —
//                                see the strict-mode note on step 3 below for the step that changed.
//   3. Real tools/call(s) end-to-end via GATEWAY_BEARER — the part deploy.yml's own eval-runner.mjs
//      comment says needs a GATEWAY_BEARER secret "to activate"; same env var, same auth header
//      shape (Authorization: Bearer <token>), same POST-to-/mcp JSON-RPC envelope
//      { jsonrpc:"2.0", id, method:"tools/call", params:{ name, arguments } } as
//      src/eval/eval-runner.mjs's callMcpTool() and src/eval/cases.json's real request bodies use.
//      Calls catalog_list_tools (read-only, idempotent, no side effects — see its own
//      annotations in src/tools/catalog/list-tools.ts) and asserts the response is not just
//      HTTP 200 but has the actual expected SHAPE: structuredContent.result.data.total_tools is a
//      sane positive number and .services is a non-empty array — i.e. the tool's CONTRACT, not
//      just the transport, is intact. A second cheap call (memory_recall with a harmless query,
//      the same tool src/eval/eval-runner.mjs's own cases already exercise) is included as a
//      second independent tool-family sanity check so one lucky tool passing doesn't mask a
//      broader contract regression.
//
// AUTH FIX (2026-07-21): nightly-fleet-sentinels.yml never set GATEWAY_BEARER, so step 3 — this
// canary's whole reason for existing, "real tools/call(s) end-to-end" — silently SKIPPED on every
// single scheduled run since the workflow was created. "gateway-canary" beat green every night while
// never once actually calling an authenticated tool. Fix: when GATEWAY_BEARER/--bearer is unset, self-
// mint a cto-lane bearer via the SAME client_credentials flow skills/azure-canary/canary.mjs's own
// ctoBearer() already uses in this exact job (oauth-lane-cto-id/-secret via the shared kvSecret
// resolver -> POST /oauth/token) — no new secret required, since nightly-fleet-sentinels.yml already
// runs azure/login@v2 (OIDC) before this step, the same identity kvSecret()'s az-CLI fallback uses.
// An explicit --bearer/env GATEWAY_BEARER still wins when supplied. Under --strict, step 3 SKIPping
// (BEARER still unavailable after the mint attempt — e.g. Key Vault genuinely unreachable) is now a
// FAILURE, not a silent pass: a sentinel that can silently skip its core check is not a sentinel. This
// does NOT extend to step 2 (health_deep/ADMIN_REVOKE_TOKEN) — that token has no self-mint path here
// and its graceful-skip is the pre-existing, deliberate design (see the step-2 comment above and
// deploy.yml's identical convention for the same token); making it strict-fail too would just turn
// this sentinel permanently red regardless of real gateway health, the opposite of the goal.
//
// GATEWAY_BEARER may not be mintable in every environment (e.g. a local run with no Azure/KV access —
// same graceful-degrade convention as eval-runner.mjs, which exits 2 when it's missing). THIS script is
// a report-only-by-default sentinel meant to run unattended far more often than a deploy, so a missing
// bearer is a 'skipped' step, not a 'fail', UNLESS --strict is set (see AUTH FIX above).
//
// Dependency-free (node builtins + fetch only, plus the shared kvSecret resolver for the self-mint),
// matching this fleet's established style. Report-only by default; --strict makes ANY real failure
// (not skip) — and, for step 3 specifically, a SKIP — a non-zero exit for CI/heartbeat wiring.
//
// Usage:
//   node setup/gateway-canary.mjs [--json] [--strict]
//     [--base-url https://mcp.otchealth.app]   # default: https://mcp.otchealth.app
//     [--admin-token <token>]                   # else env ADMIN_REVOKE_TOKEN
//     [--bearer <token>]                        # else env GATEWAY_BEARER, else self-minted (cto lane)
//     [--timeout-ms 8000]
//
// Exit codes: 0 = report (default, unless --strict); 3 = one or more real (non-skipped) step FAILED,
// OR (under --strict) step 3 could not get a bearer at all; 1 = unexpected error in the harness itself.
import { kvSecret } from "../skills/kb-memory/azure-secret.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def; };

const BASE_URL = (opt("--base-url", process.env.GATEWAY_BASE_URL || "https://mcp.otchealth.app")).replace(/\/$/, "");
const ADMIN_TOKEN = opt("--admin-token", process.env.ADMIN_REVOKE_TOKEN || "");
let BEARER = opt("--bearer", process.env.GATEWAY_BEARER || "");
const TIMEOUT_MS = parseInt(opt("--timeout-ms", "8000"), 10);
// Steps whose SKIP (missing bearer) becomes a FAILURE under --strict — see the AUTH FIX note above.
// health_deep is deliberately excluded: ADMIN_REVOKE_TOKEN has no self-mint path here.
const CORE_AUTH_STEPS = new Set(["tool_catalog_list_tools", "tool_memory_recall"]);

/** Self-mint a cto-lane bearer via the SAME client_credentials flow skills/azure-canary/canary.mjs's
 *  own ctoBearer() uses (oauth-lane-cto-id/-secret via the shared kvSecret resolver -> GW /oauth/token).
 *  Never called when --bearer/GATEWAY_BEARER was already supplied — an explicit override always wins.
 *  Throws with a safe (non-secret) message on failure so the caller can record a clear reason. */
async function mintCtoBearer() {
  const cid = await kvSecret("oauth-lane-cto-id");
  const csec = await kvSecret("oauth-lane-cto-secret");
  if (!cid || !csec) throw new Error("cto-lane creds unavailable (oauth-lane-cto-id/secret) — Key Vault unreachable or the lane is not provisioned");
  const r = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: cid, client_secret: csec }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.access_token) throw new Error(`cto-lane token mint failed: HTTP ${r.status}${j?.error ? ` (${j.error})` : ""}`);
  return j.access_token;
}

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  let body = null;
  try { body = await r.json(); } catch { /* non-JSON body, leave null */ }
  return { status: r.status, ok: r.ok, body };
}

async function postJson(url, body, headers = {}) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* non-JSON (e.g. SSE) — leave null */ }
  return { status: r.status, ok: r.ok, body: parsed };
}

// Same JSON-RPC envelope + POST /mcp target as src/eval/eval-runner.mjs's callMcpTool() and the
// example request bodies driving src/eval/cases.json.
async function callMcpTool(name, args) {
  const envelope = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
  return postJson(`${BASE_URL}/mcp`, envelope, { Authorization: `Bearer ${BEARER}` });
}

const steps = [];
function record(id, status, detail) { steps.push({ id, status, detail }); }

(async () => {
  // ── Step 1: /health (public, no auth — deploy.yml's own health-gate shape) ──────────────────
  try {
    const { status, ok, body } = await getJson(`${BASE_URL}/health`);
    if (!ok || !body) {
      record("health", "fail", `HTTP ${status}, no parseable body`);
    } else if (body.status !== "ok") {
      record("health", "fail", `status field = ${JSON.stringify(body.status)} (expected "ok")`);
    } else if (typeof body.tool_count !== "number" || body.tool_count < 800) {
      record("health", "fail", `tool_count = ${body.tool_count} (expected a number >= 800, matches deploy.yml's MIN_TOOLS floor)`);
    } else {
      record("health", "pass", `ok, tool_count=${body.tool_count}, governance_mode=${body.governance_mode}`);
    }
  } catch (e) {
    record("health", "fail", `unreachable: ${e.message}`);
  }

  // ── Step 2: /health/deep (Cosmos/Search/Foundry reachability; needs admin bearer) ──────────
  if (!ADMIN_TOKEN) {
    record("health_deep", "skipped", "ADMIN_REVOKE_TOKEN not set — deep dependency probe skipped (not a failure; see deploy.yml's own graceful-skip for the same token).");
  } else {
    try {
      const { status, body } = await getJson(`${BASE_URL}/health/deep`, { Authorization: `Bearer ${ADMIN_TOKEN}` });
      if (status !== 200 && status !== 503) {
        record("health_deep", "fail", `unexpected HTTP ${status}`);
      } else if (!body) {
        record("health_deep", "fail", `HTTP ${status} but no parseable body`);
      } else {
        const deps = { cosmos: body.cosmos, search: body.search, foundry: body.foundry };
        const down = Object.entries(deps).filter(([, v]) => v === "down").map(([k]) => k);
        if (down.length) record("health_deep", "fail", `dependency DOWN: ${down.join(", ")} (${JSON.stringify(deps)})`);
        else record("health_deep", "pass", JSON.stringify(deps));
      }
    } catch (e) {
      record("health_deep", "fail", `unreachable: ${e.message}`);
    }
  }

  // ── Step 3: real end-to-end tool calls via /mcp (needs a bearer) ────────────────────────────
  // AUTH FIX: --bearer/GATEWAY_BEARER still wins if supplied; otherwise self-mint a cto-lane bearer
  // (see mintCtoBearer() above) so this step actually RUNS instead of silently skipping every night.
  let bearerMintError = null;
  if (!BEARER) {
    try {
      BEARER = await mintCtoBearer();
    } catch (e) {
      bearerMintError = e.message;
    }
  }
  if (!BEARER) {
    const reason = `GATEWAY_BEARER not set, and self-mint via oauth-lane-cto creds failed (${bearerMintError || "no creds available"}).`;
    record("tool_catalog_list_tools", "skipped", reason);
    record("tool_memory_recall", "skipped", `${reason} (skipped alongside catalog_list_tools.)`);
  } else {
    // 3a. catalog_list_tools — read-only, idempotent, no side effects (per its own tool
    // annotations). Verifies the CONTRACT: not just HTTP 200, but that total_tools/services are
    // present and sane, i.e. the catalog handler itself didn't silently break.
    try {
      const { status, body } = await callMcpTool("catalog_list_tools", {});
      if (status === 401 || status === 403) {
        record("tool_catalog_list_tools", "fail", `auth rejected (HTTP ${status}) — check GATEWAY_BEARER validity.`);
      } else if (!body) {
        record("tool_catalog_list_tools", "fail", `HTTP ${status}, no parseable JSON body (expected an SSE/JSON tools/call response).`);
      } else if (body.error) {
        record("tool_catalog_list_tools", "fail", `JSON-RPC error: ${JSON.stringify(body.error).slice(0, 200)}`);
      } else {
        const sc = body.result?.structuredContent;
        const data = sc?.result?.data;
        const totalTools = data?.total_tools;
        const services = data?.services;
        if (typeof totalTools !== "number" || totalTools < 1) {
          record("tool_catalog_list_tools", "fail", `structuredContent.result.data.total_tools missing/invalid: ${JSON.stringify(totalTools)}`);
        } else if (!Array.isArray(services) || services.length === 0) {
          record("tool_catalog_list_tools", "fail", `structuredContent.result.data.services missing/empty (expected a non-empty array)`);
        } else {
          record("tool_catalog_list_tools", "pass", `total_tools=${totalTools}, total_services=${data.total_services ?? services.length}`);
        }
      }
    } catch (e) {
      record("tool_catalog_list_tools", "fail", `request failed: ${e.message}`);
    }

    // 3b. memory_recall — the same tool src/eval/cases.json's own recall-0N cases already exercise
    // against the live gateway, with an innocuous query. Second, independent tool family: confirms
    // the contract break isn't isolated to catalog_list_tools alone.
    try {
      const { status, body } = await callMcpTool("memory_recall", { query: "gateway canary smoke test" });
      if (status === 401 || status === 403) {
        record("tool_memory_recall", "fail", `auth rejected (HTTP ${status}) — check GATEWAY_BEARER validity.`);
      } else if (!body) {
        record("tool_memory_recall", "fail", `HTTP ${status}, no parseable JSON body.`);
      } else if (body.error) {
        record("tool_memory_recall", "fail", `JSON-RPC error: ${JSON.stringify(body.error).slice(0, 200)}`);
      } else {
        // Contract check: a structuredContent envelope must be present with a correlation_id
        // (every successful tool call carries one, per registry.ts) — we deliberately do NOT
        // require any particular memory hit (a harmless smoke-test query will usually find
        // nothing), only that the tool executed and returned its normal envelope shape.
        const sc = body.result?.structuredContent;
        if (!sc || typeof sc.correlation_id !== "string" || !sc.correlation_id) {
          record("tool_memory_recall", "fail", `structuredContent envelope missing/malformed (expected correlation_id): ${JSON.stringify(sc).slice(0, 200)}`);
        } else {
          record("tool_memory_recall", "pass", `contract intact (correlation_id=${sc.correlation_id.slice(0, 12)}...)`);
        }
      }
    } catch (e) {
      record("tool_memory_recall", "fail", `request failed: ${e.message}`);
    }
  }

  const strict = flag("--strict");
  const failed = steps.filter((s) => s.status === "fail");
  const skipped = steps.filter((s) => s.status === "skipped");
  const passed = steps.filter((s) => s.status === "pass");
  // AUTH FIX: under --strict, a SKIP on a CORE auth step (tool_catalog_list_tools / tool_memory_recall
  // — the "real tools/call(s) end-to-end" this canary exists for) is itself a failure. health_deep is
  // deliberately NOT in CORE_AUTH_STEPS, so its own graceful skip (no self-mint path for
  // ADMIN_REVOKE_TOKEN) is unaffected — see the header comment.
  const strictSkipFailures = strict ? skipped.filter((s) => CORE_AUTH_STEPS.has(s.id)) : [];
  const hardFailed = [...failed, ...strictSkipFailures];

  if (flag("--json")) {
    console.log(JSON.stringify({
      base_url: BASE_URL, steps, strict,
      summary: { passed: passed.length, failed: failed.length, skipped: skipped.length, strict_skip_failures: strictSkipFailures.map((s) => s.id) },
    }, null, 2));
  } else {
    console.log(`# GATEWAY-CANARY — ${BASE_URL} — ${passed.length} pass, ${failed.length} fail, ${skipped.length} skipped${strictSkipFailures.length ? ` (${strictSkipFailures.length} core-auth skip escalated to FAIL under --strict)` : ""}`);
    for (const s of steps) {
      const escalated = strict && s.status === "skipped" && CORE_AUTH_STEPS.has(s.id);
      const tag = s.status === "pass" ? "LIVE  " : s.status === "fail" || escalated ? "DEAD  " : "SKIP  ";
      console.log(`[${tag}] ${s.id.padEnd(26)} ${s.detail}${escalated ? " (STRICT: a core auth step cannot silently skip — a sentinel that can silently skip its core check is not a sentinel.)" : ""}`);
    }
    if (failed.length) console.log(`\nFAILED: ${failed.map((s) => s.id).join(", ")} — gateway is up but at least one contract silently broke.`);
    if (strictSkipFailures.length) console.log(`STRICT FAILURE (core auth step skipped): ${strictSkipFailures.map((s) => s.id).join(", ")}.`);
    const reportOnlySkips = skipped.filter((s) => !strictSkipFailures.includes(s));
    if (reportOnlySkips.length) console.log(`SKIPPED (not failures, missing optional creds): ${reportOnlySkips.map((s) => s.id).join(", ")}`);
  }

  process.exit(strict && hardFailed.length ? 3 : 0);
})().catch((e) => { console.error("[gateway-canary] ERROR: " + e.message); process.exit(1); });
