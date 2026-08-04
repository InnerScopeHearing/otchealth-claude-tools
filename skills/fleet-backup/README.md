# fleet-backup

Durable, offline copies of the fleet's two most central stores, decoupled from the live Azure
resources they back up. This directory is a job-body skill (no SKILL.md by design, matching
`xero-run`, `ocr-sweep`, `stripe-read`, and `agent-sunrise`): these scripts run as scheduled
Container Apps Jobs or ad hoc from a session, not as interactively invoked Skill-tool skills.

- `backup.mjs`: exports the Cosmos work ledger and every LIVE Azure AI Search index (per
  `setup/expected-indexes.json`) to the Azure Blob container `ledger-backup`, with sha256 manifests
  and fail loud, zero row discipline. Read its own header comment for the full design rationale.
- `azure-blob-client.mjs`: shared Azure Blob Storage REST client (List Blobs, GET, PUT block blob,
  container HEAD). Used by `s3-mirror.mjs` and `restore-drill.mjs` below.
- `s3-client.mjs`: shared, dependency-free AWS S3 client (PutObject, HeadObject, GetObject), signed
  with a hand-rolled AWS Signature Version 4 implementation (node:crypto only, no aws-sdk).
- `s3-mirror.mjs` and `restore-drill.mjs`: the Phase 6 disaster-recovery mirror, documented below.
- `pg-dump.mjs`: nightly `pg_dump` of Flatstick's and FourVault's production Azure Postgres databases
  to the same `ledger-backup` container, documented below (closes AZURE-LOSS-DR-PLAN.md gap #9).

## S3 DR mirror (Phase 6)

Replicates everything `backup.mjs` writes to the Azure Blob container `ledger-backup` into AWS S3,
as an off-Azure cold copy. The goal: a total loss of the Azure subscription or tenant should not also
mean a total loss of the only durable copy of the Cosmos work ledger and the live AI Search room
dumps. This mirror consumes `backup.mjs`'s output. It never re-exports from Cosmos or AI Search
directly, and never duplicates `backup.mjs`'s own export logic.

Run `s3-mirror.mjs` on the same cadence as `backup.mjs`, or less often. It is fully idempotent: a blob
whose S3 copy already has a matching sha256 (recorded as S3 object metadata `x-amz-meta-sha256`) is
skipped without re-download or re-upload.

### What gets mirrored, and what does not (ring segregation, hard requirement)

By default, this mirror EXCLUDES every privileged or sensitive room. A blob is classified privileged
if its name contains any of, case insensitive: `legal-personal`, `legal-company`, `cfo`, `finance-`,
`-personal`, `medreview`, `phi`. This is deliberately over inclusive: a false positive just delays a
safe room reaching the off-Azure copy, which is the fail-closed direction; a false negative would leak
a privileged room into the wrong bucket, which must never happen. As a second, independent signal,
`s3-mirror.mjs` also cross-checks `setup/expected-indexes.json`, so any index gated behind
`kb_search_privileged` is force classified privileged even if its name does not match the substring
list above.

With the current live room registry, this means:

| Room / blob | Classification | Reaches S3 by default? |
| --- | --- | --- |
| `tasks-<date>.jsonl` (Cosmos work ledger) | non-privileged | yes |
| `index-memory-exec-<date>.jsonl` | non-privileged | yes |
| `index-commons-company-journal-<date>.jsonl` | non-privileged | yes |
| `index-commerce-commerce-source-docs-<date>.jsonl` | non-privileged | yes |
| `manifest-<date>.json` (backup.mjs's own manifest; metadata only) | non-privileged | yes |
| `index-finance-cfo-source-docs-<date>.jsonl` | privileged (MNPI ring) | no, unless double opt-in |
| `index-legal-company-<date>.jsonl` | privileged (attorney ring) | no, unless double opt-in |
| `index-legal-personal-<date>.jsonl` | privileged (attorney-personal ring) | no, unless double opt-in |

Every run logs which blobs were mirrored and which were skipped as privileged. Coverage is never
silently dropped: a room that is expected (per the registry) but produces no blob at all, or a missing
Cosmos ledger export, fails the run loudly (after the manifest is still persisted, so partial progress
is never lost).

### Including privileged rooms (double opt-in, separate bucket)

Privileged rooms are mirrored only when BOTH of these are set on the same run:

- CLI flag `--include-privileged`
- Environment variable `S3_DR_INCLUDE_PRIVILEGED=1`

When both are set, privileged blobs go to a SEPARATE bucket and a SEPARATE AWS credential
(`aws-dr-privileged-*`), never co-mingled with the non-privileged bucket. `s3-mirror.mjs` refuses to
run the privileged lane at all if `aws-dr-privileged-s3-bucket` resolves to the same bucket as
`aws-dr-s3-bucket`.

### Secrets to provision

UPDATE 2026-07-22: the base (non-privileged) four secrets below are now CONFIRMED LIVE in Key Vault,
independently verified with a real STS GetCallerIdentity call (IAM user cto-hyperagent, AWS account
900915535335) and a real S3 ListObjectsV2 call against the destination bucket (HTTP 200, bucket exists).
This lane is fully self-serve; nobody needs to provision anything further for it. The scheduled
`.github/workflows/nightly-s3-dr-mirror.yml` runs it nightly. Only the privileged lane's secrets remain
unconfirmed (see "Including privileged rooms" above); that lane is a deliberate, manual, double opt-in
action and stays inert until someone provisions and arms it on purpose.

Both scripts stay inert safe regardless: with any of the base four secrets absent, `s3-mirror.mjs run`
prints a clear message and exits 0, no error, no partial state. That is now a permanent fail-open guard
(a deleted/rotated secret, a Key Vault outage), not the day-to-day expected state.

Store these in Azure Key Vault (`kv-otc-55c84f6bef` by default, override with `AZURE_KEYVAULT_NAME`).
Prefer `--file` over `--value` so the secret never lands in shell history; write to a temp file, set
the secret, then shred the temp file, matching the fleet's established credential hygiene pattern.

Required for the base, non-privileged mirror (all four, or the whole run is a no-op). A small helper
function keeps the value out of shell history and shreds the temp file after each write:

```bash
VAULT=kv-otc-55c84f6bef
umask 077
set_kv() { printf '%s' "$2" > /tmp/s.$$; az keyvault secret set --vault-name "$VAULT" \
  --name "$1" --file /tmp/s.$$ >/dev/null; shred -u /tmp/s.$$; echo "set $1"; }

set_kv aws-dr-access-key-id       "<AWS access key id, the non-privileged DR IAM user>"
set_kv aws-dr-secret-access-key   "<matching secret access key>"
set_kv aws-dr-s3-bucket           "<destination bucket name, no dots, see the bucket-naming note below>"
set_kv aws-dr-region              "<e.g. us-east-1>"
```

Optional, only needed to enable the privileged lane (both `--include-privileged` and
`S3_DR_INCLUDE_PRIVILEGED=1` must also be set):

```bash
set_kv aws-dr-privileged-access-key-id     "<a DISTINCT AWS access key, not the IAM user above>"
set_kv aws-dr-privileged-secret-access-key "<matching secret access key>"
set_kv aws-dr-privileged-s3-bucket         "<a SEPARATE bucket name from aws-dr-s3-bucket>"
set_kv aws-dr-privileged-region            "<optional, falls back to aws-dr-region if unset>"
```

### Recommended IAM policy (least privilege)

The mirror never calls `s3:ListBucket`. Every key it touches comes from the Azure side listing, never
from asking S3 to enumerate itself, so the IAM policy can be this narrow:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "FleetDRMirrorNonPrivileged",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::REPLACE-WITH-NON-PRIVILEGED-BUCKET/*"
    }
  ]
}
```

Attach a copy of the same policy, with the Resource ARN pointed at the privileged bucket instead, to
the separate `aws-dr-privileged-*` IAM user if the privileged lane is ever armed.

A static access key and secret key pair is the simplest credential shape to wire into Key Vault and
this dependency-free SigV4 client, and is what this v1 build expects. A more secure v2 upgrade path,
not built here, is federated auth (AWS IAM Roles Anywhere, or GitHub Actions OIDC via
`AssumeRoleWithWebIdentity`), which avoids long-lived key material entirely at the cost of a different
STS-based auth flow this client does not implement yet.

**Bucket-naming note:** avoid a literal `.` in either bucket name. A bucket name containing a dot
breaks virtual-hosted-style HTTPS (TLS SNI and certificate wildcard matching do not cover
`my.bucket.name.s3.<region>.amazonaws.com`), and this client only implements virtual-hosted-style
requests, not the legacy path-style fallback.

### Running it

```bash
# no writes, reports Azure auth reachability, source container reachability, and whether AWS creds
# (base and privileged) are provisioned, without touching S3 at all
node skills/fleet-backup/s3-mirror.mjs selftest

# see what WOULD be mirrored without uploading anything (still requires real AWS creds, since it
# HEADs the destination to report what would be skipped as already-unchanged)
node skills/fleet-backup/s3-mirror.mjs run --dry-run

# the real mirror run, non-privileged rooms only (the default posture)
node skills/fleet-backup/s3-mirror.mjs run

# the real mirror run, including privileged rooms to the separate bucket
S3_DR_INCLUDE_PRIVILEGED=1 node skills/fleet-backup/s3-mirror.mjs run --include-privileged
```

Required environment (same names `backup.mjs` already uses; deploy this as a sibling job with an
identical env block):

```text
BACKUP_STORAGE_ACCOUNT   e.g. stotc55c84f6bef, the same account backup.mjs writes to
BACKUP_CONTAINER         default "ledger-backup"
S3_DR_MAX_MB             default 500, a single blob over this size is skipped with a loud warning
                         instead of risking an unbounded in-memory buffer
```

### Running the restore drill

Proves the mirror is restorable, not just writable: pulls a blob back from S3, recomputes its sha256,
and compares it to the sha256 recorded in the most recent `s3-mirror.mjs` manifest (read from Azure
Blob, the copy `s3-mirror.mjs` is required to write there).

```bash
# drill EVERY blob recorded in the latest manifest, non-privileged bucket (the full proof)
node skills/fleet-backup/restore-drill.mjs

# drill just one blob
node skills/fleet-backup/restore-drill.mjs index-memory-exec-2026-07-15.jsonl

# drill the privileged bucket instead (only meaningful once the privileged lane has actually run)
node skills/fleet-backup/restore-drill.mjs --privileged
```

Same inert-safe behavior: exits 0 with a clear message if the relevant `aws-dr-*` secrets are absent.
If creds are present but no manifest can be found in Azure, or the manifest has nothing recorded for
the requested bucket, that is a real failure (nothing to verify a restore against) and it exits
non-zero.

## Postgres -> S3 DR backup (closes AZURE-LOSS-DR-PLAN.md gap #9)

Flatstick's and FourVault's production databases (`flatstick` and `fourvault`, both on the Azure
Database for PostgreSQL Flexible Server `otchealth-nonphi-pg-cus1`) had NO off-Azure backup. Azure's own
point-in-time-restore, if enabled, lives inside Azure and does not survive a total Azure loss -- the
exact scenario the DR plan is for. `pg-dump.mjs` fixes this: it `pg_dump`s both databases nightly, gzips
the result, and writes it into the SAME `ledger-backup` Blob container `backup.mjs` already writes to,
under a `pg-dumps/` prefix. From there `s3-mirror.mjs` and `restore-drill.mjs` above need **zero code
changes** to pick these up: they already list the whole container generically, and `pg-dumps/<db>-<date>.
sql.gz` does not match any of `s3-mirror.mjs`'s privileged-substring patterns (pinned by
`tests/pg-dump-not-privileged.test.mjs`, a regression guard against a future rename accidentally
reclassifying it).

**Why this does NOT connect to Postgres directly from GitHub Actions** (read `pg-dump.mjs`'s own header
for the full detail): a live check this session proved neither this repo's cloud sandbox NOR, by the same
firewall evidence, a plain `ubuntu-latest` GitHub Actions runner can reach the Postgres server on `:5432`
-- the server's firewall allows exactly one named IP (a leftover from the original 2026-06-17 migration)
and `AllowAllAzureServices` (Azure-internal only, not "the public internet"). Rather than widen that
firewall to arbitrary public IPs (a real security downgrade on a server holding financial and COPPA-
relevant data), `pg-dump.mjs` runs the actual dump from a short-lived **Azure Container Apps Job**
execution (`pg-dump-nonphi`, image `postgres:16` straight from Docker Hub, no custom image build needed)
on the SAME `otchealth-jobs-env` environment the original Neon->Azure migration jobs already used --
already reachable to the Postgres server with zero firewall change. The GitHub Actions workflow's role is
to create/update that job via ARM, mint a short-lived write SAS + fresh credentials, start one execution,
poll it, and verify the result -- it never itself opens a socket to Postgres.

**Least privilege:** the job bootstraps a dedicated `backup_ro` role (LOGIN, NOSUPERUSER, NOCREATEDB,
NOCREATEROLE, NOREPLICATION, granted only the built-in Postgres 14+ `pg_read_all_data` predefined role
plus explicit `CONNECT` on both target databases) the first time it runs, using the admin credential ONLY
ephemerally inside that one Azure-internal job execution -- the admin credential is never used for the
dump itself and never leaves Azure. (NOT named `pg_dump_ro`: Postgres reserves every role name starting
with `pg_` for system use and refuses to create one -- found by an actual failed live run, not by
inspection; see the comment on the `ROLE` constant in `pg-dump.mjs`.)

Secrets used (Key Vault): `azure-pg-nonphi-server` / `azure-pg-nonphi-admin-user` /
`azure-pg-nonphi-admin-password` / `azure-subscription-id` (all pre-existing from the original migration).
`azure-pg-nonphi-dumpro-password` and `azure-backup-storage-key` are self-provisioned by `pg-dump.mjs` on
its first run (generated / fetched via ARM `listKeys` respectively, then stored for reuse).

```bash
# no writes: reports Key Vault + ARM + source-account reachability
node skills/fleet-backup/pg-dump.mjs selftest

# the real run: ensure the job, mint fresh creds/SAS, start + poll one execution, verify each blob
# (non-empty, gunzips cleanly, contains the real pg_dump banner)
node skills/fleet-backup/pg-dump.mjs run
```

**LIVE-PROVEN end to end** (2026-08-04, the session that built this): a real run against production --
`pg-dump-nonphi` execution Succeeded, `flatstick` dump = 150727 bytes gzipped, `fourvault` dump = 15595
bytes gzipped, both landed in Azure Blob and passed the gunzip/pg_dump-banner content check, both were
then picked up by an unmodified `s3-mirror.mjs run` and landed in the S3 DR bucket (verified via a direct
`s3Head` against `otchealth-brain-dr-55c84f6b`, byte counts matching exactly), and both PASSED
`restore-drill.mjs`'s byte-identity check pulling them back from S3.

Scheduled via `.github/workflows/pg-dump-to-s3.yml` (daily, 07:05 UTC, 15 minutes after
`nightly-s3-dr-mirror.yml`'s own 06:50 UTC run so the two scheduled invocations of `s3-mirror.mjs` never
race each other's manifest write into the shared source container). Same Azure auth shape as
`nightly-s3-dr-mirror.yml` (OIDC login + `AZURE_SP_*` secrets for the Blob-touching / ARM-touching steps).

Adding a third database (e.g. once Companion cuts over to this same server, per
`azure-migration-runbook.md`) is a one-line `PG_DUMP_DATABASES` env change on the workflow, no code change
and no new job resource.

### Deployment note

SCHEDULED as of 2026-07-22 via `.github/workflows/nightly-s3-dr-mirror.yml` (daily, 06:50 UTC): runs
`s3-mirror.mjs run` then `restore-drill.mjs` in the same job, non-privileged lane only, and pages on
failure the same way every other nightly workflow in this repo does. It authenticates with `azure/login`
OIDC (for `kvSecret`'s az-CLI fallback, resolving the `aws-dr-*` Key Vault secrets) plus
`AZURE_SP_CLIENT_ID`/`AZURE_SP_CLIENT_SECRET`/`AZURE_SP_TENANT_ID` GitHub Actions secrets (needed because
`azure-blob-client.mjs`, unlike `kvSecret`, has no az-CLI fallback of its own, only managed identity or
an `AZURE_SP_*` client_credentials path) on a `BACKUP_STORAGE_ACCOUNT` repo variable that falls back to
the documented example account name if unset.

A future alternative not built here: moving this to a Container Apps Job with the identical env block
`backup.mjs` runs under (Bicep or ARM job spec), which would drop the `AZURE_SP_*` secret entirely in
favor of the same managed identity `backup.mjs` already uses. **Correction (2026-07-21, live proving
run):** the required grant is NOT `Storage Blob Data Reader`. `backup.mjs` WRITES the backup and its
manifest, so it needs `Storage Blob Data Contributor` (see the comment in `backup.mjs`); `s3-mirror.mjs`
also needs Contributor on the SOURCE container, since it writes its own run manifest back into the
container it mirrors -- a live proving run confirmed Reader-only access lets the mirror step succeed
but fails writing that manifest. `restore-drill.mjs` is the one script here that genuinely only needs
Reader (it reads the manifest from Azure Blob and pulls the compare blob from S3, writing nothing back
to Azure). Grant each identity what its own script needs; do not copy one script's grant onto another.
The GitHub Actions schedule above is the live path today; that Container-Apps-Job move is optional
future work, not a gap in the current schedule.
