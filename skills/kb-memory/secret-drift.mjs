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
// THE CHECKER MUST NOT USE THE RESOLVER (bug fixed 2026-08-18). This file used to read the Azure
// side via kvSecret() while forcing SECRET_BACKEND=keyvault, on the theory that the env var pinned
// which store answered. It does not. kvSecret() delegates to resolveSecret(), whose entire job is
// to paper over which store answered: when the Key Vault leg came back empty for ANY reason,
// resolveSecret() fell through to SSM and handed that value back as though the vault had served it.
// The check then compared SSM against itself and printed in-sync, exit 0, no matter how far the two
// stores had actually diverged. Measured against a vault answering 404 for a name SSM holds: the
// old code reported in-sync=1 exit=0 where the correct answer was KV-MISSING exit=1. A check that
// cannot fail is worse than a deleted one, because it gets cited as evidence.
//
// The fix is structural, not a flag: read the Azure leg through keyVaultRead(), which never falls
// through to another store, and drop the SECRET_BACKEND push/pop entirely (this file no longer
// cares what the ambient backend is, so it can no longer be defeated by it).
//
// THREE OUTCOMES, NEVER TWO. keyVaultRead() also returns `attempts`, which separates "the vault
// answered and does not have this secret" from "no auth path here could reach a vault at all".
// Folding the second into the first turns a seat with no Azure credential -- which is every seat
// today, subscription 55c84f6b being retired -- into a wall of false KV-MISSING alarms; folding it
// into in-sync restores the false green this fix exists to remove. So a run reports in-sync /
// drift-or-missing / cannot-compare, and only the first exits 0.
//
// Values are compared by hash and are never printed, logged, or returned.
//
//   node skills/kb-memory/secret-drift.mjs [name ...]     (no names = every mirrored secret)
//
// Exit 0 = every compared secret is in sync.
// Exit 1 = real divergence: drift, or one store missing a secret the other has.
// Exit 2 = cannot compare (a store unreachable from this seat). NOT a clean bill of health.

import crypto from "node:crypto";
import { ssmSecret, ssmList, ssmAvailable } from "./aws-secret.mjs";
import { keyVaultRead } from "./azure-secret.mjs";

const hash = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 12);

// An attempt string is `<mode>:<outcome>`; `no-token` means that credential path never produced a
// token, so the vault was never actually asked. If every path says no-token, this seat has no Azure
// identity at all and there is nothing to compare against.
const reachedVault = (attempts) => attempts.some((a) => !a.endsWith(":no-token"));

if (!(await ssmAvailable())) {
  console.error("[secret-drift] CANNOT COMPARE: no AWS credentials resolvable on this seat. Exit 2.");
  process.exit(2);
}

// PROBE THE VAULT ONCE, UP FRONT, before comparing anything. Without this, a seat with no Azure
// credential emits one KV-MISSING line per secret -- 444 of them -- and exits 1 forever: a
// permanent false alarm, which is the same failure as a permanent false green wearing different
// clothes. Both train a reader to stop believing the check. The probe name is deliberately one that
// cannot exist; a 404 is a perfectly good "the vault is reachable" answer.
const probe = await keyVaultRead("secret-drift-reachability-probe-0000");
if (!reachedVault(probe.attempts)) {
  console.error(
    `[secret-drift] CANNOT COMPARE: no Azure Key Vault auth path resolved on this seat ` +
      `(${probe.attempts.join(", ") || "no attempts"}). Nothing was compared. This is NOT an ` +
      `in-sync result. Exit 2.`,
  );
  process.exit(2);
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : await ssmList();
let ok = 0, drift = 0, ssmMissing = 0, kvMissing = 0, unknown = 0, absent = 0;

for (const n of names) {
  const kvRes = await keyVaultRead(n);
  const kv = kvRes.value;
  const ssm = await ssmSecret(n);

  // A null from the vault only means "not there" if the vault actually answered. If every auth path
  // failed on THIS name (401/403, 5xx, network error), we do not know whether the secret exists, so
  // it is inconclusive and must never be counted as agreement.
  const vaultAnswered = kv != null || kvRes.attempts.some((a) => /:http-404$/.test(a));

  if (kv != null && ssm != null) {
    if (kv === ssm) ok++;
    else { drift++; console.log(`DRIFT        ${n}  keyvault=${hash(kv)}  ssm=${hash(ssm)}`); }
  } else if (!vaultAnswered) {
    unknown++;
    console.log(`UNKNOWN      ${n}  (key vault inconclusive: ${kvRes.attempts.join(", ") || "no attempts"})`);
  } else if (kv != null) { ssmMissing++; console.log(`SSM-MISSING  ${n}`); }
  else if (ssm != null) { kvMissing++; console.log(`KV-MISSING   ${n}`); }
  else absent++; // vault answered 404 and SSM has nothing: neither store holds it. Not divergence,
                 // and deliberately not counted as in-sync either -- no value was ever agreed on.
}

console.log(
  `\nin-sync=${ok} drift=${drift} ssm-missing=${ssmMissing} kv-missing=${kvMissing} ` +
    `unknown=${unknown} absent-from-both=${absent} (of ${names.length})`,
);
if (drift || ssmMissing || kvMissing) process.exit(1);
if (unknown) {
  console.error(
    `[secret-drift] ${unknown} secret(s) could not be compared; this run does NOT certify the ` +
      `stores agree. Exit 2.`,
  );
  process.exit(2);
}
process.exit(0);
