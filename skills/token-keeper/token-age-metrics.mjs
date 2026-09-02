#!/usr/bin/env node
// token-age-metrics.mjs — emits otc.fleet.token_age_hours{secret:<name>} for every ROTATING
// OAuth refresh-token credential the fleet actually depends on, so the Datadog monitor
// "Credential health — rotating token aging toward idle-expiry" (id 22896070,
// max:token_age_hours{*} by {secret} > 1200, ~50 days) has real data instead of the "No Data"
// it has shown since it was created 2026-06-27 (a monitor watching a metric nobody emits looks
// like healthy silence, which is worse than no monitor at all).
//
// AGE SOURCE: AWS SSM Parameter Store's own GetParameter LastModifiedDate, via
// skills/kb-memory/aws-secret.mjs's ssmParamModifiedMs() (added alongside this script). SSM is the
// live fleet secret store (see that file's header); LastModifiedDate updates on every real
// rotation-persist write because every rotator in this codebase (token-keeper's own
// smAddVersion/refreshOneOAuth, skills/xero/xero-token.mjs's smWrite, skills/cfo-onedrive/
// onedrive.mjs's smWrite) persists a rotated token via kvSecretSet(), which DUAL-WRITES to SSM and
// Key Vault (skills/kb-memory/azure-secret.mjs kvSecretSet, "DUAL-WRITE (2026-08-16)"). So a stale
// SSM LastModifiedDate for one of the secrets this script covers is a genuine "hasn't rotated"
// signal, not a store artifact -- verified live 2026-08-18: every candidate secret resolves a real,
// distinct LastModifiedDate via ssmParamModifiedMs, not a missing/zero value.
//
// WHICH SECRETS ARE COVERED, AND WHY (code-verified, not assumed):
//   - QuickBooks refresh tokens, one per entity (otchealth/innd/hearingassist/personal): sourced
//     directly from token-keeper's OWN `PROVIDERS.quickbooks` registry (kind:"oauth-rotating",
//     tenants[], refreshSecretFor()) -- see keeper.mjs. This is the exact set token-keeper itself
//     refreshes on `refresh --all --force`; reusing that registry means this script can never drift
//     from what token-keeper actually rotates.
//   - Microsoft Graph OneDrive delegated refresh token (`graph-onedrive-refresh-token`): NOT in
//     token-keeper's registry (a separate skill owns it), but genuinely rotates on every use --
//     skills/cfo-onedrive/onedrive.mjs persists the rotated refresh_token via smWrite() on every real
//     OneDrive call (see its header: "The refresh token rotates on use and is auto-persisted to
//     Secret Manager"). Included by name here since it is the fleet's other real rotate-on-use OAuth
//     credential, matching the task's own example ("Microsoft Graph delegated tokens").
//
// WHAT IS DELIBERATELY EXCLUDED, AND WHY (a wrong number is worse than no number):
//   - Xero refresh tokens (xero-refresh-token / xero-refresh-token-<org>), even though token-keeper's
//     own PROVIDERS.xero is ALSO kind:"oauth-rotating". Since 2026-07-16 the otchealth-mcp-server
//     gateway is the SOLE consumer of the live rotate-on-use Xero chain for all 4 orgs -- it keeps the
//     live, rotating token in its OWN Cosmos cache and never writes back to Key Vault/SSM. See
//     skills/xero/xero-token.mjs's guardGatewayOwnedOrg() and its header comment: "the KV
//     `xero-refresh-token-<org>` secrets are now SPENT bootstraps". token-keeper's own `refresh`
//     command would hit that same guard if it ever tried to touch xero for a real org (it currently
//     does not carry the guard itself, which is a latent inconsistency worth fixing separately, but is
//     out of scope here). Concretely: the SSM copy of this secret was last touched by the one-time
//     2026-08-13 GCP->AWS bulk secret migration (verified live -- every Xero secret AND several
//     unrelated ones cluster at the identical migration timestamp, not a real per-secret rotation
//     history), and will NEVER be touched again by a genuine Xero rotation from this point forward.
//     Reporting its age as "time until Xero idle-expires" would be actively wrong: it would climb
//     monotonically toward and past the 1200h threshold regardless of whether the live (Cosmos-held)
//     Xero connection is perfectly healthy, training the on-call to ignore a permanently-red alert.
//     The gateway itself is off-limits to this repo's session (a separate, actively-worked-on
//     component); a real Xero-token-age signal would need to be sourced FROM the gateway's own Cosmos
//     cache, which is a follow-up, not something this script can honestly fabricate from SSM.
//   - Mercury (`mercury-api-token`): token-keeper classifies this `kind:"static-token"` -- a native
//     long-lived API token with no refresh/rotation at all (see keeper.mjs: "native long-lived API
//     token; no refresh, just validate"). It cannot idle-expire the way a rotating refresh token can.
//   - Plaid (`plaid-access-token`): token-keeper classifies this `kind:"no-expire"` (its own comment:
//     "item access_token does not expire; nothing to rotate").
//   - Amazon SP-API (`amzn-sp-refresh-token`): grepped skills/amazon-sp-api/*.mjs -- it exchanges the
//     refresh token for an access token on every call but never persists a NEW refresh token back
//     (no smAddVersion/rotation-persist call anywhere in that skill). Amazon's LWA refresh tokens are
//     long-lived and do not rotate per-use, so it behaves like a static credential for this purpose;
//     it is on the SEPARATE security-hygiene ROTATE-BEFORE-LAUNCH list
//     (skills/signal-radar/detectors/rotate-secret-age.mjs), a different concern ("rotate this
//     periodically for hygiene") from idle-expiry risk.
//   - Any other API key / client secret: static by construction, out of scope for an idle-expiry
//     monitor by definition.
//
// FAILURE IS LOUD: a Datadog submission failure is never swallowed. Every failure is printed to
// stderr with the specific secret + reason, counted in the run summary, and makes the process exit
// non-zero -- so a scheduled runner (GitHub Actions) goes red and the existing page-on-failure.mjs
// path pages a human, instead of a job silently "succeeding" while its telemetry silently vanished
// (the exact bug class skills/fleet-medic/medic.mjs already shipped once and fixed).
//
// AN ABSENT TARGET IS ALSO A FAILURE, for the same reason. rotatingSecrets() is a deliberate
// allowlist of secrets that are supposed to EXIST (see above); a target missing from SSM means one
// was deleted, renamed, or the registry drifted. Treating that as a quiet skip would silently drop
// that secret from monitoring and leave otc.fleet.token_age_hours{secret:<id>} back in the No Data
// state this script exists to end -- undetectably, because the run would still exit 0. Verified
// 2026-09-02 against live SSM that all five expected targets are present, so this is a drift alarm,
// not one that fires on a standing condition. If a target ever becomes legitimately retired, remove
// it from rotatingSecrets() (and from the monitor) rather than letting the run tolerate its absence.
//
// Usage: node token-age-metrics.mjs [--dry-run] [--json]
import { ensureAwsCreds } from "../kb-memory/aws-bootstrap.mjs";
import { ssmParamModifiedMs } from "../kb-memory/aws-secret.mjs";
import { ddMetric } from "../datadog/dd-emit.mjs";
import { PROVIDERS } from "./keeper.mjs";

const DRY_RUN = process.argv.includes("--dry-run");
const JSON_OUT = process.argv.includes("--json");

/** Pure: derive the exact list of {id, label} rotating secrets to track, from token-keeper's own
 *  registry plus the one documented cross-skill addition. Exported for unit testing. */
export function rotatingSecrets(providers = PROVIDERS) {
  const out = [];
  const qbo = providers.quickbooks;
  if (qbo && qbo.kind === "oauth-rotating" && Array.isArray(qbo.tenants)) {
    for (const t of qbo.tenants) out.push({ id: qbo.refreshSecretFor(t), label: `quickbooks:${t}` });
  }
  // Microsoft Graph OneDrive delegated refresh token — not owned by token-keeper's PROVIDERS (see
  // header for why), added explicitly and by name so the exclusion of everything else stays a
  // deliberate allowlist, never an accidental broad sweep.
  out.push({ id: "graph-onedrive-refresh-token", label: "graph:onedrive" });
  return out;
}

/** Pure: did this run fail? Three distinct causes, ONE severity -- each of them means at least one
 *  tracked secret has no fresh otc.fleet.token_age_hours point, which is precisely the per-secret
 *  "No Data" state this script exists to end. `notFound` is the one that used to be excluded: an
 *  absent target was reported to stderr and then exited 0, so a deleted or renamed secret dropped out
 *  of monitoring silently -- the monitor stayed green about a secret it was no longer watching.
 *  Exported for unit testing. */
export function runFailed({ failed = 0, lookupErrors = 0, notFound = 0 } = {}) {
  return failed > 0 || lookupErrors > 0 || notFound > 0;
}

async function main() {
  const targets = rotatingSecrets();
  const haveAws = await ensureAwsCreds();
  if (!haveAws) {
    console.error(
      "[token-age-metrics] FATAL: no AWS credentials resolvable (checked the ECS task role, " +
        "AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY env, and kvSecret aws-cto-access-key-id/" +
        "aws-cto-secret-access-key -- which itself reads AWS SSM, NOT the deleted Key Vault). " +
        "Cannot read SSM; refusing to emit fabricated ages.",
    );
    process.exitCode = 1;
    return;
  }

  const now = Date.now();
  const rows = [];
  // ABSENT vs BROKEN are handled differently ON PURPOSE. ssmParamModifiedMs returns null only for a
  // genuinely missing parameter and THROWS for any other failure (throttle, expired credential, 5xx,
  // network). Collapsing the two here would mean a transient SSM outage reported every secret as
  // "not found", emitted nothing, and still exited 0 -- restoring the monitor to the "No Data" state
  // this whole script exists to end, with nothing left to notice it. A lookup error is therefore a
  // RUN FAILURE (folded into `failed`, which forces the non-zero exit below), while a genuinely
  // absent secret is a reported, non-fatal skip.
  let lookupErrors = 0;
  for (const t of targets) {
    let lastModifiedMs;
    try {
      lastModifiedMs = await ssmParamModifiedMs(t.id);
    } catch (e) {
      lookupErrors++;
      console.error(`[token-age-metrics] SSM LOOKUP FAILED for ${t.id} (${t.label}): ${(e && e.message) || e}`);
      rows.push({ ...t, found: false, lookup_error: (e && e.message) || String(e) });
      continue;
    }
    if (lastModifiedMs == null) {
      // Distinct from a lookup ERROR above (which means "SSM could not answer"): this means SSM
      // answered and the parameter is genuinely gone. Different diagnosis, same severity -- either
      // way this secret is no longer being monitored.
      console.error(
        `[token-age-metrics] NOT FOUND in SSM: ${t.id} (${t.label}) -- this is an EXPECTED rotating ` +
          `secret, so its absence is drift (deleted/renamed/registry stale), not a benign skip. ` +
          `No age emitted; this run FAILS. Fix the secret or remove the target from rotatingSecrets().`,
      );
      rows.push({ ...t, found: false });
      continue;
    }
    const ageHours = (now - lastModifiedMs) / 3600000;
    rows.push({ ...t, found: true, lastModifiedIso: new Date(lastModifiedMs).toISOString(), ageHours });
  }

  let emitted = 0, failed = 0;
  for (const r of rows) {
    if (!r.found) continue;
    if (DRY_RUN) {
      console.log(`[token-age-metrics] DRY-RUN would emit otc.fleet.token_age_hours=${r.ageHours.toFixed(2)} secret:${r.id}`);
      continue;
    }
    const res = await ddMetric("otc.fleet.token_age_hours", r.ageHours, { tags: [`secret:${r.id}`, `provider:${r.label}`], type: "gauge" });
    if (res.ok) {
      emitted++;
    } else {
      failed++;
      console.error(`[token-age-metrics] METRIC EMIT FAILED for secret ${r.id}: ${res.error}`);
    }
  }

  const notFound = rows.filter((r) => !r.found && !r.lookup_error).length;
  const summary = {
    ts: new Date(now).toISOString(),
    tracked: rows.length,
    emitted,
    failed,
    lookup_errors: lookupErrors,
    not_found: notFound,
    dry_run: DRY_RUN,
    rows,
  };
  if (JSON_OUT) console.log(JSON.stringify(summary, null, 2));
  else
    console.log(
      `[token-age-metrics] run complete: ${emitted} emitted, ${failed} send-failed, ` +
        `${lookupErrors} lookup-failed, ${notFound} not found in SSM (tracked ${rows.length}).`,
    );

  // Loud: a metric-send failure, an SSM lookup failure, OR a missing expected target fails this run.
  // A run that could not read the ages is not a run that found nothing -- and only a non-zero exit
  // reaches page-on-failure.mjs. Set exitCode rather than calling process.exit(): stdout is async
  // when it is a pipe (CI always pipes it), so exiting here can truncate the summary that was just
  // written -- the same defect fixed in skills/github-app/gh-app.mjs (see FLEET-BULLETIN.md).
  if (runFailed({ failed, lookupErrors, notFound })) process.exitCode = 1;
}

const isMain = process.argv[1] && process.argv[1].endsWith("token-age-metrics.mjs");
if (isMain) {
  main().catch((e) => {
    console.error("[token-age-metrics] FATAL: " + (e && e.stack || e));
    process.exitCode = 1;
  });
}
