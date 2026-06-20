# TODAY — the COO's directive (regenerate each morning; mark results through the day)

Date: 2026-06-20 (Friday). Operating window 9am-5pm PT. Last day before the weekend.

## The number
Cash in bank: $0. Burn $50K/mo. Runway: 0. Every day without revenue is a day closer to zero.

## Today's 3 moves (in order — the Amazon PDFs take 15 min, do them first)

### Move 1 (~15 min) — FIRST DOLLAR GATE: Sign the 3 Amazon TReO PDFs
The CRO built the Amazon channel end-to-end. 3 PDFs are pre-filled and waiting in
otchealth-exec/cro/amazon/signing/. All Matt does is sign and upload the commercial invoice
to Amazon's Apply-to-Sell portal. Channel goes live same day. ~$30+ net/unit, ~2,000 units
stageable. This is the single fastest dollar available without any compliance gates.
- Open the PDFs, sign all 3, upload to Apply-to-Sell.
- Report back: done? Order ID or confirmation?
Status: [ ] not started

### Move 2 (~10 min) — URGENT: Fund the storage payments (lien risk on $2-3M inventory)
Treelake ~$1,005/mo + Security Public Storage ~$146/mo are declining off an empty Mercury
account. These warehouses hold the ~10,298 legacy units. Unpaid = lien + auction = the
entire $2-3M pool is gone. Pay both TODAY.
- Log into Mercury, fund the account, pay Treelake and Security Public Storage.
- Report back: paid? Confirmation numbers?
Status: [ ] not started

### Move 3 (~45 min, Matt + CTO) — Fix Shopify checkout (blocks ALL email revenue)
0 of 9 recent checkout sessions completed. Two confirmed blockers: (1) Stripe card payments
not capturing on live orders, (2) US shipping missing from active hearing-aid products
(assigned to International-only profile). Neither email campaign nor draft 141 ships until
checkout converts. Flag to the CTO right now and confirm a fix-by-EOD commitment.
- Ping Mark / open a session: "fix Shopify checkout - Stripe capture broken, US shipping
  profile missing on hearing aids."
- Prove with 1 live test purchase before EOD.
- Report back: fixed? Test order confirmed?
Status: [ ] not started

## Security gates (block investor + public exposure until cleared)
These are accumulating. The COO cannot clear them autonomously.
- HARD GATE (Task 28): 28 live secrets in n8n exports — Azure AD/Graph client secret is
  #1 priority (mailbox access, potential PHI). Rotate NOW. Still open despite June 14
  deferral; the credentials stay valid and exposed until rotated.
- HARD GATE (Task 44): 8 secrets in InnerScopeHearing repos. Rotate + BFG purge.
- URGENT (Task 46/50): Enable 2FA on COOINND GitHub account. GitHub enforcement is live.
- TIME-GATE (Task 39): Accept GitHub enterprise invite for coo@innd.com by June 23
  (Tuesday). Go to the shared mailbox and click Join OTCHealth.

## Not a move today (resist it)
Building more tools. Shipping more features. The system is DONE. The Amazon PDFs have been
sitting signed-and-ready for days. The warehouse lien is real and growing. Do Move 1 first.

## Previous open items (still need closure)
- Gumroad SOP store: not started (digital-products can draft the SOPs anytime Matt asks)
- FDA OTC Establishment Registration: not filed
- LinkedIn cadence: not restarted
- COO Read Calendar workflow (Task 43): inactive on self-host; Matt must toggle active

## Yesterday's results
(not reported)
