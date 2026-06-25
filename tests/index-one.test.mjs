// Regression gate for index-one.mjs - the write-through SEMANTIC indexer that mem.mjs append() spawns
// DETACHED + unref'd after a shared publish, so a just-shared fact is embedded into the memory-exec
// AI Search index immediately (recallable by meaning within the minute, not after the 6h reindex).
//
// Because it runs detached with stdio:'ignore', its failures are INVISIBLE at runtime - so the only
// safety net is that it is provably FAIL-OPEN: it must ALWAYS exit 0 and never hang, on every bad or
// credential-less input, short-circuiting BEFORE any network call. And its doc-key scheme must stay
// byte-identical to semantic.mjs's (the nightly reindexer), or the two would write DUPLICATE docs for
// the same entry instead of converging via mergeOrUpload. All hermetic: the guard/no-SA paths return
// before touching Azure, so no creds are needed.
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IDX1 = join(ROOT, "skills/kb-memory/index-one.mjs");
const SEMANTIC = join(ROOT, "skills/kb-memory/semantic.mjs");

// run index-one with a clean temp HOME (no ~/.gcp_claude_driver_sa.json) and an empty env SA, so the
// no-SA branch is exercised hermetically and nothing ever reaches the network.
function runHermetic(args) {
  const HOME = mkdtempSync(join(tmpdir(), "idx1-"));
  return spawnSync("node", [IDX1, ...args],
    { env: { ...process.env, HOME, GCP_CLAUDE_DRIVER_SA_JSON: "" }, encoding: "utf8", timeout: 10000 });
}

test("exits 0 with no args (missing agent/entry guard)", () => {
  const r = runHermetic([]);
  assert.strictEqual(r.status, 0, "must fail-open on no args");
  assert.strictEqual(r.signal, null, "must not be killed/hang");
});

test("exits 0 when the entry is unparseable JSON", () => {
  const r = runHermetic(["cto", "{not json"]);
  assert.strictEqual(r.status, 0);
});

test("exits 0 when the entry lacks id or text (incomplete entry guard)", () => {
  assert.strictEqual(runHermetic(["cto", JSON.stringify({ id: "x" })]).status, 0, "no text -> skip");
  assert.strictEqual(runHermetic(["cto", JSON.stringify({ text: "y" })]).status, 0, "no id -> skip");
});

test("exits 0 with a VALID entry but no service account (fail-open, no network)", () => {
  // valid agent + id + text, but the temp HOME has no SA file and the env SA is blank -> resolveSa()
  // returns null and it must exit 0 immediately, never attempting an embed/upsert. This is the path
  // that protects every real detached spawn on a credential-less shell.
  const r = runHermetic(["cto", JSON.stringify({ id: "20260101-001", text: "hello", type: "fact", tags: ["t"], ts: "2026-01-01T00:00:00Z" })]);
  assert.strictEqual(r.status, 0, "must fail-open when the SA is absent");
  assert.strictEqual(r.signal, null, "must not hang/timeout");
});

test("doc-key scheme is byte-identical to semantic.mjs (converge on mergeOrUpload, never duplicate)", () => {
  // Both files independently sanitize to the Azure AI Search key charset [A-Za-z0-9_\-=]; if one is
  // edited and the other is not, write-through and the reindexer would diverge into duplicate docs.
  const idx1 = readFileSync(IDX1, "utf8");
  const sem = readFileSync(SEMANTIC, "utf8");
  // the shared shape: `${<var>}__${id}`.replace(/[^A-Za-z0-9_\-=]/g, "_")
  const SANITIZE = /\$\{[a-z]+\}__\$\{id\}`\.replace\(\/\[\^A-Za-z0-9_\\-=\]\/g, "_"\)/;
  assert.match(idx1, SANITIZE, "index-one.mjs must use the agent__id + charset-sanitize doc key");
  assert.match(sem, SANITIZE, "semantic.mjs must use the same agent__id + charset-sanitize doc key");
});
