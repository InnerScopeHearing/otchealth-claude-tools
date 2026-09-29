---
name: ad-studio
description: Renders short paid-social video ads from a JSON manifest using the ElevenLabs API (Veo 3.1 video via Flows, eleven_v4 voiceover with word timestamps, music_v2_5, optional Dubbing v2) and assembles them locally with ffmpeg into 9:16, 1:1 and 16:9 files with ducked music, burned captions, an end card, an AI-generated label and -14 LUFS loudness. Every spend is dry-run by default and needs --commit plus --max-credits. Every ad must pass the claims_check, FTC, brand and copy/PHI gates before any credit is spent. Use when producing or varying an OTCHealth video ad; not for app-store previews or one-off clips (use skills/designer for those).
---

# ad-studio

One manifest in, ad files out. The pipeline is: **validate (all gates) -> estimate -> [commit] generate -> assemble**.
Everything that costs credits is cached by content hash, so re-renders and variants never re-pay for an unchanged asset.

Non-PHI ring only. Nothing here sends company data anywhere except the ad copy to the OTCHealth gateway `claims_check` and the
prompts/scripts to ElevenLabs.

## Quick start

```bash
cd skills/ad-studio
# 1. copy and edit the example (REAL product photos are required for product shots)
cp examples/sample-ad.json my-ad.json && mkdir -p assets   # put real photos in assets/

# 2. check every gate (needs gateway access for claims_check; --offline runs only the static guards)
node validate.mjs my-ad.json

# 3. DRY RUN: validates, prints the spend plan and estimate, submits nothing
node render.mjs my-ad.json

# 4. spend, capped (see "Spend rules")
node render.mjs my-ad.json --commit --max-credits 20000 --allow-unknown-rate

# 5. variants at zero video credits (new hook / CTA / end card / aspect)
node variants.mjs my-ad.json --spec variants.json --n 3

# optional: cheap half-size assembly for review
node render.mjs my-ad.json --preview
```

Output lands in `ad-studio-out/<id>/` as `<id>_<locale>_<9x16|1x1|16x9>.mp4` plus `<id>.report.json`
(jobs, cache hits, credits spent, measured LUFS). The asset cache is `~/.cache/ad-studio/assets` and the credit ledger is
`~/.cache/ad-studio/credit-ledger.jsonl` (override with `AD_STUDIO_CACHE` and `AD_STUDIO_LEDGER`).

The API key is AWS SSM `elevenlabs-api-key`. It is resolved from `ELEVENLABS_API_KEY`, then `~/.designer/credentials.env`.
Fetch it without printing it: `node /tmp/octools/setup/get-secret-aws.mjs elevenlabs-api-key /tmp/el.key` and export it from the file.

## The manifest

See `examples/sample-ad.json` and `ad-manifest.schema.json`. Key fields: `productClass` (passed to claims_check), `voice`,
`script` (one VO line per item, each its own TTS job so variants only re-pay changed lines), `onScreenText`, `shots[]`
(`duration_secs` 4, 6 or 8; `aspect` 9:16 or 16:9; `showsProduct` and `start_frame`), `music`, `endCard`, `outputs`,
`disclosures`, `locales` and optional `i18n.<locale>`.

## Spend rules (hard)

1. Every generating command is a **dry run** unless you pass `--commit` **and** `--max-credits N`. Boolean flags mean what they
   say: `--commit false`, `--commit=0` and `--commit no` are NOT commits.
2. `--max-credits` is one budget for the **whole run**. `variants.mjs` shares a single guard across all variants, so N variants
   together can never spend more than the cap (each later variant is planned against what is left of it).
3. **What the cap does and does not guarantee.** Known-rate jobs (Veo fast 1080p silent, 1,000 credits/s measured; SFX with a
   duration, 40 credits/s from the docs) are estimated exactly. Every other rate is UNPUBLISHED, so those jobs are bounded by a
   deliberately high **ceiling** (video 5,000/s, TTS 2/char, music 300/s, dubbing 2,000/s of speech, auto-length SFX 1,200):
   the planner refuses unless `known + ceilings <= cap`, and the runtime guard refuses to START a job whose bound would push the
   total past the cap. Unknown-rate jobs additionally need `--allow-unknown-rate`. The ceilings are guesses made to be too
   high, not measurements: if one is wrong, that single job can still cost more than its ceiling before the guard sees the
   balance afterwards, and then it stops everything else. Keep calibration runs small.
4. The guard runs one job at a time and reads the balance before and after each. A missing, zero or negative delta on a job that
   ran is NOT treated as free: it is charged at its estimate (or ceiling) against the cap and is never used to learn a rate.
   A definite failure with no balance movement is not charged; a timeout or 5xx on a generating request is treated as possibly
   charged.
5. Each real job appends `{balance before, after, delta, charged}` to `~/.cache/ad-studio/credit-ledger.jsonl`. A learned rate
   needs at least 2 clean samples and can only **raise** a known rate, never lower it.
6. Generating requests are **never auto-retried** on a timeout, network error or 5xx (the first attempt may already have been
   accepted and charged). Only a 429, which is rejected before any work starts, is retried. An "OUTCOME UNKNOWN" error means:
   check the balance before doing anything again.
7. A Flows video generation id is saved to the cache **before** waiting. If the wait times out or the download fails, the next
   run resumes that same generation (no new charge, and it does not count against the cap again) instead of submitting a new
   one. A generation that FAILED is not charged, so it is cleared and may be resubmitted.
8. A cached asset costs nothing. When every asset is cached, `render.mjs` needs no `--commit`; it just re-assembles.
9. `--offline` (claims not run) can never be combined with a spend.
10. `--audio` is refused: Veo audio is not mixed into the assembly, so `generate_audio` stays false.
11. `dub.mjs` obeys the same cap (its worst case is 2,000 credits per second of speech). The target language is passed in the
    project-create call; the separate paid add-language endpoint is never used.
12. The single-shot designer scripts (`gen-voiceover`, `gen-music`, `gen-sfx`, and `gen-video --engine elevenlabs`) write the same
    ledger. The first three still spend by default for backward compatibility (`--dry-run` previews); pass `--max-credits N` to
    make them honor a cap.

## Compliance rules (all enforced before spend, fail closed)

- **claims_check**: every VO line and every on-screen string (all locales), plus the joined copy as one net-impression check,
  goes through the gateway `claims_check` tool with `channel: ad` and the manifest `productClass`. Only a `pass` verdict passes.
  An unreachable gateway, a bad token or an unparseable answer is a failure, not a pass. TReO is a PSAP: never hearing-aid,
  medical, FDA or cure language. `OTC_hearing_aid` is refused outright (gated to Matt and clinical review).
- **FTC**: no testimonial framing, checked case-insensitively on voiceover, on-screen text and end card, in English and Spanish, after
  Unicode normalization (zero-width and look-alike letters cannot hide a phrase). First-person voice (I, my, yo, mi, me), "as a customer",
  "real users", invented star ratings or reviews, and before/after outcomes are rejected. A person speaking to camera is allowed only with `aiActor: true` and a
  configured on-screen "AI-generated" label (burned in for the whole video), and an AI actor may never be framed as a
  customer, patient or reviewer.
- **Brand**: competitor and third-party brand names (Apple, AirPods, Bose, Sony, Jabra, Phonak, Oticon and others) are rejected in
  prompts and copy, including spaced, dotted, accented, full-width, homoglyph and leetspeak spellings. Any shot that shows the product must set `showsProduct: true` and supply `start_frame` (a REAL product
  photo). Veo drew an AirPods look-alike from an unbranded prompt, so any prompt that mentions a generic device word (earbud, earphone, headphone, earpiece, gadget, device, hearing aid, amplifier, wearable) counts as a product shot and must set `showsProduct: true` with a real `start_frame`.
- **Copy**: no dash punctuation other than the plain hyphen in any published text (every Unicode Pd character is rejected), no PHI-ring field names or PHI-shaped text, and a PSAP end card must carry "not a hearing aid" (Spanish: "no es un audífono") in every locale. `endCard.background`, `textColor` and `accent` must be `#RRGGBB`.
- Spanish (`locales: ["en","es"]`) needs a reviewed `i18n.es.script` with the same line count. Each line is claims-checked and
  synthesized with `language_code: es`. `dub.mjs` (Dubbing v2, audio only) exists for review use; its machine translation cannot
  pass claims_check, so it is never mixed into an ad automatically.
- Music terms: paid self-serve plans allow digital ads but not TV or radio.
- Only clone or use voices of people with written consent.

## Files

| File | Purpose |
|---|---|
| `el-client.mjs` | dependency-free ElevenLabs client (balance, Flows video, TTS with timestamps, music, SFX, dubbing), reads retry 429/5xx, billable requests retry only 429, key and signed URLs never logged |
| `credit-guard.mjs` | rate table, estimator, spend gate, runtime cap, JSONL ledger with learned rates |
| `guards.mjs`, `validate.mjs`, `claims.mjs` | structure, FTC, brand, copy/PHI guards and the gateway claims gate |
| `render.mjs` | validate, estimate, generate (cached), assemble |
| `assemble.mjs`, `captions.mjs` | ffmpeg: crossfades, VO, sidechain-ducked music, ASS captions, end card, label, two-pass loudnorm, 3 aspects |
| `variants.mjs` | derive N variants that reuse cached shots (video spend forbidden) |
| `dub.mjs` | optional Dubbing v2 audio stage |

`skills/designer` also has `gen-video.mjs --engine elevenlabs` for one-off clips (same dry-run default and cap rules).

## Tests

`node --test skills/ad-studio/*.test.mjs` (or `bash run-tests.sh` from the repo root). All generation is tested with mocked fetch;
the ffmpeg assembly tests use generated color bars and sine tones. No test touches the network or spends credits.

## Pitfalls

- Veo `images` (reference images) cannot be combined with `start_frame` and require an 8 s clip. Product shots use `start_frame`.
- Give each `start_frame` photo the same aspect as its shot (a 9:16 photo for a 9:16 shot). Veo animates from the frame, and a mismatched frame is cropped or padded by the model, not by us.
- Veo durations are only 4, 6 or 8 s and aspects only 16:9 or 9:16. 1:1 is derived at export (crop), and a 9:16 shot in a 16:9 export
  gets a blurred pad instead of a crop so the product is never cut off.
- Signed content URLs last about an hour and are fetched without the API key. Assets are stored in the cache immediately.
- Poll Flows video no faster than every 10 s (the client enforces the floor) and expect roughly 2 minutes per shot.
- eleven_v4 has only Stability and Similarity settings (no Style or Speed) and no SSML; use audio tags for delivery.
  Cross-language v4 speech is fluent in the target language rather than carrying the source accent.
- Each VO line is synthesized on its own (no previous_text or next_text) so line jobs stay independently cacheable. Keep lines
  self-contained sentences.
- v4 audio tags such as `[whispers]` are stripped from captions.
- Captions take their words from the manifest text and their timing from the TTS character alignment; if the API normalizes the
  text differently the timing falls back to an even spread across the line.
- ffmpeg must include libass (the `ass` filter) and libx264. The captions use DejaVu Sans via fontconfig.
- Nothing in this skill publishes or uploads an ad. Publishing stays behind the claims, counsel and Matt gates.
