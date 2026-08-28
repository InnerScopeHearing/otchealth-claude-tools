---
name: fleet-secret-custodian
description: "SUPERSEDED 2026-08-28 -- do not run or port. Was Tier-1 autonomous secret-lifecycle custody (enumerate + classify + hygiene-audit + autonomous rotation) for Azure Key Vault kv-otc-55c84f6bef. That vault, and the Azure subscription it lived on, was permanently deleted 2026-08-13 -- every function here (KV enumeration, ARM regenerateKey, the Blob Append-Blob tamper-evident audit log) targets a dead resource. AWS SSM Parameter Store (/otchealth/*, ~455 params) is the fleet's secret store of record now, and it has no Tier-1 custodian yet; this needs a NEW SSM-native tool, not a port of this one (SSM's PutParameter rotation model has no ARM regenerateKey analog, and SSM has no first-class Append-Blob-equivalent for the hash-chained log). See the Status note at the bottom of this file for the one piece worth reusing directly: the classification taxonomy, which is store-agnostic."
---

# fleet-secret-custodian — the CTO owns every secret, autonomously, with an audit trail

> **SUPERSEDED (2026-08-28) -- read this before touching this skill.** This directory is kept for
> HISTORY only. Do not run `custodian.mjs` and do not port it. Reasons:
> 1. **Its entire subject is permanently gone.** Every function here targets Azure Key Vault
>    `kv-otc-55c84f6bef` (ARM `regenerateKey` for rotation, an Azure Blob Append Blob for the
>    tamper-evident audit log) on the Azure subscription permanently deleted 2026-08-13. There is
>    nothing left to enumerate, classify, or rotate through this code path.
> 2. **AWS SSM Parameter Store is the fleet's secret store of record now** (`/otchealth/*`, ~455
>    params -- see `otchealth-claude-tools/CLAUDE.md`'s 2026-08-27 correction), and it has no Tier-1
>    autonomous custodian yet. Unlike the other Azure-estate skills ported in the 2026-08-27/28 S3
>    cluster (a like-for-like storage-backend swap), this one is **not** a like-for-like port
>    candidate: SSM's rotation primitive (`PutParameter` with `Overwrite:true`) does not map onto
>    ARM's dual-key-swap `regenerateKey` model, and SSM has no first-class Append-Blob equivalent for
>    a hash-chained tamper-evident log (an S3 Object Lock bucket, already used elsewhere in the
>    fleet's DR chain, would be the natural substitute but is a genuinely different design, not a
>    swap-in). **If Tier-1 autonomous SSM custody is ever wanted, build a NEW, small, SSM-native
>    tool** rather than porting this one -- mirror `skills/notion-export/SKILL.md`'s own precedent for
>    this exact situation (a dead-store tool whose migration already happened, or whose successor
>    would be a different shape, is not worth porting).
> 3. **One piece IS worth reusing directly**, and is called out here so it is not lost with the rest:
>    the **classification taxonomy** (`a-azure-native` / `b-shortlived-better` / `owner-token-keeper`
>    / `tier2-bootstrap` / `tier3-out-of-scope` / `public-nonsecret` / `unknown` -- see the table
>    below) -- the CATEGORIES and the reasoning behind each (what rotates safely, what token-keeper
>    alone must own, what stays permanently out of scope) are store-agnostic and apply just as well
>    to an SSM-native classifier as they did to this Key-Vault one.
>
> Everything below this note is the ORIGINAL skill documentation, preserved as-is for history; treat
> every Key Vault / ARM / Azure Blob reference in it as describing a dead target, not a live one.

Tier 1 of the CEO directive (Matt: the CTO owns complete custody of all secrets fleet-wide; no ongoing
human token management). This is **accountability, not permission-seeking**: nothing here waits for an
approval. It audits, classifies, and rotates what is safely rotatable — and records everything to a
tamper-evident log so any action can be reconstructed after the fact.

## What it does NOT do (deliberate, load-bearing)
- It does **not** reinvent Key Vault access — it reuses the exact managed-identity-first pattern of
  `skills/kb-memory/azure-secret.mjs` (identity sidecar → SP fallback; never throws on read).
- It does **not** rotate OAuth refresh tokens. `skills/token-keeper` (Xero 60d, QBO 100d) is the
  single canonical writer per `runbooks/CREDENTIAL-OWNERSHIP-MAP.md`. The fleet's #1 secret-lockout
  class is TWO writers on one rotating token (Xero innd v474 / dead Stripe MCP). The custodian
  classifies those as `owner-token-keeper` and **refuses** to rotate them — it can never become a
  second writer. It audits them; token-keeper rotates them.
- It does **not** touch Apple/bank/hardware-MFA/PHI secrets (`tier3-out-of-scope`) — ever.

## Verbs
- `audit [--json]` — read-only inventory + classification + hygiene findings. Safe anytime. Writes ONE
  record to the tamper-evident log. Fail-OPEN per secret (a metadata miss degrades one row to
  `unknown`, never aborts); fail-LOUD (exit 78) only if the whole vault is unreachable.
- `report [--json]` — human-readable summary; a pure read (does NOT append a log record).
- `rotate <secret-name> [--force]` — rotate one secret. **Dry-run by default**; `--force` executes.
  FAIL-CLOSED: refuses loudly if the secret isn't `a-azure-native`. Verify-before-retire; prior KV
  version stays enabled for `CUSTODIAN_GRACE_HOURS` (rollback window).
- `rotate-due [--force]` — the cron entrypoint: rotate every `a-azure-native` secret past the age
  threshold (`ROTATE_AGE_DAYS_APIKEY`, default 90).
- `selftest` — no writes: identity/KV/ARM reachability + audit-log writability.

## Classification categories
| category | meaning | custodian rotates? |
|---|---|---|
| `a-azure-native` | Storage/Cosmos/Search/Cognitive keys — ARM `regenerateKey` (dual-key swap) | **YES (Tier 1)** |
| `b-shortlived-better` | GitHub PAT/App key — the right answer is the short-lived installation-token pattern, not rotation | no — flags migration |
| `owner-token-keeper` | OAuth-rotating refresh/access tokens | no — token-keeper is the single writer |
| `tier2-bootstrap` | Entra app secrets, Stripe/Cloudflare/etc. third-party keys, keystone/infra | no — needs a one-time bootstrap |
| `tier3-out-of-scope` | Apple/bank/hardware-MFA/PHI | **never** |
| `public-nonsecret` | DSNs, phc_ capture keys, endpoints/ids/versions | n/a |
| `unknown` | unclassified name | **never** (fail-closed; surfaced for human triage) |

## Tamper-evident audit log (why Blob, not Cosmos)
Append-only NDJSON, one blob per UTC day (`secret-custodian-audit/log-<date>.ndjson`), via the Blob
**Append Blob** API. Each record carries the SHA-256 of the previous record (`prevHash`) → a
hash-chain, so deleting/editing a middle record is detectable. The container is meant to carry a Blob
**immutability (WORM) time-based-retention policy**, which is what makes it genuinely tamper-*evident*.
Cosmos is not reachable from this job's tool surface (no data-plane role; the fleet reaches the ledger
only through the read-only gateway), so a rotation is **mirrored best-effort** into the Cosmos
work-ledger via the gateway `task_create` — but the Blob hash-chain is the authoritative record.

## Fail posture (house convention)
`audit`/`report` fail-OPEN (like kb-memory recall). `rotate` fails-CLOSED (like synthetic-health-data's
de-identifier): any uncertainty → do not rotate, exit non-zero, leave the old secret working. A
rotation that cannot be recorded in the audit log is treated as a FAILED rotation and rolled back.

## Run
- Container Apps Job (canonical): `node skills/fleet-secret-custodian/custodian.mjs audit` weekly +
  `rotate-due --force` on the age threshold. See `otchealth-cto/iac/fleet-secret-custodian-cron.json`.
- Manual: `node skills/fleet-secret-custodian/custodian.mjs report`

## Env (none are secret values)
`AZURE_KEYVAULT_NAME` (default kv-otc-55c84f6bef) · `CUSTODIAN_STORAGE_ACCOUNT` (audit-log Blob account;
confirm before deploy, not hardcoded) · `CUSTODIAN_CONTAINER` (default secret-custodian-audit) ·
`ROTATE_AGE_DAYS_APIKEY` (default 90) · `CUSTODIAN_GRACE_HOURS` (default 24) · `AZURE_SUBSCRIPTION_ID`
(for ARM regenerateKey) · `GATEWAY_BASE_URL` (ledger mirror).

## Hard rules
- Non-PHI ring only. Secret VALUES are never printed, logged, or written to the audit trail — only
  names, versions, timestamps, categories, outcomes.
- A rotatable secret MUST be tagged `resourceId` (its source Azure resource) at provisioning; rotate
  fails closed rather than guessing which resource a key belongs to.
- Never a second writer on an OAuth-rotating token (defer to token-keeper).
