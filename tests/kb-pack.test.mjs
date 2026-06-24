// Regression tests for `mem.mjs pack` - the per-prompt WORKING-MEMORY block injected by the
// kb-recall UserPromptSubmit hook. Guards the anti-forgetting read-back loop and, critically, the
// READ-SIDE RING FILTER (no cross-agent MNPI/PHI in an injected block). All hermetic: a fresh local
// cache means pack reads local files and never touches the network, so no creds/Azure are needed.
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

function home(ownRows, teamRows) {
  const h = mkdtempSync(join(tmpdir(), "pack-"));
  mkdirSync(join(h, ".claude", "kb-cache"), { recursive: true });
  writeFileSync(join(h, ".claude", "kb-cache", "cto.jsonl"), nd(ownRows));
  if (teamRows) writeFileSync(join(h, ".claude", "kb-cache", "_team.jsonl"), nd(teamRows));
  return h;
}
// default env: NO service account => pack reads the fresh local cache and never refreshes from Azure.
const pack = (h, args = [], env = {}) =>
  execFileSync("node", [MEM, "pack", "--agent", "cto", ...args],
    { env: { ...process.env, HOME: h, GCP_CLAUDE_DRIVER_SA_JSON: "", ...env }, encoding: "utf8" });

test("pack emits sentinels + a LIVE beacon and surfaces the prompt-relevant fact", () => {
  const out = pack(home([
    { id: "20260101-001", ts: "2026-01-01T00:00:00Z", type: "fact", text: "the widget pipeline uses depot macos runners" },
    { id: "20260101-002", ts: "2026-01-02T00:00:00Z", type: "fact", text: "an unrelated note about lunch" },
    { id: "20260101-003", ts: "2026-01-03T00:00:00Z", type: "pitfall", text: "do not hand-edit project.pbxproj" },
  ]), ["--query", "depot runner pipeline"]);
  assert.match(out, /<<<WORKING-MEMORY>>>/);
  assert.match(out, /<<<END>>>/);
  assert.match(out, /MEMORY: LIVE agent=cto \| ledger=3/);
  assert.match(out, /RELEVANT TO THIS PROMPT/);
  assert.match(out, /depot macos runners/, "the matching fact is injected");
});

test("pack drops a superseded row (newest-wins)", () => {
  const out = pack(home([
    { id: "20260101-001", ts: "2026-01-01T00:00:00Z", type: "fact", text: "OLD build number is 42" },
    { id: "20260101-002", ts: "2026-01-02T00:00:00Z", type: "fact", text: "NEW build number is 43", supersedes: "20260101-001" },
  ]), ["--query", "build number"]);
  assert.match(out, /NEW build number is 43/);
  assert.doesNotMatch(out, /OLD build number is 42/, "the superseded value is not injected");
});

test("pack RING-FILTERS cross-agent MNPI from the team feed but keeps a clean status", () => {
  // fresh team cache + a (fake, never-used) SA => pack reads the LOCAL team cache, no network.
  const out = pack(
    home(
      [{ id: "20260101-001", ts: "2026-01-01T00:00:00Z", type: "fact", text: "own lane fact" }],
      [
        { agent: "coo", id: "t1", ts: "2026-02-01T00:00:00Z", type: "status", text: "shipping the morning briefing" },
        { agent: "cfo", id: "t2", ts: "2026-02-02T00:00:00Z", type: "status", text: "reconciling the INND Reg D raise share price" },
      ]
    ),
    [],
    { GCP_CLAUDE_DRIVER_SA_JSON: '{"client_email":"x@y","private_key":"unused"}' }
  );
  assert.match(out, /shipping the morning briefing/, "keeps the clean cross-agent status");
  assert.doesNotMatch(out, /Reg D raise/, "drops the MNPI cross-agent status (read-side ring wall)");
});

test("pack stays within the char budget and always closes the block", () => {
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push({ id: `2026-${i}`, ts: `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00Z`, type: "pitfall", text: "x".repeat(300) + " pitfall " + i });
  const out = pack(home(rows), ["--query", "pitfall"]);
  assert.ok(out.length <= 5000, `pack is ${out.length} chars, should be ~within the ~4800 budget`);
  assert.match(out, /<<<END>>>\s*$/, "the block is always closed even when truncated");
});

test("pack with no agent marker yields a one-line OFF beacon, never throws", () => {
  const out = execFileSync("node", [MEM, "pack"], { env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), "pack-")), GCP_CLAUDE_DRIVER_SA_JSON: "" }, encoding: "utf8" });
  assert.match(out, /MEMORY: OFF \(no agent\)/);
});
