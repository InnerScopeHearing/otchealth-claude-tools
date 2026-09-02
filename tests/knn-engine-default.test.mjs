// Regression pin: OpenSearch 3.x rejects the nmslib k-NN engine at index creation
// ("nmslib engine is deprecated ... cannot be used for new index creation in OpenSearch
// from 3.0.0", proven live on otchealth-brain after the 2026-09-02 upgrade to 3.7).
// Every live room already uses faiss; the two places that CREATE new indices must
// default to faiss or the next new room / memory lane silently fails to provision.
//
// The scan is deliberately tolerant of how the mapping is WRITTEN (quoted or bare `engine`
// key, any whitespace around the colon, single or double quotes around the value, `type`
// before or after `method`): it collects every `engine: <value>` assignment in the file and
// requires the set of values to be exactly {faiss}. A single nmslib (or any other engine)
// anywhere in either file fails the pin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = ["skills/doc-indexer/indexer.mjs", "skills/kb-memory/opensearch-write.mjs"];
const ENGINE_ASSIGNMENT = /["']?engine["']?\s*:\s*["']([A-Za-z0-9_-]+)["']/g;

export function engineValues(src) {
  return [...src.matchAll(ENGINE_ASSIGNMENT)].map((m) => m[1]);
}

for (const rel of files) {
  test(`${rel}: every k-NN engine assignment is faiss, never nmslib`, () => {
    const src = readFileSync(path.join(root, rel), "utf8");
    assert.match(src, /["']?type["']?\s*:\s*["']knn_vector["']/, `expected a knn_vector mapping in ${rel}`);
    const engines = engineValues(src);
    assert.ok(engines.length >= 1, `expected at least one engine assignment in ${rel}`);
    assert.deepEqual([...new Set(engines)], ["faiss"], `${rel} engine assignments must all be faiss, got: ${engines.join(", ")}`);
    assert.doesNotMatch(src, /nmslib/i, `${rel} still mentions nmslib`);
  });
}

test("engineValues() sees every quoting/spacing variant (so the pin cannot be evaded by style)", () => {
  const variants = [
    'engine: "nmslib"', "engine: 'nmslib'", '"engine": "nmslib"', "'engine': 'nmslib'", 'engine : "nmslib"', 'engine:"nmslib"',
  ];
  for (const v of variants) assert.deepEqual(engineValues(`{ ${v} }`), ["nmslib"], `variant not detected: ${v}`);
  assert.deepEqual(engineValues('method: { engine: "faiss", name: "hnsw" }, type: "knn_vector"'), ["faiss"]);
});
