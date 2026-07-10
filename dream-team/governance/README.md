# Agent governance — the Moore Playbook made machine-checkable

This directory is the **Phase 5 governance framework**: it turns the fleet's prose
rules (`otchealth-cto/CLAUDE.md` "Operating authority & autonomy," each agent's
`dream-team/agents/<role>.md`, `dream-team/MEMORY-SOP.md`'s ring rules) into a
small set of machine-readable artifacts that a gateway, CI, and a human reviewer
can all check the same way. See `GATES.md` for exactly what is shipped-and-enforced
today versus framework-only pending follow-on work; that is the honest status
ledger, read it before assuming anything here is live.

## Why this exists

Every agent already has a rich prose definition. That prose is correct and
necessary for day-to-day judgment calls, but it is **unenforceable**: nothing
stops a PR, a tool call, or a spend proposal from violating it except the
agent's own good judgment in the moment. An **agent charter** is a thin, separate,
machine-readable artifact that sits next to the prose definition and encodes
only the subset of it a machine can check without an LLM in the loop: which
compliance rings this agent may touch, which gateway tools it may call, which
regexes must never appear in its outbound content or authored diffs, and who
must approve an irreversible action above what ceiling.

This is not a greenfield idea. Three pieces of the target architecture are
**already shipped and running** in `otchealth-mcp-server` today, and this
framework generalizes them rather than replacing them:

1. **Deploy already implements propose-vs-commit.** `.github/workflows/deploy.yml`
   builds an immutable `@sha256` digest (propose), brings it up as a `GREEN`
   revision at 0% traffic, health-checks it, and only a human-gated `production`
   GitHub Environment required-reviewer step (commit) shifts live traffic.
2. **The work-ledger already implements an artifact-gated "done."**
   `src/agentstate/ledger.ts` `completeTask()` rejects a task transition to
   `done` unless `artifact_uri` resolves (`src/agentstate/resolver.ts`).
3. **A regex-based compliance guardrail already gates on acknowledgment.**
   `src/compliance/guardrail.ts` `scanForCompliance()` scans outbound tool
   payloads for six regulated/investor-sensitive triggers and requires
   `acknowledge_warning: true` before the caller sees the data.
4. **A per-app compliance grep is already a hard, proven CI gate.** iHEARtest's
   `.github/workflows/web-ci.yml` "Compliance guard" step fails a PR whose diff
   introduces `hearing_number`/`threshold_db_hl` outside two sanctioned
   exception files. `charter-lint.mjs` generalizes exactly this pattern
   fleet-wide, driven by charter data instead of a hand-maintained grep line
   per repo.

The one thing that does **not** exist yet: per-agent identity. `src/auth/bearer.ts`
resolves every caller to one of a small number of **shared lanes** (`cto`, `cfo`,
`clo`, `clo-personal`, `copilot-agent`, or the static `OAUTH_DEFAULT_AGENT`).
There is no per-agent Entra identity, no PIM, no Conditional Access. Separately,
`azure-sp` holds subscription Owner and `otchealth-fleet-bot` is flagged
over-privileged. Retiring both is the identity migration this framework is
designed to carry, once its licensing gate (below) is answered.

## What's in this directory

| File | What it is |
|---|---|
| `agent-charter.schema.json` | The JSON Schema every charter validates against. Read its top-level `description` and each field's `description` first; the schema doc comments carry most of the design reasoning inline. |
| `charters/charter-{cto,cfo,clo}.json` | Three worked example charters, drafted against the real fleet state (the real shared-bearer lanes, the real tool-name conventions, the real skills each role wields per `ROSTER.md`). All three validate against the schema and the linter. |
| `charter-lint.mjs` | The CI-shaped linter: structural + invariant validation of every charter (write ⊆ read, no self-approval, hard-limit enforcement-point coverage, no unwarranted bare `*` scope), plus an optional diff scan for a repo that declares a `--repo-lane`. Not yet wired into any GitHub Actions workflow — see `GATES.md`. |
| `reference/charter-enforcer.ts` | A gateway-side **sketch**, typechecked against real `otchealth-mcp-server` source (`bearer.ts`'s `AuthContext`, `guardrail.ts`'s `scanForCompliance`), showing the third enforcement point: coarse `gateway_scopes` allowlist, then the ring gate, then fine-grained `tool_deny`/`resource_deny`, then the post-hoc `regex_content` scan. **Reference only — not wired into the running gateway.** |
| `reference/propose-commit-ledger.ts` | A gateway-side **sketch**, typechecked against the real `src/agentstate/cosmos.ts` primitives, generalizing the deploy propose-vs-commit shape to spend and any other irreversible action, on the same Cosmos `createDoc`/`readDoc`/`replaceDoc`/`queryDocs` primitives `ledger.ts` already uses. **Reference only — the `irreversible_proposals` container does not exist yet; nothing calls this file.** |

## The charter model, in one picture

```
   PROPOSE (any agent, any time, costs nothing)
        |  produces an immutable, checkable ARTIFACT
        |    - deploy: an @sha256 digest, already live in an inactive revision
        |    - task:   an artifact_uri that resolver.ts can verify
        |    - spend:  a structured { amount_usd, vendor, purpose, invoice_uri }
        |    - publish: a content URI + diff
        v
   COMMIT (a GATED actor: either the proposer itself, ONLY if under its
           charter's self-commit ceiling, or a distinct approver named in
           the charter -- never the proposer above the ceiling)
        |
        v
   the artifact takes effect (traffic shifts / task closes / money moves /
   content publishes) -- and ONLY at this step, never at propose time
```

Deploy already runs this exact shape via a purpose-built gate (a GitHub
Environment required reviewer) and keeps using it; `propose-commit-ledger.ts`
is the generic version for irreversible actions that do not already have an
equivalently strong purpose-built gate (a vendor invoice, an INND-facing
publish, a destructive infra change, a data-room write to a privileged index).

## Design decisions worth knowing before reading the schema

- **`identity.bearer_lane` is required today; `entra_agent_id_blueprint` is
  nullable.** The charter is deliberately the single artifact that migrates the
  fleet from shared bearer lanes to per-agent Entra identity without a schema
  break: `auth_mode` flips from `shared-bearer` to `entra-agent-id` per role,
  independently, as each role's Entra rollout completes. No flag-day cutover.
- **Two enforcement points per prohibition, not one.** Every `prohibited_actions`
  entry declares `enforcement_point: [gateway, ci, browser_agent, human_review]`.
  The linter fails a charter if a `ring_gate` or `regex_content` entry lists
  only `human_review` — a hard limit that only a human catches on review is a
  documented gap, not a control. `clo`'s `no_unverified_legal_citation` is the
  one deliberate, honest exception: it is typed `physical_gate_marker` because
  "was this citation verified" has no regex signature.
- **`rings` extends `app.manifest.json`'s `ring` enum** with `mnpi`
  (securities/Reg FD firewall) and `legal-personal` (privileged, CLO-only,
  never shared, mirroring `MEMORY-SOP.md`). `write` is schema-required to be a
  subset of `read`, and the linter enforces this as a static invariant.
- **`spend_authority` bakes in "no self-approval" as a structural rule.** A
  charter's `commit_approvers` must never include its own `agent_role` —
  checked both statically (the linter) and dynamically
  (`propose-commit-ledger.ts`'s `commit()`).
- **`physical_gates` documents what a charter can never enforce.** Account
  signup/KYC/OAuth consent/payment/e-signature/hardware have no gateway-side
  signal. The schema is honest about this: `physical_gate_marker` prohibitions
  are explicitly not required to carry a `gateway`/`ci` enforcement point.

## Charter authorship and change control (intended, not yet set up)

Charters are meant to live in the gateway repo (the same repo that already
runs `deploy.yml`), protected by CODEOWNERS so only `coach`, `guardian`, or Matt
may merge a change to them. A charter version bump is itself a propose (a PR) /
commit (a required-reviewer merge) action — charter governance uses the same
primitive it defines. This directory in `otchealth-claude-tools` is the drafting
and reference home; see `GATES.md` for what still needs to happen for that to
be real rather than aspirational.

## Per-agent identity: the licensing gate, stated precisely

Microsoft Entra Agent ID provides agent identity blueprints (individual,
governed agent identities with parent-child relationships, OAuth 2.0/MCP/A2A
native, explicit third-party-agent support). The facts that matter for
sequencing this, verified against current Microsoft Learn docs:

| Capability | What it needs |
|---|---|
| Creating an agent identity at all | Free, included for all Entra customers |
| Conditional Access for agents | Entra ID P1 **plus** a Microsoft Agent 365 license |
| ID Protection for agents | Entra ID P2 **plus** Agent 365 |
| ID Governance for agents (PIM, access reviews) | Entra ID P1 **plus** Agent 365 (or M365 E7, which bundles both) |
| Network controls for agents | Microsoft Entra Internet Access |

The load-bearing fact: every enforcement control this design actually wants
(Conditional Access, PIM, ID Governance) requires a **per-user** Microsoft
Agent 365 license stacked on the underlying Entra P1/P2 tier. It is a recurring
per-sponsor cost line, not a one-time platform fee, and it is not automatically
covered by the existing Azure consumption credit line. **Before rolling out
Entra Agent ID governance for even one role: get an exact Agent 365 quote
stacked on the tenant's current Entra tier, and confirm with Matt whether that
recurring cost is grant-covered or new spend.** See `GATES.md` for this as a
tracked, not-yet-done item.

Recommended sequencing once the licensing question is answered: pilot on one
role first (`cto`, since it holds the most-privileged shared lane), add a
Conditional Access group + policy as a second independent enforcement point
alongside the gateway's own ring check, then extend to PIM for the rare
subscription-Owner-equivalent action (this is what finally retires `azure-sp`'s
standing Owner grant and the GitHub App's standing broad scopes), then roll the
remaining roles through the same pilot-then-widen sequence, each gated on its
own charter's `auth_mode` flip.

## What this framework explicitly does not do yet

See `GATES.md` for the full, itemized list. In short: nothing here is wired
into the live `otchealth-mcp-server` gateway or its CI. No `charters/`
directory or CODEOWNERS rule exists in that repo. No Entra tenant
configuration has been touched. Per-tool ring tagging across the ~838 real
gateway tools has not been attempted. This directory is the schema, the
worked examples, the linter, and the reference sketches — the shippable,
review-ready starting point for that follow-on work, not a claim that the
follow-on work is done.
