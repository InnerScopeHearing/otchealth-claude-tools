# TODAY — the COO's directive (regenerate each morning; mark results through the day)

Date: 2026-06-11 (refreshed). Operating window 9am-5pm PT.

## The number
Cash in bank: $0. Goal: first dollars THIS WEEK. Burn ~$50K/mo. The clock is real.
Two weeks have passed since the seed. All three cash moves are still not started.

## INFRA ALERT (urgent, today)
**n8n Cloud is hard-locked** (billing failure + plan cap). All 35 workflows are suspended:
COO heartbeat, inbound loop, Send Email/Create Meeting primitives, AND production app
webhooks (iHEARtest, AWARE, Shopify, Helen voice line). COO-21 is the dispatch to
migrate all flows to self-hosted Azure. Provider decided, runbook written, approved.
This blocks the COO nervous system until resolved. See COO Tasks COO-21.

## Today's 3 moves (do these, in order)

### Move 0 (urgent, ~2-3 hrs, blocks the COO) — Unblock n8n: kick off the Azure migration
COO-21 is approved and due today. Open a builder session and dispatch the CTO task:
- Export all 35 workflow definitions + credentials inventory from Cloud while access remains.
- Provision the Azure Ubuntu VM (Standard_B2as_v2) and deploy docker-compose: n8n + Postgres + Caddy.
- Get TLS + subdomain live, confirm n8n loads, re-point COO workflows first.
Full runbook is in the COO-21 Notion task.
Status: [ ] not started

### Move 1 (overdue 10+ days, ~30 min) — Send the reactivation email
This campaign has been due since before the June 6 briefing. It is the fastest, cheapest
cash lever and it is still sitting in a draft.
- Open a Claude Code session: "draft the reactivation email for the 85K (offer:
  accessories/TReO now, hearing-aid clearance teased), CAN-SPAM compliant."
- Review it, approve, send the first segment in Customer.io.
- Report back: sent? to how many?
Status: [ ] not started

### Move 2 (cash in days) — Stand up the Gumroad store
- Tell Claude (a session): "draft the 10-15 pharmacy/OTC compliance SOPs from Mark's
  outline." (digital-products skill). Get the drafts.
- Create the Gumroad account, list them at $49-149, turn on instant delivery.
- Report back: listed? link?
Status: [ ] not started

### Move 3 (unlock the big pool, ~1-2 hrs) — Flip one switch
Pick ONE: file the FDA OTC Establishment Registration (~$10K, <2wk), OR connect Stripe.
Both are required to sell the 10,298 units. Doing one today moves the $2-3M pool closer.
Status: [ ] not started

## Not a move today (resist it)
Building more tools. The system is done (and currently locked). If you feel the urge,
that is the avoidance pattern. Come back to Move 1.

## Active tracks (not today's focus)
- Azure NCASv3_T4 GPU quota: waiting on Microsoft (COO-20, self check-in 2026-06-13).
- GCP SA + PostHog key rotation: HARD GATE before any investor/public action (Matt-only).
- Securities counsel engagement: gates the Reg D raise (Matt-only).
- Reverse split filing: FINRA 6490, 3-12 mo lead time. Start it if that is the plan.

## Yesterday's results
No results logged since June 9 seed. Three cash moves remain not started.
