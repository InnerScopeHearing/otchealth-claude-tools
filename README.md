# otchealth-claude-tools

Portable Claude tooling for the OTCHealth Inc. portfolio. Commit once here, and
every Claude Code (web) session across **any** project — AWARE, iHEARtest,
MedReview, OTCHealthMart, Companion, InnerEase — can install it on startup and
re-hydrate credentials from environment secrets.

> **Scope:** these tools operate in the **NON-PHI ring only**. The bundled GCP
> service account (`claude-driver@otchealth-shared-prod`) must never be granted
> on a PHI project (MedReview, B2B) or on FourVault.

## What's inside

| Path | What it is |
|---|---|
| `skills/designer/` | Creative-director skill — Claude drives icon / illustration / app-icon / App Store screenshot / video / **talking avatar** / voiceover / **music** / **sound-effects** generation, plus **GPT-4o art-director review**. Brand-profile driven (works per project). Wraps OpenAI DALL·E 3 + GPT-image-1 + GPT-4o Vision, Vertex AI Imagen 4 (GA) + Veo 3.1 (native audio + lip-sync), ElevenLabs (voice + music + SFX). |
| `setup/session-start.sh` | Idempotent installer: copies the skill into `~/.claude/skills/`, runs `npm install`, writes the GCP SA key, then fetches API keys from Secret Manager into `~/.designer/credentials.env`. |
| `setup/fetch-secrets.mjs` | Pulls `openai-api-key` / `elevenlabs-api-key` (and optional `recraft-api-key`) from GCP Secret Manager using the SA key. No gcloud CLI needed. |
| `setup/credentials.env.template` | Reference for the one env secret + the Secret Manager secret IDs. |
| `.claude/settings.json` | SessionStart hook — runs the installer automatically when this repo is the project dir. |

## Secrets model — ONE env secret

Only **`GCP_CLAUDE_DRIVER_SA_JSON`** (the SA key) is set in the Claude Code
environment. Everything else lives in **GCP Secret Manager** and is fetched at
session start using that SA (which already holds `roles/secretmanager.secretAccessor`).
Nothing sensitive ever touches git or the env config beyond that one key.

### Create the Secret Manager secrets (once, as org admin)

The SA can *read* secrets but not *create* them, so create these once:

```bash
gcloud config set project otchealth-shared-prod
printf '%s' "<PASTE-OPENAI-KEY>"      | gcloud secrets create openai-api-key     --data-file=-
printf '%s' "<PASTE-ELEVENLABS-KEY>"  | gcloud secrets create elevenlabs-api-key --data-file=-
# optional:
printf '%s' "<PASTE-RECRAFT-KEY>"     | gcloud secrets create recraft-api-key    --data-file=-
```

To rotate a key later, add a new version (no code change, picks up `latest`):

```bash
printf '%s' "<PASTE-NEW-KEY>" | gcloud secrets versions add openai-api-key --data-file=-
```

#### Optional: Azure ($5k grant) — scoped resource keys only

To let the skill spend Azure credits, create **two scoped resources** in the
Azure Portal — an **Azure OpenAI** resource (with `gpt-image-1` and `gpt-4o`
*deployments*) and an **Azure AI Speech** resource — then store their keys here.
**Do not share Microsoft account or tenant-admin credentials**; only these
resource keys are needed:

```bash
printf '%s' "<AZURE-OPENAI-ENDPOINT>"  | gcloud secrets create azure-openai-endpoint          --data-file=-
printf '%s' "<AZURE-OPENAI-KEY>"       | gcloud secrets create azure-openai-key               --data-file=-
printf '%s' "<IMAGE-DEPLOYMENT-NAME>"  | gcloud secrets create azure-openai-image-deployment  --data-file=-
printf '%s' "<VISION-DEPLOYMENT-NAME>" | gcloud secrets create azure-openai-vision-deployment --data-file=-
printf '%s' "<AZURE-SPEECH-KEY>"       | gcloud secrets create azure-speech-key               --data-file=-
printf '%s' "<AZURE-SPEECH-REGION>"    | gcloud secrets create azure-speech-region            --data-file=-
# optional override (defaults to 2025-04-01-preview):
printf '%s' "2025-04-01-preview"       | gcloud secrets create azure-openai-api-version        --data-file=-
```

Azure OpenAI is now live and is the default provider when configured (it spends the Azure grant). See `skills/designer/SKILL.md` and `skills/designer/RUNTIME-NOTES.md`. The skill falls back to direct OpenAI / Vertex when Azure is not configured.

## One-time setup

### 1. Create the repo and push (run locally)

```bash
# from the unpacked otchealth-claude-tools/ directory
git init -b main
git add .
git commit -m "Initial commit: designer skill + session installer"
gh repo create InnerScopeHearing/otchealth-claude-tools --private --source=. --push
# (or create the empty repo in the GitHub UI, then:)
#   git remote add origin https://github.com/InnerScopeHearing/otchealth-claude-tools.git
#   git push -u origin main
```

### 2. Add the ONE secret to each Claude Code environment

In the Claude Code web environment settings (per project, or a shared default),
add a single **environment secret**:

| Secret | Value |
|---|---|
| `GCP_CLAUDE_DRIVER_SA_JSON` | the **entire** JSON of the `claude-driver` SA key (from the Notion vault → "Google Cloud — Claude Driver SA") |

The OpenAI + ElevenLabs keys are NOT set here — they're pulled from Secret
Manager at session start (see "Create the Secret Manager secrets" above).
Optional env overrides: `GOOGLE_CLOUD_PROJECT`, `VERTEX_DEFAULT_*`.

### 3. Point each environment's setup script at the installer

Set the environment's setup/init script to (force a fresh clone every start so
a warm-container cache can never ship stale skills):

```bash
rm -rf /tmp/octools 2>/dev/null
git clone --depth 1 https://github.com/InnerScopeHearing/otchealth-claude-tools /tmp/octools
bash /tmp/octools/setup/session-start.sh
```

> The older `git clone ... || git pull --ff-only` form can leave a stale
> `/tmp/octools` if the pull ever fails to fast-forward — symptom: a session
> reports missing scripts (e.g. no `healthcheck.mjs`). The force-fresh form
> above avoids that; `session-start.sh` also self-heals a `/tmp/*` clone to
> `origin/main` as a backstop.

That's it. From then on, every Claude Code web session auto-installs the
designer skill and hydrates credentials — no manual steps.

## Using the designer skill

Once installed, just ask Claude in plain English. Trigger words: *design, icon,
logo, illustration, splash, hero image, App Store screenshot, preview video,
talking avatar, presenter, voiceover, music, sound effect, social graphic,
empty state.*

```
"Generate an app icon family for AWARE from the teal sound-wave mark"
"Make a hero illustration: older woman laughing in a restaurant, hearing aids visible"
"Create 5 App Store screenshots for iHEARtest with headlines"
"Make a 30-second talking-avatar intro: our audiologist explains the hearing check"
"Generate a calm ambient music bed and a soft success chime for the app"
"Review this hero image against the AWARE brand and refine it"
"Estimate the cost to generate 20 tip icons first"   # runs --dry-run
```

The skill auto-detects the brand profile from the current project directory
(`.designer/brand.json` → `BRAND.md` → named profile → default), locks palette
and typography, picks the right model, saves to `assets/generated/…`, and writes
a sibling `.meta.json` (prompt, model, cost, timestamp).

## Notes & limits

- **Claude Code only.** Filesystem skills (`~/.claude/skills/`) are a Claude Code
  feature. Claude Chat (claude.ai) uses a separate Skills upload that runs in a
  sandbox without these credentials — this repo does not target Claude Chat.
- **Video + avatars use Veo 3.1** (`veo-3.1-generate-001`) for native audio +
  lip-synced dialogue; Veo 2 stays available for plain silent B-roll. Imagen is
  the GA `imagen-4.0-generate-001`. Synthetic avatars only — never replicate a
  real, identifiable person without consent, and keep `voice.do_not` claims out
  of spoken scripts.
- **Cost-aware.** Every script supports `--dry-run` to print the estimated spend
  and exact API call without spending.
- **Imagen quota:** new GCP projects may need a Vertex AI quota bump for
  `imagen-4.0-generate-001` online predictions; the DALL·E 3 path works without it.
