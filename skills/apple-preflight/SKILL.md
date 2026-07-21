---
name: apple-preflight
description: The CTO's pre-dispatch gate before an ios-depot build ships to App Store submission, or before a build promotes to the external tester pool. Maps each fleet app's real risk profile (kids/COPPA, health/AI/medical claims, subscription/IAP, social/UGC, privacy manifest, encryption/export compliance) to the relevant Apple App Store Review Guideline checklist, sourced from the installed capacitor-apple-review-preflight plugin (guideline-cited, verbatim) with a condensed guideline-cited fallback when that plugin is not present in the session. Prints an advisory report only, it never blocks a build itself; the human CTO reads it and decides. Trigger before dispatching any ios-depot.yml build headed for App Store review, before promoting TestFlight external testers, or after an Apple rejection to map the rejection back to the right checklist section. Run: node skills/apple-preflight/apple-preflight.mjs --app <id>.
---

# apple-preflight, the CTO pre-dispatch Apple review gate

## Why this exists

iOS build + TestFlight upload are CTO-only across the fleet (every per-app CLAUDE.md says so).
That means the CTO is the one seat that can catch an App Store Review rejection BEFORE it
costs a review cycle, if it reads the right checklist before dispatching the build. This skill
is that read: given a fleet app id, it prints the guideline-cited checklist sections that
actually apply to that app's real risk profile (a kids app gets kids.md, a paywalled AI health
app gets health_fitness.md + ai_apps.md + subscription_iap.md, and so on), plus two checks that
apply to every app regardless of category, the Privacy Manifest requirement and Export
Compliance/encryption declaration.

It is a REPORT tool, not a gate that blocks anything. The human CTO (Opus) is still the one who
reads the output and decides go or no-go before merge/dispatch, exactly as the dispatch that
created this skill specified.

## When to use

- Before dispatching an `ios-depot.yml` workflow_dispatch run that is headed for actual App
  Store submission (not just an internal TestFlight build for Mark's review or a device smoke
  test).
- Before promoting a build to the 75-tester external pool (iHEARtest) or any equivalent
  external-tester rollout on another app.
- Right after an Apple rejection lands, to map the cited guideline number back to the full
  checklist section and the app's own risk-profile note.
- When scaffolding a NEW fleet app (alongside `scaffolder` / `app-factory`), to plan its
  App Store metadata and privacy posture from day one instead of retrofitting it before the
  first submission.

## Run

```
node skills/apple-preflight/apple-preflight.mjs --list
node skills/apple-preflight/apple-preflight.mjs --app companion
node skills/apple-preflight/apple-preflight.mjs --app flatstick --out /tmp/flatstick-preflight.md
node skills/apple-preflight/apple-preflight.mjs --app <new-app-id> --tags subscription,ai
```

`--list` prints the fleet risk-profile registry (below) as a table, plus whether the source
plugin was found this session. `--app <id>` prints the full report: the app's bundle id and
risk-profile note, then every applicable checklist section in full. `--out <path>` writes the
report to a file instead of stdout. `--tags a,b,c` runs an ad hoc preflight for an app that is
not yet in the registry (a brand new app, or overriding the registry's tag set for one run);
known tags are `kids`, `health`, `ai`, `subscription`, `social` (see Checklist tags below).

Dependency-free Node, no network calls. Every report is deterministic given the same inputs and
the same installed-plugin state.

## Where the checklist content comes from

This skill does not vendor a copy of Apple's guideline text into this repo. It reads it LIVE,
at run time, from the installed `capacitor-apple-review-preflight` Claude Code plugin
(marketplace `capgo-skills`, source `truongduy2611/app-store-preflight-skills`), which is
already available in this fleet's plugin marketplaces. `apple-preflight.mjs` searches a few
candidate install locations (the known default, `$APPLE_PREFLIGHT_CAPGO_DIR` override, and a
walk of any `~/.claude/plugins/marketplaces/*/skills/capacitor-apple-review-preflight`
directory) and reads the matching checklist file verbatim when found, citing the exact file
path it read from.

If that plugin is not installed in the current session (a different sandbox, a stripped-down
agent), the script falls back to a condensed summary that still cites a real Apple guideline
number for every line (drawn from Apple's own public guideline index,
developer.apple.com/app-store/review/guidelines, and from the plugin's checklists as read
during this skill's own build session). The report always states which source it used for each
section, live read or fallback summary, so nothing is silently guessed. Nothing in either path
is invented; when a guideline's exact current wording matters (drafting reviewer-response
copy, for example), read the live plugin file or Apple's page directly rather than trusting the
condensed fallback bullet.

Note: quoted guideline text from the live plugin files may contain em dashes (the upstream
source's own formatting); that is intentional verbatim quoting of a third-party checklist, not
this skill's own authored copy, and is not a violation of the fleet's no-em-dash rule for
published copy.

## Checklist tags

| Tag | Checklist | Applies when |
|---|---|---|
| `all_apps` (always) | All Apps (Universal Guidelines) | Every app, every submission. |
| `privacy_manifest` (always) | Privacy Manifest (`PrivacyInfo.xcprivacy`) | Every app, every submission, Spring 2024 requirement. |
| (fleet-authored, always) | Export Compliance / Encryption Declaration | Every app; not part of the capgo plugin, sourced from Apple's Export Compliance docs and the fleet's own iHEARtest/PlantID history. |
| `kids` | Kids Category Apps | App is in, or targets, the Kids Category (COPPA). |
| `health` | Health, Fitness and Medical Apps | HealthKit integration, medical/health claims, dosage or diagnostic-adjacent content. |
| `ai` | AI-Powered / Generative AI Apps | Any LLM/generative-AI feature (chat, vision, recognition, recommendation). |
| `subscription` | Subscriptions and In-App Purchase | Any RevenueCat/StoreKit paywall, subscription, or IAP. |
| `social` | Social / User-Generated Content Apps | Any feed, messaging, or UGC surface with moderation/report/block requirements. |

## Per-app risk profile (the fleet's 9 apps at time of writing)

This table is also the `APPS` registry inside `apple-preflight.mjs`; keep them in sync when an
app's risk profile changes (new paywall, new AI feature, new social surface).

| App | Tags applied | Why |
|---|---|---|
| **FourVault** | `kids` | Kids trading-card app; COPPA + verifiable parental consent, no loot boxes, no third-party analytics on kid screens are already hard rules in its own CLAUDE.md, `kids.md` is a direct match. |
| **MedReview** | `health`, `ai` | Vertex AI Gemini chat (educational medication content) triggers `ai_apps.md`; medication/dosage content triggers `health_fitness.md` 1.4.1/1.4.2. PHI/BAA ring app; V1 is web-only (Shopify-embedded), so this preflight is not actionable until the V1.1 Capacitor wrap (Day 22-30) actually reaches an App Store submission. This tool never touches PHI, it only inspects App Store metadata/checklist coverage. |
| **OTCHealth Companion** | `health`, `ai`, `subscription`, `social` | Visual/voice AI assistant (Gemini vision) = `ai_apps.md`; five-tier RevenueCat paywall = `subscription_iap.md`; family photo/video feed = `social_ugc.md`; health-adjacent framing ("point the camera at a pill", scam/health guidance) = `health_fitness.md`, answered by the app's own "no medical advice" hard rule. |
| **AWARE Aural Rehab** | `subscription` | RevenueCat `pro` entitlement. Recommendation beyond the base tag set: a light `health_fitness.md` pass given the aural-rehabilitation positioning and the app's own FDA/dementia/cure claims firewall, flagged in the report note. |
| **Flatstick** | `subscription` | RevenueCat organizer Pro + three chat entitlement tiers. Fleet-specific addition (not a capgo checklist line item): review notes should proactively frame the app as scorekeeping among friends (never holding/escrowing money) to preempt a Gaming & Gambling (5.3) miscategorization. |
| **PlantID Care** | `ai`, `subscription` | Vertex Gemini vision recognition = `ai_apps.md`; RevenueCat annual price-test products = `subscription_iap.md`. |
| **iHEARtest** | `subscription` | Per dispatch. Recommendation beyond the base tag set: also run `health_fitness.md`, its own FTC HBNR compliance grep already targets the same 1.4.1 class of finding (no sensor-only diagnostic claims). |
| **InnerEase** | (none yet) | Pre-code as of this writing, no app scaffold exists. Not actionable until Phase 0 lands; when it does, expect `subscription` (RC pro planned) and a General Wellness claims-firewall pass that maps onto `health_fitness.md` 1.4.1. |
| **Fictionary** | (none) | Free and non-commercial, no IAP/subscription, general audience. Baseline (`all_apps` + `privacy_manifest` + encryption) only unless the store listing later opts into the Kids Category. |

## What this is not

- Not an automated blocker. It never fails a CI job or a build dispatch; there is no exit-code
  gate tied to a "you must fix this" outcome. The CTO reads the report and decides.
- Not a substitute for the live App Store Connect submission flow, metadata review, or the
  Mark Moore device-review ritual (iHEARtest). Those stay as they are.
- Not a copy of Apple's guidelines living in this repo. See "Where the checklist content comes
  from" above; this skill reads the plugin live and never bundles a redistribution of it.
