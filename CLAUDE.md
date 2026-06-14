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
  - **`dream-team/FLEET-TOOLKIT-REFERENCE.md` = the master, tool-level index** of EVERY
    capability (MCP connectors + their tools, the custom gateway's 41 tools, the 23 skills,
    the 13 plugins, the 19 agents) + the routing policy. Read it first to know the toolkit.
- `app-kit/` - the portable app lifecycle kits (startup -> maintenance + LESSONS).
- `skills/designer/` - the creative skill (icons, video, avatars, voice, music).
- `avatar-pipeline/` - the cloud avatar render pipeline.
- `setup/session-start.sh` - the installer that hydrates skills + credentials.

### iOS build runner correction (2026-06-13)
- Use the **`depot-macos-26`** runner (Xcode 26 / iOS 26 SDK). `depot-macos-latest` = macOS 15 / Xcode 16.4, which Apple REJECTS (altool 409: must be built with the iOS 26 SDK). Depot iOS is PROVEN GREEN end-to-end — iHEARtest 1.5.15 / CFBundleVersion 43 shipped to TestFlight; cut Codemagic billing. Build numbers follow **ASC CFBundleVersion** (the Codemagic build counter is retired). Full Hyperagent-session sync: see `otchealth-cto/CLAUDE.md`.

### Cloud direction: GCP -> Azure migration (Matt directive, 2026-06-14)
- **We are moving most GCP services to Microsoft Azure** (Azure credits are the funded
  lane). Default new infra/compute to Azure. The secret store stays `otchealth-shared-prod`
  GCP Secret Manager for now (it hydrates every session); compute moves, the secret store
  follows later if at all.
- **Already staged at the credential level**: the vault now holds a full Azure suite —
  `azure-openai-key` / `azure-openai-endpoint` / image+vision+video deployments,
  `azure-speech-key` / `azure-speech-region`, and an `azure-sp-*` Contributor service
  principal + `azure-subscription-id`. The designer skill's credentials template already
  carries the `AZURE_OPENAI_*` / `AZURE_SPEECH_*` slots. So Azure OpenAI + Azure Speech
  are the intended creative/inference path on Azure.
- **LEGAL WALL (flag-and-hold, do NOT migrate silently):** MedReview's PHI workloads run
  under the **GCP BAA** (Vertex AI Gemini 2.5 Pro, Cloud Run, Cloud Vision); Companion uses
  Vertex Gemini Live + Firebase. Moving any PHI workload to Azure REQUIRES an Azure BAA +
  Azure OpenAI (HIPAA-eligible) in place FIRST. Surface and wait for Matt + counsel; the CTO
  does not move the PHI ring off its BAA on its own. Non-PHI apps migrate freely.

### Secrets + n8n base URL reconciliation (2026-06-14)
- **Secret state corrected:** `otchealth-shared-prod` holds **40 secrets** and they hydrate
  cleanly via the claude-driver SA (no gcloud binary needed; the SA has create + addVersion +
  access). The older "secrets never promoted / values missing" note in
  `setup/CLAUDE-CODE-SETTINGS.md` was STALE — `openai-api-key`, `elevenlabs-api-key`,
  `depot-token`, `posthog-personal-api-key`, `n8n-api-key`, and the full Azure suite are all
  PRESENT. Only optional `recraft-api-key` is absent.
- **Fixed:** the `n8n-base-url` secret still pointed at the dead Cloud host
  (`otchealth.app.n8n.cloud`); set a new version to the self-host
  `https://automation.otchealth.app` (the canonical target). It was overriding session-start's
  default for anything reading the base URL from Secret Manager.
- **Plugins:** 9 Claude Code dev/security plugins are installed + wired fleet-wide (see
  `dream-team/PLUGIN-LAUNCH-PLAN.md`).

### Apple push + Sign-in keys (2026-06-14) — ONE push key for the whole fleet
- **APNs push is portfolio-shared.** There is ONE team-scoped (all-topics) APNs key for every
  app: Secret Manager **`apple-apns-key-p8`** (Key ID `DC8MP3LHX3`, Apple team `465UF9H72S`,
  Production). When ANY app adds push, REUSE this secret and set the APNs topic to that app's
  bundle id (`app.flatstick.ios`, `com.innerscope.aware`, `com.otchealth.companion`, ...). Do
  NOT mint a per-app push key. Token-based APNs (ES256 provider JWT, kid=DC8MP3LHX3).
- **Sign in with Apple (Flatstick):** Secret Manager **`flatstick-apple-signin-key-p8`**
  (Key ID `ZYM7MW4JGS`, team `465UF9H72S`, client `app.flatstick.ios`). SiwA keys are team-level
  and reusable if another app needs SiwA later.
- Both .p8 are backend-only (never in an IPA or a repo); fetch via
  `node setup/get-secret.mjs <id> <outfile>`. Backup copies + metadata also in the Notion
  "API Tokens & Credentials" vault; both flagged for rotation.
