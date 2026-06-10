# COO BRIEFING — how the buckets keep the quarterback's picture current

Dispatch (`coo/DISPATCH.md`) sends work DOWN to the buckets. This is the other
direction: real status flows UP from each bucket to the COO, so the quarterback
calls plays on reality, not on a stale memory.

**Why this exists (the failure it fixes):** on 2026-06-10 the COO dispatched a
"send the reactivation email, it was never sent" packet. It was wrong. The emails
had gone out the week before. The COO is a separate, ephemeral session from the
buckets that do the work, so its picture decays the moment a bucket does something
the COO does not witness. Without a feedback path the COO confidently dispatches
work that is already done. That is the bug. The briefing is the fix.

## The home of truth: the "Bucket Briefings" Notion DB

`collection://2bed2bba-52f8-4665-ba7d-46044a11d549` (under "Business — OTCHealth").
One row per bucket per day. Columns:

- **Bucket** — which session/lever (Shopify, Gumroad, iHEARtest, MedReview, ...).
- **Date.**
- **Cash Lever Status** — the single source of truth for where this lever really sits.
- **What Happened** — tasks done + status changes since the last brief.
- **Real Numbers** — facts, not plans: sent counts, opens, orders, revenue, units, dollars.
- **Blockers.**
- **Needs From COO** — what the bucket needs the quarterback to decide or unblock.
- **Reconciled** — `New` until the COO folds it in, then `COO Read`.

A briefing is the bucket's daily audit of itself. It replaces the expensive ritual of
spinning up a fresh session to re-audit a project from scratch, the audit becomes a
cheap daily delta instead of a from-scratch rediscovery.

## Two tiers (same shape as dispatch)

### Tier 1 — end-of-session brief (live today, zero new infra)
Each bucket repo's `CLAUDE.md` (or a `/eod` skill) carries this rule:

> Before ending a working session, write one row to the Bucket Briefings DB for this
> bucket: today's date, the real current status of this bucket's cash lever, what
> changed today, the real numbers, blockers, and anything you need the COO to decide.
> Set Reconciled = New. Be factual; numbers over adjectives.

Works the instant it is added. Latency: whenever the session next runs. Cost: zero.

### Tier 2 — scheduled auto-brief (proven routine pattern, generalized)
A nightly n8n trigger (e.g. 6pm PT) fires each bucket's Claude Code routine in
**REPORT MODE**. The routine reads its repo's commits since the last brief + its open
Notion tasks + any session notes, summarizes them, and writes the briefing row, no
human needed. This is the same routine-API-trigger mechanism already proven by the COO
inbound email loop, pointed at "summarize your day" instead of "handle this email."
Gated on Matt creating one routine per bucket (one-time), exactly like Tier 2 dispatch,
so dispatch and briefing can share the per-bucket routine.

## The COO side: reconcile at the start of every run

This is now part of step 1 of the COO routine (load the truth):

1. Read the **New** rows in Bucket Briefings.
2. Fold each into `coo/SITUATION.md` and re-rank `coo/PRIORITIES.md` to match reality.
3. Mark each row **COO Read**.
4. Only THEN decide the day's moves and dispatch.

Rule: **the latest bucket briefing always beats the COO's own memory.** If they
disagree, the COO is stale; trust the bucket and update.

## The full loop
Matt (coach) -> COO (quarterback) reconciles briefings -> dispatches a packet ->
bucket (receiver) executes + files a briefing -> COO reconciles -> next play.
A closed loop means the quarterback is never again calling a route the receiver
already ran.
