---
name: designer
description: Creative-director skill — Claude drives end-to-end visual asset generation across any project (icons, illustrations, app icons, App Store screenshots, video, voiceover). Brand-profile driven so the same skill produces on-brand assets for AWARE, iHEARtest, MedReview, OTCHealthMart, Companion, InnerEase, or any future project. Wraps OpenAI (GPT-image-1, DALL-E 3), Google Vertex AI (Imagen 4 GA, Veo 2), and ElevenLabs. Outputs land in the project's assets/ directory and are returned inline for Claude to display.
---

# Designer Skill — Claude as creative quarterback

## When to invoke

Invoke this skill whenever a project needs a visual or audio asset and the user hasn't pointed at a specific manual tool. Trigger words: "design," "generate," "icon," "illustration," "splash," "logo," "App Store screenshot," "preview video," "voiceover," "hero image," "social graphic," "empty state," "marketing asset."

## Provider defaults — use the proven path (read first)

These run on credits that are **live today**; default to them and the skill just works:
- **Images / icons / vision review:** direct **OpenAI** (`gpt-image-1`, `gpt-4o`) — the default. Don't pass `--provider azure`.
- **Video:** direct **OpenAI Sora 2** (`gen-video.mjs`, default engine) — validated live, plenty of OpenAI credits; auto-falls-back to Veo if Sora is ever unavailable. **Talking avatars:** **Vertex Veo 3.1** (`gen-avatar.mjs`) — validated live.
- **Voice / music / SFX:** **ElevenLabs** — live.
- **Photoreal fixed-presenter avatar:** **Azure TTS-Avatar** (`gen-avatar.mjs --engine azure`) — validated live and fine to use.

**Azure OpenAI is now the DEFAULT when configured** (spends the Microsoft for Startups Azure grant instead of direct-OpenAI/Vertex credits). The `gpt-image-1`, `gpt-4o`, and `sora-2` deployments are live. The scripts auto-route to Azure when `AZURE_OPENAI_API_KEY` plus the matching deployment env var (`AZURE_OPENAI_IMAGE_DEPLOYMENT` / `AZURE_OPENAI_VISION_DEPLOYMENT` / `AZURE_OPENAI_VIDEO_DEPLOYMENT`) are set; otherwise they fall back to direct OpenAI / Vertex. Override per call with `--provider openai` or `--engine openai|veo`. Configure the Azure values from the private Notion vault "Azure OpenAI" entry; do not hardcode them here.

## Compliance / scope rules (read first)

- **This skill operates in the NON-PHI ring only.** Default project is `otchealth-shared-prod`. NEVER point this skill at `otchealth-medreview-prod` or any PHI project.
- **No PHI in any generated asset, prompt, or metadata.** Generated content is brand/marketing only.
- **FourVault is OUTSIDE the OTCHealth org.** When generating for FourVault, the credentials.env must point at the personal Google Cloud project, not the company project. See `docs/gcp/ARCHITECTURE.md` in any AWARE-derived repo.
- **Video / avatar models:** Direct **OpenAI Sora 2** is the default video engine (`gen-video.mjs`). **Veo 3.1** powers talking avatars (`gen-avatar.mjs`) and is the video fallback / alternate (`--engine veo`, native lip-synced audio); Veo 2 via `--model veo-2.0-generate-001` for plain silent B-roll. Imagen 4 is GA (preview IDs retired Nov 30, 2025).
- **Avatars are synthetic, not real people.** Never generate an avatar resembling a real, identifiable person without their consent. No PHI, no implied medical credentials the brand doesn't hold, and keep `voice.do_not` claims out of any spoken script.

## What it does

| Need | Script | Backed by | Approx cost |
|---|---|---|---|
| Single illustration / hero image | `gen-image.mjs` | OpenAI GPT-image-1 (default) or Vertex Imagen 4 GA | $0.04-0.12 |
| Brand-consistent icon | `gen-image.mjs --kind icon` | OpenAI GPT-image-1 | $0.04 |
| Style-locked icon batch (20+ icons in matching aesthetic) | `gen-icon-batch.mjs` | GPT-image-1 + reference image conditioning | $0.04/icon |
| Empty-state illustration | `gen-image.mjs --kind empty-state` | GPT-image-1 | $0.04 |
| App icon family (1024 master + all iOS + Android sizes) | `gen-app-icon-family.mjs` | DALL-E 3 HD + sharp post-processing | $0.12 + free |
| App Store screenshot (device frame + headline overlay) | `compose-screenshot.mjs` | sharp + Imagen 4 for headline text rendering | $0.04 + free |
| AI video (App Preview, marketing, walkthrough) | `gen-video.mjs` | OpenAI Sora 2 (default) · Veo 3.1 (`--engine veo`) · Azure Sora (`--engine azure`) | ~$0.10/sec Sora · ~$0.50/sec Veo |
| **Realistic AI talking avatar** (presenter reads a script, native lip-sync) | `gen-avatar.mjs` | Google Vertex Veo 3.1 (text- or image-to-avatar) | ~$0.75/sec ($0.40/sec on `-fast`) |
| Voiceover for video | `gen-voiceover.mjs` | ElevenLabs (33M-char startup grant active) | $0.30/1000 chars |
| **Background music / underscore** (app ambience, video bed, intro) | `gen-music.mjs` | ElevenLabs Music | ~$0.06/10s (grant) |
| **Sound effects** (UI chime, notification, stinger, transition) | `gen-sfx.mjs` | ElevenLabs Sound Effects | ~$0.02 each (grant) |
| **Art-director review** (brand-fit critique + refined prompt) | `review-asset.mjs` | OpenAI GPT-4o Vision | ~$0.01 each |
| **$10M curation** (judge a SET head-to-head, pick the winner) | `art-director.mjs` | OpenAI GPT-4o Vision | ~$0.02 each |
| **$10M design loop** (generate N → judge → winner, one command) | `art-direct.mjs` | gen-image + art-director | gen cost + ~$0.02 |
| PNG → SVG vectorize | `vectorize.mjs` | Recraft API or local potrace | $0.04 or free |
| Optimize / format assets | `optimize-asset.mjs` | sharp (local, free) | $0 |
| Health-check all credentials / APIs | `healthcheck.mjs` | every provider (auth-only probes) | $0 |

## Full creative stack — pick the best engine per task

The handcuffs are off: route every job to whichever model on our credits
produces the best result. The menu, by medium:

- **Stills / icons / hero art** — OpenAI **GPT-image-1** (default, best instruction-following), **DALL-E 3 HD** (app-icon master), Vertex **Imagen 4 GA** (`imagen4` / `imagen4-ultra` / `imagen4-fast`; best in-image text rendering for screenshot headlines). All via `gen-image.mjs --model …`.
- **Video / motion / animated loops** — direct **OpenAI Sora 2** (`gen-video.mjs`, default; `--sora-model sora-2-pro` for higher quality); **Veo 3.1** via `--engine veo` (native audio + lip-sync, text- or image-to-video, `--seed-image`); **Veo 2** for plain silent B-roll; **Azure Sora** via `--engine azure` (spends the Azure grant, pending quota). Sora is the default because we have ample OpenAI credits; it auto-falls-back to Veo on failure.
- **Talking avatars / presenters** — two engines: Vertex **Veo 3.1** (default, cinematic, generative) via `gen-avatar.mjs`; or Azure **AI Speech TTS-Avatar** via `--engine azure` (a fixed, consistent enterprise cast — Lisa/Max/Meg — ideal for high-volume identical explainers, on the Azure grant). Reusable on-brand presenter defined in `brand.avatar` (and `brand.avatar.azure`).
- **Voice / narration** — ElevenLabs (`gen-voiceover.mjs`), always on the latest **`eleven_v3`** model. **Every voice in the account is available** (premade and cloned) — pass any `--voice-id` (e.g. Sarah `EXAVITQu4vr4xnSDxMaL`, or list voices via `GET https://api.elevenlabs.io/v1/voices`). Per-project default via `brand.voiceover_default_voice_id`; do not assume a single fixed voice. 33M-char grant active.
- **Music** — ElevenLabs Music via `gen-music.mjs` (instrumental beds by default, `--vocal` for songs).
- **Sound design** — ElevenLabs Sound Effects via `gen-sfx.mjs` (UI chimes, notifications, stingers).
- **Quality control** — `review-asset.mjs` runs GPT-4o Vision as an art director: scores brand fit, flags `do_not` violations, and returns a refined prompt to regenerate from.
- **The $10M design system** — two scripts make "make it look like a $10 million app" a repeatable loop instead of luck:
  - `art-director.mjs --dir <folder>` (or `--images a,b,c`) judges a SET of candidates head to head against a fixed 6-dimension $10M rubric (finish/polish .25, cohesion .20, composition .18, premium_feel .17, on_brand .12, character_accuracy .08), computes a deterministic 0-100 "ten_million_score", ranks them, and picks a winner with per-image fix notes. Use it to auto-cull a batch down to the best one. (review-asset = ONE image vs brand; art-director = MANY images ranked.)
  - `art-direct.mjs --brief "..." --intent "..." --variants N [--rounds R]` is the whole loop in one command: generate N candidates (gen-image), judge them (art-director), keep the winner, and on `--rounds 2+` fold the winner's fix notes back into the brief for another pass. Output lands at `<workdir>/<name>-WINNER.png`. This is the default way to produce any flagship hero/splash asset. PROVEN: produced FourVault's splash hero at 95/100 from a single brief.
- **Vectors / cleanup** — `vectorize.mjs` (Recraft or local potrace), `optimize-asset.mjs` (sharp, free), `compose-screenshot.mjs` (device frames + headline overlay).
- **Long-form lip-synced presenter video (real presenter + your ElevenLabs voice)** — NOT this skill. Use the sibling **`avatar-pipeline/`** in this repo: a cloud pipeline (GitHub Actions, GPU on Replicate or Azure) that relip-syncs a short presenter base video to a full script in your own ElevenLabs voice via LatentSync/MuseTalk/SadTalker. Trigger the `avatar-render` workflow (phone-friendly) or `python avatar-pipeline/quick_render.py`. The designer `gen-avatar.mjs` here is for short *generative* talking heads (Veo / Azure TTS-Avatar); the avatar-pipeline is for long, consistent presenter videos. See `avatar-pipeline/README.md`.

A full App Preview can be assembled end-to-end from this stack with no
third-party SaaS: `gen-avatar.mjs` (presenter) + `gen-video.mjs` (B-roll) +
`gen-music.mjs` (bed) + `gen-sfx.mjs` (UI sounds) + `gen-voiceover.mjs`
(any extra VO), stitched in an editor.

**Avatar RAI note (learned from live testing):** Veo's Responsible-AI filter
blocks some realistic-human renders (support code 15236754) — you are *not*
charged for filtered outputs. Neutral presenters + plain scripts pass cleanly;
renders that imply a medical professional ("audiologist") or make health claims
("check your hearing") tend to get filtered. Keep avatar scripts neutral and
non-clinical, let the brand voice carry warmth, and add disease/outcome claims
as on-screen text in the editor rather than in the spoken line. `personGeneration`
defaults to `allow_adult`; override with `--person`.

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
| `OPENAI_API_KEY` | GPT-image-1 (image gen), GPT-4o Vision (asset review) |
| `OPENAI_ORG_ID` | optional, for multi-org accounts |
| `GOOGLE_APPLICATION_CREDENTIALS` | path to service account JSON for Vertex AI |
| `GOOGLE_CLOUD_PROJECT` | GCP project ID for Vertex AI |
| `ELEVENLABS_API_KEY` | voiceover, music, sound-effects |
| `RECRAFT_API_KEY` | optional, for vectorization (otherwise uses local potrace) |
| `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_KEY` | optional — route GPT-image-1 + GPT-4o Vision to Azure OpenAI (spends the Azure grant) |
| `AZURE_OPENAI_IMAGE_DEPLOYMENT` / `AZURE_OPENAI_VISION_DEPLOYMENT` | Azure deployment names for the image + vision models |
| `AZURE_OPENAI_API_VERSION` | optional, defaults to `2025-04-01-preview` |
| `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` | optional — Azure AI Speech (TTS-Avatar / neural TTS) |

Run `bash setup.sh` once per machine to install deps and validate credentials.

### Provider routing (OpenAI vs Azure)

`gen-image.mjs` and `review-asset.mjs` accept `--provider openai|azure` (or set
`DESIGNER_OPENAI_PROVIDER=azure` to flip the default for a session). Both back
the same models — Azure just bills the Microsoft grant instead of direct OpenAI
credits. Azure is used only when its secrets are configured; otherwise the call
fails with a clear "not configured" message. (DALL·E 3 was retired Mar 2026 —
the `dall-e-3` alias now routes to `gpt-image-1`.)

## Output convention

By default, generated assets land in `$PWD/assets/generated/<type>/<slug>.<ext>` where:
- `<type>` = icon, illustration, app-icon, store-screenshot, video, avatar, voiceover
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
2. Optionally self-critique each with `review-asset.mjs --image <path>` — it scores brand fit, flags `do_not` violations, and returns a refined prompt. Use this to auto-cull weak variants before showing the user.
3. Display the strongest inline via SendUserFile
4. User picks one or asks for refinement
5. Refine with `--seed <selected> --refine "<feedback>"` (uses image-to-image edit endpoint), or feed the reviewer's `refined_prompt` straight back into `gen-image.mjs`
6. Iterate until approved

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
- Not for live photography work (Veo is generative; no on-set production)
- Not a long-form avatar tool — Veo clips top out around 8s per render; stitch multiple `gen-avatar.mjs` calls in an editor for a longer presenter monologue
- Not a CI/CD pipeline — wire into n8n if you want scheduled regeneration
