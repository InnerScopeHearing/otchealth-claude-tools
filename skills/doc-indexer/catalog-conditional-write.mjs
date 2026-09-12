// Whole-catalog writers must not create a new S3 version when their canonical JSONL
// bytes did not change. When they do change, use the ETag returned with the source
// read so a concurrent publisher cannot be overwritten by a stale in-memory catalog.
export async function writeCatalogIfChanged({ snapshot, next, write }) {
  if (!snapshot || !(snapshot.body === null || Buffer.isBuffer(snapshot.body)) || typeof write !== "function") {
    throw new Error("catalog_write_input_invalid");
  }
  if (!Buffer.isBuffer(next)) throw new Error("catalog_write_input_invalid");
  if (Buffer.isBuffer(snapshot.body) && snapshot.body.equals(next)) {
    return { written: false, snapshot };
  }
  const headers = snapshot.body === null
    ? { "If-None-Match": "*" }
    : typeof snapshot.etag === "string" && snapshot.etag.length > 0
      ? { "If-Match": snapshot.etag }
      : null;
  if (!headers) throw new Error("catalog_write_etag_missing");
  const saved = await write(next, headers);
  if (!saved || !(saved.etag === null || typeof saved.etag === "string")) throw new Error("catalog_write_result_invalid");
  return { written: true, snapshot: { body: next, etag: saved.etag, versionId: saved.versionId ?? null } };
}
