#!/usr/bin/env node
// personal-store.mjs — a tiny, INDEPENDENT Azure Blob SharedKey helper scoped to ONLY the `personal`
// container of the CLO's legal store (account otchealthlegalstore). Used exclusively to persist
// legal-deadline-pager cooldown state for personal-namespace (Matt's confidential CA matters) docket
// rows, so a personal deadline cannot page repeatedly without ever writing personal content anywhere
// outside that same confidential, access-controlled container.
//
// Deliberately duplicated (not imported) from skills/legal/legal.mjs's own blob helpers: legal.mjs is
// not designed as a shared library for its Azure Blob internals (they are unexported implementation
// detail) and may change independently of this pager. This file re-implements the exact same minimal
// SharedKey scheme so it never depends on legal.mjs's internals -- same account, same `personal`
// container, same confidentiality ring, just a second small independent client against it.
//
// CONTENT DISCIPLINE: the cooldown map is keyed by an OPAQUE sha256 hash (pager.mjs's rowKey()), never
// the docket row's cleartext date/description. So even this private-container blob carries no
// privileged case detail, only "this opaque key was last paged at this timestamp" -- defense in depth
// on top of the container-level access control.
//
// Fail-open by convention (matches every other credential-touching module in this fleet): a missing key
// or an unreachable store degrades to an empty/no-op result and a clear log line, never a thrown error,
// so a store outage can never crash the sweep. Worst case on an outage: cooldown does not persist and a
// row may re-page on the next run -- preferred over silently losing legal-deadline visibility.
import crypto from "node:crypto";
import { kvSecret } from "../kb-memory/azure-secret.mjs";

const ACCT = process.env.AZURE_LEGAL_STORAGE_ACCOUNT || "otchealthlegalstore";
const AVER = "2021-06-08";
const CONTAINER = "personal";
const BLOB_NAME = "pager-state/cooldown.json";

async function legalStorageKey() {
  return process.env.AZURE_LEGAL_STORAGE_KEY || (await kvSecret("azure-legal-storage-key"));
}

function azSig(method, account, key, container, blob, xms, contentLength, contentType) {
  const canonHeaders = Object.keys(xms).sort().map((k) => `${k.toLowerCase()}:${xms[k]}`).join("\n") + "\n";
  const canonResource = `/${account}/${container}${blob ? `/${blob}` : ""}`;
  const sts = [method, "", "", contentLength || "", "", contentType || "", "", "", "", "", "", "", canonHeaders + canonResource].join("\n");
  return `SharedKey ${account}:${crypto.createHmac("sha256", Buffer.from(key, "base64")).update(sts, "utf8").digest("base64")}`;
}

/** Read the personal cooldown map ({ [opaqueRowKey]: { last_paged_at: ISOString } }). Returns {} if the
 *  blob does not exist yet, or the store/key is unreachable -- never throws. */
export async function getPersonalCooldown() {
  const key = await legalStorageKey();
  if (!key) { console.log("[legal-deadline-pager] personal cooldown store not reachable in this environment (treating as empty)."); return {}; }
  try {
    const xms = { "x-ms-date": new Date().toUTCString(), "x-ms-version": AVER };
    const auth = azSig("GET", ACCT, key, CONTAINER, BLOB_NAME, xms, "", "");
    const r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${BLOB_NAME}`, { headers: { ...xms, Authorization: auth } });
    if (r.status === 404) return {};
    if (!r.ok) { console.log(`[legal-deadline-pager] personal cooldown store read HTTP ${r.status} (treating as empty).`); return {}; }
    const j = await r.json();
    return j && typeof j === "object" ? j : {};
  } catch (e) {
    console.log(`[legal-deadline-pager] personal cooldown store read failed (${e.message}); treating as empty.`);
    return {};
  }
}

/** Persist the personal cooldown map. Returns true on success, false otherwise -- never throws. */
export async function putPersonalCooldown(map) {
  const key = await legalStorageKey();
  if (!key) { console.log("[legal-deadline-pager] personal cooldown store not reachable in this environment (cooldown not persisted)."); return false; }
  try {
    const body = JSON.stringify(map || {});
    const xms = { "x-ms-blob-type": "BlockBlob", "x-ms-date": new Date().toUTCString(), "x-ms-version": AVER };
    const ct = "application/json";
    const auth = azSig("PUT", ACCT, key, CONTAINER, BLOB_NAME, xms, String(Buffer.byteLength(body)), ct);
    const r = await fetch(`https://${ACCT}.blob.core.windows.net/${CONTAINER}/${BLOB_NAME}`, { method: "PUT", headers: { ...xms, "Content-Type": ct, Authorization: auth }, body });
    if (!r.ok) { console.log(`[legal-deadline-pager] personal cooldown store write HTTP ${r.status}.`); return false; }
    return true;
  } catch (e) {
    console.log(`[legal-deadline-pager] personal cooldown store write failed (${e.message}).`);
    return false;
  }
}
