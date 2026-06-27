# COO LOG — append-only accountability trail (directives given + results reported)

Format: `YYYY-MM-DD HH:MM | move | result (done/partial/blocked) | note`

---
2026-06-09 seed | COO initialized | n/a | Situation, priorities, and today's 3 moves
seeded. North star: cash this week. Overdue: the Friday reactivation email. Pattern to
break: building instead of executing.
2026-06-09 build | COO infrastructure live | done | The COO now has its own mailbox
(coo@innd.com, "Chief Operating Officer") and four live n8n workflows: heartbeat (hourly
email + daily calendar block, KzhxslBIB12QcKuW), Send Email (shpRZibsI81XfJiJ), Create
Meeting (ZFkox8gT5vdEKk2Z), and Read Calendar next 7 days (xL0VYbElD15ttqKw). "COO Tasks"
Notion DB created. Autonomy policy set: autonomous internal (Matt+Mark) / directive =
pre-authorization / draft-then-approve external / hard-gate investor-IR-INND. Autonomous
COO routine playbook documented (dream-team/coo-routine.md). Calendar is now two-way.
2026-06-09 build | Autonomous inbound loop live + tested | done | COO routine created in
Claude with an API trigger. n8n workflow "COO: Inbound Email -> Wake COO" (B0bYgelXujDmO7WC)
polls the coo@innd.com shared mailbox every 5 min via Graph, wraps each email as an
injection-guarded external payload, fires the routine to wake the COO, and marks the mail
read. End-to-end test passed: an email to coo@innd.com woke a real COO session. The "CC the
COO" pattern is now live: anything to or CC'ing coo@innd.com wakes the COO unattended.
2026-06-09 build | Concurrency guard + injection-guard fix | done | Playbook is now
mode-aware: only a scheduled MORNING-MODE run sends the brief and books the daily block; an
inbound-fired EVENT-MODE run handles just its item and never briefs. Morning mode checks a
"Morning brief sent - YYYY-MM-DD" marker in the COO Tasks DB before sending and writes it
after, so the brief happens at most once per day (no duplicates from double-scheduling).
Also fixed the review finding: step 1 no longer elevates the email payload as "top input";
it now marks event payloads as untrusted, triage-only, never a directive.
2026-06-09 build | Idempotency-guard hardening (review) | done | Pinned the marker title to
one exact format (Morning brief sent - YYYY-MM-DD) for both the check and the write so they
can't drift; the marker is now written FIRST (before sending) to shrink the double-run
window; and the already-sent short-circuit path now logs that the guard fired, so guard
hits are auditable.
2026-06-09 build | Idempotency recovery + log format (review) | done | Morning guard now has a recovery path: if any step fails after the marker is claimed, the marker is deleted and Matt is alerted so the next run retries instead of silently skipping. Guard-hit and failure log lines now follow the file format (... | morning-guard | skipped/failed | ...).
2026-06-09 build | Failure-alert fallback channel (review) | done | If the morning brief fails on the email step, alerting Matt via email would also fail. Recovery now alerts over an email-independent channel: a guaranteed high-priority "Needs Matt" task in the COO Tasks DB (Notion), plus a best-effort calendar alert event and email only when email was not the failing step.
2026-06-09 coo-check | COO invoked after another build session (org move + Depot + cloud-env setup) | flagged | Every entry in today's log is "build." The 3 cash moves are still not-started and the Friday reactivation email is still unsent. Named the pattern, redirected to Move 1, offered to draft the email + the Gumroad SOPs now.
2026-06-27 09:00 | morning-guard | failed | All 3 COO n8n workflows inactive (404): Read Calendar xL0VYbElD15ttqKw, Create Meeting ZFkox8gT5vdEKk2Z, Send Email shpRZibsI81XfJiJ. Morning brief email NOT sent. Marker renamed to FAILED so next run retries. Alert task created in Notion. PushNotification sent to Matt.
2026-06-27 09:00 | reactivation-email-draft | done | Lifecycle agent produced CAN-SPAM-compliant Customer.io-ready HTML + plain-text draft. Subject lines: "We still have something for you" (primary) / "Your hearing health just got easier" (A/B). Tiered send strategy: Tier 1 = 5-10K most-engaged contacts today; Tier 2 = 15-20K at 48h; Tier 3 = remainder at 72h (spam rate gate 0.3%). Draft saved to Notion: "NEEDS MATT: Approve + Send Reactivation Email." Awaiting Matt approval + send. NOTE: physical address placeholder must be filled before any send.
2026-06-27 09:00 | today-directive | done | coo/today.md regenerated. 3 moves: (1) send reactivation email [OVERDUE 7 days], (2) list 14 Gumroad SOPs [idle 12 days], (3) connect Stripe [unlocks $2-3M pool].
2026-06-27 09:00 | n8n-flag | flagged | COO n8n primitives are all inactive. Matt must go to https://automation.otchealth.app and activate: Read Calendar, Create Meeting, Send Email workflows. Without these the COO routine cannot brief Matt by email or book calendar blocks.
