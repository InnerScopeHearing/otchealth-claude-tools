// Regression gate for the Sunset/Sunrise Transfer Protocol. The network paths (commons read/write) need
// the SA, but the load-bearing LOGIC is hermetic: last3 dedupes + caps at 3, the handoff renderer is
// RING-SAFE (no sensitive ledger text in a sensitive role's commons doc), and the read verbs FAIL-OPEN
// (exit 0) on a credential-less box so a SessionStart/cron can never break.
import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeLast3, renderHandoff, ROSTER, SENSITIVE } from "../skills/sunset-protocol/protocol.mjs";

const D = join(dirname(fileURLToPath(import.meta.url)), "..", "skills/sunset-protocol/protocol.mjs");
function run(args) {
  const HOME = mkdtempSync(join(tmpdir(), "sun-"));
  return spawnSync("node", [D, ...args], { env: { ...process.env, HOME, GCP_CLAUDE_DRIVER_SA_JSON: "" }, encoding: "utf8", timeout: 10000 });
}

// A distinctive sentinel stands in for sensitive ledger CONTENT, so the ring test checks the real
// property (ledger-derived text never lands in a sensitive role's commons doc) without colliding with
// generic protocol words that appear in the static boilerplate (e.g. "fleet-dispatch").
const SENTINEL = "ZZSENSITIVELEDGERTEXTZZ";
const FIX = [
  { id: "1", ts: "2026-06-25T01:00:00Z", type: "fact", text: "Background context fact." },
  { id: "2", ts: "2026-06-25T02:00:00Z", type: "decision", text: `Workstream alpha ${SENTINEL} one.` },
  { id: "3", ts: "2026-06-25T03:00:00Z", type: "decision", text: `Workstream alpha ${SENTINEL} one.` },
  { id: "4", ts: "2026-06-25T04:00:00Z", type: "decision", text: `Workstream bravo ${SENTINEL} two.` },
  { id: "5", ts: "2026-06-25T05:00:00Z", type: "status", text: `Workstream charlie ${SENTINEL} three.` },
];

test("computeLast3 returns at most 3 and dedupes repeated workstreams (newest first)", () => {
  const l3 = computeLast3(FIX);
  assert.ok(l3.length <= 3);
  assert.strictEqual(l3[0].title.startsWith("Workstream charlie"), true, "newest first");
  // entries 2 and 3 are the same workstream -> collapse to one
  const titles = l3.map((x) => x.title);
  assert.strictEqual(new Set(titles).size, titles.length, "no duplicate workstreams");
});

test("handoff for a NON-sensitive role embeds recent titles", () => {
  const doc = renderHandoff("cto", FIX, 0);
  assert.match(doc, /Last worked on/);
  assert.match(doc, new RegExp(SENTINEL), "non-sensitive doc includes ledger-derived titles");
  assert.match(doc, /Non-PHI ring/);
});

test("handoff for a SENSITIVE role embeds NO ledger text (ring-safe)", () => {
  const doc = renderHandoff("cfo", FIX, 0);
  assert.match(doc, /RING-PROTECTED/);
  assert.doesNotMatch(doc, new RegExp(SENTINEL), "no sensitive ledger text in a commons-stored doc");
  assert.match(doc, /MNPI|financial/);
});

test("clo handoff is flagged privileged + segregated", () => {
  assert.ok(SENSITIVE.has("clo"));
  assert.match(renderHandoff("clo", FIX, 0), /privileged/i);
});

test("roster covers the exec + cash + product agents", () => {
  for (const r of ["cto", "cfo", "clo", "coo", "developer", "commerce"]) assert.ok(ROSTER.includes(r), r);
});

test("sunrise + last3 FAIL OPEN (exit 0) on a credential-less box", () => {
  assert.strictEqual(run(["sunrise", "--agent", "cto"]).status, 0);
  assert.strictEqual(run(["last3", "--agent", "cto", "--json"]).status, 0);
});

test("sunset without an agent is a usage error (exit 2), and an unknown verb too", () => {
  assert.strictEqual(run(["sunset"]).status, 2);
  assert.strictEqual(run(["frobnicate"]).status, 2);
});
