# Launch Kit — ship the release and the day-of operations

Goal: a calm, scripted launch with fast rollback, generalized from the iHEARtest
`beta-test/automation/launch-day-runbook.md` and MedReview `launch-runbook-day-21.md`.

## Release pipeline
- Merge to main triggers the Codemagic build and (automated) TestFlight upload.
- One merge equals one shippable build. No manual ritual.
- Release notes generated from the merged PRs.

## OTA / Live Updates (the velocity unlock)
Most of a Capacitor app is the `www/` web layer. Wire **Capgo (or Ionic Appflow)
Live Updates** so web-layer fixes and copy changes ship over the air in minutes
without an App Review cycle. Native changes still go through the store. This turns
the effective release cycle for most changes from days to minutes.
- Channels: production, beta. Staged rollout by percentage.
- A one-tap rollback to the previous OTA bundle.

## Phased rollout
- TestFlight external cohort first (the iHEARtest runbook caps the first round near
  75 testers, balanced by source / age / device).
- App Store phased release (Apple's 7-day ramp) for native releases.
- Feature flags so code ships dark and is turned on gradually.

## Launch-day runbook (template)
Day before: final QA, confirm build in TestFlight, prep the tester cohort, confirm
messaging (Customer.io). Launch day: send invites, watch Sentry and reviews, have
the rollback ready. Generalize the iHEARtest checklist into an app-agnostic template.

## Monetization go-live
- RevenueCat products live and approved, paywall flag on, restore-purchases tested.
- Track activation to paid conversion from day one.

## Deliverable for this kit (to build next)
The Capgo Live Updates setup as a reusable config, the automated TestFlight-on-merge
CI step, and the app-agnostic launch-day runbook template.
