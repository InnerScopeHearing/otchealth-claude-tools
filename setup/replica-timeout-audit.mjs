#!/usr/bin/env node
// replica-timeout-audit.mjs — A7-IDEMPOTENT-JOBS (report-only half). Queries every Container Apps
// Job in the fleet via ARM and reports each job's current `properties.configuration.replicaTimeout`
// (seconds) and `properties.configuration.replicaRetryLimit`, flagging:
//   - retryLimit === 0            -> a hung/killed run never retries at all (real risk: a transient
//                                    blip — OOM, 429 storm, a killed node — permanently drops that run
//                                    until the next scheduled tick, silently, unless something else
//                                    (heartbeat.mjs) is watching).
//   - replicaTimeout > 3600s      -> "verify this is intentional for a long job". We do NOT assert
//                                    this is wrong: several jobs in this fleet ARE legitimately long
//                                    (deep-pass with a --max-minutes budget, memory-librarian across
//                                    many agent-days). Flagged for a human to confirm the number
//                                    matches the job's actual expected runtime, not asserted as a bug.
//   - replicaTimeout looks unset/default -> ARM's own default (if the job was created without an
//                                    explicit value) is 1800s; a job that has clearly never had this
//                                    tuned (still sitting on exactly the ARM default) is flagged
//                                    informationally so it can be reviewed alongside the >3600s cases.
//
// This is the report-only counterpart to skills/*/*.mjs idempotency review (see
// docs/idempotency-audit-2026-07-05.md for that half) — the roadmap item A7-IDEMPOTENT-JOBS bundles
// "idempotent job design" (code review, not automatable) with "tuned replicaTimeout/retry" (this
// script, which IS automatable: it just reads current ARM state and flags outliers).
//
// ARM auth + pagination: reuses the exact client_credentials + paginated-nextLink pattern from
// setup/drift-recon.mjs's armToken()/listJobs() (that script's listJobs() had a real bug — a single
// GET silently missed every job past page 1 once the RG had 20+ resources — fixed 2026-07-05 to
// follow nextLink fully; this script follows nextLink fully too, from the start, so it does not
// reintroduce that bug). Dependency-free (fetch + node builtins only), same AZURE_SP_* env vars used
// throughout this repo.
//
// This fleet's jobs span TWO resource groups (see setup/heartbeat-registry.json):
//   otchealth-automation-rg   (doc-indexer family, kb-memory, ledger-compaction, signal-radar, ...)
//   rg-otchealth-apps-prod    (docintel-ocr-sweep, os-* monitors, xero-*, token-keeper)
// Both are scanned by default; pass --rg-jobs to override with a single RG, or --all-rgs=false to
// scan only the primary one.
//
// Usage:
//   node setup/replica-timeout-audit.mjs [--json] [--strict]
//     [--subscription <id>] [--resource-group <rg> ...]  (repeatable; default: both known RGs)
//
// Exit codes: 0 = report (default, always unless --strict); 3 = one or more flags raised AND
// --strict; 1 = unexpected error; 78 = missing config/creds (EX_CONFIG, matches this repo's
// drift-recon.mjs / image-drift.mjs convention).

const TEN = process.env.AZURE_SP_TENANT_ID, CID = process.env.AZURE_SP_CLIENT_ID, CSEC = process.env.AZURE_SP_CLIENT_SECRET;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const optAll = (name) => argv.reduce((acc, a, i) => { if (a === name && argv[i + 1] !== undefined) acc.push(argv[i + 1]); return acc; }, []);
const opt = (name, def) => { const v = optAll(name); return v.length ? v[v.length - 1] : def; };

// Defaults reflect this fleet's live topology per setup/heartbeat-registry.json (2026-07-05): jobs
// are split across two resource groups. Both are scanned unless --resource-group is passed explicitly
// (repeatable flag), in which case only the given RG(s) are scanned.
const DEFAULT_SUB = process.env.AZURE_SUBSCRIPTION_ID || "55c84f6b-ef90-4259-a58b-50835cc4cab4";
const DEFAULT_RGS = ["otchealth-automation-rg", "rg-otchealth-apps-prod"];

const SUB = opt("--subscription", DEFAULT_SUB);
const RG_OVERRIDE = optAll("--resource-group");
const RGS = RG_OVERRIDE.length ? RG_OVERRIDE : DEFAULT_RGS;

// ARM's own default replicaTimeout when a job is created without specifying one explicitly.
// (Confirms via Microsoft.App/jobs docs; NOT asserted here as "correct" — just used to flag jobs
// that look like they were never tuned at all, which is informational, distinct from the >3600s flag.)
const ARM_DEFAULT_REPLICA_TIMEOUT = 1800;
const LONG_JOB_THRESHOLD_SECONDS = 3600;

async function armToken() {
  if (!TEN || !CID || !CSEC) { console.error("[replica-timeout-audit][FATAL] AZURE_SP_* not set."); process.exit(78); }
  const r = await fetch(`https://login.microsoftonline.com/${TEN}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: CID, client_secret: CSEC, scope: "https://management.azure.com/.default" }),
  });
  const j = await r.json();
  if (!j.access_token) { console.error("[replica-timeout-audit][FATAL] no ARM token: " + JSON.stringify(j).slice(0, 200)); process.exit(1); }
  return j.access_token;
}

// Follow nextLink fully — this is the exact bug drift-recon.mjs had (single-request version
// silently dropped every job past page 1 once an RG had 20+ resources). Do not reintroduce it.
async function listJobsInRg(tok, rg) {
  const out = [];
  let url = `https://management.azure.com/subscriptions/${SUB}/resourceGroups/${rg}/providers/Microsoft.App/jobs?api-version=2024-03-01`;
  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) {
      console.error(`[replica-timeout-audit][WARN] GET jobs in ${rg} -> HTTP ${r.status}; stopping pagination for this RG.`);
      break;
    }
    const j = await r.json();
    out.push(...(j.value || []).map((job) => ({ ...job, _rg: rg })));
    url = j.nextLink || null;
  }
  return out;
}

async function listAllJobs(tok) {
  const out = [];
  for (const rg of RGS) out.push(...(await listJobsInRg(tok, rg)));
  return out;
}

function auditJob(j) {
  const cfg = j.properties?.configuration || {};
  const replicaTimeout = cfg.replicaTimeout;
  const replicaRetryLimit = cfg.replicaRetryLimit;
  const triggerType = cfg.triggerType || j.properties?.configuration?.triggerType || "unknown";
  const cron = cfg.scheduleTriggerConfig?.cronExpression || null;

  const flags = [];
  if (replicaRetryLimit === 0) {
    flags.push({ code: "RETRY_ZERO", severity: "warn", msg: "replicaRetryLimit=0 — a hung/killed run never retries; a transient failure silently drops that execution until the next scheduled tick." });
  }
  if (typeof replicaTimeout === "number" && replicaTimeout > LONG_JOB_THRESHOLD_SECONDS) {
    flags.push({ code: "TIMEOUT_LONG", severity: "info", msg: `replicaTimeout=${replicaTimeout}s (> ${LONG_JOB_THRESHOLD_SECONDS}s) — verify this is intentional for a long-running job, not left unset/default-huge.` });
  }
  if (typeof replicaTimeout === "number" && replicaTimeout === ARM_DEFAULT_REPLICA_TIMEOUT) {
    flags.push({ code: "TIMEOUT_DEFAULT", severity: "info", msg: `replicaTimeout=${replicaTimeout}s matches the ARM platform default exactly — likely never explicitly tuned for this job; confirm ${replicaTimeout}s is enough (or intentionally chosen) rather than an oversight.` });
  }
  if (replicaTimeout == null) {
    flags.push({ code: "TIMEOUT_MISSING", severity: "warn", msg: "replicaTimeout is absent from the ARM response entirely (unexpected — every job should carry this field); treat as unverified." });
  }
  if (replicaRetryLimit == null) {
    flags.push({ code: "RETRY_MISSING", severity: "warn", msg: "replicaRetryLimit is absent from the ARM response entirely (unexpected); treat as unverified." });
  }

  return {
    name: j.name,
    resourceGroup: j._rg,
    triggerType,
    cron,
    replicaTimeout: replicaTimeout ?? null,
    replicaRetryLimit: replicaRetryLimit ?? null,
    flags,
  };
}

(async () => {
  const tok = await armToken();
  const allJobs = await listAllJobs(tok);
  if (!allJobs.length) {
    console.error(`[replica-timeout-audit][FATAL] no jobs found across RG(s): ${RGS.join(", ")}. Check --resource-group / SP permissions.`);
    process.exit(78);
  }

  const rows = allJobs.map(auditJob).sort((a, b) => a.name.localeCompare(b.name));
  const withFlags = rows.filter((r) => r.flags.length > 0);
  const retryZero = rows.filter((r) => r.flags.some((f) => f.code === "RETRY_ZERO"));
  const longTimeout = rows.filter((r) => r.flags.some((f) => f.code === "TIMEOUT_LONG"));
  const defaultTimeout = rows.filter((r) => r.flags.some((f) => f.code === "TIMEOUT_DEFAULT"));
  const missingFields = rows.filter((r) => r.flags.some((f) => f.code === "TIMEOUT_MISSING" || f.code === "RETRY_MISSING"));

  if (flag("--json")) {
    console.log(JSON.stringify({
      subscription: SUB,
      resourceGroups: RGS,
      generatedAt: new Date().toISOString(),
      jobCount: rows.length,
      flaggedCount: withFlags.length,
      jobs: rows,
    }, null, 2));
  } else {
    console.log(`# REPLICA-TIMEOUT-AUDIT — ${rows.length} job(s) across [${RGS.join(", ")}]; ${withFlags.length} flagged`);
    console.log("");
    for (const r of rows) {
      const rt = r.replicaTimeout == null ? "MISSING" : `${r.replicaTimeout}s`;
      const rl = r.replicaRetryLimit == null ? "MISSING" : String(r.replicaRetryLimit);
      const marker = r.flags.length ? (r.flags.some((f) => f.severity === "warn") ? "WARN" : "INFO") : "OK  ";
      console.log(`[${marker}] ${r.name.padEnd(28)} rg=${r.resourceGroup.padEnd(24)} timeout=${rt.padEnd(9)} retryLimit=${rl}`);
      for (const f of r.flags) console.log(`       - (${f.code}) ${f.msg}`);
    }
    console.log("");
    if (retryZero.length) console.log(`RETRY_ZERO (${retryZero.length}): ${retryZero.map((r) => r.name).join(", ")}`);
    if (longTimeout.length) console.log(`TIMEOUT_LONG > ${LONG_JOB_THRESHOLD_SECONDS}s (${longTimeout.length}, verify intentional): ${longTimeout.map((r) => r.name).join(", ")}`);
    if (defaultTimeout.length) console.log(`TIMEOUT_DEFAULT (== ARM's ${ARM_DEFAULT_REPLICA_TIMEOUT}s default, likely untuned) (${defaultTimeout.length}): ${defaultTimeout.map((r) => r.name).join(", ")}`);
    if (missingFields.length) console.log(`MISSING FIELDS (unexpected ARM shape) (${missingFields.length}): ${missingFields.map((r) => r.name).join(", ")}`);
    if (!withFlags.length) console.log("No flags raised.");
    console.log("\nThis script is report-only: it does not change any job's configuration. See docs/idempotency-audit-2026-07-05.md for the accompanying code-review half of A7-IDEMPOTENT-JOBS.");
  }

  process.exit(flag("--strict") && withFlags.length ? 3 : 0);
})().catch((e) => { console.error("[replica-timeout-audit] ERROR: " + e.message); process.exit(1); });
