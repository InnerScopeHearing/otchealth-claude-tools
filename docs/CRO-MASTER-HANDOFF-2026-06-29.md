# CRO MASTER HANDOFF (Hyperagent to Claude) - 2026-06-29

Mid-session transfer of the CRO seat from the Hyperagent engine to the Claude engine. Same brain, two
engines. Read this top to bottom, then the From the Chair book-folder README, then your memory pack.
No confidential or INND/securities figures live in this doc (those stay in the private cro ledger lane).

## NORTH STAR
One number: cash in the bank this week. Pick the highest-velocity revenue lever (time-to-cash x probability
x size), stage it through the compliance gate, dispatch the owner, clear the blocker, report dollars not
activity. You draft, stage, and dispatch; the human approves spend, sends, pricing, and anything to strangers
or regulators.

## REVENUE SCOREBOARD (resume point)
- The live scoreboard was NOT refreshed in this session (the session focus was building the From the Chair
  product). Run it at sunrise: Stripe + Shopify + PostHog, read-only.
- Last known shared-brain state: cash realized to date is effectively $0; no revenue channel has produced a
  proven customer purchase yet.
- The CHECKOUT-PROOF guard is in force: the Stripe account has processed roughly one real charge ever. A one
  dollar owner test is NOT proof. Verify a real customer checkout completes before any mass send or ad spend.

## RESUME POINT PER CHANNEL
### 1) From the Chair / Gumroad (the active build this session)
- FINAL + compliance-passed + committed under CRO-HyperAgent/gumroad/: shared-core manuscript (18 chapters),
  Edition A "The Closer" + Edition B "The Professional" (full manuscript + workbook each), the fillable
  workbook (18 modules + front/back), and the 5-piece extras toolkit (scripts library, quick-ref cards,
  training kit, audio companion script, implementation tracker + master index). Compliance pass record is in
  extras/COMPLIANCE-PASS-PHASE5.md.
- The book-folder README (CRO-HyperAgent/gumroad/README.md) indexes every artifact with FINAL/DRAFT/PENDING
  status. Read it first.
- Design: Folio Round 1 delivered (brand frame, covers v1/v2, diagrams, full interior layout system). The
  CRO critical review chose the DARK cinematic cover direction and the v3 three-patients diagram. Round 2
  prompts are staged at design/FOLIO-PROMPTS-ROUND2.md (dark covers with fixed lockup + credibility line,
  fixed diagrams, 3D mockups, Gumroad listing graphics, LinkedIn launch kit, three-generations heritage
  piece, back covers).
- The 3 real Moore heritage photos are in design/photos/ (Marvin Posey 1950s, Mark testing his mother 1980s,
  family 1989). All repo art is base64 text inside the file; decode with base64 -d before use.
- LEFT before launch: run Folio Round 2; add Matt present-day photo (design/photos/moore-family-present.png);
  write the Gumroad listing copy (3 SKUs); set final pricing (Matt-gated); assemble fillable PDFs (decode the
  base64 art, embed Fraunces + Inter, overlay interactive form fields per design/interior/LAYOUT-SPEC.md);
  verify a real Gumroad checkout completes; launch to the ~20,000 LinkedIn industry connections.

### 2) Medvi mirror (the growth machine)
- PLAN.md is the canonical playbook. Do not rebuild it. Wedge = iHEAR TReO (PSAP, sellable today). Magnet =
  the free iHEARtest screening. Loop = advertorial, then 2-minute quiz, then offer reveal, then checkout,
  then lifecycle.

### 3) Lifecycle / Customer.io reactivation
- The ~66,224 valid/mailable HearingAssist contacts and the draft-141 TReO reactivation email are staged to
  fire the instant checkout is proven. SENDING is gated to Matt (TCPA/CAN-SPAM/DNC) AND gated on proven
  checkout.

### 4) Shopify TReO, Amazon, paid social
- Shopify TReO STORE: 99 single / 149 pair, PAIR99 pair promo live (pricing changes Matt-gated).
- Amazon TReO listing: shovel-ready, funded after first dollars.
- Paid social: only after the warm-list cash proves the funnel. Brand-health trap: fix the CS + refund path
  (with the COO) before pouring paid traffic into a support hole.

## SYSTEMS TO USE / DO NOT REBUILD
- cash.manifest (the revenue scoreboard source of truth).
- Medvi PLAN.md (the growth-machine playbook).
- The CRO-HyperAgent/gumroad/ folder (the entire From the Chair product).
- The claims-compliance gate (every claim, owned AND affiliate, passes it before shipping).
- Folio (the design agent; prompts live in design/FOLIO-PROMPTS.md and FOLIO-PROMPTS-ROUND2.md).
- kb-memory (the cro ledger), company-brain (brain.mjs ask), and the gateway read tools for Shopify,
  Customer.io, and PostHog.

## CONVENTIONS (non-negotiable)
- No em dashes or en dashes in any customer-facing copy. Use commas, periods, parentheses, or hyphens.
- Every claim, owned AND affiliate, passes the claims gate (FTC holds the brand liable for affiliate claims).
- TReO is a PSAP. Benefits-led copy only. No medical, hearing-loss, treat/restore/cure, or device language.
- The book is a memoir/method about traditional hearing aids; Mark & Kim are Licensed Hearing Aid Dispensers,
  never "audiologist"; keep it cleanly separate from the iHEAR TReO PSAP.
- Publish, pricing, mass sends, and ad spend are Matt-gated. INND/securities/IR is a firewall: prepare and
  flag, never make the call. Confidential figures go to the private cro ledger lane only.

## WHO YOU ARE
See dream-team/agents/cro.md (CRO is now a first-class roster member, PR #241).

## CLAUDE CRO - START HERE
1. Sync the toolkit to main; echo cro > ~/.claude/.kb-agent.
2. mem.mjs whoami --agent cro (must PASS, service-account present; if missing, stop and tell Matt).
3. protocol.mjs sunrise --agent cro.
4. Read this doc, then CRO-HyperAgent/gumroad/README.md, then mem.mjs pack --agent cro.
5. Run the revenue scoreboard (Stripe/Shopify/PostHog read-only) to get the live one number.
6. Greet exactly: "I am fully updated and ready to go, Sir." then list the last 3 and ask which to work on.
