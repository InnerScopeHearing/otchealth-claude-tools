// Regression gate for the Wave 3 typed ENTITY / current-value layer. Entities are the deterministic
// "what is X NOW?" projection over the flat ledger: latest row per key wins, superseded values drop.
// These tests drive the LOCAL-cache pack path (the per-prompt injection), so they are fully hermetic -
// a fresh temp HOME with no service account means pack reads local files and never touches Azure. They
// prove the two load-bearing guarantees: (1) a current value is surfaced in the CURRENT VALUES block,
// and (2) a SUPERSEDED older value is NOT (newest-wins), so the agent never sees a stale build number.
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MEM = join(ROOT, "skills/kb-memory/mem.mjs");
const nd = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

function packWith(rows, query = "unrelated topic") {
  const h = mkdtempSync(join(tmpdir(), "ent-"));
  mkdirSync(join(h, ".claude", "kb-cache"), { recursive: true });
  writeFileSync(join(h, ".claude", "kb-cache", "cto.jsonl"), nd(rows));
  return execFileSync("node", [MEM, "pack", "--agent", "cto", "--query", query],
    { env: { ...process.env, HOME: h, GCP_CLAUDE_DRIVER_SA_JSON: "" }, encoding: "utf8" });
}

test("a current-value entity is surfaced in the pack's CURRENT VALUES block", () => {
  const out = packWith([
    { id: "20260101-001", ts: "2026-01-01T00:00:00Z", type: "entity", ekey: "iheartest_cfbundleversion", evalue: "46", text: "iheartest_cfbundleversion = 46" },
  ]);
  assert.match(out, /CURRENT VALUES/);
  assert.match(out, /iheartest_cfbundleversion = 46/);
});

test("the SUPERSEDED older value never appears; only the newest wins", () => {
  // 002 supersedes 001 (exactly what `entity set` writes when a key already has a value). The pack's
  // active-set filter must drop 001, so the agent sees 47 and NEVER the stale 46.
  const out = packWith([
    { id: "20260101-001", ts: "2026-01-01T00:00:00Z", type: "entity", ekey: "iheartest_cfbundleversion", evalue: "46", text: "iheartest_cfbundleversion = 46" },
    { id: "20260101-002", ts: "2026-01-02T00:00:00Z", type: "entity", ekey: "iheartest_cfbundleversion", evalue: "47", text: "iheartest_cfbundleversion = 47", supersedes: "20260101-001", was: "46" },
  ]);
  assert.match(out, /iheartest_cfbundleversion = 47/, "the current value is shown");
  assert.doesNotMatch(out, /= 46\b/, "the superseded value is gone (no stale build number)");
});

test("entities ride in regardless of the prompt topic (current-values are always-on, like pitfalls)", () => {
  const out = packWith([
    { id: "20260101-001", ts: "2026-01-01T00:00:00Z", type: "entity", ekey: "n8n_base_url", evalue: "https://automation.otchealth.app", text: "n8n_base_url = https://automation.otchealth.app" },
  ], "write me a poem about the sea");
  assert.match(out, /n8n_base_url = https:\/\/automation\.otchealth\.app/, "a current value survives an off-topic prompt");
});
