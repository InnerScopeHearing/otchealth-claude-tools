#!/usr/bin/env node
/**
 * pg-dump.mjs — closes the AI-OS Azure-loss DR plan's gap #9: Flatstick's and FourVault's production
 * Azure Database for PostgreSQL databases (`otchealth-nonphi-pg-cus1`, databases `flatstick` and
 * `fourvault`) have NO off-Azure backup today. See otchealth-cto/runbooks/AZURE-LOSS-DR-PLAN.md, gap #9,
 * for the full finding: Azure's own point-in-time-restore (if enabled) lives inside Azure and does not
 * survive a total Azure loss — the exact scenario this fixes. This is a `pg_dump`-to-S3 job, per that
 * gap's own prescribed fix ("an automated pg_dump-to-S3 job... MANDATORY off-Azure, not optional").
 *
 * ARCHITECTURE (a deliberate departure from a naive "GitHub Actions runner talks straight to Postgres"
 * design — see the network-reachability finding below, which forced this):
 *
 *   1. THIS SCRIPT (runs from GitHub Actions, or any seat with AZURE_SP_* / az-CLI creds and outbound
 *      HTTPS — it never itself opens a socket to Postgres) creates/updates ONE Azure Container Apps Job
 *      resource (`pg-dump-nonphi`, Manual trigger, image `postgres:16` straight from Docker Hub — the
 *      OFFICIAL Postgres image, which already ships `pg_dump`/`psql`, so no custom image build is
 *      needed) via ARM, mints a short-lived Azure Blob SAS + resolves DB credentials, PUTs those in as
 *      job secrets, starts ONE execution, and polls it to completion.
 *   2. The JOB ITSELF (running INSIDE Azure, on the SAME `otchealth-jobs-env` Container Apps environment
 *      the original Neon->Azure migration jobs already used — see otchealth-cto/runbooks/
 *      azure-migration-runbook.md, 2026-06-17 — reachable to the Postgres server via the server's
 *      existing `AllowAllAzureServices` firewall rule, confirmed live via ARM, see below) does the
 *      actual work: bootstrap (idempotent) a dedicated LEAST-PRIVILEGE read-only role, `pg_dump` each
 *      database, gzip it, and PUT the result to Azure Blob container `ledger-backup` (the SAME container
 *      skills/fleet-backup/backup.mjs already writes to) under a `pg-dumps/` prefix.
 *   3. Reaching S3 from there is FREE: skills/fleet-backup/s3-mirror.mjs already lists the ENTIRE
 *      `ledger-backup` container, classifies every blob it finds (privileged vs not — see its own
 *      README), and mirrors non-privileged blobs to S3 on its existing nightly schedule. `pg-dumps/
 *      flatstick-<date>.sql.gz` and `pg-dumps/fourvault-<date>.sql.gz` do not match ANY of
 *      s3-mirror.mjs's PRIVILEGED_SUBSTRINGS (legal-personal, legal-company, cfo, finance-, -personal,
 *      medreview, phi — see tests/pg-dump-not-privileged.test.mjs, which pins this as a regression
 *      guard against a future rename accidentally reclassifying these), and s3-mirror.mjs needs ZERO
 *      code changes to pick them up: it computes sha256 from whatever bytes it downloads for any blob
 *      it does not already have a manifest-recorded hash for, which is exactly the case for a brand new
 *      artifact type like this. Likewise restore-drill.mjs needs zero changes to prove these specific
 *      blobs round-trip: it drills EVERY blob s3-mirror.mjs's own manifest recorded as mirrored.
 *      .github/workflows/pg-dump-to-s3.yml (the scheduled caller of this script) runs this script, THEN
 *      s3-mirror.mjs, THEN restore-drill.mjs, THEN one pg_dump-specific content-shape check (item 4 of
 *      the task this closes — "verify it's non-empty and gunzips cleanly and looks like real SQL"),
 *      reusing all of that existing, already-scheduled, already-tested machinery instead of duplicating
 *      an S3 upload path a second time in this file.
 *
 * WHY NOT A PLAIN GITHUB ACTIONS WORKFLOW TALKING DIRECTLY TO POSTGRES (the design this replaces, and
 * why — read before "simplifying" this back to a direct connection):
 *   LIVE-VERIFIED this session, both independently: (a) this repo's own cloud sandbox cannot open a TCP
 *   connection to the Postgres server on :5432 at all (`cat < /dev/null > /dev/tcp/<host>/5432` times
 *   out; the SAME host on :443 connects immediately — confirms it is a targeted egress block, not a DNS
 *   or host problem), matching the exact finding
 *   otchealth-cto/runbooks/azure-migration-runbook.md already recorded for the original 2026-06-17
 *   migration ("the CTO sandbox network policy BLOCKS outbound :5432 (only :443 egress)... ALL Postgres
 *   work runs from INSIDE Azure as Container Apps Jobs"); (b) a live ARM query against the server's
 *   firewall rules (`otchealth-nonphi-pg-cus1`) shows exactly TWO rules: a single named IP
 *   (`sandbox-gcp`, a leftover from that same 2026-06-17 migration session, not this one, and not a
 *   GitHub Actions IP) and `AllowAllAzureServices` — an Azure-internal-only allowance, NOT "allow the
 *   public internet." A plain `ubuntu-latest` GitHub Actions runner is neither of those, so it would be
 *   REJECTED by the server's firewall exactly like this sandbox is, unless the firewall were widened to
 *   allow arbitrary public IPs (GitHub-hosted runners have no fixed, publishable IP range) — a real
 *   security downgrade on a server holding Flatstick's financial data and FourVault's COPPA-relevant kid/
 *   parent data that this design deliberately avoids. Running the dump from an Azure Container Apps Job
 *   instead needs ZERO firewall change (AllowAllAzureServices already covers it) and matches the
 *   established, already-proven fleet pattern for Postgres work — see the ARCHITECTURE note above.
 *
 * LEAST PRIVILEGE (task item 5): rather than settling for the admin credential (`azure-pg-nonphi-admin-
 * *`, superuser-equivalent) OR reusing an application's own read/write runtime role (`flatstick_app` /
 * `fourvault_app`, which the app itself uses for INSERT/UPDATE/DELETE), this script bootstraps a
 * DEDICATED, READ-ONLY role, `backup_ro` — LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION,
 * granted only the built-in Postgres 14+ predefined role `pg_read_all_data` (SELECT on every table/view/
 * sequence, USAGE on every schema — no ability to write anything) plus explicit CONNECT on both target
 * databases. The bootstrap (CREATE ROLE if missing / ALTER ROLE to refresh the password if it already
 * exists, then the GRANTs, all idempotent — safe to re-run every night) runs INSIDE the same Container
 * Apps Job execution, using the admin credential ONLY ephemerally inside that one Azure-internal job run
 * — the admin credential is never used for the dump itself, and never leaves Azure. The generated
 * `backup_ro` password is stored in Key Vault (`azure-pg-nonphi-dumpro-password`) so it persists across
 * runs instead of being rotated (and re-granted, which is harmless but unnecessary) every single night.
 *
 * REQUIRED SECRETS (Key Vault, kv-otc-55c84f6bef by default — this script also self-provisions two of
 * them the FIRST time it runs, storing what it generates/fetches so later runs reuse it):
 *   azure-pg-nonphi-server              FQDN of the Postgres Flexible Server (already existed)
 *   azure-pg-nonphi-admin-user / -password   admin creds, used ONLY inside the ephemeral job execution
 *                                        to bootstrap backup_ro (already existed)
 *   azure-subscription-id               (already existed)
 *   azure-pg-nonphi-dumpro-password     generated + stored by THIS script on first run if absent
 *   azure-backup-storage-key            the `stotc55c84f6bef` storage account key, used to mint a
 *                                        short-lived write SAS for the job to PUT its dump into
 *                                        `ledger-backup`. FETCHED via ARM `listKeys` and STORED here on
 *                                        first run if the secret is not already present (self-serve —
 *                                        this account has no existing "the key lives at secret X"
 *                                        convention anywhere in this repo; see the header comment on
 *                                        buildAccountSas() below for why an account-key SAS was chosen
 *                                        over reusing the AAD-bearer path azure-blob-client.mjs already
 *                                        has — that path only works for a caller WITH an AAD identity,
 *                                        which the stock `postgres:16` container does not have).
 *
 * REQUIRED ENV (non-secret): AZURE_SP_CLIENT_ID / AZURE_SP_CLIENT_SECRET / AZURE_SP_TENANT_ID (mints
 * BOTH the Key Vault token, via kvSecret()'s own SP fallback, AND a separate management.azure.com token
 * this file mints itself — kvSecret()'s token helpers are hardcoded to the vault.azure.net resource, so
 * they cannot be reused for ARM calls; see armToken() below).
 *   BACKUP_STORAGE_ACCOUNT   default stotc55c84f6bef (same account backup.mjs / s3-mirror.mjs use)
 *   BACKUP_CONTAINER         default "ledger-backup"
 *   PG_DUMP_RG               default otchealth-automation-rg (same RG the original pg-migrate-* jobs live in)
 *   PG_DUMP_ENV_ID           default the otchealth-jobs-env managed environment ARM id (same one the
 *                            original pg-migrate-* jobs already use — read live via ARM if unset, so a
 *                            hardcoded id never drifts out of sync with the real resource)
 *   PG_DUMP_DATABASES        default "flatstick,fourvault" — comma-separated list of database names on
 *                            the nonphi server to dump. Adding a third database (e.g. once Companion
 *                            cuts over per azure-migration-runbook.md) is a one-line env change, no code
 *                            change and no new job resource.
 *
 * USAGE:
 *   node pg-dump.mjs run            # ensure the job, mint fresh creds/SAS, start + poll one execution,
 *                                    # verify each expected blob landed in Azure Blob (size + gzip +
 *                                    # "PostgreSQL database dump" header sanity check)
 *   node pg-dump.mjs selftest        # no writes: reports Key Vault + ARM + source-account reachability
 *
 * INERT-SAFE: if the base Postgres secrets (`azure-pg-nonphi-server`, `azure-pg-nonphi-admin-user`,
 * `azure-pg-nonphi-admin-password`, `azure-subscription-id`) are not all present, this prints a clear
 * message and exits 0 — matches this skill directory's established fail-open convention (s3-mirror.mjs,
 * restore-drill.mjs) for "a prerequisite was never provisioned" vs. a real bug.
 */

import crypto from "node:crypto";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { kvSecret, kvSecretSet } from "../kb-memory/azure-secret.mjs";
import { listBlobs, getBlob } from "./azure-blob-client.mjs";

const DEFAULT_ACCOUNT = "stotc55c84f6bef";
const DEFAULT_CONTAINER = "ledger-backup";
const DEFAULT_RG = "otchealth-automation-rg";
const JOB_NAME = "pg-dump-nonphi";
// NOT "pg_dump_ro" -- Postgres reserves every role/database/tablespace name starting with "pg_" for
// system use and refuses to create one (confirmed live, 2026-08-04: "role name \"pg_dump_ro\" is
// reserved... Role names starting with \"pg_\" are reserved"). Found by an actual failed run, not by
// inspection -- see pg-dump.mjs's header for why a live proof run matters even for a detail like this.
const ROLE = "backup_ro";

// ---------- pure helpers (unit-tested directly, tests/pg-dump-pure.test.mjs) ----------

/** The blob name convention this script writes and s3-mirror.mjs/restore-drill.mjs pick up generically.
 *  Exported so tests can pin it, and so the not-privileged regression guard (tests/
 *  pg-dump-not-privileged.test.mjs) checks the EXACT string this script actually produces, not a
 *  hand-copied literal that could silently drift out of sync with the real code. */
export function pgDumpBlobName(dbName, dateStamp) {
  return `pg-dumps/${dbName}-${dateStamp}.sql.gz`;
}

export function todayStamp(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Build an Azure Storage ACCOUNT SAS (covers every container/blob on the account — matches
 *  setup/heartbeat.mjs's buildSas() exactly, a proven, already-in-production STS construction; copied
 *  rather than imported to keep this file dependency-free of setup/heartbeat.mjs, which is a CLI tool,
 *  not a library). An ACCOUNT SAS (not a container- or blob-scoped SERVICE SAS) is used deliberately:
 *  the stock `postgres:16` container has no Azure SDK and no AAD identity, only `curl`, so it needs a
 *  single opaque query-string it can append to any blob URL — the account-key-signed account SAS gives
 *  that with a single HMAC computation here, no per-blob signing loop needed. Scoped to the minimum
 *  permission this job needs: `sp: "cw"` (create + write only — no read, no delete, no list) so a
 *  leaked/logged SAS could at most overwrite a blob it can already name, never exfiltrate or destroy
 *  anything else in the account. `now` is injectable for deterministic unit tests. */
export function buildAccountSas(account, keyBase64, permission, minutesValid, now = new Date()) {
  const sv = "2021-12-02", ss = "b", srt = "co";
  const st = new Date(now.getTime() - 5 * 60_000).toISOString().slice(0, 19) + "Z"; // 5min clock-skew slack, matches heartbeat.mjs
  const se = new Date(now.getTime() + minutesValid * 60_000).toISOString().slice(0, 19) + "Z";
  const stringToSign = [account, permission, ss, srt, st, se, "", "https", sv, ""].join("\n") + "\n";
  const sig = crypto.createHmac("sha256", Buffer.from(keyBase64, "base64")).update(stringToSign, "utf8").digest("base64");
  return new URLSearchParams({ sv, ss, srt, sp: permission, st, se, spr: "https", sig }).toString();
}

/** Postgres does not support `CREATE ROLE IF NOT EXISTS`, so the bootstrap is a DO block that checks
 *  pg_roles first. Pure string builder (no network) so the exact SQL shape is unit-tested directly —
 *  the load-bearing property being tested is "the generated password never appears unescaped in a way
 *  that could break out of the single-quoted literal" (a defense-in-depth check; the password itself is
 *  generated by this script as lowercase hex, see randomHexPassword() below, which can never contain a
 *  single quote, but the SQL-builder is tested independently of that guarantee holding). */
export function bootstrapRoleSql(role, password, databases) {
  const escaped = password.replace(/'/g, "''");
  const grants = databases.map((db) => `GRANT CONNECT ON DATABASE ${quoteIdent(db)} TO ${quoteIdent(role)};`).join("\n");
  return [
    `DO $do$ BEGIN`,
    `  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN`,
    `    CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD '${escaped}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;`,
    `  ELSE`,
    `    ALTER ROLE ${quoteIdent(role)} WITH LOGIN PASSWORD '${escaped}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;`,
    `  END IF;`,
    `END $do$;`,
    `GRANT pg_read_all_data TO ${quoteIdent(role)};`,
    grants,
  ].join("\n");
}

/** Postgres identifier quoting: double-quote and escape embedded double-quotes. Only ever called with
 *  fixed, hardcoded strings (the role name constant and the configured database-name list) in this
 *  file, never with user input, but quoting defensively costs nothing and avoids a class of bug if a
 *  database name is ever changed to something with a special character. */
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** A cryptographically random, SQL-literal-safe password: hex never needs escaping and never collides
 *  with shell-quoting rules either (this password also gets interpolated into a POSIX shell script as
 *  an env-var-derived string — hex has zero shell metacharacters, so no injection surface there either,
 *  a second reason hex was chosen over a full print­able-ASCII password generator). */
export function randomHexPassword(bytes = 24) {
  return crypto.randomBytes(bytes).toString("hex");
}

/** Sanity-check a gunzipped pg_dump: does it actually look like a Postgres dump, not junk or a partial/
 *  truncated write? A real `pg_dump` plain-text (-Fp, the default) output ALWAYS starts with this exact
 *  banner comment. Pure (given a Buffer) so it's unit-tested with a real small fixture, no live network
 *  needed — see tests/pg-dump-pure.test.mjs. */
export function looksLikePgDumpSql(gunzippedBuf) {
  const head = gunzippedBuf.subarray(0, 4096).toString("utf8");
  return head.includes("-- PostgreSQL database dump") || head.includes("-- Dumped from database version");
}

/** Build the ARM PUT body for the pg-dump-nonphi Container Apps Job. Pure (no network) — given every
 *  resolved value as a parameter, this returns the exact request body, so the ARM-shape logic is
 *  unit-tested directly without live Azure credentials (tests/pg-dump-pure.test.mjs). See the file
 *  header for why this uses the stock `postgres:16` Docker Hub image with an overridden command rather
 *  than a custom-built image. */
export function buildJobTemplate({ location, environmentId, host, databases, dateStamp }) {
  const dbList = databases.join(" ");
  // NOTE on escaping: every `\${NAME}` below is a JS template-literal ESCAPE (backslash-dollar-brace),
  // producing the LITERAL text `${NAME}` in the generated shell script — a real POSIX shell variable
  // reference, resolved when the container runs, not a JS interpolation. The few bare `${ROLE}` /
  // `${dbList}` references (no backslash) ARE real JS interpolations, baking this file's own constants
  // (the fixed role name, the configured database list) into the script text at BUILD time. Mixing the
  // two deliberately and consistently: build-time constants get real interpolation, runtime/secret
  // values always get the escaped (literal shell-variable) form, so no secret value ever needs to flow
  // through this JS builder itself.
  const script = [
    `exec > /tmp/log.txt 2>&1`,
    `uplog(){ curl -s -X PUT -H "x-ms-blob-type: BlockBlob" --data-binary @/tmp/log.txt "\${AZURE_BLOB_BASE}/pg-dumps%2Frun-log-\${DATE}.txt?\${AZURE_SAS_QS}" >/dev/null 2>&1 || true; }`,
    `trap uplog EXIT`,
    `apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq curl ca-certificates >/dev/null 2>&1 || true`,
    `set -e`,
    `psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -tAc "SELECT 'admin_ok'"`,
    `psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "$ROLE_SQL"`,
    `for DB in ${dbList}; do`,
    `  URL="postgresql://${ROLE}:\${DUMPRO_PASS}@\${PGHOST}:5432/\${DB}?sslmode=require"`,
    `  echo "dumping $DB..."`,
    `  pg_dump --no-owner --no-acl "$URL" | gzip -9 > /tmp/\${DB}.sql.gz`,
    `  SZ=$(stat -c%s /tmp/\${DB}.sql.gz)`,
    `  SHA=$(sha256sum /tmp/\${DB}.sql.gz | cut -d' ' -f1)`,
    `  echo "RESULT db=$DB bytes=$SZ sha256=$SHA"`,
    `  curl -sf -X PUT -H "x-ms-blob-type: BlockBlob" --data-binary "@/tmp/\${DB}.sql.gz" "\${AZURE_BLOB_BASE}/pg-dumps%2F\${DB}-\${DATE}.sql.gz?\${AZURE_SAS_QS}"`,
    `done`,
    `echo PG_DUMP_OK`,
  ].join("\n");

  return {
    location,
    properties: {
      environmentId,
      configuration: {
        triggerType: "Manual",
        replicaTimeout: 1800,
        replicaRetryLimit: 0,
        manualTriggerConfig: { replicaCompletionCount: 1, parallelism: 1 },
        // secrets are intentionally NOT set here — this builder is pure (no secret material ever
        // passes through it); the caller (run(), below) attaches the real
        // admin-url/role-sql/dumpro-pass/blob-base/sas-qs secret values to
        // body.properties.configuration.secrets right before the ARM PUT.
      },
      template: {
        containers: [
          {
            image: "postgres:16",
            name: "pgdump",
            command: ["/bin/sh", "-c"],
            args: [script],
            env: [
              { name: "ADMIN_URL", secretRef: "admin-url" },
              { name: "ROLE_SQL", secretRef: "role-sql" },
              { name: "DUMPRO_PASS", secretRef: "dumpro-pass" },
              { name: "PGHOST", value: host },
              { name: "AZURE_BLOB_BASE", secretRef: "blob-base" },
              { name: "AZURE_SAS_QS", secretRef: "sas-qs" },
              { name: "DATE", value: dateStamp },
            ],
            resources: { cpu: 0.5, memory: "1Gi", ephemeralStorage: "2Gi" },
          },
        ],
      },
    },
  };
}

// ---------- ARM auth (management.azure.com — a DIFFERENT resource than kvSecret()'s vault.azure.net
// tokens, so it cannot reuse that helper's token cache; see file header) ----------
async function armToken() {
  const tenant = process.env.AZURE_SP_TENANT_ID, cid = process.env.AZURE_SP_CLIENT_ID, csec = process.env.AZURE_SP_CLIENT_SECRET;
  if (!tenant || !cid || !csec) return null;
  const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: cid, client_secret: csec, scope: "https://management.azure.com/.default" }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.access_token || null;
}

async function armFetch(tok, url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`ARM ${opts.method || "GET"} ${url} failed: ${r.status} ${(await r.text()).slice(0, 500)}`);
  return r.status === 204 ? null : r.json();
}

async function resolveEnvironmentId(tok, sub, rg) {
  if (process.env.PG_DUMP_ENV_ID) return process.env.PG_DUMP_ENV_ID;
  // reuse whatever environment the original pg-migrate-* jobs already run on, read live so this never
  // drifts from the real resource (see file header)
  const j = await armFetch(tok, `https://management.azure.com/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.App/jobs/pg-migrate-flatstick?api-version=2024-03-01`);
  return j.properties.environmentId;
}

async function ensureDumproPassword() {
  const existing = await kvSecret("azure-pg-nonphi-dumpro-password");
  if (existing) return existing;
  const fresh = randomHexPassword();
  const ok = await kvSecretSet("azure-pg-nonphi-dumpro-password", fresh);
  if (!ok) throw new Error("could not persist azure-pg-nonphi-dumpro-password to Key Vault");
  console.log("[pg-dump] generated + stored a new azure-pg-nonphi-dumpro-password (first run).");
  return fresh;
}

async function ensureBackupStorageKey(tok, sub) {
  const existing = await kvSecret("azure-backup-storage-key");
  if (existing) return existing;
  const account = process.env.BACKUP_STORAGE_ACCOUNT || DEFAULT_ACCOUNT;
  // find the account's resource group live (do not hardcode it — a second self-provisioning script
  // hardcoding an RG that later drifts is exactly the class of bug this whole file's design tries to
  // avoid elsewhere)
  const list = await armFetch(tok, `https://management.azure.com/subscriptions/${sub}/providers/Microsoft.Storage/storageAccounts?api-version=2023-01-01`);
  const acct = (list.value || []).find((a) => a.name === account);
  if (!acct) throw new Error(`storage account ${account} not found in subscription ${sub}`);
  const rg = acct.id.split("/")[4];
  const keys = await armFetch(tok, `https://management.azure.com/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/${account}/listKeys?api-version=2023-01-01`, { method: "POST" });
  const key = keys.keys && keys.keys[0] && keys.keys[0].value;
  if (!key) throw new Error(`listKeys returned no key for ${account}`);
  const ok = await kvSecretSet("azure-backup-storage-key", key);
  if (!ok) throw new Error("could not persist azure-backup-storage-key to Key Vault");
  console.log(`[pg-dump] fetched + stored azure-backup-storage-key for ${account} via ARM listKeys (first run).`);
  return key;
}

async function pollExecution(tok, sub, rg, jobName, execName, { timeoutMs = 5 * 60_000, intervalMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const j = await armFetch(tok, `https://management.azure.com/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.App/jobs/${jobName}/executions/${execName}?api-version=2024-03-01`);
    const status = j.properties && j.properties.status;
    if (status === "Succeeded" || status === "Failed") return status;
    if (Date.now() > deadline) throw new Error(`execution ${execName} did not finish within ${timeoutMs}ms (last status: ${status})`);
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}

async function run() {
  const account = process.env.BACKUP_STORAGE_ACCOUNT || DEFAULT_ACCOUNT;
  const container = process.env.BACKUP_CONTAINER || DEFAULT_CONTAINER;
  const rg = process.env.PG_DUMP_RG || DEFAULT_RG;
  const databases = (process.env.PG_DUMP_DATABASES || "flatstick,fourvault").split(",").map((s) => s.trim()).filter(Boolean);

  const [host, adminUser, adminPass, sub] = await Promise.all([
    kvSecret("azure-pg-nonphi-server"),
    kvSecret("azure-pg-nonphi-admin-user"),
    kvSecret("azure-pg-nonphi-admin-password"),
    kvSecret("azure-subscription-id"),
  ]);
  const missing = [];
  if (!host) missing.push("azure-pg-nonphi-server");
  if (!adminUser) missing.push("azure-pg-nonphi-admin-user");
  if (!adminPass) missing.push("azure-pg-nonphi-admin-password");
  if (!sub) missing.push("azure-subscription-id");
  if (missing.length) {
    console.log(`[pg-dump] required Postgres secret(s) not provisioned (${missing.join(", ")}) -- nothing to dump.`);
    process.exit(0);
  }

  const tok = await armToken();
  if (!tok) {
    console.error("[FATAL] could not mint a management.azure.com token (AZURE_SP_CLIENT_ID/SECRET/TENANT_ID not set or rejected).");
    process.exit(78);
  }

  const [dumproPass, storageKey, environmentId] = await Promise.all([
    ensureDumproPassword(),
    ensureBackupStorageKey(tok, sub),
    resolveEnvironmentId(tok, sub, rg),
  ]);

  const dateStamp = todayStamp();
  const sasQs = buildAccountSas(account, storageKey, "cw", 45); // create+write only, 45min window
  const blobBase = `https://${account}.blob.core.windows.net/${container}`;
  const adminUrl = `postgresql://${encodeURIComponent(adminUser)}:${encodeURIComponent(adminPass)}@${host}:5432/postgres?sslmode=require`;
  const roleSql = bootstrapRoleSql(ROLE, dumproPass, databases);

  const body = buildJobTemplate({ location: "West US 2", environmentId, host, databases, dateStamp, sasQs, blobBase });
  body.properties.configuration.secrets = [
    { name: "admin-url", value: adminUrl },
    { name: "role-sql", value: roleSql },
    { name: "dumpro-pass", value: dumproPass },
    { name: "blob-base", value: blobBase },
    { name: "sas-qs", value: sasQs },
  ];

  console.log(`[pg-dump] ensuring job ${JOB_NAME} in ${rg} (databases: ${databases.join(", ")}) ...`);
  await armFetch(tok, `https://management.azure.com/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.App/jobs/${JOB_NAME}?api-version=2024-03-01`, {
    method: "PUT",
    body: JSON.stringify(body),
  });

  console.log(`[pg-dump] starting execution ...`);
  const startResp = await armFetch(tok, `https://management.azure.com/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.App/jobs/${JOB_NAME}/start?api-version=2024-03-01`, { method: "POST" });
  const execName = startResp.name;
  console.log(`[pg-dump] execution ${execName} started, polling ...`);
  const status = await pollExecution(tok, sub, rg, JOB_NAME, execName);
  console.log(`[pg-dump] execution ${execName} finished: ${status}`);
  if (status !== "Succeeded") {
    console.error(`::error::[pg-dump] job execution ${execName} did not succeed (status: ${status}). Check the run log blob pg-dumps/run-log-${dateStamp}.txt in ${container}/${account} for detail.`);
    process.exit(1);
  }

  console.log(`[pg-dump] verifying blob(s) landed in ${container}/${account} ...`);
  const blobs = await listBlobs(account, container);
  const byName = new Map(blobs.map((b) => [b.name, b]));
  const results = [];
  let anyFailed = false;
  for (const db of databases) {
    const name = pgDumpBlobName(db, dateStamp);
    const meta = byName.get(name);
    if (!meta) {
      console.error(`::error::[pg-dump] expected blob ${name} not found after a Succeeded execution.`);
      results.push({ db, blob: name, ok: false, reason: "blob not found" });
      anyFailed = true;
      continue;
    }
    const buf = await getBlob(account, container, name);
    let ok = buf.length > 0;
    let reason = ok ? null : "0 bytes";
    let looksReal = false;
    if (ok) {
      try {
        looksReal = looksLikePgDumpSql(gunzipSync(buf));
        if (!looksReal) { ok = false; reason = "gunzipped content does not look like a pg_dump (missing the standard banner comment)"; }
      } catch (e) {
        ok = false; reason = `gunzip failed: ${e.message}`;
      }
    }
    console.log(`[pg-dump] ${db}: blob=${name} bytes=${buf.length} looksLikePgDump=${looksReal} -> ${ok ? "OK" : "FAIL (" + reason + ")"}`);
    results.push({ db, blob: name, bytes: buf.length, ok, reason });
    if (!ok) anyFailed = true;
  }

  console.log(JSON.stringify({ ts: new Date().toISOString(), dateStamp, databases, results }, null, 2));
  if (anyFailed) {
    console.error("::error::[pg-dump] one or more database dumps failed verification. See results above.");
    process.exit(1);
  }
  console.log("[pg-dump] all database dumps verified present, non-empty, and gzip/SQL-shape-valid in Azure Blob. s3-mirror.mjs picks these up on its own run (same container, no code change needed there).");
}

async function selftest() {
  const report = {};
  const [host, adminUser, adminPass, sub] = await Promise.all([
    kvSecret("azure-pg-nonphi-server"),
    kvSecret("azure-pg-nonphi-admin-user"),
    kvSecret("azure-pg-nonphi-admin-password"),
    kvSecret("azure-subscription-id"),
  ]);
  report.pgSecretsProvisioned = Boolean(host && adminUser && adminPass && sub);
  report.pgSecretsMissing = [!host && "azure-pg-nonphi-server", !adminUser && "azure-pg-nonphi-admin-user", !adminPass && "azure-pg-nonphi-admin-password", !sub && "azure-subscription-id"].filter(Boolean);
  const tok = await armToken();
  report.armTokenMinted = Boolean(tok);
  report.dumproPasswordProvisioned = Boolean(await kvSecret("azure-pg-nonphi-dumpro-password"));
  report.backupStorageKeyProvisioned = Boolean(await kvSecret("azure-backup-storage-key"));
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cmd = process.argv[2] || "run";
  if (cmd === "selftest") {
    selftest().catch((e) => { console.error("ERR", e.message); process.exit(1); });
  } else if (cmd === "run") {
    run().catch((e) => { console.error("ERR", e.message); process.exit(1); });
  } else {
    console.error("usage: node pg-dump.mjs run | selftest");
    process.exit(2);
  }
}
