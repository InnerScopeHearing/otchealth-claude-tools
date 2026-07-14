// schema-merge.mjs -- additive, skew-proof merge for an Azure AI Search index schema.
//
// WHY: `PUT /indexes/{name}` that OMITS a field the LIVE index already has is rejected by Azure AI
// Search with 400 "Existing field(s) 'X' cannot be deleted." So any writer whose CODE schema lags the
// live index (an older image, a job that missed a field addition) hard-fails at push-search under
// `set -e`. This is exactly what took down daily-digest the night `indexed_at` was backfilled onto the
// commons index while daily-digest still ran a pre-`indexed_at` image (2026-07-13): the digest + upload
// + index all succeeded, then push-search's create-index PUT (which omitted indexed_at) 400'd and the
// whole nightly job died.
//
// FIX: before the PUT, GET the live index and merge so the PUT is always a NON-DESTRUCTIVE SUPERSET:
//   - every field the live index already has is preserved (the LIVE definition wins for shared names,
//     so we never trigger a "cannot change field 'X'" 400 either), and
//   - fields this code introduces but the live index lacks are ADDED.
// A field is thus never deleted or altered by a version-skewed writer; only added. Field REMOVAL /
// attribute migration remains a deliberate, separate operation, never an accidental side effect of a
// stale image. Pure (no I/O) so it is unit-testable.

/**
 * @param {{name:string, fields:Array<{name:string}>}} desired  the code's intended schema
 * @param {{fields?:Array<{name:string}>}|null} liveIndex        the live index def from GET (or null/absent)
 * @returns {object} a schema whose `fields` never drop or alter a live field; only add new code fields.
 */
export function mergeSchemaAdditive(desired, liveIndex) {
  if (!liveIndex || !Array.isArray(liveIndex.fields) || liveIndex.fields.length === 0) return desired;
  const desiredNames = new Set((desired.fields || []).map((f) => f.name));
  const liveByName = new Map(liveIndex.fields.map((f) => [f.name, f]));
  // shared fields: keep the LIVE definition (avoids "cannot change field" 400s); code-only fields stay.
  const merged = (desired.fields || []).map((f) => liveByName.get(f.name) || f);
  // live-only fields: preserve them so the PUT never reads as a field deletion.
  for (const lf of liveIndex.fields) if (!desiredNames.has(lf.name)) merged.push(lf);
  return { ...desired, fields: merged };
}
