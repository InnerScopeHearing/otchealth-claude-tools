# Interconnect — the contracts that make eight agents one team

Agents only become a team if they share state and hand off cleanly. This file
defines the five pieces of connective tissue. They are deliberately simple (files
+ existing MCP servers), because the cheapest integration that everyone already
speaks beats a bespoke bus.

```
   app.manifest.json ──read on entry, write your slice on exit── every agent
            │
   handoff.json ──── from-agent emits, to-agent consumes ──── the relay
            │
   .dreamteam/ledger.md  +  Notion "Dream Team Run Log" ──── the human watches
            │
   Notion MCP (vault/objectives) · GitHub MCP (PRs/CI) ──── the shared services
            │
   session-start.sh install + Daytona fan-out ──── how the team reaches every app
```

---

## 1. `app.manifest.json` — the per-app source of truth

One file at each app repo root. Every agent opens it first and writes back only
its slice. This is what replaces "read the whole repo to understand it" at the
start of every session. Schema: `schemas/app.manifest.schema.json`.

Shape (abridged):

```jsonc
{
  "app": "iheartest",
  "displayName": "iHEARtest",
  "ring": "non-phi",                 // "phi" | "non-phi"  (Guardian enforces)
  "type": "capacitor-hybrid",        // capacitor-hybrid | ts-service | web-commerce
  "brandProfile": "iheartest",       // designer skill brand profile id
  "stack": {
    "capacitor": "8.0.0",
    "node": "22",
    "plugins": ["app", "haptics", "preferences", "local-notifications"]
  },
  "services": {                      // ids only, never secrets (secrets in vault)
    "sentry": { "project": "iheartest", "baa": false, "relay": false },
    "posthog": { "project": "iheartest", "baa": false },
    "revenuecat": { "app": "iheartest" },
    "customerio": { "workspace": "otchealth" },
    "ota": { "provider": "capgo", "channel": "production" }
  },
  "kits": {                          // App-Kit + Dream-Team adoption flags
    "startup": true, "build": true, "testing": false, "prelaunch": true,
    "launch": true, "maintenance": true, "marketing": true, "devkit": false
  },
  "gates": {                         // QA + Guardian write here; Release reads
    "tests": "na", "axe": "na", "visual": "na", "lighthouse": "na",
    "evals": "na", "supplyChain": "fail", "phiReview": "na"
  },
  "owners": { "human": "matthew@innd.com" },
  "updatedBy": "guardian",
  "updatedAt": "2026-06-08T00:00:00Z"
}
```

Rules:
- **Ids and flags only, never secrets.** Secrets stay in the Notion vault / GCP
  Secret Manager. The manifest says *that* PostHog is wired, not the key.
- **`ring` is load-bearing.** Every agent refuses actions outside the declared
  ring. Guardian audits it. The designer/creative path requires `non-phi`.
- **`gates` is the contract between QA/Guardian and Release Captain.** Release
  Captain will not ship unless the gates it cares about read `pass` (or `na` with
  explicit justification). Values: `pass | fail | na | running`.
- **Last-writer stamps `updatedBy`/`updatedAt`** so the ledger can attribute
  changes.

## 2. `handoff.json` — the relay packet

When an agent finishes, it emits a handoff (returned in its final message and,
for durable plays, written to `.dreamteam/handoff.json`). The receiving agent
consumes it instead of re-deriving context.

```jsonc
{
  "from": "builder",
  "to": "qa",
  "summary": "Added AirPods audiogram import on the hearing-results screen.",
  "artifacts": ["src/screens/Results.tsx", "src/lib/healthkit.ts"],
  "changedSurfaces": ["results-screen", "healthkit-bridge"],
  "deps": { "added": ["@capacitor-community/health"], "cooldownChecked": true },
  "aiFeatureTouched": false,
  "gatesNeeded": ["tests", "axe", "visual", "supplyChain"],
  "nextActions": ["unit-test the dB parsing", "axe the results screen"],
  "ringImpact": "non-phi"
}
```

The packet is intentionally small and predictable. `gatesNeeded` tells QA exactly
which gates this change requires; `changedSurfaces` scopes the test/axe run;
`deps.added` triggers Guardian's cooldown check.

## 3. Status ledger — the human's window

Two mirrors of the same log so you can watch from anywhere:
- **`.dreamteam/ledger.md`** in the repo (committed with the work) — append-only,
  one line per play step: timestamp, agent, action, gate result, link.
- **Notion "Dream Team Run Log"** database (via Notion MCP) — the same rows, so
  you can watch a play unfold from your phone without opening the repo.

The Coach owns the ledger and appends on every dispatch and every gate result.
This is how a long autonomous play (e.g., Medic's overnight crash-fix) stays
legible.

## 4. Shared services over MCP — the nervous system

The team does not invent its own integrations; it speaks the MCP servers already
connected:
- **Notion MCP** — the API vault (secret *references*), the business objectives
  (Growth reads these to tie experiments to revenue), and the run log.
- **GitHub MCP** — PRs, CI status, reviews, and the PR-activity webhooks. The
  Builder->QA->Guardian->Release relay rides on PRs; Medic subscribes to CI
  events.
- **designer skill** — Creative's tools, already installed by `session-start.sh`.

A future optional addition is a tiny **manifest MCP** (read/patch
`app.manifest.json` over MCP) so cross-repo plays can update many manifests
without cloning each. Not required for v1; the file + GitHub MCP cover it.

## 5. Propagation — how the team reaches every app

Two mechanisms, both already proven in this repo:
- **Install at session start.** `setup/session-start.sh` (which today installs the
  designer skill) gains a step to install the `agents/` definitions and the new
  skills into `~/.claude/`. Any app session then has the whole team available.
- **Parallel rollout.** One Coach play fans Guardian/Builder across all repos via
  Daytona, opening an "adopt the dream team" PR in each at once (drop in
  `app.manifest.json`, the cooldown configs, the test scaffold, the devkit). Each
  PR is reviewed by Greptile + Guardian; you merge the sweep. The portfolio
  converges on one operating model in a single pass.

---

## How a contract change flows (so the team stays in sync)

1. A new field is needed in the manifest (say, `services.ota.rollbackOnCrashRate`).
2. Update `schemas/app.manifest.schema.json` here first (the contract).
3. The agent that writes it (`release-conductor`) and the agent that reads it
   (`medic`) reference the schema, not a hard-coded shape.
4. The next Daytona rollout carries the schema bump to every app manifest.

The schema is the single contract; agents are clients of it. That is what keeps
eight independent specialists from drifting apart.
