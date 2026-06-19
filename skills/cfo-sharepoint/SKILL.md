---
name: cfo-sharepoint
description: Read SharePoint sites and document libraries (app-only Microsoft Graph) so the CFO can reach finance source docs that live on Team sites, e.g. the InnerScope WF account 9145 bank statements on the FinanceTeam site, which the personal-OneDrive-only cfo-onedrive skill cannot reach. READ-ONLY (Sites.Read.All application). List sites, list document libraries, browse + download folders/files; the CFO routes them into the Azure Blob data room. Wielded by the CFO / finance agent. Non-PHI ring only (never a MedReview/PHI site). App-only avoids the delegated-token rotation fragility; app-only SharePoint works even though app-only personal OneDrive is tenant-blocked.
---

# cfo-sharepoint — read SharePoint Team sites + libraries (CFO)

Closes the gap the `cfo-onedrive` skill leaves: that skill's delegated token reaches only
Matt's personal OneDrive (`/me/drive`). Finance docs on Team sites (FinanceTeam, etc.), like
the WF-9145 operating-account statements needed to verify the blessed-year cash, live in
SharePoint document libraries. This skill reads them app-only.

## Commands
```
node skills/cfo-sharepoint/cfo-sharepoint.mjs whoami                       # verify the token + permission
node skills/cfo-sharepoint/cfo-sharepoint.mjs sites [search]               # list sites (id | name | webUrl)
node skills/cfo-sharepoint/cfo-sharepoint.mjs drives <siteId>             # document libraries (driveId | name)
node skills/cfo-sharepoint/cfo-sharepoint.mjs ls <driveId> [path]         # list a folder
node skills/cfo-sharepoint/cfo-sharepoint.mjs tree <driveId> [path]       # recursive listing
node skills/cfo-sharepoint/cfo-sharepoint.mjs pull <driveId> <path> <dir> # download a folder (recursive) or a file
```
Example (FinanceTeam WF-9145): `sites Finance` -> get the site id -> `drives <siteId>` (or use
the known drive id `b!uNyvBM9RO0-YyiQQBQrJczm98sl6TktCo6STapJffrTvP_0-VTG8S78PqzXYPtqw`) ->
`tree <driveId> "Shared Documents/General/Bank Statements/9145 WF"` -> `pull <driveId> "<path>" <dir>`.

## Auth + setup
App-only client-credentials with the dedicated app **"OTCHealth CFO SharePoint Ingestion"**
(`graph-sites-client-id` / `graph-sites-client-secret` in Secret Manager; tenant =
`graph-mail-tenant-id`). Requires **Sites.Read.All (application) admin-consented** on that app
(one-time admin step). Read-only.

## Guardrails
- Non-PHI ring only: never point at a MedReview/PHI site or library.
- Read-only (Sites.Read.All). Downloads land locally; the CFO uploads to the **Azure Blob**
  data room (per the Azure directive), not GCS.
- The agent can only USE this once the SharePoint host (`innd.sharepoint.com`) + graph are in
  the `autoMode.environment` trusted list; otherwise the classifier blocks the pull (a bulk
  SharePoint -> storage pattern). That trust config is the operator step that turns it on.
- Credentials flagged ROTATE-BEFORE-LAUNCH.
- STATUS (2026-06-19): the "OTCHealth CFO SharePoint Ingestion" app (appId 2ce11702-003d-4638-
  958a-9d0299518b84) was trimmed from over-broad (full-control / write / mail tenant-wide) down to
  LEAST-PRIVILEGE **Sites.Read.All (read-only)** and VALIDATED end-to-end with the same key:
  app-only token -> Finance Team site -> Documents library all read cleanly, zero loss of function.
  Over-privilege risk CLOSED. The key still rotates before public launch.
