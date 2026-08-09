# Warranty and Return Notification Ownership Matrix

Status: launch-blocking draft. No notification is authorized by this matrix.

## Standing rule

No vendor default notification is trusted. Every return and warranty event requires an inventory row, approved template/version, customer-safe fields, recipient verification, deterministic send key, release authority, backup, claims-check status where applicable, and observed readback. Unknown, newly added or reset vendor events default to OFF and HOLD.

| Notification class | Configuration owner | Content owner | Release authority | Backup | Daily S0 evidence | Current status |
|---|---|---|---|---|---|---|
| Ordinary transactional receipt/status | Care Team admin 11167146 | Care/Communications - unassigned | Warranty Operations Lead - unassigned | Unassigned | toggle, template hash, recipient check, send-key dedupe | HOLD |
| Return approved/in-progress/item received/resolved/canceled/reminder | Care Team admin 11167146 | Care/Communications - unassigned | Warranty Operations Lead - unassigned | Unassigned | each vendor event independently read back | HOLD |
| AfterShip Tracking pages/delivery notifications/marketing | Care Team admin 11167146 | Care/Communications - unassigned | Warranty Operations Lead - unassigned | Unassigned | Free 50 installed; notifications off/locked; tracking page unlaunched; auto-upgrade off; read back every event/page/automation | HOLD / INSTALLED OFF |
| Rejection/adverse coverage | Care Team admin 11167146 | Legal + Care - unassigned | Matt or signed delegate + Legal | Matt backup unassigned | toggle must remain OFF until signed adverse template and appeal path | HOLD |
| Safety/stop-use | Care Team admin 11167146 | Product Safety + Legal | Named Product Safety duty owner + Legal | Safety secondary unassigned | exact template, recipient, urgency and acknowledgment path | HOLD |
| Recall/bulk safety | Care Team admin 11167146 | Product Safety + Legal + Communications | Named Product Safety lead + Legal | Safety secondary unassigned | affected-population proof, lot/serial scope, dedupe and release token | HOLD |
| Refund/credit/financial | Care Team admin 11167146 | Finance + Care | Finance approver plus business approval | Finance backup unassigned | provider settlement status, exact amount and recipient | HOLD |
| Appeal acknowledgment/outcome | Care Team admin 11167146 | Independent Appeals Lead - unassigned | Appeals Lead; downstream effects re-enter separate gates | Alternate unassigned | different reviewer, decision version, cure/state-rights copy | HOLD |
| Wrong-recipient/bounce/suppression incident | Care Team admin 11167146 | Privacy + Communications | Incident owner - unassigned | Unassigned | block, suppress, alternate-channel and incident receipt | HOLD |
| Daily S0 alert | Warranty Operations Lead - unassigned | Deterministic probe | Warranty Operations Lead | Backup unassigned | probe JSON, evidence age, domain/runtime/Admin comparison | HOLD |

## Daily S0 notification checks

1. Enumerate every enabled and disabled return/warranty event plus every installed AfterShip Tracking page, delivery notification, marketing message and automation. Do not rely on prior screenshots or group summaries.
2. Compare the inventory to the signed release matrix. A new event, renamed event, reset toggle or unknown default is S0 HOLD.
3. Verify the rejection/adverse notification remains OFF until Matt/delegate + Legal sign exact template, evidence disclosure, correction and appeal path.
4. Verify Safety and recall events cannot release without Product Safety + Legal authority.
5. Verify ordinary messages cannot send unless recipient, relationship, channel permission, language, template version, freshness and deterministic send key pass.
6. Verify bounce, suppression and wrong-recipient results block release and open the named incident route.
7. Record content/template hash and toggle state with the same daily timestamp as domain, policy and window readback.
8. If notification inventory cannot be read, the result is UNKNOWN, not PASS; keep publication and traffic on HOLD.

## Required human closure

Matt must name the Warranty Operations primary/backup, Care/Communications content owner, ordinary release owner, Matt backup, Safety primary/secondary/duty rota, Finance backup, Appeals Lead/alternate, and Communications/Privacy incident owner. Each named person must accept the role and sign the event-level release matrix.