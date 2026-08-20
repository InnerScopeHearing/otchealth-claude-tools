// aws-bootstrap.mjs — env-var bridge so aws-secret.mjs's SSM functions also work on a seat that has
// no AWS credentials of its own (a GitHub Actions runner, a local/Hyperagent seat) but DOES have
// Azure Key Vault access (azure/login OIDC, or AZURE_SP_* client_credentials).
//
// WHY THIS IS A SEPARATE FILE, NOT ADDED INTO aws-secret.mjs DIRECTLY: aws-secret.mjs is deliberately
// dependency-free (its own header: "Dependency-free: hand-rolled SigV4, no aws-sdk") and has ZERO
// imports. azure-secret.mjs already imports FROM aws-secret.mjs (its own SSM-primary fallback for
// kvSecret/kvSecretSet). Importing azure-secret.mjs's kvSecret back INTO aws-secret.mjs would create
// a circular import between the two files -- fragile even where Node tolerates it, and aws-secret.mjs
// explicitly documents this exact gap as a known, deliberately-not-closed limitation ("CREDENTIAL
// BOOTSTRAP ... a seat-convenience gap, not a production one"). This file closes that gap at the
// CALLER layer instead: a thin, side-effecting bridge any script can call once, before it touches
// SSM, with no change to aws-secret.mjs's own zero-dependency contract.
//
// Mirrors the exact resolution order skills/kb-memory/opensearch-write.mjs's resolveAwsCredentials()
// already uses for the identical problem (ECS task role -> env -> Key Vault aws-cto-access-key-id /
// aws-cto-secret-access-key) -- same order, same secret names, same fallback semantics -- just
// expressed as an env-var side effect instead of a returned credentials object, since that is the
// shape aws-secret.mjs's ssmSecret/ssmList/ssmListDetailed/ssmParamModifiedMs already expect
// (they all read AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY from process.env).
//
// Usage: `await ensureAwsCreds()` once, early, before any aws-secret.mjs call, on any non-ECS seat.
// Returns true iff SSM is reachable after the call (task role, pre-set env, or the Key Vault
// fallback); false means no path yielded credentials -- callers must treat that as "cannot read SSM
// here", never guess. Secret VALUES are never logged; only presence/absence is ever reported.
import { ssmAvailable } from "./aws-secret.mjs";
import { kvSecret } from "./azure-secret.mjs";

let _bootstrapped = false;
let _result = false;

export async function ensureAwsCreds() {
  if (_bootstrapped) return _result;
  _bootstrapped = true;
  if (await ssmAvailable()) { _result = true; return true; } // ECS task role, or real env creds already set
  const [ak, sk] = await Promise.all([kvSecret("aws-cto-access-key-id"), kvSecret("aws-cto-secret-access-key")]);
  if (!ak || !sk) { _result = false; return false; }
  process.env.AWS_ACCESS_KEY_ID = ak;
  process.env.AWS_SECRET_ACCESS_KEY = sk;
  _result = await ssmAvailable();
  return _result;
}

/** Test-only: clear the memoized result so a test can force re-resolution. */
export function _resetForTests() { _bootstrapped = false; _result = false; }
