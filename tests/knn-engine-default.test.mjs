// Regression pin: OpenSearch 3.x rejects the nmslib k-NN engine at index creation
// ("nmslib engine is deprecated ... cannot be used for new index creation in OpenSearch
// from 3.0.0", proven live on otchealth-brain after the 2026-09-02 upgrade to 3.7).
// Every live room already uses faiss; the two places that CREATE new indices must
// default to faiss or the next new room / memory lane silently fails to provision.
//
// The scan is deliberately tolerant of how the mapping is WRITTEN (quoted or bare keys, any
// whitespace around the colon, single or double quotes around the value, `type` before or
// after `method`): it collects every `engine: <value>` assignment that sits inside a k-NN
// `method: { ... }` block and requires that set to be exactly {faiss}. Scoped to method
// blocks on purpose: indexer.mjs also uses `engine:` for its OCR/text-extraction engines
// (text, pdftotext, tesseract, ...), which are unrelated to OpenSearch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = ["skills/doc-indexer/indexer.mjs", "skills/kb-memory/opensearch-write.mjs"];
const METHOD_BLOCK = /["']?method["']?\s*:\s*\{([^}]*)\}/g;
const ENGINE_ASSIGNMENT = /["']?engine["']?\s*:\s*["']([A-Za-z0-9_-]+)["']/g;

/** Every `engine` value assigned inside a k-NN `method: { ... }` block, in file order. */
export function knnEngineValues(src) {
  const out = [];
  for (const block of src.matchAll(METHOD_BLOCK)) {
    for (const m of block[1].matchAll(ENGINE_ASSIGNMENT)) out.push(m[1]);
  }
  return out;
}

for (const rel of files) {
  test(`${rel}: every k-NN engine assignment is faiss, never nmslib`, () => {
    const src = readFileSync(path.join(root, rel), "utf8");
    assert.match(src, /["']?type["']?\s*:\s*["']knn_vector["']/, `expected a knn_vector mapping in ${rel}`);
    const engines = knnEngineValues(src);
    assert.ok(engines.length >= 1, `expected at least one k-NN method block with an engine in ${rel}`);
    assert.deepEqual([...new Set(engines)], ["faiss"], `${rel} k-NN engine assignments must all be faiss, got: ${engines.join(", ")}`);
    assert.doesNotMatch(src, /nmslib/i, `${rel} still mentions nmslib`);
  });
}

test("knnEngineValues() sees every quoting/spacing/order variant inside a method block, and nothing outside one", () => {
  const variants = [
    'engine: "nmslib"', "engine: 'nmslib'", '"engine": "nmslib"', "'engine': 'nmslib'", 'engine : "nmslib"', 'engine:"nmslib"',
  ];
  for (const v of variants) {
    assert.deepEqual(knnEngineValues(`method: { name: "hnsw", ${v} }`), ["nmslib"], `variant not detected: ${v}`);
    assert.deepEqual(knnEngineValues(`"method" : {${v}, name: "hnsw"}`), ["nmslib"], `quoted-key/leading variant not detected: ${v}`);
  }
  assert.deepEqual(knnEngineValues('method: { engine: "faiss", name: "hnsw" }, type: "knn_vector"'), ["faiss"]);
  // OCR engines and other non-k-NN `engine:` keys outside a method block are ignored on purpose.
  assert.deepEqual(knnEngineValues('const ocr = { engine: "tesseract" }; method: { engine: "faiss" }'), ["faiss"]);
});
