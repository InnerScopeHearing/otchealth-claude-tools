# OTCHealth Dream Team — one coordinated AI org across the whole stack

This is the integration layer that turns the tools we already built (designer
skill, avatar pipeline, App-Kit, the session-start installer, the Notion vault)
and the tools the deep-research sweep told us to adopt (Capacitor Agent Skills,
`/sandbox`, hooks, Vitest+Playwright+axe, PostHog single-BAA, Capgo OTA,
Promptfoo, Sentry Seer, Spec Kit, dependency cooldowns, Gitleaks/SBOM, on-device
LLM, RTM billing) into a single coordinated team that works **with each other**
and **across every app and service** in the portfolio.

Read this file for the analysis (how it all fits and why it is more efficient).
Read `ROSTER.md` for the agents and skills. Read `INTERCONNECT.md` for the
contracts that wire them together. The `agents/` folder holds the actual,
installable Claude Code subagent definitions.

---

## 1. The problem this solves (where the time goes today)

Today every app is a soloist. The knowledge lives in big per-app manuals
(iHEARtest's 19-chapter manual, MedReview's 5-part playbook, AWARE's QA lists),
and **you are the integration layer.** Each Claude session re-derives context
from scratch, handoffs between "design", "build", "test", "ship", "grow",
"maintain" are implicit and live in your head, and an improvement made in one
app does not travel to the others. The deep-research sweep found 0 automated
tests on four consumer apps, 0 PostHog/flags/OTA anywhere, and no supply-chain
hardening. Those are not app problems. They are **missing-team-member** problems:
nobody owns testing, nobody owns growth instrumentation, nobody owns supply chain.

## 2. The dream-team thesis

Replace one overloaded generalist (and one overloaded founder) with a **small
team of sharp specialists that share situational awareness and hand work to each
other through standard contracts.** Three ideas do the heavy lifting:

1. **A shared source of truth per app** (`app.manifest.json`) so no agent ever
   re-derives "what is this app, what ring is it in, what is wired, what passed."
   This is the locker-room whiteboard the whole team reads before every play.
2. **Standard handoffs** so when the Builder finishes, the QA agent receives a
   precise "here is what changed and what to test" packet instead of guessing.
3. **One installer + one parallel rollout** so the team lands in every app
   session automatically, and any upgrade to the team reaches the whole
   portfolio in a single Daytona sweep.

The human moves from *operator* (doing every handoff by hand) to *coach*
(stating the goal and approving the gates).

## 3. The roster at a glance

| # | Agent | Lifecycle role | Owns / new tools it brings to the team |
|---|---|---|---|
| 0 | **Coach** | Orchestrator / GM | Reads the goal + manifest, runs the play, dispatches specialists, owns the status ledger and the gates |
| 1 | **Architect** | Plan / spec | Spec Kit (`/specify /plan /tasks`), App-Kit build standards, PHI-ring decisions |
| 2 | **Builder** | Implement | **Capacitor Agent Skills pack** (70%->92% correct native code), the format/lint hooks, web-layer-first for OTA |
| 3 | **QA** | Test / gate | **Vitest 4 Browser Mode + Playwright + axe + visual + Lighthouse CI**, Maestro/CDP smoke, **Promptfoo** for AI features |
| 4 | **Release Captain** | Ship | **Capgo / Capawesome OTA**, Codemagic native builds, phased rollout, RevenueCat go-live |
| 5 | **Growth** | Revenue | **PostHog flags/experiments**, RevenueCat/Superwall paywall A/B, **RTM billing codes 98975-98981**, Customer.io reactivation (designer + avatar assets) |
| 6 | **Guardian** | Security / compliance | **Dependency cooldowns + no auto-merge + SHA-pinned Actions**, Gitleaks/TruffleHog, cdxgen SBOM, Semgrep, PHI/BAA enforcement (gate veto) |
| 7 | **Medic** | Reliability / SRE | **Sentry Seer autofix loop**, release-health gates, dependency sweeps, **Daytona parallel maintenance**, bug-hunting playbook |
| 8 | **Creative** | Brand / assets | The existing **designer skill** + avatar pipeline, on demand for Release Captain and Growth |

Each agent is backed by **skills** (its equipment) and the **tech stack** (its
infrastructure). The roster, the skills, and the exact tool mapping are in
`ROSTER.md`.

## 4. How the pieces interconnect (the architecture)

```
                                  YOU (coach the team, approve gates)
                                          |
                                   ┌──────────────┐
                                   │    COACH     │  reads goal + app.manifest.json
                                   │ orchestrator │  writes status ledger (Notion + local)
                                   └──────┬───────┘
            dispatch (Agent tool)         │            standard handoff packets
   ┌───────────┬───────────┬─────────────┼─────────────┬───────────┬───────────┐
   ▼           ▼           ▼             ▼             ▼           ▼           ▼
ARCHITECT → BUILDER  →    QA      →  RELEASE CAP. →  GROWTH     GUARDIAN    MEDIC
 (spec)    (impl)      (gates)       (OTA/ship)    (revenue)  (sec/PHI)  (observe)
   │          │           │             │             │           │           │
   └── skills: scaffolder · devkit · designer · test-author · eval-runner ·    │
       release-conductor · telemetry-wiring · supply-chain-guard               │
                                          │                                     │
        ┌─────────────────────────────────┴─────────────────────────────────┐  │
        │   SHARED NERVOUS SYSTEM (MCP + contracts)                          │  │
        │   • app.manifest.json  (per-app source of truth, every agent r/w)  │◄─┘
        │   • handoff.json       (from→to packet between agents)             │
        │   • Notion MCP         (API vault, business objectives, run log)   │
        │   • GitHub MCP         (PRs, CI, reviews, webhook events)          │
        └───────────────────────────────────────────────────────────────────┘
                                          │
        TECH STACK (the infrastructure the team runs on)
   OpenAI · Vertex · ElevenLabs · Azure · PostHog · Sentry · RevenueCat ·
   Customer.io · Capgo/Capawesome · Codemagic · Daytona · Greptile · Replicate ·
   Cloudflare R2 · MongoDB · GitHub Actions · Notion
```

The connective tissue is the bottom two boxes. **The manifest is what makes them
a team and not eight strangers**: every agent opens it on entry, acts on its
slice, and writes back what it changed, so the next agent starts informed. Full
schemas and the handoff format are in `INTERCONNECT.md`.

## 5. The team in motion (worked plays)

**Play A — ship a feature (the relay).**
Coach reads the goal + manifest -> **Architect** writes a Spec Kit spec/plan/tasks
and flags ring implications -> **Builder** implements with the Capacitor Agent
Skills pack, hooks auto-format/lint each edit, clinical logic stays web-layer ->
**QA** runs Vitest+Playwright+axe+visual+Lighthouse and (if the feature uses an
LLM) Promptfoo, and either gates green or hands failures back to Builder ->
**Guardian** checks PHI leakage + dependency diff + secrets -> **Release Captain**
ships the web layer via Capgo OTA (no App Review) or cuts a Codemagic native
build for phased rollout -> **Growth** wraps it in a PostHog experiment ->
**Medic** watches release health. The human approved two gates; the team did the
eleven handoffs.

**Play B — a crash heals itself.**
Sentry Seer flags a root cause -> **Medic** picks it up (it meets the >=10 events
/ <14 days / fixability bar), reproduces, opens a fix PR -> re-enters the **QA**
gate -> **Guardian** clears it -> **Release Captain** OTA-ships the patch. The
human reviews one PR.

**Play C — launch a brand-new app.**
Coach -> **scaffolder** skill builds the repo, Capacitor 8, manifest, CLAUDE.md,
RevenueCat/Sentry/PostHog stubs, CI, and a green test scaffold -> **devkit** skill
installs `/sandbox`, the hooks, the Capacitor Agent Skills pack, and Spec Kit ->
the full team is live on day one, so app #7 starts with everything apps #1-6
learned.

**Play D — harden the whole portfolio at once.**
Coach fans **Guardian** (the `supply-chain-guard` skill) across all 14 repos in
parallel via Daytona -> one "adopt cooldowns + Gitleaks + SBOM + SHA-pins" PR per
repo -> Greptile + Guardian review each -> you merge the sweep. The single
highest-leverage supply-chain control lands everywhere in one pass.

## 6. Why this is measurably more efficient

- **No re-derivation.** The manifest replaces the "let me read the whole repo to
  understand it" step that starts most sessions today.
- **Explicit handoffs.** The receiver gets a packet, not a mystery. Less rework
  from misunderstood context.
- **Specialists beat a generalist.** Eight small, focused agents each carry a
  tight prompt and the right tools; that outperforms one agent juggling
  everything (and dovetails with Claude Code subagents + worktree isolation).
- **Quality is automatic, not heroic.** Gates (tests, axe, Lighthouse,
  cooldowns, evals) are owned by agents and enforced by hooks, so bugs are caught
  from day one instead of in a 12-PR audit saga.
- **Improvements are portfolio-wide.** Fix or upgrade a team member once here;
  the installer + Daytona rollout carry it to every app.
- **You become the coach.** Your time goes to goals and approvals, not to being
  the glue between tools.

## 7. Adoption order (incremental, each step useful alone)

1. **Land the contracts** — add `app.manifest.json` + the handoff format to this
   repo and one pilot app (iHEARtest). Nothing else has to change for these to
   start paying off.
2. **Install the `devkit` + Capacitor Agent Skills** (Builder's equipment) and
   the `supply-chain-guard` skill (Guardian) — both are near-zero-effort, high-
   protection wins from the research sweep.
3. **Stand up QA's web-first stack** on the pilot app, then template it.
4. **Wire telemetry** (PostHog single-BAA + Sentry scrubbed) via the
   `telemetry-wiring` skill so Growth and Medic have data to act on.
5. **Turn on the relay** — let Coach orchestrate Architect->Builder->QA->Release
   on one real feature.
6. **Fan out** — Daytona parallel rollout of the team across the portfolio.

## 8. Guardrails baked into the team

- **Guardian holds a veto** on the release gate; PHI-ring boundaries and the BAA
  checklist are enforced, not advisory. PHI never enters Sentry/PostHog/Daytona
  prompts unmasked.
- **Non-PHI ring only** for the creative/designer paths, exactly as today.
- **Published app copy** produced by any agent carries no em or en dashes (use
  commas, periods, line breaks). Internal docs like this one are exempt.
- Every agent is **manifest-aware**: it refuses to act outside the ring the
  manifest declares for the app.
