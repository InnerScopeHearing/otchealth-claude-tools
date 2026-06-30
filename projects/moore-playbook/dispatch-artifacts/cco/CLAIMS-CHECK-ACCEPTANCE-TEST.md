# CLAIMS-CHECK-ACCEPTANCE-TEST
## The 12-string acceptance test that must PASS before any copy ships

**Owner:** CCO · **Depends on:** CTO merging + deploying `otchealth-mcp-server` PR #24 (claims_check) to protected `main`, gateway Container App `otchealth-mcp-gateway` (eastus2) redeployed so the deployed image == main.
**Source of authority:** EXECUTION-PROGRAM Dimension 2 (Compliance / CCO) action #1, Master Critical Path Phase 2, Top-10 action #3.
**Ring:** non-PHI. **Rule under test:** PSAP-only marketing (amplification/wellness, never treat/diagnose/cure/hearing-aid/FDA), the securities firewall (no INND/share-price), and no fake testimonials.

> **What this is.** A fixed, repeatable acceptance test for the in-code compliance gate. The whole Moore/Medvi-mirror moat is "every claim, owned AND affiliate, passes claims_check before it ships." That moat does not exist until this test passes. **Until 8/8 bad strings are BLOCKED and 4/4 good strings PASS, each with a persisted audit-log id, NOTHING sends.** The CCO runs this after every gate deploy and after any redeploy from main (a redeploy that silently drops the gate is the documented failure mode).

---

## 1. How to run

1. Confirm the deployed gateway image == merged `main` (CTO confirms; tool count before == after).
2. For each of the 12 strings below, call the gateway `claims_check` tool with the string and the stated `channel`.
3. Record the returned `verdict`, the returned `reason`, and the `audit_log_id` for every call.
4. Compare each result to the **Expected verdict** column. The run PASSES only if all 12 match AND every call produced a persisted, queryable audit-log id.
5. Then query the audit log for the 12 ids and confirm each entry stored: timestamp, channel, the submitted text (or a hash), verdict, and reason. This proves the trail is real, not just a runtime response.
6. Post the full result table (string, channel, expected, actual, audit-log id) to the `cco` ledger. A single mismatch or any missing audit-log id = the run FAILS and the gate is not cleared; nothing sends.

**Pass bar:** 8/8 BLOCK + 4/4 PASS, 12/12 audit-log ids persisted and queryable.

---

## 2. The 8 strings that MUST be BLOCKED

| # | Channel | Test string | Expected verdict | Expected reason (category) | Audit-log expectation |
|---|---|---|---|---|---|
| B1 | email | "TReO is a hearing aid that will treat your hearing loss and restore what you've been missing." | **BLOCK** | hearing-aid claim + treat/restore medical claim on a PSAP | One log entry: channel=email, verdict=BLOCK, reason names the hearing-aid + treat/restore violation; queryable by id |
| B2 | funnel | "Clinically proven to cure tinnitus and reverse hearing damage." | **BLOCK** | treat/diagnose/cure claim (cure tinnitus, reverse damage) | Log entry persisted; reason cites cure/medical-condition claim |
| B3 | ad | "FDA-approved medical device, doctor-recommended for the hearing impaired." | **BLOCK** | FDA/clearance claim + medical-device + medical-condition targeting | Log entry persisted; reason cites FDA + medical-device + condition targeting |
| B4 | affiliate | "Honestly the same as a $2,000 hearing aid, my audiologist says it's just as good." | **BLOCK** | unsubstantiated comparative/superiority + hearing-aid equivalence + unverified clinician endorsement | Log entry persisted; reason cites unsubstantiated comparative + hearing-aid equivalence |
| B5 | email | "Buy INND stock now, the share price is undervalued and about to pop." | **BLOCK** | securities firewall: INND ticker + share-price + investment solicitation | Log entry persisted; reason cites INND/securities firewall (Reg FD / 17(b)) |
| B6 | affiliate | "As a real customer my hearing came back to 100% in three days, this is a miracle device." (submitted as a scripted/fabricated testimonial) | **BLOCK** | fake/unsubstantiated testimonial + restore/cure claim | Log entry persisted; reason cites fabricated-testimonial + medical claim |
| B7 | sms | "Reply YES to start your hearing-recovery program by text." | **BLOCK** | TCPA hard block (SMS channel) + hearing-recovery medical claim | Log entry persisted; reason cites TCPA SMS block (and the medical claim) |
| B8 | email | "Bundle CareNow membership and get InnerScope shares with your purchase." | **BLOCK** | Securities Act 17(b): share-bundle promotion + INND/securities | Log entry persisted; reason cites 17(b)/securities firewall |

---

## 3. The 4 strings that MUST PASS (benefit-led PSAP copy)

| # | Channel | Test string | Expected verdict | Why it passes | Audit-log expectation |
|---|---|---|---|---|---|
| G1 | email | "TReO is a personal sound amplifier that makes everyday conversations louder and clearer. Not a hearing aid, and not intended to diagnose, treat, cure, or prevent any condition." | **PASS** | Amplification/wellness benefit with the clear-and-conspicuous PSAP disclaimer; no medical claim | One log entry: channel=email, verdict=PASS; queryable by id |
| G2 | funnel | "Hear your grandkids at dinner again. TReO turns up the sounds you've been missing, all day comfort, rechargeable, complete pair." | **PASS** | Lifestyle/situational benefit, no treat/diagnose/cure, no hearing-aid framing | Log entry persisted, verdict=PASS |
| G3 | ad | "A fraction of what I expected to pay for a personal sound amplifier. Free shipping and a 60-day money-back guarantee." | **PASS** | Honest price-value + true product facts (guarantee only while operationally true); no medical or unsubstantiated-comparative claim | Log entry persisted, verdict=PASS |
| G4 | email | "Everyday sounds, turned back up. TReO is a wearable personal sound amplifier for general listening. Personal sound amplifier, not a hearing aid." | **PASS** | Pure amplification/general-wellness framing with category line; net impression is not a hearing-aid/treatment claim | Log entry persisted, verdict=PASS |

---

## 4. Audit-log verification (the trail must be real)

After the 12 calls, export the last 12+ `claims_check` log entries and confirm:
- Each of the 12 ids from §2/§3 is present and queryable.
- Each entry stores: timestamp (UTC), channel, submitted text or its hash, verdict, reason.
- The 8 BLOCK entries carry a non-empty machine-readable reason category; the 4 PASS entries carry verdict=PASS.
- The export is retained for the FTC look-back window.

If any of the 12 ids is missing or the log is not queryable, the gate is NOT cleared regardless of the runtime verdicts, because an unlogged gate cannot prove compliance after the fact.

---

## 5. Result record (fill on each run, post to the cco ledger)

```
RUN DATE (UTC): ____________________
GATEWAY IMAGE == MAIN (CTO confirmed): [ ] yes

BLOCK results:  B1 [ ]  B2 [ ]  B3 [ ]  B4 [ ]  B5 [ ]  B6 [ ]  B7 [ ]  B8 [ ]   (8/8 required)
PASS results:   G1 [ ]  G2 [ ]  G3 [ ]  G4 [ ]                                   (4/4 required)
Audit-log ids persisted + queryable (12/12): [ ]

VERDICT: [ ] CLEARED (8/8 + 4/4 + 12/12 logged)   [ ] FAILED (any mismatch -> nothing sends)
Audit-log ids: B1=____ B2=____ B3=____ B4=____ B5=____ B6=____ B7=____ B8=____ G1=____ G2=____ G3=____ G4=____
CCO sign-off: ____________________
```

**Re-run policy:** run this test after the initial gate deploy AND after any gateway redeploy from main, since a routine redeploy is the exact way the moat can silently drop. A CLEARED result is a precondition (PRE-SEND-CHECKLIST line 1) for the draft-141 clearance memo and therefore for Matt's send-go.
