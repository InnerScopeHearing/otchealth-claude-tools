---
name: cfo-onedrive
description: The CFO's file exchange with Matt over his OneDrive (matthew@innd.com). Three folders at the OneDrive root, CFO Outgoing (Matt drops files here FOR the CFO), CFO Processed (CFO MOVES items here after handling them, her owned archive), CFO Incoming (CFO delivers work product here FOR Matt). Use to pick up what Matt left, process it, and deliver financials/work product back. Delegated access (acts as Matt, Files.ReadWrite); the tenant blocks app-only OneDrive so this uses a stored, auto-rotating delegated refresh token. Non-PHI ring.
---

# CFO <-> Matt OneDrive exchange

The CFO's drop-box protocol with Matt, on his OneDrive. Three root folders:

| Folder | Direction | Meaning |
|--------|-----------|---------|
| **CFO Outgoing** | Matt -> CFO | Matt drops files here for the CFO to review/process. The CFO's inbox. |
| **CFO Processed** | CFO archive | After the CFO handles an item from Outgoing, she MOVES it here. Her owned, organized archive of everything worked. |
| **CFO Incoming** | CFO -> Matt | The CFO delivers financials / work product here for Matt. |

Mnemonic: the names are from Matt's point of view. "Outgoing" = going out from Matt to the CFO;
"Incoming" = coming in to Matt from the CFO; "Processed" = the CFO's done pile.

## Why delegated (not app-only)
The InnerScope tenant BLOCKS app-only OneDrive access (returns 503 even with Files.ReadWrite.All
granted). So this skill uses a DELEGATED refresh token (`graph-onedrive-refresh-token`) and acts
AS Matt, scoped to `Files.ReadWrite`. The token rotates on every use and is auto-persisted back to
Secret Manager, so it does not silently expire.

## Credentials (hydrated)
- `GRAPH_MAIL_CLIENT_ID` / `GRAPH_MAIL_CLIENT_SECRET` / `GRAPH_MAIL_TENANT_ID` (the app)
- `GCP_CLAUDE_DRIVER_SA_JSON` (reads/writes `graph-onedrive-refresh-token` in Secret Manager)
- Folder names override via `CFO_OUTGOING_FOLDER` / `CFO_INCOMING_FOLDER` / `CFO_PROCESSED_FOLDER`
  (default "CFO Outgoing" / "CFO Incoming" / "CFO Processed").

## Commands
```
node skills/cfo-onedrive/onedrive.mjs inbox                      # list CFO Outgoing (what Matt left for you)
node skills/cfo-onedrive/onedrive.mjs pull <name> [localDir]     # download a file from CFO Outgoing
node skills/cfo-onedrive/onedrive.mjs process <name>            # MOVE a file CFO Outgoing -> CFO Processed
node skills/cfo-onedrive/onedrive.mjs deliver <localFile> [name] # upload work product to CFO Incoming
node skills/cfo-onedrive/onedrive.mjs incoming-list | processed-list
```

## The loop the CFO runs
1. `inbox` to see what Matt dropped in CFO Outgoing.
2. `pull <name>` to download and work it.
3. When done, `process <name>` to MOVE it to CFO Processed (so Outgoing only ever holds un-handled
   items, and Processed is the organized record of everything worked).
4. `deliver <file>` to put financials / work product into CFO Incoming for Matt.

## Guardrails
- Non-PHI ring only. Never place MedReview / PHI data here.
- The token acts AS Matt on his OneDrive; treat it as sensitive (it is on the rotate list).
- Large source-doc datasets (full QBO/Xero exports) belong in the GCS `cfo-store` bucket, not
  OneDrive; OneDrive is for the working exchange with Matt (requests + deliverables + reviewed docs).
