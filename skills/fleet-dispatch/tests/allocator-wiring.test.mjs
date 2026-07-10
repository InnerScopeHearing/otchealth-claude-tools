// Tests for the compute-allocator wiring in fleet-dispatch/dispatch.mjs. dispatch now consults the
// allocator on TASK dispatches, stamps the recommendation on the inbox row, and folds it into the
// spawn task text. These pin the two exported glue helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAllocationFor, fmtCompute } from "../dispatch.mjs";

test("fmtCompute(null) is empty (no annotation when the allocator was unavailable)", () => {
  assert.equal(fmtCompute(null), "");
});

test("fmtCompute renders a one-line agents/model/critic summary", () => {
  const line = fmtCompute({ agents: 3, model: "opus", useCritic: true, signals: 2 });
  assert.match(line, /3 agent\(s\)/);
  assert.match(line, /model=opus/);
  assert.match(line, /critic-pass=yes/);
  assert.match(line, /2 recent signal/);
});

test("fmtCompute omits the signal clause when there are none", () => {
  const line = fmtCompute({ agents: 1, model: "sonnet", useCritic: false, signals: 0 });
  assert.match(line, /critic-pass=no/);
  assert.doesNotMatch(line, /recent signal/);
});

test("computeAllocationFor is fail-open: never throws, returns null OR a well-formed recommendation", async () => {
  // No assertion on live signals (may be 0 offline, or >0 where creds exist): either way it must not
  // throw and must return either null (fail-open) or the full recommendation shape.
  let rec;
  await assert.doesNotReject(async () => { rec = await computeAllocationFor("cto", "reverse-engineer and red-team the auth flow"); });
  if (rec !== null) {
    assert.ok(Number.isInteger(rec.agents) && rec.agents >= 1 && rec.agents <= 4);
    assert.ok(rec.model === "opus" || rec.model === "sonnet");
    assert.equal(typeof rec.useCritic, "boolean");
    assert.equal(typeof rec.rationale, "string");
  }
});
