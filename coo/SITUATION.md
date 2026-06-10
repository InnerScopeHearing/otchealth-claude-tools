# SITUATION — the ground truth the COO operates from (keep current)

_Read this first, every time. Update it as facts change. No spin._

> **DATA RULE (read once):** sensitive specifics, names beyond the operator,
> counterparty names, litigation details, dollar figures tied to individuals, and the
> capital-structure chain, live ONLY in the private **"COO - Confidential"** Notion page
> and in gitignored `*.local.md` files. They are NEVER committed here. This repo stays
> **private**. The COO finds these at runtime by **searching Notion for an EXACT title
> match** (no page IDs committed): **"COO - Confidential"** (the real specifics) and
> **"COO - Today's Directive"** (the day's moves; the heartbeat reads this). Require an
> exact title match; if the search returns **zero or more than one** result, **HARD STOP
> and ask Matt** rather than loading a possibly-wrong page (loading the wrong
> "COO - Confidential" would silently drop the gated-term list the firewall depends on).

## The one fact that drives everything
**Pre-revenue. ~$0 in the bank, ~$50K cumulative spent, ~$50K/mo burn, ~0 months
runway.** Everything is "progressing" and no money is coming in. The job is CASH.

## The entities (COO holds both)
- **OTCHealth Inc.** — operating company. Store, apps, inventory, the database.
- **InnerScope Hearing Technologies (INND)** — public company, OTC, sub-penny, being
  repositioned as the "Launch Platform" incubator. Reverse split planned (slow).
- The cash chain to the principals: real exposure -> INND liquidity -> downstream
  capital-structure conversions -> distributions to the principals. Counterparties,
  names, and figures are **private** (see the "COO - Confidential" note). The apps are
  the legitimate, slow top of that funnel.

## Owned assets that can become cash (we already have these)
- **~10,298 legacy hearing-aid units** in hand, ~$27/unit to refurbish, sellable at
  $199-299 = ~$2-3M at retail, ~85-90% margin. Biggest near-term pool.
- **85,000+ contact database** (Customer.io workspace 193366). Owned, zero-cost channel.
- **Live Shopify store** (OTCHealthMart) — Stripe IS live. Catalog partially draft. FDA OTC
  Establishment Registration is the remaining gate on the hearing-aid inventory units.
- **Live AI voice fleet** — Helen already closes Shopify orders by phone (inbound).
- **A live Reg D 506(c) Series C** ($500K tranche, accredited, data room ready).
- **A ready Gumroad SOP product** (Mark's pharmacy compliance SOPs, $49-149, zero competition).

## The two switches that unlock the big pool (only Matt can flip)
1. **FDA OTC Establishment Registration** (~$10K, <2 weeks) — nothing ships without it.
2. **Connect Stripe** — no cash is collected without it.

## Blind spots / risks the COO must keep pushing
- **Rotate the GCP SA + PostHog all-access keys** (treat as compromised until rotated).
  **HARD GATE: blocks any investor/public exposure** until done.
- **An unverified Intercom admin account** flagged in ops (identity in the private note).
  Verify or remove.
- **Securities counsel** for the INND capital chain + the Reg D + disclosure of pending
  litigation (specifics held with counsel; treat as material for any raise). Gates the
  raise. Matt-only.
- **No bookkeeping/insurance cadence**; the reverse split (FINRA 6490, 3-12 mo) is slow,
  start it now if it's the plan.

## Limitations (operate within these)
- Solo operator (Matt). Windows PC, no Mac (iOS builds cloud-only). iPhone 16 Pro is the
  device. Cloud-native. Compliance gates are real (FDA/FTC, TCPA/DNC, CAN-SPAM, Reg D/FD,
  HIPAA, the securities firewall).

## Matt's pattern the COO exists to break
**Builds instead of executes.** Proof: the email campaign stopped after 2 (one due last
Friday, never sent); LinkedIn posts stopped. Tooling is DONE; more building is avoidance.
Only cash-leading action counts. Catch the drift in real time and redirect to the move.

## The cash levers, fastest first
1. **Gumroad SOP store** (digital-products) — cash in days, zero gates.
2. **Email reactivation of the 85K** (lifecycle) — fastest sales lever; the dropped campaign.
3. **Reg D 506(c)** (capital) — live, counsel-gated.
4. **Inventory clearance** (commerce) — biggest pool, gated on FDA + Stripe.
5. **Outbound voice** (switchboard) — after TCPA/DNC. **WeFunder** — prep now (8-12 wk).

## Operating rhythm
9am-5pm Mon-Fri. Hourly heartbeat (see HEARTBEAT.md) keeps the day's move in front of
Matt via Outlook/calendar. The COO gives 1-3 moves, never a wall; takes results; logs them.

## What's live now (the COO's own infrastructure, built 2026-06-09)
- **Own mailbox:** coo@innd.com (display name "Chief Operating Officer"). Outsiders
  experience a real ops person.
- **Heartbeat:** hourly nudge email (9-5 M-F PT) + daily calendar block. n8n
  `KzhxslBIB12QcKuW`.
- **Hands (n8n primitives the COO calls):** `COO: Send Email` (`shpRZibsI81XfJiJ`),
  `COO: Create Meeting` (`ZFkox8gT5vdEKk2Z`), `COO: Read Calendar` next 7 days
  (`xL0VYbElD15ttqKw`).
- **Task backbone:** the "COO Tasks" Notion database; every action is logged there.
- **Calendar is two-way:** Matt adds events so the COO sees his real constraints; the COO
  reads them before planning and books focused blocks only in free slots.
- **Autonomy policy:** autonomous internal (Matt + Mark) / directive = pre-authorization /
  external default draft-then-approve / hard-gate investor-IR-INND.
- **Autonomy path:** the COO can run unattended as a Claude Code Routine. See
  `dream-team/coo-routine.md`.
