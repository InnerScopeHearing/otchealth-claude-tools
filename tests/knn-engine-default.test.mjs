// Regression pin: OpenSearch 3.x rejects the nmslib k-NN engine at index creation
// ("nmslib engine is deprecated ... cannot be used for new index creation in OpenSearch
// from 3.0.0", proven live on otchealth-brain after the 2026-09-02 upgrade to 3.7).
// Every live room already uses faiss; the two places that CREATE new indices must
// default to faiss or the next new room / memory lane silently fails to provision.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = ["skills/doc-indexer/indexer.mjs", "skills/kb-memory/opensearch-write.mjs"];

for (const rel of files) {
  test(`${rel}: knn_vector mappings use engine faiss, never nmslib`, () => {
    const src = readFileSync(path.join(root, rel), "utf8");
    const mappings = src.match(/type:\s*"knn_vector"[^}]*method:\s*\{[^}]*\}/g) || [];
    assert.ok(mappings.length >= 1, `expected at least one knn_vector mapping in ${rel}`);
    for (const m of mappings) {
      assert.match(m, /engine:\s*"faiss"/, `knn_vector mapping must use faiss: ${m}`);
      assert.doesNotMatch(m, /nmslib/, `nmslib is not creatable on OpenSearch 3.x: ${m}`);
    }
    assert.doesNotMatch(src, /engine:\s*"nmslib"/, `${rel} still defaults an index to nmslib`);
  });
}
