// indexer-harness.mjs -- run the REAL skills/doc-indexer/indexer.mjs CLI in a subprocess against the in-memory
// fake cloud (tests/helpers/fake-cloud-preload.mjs). Nothing here can reach a real service: the environment is
// minimal and synthetic (fake AWS keys, a fake OpenSearch host, a fake OpenAI key, an empty HOME), and the
// preload replaces fetch, so an unexpected host is a logged error, never a request.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { buildHeader, buildObject, keyRefFor } from "../../skills/brain-save/lib/provenance.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const INDEXER = join(HERE, "..", "..", "skills", "doc-indexer", "indexer.mjs");
const PRELOAD = pathToFileURL(join(HERE, "fake-cloud-preload.mjs")).href;

/** 130 synthetic SecureString parameters (>= the loader's floors) + one named parameter holding `secret`. */
export function syntheticSsm(secret) {
  const out = Array.from({ length: 130 }, (_, i) => ({ name: `synthetic-param-${i}`, value: randomBytes(24).toString("base64url") }));
  if (secret) out.push({ name: "widget-live-token", value: secret });
  return out;
}

/** A brain-save-shaped stored object (header + body) for a `_KNOWLEDGE/` key. */
export function knowledgeObject(key, body, over = {}) {
  const h = buildHeader({ brain_id: "KN-RES-1234567890", version: "1", title: "Widget planning notes", kind: "research", app: "fleet", source: "", artifact_url: "", author_agent: "cto", session: "", doc_date: "2026-09-29", saved_at: "2026-09-29T00:00:00Z", content_sha256: "a".repeat(64), key_ref: keyRefFor(key), supersedes: "", ring: "commons", ring_warnings: "", ring_override: "", tags: "", saved_by: "brain-save 1", ...over });
  return buildObject(h, body);
}

/** rows: [{path, sidecar: text}] -> scenario s3 map with the catalog, the sidecars and the source objects. */
export function catalogScenario(rows, extra = {}) {
  const s3 = {};
  s3["_CATALOG/catalog.jsonl"] = rows.map((r) => JSON.stringify({ path: r.path, entity: r.path.split("/")[0], title: r.path.split("/").pop(), sha256: "f".repeat(64), sidecar: true })).join("\n") + "\n";
  for (const r of rows) { s3[`_TEXT/${r.path}.txt`] = r.sidecar; if (r.object !== false) s3[r.path] = r.sidecar; }
  return { s3, osShape: "chunked", osExisting: [], ssm: syntheticSsm(extra.secret), ...extra };
}

/** Run `indexer.mjs <args>` under the fake cloud. Returns { code, stdout, stderr, log: [ ... ] }. */
export function runIndexer(args, scenario = { s3: {}, ssm: [], osShape: "chunked" }, envExtra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "idx-harness-"));
  const scenarioPath = join(dir, "scenario.json");
  const logPath = join(dir, "calls.jsonl");
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  writeFileSync(logPath, "");
  const home = mkdtempSync(join(tmpdir(), "idx-home-"));
  const env = {
    PATH: process.env.PATH, HOME: home, OPENAI_USAGE_DISABLE: "1",
    AWS_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKE1234", AWS_SECRET_ACCESS_KEY: "fakeSecretAccessKeyForTestsOnly0123456789abcd",
    OPENSEARCH_ENDPOINT: "fake-os.local", OPENAI_API_KEY: "sk-fake-test-only",
    FAKE_CLOUD_SCENARIO: scenarioPath, FAKE_CLOUD_LOG: logPath, ...envExtra,
  };
  const r = spawnSync(process.execPath, ["--import", PRELOAD, INDEXER, ...args], { env, encoding: "utf8", timeout: 60000 });
  const log = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "", log };
}
