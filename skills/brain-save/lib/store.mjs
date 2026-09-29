// store.mjs -- S3 commons writes, the per-document version registry, by-hash aliases, archive moves.
// Every function takes the backend (real or fake) as its first argument.
import { registryKey, byHashKey, archiveKeyFor, sidecarKeyFor, META_PREFIX } from "./provenance.mjs";

const JSON_CT = "application/json";

/** Read a JSON object; returns {doc, etag} ({doc:null, etag:null} when absent). */
export async function readJson(backend, key) {
  const { text, etag } = await backend.get(key);
  if (text == null) return { doc: null, etag: null };
  try { return { doc: JSON.parse(text), etag }; }
  catch { throw new Error(`corrupt JSON at ${key}`); }
}

export const readRegistry = (backend, brainId) => readJson(backend, registryKey(brainId));
export const readByHash = (backend, sha) => readJson(backend, byHashKey(sha));

/** ETag-guarded read-modify-write of a registry object. `mutate(doc|null) -> doc`. One re-read-and-retry
 *  on a 412/409 conflict; a second conflict throws (the caller maps it to an error, never silence). */
export async function updateRegistry(backend, brainId, mutate) {
  const key = registryKey(brainId);
  for (let attempt = 0; attempt < 2; attempt++) {
    const { doc, etag } = await readJson(backend, key);
    const next = mutate(doc ? structuredClone(doc) : null);
    next.updated_at = new Date().toISOString();
    try {
      await backend.putCond(key, JSON.stringify(next, null, 2) + "\n", JSON_CT, etag);
      return next;
    } catch (e) {
      if ((e.status === 412 || e.status === 409) && attempt === 0) continue;
      throw e;
    }
  }
  throw new Error(`registry ${brainId}: write conflict persisted after one retry`);
}

/** Create-only object write. A 412 means an object already exists at this content-addressed key,
 *  which is identical by construction (the key embeds the body hash), so it is treated as success. */
export async function createObject(backend, key, body, contentType = "text/markdown; charset=utf-8") {
  try { await backend.putCond(key, body, contentType, null); return { created: true }; }
  catch (e) { if (e.status === 412 || e.status === 409) return { created: false }; throw e; }
}

export async function writeByHash(backend, sha, record) {
  await backend.put(byHashKey(sha), JSON.stringify(record, null, 2) + "\n", JSON_CT);
}

/** Move a stored doc out of the searchable prefix: copy to _ARCHIVE/<key> (never indexed), delete the
 *  original, and delete the nightly _TEXT/ sidecar if one was created (so a later --reindex cannot
 *  resurrect it). Returns the archive key. */
export async function archiveObject(backend, key) {
  const { text } = await backend.get(key);
  const archived = archiveKeyFor(key);
  if (text != null) {
    await backend.put(archived, text, "text/markdown; charset=utf-8");
    await backend.del(key);
  }
  try { await backend.del(sidecarKeyFor(key)); } catch { /* no sidecar yet is normal */ }
  return archived;
}

export async function writeOverrideAudit(backend, { brainId, sha8, record }) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `${META_PREFIX}audit/overrides/${day}/${brainId}-${sha8}.json`;
  await backend.put(key, JSON.stringify(record, null, 2) + "\n", JSON_CT);
  return key;
}

/** The live version entry of a registry doc, or null. */
export function liveVersion(reg) {
  if (!reg || !Array.isArray(reg.versions)) return null;
  return [...reg.versions].reverse().find((v) => v.status === "live") || null;
}
export function latestVersion(reg) {
  if (!reg || !Array.isArray(reg.versions) || !reg.versions.length) return null;
  return reg.versions[reg.versions.length - 1];
}
