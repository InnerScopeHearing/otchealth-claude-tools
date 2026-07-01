// Detector 5: a secret on the ROTATE-BEFORE-LAUNCH list that has aged past a flagged threshold with
// no evidence of rotation. HIGH PRECISION rationale: the ROTATE list itself is an explicit, curated,
// human-decided set (from otchealth-cto/CLAUDE.md's dated "ROTATE-BEFORE-LAUNCH" entries), not a
// heuristic guess at which secrets "look sensitive" - so there is no ambiguity about WHICH secrets
// matter. The only measurement is Secret Manager's own createTime, i.e. an EXACT integer age (no
// noisy proxy metric), and the threshold is generous (default 180 days) so a routinely-rotated
// secret with a fresh version never fires.
//
// NOTE: Secret Manager's `createTime` on the secret container reflects when the CONTAINER was
// created, not necessarily the latest version's age; a secret whose value was rotated in place
// (new version added, same secret id) will NOT show a younger createTime. This detector is
// deliberately framed as "flag for a manual look," not "definitely stale," to stay high-precision:
// it only fires for secrets on the explicit ROTATE list, and the suggested_action always says to
// verify actual rotation history, not just delete/regenerate blindly.
import { listSecrets } from "../common.mjs";
import { makeSignal } from "../schema.mjs";

export const NAME = "rotate-secret-age";
export const OWNER = "cto"; // security/infra domain

const MAX_AGE_DAYS = 180;

// The curated ROTATE-BEFORE-LAUNCH set, consolidated from the dated entries in otchealth-cto/CLAUDE.md.
// Matched by PREFIX against the live Secret Manager id (so e.g. "github-app" catches
// "github-app-private-key" if that is the actual stored id). Keep this list in sync with CLAUDE.md
// when new ROTATE items are added there; it is intentionally explicit rather than a heuristic guess.
export const ROTATE_LIST = [
  "github-pat", "github-app", "asc-api-key-p8", "azure-sp", "gcp-claude-driver",
  "azure-storage-key", "fingerprint-hmac-secret", "plantid-client-api-key", "revenuecat-secret-key",
  "posthog-personal-api-key", "posthog-phx", "sentry-auth-token", "amzn-lwa-client-id",
  "amzn-lwa-client-secret", "amzn-sp-refresh-token", "amzn-seller-id", "graph-onedrive-refresh-token",
  "xero-refresh-token", "qbo-client-secret", "coo-fire-token",
];

/** Pure core: given [{id, created}] and the rotate-list prefixes, flag matches past MAX_AGE_DAYS.
 * Exported for hermetic unit testing. */
export function findAgedRotateSecrets(secrets, rotateList = ROTATE_LIST, now = new Date(), maxAgeDays = MAX_AGE_DAYS) {
  const out = [];
  for (const s of secrets || []) {
    if (!s.created) continue;
    const match = rotateList.find((p) => s.id.startsWith(p) || s.id.includes(p));
    if (!match) continue;
    const ageDays = Math.round((now - new Date(s.created)) / 86400000);
    if (ageDays >= maxAgeDays) out.push({ id: s.id, matchedPrefix: match, ageDays });
  }
  return out.sort((a, b) => b.ageDays - a.ageDays);
}

export async function run() {
  const notes = [];
  let secrets;
  try { secrets = await listSecrets(); }
  catch (e) { notes.push(`Secret Manager list failed: ${e.message}`); return { signals: [], notes }; }

  const aged = findAgedRotateSecrets(secrets);
  const signals = aged.map((a) => makeSignal({
    detector: NAME, owner: OWNER, subject: a.id, severity: a.ageDays >= 365 ? "high" : "medium",
    why: `Secret "${a.id}" is on the ROTATE-BEFORE-LAUNCH list and its Secret Manager container is ${a.ageDays} days old (>= ${MAX_AGE_DAYS}d threshold).`,
    evidence_link: null,
    suggested_action: `Verify whether "${a.id}" has actually been rotated (a new version can post-date the container); if not, rotate it at the source and run setup/set-secret.mjs to store the new value.`,
  }));
  return { signals, notes };
}
