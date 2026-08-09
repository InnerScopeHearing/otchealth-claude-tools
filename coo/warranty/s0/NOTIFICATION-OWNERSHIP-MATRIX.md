# Warranty and Return Notification Ownership Matrix

Status: launch-blocking draft. No notification is authorized by this matrix.

## Standing rule

No vendor default notification is trusted. Every return and warranty event requires an inventory row, approved template/version, customer-safe fields, recipient verification, deterministic send key, release authority, backup channel, claims-check status where applicable, and observed readback. Under solo-operator correction `cro__20260724-012-a418`, Matt is the only human; backup means a second independent notification channel and agent monitor, not another employee. Unknown, newly added or reset vendor events default to OFF and HOLD.

| Notification class | Configuration owner | Content owner | Release authority | Backup | Daily S0 evidence | Current status |
|---|---|---|---|---|---|---|
| Ordinary transactional receipt/status | Care Team admin 11167146 | COO/Care | COO | CTO independent channel monitors S0; no alternate human | toggle, copy hash, recipient/relationship check, send-key dedupe | OWNER ASSIGNED / SEND OFF UNTIL TESTS PASS |
| Return approved/in-progress/item received/resolved/canceled/reminder | Care Team admin 11167146 | COO/Care | COO | CTO independent channel monitors; no alternate human | each vendor event, copy, recipient, dedupe and suppression independently read back | OWNER ASSIGNED / SEND OFF UNTIL TESTS PASS |
| AfterShip Tracking pages/delivery notifications/marketing | CRO installed under Matt authorization; configuration monitored by CRO | COO/Care | COO if ever enabled | CTO independent channel monitors; no alternate human | Free 50 Monthly $0; auto-upgrade OFF; all Tracking notifications OFF/locked; tracking page unlaunched | INSTALLED / CONTAINED / SEND OFF |
| Rejection/adverse coverage | Care Team admin 11167146 | COO/Care drafts; CLO reviews | Matt only; no agent decision | Matt alerted through two independent channels | exact adverse copy, facts/evidence, correction and appeal path; release remains disabled | ROUTING ASSIGNED / LEGAL GATE OPEN / SEND OFF |
| Safety/stop-use | Care Team admin 11167146 | COO operational draft + CLO review | Matt only; COO+CLO monitor/escalate but cannot close | Matt alerted through two independent channels | exact copy, recipient, urgency, acknowledgment, reportability and human closure evidence | ROUTING ASSIGNED / SAFETY GATE OPEN / SEND OFF |
| Recall/bulk safety | Care Team admin 11167146 | COO operational draft + CLO review | Matt only; COO+CLO monitor/escalate but cannot close | Matt alerted through two independent channels | affected-population proof, lot/serial scope, dedupe, reportability and release evidence | ROUTING ASSIGNED / SAFETY-LEGAL GATES OPEN / SEND OFF |
| Refund/credit/financial | Care Team admin 11167146 | Finance + Care | Finance approver plus business approval | Finance backup unassigned | provider settlement status, exact amount and recipient | HOLD |
| Appeal acknowledgment/outcome | Care Team admin 11167146 | Independent Appeals Lead - unassigned | Appeals Lead; downstream effects re-enter separate gates | Alternate unassigned | different reviewer, decision version, cure/state-rights copy | HOLD |
| Wrong-recipient/bounce/suppression incident | CTO/Security | CTO/Security incident record; COO/Care supplies message context | CTO/Security owns incident; notify Matt | Matt alerted through two independent channels | block, suppress, alternate-channel, evidence preservation and incident receipt | OWNER ASSIGNED / INCIDENT TEST OPEN |
| Daily S0 alert | CRO | Deterministic probe | CRO owns daily action; CTO is independent-channel backup | CTO independent notification channel; no alternate human | probe JSON, evidence age, domain/runtime/Admin/dependency comparison | OWNER ASSIGNED |

## Daily S0 notification checks

1. Enumerate every enabled and disabled return/warranty event and every installed AfterShip Tracking page, delivery notification, marketing message and automation. Do not rely on prior screenshots or group summaries.
2. Compare the inventory to the signed release matrix. A new event, renamed event, reset toggle or unknown default is S0 HOLD.
3. Verify rejection/adverse notification remains OFF until copy/recipient tests pass and Matt alone releases after CLO review; no agent decides.
4. Verify Safety and recall notifications remain OFF until copy/recipient tests and substantive Safety/legal evidence pass; Matt alone releases, with COO+CLO monitoring/escalation but no agent closure.
5. Verify ordinary messages cannot send unless recipient, relationship, channel permission, language, template version, freshness and deterministic send key pass.
6. Verify bounce, suppression and wrong-recipient results block release and open the named incident route.
7. Record content/template hash and toggle state with the same daily timestamp as domain, policy and window readback.
8. If notification inventory cannot be read, the result is UNKNOWN, not PASS; keep publication and traffic on HOLD.

## Solo-operator correction and remaining closure

The seven requested notification routes are now assigned: CRO daily S0; CTO independent-channel backup; COO/Care ordinary content; COO ordinary release; Matt-only adverse authority with two-channel alert and CLO review; Matt-only Safety/recall authority with two-channel alert and COO+CLO monitoring/escalation; CTO/Security wrong-recipient incident ownership with two-channel Matt alert.

This assignment does not add employees and does not close substantive Safety, legal, staffing, Finance, Appeals, copy, recipient, carrier, facility or pilot gates. All actual outbound notifications remain disabled until the required copy, recipient/relationship, dedupe/suppression and event-level release tests pass.