---
name: raise-ops
description: Capital-raise campaign operations, runs the actual fundraise across vehicles (Reg D 506(c), Reg CF / WeFunder, Reg A+, and other sources), the reservation funnel, investor CRM + outreach, the data room, and the campaign timeline. The execution layer beneath ir-support. Wielded by the Capital agent. HEAVILY gated, every investor-facing word is attorney + Matt approved; this skill prepares and operates, counsel and the human decide.
---

# raise-ops — run the raise, compliantly

Capital is one of the two fastest paths to cash (alongside selling owned inventory).
This skill operates a real raise end to end. It is the **gated lane**: it prepares,
sequences, and tracks; **counsel + Matt approve every investor-facing item.** Read
`growth-pr/templates/securities-firewall.md` first.

## When to invoke
Choosing a raise vehicle, opening or running a campaign, building the reservation
list, or managing investor outreach and the data room.

## 1. Pick the vehicle (see `templates/vehicle-matrix.md`)
- **Reg D 506(c)** (accredited only, general solicitation allowed, issuer MUST verify
  accredited status): fastest to real cash; OTCHealth's Series C tranche is the live
  example. Days-to-weeks.
- **Reg CF / WeFunder** (anyone can invest, capped, needs Form C + reviewed/audited
  financials, 8-12 wk prep): broad retail crowd; ~weeks to launch.
- **Reg A+** (larger, "mini-IPO," SEC qualification, months + cost): later-stage.
- Match vehicle to time-to-cash, amount, and who can invest.

## 2. Build the reservation funnel (the conversion multiplier)
Reservations convert ~35-40% vs ~1-3% cold. Build a 1,500-3,000 interest list BEFORE
launch via `lifecycle-crm` (email to the 85K), `content-engine`, and `paid-ads`.
Use **Testing-the-Waters (Rule 206)** to gauge interest, but **no money is accepted**
during TTW and all TTW materials get filed with the Form C.

## 3. Operate the campaign
- Investor CRM (segments, outreach sequences, follow-ups via Customer.io/n8n).
- Data room readiness (NDA-gated for Reg D institutional DD; the OTCHealth room exists).
- Timeline + milestones (front-load week 1 to 20-30% of target); the $250K milestone
  unlocks a platform investor blast.
- Track committed vs target vs fees (WeFunder ~7.9% + $1k; plan ~11-13% all-in).

## Hard guardrails (the reason this is gated)
- **Every investor-facing word is draft-only -> attorney review -> Matt approves.**
- Reg D: verify accredited status (not self-certify). Reg FD discipline once INND is involved.
- No share-price promotion, no guarantees, PSLRA safe-harbor on projections, 17(b)
  disclosure of any compensated promotion. Never claim a 510(k) OTCHealth doesn't hold.
- No paid ads that solicit the security without counsel sign-off (advertising a
  raise is rule-bound).
- No em or en dashes in published copy.

## Output
A chosen vehicle + a sequenced campaign + a growing reservation list + a tracked
investor pipeline, every external item counsel-approved. Status to the Capital agent
and the cash.manifest.
