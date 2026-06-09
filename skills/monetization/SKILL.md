---
name: monetization
description: App + service revenue mechanics, paywall and pricing/trial A/B (RevenueCat / Superwall), subscription design, and RTM billing (codes 98975-98981) for medication-adherence revenue on MedReview/Companion. Turns app exposure into recurring and billable cash. Wielded by the Growth and Commerce agents. PHI-aware; RTM billing is human/clinically gated.
---

# monetization — recurring + billable revenue from the apps

Apps are slow to cash, but their monetization compounds. This skill builds the
revenue mechanics so exposure converts to recurring and billable dollars.

## When to invoke
An app needs a paywall, pricing/trial experiment, subscription, or the RTM billing
opportunity is being pursued.

## What it does
- **Paywalls + pricing A/B** via RevenueCat Experiments or Superwall (remote config,
  no app-store resubmission): trial length, price points, paywall design, placement
  (show after the user hits the core value, not a hard gate).
- **Subscription design:** tiers, entitlements (server-enforced), winback offers,
  family plans.
- **RTM billing (98975-98981):** wire medication-adherence monitoring on
  MedReview/Companion into a reimbursable workflow, real billable revenue, not just
  consumer IAP. Specify the clinical data capture, the billing path, and the
  human/clinical gates with Compliance.

## Hard guardrails
- **PHI:** monetization/subscriber events never carry health identifiers; RTM is a
  PHI workflow, BAA + scrubbing + clinical oversight required, human-gated.
- **RTM is clinically + compliance gated:** it involves billing payers; nothing goes
  live without the clinical/compliance owner's sign-off (not an autonomous action).
- App-store rules: entitlements server-side; no dark-pattern paywalls for seniors.
- Securities firewall: app revenue only, no stock/raise tie-ins. No em or en dashes.

## Output
Live paywalls/experiments tied to revenue in PostHog; an RTM billing plan ready for
clinical/compliance approval; results on the cash scoreboard.
