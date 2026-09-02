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

// Memoize the PROMISE, not a resolved-yet flag. An eager `_resolved = true` before the await had two
// failure modes: a second caller entering while the first was still awaiting would be handed
// undefined creds (a spurious "did not resolve"), and a THROWN lookup would leave the flag latched so
// every later call in the process reported the same phantom failure -- one transient secret-store
// blip permanently blinding the emitter. Clearing the cache on rejection keeps a failure retryable.
let _credsPromise = null;
// Test-only indirection. kvSecret() CAN reject (it reaches AWS SSM), and this module's whole contract
// is that such a rejection surfaces as {ok:false, error} rather than as a thrown exception at the
// caller. There is no way to force that path from a test otherwise: node:test's mock.module is
// unavailable here (it needs --experimental-test-module-mocks and the runner is a plain `node --test`).
// Defaults to the real kvSecret; _resetForTests() restores it so a stub cannot leak between tests.
let _secretGetter = kvSecret;
function creds() {
  if (!_credsPromise) {
    _credsPromise = (async () => ({
      apiKey: process.env.DD_API_KEY || (await _secretGetter("datadog-api-key")),
      site: process.env.DD_SITE || (await _secretGetter("datadog-site")) || "datadoghq.com",
    }))().catch((e) => {
      _credsPromise = null;
      throw e;
    });
  }
  return _credsPromise;
}

/** Submit ONE Datadog metric point (v2 series API). Retries transient failures with short backoff.
 *  Returns {ok:true} or {ok:false, error:<string>} -- never throws, never silently no-ops. A missing
 *  API key is reported as a real failure (not a quiet skip), matching fleet-medic's
 *  "POSTHOG CAPTURE SKIPPED" precedent for a missing credential. */
export async function ddMetric(name, value, { tags = [], type = "gauge", attempts = 3 } = {}) {
  // creds() reaches a secret store (kvSecret -> AWS SSM), so it CAN throw. Resolving it outside a
  // try/catch would break this module's own "never throws" contract at its very first statement and
  // hand the caller an exception instead of the {ok:false, error} it is written to check.
  let apiKey, site;
  try {
    ({ apiKey, site } = await creds());
  } catch (e) {
    return { ok: false, error: `datadog credential lookup FAILED: ${(e && e.message) || String(e)}` };
  }
  if (!apiKey)
    return {
      ok: false,
      error:
        "datadog-api-key did not resolve (checked the DD_API_KEY env var, then kvSecret -> AWS SSM " +
        "/otchealth/datadog-api-key). NOTE: kvSecret reads SSM, not Key Vault -- kv-otc-55c84f6bef " +
        "died with Azure subscription 55c84f6b on 2026-08-13; do not go looking for it there.",
    };
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

/** Test-only: clear memoized credentials so a test can force re-resolution under a fresh env/mock,
 *  and restore the real secret getter so a stub from one test cannot leak into the next. */
export function _resetForTests() {
  _credsPromise = null;
  _secretGetter = kvSecret;
}

/** Test-only: substitute the secret lookup (see _secretGetter above). Pass nothing to restore. */
export function _setSecretGetterForTests(fn) {
  _secretGetter = fn || kvSecret;
  _credsPromise = null;
}
