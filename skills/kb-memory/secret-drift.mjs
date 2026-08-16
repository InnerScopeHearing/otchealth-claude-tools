// secret-drift.mjs — compare the Azure Key Vault and AWS SSM secret stores.
//
// WHY A SEPARATE FILE: azure-secret.mjs statically imports aws-secret.mjs, so a drift CLI living
// inside aws-secret.mjs and dynamically importing azure-secret.mjs deadlocks on an unsettled
// top-level await (observed 2026-08-16). The check needs BOTH modules, so it lives outside both.
//
// WHY IT EXISTS: the Azure-outage fallback in kvSecret() is only trustworthy while the two stores
// agree. kvSecretSet() dual-writes to keep them aligned going forward, but a secret rotated by some
// other route (a console edit, a vendor rotation pasted into one store) can still diverge them --
// and divergence is SILENT, because the stale read succeeds and no fallback fires.
//
// Values are compared by hash and are never printed, logged, or returned.
//
//   node skills/kb-memory/secret-drift.mjs [name ...]     (no names = every mirrored secret)
//
// Exit 0 = in sync. Exit 1 = drift or a store missing a secret. Safe as a scheduled check.

import crypto from "node:crypto";
import { ssmSecret, ssmList, ssmAvailable } from "./aws-secret.mjs";
import { kvSecret } from "./azure-secret.mjs";

const hash = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 12);

if (!(await ssmAvailable())) {
  console.error("[secret-drift] no AWS credentials resolvable; cannot compare. Exit 1.");
  process.exit(1);
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : await ssmList();
let ok = 0, drift = 0, ssmMissing = 0, kvMissing = 0;

for (const n of names) {
  // Force the Key Vault leg regardless of the ambient SECRET_BACKEND. Without this, a run with
  // SECRET_BACKEND=ssm would compare SSM against itself and report perfect agreement no matter how
  // far the stores had actually diverged -- a check that always passes is worse than no check.
  const prev = process.env.SECRET_BACKEND;
  process.env.SECRET_BACKEND = "keyvault";
  const kv = await kvSecret(n).catch(() => null);
  if (prev === undefined) delete process.env.SECRET_BACKEND;
  else process.env.SECRET_BACKEND = prev;

  const ssm = await ssmSecret(n);
  if (kv != null && ssm != null) {
    if (kv === ssm) ok++;
    else { drift++; console.log(`DRIFT        ${n}  keyvault=${hash(kv)}  ssm=${hash(ssm)}`); }
  } else if (kv != null) { ssmMissing++; console.log(`SSM-MISSING  ${n}`); }
  else if (ssm != null) { kvMissing++; console.log(`KV-MISSING   ${n}`); }
}

console.log(`\nin-sync=${ok} drift=${drift} ssm-missing=${ssmMissing} kv-missing=${kvMissing} (of ${names.length})`);
process.exit(drift || ssmMissing || kvMissing ? 1 : 0);
