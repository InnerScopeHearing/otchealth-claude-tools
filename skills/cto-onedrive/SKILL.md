---
name: cto-onedrive
description: The CTO's three-folder OneDrive exchange with Matt (matthew@innd.com), the same process the CFO and CLO use, pointed at the CTO's own folders. CTO Outgoing (Matt drops files FOR the CTO, the CTO's inbox: API docs, vendor specs, architecture inputs, build artifacts), CTO Incoming (the CTO delivers work product FOR Matt), CTO Processed (the CTO's organized archive / technical data room). Use to pick up what Matt left, organize it into a data room, and deliver work back. A thin wrapper over the shared cfo-onedrive engine (full read/write/move/copy/dedupe across the whole drive); self-hydrates the Graph delegated creds. Non-PHI ring.
---

# cto-onedrive, the CTO's OneDrive exchange

The technical counterpart to the CFO and CLO OneDrive skills. Same engine, same verbs, same
delegated full-drive access, just pointed at the CTO's three exchange folders at the OneDrive root.

| Folder | Direction | Purpose |
|--------|-----------|---------|
| **CTO Outgoing** | Matt -> CTO | Matt drops files here for the CTO. The CTO's inbox (eBay/vendor API docs, specs, design inputs, artifacts). |
| **CTO Processed** | CTO archive | The CTO's organized archive / technical data room. |
| **CTO Incoming** | CTO -> Matt | The CTO delivers work product / writeups here for Matt. |

Mnemonic (from Matt's point of view): "Outgoing" = out from Matt to the CTO; "Incoming" = in to
Matt from the CTO; "Processed" = the CTO's done pile.

This is a thin wrapper over `skills/cfo-onedrive/onedrive.mjs` (the shared OneDrive engine). It sets
the engine's exchange-folder overrides to the CTO folders and self-hydrates the Graph app creds
(`GRAPH_MAIL_CLIENT_ID` / `_SECRET` / `_TENANT_ID`) from Secret Manager if they are not already in
the environment, so it runs in any session. All `<path>` arguments are relative to the OneDrive ROOT,
so the CTO can also operate anywhere on the drive.

## Commands

```
# Exchange with Matt
node skills/cto-onedrive/cto-onedrive.mjs inbox                      # list CTO Outgoing (what Matt left)
node skills/cto-onedrive/cto-onedrive.mjs process <name>             # MOVE CTO Outgoing/<name> -> CTO Processed
node skills/cto-onedrive/cto-onedrive.mjs deliver <localFile> [name]  # upload to CTO Incoming
node skills/cto-onedrive/cto-onedrive.mjs incoming-list | processed-list

# Full-drive primitives (any path from the OneDrive root)
node skills/cto-onedrive/cto-onedrive.mjs ls [path]                  # list a folder (default root)
node skills/cto-onedrive/cto-onedrive.mjs tree [path]                # recursive listing
node skills/cto-onedrive/cto-onedrive.mjs stat <path>               # size, content hash, ids
node skills/cto-onedrive/cto-onedrive.mjs mkdir <path>              # create folder (mkdir -p)
node skills/cto-onedrive/cto-onedrive.mjs mv <src> <destFolder> [newName]
node skills/cto-onedrive/cto-onedrive.mjs cp <src> <destFolder> [newName]
node skills/cto-onedrive/cto-onedrive.mjs rm <path>                  # delete (-> recycle bin, recoverable)
node skills/cto-onedrive/cto-onedrive.mjs upload <localFile> <destPath>
node skills/cto-onedrive/cto-onedrive.mjs download <path> [dir]
node skills/cto-onedrive/cto-onedrive.mjs catalog [path] [out.json]  # recursive inventory + dupe report
node skills/cto-onedrive/cto-onedrive.mjs find-dupes [path]
```

## Credentials (hydrated)
- `GRAPH_MAIL_CLIENT_ID` / `GRAPH_MAIL_CLIENT_SECRET` / `GRAPH_MAIL_TENANT_ID` (the Graph app; the
  wrapper self-hydrates these from Secret Manager if unset).
- `GCP_CLAUDE_DRIVER_SA_JSON` (reads/writes `graph-onedrive-refresh-token` in Secret Manager; the
  delegated refresh token auto-rotates and is persisted).

## Notes
- Delegated access (acts as Matt, `Files.ReadWrite` over his entire OneDrive); the tenant blocks
  app-only OneDrive, so this uses the stored, auto-rotating delegated refresh token, the same one the
  CFO/CLO skills use.
- Ring: non-PHI. Do not route PHI (MedReview/Companion patient data) through this exchange.
- To organize a drop into a data room, `process` each item into `CTO Processed/<topic>/...`, then the
  `doc-indexer` skill (generic profile) can index `CTO Processed` for cloud-search.
