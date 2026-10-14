import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runHealthzProbe, HEALTH_URL } from "../skills/doc-indexer/healthz-monitor/monitor.mjs";

const HEALTHY = {
  status: "ok", liveness: "ok", readiness: "ready", service: "otchealth-mcp-server",
  time: new Date().toISOString(), revision: { image_digest: "sha256:abc" },
};

function response(body, { status = 200, contentType = "application/json" } = {}) {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

test("healthy public /health response is reduced to a safe receipt", async () => {
  let seen;
  const result = await runHealthzProbe({ fetchImpl: async (url, options) => {
    seen = { url: String(url), options };
    return response(JSON.stringify({ ...HEALTHY, secret: "must-not-escape" }));
  }, now: () => Date.now() });
  assert.equal(seen.url, HEALTH_URL);
  assert.equal(seen.options.method, "GET");
  assert.equal(seen.options.redirect, "error");
  assert.equal(result.status, "healthy");
  assert.equal(result.service, "otchealth-mcp-server");
  assert.equal(JSON.stringify(result).includes("must-not-escape"), false);
});

test("HTTP 200 alone is not healthy when gateway reports degraded readiness", async () => {
  const result = await runHealthzProbe({ fetchImpl: async () => response(JSON.stringify({ ...HEALTHY, status: "degraded", readiness: "not_ready" })) });
  assert.deepEqual({ status: result.status, reason: result.reason }, { status: "unhealthy", reason: "gateway_not_ready" });
});

test("stale and future gateway snapshots are rejected with fixed reasons and observed-time metadata", async () => {
  const now = Date.parse("2026-10-14T09:00:00.000Z");
  const probe = (time) => runHealthzProbe({ now: () => now,
    fetchImpl: async () => response(JSON.stringify({ ...HEALTHY, time })) });
  const stale = await probe("2026-10-14T08:54:59.999Z");
  const future = await probe("2026-10-14T09:01:00.001Z");
  const fresh = await probe("2026-10-14T08:55:00.000Z");
  assert.equal(stale.status, "unhealthy");
  assert.equal(stale.reason, "stale_gateway_observation");
  assert.equal(stale.gatewayObservedAt, "2026-10-14T08:54:59.999Z");
  assert.equal(future.status, "unhealthy");
  assert.equal(future.reason, "future_gateway_observation");
  assert.equal(future.gatewayObservedAt, "2026-10-14T09:01:00.001Z");
  assert.equal(fresh.status, "healthy");
  assert.equal(fresh.gatewayObservedAt, "2026-10-14T08:55:00.000Z");
});

test("rejects unexpected HTML, malformed JSON, and oversized body without echoing content", async () => {
  const html = await runHealthzProbe({ fetchImpl: async () => response("<html>private</html>", { contentType: "text/html" }) });
  const malformed = await runHealthzProbe({ fetchImpl: async () => response("private malformed content") });
  const oversized = await runHealthzProbe({ maxBytes: 16, fetchImpl: async () => response(JSON.stringify(HEALTHY)) });
  assert.equal(html.reason, "unexpected_content_type");
  assert.equal(malformed.reason, "invalid_json");
  assert.equal(oversized.reason, "response_too_large");
  assert.equal(JSON.stringify([html, malformed, oversized]).includes("private"), false);
});

test("redirects and non-2xx responses are not treated as success", async () => {
  const redirect = await runHealthzProbe({ fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, "error");
    throw new TypeError("redirect disallowed");
  } });
  const failed = await runHealthzProbe({ fetchImpl: async () => response("{}", { status: 503 }) });
  assert.equal(redirect.reason, "request_failed");
  assert.equal(failed.reason, "http_status");
});

test("timeout is bounded and no alert/email side effect is attempted", async () => {
  let signal;
  const result = await runHealthzProbe({ timeoutMs: 10, fetchImpl: (_url, options) => {
    signal = options.signal;
    return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }));
  } });
  assert.equal(signal.aborted, true);
  assert.equal(result.reason, "timeout");
  assert.equal(Object.keys(result).some((key) => /email|alert|body|detail/i.test(key)), false);
});

test("deadline also bounds a response body reader that stalls after headers", async () => {
  const body = new ReadableStream({ pull: () => new Promise(() => {}) });
  const result = await runHealthzProbe({ timeoutMs: 10, fetchImpl: async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }) });
  assert.equal(result.reason, "timeout");
});

test("actual CLI prints only a minimal receipt and exits nonzero for HTTP 200 not-ready", () => {
  const scriptPath = fileURLToPath(new URL("../skills/doc-indexer/healthz-monitor/monitor.mjs", import.meta.url));
  const runCli = (payload) => spawnSync(process.execPath, ["--input-type=module", "-e", `
    globalThis.fetch = async () => new Response(JSON.stringify(${JSON.stringify(payload)}), {
      status: 200, headers: { "content-type": "application/json" }
    });
    process.argv[1] = ${JSON.stringify(scriptPath)};
    await import(${JSON.stringify(pathToFileURL(scriptPath).href)});
  `], { encoding: "utf8", timeout: 1000 });
  const healthy = runCli(HEALTHY);
  assert.equal(healthy.status, 0, healthy.stderr);
  const healthyReceipt = JSON.parse(healthy.stdout);
  assert.deepEqual({ status: healthyReceipt.status, httpStatus: healthyReceipt.httpStatus }, { status: "healthy", httpStatus: 200 });
  const degraded = runCli({ ...HEALTHY, status: "degraded", readiness: "not_ready", private_detail: "must-not-print" });
  assert.equal(degraded.status, 1);
  assert.deepEqual(JSON.parse(degraded.stdout).reason, "gateway_not_ready");
  assert.equal(degraded.stdout.includes("must-not-print"), false);
  assert.equal(degraded.stdout.trim().split("\n").length, 1);
});
