#!/usr/bin/env node
// cto-onedrive.mjs - the CTO's three-folder OneDrive exchange, same process as the CFO/CLO.
//
// This is a THIN wrapper over the shared engine skills/cfo-onedrive/onedrive.mjs. It does two
// things, then forwards every argument unchanged:
//   1. Points the exchange folders at the CTO set ("CTO Outgoing" / "CTO Incoming" / "CTO Processed")
//      via the engine's CFO_*_FOLDER overrides, so `inbox` / `process` / `deliver` operate on the
//      CTO folders instead of the CFO ones.
//   2. Self-hydrates the Graph app creds (GRAPH_MAIL_CLIENT_ID/SECRET/TENANT_ID) from Secret Manager
//      if they are not already in the environment, so it works in any session.
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
// Ring: non-PHI (same as the CFO/CLO OneDrive skills).

import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = resolve(HERE, '..', 'cfo-onedrive', 'onedrive.mjs');
const REPO_ROOT = resolve(HERE, '..', '..');
const GET_SECRET = resolve(REPO_ROOT, 'setup', 'get-secret.mjs');

// --- 1. Point the exchange at the CTO folders (do not clobber an explicit override) ---
const env = { ...process.env };
env.CFO_OUTGOING_FOLDER ??= 'CTO Outgoing';
env.CFO_INCOMING_FOLDER ??= 'CTO Incoming';
env.CFO_PROCESSED_FOLDER ??= 'CTO Processed';
env.CFO_SUPERSEDED_FOLDER ??= 'CTO Processed/_Superseded';

// --- 2. Hydrate the Graph app creds from Secret Manager if missing ---
// get-secret.mjs writes to a FILE (writing to /dev/stdout fails under a spawned process), so read
// each secret into a temp file and read it back.
const TMP = mkdtempSync(join(tmpdir(), 'cto-od-'));
function secret(id) {
  const f = join(TMP, id);
  try { execFileSync('node', [GET_SECRET, id, f], { stdio: 'ignore' }); return readFileSync(f, 'utf8').trim(); }
  catch { return ''; }
}
const credMap = {
  GRAPH_MAIL_CLIENT_ID: 'graph-mail-client-id',
  GRAPH_MAIL_CLIENT_SECRET: 'graph-mail-client-secret',
  GRAPH_MAIL_TENANT_ID: 'graph-mail-tenant-id',
};
for (const [envVar, secretId] of Object.entries(credMap)) {
  if (!env[envVar]) {
    const v = secret(secretId);
    if (v) env[envVar] = v;
  }
}

// --- 3. Forward all args to the shared engine ---
const r = spawnSync('node', [ENGINE, ...process.argv.slice(2)], { stdio: 'inherit', env });
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(r.status ?? 1);
