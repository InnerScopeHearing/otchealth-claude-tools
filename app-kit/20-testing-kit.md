# Testing Kit — make a green build trustworthy without a human checklist

Goal: replace slow manual QA gating with fast automated gates, so changes ship
confidently and quickly. Today most apps have no automated tests (iHEARtest:
`"test": "echo No tests yet"`).

## Three layers
1. **Unit (Vitest).** Test the logic that breaks silently and matters most:
   scoring, calibration, audiometry math, IAP/entitlement logic, i18n coverage,
   PDF/report generation. Runs on every commit, fast.
2. **End-to-end (Maestro).** Automate the critical user flows on a simulator.
   iHEARtest and AWARE already have `qa/maestro/flows/`. Standardize a flow set:
   onboarding, the core action (screening/test/review), paywall, export, settings.
3. **Synthetic focus-group review (the AWARE pattern).** AWARE runs persona
   reviews (`qa/focus-group-buyers/reviews/*.json`) that produce a `FIX_LIST`.
   Generalize this: a set of senior personas review each build for UX and produce
   a prioritized fix list. This catches usability bugs tests do not.

## Dev/test data: synthetic by default (never real PHI)
Test fixtures, seed data, focus-group inputs, and any records an agent builds
against come from the `synthetic-health-data` skill, never from a real
patient/customer roster. One command produces the canonical, reproducible bundle:

```bash
node skills/synthetic-health-data/seed-fixtures.mjs   # fixtures/synthetic/{hearing-screening,patient,customer,order}.json
```

A fixed seed gives byte-identical output, so commit the bundle (or the seed
command) into the app repo and every contributor and CI run gets the same data.
This is the fleet standard, see `app-kit/DEV-DATA-STANDARD.md` for the Iron Rule,
the generator flags, and the (BAA-only) `deident.mjs` path for real extracts.

## Gate it in CI
Wire unit + Maestro into the CI workflow so a red test blocks merge. Greptile
reviews the PR in parallel. The human only checks the genuinely device-dependent
things (native audio routing), per the Bug-Hunting Playbook.

## Build-review checklist
Keep the per-build QA checklist (iHEARtest `qa/build-review-*.html`) but as the
LAST gate for device-only items, not the first gate for everything.

## Run tests in parallel (Daytona)
For the portfolio, run each app's suite in its own Daytona sandbox so the whole
fleet is verified at once.

## Deliverable for this kit (to build next)
A drop-in `vitest.config` + example specs for the common logic, a standard Maestro
flow set, the persona focus-group harness, and the CI gate template.
