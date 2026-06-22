---
name: notion-export
description: Ring-routed, resumable export of Notion content into the Azure Blob brain substrate, the engine of the Notion -> Azure retirement (Matt directive 2026-06-22). Reads a routing manifest (per-object ring: OPERATIONAL | CREDENTIALS | MNPI-INND | PERSONAL-PRIVILEGED | PHI-HOLD), renders each page to Markdown and each database to Markdown + JSONL, and uploads to the ring-correct storage account/container so the librarian can index it into the company brain. TWO safety gates: the upstream classifier routes by database identity + teamspace, and this exporter adds a CONTENT scrubber that QUARANTINES any object containing a real secret value or a confidential marker (secret values live in Secret Manager, never in a searchable store). Operational -> commons; CREDENTIALS regenerate from Secret Manager separately (never raw-copied); PERSONAL-PRIVILEGED is a CLO-lane action; PHI-HOLD is never exported here. Wielded by the CTO. Non-PHI ring. Reuses the kb-memory storage pattern (claude-driver SA -> Secret Manager -> account SAS -> Blob REST), dependency-free Node.
---

# notion-export

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
- `--no-scrub` disables the content scrubber. Use ONLY for a fully access-controlled, segregated, non-brain-federated destination (the legal `personal` container) where the goal is to move ALL sensitive content faithfully and the container's own access control is the protection. Never use it for an OPERATIONAL copy (that feeds the shared brain).
- Notion key: `--key <file>` or, by default, Secret Manager `notion-api-key`. Paced ~3 req/s with 429 backoff.

## Guardrails
- Non-PHI ring only. PHI databases (MedReview Consult Queue, Adverse Events) are HELD at the wall, never exported here.
- MNPI/INND is securities-sensitive: route to the restricted container only, flag Capital + CLO, never the shared commons.
- PERSONAL-PRIVILEGED (family-law, the civil case) is attorney-privileged: the CTO does NOT read or copy it; the CLO runs that ring in its segregated lane.
- The account SAS must include delete (`sp=rwdlc`) for purges; write/list (`rwlc`) 403s on delete.
