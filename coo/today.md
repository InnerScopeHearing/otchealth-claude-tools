# TODAY — the COO's directive (regenerate each morning; mark results through the day)

Date: 2026-06-11. Operating window 9am-5pm.

## The number
Cash in bank: $0. Goal: first dollars THIS WEEK. Burn ~$50K/mo. The clock is real.

## Foundation built (2026-06-10 + this morning)
The C-suite org is designed. The infrastructure (mailbox, heartbeat, dispatch loop,
briefing loop, send-later) is all live. The repo structure is staged.

**What is NOT done yet = what needs to happen today:**

## Move 1 — CTO: launch NOW (n8n is hard locked)
All 35 n8n workflows are suspended. COO nervous system, iHEARtest webhooks, AWARE,
Shopify, Helen voice -- all offline. The CTO session fixes this.

**Matt's action:**
1. Open `InnerScopeHearing/otchealth-cto` (already created)
2. Start a NEW Claude Code session on that repo (All repositories access)
3. Paste the prompt from `coo/CTO-PROMPT.md`
4. The CTO reads the dispatch, starts the Azure migration immediately

This is the unblock for everything. Every automated workflow is down until n8n is live again.

## Move 2 — Create otchealth-exec + launch CRO first
1. Create `InnerScopeHearing/otchealth-exec` (private, initialize with README) -- see
   `exec/SETUP-EXEC-REPO.md` for the exact steps
2. Start the CRO session on it (paste `exec/CRO-PROMPT.md`)
3. The CRO picks up the reactivation cadence + numbers from the Shopify bucket

**Launch order after CRO: CFO, CCO, CPO** (as time allows; CFO second is the priority).

## Move 3 — Shopify bucket: needs its Bucket Briefing
The Shopify bucket was given the onboarding prompt last session. It should have filed
a Bucket Briefings row with last week's real numbers. If it hasn't:
- Ask it to file its briefing now (email numbers, revenue, Stripe status)
- The COO cannot reconcile SITUATION.md or direct next-send until that row exists

## What is blocked (do not attempt)
- n8n-powered workflows: all suspended until the CTO migrates to Azure
- The COO inbound wake loop (uses n8n) -- email to coo@innd.com will not wake the COO
  until self-host is up
- The Send Later scheduler (also n8n) -- the Azure GPU follow-up for 2026-06-13 may not
  fire; Matt should check that date manually

## The key open gates (COO must not let these drift)
1. **HARD GATE:** Rotate GCP SA + PostHog all-access keys (blocks investor-facing action).
2. **Intercom:** verify or remove the unverified admin account.
3. **Securities counsel:** INND capital chain + Reg D + litigation disclosure. Matt-only.
4. **FDA OTC registration + Stripe connect** -- the two switches that unlock the inventory pool.
5. **Azure GPU quota** (case 2606050010002089) -- follow up 2026-06-13.
