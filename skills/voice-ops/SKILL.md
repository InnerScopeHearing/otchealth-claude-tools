---
name: voice-ops
description: Builds and operates the AI voice agent fleet (Sarah intake, Helen sales, Roger IR, Fin) on Twilio + ElevenLabs + n8n + Intercom + Customer.io, agent scripts/KB, inbound intake, and TCPA-gated outbound campaigns. Helen already closes Shopify orders by phone; this skill scales that safely. Wielded by the Switchboard agent. Heavily compliance-gated.
---

# voice-ops — the AI voice fleet, scaled safely

A real asset already in production: Sarah (intake, 800-864-4337), Helen (iHEAR
sales, takes live Shopify orders, 800-640-9731), Roger (INND IR, 833-788-0506),
Fin (main line). All inbound today. This skill maintains them and designs outbound,
which is a different, higher-risk regime.

## When to invoke
Updating an agent's script/KB, adding a tool, standing up a new line, or designing
an outbound campaign to the database.

## What it does
- **Agent design:** scripts, knowledge base, server tools (Customer.io lookup/log,
  Shopify draft orders), post-call pipeline via the shared n8n flow.
- **Inbound intake:** capture, route, tag (intent, resolution), Customer.io
  enrichment, escalate per the Fin procedure tiers.
- **Outbound (gated):** reactivation/sales calls to consented numbers, in a chosen
  voice, with the offer, only after the consent + DNC checks below.

## Hard guardrails (non-negotiable)
- **TCPA:** outbound voice/SMS only to numbers with prior express consent; recording
  disclosure on every call; legacy-list consent provenance is unverified, so an
  outbound campaign is BLOCKED until a consent + **DNC scrub** is done.
- **Adverse events:** any AE keyword triggers Procedure 00 (Tier-4 hard escalate,
  30-day MDR clock, WF02, email Matt). This path stays live and unbypassed.
- **No medical advice / no diagnosis / no model recommendation / no audiogram
  interpretation;** redirect to telehealth.
- **No PHI capture;** do not repeat back or log volunteered medical history.
- **No bot commitments** on price, refund, or warranty, confirm by email.
- **Roger / IR = Reg FD + attorney-gated;** IR is the securities lane, never quotes
  financials, draft-only, counsel-approved.
- No em or en dashes in published scripts.

## Output
Maintained/extended voice agents; any outbound campaign ships only with the
consent + DNC gate cleared and Compliance sign-off.
