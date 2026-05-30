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
| `skills/designer/` | Creative-director skill — Claude drives icon / illustration / app-icon / App Store screenshot / video / voiceover generation. Brand-profile driven (works per project). Wraps OpenAI DALL·E 3 + GPT-image-1, Vertex AI Imagen 4 (GA) + Veo 2, ElevenLabs. |
| `setup/session-start.sh` | Idempotent installer: copies the skill into `~/.claude/skills/`, runs `npm install`, and writes `~/.designer/credentials.env` + the GCP SA key from environment secrets. |
| `setup/credentials.env.template` | Reference list of the env secrets the installer expects. |
| `.claude/settings.json` | SessionStart hook — runs the installer automatically when this repo is the project dir. |

## One-time setup

### 1. Create the repo and push (run locally)

```bash
# from the unpacked otchealth-claude-tools/ directory
git init -b main
git add .
git commit -m "Initial commit: designer skill + session installer"
gh repo create gbgolfmatt/otchealth-claude-tools --private --source=. --push
# (or create the empty repo in the GitHub UI, then:)
#   git remote add origin https://github.com/gbgolfmatt/otchealth-claude-tools.git
#   git push -u origin main
```

### 2. Add the secrets to each Claude Code environment

In the Claude Code web environment settings (per project, or a shared default),
add these **environment secrets**:

| Secret | Value |
|---|---|
| `OPENAI_API_KEY` | your `sk-proj-…` key |
| `ELEVENLABS_API_KEY` | your `sk_…` key |
| `GCP_CLAUDE_DRIVER_SA_JSON` | the **entire** JSON of the `claude-driver` SA key (from the Notion vault → "Google Cloud — Claude Driver SA") |

Optional: `GOOGLE_CLOUD_PROJECT`, `RECRAFT_API_KEY`, and the `VERTEX_DEFAULT_*`
model overrides.

### 3. Point each environment's setup script at the installer

Set the environment's setup/init script to:

```bash
git clone https://github.com/gbgolfmatt/otchealth-claude-tools /tmp/octools \
  2>/dev/null || (cd /tmp/octools && git pull --ff-only)
bash /tmp/octools/setup/session-start.sh
```

That's it. From then on, every Claude Code web session auto-installs the
designer skill and hydrates credentials — no manual steps.

## Using the designer skill

Once installed, just ask Claude in plain English. Trigger words: *design, icon,
logo, illustration, splash, hero image, App Store screenshot, preview video,
voiceover, social graphic, empty state.*

```
"Generate an app icon family for AWARE from the teal sound-wave mark"
"Make a hero illustration: older woman laughing in a restaurant, hearing aids visible"
"Create 5 App Store screenshots for iHEARtest with headlines"
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
- **Pre-GA models excluded.** Video uses Veo 2; Veo 3/3.1 are Preview. Imagen is
  the GA `imagen-4.0-generate-001`.
- **Cost-aware.** Every script supports `--dry-run` to print the estimated spend
  and exact API call without spending.
- **Imagen quota:** new GCP projects may need a Vertex AI quota bump for
  `imagen-4.0-generate-001` online predictions; the DALL·E 3 path works without it.
