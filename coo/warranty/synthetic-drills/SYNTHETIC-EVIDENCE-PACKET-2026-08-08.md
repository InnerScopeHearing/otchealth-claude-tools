# OTCHealth Warranty Operations Synthetic Evidence Packet

Prepared: 2026-08-08
Scope: offline synthetic and tabletop evidence only
Decision: HOLD / NO-GO unchanged

## Executive result

- Local deterministic drills: 14/14 PASS with 58 assertions.
- Fresh n8n synthetic contract executions: 6/6 PASS.
- Test wrapper: 6/6 PASS.
- Offline guard: PASS. No network or credential-bearing code path in the drill runner.
- Real customer records used: 0.
- Customer contacts, provider calls, labels, shipments, refunds/credits, inventory changes, repair orders, canonical writes, consumed authorizations, and real kill-switch changes: 0.
- Pilot and public launch remain HOLD. Synthetic evidence cannot supply names, signatures, facilities, contracts, carrier acceptance, physical custody, human competency, accessibility observation, real cohort results, or financial closes.

## Immutable receipts

- Synthetic report SHA-256: 448bab7cf1ed85d39cefac3d355b25750a667169fbaf4e55b28bea17671d3019
- Fixture SHA-256: 4adef814fa2c21811e237c64985a2c1f75d5f88581cca282f1d2ac32c8b95ba6
- Runner SHA-256: 14fd881bd95aa726edc915e550a3a4fae9f34b035e3f77a9098451c155cfb2e6
- n8n executions: WTY-00 48337; WTY-01 48336; WTY-02 48333; WTY-03 48334; WTY-04 48335; WTY-05 48332

## Executed drill inventory

| Drill | Synthetic result | What was proven | What remains unproven |
|---|---|---|---|
| care_intake | PASS_SYNTHETIC | Safety-first routing; missing-proof non-denial; opaque provisional references; cross-channel duplicate reconciliation; zero external/customer effects | live Care channel receipt; staff response time; named warranty operator availability; Intercom ticket creation |
| safety_phmsa_tabletop | PASS_TABLETOP_ONLY | Safety leakage is blocked; ordinary parcel/air labels are blocked; damaged-lithium scenarios require PHMSA/carrier human path; reportability and closure remain human | named 24/7 duty roster; approved stop-use words; actual PHMSA classification; carrier acceptance; lot/serial hold execution; chain of custody; live page or acknowledgment time |
| manual_fallback | PASS_SYNTHETIC | honest degraded copy; manual reference generation; Safety availability; original-time preservation; duplicate reconciliation | real independent phone/email continuity; secure paper/manual custody; human back-entry execution; live restore and reconciliation |
| queue_owner_mapping | PASS_MAPPING_ONLY | deterministic role routing map; existing versus proposed queue distinction; zero object creation | named primaries/backups; queue creation; staff availability; capacity or SLA |
| training | PASS_AGENT_RULEBOOK_ONLY | training curriculum scenarios and expected answers are internally consistent | named human attendance; knowledge retention; signed competency; supervised performance; recertification |
| notifications | PASS_SYNTHETIC | recipient and suppression blocking; deterministic dedupe; high-risk human release; zero sends | approved templates; named release owner; actual provider configuration; remaining AfterShip email toggles disabled; live bounce/wrong-recipient behavior |
| kill_switches | PASS_TABLETOP_ONLY | all 11 required switch semantics; safe reads and records preserved; manual fallback and Safety continuity; resume evidence requirements | real server-side switch implementation; named incident owner; in-flight command reconciliation; live degraded copy; actual restore/resume |
| policy_authority | PASS_TABLETOP_ONLY | unapproved remedy rules block; missing fee matrix blocks; unapproved replacement/successor terms block; missing authority blocks; no values invented | counsel-approved terms; Finance responsibility matrix; Matt/delegate signatures; state timing overlays; actual route cost |
| authority_gap_validator | PASS_GAP_DETECTION_ONLY | required role registry; null/unsigned fail-closed validation; no synthetic owner substitution | real names; availability; delegation acceptance; signatures; threshold approval |
| physical_operations_tabletop | PASS_TABLETOP_ONLY | no label without carrier/location; hazardous return blocks ordinary lane; mismatch routes to quarantine/human exception; repair outage triggers alternate review; California invoice uncertainty blocks | real return facility; carrier account/service; PHMSA classification/acceptance; quarantine space/scanners; providers/contracts/parts/capacity/QA/invoice notice |
| accessibility_requirements | PASS_REQUIREMENTS_COVERAGE_ONLY | required digital and assisted paths are enumerated; synthetic execution refuses to claim WCAG or assisted-channel proof | keyboard/screen-reader behavior; reflow/zoom/contrast/focus/errors; tagged PDF; observed phone/email/mail/relay/caregiver completion |
| serial_ownership | PASS_SYNTHETIC | missing serial is not denial; gift privacy/dates; ownership overlap blocks; successor lineage modeled; receiving mismatch quarantines not denies | real OEM/box/left/right source map; scanner/device capability; real owner proof; pick/pack/tender/return/inspection traces; approved successor term |
| pilot_entry | PASS_ENTRY_BLOCKER_CHECKLIST | complete entry-gate checklist; unsigned gate blocks; agent cannot sign or start pilot | signed entry gates; approved caps; employee cohort; real cohort; two operating/Finance closes; actual halt/recovery drills |
| reconciliation | PASS_SYNTHETIC | exception taxonomy; role ownership map; no automatic repair/overwrite/retry; reconciliation cadence checklist | live source access; actual exception detection; provider/GL reconciliation; two close cycles |

## Agent-executable versus irreducible evidence matrix

| Launch gate | Classification | Agent/tabletop evidence executed now | Result | Irreducible human or physical evidence |
|---|---|---|---|---|
| Remedy ladder and state timing | HYBRID | Fail-closed remedy/state scenarios executed. | PASS_TABLETOP_ONLY | Counsel-approved rules, state timing, named operational acceptance. |
| Fees, labor, freight, packaging, tax, shipping | HYBRID | Missing fee/responsibility matrix correctly blocks action and promise. | PASS_TABLETOP_ONLY | Counsel/Finance signatures, provider and carrier prices, actual invoices. |
| Replacement condition and successor term | HYBRID | Replacement/lineage scenarios execute without inventing condition or term. | PASS_TABLETOP_ONLY | Counsel-approved new/refurb/equivalent disclosure and successor term. |
| AI/human authority | HYBRID | Authority-floor, prohibited-action, null-owner and unsigned-role validators executed. | PASS_DESIGN_AND_GAP_VALIDATION | Signed role/action matrix, exact delegates and thresholds. |
| Matt backup and thresholds | HUMAN_ONLY | Required-role validator refuses synthetic owner substitution. | PASS_GAP_DETECTION_ONLY | Matt names and signs backup and limits. |
| Carrier and return location | PHYSICAL_EXTERNAL | No-location/no-carrier and hazardous-route cases fail closed. | PASS_TABLETOP_ONLY | Real facility, carrier account, rates, service, tender/delivery/check-in. |
| Warehouse/quarantine/inspection/disposition | HYBRID_PHYSICAL | Mismatch/quarantine/disposition cases fail closed. | PASS_TABLETOP_ONLY | Controlled space, trained people, actual scans, unit custody, disposition. |
| Repair network and capacity | PHYSICAL_EXTERNAL | Primary-unavailable and invoice uncertainty cases route to human alternate review. | PASS_TABLETOP_ONLY | Providers/contracts/parts/capacity/QA/invoice notice/failover proof. |
| 24/7 Safety/recall/hazardous return | HYBRID_HUMAN_PHYSICAL | Safety/PHMSA fail-closed tabletop executed. | PASS_TABLETOP_ONLY | Roster, approved scripts/reportability, PHMSA classification, carrier acceptance, hold execution, custody, live drill. |
| Staffing/queues/capacity/earned SLA | HYBRID_HUMAN | Queue/role mapping and required-role gap validation executed. | PASS_MAPPING_AND_GAP_VALIDATION | Named primaries/backups, schedules, measured volume/handle time and capacity. |
| Manual fallback | HYBRID | Outage/reference/back-entry/duplicate drill executed. | PASS_SYNTHETIC | Independent live channels, secure custody, human back-entry, restore drill. |
| Training | HYBRID_HUMAN | 12-scenario curriculum/answer key executed. | PASS_AGENT_RULEBOOK_ONLY | Human attendance, knowledge check, observed performance, signed competency. |
| Notification ownership | HYBRID_HUMAN | Recipient/class/dedupe/release checks executed with zero sends. | PASS_SYNTHETIC | Approved templates, named release owner, vendor toggles, live provider tests. |
| Care queues and Intercom objects | HYBRID | Existing/proposed queue map and synthetic routing executed. | PASS_MAPPING_ONLY | Approved object creation, named staffing, live handoff and stale-data tests. |
| WCAG 2.2 AA and assisted completion | HYBRID_HUMAN | All required digital/assisted paths enumerated; runner refuses synthetic closure. | PASS_REQUIREMENTS_COVERAGE_ONLY | Manual assistive-tech audit and observed phone/email/mail/relay/caregiver completion. |
| Serial/ownership/fulfillment scans | HYBRID_PHYSICAL | Six missing/duplicate/gift/overlap/successor/mismatch scenarios executed. | PASS_SYNTHETIC | Real source map, scanners, units, pick/pack/tender/return/inspection traces. |
| Controlled pilot and two closes | HUMAN_PHYSICAL_LIVE | 12-gate entry validator, halt rules and reconciliation checklist executed. | PASS_ENTRY_BLOCKER_CHECKLIST | Signed entry gates, employee/real cohort, actual operations/Finance cycles and signatures. |

## Fresh n8n synthetic receipts

| Code | Execution | Outcome | External calls | Authorization consumed | Customer contact | Live execution |
|---|---:|---|---:|---|---|---|
| WTY-00 | 48337 | ROUTED_TO_DRAFT_ONLY | 0 | false | false | false |
| WTY-01 | 48336 | INTERCOM_ACTION_DRAFT_ONLY | 0 | false | false | false |
| WTY-02 | 48333 | MESSAGE_DRAFT_ONLY | 0 | false | false | false |
| WTY-03 | 48334 | OPERATIONS_ACTION_DRAFT_ONLY | 0 | false | false | false |
| WTY-04 | 48335 | PROVIDER_OBSERVATION_DRAFT_ONLY | 0 | false | false | false |
| WTY-05 | 48332 | RECONCILIATION_EXCEPTION_DRAFT_ONLY | 0 | false | false | false |

## Safety / PHMSA source-backed tabletop rule

- PHMSA regulates lithium batteries as hazardous material under 49 CFR Parts 171-180 and identifies damaged, defective or recalled batteries as higher fire-risk shipments: https://www.phmsa.dot.gov/lithiumbatteries
- PHMSA's 2024 shipper guide states DDR lithium batteries may travel only by highway, rail or vessel and are strictly forbidden by aircraft; 49 CFR 173.185(f) packaging and full training/shipping-paper/marking/labeling requirements apply: https://www.phmsa.dot.gov/sites/phmsa.dot.gov/files/2024-11/Lithium-Battery-Guide-2024.pdf
- PHMSA states the shipper is responsible for condition assessment and may need a technical expert or manufacturer information: https://www.phmsa.dot.gov/sites/phmsa.dot.gov/files/2023-03/DDR-brochure.pdf
- USPS Publication 52 generally prohibits damaged, defective or recalled batteries absent Product Classification approval, restricts used/damaged/defective devices to applicable surface paths domestically, and prohibits such batteries/devices internationally: https://pe.usps.com/text/pub52/pub52c3_028.htm
- Tabletop decision: every suspected DDR case blocks ordinary return, ordinary parcel/air label, returnless handling, destructive customer instruction and agent closure. Only a trained human may classify, package, select a compliant carrier service, offer for transport, execute holds or close Safety. Full research-backed tabletop: PHMSA-TABLETOP-EVIDENCE.md.

## Irreducible signatures and observations still required

1. Matt must name and sign the backup/delegate, exact decision and execution thresholds, unavailable-owner behavior, vetoes, expiry and revocation.
2. Counsel, Finance and Operations must sign the remedy ladder, state timing, fees/labor/freight responsibility, replacement condition and successor term.
3. Product Safety must name the primary, secondary and duty rota; approve scripts and reportability/recall rules; prove lot/serial holds, chain of custody, PHMSA classification, carrier acceptance and a live tabletop with acknowledgments.
4. Operations and Warehouse must identify the real return facility and backup, carrier accounts/services, quarantine area, scanners, inspection/sanitation/disposition process and an observed physical package trace.
5. Repair must provide primary and backup providers, agreements, parts, capacity, turnaround, QA, California invoice notice handling and an observed failover.
6. Care and Communications must name queue owners and backups, create only approved objects, train people, approve templates, disable or gate remaining AfterShip emails, and observe live recipient/bounce/suppression behavior without using customers.
7. Accessibility must complete manual WCAG 2.2 AA and assistive-technology review plus observed phone, email, mail, relay and caregiver completion.
8. Inventory/platform owners must prove the real assembly/left/right/box/OEM map, ownership proof, scanner capability and pick/pack/tender/return/inspection/successor traces.
9. Pilot owners must sign all entry gates and caps, run an employee cohort, then a separately approved small real cohort, drill every kill switch and complete two reconciled operating and Finance/GL cycles with zero unresolved stop-ship defect.

## Interpretation rule

A synthetic PASS means the agent-side logic, checklist or fail-closed decision behaved correctly with synthetic data. It never means the corresponding operational launch gate is closed. Only the named signatures, physical observations, external-provider evidence, controlled pilot and reconciled cycles can close those gates.
