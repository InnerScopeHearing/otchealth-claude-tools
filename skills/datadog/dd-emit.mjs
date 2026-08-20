// dd-emit.mjs — shared, retrying, LOUD-ON-FAILURE Datadog metric submission for fleet emitter jobs.
//
// WHY THIS EXISTS, NOT skills/datadog/datadog.mjs OR skills/datadog/dd-fleet.mjs:
//   - datadog.mjs is a CLI entrypoint: it runs top-level side effects on import (resolves creds,
//     parses process.argv, calls process.exit() on failure) and is meant to be invoked as
//     `node datadog.mjs metric ...`, not imported as a module. Importing it from another script would
//     hijack that script's own argv and could process.exit() the caller out from under it.
//   - dd-fleet.mjs and xero-token.mjs's local `ddEmit()` both wrap their POST in try/catch and
//     swallow every failure silently (dd-fleet.mjs: `catch{ /* fail-open */ }` with no logging at
//     all). That is the EXACT "Succeeded job, zero visible telemetry" bug class this fleet already
//     shipped once for real (fleet-medic's PostHog capture -- see otchealth-claude-tools/CLAUDE.md,
//     2026-08-01 entry) and fixed by making the failure loud. A NEW emitter should not reintroduce
//     the same silent-swallow shape the fleet just spent a session fixing elsewhere.
//
// Contract: ddMetric() NEVER throws and NEVER silently drops a failure -- it always returns
// {ok, error?}, retried a few times with backoff for a transient failure. The CALLER is responsible
// for checking `ok` and surfacing failures (stderr line + a non-zero exit / a run summary), the same
// way skills/fleet-medic/medic.mjs's emitDispatch() and skills/token-keeper/keeper.mjs's `refresh`
// command already do for their own I/O.
import { kvSecret } from "../kb-memory/azure-secret.mjs";

const TYPE = { unspecified: 0, count: 1, rate: 2, gauge: 3 };

let _apiKey, _site, _resolved = false;
async function creds() {
  if (_resolved) return { apiKey: _apiKey, site: _site };
  _resolved = true;
  _apiKey = process.env.DD_API_KEY || (await kvSecret("datadog-api-key"));
  _site = process.env.DD_SITE || (await kvSecret("datadog-site")) || "datadoghq.com";
  return { apiKey: _apiKey, site: _site };
}

/** Submit ONE Datadog metric point (v2 series API). Retries transient failures with short backoff.
 *  Returns {ok:true} or {ok:false, error:<string>} -- never throws, never silently no-ops. A missing
 *  API key is reported as a real failure (not a quiet skip), matching fleet-medic's
 *  "POSTHOG CAPTURE SKIPPED" precedent for a missing credential. */
export async function ddMetric(name, value, { tags = [], type = "gauge", attempts = 3 } = {}) {
  const { apiKey, site } = await creds();
  if (!apiKey) return { ok: false, error: "datadog-api-key did not resolve (checked DD_API_KEY env and Key Vault)" };
  const body = JSON.stringify({
    series: [{ metric: name, type: TYPE[type] ?? 3, points: [{ timestamp: Math.floor(Date.now() / 1000), value: Number(value) }], tags }],
  });
  let lastErr = "unknown";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const r = await fetch(`https://api.${site}/api/v2/series`, {
        method: "POST",
        headers: { "DD-API-KEY": apiKey, "Content-Type": "application/json" },
        body,
      });
      if (r.ok) return { ok: true };
      lastErr = `HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`.trim();
    } catch (e) {
      lastErr = (e && e.message) || String(e);
    }
    if (attempt < attempts) await new Promise((res) => setTimeout(res, 400 * attempt));
  }
  return { ok: false, error: lastErr };
}

/** Test-only: clear memoized credentials so a test can force re-resolution under a fresh env/mock. */
export function _resetForTests() {
  _apiKey = undefined; _site = undefined; _resolved = false;
}
