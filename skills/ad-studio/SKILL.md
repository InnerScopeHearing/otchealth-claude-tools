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

1. Every generating command is a **dry run** unless you pass `--commit` **and** `--max-credits N`.
2. If the known estimate exceeds the cap, or the remaining balance, nothing is submitted.
3. Any job with an **UNKNOWN** rate blocks the run unless `--allow-unknown-rate` is passed. The cap still applies at runtime:
   the guard reads the balance before and after every job (strictly one job at a time) and refuses to start the next job once
   the cap would be crossed.
4. Known rates today: Veo 3.1 Fast, 1080p, silent = **1,000 credits per second** (measured 2026-09-29) and sound effects
   40 credits per second (docs). Everything else is unknown until measured. Each real job appends
   `{balance before, after, delta, units}` to the ledger and the estimator uses the median of the learned samples, so
   the first run of a new combination is the calibration run. Do it small (one 4 s shot) with a low cap.
5. A cached asset costs nothing. When every asset is cached, `render.mjs` needs no `--commit`; it just re-assembles.
6. Failed generations are not charged by ElevenLabs. A timeout does not cancel the server-side job: the error carries the
   generation id so it can be looked up.
7. `--offline` (claims not run) can never be combined with a spend.

## Compliance rules (all enforced before spend, fail closed)

- **claims_check**: every VO line and every on-screen string (all locales), plus the joined copy as one net-impression check,
  goes through the gateway `claims_check` tool with `channel: ad` and the manifest `productClass`. Only a `pass` verdict passes.
  An unreachable gateway, a bad token or an unparseable answer is a failure, not a pass. TReO is a PSAP: never hearing-aid,
  medical, FDA or cure language. `OTC_hearing_aid` is refused outright (gated to Matt and clinical review).
- **FTC**: no testimonial framing. First-person voiceover (I, my), "as a customer", "real users", invented star ratings or
  reviews, and before/after outcomes are rejected. A person speaking to camera is allowed only with `aiActor: true` and a
  configured on-screen "AI-generated" label (burned in for the whole video), and an AI actor may never be framed as a
  customer, patient or reviewer.
- **Brand**: competitor and third-party brand names (Apple, AirPods, Bose, Sony, Jabra, Phonak, Oticon and others) are rejected in
  prompts and copy. Any shot that shows the product must set `showsProduct: true` and supply `start_frame` (a REAL product
  photo). Veo drew an AirPods look-alike from an unbranded prompt, so device words in a non-product shot are rejected too.
- **Copy**: no em or en dashes in any published text, and no PHI-ring field names or PHI-shaped text.
- Spanish (`locales: ["en","es"]`) needs a reviewed `i18n.es.script` with the same line count. Each line is claims-checked and
  synthesized with `language_code: es`. `dub.mjs` (Dubbing v2, audio only) exists for review use; its machine translation cannot
  pass claims_check, so it is never mixed into an ad automatically.
- Music terms: paid self-serve plans allow digital ads but not TV or radio.
- Only clone or use voices of people with written consent.

## Files

| File | Purpose |
|---|---|
| `el-client.mjs` | dependency-free ElevenLabs client (balance, Flows video, TTS with timestamps, music, SFX, dubbing), 429/5xx retry, key and signed URLs never logged |
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
- Captions take their words from the manifest text and their timing from the TTS character alignment; if the API normalizes the
  text differently the timing falls back to an even spread across the line.
- ffmpeg must include libass (the `ass` filter) and libx264. The captions use DejaVu Sans via fontconfig.
- Nothing in this skill publishes or uploads an ad. Publishing stays behind the claims, counsel and Matt gates.
