#!/usr/bin/env node
// resource-reconcile.mjs — A6-RESOURCE-CI (2026-07-05). Kills the "provision workflow written but
// never triggered" class: this exact incident already happened once (see git log / the original
// .github/workflows/provision-ring-memory-job.yml — a `workflow_dispatch`-only job creator that
// nobody clicked "Run workflow" on, so ring-memory-index-daily silently did NOT EXIST for weeks
// while heartbeat.mjs, drift-recon.mjs, and every doc referencing it assumed it did). The bug was
// never in the provisioning bash — it was that "I wrote a workflow that provisions X" was treated
// as equivalent to "X exists", with nothing in CI actually checking the second claim.
//
// This is deliberately the CI-checkable MINIMUM VIABLE version of the Azure Deployment Stacks idea
// (https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/deployment-stacks) — reconcile
// declared-vs-actual, NOT full stack lifecycle management. Deployment Stacks would additionally give
// you drift correction (re-apply to fix), deny-settings deletion protection, and a single deletable
// unit for an entire stack's resources; none of that is here. What IS here: a flat manifest of "every
// resource our code assumes is live" (setup/expected-resources.json) and a direct ARM GET per entry —
// 200 = exists, 404 = MISSING, anything else = ERROR (ambiguous, does not silently pass). That is
// enough to make "did the provisioning step actually run" a CI gate instead of a hope. If the team
// wants the stronger guarantees later (drift correction, deletion protection, atomic stack teardown),
// migrating this manifest's `resources[]` into a Bicep/ARM template and running
// `az stack {sub|group} create` is the documented upgrade path — not a rewrite, an upgrade.
//
// Auth: AZURE_SP_CLIENT_ID / AZURE_SP_CLIENT_SECRET / AZURE_SP_TENANT_ID via client_credentials —
// the same SP and the same dependency-free fetch-based ARM REST style as setup/heartbeat.mjs's
// armToken()/armLastExec() and setup/drift-recon.mjs's armToken()/arm(). No Azure SDK.
//
// Usage:
//   node setup/resource-reconcile.mjs [--json] [--manifest <file.json>] [--subscription <id>]
//
// Exit codes:
//   0  = every declared resource resolved (200 on its ARM GET).
//   3  = one or more declared resources are MISSING (404) or unresolvable by resource-group scope
//        (see --json output / "MISSING:" list) — this is the "provision workflow never ran" signal.
//   1  = unexpected error (bad manifest, etc).
//   78 = missing AZURE_SP_* creds (EX_CONFIG, matches this fleet's other ARM scripts' convention).
//
// What "exists" means per resource type (ARM api-versions match what heartbeat.mjs / drift-recon.mjs /
// deploy-gate-check.mjs already use elsewhere in this repo, kept consistent rather than picking new
// ones):
//   containerAppJob       GET .../resourceGroups/{rg}/providers/Microsoft.App/jobs/{name}
//   keyVault               GET .../resourceGroups/{rg}/providers/Microsoft.KeyVault/vaults/{name}
//   containerRegistry      GET .../resourceGroups/{rg}/providers/Microsoft.ContainerRegistry/registries/{name}
//   userAssignedIdentity   GET .../resourceGroups/{rg}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/{name}
//   storageAccount         GET .../resourceGroups/{rg}/providers/Microsoft.Storage/storageAccounts/{name}
//                          (if resourceGroup is null in the manifest, falls back to a subscription-wide
//                          Resource Graph-free search via Microsoft.Storage/storageAccounts LIST and
//                          matching by name — slower, but doesn't require guessing the RG)
//   cosmosAccount          GET .../resourceGroups/{rg}/providers/Microsoft.DocumentDB/databaseAccounts/{name}
//                          (same subscription-wide fallback as storageAccount if resourceGroup is null)
//
// A GET that returns 200 is "exists". A GET that returns 404 is "MISSING". Any other status (403,
// 401, 5xx, network error) is reported as ERROR, not folded into either bucket — an ambiguous answer
// must never look like a clean pass.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_MANIFEST_PATH = path.join(__dirname, "expected-resources.json");
const ARM_API = {
  containerAppJob: "2024-03-01",
  keyVault: "2022-07-01",
  containerRegistry: "2022-02-01-preview",
  userAssignedIdentity: "2023-01-31",
  storageAccount: "2023-01-01",
  cosmosAccount: "2023-11-15",
};
const PROVIDER_PATH = {
  containerAppJob: (rg, name) => `resourceGroups/${rg}/providers/Microsoft.App/jobs/${name}`,
  keyVault: (rg, name) => `resourceGroups/${rg}/providers/Microsoft.KeyVault/vaults/${name}`,
  containerRegistry: (rg, name) => `resourceGroups/${rg}/providers/Microsoft.ContainerRegistry/registries/${name}`,
  userAssignedIdentity: (rg, name) => `resourceGroups/${rg}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${name}`,
  storageAccount: (rg, name) => `resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/${name}`,
  cosmosAccount: (rg, name) => `resourceGroups/${rg}/providers/Microsoft.DocumentDB/databaseAccounts/${name}`,
};
// Subscription-wide LIST endpoints used when a manifest entry has resourceGroup: null (we don't want
// to guess an RG and silently report MISSING just because we guessed wrong — see storageAccount/
// cosmosAccount notes in expected-resources.json where the RG is genuinely unconfirmed).
const SUBSCRIPTION_LIST_PATH = {
  storageAccount: () => `providers/Microsoft.Storage/storageAccounts`,
  cosmosAccount: () => `providers/Microsoft.DocumentDB/databaseAccounts`,
};

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def; };

if (flag("--help") || flag("-h")) {
  console.log(`Usage: node setup/resource-reconcile.mjs [--json] [--manifest <file.json>] [--subscription <id>]

Checks every resource declared in the manifest (default: setup/expected-resources.json) via a direct
ARM GET (or, when resourceGroup is null, a subscription-wide LIST + name match). Reports exactly which
declared resources are MISSING (404) vs ERROR (ambiguous status) vs OK (200).

Env (required): AZURE_SP_CLIENT_ID, AZURE_SP_CLIENT_SECRET, AZURE_SP_TENANT_ID
Env (optional): AZURE_SUBSCRIPTION_ID (fallback for --subscription / manifest.subscriptionId)

Exit codes: 0 = all declared resources exist. 3 = one or more MISSING/ERROR. 1 = unexpected error.
            78 = AZURE_SP_* not set.`);
  process.exit(0);
}

async function armToken() {
  const tenant = process.env.AZURE_SP_TENANT_ID, cid = process.env.AZURE_SP_CLIENT_ID, csec = process.env.AZURE_SP_CLIENT_SECRET;
  if (!tenant || !cid || !csec) { console.error("[resource-reconcile][FATAL] AZURE_SP_CLIENT_ID / AZURE_SP_CLIENT_SECRET / AZURE_SP_TENANT_ID must all be set."); process.exit(78); }
  const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: cid, client_secret: csec, scope: "https://management.azure.com/.default" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) { console.error("[resource-reconcile][FATAL] no ARM token: " + JSON.stringify(j).slice(0, 200)); process.exit(1); }
  return j.access_token;
}

/** Direct ARM GET on a single resource. Returns { status } for 200/404; throws only on network-level
 *  failure so the caller can distinguish "confirmed absent" from "couldn't ask". */
async function armGet(tok, sub, relPath, apiVersion) {
  const url = `https://management.azure.com/subscriptions/${sub}/${relPath}?api-version=${apiVersion}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
  let body = null;
  try { body = await r.json(); } catch { /* not all bodies are JSON (e.g. some 404s) */ }
  return { status: r.status, ok: r.status === 200, body };
}

/** Subscription-wide LIST + name match, for manifest entries with resourceGroup: null. Follows
 *  nextLink same as drift-recon.mjs's listJobs() paging fix. */
async function armFindByNameAcrossSub(tok, sub, listRelPath, apiVersion, name) {
  let url = `https://management.azure.com/subscriptions/${sub}/${listRelPath}?api-version=${apiVersion}`;
  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) return { status: r.status, ok: false, body: null };
    const j = await r.json().catch(() => ({}));
    const hit = (j.value || []).find((v) => v.name === name);
    if (hit) return { status: 200, ok: true, body: hit };
    url = j.nextLink || null;
  }
  return { status: 404, ok: false, body: null };
}

function loadManifest(manifestPath) {
  if (!existsSync(manifestPath)) throw new Error(`manifest not found: ${manifestPath}`);
  const raw = readFileSync(manifestPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.resources)) throw new Error(`manifest ${manifestPath} must have a "resources" array`);
  for (const r of parsed.resources) {
    if (!r.name || !r.type) throw new Error(`manifest entry missing name/type: ${JSON.stringify(r)}`);
    if (!PROVIDER_PATH[r.type]) throw new Error(`manifest entry ${r.name} has unknown type "${r.type}" (known: ${Object.keys(PROVIDER_PATH).join(", ")})`);
  }
  return parsed;
}

async function main() {
  const manifestArg = opt("--manifest", null);
  const manifestPath = manifestArg
    ? (path.isAbsolute(manifestArg) ? manifestArg : path.join(REPO_ROOT, manifestArg))
    : DEFAULT_MANIFEST_PATH;

  let manifest;
  try {
    manifest = loadManifest(manifestPath);
  } catch (e) {
    console.error(`[resource-reconcile][FATAL] ${e.message}`);
    process.exit(1);
  }

  const sub = opt("--subscription", null) || process.env.AZURE_SUBSCRIPTION_ID || manifest.subscriptionId;
  if (!sub) { console.error("[resource-reconcile][FATAL] no subscription id (pass --subscription, set AZURE_SUBSCRIPTION_ID, or set subscriptionId in the manifest)."); process.exit(1); }

  const tok = await armToken();

  const rows = [];
  for (const r of manifest.resources) {
    const entry = { name: r.name, type: r.type, resourceGroup: r.resourceGroup ?? null, source: r.source || null, note: r.note || null };
    try {
      let result;
      if (r.resourceGroup) {
        const relPath = PROVIDER_PATH[r.type](r.resourceGroup, r.name);
        result = await armGet(tok, sub, relPath, ARM_API[r.type]);
      } else if (SUBSCRIPTION_LIST_PATH[r.type]) {
        result = await armFindByNameAcrossSub(tok, sub, SUBSCRIPTION_LIST_PATH[r.type](), ARM_API[r.type], r.name);
      } else {
        entry.status = "ERROR";
        entry.detail = `resourceGroup is null in manifest and type "${r.type}" has no subscription-wide list fallback — cannot check without an RG.`;
        rows.push(entry);
        continue;
      }
      if (result.status === 200) { entry.status = "OK"; }
      else if (result.status === 404) { entry.status = "MISSING"; }
      else { entry.status = "ERROR"; entry.detail = `ARM GET returned HTTP ${result.status} (ambiguous — not a confirmed 200 or 404; check SP permissions / rg name).`; }
      entry.httpStatus = result.status;
    } catch (e) {
      entry.status = "ERROR";
      entry.detail = `request failed: ${e.message}`;
    }
    rows.push(entry);
  }

  const missing = rows.filter((r) => r.status === "MISSING");
  const errored = rows.filter((r) => r.status === "ERROR");
  const ok = rows.filter((r) => r.status === "OK");

  if (flag("--json")) {
    console.log(JSON.stringify({ subscriptionId: sub, manifest: manifestPath, checked: rows.length, ok: ok.length, missing: missing.length, errored: errored.length, resources: rows }, null, 2));
  } else {
    console.log(`# RESOURCE-RECONCILE — ${rows.length} declared resource(s) checked against subscription ${sub}`);
    for (const r of rows) {
      const tag = r.status === "OK" ? "OK     " : r.status === "MISSING" ? "MISSING" : "ERROR  ";
      const loc = r.resourceGroup ? `rg=${r.resourceGroup}` : "(subscription-wide lookup)";
      console.log(`[${tag}] ${r.type.padEnd(20)} ${r.name.padEnd(28)} ${loc}${r.detail ? `  -- ${r.detail}` : ""}`);
    }
    if (missing.length) {
      console.log(`\nMISSING: ${missing.map((r) => `${r.name} (${r.type}${r.resourceGroup ? `, rg ${r.resourceGroup}` : ""})`).join(", ")}`);
      console.log(`These are declared in ${path.relative(REPO_ROOT, manifestPath)} as resources the fleet's code assumes exist, but the ARM GET came back 404. If a provisioning workflow is supposed to create one of these, confirm it actually RAN (not just that it was written/merged) — this is the exact class of bug this script exists to catch.`);
    }
    if (errored.length) {
      console.log(`\nERROR (ambiguous, not confirmed missing OR present): ${errored.map((r) => r.name).join(", ")} — re-run, or check SP RBAC / resource-group names before trusting a clean result.`);
    }
    if (!missing.length && !errored.length) {
      console.log(`\nAll ${ok.length} declared resource(s) exist.`);
    }
  }

  process.exit((missing.length || errored.length) ? 3 : 0);
}

main().catch((e) => {
  console.error(`[resource-reconcile] FATAL (uncaught): ${e.stack || e.message}`);
  process.exit(1);
});
