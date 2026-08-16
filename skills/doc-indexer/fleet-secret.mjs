// fleet-secret.mjs — the ONE secret resolver every doc-indexer job uses, AWS-first.
//
// THE DEFECT THIS FIXES (found live 2026-08-16, not by inspection). The scheduled jobs were migrated
// to AWS as ECS task definitions + EventBridge schedules, but their CREDENTIAL MODEL was never
// ported. 15 of the 32 job task definitions carry ZERO injected secrets and only
// `AZURE_KEYVAULT_NAME` + `AZURE_UAMI_CLIENT_ID` — an Azure USER-ASSIGNED MANAGED IDENTITY, which
// exists only inside Azure and can never authenticate from AWS Fargate. Every one of them resolved
// secrets through a chain that went Azure Key Vault -> GCP Secret Manager and never touched AWS SSM.
//
// The observed symptom was misleading, which is why this went unnoticed: librarian-commerce exited 2
// with "Missing storage key for profile commerce (secret azure-commerce-storage-key)". That reads as
// a MISSING SECRET. The secret is present in SSM. What was missing was an IDENTITY able to fetch it.
// Same failure class as the rest of this migration: the compute moved, the credential path did not,
// and it failed in a way that pointed at the wrong thing.
//
// RESOLUTION ORDER, and why:
//   1. AWS SSM Parameter Store (/otchealth/<id>) — the store that SURVIVES the Azure retirement, and
//      already where the gateway reads all ~65 of its secrets. On Fargate this authenticates via the
//      task role (otchealthTaskRole already holds ssm:GetParameter/GetParameters/GetParametersByPath,
//      verified), so it needs nothing injected into the task definition at all.
//   2. Azure Key Vault — the transition fallback. Keeps every job byte-identical in behaviour while
//      Azure is still up, so this change cannot regress anything today, and is what makes the switch
//      safe to land before the blob rooms themselves have moved.
//   3. GCP Secret Manager — legacy, retained only because a caller may still carry a service account.
//
// Deliberately NOT folded into kb-memory/azure-secret.mjs's kvSecret(): a function named kvSecret
// must keep meaning "read Key Vault". Callers wanting the fleet chain ask for it by name, here.
//
// Fail-open per tier: any tier that throws or misses falls through to the next, and an all-miss
// returns null, which is exactly what the previous chain did. A caller that treats null as fatal
// (indexer.mjs's `if (!AKEY) ... process.exit(2)`) keeps that behaviour unchanged.
import { kvSecret } from "../kb-memory/azure-secret.mjs";
import { ssmSecret } from "../kb-memory/aws-secret.mjs";

/** Resolve a fleet secret by its BARE id (e.g. "azure-commerce-storage-key"). ssmSecret() adds the
 *  /otchealth/ prefix itself, so never pass a fully-qualified parameter path. */
export async function fleetSecret(id, gcpFallback) {
  if (!id) return null;
  try {
    const v = await ssmSecret(id);
    if (v != null && v !== "") return v;
  } catch {
    /* fall through: SSM unreachable (no AWS creds resolvable) is not fatal while Azure is up */
  }
  try {
    const v = await kvSecret(id);
    if (v != null && v !== "") return v;
  } catch {
    /* fall through */
  }
  // Optional third tier, supplied by the caller because each file's GCP auth differs (some have a
  // service-account JWT helper, some do not). Passing nothing simply ends the chain at Key Vault.
  if (typeof gcpFallback === "function") {
    try {
      const v = await gcpFallback(id);
      if (v != null && v !== "") return v;
    } catch {
      /* fall through */
    }
  }
  return null;
}

export default fleetSecret;
