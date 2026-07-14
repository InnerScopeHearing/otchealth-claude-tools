#!/usr/bin/env node
// rebuild-and-repoint.mjs (2026-07-14) -- ONE command that kills the "rebuild the image, then manually
// re-pin 9 jobs" treadmill. It (1) rebuilds an ACR image from the current git HEAD headlessly (the
// same ARM `scheduleRun` DockerBuildRequest flow the fleet already uses -- no `az` CLI, no Docker
// daemon), then (2) shells to `drift-recon.mjs --apply`, which resolves the just-built :latest digest
// and repoints every STALE Container Apps Job to it via a targeted, identity-preserving PATCH.
//
// WHY this and not a self-hosted cron reconciler: a cron job would have to run under an identity with
// ARM job-write RBAC. The doc-indexer jobs run under id-otc-jobs-kv (a Key-Vault-reader), so a cron
// reconciler would require GRANTING that identity "Container Apps Jobs Contributor" -- an identity
// that can rewrite every job definition is a large blast radius -- and it would blindly adopt whatever
// :latest points at. The right fix is to make the DELIBERATE rebuild atomic with the repoint (this
// script), run from the operator/CTO context where azure-sp Owner already has ARM write. image-drift
// / drift-recon (report-only, in the nightly) remain the DETECTOR that catches any out-of-band drift.
//
// Usage:
//   node setup/rebuild-and-repoint.mjs [--repository doc-indexer] [--dockerfile <path>]
//     [--include-unpinned] [--no-repoint] [--dry]
//
// Auth: azure-sp via the shared kvSecret resolver (env fast-path, else Key Vault). Exit 0 on success.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { kvSecret } from "../skills/kb-memory/azure-secret.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const opt = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(n);
const SUB = process.env.AZURE_SUBSCRIPTION_ID || (await kvSecret("azure-subscription-id"));
const RG = opt("--resource-group", "otchealth-automation-rg");
const REGISTRY = opt("--registry", "otchealthacr");
const REPOSITORY = opt("--repository", "doc-indexer");
const DOCKERFILE = opt("--dockerfile", "skills/doc-indexer/job/Dockerfile");
const IMAGE = `${REPOSITORY}:latest`;
const AV = "2019-06-01-preview";
const base = `https://management.azure.com/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.ContainerRegistry/registries/${REGISTRY}`;

async function armToken() {
  let tid = process.env.AZURE_SP_TENANT_ID, cid = process.env.AZURE_SP_CLIENT_ID, sec = process.env.AZURE_SP_CLIENT_SECRET;
  if (!(tid && cid && sec)) { tid = tid || await kvSecret("azure-sp-tenant-id"); cid = cid || await kvSecret("azure-sp-client-id"); sec = sec || await kvSecret("azure-sp-client-secret"); }
  if (!(tid && cid && sec)) { console.error("[rebuild][FATAL] azure-sp creds unavailable (AZURE_SP_* env or Key Vault)."); process.exit(78); }
  const r = await fetch(`https://login.microsoftonline.com/${tid}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: cid, client_secret: sec, scope: "https://management.azure.com/.default" }) });
  const j = await r.json(); if (!j.access_token) { console.error("[rebuild][FATAL] no ARM token"); process.exit(1); } return j.access_token;
}

async function rebuild(tok) {
  const H = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
  const head = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  console.log(`[rebuild] ${IMAGE} from ${head.slice(0, 12)} via ${DOCKERFILE}`);
  // 1) upload URL
  const up = await (await fetch(`${base}/listBuildSourceUploadUrl?api-version=${AV}`, { method: "POST", headers: H })).json();
  if (!up.uploadUrl) { console.error(`[rebuild][FATAL] listBuildSourceUploadUrl: ${JSON.stringify(up).slice(0, 200)}`); process.exit(1); }
  // 2) git archive HEAD -> tar.gz -> PUT to the blob
  const tgz = `/tmp/rebuild-ctx-${head.slice(0, 8)}.tar.gz`;
  execFileSync("git", ["-C", ROOT, "archive", "--format=tar.gz", "-o", tgz, "HEAD"]);
  const buf = readFileSync(tgz);
  console.log(`[rebuild] context ${(buf.length / 1024 / 1024).toFixed(1)}MB -> uploading`);
  const putR = await fetch(up.uploadUrl, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": "application/gzip" }, body: buf });
  if (!putR.ok) { console.error(`[rebuild][FATAL] blob upload ${putR.status}`); process.exit(1); }
  // 3) scheduleRun DockerBuildRequest (push :latest + a git-sha tag so drift-recon can resolve it)
  const runReq = { type: "DockerBuildRequest", imageNames: [IMAGE, `${REPOSITORY}:${head.slice(0, 12)}`], isPushEnabled: true, dockerFilePath: DOCKERFILE, sourceLocation: up.relativePath, platform: { os: "Linux", architecture: "amd64" }, agentConfiguration: { cpu: 2 } };
  const sched = await fetch(`${base}/scheduleRun?api-version=${AV}`, { method: "POST", headers: H, body: JSON.stringify(runReq) });
  if (!sched.ok) { console.error(`[rebuild][FATAL] scheduleRun ${sched.status}: ${(await sched.text()).slice(0, 300)}`); process.exit(1); }
  const runId = (await sched.json()).properties?.runId;
  console.log(`[rebuild] scheduled runId=${runId}; polling...`);
  // 4) poll
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const s = await (await fetch(`${base}/runs/${runId}?api-version=${AV}`, { headers: H })).json();
    const st = s.properties?.status;
    if (["Succeeded", "Failed", "Canceled", "Error", "Timeout"].includes(st)) {
      const digest = (s.properties?.outputImages || []).find((o) => o.repository === REPOSITORY && o.tag === "latest")?.digest;
      console.log(`[rebuild] run ${runId} ${st}${digest ? ` -> ${digest.slice(0, 19)}...` : ""}`);
      if (st !== "Succeeded") process.exit(1);
      return digest;
    }
  }
  console.error("[rebuild][FATAL] build poll timeout"); process.exit(2);
}

const tok = await armToken();
if (flag("--dry")) {
  console.log("[rebuild-and-repoint] --dry: would rebuild the image, then run drift-recon.mjs --apply. Skipping the real build; showing the repoint plan against the CURRENT :latest:");
} else {
  await rebuild(tok);
}
if (flag("--no-repoint")) { console.log("[rebuild-and-repoint] --no-repoint: build done, skipping repoint."); process.exit(0); }
// Chain the reconciler: it resolves the (just-built) :latest digest from ACR runs and repoints STALE jobs.
const args = ["setup/drift-recon.mjs", "--apply", "--repository", REPOSITORY, "--rg-jobs", RG];
if (flag("--include-unpinned")) args.push("--include-unpinned");
if (flag("--dry")) args.push("--dry");
console.log(`[rebuild-and-repoint] -> node ${args.join(" ")}`);
try {
  execFileSync("node", args, { cwd: ROOT, stdio: "inherit" });
} catch (e) {
  console.error(`[rebuild-and-repoint] repoint step exited non-zero (${e.status}). Inspect the drift-recon output above.`);
  process.exit(e.status || 1);
}
console.log("[rebuild-and-repoint] DONE: image rebuilt + all doc-indexer jobs reconciled to the new digest.");
