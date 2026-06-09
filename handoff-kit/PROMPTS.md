# Handoff prompts — copy/paste to migrate any session

Moving an old, frozen Claude Code session onto a fresh, fully-loaded one is always
three steps: **capture -> merge -> kickoff.**

1. **Capture** — paste the *capture* prompt into the OLD session (it holds the
   conversation). It applies the kit and writes `HANDOFF.md`, then opens a PR.
2. **Merge** that PR so `HANDOFF.md` + the auto-load hook land on `main`.
3. **Kickoff** — open a NEW session and paste the matching *kickoff* prompt
   (app or commerce). It reads the handoff, confirms the toolkit, audits against
   the current stack, and continues.

Swap `<APP NAME>` where shown. The capture prompt is identical for every repo.

---

## 1. Capture — paste into the OLD session

> Do all of this in this session, then push:
>
> 1. Push anything uncommitted first.
> 2. Refresh the toolkit and apply the handoff kit:
>    `rm -rf /tmp/octools 2>/dev/null && git clone --depth 1 https://github.com/InnerScopeHearing/otchealth-claude-tools /tmp/octools && bash /tmp/octools/handoff-kit/apply.sh`
> 3. `apply.sh` prints where it wrote `HANDOFF.md` (the project root). Confirm that path is the repo root, then fill in every section from THIS conversation and the repo's real state. List the open PRs and branches with your GitHub tools, not just our chat:
>    - **Project overview**
>    - **Where the code is** — branches, every open PR and what each is, done vs. in progress
>    - **Conversation summary** — the decisions, reasoning, and context NOT in the code (the "why"). Most important section.
>    - **What Matt wants** — vision, current and future versions
>    - **Next up** — next steps, open questions, blockers
> 4. Commit everything (`HANDOFF.md`, the `CLAUDE.md` pointer, `.claude/settings.json`) and open a PR to `main`.

---

## 2. Kickoff — APP repos — paste into the NEW session

> You're picking up the **<APP NAME>**. Get fully oriented, bring it up to our current platform, then continue the work.
>
> **1) Load context.** Read `HANDOFF.md` and `CLAUDE.md`, then summarize back to me: what the app is, its purpose, the key decisions, and exactly where the last session left off ("Next up").
>
> **2) Confirm the toolkit.** You should have the full OTCHealth toolset (24 skills + 19 agents). Confirm you see the design skills (designer, aso-growth, content-engine), the build skills (devkit, scaffolder, test-author), and the agents (architect, builder, qa, guardian, release-captain). If any are missing, run `bash /tmp/octools/setup/session-start.sh`.
>
> **3) Audit against our current stack and standards — assess only, don't change code yet.** Read `/tmp/octools/app-kit/` (build kit + LESSONS), then check the app against:
> - **devkit** — Capacitor/Ionic Agent Skills pack, format/lint + test-gate hooks, the CLAUDE.md standard, Spec Kit
> - **CI** — Depot runners (`runs-on: depot-ubuntu-24.04`) for web/Android/services; iOS stays cloud-only via Codemagic + TestFlight on the iPhone 16 Pro — never propose a local Xcode build
> - **Testing** — web-first stack (Vitest browser mode, Playwright, axe, Lighthouse) via test-author/qa; **eval-runner** (Promptfoo evals + red-team) for any in-app LLM feature
> - **Guardian** — dependency cooldowns, SHA-pinned actions, secret scanning, SBOM
> - **Design** — icon family, App Store screenshots, brand assets via the designer skill
>
> **4) Give me a prioritized plan** (use the architect agent to structure it), split into "modernize the foundation" vs. "continue the Next-up work." Wait for my go before implementing.
>
> After I approve: build with the builder, gate with qa + guardian, ship via release-captain. Update `HANDOFF.md` before you stop.

---

## 3. Kickoff — COMMERCE / store — paste into the NEW session

> You're picking up the **<STORE NAME>** — the revenue engine, not an app. Optimize for cash and conversion, and never touch anything live without my go.
>
> **1) Load context.** Read `HANDOFF.md` and `CLAUDE.md`, then summarize: what the store sells, current state (catalog, payments, channels), and exactly where the last session left off ("Next up").
>
> **2) Confirm the commerce toolkit.** Lean on the skills storefront-cro (listings, offers, bundles, upsell, abandoned-cart, checkout), lifecycle-crm (Customer.io email/SMS, winback of the 85K list), monetization, partnerships (Amazon/retail/pharmacy), paid-ads, content-engine, designer (product images, hero films, merchandising); and the agents commerce (liquidator), rainmaker (cash orchestrator), lifecycle, growth-exposure, switchboard (Helen closes Shopify orders by phone), compliance-officer (veto). If any are missing, run `bash /tmp/octools/setup/session-start.sh`.
>
> **3) Audit the store for REVENUE — assess only, change nothing live yet:**
> - **Sellable now vs. gated** (hearing aids gated on FDA OTC registration; what sells today — accessories, TReO, HSA/FSA — via web and phone?)
> - **Payment readiness** — is Stripe connected? If not, that's the #1 blocker; flag it for me.
> - **Conversion** — listings, pricing, bundles, upsell/cross-sell, abandoned-cart, landing pages, checkout (storefront-cro).
> - **Channels** — the 85K list (lifecycle-crm), phone (Helen), Amazon/retail (partnerships), HSA/FSA.
> - **Compliance** — NO medical/device claims, FTC, Shopify/Stripe prerequisites. Route claims through compliance-officer; it has veto.
>
> **4) Give me a prioritized CASH plan** (use the rainmaker or commerce agent), ordered by time-to-dollars, separating "unblock the big inventory pool" (Stripe + FDA, mine to do) from "revenue we can capture this week." Wait for my go before changing anything live.
>
> After I approve: execute with commerce + lifecycle, gate every claim through compliance-officer, report revenue impact. Update `HANDOFF.md` before you stop.
