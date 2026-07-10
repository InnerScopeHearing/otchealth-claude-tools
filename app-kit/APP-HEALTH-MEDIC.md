# App Health Medic — the production -> agent feedback loop (design)

> Today the loop is: ship -> a human finds the bug -> tells the developer agent.
> This closes it: production telemetry auto-wakes the right developer session with a
> diagnosis. It extends the CTO's existing memory **fleet-medic** (superbrain Wave 4,
> `skills/fleet-medic`) from agent-memory health to APP health. Non-PHI ring.

## The idea
The fleet already emits the signal it needs to self-heal apps; nothing watches it for
the developer. Sentry holds crashes + crash-free rate; PostHog holds funnels,
activation, and retention. A standing monitor reads app health, and the moment an app
degrades past a threshold, it leaves a **self-heal directive** the developer session
picks up on its next prompt (exactly the mechanism the memory medic already uses:
SessionStart `kb-inject` surfaces a "PENDING SELF-HEAL" block), plus a `medic_dispatch`
alert so the operator has visibility without watching.

## Signals + thresholds (per app, per release)
| Source | Metric | Degrade trigger |
|---|---|---|
| Sentry | crash-free sessions (rolling 1h/24h) | < 99.0% sessions, or a NEW issue with > N events post-release |
| Sentry | a fatal issue tagged `level:fatal` on the latest release | any (boot crashes are P0) |
| PostHog | boot/first-screen reached (a `app_booted` / first interactive event) | a release whose install->first-screen rate drops vs the prior release (the "green screen" signature in production) |
| PostHog | activation: install -> aha event (per `design-tokens.json` ahaByApp) | a release-over-release drop > X% |
| PostHog | D1 retention | a release-over-release drop > X% |

The boot/first-screen signal is the production analogue of the boot-gate: instrument
an `app_booted` event fired from the `[data-boot-ready]` path (the same marker
`skills/boot-gate/templates/main-boot.tsx` sets). A build whose users install but never
fire `app_booted` is a green screen in the wild — page it immediately.

## The self-heal directive (what the agent receives)
On degrade, write a directive to the app's developer lane (kb-memory) + a per-repo
marker the SessionStart hook surfaces, containing: app, release/SHA, the metric that
broke, the top Sentry issue (title + stack frame + culprit) or the funnel step that
dropped, and a first-move suggestion (e.g. "crash in `main.tsx` at boot -> check the
ErrorBoundary + the latest 3 commits to the boot path; reproduce with the boot-gate").
The developer session, on its next prompt, sees it, investigates, and opens a draft
fix PR. Cooldown + never-nag-an-idle-app, same discipline as the memory medic.

## Build split
- **Read-side (developer can build now):** `skills/app-health/health.mjs` — pulls
  per-app Sentry crash-free + top issues (Sentry MCP / API) and PostHog activation/boot
  funnels (PostHog project per app, see the PostHog Project Registry), prints a health
  report, and emits the self-heal directive on degrade. Needs the per-app
  Sentry-project + PostHog-project map (mostly known) and the `app_booted`/aha events
  instrumented per app (a small per-app task).
- **Infra / standing monitor (CTO owns):** run `health.mjs` as a Container Apps Job on
  cron (the same pattern as the librarians + the memory fleet-medic), wire the
  `medic_dispatch` alert, and reuse the medic's escalation path. ESCALATE to the CTO to
  host this alongside the Wave-4 medic so app-health and memory-health share one
  dispatcher and one operator dashboard.

## Dependencies / first steps
1. Instrument `app_booted` (off the `[data-boot-ready]` marker) + the aha event in each
   app's PostHog (per-app task; pairs with adopting the boot-gate).
2. Confirm the per-app Sentry-project + PostHog-project registry.
3. Build `skills/app-health/health.mjs` (read-side, developer).
4. CTO: schedule it + wire alerts into the existing medic dispatcher.

PHI wall: MedReview/Companion PHI telemetry stays in the BAA ring; the app-health medic
reads only non-PHI projects + categorical metrics, never PHI event content.
