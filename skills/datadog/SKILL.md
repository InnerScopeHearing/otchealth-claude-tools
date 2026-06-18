---
name: datadog
description: The fleet observability skill for Datadog ($100k startup credit). Submit metrics + events, manage monitors, dashboards, and synthetic uptime checks, and run the Microsoft Azure cloud integration so Datadog pulls our Azure infra metrics (Container Apps, the n8n VM, Blob storage, Azure OpenAI). Datadog covers the infra + APM + logs layer that PostHog (product) and Sentry (errors) do not. Wielded by the CTO / medic / growth agents. Reads keys from Secret Manager (datadog-api-key, datadog-app-key, datadog-site). HARD PHI WALL: do NOT point Datadog APM/logs at MedReview or OTCHealth Companion (PHI/BAA) until a Datadog BAA is signed and PHI scrubbing is configured; non-PHI apps + infra only.
---

# datadog — fleet observability (infra + APM + logs)

Datadog is the observability layer for the OTCHealth/InnerScope stack, funded by the $100k
startup credit. It complements, does not replace, PostHog (product analytics, primary) and
Sentry (native crash/errors). Datadog owns: Azure infra metrics, backend APM/traces, log
management, synthetics/uptime, and alerting.

Org: **OTCHealth Inc.** | Site: **us3.datadoghq.com** (API base `https://api.us3.datadoghq.com`).

## Commands
```
node skills/datadog/datadog.mjs verify                                  # validate keys + print org
node skills/datadog/datadog.mjs metric <name> <value> [--tags a:b] [--type gauge|count|rate]
node skills/datadog/datadog.mjs event "<title>" "<text>" [--tags ...]
node skills/datadog/datadog.mjs monitors                                # list monitors
node skills/datadog/datadog.mjs monitor "<type>" "<query>" "<name>" ["<msg>"]
node skills/datadog/datadog.mjs dashboards                              # list dashboards
node skills/datadog/datadog.mjs dashboard <file.json>                   # create dashboard from JSON
node skills/datadog/datadog.mjs synthetic <url> "<name>" [--tags ...]   # HTTP uptime test (5m, us-east-1 + us-west-1)
node skills/datadog/datadog.mjs azure-integration                       # wire the Azure cloud integration (azure-sp)
node skills/datadog/datadog.mjs azure-list                              # list configured Azure integrations
node skills/datadog/datadog.mjs request <METHOD> <path> [body<stdin]    # generic API passthrough
```

## Auth
Reads `DD_API_KEY` / `DD_APP_KEY` / `DD_SITE` from env (hydrated by `setup/fetch-secrets.mjs`)
or directly from Secret Manager via the claude-driver SA. Keys are flagged ROTATE-BEFORE-LAUNCH.

## What is live (set up 2026-06-18)
- **Azure cloud integration**: wired via the `azure-sp` (metrics_enabled, resource collection on).
  Datadog pulls Azure Monitor metrics for the subscription. If metrics are thin, ensure the SP
  has `Monitoring Reader` (Contributor, which it has, is a superset).
- **Synthetics**: `automation.otchealth.app/healthz` (n8n self-host) and `innd.com` (INND site).
- **Dashboard**: "OTCHealth Fleet Overview" (Azure CPU / Container Apps / Blob + the PHI note).

## HARD PHI wall (do not cross without a BAA)
- MedReview and OTCHealth Companion are PHI under the GCP BAA. **Do NOT send their logs or
  traces to Datadog** until a **Datadog BAA** is signed and PHI scrubbing is configured.
- Non-PHI apps (Flatstick, AWARE, InnerEase, Fictionary, OTCHealthMart, INND site) and the
  Azure infra are fine to instrument now.
- FourVault is COPPA: no kid-screen telemetry to Datadog.

## APM / logs rollout (per non-PHI backend, follow-on)
Install `dd-trace` in the backend (Flatstick API, the gateway, etc.), set `DD_API_KEY`,
`DD_SITE`, `DD_ENV`, `DD_SERVICE`, `DD_VERSION`, enable log collection. Tag everything
`team:<app> env:prod`. Keep PHI services OUT until the BAA lands.
