#!/usr/bin/env node
// cto-onedrive.mjs - the CTO's three-folder OneDrive exchange, same process as the CFO/CLO.
//
// This is a THIN wrapper over the shared engine skills/cfo-onedrive/onedrive.mjs. It does two
// things, then forwards every argument unchanged:
//   1. Points the exchange folders at the CTO set ("CTO Outgoing" / "CTO Incoming" / "CTO Processed")
//      via the engine's CFO_*_FOLDER overrides, so `inbox` / `process` / `deliver` operate on the
//      CTO folders instead of the CFO ones.
//   2. Self-hydrates the Graph app creds (GRAPH_MAIL_CLIENT_ID/SECRET/TENANT_ID) if they are not
//      already in the environment, so it works in any session.
//
// CREDENTIAL RESOLUTION (fixed 2026-08-18, post Azure-subscription-deletion). This used to shell out
// to setup/get-secret.mjs, which talks to Azure Key Vault ONLY -- no fallback of any kind. Azure
// subscription 55c84f6b (and with it Key Vault kv-otc-55c84f6bef) was PERMANENTLY DELETED 2026-08-13,
// so every call failed (a 403 "subscription disabled" from the vault, or an auth failure minting the
// token), the failure was swallowed by a bare try/catch, and the engine downstream reported only the
// generic "Missing env GRAPH_MAIL_TENANT_ID" -- true, but silent about WHY, and about the fact the
// real credential was sitting the whole time in the AWS SSM mirror the 2026-08-13 evacuation created.
//
// The fix is to stop reinventing credential resolution here and use the SAME resolver every already-
// migrated fleet skill uses: kvSecret() from ../kb-memory/azure-secret.mjs. It already tries Key
// Vault (now always a fast, harmless "no-token"/403 miss) and falls through to the AWS SSM mirror
// (/otchealth/<name>, populated 2026-08-13) automatically -- no new fallback logic needed here, and
// none invented that would drift from the shared one.
//
// Usage is identical to the CFO skill (run with no args for the engine's help):
//   node skills/cto-onedrive/cto-onedrive.mjs inbox                 # list CTO Outgoing (Matt -> CTO)
//   node skills/cto-onedrive/cto-onedrive.mjs process <name>        # MOVE CTO Outgoing/<name> -> CTO Processed
//   node skills/cto-onedrive/cto-onedrive.mjs deliver <file> [name] # upload to CTO Incoming (CTO -> Matt)
//   node skills/cto-onedrive/cto-onedrive.mjs ls|tree|stat|mkdir|mv|cp|rm|upload|download|catalog ...
//
// The folders (mnemonic from Matt's point of view):
//   CTO Outgoing  = out from Matt to the CTO (the CTO's inbox; drop API docs / specs / artifacts here)
//   CTO Incoming  = in to Matt from the CTO (the CTO delivers work product here)
//   CTO Processed = the CTO's done pile / organized data room
//
// NOTE on the delegated refresh token (graph-onedrive-refresh-token): that credential is read AND
// (on rotation) written by the ENGINE itself (onedrive.mjs's smRead/smWrite), which already imports
// kvSecret/kvSecretSet directly -- this wrapper only supplies the three static APP credentials above
// and never touches the refresh token, so there is nothing to duplicate here.
//
// Ring: non-PHI (same as the CFO/CLO OneDrive skills).

import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { kvSecret } from '../kb-memory/azure-secret.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = resolve(HERE, '..', 'cfo-onedrive', 'onedrive.mjs');

// secret id (Key Vault name / SSM parameter name under /otchealth/) -> env var the engine reads.
export const GRAPH_CRED_MAP = {
  GRAPH_MAIL_CLIENT_ID: 'graph-mail-client-id',
  GRAPH_MAIL_CLIENT_SECRET: 'graph-mail-client-secret',
  GRAPH_MAIL_TENANT_ID: 'graph-mail-tenant-id',
};

/**
 * Resolve the three Graph app credentials into a copy of `baseEnv`, via `kv` (defaults to the real
 * kvSecret() resolver; tests inject a stub). An env var already set in `baseEnv` wins and is never
 * looked up (explicit override, matches the pre-fix behaviour). Returns `{ env, missing }` -- `env`
 * is a NEW object (baseEnv is never mutated), `missing` lists the secret ids (not the env var names,
 * so the message matches what a human would grep Key Vault / `aws ssm get-parameter` for) that
 * neither store could resolve. Pure aside from the injected `kv` calls, so this is unit-testable
 * without touching the network or process.exit.
 */
export async function hydrateGraphCreds(baseEnv = process.env, kv = kvSecret) {
  const env = { ...baseEnv };
  const missing = [];
  for (const [envVar, secretId] of Object.entries(GRAPH_CRED_MAP)) {
    if (env[envVar]) continue; // explicit override wins, no lookup performed
    const v = await kv(secretId);
    if (v) env[envVar] = v;
    else missing.push(secretId);
  }
  return { env, missing };
}

/** The loud, named failure message for a set of unresolved secret ids. Exported so the exact wording
 *  is unit-testable without needing to fork a process to observe a process.exit() call. */
export function describeMissingCredsError(missing) {
  return (
    `[cto-onedrive] FATAL: could not resolve ${missing.length} required Graph credential(s) from ` +
    `EITHER store (Azure Key Vault -- permanently deleted 2026-08-13 -- or its AWS SSM mirror under ` +
    `/otchealth/): ${missing.join(', ')}. See the [kv-secret] lines above for which auth path failed ` +
    `on each store. Refusing to continue with a partially-hydrated environment: a silent empty value ` +
    `here would surface later as a confusing 401 from Microsoft Graph instead of this named error.`
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // --- 1. Point the exchange at the CTO folders (do not clobber an explicit override) ---
  const baseEnv = { ...process.env };
  baseEnv.CFO_OUTGOING_FOLDER ??= 'CTO Outgoing';
  baseEnv.CFO_INCOMING_FOLDER ??= 'CTO Incoming';
  baseEnv.CFO_PROCESSED_FOLDER ??= 'CTO Processed';
  baseEnv.CFO_SUPERSEDED_FOLDER ??= 'CTO Processed/_Superseded';

  // --- 2. Hydrate the Graph app creds via the shared kvSecret() resolver (Key Vault -> SSM) ---
  const { env, missing } = await hydrateGraphCreds(baseEnv);

  // --- 3. FAIL LOUD AND NAMED before ever reaching the engine / Microsoft Graph ---
  if (missing.length) {
    console.error(describeMissingCredsError(missing));
    process.exit(78); // EX_CONFIG, matches azure-secret.mjs's requireSecrets() convention
  }

  // --- 4. Forward all args to the shared engine ---
  const r = spawnSync('node', [ENGINE, ...process.argv.slice(2)], { stdio: 'inherit', env });
  process.exit(r.status ?? 1);
}
