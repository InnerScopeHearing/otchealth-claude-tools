# TODAY — the COO's directive (regenerate each morning; mark results through the day)

Date: 2026-07-01 (Wednesday). Operating window 9am-5pm Mon-Fri PT.
Morning brief for today: sending now (marker claimed in the coo ledger, id 20260701-004).
Calendar read live: CLEAR today and for the next several days. Next events on calendar are
Monday 2026-07-06 Therapy 3-4pm PT and Tuesday 2026-07-07 Mindful Health Solutions
8:30-11:30am PT. CASH BLOCK booked today 12:00-2:00pm PT (19:00-21:00 UTC).

## The number
Cash in bank: fleet total ~$30,467 (InnerScope ~$30,464.51, almost all Reg A capital, not
working cash; OTCHealth operating cash ~$2.41 in Mercury). Revenue today: **$0**. Revenue
last 90 days: **$0**. 2026 YTD: $736 (2 Shopify orders in February). Burn ~$50K/mo, ~0
runway. **Day 22, zero cash moves CLOSED yet.** Both Matt-only gates are STILL open,
unchanged since yesterday.

## The 2 gates (Matt-only, ~15 min combined, the whole game)
1. **Connect the Stripe payout bank.** `payouts_enabled=FALSE` on acct_1SQyXZAwjS2xuomw.
   CTO confirmed (2026-06-29 live read): charges_enabled=true, card_payments=active, zero
   verification holds — the rail is fully live for taking a charge. The ONLY thing missing
   is a linked payout bank account, which is a Stripe Dashboard action, not API-fixable.
   Without it, a successful sale's cash sits trapped in Stripe and never reaches Mercury.
   Status: **still open** (in progress per Matt as of 2026-06-30 — no confirmation posted
   since).
2. **Place ONE real, non-refunded, full-price TReO Pair order** (code PAIR99, nets $99) at
   otchealthmart.com to clinch CHECKOUT-PROOF=PASS (CTO verifies: Shopify paid+fulfilled,
   Stripe charge succeeded+unrefunded, payouts_enabled=true). Only one charge has ever hit
   this account and it was an owner test that was refunded — that does not count as proof.
   Status: **still open** (in progress per Matt as of 2026-06-30 — no confirmation posted
   since).

## Fires the instant both gates close — Send draft-141
draft-141 is written, dash-clean, CCO-cleared (CAN-SPAM elements present), mailable count
LOCKED = **66,224** valid HearingAssist contacts (Customer.io ws 193366). CTA points at
/pages/treo-pair-offer (PAIR99). Runbook: seed wave (~5-10K), watch 20-30 min, then release
the rest. Held awaiting both gates + Matt's explicit send-go (email only — no SMS, TCPA
unverified).
Status: staged, gated. Nothing to do here today except close the 2 gates above.

## Parallel, zero technical gates — Gumroad "From the Chair"
The full manuscript is DONE: Foreword + 18 chapters + The Modern Layer + front/back matter,
all dash-clean, all research-verified (CRO killed a bad ad-spend stat and re-sourced 6+
claims to real citations). Gumroad account is fully stood up. The ONLY thing left is
Matt's call: **pick the edition (A/B) and lock final pricing** so CRO can finish the
fillable-PDF build and publish the listing. Zero gates once chosen — cash in days.
Status: manuscript complete, awaiting Matt's pricing/edition decision with CRO.

## Not a move today (resist it)
- **More planning/building.** The Moore Playbook + 12-month plan + execution program are
  DONE and durable on main. Today's only real work is closing the 2 gates and deciding
  Gumroad pricing.
- **FDA OTC Establishment Registration** (~$10K, <2wk) — funded AFTER first dollars.
- **Amazon TReO** — blocked on the iHEAR trademark filing — also fund-after-first-dollars.

## Standing hard gate (not a move, but it BLOCKS investor/public action)
- **Rotate the GCP SA + PostHog keys** (28-cred ops leak, deferred since before 2026-06-14).
  No investor or public exposure until done. Flagging again — this has been open for
  weeks and quietly gates the whole capital lane whenever that becomes the focus.

## Today's results so far
- 2026-07-01 morning brief sent (Day 22). Calendar clear through 2026-07-05; CASH BLOCK
  booked 12:00-2:00pm PT today. Both gates confirmed still open (no change from Matt since
  2026-06-30). Gumroad manuscript confirmed complete and ready the moment pricing is set.

## Reconciled to the ledger
This directive matches the `coo` ledger as of 2026-07-01 (entries through `20260701-004`).
Confidential specifics live in the kb-memory `coo` private lane. The COO's hands are the
n8n webhook paths coo-read-calendar / coo-send-email / coo-create-meeting.
