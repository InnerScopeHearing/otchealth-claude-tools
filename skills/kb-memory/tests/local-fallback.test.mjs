// Direct unit tests for local-fallback.mjs (extracted 2026-08-18 from reflect.mjs so mem.mjs's own
// direct CLI writes can share the identical durable-fallback safety net; see that file's header).
// reflect-loud-failure.test.mjs already covers the ORIGINAL behavior end to end via reflect.mjs's
// re-export; these cover the module directly plus the two fields added for mem.mjs's use (`was`,
// `on`) that reflect.mjs itself never sets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAILED_WRITE_FILE, appendFailedWriteFallback } from "../local-fallback.mjs";

async function withTempHome(run) {
  const dir = await mkdtemp(join(tmpdir(), "local-fallback-test-"));
  const savedHome = process.env.HOME;
  process.env.HOME = dir;
  try { return await run(dir); } finally { process.env.HOME = savedHome; await rm(dir, { recursive: true, force: true }); }
}

test("appendFailedWriteFallback: default source stays 'reflect.mjs' when the caller passes no 4th argument (backward compat)", async () => {
  await withTempHome(async () => {
    appendFailedWriteFallback("agent-default-source", { type: "pitfall", text: "x" }, "err");
    const [row] = (await readFile(FAILED_WRITE_FILE("agent-default-source"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(row.source, "reflect.mjs");
  });
});

test("appendFailedWriteFallback: an explicit source (e.g. 'mem.mjs') overrides the default", async () => {
  await withTempHome(async () => {
    appendFailedWriteFallback("agent-explicit-source", { type: "status", text: "x", share: true }, "err", "mem.mjs");
    const [row] = (await readFile(FAILED_WRITE_FILE("agent-explicit-source"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(row.source, "mem.mjs");
    assert.equal(row.share, true);
  });
});

test("appendFailedWriteFallback: `was` and `on` are ADDITIVE -- present only when the caller supplies them", async () => {
  await withTempHome(async () => {
    appendFailedWriteFallback("agent-plain", { type: "remember", text: "no extras" }, "err", "mem.mjs");
    appendFailedWriteFallback("agent-plain", { type: "correct", text: "the right fact", was: "the wrong prior belief" }, "err", "mem.mjs");
    appendFailedWriteFallback("agent-plain", { type: "remember", text: "cross-lane note", on: "clo" }, "err", "mem.mjs");
    const rows = (await readFile(FAILED_WRITE_FILE("agent-plain"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows.length, 3);
    assert.equal("was" in rows[0], false, "a plain remember must not gain a spurious was field");
    assert.equal("on" in rows[0], false);
    assert.equal(rows[1].was, "the wrong prior belief");
    assert.equal("on" in rows[1], false);
    assert.equal(rows[2].on, "clo");
    assert.equal("was" in rows[2], false);
  });
});

test("appendFailedWriteFallback: a falsy `was`/`on` (empty string, absent) is never written as an empty field", async () => {
  await withTempHome(async () => {
    appendFailedWriteFallback("agent-falsy", { type: "remember", text: "x", was: "", on: "" }, "err", "mem.mjs");
    const [row] = (await readFile(FAILED_WRITE_FILE("agent-falsy"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal("was" in row, false);
    assert.equal("on" in row, false);
  });
});

test("FAILED_WRITE_FILE: unknown/empty agent still resolves to a stable, non-throwing path", () => {
  assert.match(FAILED_WRITE_FILE(""), /_failed_writes-unknown\.jsonl$/);
  assert.match(FAILED_WRITE_FILE(undefined), /_failed_writes-unknown\.jsonl$/);
});
