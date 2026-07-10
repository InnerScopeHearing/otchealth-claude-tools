// kb-memory / blob-lease.mjs — dependency-free (fetch-based, no Azure SDK) exclusive-write lease for
// a SINGLE Azure Blob, using the native Lease Blob REST operation (`PUT ...?comp=lease`,
// `x-ms-lease-action: acquire|renew|release|break`). This is the fleet's general-purpose version of
// the one-off lock skills/doc-indexer/indexer.mjs already grew for its own catalog.jsonl (see its
// LOCK_BLOB / leaseAcquire / leaseRenew / leaseRelease, ~line 214-230) — same header contract, same
// create-lock-blob-if-absent bootstrap, factored out so any skill that PUTs a shared blob can adopt
// it without re-deriving the REST call.
//
// ROADMAP A8-BLOB-LEASE ("Blob-lease single-writer for shared-state writes, avoid Redlock — no
// fencing tokens"): the roadmap's Redlock critique is about multi-node Redis quorum locks, which
// have no fencing token and can be lost/duplicated across a network partition between nodes that
// don't agree on time. Azure Blob's native lease is a different, safer category: a SINGLE-AUTHORITY
// lease service (the blob service itself), and it DOES support a fencing-token-shaped guarantee —
// once acquired, every subsequent write to the leased blob MUST carry the matching `x-ms-lease-id`
// or the service rejects it (412 Precondition Failed / 409 Conflict), so a stale/expired holder
// cannot silently clobber a newer lease the way an un-fenced Redlock holder can. It is not a literal
// monotonic counter fencing token like Cosmos ETags (see skills/decision-clock/cosmos-client.mjs's
// If-Match usage) — it's "possession of the current lease ID", checked server-side on every write —
// but it closes the same hole Redlock's critics point at (a lock holder that no longer holds
// authority can still mutate state). For structured, queryable, multi-writer data, this fleet's
// Cosmos ETag/If-Match pattern remains the right tool; this module is for the OTHER half of the
// fleet's state: unstructured blob artifacts (compacted ledger summaries, doc-indexer catalogs,
// memory-librarian digests, ...) where two writers hitting the SAME blob path concurrently today
// either do a plain unconditional PUT (silent last-write-wins) or at best an ETag-conditional PUT
// retry loop (correct, but doesn't stop a slow/hung writer from resuming mid-lease and stomping a
// blob a faster writer already moved on from — a real lease holds the blob EXCLUSIVE for the whole
// operation, not just the instant of the PUT).
//
// Verified against Microsoft Learn (2026-07-05, live fetch) — NOT purely training-data recall:
//   https://learn.microsoft.com/en-us/rest/api/storageservices/lease-blob
// Confirmed header names/semantics: x-ms-lease-action (acquire|renew|change|release|break),
// x-ms-lease-id (required on renew/change/release, and on ANY write/delete to a leased blob),
// x-ms-lease-duration (15-60 seconds, or -1 for infinite; specified only on acquire),
// x-ms-proposed-lease-id (optional on acquire, required on change). Status codes below (201 on
// successful acquire, 409 when already leased by someone else, 412 when your lease-id no longer
// matches e.g. because it expired/was broken) match what skills/doc-indexer/indexer.mjs already
// observes live in this fleet (its leaseAcquire() checks exactly r.status === 201 / 409) — so the
// status-code contract is fleet-verified, not just doc-read. What the REVIEWER should still confirm
// live before trusting this for a new caller (see "LIVE-VERIFY" below): the exact status code this
// fleet's storage account returns for a RENEW after the lease has expired (docs say a renew can
// still succeed post-expiry if the blob wasn't re-leased/modified meanwhile, but that edge case is
// not exercised by doc-indexer's fire-and-forget renew and this module has not been run live here).
//
// Auth: mirrors skills/ledger-compaction/job/run-compaction.mjs's buildSas/getText/putText style
// exactly — same URL construction (`https://{account}.blob.core.windows.net/{container}/{blob}`),
// same query-string auth. Accepts EITHER a SAS query string (this fleet's usual `?sv=...&sig=...`,
// built by every skill's local buildSas()) or a bearer token (Entra ID / managed-identity path, see
// skills/kb-memory/azure-secret.mjs's post-GCP-retirement identity token), auto-detected: a SAS's
// query string starts with `sv=`, a bearer token does not (and is sent as `Authorization: Bearer`
// instead of appended to the URL).
//
// USAGE EXAMPLE (illustrative only — this file does NOT modify run-compaction.mjs):
//   A future caller in skills/ledger-compaction/job/run-compaction.mjs could wrap its existing
//   putText(acct, cfg.container, sas, outName, md, "text/markdown; charset=utf-8") write like this:
//
//     import { withLease } from "../../kb-memory/blob-lease.mjs";
//
//     const outUrl = `https://${acct}.blob.core.windows.net/${cfg.container}/${encPath(outName)}`;
//     await withLease(outUrl, sas, async (leaseId) => {
//       // same putText body as today, but pass the lease id through so the write is accepted by a
//       // blob that is currently under lease (Azure rejects a write to a leased blob that omits it).
//       await putText(acct, cfg.container, sas, outName, md, "text/markdown; charset=utf-8", leaseId);
//     }, { durationSeconds: 60, maxWaitMs: 15000 });
//
//   (putText would need one extra optional `leaseId` param that adds `"x-ms-lease-id": leaseId` to
//   its PUT headers when present — a small, additive change, not made here.)
//
// LIVE-VERIFY before trusting this module in production (no live Azure creds were available in this
// sandbox — see header comment in the accompanying report):
//   1. node --check skills/kb-memory/blob-lease.mjs                      (syntax only, already run)
//   2. Real round-trip against a throwaway blob path, e.g.:
//        node -e '
//          import("./skills/kb-memory/blob-lease.mjs").then(async (m) => {
//            const url = "https://<acct>.blob.core.windows.net/<container>/_TEST/lease-check.txt";
//            const sas = "<sv=...&sig=...>";
//            const id = await m.acquireLease(url, sas, 30);
//            console.log("acquired", id);
//            await m.renewLease(url, sas, id);
//            console.log("renewed");
//            await m.releaseLease(url, sas, id);
//            console.log("released");
//          });'
//      Confirm: acquire returns a GUID lease id and a 201; a SECOND concurrent acquireLease() against
//      the same blob (before release) fails with the "already leased" error (409); release lets that
//      second attempt succeed immediately after.
//   3. Confirm a plain PUT to the SAME blob while it is leased, WITHOUT x-ms-lease-id, is rejected
//      (expected 412) — this is the actual single-writer guarantee this module exists to provide;
//      it has not been observed live in this sandbox.

import crypto from "node:crypto";

// A SAS query string always starts with `sv=` (storage-service-version is the first component every
// buildSas() in this fleet emits, e.g. skills/ledger-compaction/job/run-compaction.mjs's buildSas).
// A bearer token never starts with `sv=`, so this is a safe, simple discriminator — no need to ask
// the caller to say which kind they're passing.
function isSas(sasOrToken) {
  return typeof sasOrToken === "string" && sasOrToken.startsWith("sv=");
}

// Build the {url, headers} for one blob-lease REST call, handling both auth shapes. `url` is the
// blob's base URL WITHOUT any query string (this module appends `?{sas}&comp=lease` or `?comp=lease`
// itself, so callers pass the same bare blob URL to every function here).
function leaseRequest(url, sasOrToken, extraHeaders) {
  const headers = { ...extraHeaders };
  let fullUrl;
  if (isSas(sasOrToken)) {
    fullUrl = `${url}?${sasOrToken}&comp=lease`;
  } else {
    fullUrl = `${url}?comp=lease`;
    headers.Authorization = `Bearer ${sasOrToken}`;
    headers["x-ms-version"] = headers["x-ms-version"] || "2021-12-02"; // required header for the bearer/Entra path; SAS embeds its own sv=
  }
  return { fullUrl, headers };
}

// Ensure the lock blob itself exists (Lease Blob 404s on a blob that was never created). Mirrors
// doc-indexer's "create-if-absent, ignore exists/leased" bootstrap: an empty 0-byte BlockBlob is
// enough to lease. Safe to call every time; a concurrent creator racing on If-None-Match just loses
// harmlessly (its own create fails, the blob is already there, which is exactly what we want).
async function ensureBlobExists(url, sasOrToken) {
  const headers = { "x-ms-blob-type": "BlockBlob", "Content-Length": "0" };
  let fullUrl;
  if (isSas(sasOrToken)) {
    fullUrl = `${url}?${sasOrToken}`;
    headers["If-None-Match"] = "*";
  } else {
    fullUrl = url;
    headers.Authorization = `Bearer ${sasOrToken}`;
    headers["x-ms-version"] = "2021-12-02";
    headers["If-None-Match"] = "*";
  }
  try {
    await fetch(fullUrl, { method: "PUT", headers, body: "" });
  } catch {
    // ignore: blob already exists, transient network blip, etc. — acquireLease's own fetch below is
    // the real signal; this is best-effort bootstrap only.
  }
}

/**
 * Acquire an exclusive lease on the blob at `url`.
 *
 * @param {string} url - bare blob URL, no query string (e.g. `https://acct.blob.core.windows.net/container/path/to/blob`).
 * @param {string} sasOrToken - a SAS query string (starts with `sv=`) or a bearer token.
 * @param {number} [durationSeconds=60] - lease duration, 15-60 seconds, or -1 for an infinite lease
 *   (Azure enforces this range server-side; pass -1 deliberately, not as a mistaken "no timeout").
 * @returns {Promise<string>} the lease id (GUID string) on success.
 * @throws if the blob is already leased by someone else (409), the request is malformed (400), or
 *   any other non-201 response.
 */
export async function acquireLease(url, sasOrToken, durationSeconds = 60) {
  await ensureBlobExists(url, sasOrToken);
  const proposed = crypto.randomUUID();
  const { fullUrl, headers } = leaseRequest(url, sasOrToken, {
    "x-ms-lease-action": "acquire",
    "x-ms-lease-duration": String(durationSeconds),
    "x-ms-proposed-lease-id": proposed,
  });
  const r = await fetch(fullUrl, { method: "PUT", headers });
  if (r.status === 201) return r.headers.get("x-ms-lease-id") || proposed;
  const body = await r.text().catch(() => "");
  const reason = r.status === 409 ? "already leased by another writer" : `unexpected status`;
  throw new Error(`acquireLease ${r.status} (${reason}): ${body.slice(0, 160)}`);
}

/**
 * Renew an existing lease before it expires. Fire-and-forget style callers (like doc-indexer's
 * leaseRenew) may prefer to swallow errors themselves; this function throws on failure so a
 * withLease() renew loop can decide whether a failed renew should abort the held work.
 *
 * @param {string} url - same bare blob URL passed to acquireLease.
 * @param {string} sasOrToken - SAS or bearer token, as above.
 * @param {string} leaseId - the id returned by acquireLease.
 * @returns {Promise<string>} the (possibly re-confirmed) lease id.
 */
export async function renewLease(url, sasOrToken, leaseId) {
  const { fullUrl, headers } = leaseRequest(url, sasOrToken, {
    "x-ms-lease-action": "renew",
    "x-ms-lease-id": leaseId,
  });
  const r = await fetch(fullUrl, { method: "PUT", headers });
  if (r.status === 200) return r.headers.get("x-ms-lease-id") || leaseId;
  const body = await r.text().catch(() => "");
  throw new Error(`renewLease ${r.status}: ${body.slice(0, 160)}`);
}

/**
 * Release a held lease, freeing the blob for the next writer immediately (rather than waiting out
 * the remaining duration). Safe to call even if the lease may already be gone (expired/broken) —
 * callers that want fully-silent best-effort release should wrap this in their own try/catch (see
 * withLease's finally block below for the canonical example).
 *
 * @param {string} url - same bare blob URL.
 * @param {string} sasOrToken - SAS or bearer token.
 * @param {string} leaseId - the id to release.
 * @returns {Promise<void>}
 */
export async function releaseLease(url, sasOrToken, leaseId) {
  const { fullUrl, headers } = leaseRequest(url, sasOrToken, {
    "x-ms-lease-action": "release",
    "x-ms-lease-id": leaseId,
  });
  const r = await fetch(fullUrl, { method: "PUT", headers });
  if (r.status !== 200) {
    const body = await r.text().catch(() => "");
    throw new Error(`releaseLease ${r.status}: ${body.slice(0, 160)}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Convenience wrapper: acquire a lease (retrying on 409 "already leased" up to `maxWaitMs`), run
 * `fn(leaseId)`, and ALWAYS release the lease afterward (try/finally), even if `fn` throws or an
 * acquire/renew step fails partway through. This is the drop-in a skill's existing putText()-style
 * write should wrap (see the header comment's run-compaction.mjs example).
 *
 * A lightweight auto-renew timer keeps the lease alive at ~2/3 of `durationSeconds` intervals for
 * the lifetime of `fn`, so a long-running `fn` (e.g. a multi-blob compaction pass) does not lose the
 * lease mid-operation just because it outran the initial duration. Renew failures are logged to
 * stderr but do not abort `fn` — the final release (or the next writer's 412 on an unfenced write)
 * is the backstop, matching this fleet's fail-open philosophy elsewhere (e.g.
 * skills/ledger-compaction/job/run-compaction.mjs's per-agent fail-open loop).
 *
 * @param {string} url - bare blob URL (no query string).
 * @param {string} sasOrToken - SAS query string or bearer token.
 * @param {(leaseId: string) => Promise<any>} fn - the critical section; receives the lease id so it
 *   can pass `x-ms-lease-id` on its own writes to the SAME blob (a lease on the LOCK blob does not
 *   automatically cover writes to a DIFFERENT blob — see note below).
 * @param {{durationSeconds?: number, maxWaitMs?: number}} [opts]
 * @returns {Promise<any>} whatever `fn` returns.
 *
 * NOTE on lock-blob-vs-target-blob: like doc-indexer's LOCK_BLOB pattern, the simplest and most
 * portable use is to lease a DEDICATED lock blob (e.g. `_LOCKS/<name>.lock`) next to the real
 * artifact, and let `fn` write the real artifact unconditionally once it holds that lock — this
 * works even for artifacts that get fully REPLACED (not just appended-to) each run, and does not
 * require every writer of the real blob to thread a lease id through. If you instead lease the
 * target blob ITSELF (so Azure enforces the exclusion natively on the write, not just by convention
 * among cooperating callers), `fn` MUST pass the returned leaseId as `x-ms-lease-id` on its PUT, or
 * Azure will reject the write with 412 while the lease is held by this same call.
 */
export async function withLease(url, sasOrToken, fn, opts = {}) {
  const durationSeconds = opts.durationSeconds ?? 60;
  const maxWaitMs = opts.maxWaitMs ?? 30_000;
  const pollMs = 1000;

  const deadline = Date.now() + maxWaitMs;
  let leaseId = null;
  for (;;) {
    try {
      leaseId = await acquireLease(url, sasOrToken, durationSeconds);
      break;
    } catch (e) {
      if (Date.now() >= deadline) throw new Error(`withLease: could not acquire lease within ${maxWaitMs}ms: ${e.message}`);
      await sleep(pollMs);
    }
  }

  let renewTimer = null;
  if (durationSeconds > 0) {
    const renewMs = Math.max(1000, Math.floor((durationSeconds * 1000 * 2) / 3));
    renewTimer = setInterval(() => {
      renewLease(url, sasOrToken, leaseId).catch((e) => {
        console.error(`[blob-lease] renew failed for ${url}: ${e.message} (lease may expire; release/next-writer 412 is the backstop)`);
      });
    }, renewMs);
  }

  try {
    return await fn(leaseId);
  } finally {
    if (renewTimer) clearInterval(renewTimer);
    try {
      await releaseLease(url, sasOrToken, leaseId);
    } catch (e) {
      // Best-effort: if release fails (network blip, lease already expired/broken), the lease will
      // simply time out on its own after `durationSeconds` — never let a release failure mask the
      // real error from `fn` (this catch swallows only the release's own error).
      console.error(`[blob-lease] release failed for ${url}: ${e.message} (will self-expire in <= ${durationSeconds}s)`);
    }
  }
}
