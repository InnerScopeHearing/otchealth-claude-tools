#!/usr/bin/env node
// personal-store.mjs — a tiny, INDEPENDENT S3 helper scoped to ONLY the `personal` container of the
// CLO's legal store (mirror account name `otchealthlegalstore`, resolved through the SAME
// (account, container) -> (bucket, keyPrefix) MIRROR table ../kb-memory/s3-blob.mjs uses -- a
// faithful port of the identical table otchealth-mcp-server's src/legal/s3-blob-store.ts uses in
// production, so this file and the gateway read/write the EXACT SAME physical S3 object). Used
// exclusively to persist legal-deadline-pager cooldown state for personal-namespace (Matt's
// confidential CA matters) docket rows, so a personal deadline cannot page repeatedly without ever
// writing personal content anywhere outside that same confidential, access-controlled container.
//
// AZURE BLOB IS DEAD (2026-08-28 port; Azure subscription 55c84f6b was permanently deleted
// 2026-08-13). `otchealthlegalstore/personal` resolves, via that MIRROR table, to its OWN dedicated
// bucket otchealth-legal-personal-dr-55c84f6b -- never the shared finance-legal bucket company
// matters live in.
//
// Deliberately duplicated (not imported) from skills/legal/legal.mjs's own store helpers: legal.mjs is
// not designed as a shared library for its S3 internals (they are unexported implementation detail)
// and may change independently of this pager. This file re-implements the exact same minimal
// get/put shape directly against ../kb-memory/s3-blob.mjs so it never depends on legal.mjs's
// internals -- same account, same `personal` container, same confidentiality ring, just a second
// small independent client against it.
//
// CONTENT DISCIPLINE: the cooldown map is keyed by an OPAQUE sha256 hash (pager.mjs's rowKey()), never
// the docket row's cleartext date/description. So even this private-container blob carries no
// privileged case detail, only "this opaque key was last paged at this timestamp" -- defense in depth
// on top of the container-level access control.
//
// READ/WRITE ASYMMETRY IS DELIBERATE. READS stay fail-open, matching every other credential-touching
// module in this fleet: a missing object or an unreachable store degrades to an empty/no-op result
// and a clear log line, never a thrown error, so a store outage can never crash the sweep. WRITES do
// NOT fail open. As of this port the live IAM grant on the personal-legal DR bucket is intentionally
// GetObject+ListBucket ONLY for every toolkit/job identity ("PersonalLegalRingReadOnly" -- see
// otchealth-mcp-server's src/legal/s3-blob-store.ts header and blob-store.ts's
// S3_WRITABLE_CONTAINERS comment for the full history; a Terraform-only rename to
// "PersonalLegalRingReadWrite" describes a PROPOSED widening, never yet applied to the live account),
// pending an explicit Matt approval to widen it. A write therefore reaches AWS for real and gets a
// genuine 403 AccessDenied. That is an EXPECTED, PERMANENT-UNTIL-APPROVED condition, not a transient
// outage, so it is surfaced LOUD (thrown, with a distinct message naming the gate) rather than folded
// into the same silent "treat as empty/no-op" path reads use -- never add a catch here that turns a
// write failure back into a quiet `false`. The caller (pager.mjs's runSweep) already wraps this call
// in its own `.catch()` for its documented fail-open SWEEP semantics, so a thrown error here changes
// nothing about the sweep's control flow, only what shows up in the log and in any caller that does
// inspect the rejection.
import { getTextFromS3, putObjectToS3 } from "../kb-memory/s3-blob.mjs";

const ACCT = process.env.AZURE_LEGAL_STORAGE_ACCOUNT || "otchealthlegalstore";
const CONTAINER = "personal";
const BLOB_NAME = "pager-state/cooldown.json";

/** The exact, standing reason a personal-legal WRITE is refused as of this port. Exported so tests
 *  (and any future caller that wants to detect this specific condition) assert against this constant
 *  rather than duplicating the literal string. */
export const PERSONAL_WRITE_IAM_GATE_MESSAGE =
  "personal-legal S3 writes are IAM-gated pending owner approval (PersonalLegalRingReadOnly)";

/** Read the personal cooldown map ({ [opaqueRowKey]: { last_paged_at: ISOString } }). Returns {} if the
 *  object does not exist yet, or the store is unreachable -- never throws (fail-open; see header). */
export async function getPersonalCooldown() {
  try {
    const text = await getTextFromS3(ACCT, CONTAINER, BLOB_NAME);
    if (text === null) return {}; // genuinely no cooldown state yet (first-ever sweep)
    const j = JSON.parse(text);
    return j && typeof j === "object" ? j : {};
  } catch (e) {
    console.log(`[legal-deadline-pager] personal cooldown store read failed (${e.message}); treating as empty.`);
    return {};
  }
}

/**
 * Persist the personal cooldown map. Resolves `true` on success. REJECTS (never returns `false`) on
 * any write failure -- see the header for why this deliberately does NOT match getPersonalCooldown's
 * fail-open contract. A 403 (the standing, expected IAM-gate condition) rejects with the exact
 * `PERSONAL_WRITE_IAM_GATE_MESSAGE`; any OTHER failure (network, missing credentials, an unexpected
 * 5xx) still rejects loud, with its own real cause, rather than being mislabeled as the IAM gate.
 */
export async function putPersonalCooldown(map) {
  const body = JSON.stringify(map || {});
  try {
    await putObjectToS3(ACCT, CONTAINER, BLOB_NAME, body, "application/json");
    return true;
  } catch (e) {
    if (e && e.status === 403) {
      console.error(`[legal-deadline-pager] personal cooldown store write refused: ${PERSONAL_WRITE_IAM_GATE_MESSAGE}.`);
      throw new Error(PERSONAL_WRITE_IAM_GATE_MESSAGE);
    }
    console.error(`[legal-deadline-pager] personal cooldown store write FAILED (${e.message}).`);
    throw new Error(`personal cooldown store write failed: ${e.message}`);
  }
}
