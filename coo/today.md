# TODAY — COO directive, 2026-06-20 (Friday)

Date: 2026-06-20. Operating window 9am-5pm PT.
Calendar note: Read Calendar workflow (xL0VYbElD15ttqKw) still down — Task 43 open for Matt.

## The number
Cash in bank: $0. Burn: $50K/mo. Runway: 0. The clock is not theoretical.

## Today's 3 moves

### Move 1 (FIRST DOLLAR, ~30 min) — Sign the 3 Amazon TReO PDFs
Task 34. The CRO built the entire Amazon channel; 3 pre-filled PDFs are staged in
`otchealth-exec/cro/amazon/signing/`. Matt signs, uploads the commercial invoice to
Amazon Apply-to-Sell. CRO fires the $50 TReO singles listing same-day. ~$30 net/unit,
~2,000 stageable units. This is the cleanest, fastest first-dollar path we have right now.
- Action: sign 3 PDFs + upload commercial invoice to Amazon Apply-to-Sell
- Report back: done? link to the listing?
Status: [ ] not started (carried from 2026-06-16)

### Move 2 (LIEN RISK, same-day) — Fund storage payments
Task 36. Treelake ~$1,005/mo + Security Public Storage ~$146/mo declining off an empty
Mercury account. These warehouses hold the 10,298-unit inventory ($2-3M retail value).
Unpaid = lien and auction. Fund both TODAY. Total ~$1,150 to protect the biggest asset pool.
- Action: transfer/fund Mercury, confirm both payments clear
- Report back: done?
Status: [ ] not started (URGENT - lien risk)

### Move 3 (UNLOCK EMAIL, ~2 hrs) — Fix Shopify checkout
Task 35. 0 of 9 checkout attempts completed in 14 days. Two confirmed blockers:
(1) Stripe card payments not capturing on live orders; (2) US shipping missing (assigned
to International-only profile). Fix both, run 1 live test purchase, then Send 3 v2
(draft 141, 6.8K resend, $99 TReO offer, CCO-conditionally-cleared) can go out.
- Action: Matt + CTO resolve the two checkout blockers; confirm with live test purchase
- Report back: fixed? test purchase succeeded?
Status: [ ] not started

## Security flag (not a cash move, but same-day)
Task 50: GitHub sent a 2FA-enabled notification to COOINND. Verify: did you enable it?
If YES — download and save recovery codes at github.com/settings/auth/recovery and store
in Notion API Tokens & Credentials. If NO — unauthorized access; revoke sessions, rotate
password, notify security@github.com. 5 minutes.

## Not a move today
More tooling. The Amazon channel is built. The email is drafted. The checkout diagnosis
is done. The only thing between here and first dollars is Matt executing the above 3 moves.

## Carry-over from yesterday
- Task 34: Amazon TReO PDF signing — still open
- Task 36: Storage payments — still open (lien risk escalating)
- Task 35: Shopify checkout — still open (blocks email campaign)
- Task 10: Draft 141 approval — conditional on checkout fix
- Task 50: GitHub 2FA on COOINND — new, same-day

## Security cluster (this week, not today's focus)
- Task 44: 8 secrets in InnerScopeHearing repos (GitHub secret scan, HARD GATE)
- Task 28: 28 live secrets in otchealth-ops n8n exports (rotate Azure AD/Graph FIRST)
- Task 4: Rotate GCP SA + PostHog keys (HARD GATE — blocks investor/public exposure)
- Task 5: Rotate COO routine fire token
