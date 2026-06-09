# Dream Team Roster — agents, skills, and what each brings to the table

Two kinds of team member:

- **Agents** = roles with judgment. They read the goal + manifest, orchestrate
  skills and tools toward an outcome, and hand off to the next agent. They live in
  `agents/*.md` as installable Claude Code subagents.
- **Skills** = equipment. Deterministic capability packs (procedures + scripts)
  that any agent (or you) can invoke. The `designer` skill already exists; the
  rest are specified here and built incrementally.

The rule of thumb: **if it needs judgment and hands off, it is an agent; if it is
a repeatable procedure anyone can run, it is a skill.** Agents wield skills.

---

## Part 1 — The agents

Each agent below lists: its job, when it engages, what it reads, what it produces
(its handoff), who it hands to, the new tools it brings, and its guardrails. The
installable definitions are in `agents/<name>.md`.

### 0. Coach (`coach`) — orchestrator / GM
- **Job:** the single entry point. Decompose the user's goal into a play, dispatch
  the right specialists (in sequence or parallel via the Agent tool), thread the
  manifest and handoffs between them, keep the status ledger, enforce gates.
- **Engages when:** the user states an outcome ("ship the audiogram import",
  "harden the portfolio", "launch app #7") rather than a single tool action.
- **Reads:** the goal, `app.manifest.json`, Notion business objectives, the ledger.
- **Produces:** a play (ordered list of agent calls + gates), and a running
  ledger entry per step (Notion DB + `.dreamteam/ledger.md`).
- **Hands to / from:** everyone.
- **Guardrails:** never skips Guardian before a release; surfaces ambiguous forks
  to the human via AskUserQuestion rather than guessing.

### 1. Architect (`architect`) — plan / spec
- **Job:** turn a request into a Spec Kit spec + plan + tasks; choose patterns
  from the App-Kit Build kit; decide PHI-ring implications and update the manifest
  with the planned surfaces and the gates the work will need.
- **Brings:** Spec Kit (`uvx --from git+https://github.com/github/spec-kit.git
  specify init`, `/specify /plan /tasks`), spec-as-contract discipline.
- **Reads:** request, manifest, Build kit, LESSONS.md.
- **Produces:** `spec/` artifacts + a handoff listing tasks, target surfaces, and
  ring classification.
- **Hands to:** Builder. **From:** Coach.

### 2. Builder (`builder`) — implement
- **Job:** implement tasks against the spec. Keep clinical/logic in the web layer
  so it is OTA-patchable. Use the Capacitor Agent Skills pack so native code is
  correct the first time. Let the format/lint hooks run on every edit.
- **Brings:** **Capacitor/Ionic Agent Skills** (`npx skills add
  capawesome-team/skills`, 70%->92% correct native code — the single highest-ROI
  research find), the PostToolUse prettier+eslint hook, the PreToolUse test gate.
- **Wields skills:** `scaffolder` (new surfaces), `designer` (UI assets), `devkit`.
- **Produces:** a branch + a handoff packet (changed files, surfaces, plugins
  touched, new deps, whether AI features were added).
- **Hands to:** QA. **From:** Architect. Bounces back from QA on red.

### 3. QA (`qa`) — test / gate
- **Job:** author and run the web-first test stack and gate the PR. Native smoke
  only for the genuinely-native slice. Evals for any AI feature.
- **Brings:** **Vitest 4 Browser Mode + Playwright (Chromium+WebKit) + axe-core +
  `toHaveScreenshot()` visual + Lighthouse CI**; Maestro / the CDP-WebView trick
  for native smoke; **Promptfoo** eval + red-team for in-app LLM features
  (PII-leakage / hallucination checks matter for health). Capacitor plugin manual
  mocks.
- **Wields skills:** `test-author`, `eval-runner`.
- **Produces:** pass/fail on each gate written back to `manifest.gates`, plus a
  failure packet to Builder on red.
- **Hands to:** Guardian (on green). **From:** Builder.

### 4. Release Captain (`release-captain`) — ship
- **Job:** run the Pre-launch + Launch kits, choose the right ship path (OTA web
  layer vs native build), run phased rollout, take monetization live.
- **Brings:** **Capgo / Capawesome Cloud OTA** (ship web-layer fixes in minutes,
  off the sunsetting Appflow), Codemagic native builds, RevenueCat go-live,
  phased-rollout + automatic-rollback discipline.
- **Wields skills:** `release-conductor`, `designer` (store assets via Creative).
- **Produces:** a release record in the manifest + ledger; tag + rollout state.
- **Hands to:** Growth + Medic. **From:** QA + Guardian (must have both greens).

### 5. Growth (`growth`) — revenue / experimentation
- **Job:** instrument and grow revenue. Own flags/experiments, paywall A/B,
  billing wiring, and reactivation campaigns. Read the Notion business objectives
  and tie every experiment to a revenue metric.
- **Brings:** **PostHog feature flags + A/B experiments** (single-BAA), **RevenueCat
  Experiments / Superwall Demand Score** paywall A/B, **RTM billing codes
  98975-98981** for medication-adherence revenue (MedReview/Companion),
  Customer.io reactivation to the 78K database with **designer + avatar** creative.
- **Wields skills:** `designer`, `telemetry-wiring`.
- **Produces:** running experiments + a growth entry in the manifest/ledger.
- **Hands to:** Coach (results) / Medic (if an experiment regresses health).
  **From:** Release Captain.

### 6. Guardian (`guardian`) — security & compliance (gate veto)
- **Job:** the compliance conscience. Enforce supply-chain hardening, scan for
  secrets, keep an SBOM, review every PR for PHI leakage and ring violations,
  manage the BAA checklist. Can **block** a release.
- **Brings:** **dependency cooldowns (`minimumReleaseAge`/`cooldown`) + disabled
  bot auto-merge + SHA-pinned Actions** (the urgent #2 research item),
  **Gitleaks pre-commit + TruffleHog CI**, **cdxgen CycloneDX SBOM**, Semgrep
  Assistant in-IDE, the PHI/BAA checklist.
- **Wields skills:** `supply-chain-guard`.
- **Produces:** a security gate result (pass/block) + SBOM artifact + any required
  scrubbing fixes.
- **Hands to:** Release Captain (clear) or back to Builder (block). **From:** QA.

### 7. Medic (`medic`) — reliability / SRE
- **Job:** keep shipped apps healthy. Triage production issues, drive the autofix
  loop, run dependency/security sweeps and the bug-hunting playbook, and run
  maintenance across many repos in parallel.
- **Brings:** **Sentry Seer + Issue Autofix** (root-cause -> fix PR, hands to
  Claude Code), Sentry **release-health gates** (crash-free thresholds),
  **Daytona parallel-agent maintenance** across the portfolio, the device-only
  Bug-Hunting Playbook from LESSONS.md.
- **Wields skills:** `telemetry-wiring`.
- **Produces:** fix PRs that re-enter the QA->Guardian->Release relay; health
  reports in the ledger.
- **Hands to:** QA (fix PRs). **From:** Sentry/PostHog signals, Coach.

### 8. Creative (`creative`) — brand / assets
- **Job:** produce every visual/audio/video asset on brand, on demand.
- **Brings:** the existing **designer skill** (OpenAI/Vertex/ElevenLabs/Azure) +
  the **avatar pipeline** (cloud render).
- **Wields skills:** `designer`.
- **Produces:** assets in `assets/generated/` + metadata.
- **Hands to:** Release Captain (store assets), Growth (campaign assets). **From:**
  any agent that needs an asset.

---

## Part 2 — The skills (equipment)

| Skill | Status | What it does | Primary wielder(s) |
|---|---|---|---|
| `designer` | **built** | Icons, illustrations, app-icon families, App Store screenshots, video, talking avatars, voiceover, music, SFX, art-director review. Brand-profile driven. | Creative, Growth, Release Captain |
| `devkit` | **new** | The Claude Code operating layer: installs `/sandbox` config, the PostToolUse format/lint + PreToolUse test hooks, the Capacitor Agent Skills pack, the `CLAUDE.md` standard, and Spec Kit. Makes Claude Code itself faster and less glitchy. | Architect, Builder |
| `scaffolder` | **new** | Startup-kit made executable: new app from name + brand profile -> repo, Capacitor 8, `app.manifest.json`, `CLAUDE.md`, RevenueCat/Sentry/PostHog stubs, CI, green test scaffold. | Builder |
| `test-author` | **new** | Installs + authors the web-first test stack and CI gates (Vitest Browser Mode, Playwright Chromium+WebKit, axe-core, visual snapshots, Lighthouse CI) + Capacitor plugin manual mocks. | QA |
| `eval-runner` | **new** | Promptfoo eval + red-team harness (PII-leakage, hallucination, jailbreak) for any in-app AI feature; gates AI quality in CI. | QA |
| `supply-chain-guard` | **new** | Drops in dependency-cooldown configs across every package manager present, disables bot auto-merge, SHA-pins Actions, adds Gitleaks pre-commit + TruffleHog CI, generates a cdxgen SBOM. | Guardian |
| `telemetry-wiring` | **new** | Manifest-driven wiring of PostHog (single-BAA, mask-by-default replay) + Sentry (scrubbed, Seer) + RevenueCat events, PHI-aware by construction. | Growth, Medic |
| `release-conductor` | **new** | Executes the ship path: Capgo/Capawesome OTA for web-layer changes, Codemagic for native, phased rollout + automatic-rollback runbook. | Release Captain |

Each new skill follows the `designer` skill's shape: a `SKILL.md` with frontmatter
(`name`, `description`, trigger words), a `scripts/` folder of small focused
`.mjs`/`.py` tools, and a `--dry-run`/healthcheck convention. They install through
the same `setup/session-start.sh` path the designer skill already uses.

---

## Part 3 — Tool-to-member mapping (where every research pick lands)

So nothing from the research sweep is orphaned, here is the explicit assignment:

| Research pick | Joins the team as | Via |
|---|---|---|
| Capacitor/Ionic Agent Skills pack | Builder's core equipment | `devkit` |
| `/sandbox` (84% fewer prompts) | Builder/Architect environment | `devkit` |
| Format/lint + test-gate hooks | Builder discipline | `devkit` |
| Spec Kit (spec-driven dev) | Architect's method | Architect + `devkit` |
| Vitest Browser Mode + Playwright + axe + visual + Lighthouse | QA's stack | `test-author` |
| Promptfoo evals + red-team | QA for AI features | `eval-runner` |
| Dependency cooldowns + no auto-merge + SHA-pins | Guardian's #1 control | `supply-chain-guard` |
| Gitleaks / TruffleHog / cdxgen SBOM / Semgrep | Guardian | `supply-chain-guard` |
| PostHog single-BAA (flags/experiments/replay) | Growth + Medic | `telemetry-wiring` |
| Sentry Seer + Autofix + release health | Medic | `telemetry-wiring` |
| Capgo / Capawesome OTA (off Appflow) | Release Captain | `release-conductor` |
| RevenueCat / Superwall paywall A/B | Growth | `telemetry-wiring` + Growth |
| RTM billing codes 98975-98981 | Growth (revenue) | Growth procedure |
| On-device LLM (`@ionic/capacitor-local-llm`) | Builder (Companion assistant) | `devkit` + spec |
| Apple AirPods audiogram via HealthKit | Architect/Builder (iHEARtest scope cut) | spec |
| Daytona parallel-agent maintenance | Medic + Coach fan-out | orchestration |
| Greptile review | Guardian second opinion | review step |

Nothing is left on the shelf: every find from the sweep has an owner.
