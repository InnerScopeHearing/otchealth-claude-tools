# OTCHealth Platform — wiring and deployment

How every service, token, and grant we hold connects into one system, how it
deploys across **all** Claude Code Cloud environments and GitHub repos, where the
future plans plug in, and how to extend the assist into normal Claude chat.

Read `dream-team/` for the agent architecture and `CLAUDE.md` for the standing
rules. This file is the operational layer: secrets, installer, CI, rollout.

---

## 1. The model in one picture

```
  ONE env secret per Claude Code environment
     GCP_CLAUDE_DRIVER_SA_JSON  (non-PHI claude-driver SA)
                │
                ▼
  setup/session-start.sh  (runs at every session start, every repo)
     ├─ installs the designer skill        -> ~/.claude/skills/designer
     ├─ installs the Dream Team agents      -> ~/.claude/agents/*.md
     └─ runs fetch-secrets.mjs (SA -> GCP Secret Manager)
                │  pulls every provisioned token
                ▼
        ~/.designer/credentials.env   (OpenAI, ElevenLabs, Vertex, Azure,
            Depot, PostHog, Miro, Make, Daytona, Greptile, Replicate, n8n, Sentry)
                │
   tools + agents + skills read it ──► do work in the session
                │
  per-repo app.manifest.json  = what is wired for THAT app (ring, services, gates)
  MCP (Notion vault · GitHub · n8n) = the shared nervous system, already connected
```

One secret bootstraps everything; everything else is fetched, never pasted. Add a
service once here and it appears in every session in every repo automatically.

## 2. Two registries, kept in sync

| Registry | Role | Who reads it |
|---|---|---|
| **Notion "API Tokens & Credentials"** | Human-readable record: what each token is, its grant, its decision status, rotation flag | You, future sessions, chat |
| **GCP Secret Manager** (`otchealth-shared-prod`) | Machine runtime: what `session-start.sh` actually hydrates | The installer, in every session |

**The current gap:** every new token this cycle (Depot, PostHog, Miro, Make,
Daytona, Greptile, Amplitude/Mixpanel) went into Notion but **not** into Secret
Manager, so sessions can't use them yet. Closing that gap is step 1 of deploy.

## 3. Service registry

Ring is **non-PHI** for everything in the shared SA path. PHI services
(MedReview) use a separate secret store and a signed BAA, never this SA.

| Service | Grant | Secret id (SM) | Env var | Consumer | Lane decision |
|---|---|---|---|---|---|
| OpenAI | credits | `openai-api-key` | `OPENAI_API_KEY` | designer, Sora | live |
| Vertex | — | (SA) | `GOOGLE_APPLICATION_CREDENTIALS` | Imagen/Veo | live |
| ElevenLabs | 33M chars | `elevenlabs-api-key` | `ELEVENLABS_API_KEY` | voice/music/SFX | live |
| Azure | $5k | `azure-*` | `AZURE_*` | OpenAI/Speech; **n8n self-host target** | additive |
| Depot | $5k | `depot-token` | `DEPOT_TOKEN` | GitHub Actions runners, Docker | **build/CI lane** |
| PostHog | $50k | `posthog-personal-api-key` | `POSTHOG_PERSONAL_API_KEY` | telemetry-wiring, Growth/Medic | **analytics lane (the one)** |
| Miro | 3 seats | `miro-token` | `MIRO_TOKEN` | diagrammer | diagram/wireframe lane |
| Make | $1.5k | `make-api-token` | `MAKE_API_TOKEN` | non-PHI automation only | **n8n is prod; Make = sandbox** |
| n8n | Cloud | `n8n-api-key` | `N8N_API_KEY` | automation engine + MCP | **prod automation** |
| Daytona | $10k | `daytona-api-key` | `DAYTONA_API_KEY` | parallel-agent rollout | **sandbox lane** |
| Greptile | — | `greptile-token` | `GREPTILE_TOKEN` | Guardian second-opinion review | review |
| Replicate | $5 | `replicate-api-token` | `REPLICATE_API_TOKEN` | avatar render fallback | fallback |
| Sentry | — | `sentry-auth-token` | `SENTRY_AUTH_TOKEN` | Medic, release health, Seer | **errors/crash lane** |
| Cloudflare R2 | — | (avatar-pipeline env) | `R2_*` | avatar storage | storage |
| Mixpanel / Amplitude | free / discount | — (banked) | — | none | **declined: analytics lane is PostHog** |
| Datadog | pending | — (banked) | — | none yet | **hold for backend scale / PHI backend** |
| RevenueCat / Customer.io / Codemagic | — | per-app | per-app | monetization / campaigns / iOS builds | live |

Nothing is orphaned and nothing double-fills a lane. The "declined/banked" rows
are deliberate: analytics is a single-platform decision (PostHog), so other
analytics grants are recorded but not instrumented.

## 4. Deploy NOW — the runbook (across all environments + repos)

**Step 1. Promote vault tokens into Secret Manager (org admin; the SA can read
but not create).** For each provisioned service:

```bash
gcloud config set project otchealth-shared-prod
printf '%s' "<DEPOT_TOKEN>"        | gcloud secrets create depot-token              --data-file=-
printf '%s' "4dl4ww0nk4"           | gcloud secrets create depot-project-id         --data-file=-
printf '%s' "<POSTHOG_PHX_KEY>"    | gcloud secrets create posthog-personal-api-key --data-file=-
printf '%s' "https://us.posthog.com" | gcloud secrets create posthog-host           --data-file=-
printf '%s' "<MIRO_TOKEN>"         | gcloud secrets create miro-token               --data-file=-
printf '%s' "<MAKE_TOKEN>"         | gcloud secrets create make-api-token           --data-file=-
printf '%s' "<DAYTONA_KEY>"        | gcloud secrets create daytona-api-key          --data-file=-
printf '%s' "https://app.daytona.io/api" | gcloud secrets create daytona-api-url    --data-file=-
printf '%s' "<GREPTILE_TOKEN>"     | gcloud secrets create greptile-token           --data-file=-
printf '%s' "<REPLICATE_TOKEN>"    | gcloud secrets create replicate-api-token      --data-file=-
# rotate later with: gcloud secrets versions add <id> --data-file=-
```
(Values are in the Notion vault. `fetch-secrets.mjs` already lists all these ids,
so once created they hydrate automatically, no code change.)

**Step 2. Every OTCHealth Claude Code environment gets the same two things:**
- the ONE env secret `GCP_CLAUDE_DRIVER_SA_JSON`, and
- the setup/init script:
  ```bash
  rm -rf /tmp/octools 2>/dev/null
  git clone --depth 1 https://github.com/gbgolfmatt/otchealth-claude-tools /tmp/octools
  bash /tmp/octools/setup/session-start.sh
  ```
Set this once per environment (or on a shared default). From then on every
session in every repo auto-installs the skill + the Dream Team agents + all creds.

**Step 3. The installer does the rest (already wired).** `session-start.sh` now
installs `dream-team/agents/*.md` to `~/.claude/agents` and appends every
provisioned service token to `~/.designer/credentials.env`.

**Step 4. GitHub Actions secrets (for CI-time services like Depot).** Set repo/org
secrets via the GitHub API (PAT + PyNaCl sealed-box, the method already proven for
the avatar workflows): `DEPOT_TOKEN`, `DEPOT_PROJECT_ID`, plus any per-repo
service keys. Then CI swaps `runs-on: ubuntu-latest` for Depot runners.

**Step 5. Fan out across the portfolio (Daytona).** One Coach play opens an "adopt
the platform" PR in each repo at once: drop in `app.manifest.json`, the dependency
cooldown configs, the web-first test scaffold, and point the env setup at the
installer. Greptile + Guardian review each; you merge the sweep.

## 5. Per-service deployment notes

- **Depot:** swap `runs-on` to Depot runners in each workflow; add Docker build
  cache for the avatar image + Cloud Run service images. macOS/GPU runners are an
  evaluate-later option (iOS stays on Codemagic for now).
- **PostHog:** the `phx_` key (management) hydrates here; each app's SDK uses its
  own `phc_` project key. Non-PHI apps run on the $50k now; MedReview waits on the
  BAA (Boost) decision. Replay masks on-device.
- **Miro:** `diagrammer` renders artifacts to boards (portfolio, n8n map, Dream
  Team). Token hydrated for any session.
- **n8n vs Make:** n8n is the production engine (and an MCP server); Make is a
  non-PHI sandbox for net-new low-frequency automation only.
- **Daytona:** the parallel-agent rollout engine for step 5; not for GPU/ML.

## 6. Future plans — the triggers that move them

| Plan | Trigger to act | Lands as |
|---|---|---|
| **n8n self-host on Azure** | prod executions ~8-10k/mo OR first PHI flow live | compliant + unlimited automation |
| **PostHog BAA (Boost)** | MedReview instrumenting PHI | single-BAA analytics for PHI app |
| **Datadog** | backend services at scale OR PHI backend live | infra/APM/log observability |
| **On-device LLM** | Companion assistant build | `@ionic/capacitor-local-llm` |
| **Dream Team relay live** | first real feature through Coach | Architect->...->Release |
| **Depot macOS/GPU** | iOS CI cost review / avatar GPU need | second cloud-macOS + GPU render |

Each is pre-decided so we switch once, at the right moment, for the right reason.

## 7. Extending the assist into normal Claude chat sessions

Claude Code (filesystem skills + the SA-hydrated creds) is the credentialed tier.
Claude chat (claude.ai) cannot hold the GCP SA or tokens, so it gets a **knowledge
+ MCP** tier, not local credentials:

1. **Connect the same MCP servers to claude.ai** (custom connectors): Notion (the
   vault + business objectives + run log), GitHub, and n8n. Chat can then read the
   registry, browse repos, and trigger automations, auth lives server-side in the
   connector, no secret in the chat.
2. **Create a claude.ai Project "OTCHealth Ops"** with `CLAUDE.md` as the custom
   instructions and this `PLATFORM.md` + the decision records as project knowledge.
   Every chat session then shares the standing context (ring rules, lane
   decisions, host facts) without re-explaining.
3. **Portable skills for chat** where they can run without the SA: package a
   light, prompt-token version of small skills (e.g. a Miro `diagrammer` that takes
   a user-supplied token). Credentialed generation (designer/Vertex/avatars) stays
   in Claude Code by design.

**The hard boundary:** never paste the GCP SA or any service token into a chat
window. Chat assists through MCP (auth held by the connector) and shared
knowledge; Claude Code does the credentialed work. Same PHI ring applies to both.

## 8. Guardrails (enforced, not advisory)

- **Ring:** the shared SA + this credential path are **non-PHI only**. PHI services
  use a separate store + BAA. Guardian audits every repo's `app.manifest.ring`.
- **One lane per job:** analytics = PostHog; automation = n8n (Make sandbox);
  build/CI = Depot; sandboxes = Daytona; errors = Sentry; diagrams = Miro. New
  grants that duplicate a filled lane are banked, not instrumented.
- **Secrets:** one env secret, everything else fetched. Tokens in chat get vaulted
  and flagged. No secret in git, ever.
