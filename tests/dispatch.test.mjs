// Unit tests for the agent-dispatch protocol logic: the loop-safety + ring + routing invariants that
// keep an autonomous dispatch fleet from running away or leaking. Pure functions, no I/O, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ringAllowed, agentSafe, inboxPath, buildEnvelope, loopExceeded, nextReply, newId }
  from "../skills/agent-dispatch/dispatch.mjs";

test("ringAllowed refuses PHI / INND-securities / personal on the wire, permits non-phi", () => {
  for (const r of ["phi", "medreview", "innd", "securities", "mnpi", "clo-personal", "personal", "PHI", " Innd "])
    assert.equal(ringAllowed(r), false, `ring '${r}' must be refused`);
  for (const r of ["non-phi", "", null, undefined, "commerce"])
    assert.equal(ringAllowed(r), true, `ring '${r}' should be allowed`);
});

test("agentSafe strips path-traversal and separators (no inbox escape)", () => {
  assert.equal(agentSafe("CTO"), "cto");
  assert.equal(agentSafe("plant id"), "plant_id");
  const evil = agentSafe("../../etc/passwd");
  assert.ok(!evil.includes("/") && !evil.includes(".."), "must not retain traversal");
  assert.throws(() => agentSafe(""), "empty agent id is rejected");
});

test("inboxPath routes by addressee (the filename is the recipient)", () => {
  assert.match(inboxPath("dispatch", "plantid"), /dispatch\/plantid\.inbox\.jsonl$/);
  assert.match(inboxPath("dispatch", "CTO"), /dispatch\/cto\.inbox\.jsonl$/);
});

test("buildEnvelope validates: task required, no self-dispatch, defaults applied", () => {
  const e = buildEnvelope({ from: "cto", to: "plantid", task: "do the thing" });
  assert.equal(e.from, "cto"); assert.equal(e.to, "plantid");
  assert.equal(e.hops, 0); assert.equal(e.ttl, 6); assert.equal(e.ring, "non-phi"); assert.equal(e.status, "open");
  assert.equal(e.thread, e.id, "a new dispatch opens its own thread");
  assert.throws(() => buildEnvelope({ from: "cto", to: "cto", task: "x" }), /yourself/);
  assert.throws(() => buildEnvelope({ from: "cto", to: "plantid", task: "" }), /task/);
  assert.throws(() => buildEnvelope({ from: "cto", to: "plantid", task: "x", ring: "innd" }), /wire/);
});

test("loopExceeded fires exactly at the hop cap", () => {
  assert.equal(loopExceeded({ hops: 5, ttl: 6 }), false);
  assert.equal(loopExceeded({ hops: 6, ttl: 6 }), true);
  assert.equal(loopExceeded({ hops: 7, ttl: 6 }), true);
});

test("nextReply routes BACK to the sender, inherits the thread, and increments hops", () => {
  const orig = buildEnvelope({ from: "cto", to: "plantid", task: "round 4" });
  const reply = nextReply(orig, { from: "plantid", to: "cto", task: "done, 9.1/9.0/9.2" });
  assert.equal(reply.to, "cto", "a reply goes back to whoever asked");
  assert.equal(reply.from, "plantid");
  assert.equal(reply.thread, orig.thread, "same thread");
  assert.equal(reply.reply_to, orig.id);
  assert.equal(reply.hops, 1, "each hop increments toward the cap");
});

test("a reply can never route to the replier itself (no self-wake)", () => {
  const orig = buildEnvelope({ from: "cto", to: "plantid", task: "x" });
  // plantid replying must address cto, not plantid; building a self-addressed reply throws
  assert.throws(() => nextReply(orig, { from: "plantid", to: "plantid", task: "y" }), /yourself/);
});

test("newId is sortable-ish and unique across calls", () => {
  const a = newId(), b = newId();
  assert.notEqual(a, b);
  assert.match(a, /^[a-z0-9]+-[0-9a-f]{10}$/);
});
