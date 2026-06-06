# Startup Kit — scaffold a new app from zero

Goal: a new app reaches "builds, runs, brand-correct, monetization and telemetry
wired, tests passing" in hours, not weeks, from a common base.

## What a new app gets on day one
1. **Repo + CLAUDE.md.** Private GitHub repo, plus a CLAUDE.md from the template
   (`CLAUDE.template.md`) that holds the non-negotiable rules (no medical advice,
   PHI ring boundaries, senior accessibility as a hard requirement, credentials
   never ship to the client, entitlements enforced server-side). Every mature app
   already has one (iHEARtest, MedReview, Companion, InnerEase). Standardize it.
2. **Capacitor 8 scaffold** for hybrid apps: `capacitor.config.ts`, the pinned
   plugin set (app, browser, haptics, local-notifications, preferences,
   push-notifications, share, splash-screen, status-bar), `www/` structure.
   Generalize from iHEARtest engineering-manual ch 2.
3. **Brand assets** via the designer skill: app icon family, splash, store
   screenshots, from the project brand profile. No per-app reinvention.
4. **Monetization (RevenueCat)** wiring stub. Generalize from iHEARtest manual ch 10.
5. **Telemetry (Sentry)** + a PHI scrubber by default. Manual ch 16. PHI apps must
   scrub before capture (Sentry is outside the BAA ring).
6. **i18n** scaffold + the i18n coverage check (`qa/scripts/i18n-coverage-check.mjs`
   pattern from iHEARtest).
7. **CI** from the templates (Codemagic for native, GitHub Actions for web/services).
8. **Test scaffold** from the Testing kit (Vitest + Maestro), green from commit one.

## Accounts and services checklist (the human steps)
Generalize from Companion `docs/SPRINT_0_CHECKLIST.md` and iHEARtest manual ch 7.
- [ ] App Store Connect app record (Apple blocks programmatic creation; do via web UI)
- [ ] Bundle id, team id, signing
- [ ] RevenueCat app + entitlements + products
- [ ] Sentry project
- [ ] Codemagic app + workflow
- [ ] Customer.io / push (APNs) if the app uses messaging
- [ ] Privacy policy + store privacy answers

## Deliverable for this kit (to build next)
A `scaffold-app` script/skill that takes an app name + brand profile and produces
the above, plus a `CLAUDE.template.md`. Until then, copy from the most similar
existing app and strip the app-specific science.
