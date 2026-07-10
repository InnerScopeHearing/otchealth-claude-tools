# DRAFT-141-CLEARANCE-MEMO
## CCO written conditional-clearance memo for the reignition send (template)

**From:** CCO · **To:** Matt (send-go authority), COO, CRO/Lifecycle · **Lane:** `cco`
**Asset:** draft-141, the reignition email to the warm HearingAssist list (mailable count LOCKED at 66,224) routing to the TReO advertorial + 5-question quiz funnel.
**Source of authority:** EXECUTION-PROGRAM Dimension 2 (Compliance / CCO) actions #2/#3/#4/#8, Master Critical Path Phase 2/3, PLAN open-decisions #1/#2/#5, CCO ledger 2026-06-23.
**Ring:** non-PHI. **Channel:** EMAIL ONLY. SMS is a TCPA hard BLOCK. **Product rule:** TReO is a PSAP, never a hearing-aid/medical/FDA/hearing-loss claim.

> **What this memo is.** The written record by which the CCO conditionally clears draft-141 to send. It is **CONDITIONAL-CLEAR**: the copy and mechanics are cleared, but the SEND remains gated on a small set of operational preconditions and on Matt's send-go. The CCO does not authorize the send; the CCO certifies that, once the preconditions are GREEN, there is no compliance bar to Matt giving the send-go. **No send fires until every box below is checked.**

---

## 1. Verdict line (fill at issuance)

```
DRAFT-141 STATUS: [ ] CONDITIONAL-CLEAR   [ ] HOLD (reason: __________)
Issued (UTC): ____________   CCO: ____________
One-liner to Matt: "draft-141 is compliance-cleared. Send-go is yours once the three preconditions below are GREEN."
```

---

## 2. claims_check PASS on the live gate (prerequisite, do this first)

The exact draft-141 subject line + body + the funnel landing copy were run through the DEPLOYED, CCO-verified `claims_check` gate (channel=email), after the 12-string acceptance test was CLEARED (see CLAIMS-CHECK-ACCEPTANCE-TEST.md).

- [ ] 12-string acceptance test CLEARED (8/8 BLOCK + 4/4 PASS, 12/12 audit-log ids) — date: ______
- [ ] draft-141 subject line returns PASS — audit-log id: ______
- [ ] draft-141 body returns PASS — audit-log id: ______
- [ ] funnel landing copy returns PASS — audit-log id: ______

If any returns BLOCK, this memo is HOLD until the copy is fixed and re-passes.

---

## 3. The 4 CAN-SPAM elements to verify (in the rendered send)

Verified against the actual rendered email, not the draft source. Attach screenshots to this memo.

| # | CAN-SPAM element | Requirement | Verified | Evidence |
|---|---|---|---|---|
| 1 | **Physical postal address** | A valid physical postal address of the sender appears in the email (the Roseville address per CCO ledger 2026-06-23). | [ ] | screenshot ref: ______ |
| 2 | **Working unsubscribe** | A clear, one-click unsubscribe mechanism that is actually WIRED to the suppression list (test-clicked and confirmed it suppresses), honored promptly. | [ ] | test unsubscribe ref + suppression confirmed: ______ |
| 3 | **Honest, non-deceptive From / subject** | The From name/address identifies the real sender and the subject line is not misleading about the content or origin. | [ ] | screenshot ref: ______ |
| 4 | **Clear advertising identification** | The message is identifiable as an advertisement / commercial message. | [ ] | screenshot ref: ______ |

All four must be checked. (Mailable count is LOCKED at 66,224; the send is email-only, no SMS per the TCPA block.)

---

## 4. Comparative-price substantiation on file (prerequisite)

Every comparative price claim used in draft-141 and the funnel must have a dated source on file (`cco/substantiation/treo-price-comparison.md`) BEFORE the send. The PSAP category disclaimer must be clear-and-conspicuous adjacent to the benefit H1 and the offer (net-impression review on the rendered page, not the source).

- [ ] "$299/side at CVS" (or equivalent retail-price hook) — dated substantiation source on file: ______
- [ ] "$2,400 clinic markup" (or equivalent) — dated substantiation source on file: ______
- [ ] Any other comparative/superiority number in the asset — substantiation on file: ______
- [ ] PSAP disclaimer ("not a hearing aid, not intended to diagnose, treat, cure, or prevent") verified clear-and-conspicuous next to the H1 AND the offer block
- [ ] Funnel re-run through claims_check after any CRO copy edit — audit-log id: ______

Any live comparative claim without on-file substantiation is pulled before the send.

---

## 5. Brand-health precondition (operationally-true guarantee + reachable CS)

draft-141 promises a 60-day money-back guarantee and that support is reachable. Under FTC Act §5, the Mail-or-Telephone Order Rule (16 CFR 435), and Magnuson-Moss, those claims must be operationally TRUE before they land in 66,224 inboxes. This is the #1 historical BBB/Trustpilot complaint and the live FTC exposure.

- [ ] Stripe `payouts_enabled = TRUE` (payout bank connected by Matt) so refunds can actually process
- [ ] Refund SOP published (named owner, stated turnaround SLA, the Stripe/Shopify refund path) — doc ref: ______
- [ ] CS reachability path published and manned (the 1-800-864-4337 line + an email SLA) — doc ref: ______
- [ ] One end-to-end test refund completed successfully — ref: ______
- [ ] Timed test CS contact on phone AND email answered within the published SLA — refs: ______
- [ ] CCO logged **BRAND-HEALTH = READY**

If BRAND-HEALTH is not READY, guarantee/CS claims are struck from the copy or the send is HOLD.

---

## 6. Channel + hard-block confirmations

- [ ] **EMAIL ONLY.** Customer.io SMS channel is disabled at the platform level (not merely unused). TCPA hard block confirmed. — ref: ______
- [ ] **Securities firewall.** draft-141 and the funnel contain zero INND / ticker / share-price / "undervalued" / "invest" / public-company language; the gate BLOCKs an INND/share-price test string on the email channel. — audit-log id: ______
- [ ] **CareNow / 17(b).** No CareNow share-bundle or any compensated-promotion-plus-securities element is present (Securities Act 17(b) hard block). — confirmed

---

## 7. Pre-send go/no-go (every line GREEN before the send-go)

| Line | Precondition | GREEN |
|---|---|---|
| 1 | claims_check gate merged + deployed + 12-string acceptance test CLEARED with audit-log ids | [ ] |
| 2 | draft-141 subject + body + funnel copy returned PASS on the live gate (audit-log ids on file) | [ ] |
| 3 | 4 CAN-SPAM elements verified in the rendered send | [ ] |
| 4 | Comparative-price substantiation on file; PSAP disclaimer clear-and-conspicuous (net impression) | [ ] |
| 5 | BRAND-HEALTH = READY (Stripe payouts_enabled=TRUE, refund SOP, manned CS, test refund + timed CS contact) | [ ] |
| 6 | EMAIL ONLY confirmed (SMS disabled / TCPA), securities firewall fires, CareNow 17(b) blocked | [ ] |
| 7 | CHECKOUT-PROOF = PASS (one real full-price, unrefunded, settling PAIR99 order verified) | [ ] |

**CHECKOUT-PROOF** is recorded by the CTO/COO, not the CCO, but it is a precondition this memo references because a deceptive guarantee on an unproven checkout is itself an exposure.

---

## 8. CCO certification and hand-off

When lines 1, 2, 3, 4, 6 are GREEN, the CCO issues this memo as **CONDITIONAL-CLEAR**:

> "draft-141 is compliance-cleared to send PENDING checkout-proof (line 7) and BRAND-HEALTH = READY (line 5). Email only. The send-go is Matt's. The CCO withholds nothing further once those two operational lines are GREEN."

When all seven lines are GREEN, the CCO hands Matt the single one-liner: **"Compliance-cleared. Send-go is yours."** The send itself is Matt's decision and his alone; the CCO certifies only that there is no compliance bar.

```
CCO certification (UTC): ____________   Signature: ____________
Audit-log ids attached: subject=____ body=____ funnel=____ INND-block=____
Result posted to cco ledger: [ ]
```

---

*This memo is the durable compliance record for the reignition send. A copy, with its audit-log ids and evidence screenshots, is retained for the FTC look-back window. No send fires without a completed, all-GREEN copy of this memo on file.*
