<!-- COO morning-brief idempotency marker (replaces the old Notion "Morning brief sent" task).
The MORNING MODE routine writes today's date (YYYY-MM-DD) here when it claims the day before
sending the brief, and CLEARS this file (back to this note) if a post-claim step fails, so the
next run retries instead of silently skipping. If this file contains today's date, the brief
already went out today. See dream-team/coo-routine.md step 5. -->
