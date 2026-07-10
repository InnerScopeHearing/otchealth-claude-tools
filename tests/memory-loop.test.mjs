// The anti-forgetting regression gate (panel P1). Proves the read-back loop end to end: a fact
// "captured before a compaction" (seeded in the local cache) must reappear in the per-prompt pack on
// the NEXT prompt - INCLUDING when that prompt is about something else entirely (the literal "forgets
// what happened 20 minutes ago" case). If this ever goes red, the loop has regressed. Hermetic: a
// fresh local cache means pack reads local files and never touches the network.
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MEM = join(ROOT, "skills/kb-memory/mem.mjs");

function seedCacheAndPack(rows, query) {
  const home = mkdtempSync(join(tmpdir(), "loop-"));
  mkdirSync(join(home, ".claude", "kb-cache"), { recursive: true });
  writeFileSync(join(home, ".claude", "kb-cache", "cto.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return execFileSync("node", [MEM, "pack", "--agent", "cto", "--query", query],
    { env: { ...process.env, HOME: home, GCP_CLAUDE_DRIVER_SA_JSON: "" }, encoding: "utf8" });
}

test("a fact captured before a compaction reappears on the next prompt (matching query)", () => {
  const out = seedCacheAndPack([
    { id: "20260101-001", ts: "2026-01-01T00:00:00Z", type: "fact", text: "the prod deploy key lives in vault entry deploy-key-prod" },
  ], "where is the prod deploy key");
  assert.match(out, /MEMORY: LIVE/);
  assert.match(out, /deploy-key-prod/, "the just-captured fact is re-injected");
});

test("the fact reappears EVEN when the next prompt is about something else (the 20-min-ago guard)", () => {
  // This is the load-bearing case: after a compaction, the very next prompt is often a different topic,
  // and the agent must still carry forward what it just learned. Recent facts ride in via RECENT.
  const out = seedCacheAndPack([
    { id: "20260101-001", ts: "2026-01-01T00:00:01Z", type: "fact", text: "we decided to ship build 79 not build 2" },
    { id: "20260101-002", ts: "2026-01-01T00:00:02Z", type: "fact", text: "the API base url is https://example.test/api" },
  ], "can you help me write a haiku about the ocean");
  assert.match(out, /<<<WORKING-MEMORY>>>/);
  assert.match(out, /build 79 not build 2/, "a recent fact survives an off-topic next prompt");
});

test("pitfalls are always carried across a compaction", () => {
  const out = seedCacheAndPack([
    { id: "20260101-001", ts: "2026-01-01T00:00:00Z", type: "pitfall", text: "never trust the developer build-number estimate; confirm ASC max+1" },
    { id: "20260101-002", ts: "2026-01-02T00:00:00Z", type: "fact", text: "unrelated filler" },
  ], "completely unrelated topic");
  assert.match(out, /confirm ASC max\+1/, "a pitfall is always in the pack regardless of the prompt");
});
