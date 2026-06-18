# PRIORITIES — the standing stack (COO re-ranks as things move)

Ranked by cash impact x speed x "only Matt can do it." The COO pulls today's 1-3 moves
from the top of this list. Update status as items complete.

## EMERGENCY (deal with today before anything else)
0. **Fund storage payments NOW** (COO-36) -- Treelake (~$1,005/mo) + Security Public
   Storage (~$146/mo) declining off empty Mercury. Lien/auction risk on ~$2-3M inventory.
   Pay from any available card or account. [URGENT, Matt only]

## NOW (this week -- first dollars)
1. **Sign the Amazon TReO PDFs** (COO-34) -- 3 pre-filled PDFs in
   otchealth-exec/cro/amazon/signing/. Sign + upload commercial invoice to Apply-to-Sell.
   CRO fires $50 singles listing same-day. ~$30 net/unit, ~2,000 stageable.
   OVERDUE since 2026-06-16. [Matt only, 5 min]
2. **Stand up the Gumroad store** (COO-2) -- 14 SOPs generated, runbook at
   otchealth-exec/coo/gumroad-launch/LAUNCH-RUNBOOK.md. Create account, paste listings,
   upload PDFs. Cash in days, zero gates. [Matt only, 30 min]
3. **Fix Shopify checkout** (COO-35) -- 2 confirmed blockers: (a) Stripe card not
   capturing on live orders, (b) US shipping missing on active hearing aids (International-
   only profile). Fix both, prove with 1 live test purchase. This unblocks Draft 141
   (6,800 non-opener resend) and any paid traffic to the store.
4. **File FDA OTC Establishment Registration** (COO-3) -- ~$10K at FDA FURLS, <2 weeks.
   Only remaining gate on the $2-3M inventory pool. [Matt only]

## THIS WEEK (security + compliance hard gates)
5. **HARD GATE: GitHub secret scanning** (COO-44) -- 8 secrets in InnerScopeHearing repos.
   HARD GATE blocks investor/public exposure. Rotate all exposed secrets, BFG purge history.
   [Matt]
6. **HARD GATE: 28 committed secrets in n8n exports** (COO-28) -- All valid, reachable.
   Matt deferred. CCO says rotate Azure AD client secret NOW (mailbox access, PHI risk).
   [Matt]
7. **HARD GATE: Rotate GCP SA + PostHog keys** (COO-4) -- Treated as compromised.
   Blocks investor-facing or public action. [Matt]
8. **Enable 2FA on COOINND GitHub** (COO-46) -- Account restriction imminent.
   5 min. [Matt, overdue]
9. **Verify/remove unverified Intercom admin** (COO-6, Naveed Ali Qureshi). [Matt]

## IN MOTION (parallel, longer)
10. **Reg D 506(c) outreach** (COO draft) -- live, counsel-approved every word.
11. **WeFunder prep** (Form C + reviewed financials + reservation list) -- 8-12 wk lead.
12. **Reverse split** -- start it (FINRA 6490 is 3-12 months).
13. **Engage securities counsel** for INND capital chain + Reg D + litigation disclosure.
    Gates the raise. [Matt only]
14. **Draft 141 email resend** (COO-10, 6,800 non-openers, $99 TReO) -- CCO conditional
    clear. BLOCKED until Shopify checkout fixed.

## INFRASTRUCTURE (one-time fix needed)
15. **Update SITUATION.md webhook IDs** (done 2026-06-18) -- Correct paths found:
    coo-send-email, coo-read-calendar, coo-create-meeting.
16. **n8n webhook path reconciliation** -- SITUATION.md had stale IDs for COO primitives.
    Fixed in coo run 2026-06-18.

## BANKED (do not spend focus on)
- More tooling. The operating system is DONE. Building is the avoidance pattern.
- New grants that duplicate a filled lane.
