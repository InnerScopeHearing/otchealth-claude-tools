# OTCHealth Warranty & Product Registration Operations Packet

Status: Decision-ready nonpublic operating draft. No public launch, customer communication, Fin publication, refund, credit, inventory reservation, order, label, shipment, repair work order, Safety closure, adverse decision, or appeal decision is authorized by this packet.

Prepared: 2026-08-07
Program scope: Product-neutral OTCHealth Warranty & Product Registration, with iHEAR TReO as the first implementation.

## 1. Operating decision

OTCHealth should operate one owned Warranty Service and Warranty Ledger. Shopify remains commerce and account context. PostgreSQL becomes warranty truth. Blob and its scan state become evidence-byte truth. Intercom remains conversation truth. n8n, Fin, WMS, carriers, repair providers, payment systems, and any RMA vendor remain replaceable adapters.

Registration is optional service metadata. It never creates, preserves, reduces, voids, or shortens rights. A paid qualifying order creates provisional coverage automatically. Missing registration, account, receipt, serial, upload, email, smartphone, printer, or SMS access never blocks claim or Safety intake.

The standing authority floor controls every implementation detail:

- AI and Fin may retrieve customer-authorized status, summarize verified facts, classify an issue, guide approved nonmedical troubleshooting, rank a case for human review, and draft from an approved template.
- AI, Fin, n8n, or a deterministic worker may not deny or approve coverage; select or authorize a remedy; decide fraud; change ownership, contact, or address; reserve or release inventory; create an order, label, shipment, pickup, repair order, refund, credit, hold, or charge; close a Safety event; release an adverse, Safety, recall, bulk, legal, or financial message; or decide an appeal.
- At launch, Matt approves repair, replacement, denial, and business remedy. Finance approves every monetary action. Product Safety independently controls containment and closure. Every consequential execution later requires a separate exact-scope, one-use human authorization tied to the action digest, object version, provider, amount or SKU or leg or template or recipient scope, expiration, and idempotency key.

Sources: TReO-Warranty-Member-Blueprint-Full.md §§1, 4, 7, 16-21, 24-29; 02-azure-service-plan.md §§1-5, 7-14, 17; 03-program-raci-tests.md §§0-7 and 12.

## 2. Customer-neutral state model

Customer-facing states answer four questions: what is happening, what the customer needs to do, who owns the next step, and the target date.

1. RECEIVED
2. SAFETY REVIEW
3. CHECKING COVERAGE
4. MORE INFORMATION NEEDED
5. TRY A SAFE STEP
6. UNDER HUMAN REVIEW
7. NOT COVERED UNDER THE LIMITED WARRANTY, WITH CORRECTION AND APPEAL PATHS
8. APPROVED, PREPARING RESOLUTION
9. REPAIR IN PROGRESS
10. REPLACEMENT PROCESSING
11. RETURN IN TRANSIT
12. ITEM RECEIVED AND IN QUARANTINE OR INSPECTION
13. REPLACEMENT SHIPPED, only after carrier acceptance
14. REFUND PROCESSING
15. REFUND SENT, only after provider settlement evidence
16. APPEAL UNDER REVIEW
17. COMPLETE, only after outcome evidence, reconciliation, and Safety release

Internal risk scores, AI confidence, economics ranking, unapproved remedies, warehouse notes, Safety investigation details, and staff notes are never exposed in the customer projection. Label creation is never represented as shipment.

## 3. Queue map and owners

### Named now

- Executive remedy, repair, replacement, denial, and adverse-business-decision approver: Matt.
- Current Intercom admin identity: Care Team, admin 11167146. It is an owner/admin identity and must not expose Matt's personal name or address in customer-facing replies.
- Current Intercom operator: Helen, admin 11167147.
- Current Intercom Safety queue: Safety Escalations, team 11247295.

### Proposed provisional operating assignment, pending Matt sign-off

- Care intake and ordinary status support: Helen as primary operator; Care Team admin as configuration owner.
- Safety intake routing: Safety Escalations team.
- Executive approval: Matt.

### Names still required before pilot

- Matt backup for executive approvals.
- Warranty Program Owner and deputy.
- Warranty Operations Lead and senior-specialist backup.
- Named Product Safety lead, secondary, and duty schedule.
- Finance approver and backup.
- Warehouse and inventory lead plus backup.
- Repair lead plus backup provider.
- Independent Appeals Lead and alternate.
- Legal, Privacy, Security, Accessibility, Communications, Incident, and Vendor Exit owners and backups.

No public SLA or 24/7 promise may be made until these people and coverage windows are signed.

## 4. SOP runbooks

### SOP 01 - Intake, registration, and claim preservation

Trigger: web, Intercom, phone, email, mail, relay, caregiver, retail, gift, transfer, or outage intake.

Steps:
1. Accept Safety intake first without requiring identity, order, serial, registration, receipt, or email.
2. Create an opaque provisional reference and preserve original attempted-contact time.
3. Determine channel and relationship: buyer, current owner, gift recipient, delegate, retail purchaser, legacy owner, or unknown.
4. Search existing claim and unit records only after appropriate proof of control. Do not disclose whether another owner exists.
5. If a paid OTCHealth order is verified, create or locate provisional entitlement automatically. Do not inspect registration status as an adverse factor.
6. If off-channel or missing proof, place the claim in PENDING VERIFICATION while continuing Safety and allowed service.
7. Capture only mechanical issue code, component, brief optional text, contact preference, and necessary proof. Do not request age group, diagnosis, hearing-test results, medications, or insurance details.
8. Deduplicate by authorized unit, incident scope, and claim relationship. Never merge claims based only on name, email, address, order number, or free text.
9. Confirm receipt from an approved template only after the core record is durably committed.
10. Route Safety-positive cases to SOP 02; otherwise route to SOP 03.

Records: claim ID, source channel, original contact time, relationship, entitlement state, issue code, Safety answers, event digest, actor, policy version.

### SOP 02 - Safety-first intake and containment

Trigger: injury, pain, heat, swelling, smoke, fire, leaking or damaged battery, sudden dangerous malfunction, recall or lot concern, or approved Safety taxonomy hit.

Steps:
1. Atomically create or link a Safety case and mark the ordinary claim path blocked.
2. Display or read the approved stop-use script immediately.
3. Page the named Product Safety duty owner and record acknowledgment time.
4. Block ordinary troubleshooting, destructive proof requests, returnless handling, and ordinary parcel or air labels.
5. Apply authorized unit, lot, and inventory holds through a named human Safety command only.
6. Determine custody and hazardous-return requirements. Damaged lithium devices use the approved hazardous-material route.
7. Product Safety and Legal decide reportability, recall, containment, and customer or bulk communications. AI may draft only.
8. Safety closure requires a named Safety human, rationale, disposition, reportability outcome, custody state, and corrective action. Ordinary claim closure never closes Safety.

Immediate halt: any Safety-positive case entering an ordinary path or receiving an ordinary shipping label.

### SOP 03 - Entitlement and proof review

Steps:
1. Resolve the applicable immutable policy version and jurisdiction overlay.
2. Confirm product, unit, component, predecessor or successor lineage, owner relationship, and qualifying transaction where available.
3. Apply the approved proof hierarchy: OTCHealth order or receipt or gift receipt; retailer record; payment plus corroboration; service or activation evidence; counsel-approved attestation or manual review.
4. Request evidence once, state the reason, provide an example and alternative, and retain the verified result for reuse.
5. Missing receipt, serial, image, or upload never causes an automated denial.
6. Keep date status provisional if delivery or possession date is unresolved. Show dates as being confirmed rather than a false countdown.
7. Correct dates and ownership through compensating events, never destructive overwrite.
8. Escalate exclusions, timeliness, ownership conflicts, suspected fraud, or adverse findings to a human specialist and then Matt or signed delegate.

### SOP 04 - Evidence handling

Steps:
1. Accept only approved still-image types during initial pilot; proposed limit is three JPG or PNG files, 10 MB each, pending validation.
2. Upload to private quarantine with a narrow one-object authorization.
3. Validate magic bytes, decode and re-encode, strip metadata, scan, and mark clean or rejected.
4. Do not expose evidence to staff, model, vendor, Intercom, Fin, n8n, email, logs, traces, or events until the clean gate passes.
5. Store only metadata and blob reference in the Warranty Ledger.
6. Provide an equally effective phone, mail, or assisted alternative.
7. Apply approved retention, legal hold, deletion, and restore re-deletion controls.

### SOP 05 - Bounded troubleshooting

Steps:
1. Confirm the case is not Safety-positive and the troubleshooting script version is approved for the product and issue code.
2. Offer only nonmedical, reversible, device-support steps.
3. Permit the customer to skip without penalty.
4. Stop after the approved bounded sequence or sooner if a Safety trigger appears.
5. Record offered step, outcome, and skip reason.
6. Escalate unresolved cases to human review. Never imply that troubleshooting failure proves misuse, fraud, exclusion, or no fault.

### SOP 06 - Human review, recommendation, and approval

Steps:
1. Specialist reviews policy version, entitlement, accepted evidence, troubleshooting, unit history, Safety state, and known provider constraints.
2. System may compute route options and economics, but presents assumptions, source freshness, and uncertainty.
3. Specialist recommends repair, component replacement, standard replacement, material substitute, advance exchange, returnless replacement, refund, no-coverage finding, or information request.
4. Matt or signed delegate approves or declines the business and coverage decision. Finance separately approves monetary actions. Safety and Legal retain veto authority.
5. Record reason codes and human rationale. Do not describe any decision as final or binding.
6. Create no provider command from the decision alone. Each inventory, order, label, shipment, repair, payment, or message action later requires a new exact one-use human execution authorization.

Advance exchange and returnless replacement remain inactive until separately approved with caps and tests.

### SOP 07 - Inventory, replacement, and successor coverage

Steps:
1. Revalidate Safety, recall, quarantine, unit condition, service tier, and approved equivalent product.
2. Draft a reservation action. A named human authorizes the exact SKU or serialized unit and quantity.
3. Warranty worker atomically consumes the one-use authorization and reserves exactly once.
4. No customer promise is made before confirmed reservation.
5. Create predecessor-successor unit lineage and successor entitlement under the approved remaining-term or longer-law rule.
6. If no stock exists, route to human alternate-remedy review with owner and date.
7. Reconcile reservation, pick, actual serial, order, carrier acceptance, delivery, return, inspection, and closure.

### SOP 08 - Labels, receiving, quarantine, inspection, NFF, and disposition

Steps:
1. Label creation requires a specific human authorization and correct return route.
2. Track label_created, tendered, in_transit, delivered, and facility_check_in as separate observations.
3. Receiving validates expected versus observed unit and serial, records weight and origin, and quarantines immediately.
4. Mismatch never auto-denies. Open a human exception.
5. Inspection uses a versioned plan for identity, function, Safety, sanitation, accessories, and data wipe.
6. No-fault-found is an inspection result, not a denial. Route to human review for intermittent defect, alternate route, return, repair, replacement, or additional observation.
7. Repair, refurbish, supplier RMA, harvest, scrap, or Safety hold requires named human authorization and traceable disposition.

### SOP 09 - Repair and backorder

Steps:
1. Confirm approved repair route, center capability, parts, expected completion date, and legal timing.
2. Create work-order draft; named human authorizes exact work scope.
3. Track received, diagnosis, estimate, parts, repair, QA, outbound, and delivered observations separately.
4. If parts or capacity fail, create an alternate-remedy review rather than indefinite delay.
5. Notify only from approved templates after recipient verification and release controls.
6. Closure requires QA and delivery evidence plus cost reconciliation.

### SOP 10 - Refund and monetary action

Steps:
1. Confirm business approval and Finance approval.
2. Draft exact amount, currency, provider, order or payment reference, and reason.
3. Obtain one-use Finance execution authorization.
4. Warranty worker consumes authorization and sends one provider command with idempotency.
5. Provider acceptance is not settlement. Track pending, settled, failed, reversed, and reconciled separately.
6. Any unmatched success after timeout freezes further action and opens a Finance and Security exception. Never retry blindly.

### SOP 11 - Customer communication

Steps:
1. Use one approved template version linked to policy and claims-check references.
2. Verify recipient, relationship, channel permission, language, and customer-safe fields.
3. Classify ordinary transactional versus adverse, Safety, recall, bulk, legal, or financial.
4. Draft only. Adverse, Safety, recall, bulk, legal, and financial messages require exact human release authorization. Ordinary conversational replies remain within existing approved reply authority, not these lifecycle drafts.
5. Deduplicate by deterministic send key. Handle bounce, suppression, wrong-recipient, and alternate-channel exceptions.
6. Every status message states status, required action, owner, and target date.

### SOP 12 - Appeal and correction

Steps:
1. Accept free appeal or correction by web, phone, email, or mail without requiring an account.
2. Acknowledge receipt immediately after durable commit.
3. Assign a different authorized reviewer where practicable.
4. Show the original human decision, facts and evidence considered, policy version, cure path, and state-rights caveat.
5. AI may summarize but never decide.
6. Human outcome may uphold, overturn, partially overturn, or reopen remedy.
7. Any monetary or fulfillment consequence re-enters the separate approval and one-use execution process.

### SOP 13 - Manual intake and outage

Steps:
1. If core write is unavailable, display an honest degraded page with current terms and Care channels.
2. Never display submission success without a core commit.
3. Create a timestamped manual provisional reference and preserve attempted-contact time.
4. Continue Safety phone and email intake through the independent path.
5. Fail closed on new risky actions; continue safe read-only and manual help.
6. On recovery, back-enter with original time, reconcile duplicates, and notify only when approved.

### SOP 14 - Kill switches

Required switches: AI, adjudication, Safety, evidence upload, guest access, n8n, communications, fulfillment, payments, provider adapter, and public intake.

Activation steps:
1. Named incident owner records reason and scope.
2. Switch blocks new affected actions while preserving canonical records and safe reads.
3. Manual queues and degraded copy activate.
4. Incident owner reconciles in-flight commands and callbacks.
5. Resume requires root cause, remediation, replay or reconciliation evidence, negative tests, and named domain approval.

### SOP 15 - Vendor exit

Steps:
1. Stop new egress and revoke vendor credentials.
2. Export owners, units, serial relationships, policies, claims, events, media metadata, messages, shipments, costs, field dictionary, counts, and checksums.
3. Perform clean-room import and prove open-claim continuity.
4. Reconcile provider versus owned ledger.
5. Obtain deletion certificate and verify backup expiry.
6. Continue from the owned ledger and manual queues. Customer semantics may not change when the adapter is disconnected.

### SOP 16 - Reconciliation cadence

- Near-real-time: outbox and provider commands, upload and scan, authorization consumption, exactly-one side effect.
- Hourly: missing entitlements, approved but unexecuted actions, unmatched carrier observations, dead letters.
- Nightly: Shopify order and product versus entitlement; Intercom handoff projection; provider observations; status freshness.
- Daily: dates, reminders, timely open claims, aged next actions, Safety acknowledgment.
- Weekly: labels, scans, invoices, receipts, quarantine, inspection, serial conflicts, ownership conflicts.
- Monthly: remedy costs, refunds, recoveries, dispositions, supplier credits, reserve, and general-ledger tie-out.
- Quarterly: access review, overrides, vendor export, restore, replay, exit, incident, and kill-switch drills.

Reconciliation detects and owns exceptions; it never automatically overwrites canonical state or repeats a side effect.

## 5. Internal targets, staffing assumptions, and pilot caps

Proposed internal targets only:

- Receipt after core commit: immediate.
- Safety guidance: immediate.
- Safety human acknowledgment: within one business hour, but no 24/7 public promise until rostered.
- First human review after evidence complete: next business day.
- Information request after review: same business day.
- Matt or delegate approval: within one business day.
- Reservation after exact execution authorization: within 15 minutes.
- Warehouse tender for in-stock authorized resolution: next business day.
- Facility check-in after carrier delivery: same business day.
- Inspection: one to two business days, subject to pilot proof.
- Appeal acknowledgment: immediate after commit.
- Appeal decision target: five business days.
- OTCHealth-owned missed date: proactive update immediately, then every two business days.

These are not publishable promises until arrival volume, handle times, staff availability, Safety coverage, approval throughput, inventory, repair capacity, Finance capacity, holidays, languages, and assisted-channel capacity are measured.

Pilot restrictions: synthetic then employee then small real cohort; manual decisions and execution; AI shadow/read-only; no advance exchange or returnless route; daily S0 review; all kill switches drilled; two complete operating and financial reconciliation cycles.

Pilot caps still requiring Matt, Finance, Safety, and Operations approval: eligible SKU/channel/jurisdiction; claims per day; concurrent claims; open evidence, approval, appeal, repair, inspection, and Safety queues; units and dollars per week; inventory floor; queue-aging limits; vendor volume; aggregate loss.

## 6. Exact proposed Intercom objects - create only after approval

Verified current workspace: budq9yib. Existing relevant resources remain untouched.

### Teams

- Keep Safety Escalations 11247295.
- Propose Warranty Operations, with named primary and backup required.
- Propose Warranty Appeals, independent from original reviewer where practicable.

### Ticket type

Propose Warranty Claim with fields:

- warranty_claim_ref, text, required, opaque
- warranty_safe_status, list
- warranty_next_action, text
- warranty_owner_role, list
- warranty_target_at, datetime
- warranty_policy_version, text
- warranty_entitlement_state, list
- warranty_evidence_state, list
- warranty_safety_flag, boolean
- warranty_appeal_state, list
- warranty_freshness_at, datetime
- warranty_action_digest, text, internal only

No raw serial, address, evidence URL, diagnosis, hearing test, payment data, risk score, AI confidence, or internal Safety investigation detail.

### Tags

- warranty-claim
- warranty-needs-evidence
- warranty-human-review
- warranty-pending-approval
- warranty-safety-hold
- warranty-appeal
- warranty-manual-intake
- warranty-reconciliation-exception

Existing safety-escalation 15837481 remains the Safety routing tag.

### Collections and draft articles

Propose new collection Warranty, Claims & Product Registration. Draft, do not publish:

1. Product Registration Is Optional
2. How to Start and Track a Warranty Claim
3. What Evidence May Be Requested
4. Safety: Stop Use and Contact Care
5. Warranty Corrections and Appeals
6. Manual Help During an Outage
7. Gift, Transfer, Retail, and Legacy Purchase Help
8. Repair, Replacement, Return, and Refund Are Different Processes

All copy remains gated on the approved warranty terms, customer-content review, and claims check.

### Fin/Data Connector proposal

Keep existing live identity and Safety connectors. Add only read-only connectors later:

- warranty_summary_read: returns claim ref, customer-safe status, required action, owner role, target date, evidence state, freshness, and portal link.
- warranty_timeline_read: returns only approved customer-safe events.
- warranty_product_context_read: returns product display name, component scope, entitlement state, and masked identifiers.

Do not create a Fin connector for denial, remedy approval, fraud outcome, ownership/address change, inventory, order, label, shipment, refund, credit, Safety closure, outbound message, or appeal decision. Fin hands off to a human queue when data is stale or unavailable.

## 7. n8n synthetic drafts created and tested

All six workflows are in the personal n8n project for matthew@otchealthmart.com. Every workflow is inactive, has no active version, has zero triggers, has no credentials, and contains only Manual Trigger, Set nodes, and a guardrail note.

| Code | Workflow ID | Purpose | Test execution |
|---|---|---|---|
| WTY-00 | f9hT19JCNh2tQi7v | Signed Event Intake and Router synthetic contract | 46905 PASS |
| WTY-01 | AyA4BGMspfpoSeTf | Intercom Care Handoff draft | 46901 PASS |
| WTY-02 | cdlb1eaRgTVJooU1 | Customer Communication draft | 46902 PASS |
| WTY-03 | yGML7VPfrLTSP2ra | Operations Action draft | 46903 PASS |
| WTY-04 | 9BMtCKBfxi9aiXcR | Provider Event Normalize draft | 46900 PASS |
| WTY-05 | VyyFdtwj2aLNns8N | Reconciliation Exception draft | 46904 PASS |

Every test output proved: synthetic=true; mode=synthetic_draft; external_call_count=0; authorization_consumed=false; draft_only=true; live_execution_permitted=false; customer_contact_permitted=false. WTY-03 additionally proved provider_call_permitted=false and status=AWAITING_HUMAN. WTY-04 proved domain_transition_applied=false. WTY-05 proved auto_repair_permitted=false.

These are executable contract scaffolds, not production integrations. They intentionally omit webhooks, schedules, credentials, persistence, HTTP calls, Intercom nodes, Shopify nodes, WMS, carriers, repair, payments, and communications.

## 8. Remaining blockers and activation gates

1. Final warrantor, product classification, one-year terms, state overlays, coverage dates, transfer rule, exclusions, remedies, fees, successor term, appeals, and historical registration-denial remediation.
2. Named Matt backup and signed authority matrix, including one-use execution authorization roles.
3. Named Product Safety owner and backup plus staffed coverage, scripts, reportability, hazardous return, custody, and closure rules.
4. Warranty Program, Operations, Finance, Appeals, Warehouse, Repair, Privacy, Security, Accessibility, Communications, Incident, and Vendor owners and backups.
5. Theme baseline checksum discrepancies for settings_data.json, header-group.json, and footer-group.json plus a proven rollback package.
6. Canonical Warranty Service and PostgreSQL ledger do not yet exist.
7. Actual assembly, left, right, box, and OEM serial sources and scan points are unverified.
8. WMS, carrier, hazardous shipping, repair, payment/refund, and vendor contracts and capabilities are unverified.
9. Real costs, reserve, claim rate, handle time, approval capacity, repair rate, NFF rate, repeat failure, inventory lead time, loss caps, and pilot caps are missing.
10. Warranty-specific Intercom teams, ticket type, fields, tags, articles, and read-only Fin connectors remain proposals only.
11. Gateway Intercom connector remains unconfigured even though the same live OTCHealth workspace was verified directly through the local Intercom CRM credential.
12. No public warranty route, immutable terms page, customer account extension, guest access, upload flow, status view, appeal flow, or assisted intake has been released.
13. Security, privacy, accessibility, identity, concurrency, duplicate-side-effect, outage, restore, deletion, vendor-exit, kill-switch, and two-close pilot evidence is not yet complete.

Public or pilot activation requires the signed Legal, Safety, Identity, Security, Privacy, Integrity, AI, Operations, Accessibility, Customer Experience, Vendor if used, Finance, and Pilot gates defined in the blueprint and implementation planner.

## 9. AfterShip public-domain, policy, window, and notification S0 addendum - 2026-08-08

The CRO negative-path pilot proved that AfterShip Admin status `Unpublished` is not sufficient containment evidence. Both default domains were publicly actionable before the corrected draft was resaved and exposed stale 30-day policy content. After the draft save, both domains visibly returned Page not found, but Operations anonymous readback found a soft 404: HTTP 200 plus hidden runtime state.

Current five-plane reconciliation:

- Admin expectation: Delivery date + 75 days.
- Anonymous visible page: Page not found on `hearingassist.aftership.com` and `hearingassist.returnscenter.com`, including `/return-policy`.
- Public runtime: access denied / `returns_page_not_published`; `return_window_base_on=delivery_date` now matches Admin.
- Public runtime policy fields: translated summary includes the approved 75-day delivery copy, while `policy_text` still says unused and undamaged.
- Public runtime policy URL and contact/privacy/terms URLs now match the saved draft; search-engine blocking remains false.

Root cause and bounded resolution: AfterShip Returns requires the separate AfterShip Tracking app to persist Delivery date. CRO first discarded the unsavable draft. After scope review and Matt authorization, CRO installed Tracking on Free 50 Monthly at $0, turned auto-upgrade and notifications OFF, kept the tracking page unlaunched, and observed one existing shipment auto-sync. Returns persisted Delivery date + 75 days with no fulfillment fallback. Order-date approximation remains prohibited.

This remains an S0 launch HOLD, not a clean containment PASS, because stale `policy_text` survives across all four runtime readbacks. A visible 404 cannot override contradictory runtime policy.

Required daily readback:

1. Probe both default domains and every policy/custom/app-proxy path anonymously.
2. Evaluate visible content and runtime JSON; do not rely on HTTP status because AfterShip returns soft 404s.
3. Compare Admin, public visible page, public runtime, canonical Shopify policy and notification configuration.
4. Fail launch if delivery-date dependency, window basis/days, policy text/link, publication state, search indexing, contact/privacy/terms links, or any notification event/owner disagrees.
5. Preserve the JSON receipt and open one human reconciliation exception; never auto-correct vendor state.
6. Keep the completed Tracking scope review and Matt authorization with the gate record; any plan, scope, price, notification, page, automation, data-sharing or reinstall change requires a new bounded review.
7. Never approximate delivery with order date.
8. Require two consecutive clean daily readbacks after the final correction before pilot or launch evidence may cite this gate as ready.

Solo-operator notification routing, per `cro__20260724-012-a418`:

- Daily S0 owner: CRO; backup: CTO through an independent notification channel.
- Ordinary transactional content: COO/Care; ordinary release: COO.
- Adverse/rejection: Matt only, alerted through two independent channels; CLO reviews; no agent decides.
- Safety/recall: Matt only, alerted through two independent channels; COO+CLO monitor/escalate but cannot close.
- Wrong-recipient incidents: CTO/Security; Matt notified through two independent channels.

Backup means channel/monitor redundancy, not another employee. Actual outbound notifications remain disabled until copy, recipient/relationship, dedupe/suppression and event-level release tests pass. These assignments do not close substantive Safety, legal, staffing, Finance, Appeals or pilot gates.

Durable controls:

- `coo/warranty/s0/aftership-s0-probe.mjs`
- `coo/warranty/s0/aftership-expected.json`
- `coo/warranty/s0/AFTERSHIP-TRACKING-PROCUREMENT-SCOPE-GATE.md`
- `coo/warranty/s0/DAILY-S0-AFTERSHIP-CHECKLIST.md`
- `coo/warranty/s0/NOTIFICATION-OWNERSHIP-MATRIX.md`
- `coo/warranty/s0/LAUNCH-CHECKLIST-ADDENDUM.md`
- `coo/warranty/s0/evidence/aftership-s0-2026-08-08.json`
- `coo/warranty/s0/evidence/aftership-s0-2026-08-08-post-tracking.json`
- `coo/warranty/s0/aftership-s0-history.mjs`
- `coo/warranty/s0/aftership-notification-ownership.mjs`
- `coo/warranty/s0/evidence/notification-ownership-2026-08-08.json`

The authorized Tracking installation auto-synced one existing shipment. The readback itself created no additional public page, return, claim, message, label, refund, shipment, inventory or customer effect.
