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
// GATEWAY_BEARER may not be set (same graceful-degrade convention as eval-runner.mjs, which exits 2
// when it's missing — but THIS script is a report-only sentinel meant to run unattended far more
// often than a deploy, so a missing bearer must not be fatal here: step 3 is marked 'skipped', not
// 'fail', and the overall exit code reflects only the steps that actually ran).
//
// Dependency-free (node builtins + fetch only), matching this fleet's established style.
// Report-only by default; --strict makes ANY real failure (not skip) a non-zero exit for CI/heartbeat wiring.
//
// Usage:
//   node setup/gateway-canary.mjs [--json] [--strict]
//     [--base-url https://mcp.otchealth.app]   # default: https://mcp.otchealth.app
//     [--admin-token <token>]                   # else env ADMIN_REVOKE_TOKEN
//     [--bearer <token>]                        # else env GATEWAY_BEARER
//     [--timeout-ms 8000]
//
// Exit codes: 0 = report (default, unless --strict); 3 = one or more real (non-skipped) step FAILED
// and --strict; 1 = unexpected error in the harness itself.

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def; };

const BASE_URL = (opt("--base-url", process.env.GATEWAY_BASE_URL || "https://mcp.otchealth.app")).replace(/\/$/, "");
const ADMIN_TOKEN = opt("--admin-token", process.env.ADMIN_REVOKE_TOKEN || "");
const BEARER = opt("--bearer", process.env.GATEWAY_BEARER || "");
const TIMEOUT_MS = parseInt(opt("--timeout-ms", "8000"), 10);

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

  // ── Step 3: real end-to-end tool calls via /mcp (needs GATEWAY_BEARER) ─────────────────────
  if (!BEARER) {
    record("tool_catalog_list_tools", "skipped", "GATEWAY_BEARER not set — no bearer available in this environment to authenticate tools/call (same env var eval-runner.mjs / deploy.yml's golden-case-eval step needs).");
    record("tool_memory_recall", "skipped", "GATEWAY_BEARER not set — skipped alongside catalog_list_tools.");
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

  const failed = steps.filter((s) => s.status === "fail");
  const skipped = steps.filter((s) => s.status === "skipped");
  const passed = steps.filter((s) => s.status === "pass");

  if (flag("--json")) {
    console.log(JSON.stringify({ base_url: BASE_URL, steps, summary: { passed: passed.length, failed: failed.length, skipped: skipped.length } }, null, 2));
  } else {
    console.log(`# GATEWAY-CANARY — ${BASE_URL} — ${passed.length} pass, ${failed.length} fail, ${skipped.length} skipped`);
    for (const s of steps) {
      const tag = s.status === "pass" ? "LIVE  " : s.status === "fail" ? "DEAD  " : "SKIP  ";
      console.log(`[${tag}] ${s.id.padEnd(26)} ${s.detail}`);
    }
    if (failed.length) console.log(`\nFAILED: ${failed.map((s) => s.id).join(", ")} — gateway is up but at least one contract silently broke.`);
    if (skipped.length) console.log(`SKIPPED (not failures, missing optional creds): ${skipped.map((s) => s.id).join(", ")}`);
  }

  process.exit(flag("--strict") && failed.length ? 3 : 0);
})().catch((e) => { console.error("[gateway-canary] ERROR: " + e.message); process.exit(1); });
