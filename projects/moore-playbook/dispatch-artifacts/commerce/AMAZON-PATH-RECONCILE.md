# Amazon TReO Path — Reconciled to One Recommendation and One Owner

**Owner of this decision artifact:** Commerce / Liquidator lead · **Sponsor:** Matt
**Lane:** non-PHI. Marketplace channel for TReO and the legacy pool (MOORE-PLAYBOOK Phase 2 Week 11; open decision 6).
**Status:** reconciled to a single named recommendation with a single owner and a clear sequence. Funded after first dollars.

> Grounded in: MOORE-PLAYBOOK Week 11 and open decision 6 (Apply-to-Sell vs iHEAR trademark filing, who and when, fund from first dollars), the EXECUTION-PROGRAM ownership lines (commerce/digital-products owns the Amazon TReO path, post first cash), and the live SP-API connection facts in `skills/amazon-sp-api/CRO-HANDOFF.md`.
>
> TReO is a Personal Sound Amplifier (PSAP). All listing copy must carry zero hearing-aid, hearing-loss, treats/restores/cures, FDA, or medical-device language and route through the compliance lane before any publish. Non-PHI ring. Dash-clean published copy.

---

## 1. What is already true (do not relearn)

- The OTCHealth Inc. Amazon Seller account is connected via SP-API and verified. Read ops (orders, inventory, catalog search, competitive pricing) are live and autonomous. Write ops (create or update a listing, set price, set inventory) are technically enabled (Seller ID stored) but gated on compliance sign-off of copy.
- TReO ALREADY has a live ASIN on Amazon, listed by third party sellers who previously liquidated this inventory. We can add our own offer to that existing ASIN.
- The existing detail-page copy on that ASIN was written by those third party sellers and we do not control it. It may contain non-compliant claims (hearing-aid or medical language) that we cannot edit without brand control of the listing.
- We do not currently own an accepted Amazon Brand Registry entry for an iHEAR or TReO trademark.

So there are two real routes, and they are not equal in speed, cost, or control.

---

## 2. The two routes, reconciled

### Route A — Apply-to-Sell on the existing ASIN (the fast path)

Attach OTCHealth's offer to the existing TReO ASIN and compete for the Buy Box on price and fulfillment. Personal sound amplifiers and consumer audio can sit behind an Amazon Apply-to-Sell or category-approval gate that asks for documentation.

- **What it needs:** the Apply-to-Sell documentation package, typically up to 3 supporting PDFs (for example a supplier or purchase invoice showing we legitimately hold the inventory, product images, and any required product documentation) plus a commercial invoice. These are documents Matt can assemble from our purchase and inventory records.
- **Cost:** effectively zero out of pocket beyond our time.
- **Speed:** fastest. Days to a couple of weeks once the documents are submitted and approved.
- **Owner:** **Matt** assembles and submits the 3 PDFs plus the commercial invoice (these come from our own purchase and inventory records, which only Matt can pull and attest to). Commerce operates the listing and pricing once approved.
- **The catch:** we are selling under copy we do not control. The existing detail page may carry non-compliant hearing-aid or medical claims. We can sell against it on price, but we cannot fix the page, and the brand exposure of that uncontrolled copy is real.

### Route B — iHEAR Brand Registry via a fresh trademark filing (the control path)

File a fresh trademark for the iHEAR (or TReO) brand, enroll in Amazon Brand Registry once accepted, and take control of the listing content, A+ content, and brand storefront.

- **What it needs:** a fresh trademark filing. Brand Registry generally requires an accepted (in many cases registered, with some pending-program options) mark. Filing is paperwork plus government and possibly counsel fees.
- **Cost:** roughly $300 to $2,000 depending on whether we file directly or through counsel and the class coverage. Funded from first dollars.
- **Speed:** slowest. Filing is quick but acceptance into Brand Registry depends on the mark progressing, which can take time. This is a multi-week to multi-month horizon, not a days horizon.
- **Owner:** **CLO** files the fresh trademark and drives the Brand Registry enrollment when accepted. Commerce takes over listing content once Brand Registry is live.
- **The payoff:** full control of the listing, compliant copy we author and gate, A+ content, and protection against third party sellers misrepresenting the product. This is the durable, brand-correct end state.

---

## 3. The recommendation (one named path, one sequence)

**Recommendation: run Route A first to open the channel and start cash, and start Route B in parallel as the durable end state. Do not wait for Route B to begin selling. Both are funded after first dollars.**

Reconciled into a single sequence:

1. **Now, gated on first dollars: Route A. Owner = Matt.** Matt assembles the Apply-to-Sell package (up to 3 supporting PDFs plus a commercial invoice from our own purchase and inventory records) and submits it. On approval, Commerce attaches our offer to the existing ASIN and competes for the Buy Box on price and fulfillment. Before our offer goes live, Commerce assesses the existing detail-page copy for non-compliant claims and flags the exposure to the compliance lane. If the existing copy is too non-compliant to sell behind, Commerce escalates and we hold Route A until Route B gives us control or we pursue a compliant variation.
2. **In parallel, gated on first dollars: Route B. Owner = CLO.** CLO files the fresh iHEAR (or TReO) trademark (roughly $300 to $2,000) and drives Brand Registry enrollment when the mark is accepted. This runs on its own slower clock and does not block Route A.
3. **End state: Route B controls the listing.** Once Brand Registry is live, Commerce migrates to a controlled, compliance-gated, dash-clean listing with our own copy and A+ content, and we no longer depend on third party copy we cannot edit.

**Why this and not one-or-the-other:** Route A alone leaves us permanently selling under copy we do not control, which is a standing compliance and brand risk. Route B alone leaves the channel closed for weeks to months while a fast, near-free path was available. Sequencing A-now and B-in-parallel captures Amazon cash quickly and buys the durable control without making cash wait on the trademark clock.

---

## 4. Ownership and gates (single accountable per route)

| Item | Owner (Accountable) | Gate |
|---|---|---|
| Route A: assemble 3 PDFs + commercial invoice, submit Apply-to-Sell | Matt | Physical gate: only Matt can pull and attest to our purchase and inventory records |
| Route A: attach offer, price, Buy Box ops | Commerce | After approval, and after compliance assessment of existing copy |
| Route A: flag non-compliant existing detail-page copy | Commerce, to compliance lane | Before our offer goes live |
| Route B: file fresh trademark + Brand Registry | CLO | Legal gate, counsel as needed; ~$300 to $2,000 funded from first dollars |
| Route B: migrate to controlled compliant listing | Commerce | After Brand Registry is accepted and live |
| Any TReO listing copy publish (PUT/PATCH) | Commerce drafts, compliance signs off | Hard compliance gate, no exceptions |
| Funding for both routes | Matt | Funded after first dollars (first proven TReO checkout revenue) |

---

## 5. Compliance firewall (carried forward, hard)

- TReO is a PSAP, not a hearing aid. Every title, bullet, A plus content block, and backend search term must carry zero hearing-aid, hearing-loss, treats, restores, cures, FDA, or medical-device language. Frame strictly as a personal sound amplifier.
- Route all listing copy through the compliance lane before any publish that creates or changes a live listing. Commerce drafts and operates. The claims posture is gated.
- The existing third party ASIN copy is a known exposure under Route A. Assess it and flag it before attaching our offer. Do not assume it is compliant.
- Non-PHI ring only. No PHI in listings, metadata, backend terms, or analytics.
- No em dashes or en dashes in any published listing copy.

---

## 6. First concrete moves once first dollars land

1. Commerce pulls the existing TReO ASIN(s) and current offers, Buy Box, and competitive pricing via SP-API and assesses the existing copy for compliance exposure.
2. Matt assembles and submits the Route A Apply-to-Sell package (3 PDFs plus commercial invoice).
3. CLO opens the Route B fresh trademark filing in parallel.
4. On Route A approval and a clean (or acceptable) compliance read, Commerce attaches our offer at a Buy-Box-competitive price with a chosen fulfillment model (FBA versus FBM decided on the unit-econ model and the refurb/3PL fulfillment plan).
5. On Route B Brand Registry acceptance, Commerce migrates to our own controlled, gated, dash-clean listing.
