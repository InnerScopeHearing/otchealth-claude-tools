# Pre-Launch Kit — get through Apple and the stores without surprises

Goal: a repeatable path from "feature complete" to "approved and ready," with the
Apple-side friction pre-solved. Generalize from iHEARtest manual ch 7 and the
MedReview / iHEARtest launch runbooks.

## App Store Connect + signing (the Apple side)
- App record created via the web UI (Apple returns 403 on programmatic creation).
- Bundle id, team, signing certs, provisioning, In-App Purchase key.
- `Info.plist` keys patched via plutil: `UIBackgroundModes`,
  `ITSAppUsesNonExemptEncryption`, usage-description strings, ATS.
- TestFlight internal + external groups configured.

## Store listing kit
- Name, subtitle, keywords (ASO, see Marketing kit), description.
- Screenshots and preview (designer skill: `compose-screenshot.mjs`, device frames + headlines).
- Privacy policy URL + App Privacy answers (data types, tracking).
- Age rating, category, support URL.

## Compliance pre-flight
- **PHI apps (MedReview):** BAA-covered services only, audit logging, no PHI in
  Sentry/analytics, data-persistence rules (manual ch 12). MedReview already has
  audit-log migrations and triggers; make that the standard for PHI apps.
- **Health claims:** no medical advice, no diagnosis claims, "may help" framing.
- **Accessibility:** senior-first WCAG pass (manual ch 13).

## Pre-flight checklist (run before every submission)
- [ ] Tests green (unit + Maestro)
- [ ] Greptile review clean
- [ ] Bug-Hunting Playbook smoke test of the core flow on a real device
- [ ] Build number bumped, release notes written
- [ ] Store listing + screenshots current
- [ ] Privacy answers match actual data use
- [ ] Monetization (RevenueCat) products approved and live
- [ ] OTA channel configured (Launch kit)

## Deliverable for this kit (to build next)
A submission checklist generator and a store-metadata template per app.
