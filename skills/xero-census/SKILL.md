---
name: xero-census
description: Size the phantom-duplicate population in a Xero org without paging millions of bytes. Groups objects by Reference and reports (Reference, count, objectIDs, statuses, UpdatedDateUTC, write-day clusters), so the CFO lane can measure duplication across a full year and both orgs instead of one hand-censused month. READ-ONLY; never writes, voids or deletes. Built for the 2026-08-14 multi-write incident (113 objects representing 25 bills in one month; 13 bills as FOUR objects each).
---

# xero-census

Read-only duplicate census for a Xero org.

```
node skills/xero-census/census.mjs --org hearingassist --type ACCPAY --from 2022-01-01 --to 2022-12-31
node skills/xero-census/census.mjs --org innd --collection CreditNotes --type ACCPAYCREDIT --from 2022-01-01 --to 2022-12-31 --out innd-cn-2022.json
```

Reports objects read, distinct references, groups at or above `--min-count` (default 2, i.e.
duplicates only), the phantom-duplicate count, and the distinct **write days** per group. Two
UpdatedDateUTC clusters on one reference is the signature of a re-write wave.

Auth is the gateway `cfo` lane, so no Xero token is needed locally. Collections supported:
`Invoices`, `BankTransactions`, `CreditNotes`, `ManualJournals`.

Removal is NOT implemented here on purpose. It runs under the CFO's approved control: reverse,
never void, with readback on every object.
