# OTChealth Icon System — Batch 2 (2026-08-05)

Second batch, built after a live-site gap audit confirmed the 2026-07-16 batch (nav icons, FAQ accordion, star ratings, 5 trust badges, 2 diagrams) is fully wired into production. This batch closes gaps found on the homepage "Why OTCHealth" tiles and the Matrix product page. All labels/claims were run through the claims_check compliance gate first; this batch reflects the REVISE verdict (risk 36, 3 violations) and Matt's resulting decisions.

10 files, hand-authored SVG, no raster/PNG. Same palette and conventions as batch 1.

## Palette
- Warm Bone `#F7F1E4` — canvas
- Warm Ink `#241F19` — line work, primary text
- Terracotta Clay `#B5603C` — the one accent, used once per icon, never as a large fill

## icons/ (7 files)
| File | Description | Corrected label it decorates |
|---|---|---|
| icon-tile-heritage.svg | Timeline of 3 nodes, oldest to newest, terracotta on the current generation | "Three generations of audio innovation" (was "...hearing care" — flagged as clinical-care language) |
| icon-tile-easy-setup.svg | Pill toggle switch, flipped on, terracotta knob | "Easy setup, not complicated" (was "Certainty, not a guessing game" — flagged as implying diagnostic certainty) |
| icon-tile-support.svg | Support headset, terracotta mic-tip accent | "Real support, real guarantee" (unchanged — passed clean) |
| icon-feature-bluetooth.svg | Device outline + radiating signal arcs (outermost in terracotta) — deliberately NOT a literal Bluetooth-SIG rune, to avoid any trademark-adjacent ambiguity | Bluetooth streaming (Matrix PDP Features grid) |
| icon-feature-battery.svg | Battery outline, terracotta charge-level fill | 20+ hour battery (Matrix PDP Features grid) |
| icon-feature-ai-noise-reduction.svg | Noisy waveform → clean line, terracotta sparkle accent (no circuit-board cliché) | AI noise reduction (Matrix PDP Features grid) |
| icon-feature-multi-program.svg | 2x2 grid of program slots, one filled terracotta (active) | 4 listening programs (Matrix PDP Features grid) |

**Important constraint honored:** the 4 feature icons are purely decorative companions to copy that is already live on the Matrix PDP. Nothing here introduces, rewords, or extrapolates a spec claim — the icons ride alongside the existing text ("Bluetooth streaming", "20+ hour battery", "AI noise reduction", "4 listening programs") and assert nothing beyond it.

## badges/ (2 files)
| File | Description |
|---|---|
| badge-us-based-support.svg | Support-headset badge, "US-BASED SUPPORT" — passed the claims gate clean, no flag imagery (the claim is carried by text, not a symbol that could overclaim) |
| badge-free-returns.svg | Package + return-arrow badge, "FREE RETURNS" — built as its OWN distinct badge, not a relabel of the existing Free Shipping badge. Substantiated by the live 75-day policy (prepaid UPS return label at OTCHealth's cost). |

**HELD, not built:** a "Made in the USA" badge. The claims gate passed the phrase (it isn't a health claim), but it falls under the FTC Made in USA Labeling Rule ("all or virtually all" US content) and there is no country-of-origin substantiation on file. The phrase is already live as plain text elsewhere on the site; turning it into a badge amplifies and repeats the claim, which is exactly the exposure being avoided. Escalated to Matt for documentation — build only after he confirms.

## diagrams/ (1 file)
| File | Description |
|---|---|
| diagram-how-amplification-works.svg | Generic, product-neutral signal-path cutaway: sound in → microphone → amplifier → speaker → sound out. Deliberately carries NO headline, NO product name, and NO "hearing aid"/"PSAP" claim anywhere in the graphic — only generic stage labels (MIC / AMPLIFIER / SPEAKER) plus a footnote disclaiming that components vary by device. |

**Wire-in instruction (do not skip):** the compliant headline must be added separately, in the page template, depending on which product this ends up serving:
- If used on **iHEAR TReO**: "How this personal sound amplification product (PSAP) amplifies the sounds around you." Never "hearing device," never "hearing aid," anywhere near this diagram when it's on a TReO page.
- If used on **iHEAR Matrix** (or another genuine OTC hearing aid): "hearing aid" language is permitted — Matrix is a real FDA OTC hearing aid, confirmed by Matt 2026-07-15.
- Do not use one rendered instance (with a baked-in headline) for both products. If both pages need this diagram, add the headline as page-template text, not inside the SVG.

## Not touched in this batch
- The rogue bright-green "75-Day Money-Back Guarantee" CTA banner on the Matrix PDP (conflicts with the one-accent-color brand rule) — logged, tracked separately by Matt, intentionally not fixed here since it's a theme color issue, not an asset gap.
- Nothing in this batch is wired into the live theme. Repo commit only, same as batch 1.
