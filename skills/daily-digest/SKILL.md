---
name: daily-digest
description: The company's end-of-day knowledge digest - the closing piece of the fleet learning loop. Generates a structured daily Markdown file of what the company shipped (merged PRs across every org repo), decided, and learned, then feeds it into the knowledge base (stage -> index -> understand -> push-search) so every agent can cloud-search what happened and what we learned on any given day. Run nightly at 23:59 as a scheduled job. Makes the company literally journal and compound its knowledge every single day.
---

# daily-digest - the end-of-day company knowledge digest

Closes the learning loop: every day, a digest of the day's shipped work + decisions + learnings is
generated, dropped into the knowledge base, understood + indexed, and becomes permanently
searchable. An agent tomorrow can ask "what did we ship / decide / learn on 2026-06-19" and get it.

## Generate
```
node skills/daily-digest/digest.mjs [--date YYYY-MM-DD] [--days 1] [--org InnerScopeHearing] [--out journal/<date>.md]
```
Gathers the day's merged PRs org-wide via the github-app (lean GraphQL: number/title/repo) and
writes a structured Markdown digest with sections: Shipped, Decisions & notes, Learnings (fleet
memory), Open / blockers, Next. Validated: 44 merged PRs across 7 repos in a day.

## The nightly loop (what the 23:59 job runs)
```
DATE=$(date -u +%F)
# 1. generate the digest
node skills/daily-digest/digest.mjs --out /tmp/$DATE.md
# 2. stage it into the knowledge-base commons (own non-sensitive store; --account/--key-secret target it)
node skills/cfo-store/store.mjs --azure --account <commonsAccount> --key-secret <commonsKeySecret> \
  --container company-journal put /tmp/$DATE.md "_DAILY/$DATE.md"
# 3. catalog + understand + index it so it is cloud-searchable
node skills/doc-indexer/indexer.mjs index       --profile <commonsProfile> --azure
node skills/doc-indexer/indexer.mjs understand   --profile <commonsProfile> --azure
node skills/doc-indexer/indexer.mjs push-search  --profile <commonsProfile> --azure
# 4. (optional) commit the digest to otchealth-cto/journal/<date>.md for the durable, versioned record
```
After this, `cloud-search "<anything> 2026-06-19"` surfaces the day's digest alongside the source
documents, and the next day's digest builds on a richer base. The loop compounds.

## Schedule (the 23:59 kick)
- **Container Apps Job, cron `59 23 * * *`** on `otchealth-jobs-env`, using the doc-indexer job image
  (which includes this skill + github-app). Entrypoint runs the nightly loop above. This is the
  standard runtime; it deploys with the fleet image build (`az acr build` -> `otchealthacr`).
- Alternative: an n8n scheduled workflow (the live automation engine) that triggers the same loop.

## What it pulls together (the learning sources)
- **Shipped:** merged PRs across every org repo (the concrete daily output). LIVE.
- **Decisions & notes:** durable-state changes (CLAUDE.md / runbooks / Notion briefings) for the day.
- **Learnings:** promoted `kb_remember` entries for the day, so what one agent learned becomes
  searchable for all - the memory loop feeding the journal.
- **Open / Next:** carried status + tomorrow's priorities.
(The Shipped section is fully automated today; the other sections enrich as `kb_remember` + the
durable-state diff integration are wired - they are template slots now, not empty.)

## Credentials
- github-app private key (to fetch merged PRs) - via the `github-app` skill.
- commons store key (`azure-<commons>-storage-key`) + the doc-indexer Azure/CU/Search creds (self-
  resolved from Secret Manager via the claude-driver SA).

## Guardrails
- The journal is the COMMONS (shared, broadly readable). Keep it on its own non-sensitive store so
  its key does not unlock the finance/legal/MNPI rooms. Do NOT put PHI, raw MNPI, or privileged
  detail in the digest - summaries only; sensitive specifics stay in their ring.
- Non-PHI ring. No em dashes or en dashes in the digest copy.
