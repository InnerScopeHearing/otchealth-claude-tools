# TODAY — the COO's directive (regenerate each morning; mark results through the day)

Date: 2026-06-30 (Tuesday). Operating window 9am-5pm Mon-Fri PT.
Morning brief for today already sent (see log). This file refreshed mid-day to match the
live `coo` ledger — no new brief, no new calendar block (idempotency guard respected).
Next event on calendar: **CASH BLOCK - TReO checkout + Gumroad pricing**, 2026-07-01
02:00-04:00 UTC.

## The number
Cash in bank: **$0**. Revenue last 90 days: **$0**. Burn ~$50K/mo, ~0 runway. **Day 21,
zero cash moves CLOSED yet** — but both Matt-only gates are now IN PROGRESS (not stalled):

## The 2 gates (Matt-only, ~15 min combined, the whole game)
1. **Connect the Stripe payout bank.** `payouts_enabled=FALSE` on acct_1SQyXZAwjS2xuomw —
   charges work (charges_enabled=true, no verification holds) but collected cash would sit
   trapped in Stripe with no bank to land in. Dashboard-only fix, not API-fixable.
   Status: **in progress (Matt directly, 2026-06-30).**
2. **Place ONE real, non-refunded, full-price TReO Pair order** (code PAIR99 -> nets $99)
   on otchealthmart.com to clinch CHECKOUT-PROOF=PASS (CTO verifies: Shopify paid+fulfilled,
   Stripe charge succeeded+unrefunded, payouts_enabled=true). Matt has verified the site
   checkout works generally; the one proving order is what flips CHECKOUT-PROOF.
   Status: **in progress (Matt directly, 2026-06-30).**

## Fires the instant both gates close — Send draft-141
draft-141 is written, dash-clean, CCO-cleared (CAN-SPAM elements present), mailable count
LOCKED = **66,224** valid HearingAssist contacts (Customer.io ws 193366). CTA points at
/pages/treo-pair-offer (PAIR99). Runbook: seed wave (~5-10K), watch 20-30 min, then release
the rest. Held awaiting both gates + Matt's explicit send-go (email only — no SMS, TCPA
unverified).
Status: staged, gated.

## Parallel, zero gates — Gumroad store
**Gumroad account is fully stood up (Matt, 2026-06-30).** First product being chosen with
CRO — "From the Chair" (Mark's book, 136pp manuscript delivered, pricing options $7/$7/
bundle $7 suggested) vs. the 5-SOP compliance bundle. Whichever is ready first, ship it.
Status: live, first-listing decision pending.

## Strategic spine (context, not a today-move)
The Moore Playbook (12-month implementation, execution program, 27-gap review) is complete
and merged to `main` (`projects/moore-playbook/`). It is the long-range plan underneath
today's 2 gates — do not let more planning substitute for closing them.

## Not a move today (resist it)
- **More planning/building.** The Moore Playbook is DONE and durable. Today's only real
  work is closing the 2 gates above and picking the first Gumroad listing.
- **FDA OTC Establishment Registration** (~$10K, <2wk) — funded AFTER first dollars.
- **Amazon TReO** — blocked on the iHEAR trademark filing — also fund-after-first-dollars.

## Standing hard gate (not a move, but it BLOCKS investor/public action)
- **Rotate the GCP SA + PostHog keys** (28-cred ops leak, deferred). No investor or public
  exposure until done.

## Today's results so far
- 2026-06-30 morning brief sent (Day 21). Calendar: Mindful Health Solutions 8:30-11:30am
  PT; CASH BLOCK booked. Both gates moved from "not started" to "in progress" (Matt
  direct). Gumroad stood up. Moore Playbook (PR #244) + COO cash work (otchealth-exec PR
  #2) both merged to main.

## Reconciled to the ledger
This directive matches the `coo` ledger as of 2026-06-30 (entries through `20260630-063`).
Confidential specifics live in the kb-memory `coo` private lane. The COO's hands are the
n8n webhook paths coo-read-calendar / coo-send-email / coo-create-meeting.
