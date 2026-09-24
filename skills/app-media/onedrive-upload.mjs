// onedrive-upload.mjs -- a minimal, self-contained Microsoft Graph client for uploading app-media
// files to an ARBITRARY path in Matt's OneDrive (not the CFO/CTO three-folder exchange).
//
// Deliberately NOT built on top of skills/cfo-onedrive/onedrive.mjs's `upload` command: that
// command does a single PUT :/content, which Microsoft Graph rejects once a file crosses the small
// simple-upload ceiling (Device Farm run videos here are routinely ~30 MB), and onedrive.mjs
// exports no functions to import into another module -- it is a CLI script whose logic all runs at
// the top level. Per this skill's own build brief: "implement a Graph upload session in the new
// skill rather than changing the shared engine." This module always uses a resumable upload
// session (POST createUploadSession + chunked PUT), for every file regardless of size, so there is
// exactly one upload code path to reason about instead of a small-file/large-file branch.
//
// Auth mirrors skills/cfo-onedrive/onedrive.mjs's own accessToken(): a delegated refresh token
// (graph-onedrive-refresh-token in the credential store) traded against the same GRAPH_MAIL_* app
// registration. A rotated refresh token is persisted back via kvSecretSet, exactly like the CFO
// engine does, so a later run keeps working after Microsoft rotates it.
//
// Ring: non-PHI (same as every other OneDrive skill in this repo).

import { kvSecret, kvSecretSet } from "../kb-memory/azure-secret.mjs";

const GRAPH = "https://graph.microsoft.com/v1.0";
// Every non-final upload-session fragment must be a multiple of 320 KiB (327,680 bytes) per
// Graph's contract. 32 * 327,680 = 10,485,760 bytes exactly (10 MiB), inside Microsoft's
// recommended 5-10 MiB fragment-size window.
const CHUNK_SIZE = 32 * 327_680;

function encPath(p) {
  return String(p).split("/").filter(Boolean).map(encodeURIComponent).join("/");
}
function itemRef(path) {
  return path && path !== "/" ? `/me/drive/root:/${encPath(path)}` : "/me/drive/root";
}

async function envOrSecret(envName, secretId) {
  if (process.env[envName]) return process.env[envName];
  const v = await kvSecret(secretId);
  if (!v) throw new Error(`app-media/onedrive-upload: missing ${envName} (secret "${secretId}")`);
  return v;
}

let _tokenCache = null; // {token, expiresAt} -- process-local, not persisted, mirrors onedrive.mjs's own no-cache-across-runs posture except within a single archive.mjs invocation that uploads many files.

/** Resolve a Graph access token via the delegated refresh-token grant. Exported (not just used
 *  internally) so the CLI/tests can probe credential availability without also exercising the
 *  upload-session path. */
export async function accessToken() {
  if (_tokenCache && _tokenCache.expiresAt > Date.now() + 60_000) return _tokenCache.token;
  const refreshKey = "graph-onedrive-refresh-token";
  const refresh = await kvSecret(refreshKey);
  if (!refresh) {
    throw new Error(`app-media/onedrive-upload: no ${refreshKey} in the credential store. Run the OneDrive consent first (see skills/cfo-onedrive).`);
  }
  const tenant = await envOrSecret("GRAPH_MAIL_TENANT_ID", "graph-mail-tenant-id");
  const clientId = await envOrSecret("GRAPH_MAIL_CLIENT_ID", "graph-mail-client-id");
  const clientSecret = process.env.GRAPH_MAIL_CLIENT_SECRET || (await kvSecret("graph-mail-client-secret")) || "";

  // The app registration is both confidential and a public client. Whether a token refreshes WITH
  // or WITHOUT a client secret depends on how it was originally issued (see onedrive.mjs's own
  // comment on this same quirk), so try without first and fall back on the specific AADSTS error.
  async function refreshGrant(withSecret) {
    const p = { client_id: clientId, grant_type: "refresh_token", refresh_token: refresh, scope: "offline_access Files.ReadWrite" };
    if (withSecret) p.client_secret = clientSecret;
    const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(p),
    });
    return r.json();
  }
  let j = await refreshGrant(false);
  if (!j.access_token && /7000218/.test(JSON.stringify(j))) j = await refreshGrant(true);
  if (!j.access_token) throw new Error("app-media/onedrive-upload: token refresh failed: " + JSON.stringify(j).slice(0, 200));

  if (j.refresh_token && j.refresh_token !== refresh) {
    try {
      await kvSecretSet(refreshKey, j.refresh_token);
    } catch (e) {
      console.error("app-media/onedrive-upload: rotated refresh token but persisting it FAILED: " + e.message);
    }
  }
  _tokenCache = { token: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 3300) * 1000 };
  return j.access_token;
}

async function gx(tok, method, path, opts = {}) {
  return fetch(path.startsWith("http") ? path : GRAPH + path, {
    method,
    headers: { Authorization: `Bearer ${tok}`, ...(opts.headers || {}) },
    body: opts.body,
  });
}

async function getItemId(tok, path, select = "id,folder") {
  const r = await gx(tok, "GET", `${itemRef(path)}?$select=${select}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`app-media/onedrive-upload stat "${path}" ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return await r.json();
}

// mkdir -p. Identical shape to onedrive.mjs's own ensureFolder(); duplicated locally rather than
// imported since that file exports nothing (see this file's header for why).
async function ensureFolder(tok, path) {
  const segs = String(path).split("/").filter(Boolean);
  let parent = "";
  let id = null;
  for (const seg of segs) {
    const cur = parent ? `${parent}/${seg}` : seg;
    let it = await getItemId(tok, cur, "id,folder");
    if (!it) {
      const createUrl = parent ? `${itemRef(parent)}:/children` : "/me/drive/root/children";
      const r = await gx(tok, "POST", createUrl, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: seg, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
      });
      if (!r.ok && r.status !== 409) throw new Error(`app-media/onedrive-upload mkdir "${cur}" ${r.status}: ${(await r.text()).slice(0, 160)}`);
      it = await getItemId(tok, cur, "id,folder");
    }
    parent = cur;
    id = it?.id ?? null;
  }
  return id;
}

/** Upload `buffer` (a Buffer) to OneDrive at `destPath` (root-relative, e.g.
 *  "5-Media/App Screenshots and Videos/AWARE/1.4.0 (1779565789)/web-screenshots/foo.png") via a
 *  resumable upload session, chunked at CHUNK_SIZE. Ensures every parent folder in the path exists
 *  first (Graph does NOT auto-create them for createUploadSession, same as it does not for
 *  onedrive.mjs's plain PUT :/content). Conflict behavior is "replace" -- re-archiving the exact
 *  same destination path overwrites in place, which is fine here because the CLI's sha256
 *  idempotency check (see lib.mjs's shouldSkipUpload) already decides whether a re-upload should
 *  happen at all before this function is ever called. Returns the final DriveItem JSON. */
export async function uploadFileToOneDrive(destPath, buffer, contentType) {
  if (!Buffer.isBuffer(buffer)) throw new Error("app-media/onedrive-upload: buffer must be a Buffer");
  if (buffer.length === 0) throw new Error(`app-media/onedrive-upload: refusing to upload an empty (0-byte) file: ${destPath}`);

  const tok = await accessToken();
  const slash = destPath.lastIndexOf("/");
  if (slash > 0) await ensureFolder(tok, destPath.slice(0, slash));

  const sessionRes = await gx(tok, "POST", `${itemRef(destPath)}:/createUploadSession`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } }),
  });
  if (!sessionRes.ok) {
    throw new Error(`app-media/onedrive-upload createUploadSession "${destPath}" ${sessionRes.status}: ${(await sessionRes.text()).slice(0, 200)}`);
  }
  const { uploadUrl } = await sessionRes.json();
  if (!uploadUrl) throw new Error(`app-media/onedrive-upload: createUploadSession returned no uploadUrl for "${destPath}"`);

  const total = buffer.length;
  let lastJson = null;
  for (let start = 0; start < total; start += CHUNK_SIZE) {
    const end = Math.min(start + CHUNK_SIZE, total);
    const chunk = buffer.subarray(start, end);
    // NOTE: no Authorization header here on purpose. Upload-session URLs are pre-authenticated by
    // Graph; sending a bearer header to them is unnecessary and, per Microsoft's own docs, can
    // cause the request to be rejected.
    const r = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Length": String(chunk.length), "Content-Range": `bytes ${start}-${end - 1}/${total}` },
      body: chunk,
    });
    if (!r.ok) {
      throw new Error(`app-media/onedrive-upload fragment ${start}-${end - 1}/${total} for "${destPath}" ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    lastJson = await r.json().catch(() => null);
  }
  if (!lastJson || !lastJson.id) {
    throw new Error(`app-media/onedrive-upload: upload session for "${destPath}" did not return a final DriveItem (upload may be incomplete)`);
  }
  return lastJson;
}

/** Download a OneDrive file's raw bytes as a Buffer, for anything that needs a read-back
 *  verification against what was just uploaded. Not used by every call site -- the CLI verifies
 *  round-trip integrity against S3 (the cheaper, already-signed path) rather than OneDrive, but
 *  this is here for completeness and for any future caller that needs it. */
export async function readOneDriveFileBuffer(path) {
  const tok = await accessToken();
  const r = await gx(tok, "GET", `${itemRef(path)}:/content`);
  if (!r.ok) throw new Error(`app-media/onedrive-upload download "${path}" ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return Buffer.from(await r.arrayBuffer());
}
