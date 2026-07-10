# Microsoft IQ Solution Accelerator — harvest assessment (not adopted, not built)

> Scope: this is a research/assessment doc only, per the CTO gate-review task. We are **not** deploying
> or building the Microsoft IQ Solution Accelerator. The question this answers: *does anything in it
> pay off for our Claude+Azure fleet without buying the paid Microsoft 365/Fabric/Copilot Studio stack?*
> Sources: `github.com/microsoft/microsoft-iq-solution-accelerator` (repo, README, DeploymentGuide.md)
> and `azure.github.io/ai-app-templates` catalog listing, reviewed 2026-07-02.

## What it is

The **Microsoft IQ Solution Accelerator** is a Microsoft-published, ready-to-deploy reference
architecture (MIT-licensed, Python/Bicep/PowerShell, `azd up` deployable) demonstrating **Microsoft
IQ** — Microsoft's unified enterprise-intelligence layer — applied to a supply-chain disruption
detection/response scenario. It stitches together three "IQ" services plus an orchestration layer:

| Component | What it does | What it needs |
|---|---|---|
| **Fabric IQ** | Data lakehouse, notebooks, semantic models/ontologies, and a "Fabric Ontology Data Agent" that answers questions grounded in the business's data model (customers, products, inventory, suppliers, demand). | **Microsoft Fabric** capacity (licensed/metered), Fabric Admin Portal feature flags, OneLake. |
| **Foundry IQ** | A managed enterprise-knowledge layer: connects Azure/SharePoint/OneLake/web content into a permission-aware retrieval index; a "Foundry Chat Agent" answers contract/policy/supplier questions grounded in that index. | **Microsoft Foundry** (Azure AI Foundry) — this part *is* Azure-native and credit-eligible on its own. |
| **Work IQ** | A Copilot Studio agent, triggered by an inbound email, that orchestrates the other two agents from "a single conversational ingress," grounded in Microsoft 365 signals (mail/calendar/Teams) via Work IQ MCP servers. | **Microsoft 365 Copilot** licensing, **Power Platform** (Power Automate flow, Power Platform environment), **Copilot Studio**, Microsoft Teams. Deployed **manually** (a Power Platform solution-zip import), not part of the automated `azd up`. |

Deployment is two-phase: `azd up` automates Fabric IQ + Foundry IQ provisioning into one Azure resource
group; Work IQ is then hand-configured against a licensed Microsoft 365/Power Platform tenant. The repo
itself flags the MCP-server integration as **preview**, explicitly scoped for "evaluation, experimentation,
and demonstration," not production.

## Licensing / cost verdict: NOT credit-eligible, NOT cost-neutral, for 2 of 3 legs

- **Work IQ leg — hard NO.** Requires a licensed Microsoft 365 Copilot seat, Power Platform (Power
  Automate + a Power Platform environment, both consumption/seat-licensed products outside the Azure
  compute/AI credit pool), and Copilot Studio (its own per-message/session metering). None of this is
  payable from an Azure OpenAI/compute grant — it is Microsoft 365 suite spend. **Ineligible for our
  credit-funded, cost-neutral posture as a hard requirement**, not an optional extra: the accelerator's
  own orchestration layer *is* Work IQ.
- **Fabric IQ leg — mostly NO.** Needs Microsoft Fabric capacity (F-SKU, billed continuously once
  provisioned, independent of Azure OpenAI credits) plus tenant-level Fabric Admin Portal settings we
  don't currently hold. We have zero existing Fabric footprint; standing one up purely to harvest a
  supply-chain demo's semantic-model pattern is not justified by what we'd get back.
- **Foundry IQ leg — the only piece that's actually "just Azure."** Microsoft Foundry (Azure AI Foundry)
  agent + retrieval-index pattern runs on the same Azure AI Foundry / Azure AI Search substrate we
  *already* use for `company-brain`, `kb-memory/semantic.mjs`, and `ring-memory-index`. This is the one
  leg with no new licensing surface.

**Bottom line: the accelerator as a whole is not something we can stand up under the current Azure
credit / no-new-recurring-spend constraint** — two of its three pillars require paid Microsoft 365 /
Fabric seats we don't hold and shouldn't buy just to harvest patterns. Do not build it.

## What IS harvestable, patterns-only, on our Claude+Azure stack (zero new spend)

None of these require adopting Fabric, Copilot Studio, or M365 Copilot. They are architectural ideas we
can (and in most cases already substantially do) implement natively:

1. **"Shared context layer that every agent grounds in" (the Microsoft IQ thesis itself).**
   This is directly what `company-brain` + `kb-memory`/`semantic.mjs` + `ring-memory-index` already do:
   a federated Azure AI Search substrate (`memory-exec`, ring-private indexes, per-agent commons
   indexes) every agent recalls through. Microsoft IQ's pitch ("build an agent once, it knows the
   company; build the next, it reasons from the same grounded understanding") is a validation of a
   direction we've already taken independently — no new build needed, but it's a good argument for
   continuing to invest here (which is exactly what embedding-drift-monitor, this same gate PR set,
   does: keep that shared layer healthy).

2. **Permission-aware / policy-compliant knowledge retrieval (Foundry IQ's framing).** Foundry IQ's core
   idea — a retrieval layer that enforces access policy per query rather than per document dump — maps
   cleanly onto our existing **ring-isolation model** (legal-personal-memory, finance-cfo-memory never
   crossing into the shared brain). We already enforce this at the index-selection layer (which index a
   query is allowed to touch) rather than Microsoft's per-document ACL-at-retrieval-time approach; ours
   is coarser-grained but achieves the same "don't leak ring-private content" goal for free. Worth
   revisiting only if we ever need document-level (not index-level) access control within a single ring
   — not needed today.

3. **A "single conversational ingress that orchestrates specialist sub-agents" pattern (Work IQ's
   orchestration idea, minus Copilot Studio).** The accelerator's actual mechanism — one entry point
   (there, an inbound email) triggers a workflow that calls out to a data agent and a knowledge agent
   and synthesizes a response — is architecturally identical to what `fleet-dispatch` +
   `focus-group-loop` already do with plain `.mjs` orchestration over Azure OpenAI, no Power Platform
   required. If we wanted an email-triggered entry point specifically, that's a small, independent
   build (an Azure Function or a scheduled poll against a mailbox) — not something that needs Work IQ.

4. **Ontology/ semantic-model grounding for structured data Q&A (Fabric IQ's "Ontology Data Agent").**
   The pattern — define an explicit semantic model over structured business data so an agent answers
   consistently ("what's at risk," "which supplier," etc.) rather than re-deriving meaning from raw
   rows every query — is worth stealing *conceptually* for anywhere we have structured data an agent
   queries repeatedly (e.g. CFO's books, commerce inventory). We do NOT need Fabric/OneLake for this:
   a lightweight, hand-maintained schema/glossary doc (or a small JSON ontology file the relevant
   skill reads) gets 80% of the benefit at 0% of the licensing cost. If a CFO/commerce agent starts
   showing inconsistent interpretation of the same structured fields, that's the trigger to build this
   — not a general roadmap item today.

5. **MCP-based "IQ" tool surfacing (Work IQ MCP servers).** The idea of exposing org context (mail,
   calendar, docs) to an agent via typed MCP tools rather than ad-hoc scraping is directionally aligned
   with how our own skills already expose typed operations (`node <skill>.mjs <verb>`). No action item —
   we're already doing the MCP-shaped thing without calling it that, and don't need Microsoft's specific
   MCP servers (which require Work IQ/M365 licensing to reach anyway).

## Recommendation

- **Do not deploy or replicate the accelerator.** Its orchestration layer is licensing-gated behind
  Microsoft 365 Copilot + Power Platform + Fabric, none of which are credit-eligible or cost-neutral for
  us, and two of its three "IQ" pillars are unusable without that paid stack.
- **No new build triggered by this review.** Every pattern worth having (shared grounding layer, ring-
  scoped retrieval, orchestrator-over-specialist-agents, semantic-model consistency) is either already
  implemented in this repo (`company-brain`, `kb-memory`, `ring-memory-index`, `fleet-dispatch`) or is a
  small, independent, non-Fabric build to consider only if a concrete pain point shows up (e.g.
  inconsistent structured-data answers from CFO/commerce agents — see item 4 above).
- **Revisit trigger:** if OTCHealth ever *does* acquire Microsoft 365 Copilot + Fabric seats for other
  business reasons (not to chase this accelerator), Foundry IQ becomes worth a second look since it's
  the one leg that's genuinely "just more Azure" — re-evaluate at that time, not before.
