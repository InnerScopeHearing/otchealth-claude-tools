# Avatar Pipeline (cloud-native, self-hosted GPU)

Turn a script plus your ElevenLabs voice into a finished, lip-synced MP4,
rendered on a credited Azure GPU, orchestrated entirely by GitHub Actions. No
local PC is involved. The GPU auto-starts before a job and auto-deallocates
after, so idle time never burns credits. A paid fal.ai path stays available as a
fallback for hero shots.

## How it flows

1. You trigger the `avatar-render` workflow (GitHub mobile app, or `gh workflow run`).
2. The runner does ElevenLabs TTS, splits the script into segments of 60 seconds
   or less on sentence boundaries, and uploads audio plus the presenter base
   video to Cloudflare R2.
3. The runner starts the Azure GPU VM and triggers inference per segment via
   `az vm run-command` (Azure control plane, so the VM needs no inbound port).
4. The container on the VM pulls inputs from R2, runs the model, and uploads each
   clip back to R2.
5. The runner downloads the clips, concatenates them with FFmpeg into
   `final.mp4`, uploads it to R2, writes a row to the Notion render log, and
   publishes `final.mp4` as a workflow artifact you can download from your phone.
6. An `if: always()` step deallocates the VM, even on failure.

## Interim path: render today without Azure GPU quota

Azure GPU quota needs manual support approval on credited subscriptions, which
can take a day. To produce videos now, the pipeline supports a no-quota managed
GPU via **Replicate** (`--backend replicate`), and a standalone runner that needs
no Azure, no R2, and no GitHub Actions:

```
python quick_render.py --script scripts/demo.md --base presenter.mp4 --model latentsync
```

It only needs `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `REPLICATE_API_TOKEN`,
and a presenter base video (or a photo with `--model sadtalker`). Inputs are
uploaded to Replicate's files API, so no object store is required. Switch to
`--backend azure` once the GPU quota lands.

## Models

- `latentsync` (default, needs a presenter BASE VIDEO)
- `musetalk` (needs a presenter BASE VIDEO)
- `sadtalker` (photo only fallback)

Select with the `model` workflow input.

## Layout

```
avatar-pipeline/
  config.py voiceover.py storage.py splice.py avatar.py orchestrate.py notion_log.py
  infra/  Dockerfile entrypoint.py provision.sh LICENSES.md
  scripts/ demo.md
  requirements.txt  .env.example
.github/workflows/   avatar-render.yml avatar-stop.yml avatar-build-image.yml avatar-provision.yml
```

Workflows live at the repository root `.github/workflows/` (required by GitHub)
and use `working-directory: avatar-pipeline`.

## Secrets: from the Notion Token Vault to GitHub

Secrets originate in the Notion Token Vault and must be added as repository
**Actions Secrets** (Settings, Secrets and variables, Actions). Required:

| Secret | Notes |
|---|---|
| `ELEVENLABS_API_KEY` | in the vault |
| `ELEVENLABS_VOICE_ID` | pick a voice (Sarah is the documented primary) |
| `R2_ACCESS_KEY_ID` | mint in the Cloudflare R2 dashboard |
| `R2_SECRET_ACCESS_KEY` | mint in the Cloudflare R2 dashboard |
| `R2_ACCOUNT_ID` | Cloudflare account id |
| `R2_BUCKET` | R2 bucket name |
| `R2_PUBLIC_URL_BASE` | public bucket or custom domain base URL |
| `NOTION_API_KEY` | in the vault |
| `NOTION_RENDER_DB_ID` | optional; auto-created if `NOTION_PARENT_PAGE_ID` is set |
| `AZURE_CREDENTIALS` | service-principal JSON for `azure/login` (Contributor on the subscription or `otchealth-avatar-rg`) |
| `FAL_KEY` | optional, only for `--backend fal` |

Optional repository **Variables**: `AZURE_RG`, `AZURE_VM_NAME`, `AZURE_REGION`,
`AZURE_VM_SKU`, `GHCR_IMAGE`.

## One-time setup

1. Request GPU quota for the T4 family (NCASv3) in `eastus` or `westus2` under
   Azure portal, Quotas. New subscriptions start at zero. This is CHECKPOINT 1.
2. Add the Actions Secrets above (and `AZURE_CREDENTIALS`).
3. Run the `avatar-build-image` workflow to build and push the container to GHCR.
   Make the GHCR package public, or store a read token on the VM.
4. Run the `avatar-provision` workflow to create the resource group, GPU VM
   (no public IP, no inbound app port), the `/mnt/weights` data disk, the
   `project=otchealth-avatar` tag, and the auto-shutdown backstop.

## Base video requirement (CHECKPOINT 2)

`latentsync` and `musetalk` relip-sync a short BASE VIDEO of the presenter, not a
photo. Provide it as the `base_video` input (a public URL, or a path you commit
under `scripts/`). If you only have a still photo, use `--model sadtalker`.

## Run a render

- From your phone: Actions, `avatar-render`, Run workflow, set `script`, `model`,
  `backend`, and `base_video`.
- From a shell: `gh workflow run avatar-render.yml -f script=scripts/demo.md -f model=latentsync -f base_video=<url>`.
- Download the result from the run's `avatar-final` artifact, or from the R2 URL
  in the log and the Notion row.

## Force-stop the GPU

Run the `avatar-stop` workflow anytime (phone friendly) to deallocate the VM
immediately. The `avatar-render` always() step and the daily auto-shutdown are
additional backstops.

## Cost control

- The VM starts on demand and deallocates at job end, on error, and on a job
  timeout. The render job has `timeout-minutes: 90`.
- Each render logs GPU minutes and an estimated cost to the Notion render log and
  prints a remaining-credit reminder in the workflow log.

## Status and what is still needed (2026-06-04)

This codebase was built and committed by Claude Code in the cloud sandbox. The
sandbox cannot set GitHub Actions Secrets (no `gh` or token) and the Azure
identity available to it is scoped to a single resource group, so the following
are yours to complete before the first render:

1. CHECKPOINT 1: request GPU quota (almost certainly zero on a new subscription).
2. Add the Actions Secrets, including `AZURE_CREDENTIALS` (a service principal
   with Contributor on the subscription so `avatar-provision` can create the RG
   and VM). The existing `claude-driver` SP is Contributor on `rg-claude-designer`
   only and cannot create a new RG.
3. The five `R2_*` values are not in the Token Vault yet. Mint R2 S3 keys in
   Cloudflare and add them.
4. CHECKPOINT 2: provide the presenter base video (or a photo for SadTalker).

GPU inference (LatentSync, MuseTalk, SadTalker) could not be validated in the
CPU-only build sandbox. The per-model commands follow each official repo and are
validated on the first real GPU run (Stage 7).

Content rule for generated narration: no em dashes or en dashes. Use commas,
periods, or line breaks.
