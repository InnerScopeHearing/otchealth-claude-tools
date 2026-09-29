// cache.mjs -- content-addressed asset cache so a re-render NEVER re-pays for an unchanged asset.
// Key = sha256 of the canonical JSON of everything that affects the output (model, prompt, duration, the
// start-frame FILE hash, voice, text, ...). Files live at <root>/<kind>/<key>.<ext> plus a <key>.json sidecar.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function cacheRoot(env = process.env) {
  return env.AD_STUDIO_CACHE || join(homedir(), '.cache', 'ad-studio', 'assets');
}

/** Stable stringify (sorted keys) so key order never changes a hash. */
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
export const hashJson = (v) => createHash('sha256').update(canonical(v)).digest('hex');
export const hashFile = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

export function assetPath(root, kind, key, ext) { return join(root, kind, `${key}.${ext}`); }
export function peek(root, kind, key, ext) { const p = assetPath(root, kind, key, ext); return existsSync(p) ? p : null; }

export function readMeta(root, kind, key) {
  const p = join(root, kind, `${key}.json`);
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

/** Return the cached file, or run `produce()` (must return a Buffer) and store it atomically. */
export async function getOrCreate(root, kind, key, ext, produce, meta = {}) {
  const hit = peek(root, kind, key, ext);
  if (hit) return { path: hit, hit: true, meta: readMeta(root, kind, key) };
  const buf = await produce();
  const p = assetPath(root, kind, key, ext);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + `.tmp-${process.pid}`;
  writeFileSync(tmp, buf);
  renameSync(tmp, p);
  const m = { ...meta, key, createdAt: new Date().toISOString(), bytes: buf.length };
  writeFileSync(join(root, kind, `${key}.json`), JSON.stringify(m, null, 2));
  return { path: p, hit: false, meta: m };
}

function writeAtomic(p, data) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + `.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data);
  renameSync(tmp, p); // rename is atomic: a reader sees the old file or the whole new one, never a torn write
  return p;
}

/** Store the TTS alignment sidecar (written BEFORE the mp3, so an mp3 in the cache always has its alignment). */
export function putJson(root, kind, key, obj) {
  return writeAtomic(join(root, kind, `${key}.align.json`), JSON.stringify(obj));
}
export function getJson(root, kind, key) {
  try { return JSON.parse(readFileSync(join(root, kind, `${key}.align.json`), 'utf8')); } catch { return null; }
}

/** Pending-generation sidecar: the server-side generation id, persisted BEFORE waiting so a timeout, crash or failed
 *  download resumes the paid generation instead of submitting (and paying for) a new one. */
export function putPending(root, kind, key, obj) {
  return writeAtomic(join(root, kind, `${key}.pending.json`), JSON.stringify({ ...obj, savedAt: new Date().toISOString() }));
}
export function getPending(root, kind, key) {
  try { return JSON.parse(readFileSync(join(root, kind, `${key}.pending.json`), 'utf8')); } catch { return null; }
}
export function clearPending(root, kind, key) {
  rmSync(join(root, kind, `${key}.pending.json`), { force: true });
}
