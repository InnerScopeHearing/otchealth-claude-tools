# Maintenance Kit — keep apps healthy and improving after launch

Goal: turn beta and production signal into fixes fast, and keep the whole portfolio
patched, without it eating all your time.

## Bug-hunting playbook (generalize iHEARtest ch 15)
A symptom-to-root-cause lookup table. The portable "Future Matt" method:
1. Simplest explanation that fits all symptoms.
2. Most common cause first.
3. Prove or disprove with one targeted test.
4. What changed in the last 24 hours.
Fixed order: reproduce, bisect from last known-good, confirm with one test, ship the
fix paired with a regression test that would have caught it. App-specific symptom
tables (audio routing, etc.) stay in the app repo; the method is portable.

## Centralize the bug intake
Beta bugs are scattered today (TestFlight feedback, forms, heads). Standardize a
single intake per app (GitHub Issues with templates) so they are catalogued and
fixable. You cannot systematically clear what is not written down.

## Sentry triage loop
Watch unresolved issues by frequency and user count, fix top offenders first,
resolve with a regression test. PHI apps: scrub before capture, Sentry is outside
the BAA ring.

## Routine sweeps (run portfolio-wide, in parallel)
Using Daytona + Claude + Greptile, run these across all apps on a schedule:
- Dependency upgrades + fix breakages.
- Security review (Claude `/security-review`) + fixes.
- Lint and dead-code cleanup.
- Doc and brand/legal sync.
Each produces a reviewed PR per repo; you merge.

## Regression tests are mandatory
Every fix ships with a test that would have caught the original bug. This is how
bugs stay dead and the app gets more stable over time, not less.

## Deliverable for this kit (to build next)
The GitHub Issue templates, a Sentry-triage helper, and the parallel-sweep
orchestrator (Daytona) that opens fix PRs across repos.
