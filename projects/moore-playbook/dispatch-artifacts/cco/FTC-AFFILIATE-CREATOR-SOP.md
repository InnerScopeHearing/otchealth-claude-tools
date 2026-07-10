# FTC-AFFILIATE-CREATOR-SOP
## The standing operating procedure that MUST exist before any creator or affiliate is onboarded

**Owner:** CCO (Chief Compliance Officer) · **Co-owners:** CRO (program), CLO (agreement rider + indemnity)
**Lane:** `cco` · **Status:** v1, commit-ready · **Source of authority:** MOORE-PLAYBOOK §9, MEDVI-MIRROR SOP-1/SOP-8, EXECUTION-PROGRAM Dimension 2 (Compliance / CCO) action #5, PLAN open-decision #8
**Ring:** non-PHI only. **Hard product rule:** TReO is a Personal Sound Amplifier (PSAP). It is NEVER a hearing aid, never a medical/FDA/hearing-loss/treat/diagnose/cure claim.

> **Why this document exists, in one sentence.** Medvi did not blow up on its own ads. It blew up on roughly a third of its ads run by AFFILIATES with fabricated AI "doctor" personas making unsubstantiated endorsement claims, and the FTC holds the BRAND liable for what its affiliates say (16 CFR Part 255). This SOP is the written, enforced control that keeps us from repeating that exact legal explosion. **No creator or affiliate is onboarded, paid, or published until every gate below is GREEN for that creator.**

---

## 0. Scope and the non-negotiable sequencing rule

This SOP governs every person or entity outside the company who is given anything of value (flat fee, free product, affiliate commission, discount code, gift) in exchange for promoting an OTCHealth product. That includes paid creators, micro-influencers, affiliate-link partners, review-site placements, and any UGC-style ad we commission.

**SEQUENCING (hard).** The Phase-2 creator/affiliate program (EXECUTION-PROGRAM, Top-10 and Phase-2 Wk12) is BLOCKED from onboarding a single creator until BOTH of these are true:
1. The in-code `claims_check` gate is merged, deployed, and CCO-verified firing (see the companion artifact CLAIMS-CHECK-ACCEPTANCE-TEST.md, 8/8 bad BLOCKED + 4/4 good PASS with persisted audit-log ids).
2. This SOP is committed and the creator agreement rider is CLO-reviewed.

The CCO holds the go. The CLO gates the agreement rider. No exception, no "just one creator," no verbal clearance.

---

## 1. Creator identity and persona verification (no fabricated / AI personas)

The single control that would have stopped Medvi. Before ANY work or payment:

**1.1 Real-identity KYC.** Collect and retain, in the non-PHI creator file:
- Legal name and a government-issued photo ID (or, for an entity, the registered business name plus the responsible individual's ID).
- A reachable email and phone that match the identity.
- The exact handle(s) / channel URL(s) the creator will post from, and proof of control of each (a posted verification token or a DM from the verified account).
- W-9 / W-8BEN for payment, tying the payee to the verified identity.

**1.2 Persona-authenticity attestation.** The creator signs an attestation that:
- They are a real person posting as themselves, OR a real person disclosed as a paid spokesperson.
- They are NOT presenting as a doctor, audiologist, physician, nurse, pharmacist, or any licensed clinician unless they ARE one and provide a current, verifiable license number that the CCO independently confirms.
- No content will use an AI-generated or fictional "expert" persona, a deepfaked face/voice, or a synthetic testimonial.

**1.3 Credential verification (if any health/expertise claim of the creator is used).** If a creator's professional credential is to appear anywhere in the asset, the CCO verifies the license against the issuing board BEFORE the asset is approved, and the file records the verification date and source. An unverifiable credential = the credential line is struck; if it is load-bearing to the asset, the asset is rejected. (This mirrors the open iHEARtest "licensed audiologist" founder-video gate, EXECUTION-PROGRAM Dimension 2.)

**1.4 Outcome.** Each creator gets a status in the creator registry: `VERIFIED` (KYC complete, persona attestation signed, any credential confirmed) or `BLOCKED`. Only `VERIFIED` creators proceed.

---

## 2. The PSAP claims allow / deny list (what a creator may and may not say)

This is the substantive ruleset. It is enforced two ways: (a) automatically by the `claims_check` gate on every asset, and (b) by CCO human review of net impression on the rendered asset. A creator is given this list in plain language at onboarding and it is incorporated into the agreement rider.

### 2.1 DENY — these are BLOCKED, no exceptions (any one kills the asset)
- Any word or implication that TReO is a **hearing aid**, "like a hearing aid," "as good as a hearing aid," or a substitute for one.
- Any **treat / diagnose / cure / restore / correct / reverse / fix / prevent** claim about hearing, hearing loss, deafness, tinnitus, or any medical condition. ("restores your hearing," "corrects hearing loss," "cures ringing in the ears" are all BLOCKED.)
- Any **FDA** language: "FDA-approved," "FDA-cleared," "FDA-registered," "medical device," "clinically proven," "doctor-recommended" (unless a verified clinician is genuinely recommending it AND it is substantiated and disclosed).
- Any **medical-condition targeting**: "for hearing loss," "if you're going deaf," "hearing-impaired," "for your tinnitus."
- **Unsubstantiated comparative or superiority** claims: "the same as a $2,000 hearing aid," "better than [named brand]," "#1," "best," without a dated substantiation file on record (see §4).
- **Fake / incentivized-but-undisclosed testimonials**, invented results, fabricated before/after, or any review the creator did not actually experience.
- **Securities / INND** language of any kind: the ticker INND, share price, "undervalued," "invest," "public company," "stock," CareNow share-bundle promotion. (Securities firewall, MOORE-PLAYBOOK §3; INND is MNPI / framework-level only. Securities Act 17(b) blocks compensated promotion bundled with any IR/share element.)
- **SMS / text** call-to-action that would drive an un-consented text program (TCPA hard block; reignition and creator funnels are email-only).

### 2.2 ALLOW — benefit-led PSAP copy a creator MAY use (still gate-checked)
- Amplification and general-wellness framing: "makes everyday sounds louder and clearer," "hear conversations at dinner again," "turn up the world," "personal sound amplifier you can wear all day."
- Lifestyle / situational benefit: "I stopped asking people to repeat themselves at restaurants," "I can follow the TV without blasting it," "family game night sounds crisp again" — provided it is the creator's genuine experience.
- Honest, substantiated price-value framing that does NOT imply medical equivalence: "a fraction of what I expected to pay," or a specific comparison ONLY if backed by a dated substantiation file (§4) and stated as a price comparison, not a clinical-equivalence claim.
- Product facts that are true and on the spec sheet: rechargeable, two ear pieces ("complete pair"), 60-day money-back guarantee (only while that guarantee is operationally true, §5), free shipping, US support line.
- The mandatory category line where required: "TReO is a personal sound amplifier, not a hearing aid, and is not intended to diagnose, treat, cure, or prevent any condition."

### 2.3 The disclaimer / net-impression rule
Every creator asset that makes any benefit claim must carry the PSAP category disclaimer **clear and conspicuous**, in the same medium as the claim (spoken in a video, on-screen in a video, in the caption for a static post), not buried in a comment or a link. A literally-true sentence stack that leaves the overall impression of a hearing-aid/treatment product is BLOCKED on net impression even if no single line is in the DENY list. The CCO reviews the RENDERED asset, not the script.

---

## 3. Material-connection / #ad disclosure rules (16 CFR Part 255)

Every creator has a material connection to us (we pay them or give them product or commission). FTC requires that connection be disclosed clearly and conspicuously. Brand liability attaches if it is missing or buried.

**3.1 Mandatory disclosure.** Each asset must include a clear material-connection disclosure: `#ad`, `#sponsored`, or "Paid partnership with OTCHealth," plus, where the creator earns commission, "I earn a commission on purchases through my link."

**3.2 Placement rules (clear and conspicuous):**
- **Video:** disclosure both on-screen as text AND spoken near the start, not only in the description, and visible long enough to read. It must not require expanding "...more."
- **Static image / carousel:** disclosure in the visible caption ABOVE the "more" fold and, where the platform supports it, the platform's paid-partnership label toggled on.
- **Stories / short-form:** a persistent on-screen disclosure sticker for the full duration of any promotional frame.
- **Affiliate link / blog:** disclosure immediately adjacent to the link and near the top of the page, not solely in a footer.
- **Live / audio:** spoken disclosure at the start and repeated if the session is long.

**3.3 Language rules.** Plain English. "Thanks to OTCHealth" or "sp" or "collab" alone is NOT sufficient. No disclosure may be hidden behind hashtags-soup, a different color that blends in, or tiny text.

**3.4 Honesty rule.** A creator may only endorse a product they have actually used, and may only state opinions they genuinely hold (16 CFR 255.1). No scripting of an experience the creator did not have.

---

## 4. Pre-publish claims_check routing (every asset, before it ships)

No creator asset is published, boosted, or paid for until it has a logged PASS from the deployed `claims_check` gate. This is the same gate the owned channels use (SOP-1), extended to affiliates because the FTC holds the brand liable for affiliate claims.

**4.1 The routing path:**
1. Creator submits the FINAL rendered asset (video file / image + exact caption / blog HTML), the channel, and the disclosure as it will appear.
2. CCO (or the automated submission flow) runs the asset's text through the `claims_check` gate (channel = the creator's channel), capturing the verdict and the audit-log id.
3. CCO runs the human net-impression + disclosure-placement review on the rendered asset (§2.3, §3).
4. Both must pass. The asset's record stores: claims_check audit-log id, verdict, CCO reviewer, date, and a copy of the approved asset.

**4.2 Substantiation file.** Any claim that needs substantiation (comparative price like "$299/side at CVS," any superiority claim, the "60-day guarantee," any CS-SLA promise) must have a dated source on file (`cco/substantiation/...`) BEFORE the asset goes live. No on-file substantiation = the claim is pulled.

**4.3 No back-door publishing.** A creator may not publish a different cut than the one approved. Material edits require re-routing through the gate (a new audit-log id). The agreement rider makes deviation a breach.

---

## 5. Brand-health precondition (a guarantee/CS claim must be operationally true)

A creator may not promote the 60-day money-back guarantee or "reach our support team" until those are operationally true (FTC Act §5; Mail-or-Telephone Order Rule 16 CFR 435; Magnuson-Moss). This is the #1 historical BBB/Trustpilot complaint and an FTC exposure. Precondition for any creator asset touching guarantee/CS:
- Stripe `payouts_enabled = TRUE` so refunds can actually process.
- A published refund SOP (named owner, stated turnaround SLA).
- A manned CS path (the 1-800-864-4337 line + an email SLA), CCO-verified by a timed test contact and one end-to-end test refund.

Until BRAND-HEALTH = READY is logged by the CCO, guarantee/CS claims are struck from creator copy.

---

## 6. Monitoring, sampling, and the audit trail

**6.1 Ongoing sampling.** The CCO samples live creator assets on a rolling basis (target: every active creator's recent posts at least monthly, plus a random sample weekly). Each sampled asset is checked for: correct disclosure present and conspicuous, claims within the allow list, persona authenticity (still the real verified person, no new fabricated-expert framing), and substantiation still on file.

**6.2 KPIs (from EXECUTION-PROGRAM Dimension 2).**
- claims_check coverage of shipped creator copy: 100% carry a passing audit-log id; 0 un-gated sends.
- Disclosure + persona compliance on sampled audits: >= 95% correct, 0 fabricated/AI-persona endorsements.
- Substantiation-on-file rate for claims that need it: 100% before they go live.

**6.3 Audit trail.** Every claims_check decision (creator and owned) is written to a persistent, queryable audit log with timestamp, channel, verdict, and reason, retained for the FTC look-back window. The creator file additionally retains the KYC docs, signed attestation/agreement, approved asset, and sampling results.

---

## 7. Takedown and enforcement

**7.1 Triggers for immediate takedown / suspension:**
- Any fabricated, AI, or undisclosed-clinician persona discovered.
- A live asset with a DENY-list claim (hearing-aid/treat/restore/correct, FDA, medical-condition targeting, unsubstantiated comparative, fake testimonial, any INND/securities line, any SMS CTA).
- Missing or non-conspicuous material-connection disclosure.
- A claim live without on-file substantiation.
- A guarantee/CS claim while BRAND-HEALTH is not READY.

**7.2 The takedown procedure:**
1. CCO issues a written takedown notice to the creator (the agreement rider requires removal within 24 hours).
2. The creator's affiliate links and discount codes are disabled immediately.
3. The non-compliant asset is logged in the incident record with the reason and the audit evidence.
4. Commission/payment for the offending period is withheld pending cure (per the rider).
5. Repeat or willful violation, or any fake-persona finding, = termination and removal from the program.

**7.3 Program-level circuit breaker (KPI kill rules).** If disclosure/persona compliance on sampled audits drops below 90%, OR any fake persona is detected: suspend that creator and PAUSE all new creator onboarding until the rate recovers to >= 95% for 30 days. If any asset ever ships without a logged PASS: HALT all sends and the creator program on that channel until the gate is enforced there.

---

## 8. The creator agreement rider (CLO-gated)

Every creator signs the standard agreement WITH a claims-and-disclosure rider, CLO-reviewed, that binds them to: the allow/deny list, the 16 CFR 255 disclosure rules, mandatory pre-publish claims_check routing, no fabricated personas, the takedown/removal obligation within 24 hours, and an indemnity for claims they make outside the approved asset. The rider is a hard prerequisite; no creator is paid before it is signed and the CLO has reviewed the rider and indemnity.

---

## 9. Onboarding checklist (the gate, per creator)

A creator may be activated only when ALL of these are GREEN, recorded in the creator file:

- [ ] claims_check gate is deployed + CCO-verified firing (program-level, one time; see CLAIMS-CHECK-ACCEPTANCE-TEST.md)
- [ ] Real-identity KYC complete (ID, contact, channel control proof, W-9/W-8BEN)
- [ ] Persona-authenticity attestation signed (no fabricated/AI/undisclosed-clinician persona)
- [ ] Any professional credential independently verified (or struck)
- [ ] Creator agreement + claims/disclosure rider signed and CLO-reviewed
- [ ] Creator given the allow/deny list and the disclosure-placement rules
- [ ] Substantiation on file for any comparative/superiority/guarantee/CS claim the creator will make
- [ ] BRAND-HEALTH = READY if the creator will promote the guarantee or CS
- [ ] First sample asset routed through claims_check with a logged PASS and a passing CCO net-impression + disclosure review
- [ ] Securities firewall acknowledged (no INND/share-price/CareNow-share-bundle), TCPA-SMS acknowledged (email-only)

When every box is checked, the CCO records `CREATOR ACTIVATED` with the date and the creator id in the registry and the cco ledger. Anything less = not activated.

---

*This SOP is a living control. The CCO updates it as the ruleset and the FTC guidance evolve; the source of truth for the substantive ruleset is the deployed `claims_check` gate config plus this document.*
