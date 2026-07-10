# From the Chair - Book Folder HANDOFF & Artifact Index

Project: "From the Chair" - the first Gumroad product. A professional book + fillable workbook system
built from the real careers of Mark & Kim Moore (Licensed Hearing Aid Dispensers, three generations of
hearing care). Sold as TWO editions of the SAME content plus a bundle.

Last updated: 2026-06-29 (Hyperagent CRO, at sunset handoff to Claude CRO).
Status legend: FINAL = written + compliance-passed; DRAFT = produced, not final; PENDING = not yet produced.

## Editions model
- Edition A "The Closer" - owners / salespeople / commission dispensers (sales framing).
- Edition B "The Professional" - front desk / support / care-first dispensers (care framing).
- Same shared-core content; Phase 3 vocabulary swap produces the two editions. Bundle = both + workbooks + tools.

## Artifact index (all paths under CRO-HyperAgent/gumroad/)
| Area | Path | Status | Notes |
|---|---|---|---|
| Shared-core manuscript | manuscript/ch01-18.md | FINAL | 18 chapters, 33,763 words. Commit 1eab9cc. |
| Edition A manuscript | edition-a/manuscript/ch01-18.md | FINAL | Closer vocabulary. Commit 95bcff2. |
| Edition B manuscript | edition-b/manuscript/ch01-18.md | FINAL | Professional vocabulary. Commit 95bcff2. |
| Fillable workbook (neutral) | workbook/wb00-front, wb01-18, wb99-back | FINAL | 18 modules + front/back. Commit a997cc3. |
| Edition A workbook | edition-a/workbook/ | FINAL | Closer lens resolved. |
| Edition B workbook | edition-b/workbook/ | FINAL | Professional lens resolved. |
| Extras: scripts library | extras/scripts-library.md | FINAL | ~33 scripts, journey-ordered. |
| Extras: quick-ref cards | extras/quick-ref-cards.md | FINAL | 6 cards. |
| Extras: training kit | extras/training-kit.md | FINAL | 4-week rollout, 8 role-plays. |
| Extras: audio companion script | extras/audio-companion-script.md | FINAL | intro + 9 parts + close. |
| Extras: implementation tracker + master index | extras/implementation-tracker.md | FINAL | 90-day rollout + bundle map. |
| Compliance pass record | extras/COMPLIANCE-PASS-PHASE5.md | FINAL | 2 HIGH + 4 MED + 2 LOW resolved. Commits 591d202 / b4a9f1a. |
| Specs | STYLE-AND-LEXICON.md, CHAPTER-SPECS.md, WORKBOOK-SPEC.md, SWAP-SPEC.md, EXTRAS-SPEC.md | FINAL | Master consistency docs. |
| Scope + outline + plan | BOOK-PROJECT-OVERVIEW.md, FROM-THE-CHAIR-MASTER-OUTLINE.md, PRODUCTION-GAME-PLAN.html, PRODUCTION-RUNBOOK.html | FINAL | Pricing proposal lives in game plan; Matt-gated. |
| Source | transcripts/ (mark, kim), drafts/ (kim-spine, mark-spine, master-outline) | FINAL | Raw interview + spines. |
| Brand | design/brand/style-frame.png + STYLE-NOTES.md | DRAFT | Fraunces + Inter, cream + amber/teal/gold. |
| Covers v1 (light) | design/covers/edition-a, edition-b, bundle | DRAFT | Superseded by dark direction. |
| Covers v2 (dark) | design/v2/edition-a-v2, edition-b-v2, bundle-v2 | DRAFT | DARK direction WINS (see Round 2). |
| Diagrams | design/diagrams/ + design/v2 + design/v3 | DRAFT | v3 three-patients + v3 patient-journey are the keepers. |
| Interior layout system | design/interior/ (chapter-opener, body-grid, workbook, A+B) + LAYOUT-SPEC.md | DRAFT | Strong; near-ready. |
| Heritage photos | design/photos/ (marvin-posey-1950s, mark-testing-mother-1980s, moore-family-1989) + README | FINAL | Real Moore-family photos. See encoding note. |
| Folio prompts Round 1 | design/FOLIO-PROMPTS.md + BRAND-BRIEF.md | FINAL | The 10 original prompts. |
| Folio prompts Round 2 | design/FOLIO-PROMPTS-ROUND2.md | FINAL | Revised art direction + marketing/teaser + photo integration. |
| Gumroad listing copy | (pending) | PENDING | Not yet written. |
| 3D mockups + listing graphics + LinkedIn kit | design/mockups, design/listing, design/social | PENDING | Folio to produce from Round 2 prompts R7-R11. |
| Present-day family photo | design/photos/moore-family-present.png | PENDING | Matt to provide; completes the "Today" slot. |

## ENCODING NOTE (important)
Every binary asset in this repo (Folio art + the heritage photos) is stored as base64 TEXT inside the file
(github push stores content verbatim as text). To use any image: run base64 -d file.png > real.png (one decode).
This is the working convention; it is consistent across all repo art.

## Design direction decision (Round 2)
Go DARK and cinematic for all three covers (v2 wins) as a matched set; fix the cover lockup and add a
credibility line (three generations, 40,000+ patients). Adopt the v3 "three patients" cards as the hero
modality visual and fix the raw HTML entity bug. Real family photos do the converting work on the back
cover, the three-generations piece, and the LinkedIn carousel. Front covers stay the dark-chair brand motif.

## What is left before Gumroad launch
1. Folio runs Round 2 (dark covers + fixed diagrams + mockups + listing + LinkedIn kit + three-generations + back covers).
2. Matt provides the present-day photo.
3. Write the Gumroad listing copy (3 SKUs).
4. Final pricing (Matt-gated).
5. Assemble fillable PDFs (decode the base64 art; embed Fraunces/Inter; overlay interactive form fields per LAYOUT-SPEC).
6. Stage the 3 Gumroad SKUs; verify a real checkout completes BEFORE calling it live.
7. Launch (Matt gate): LinkedIn sequence to ~20,000 industry connections.

## Compliance (non-negotiable)
Licensed Hearing Aid Dispensers, never "audiologist". Traditional hearing aids only, no iHEAR TReO / PSAP
cross-promotion. No medical / treatment / cure / diagnosis claims; cognitive-link statements are framed as
Mark's personal experience. INND heritage stays factual and modest. Front-matter global disclaimer ships
with the produced PDFs.
