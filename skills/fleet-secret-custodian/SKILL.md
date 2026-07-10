---
name: fleet-secret-custodian
description: Tier-1 autonomous secret-lifecycle custody for the OTCHealth fleet. Enumerates every secret in Key Vault kv-otc-55c84f6bef, classifies each by rotation capability (Azure-native regenerateKey / third-party / short-lived-token-is-better / token-keeper-owned OAuth / Tier-2-bootstrap / Tier-3-permanently-manual / public-non-secret), surfaces real hygiene gaps (missing-expiry, stale, unclassified), and autonomously rotates the Azure-native key class on an age threshold — FAIL-CLOSED (verify-before-retire, prior version kept enabled for a grace window, never a half-rotated state). Every action writes a tamper-evident, hash-chained append-only record to Blob (WORM-capable), mirrored best-effort into the Cosmos work-ledger. Builds ON skills/kb-memory/azure-secret.mjs (KV primitive) and DEFERS to skills/token-keeper as the single writer for OAuth-rotating tokens (never becomes a second writer — the fleet's #1 lockout class). Non-PHI ring; secret VALUES never logged. Run: node skills/fleet-secret-custodian/custodian.mjs <audit|report|rotate <name>|rotate-due|selftest>.
---

# fleet-secret-custodian — the CTO owns every secret, autonomously, with an audit trail

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
