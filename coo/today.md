# TODAY — the COO's directive (regenerate each morning; mark results through the day)

Date: 2026-06-30 (Tuesday). Operating window 9am-5pm Mon-Fri PT.
Morning brief already sent today (Day 21) — calendar was busy 8:30-11:30am PT (Mindful
Health Solutions); CASH BLOCK booked 12pm-2pm PT. This file is refreshed mid-day to match
what actually happened since the brief, not a second brief.

## The number
Cash in bank: **$0**. Revenue last 90 days: **$0**. Burn ~$50K/mo, ~0 runway. **Day 21,
zero cash moves closed.** Both Matt-only gates are now IN PROGRESS (not untouched) — this
is real movement, even though no dollar has landed yet.

## The two gates (Matt-only, the whole game)
1. **Connect the Stripe payout bank.** `payouts_enabled=FALSE` on the TReO Stripe account
   means even a completed sale leaves cash trapped in Stripe, never reaching Mercury.
   Status: **Matt is personally handling this, in progress** (per Matt direct, 2026-06-30).
2. **Place ONE real full-price PAIR99 TReO order** so CTO can post `CHECKOUT-PROOF=PASS`
   (Shopify paid+fulfilled, Stripe charge succeeded+unrefunded, payouts_enabled=true).
   Status: Matt verified the checkout works fine in his own testing (2026-06-30), but the
   formal proving order + CTO `CHECKOUT-PROOF=PASS` post has **not** been logged yet.
- On both gates closing: CRO/lifecycle fire draft-141 (staged, dash-clean, CAN-SPAM clean,
  claims_check-clean) to the LOCKED 66,224-contact segment, email-only, send as a ~2,000
  seed wave first, then the rest. Needs Matt's explicit send-go.

## Move running now (parallel, zero gates)
**Gumroad store is fully set up** (Matt, 2026-06-30) — the account/storefront is live.
Remaining: Matt + CRO are finalizing which product goes up first ("From the Chair" book
vs. the SOP bundle). Report back: which product, and is it listed with a link?

## Not a move today (resist it)
- More planning. The Moore Playbook (strategy), the 12-month implementation plan (all 9
  exec hats), the gap review (27 verified gaps), and a live Miro board for Matt + Mark/Kim
  are all DONE and committed to `main`. The strategic layer is finished; the only open
  items are the two Matt-only gates above plus the Gumroad first-product pick.
- FDA OTC Establishment Registration and the Amazon/iHEAR trademark filing — fund-after-
  first-dollars, not today moves.

## Standing hard gate (not a move, but it BLOCKS investor/public action)
- Rotate the GCP SA + PostHog keys (28-cred ops leak, still deferred). No investor or
  public exposure until done.

## Today's results so far
- 2026-06-30 morning brief sent (Day 21).
- Matt verified checkout works; Stripe payout-bank connect in progress (Matt-owned).
- Gumroad fully stood up; first product being chosen with CRO.
- Moore Playbook 12-month implementation + Miro board delivered; PRs #244 (claude-tools)
  and #2 (otchealth-exec) both merged to main — no finished work left sitting in a draft PR.
- 5 of 7 Moore-execution dispatches have committed artifact work product; the 2 remaining
  (CTO infra verification, lifecycle live send) wait on live access / the gates above.

## Reconciled to the ledger
Matches the `coo` ledger as of 2026-06-30 (entries 20260630-018 through -022). Confidential
specifics stay in the kb-memory `coo` private lane. Hands: n8n webhook paths
coo-read-calendar / coo-send-email / coo-create-meeting at
`POST https://automation.otchealth.app/webhook/<path>`.
