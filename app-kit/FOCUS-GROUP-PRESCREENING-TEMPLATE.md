# Focus Group Pre-Screening Template

**Purpose:** A structured, code-backed simulation that validates a PR/release candidate
against representative user personas before merge and TestFlight submission. Catches
usability and product-logic failures that unit tests miss, without recruiting real users.

**Canonical reference implementation:** iHEARtest `qa/focus-group-prescreening-1.5.19.html`
(commit `af4cd2f` on `innerscopehearing/iheartest`). Use it as the style/structure reference.

---

## When to run

Run once per release candidate, before squash-merging the feature branch to `main`.
Render to PDF (weasyprint), commit both files, send PDF to stakeholder reviewer.

---

## The output files

```
qa/focus-group-prescreening-X.Y.Z.html   (source, committed)
qa/pdf/focus-group-prescreening-X.Y.Z.pdf (rendered, committed)
```

---

## Five core personas (apply to all OTCHealth consumer health apps)

These five archetypes cover the trust/tech-comfort spectrum for the 45-75 target demographic.
Adapt names and exact ages per app, but keep the archetype roles consistent.

| Slot | Archetype | Age | Key concern | Trust trigger |
|---|---|---|---|---|
| 1 | Non-technical self-tester | 68-75 | Clarity, no jargon | Simplicity, familiar UI patterns |
| 2 | Analytical retiree | 65-72 | Accuracy, methodology | Data sources, clinical references |
| 3 | Caregiver / proxy user | 48-58 | Reliability, family impact | Clear instructions, low error rate |
| 4 | Domain skeptic | 40-52 | Professional standard vs consumer grade | Transparency about limitations |
| 5 | Clinical gatekeeper | 50-65 | Medical credibility, liability | Clinical citations, disclaimers |

For apps outside the health/senior space, substitute archetypes that match the actual
buyer spectrum. The five-slot structure (novice, expert, proxy, skeptic, authority) is
what matters, not the specific demographics.

---

## Checklist structure

### Mandatory sections for every pre-screening

1. **Cover page** -- PR/branch, date, method, persona list, verdict key
2. **Scope summary** -- What changed in this release (1 row per fix/feature)
3. **Risk matrix** -- Per feature: audience, severity, code confidence, device required
4. **Per-persona checklist pages** (one page per persona) -- see below
5. **Final verdict page** -- Roll-up table, decision line, next steps

### Per-persona checklist columns

| Column | Description |
|---|---|
| # | Checklist item number |
| Area | Feature / screen area being checked |
| Scenario | What the persona does in this situation |
| Expected | What correct behavior looks like |
| Verdict | PASS / DEVICE REQ / FLAG / NOTE |
| Evidence | Code line / commit / file confirming the verdict |

Mark items from this release with `[NEW]` so the reviewer can focus the device test.

---

## Verdict definitions

| Chip | Meaning |
|---|---|
| PASS | Code confirms correct behavior for this item |
| DEVICE REQ | Hardware test needed; code appears correct but cannot be verified from source alone |
| FLAG | Would cause this persona to vote NO or HOLD on the release |
| NOTE | Minor concern, not a blocker |

**Merge gate:** no FLAGs on any persona before merge. DEVICE REQ items go to the
device spot-check list (tester runs on real hardware before sending to external reviewers).

---

## Checklist item categories

**Functional (code-verifiable):**
- New feature visible and correct
- Edge cases handled (no profile, no age, null results)
- Error states degrade gracefully (mic denied, no network)
- PHI ring: sensitive data stays on device
- i18n: key strings translate correctly

**Device-only (cannot be verified from source):**
- Audio routing (AirPods, speaker, silent switch)
- Mic permission prompt UX
- Screen layout on small/large device
- Haptics, scrolling, tap targets

**Trust/copy:**
- Clinical claims are accurate and defensible
- Disclaimers visible and appropriately scoped
- No credential overclaims

---

## Persona ship-call format (per-page footer)

```
SHIP-IT?  YES / NO/HOLD
Reason: [1 sentence from this persona's perspective]
Device items to verify: [list, or "none"]
```

---

## HTML structure (from the iHEARtest reference)

The document uses letter-sized paged CSS (`@page { size: letter; margin: 0.55in 0.6in; }`).
Key CSS classes:

```css
.page          /* page-break-after: always; */
.intro-box     /* blue left border -- context/purpose */
.warn-box      /* yellow left border -- caveats */
.green-box     /* green left border -- confirmations */
.persona-card  /* bordered card per persona */
.new-badge     /* [NEW] inline label for this release's items */
.ready-box     /* green border -- final SHIP-IT verdict */
.final-box     /* red border -- HOLD verdict */
```

Verdict chip classes: `.vp` (PASS, green), `.vf` (FLAG, red), `.vd` (DEVICE REQ, blue), `.vn` (NOTE, amber).

---

## Integration with the Mark review ritual (iHEARtest-specific)

For iHEARtest, the focus group pre-screening is a DEVELOPER gate, not the Mark review:
- **Pre-screening** -- developer validation before merge (catches code bugs)
- **Mark review** -- `qa/build-review-X.Y.Z.pdf` sent to Mark after the TestFlight build

Other apps: adapt the authority-reviewer role to match whoever gates external release
(clinical reviewer, compliance officer, domain expert). The two-gate pattern is the standard.

---

## How Claude agents should use this

1. Read this file before writing any focus group pre-screening document.
2. Start with the five-persona slots. Tailor demographics/names to the app.
3. Scope the checklist to THIS release's changes. 14-32 items is the right range.
4. Mark code-verifiable items first. DEVICE REQ items get the device spot-check list.
5. Fill the risk matrix from the PR diff (audience, severity, confidence).
6. Write the final verdict section last, after all personas have verdicts.
7. Render to PDF with `weasyprint src.html out.pdf`.
8. Commit both HTML + PDF. Deliver PDF via `SendUserFile`, NEVER as a GitHub link.
