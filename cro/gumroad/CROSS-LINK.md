# CROSS-LINK: the canonical From the Chair book + workbook are in CRO-HyperAgent/gumroad/

Canonical decision (Matt-confirmed 2026-06-29): the chapter-aligned workbook in CRO-HyperAgent/gumroad/workbook/
is the canonical "From the Chair: The Workbook." The 46-page kits-audiology workbook in THIS folder becomes the
practice-ops COMPANION. Do not evolve the 46-page file into the From the Chair workbook; reconcile against the
canonical one instead.

## The canonical half (Hyperagent engine) - CRO-HyperAgent/gumroad/ , all on origin/main
- Book manuscript: manuscript/ch01-18.md + edition-a/manuscript + edition-b/manuscript (compliance-passed, Phase 5)
- CANONICAL workbook: workbook/ (20 files) + edition-a/workbook + edition-b/workbook (20 each)
- Extras: scripts library, quick-ref cards, training kit, audio companion script, implementation tracker
- Design: covers (v1 light, v2 dark = chosen direction, v3 diagrams), interior layout system, the 3 Moore
  heritage photos (design/photos/), Folio prompts (FOLIO-PROMPTS.md + FOLIO-PROMPTS-ROUND2.md)
- Read first: CRO-HyperAgent/gumroad/README.md (artifact index) and docs/CRO-MASTER-HANDOFF-2026-06-29.md (PR #242)
- ENCODING: all repo images are base64 text inside the file; decode with base64 -d before use.

## THIS folder (cro/gumroad/) - the practice-ops companion
The 46-page Complete-Hearing-Care-Practice-Workbook (PDF + editable Word, build_workbook.py), the overview,
Prologue + Chapter 1, the role editions, the five compliance kits, Mark's transcript, and the Gumroad listing.

## The move (agreed)
- Keep the chapter-aligned workbook as canonical.
- Harvest THIS workbook's unique practice-ops modules (OTC-refugee, device economics/unbundling, the numbers,
  lobby environment, diversification, headwinds, trackers) into the From the Chair extras / practice-ops companion.
- Do NOT refill the "From the chair" boxes with stories already in the manuscript (rain on the roof ch03,
  "they are returning you" ch03/ch14, the denial play ch07, the packed lobby ch15). Point to the chapter instead.

## De-fork rule (both engines)
Sync to origin/main before declaring anything missing. Push all work product to origin/main (cro/gumroad assets
are not yet on main as of this writing). Two folders, one product.
