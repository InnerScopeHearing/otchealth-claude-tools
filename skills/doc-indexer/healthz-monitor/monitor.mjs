#!/usr/bin/env node

// Source-controlled replacement candidate for the opaque SSM-injected healthz monitor.
// This is intentionally read/report-only: it never calls Graph, email, AWS, or a write API.
import { pathToFileURL } from "node:url";

export const HEALTH_URL = "https://mcp.otchealth.app/health";
export const MAX_RESPONSE_BYTES = 16 * 1024;
export const DEFAULT_TIMEOUT_MS = 5000;
export const MAX_OBSERVATION_AGE_MS = 5 * 60 * 1000;
export const MAX_FUTURE_SKEW_MS = 60 * 1000;
const EXPECTED_SERVICE = "otchealth-mcp-server";

function receipt(status, reason, httpStatus = null, checkedAt = new Date().toISOString(), service = null,
  gatewayObservedAt = null) {
  return { status, reason, httpStatus, checkedAt, service, gatewayObservedAt };
}

function discardBody(response) {
  try {
    const pending = response.body?.cancel?.();
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch { /* body is not consumed or reported on non-JSON/error responses */ }
}

async function readBodyBounded(response, maxBytes) {
  const declaredLength = response.headers?.get?.("content-length");
  if (declaredLength && Number.isFinite(Number(declaredLength)) && Number(declaredLength) > maxBytes) {
    try { await response.body?.cancel(); } catch { /* bounded failure; do not emit body */ }
    throw new Error("response_too_large");
  }
  if (!response.body?.getReader) throw new Error("body_unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* best effort stop after the hard byte bound */ }
        throw new Error("response_too_large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch { /* nothing else can use this response body */ }
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

/**
 * Probe only Gateway's public, cheap /health endpoint. The endpoint contract is sourced from
 * Gateway src/server/health.ts; do not substitute /health/deep (admin-gated and makes dependencies).
 * Returns a bounded allowlist receipt and never returns the gateway body or an exception message.
 */
export async function runHealthzProbe({ fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = MAX_RESPONSE_BYTES, now = () => Date.now() } = {}) {
  const checkedAt = new Date(now()).toISOString();
  if (typeof fetchImpl !== "function" || !Number.isInteger(timeoutMs) || timeoutMs < 1
      || !Number.isInteger(maxBytes) || maxBytes < 1) {
    return receipt("unhealthy", "invalid_probe_configuration", null, checkedAt);
  }
  const controller = new AbortController();
  let timer;
  let timedOut = false;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("probe_timeout"));
    }, timeoutMs);
  });
  const request = (async () => {
   try {
    const response = await fetchImpl(HEALTH_URL, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response || typeof response.status !== "number") {
      return receipt("unhealthy", "invalid_response", null, checkedAt);
    }
    if (!response.ok) {
      discardBody(response);
      return receipt("unhealthy", "http_status", response.status, checkedAt);
    }
    const contentType = response.headers?.get?.("content-type")?.toLowerCase() || "";
    if (!(contentType.includes("application/json") || contentType.includes("+json"))) {
      discardBody(response);
      return receipt("unhealthy", "unexpected_content_type", response.status, checkedAt);
    }
    let text;
    try {
      text = await readBodyBounded(response, maxBytes);
    } catch (error) {
      const code = timedOut ? "timeout" : (["response_too_large", "body_unavailable"].includes(error?.message) ? error.message : "body_read_failed");
      return receipt("unhealthy", code, response.status, checkedAt);
    }
    let payload;
    try { payload = JSON.parse(text); }
    catch { return receipt("unhealthy", "invalid_json", response.status, checkedAt); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return receipt("unhealthy", "unexpected_payload_shape", response.status, checkedAt);
    }
    const timestamp = typeof payload.time === "string" ? Date.parse(payload.time) : NaN;
    if (payload.service !== EXPECTED_SERVICE || !Number.isFinite(timestamp)
        || !["ok", "degraded"].includes(payload.status)
        || !["ok", "degraded"].includes(payload.liveness)
        || !["ready", "not_ready"].includes(payload.readiness)) {
      return receipt("unhealthy", "unexpected_payload_shape", response.status, checkedAt,
        payload.service === EXPECTED_SERVICE ? EXPECTED_SERVICE : null);
    }
    const gatewayObservedAt = new Date(timestamp).toISOString();
    const ageMs = now() - timestamp;
    if (ageMs > MAX_OBSERVATION_AGE_MS) {
      return receipt("unhealthy", "stale_gateway_observation", response.status, checkedAt,
        EXPECTED_SERVICE, gatewayObservedAt);
    }
    if (ageMs < -MAX_FUTURE_SKEW_MS) {
      return receipt("unhealthy", "future_gateway_observation", response.status, checkedAt,
        EXPECTED_SERVICE, gatewayObservedAt);
    }
    if (payload.status !== "ok" || payload.liveness !== "ok" || payload.readiness !== "ready") {
      return receipt("unhealthy", "gateway_not_ready", response.status, checkedAt, EXPECTED_SERVICE,
        gatewayObservedAt);
    }
    return receipt("healthy", null, response.status, checkedAt, EXPECTED_SERVICE, gatewayObservedAt);
   } catch {
    return receipt("unhealthy", timedOut || controller.signal.aborted ? "timeout" : "request_failed", null, checkedAt);
   }
  })();
  try {
    return await Promise.race([request, deadline]);
  } catch {
    return receipt("unhealthy", "timeout", null, checkedAt);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const result = await runHealthzProbe();
  // Never print response bodies, upstream messages, credentials, or email addresses.
  console.log(JSON.stringify(result));
  if (result.status !== "healthy") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
