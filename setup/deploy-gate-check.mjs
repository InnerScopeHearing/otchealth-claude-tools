#!/usr/bin/env node
// deploy-gate-check.mjs — pre-flight GATE for doc-indexer image rebuild / re-pin rollouts
// (the "rebuild image, re-pin all ~13 Container Apps Jobs" routine this fleet runs regularly,
// see /tmp/a3_rollout.mjs, /tmp/repin.mjs for the ad-hoc scripts that actually do the re-pin PUTs).
//
// This script does NOT change anything. It only verifies, before you kick off a rollout, that the
// three things a doc-indexer job needs at runtime are actually true RIGHT NOW:
//
//   1. The shared user-assigned managed identity (id-otc-jobs-kv by default) still holds an ACTIVE
//      "Key Vault Secrets User" RBAC role assignment scoped at the vault (kv-otc-55c84f6bef).
//   2. The SAME identity still holds an ACTIVE "AcrPull" RBAC role assignment scoped at the
//      container registry (otchealthacr) — needed to pull the freshly-rebuilt image.
//   3. For every job entrypoint file you pass in, every secret NAME that file's code actually asks
//      Key Vault for (via kvSecret("...") / requireSecrets([...]) calls — see
//      skills/kb-memory/azure-secret.mjs) currently resolves to a real secret in the vault.
//
// If ANY of the above fails, this exits non-zero with an itemized report — BLOCK the rollout, do
// not re-pin. If everything checks out, exits 0 with a clean summary.
//
// Auth: this script authenticates with the fleet's provisioning/ops service principal
// (AZURE_SP_CLIENT_ID / AZURE_SP_CLIENT_SECRET / AZURE_SP_TENANT_ID — the SAME env vars used
// throughout this repo, e.g. setup/fetch-secrets-azure.mjs, skills/kb-memory/azure-secret.mjs).
// That SP needs:
//   - Microsoft.Authorization/roleAssignments/read at the vault scope and at the ACR scope
//     (Reader, or any role with that data action, is enough — it does NOT need the KV/ACR roles
//     itself, it is only reading role-assignment metadata via ARM).
//   - `get` on Key Vault secrets (Key Vault Secrets User, or the legacy access-policy equivalent)
//     for check #3, since the gate itself needs read access to verify secret existence — this is
//     deliberately separate from the managed-identity path the jobs use at RUNTIME (checks #1/#2
//     are what confirm the *jobs'* identity, not this script's SP, can reach the vault/registry).
//
// Usage:
//   node setup/deploy-gate-check.mjs [options] [-- <entrypoint.mjs> <entrypoint.mjs> ...]
//
// Options:
//   --identity-id <resourceId>   Full ARM resource id of the user-assigned managed identity.
//                                 Default: /subscriptions/<sub>/resourceGroups/otchealth-automation-rg/
//                                          providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-otc-jobs-kv
//   --identity-name <name>        Shorthand: just the identity name, combined with --rg/--sub.
//                                 Default: id-otc-jobs-kv
//   --vault <name>                Key Vault name. Default: kv-otc-55c84f6bef
//   --acr <name>                  Container registry name (no domain suffix). Default: otchealthacr
//   --rg <name>                   Resource group for the identity + ACR (ARM scope construction).
//                                 Default: otchealth-automation-rg
//   --sub <id>                    Azure subscription id. Default: AZURE_SUBSCRIPTION_ID env, else
//                                 the fleet's known subscription 55c84f6b-ef90-4259-a58b-50835cc4cab4
//   --manifest <file.json>        JSON manifest of job entrypoint files to scan (see shape below).
//                                 Default: setup/deploy-gate-jobs.json if it exists next to this
//                                 script; otherwise entrypoints must be passed as trailing args.
//   --skip-secrets                Skip check #3 (RBAC-only gate; e.g. no code changed this rollout).
//   --json                        Emit the full report as JSON on stdout (in addition to exit code).
//
// Trailing positional args (after all options, optionally after a literal `--`) are treated as
// additional job entrypoint .mjs files to scan, on top of anything in --manifest.
//
// Manifest JSON shape (all fields optional beyond the array itself):
//   { "entrypoints": ["skills/doc-indexer/indexer.mjs", "skills/doc-indexer/deep-pass.mjs", ...] }
// or simply a bare JSON array of file paths: ["skills/doc-indexer/indexer.mjs", ...]
// Paths are resolved relative to the repo root (this file's ../.. ) if not absolute.
//
// Exit codes: 0 = all clear. 1 = one or more gate checks failed (block the rollout).
//             2 = usage / config error (couldn't even run the checks).

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ── Fleet defaults (inferred from setup/heartbeat-registry.json, setup/*.mjs, and the ARM
//    resource ids baked into the throwaway /tmp/a3_rollout.mjs / /tmp/repin.mjs ops scripts —
//    REVIEWER: double-check these four against live Azure before trusting the gate blindly) ──
const DEFAULT_SUBSCRIPTION_ID = '55c84f6b-ef90-4259-a58b-50835cc4cab4';
const DEFAULT_RESOURCE_GROUP = 'otchealth-automation-rg'; // identity + ACR live here
const DEFAULT_VAULT_RESOURCE_GROUP = 'rg-otchealth-shared-prod'; // the vault lives in a DIFFERENT rg
const DEFAULT_VAULT_NAME = 'kv-otc-55c84f6bef';
const DEFAULT_ACR_NAME = 'otchealthacr';
const DEFAULT_IDENTITY_NAME = 'id-otc-jobs-kv';
const DEFAULT_MANIFEST_PATH = path.join(__dirname, 'deploy-gate-jobs.json');

// Built-in RBAC role definition GUIDs (fixed, tenant-independent — these are the same everywhere
// in Azure, not fleet-specific; confirmed against the task brief).
const ROLE_KV_SECRETS_USER = '4633458b-17de-408a-b874-0445c86b69e6';
const ROLE_ACR_PULL = '7f951dda-4ed3-4680-a7ca-43fe172d538d';

const ARM_API_VERSION = '2022-04-01';

// ── CLI parsing ──────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    identityId: null,
    identityName: DEFAULT_IDENTITY_NAME,
    vault: DEFAULT_VAULT_NAME,
    acr: DEFAULT_ACR_NAME,
    rg: DEFAULT_RESOURCE_GROUP,
    vaultRg: null, // set below to DEFAULT_VAULT_RESOURCE_GROUP if not overridden — the vault does NOT
                    // necessarily live in the same RG as the identity/ACR (confirmed live: this fleet's
                    // vault is in rg-otchealth-shared-prod while the identity/registry are in
                    // otchealth-automation-rg) — collapsing these into one --rg was a real bug caught
                    // by running this gate live for the first time.
    sub: process.env.AZURE_SUBSCRIPTION_ID || DEFAULT_SUBSCRIPTION_ID,
    manifest: null,
    skipSecrets: false,
    json: false,
    entrypoints: [],
  };
  let sawDashDash = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { sawDashDash = true; continue; }
    if (!sawDashDash && a.startsWith('--')) {
      const next = () => argv[++i];
      switch (a) {
        case '--identity-id': out.identityId = next(); break;
        case '--identity-name': out.identityName = next(); break;
        case '--vault': out.vault = next(); break;
        case '--vault-rg': out.vaultRg = next(); break;
        case '--acr': out.acr = next(); break;
        case '--rg': out.rg = next(); break;
        case '--sub': out.sub = next(); break;
        case '--manifest': out.manifest = next(); break;
        case '--skip-secrets': out.skipSecrets = true; break;
        case '--json': out.json = true; break;
        case '--help': case '-h': out.help = true; break;
        default:
          console.error(`[deploy-gate-check] unknown option: ${a}`);
          out.usageError = true;
      }
    } else {
      out.entrypoints.push(a);
    }
  }
  if (!out.identityId) {
    out.identityId = `/subscriptions/${out.sub}/resourceGroups/${out.rg}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${out.identityName}`;
  }
  return out;
}

function printUsage() {
  console.log(`Usage: node setup/deploy-gate-check.mjs [options] [-- <entrypoint.mjs> ...]

Options:
  --identity-id <resourceId>   Full ARM id of the managed identity (default derived from --rg/--sub/--identity-name)
  --identity-name <name>       Identity name only (default: ${DEFAULT_IDENTITY_NAME})
  --vault <name>               Key Vault name (default: ${DEFAULT_VAULT_NAME})
  --vault-rg <name>            Resource group the vault itself lives in, if different from --rg (default: ${DEFAULT_VAULT_RESOURCE_GROUP})
  --acr <name>                 Container registry name, no domain (default: ${DEFAULT_ACR_NAME})
  --rg <name>                  Resource group for identity/ACR scope (default: ${DEFAULT_RESOURCE_GROUP})
  --sub <id>                   Subscription id (default: ${DEFAULT_SUBSCRIPTION_ID})
  --manifest <file.json>       JSON manifest of entrypoint files (default: setup/deploy-gate-jobs.json if present)
  --skip-secrets                Skip the per-job secret-existence check (RBAC-only gate)
  --json                        Also emit the full report as JSON on stdout

Env (required): AZURE_SP_CLIENT_ID, AZURE_SP_CLIENT_SECRET, AZURE_SP_TENANT_ID
Env (optional): AZURE_SUBSCRIPTION_ID (fallback for --sub)

Trailing positional args are additional job entrypoint .mjs files to scan.`);
}

// ── ARM / Key Vault auth — mirrors skills/kb-memory/azure-secret.mjs's spToken() /
//    skills/decision-clock/cosmos-client.mjs style exactly: dependency-free fetch, SP
//    client_credentials, no Azure SDK. Two scopes needed: management.azure.com (RBAC reads) and
//    vault.azure.net (secret existence checks). ──
async function mintToken(scope) {
  const tenant = process.env.AZURE_SP_TENANT_ID;
  const cid = process.env.AZURE_SP_CLIENT_ID;
  const csec = process.env.AZURE_SP_CLIENT_SECRET;
  if (!tenant || !cid || !csec) {
    throw new Error('AZURE_SP_CLIENT_ID / AZURE_SP_CLIENT_SECRET / AZURE_SP_TENANT_ID must all be set');
  }
  const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cid, client_secret: csec, scope }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) {
    throw new Error(`token mint failed for scope ${scope}: ${j.error || r.status} ${(j.error_description || '').slice(0, 200)}`);
  }
  return j.access_token;
}

/** Resolve the managed identity's principalId (the ARM resource's own object id) from its
 *  resource id. Role assignments are keyed on principalId, not the resource id, so we need
 *  this before we can query roleAssignments. */
async function resolveIdentityPrincipalId(armToken, identityId) {
  const url = `https://management.azure.com${identityId}?api-version=2023-01-31`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${armToken}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`GET identity ${identityId} -> ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  }
  const principalId = j.properties?.principalId;
  if (!principalId) throw new Error(`identity ${identityId} has no properties.principalId in response`);
  return principalId;
}

/** Query ARM role assignments for a principal, filtered by scope + exact role definition id.
 *  Mirrors /tmp/step9_check_role.mjs's roleAssignments GET, but adds the scope + roleDefinitionId
 *  filtering the brief asks for so we don't just get "principal has ANY role ANYWHERE". */
async function hasActiveRoleAssignment(armToken, subscriptionId, principalId, scope, roleDefinitionGuid) {
  const filter = encodeURIComponent(`principalId eq '${principalId}'`);
  const url = `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleAssignments?api-version=${ARM_API_VERSION}&$filter=${filter}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${armToken}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`GET roleAssignments -> ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  }
  const wantRoleId = `/providers/Microsoft.Authorization/roleDefinitions/${roleDefinitionGuid}`;
  const scopeLower = scope.toLowerCase();
  const assignments = j.value || [];
  const matches = assignments.filter((a) => {
    const p = a.properties || {};
    const aScope = String(p.scope || '').toLowerCase();
    const aRole = String(p.roleDefinitionId || '').toLowerCase();
    if (!aRole.endsWith(wantRoleId.toLowerCase())) return false;
    // Match either exactly at the target scope, or inherited from an ancestor scope
    // (e.g. assigned at the subscription/RG level rather than the vault/ACR itself) —
    // both are "active" for the purpose of this gate, since either grants the access.
    return scopeLower === aScope || scopeLower.startsWith(aScope + '/');
  });
  return { ok: matches.length > 0, matches, allAssignmentsForPrincipal: assignments };
}

/** Confirm a single secret name currently resolves in Key Vault. Uses the SP's OWN vault token
 *  (client_credentials against vault.azure.net) — deliberately separate from the managed-identity
 *  runtime path being validated in checks #1/#2. Per the brief, this is fine for THIS check only:
 *  the gate needs read access to verify, the jobs at runtime use the managed identity. */
async function secretExists(vaultToken, vaultName, secretName) {
  const url = `https://${vaultName}.vault.azure.net/secrets/${encodeURIComponent(secretName)}?api-version=7.4`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${vaultToken}` } });
  if (r.status === 404) return { ok: false, status: 404 };
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    return { ok: false, status: r.status, error: body.slice(0, 200) };
  }
  const j = await r.json().catch(() => ({}));
  return { ok: j.value != null && String(j.value).length > 0, status: r.status };
}

// ── Static scan of job entrypoint source for kvSecret("...") / requireSecrets([...]) calls ──
// Deliberately simple regex scan (no AST parsing) matching the actual call shapes used across
// the repo today, e.g.:
//   await kvSecret("posthog-fleet-ingest-key")
//   await requireSecrets(["azure-commons-storage-account", "azure-commons-storage-key"])
//   if (KEYSECRET) await requireSecrets([KEYSECRET, 'azure-foundry-key'])
// Only string-literal arguments are extractable; a dynamic/variable arg (like KEYSECRET above)
// is reported separately as "dynamic" so the reviewer knows the static scan is incomplete for
// that file rather than silently missing it.
const KV_SECRET_CALL_RE = /\bkvSecret(?:OrThrow)?\(\s*(['"])((?:(?!\1).)*)\1\s*\)/g;
const REQUIRE_SECRETS_CALL_RE = /\brequireSecrets\(\s*\[([^\]]*)\]\s*\)/g;
const STRING_LITERAL_RE = /(['"])((?:(?!\1).)*)\1/g;

function extractSecretNames(source, filePath) {
  const names = new Set();
  let dynamicArgCount = 0;

  for (const m of source.matchAll(KV_SECRET_CALL_RE)) names.add(m[2]);

  for (const m of source.matchAll(REQUIRE_SECRETS_CALL_RE)) {
    const argsBody = m[1];
    let matchedAny = false;
    for (const lit of argsBody.matchAll(STRING_LITERAL_RE)) { names.add(lit[2]); matchedAny = true; }
    // crude count of comma-separated entries vs. string literals found, to flag likely dynamic args
    const entryCount = argsBody.split(',').map((s) => s.trim()).filter(Boolean).length;
    const literalCount = [...argsBody.matchAll(STRING_LITERAL_RE)].length;
    if (entryCount > literalCount) dynamicArgCount += (entryCount - literalCount);
    if (!matchedAny && argsBody.trim()) dynamicArgCount += 1;
  }

  return { names: [...names], dynamicArgCount };
}

function resolveEntrypointPath(p) {
  return path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
}

function loadManifestEntrypoints(manifestPath) {
  if (!manifestPath || !existsSync(manifestPath)) return [];
  const raw = readFileSync(manifestPath, 'utf8');
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : parsed.entrypoints;
  if (!Array.isArray(list)) {
    throw new Error(`manifest ${manifestPath} must be a JSON array or {"entrypoints": [...]}`);
  }
  return list;
}

// ── Main ─────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printUsage(); process.exit(0); }
  if (args.usageError) { printUsage(); process.exit(2); }

  const manifestPath = args.manifest
    ? (path.isAbsolute(args.manifest) ? args.manifest : path.join(REPO_ROOT, args.manifest))
    : DEFAULT_MANIFEST_PATH;

  let manifestEntrypoints = [];
  try {
    manifestEntrypoints = loadManifestEntrypoints(manifestPath);
  } catch (e) {
    console.error(`[deploy-gate-check] FATAL: could not load manifest ${manifestPath}: ${e.message}`);
    process.exit(2);
  }

  const entrypoints = [...new Set([...manifestEntrypoints, ...args.entrypoints])];

  if (!args.skipSecrets && entrypoints.length === 0) {
    console.error('[deploy-gate-check] FATAL: no job entrypoint files given (no --manifest, no manifest file at default path, no trailing args) and --skip-secrets not set.');
    console.error(`                     Either pass entrypoint .mjs paths as trailing args, create ${DEFAULT_MANIFEST_PATH}, or pass --skip-secrets to run an RBAC-only gate.`);
    process.exit(2);
  }

  const vaultScope = `/subscriptions/${args.sub}/resourceGroups/${args.vaultRg || DEFAULT_VAULT_RESOURCE_GROUP}/providers/Microsoft.KeyVault/vaults/${args.vault}`;
  const acrScope = `/subscriptions/${args.sub}/resourceGroups/${args.rg}/providers/Microsoft.ContainerRegistry/registries/${args.acr}`;

  const report = {
    generatedAt: new Date().toISOString(),
    identityId: args.identityId,
    vault: args.vault,
    vaultScope,
    acr: args.acr,
    acrScope,
    subscriptionId: args.sub,
    resourceGroup: args.rg,
    checks: {},
    entrypointScan: [],
    failures: [],
  };

  console.log('==================================================================================');
  console.log('[deploy-gate-check] Pre-flight gate for doc-indexer rollout');
  console.log(`  identity : ${args.identityId}`);
  console.log(`  vault    : ${args.vault}  (scope ${vaultScope})`);
  console.log(`  registry : ${args.acr}  (scope ${acrScope})`);
  console.log(`  subscr.  : ${args.sub}`);
  console.log(`  entrypts : ${entrypoints.length ? entrypoints.join(', ') : '(none — --skip-secrets set)'}`);
  console.log('==================================================================================');

  // Mint the two tokens up front — fail loud immediately if SP creds are absent/bad, before doing
  // any per-check work.
  let armToken, vaultToken;
  try {
    armToken = await mintToken('https://management.azure.com/.default');
  } catch (e) {
    console.error(`[deploy-gate-check] FATAL: could not mint ARM token: ${e.message}`);
    process.exit(2);
  }

  // ---- Check 1: identity has Key Vault Secrets User on the vault -----------------------------
  let principalId;
  try {
    principalId = await resolveIdentityPrincipalId(armToken, args.identityId);
    report.identityPrincipalId = principalId;
    console.log(`[1/3] resolved identity principalId: ${principalId}`);
  } catch (e) {
    report.checks.identityResolved = { ok: false, error: e.message };
    report.failures.push(`Could not resolve principalId for identity ${args.identityId}: ${e.message}`);
    console.error(`[1/3] FAIL: ${e.message}`);
  }

  if (principalId) {
    try {
      const kvCheck = await hasActiveRoleAssignment(armToken, args.sub, principalId, vaultScope, ROLE_KV_SECRETS_USER);
      report.checks.keyVaultSecretsUser = {
        ok: kvCheck.ok,
        matchCount: kvCheck.matches.length,
        matches: kvCheck.matches.map((m) => ({ scope: m.properties.scope, id: m.id })),
      };
      if (kvCheck.ok) {
        console.log(`[1/3] PASS: identity has "Key Vault Secrets User" on ${args.vault} (${kvCheck.matches.length} matching assignment(s))`);
      } else {
        report.failures.push(`Identity ${args.identityId} does NOT have an active "Key Vault Secrets User" (role ${ROLE_KV_SECRETS_USER}) role assignment scoped at ${vaultScope} (or an ancestor scope). Found ${kvCheck.allAssignmentsForPrincipal.length} role assignment(s) total for this principal, none matched.`);
        console.error(`[1/3] FAIL: no matching "Key Vault Secrets User" role assignment at ${vaultScope}`);
      }
    } catch (e) {
      report.checks.keyVaultSecretsUser = { ok: false, error: e.message };
      report.failures.push(`RBAC check for Key Vault Secrets User failed: ${e.message}`);
      console.error(`[1/3] FAIL (error): ${e.message}`);
    }

    // ---- Check 2: identity has AcrPull on the registry ---------------------------------------
    try {
      const acrCheck = await hasActiveRoleAssignment(armToken, args.sub, principalId, acrScope, ROLE_ACR_PULL);
      report.checks.acrPull = {
        ok: acrCheck.ok,
        matchCount: acrCheck.matches.length,
        matches: acrCheck.matches.map((m) => ({ scope: m.properties.scope, id: m.id })),
      };
      if (acrCheck.ok) {
        console.log(`[2/3] PASS: identity has "AcrPull" on ${args.acr} (${acrCheck.matches.length} matching assignment(s))`);
      } else {
        report.failures.push(`Identity ${args.identityId} does NOT have an active "AcrPull" (role ${ROLE_ACR_PULL}) role assignment scoped at ${acrScope} (or an ancestor scope).`);
        console.error(`[2/3] FAIL: no matching "AcrPull" role assignment at ${acrScope}`);
      }
    } catch (e) {
      report.checks.acrPull = { ok: false, error: e.message };
      report.failures.push(`RBAC check for AcrPull failed: ${e.message}`);
      console.error(`[2/3] FAIL (error): ${e.message}`);
    }
  } else {
    report.checks.keyVaultSecretsUser = { ok: false, error: 'skipped (identity principalId unresolved)' };
    report.checks.acrPull = { ok: false, error: 'skipped (identity principalId unresolved)' };
    console.error('[2/3] SKIPPED: identity principalId unresolved');
  }

  // ---- Check 3: every kvSecret()/requireSecrets() name in each entrypoint resolves in KV -----
  if (args.skipSecrets) {
    console.log('[3/3] SKIPPED (--skip-secrets)');
  } else {
    try {
      vaultToken = await mintToken('https://vault.azure.net/.default');
    } catch (e) {
      report.failures.push(`Could not mint Key Vault token for secret-existence checks: ${e.message}`);
      console.error(`[3/3] FAIL: ${e.message}`);
    }

    if (vaultToken) {
      const allSecretNames = new Set();
      for (const rel of entrypoints) {
        const abs = resolveEntrypointPath(rel);
        const entry = { file: rel, resolvedPath: abs, secretNames: [], dynamicArgCount: 0 };
        if (!existsSync(abs)) {
          entry.error = 'file not found';
          report.failures.push(`Entrypoint file not found: ${abs} (from "${rel}")`);
          console.error(`[3/3] FAIL: entrypoint not found: ${abs}`);
        } else {
          const source = readFileSync(abs, 'utf8');
          const { names, dynamicArgCount } = extractSecretNames(source, abs);
          entry.secretNames = names;
          entry.dynamicArgCount = dynamicArgCount;
          names.forEach((n) => allSecretNames.add(n));
          if (dynamicArgCount > 0) {
            console.log(`  note: ${rel} has ${dynamicArgCount} dynamic (non-literal) secret arg(s) the static scan cannot resolve by name — review manually.`);
          }
          if (names.length === 0 && dynamicArgCount === 0) {
            console.log(`  note: ${rel} has no kvSecret()/requireSecrets() calls found.`);
          }
        }
        report.entrypointScan.push(entry);
      }

      console.log(`[3/3] scanning ${allSecretNames.size} distinct secret name(s) referenced across ${entrypoints.length} entrypoint file(s)`);
      const secretResults = {};
      for (const name of allSecretNames) {
        const res = await secretExists(vaultToken, args.vault, name);
        secretResults[name] = res;
        if (res.ok) {
          console.log(`  OK   ${name}`);
        } else {
          console.error(`  MISS ${name}  (status ${res.status}${res.error ? `, ${res.error}` : ''})`);
        }
      }
      report.checks.secretsResolved = {
        ok: Object.values(secretResults).every((r) => r.ok),
        results: secretResults,
      };
      const missing = Object.entries(secretResults).filter(([, r]) => !r.ok).map(([n]) => n);
      if (missing.length) {
        report.failures.push(`Secret(s) referenced by job code do NOT resolve in Key Vault ${args.vault}: ${missing.join(', ')}`);
      } else if (allSecretNames.size > 0) {
        console.log(`[3/3] PASS: all ${allSecretNames.size} secret name(s) resolve in ${args.vault}`);
      } else {
        console.log('[3/3] PASS (vacuously — no secret names found in given entrypoints)');
      }
    }
  }

  // ---- Verdict ---------------------------------------------------------------------------------
  console.log('==================================================================================');
  if (report.failures.length === 0) {
    console.log('[deploy-gate-check] RESULT: PASS — all checks green. Rollout may proceed.');
    if (args.json) console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  } else {
    console.error(`[deploy-gate-check] RESULT: FAIL — ${report.failures.length} issue(s). BLOCKING rollout.`);
    report.failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
    if (args.json) console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`[deploy-gate-check] FATAL (uncaught): ${e.stack || e.message}`);
  process.exit(2);
});
