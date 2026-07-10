# Adoption order — who goes first, why, and what is explicitly excluded

This is the honest rollout sequence for `templates/golden-path/`, reconciled against each app
repo's ACTUAL current deploy shape (not an assumption). Nothing below has been executed; adopting
a template against any of these repos is a separate, explicit action for whoever picks it up next.

## 1. Flatstick `packages/api` — FIRST adopt target

Repo: `flatstick`, deployable service `packages/api` (Container App `pressgolf-api`), CI/deploy file
`.github/workflows/deploy-azure.yml`.

**This is the live example of the exact anti-pattern the golden path exists to kill.** Its current
`deploy-azure.yml` does a mutable-tag `az acr build` followed by an in-place `containerapp update
--image` — no immutable digest, no blue-green revision split, no health gate before traffic serves
the new code, and it authenticates via a stored `AZURE_CREDENTIALS` secret rather than OIDC. This is
the SAME shape that caused the gateway's own pre-Phase-1 regression (an in-place update that
silently dropped its tool count from 838 to a subset, undetected because nothing gated the cutover).
Flatstick is a Container App already (so `infra/app.bicep` applies with no host-migration step
first), and it has the highest recent engineering activity of any backend repo this cycle (the
watch/widget/Live Activity ships), which makes proving the template here the highest-signal second
data point after the gateway itself.

**Adopting this is NOT just "copy the three files."** The template's own README
(`templates/golden-path/README.md`) spells out a sequence that must be followed in order, and
skipping any step degrades the template back into the exact anti-pattern it replaces:

1. Copy `ci.yml` / `deploy.yml` / `infra/app.bicep` into the repo, fill in the `env:` block
   (`APP=pressgolf-api`, its `APP_RG`, `IMAGE_REPO=flatstick-api`, `HEALTH_PATH`).
2. **Create a per-app UAMI** (`id-flatstick-deployer` or similar) scoped to ONLY Flatstick's own
   resource group + AcrPull on the shared ACR. Never point `deploy.yml`'s `client-id:` at the
   gateway's `id-gateway-deployer` or at any other app's identity — that grants Flatstick's pipeline
   write access to a resource group it has no business touching. This is a NEW Azure resource
   (an identity + two role assignments + a federated credential); it does not exist yet.
3. **Enable branch protection on `main` FIRST** (required PR, required `ci` status check, "require
   branches up to date before merge") and **create a `production` GitHub Environment** (scoped to
   `branch: main`, one required reviewer who is not the person who usually opens the release) —
   BOTH of these must be live BEFORE the first real deploy, not added afterward. `deploy.yml`'s
   `push: branches: [main]` auto-trigger is only safe once merges to `main` are actually gated;
   turning it on before branch protection exists reproduces the exact "deploy whatever just merged,
   no gate" failure mode this template is supposed to prevent.
4. First deploy via `workflow_dispatch` only, watch the full blue-green cycle once, confirm the
   health gate actually fails closed (temporarily point `HEALTH_PATH` at something that 500s, confirm
   blue keeps 100% traffic, then fix it back) before trusting the automatic push-to-main trigger.

**Skipping step 2 or step 3 to "move faster" is the single easiest way to make this whole exercise
pointless** — it is called out explicitly here and in `templates/golden-path/README.md`'s "What NOT
to do" section because it is the most likely shortcut under time pressure, not a hypothetical.

## 2. MedReview `packages/api` — EXCLUDED, not a rollout step

Repo: `medreview`. Currently deployed to **GCP Cloud Run**, not Azure at all, under the GCP BAA.

**Do not adopt this template against MedReview.** MedReview is PHI-ring and stays on the GCP BAA per
the hard legal wall documented in `otchealth-claude-tools/CLAUDE.md` and
`otchealth-cto/runbooks/AZURE-AI-OPERATING-SYSTEM.md`: moving any PHI workload to Azure requires an
Azure BAA + a HIPAA-eligible Azure OpenAI deployment signed and provisioned FIRST, and that is a
Matt + counsel decision, not something the CTO or a template adoption pass decides unilaterally.
MedReview is listed in this document only to make the exclusion explicit and prevent a future
session from "helpfully" including it in a batch rollout.

## 3. Other apps — verify current state before assuming they need this, or are even eligible yet

- **OTCHealth Companion `apps/backend`** — currently on GCP Cloud Run, not yet on Azure at all.
  Companion is NOT PHI by its own CLAUDE.md ("Treat all data as NON-PHI in v1"), so unlike MedReview
  there is no legal wall blocking it — but it needs the Cloud-Run-to-Container-Apps MIGRATION step
  done first, before a golden-path adoption pass makes sense. Sequenced after Flatstick because of
  that prerequisite, not because it is lower priority.
- **PlantID `functions/`** — an Azure Function App, already live, but deployed today via manual
  `func azure functionapp publish` + manual ARM App Settings, no CI at all. This is a **Function App
  variant**, not a Container App — `infra/app.bicep` targets `Microsoft.App/containerApps` and does
  NOT apply as-is. `ci.yml` (the green-main gate) is host-agnostic and can adopt unchanged; the
  deploy side needs a separate `deploy-functions.yml` (zip/`az functionapp deployment source
  config-zip` or the Bicep `onedeploy` extension, a lightweight health-poll, no blue-green since
  Function Apps do not expose the same multi-revision traffic-split primitive Container Apps has).
  That variant is NOT drafted in this PR — flagging it here as its own follow-on track rather than
  silently skipping it.
- **FourVault `packages/api`** — has an `e2e/server` test harness; its production deploy shape was
  **not verified this session**. Before adopting anything here, actually read its current CI/deploy
  files rather than assuming it needs the template — it may already be closer to the golden shape
  given FourVault's newer build.
- **AWARE / InnerEase / Fictionary / OTCHealthMart / INND-website** — little to no backend surface
  found in a repo scan (no `packages/api` or `functions/` directory). Not a retrofit target; the
  cheaper move is adopting the template AT CREATION time when each of these actually grows a backend,
  rather than retrofitting an existing one later.

## Orchestration + sandbox planes: unverified prerequisites, not yet pilotable

Both of these need one fact confirmed before a real pilot can run — neither is a blocker to the
template existing in this repo, but both block actually deploying it:

- **`templates/durable-librarian/`** needs the Durable Task Scheduler (Consumption SKU) created
  once, shared fleet-wide (`sched-otchealth-jobs` / task hub `fleet-orchestration` — see the
  template's own README for the exact `az durabletask` commands). This is designed as a
  **coexistence pilot**, not a cutover: the 4 existing `librarian-{finance,commerce,legal-company,
  legal-personal}` Container Apps Jobs keep running unchanged on their current staggered cron while
  this is piloted side by side, and only get paused (not deleted) once the Durable Functions path is
  observed clean for at least a week.
- **`templates/dynamic-sessions-pool/sandbox-pool.bicep`** requires a **workload-profiles-enabled**
  Container Apps environment (a hard platform requirement for custom-container session pools). It is
  **not yet confirmed** whether either existing environment (`cae-otchealth-apps`, the gateway's env,
  or `otchealth-jobs-env`, where the librarian jobs run today) has workload profiles enabled. If
  neither does, this plane needs its own new environment before a session pool can be created at
  all — verify this with `az containerapp env show` (check `properties.workloadProfiles`) before
  attempting a deployment, not after writing a deployment script that assumes it.

## What this ordering does NOT claim

This is a recommended sequence based on what was verifiable this session, not a committed schedule.
In particular: Flatstick being first does not mean it will be done in any specific timeframe, and
none of the "verify current state" items above have actually been verified in this PR — they are
flagged as the next reader's first step, not resolved.
