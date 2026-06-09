---
name: daily-briefing
description: Assembles the one report a solo operator reads each day, the cash number, the top cash levers and their blockers, the spin-off-trigger progress, and credit flags, from the cash.manifest + grant tracker. So you stay in control without opening a dozen dashboards. Wielded by the Rainmaker / finance-ops; part of the solo-operator layer.
---

# daily-briefing — one report, the whole picture

Replaces checking 12 tools with one glance. Dollars first, then the levers, then risks.

## When to invoke
Start of day, or whenever you want the current cash + lever state.

## Use it
```bash
node scripts/brief.mjs [path/to/cash.manifest.json]
```
Defaults to the example cash.manifest until a live one exists. Prints: north star,
scoreboard (cash/revenue/burn/runway + the $100K/mo trigger), the top 5 levers by
time-to-cash with owner/pipeline/blocker/compliance, and the grant-expiry flags.

## How to make it proactive
Schedule it: an n8n cron (or `/loop`) runs the briefing and posts it to email/Notion
each morning, so the report comes to you. Keep the live cash.manifest current (that is
the finance-ops job) so the number is real, not seeded.

## Guardrails
Numbers come from the cash.manifest (sourced, not estimated). No PHI, no secrets in the
briefing. Securities/financial figures that go to anyone external route through the
capital agent + counsel.
