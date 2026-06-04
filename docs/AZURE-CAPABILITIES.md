# Microsoft Azure for OTCHealth — capability map & access model

> Purpose: orient a non-Azure-expert owner on (a) what Azure can do for us,
> (b) where the $5,000 grant stretches furthest, and (c) how to grant Claude
> *enough* access to help build — safely, without handing over the keys to the
> kingdom. Written for the NON-PHI ring by default; PHI notes called out.

## 0. First: "Microsoft account" ≠ "Azure". This matters.

There are two separate things, and people conflate them:

| Layer | What it is | Who should hold admin |
|---|---|---|
| **Entra ID / Microsoft 365 tenant** (the "account" side) | Identity, email, users, billing owner. "Global Administrator" lives here. | **You / a human only.** Never an automated tool. |
| **Azure subscription** (the "cloud" side) | The actual resources — AI models, servers, databases, storage. Roles here are **Owner / Contributor / Reader**, scoped to a subscription or a resource group. | A **scoped service principal** is fine here. |

**You should never give any tool — including me — "Global Administrator" or
full account access.** It's unnecessary and irreversible-risky. Everything I'd
help with lives on the **Azure subscription** side, where access is scoped,
role-limited, and revocable in one click. (This mirrors what we already do on
Google: the `claude-driver` service account has *only* `secretAccessor`, never
org-admin.)

---

## 1. What Azure offers us (mapped to what we actually build)

### A. Generative AI & media — directly powers the designer skill
- **Azure OpenAI** — `gpt-image-1` (images), `gpt-4o` (vision/review), **Sora 2** (video, preview). Same models we use today, billed to the Azure grant.
- **Azure AI Speech** — neural **Text-to-Speech** (hundreds of voices), **TTS-Avatar** (photorealistic talking presenters — a HeyGen-style engine), captioning, pronunciation.
- **Azure AI Translator** — localize scripts/copy → multilingual avatars + voiceover.
- **Azure AI Foundry model catalog** — FLUX (Black Forest Labs), Llama, Mistral, etc., if we want non-OpenAI models.
- **Azure AI Vision / Content Understanding** — OCR, image tagging, moderation.

### B. Hosting the websites & apps
- **Static Web Apps** — marketing sites / SPAs (AWARE, iHEARtest, OTCHealthMart fronts) with built-in CDN + CI from GitHub.
- **Container Apps** — serverless containers; ideal for APIs, **self-hosting n8n**, or **open-source lip-sync (MuseTalk) on GPU**.
- **App Service / Functions** — managed web apps + event-driven serverless.
- **AKS** — full Kubernetes if/when we outgrow the above.

### C. Data & storage
- **Blob Storage + Front Door/CDN** — store & globally serve generated media (avatars, video, music).
- **Cosmos DB / Azure SQL / Postgres Flexible Server** — app databases.
- **Azure Cache for Redis** — sessions, queues, rate-limit state.

### D. Automation & integration
- **Logic Apps** / **Functions** / **Event Grid** / **Service Bus** — the "n8n-style" glue, native to Azure.
- Self-hosted **n8n** on Container Apps — the scheduled-regeneration the designer skill references.

### E. Security, identity, compliance
- **Key Vault** — Azure's secret store (peer of GCP Secret Manager).
- **Entra ID** — SSO/login for our apps.
- **Microsoft Defender for Cloud** — posture management.
- **HIPAA/BAA** — Azure will sign a BAA; PHI workloads (MedReview) can run on
  Azure *if* configured on covered services. **The designer skill stays NON-PHI
  regardless** — no patient data ever touches generated assets.

### F. Compute for self-hosted AI
- **GPU VMs / Container Apps GPU** — run open-source lip-sync, image, or fine-tune
  jobs. $5k buys a lot of GPU hours here (the zero-marginal-cost avatar path).

---

## 2. Where the $5,000 grant stretches furthest

Rough priority for our use cases (spend the grant where it's highest-leverage):

1. **Azure OpenAI** image + vision calls — offload the designer skill's per-asset
   spend off direct-OpenAI credits. High volume, low unit cost.
2. **Azure AI Speech TTS-Avatar** — a consistent, reusable presenter for high-volume
   explainers (cheaper per clip than Veo for repetitive talking-head content).
3. **Hosting** (Static Web Apps / Container Apps) — small monthly cost, big utility.
4. **Sora 2 video** — premium, use selectively.
5. **GPU compute** — only if we commit to self-hosting open-source models.

---

## 3. How to give Claude *enough* access — safely

The right model is the Azure twin of our Google setup: a **service principal**
(a non-human identity) with a **scoped role**, whose credentials live in a
**vault**, not in chat.

### Recommended progression (least privilege first)

| Step | What you create | Role / scope | What it lets me do |
|---|---|---|---|
| 1. **Inventory** | A service principal | **Reader** on the subscription | Enumerate everything you have, audit it, and write you an exact "here's what's provisioned and what's idle" report. Read-only — cannot change or spend. |
| 2. **Build (scoped)** | Same principal (or a second) | **Contributor** on a single **dedicated resource group** (e.g. `rg-claude-designer`) | Create/configure AI + hosting resources *inside that one box* — nothing else in your account is touchable. |
| 3. **Secrets** | Store the principal's creds | In **GCP Secret Manager** (our existing vault) or **Azure Key Vault** | Auto-loaded at session start, like the GCP SA today. |

What I would **not** ask for and you should **not** grant: Owner at
subscription root, User Access Administrator, or anything in Entra ID. If a task
ever truly needs more, I'll tell you the *specific* role and *specific* scope and
let you decide — never a blanket grant.

### The catch (being straight with you)
A service principal gives me *authorization*, but this session also needs the
*tooling + network* to reach Azure (the `az` CLI / Azure SDK and outbound access
to `management.azure.com`). Today this environment has neither wired. So the
order of operations is:
1. **Now, zero access:** I act as your Azure strategist/expert (this doc, plus
   answering "can Azure do X?" and designing the architecture).
2. **Reader SP + tooling:** I inventory your actual subscription and give you a
   real audit.
3. **Contributor-on-RG + tooling:** I provision resources hands-on, you approve
   each meaningful step.

### Concretely, to create the Reader service principal (you, once)
In the Azure Portal (or Cloud Shell) signed in as the subscription owner:
```bash
# Cloud Shell (bash) — creates an app + service principal with READ-ONLY access
az ad sp create-for-rbac \
  --name "claude-designer-reader" \
  --role "Reader" \
  --scopes "/subscriptions/<YOUR-SUBSCRIPTION-ID>"
# Outputs appId, password, tenant — store these as secrets, do NOT paste in chat.
```
Then store the three values in our vault (you, as GCP org admin):
```bash
gcloud config set project otchealth-shared-prod
printf '%s' "<appId>"    | gcloud secrets create azure-sp-client-id     --data-file=-
printf '%s' "<password>" | gcloud secrets create azure-sp-client-secret --data-file=-
printf '%s' "<tenant>"   | gcloud secrets create azure-sp-tenant-id     --data-file=-
printf '%s' "<sub-id>"   | gcloud secrets create azure-subscription-id  --data-file=-
```

When those exist, tell me — I'll wire the fetch (same pattern as the
`azure-openai-*` secrets) and start the inventory.

---

## 4. Golden rules (pin these)
- Never grant **Global Administrator** or full Microsoft-account access to a tool.
- Prefer **Reader first**, then **Contributor on one resource group**.
- Keys live in a **vault**, never in chat or git.
- **PHI stays out** of the designer skill and the NON-PHI service principal.
- Every grant is **revocable** — `az ad sp delete` or rotate the secret.
