# Golden Path — the fleet's templated release/orchestration/sandbox layer

Phase 6 of the Azure AI Operating System program (`otchealth-cto/runbooks/AZURE-AI-OPERATING-SYSTEM.md`,
Layer A "Compute + orchestration plane" + the golden-path templating item under "Top moves"). This
directory holds the REUSABLE templates so the release pipeline `otchealth-mcp-server` (the gateway)
proved out is not a one-repo island — any of the ~15 per-app backend repos can adopt the same
blue-green, digest-pinned, least-privilege release shape, and the fleet's cron+blob jobs get a path to
durable orchestration and a hardened sandbox plane.

**Status: templates only, nothing deployed.** Copying a template into this directory does not change
any live resource. Every template requires the adopt steps below to be run explicitly, per target repo,
by whoever is doing that adoption.

## What's here

- **`templates/golden-path/`** — the reusable `ci.yml` + `deploy.yml` + `infra/app.bicep` for a
  Container-App-shaped backend. Derived from the gateway's own proven, live pipeline
  (`otchealth-mcp-server/.github/workflows/{ci.yml,deploy.yml}` + `infra/gateway.bicep`) with the
  gateway-specific values pulled out into an `env:` block. See `templates/golden-path/README.md` for
  the full copy-paste adopt sequence (per-app UAMI creation, branch protection, GitHub Environment,
  first-deploy-by-hand before trusting the auto-deploy trigger).
- **`templates/durable-librarian/`** — a Durable Functions (Flex Consumption) skeleton that fans the
  4 librarian data-room profiles (finance / commerce / legal-company / legal-personal) out as parallel
  activities instead of 4 separate Container Apps Jobs on staggered cron. Ships with a free operator
  dashboard (pause/terminate/resume any run), checkpointed resume on a process recycle, and a
  documented (not-yet-wired) human-in-the-loop approval-gate pattern for the CFO's gated
  INND/HearingAssist xero posting. See `templates/durable-librarian/README.md`.
- **`templates/dynamic-sessions-pool/`** — a Container Apps Dynamic Sessions custom-container pool
  Bicep template (`sandbox-pool.bicep`) for running genuinely untrusted code (doc-indexer OCR on
  arbitrary uploaded files, any future LLM-generated-code execution) Hyper-V-isolated, with outbound
  network **disabled by default** and no managed identity with fleet-secret access baked into the
  pool. The browser-agent explicitly stays OFF this plane for now (see the template's own comments) —
  it needs real egress to reach OAuth/portal pages, and mixing that need into the same pool as the
  egress-disabled untrusted-code case would widen the sandbox's trust boundary for no reason.
- **`ADOPTION-ORDER.md`** — the honest, repo-by-repo rollout sequence: which app goes first and why,
  which apps are explicitly excluded (and why), and what unverified prerequisites block the other two
  planes before a real pilot can run.

## Why this exists (in one paragraph)

The gateway repo proved a real fix for a real incident: an in-place, mutable-tag Container App
deploy with no health gate silently regressed its own tool count from 838 to a subset, and nobody
noticed until later. The golden path (immutable digest, blue-green with a health-gated cutover,
branch protection + a required-reviewer Environment, least-privilege per-app identity) is the fix.
Flatstick's live `packages/api` deploy workflow today is the same anti-pattern the gateway had before
its own fix — mutable `az acr build` tag, in-place `containerapp update --image`, no digest, no
blue-green, no health gate. That is why Flatstick is first in `ADOPTION-ORDER.md`, not an arbitrary
pick.

## Ring / compliance discipline (unchanged from the rest of the fleet)

- **Non-PHI only.** None of the three template families here are for MedReview, FourVault's kid-data
  ring, or any BAA workload. MedReview is explicitly excluded from `ADOPTION-ORDER.md` with the legal-
  wall citation (it stays on the GCP BAA until an Azure BAA + HIPAA-eligible Azure OpenAI are signed).
- **No live app repo, and no live gateway resource, was touched to produce these templates.** They
  were copied from `/tmp/phase6/` (a prior research/design pass) into this repo only. Adopting a
  template against a real app repo, and any Azure resource creation it implies (a per-app UAMI, a
  Durable Task Scheduler task hub, a session pool), is a separate, explicit, per-adoption action —
  never a side effect of this PR landing.
- **Least privilege is the whole point.** Every per-app UAMI recipe here is scoped to exactly one
  app's own resource group; reusing another app's identity (including the gateway's
  `id-gateway-deployer`) to "save a step" defeats the template's actual purpose. See
  `templates/golden-path/README.md`'s "What NOT to do" section.

## Read next

1. `ADOPTION-ORDER.md` — which repo to onboard first, and the two verify-before-build prerequisites
   (workload-profiles-enabled Container Apps environment for Dynamic Sessions; confirming
   FourVault/other repos' current deploy shape before assuming they need this).
2. `templates/golden-path/README.md` — the release-pipeline adopt sequence (do steps in order; branch
   protection BEFORE the first real deploy, not after).
3. `templates/durable-librarian/README.md` — the orchestration pilot sequence (coexistence with the
   existing Container Apps Jobs cron, not a flag-day cutover).
4. `templates/dynamic-sessions-pool/sandbox-pool.bicep`'s own header comment — the prerequisite check
   (workload profiles) and the egress-disabled-by-default design rule.
