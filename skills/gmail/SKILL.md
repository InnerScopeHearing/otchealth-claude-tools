---
name: gmail
description: The CLO's Gmail retrieval skill for Matt's PERSONAL Gmail (Mattrmoore85@gmail.com). Search the mailbox, pull full messages, and DOWNLOAD ATTACHMENTS plus the raw .eml, so documents that exist only as a Gmail attachment (never saved to OneDrive) are reachable for the legal matters. Closes the gap the Gmail MCP leaves (it can search/read but cannot download attachment bytes). Read-only (gmail.readonly). Wielded by the CLO. CONFIDENTIAL + privileged: route exports into the legal store personal container or the CLO OneDrive folders only; never co-mingle with company records or commit contents to git. Non-PHI ring.
---

# gmail — pull Matt's personal Gmail emails + attachments (CLO)

Closes the gap: the Gmail MCP (`mcp__Gmail__search_threads` / `get_thread`) can search and read
but CANNOT download attachment binaries. This skill uses the Gmail API directly to pull full
messages, the raw `.eml`, and every attachment, so a document that lives only as a Gmail
attachment is reachable for the divorce / custody / criminal / civil matters.

## Commands
```
node skills/gmail/gmail.mjs consent                                # one-time: authorize Mattrmoore85 + store the refresh token
node skills/gmail/gmail.mjs search "<gmail query>" [--max 50]      # list messages (id | date | from | subject | #attachments)
node skills/gmail/gmail.mjs get <messageId>                        # headers + snippet + attachment list
node skills/gmail/gmail.mjs export <messageId> <dir>              # save <id>.eml (full RFC822) + extract all attachments
node skills/gmail/gmail.mjs pull "<gmail query>" <dir> [--max 200] # export every matching message into <dir>
```
Gmail query syntax works: `from:`, `to:`, `subject:`, `has:attachment`, `after:YYYY/MM/DD`,
`before:`, names in quotes, `OR`, `-` to exclude. Scope a `pull` per matter (the ex-wife's
name, opposing counsel, case numbers) rather than dumping everything.

## Setup (one-time, operator)
1. Create a Google **Desktop app** OAuth client (GCP console -> APIs & Services -> Credentials),
   enable the **Gmail API**, and add `Mattrmoore85@gmail.com` as a test user on the consent
   screen (scope `gmail.readonly`). Store the two values:
   `gmail-oauth-client-id`, `gmail-oauth-client-secret` (Secret Manager).
2. Run `node skills/gmail/gmail.mjs consent`, open the printed URL signed in as Mattrmoore85,
   approve, copy the redirected `http://localhost:4747/callback?code=...` URL, and run
   `node skills/gmail/gmail.mjs consent "<that URL>"`. The refresh token is stored as
   `gmail-refresh-token`. (Use `--user <name>` to add more accounts later.)

## Workflow for the CLO
1. `search` (or `get`) to find the relevant threads for a matter.
2. `export <id> <dir>` (or `pull "<query>" <dir>`) into a per-matter folder under the legal
   store personal area / `CLO Processed/Personal/<Matter>`.
3. Run the documents through the `pdf` OCR + the `legal` matter/docket store (the doc-intake
   loop): catalog, summarize, learn into the matter, docket any deadlines.

## Guardrails
- Read-only (`gmail.readonly`); never sends or deletes mail.
- Privileged + confidential: personal-matter contents stay in the `personal` store; never
  co-mingled with company systems, never committed to git, never shared into other agents.
- A large `pull` is bulk movement of your own data to your own store; scope it per matter.
