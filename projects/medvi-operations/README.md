# Project: Medvi Operations for OTCHealth (COO-owned)

**Owner:** COO (The Quarterback). **Sponsor:** Matt. **Built by:** CTO (packaged 2026-06-28).
**Lane for memory:** `coo` (write-through every decision: `mem.mjs decision "..." --agent coo --share --tags medvi-ops`).

## Mission
Stand up a **Medvi-style operations engine** for OTCHealth: a marketing + distribution layer on outsourced
infra that turns the existing assets into **cash in the bank**, on a structurally safer product (PSAP) than
Medvi's GLP-1, with **compliance enforced in code** as the moat. Copy what made Medvi explode; avoid what
blew it up.

## Your job in this project (the deliverable)
Review everything in this folder + the linked sources, then produce a **Medvi Operations Plan**:
1. A **Medvi-parallel map** — each Medvi growth mechanic -> our equivalent -> current status (built / draft / gated) -> the gap to close.
2. A **prioritized deploy sequence** by speed-to-cash, mapped to the cash levers, with an owner (which fleet agent) per lever.
3. The **first 1-3 moves** for Matt (WHAT, not how), sized to his real calendar.
4. The **org + cadence** to run it (who does what daily/weekly; the SOPs that make it run without Matt).
5. **Open questions / decisions** Matt or counsel must make.
Log the plan to the `coo` ledger and write it back here as `PLAN.md`. Then you and Matt take it from there.

## How to use this folder
- `MEDVI-MIRROR-PLAYBOOK.md` — the full consolidated strategy, forensics, tactics, product ladder, the 9-stage revenue loop, the SOP library, the build sequence, voice economics, and the cost ledger. **Start here.**
- `SOURCES.md` — pointers to every live artifact (the canonical living doc, the CTO repo docs, the cro/coo ledgers, the claims gate, the funnel artifacts, the revenue tracker, the focus-group loop) so you can go deeper or verify against live state.
- Then write `PLAN.md` (your deliverable) in this folder.

## The non-negotiables (read before planning)
- **Cash first, LEGAL ALWAYS.** Compliance is the moat, not a step. Every claim — OWNED and AFFILIATE — passes the `claims_check` gate before it ships (FTC holds the brand liable for affiliate claims). Ads + advertorials get screened hardest (Medvi's exact failure point).
- **Market only what ships today:** iHEAR TReO (PSAP) now; iHEARtest (free screening) ~next week. Keep CareNow/SaveRx internal until launch.
- **TReO is a PSAP, NOT a hearing aid.** Zero hearing-aid / medical / FDA / "hearing loss" / treat-restore-correct language. Lead with situational benefits (conversations, the TV, the grandkids). Don't even use "PSAP/sound amplifier" in headlines.
- **Checkout is the gate.** Stripe is the only OTCHealthMart rail. A $1 owner test is NOT proof; verify a real TReO checkout completes before any send. A correct link into a broken checkout still produces $0.
- **Brand-health first.** The #1 complaint (BBB/Trustpilot) is unreachable CS + unprocessed refunds. Fix support + refunds before scaling paid traffic.
- **Hard gates (prepare + flag only):** real paid ad spend; mass email/SMS sends (TCPA/CAN-SPAM/DNC); final pricing; anything investor / IR / INND / securities (Matt + counsel); any device/treatment claim; new financial commitments. Cost-neutral until Matt approves spend.
- **Cost-neutral build:** everything runs on existing grants/credits (Azure $25K, GitHub $10K, PostHog $50K, ElevenLabs char grant). Net new cash cost = $0 until Matt approves paid spend.
