# Governance gates — what's shipped vs. what's still a plan

Read this before assuming anything in `dream-team/governance/` is live and
enforcing. This is the honest status ledger. Update it in the same PR that
changes any of these facts; a stale "DONE" here is worse than an honest
"NOT DONE."

## Legend

- **SHIPPED** — exists in this repo, runs, was tested this session.
- **FRAMEWORK-ONLY** — the design/schema/sketch exists; nothing consumes or
  enforces it yet.
- **NOT DONE / BLOCKED** — named as a dependency; no work has started, or work
  is blocked on a gate outside this repo (a license quote, a Matt decision,
  another repo's CI).

## 1. Charter schema + example charters — SHIPPED

- `agent-charter.schema.json` is a complete, valid JSON Schema.
- `charters/charter-{cto,cfo,clo}.json` all validate against it.
- `charter-lint.mjs` runs structural + invariant validation
  (`write ⊆ read`, no self-approval, hard-limit enforcement-point coverage, no
  unwarranted bare `*` scope) and **exits 0 on the three real charters, exits 1
  on a deliberately-broken one** (verified this session by injecting a
  self-approval violation into a scratch copy and confirming the linter
  rejects it).
- What this gets you today: a reviewable, versioned, schema-checked way to
  write down an agent's rings/scopes/prohibitions/spend authority, and a CI
  script ready to be wired into a workflow. That is genuinely useful on its
  own (it is a much more precise permissions doc than prose), but it is not
  yet gating anything a real agent does.

## 2. CI enforcement (the charter-lint as an actual gate) — NOT DONE

- `charter-lint.mjs` is not registered as a GitHub Actions step anywhere,
  in this repo or in `otchealth-mcp-server`.
- No repo has adopted `--repo-lane` (the diff-scan half of the linter,
  the direct generalization of iHEARtest's compliance grep) — it has never
  run against a real PR diff, only against the static charter files.
- To make this real: add a `charter-lint` job to the gateway repo's CI
  (it is the natural home since charters are meant to live there — see
  item 3), and, per repo that wants the diff-scan half, add a step calling
  `node charter-lint.mjs --repo-lane <lane> --diff-base origin/main`.

## 3. Charters living in the gateway repo + CODEOWNERS protection — NOT DONE

- The design (`README.md` "Charter authorship and change control") calls for
  `charters/*.json` to live in `otchealth-mcp-server`, protected by a
  CODEOWNERS rule so only `coach`, `guardian`, or Matt can merge a charter
  edit.
- **This PR does not touch `otchealth-mcp-server` at all.** The charters here
  are examples living in the toolkit repo for drafting/reference. Moving them
  to the gateway repo, and wiring a CODEOWNERS rule, is separate, not-yet-started
  work.

## 4. Gateway-side enforcement (ring gate, scope allowlist, tool/resource deny) — FRAMEWORK-ONLY

- `reference/charter-enforcer.ts` typechecks clean against copies of the real
  `otchealth-mcp-server` source (`src/auth/bearer.ts`'s `AuthContext`,
  `src/compliance/guardrail.ts`'s `scanForCompliance`/`ComplianceWarning`) —
  that only proves the sketch's shapes line up with the live code, not that
  it runs anywhere.
- It is not imported by `mcp-handler.ts` or any other real gateway file. No
  charter is loaded at gateway boot. No PHI-tool-from-non-PHI-lane call has
  actually been rejected by this code; the rejection behavior is demonstrated
  only in the file's own doc comments.
- **The load-bearing blocker for making this real: per-tool ring tagging.**
  `charter-enforcer.ts`'s `getToolRingDeclaration()` is a `declare function`
  stub. The real gateway has roughly **838 tools** across `src/tools/**`, and
  none of them currently declare a `ring`. Tagging all of them (or even the
  PHI/MNPI-adjacent subset first) is real, non-trivial follow-on work, not a
  config flip. Until a tool has a ring declaration, the enforcer's ring gate
  cannot evaluate it — this is the single biggest gap between "framework
  exists" and "PHI-ring boundary is machine-enforced."

## 5. Propose-vs-commit ledger for spend/publish/destructive-infra — FRAMEWORK-ONLY

- `reference/propose-commit-ledger.ts` typechecks clean against the real
  `src/agentstate/cosmos.ts` primitives (`createDoc`/`readDoc`/`replaceDoc`/
  `queryDocs`) — again, a shape-compatibility proof, not a running system.
- The `irreversible_proposals` Cosmos container **does not exist**. No caller
  anywhere proposes or commits anything through this file. Deploy keeps using
  its own purpose-built GitHub Environment gate (correctly — see the
  README), so this ledger has exactly zero real callers today.
- To make this real: create the container, wire at least one real proposal
  kind (spend is the most concrete starting point — CFO-proposed vendor
  invoices above a ceiling) through `propose()`/`commit()`, and add a
  `listPendingCommits()` read into the existing daily-digest job so a pending
  commit actually surfaces to Matt instead of only being queryable.

## 6. Per-agent Entra Agent ID identity — NOT DONE / BLOCKED ON A LICENSE QUOTE

- No Entra Agent ID blueprint has been created. No Conditional Access policy
  has been written. No license has been purchased or even priced against the
  tenant's actual current Entra SKU.
- **The concrete next step, not yet taken:** get an exact Microsoft Agent 365
  per-user quote stacked on the tenant's current Entra tier, and confirm with
  Matt whether that recurring cost is grant-covered or new out-of-pocket
  spend. Every enforcement control this design wants (Conditional Access,
  PIM, ID Governance) needs that license on top of Entra P1/P2 — creating the
  identity itself is free, but making it governable is not, and this has not
  been priced yet.
- Until that quote lands and Matt decides, every charter's `identity.auth_mode`
  stays `shared-bearer` and `entra_agent_id_blueprint`/`conditional_access_group`
  stay `null`. That is the correct, honest state for all three example
  charters in this PR.

## 7. azure-sp Owner + otchealth-fleet-bot least-privilege migration — SEQUENCED LAST, NOT STARTED

- `azure-sp` currently holds subscription-level Owner. `otchealth-fleet-bot`
  (the GitHub App) is flagged over-privileged (near-enterprise-admin scopes,
  installed on 3 accounts including a user account) — both are pre-existing,
  already-flagged risks this framework is designed to eventually retire, not
  new findings from this PR.
- The design's own sequencing (README "Recommended sequencing") explicitly
  puts this **last**: pilot Entra Agent ID on one role, prove Conditional
  Access, only then extend to PIM for the rare privileged action that
  converts `azure-sp`'s standing Owner grant and the GitHub App's standing
  scopes into just-in-time, time-bound activations.
- Nothing in this PR changes `azure-sp`'s permissions or the GitHub App's
  installation scope. Both remain on the existing ROTATE-BEFORE-LAUNCH /
  least-privilege backlog exactly as they were before this PR.

## Summary table

| Layer | Status |
|---|---|
| Charter schema | SHIPPED |
| Three example charters (cto/cfo/clo) | SHIPPED |
| Charter structural linter (`charter-lint.mjs`) | SHIPPED (runs, tested both directions) |
| Linter wired into any real CI workflow | NOT DONE |
| Charters living in the gateway repo + CODEOWNERS | NOT DONE |
| Per-tool ring tagging (~838 tools) | NOT DONE (~0 of 838 tagged) |
| Gateway-side charter enforcement (`charter-enforcer.ts`) | FRAMEWORK-ONLY (typechecks, not wired) |
| Propose-vs-commit ledger for spend/publish/infra | FRAMEWORK-ONLY (typechecks, no container, no callers) |
| Per-agent Entra Agent ID identity | NOT DONE (blocked on Agent 365 license quote) |
| azure-sp Owner / fleet-bot least-privilege retirement | NOT STARTED (sequenced last by design) |

If you are deciding whether to rely on this framework for an actual security
boundary today: **do not.** The only thing currently doing real enforcement
work in the fleet is what already existed before this PR (deploy.yml's
GitHub Environment gate, `guardrail.ts`'s regex scan, `ledger.ts`'s
artifact-gated done, and iHEARtest's own compliance grep). This PR adds a
well-specified, tested plan for generalizing those, and nothing more.
