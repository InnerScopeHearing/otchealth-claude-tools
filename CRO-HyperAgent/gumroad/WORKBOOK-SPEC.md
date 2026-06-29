# From the Chair — WORKBOOK SPEC (master template for all writers)

The workbook is the PRODUCT'S VALUE and its ANTI-PIRACY MOAT. A blank PDF can be copied; a workbook a
professional has filled in with their own patients, scripts, and numbers cannot. Build it SUBSTANTIAL,
specific, and genuinely usable in a working practice. This is not a quiz — it is a 90-day operating system.

Each writer builds the **workbook module** for their assigned chapters. One module per manuscript chapter.
Output edition-NEUTRAL Markdown (Phase 3 applies the Closer/Professional vocabulary swap). Where a prompt
naturally differs by audience, write the neutral version and add the two flagged lines (see §4).

## 0. Read first (every writer)
- The matching manuscript chapter(s): /tmp/ftc/manuscript/chNN.md  (the story + method the module reinforces)
- /tmp/ftc/inputs/CHAPTER-SPECS.md  (each chapter's "Workbook focus")
- /tmp/ftc/inputs/STYLE-AND-LEXICON.md  (voice, compliance, lexicon swap table)
NEVER invent patients, stats, or quotes. Compliance is non-negotiable: Licensed Hearing Aid Dispensers
(never "audiologist"), traditional hearing aids only (no iHEAR TReO / PSAP), no medical/treatment/cure claims.

## 1. Per-chapter module structure (write ALL of these, in order)
Each module is titled `## Chapter NN Workbook — <Chapter Title>` and contains, as fillable Markdown:

1. **The takeaway** (2–3 sentences) — the chapter's principle in plain language, so the module stands alone.
2. **Self-score (baseline)** — 3–5 statements scored 1–5 (Never→Always) on how the reader does this TODAY.
   Render each as a fillable row, e.g. `- I ask what brings the patient in before I say anything about a device.  ☐1 ☐2 ☐3 ☐4 ☐5`
   End with a `My baseline score: ___ / NN` line. (These feed the front-matter scorecard + 30/60/90 re-score.)
3. **Reflect** — 3–4 open prompts straight from the chapter's "Workbook focus," each with labeled blank lines
   (use `__________` rule lines, 2–3 per prompt) so it works as a real PDF form field. Make prompts specific to
   the chapter's story (e.g. Ch3 → "Write your own 'rain on the roof' moment: a patient whose life you changed.").
4. **The drill / script-builder** — a concrete, do-it-now exercise tied to the chapter's method. Provide a
   fill-in-the-blank SCRIPT the reader writes in their own words (labeled blank lines), plus a 1-line model/example
   pulled faithfully from the manuscript so they see the shape. (e.g. repeat-back drill, one-price-includes-me line,
   loved-one demo script, return-save protocol, the Mirror drill, modality self-test.)
5. **Real-patient log** — a small fillable TABLE the reader completes with ACTUAL patients this week (this is the
   anti-piracy core). Columns sized to the chapter (e.g. Patient initials | What they told me they're missing |
   Modality I read | What I tried | Outcome). 4–6 blank rows. Markdown table with empty cells.
6. **Commit** — one specific action the reader will take in the next 7 days + a date line:
   `This week I will: __________   By (date): ______`

Target ~600–900 words of scaffolding per module (the blanks are the point; richness = many specific, usable blanks).

## 2. Front matter (assigned to the front/back writer)
- **How to use this workbook** (½ page): the 90-day method; fill it for YOUR practice; keep it private (it's your edge).
- **The Practice Self-Assessment Scorecard (baseline)** — consolidate all 18 chapters' self-score dimensions into one
  master scorecard the reader scores on day 1. Group by the book's 9 Parts. Include a `Total baseline: ___ / (max)` and
  a simple band reading (e.g. ranges → "where to focus first").
- **Your Why** (Ch1 tie-in): a guided page to write the reader's own reason for the work + their role on the team.

## 3. Back matter (assigned to the front/back writer)
- **Scripts Library index** — a one-page cross-reference listing every script the reader built, by chapter, with a
  blank "my best version" line each (so the filled workbook becomes their personal script bank).
- **The Metric Tracker** — a fillable monthly table (3 months) of the reader's chosen success metrics. Keep metric
  NEUTRAL (label rows generically: "My key outcome metric", "Follow-ups completed", "Returns saved", "Referrals") so
  Phase 3 can lens it (close rate/revenue vs help-success/satisfaction). Columns: Metric | Baseline | Mo.1 | Mo.2 | Mo.3 | Goal.
- **30 / 60 / 90 Re-Score** — the master scorecard repeated 3×, with a reflection prompt each ("what moved, what's next").
- **Reflect & Commit (closing)** — a final commitment page: 3 things I'll keep doing, 1 habit I'm adding, signature + date.

## 4. Edition lens (only where a prompt truly differs)
Keep the core neutral. Where a self-score statement or drill is sharper in one audience's words, append two short
flagged lines under it so Phase 3 can swap cleanly:
`> Closer lens: <sales-framed version>`
`> Professional lens: <care-framed version>`
Use the lexicon table in STYLE-AND-LEXICON.md. Do not over-flag — most content stays shared.

## 5. Output
Write each chapter module to its own file: /tmp/ftc/workbook/wbNN.md  (wb01.md … wb18.md).
Front/back writer writes /tmp/ftc/workbook/wb00-front.md and /tmp/ftc/workbook/wb99-back.md.
Return a 3-line report: files written, total blanks/fields created (approx), any compliance flags.
