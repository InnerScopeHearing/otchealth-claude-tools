# InnerScope (INND) — Standalone Profile
### Real legal/financial state, dilution mechanics, and the preconditions for any roll-up or combined narrative

**Author:** COO (The Quarterback) · **Date:** 2026-07-10 · **Status:** v1 — internal synthesis only
**Lane:** `coo` (`--tags moore-playbook,innerscope-standalone`) · **Parent:** `INND-CAPITAL-FLYWHEEL.md`,
`INND-ROLLUP-LANDSCAPE.md`, `RACI.md` §0

> **⛔ NOT FOR EXTERNAL USE, no exceptions.** This inherits every InnerScope/INND gate already
> standing in this fleet: Capital/IR + counsel clearance before anything here is used externally;
> zero MNPI, share counts, exact dollar figures, or valuation specifics in this doc by design —
> those live only in the `coo` private ledger lane and in CFO's own working files, not here. This
> doc describes mechanisms, severity, and status categorically so it's safe to keep in a shared,
> committed file; it deliberately is NOT the place to look for exact numbers.
>
> **Why this exists:** Matt asked directly whether the roll-up/"combine OTCHealth and
> InnerScope" narrative built earlier this session (`INND-CAPITAL-FLYWHEEL.md`,
> `INND-ROLLUP-LANDSCAPE.md`) rests on solid ground. It surfaced a real answer: **not yet.**
> This doc is the honest standalone picture that those two docs need to be read against.

---

## 1. Executive summary — is a roll-up or combined narrative safe to use today?

**No.** Three independent reasons, each sufficient on its own:

1. **The share count is not stable.** InnerScope is currently being diluted at a rapid,
   accelerating pace by an actively converting toxic note (mechanics in §3 below). A roll-up
   thesis that assumes "pay in stock, re-rate at the public multiple" requires a currency that
   holds still long enough to negotiate and close a deal. That assumption does not currently
   hold.
2. **The standalone financials are mid-reconstruction, not audit-ready.** CFO is deep in a
   multi-phase rebuild of InnerScope's and HearingAssist's books from first principles. Real,
   material defects have been found and are being fixed in real time (§2). Any external
   financial narrative built today would be built on a moving foundation.
3. **Key valuation and disclosure questions are open, not settled.** Whether a major intangible
   asset is impaired, whether a specific derivative liability was ever properly recognized, and
   whether all required share issuances have been properly disclosed are all still live
   questions CFO is actively working through, not resolved facts.

None of this means the underlying business logic of the flywheel is wrong — it means the
foundation it would stand on isn't poured yet. Treat `INND-CAPITAL-FLYWHEEL.md` and
`INND-ROLLUP-LANDSCAPE.md` as the target-state thesis, not something ready to act on until the
preconditions in §5 are met.

---

## 2. Legal and financial state — categorical summary

**Entity structure:** InnerScope Hearing Technologies is a separate, publicly-traded company
(OTC market) that holds a minority equity stake in OTCHealth Inc. It is not itself currently
operating a consumer hearing-aid business day-to-day — HearingAssist (its former operating
subsidiary) was deconsolidated and its assets contributed into OTCHealth in a 2025 transaction.
InnerScope today functions primarily as (a) the public-company vehicle for the eventual roll-up/
capital-flywheel thesis, and (b) the entity working through a substantial legacy legal and
accounting cleanup from its pre-OTCHealth history.

**Financial reconstruction status:** CFO is mid-way through a structured, multi-phase rebuild of
InnerScope's and HearingAssist's standalone books (both entities, from their respective
starting points), followed by a real consolidation workpaper, followed by audit-readiness work.
This is a real, substantial, ongoing body of work — not a light touch-up. Concretely, this pass
has found and is fixing: chart-of-accounts type errors that distorted historical reported
profit, an acquisition-date opening balance sheet that was mathematically broken (impossible
negative totals) until corrected this session, cross-entity account-numbering mismatches that
would complicate consolidation, and multiple accounts whose live balances don't yet match what
prior internal summaries claimed. Live verification (not reliance on cached summaries) has
repeatedly found the true state to differ — sometimes better, sometimes worse — from what a
prior status report said, including from a prior CFO's own account of what had already been
completed. **Read: don't treat any single narrative status ("the standalone rebuild is done") as
settled without a fresh live check — this has already flip-flopped once this session.**

**Valuation/impairment status:** A significant intangible asset carried from the HearingAssist
transaction has two competing internal analyses — one showing comfortable coverage under a
lenient accounting test, another showing a substantial impairment under a stricter enterprise-
value-based lens. Both are internally generated, management-prepared analyses; neither has been
validated by an independent third-party appraisal, which does not yet exist. This will draw
significant scrutiny in any real audit regardless of which way it's ultimately resolved.

**Derivative accounting:** A specific derivative liability tied to a legacy financing
relationship was represented in one internal document as "validly valued and booked, ties to
the ledger." Direct verification against the live chart of accounts and general ledger found
this claim to be false — no such account exists, and the relevant related accounts show zero
activity. The actual derivative has not been booked. This is flagged as a genuine governance
lesson: a confident, detailed, internally-generated claim turned out to be wrong when checked
against the primary ledger, and should not have been trusted at face value.

**Litigation and contingent liabilities:** Several litigation and disputed-liability matters
exist across InnerScope's history (a note-holder dispute, an employment-related wage claim with
personal exposure implications for company principals, vendor disputes, a tax matter affecting
individuals rather than the company). Some have been reconciled/resolved this session; others
remain open or were reopened after new information surfaced. None of the specifics belong in
this doc — they live in CFO's working files and the private ledger lane, and several explicitly
need counsel's read before any characterization is treated as final.

**Audit-readiness, overall:** A red-team analysis this session characterized InnerScope's
audit-readiness profile in blunt terms appropriate to a public penny-stock issuer with a history
of at least one confirmed material omission (the derivative above), pervasive related-party
transactions, and a going-concern-relevant capital structure: expect an elevated fraud-risk
posture from any real auditor, a requirement for independent specialist valuation work, and at
least one Critical Audit Matter regardless of how the impairment question resolves. The single
highest-leverage unresolved item, repeatedly flagged, is that an independent third-party
appraisal and a real outside audit engagement have not yet started — everything produced
internally so far is a management estimate, however rigorous, not audit evidence.

---

## 3. The dilution mechanics — why the roll-up currency assumption doesn't hold today

**The mechanism:** InnerScope has an outstanding convertible note facility (a "death spiral"-
style structure) where the conversion price adjusts based on the company's own trading price,
and the lender converts debt into new shares in escalating batches. Each conversion issues new
shares to the lender, who can then sell them — which tends to press the stock price down,
which makes the NEXT conversion batch convert into even MORE shares for the same dollar amount
owed. This is a well-known, structurally self-reinforcing dilution pattern once it starts
accelerating, and this session's forensic work found direct primary-source evidence (the
transfer agent's own share register, cross-checked against InnerScope's public disclosures) that
it is currently accelerating, not winding down.

**Why this matters for the roll-up thesis specifically:** `INND-CAPITAL-FLYWHEEL.md` and
`INND-ROLLUP-LANDSCAPE.md` both describe a strategy of acquiring complementary businesses
primarily with stock, on the logic that a private seller's revenue gets "re-rated" at the
public company's own trading multiple the moment it's acquired. That logic depends on the stock
being a reasonably stable, predictable unit of value to negotiate with. **A share count that is
currently expanding rapidly and unpredictably, driven by a mechanism outside management's
control, is the opposite of a stable acquisition currency.** Any seller's advisor doing basic
diligence would surface this immediately, and any deal priced in shares today would need to
account for further dilution between signing and closing in a way that is very difficult to
model responsibly while the note is still actively converting.

**What would need to change before this stops being disqualifying:** the note would need to be
retired, refinanced, or converted in full (ending the ongoing dilution mechanism), or the
roll-up thesis would need to be restructured around cash/earnout consideration rather than
stock until the share count stabilizes. Neither has happened yet. This is a real, live,
unresolved fact pattern — not a historical footnote.

---

## 4. What's genuinely resolved (so this doc isn't all bad news)

To be fair to the work already done: several things that looked like open contradictions
earlier this session have been run down and closed with primary-source evidence rather than
left as ambiguous risk. A major cross-entity balance-sheet transfer question has been fully
traced and a corrective entry is drafted and ready pending sign-off. An ownership-structure
question that looked contradictory across documents turned out to have a clean, consistent
explanation once the actual legal documents were read directly. A large "unexplained" prior-year
transaction was traced to its actual source and resolved. The company's chart-of-accounts
design, while imperfect in execution, is fundamentally sound and mostly consistently applied
across all three related entities. None of this changes the §1 conclusion, but it's real
progress, not a story of nothing but problems.

---

## 5. Preconditions before any roll-up or combined narrative is safe to use

In rough priority order:
1. **Engage independent appraisal + real outside audit.** This is the single highest-leverage
   item — it converts every management estimate in this doc into either confirmed audit
   evidence or a known, quantified correction. Funded from a future raise per the current plan,
   but that itself depends on the numbers being credible enough to raise against — a real
   chicken-and-egg tension worth Matt's and Capital/IR's attention.
2. **Resolve the dilution mechanism** — retire/refinance/convert the note in full, or explicitly
   restructure the roll-up thesis around non-stock consideration until it's resolved.
3. **Complete the standalone financial rebuilds** for both InnerScope and HearingAssist, then
   the real consolidation workpaper — in progress, not yet done.
4. **Resolve the impairment question** with real evidence (the appraisal in #1), not competing
   internal models.
5. **Properly book the derivative** and reconcile any related restatement question.
6. **Retain securities counsel** — the master unlock for every capital-sequence and roll-up
   action regardless of the above; still not engaged.
7. **Confirm current share-issuance disclosure is complete and current** — if the dilution
   pattern in §3 is not yet reflected in InnerScope's own required public disclosures, that is
   itself a compliance gap to close, separate from the roll-up question.

Until a meaningful subset of these move, `INND-CAPITAL-FLYWHEEL.md` and `INND-ROLLUP-LANDSCAPE.md`
should be read as the destination, not the current map.

---
*Living document. Source of truth for the underlying figures = CFO's own working files (OneDrive
"CFO Incoming/Outgoing/Processed") and the `cfo`/`coo` private ledger lanes — deliberately not
this file. This doc's job is to state mechanisms, severity, and status honestly without carrying
MNPI into a shared, committed artifact. Update the categorical status here as CFO's work
resolves each item; do not add exact figures even as things get resolved — that discipline is
the point.*
