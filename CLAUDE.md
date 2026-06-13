# CLAUDE.md — operating facts for this repo and the OTCHealth portfolio

Read this first. It is the standing context every Claude Code session should
assume unless the user says otherwise.

## Environment / host facts (do not suggest workflows that violate these)
- **Operator host is a Windows PC. There is NO Mac.** Never propose a local macOS
  or local Xcode workflow.
- **iOS builds and App Store submission are cloud-only.** You cannot `xcodebuild`
  or code-sign iOS on Windows, so every iOS build/sign/submit runs on a cloud
  macOS machine: **Depot macOS runners (GitHub Actions) — PRIMARY as of
  2026-06-13**, spending the $5k Depot grant instead of Codemagic cash.
  **Codemagic is deprecated** and cut over per app once a green Depot iOS build
  is proven (the personal CI mirror GBGolfMatt/aware-aural-rehab-ci is affected
  too). Signing assets (App Store Connect API key, distribution cert + profile)
  live in the Notion API Tokens & Credentials vault and load as GitHub Actions
  secrets; fastlane match is the preferred manager. Monitor Depot grant burn
  (macOS minutes cost ~10x Linux). Android builds run on Linux (Depot ubuntu), so
  cloud CI handles them trivially.
- **We operate cloud-native.** Work happens through Claude Code on the web; the
  session sandbox is Linux in the cloud. `setup/session-start.sh` and all tooling
  run there, not on the Windows PC. If local shell is ever needed, use WSL2.
- **Test device: iPhone 16 Pro (the operator's own phone).** Use it via
  **TestFlight** for the device-only QA that the cloud cannot do (AVAudioSession /
  AirPods / Web Audio bugs, see `app-kit/LESSONS.md`). It runs **Apple
  Intelligence**, so it is also the dogfood device for on-device LLM features
  (Apple Foundation Models / Companion assistant) and the HealthKit AirPods
  audiogram idea for iHEARtest.

## Standing rules (compliance + process)
- **PHI ring boundary.** Designer/creative tooling and any non-BAA service operate
  in the **non-PHI ring only**. Never point them at `otchealth-medreview-prod` or
  any PHI project. No PHI in generated assets, prompts, metadata, analytics,
  sandboxes, or AI tool context.
- **Branch discipline.** Develop on the designated feature branch; never push to a
  different branch without explicit permission. Open PRs as **draft**.
- **Content rule.** No em dashes or en dashes in any *published app copy* (use
  commas, periods, line breaks). Internal docs like this one are exempt.
- **Secrets.** Never paste secrets into chat. Tokens provided in chat are saved to
  the Notion **API Tokens & Credentials** vault and flagged for rotation.
- **Secret store (operator decision, 2026-06-08).** Per operator direction
  (seamless > separation), ALL app secrets, including MedReview (PHI) and FourVault
  (separate entity), are consolidated into the single `otchealth-shared-prod`
  Secret Manager and hydrate into every session. This intentionally drops the
  PHI-ring / cross-entity *storage* separation; the operator accepted the HIPAA /
  entity co-mingling tradeoff. NOTE: this changes secret *storage* only. The
  content rules still hold, no PHI in generated assets, prompts, analytics, or AI
  tool context, and the designer/creative path stays non-PHI.

## Tooling decisions (the durable calls, with the trigger that changes them)
- **Automation engine: n8n is the production engine; Make.com is a non-PHI sandbox
  only.** Make will not sign a BAA on any tier and its per-module pricing is the
  worst case for our proxy-heavy workflows, so it never runs PHI and we do not
  migrate working flows to it. Spend the Make grant only on net-new, low-frequency,
  non-PHI automation.
- **n8n self-host is LIVE (DONE 2026-06-11, COO-21).** The production engine is the
  Azure self-host at **`https://automation.otchealth.app`** (VM `n8n-prod`,
  `otchealth-automation-rg`); 40 workflows imported, ~28 active (Shopify, Helen,
  Twilio, iHEARtest, AWARE, INND signup, the COO Outlook nervous system). n8n
  **Cloud** (`otchealth.app.n8n.cloud`) is billing-locked / decommissioned, kept
  read-only for final verification then cancelled. Self-hosting was the compliant
  path (Cloud gives no BAA; PHI flows WF02/WF03 may run ONLY on the self-host).
  ALWAYS target the self-host. Two things still point at Cloud and need repointing:
  the n8n **MCP connection** (set its base URL to `https://automation.otchealth.app`
  + the self-host API key from the Notion vault "n8n Self-Host") and the deployed
  `otchealth-mcp-server` `.env` (`N8N_BASE_URL`). `setup/session-start.sh` defaults
  `N8N_BASE_URL` to the self-host so CLI/skill use never hits the dead Cloud host.
- **Build/CI vs sandboxes: do not double-spend grants.** Use **Depot** ($5k) for
  build/CI acceleration (GitHub Actions runners at ~half cost + faster, Docker
  build cache, and **macOS runners — now the PRIMARY iOS build path** (see
  Environment facts above), plus optional GPU runners). Use **Daytona** ($10k) for
  parallel-agent sandboxes. They overlap on "agent sandboxes" so keep them in their
  lanes.

## Where things live
- `dream-team/` - the coordinated agent + skill architecture (roster, interconnect,
  installable agent definitions, app manifest schema).
- `app-kit/` - the portable app lifecycle kits (startup -> maintenance + LESSONS).
- `skills/designer/` - the creative skill (icons, video, avatars, voice, music).
- `avatar-pipeline/` - the cloud avatar render pipeline.
- `setup/session-start.sh` - the installer that hydrates skills + credentials.

### iOS build runner correction (2026-06-13)
- Use the **`depot-macos-26`** runner (Xcode 26 / iOS 26 SDK). `depot-macos-latest` = macOS 15 / Xcode 16.4, which Apple REJECTS (altool 409: must be built with the iOS 26 SDK). Depot iOS is PROVEN GREEN end-to-end — iHEARtest 1.5.15 / CFBundleVersion 43 shipped to TestFlight; cut Codemagic billing. Build numbers follow **ASC CFBundleVersion** (the Codemagic build counter is retired). Full Hyperagent-session sync: see `otchealth-cto/CLAUDE.md`.
