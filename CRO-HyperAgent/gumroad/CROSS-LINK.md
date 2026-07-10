# CROSS-LINK: From the Chair lives in TWO engine folders (read before building)

Canonical decision (Matt-confirmed 2026-06-29): the chapter-aligned workbook in THIS folder is the canonical
"From the Chair: The Workbook." The 46-page kits-audiology workbook on the Claude CRO engine becomes the
practice-ops COMPANION, not a competing workbook.

## THIS folder (CRO-HyperAgent/gumroad/) - the Hyperagent engine, all on origin/main
- Book manuscript: manuscript/ch01-18.md (neutral) + edition-a/manuscript + edition-b/manuscript (compliance-passed)
- CANONICAL workbook: workbook/ (wb00-front, wb01-18, wb99-back) + edition-a/workbook + edition-b/workbook
- Extras: extras/ (scripts library, quick-ref cards, training kit, audio companion, implementation tracker, COMPLIANCE-PASS-PHASE5)
- Design: design/ (covers v1/v2/v3, diagrams, interior system, photos) + FOLIO-PROMPTS.md + FOLIO-PROMPTS-ROUND2.md
- Index + handoff: README.md (artifact index) ; docs/CRO-MASTER-HANDOFF-2026-06-29.md (PR #242)

## The OTHER half (Claude CRO engine) - expected at cro/gumroad/
The practice-ops companion: kits-audiology/ (the 46-page Complete-Hearing-Care-Practice-Workbook PDF + editable
Word, rebuilds from build_workbook.py), the project overview, Prologue + Chapter 1 prose, the two role editions,
the five compliance kits, Mark's 3-part transcript, and the paste-ready Gumroad listing.

REACHABILITY (important): as of this writing, cro/ has 0 files tracked on origin/main. Per the cross-engine
reachability rule (commit 93142c6), the Claude CRO must push the cro/gumroad assets to origin/main so both
engines can see them. Until then, those assets are local-only on the Claude engine.

## How the two fit (do not fork, do not duplicate)
- The canonical workbook here is chapter-aligned to the 18-chapter book (one module per chapter).
- The 46-page companion holds UNIQUE practice-ops content (OTC-refugee opportunity, device economics and
  unbundling, the numbers, lobby environment, diversification, headwinds). Harvest THAT into From the Chair extras.
- Do NOT refill the companion's "From the chair" story boxes with stories that already exist as prose in the
  manuscript: rain on the roof = ch03; "they are returning you" = ch03/ch14; the denial play = ch07; the packed
  lobby = ch15. Point the boxes at the chapter instead.

## De-fork rule (both engines)
Sync to origin/main before declaring anything missing. Commit all work product to origin/main. Two folders,
one product: cro/gumroad (practice-ops companion + book prose drafts) and CRO-HyperAgent/gumroad (canonical book
+ chapter workbook + design).
