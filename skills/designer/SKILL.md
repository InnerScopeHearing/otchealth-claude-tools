---
name: designer
description: Creative-director skill — Claude drives end-to-end visual asset generation across any project (icons, illustrations, app icons, App Store screenshots, video, voiceover). Brand-profile driven so the same skill produces on-brand assets for AWARE, iHEARtest, MedReview, OTCHealthMart, Companion, InnerEase, or any future project. Wraps OpenAI (DALL-E 3, GPT-image-1), Google Vertex AI (Imagen 4 GA, Veo 2), and ElevenLabs. Outputs land in the project's assets/ directory and are returned inline for Claude to display.
---

# Designer Skill — Claude as creative quarterback

## When to invoke

Invoke this skill whenever a project needs a visual or audio asset and the user hasn't pointed at a specific manual tool. Trigger words: "design," "generate," "icon," "illustration," "splash," "logo," "App Store screenshot," "preview video," "voiceover," "hero image," "social graphic," "empty state," "marketing asset."

## Compliance / scope rules (read first)

- **This skill operates in the NON-PHI ring only.** Default project is `otchealth-shared-prod`. NEVER point this skill at `otchealth-medreview-prod` or any PHI project.
- **No PHI in any generated asset, prompt, or metadata.** Generated content is brand/marketing only.
- **FourVault is OUTSIDE the OTCHealth org.** When generating for FourVault, the credentials.env must point at the personal Google Cloud project, not the company project. See `docs/gcp/ARCHITECTURE.md` in any AWARE-derived repo.
- **Pre-GA models are excluded:** Veo 3 and Veo 3.1 are Preview as of May 2026 and are not used here. Video defaults to Veo 2. Imagen 4 is GA (preview IDs retired Nov 30, 2025).

## What it does

| Need | Script | Backed by | Approx cost |
|---|---|---|---|
| Single illustration / hero image | `gen-image.mjs` | OpenAI DALL-E 3 (default) or Vertex Imagen 4 GA | $0.04-0.12 |
| Brand-consistent icon | `gen-image.mjs --kind icon` | OpenAI GPT-image-1 | $0.04 |
| Style-locked icon batch (20+ icons in matching aesthetic) | `gen-icon-batch.mjs` | GPT-image-1 + reference image conditioning | $0.04/icon |
| Empty-state illustration | `gen-image.mjs --kind empty-state` | DALL-E 3 | $0.08 |
| App icon family (1024 master + all iOS + Android sizes) | `gen-app-icon-family.mjs` | DALL-E 3 HD + sharp post-processing | $0.12 + free |
| App Store screenshot (device frame + headline overlay) | `compose-screenshot.mjs` | sharp + Imagen 4 for headline text rendering | $0.04 + free |
| AI video (App Preview, marketing, walkthrough) | `gen-video.mjs` | Google Vertex Veo 2 (Veo 3/3.1 excluded — Preview) | ~$0.35/sec |
| Voiceover for video | `gen-voiceover.mjs` | ElevenLabs (33M-char startup grant active) | $0.30/1000 chars |
| PNG → SVG vectorize | `vectorize.mjs` | Recraft API or local potrace | $0.04 or free |
| Optimize / format assets | `optimize-asset.mjs` | sharp (local, free) | $0 |

## Brand-profile resolution (project-agnostic)

When invoked from inside a project directory, the skill resolves the active brand in this order:

1. `$PWD/.designer/brand.json` (project-local profile)
2. `$PWD/BRAND.md` (parsed for color / typography blocks)
3. `~/.designer/brand-profiles/<project-name>.json` (named profile in home)
4. `~/.designer/brand-profiles/default.json` (fallback)

A brand profile defines color palette, typography, voice/tone, do-not-claim rules, and style references. See `brand-profiles/_schema.json` for the contract and `brand-profiles/_example-aware.json` for a working example.

## Credentials

Set these env vars (or paste into a one-time `~/.designer/credentials.env` file the scripts auto-load):

| Env var | Purpose |
|---|---|
| `OPENAI_API_KEY` | DALL-E 3, GPT-image-1, GPT-4 Vision (for asset review) |
| `OPENAI_ORG_ID` | optional, for multi-org accounts |
| `GOOGLE_APPLICATION_CREDENTIALS` | path to service account JSON for Vertex AI |
| `GOOGLE_CLOUD_PROJECT` | GCP project ID for Vertex AI |
| `ELEVENLABS_API_KEY` | voiceover generation |
| `RECRAFT_API_KEY` | optional, for vectorization (otherwise uses local potrace) |

Run `bash setup.sh` once per machine to install deps and validate credentials.

## Output convention

By default, generated assets land in `$PWD/assets/generated/<type>/<slug>.<ext>` where:
- `<type>` = icon, illustration, app-icon, store-screenshot, video, voiceover
- `<slug>` = human-readable name derived from prompt or explicit `--name`
- A sibling `.meta.json` file records the prompt, brand profile, cost, model, timestamp

Override with `--output <path>`. All scripts print the final path on stdout; Claude can `Read` it and display inline via `SendUserFile`.

## How Claude should use this (decision tree)

```
User asks for a visual asset
    │
    ├── Did they specify the asset class (icon, hero, video, etc.)?
    │   YES → run that script directly with the user's brief
    │   NO  → ask one clarifying question, then run
    │
    ├── Are credentials present (env vars set / setup.sh ran)?
    │   NO  → run setup.sh, then prompt user for keys via SendUserMessage
    │   YES → continue
    │
    ├── Is there an active brand profile for this directory?
    │   NO  → fall back to default, mention it to user
    │   YES → use it; lock palette / typography to the profile
    │
    ├── Generate
    │   - Print prompt being used (for traceability)
    │   - Call the API
    │   - Save asset + .meta.json
    │
    ├── Display result
    │   - Read the output file
    │   - SendUserFile with caption (asset path, cost, model)
    │   - Suggest iteration: "want to refine? batch variants? try different style?"
    │
    └── Optionally commit to the project's repo as a follow-up
```

## Iteration workflow

For high-stakes assets (app icon, hero illustration, App Store cover):
1. First call: generate 4 variants with `--variants 4`
2. Display all 4 inline via SendUserFile
3. User picks one or asks for refinement
4. Refine with `--seed <selected> --refine "<feedback>"` (uses image-to-image edit endpoint)
5. Iterate until approved

For low-stakes assets (empty states, hearing-aid tip icons, throwaway social posts):
1. Single generation, no variants
2. If user dislikes, re-roll with one tweak

## Cost-aware mode

Every script supports `--dry-run` which prints the estimated cost and the exact API call without spending. Use this when:
- User has tight credit budget
- Generating in bulk (>20 assets at once)
- User asks "how much will this cost?"

## Cross-project pattern

Same skill works from any project. Invocation examples:

```bash
# Inside ~/aware-aural-rehab/
node ~/.claude/skills/designer/scripts/gen-image.mjs \
  --prompt "older woman laughing in restaurant, hearing aids visible" \
  --kind illustration \
  --output assets/illustrations/onboarding-2.png

# Inside ~/medreview/
node ~/.claude/skills/designer/scripts/gen-icon-batch.mjs \
  --names "patient,clinician,encounter,note,chart,billing" \
  --style-ref existing-icon.svg

# Inside ~/otchealthmart/
node ~/.claude/skills/designer/scripts/compose-screenshot.mjs \
  --device iphone-15-pro-max \
  --screenshot www/checkout.png \
  --headline "Buy with confidence"
```

Brand profile is auto-detected per directory. No flag changes needed across projects.

## What this skill is NOT

- Not a replacement for a human designer on hero brand work (app icon final pick, brand-mark redesign, type system) — those still benefit from human eye
- Not a video editor (use Descript for trim / cut / arrange after generation)
- Not for live photography work (Veo 2 is text-to-video; no on-set production)
- Not a CI/CD pipeline — wire into n8n if you want scheduled regeneration
