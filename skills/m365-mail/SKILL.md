---
name: m365-mail
description: Mine the InnerScope Microsoft 365 tenant's mailboxes (app-only Graph) for accounting source documents (invoices, statements, receipts, 1099s) to rebuild the 2021+ financials. Read-only. Wielded by the CFO / finance agent. Scope to the FINANCE mailboxes; drive the search by the QuickBooks vendor list, then a keyword gap-sweep. Stage every hit in the CFO Ledger and save attachments to the source-doc store. Non-PHI ring; exclude personal/medical content from the books.
---

# M365 mail mining (CFO source-doc recovery)

The CFO's tool to recover years of accounting source documents from company email, the
backbone of the 2021+ reconstruction. App-only Microsoft Graph against the InnerScope email
tenant (`9acb23d0-...`), which holds ~14 domains (innd.com, hearingassist.com, iheardirect.com,
otchealthmart.com, ...).

## Strategy (do it in this order, not brute-force)
1. **Scope to the ~15 FINANCE mailboxes**, not all 125 accounts:
   - Accountants: `bmehta@innd.com` (Beena/"Bina"), `monica@innd.com` (Monica), `dqualset@innd.com`
     (Doug, disabled but mailbox readable), `Norm@innd.com` (Norm, disabled but readable).
   - Shared: `accounting@hearingassist.com`, `billing@hearingassist.com`, `ap@innd.com`,
     `AP-HearingAssist@innd.com`, `payroll@innd.com`.
   - Execs: `matthew@innd.com`, `kim@innd.com`, `mark@innd.com`. Plus `corp@`, `office@`, `info@innd.com`.
2. **QBO vendor list first** (the targeting backbone): pull the vendor list + chart of accounts
   from QuickBooks, then `search` each finance mailbox for each vendor (Jan 2021+, with attachments).
3. **Keyword gap-sweep** for vendors not in QBO: search `invoice`, `statement`, `receipt`, `1099`,
   `purchase order`, `remittance` across the finance mailboxes.
4. **Save:** stage each hit in the Notion CFO Ledger (vendor, amount, date, entity, link); download
   attachments and store them in the SharePoint/OneDrive "CFO Source Docs" library (entity/vendor/year).
5. Dedup + reconcile against the books.

## Credentials (Secret Manager -> env, hydrated each session)
- `GRAPH_MAIL_CLIENT_ID`, `GRAPH_MAIL_CLIENT_SECRET`, `GRAPH_MAIL_TENANT_ID`
  (`graph-mail-client-id` / `-client-secret` / `-tenant-id`). App = `otchealth-cto-graph-admin`.

## Commands
```
node skills/m365-mail/m365-mail.mjs users [substr]                      # list/inventory mailboxes
node skills/m365-mail/m365-mail.mjs search <mailbox> "<terms>" [top]    # $search subject+body+attachments
node skills/m365-mail/m365-mail.mjs since <mailbox> <YYYY-MM-DD> [top]  # msgs with attachments since a date
node skills/m365-mail/m365-mail.mjs attachments <mailbox> <messageId> <dir>  # download attachments
```

## Guardrails (HARD)
- **Read-only.** This skill never sends or writes mail. Mining only.
- **Scope to financial content + entities.** Only accounting source docs enter the books; exclude
  personal, medical, and PHI content (the exec/personal mailboxes will contain it).
- **Stage, then post.** Hits go to the CFO Ledger for review; nothing posts to the books unreviewed.
- **Source-of-truth + non-PHI ring.** Every booked entry ties to a stored source doc.

## SECURITY NOTE (rotate-later, accepted risk 2026-06-16)
The underlying app (`otchealth-cto-graph-admin`) is currently OVER-PRIVILEGED, its token carries
~400 Graph application permissions (incl. Mail.ReadWrite, User.ReadWrite.All, Domain.ReadWrite.All,
policy/role write) = near-global tenant admin, and the secret was exposed in chat. Matt accepted the
risk to keep moving. REMEDIATE before launch: rotate the secret and trim to least-privilege
(`Mail.Read` + `User.Read.All` + `Files.Read.All`). This skill only needs those three reads.
