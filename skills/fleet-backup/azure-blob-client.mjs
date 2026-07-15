// azure-blob-client.mjs — minimal Azure Blob Storage REST client (List Blobs / GET blob / PUT block
// blob / container HEAD), shared by s3-mirror.mjs and restore-drill.mjs (Phase 6 S3 DR mirror).
//
// AUTH mirrors skills/fleet-backup/backup.mjs's own blob auth EXACTLY (managed identity via the
// Container Apps IDENTITY_ENDPOINT/IDENTITY_HEADER sidecar — the same credential-free path backup.mjs
// already uses in production to WRITE this exact `ledger-backup` container), with one addition: an
// AZURE_SP_* client_credentials fallback (same shape as skills/kb-memory/azure-secret.mjs's SP path,
// retargeted from the vault.azure.net resource to storage.azure.com — that shared helper is
// Key-Vault-only and has no generic "mint me a token for resource X" export, so it can't be reused
// as-is for Blob Storage). The fallback exists purely so this file works UNCHANGED both as a
// Container Apps Job (managed identity; the fallback never triggers there) and ad hoc from an
// interactive Claude Code session, which has AZURE_SP_* env but no managed identity — e.g. testing
// this script or running a restore drill on demand, before it is ever deployed as a scheduled job.
//
// No SDK dependency (matches the fleet's dependency-light .mjs convention set by backup.mjs and
// skills/amazon-sp-api/sp-api.mjs — built-in fetch + node:crypto only).

let _tok = null, _exp = 0, _authMode = null;

async function identityToken(resource) {
  const endpoint = process.env.IDENTITY_ENDPOINT;
  const header = process.env.IDENTITY_HEADER;
  if (!endpoint || !header) return null;
  try {
    const clientIdQS = process.env.AZURE_UAMI_CLIENT_ID ? `&client_id=${encodeURIComponent(process.env.AZURE_UAMI_CLIENT_ID)}` : "";
    const r = await fetch(`${endpoint}?resource=${encodeURIComponent(resource)}&api-version=2019-08-01${clientIdQS}`, {
      headers: { "x-identity-header": header },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.access_token || null;
  } catch {
    return null;
  }
}

async function spToken(resource) {
  const tenant = process.env.AZURE_SP_TENANT_ID;
  const cid = process.env.AZURE_SP_CLIENT_ID;
  const csec = process.env.AZURE_SP_CLIENT_SECRET;
  if (!tenant || !cid || !csec) return null;
  try {
    const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: cid, client_secret: csec, scope: `${resource}/.default` }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.access_token || null;
  } catch {
    return null;
  }
}

/** Mint (and cache) a storage.azure.com bearer token: managed identity first, AZURE_SP_* fallback
 *  second. Never throws; returns null if neither path yields a token. */
export async function blobToken() {
  const now = Date.now();
  if (_tok && _exp - now > 60_000) return _tok;
  const resource = "https://storage.azure.com";
  let tok = await identityToken(resource);
  _authMode = tok ? "identity" : null;
  if (!tok) {
    tok = await spToken(resource);
    if (tok) _authMode = "sp";
  }
  if (!tok) return null;
  _tok = tok;
  _exp = now + 3600_000;
  return tok;
}

/** Which auth path last succeeded ("identity" | "sp" | null) — diagnostics only. */
export function blobAuthMode() {
  return _authMode;
}

function xmlUnescape(s) {
  // &amp; MUST be unescaped LAST: unescaping it first would let a literal "&amp;lt;" become "&lt;"
  // and then "<" (double-unescape). Entity refs first, ampersand last, avoids that.
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/**
 * List every blob in a container (paginated via NextMarker; Azure caps a single List Blobs page,
 * so this loops until NextMarker is absent). Returns [{ name, bytes, lastModified }].
 */
export async function listBlobs(account, container) {
  const items = [];
  let marker = "";
  for (;;) {
    const tok = await blobToken();
    if (!tok) throw new Error("could not mint a storage.azure.com token (checked managed identity, then AZURE_SP_* client_credentials)");
    const url = `https://${account}.blob.core.windows.net/${container}?restype=container&comp=list&maxresults=5000${marker ? `&marker=${encodeURIComponent(marker)}` : ""}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, "x-ms-version": "2023-11-03" } });
    if (!r.ok) throw new Error(`List Blobs failed: ${r.status} ${(await r.text()).slice(0, 300)}`);
    const xml = await r.text();
    for (const m of xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) {
      const block = m[1];
      const name = (block.match(/<Name>([\s\S]*?)<\/Name>/) || [])[1];
      const lenStr = (block.match(/<Content-Length>([\s\S]*?)<\/Content-Length>/) || [])[1];
      const lastMod = (block.match(/<Last-Modified>([\s\S]*?)<\/Last-Modified>/) || [])[1];
      if (name) items.push({ name: xmlUnescape(name), bytes: lenStr ? Number(lenStr) : null, lastModified: lastMod || null });
    }
    const nm = (xml.match(/<NextMarker>([\s\S]*?)<\/NextMarker>/) || [])[1];
    if (!nm) break;
    marker = xmlUnescape(nm);
  }
  return items;
}

/** Download a blob's full content as a Buffer. Throws on any non-2xx (including 404 — callers that
 *  want a soft-miss should check listBlobs()/manifest state first, this mirrors backup.mjs's own
 *  getBlob-shaped calls which always expect the blob to exist). */
export async function getBlob(account, container, blobName) {
  const tok = await blobToken();
  if (!tok) throw new Error("could not mint a storage.azure.com token");
  const url = `https://${account}.blob.core.windows.net/${container}/${blobName}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, "x-ms-version": "2023-11-03" } });
  if (!r.ok) throw new Error(`GET blob ${blobName} failed: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return Buffer.from(await r.arrayBuffer());
}

/** Upload a Buffer as a Block Blob (single PUT — fine for the small manifest/report artifacts this
 *  module writes; large multi-block streaming is deliberately out of scope here, see backup.mjs's
 *  exportBrainIndexToBlob for that pattern if it is ever needed in this file). Identical REST shape
 *  to backup.mjs's own putBlockBlob. */
export async function putBlockBlob(account, container, blobName, buffer, contentType) {
  const tok = await blobToken();
  if (!tok) throw new Error("could not mint a storage.azure.com token");
  const url = `https://${account}.blob.core.windows.net/${container}/${blobName}`;
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${tok}`,
      "x-ms-version": "2023-11-03",
      "x-ms-blob-type": "BlockBlob",
      "Content-Type": contentType || "application/octet-stream",
      "Content-Length": String(buffer.length),
    },
    body: buffer,
  });
  if (!r.ok) throw new Error(`PUT blob ${blobName} failed: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return { etag: r.headers.get("etag") };
}

export async function containerExists(account, container) {
  const tok = await blobToken();
  if (!tok) return false;
  const url = `https://${account}.blob.core.windows.net/${container}?restype=container`;
  const r = await fetch(url, { method: "HEAD", headers: { Authorization: `Bearer ${tok}`, "x-ms-version": "2023-11-03" } });
  return r.status === 200;
}
