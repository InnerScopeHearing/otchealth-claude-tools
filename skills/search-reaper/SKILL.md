---
name: search-reaper
description: Orphan search-document garbage collector for the Azure AI Search brain (otchealth-dataroom-s1). Every one of the 18 native blob pull-indexer datasources has dataDeletionDetectionPolicy null, so a source blob that gets deleted leaves its indexed chunk documents behind forever - permanent ghost documents that still rank in search and crowd out live content (verified live on legal-personal, a real non-trivial orphan backlog on a 165k+ doc index). This skill scans an index, checks whether each distinct source path (the doc's `path` field, a full blob URL) still resolves to a real blob, and deletes the chunk documents whose source is confirmed gone. Read-only scan mode always available; reap mode is dry-run unless --commit is passed. Index-to-container mapping is read live from the real datasource/indexer definitions, never hardcoded. Safety-hardened - a definitive 404 is the only thing that counts as "missing" (network/auth/throttle errors are never treated as deletion evidence), any path containing CANARY is never touched, and a run only ever reads existence metadata (chunk_id + path via HEAD requests), never document content - safe to run against legal-personal (attorney-privileged). Wielded by the CTO; pairs with the separately-built deletion-detection policy (which only catches FUTURE deletes) as the backlog-clearing + ongoing-GC half of the fix.
---

# search-reaper — clear the orphan-document backlog on the Azure AI Search brain

## The bug
`otchealth-dataroom-s1` has 18 indexes fed by native Azure Search blob pull-indexers. All 18
datasources have `dataDeletionDetectionPolicy: null`, so when a source blob is deleted, the search
documents indexed from it are **never removed**. The index keeps accumulating permanent ghost
documents. Verified live: `legal-personal` (165,983 total chunk docs at last count) carries a real
orphan backlog. A deletion-detection policy only stops the bleeding going forward; this tool clears
what already accumulated and can run again any time as ongoing garbage collection.

## What "orphan" means
A chunk document whose `path` field (the full source blob URL the pull indexer read it from, e.g.
`https://otchealthlegalstore.blob.core.windows.net/personal/_TEXT/.../file.txt`) no longer resolves
to a real blob — a definitive HTTP 404 on a HEAD request. Deliberately narrower than "anything under
a `_TRASH/` prefix": a soft-deleted path may still be a perfectly real blob. Only a confirmed-gone
blob is ever touched.

## Usage
```
node reaper.mjs scan --index legal-personal [--prefix <blob-path-prefix>]   # read-only, always safe
node reaper.mjs scan --all                                                  # every live blob-backed index

node reaper.mjs reap --index legal-personal [--prefix <p>]                  # DRY RUN (default) — reports, deletes nothing
node reaper.mjs reap --index legal-personal --commit                        # actually deletes confirmed orphans
node reaper.mjs reap --all --commit
```

`reap` without `--commit` makes zero calls to the delete endpoint — it runs the exact same scan and
prints what it *would* delete. Nothing is ever deleted without an explicit `--commit`.

## How it finds the right blob container
Index -> container mapping is read live every run from the real Azure Search resource: `GET
/datasources` + `GET /indexers` (joined on `dataSourceName` -> `targetIndexName`). This is never
hardcoded, so a new datasource (or a room reconfiguration) is picked up automatically. Azure Search
redacts a datasource's storage credentials on GET (by design — there's no API that returns a live
key), so the storage ACCOUNT NAME + KEY still comes from a small `CONTAINER_ACCOUNT_MAP` table that
mirrors `skills/doc-indexer/indexer.mjs`'s PROFILES secret names exactly (same accounts:
otchealthcfodata / otchealthlegalstore / otchealthcommerce / otchealthcommons). Every per-document
path is cross-checked against that resolved account before any HEAD request runs; a mismatch is
treated as an error, never as evidence the blob is missing.

## Safety rules (all test-covered)
1. **Only a literal 404 means "missing."** Network failures, 401/403/429, 5xx, unparseable paths,
   unrecognized containers, and account-name mismatches are all "error" — never treated as
   deletion evidence. A run whose error rate is abnormally high (>25% of checked paths, with a
   floor of 5 errors) aborts and deletes nothing rather than risk mass-deleting live documents.
2. **CANARY exclusion.** Any path containing `CANARY` (case-insensitive) is excluded from
   existence-checking and deletion entirely — an active investigation canary is in flight
   fleet-wide.
3. **Dry-run by default.** `reap` without `--commit` never calls the delete endpoint.
4. **Content-blind.** Only `chunk_id` + `path` are ever read from the index (never `chunk`, the
   indexed text, or `text_vector`), and existence checks are HEAD requests only (never GET). Safe
   to run against `legal-personal` (attorney-privileged) — it never reads privileged content.
5. **Batched, partial-failure-aware deletes.** Deletes are chunked at Azure Search's 1000-action
   batch limit and a 207 (partial failure) response is parsed per-item, not treated as an
   all-or-nothing outcome.

## Credentials
`kvSecret()` from `skills/kb-memory/azure-secret.mjs` (Key Vault, managed identity -> SP ->
az-CLI). Search service: `azure-search-endpoint` / `azure-search-admin-key`. Per-room blob
credentials: `azure-{legal,cfo,commerce,commons}-storage-{account,key}` (see
`CONTAINER_ACCOUNT_MAP` in `reaper.mjs`).

## Pagination note
Uses keyset pagination (`orderby chunk_id asc` + `filter chunk_id gt '<last>'`), not `$skip` — Azure
AI Search caps `$skip` at 100,000 and `legal-personal` alone already exceeds that
(`skills/fleet-backup/backup.mjs` hit this same ceiling and had to warn about it). Keyset pagination
on the sortable/filterable key field has no such ceiling.
