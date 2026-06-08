---
name: telemetry-wiring
description: Growth's and Medic's equipment. Manifest-driven wiring of PostHog (single-BAA analytics + flags + experiments + mask-by-default replay) and Sentry (scrubbed errors + release health + Seer), PHI-aware by construction. Use to instrument an app so experiments and error triage have data, without leaking PHI.
---

# telemetry-wiring — instrument an app, PHI-safe by construction

## When to invoke
An app needs analytics/flags/experiments (Growth) or error+release-health (Medic).

## PostHog (the single analytics backbone)
- Init the mobile/web SDK with the app's **`phc_` project key** (NOT the `phx_`
  management key, which stays server/agent-side). Pull from the project settings.
- **Session replay: keep masks ON.** Mobile replay masks text/inputs/images on-device,
  so PHI never leaves the phone. Add `ph-no-capture` to any custom PHI-bearing view.
- Feature flags + experiments via the same SDK so exposure and outcome live together.
- For the PHI app: confirm the **BAA add-on (Boost)** is active before enabling on the
  PHI project; keep PHI out of event properties regardless.

## Sentry (errors + release health)
- Init with a `beforeSend` PHI **scrubber** (`templates/sentry-beforeSend.ts`): strip
  emails, names, tokens, and known PHI fields before capture. For the PHI app, also run
  a self-hosted **Relay** in front so scrubbing happens before egress.
- Enable Release Health (crash-free session/user) and tag releases so Medic can gate.
- Connect the repo so **Seer** can root-cause and open fix PRs.

## PostHog + Sentry connector
Wire the connector so a Sentry error links to the PostHog replay of the user who hit it.

## Output
Populate `manifest.services.posthog` / `.sentry` (project, baa, relay flags). Hand to
Growth (experiments) or Medic (health gates).

## Guardrails (PHI)
Masks on, `ph-no-capture` on PHI views, `beforeSend` scrubbing + Relay for PHI, BAA
confirmed before PHI flows. Monetization/analytics events never carry health identifiers.
No em or en dashes in any user-facing survey/flag copy.
