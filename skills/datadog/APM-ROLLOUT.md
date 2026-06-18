# Datadog APM + logs rollout — the fleet recipe

The uniform, key-gated pattern for instrumenting every Node backend in the fleet. Reference
implementation: Flatstick API (PR InnerScopeHearing/flatstick#69). Apply the same shape to
each backend as a DRAFT PR; the App Lead validates in staging before prod.

## Why it's safe to apply everywhere
The instrumentation is **inert unless `DD_API_KEY` is set in that environment.** `dd-trace`
only `init`s when the key is present, and `serverless-init` forwards nothing without it. So:
- Every PR is uniformly safe, merging it changes nothing until a key is provisioned.
- The **PHI gate** is simply: do NOT provision the prod `DD_API_KEY` for MedReview / Companion
  until a Datadog BAA is signed. Dev/staging may get a key now (no real PHI pre-launch).
- The **COPPA gate** (FourVault): backend APM only, never kid-screen frontend telemetry; keep
  the existing PII/free-text scrubbers; tag `env`.

## The recipe (per Node backend)
1. **Add the dep:** `dd-trace` (pnpm/npm add; commit the lockfile so `--frozen-lockfile` stays green).
2. **Init first:** add `src/instrument.ts` and import it as the FIRST line of the container entrypoint.
   ```ts
   import tracer from "dd-trace";
   if (process.env.DD_API_KEY) {
     tracer.init({
       service: process.env.DD_SERVICE || "<app>-api",
       env: process.env.DD_ENV || process.env.NODE_ENV || "development",
       version: process.env.DD_VERSION,
       logInjection: true,
       runtimeMetrics: true,
     });
   }
   export default tracer;
   ```
3. **Dockerfile:** wrap the entrypoint with serverless-init (APM + logs + metrics, no agent;
   works on Azure Container Apps AND Cloud Run):
   ```dockerfile
   COPY --from=datadog/serverless-init:1 /datadog-init /app/datadog-init
   ENV DD_SITE=us3.datadoghq.com
   ENV DD_SERVICE=<app>-api
   ENV DD_LOGS_INJECTION=true
   ENV DD_SERVERLESS_LOG_PATH=/dev/stdout
   ENTRYPOINT ["/app/datadog-init"]
   CMD [ ...the existing start command... ]
   ```
4. **Verify:** typecheck + tests green. Draft PR only (do NOT merge; do NOT provision any key in the PR).

## Per-app plan
| App | Repo | Deploy | DD_SERVICE | Ring | Notes |
|-----|------|--------|-----------|------|-------|
| Flatstick API | flatstick | Azure Container Apps | flatstick-api | non-PHI | DONE (PR #69) |
| Gateway | otchealth-mcp-server | Azure | gateway-mcp | non-PHI | clean |
| FourVault API | fourvault | (Cloud Run/Docker) | fourvault-api | COPPA | backend only; keep PII scrubbers; no kid-screen telemetry |
| MedReview API | medreview | Cloud Run | medreview-api | PHI | key-gated; NO prod key until Datadog BAA; keep PHI scrubber; dev only now |
| Companion backend | otchealth-companion | Cloud Run | companion-api | PHI | key-gated; NO prod key until Datadog BAA; dev only now |

## Activation (per environment, operator step)
Add `DD_API_KEY` (from Secret Manager `datadog-api-key`) to that environment's secrets, and
optionally `DD_ENV` (dev|staging|production). No key = no telemetry. For PHI apps, set the
key ONLY in dev/staging until the BAA; never in production pre-BAA.

## Frontends (phase 2, not APM)
iHEARtest / AWARE / InnerEase / INND site are client-side. They get **Datadog RUM** (browser),
a separate, lighter integration, evaluated against the PostHog overlap and the senior/PHI
surface-capture considerations. Not part of this backend APM wave.
