# SITUATION — the ground truth the COO operates from (keep current)

_Read this first, every time. Update it as facts change. No spin._

> **DATA RULE (read once):** sensitive specifics — names beyond the operator,
> counterparty names, litigation details, dollar figures tied to individuals, and the
> capital-structure chain — live ONLY in the **kb-memory `coo` PRIVATE lane**
> (`mem.mjs ... --agent coo` **WITHOUT** `--share`). They are NEVER committed here and
> NEVER `--share`d to the exec feed/brain. The legacy **"COO - Confidential" Notion page
> is RETIRED** (Notion sunset); do not search Notion for it. Recall confidential specifics
> with a targeted private-lane recall (`mem.mjs recall "<topic>" --agent coo`). The day's
> directive is no longer a Notion page either — today's moves live in `coo/today.md` + the
> `coo` ledger. This repo stays **private**; shareable cross-team facts go to the exec feed
> with `--share`, confidential stays private-lane only.

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
- **85,000+ contact database** (Customer.io workspace 193366; mailable LOCKED = 66,224
  valid/consented HearingAssist contacts). Owned, zero-cost channel.
- **Live Shopify store** (OTCHealthMart / hearingassist.myshopify.com) — **PROVEN BUT
  DORMANT**: ~$227,290 all-time across 1,484 orders, but **$0 in the last 90 days and 0
  TReO units sold**. Stripe **IS connected** (remediated to Stripe-only, store apps cut
  34->12), but **no real customer card order has completed in all of 2026** — checkout is
  UNPROVEN. Mission = REIGNITION of a proven store, not first-dollar. Catalog cleaned by
  Commerce (28 off-brand SKUs deleted); only ~11 of 79 products active.
- **TReO PSAP** — the only no-limit sellable lever right now (~1,000 pairs, ~$0 COGS;
  single $99, pair $149, code PAIR99 -> pair nets $99). Spell exactly "iHEAR TReO".
- **Live AI voice fleet** — Sarah (inbound CS, 800-864-4337), Helen (sales), etc. closes
  Shopify orders by phone (inbound).
- **A live Reg D 506(c) Series C** ($500K tranche, accredited, data room ready).
- **A ready Gumroad SOP product** (Mark's pharmacy compliance SOPs, $49-149, zero competition).

## The gates that unlock the cash (only Matt can flip)
1. **Prove the TReO checkout** — Stripe IS connected; the remaining blocker is **one real
   full-price TReO customer order** to prove the remediated checkout end-to-end. On proof,
   draft-141 fires to 66,224 -> first dollars. This is the #1 near-term gate.
2. **FDA OTC Establishment Registration** (~$10K, <2 weeks) — unlocks the big inventory
   pool; nothing in the ~10,298-unit hearing-aid line ships without it. (Stripe is no
   longer a blocker — it's done.)

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
4. **Inventory clearance** (commerce) — biggest pool, gated on FDA registration (Stripe done).
5. **Outbound voice** (switchboard) — after TCPA/DNC. **WeFunder** — prep now (8-12 wk).

## Operating rhythm
9am-5pm Mon-Fri. Hourly heartbeat (see HEARTBEAT.md) keeps the day's move in front of
Matt via Outlook/calendar. The COO gives 1-3 moves, never a wall; takes results; logs them.

## What's live now (the COO's own infrastructure, built 2026-06-09)
- **Own mailbox:** coo@innd.com (display name "Chief Operating Officer"). Outsiders
  experience a real ops person.
- **Heartbeat:** hourly nudge email (9-5 M-F PT) + daily calendar block (n8n).
- **Hands (n8n primitives the COO calls — verified ACTIVE 2026-06-27):** call via
  **POST `https://automation.otchealth.app/webhook/<path>`**. Paths (NOT workflow IDs):
  `coo-read-calendar` (Read Calendar, next 7 days; workflow `PR3fEnWKJcxXyqES`),
  `coo-send-email` (Send Email; workflow `jt4RVnYHI83EsOX9`),
  `coo-create-meeting` (Create Meeting; workflow `28XO4EuN11LYx4yh`).
  > The old IDs (`shpRZibsI81XfJiJ` / `ZFkox8gT5vdEKk2Z` / `xL0VYbElD15ttqKw`) are STALE
  > (June-9 build) — do not use them; the webhook URL uses the path, not the workflow ID.
- **Task backbone:** the kb-memory `coo` ledger (`mem.mjs`, Azure-backed, auto-shared to the exec feed + brain); every action is logged there. The old "COO Tasks" Notion DB is retired.
- **Calendar is two-way:** Matt adds events so the COO sees his real constraints; the COO
  reads them before planning and books focused blocks only in free slots.
- **Autonomy policy:** autonomous internal (Matt + Mark) / directive = pre-authorization /
  external default draft-then-approve / hard-gate investor-IR-INND.
- **Autonomy path:** the COO can run unattended as a Claude Code Routine. See
  `dream-team/coo-routine.md`.
