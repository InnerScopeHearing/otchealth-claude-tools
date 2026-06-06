# OTCHealth App-Kit — the master kit for building better apps, faster

The single, portable system every OTCHealth app uses across its entire life,
from first commit to ongoing maintenance. Build it once here, install it
everywhere (the same way the designer skill and avatar pipeline install via
`setup/session-start.sh`), and apply it across the whole portfolio in parallel
with the Daytona + Claude + Greptile loop.

## Why this exists
Every app so far reinvented its own process:
- **iHEARtest:** a 19-chapter engineering manual + audits + launch runbooks + Maestro QA.
- **MedReview:** a 5-part playbook + day-21 launch runbook + sprint plans.
- **AWARE:** a roadmap + synthetic focus-group QA (persona reviews to a fix list).
- **Companion:** per-package CLAUDE.md + build roadmap + sprint-0 checklist.
- **InnerEase:** just a CLAUDE.md (early).

That is a lot of duplicated effort and a lot of knowledge that does not travel.
The App-Kit distills the proven parts of all of them into one place so the next
app starts with everything the last app learned, and so a fix or standard can be
rolled to all apps at once.

## The kits (the app lifecycle)
| Kit | File | Covers |
|---|---|---|
| 0. Startup | `00-startup-kit.md` | Scaffold a new app from zero: repo, Capacitor, brand, accounts, CLAUDE.md, IAP/Sentry/i18n wiring |
| 1. Build | `10-build-kit.md` | Architecture standards, shared packages, conventions, the generalized engineering manual |
| 2. Testing | `20-testing-kit.md` | Vitest unit + Maestro E2E + persona focus-group QA + build-review checklist |
| 3. Pre-launch | `30-prelaunch-kit.md` | App Store Connect, signing, TestFlight, store listings, privacy, compliance, pre-flight checklist |
| 4. Launch | `40-launch-kit.md` | Launch-day runbook, phased rollout, OTA / Live Updates, monetization go-live |
| 5. Maintenance | `50-maintenance-kit.md` | Bug-hunting playbook, Sentry triage, dependency/security sweeps, parallel-agent maintenance |
| 6. Marketing | `60-marketing-kit.md` | Store screenshots and assets (designer skill), ASO, marketing assets, reactivation hooks |
| Lessons | `LESSONS.md` | Problems we already hit, written as a "do not repeat these" pre-flight list |

## How an app uses the kit
1. **New app:** run the Startup kit. It scaffolds a Capacitor app with brand,
   IAP, Sentry, i18n, CLAUDE.md, CI, and tests already wired, from the common base.
2. **During build:** the Build and Testing kits are the standards; tests gate every PR.
3. **Shipping:** Pre-launch then Launch kits run the same checklists every time.
4. **After launch:** the Maintenance kit runs continuously (Sentry triage, sweeps),
   and the Marketing kit produces store and campaign assets.

## How it reaches every app
Two mechanisms, both already in place:
- **Install at session start** (the `session-start.sh` model) so any app session has the kit.
- **Parallel rollout:** one Daytona + Claude pass opens an "adopt the app-kit" PR in
  each repo at once; Greptile reviews each; you merge. The portfolio converges on
  one process in a single sweep.

## App-type matrix (one size does not fit all 14 repos)
- **Capacitor hybrid apps** (iHEARtest, AWARE, Companion-mobile, InnerEase): the full kit.
- **TypeScript services** (medreview-api, companion-backend, fourvault, fictionary): Build, Testing, Pre-launch (web/Cloud Run), Maintenance.
- **Web/commerce** (otchealthmart-shopify, innd-website): Build, Testing-lite, Marketing.

## Status
Foundation scaffolded June 2026. Each kit below starts as a structured skeleton
that points to the proven per-app source to generalize from (cited inline). The
deep content is filled in over successive passes, generalizing iHEARtest's manual,
MedReview's playbook, and AWARE's QA into portable, app-agnostic form.

## Content rule
Anything here that ends up in published app copy: no em dashes or en dashes. Use
commas, periods, or line breaks.
