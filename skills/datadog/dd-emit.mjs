#!/usr/bin/env node
// dd-emit.mjs — the fleet's ONE honest Datadog metric emitter.
//
// WHY THIS EXISTS: every other ad-hoc Datadog emitter in this repo (skills/datadog/dd-fleet.mjs,
// skills/xero/xero-token.mjs's local ddEmit()) fire-and-forgets a POST with NO r.ok check, wrapped
// in a bare `catch {}` — a network error or a non-2xx Datadog response is byte-for-byte
// indistinguishable from a successful emit. That is exactly the defect class this repo keeps
// shipping inside its own fixes (see skills/fleet-medic/medic.mjs's emitDispatch(), which HAD this
// bug for PostHog capture — "Succeeded" status, zero visible effect, for 11+ days — and was fixed
// with the pattern this module generalizes: a real HTTP-ok check, bounded retries with backoff, and
// a LOUD stderr line plus an ACCURATE boolean return on exhaustion). Use this for any new
// otc.fleet.* metric instead of writing a fifth ad-hoc emitter.
//
// Never throws. A Datadog outage must never fail the caller's real job (token rotation,
// session-end telemetry, ...) — but it must never be silently reported as having worked, either.
//
// Secret resolution defaults to Key Vault (kvSecret, the fleet's post-GCP-retirement secret store);
// callers needing deterministic tests can pass apiKey/site/fetchImpl explicitly (see tests/).
import { kvSecret } from "../kb-memory/azure-secret.mjs";

const DD_TYPE = { unspecified: 0, count: 1, rate: 2, gauge: 3 }; // matches skills/datadog/datadog.mjs's `metric` command

/**
 * Emit one Datadog metric. Returns true iff Datadog actually accepted it (HTTP 2xx). Returns false
 * — loudly, via console.error — on a missing credential, a non-2xx response, or a thrown/network
 * error, even after retrying. Never returns true unless a real 2xx response was observed; never throws.
 *
 * @param {string} metric      e.g. "otc.fleet.agent_error"
 * @param {number} value
 * @param {string[]} tags      LOW CARDINALITY only (see dd-fleet.mjs) — never ids/timestamps
 * @param {object} [opts]
 * @param {"count"|"gauge"|"rate"} [opts.type="gauge"]
 * @param {string} [opts.source="dd-emit"]     identifies the caller in the failure log line only
 * @param {string|null} [opts.apiKey]          override for tests; default resolves via kvSecret
 * @param {string} [opts.site]                 override for tests; default resolves via kvSecret
 * @param {typeof fetch} [opts.fetchImpl]       override for tests; default is the global fetch
 * @param {number} [opts.attempts=3]
 * @param {number} [opts.backoffMs=400]        base backoff between attempts (attempt * backoffMs)
 */
export async function ddEmitMetric(metric, value, tags, opts = {}) {
  const {
    type = "gauge",
    source = "dd-emit",
    fetchImpl = fetch,
    attempts = 3,
    backoffMs = 400,
  } = opts;
  const apiKey = opts.apiKey !== undefined ? opts.apiKey : await kvSecret("datadog-api-key");
  if (!apiKey) {
    console.error(`  [${source}] DATADOG EMIT SKIPPED for ${metric}: datadog-api-key did not resolve from Key Vault`);
    return false;
  }
  const site = opts.site !== undefined ? opts.site : ((await kvSecret("datadog-site")) || "us3.datadoghq.com");
  const body = JSON.stringify({
    series: [{ metric, type: DD_TYPE[type] ?? DD_TYPE.gauge, points: [{ timestamp: Math.floor(Date.now() / 1000), value }], tags }],
  });
  let lastErr = "unknown";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const r = await fetchImpl(`https://api.${site}/api/v2/series`, {
        method: "POST",
        headers: { "DD-API-KEY": apiKey, "Content-Type": "application/json" },
        body,
      });
      if (r.ok) return true;
      lastErr = `HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`.trim();
    } catch (e) {
      lastErr = (e && e.message) || String(e);
    }
    if (attempt < attempts) await new Promise((res) => setTimeout(res, backoffMs * attempt));
  }
  console.error(`  [${source}] DATADOG EMIT FAILED for ${metric} (tags: ${tags.join(",")}) after ${attempts} attempt(s): ${lastErr}`);
  return false;
}
