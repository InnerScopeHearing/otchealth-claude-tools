# HEARTBEAT — the always-on hourly push (9-5 M-F) to Outlook, calendar, and your devices

## The honest architecture
The COO has two halves:
- **The brain = a Claude Code session.** Portable on web, desktop, and the iPhone 16 Pro
  (Claude Code runs on all three). You open it anywhere and say "CcOO"; it reads the
  committed `coo/` state and acts as your COO. But a session is **on-demand**, it does
  not run by itself when you're away.
- **The heartbeat = n8n.** n8n is always-on and already talks to **Outlook via the
  Graph API** (your existing workflows use it, no SMTP needed). It is what reaches you
  every hour even when no session is open.

Together they are an always-on COO: the brain decides, the heartbeat nags.

## The hourly workflow (to build in n8n)
Trigger: **Schedule, every hour, 09:00-17:00, Mon-Fri** (America/Los_Angeles).
Steps:
1. **Read today's directive.** Source of truth = a Notion page "COO - Today's Directive"
   that the COO session updates (mirrors `coo/today.md`). n8n reads it (Notion node).
2. **Compose the nudge:** the time, the one open Move (#1 first), the time it takes, and
   "report back when done." Pulls the open items from the directive.
3. **Push it** (parallel):
   - **Outlook email** (Graph API) to $RECIPIENT_EMAIL - subject "COO 2pm: Move 1 still
     open (the Friday email). 20 min. Go."
   - **Outlook calendar** - create/update a short event/reminder for the next hour with
     the move (this is what surfaces on the iPhone + Apple Watch via the Outlook/calendar
     notification).
   - Optional **SMS** (Twilio) for the 9am kickoff + a 4pm "what got done today?".
4. **Stop nagging when done:** if the directive shows all moves done, the hourly send
   becomes a single "nice work, here's tomorrow's #1" instead of a nag.

## The report-back loop
You reply in any Claude session: "CcOO, Move 1 done, sent to 5,000." The COO logs it to
`coo/log.md`, updates `coo/today.md` and the Notion directive page, and the next
heartbeat reflects it. (A future upgrade: an inbound Outlook/SMS webhook into n8n that
logs your reply automatically, so you can report by just replying to the email.)

## Why Outlook is the device fan-out
You're on Microsoft 365. An Outlook email + calendar event automatically notifies every
Apple device signed into that account, iPhone, Apple Watch, Mac/web, so n8n only has to
hit Outlook once and it reaches all your screens. No separate per-device integration.

## To activate (needs your go + a couple of specifics)
- Confirm: push channel(s) = email + calendar (+ SMS?), recipient = $RECIPIENT_EMAIL,
  window 9-5 M-F PT.
- Claude builds the n8n workflow (inactive) + the Notion "COO - Today's Directive" page;
  you review and flip it active.
- Note: n8n is on the Cloud Starter plan near its active-workflow cap, this may be the
  trigger to bump the plan or move the hourly job onto the Azure self-host.
