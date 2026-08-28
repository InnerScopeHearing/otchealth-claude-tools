---
name: notion-export
description: "SUPERSEDED 2026-08-27 -- do not run or port. Was a ring-routed, resumable export of Notion content into the Azure Blob brain substrate, the one-time engine of the Notion -> Azure retirement (Matt directive 2026-06-22). The migration it existed to run already completed (the commons _NOTION/ prefix carries 3,234 chunks per the 2026-08-19 enrich census) and it has zero callers anywhere in the repo (no job, no workflow, no cron). Its Azure Blob storage target is also permanently dead (the subscription holding it was deleted 2026-08-13). See the Status note at the bottom of this file for the retirement rationale and what to build instead if a future re-export is ever needed."
---

# notion-export

> **SUPERSEDED (2026-08-27) -- read this before touching this skill.** This directory is kept for
> HISTORY only. Do not run `notion-export.mjs` and do not port it to S3. Reasons, all independently
> verified during the 2026-08-27 S3-blob-cluster port (see `otchealth-claude-tools` CLAUDE.md's
> Azure-retirement notes for the broader context this sits inside):
> 1. **The one-time migration it exists to run already ran.** This tool's whole purpose (per its own
>    description above) was the Notion -> Azure retirement, Matt directive 2026-06-22. The commons
>    `_NOTION/` prefix is the LARGEST prefix in that data room (3,234 chunks, per the 2026-08-19
>    enrich-census entry in the CLAUDE.md dated log) -- the export completed and is already indexed.
> 2. **Zero callers anywhere in this repo.** A repo-wide grep for `notion-export` outside this
>    directory returns nothing: no job script, no GitHub Actions workflow, no cron entry, no other
>    skill importing it.
> 3. **Its storage target is permanently dead anyway.** Every write in `notion-export.mjs` targets
>    Azure Blob (`DEST` ring map -> `otchealthcommons`/`otchealthlegalstore` accounts) via a hand-rolled
>    account-SAS, exactly like the five skills that WERE ported in the 2026-08-27 S3 cluster. Porting a
>    tool nothing calls, for a migration that already finished, would be effort spent on dead code.
>
> **If a future re-export is ever genuinely needed** (e.g. Notion content changes and needs a refresh),
> build a NEW, small, S3-native tool rather than porting these ~250 lines of Azure plumbing. Two pieces
> of this file ARE worth reusing directly, and are called out here so they are not lost with the rest:
> - The `SECRET_PATTERNS` + `CONFIDENTIAL` content scrubber (`notion-export.mjs`, the regexes bound to
>   `SECRET_PATTERNS`/`CONFIDENTIAL` and the classifier function that quarantines a hit) -- a genuinely
>   reusable secret/confidential-marker detector, storage-backend-agnostic.
> - The ring-gated relaxation logic (`--no-scrub` refused for every ring but PERSONAL-PRIVILEGED,
>   `--no-confidential-scrub` refused for OPERATIONAL, full scrub always on for OPERATIONAL) -- the
>   actual safety invariant, independent of which blob store it writes to.
>
> Everything below this note is the ORIGINAL skill documentation, preserved as-is for history; treat
> every storage instruction in it (account SAS, Azure Blob URLs, `azure-*-storage-*` secrets) as
> describing a dead target, not a live one.

The migration engine for retiring Notion onto the owned Azure substrate (Blob + AI Search + company-brain + librarians). Notion is agent-only, expiring, and not durable/portable/self-learning; this moves the content to a store the fleet already owns and can search.

## Why two gates (read this before running)
"Copy everything in Notion" is a ROUTING problem, not a copy problem. The same workspace holds four walled rings mixed together (operational, credentials, MNPI/INND, attorney-privileged personal, PHI). A blind copy into the shared brain leaks secrets and co-mingles privilege. So:
1. **Structural classifier (upstream):** assigns each object a ring by database identity (a row inherits its DB ring) + teamspace id-prefix + a credential-name test. Output = a routing manifest (kept OUT of git; it references personal-matter titles).
2. **Content scrubber (this tool):** for every object, scans title + rendered content with high-precision secret-value regexes + confidential markers; on a hit it QUARANTINES the object (logs id+title+reason to `_HELD/`, never uploads). This catches secret values pasted into page bodies that the structural pass cannot see.

## Usage
```
GCP_CLAUDE_DRIVER_SA_JSON="$(cat ~/.gcp_claude_driver_sa.json)" \
  node notion-export.mjs <RING> --manifest <routing-manifest.json> [--key <notion.key>] [--limit N] [--force] [--dry]
```
- `RING`: `OPERATIONAL` (-> commons `company-journal/_NOTION/operational`, brain-indexed), `MNPI-INND` (-> restricted legal `company/_NOTION/innd-mnpi`), `PERSONAL-PRIVILEGED` (-> `personal/_NOTION/personal`, a CLO-lane action). `CREDENTIALS` are regenerated from Secret Manager, not run here. `PHI-HOLD` is never exported (legal wall).
- `--dry` previews item selection + destination without fetching/uploading. `--limit N` validates on a slice. Resumable: re-runs skip already-exported objects by their 32-hex id.
- Scrub relaxations are **gated by ring** so they can never fail-open into a brain-indexed store:
  - `--no-scrub` disables the scrubber **entirely** (including the secret-value scan). Honored ONLY for `PERSONAL-PRIVILEGED` (the legal `personal` container, fully segregated and never brain-federated); **refused for every other ring**.
  - `--no-confidential-scrub` keeps the secret-value scan but drops the confidential-marker quarantine. For restricted-but-internally-federated rings (the legal `company`/MNPI container); **refused for OPERATIONAL**.
  - `OPERATIONAL` always gets full scrubbing (no relaxation accepted).
  - When a relaxation is honored, the run still records what the full scrub WOULD have caught to `_HELD/scrub-bypassed-<ring>.jsonl` (id/title/reason, no content) for after-the-fact review.
- Notion key: `--key <file>` or, by default, Secret Manager `notion-api-key`. Paced ~3 req/s with 429 backoff.

## Guardrails
- Non-PHI ring only. PHI databases (MedReview Consult Queue, Adverse Events) are HELD at the wall, never exported here.
- MNPI/INND is securities-sensitive: route to the restricted container only, flag Capital + CLO, never the shared commons.
- PERSONAL-PRIVILEGED (family-law, the civil case) is attorney-privileged: the CTO does NOT read or copy it; the CLO runs that ring in its segregated lane.
- The account SAS must include delete (`sp=rwdlc`) for purges; write/list (`rwlc`) 403s on delete.

## Status note (added on merge, 2026-07-10)
The document-pipeline system dependencies this originally also patched into `setup/session-start.sh`
(LibreOffice modules + poppler-utils) have since been superseded by a more complete fix already on
main (which also adds weasyprint) -- that part of the original PR is intentionally NOT reapplied here.
