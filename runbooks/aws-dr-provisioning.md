# AWS-native DR chain — provisioning + restore runbook

Status as of 2026-08-28: **code shipped, AWS resources NOT provisioned.** This build ran in a sandbox
with no AWS CLI and no admin AWS credentials, so every command below is paste-ready but has not been
executed. Nothing in this repo assumes it has been; every new/resurrected workflow stays
`workflow_dispatch`-only until a human runs the provisioning steps and re-arms the schedules (see each
workflow's own header for its exact gate). Matches the operator's standing preference for copy-paste
commands over UI navigation.

Ground truth this was built against: fleet master AWS account `900915535335`, region `us-east-1`,
secrets in SSM `/otchealth/*` (~455 params), the company brain on OpenSearch domain `otchealth-brain`,
`otchealth-pg` RDS with daily automated snapshots already running (since 2026-08-19 — Part 3's RDS
check covers a backup that already works; nothing to provision for it beyond the read role).

---

## Part 1 — SSM secrets export: bucket, KMS, OIDC role

```bash
# (a) Dedicated bucket, Object Lock ON (implies versioning), NO dots in the name (dots break
#     virtual-hosted TLS -- see skills/fleet-backup/s3-client.mjs's header).
aws s3api create-bucket --bucket otchealth-secrets-dr-900915535335 \
  --object-lock-enabled-for-bucket --region us-east-1

aws s3api put-public-access-block --bucket otchealth-secrets-dr-900915535335 \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# GOVERNANCE mode, not COMPLIANCE: compliance-mode retention is irrevocable even by root.
aws s3api put-object-lock-configuration --bucket otchealth-secrets-dr-900915535335 \
  --object-lock-configuration '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"GOVERNANCE","Days":30}}}'

aws s3api put-bucket-lifecycle-configuration --bucket otchealth-secrets-dr-900915535335 \
  --lifecycle-configuration '{"Rules":[
    {"ID":"expire-dailies","Status":"Enabled","Filter":{"Prefix":"secrets-dr/daily/"},"Expiration":{"Days":90},"NoncurrentVersionExpiration":{"NoncurrentDays":90}},
    {"ID":"expire-monthlies","Status":"Enabled","Filter":{"Prefix":"secrets-dr/monthly/"},"Expiration":{"Days":400}}]}'

# (b) KMS CMK for the ciphertext layer at rest.
aws kms create-key --description "otchealth secrets-dr SSE" --query KeyMetadata.KeyId --output text
aws kms create-alias --alias-name alias/otchealth-secrets-dr --target-key-id <keyid-from-above>

# The key SSM's own SecureStrings are encrypted under (needed for the ssm:Decrypt grant below) --
# resolve it, do not assume it is the AWS-managed alias/aws/ssm; some params may use a customer CMK.
aws kms describe-key --key-id alias/aws/ssm --query KeyMetadata.Arn --output text

# (c) GitHub OIDC provider (check first; create only if absent).
aws iam list-open-id-connect-providers
aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com   # only if the provider above does not already exist
```

Trust policy for role `otchealth-secrets-dr-export` (save as `trust-secrets-dr-export.json`):

```json
{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
  "Principal":{"Federated":"arn:aws:iam::900915535335:oidc-provider/token.actions.githubusercontent.com"},
  "Action":"sts:AssumeRoleWithWebIdentity",
  "Condition":{"StringEquals":{"token.actions.githubusercontent.com:aud":"sts.amazonaws.com"},
    "StringLike":{"token.actions.githubusercontent.com:sub":"repo:InnerScopeHearing/otchealth-claude-tools:ref:refs/heads/main"}}}]}
```

Permission policy (save as `policy-secrets-dr-export.json` — **includes the fix for a real first-run
bug**: `GetParametersByPath` on `/otchealth` authorizes against the exact PATH arn as well as the
wildcard, or the very first call is `AccessDenied`):

```json
{"Version":"2012-10-17","Statement":[
 {"Sid":"ReadSSM","Effect":"Allow",
  "Action":["ssm:GetParametersByPath","ssm:GetParameter","ssm:DescribeParameters"],
  "Resource":["arn:aws:ssm:us-east-1:900915535335:parameter/otchealth","arn:aws:ssm:us-east-1:900915535335:parameter/otchealth/*"]},
 {"Sid":"DecryptSSM","Effect":"Allow","Action":"kms:Decrypt",
  "Resource":"<the alias/aws/ssm ARN resolved above, or every customer CMK any /otchealth/* param uses>"},
 {"Sid":"WriteArchive","Effect":"Allow","Action":["s3:PutObject","s3:GetObject"],
  "Resource":"arn:aws:s3:::otchealth-secrets-dr-900915535335/secrets-dr/*"},
 {"Sid":"SseKms","Effect":"Allow","Action":["kms:GenerateDataKey","kms:Decrypt"],
  "Resource":"arn:aws:kms:us-east-1:900915535335:alias/otchealth-secrets-dr"},
 {"Sid":"WriteSsmPassphrase","Effect":"Allow","Action":"ssm:PutParameter",
  "Resource":"arn:aws:ssm:us-east-1:900915535335:parameter/otchealth/secrets-dr-passphrase"}]}
```

```bash
aws iam create-role --role-name otchealth-secrets-dr-export --assume-role-policy-document file://trust-secrets-dr-export.json
aws iam put-role-policy --role-name otchealth-secrets-dr-export --policy-name secrets-dr-export --policy-document file://policy-secrets-dr-export.json

# Bucket policy denying bypass/delete of the retention to everyone except the existing break-glass
# user (live-verified outside Key Vault, otchealth-cto PR #67 / FND-20260728-404d).
aws s3api put-bucket-policy --bucket otchealth-secrets-dr-900915535335 --policy '{
  "Version":"2012-10-17","Statement":[{"Sid":"DenyBypassAndDelete","Effect":"Deny",
    "NotPrincipal":{"AWS":"arn:aws:iam::900915535335:user/<break-glass-username>"},
    "Action":["s3:BypassGovernanceRetention","s3:DeleteObjectVersion"],
    "Resource":"arn:aws:s3:::otchealth-secrets-dr-900915535335/*"}]}'
```

Then in the `otchealth-claude-tools` repo settings: set repo Variable `AWS_SECRETS_DR_ROLE_ARN` to
`arn:aws:iam::900915535335:role/otchealth-secrets-dr-export` (or leave unset — the workflow already
defaults to this exact ARN). Run `.github/workflows/nightly-secrets-dr-export.yml` once via
`workflow_dispatch`, INTERACTIVELY watched (it mints and prints the DR passphrase the first time — see
`skills/fleet-backup/ssm-dr-export.mjs`'s header), save that passphrase in a password manager OUTSIDE
this AWS account, set it as the repo secret `SECRETS_DR_PASSPHRASE`, then uncomment the `schedule:`
block in that workflow.

**Break-glass credential (used by Part 4.A's restore procedure) also needs**, in addition to whatever
it already has: `s3:GetObject` + `s3:ListBucketVersions` on `otchealth-secrets-dr-900915535335`, and
`kms:Decrypt` on `alias/otchealth-secrets-dr` — add these to the existing break-glass user/role and
exercise them once as part of the first restore drill, or step A.1 in Part 4 below fails in a real
event.

---

## Part 2 — OpenSearch `otchealth-brain` off-domain snapshot

### 2.1 The role the DOMAIN assumes (`otchealth-brain-snapshot-role`)

```json
{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
  "Principal":{"Service":"es.amazonaws.com"},"Action":"sts:AssumeRole",
  "Condition":{"StringEquals":{"aws:SourceAccount":"900915535335"}}}]}
```

Permission policy — **scoped to `opensearch-snapshots/*` in the non-privileged bucket only**:

```json
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":"s3:ListBucket","Resource":"arn:aws:s3:::otchealth-brain-dr-55c84f6b",
  "Condition":{"StringLike":{"s3:prefix":"opensearch-snapshots/*"}}},
 {"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject"],
  "Resource":"arn:aws:s3:::otchealth-brain-dr-55c84f6b/opensearch-snapshots/*"}]}
```

```bash
aws iam create-role --role-name otchealth-brain-snapshot-role --assume-role-policy-document file://trust-brain-snapshot.json
aws iam put-role-policy --role-name otchealth-brain-snapshot-role --policy-name snapshot-s3 --policy-document file://policy-brain-snapshot-role.json
```

### 2.2 The admin identity that performs registration (`otchealth-brain-snapshot-admin`)

Registration is a SIGNED AWS request against the domain's data-plane endpoint, not a plain call — the
signing identity needs `es:ESHttpPut` on the domain **and** `iam:PassRole` on the role above.
`.github/workflows/aws-dr-opensearch-snapshot-admin.yml` assumes this role for every dispatched verb:

```json
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["es:ESHttpGet","es:ESHttpPut","es:ESHttpPost"],
  "Resource":"arn:aws:es:us-east-1:900915535335:domain/otchealth-brain/*"},
 {"Effect":"Allow","Action":"es:ESHttpDelete",
  "Resource":"arn:aws:es:us-east-1:900915535335:domain/otchealth-brain/drill-*"},
 {"Effect":"Allow","Action":"es:DescribeDomain","Resource":"arn:aws:es:us-east-1:900915535335:domain/otchealth-brain"},
 {"Effect":"Allow","Action":"iam:PassRole","Resource":"arn:aws:iam::900915535335:role/otchealth-brain-snapshot-role"}]}
```

**Before running `register`, check fine-grained access control (FGAC):**

```bash
aws opensearch describe-domain --domain-name otchealth-brain --query 'DomainStatus.AdvancedSecurityOptions.Enabled'
```

If `true`, the admin identity above must ALSO be mapped to the `manage_snapshots` OpenSearch
security-plugin role (`PUT _plugins/_security/api/rolesmapping/manage_snapshots` with this identity's
IAM ARN in `backend_roles`) or every snapshot call 403s even with IAM fully satisfied. This mapping
call needs its own FGAC-admin credential this build does not assume access to; do it once, out of
band, before the first `register` dispatch.

**Do not touch the domain's access policy** to fix a 403 here. `update-domain-config
--access-policies` REPLACES the whole document and would silently clobber the LIVE gateway's own
`brain_search` access (single-node domain, no multi-AZ — this is the biggest-cost live service in the
estate). If registration 403s and FGAC is off, the actual fix is almost always the IAM/PassRole grants
above, not the access policy.

### 2.3 Run it (via the dispatch-only admin workflow, or locally with the role's credentials)

```bash
node skills/fleet-backup/os-snapshot.mjs list-indices
node skills/fleet-backup/os-snapshot.mjs register --role-arn arn:aws:iam::900915535335:role/otchealth-brain-snapshot-role
node skills/fleet-backup/os-snapshot.mjs create-policy
node skills/fleet-backup/os-snapshot.mjs status
```

Watch the FIRST snapshot to `SUCCESS` manually (it is a full copy of every non-privileged index;
subsequent ones are incremental and fast) before trusting the nightly SM policy or arming the canary's
schedule.

### 2.4 Canary read-only role (`otchealth-aws-dr-canary`)

```json
{"Version":"2012-10-17","Statement":[
 {"Sid":"ReadSsmArchive","Effect":"Allow","Action":["s3:GetObject","s3:HeadObject"],
  "Resource":"arn:aws:s3:::otchealth-secrets-dr-900915535335/secrets-dr/daily/*"},
 {"Sid":"OsRead","Effect":"Allow","Action":"es:ESHttpGet","Resource":"arn:aws:es:us-east-1:900915535335:domain/otchealth-brain/*"},
 {"Sid":"OsDrillRestore","Effect":"Allow","Action":"es:ESHttpPost",
  "Resource":["arn:aws:es:us-east-1:900915535335:domain/otchealth-brain/_snapshot/*/_restore",
              "arn:aws:es:us-east-1:900915535335:domain/otchealth-brain/drill-*/_count",
              "arn:aws:es:us-east-1:900915535335:domain/otchealth-brain/*/_count"]},
 {"Sid":"OsDrillCleanup","Effect":"Allow","Action":"es:ESHttpDelete",
  "Resource":"arn:aws:es:us-east-1:900915535335:domain/otchealth-brain/drill-*"},
 {"Sid":"RdsRead","Effect":"Allow","Action":"rds:DescribeDBSnapshots","Resource":"*"},
 {"Sid":"ReadBrainFreshnessRooms","Effect":"Allow","Action":"s3:ListBucket",
  "Resource":"arn:aws:s3:::otchealth-brain-dr-55c84f6b",
  "Condition":{"StringLike":{"s3:prefix":["otchealthcommons/company-journal/*","otchealthcommerce/commerce-source-docs/*"]}}}]}
```

Note what is **deliberately absent**, per the design-review finding that caught the original draft
over-granting: no `s3:GetObject` on the OpenSearch snapshot bucket at all (freshness comes from the
domain's own `_cat/snapshots` API, never by reading raw segment files from S3), and the `ESHttpDelete`
grant is scoped to `drill-*` only, never a live index.

**`ReadBrainFreshnessRooms` (added 2026-08-29, for the per-room brain-freshness check that closes
`FND-20260828-3142`'s canary half):** this is a genuine widening, not something already covered — the
comment above ("no `s3:GetObject` on the OpenSearch snapshot bucket at all") describes a DIFFERENT
bucket used for a different purpose (OpenSearch's own snapshot storage, read only via `_cat/snapshots`,
never via S3 directly); `otchealth-brain-dr-55c84f6b` here is the bucket holding the actual SOURCE
DOCUMENTS for the `commons-company-journal` and `commerce-commerce-source-docs` rooms
(`skills/kb-memory/s3-blob.mjs`'s MIRROR table), which this check genuinely needs to list. `ListBucket`
only (never `GetObject`) — the check reads object name/size/`LastModified` from the listing response,
never an object's bytes — scoped via the `s3:prefix` condition to exactly the two non-privileged rooms'
prefixes, never the whole bucket (which also holds the three privileged rooms' source documents, per
that same MIRROR table). **No new OpenSearch grant is needed**: the pre-existing `OsDrillRestore`
statement's third resource, `.../otchealth-brain/*/_count`, is already a wildcard covering `_count` on
ANY index under the domain — including `commons-company-journal` and `commerce-commerce-source-docs` —
so this check's `_count` calls are already authorized by the grant the weekly restore drill already
needed. **Live-verified 2026-08-29 (see `skills/aws-dr-canary/SKILL.md`'s own Credentials section):** a
real run from an operator-seat credential (broader than this dedicated role) succeeded end-to-end
against both buckets/the domain, including a genuine positive path match, proving the check's logic is
correct — but that run did NOT confirm this specific role already has `ReadBrainFreshnessRooms`, since
it ran under a different credential. Add the statement above before assuming the nightly workflow's
brain-room checks will do more than report `ERROR` (never a false `OK`) for the two rooms.

---

## Part 3 — What is intentionally NOT covered here (read before assuming full coverage)

- **Privileged OpenSearch indices** (`legal-personal`, `legal-personal-memory`,
  `finance-cfo-source-docs`, `finance-cfo-memory`) have **no snapshot DR wired by this build**.
  `skills/fleet-backup/os-snapshot.mjs`'s `--lane personal-legal`/`--lane finance-legal` are a
  disarmed scaffold (see that file's header and `requirePrivilegedLaneConfirmation()`). Arming either
  lane means creating a new IAM role with write access to the ALREADY-ring-scoped
  `otchealth-legal-personal-dr` / `otchealth-finance-legal-dr` buckets, and this build has no way to
  independently confirm that role does not widen who can read that bucket's content — ground truth
  is explicit that nothing in this build may make that call unilaterally. **This is an open decision
  for Matt/CTO, not an oversight.**
- **No off-AWS-account copy of the OpenSearch snapshots.** Object Lock, KMS, and SSM's own encryption
  all die together with account `900915535335` if it is ever lost the way the prior Azure subscription
  was — that is the OBSERVED failure mode this fleet has already lived through once, not a tail risk.
  The SSM secrets leg gets a real off-account copy (Part 1's required-by-default OneDrive delivery
  leg in `ssm-dr-export.mjs`). The OpenSearch brain snapshot does not have an equivalent — a
  same-account S3 bucket is not an independent failure domain from the domain itself. A genuine
  off-account copy would mean either periodically exporting a subset of snapshot data out via
  `os-snapshot.mjs restore-drill`-style reads (expensive, partial), or cross-account S3 replication
  to a SEPARATE AWS account (a real, larger decision — a second account, its own billing/ownership,
  and a second target IAM surface — deliberately left to Matt rather than built speculatively here).
- **The pager can go silent exactly where it matters most.** `setup/page-on-failure.mjs` needs no
  code change for this chain (its `kvSecret()` calls already resolve via AWS SSM ambient credentials
  by default), but it is bootstrapped by the SAME `aws-actions/configure-aws-credentials` OIDC step as
  the rest of each workflow. If THAT step is what fails (a misconfigured trust policy, an expired
  OIDC provider thumbprint), no step after it runs at all — including the page-on-failure step — so a
  red run pages nobody through either of its own channels. The one backstop for this specific case is
  GitHub's own default repository failure-notification email, which this fleet has explicitly never
  treated as its paging channel (see `page-on-failure.mjs`'s own header: "easy to have muted/
  misrouted"). Recommend running the existing `.github/workflows/pager-selftest.yml` against each new
  workflow once real credentials are wired, to prove the NORMAL failure case pages correctly; the
  credentials-step-itself-fails case has no code fix in this build and should be a known, accepted gap
  or a follow-up decision.

---

## Part 4 — Restore runbook

**Inputs held outside this AWS account (the two break-glass items):** the SSM secrets-DR passphrase
(Matt's password manager) and the break-glass IAM credential (live-verified outside SSM,
`otchealth-cto` PR #67 / `FND-20260728-404d`, closed). Everything below is executable with only those
two plus a general AWS admin credential for the infra-recreation steps.

### A. Secrets (SSM lost/corrupted)

```bash
# 1. Pull the archive (break-glass creds). If today's is bad, versioned + Object-Lock history goes
#    back 90 days (list-object-versions).
aws s3api get-object --bucket otchealth-secrets-dr-900915535335 \
  --key secrets-dr/daily/ssm-otchealth-<date>.json.enc /tmp/a.enc

# 2. Decrypt + sanity-check names first (never --print-values on a shared/logged terminal).
SECRETS_DR_PASSPHRASE=... node skills/fleet-backup/secrets-dr-restore.mjs /tmp/a.enc

# 3. Dry-run the SSM restore plan (no writes, no AWS call at all).
SECRETS_DR_PASSPHRASE=... node skills/fleet-backup/secrets-dr-restore.mjs /tmp/a.enc --to-ssm --dry-run

# 4. Apply for real (per-parameter Type/Tier/KMS-KeyId restored faithfully when the archive carries
#    paramMeta; falls back to SecureString/Standard for an older archive or one exported with
#    restoreFidelity:"degraded" -- see ssm-dr-export.mjs's header).
SECRETS_DR_PASSPHRASE=... node skills/fleet-backup/secrets-dr-restore.mjs /tmp/a.enc --to-ssm
rm -f /tmp/a.enc
```

Verify: `aws ssm get-parameters-by-path --path /otchealth --recursive` count matches the archive's
count, then run one live consumer probe, e.g. `node setup/get-secret-aws.mjs tavily-api-key >/dev/null`.

### B. Brain (OpenSearch domain lost)

1. Create a replacement domain (same engine version; match current sizing).
2. Re-register the snapshot repo (Part 2.1(c)/2.2 above, same `role_arn` — add `"readonly": true`
   first if the old domain might still be writing to the same bucket).
3. `node skills/fleet-backup/os-snapshot.mjs status` → confirm the newest `SUCCESS` snapshot, then
   restore it in full (not the drill's single-index path): `POST _snapshot/<repo>/<snap>/_restore`
   with `{"indices":"*,-.opendistro*,-.opensearch*,-.kibana*,-.plugins*","include_global_state":false}`.
4. Verify per-index `_count` against the canary's last recorded healthy state, then repoint the
   gateway's `SEARCH_BACKEND`/OpenSearch host env and redeploy; live-verify `brain_search`.
5. Failback: never delete the old repo's contents until the new domain has taken its own first
   `SUCCESS` snapshot into the same repo.

### C. RDS (`otchealth-pg` lost)

Standard point-in-time/snapshot restore (already-provisioned automated snapshots, since 2026-08-19).
After restore, repoint the gateway's `STATE_BACKEND=postgres` connection param in SSM. If any role
surgery is needed post-restore, remember the fleet lesson: the RDS master is not a PG16 superuser —
`GRANT ... TO role; SET ROLE role;` is required before `ALTER DEFAULT PRIVILEGES` takes effect (see
`otchealth-claude-tools/CLAUDE.md`'s "Fleet-wide durable lessons" section).
