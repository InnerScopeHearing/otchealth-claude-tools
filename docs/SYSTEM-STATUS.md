# System status — the single source of truth (so nothing is "secretly missing")

Updated 2026-06-09. Four buckets: what's **built + live**, what Claude **can still
build** (on request), what **needs you** (Claude can't do it), and what is **execution**
(real money, the separate chat). When in doubt, this doc is the answer.

## GREEN — built and live (in `main`, installs into every session)
- **23 skills** (product SDLC, designer, the full growth/revenue stack, capital
  raise-ops, grant-tracker, daily-briefing) + the **diagrammer**.
- **18 agents:** product Dream Team (9) + Cash Driver division (9).
- **Scoreboards:** `app.manifest` + `cash.manifest` schemas (+ examples).
- **Platform wiring:** 40 secrets in GCP Secret Manager hydrating every session via
  `session-start.sh`; `get-secret.mjs` for PEM/binary; the securities firewall; the
  PHI-ring rules; `CLAUDE.md` standing context.
- **Portability:** the `OTCHEALTH-OS` bundle + `INSTALL-EVERYWHERE` (Claude Code,
  Claude chat/cowork, other AIs).
- **Lifecycle + reliability:** the App-Kit, the avatar pipeline, the key-recovery runbook.

This layer is DONE. It is live in every Claude Code session now.

## YELLOW — Claude can build it, just hasn't yet (say the word)
1. **Deeper coded automations inside the skills.** Today the skills are instruction
   packs + templates (which is how Claude-Code skills work, Claude reads them and
   acts). Turnkey API scripts (a Customer.io campaign sender, a Shopify bulk-lister, an
   ElevenLabs/Twilio voice-agent builder, an investor CRM, ad-platform integrations) are
   buildable, but best built **during execution** against the live accounts so they can
   be tested with real data, not speculatively.
2. **Adopt the kit on the real apps** (iHEARtest, AWARE, Companion...): drop in
   `app.manifest.json` + devkit + tests. Needs those repos added to a session.
3. **Prove the relay end-to-end** on one real task (product or cash).
4. **Scheduled daily briefing** via n8n (emailed each morning) — buildable now via the
   n8n connection. Real proactivity.
5. **A test suite for this repo's scripts** (diagrammer/scaffolder/fetch/track).
6. **Write the Gumroad SOP product content** (digital-products) — Claude can draft the
   SOPs now; only the listing/selling step needs your Gumroad account.
7. Optional infra: a manifest MCP, a unified CLI.

## RED — needs YOU (Claude cannot do these; real-world switches)
- **FDA OTC Establishment Registration** (file + pay, ~$10k, <2wk) — gates all hearing-aid sales.
- **Connect Stripe** — gates collecting any store cash.
- **claude.ai Project + MCP connectors** (a UI action) — to give chat/cowork the context.
- **Attorney engagement + sign-off** for the raise and any IR/securities item.
- **TCPA consent + DNC decision** on the legacy list — gates outbound voice/SMS.
- **AWARE Android keystore upload** (binary) — to provision it.
- Pulling the actual cash levers: sending campaigns, taking orders, accepting investment.

## EXECUTION — the separate chat
The Rainmaker reads `cash.manifest` and runs the plays (Gumroad first for cash in days;
then the inventory clearance once FDA + Stripe are unlocked; the Reg D in parallel).
That is *operating the business*, not *building the tools*, and it lives in the
lever-pulling chat.

---
**Bottom line:** the operating system (tooling) is complete and running. What remains is
(YELLOW) deeper automations + per-app adoption Claude builds on request, and (RED) a
short list of real-world switches only you can flip. Nothing is hidden, this list is it.
