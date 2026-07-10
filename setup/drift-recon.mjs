#!/usr/bin/env node
// drift-recon.mjs — P0 stability (2026-07-05). Complements image-drift.mjs: that script only catches
// MUTABLE tags (":latest" instead of "@sha256:..."). This script catches the gap it can't see — a job
// that IS pinned to an immutable @sha256 digest, but that digest is STALE vs. what main currently builds
// (someone rebuilt+repinned by hand 3 weeks ago and every fix/feature landed on main since is silently
// missing). Nightly-alongside-image-drift, report-only, never blocks. ARM via AZURE_SP_* (client_credentials),
// same SP already used everywhere else in this fleet. Dependency-free (fetch + node builtins only).
//
// "Latest built digest" source: the ACR `runs` API via ARM —
//   GET /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.ContainerRegistry/registries/{reg}/runs?api-version=2019-06-01-preview
// Each successful QuickRun/DockerBuildRequest run already carries `properties.outputImages[]`, which
// includes the {repository, tag, digest} for every tag the build pushed (this fleet's build script,
// /tmp/di_build.mjs / azure-acrbuild*.mjs, always tags builds "doc-indexer:latest" + a git-sha tag, so
// the digest that landed under tag "latest" on the most recent Succeeded run IS the latest-main digest).
// This reuses the exact ARM SP credential + REST style already established by heartbeat.mjs's armLastExec
// and image-drift.mjs's arm() helper -- no separate ACR-specific bearer-token/OAuth2 flow needed. The
// registry data-plane API (GET https://{reg}.azurecr.io/v2/{repo}/manifests/latest) was considered but
// requires a second, ACR-scoped token exchange this fleet doesn't otherwise use; the ARM `runs` list this
// fleet ALREADY calls to kick off builds (see di_build.mjs's scheduleRun) gives the same answer for free.
//
// Usage:
//   node setup/drift-recon.mjs [--json] [--strict]
//     [--subscription <id>] [--resource-group <rg>] [--registry <name>] [--repository <repo>]
//     [--jobs job1,job2,...]     # override the doc-indexer-family job list entirely
//     [--rg-jobs <rg>]           # resource group to scan for jobs (default: same as --resource-group)
//
// Exit codes: 0 = report (default, always unless --strict); 3 = STALE pin(s) found AND --strict;
// 1 = unexpected error; 78 = missing config/creds (EX_CONFIG, matches image-drift.mjs's convention).

const TEN = process.env.AZURE_SP_TENANT_ID, CID = process.env.AZURE_SP_CLIENT_ID, CSEC = process.env.AZURE_SP_CLIENT_SECRET;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def; };

// Defaults reflect this fleet's live topology as of 2026-07-05 (confirmed via ARM query against the
// otchealth-automation-rg jobs list — 9 Container Apps Jobs currently share the doc-indexer image family:
// daily-digest, librarian-finance, librarian-commerce, librarian-legal-company, librarian-legal-personal,
// brain-reindex, deep-finance, deep-legal-company, deep-legal-personal). The roadmap item referenced "13"
// jobs; if the fleet has since grown back to 13 (or beyond), pass --jobs explicitly or rely on the
// automatic image-based discovery below (any job in the target RG whose image repository matches
// --repository is included even if not in DEFAULT_JOBS) rather than trusting a hardcoded count.
const DEFAULT_SUB = process.env.AZURE_SUBSCRIPTION_ID || "55c84f6b-ef90-4259-a58b-50835cc4cab4";
const DEFAULT_RG = "otchealth-automation-rg";
const DEFAULT_REGISTRY = "otchealthacr";
const DEFAULT_REPOSITORY = "doc-indexer";
const DEFAULT_JOBS = [
  "daily-digest", "librarian-finance", "librarian-commerce", "librarian-legal-company",
  "librarian-legal-personal", "brain-reindex", "deep-finance", "deep-legal-company", "deep-legal-personal",
];

const SUB = opt("--subscription", DEFAULT_SUB);
const RG = opt("--resource-group", DEFAULT_RG);
const JOBS_RG = opt("--rg-jobs", RG);
const REGISTRY = opt("--registry", DEFAULT_REGISTRY);
const REPOSITORY = opt("--repository", DEFAULT_REPOSITORY);
const JOBS_OVERRIDE = opt("--jobs", null);
const EXPLICIT_JOBS = JOBS_OVERRIDE ? JOBS_OVERRIDE.split(",").map((s) => s.trim()).filter(Boolean) : null;

async function armToken() {
  if (!TEN || !CID || !CSEC) { console.error("[drift-recon][FATAL] AZURE_SP_* not set."); process.exit(78); }
  const r = await fetch(`https://login.microsoftonline.com/${TEN}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: CID, client_secret: CSEC, scope: "https://management.azure.com/.default" }),
  });
  const j = await r.json();
  if (!j.access_token) { console.error("[drift-recon][FATAL] no ARM token: " + JSON.stringify(j).slice(0, 200)); process.exit(1); }
  return j.access_token;
}
async function arm(tok, path) {
  const r = await fetch(`https://management.azure.com${path}`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) return { value: [], _status: r.status };
  return r.json();
}

const digestOf = (img) => { const m = /@sha256:([0-9a-f]{64})/.exec(img || ""); return m ? "sha256:" + m[1] : null; };
const daysAgo = (iso) => { if (!iso) return null; const ms = Date.now() - Date.parse(iso); return ms >= 0 ? Math.floor(ms / 86400000) : null; };

// Find the digest ACR currently serves under `:latest` for REPOSITORY, using the ARM `runs` list API
// (this fleet's build script already talks to this exact endpoint to kick off builds — see
// /tmp/di_build.mjs's scheduleRun). We scan recent runs (newest-first, API default order) for the first
// Succeeded run whose outputImages include repository:REPOSITORY tag:"latest", and take its digest.
async function latestDigestFromAcrRuns(tok) {
  const path = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.ContainerRegistry/registries/${REGISTRY}/runs?api-version=2019-06-01-preview&$top=50`;
  const runs = await arm(tok, path);
  if (runs._status) { console.error(`[drift-recon][FATAL] ACR runs API returned HTTP ${runs._status} (check registry name/RG/SP permissions).`); process.exit(78); }
  for (const run of (runs.value || [])) {
    const p = run.properties || {};
    if (p.status !== "Succeeded") continue;
    const hit = (p.outputImages || []).find((o) => o.repository === REPOSITORY && o.tag === "latest");
    if (hit) return { digest: hit.digest, runId: p.runId || run.name, finishTime: p.finishTime || p.lastUpdatedTime };
  }
  return null;
}

// FIX (found live, 2026-07-05): the jobs list is a PAGED ARM response (nextLink) once a resource
// group has enough resources — this RG has 20+ jobs (doc-indexer family + pg-* one-shot migration
// jobs), which is enough to trigger a second page. The original single-request version silently
// missed every job past page 1 (ring-memory-index-daily, signal-radar, decision-clock,
// memory-librarian all landed on page 2 and were wrongly reported NO-JOB). Follow nextLink fully.
async function listJobs(tok) {
  const out = [];
  let url = `https://management.azure.com/subscriptions/${SUB}/resourceGroups/${JOBS_RG}/providers/Microsoft.App/jobs?api-version=2024-03-01`;
  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) break;
    const j = await r.json();
    out.push(...(j.value || []));
    url = j.nextLink || null;
  }
  return out;
}

(async () => {
  const tok = await armToken();

  const latest = await latestDigestFromAcrRuns(tok);
  if (!latest) { console.error(`[drift-recon][FATAL] no Succeeded ACR run found tagging ${REPOSITORY}:latest — cannot determine current digest.`); process.exit(78); }
  const latestDigest = latest.digest;

  const allJobs = await listJobs(tok);
  const byName = new Map(allJobs.map((j) => [j.name, j]));

  // Job selection: explicit --jobs wins; otherwise start from DEFAULT_JOBS but also pick up any live job
  // in JOBS_RG whose image repository matches REPOSITORY that isn't already in the list (fleet may have
  // grown/shrunk since these defaults were captured).
  let names;
  if (EXPLICIT_JOBS) {
    names = EXPLICIT_JOBS;
  } else {
    const discovered = allJobs
      .filter((j) => (j.properties?.template?.containers?.[0]?.image || "").includes(`/${REPOSITORY}`))
      .map((j) => j.name);
    names = [...new Set([...DEFAULT_JOBS, ...discovered])];
  }

  const rows = [];
  for (const name of names) {
    const j = byName.get(name);
    if (!j) { rows.push({ name, found: false, status: "NO-JOB" }); continue; }
    const img = j.properties?.template?.containers?.[0]?.image || "";
    const pinnedDigest = digestOf(img);
    const lastModifiedAt = j.systemData?.lastModifiedAt || null;
    const ageDays = daysAgo(lastModifiedAt);
    if (!pinnedDigest) {
      rows.push({ name, found: true, status: "UNPINNED", img, ageDays, lastModifiedAt });
    } else if (pinnedDigest === latestDigest) {
      rows.push({ name, found: true, status: "CURRENT", img, digest: pinnedDigest, ageDays, lastModifiedAt });
    } else {
      rows.push({ name, found: true, status: "STALE", img, digest: pinnedDigest, latestDigest, ageDays, lastModifiedAt });
    }
  }

  const stale = rows.filter((r) => r.status === "STALE");
  const unpinned = rows.filter((r) => r.status === "UNPINNED");
  const missing = rows.filter((r) => r.status === "NO-JOB");

  if (flag("--json")) {
    console.log(JSON.stringify({ registry: REGISTRY, repository: REPOSITORY, latestDigest, latestRunId: latest.runId, latestBuildTime: latest.finishTime, jobs: rows }, null, 2));
  } else {
    console.log(`# DRIFT-RECON — ${REPOSITORY}:latest = ${latestDigest.slice(0, 19)}... (run ${latest.runId}, built ${latest.finishTime}); ${rows.length} job(s) checked, ${stale.length} STALE`);
    for (const r of rows) {
      const tag = r.status === "STALE" ? "STALE " : r.status === "CURRENT" ? "CURRENT" : r.status === "UNPINNED" ? "DRIFT " : "NO-JOB ";
      const age = r.ageDays == null ? "" : ` (pin ~${r.ageDays}d old)`;
      console.log(`[${tag}] job ${r.name.padEnd(28)} ${r.status.padEnd(8)}${age}`);
    }
    if (stale.length) {
      console.log(`\nSTALE (pinned digest != current ${REPOSITORY}:latest — missing everything landed on main since the pin): ${stale.map((r) => r.name).join(", ")}`);
      console.log(`Remediation: run the rebuild+re-pin script (di_build.mjs / the ACR scheduleRun build flow) against main, then re-pin these jobs' image to the new @sha256 digest.`);
    }
    if (unpinned.length) console.log(`\nUNPINNED (no @sha256 digest at all — image-drift.mjs should also be flagging these): ${unpinned.map((r) => r.name).join(", ")}`);
    if (missing.length) console.log(`\nNOT FOUND in ${JOBS_RG} (removed/renamed?): ${missing.map((r) => r.name).join(", ")}`);
  }

  process.exit(flag("--strict") && stale.length ? 3 : 0);
})().catch((e) => { console.error("[drift-recon] ERROR: " + e.message); process.exit(1); });
