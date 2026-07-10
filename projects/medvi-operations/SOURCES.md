# Medvi Operations — Sources & Live Artifacts (verify against these)

Everything the CTO gathered, with how to reach each. Prefer LIVE state over this snapshot when they differ.

## Canonical living documents (Hyperagent — use the `documents` tool / ReadDocument)
- **OTCHealth Cash Playbook — The Medvi Mirror** — id `cmqumip7l06ci07adzkjlvv8r` (GLOBAL). The full living source; 9 sections (strategy, products+business design, Dream Plan v2, research findings + SOP library + execution log, tech-stack audit + Medvi forensics, the cash path, execution sequence, autonomous scope, cost ledger).
- **Agent Fleet — Rebuild Architecture (CTO -> COO for validation)** — id `cmqcuqrg40bni08adcy2tibkt`.
- **OTCHealth Portfolio — CTO Status Board** — id `cmqcrqilr0bap07adm5rt68yj`.
- **OTCHealth — Azure Tier-3 Credit-Funded Roadmap to a $1B Solo-Operator AI System** — id `cmqu6innl01yq06adoe01s463`.

## Repo docs (otchealth-cto)
- `docs/medvi/OTCHEALTH-CASH-PLAYBOOK.md` — the repo copy of the playbook.
- `docs/medvi/system-map.html` — the interconnected business / 9-stage loop / exec fleet visual.

## The fleet memory (kb-memory ledgers — run via the kb-memory wrapper)
- CRO lane (the live revenue operating truth): `node /tmp/octools/skills/kb-memory/mem.mjs pack --agent cro` (and `tail`, `recall "TReO reactivation"`, `recall "checkout"`, `recall "claims gate"`).
- COO lane: `... pack --agent coo` (SITUATION/PRIORITIES live in `coo/` files in otchealth-claude-tools).
- Shared exec feed: `... team`. Company brain: `node /tmp/octools/skills/company-brain/brain.mjs ask "<question>"`.
- Fleet bulletin: `FLEET-BULLETIN.md` in otchealth-claude-tools.

## Live systems (verify before planning)
- **Claims-compliance gate:** the `claims_check` tool on the MCP gateway (channel-aware; PSAP/FTC-FDA ruleset; screens ads/advertorials hardest). SOP-1 enforced in code.
- **Revenue tracker / $25K gate:** the Shopify Admin API revenue tracker (daily P&L heartbeat). Baseline: ~$227K all-time / 1,484 orders, store DORMANT (last 90 days $0) -> mission = REIGNITION.
- **Funnel artifact:** the iHEAR TReO advertorial + 5-question quiz + offer (focus-group-tuned to v4/v5; real product/pricing/images; live checkout to otchealthmart.com).
- **Focus-group loop:** `skills/focus-group-loop` (20 personas; scores creative/funnel before spend).
- **Store + rail:** hearingassist.myshopify.com / otchealthmart.com; Stripe acct (OTCHealth Inc.) — the ONLY rail; ~1 real charge ever (owner $1 test) -> CHECKOUT MUST BE PROVEN before any send.
- **Voice fleet:** Sarah (intake 800-864-4337), Helen (sales 800-640-9731), Roger (IR), Taylor, Claire, Fin — ElevenLabs+Twilio+n8n; ACS provisioned.
- **Data:** Customer.io workspace 193366 (~85K DB; ~66,224 valid mailable HearingAssist email contacts). PostHog (analytics). RevenueCat (subscriptions).

## Key numbers / facts to anchor on
- Mailable reactivation segment = **66,224** valid HearingAssist email contacts (NOT 400K lifetime, NOT 78K).
- Channel pricing: STORE $99 single / $149 pair + **PAIR99** ($99 pair). Final pricing = Matt-gated.
- The $25K gate funds the OTC line; read it as NEW reignition revenue from today.
- Brand-health trap: #1 complaint = unreachable CS + unprocessed refunds (fix before scaling paid).

## Gates (prepare + flag only)
Paid ad spend; mass email/SMS sends (TCPA/CAN-SPAM/DNC); final pricing; investor/IR/INND/securities (Matt + counsel); device/treatment claims; new financial commitments. Everything else is cost-neutral and buildable now.
