# Model and dependency licenses

Review before any commercial use. Flagged items below could govern the
commercial use of generated output, not just the code.

## Lip-sync models (selectable)

| Model | Source | License | Notes |
|---|---|---|---|
| LatentSync (default) | bytedance/LatentSync | Apache-2.0 (code) | Pipeline depends on Stable Diffusion 1.5 and Whisper, see below. ⚠️ review SD 1.5 terms for commercial output. |
| MuseTalk | TMElyralab/MuseTalk | MIT (code) | Near real-time. Depends on Whisper and SD-VAE components. |
| SadTalker | OpenTalker/SadTalker | Apache-2.0 (code) | Photo + audio. Bundles face models, see below. |

## Sub-dependencies that can govern OUTPUT

- ⚠️ **Stable Diffusion 1.5** (runwayml / CompVis): CreativeML OpenRAIL-M. Carries
  use-based restrictions. LatentSync uses SD 1.5 as a backbone. Confirm your use
  case is permitted under OpenRAIL-M before publishing commercially.
- **OpenAI Whisper**: MIT. Used for audio feature extraction. No output restriction.
- **Face / landmark models** (e.g. insightface, GFPGAN in some SadTalker setups):
  several are research/non-commercial. ⚠️ If using SadTalker for commercial work,
  audit each bundled face model's license.

## Voices and likeness

- The presenter likeness in any base video or photo must be one you have the
  right to use. Synthetic avatars only unless you have consent.
- ElevenLabs voice usage is governed by your ElevenLabs plan and the voice's
  rights (your cloned voice or a licensed premade voice).

## Action items flagged for review
1. Confirm SD 1.5 OpenRAIL-M permits your commercial output (LatentSync path).
2. If using SadTalker commercially, audit its bundled face-enhancement models.
3. Keep presenter consent on file for any real-person base video.
