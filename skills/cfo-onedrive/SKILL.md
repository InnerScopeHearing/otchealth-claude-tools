---
name: cfo-onedrive
description: The CFO's control of Matt's OneDrive (matthew@innd.com). Full read/write/move/copy/dedupe across his WHOLE drive, plus the three-folder exchange at the root, CFO Outgoing (Matt drops files FOR the CFO), CFO Processed (the CFO's organized archive / audit data room), CFO Incoming (CFO delivers work product FOR Matt). Use to pick up what Matt left, build a per-company per-category audit data room, move/copy/dedupe files, and deliver financials back. Delegated access (acts as Matt, Files.ReadWrite over his entire OneDrive); the tenant blocks app-only OneDrive so this uses a stored, auto-rotating delegated refresh token. Non-PHI ring.
---

# CFO OneDrive control

The CFO is the controlling party for Matt's OneDrive: full read/write/move/copy/dedupe across the
whole drive, plus the exchange folders at the root.

| Folder | Direction | Meaning |
|--------|-----------|---------|
| **CFO Outgoing** | Matt -> CFO | Matt drops files here for the CFO. The CFO's inbox. |
| **CFO Processed** | CFO archive | The CFO's organized archive / audit data room. |
| **CFO Incoming** | CFO -> Matt | The CFO delivers financials / work product here for Matt. |

Mnemonic (from Matt's point of view): "Outgoing" = out from Matt to the CFO; "Incoming" = in to
Matt from the CFO; "Processed" = the CFO's done pile.

## Access scope
DELEGATED token (`graph-onedrive-refresh-token`), acts AS Matt, scoped to `Files.ReadWrite` =
**full access to Matt's entire OneDrive**, not just the three folders. (The tenant blocks app-only
OneDrive with 503, so delegated is the compliant path.) The token rotates on every use and is
auto-persisted to Secret Manager. All `<path>` arguments are relative to the OneDrive ROOT, so the
CFO can operate anywhere (e.g. `"CFO Processed/OTCHealth/Bank Statements"`, `"Documents/..."`).

## Credentials (hydrated)
- `GRAPH_MAIL_CLIENT_ID` / `GRAPH_MAIL_CLIENT_SECRET` / `GRAPH_MAIL_TENANT_ID` (the app)
- `GCP_CLAUDE_DRIVER_SA_JSON` (reads/writes `graph-onedrive-refresh-token` in Secret Manager)
- Exchange-folder overrides: `CFO_OUTGOING_FOLDER` / `CFO_INCOMING_FOLDER` / `CFO_PROCESSED_FOLDER`.

## Commands
```
# Exchange with Matt
node skills/cfo-onedrive/onedrive.mjs inbox                       # list CFO Outgoing
node skills/cfo-onedrive/onedrive.mjs process <name>             # MOVE CFO Outgoing/<name> -> CFO Processed
node skills/cfo-onedrive/onedrive.mjs deliver <localFile> [name]  # upload to CFO Incoming
node skills/cfo-onedrive/onedrive.mjs incoming-list | processed-list

# Full-drive primitives (any path from the OneDrive root)
node skills/cfo-onedrive/onedrive.mjs ls [path]                   # list a folder (default root)
node skills/cfo-onedrive/onedrive.mjs tree [path]                 # recursive listing
node skills/cfo-onedrive/onedrive.mjs stat <path>                 # size, content hash, ids
node skills/cfo-onedrive/onedrive.mjs mkdir <path>               # create folder (mkdir -p)
node skills/cfo-onedrive/onedrive.mjs mv <src> <destFolder> [newName]   # move (dest auto-created)
node skills/cfo-onedrive/onedrive.mjs cp <src> <destFolder> [newName]   # copy/duplicate (async)
node skills/cfo-onedrive/onedrive.mjs rm <path>                   # delete (-> recycle bin, recoverable)
node skills/cfo-onedrive/onedrive.mjs upload <localFile> <destPath>     # upload to any path
node skills/cfo-onedrive/onedrive.mjs download <path> [dir]       # download any file
node skills/cfo-onedrive/onedrive.mjs catalog [path] [out.json]   # recursive inventory + dupe report
node skills/cfo-onedrive/onedrive.mjs find-dupes [path]           # byte-identical files (same hash)
node skills/cfo-onedrive/onedrive.mjs version-report [path] [out.md]  # exact dups + draft-vs-final version clusters + a move plan (REPORT ONLY)
node skills/cfo-onedrive/onedrive.mjs dataroom-init [parent]      # scaffold per-company + _Duplicates
```

`version-report` is the data-room hygiene tool: it flags both byte-identical duplicates AND
draft-vs-final version clusters (same document at different versions, matched by a
version-agnostic name key), picks the likely current one (final/executed in name, else
newest, else largest), and prints a recoverable move plan into a `_Superseded` folder. It
NEVER moves or deletes anything itself; a human confirms each cluster, then runs the printed
`mv` commands. Works for both the CFO audit data room and the CLO matter archive.

## Building the audit data room (the CFO's workflow)
1. `inbox` to see what Matt dropped; `catalog "CFO Outgoing" outgoing.json` for a full inventory
   with content hashes.
2. `dataroom-init` to scaffold `CFO Processed/Audit Data Room/<Company>/` for OTCHealth, InnerScope,
   Hearing Assist, Personal, plus a `_Duplicates` folder. Adjust company names as needed.
3. Add category subfolders per company, OTCHealth first, e.g.
   `mkdir "CFO Processed/Audit Data Room/OTCHealth/Bank Statements"` (Invoices, Bills, Receipts,
   Tax/1099s, Payroll, Contracts, Corporate, Financial Statements, Other).
4. `mv "CFO Outgoing/<file>" "CFO Processed/Audit Data Room/<Company>/<Category>"` to file each doc.
5. `find-dupes "CFO Processed"` then `mv` byte-identical extras into the `_Duplicates` folder
   (dedupe by MOVE, never delete, so nothing is lost).
6. `catalog "CFO Processed/Audit Data Room" data-room-catalog.json` for the final index, and
   `deliver` it (or a summary) to Matt via CFO Incoming.

## Guardrails
- Non-PHI ring only. Never place MedReview / PHI data in OneDrive.
- The token acts AS Matt across his whole OneDrive; it is sensitive (on the rotate-before-launch list).
- INND material is internal-only (securities firewall): do not surface document CONTENTS externally
  or commit raw financials to any git repo. The GCS `cfo-store` bucket is the durable bulk archive;
  OneDrive is the human-facing working data room.
- `rm` sends to the recycle bin (recoverable), but prefer `mv` to `_Duplicates` for dedupe.
