# designer — Claude as creative quarterback

Project-agnostic visual asset generation. The same skill produces on-brand
icons, illustrations, app icons, App Store screenshots, video, and voiceover
for AWARE, iHEARtest, MedReview, OTCHealthMart, FourVault, or any future
project. Brand is auto-detected per directory.

Backed by **OpenAI** (DALL-E 3, GPT-image-1, GPT-4 Vision), **Google Vertex
AI** (Imagen 3, Veo 2), and **ElevenLabs**. Sharp + potrace handle local
post-processing.

## First-time setup (once per machine)

```bash
bash ~/.claude/skills/designer/setup.sh
```

Installs `sharp`, writes a stub `~/.designer/credentials.env`. Edit that file
(or export env vars) with at minimum:

| Var | Get it from |
|---|---|
| `OPENAI_API_KEY` | platform.openai.com → API keys |
| `GOOGLE_CLOUD_PROJECT` | console.cloud.google.com → top-bar project selector |
| `GOOGLE_APPLICATION_CREDENTIALS` | path to a service-account JSON with the `Vertex AI User` role |
| `ELEVENLABS_API_KEY` | elevenlabs.io → profile → API key |
| `RECRAFT_API_KEY` | optional; falls back to local potrace if omitted |

Verify with `bash setup.sh` again — it prints a `✓ / ·` checklist.

## Per-project brand profile

The skill looks up the active brand in this order:

1. `$PWD/.designer/brand.json`
2. `$PWD/brand.json`
3. `~/.designer/brand-profiles/<basename-of-pwd>.json`
4. `~/.claude/skills/designer/brand-profiles/default.json`

To wire a new project: copy `brand-profiles/_example-aware.json` into
`<project-root>/.designer/brand.json` and edit. Schema lives at
`brand-profiles/_schema.json`.

## Generate things

```bash
# Single illustration (DALL-E 3, ~$0.04)
node ~/.claude/skills/designer/scripts/gen-image.mjs \
  --prompt "older woman laughing in a busy restaurant, hearing aids visible" \
  --kind illustration \
  --output assets/illustrations/restaurant-hero.png

# 20-icon batch with style locking (~$0.80)
node ~/.claude/skills/designer/scripts/gen-icon-batch.mjs \
  --names "search,settings,home,profile,bell,calendar,chart,trophy,gear,headphones,brain,ear,target,streak,share,family,microphone,wave,clock,book" \
  --style-ref assets/icons/existing-style.png

# Full iOS + Android + watchOS app icon family from one master (~$0.12)
node ~/.claude/skills/designer/scripts/gen-app-icon-family.mjs \
  --prompt "audiogram curve mark, 6 white dots, teal background, premium"

# 8-second App Preview video via Veo 2 (~$2.80)
node ~/.claude/skills/designer/scripts/gen-video.mjs \
  --prompt "cinematic intro: hands picking up AirPods, soft natural light, calm warm tone" \
  --duration 8 --ratio 9:16

# Voiceover via ElevenLabs (~$0.03 for 100 chars)
node ~/.claude/skills/designer/scripts/gen-voiceover.mjs \
  --text "Most hearing aids amplify sound. AWARE trains your brain to understand it."

# Compose an App Store screenshot — capture + device frame + headline (free)
node ~/.claude/skills/designer/scripts/compose-screenshot.mjs \
  --capture marketing/raw/01-home.png \
  --device iphone-15-pro-max \
  --headline "Hear better, every day."

# PNG → SVG (Recraft or local potrace)
node ~/.claude/skills/designer/scripts/vectorize.mjs --input icon.png

# Compress / convert (no API spend)
node ~/.claude/skills/designer/scripts/optimize-asset.mjs \
  --input hero.png --format webp --width 1024 --quality 82
```

Every script supports `--dry-run` to print the prompt + estimated cost
without spending credits.

## Output convention

Generated files land at:

```
$PWD/<brand.output_root>/<type>/<slug>.<ext>
$PWD/<brand.output_root>/<type>/<slug>.meta.json
```

`<brand.output_root>` defaults to `assets/generated`. Override per project.
Every asset has a sibling `.meta.json` recording the prompt, model, cost,
brand profile, timestamp — so 6 months later you know exactly how an asset
came to be.

## Cost ceilings

Pricing reflects the major vendors' published rates as of Jan 2026:

| Tool | Per unit |
|---|---|
| DALL-E 3 (standard) | $0.04 / image |
| DALL-E 3 (HD 1024) | $0.12 / image |
| GPT-image-1 | $0.04 / image |
| Imagen 3 (Vertex) | $0.03 / image |
| Veo 2 (Vertex) | ~$0.35 / second |
| ElevenLabs Creator | $0.30 / 1000 chars |
| Recraft vectorize | $0.04 / image |
| Sharp post-processing | free |

A complete asset refresh for one app (60 illustrations, 30 icons, full app
icon family, App Preview video, 5 store screenshots) lands in the
**$60-$80** range. With $1500 OpenAI + $1500 Google Cloud credits, that's
~20 full refreshes — enough for years of iteration.

## Files

```
~/.claude/skills/designer/
├── SKILL.md                          ← Claude reads this to know when/how to invoke
├── README.md                         ← human docs (this file)
├── setup.sh                          ← one-time install + credentials check
├── package.json
├── brand-profiles/
│   ├── _schema.json                  ← brand profile contract
│   ├── default.json                  ← fallback profile
│   └── _example-aware.json           ← reference example
├── scripts/
│   ├── _lib.mjs                      ← shared utilities (creds, brand resolution, output paths)
│   ├── gen-image.mjs                 ← illustrations + icons + hero (DALL-E 3 or Imagen 3)
│   ├── gen-icon-batch.mjs            ← style-locked icon set
│   ├── gen-app-icon-family.mjs       ← 1024 master + all iOS/Android/watchOS sizes
│   ├── gen-video.mjs                 ← Veo 2 video (text-to-video or image-to-video)
│   ├── gen-voiceover.mjs             ← ElevenLabs voiceover
│   ├── compose-screenshot.mjs        ← device-framed App Store screenshot
│   ├── vectorize.mjs                 ← PNG → SVG (Recraft or potrace)
│   └── optimize-asset.mjs            ← sharp-based local compression / format conversion
└── templates/                        ← reusable prompt fragments (per asset class)
```

## How Claude uses this

When invoked in chat, Claude:

1. **Resolves the brand** for the current project (or asks if no profile exists yet)
2. **Runs `--dry-run` first** if the asset is high-stakes or the user hasn't said "go"
3. **Generates** — calls the right script with brand-aware prompt prefix
4. **Reads the output file** and displays it inline (SendUserFile or markdown image)
5. **Offers iteration** — variants, refinements, style swaps
6. **Optionally commits** to the project repo as a follow-up commit

For batch work (replace all emoji icons in an app, regenerate all
empty-states, prep weekly content), Claude orchestrates the loop and
reports totals.

## n8n integration (optional)

Each script can be invoked from an n8n workflow node — they're stateless
and read credentials from env vars (which n8n can inject). Recommended
workflows:

1. **Daily asset health check**: Sentry-driven detect 404s → regenerate
   missing asset → open PR
2. **Weekly content batch**: cron → regenerate AWARE Daily card
   backgrounds + hearing-aid tip illustrations → commit
3. **App Store metadata watcher**: copy change → recompose all
   screenshots with new headline → upload to App Store Connect via API

n8n nodes for these live as separate workflow exports — ask Claude to
build them when needed.
