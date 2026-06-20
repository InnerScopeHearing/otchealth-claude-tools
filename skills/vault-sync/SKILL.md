---
name: vault-sync
description: Reconcile the Notion "API Tokens & Credentials (Registry)" database against GCP Secret Manager (otchealth-shared-prod). The registry is the human-facing, QUERYABLE index of every credential, one row per Secret Manager secret, with Service / Type / Environment / Ring / Status / Notes. VALUES never live in the registry, they stay in Secret Manager and are fetched by the "Secret Manager ID" column via get-secret.mjs. This skill lists SM, infers metadata per secret name, and CREATES a row for any new secret + UPDATES rows whose inferred Service/Type/Ring drifted + flags orphan rows (a row with no SM secret). Idempotent. Run it after adding/rotating secrets, or on a schedule. Replaces the old monolithic 191KB vault page that was too large for any agent to load. Non-PHI ring (the registry holds metadata, not values; MedReview rows are tagged PHI-BAA).
---

# vault-sync, the credential registry reconciler

## Why this exists
The old "API Tokens & Credentials" Notion page grew to a single ~191KB page with ~175 inline
sections. `notion-fetch` ERRORS on it ("result exceeds maximum allowed tokens"), so agents pointed
at it could not load it and could not find anything. The fix is structural: a **database** (one row
per credential) that agents QUERY instead of fetch, plus the rule that **values live in Secret
Manager, not Notion.**

## The model (read this before using the vault)
- **Secret Manager (`otchealth-shared-prod`) is the source of truth for VALUES.** Fetch any secret
  with `node setup/get-secret.mjs <id> <outfile>`. NEVER fetch the Notion page for a value.
- **The Notion registry DB is the human-facing index + rotation tracker.** It is built and kept in
  sync FROM Secret Manager by this skill. Title: "API Tokens & Credentials (Registry)". Its id is in
  Secret Manager as `notion-vault-db-id`.
- One row per secret: Name, **Secret Manager ID** (the link to the value), Service, Type, Environment,
  Ring (non-PHI / PHI-BAA), Status (Active / Rotate-before-launch / Rotated / Retired), Owner Account,
  Rotation Date, Used By, Notes.

## Commands
```
# Reconcile the registry against Secret Manager (create missing rows, update drifted metadata, flag orphans)
node skills/vault-sync/vault-sync.mjs
# Target a specific DB (else it reads notion-vault-db-id from Secret Manager):
VAULT_DB_ID=<db-id> node skills/vault-sync/vault-sync.mjs
```

## How agents should USE the vault (not the old page)
- Need a value: `node setup/get-secret.mjs <secret-id> <outfile>` (the `<secret-id>` is the row's
  "Secret Manager ID").
- Need to find/list credentials (which exist, rotation status, by service): QUERY the registry DB
  via the Notion MCP `query_data_sources` (SQL) or a saved view, do NOT fetch a giant page.
- Added/rotated a secret: run this skill so the registry reflects it.

## Credentials (hydrated)
- `notion-api-key` (the OTCHealth-Claude-Direct-API workspace integration; must be connected to the
  registry DB, it is, since the DB was created by this integration).
- `GCP_CLAUDE_DRIVER_SA_JSON` -> `$HOME/.gcp_claude_driver_sa.json` (lists Secret Manager).
- `notion-vault-db-id` (the registry database id).

## Notes
- Metadata (Service/Type/Ring) is INFERRED from the secret name; refine the `infer()` map as naming
  evolves, then re-run to update. The "Secret Manager ID" link is always exact.
- Rotation status (Rotate-before-launch) and Owner/Notes are human-curated in the DB; the sync does
  not overwrite Status/Owner/Notes/Rotation Date (it only manages Name/SM-ID/Service/Type/Env/Ring).
- The old monolithic vault page stays as a read-only LEGACY archive until its hand-written notes are
  migrated into row Notes, then it can be retired.
