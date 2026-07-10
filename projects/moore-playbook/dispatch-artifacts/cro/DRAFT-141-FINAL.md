# DRAFT-141 FINAL - Reignition Email to the 66,224 Warm HearingAssist List

**Owner:** CRO / Lifecycle · **Lane:** `cro` (write-through `--tags moore-playbook,draft-141`)
**Platform:** Customer.io workspace 193366 · **Segment:** LOCKED 66,224 warm mailable HearingAssist contacts
**Channel:** EMAIL ONLY (SMS stays TCPA-blocked per CCO) · **Status:** STAGED-AND-HELD pending send-go
**Compliance:** PSAP-only language, runs through the live `claims_check` gate before staging

> **READ FIRST - what this is and what gates it.** This is the final, commit-ready copy for the
> single highest-cash lever in the Moore machine: the reignition email to the 66,224 warm
> HearingAssist contacts, driving to the $99 Complete Pair (code PAIR99) TReO funnel. The COPY is
> done here. **SENDING is NOT done here.** The send is Matt-gated and conditional on three
> preconditions GREEN per the Execution Program Phase 3: (1) CHECKOUT-PROOF=PASS (one real
> full-price unrefunded order settling to Mercury), (2) BRAND-HEALTH=READY (live refund desk +
> reachable CS so the warm list does not hit a dead support line), (3) this draft staged +
> claims_check-cleared. On all three green, COO presents a single yes/no send-go; CRO fires a
> ~2,000-contact (3 percent) seed wave first, then releases the full 66,224.

---

## 0. Compliance guardrails baked into this copy (do not edit these out)

- **TReO is a PSAP - a Personal Sound Amplifier.** Every line frames it as sound amplification /
  general wellness for everyday listening. There is ZERO treat / diagnose / cure / hearing-loss /
  hearing-aid / FDA / medical language anywhere in either variant. This is the Medvi failure line
  (their FDA warning letter was front-end claim specificity) and it is the moat.
- **Comparison framing is price-only and factual.** "$299 a side at the pharmacy. $99 here" is a
  price comparison on our own product's prior price and a general retail anchor, not a clinical
  claim. Dated substantiation for the comparative price claim is filed by CCO before send.
- **DASH-CLEAN.** No em dashes, no en dashes anywhere in the published copy below. Commas,
  periods, and line breaks only.
- **The four CAN-SPAM elements are present in both variants:** honest "from," honest non-deceptive
  subject, the physical postal address (Roseville placeholder, replace with the verified mailing
  address before send), and a working one-click unsubscribe line wired to suppression in
  Customer.io.
- **No INND / securities content.** Nothing about the public company, shares, price, or raise
  appears in consumer copy.

---

## 1. Sending identity and footer (shared by both variants)

**From name:** iHEAR TReO (HearingAssist)
**From address:** hello@otchealthmart.com
**Reply-to:** support@otchealthmart.com (monitored; routes to the live CS desk)
**Physical postal address (CAN-SPAM element 3 - REPLACE PLACEHOLDER BEFORE SEND):**
[Company Legal Name], [Street Address], Roseville, CA [ZIP]
**Unsubscribe (CAN-SPAM element 4 - one-click, wired to Customer.io suppression):**
You are receiving this because you are a HearingAssist customer or requested information from us.
No longer want these emails? Unsubscribe here. {% unsubscribe_url %}

> Customer.io merge note: the footer block (physical address + one-click unsubscribe) is rendered
> on EVERY send via the shared layout, so it cannot be dropped by an A/B body swap. The
> `{% unsubscribe_url %}` (or the workspace one-click List-Unsubscribe header) must resolve to a
> live suppression action verified on the seed wave.

---

## 2. VARIANT A - CONTROL (price anchor)

**Use as:** the control arm of the A/B split. Lead with the price story (our strongest, simplest
hook for the warm base).

### Subject line
Your iHEAR TReO is back, and it is $99 for the pair

### Preview text (preheader)
$299 a side at the pharmacy. $99 here for both, with free shipping and 60 days to decide.

### Body

Hi [First Name],

It has been a while, and we wanted to reach out with good news.

Your iHEAR TReO personal sound amplifier is back in stock, and right now you can get the complete
pair, left and right, for $99.

That is both amplifiers for $99. A single side runs $299 at the pharmacy. With the code below, you
get the pair for the price most places charge for one.

TReO is a personal sound amplifier. It is for the everyday moments where a little more clarity
helps. The conversation across the dinner table. The TV at a volume the rest of the room can live
with. The grandkids on the phone. You slip them in, turn them on, and the sounds around you come
through clearer.

Why people who already know us are coming back to TReO:

- Both amplifiers, left and right, for $99 with the code PAIR99.
- Free shipping to your door.
- 60 days to try them at home. If they are not right for you, send them back for a refund.
- Real people to help. Call us at 1-800-864-4337 with any question.

Ready to hear the room again?

[ Get my pair for $99 ]

Use code PAIR99 at checkout so both amplifiers come to $99.

Thank you for being part of the HearingAssist family. We are glad to have you back.

Warmly,
The iHEAR TReO Team
HearingAssist

---

*Footer (auto-rendered, see Section 1):*
[Company Legal Name], [Street Address], Roseville, CA [ZIP]
You are receiving this because you are a HearingAssist customer or requested information from us.
Unsubscribe here. {% unsubscribe_url %}

**Primary CTA target:** the TReO advertorial + 5-question quiz funnel
(`iheartreo-funnel.html`), with code PAIR99 applied, checkout to otchealthmart.com.
**CTA button link:** the staged funnel URL (final URL set by CTO before send).

---

## 3. VARIANT B - AIRPODS-REBUTTAL (friction / why TReO for this use)

**Use as:** the test arm. Lead by pre-empting the most common 2026 objection from a warm,
senior-skewing base: "can't I just use AirPods Pro in hearing-aid mode?" The answer is framed
around FIT and FRICTION for this specific use, never by making a clinical claim about either
product. Same offer, same CAN-SPAM footer, same CTA.

### Subject line
Not an AirPod, and that is the point

### Preview text (preheader)
No iPhone. No tiny menus. No charging case to chase. Your TReO pair is back, $99 for both.

### Body

Hi [First Name],

You may have read that the latest earbuds can now turn up the volume on the world around you. It
is a nice feature. For a lot of people it is also a lot of fuss.

We make iHEAR TReO for the people that fuss leaves out.

TReO is a personal sound amplifier built to do one job well and get out of your way:

- It works on its own. No iPhone required, no app to set up, no account to make.
- You turn it on and wear it. No tiny on-screen menus, no settings buried three taps deep.
- It is built to sit comfortably for a long day, not to share a charging case with your music.
- When you have a question, a real person answers. Call 1-800-864-4337.

If the high-end earbud route sounds like one more gadget to manage, TReO is the simple alternative.
Put them in, turn them up, hear the room. That is the whole experience.

And right now the complete pair, left and right, is $99.

That is both amplifiers for $99 with the code PAIR99, the price a single side runs at the pharmacy.
Free shipping, and 60 days to try them at home. If they are not right for you, send them back for a
refund.

[ Get my pair for $99 ]

Use code PAIR99 at checkout so both amplifiers come to $99.

Simple sound, when you want it. Welcome back.

Warmly,
The iHEAR TReO Team
HearingAssist

---

*Footer (auto-rendered, see Section 1):*
[Company Legal Name], [Street Address], Roseville, CA [ZIP]
You are receiving this because you are a HearingAssist customer or requested information from us.
Unsubscribe here. {% unsubscribe_url %}

**Why B is compliant on the AirPods angle:** B differentiates on FORM FACTOR and EASE OF USE
(no phone, no app, no menus, simple all-day wear, human support), which are factual product
attributes. It never claims TReO treats or corrects anything, never claims it is medically
superior, and never makes any clinical comparison to the competing earbud. It positions TReO as
the simpler tool for the job, which is the legitimate, PSAP-safe rebuttal.

---

## 4. A/B split specification (for the send)

| Field | Control (A) | Variant (B) |
|---|---|---|
| Hook | Price anchor ($299/side vs $99/pair) | Friction / AirPods rebuttal (no phone, no app, simple) |
| Subject | Your iHEAR TReO is back, and it is $99 for the pair | Not an AirPod, and that is the point |
| Preview | $299 a side at the pharmacy. $99 here for both, with free shipping and 60 days to decide. | No iPhone. No tiny menus. No charging case to chase. Your TReO pair is back, $99 for both. |
| Offer | PAIR99 -> $99 complete pair, free ship, 60-day return | identical |
| CTA | Get my pair for $99 -> funnel | identical |
| Footer / CAN-SPAM | identical (shared layout) | identical (shared layout) |

- **Split mechanics:** within the LOCKED 66,224, hold the ~2,000-contact (3 percent) seed slice
  out first for the deliverability test (Section 5). On a clean seed, split the remaining list
  50/50 A vs B for the full release.
- **Primary metric:** clicks landing on the proven checkout, then cost-per-initiated-checkout /
  initiated-checkout rate (PostHog is the single source of truth, SOP-2). Open rate is a
  secondary signal only.
- **Winner call:** declare at 48 to 72 hours on initiated-checkout rate; do not call on opens.

---

## 5. Seed-wave / deliverability gate (runs BEFORE the full send, after send-go)

The full 66,224 release is itself conditional on a clean seed. After Matt's send-go:

1. Send draft-141 (split A/B) to a ~2,000-contact (3 percent) holdout slice of the LOCKED segment.
2. Measure over 24 hours: bounce rate, spam-complaint rate, open rate, click-to-checkout.
3. **Go criteria to release the full list:** bounce < 3 percent AND spam-complaint < 0.1 percent
   AND at least one checkout initiated from the seed.
4. Record the go / no-go as a decision in the `cro` ledger; if no-go, fix deliverability
   (warm-up, list hygiene, authentication) before re-attempting.

---

## 6. Staging checklist (CRO / lifecycle, in Customer.io ws 193366)

- [ ] LOCKED 66,224 segment confirmed; suppression list applied (prior unsubscribes / bounces).
- [ ] Both variants pass the live `claims_check` gate; CCO clearance memo filed (PSAP language,
      no medical / hearing-aid claims, comparative price claim substantiated and dated).
- [ ] Physical postal address placeholder replaced with the verified Roseville mailing address.
- [ ] One-click unsubscribe wired to suppression; verified to actually suppress on the seed.
- [ ] SPF / DKIM / DMARC aligned for the sending domain; List-Unsubscribe header present.
- [ ] CTA links resolve to the staged funnel with PAIR99 applied and a PROVEN checkout behind it.
- [ ] Brand-health verified: 1-800-864-4337 answers within SLA and refunds are operationally
      fundable (Stripe payout bank connected) so the 60-day guarantee is operationally true.
- [ ] Seed slice (~2,000) carved out; A/B 50/50 split configured for the remaining release.
- [ ] Campaign SCHEDULED-AND-HELD; no send until Matt's recorded send-go.

---

## 7. What is done here vs what is still gated

- **DONE here:** the final, DASH-CLEAN, PSAP-compliant copy for both the price-anchor control (A)
  and the AirPods-rebuttal variant (B), with all four CAN-SPAM elements, the A/B split spec, the
  seed-wave gate, and the staging checklist.
- **STILL GATED (NOT done here, by design):** actually staging in Customer.io against live data,
  running it through the live claims_check gate, replacing the Roseville address placeholder, and
  SENDING. The send is Matt-gated and conditional on CHECKOUT-PROOF=PASS + BRAND-HEALTH=READY +
  claims_check-cleared, then a clean seed wave. Email only; SMS is TCPA-blocked.
