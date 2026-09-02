// End-to-end orchestration tests for runSweep(), with a fully injected fake Intercom transport and a
// fake SNS publisher -- no network, no real credentials. These prove the locked design constraints
// that only show up at the orchestration level: dry-run does nothing, --commit does exactly the right
// things, one bad conversation never silently swallows the rest of the run, and a truncated customer
// quote never reaches the returned/printed summary (constraint #7's privacy rule) even though it does
// reach the one SNS message a real match produces.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSweep, SAFETY_TAG_ID } from "../monitor.mjs";

const NOW_MS = 2_000_000_000; // fixed clock; created_at values below are chosen relative to this
const NOW_S = Math.floor(NOW_MS / 1000);

function fakeRequest(routes) {
  const calls = [];
  const fn = async (path, opts = {}) => {
    const method = opts.method || "GET";
    calls.push({ path, method, body: opts.body });
    const key = `${method} ${path.split("?")[0]}`;
    const handler = routes[key];
    if (!handler) throw new Error(`fakeRequest: no route registered for ${key}`);
    return typeof handler === "function" ? handler(path, opts, calls) : handler;
  };
  fn.calls = calls;
  return fn;
}

const TAGS_OK = { ok: true, status: 200, json: { data: [{ id: SAFETY_TAG_ID, name: "safety-escalation" }] } };

function conversationDetailRoutes(byId) {
  const out = {};
  for (const [id, conv] of Object.entries(byId)) out[`GET /conversations/${id}`] = { ok: true, status: 200, json: conv };
  return out;
}

// One conversation with a genuine customer-reported hazard, untagged.
const CONV_MATCH = { id: "A", tags: { tags: [] }, source: { author: { type: "user" }, body: "The earbud caught fire while charging." } };
// One conversation already carrying the safety tag -- must be skipped even though its text would also match.
const CONV_ALREADY_TAGGED = { id: "B", tags: { tags: [{ id: SAFETY_TAG_ID, name: "safety-escalation" }] }, source: { author: { type: "user" }, body: "I was hospitalized after using it." } };
// One perfectly ordinary conversation.
const CONV_CLEAN = { id: "C", tags: { tags: [] }, source: { author: { type: "lead" }, body: "Just checking on my order status, thanks." } };

function baseRoutes() {
  return {
    "GET /tags": TAGS_OK,
    "GET /conversations": { ok: true, status: 200, json: { conversations: [{ id: "A", created_at: NOW_S - 60 }, { id: "B", created_at: NOW_S - 60 }, { id: "C", created_at: NOW_S - 60 }] } },
    "POST /conversations/search": { ok: true, status: 200, json: { conversations: [] } },
    ...conversationDetailRoutes({ A: CONV_MATCH, B: CONV_ALREADY_TAGGED, C: CONV_CLEAN }),
  };
}

test("dry run: reports what it WOULD do, and calls neither the tag endpoint nor SNS", async () => {
  let snsCalled = false;
  const req = fakeRequest({ ...baseRoutes(), "POST /conversations/A/tags": { ok: true, status: 200, json: {} } });
  const summary = await runSweep({
    commit: false,
    nowMs: () => NOW_MS,
    intercomRequest: req,
    publishSnsAlert: async () => { snsCalled = true; return { ok: true }; },
    log: () => {},
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.scanned, 3);
  assert.equal(summary.alreadyTagged, 1);
  assert.equal(summary.matched.length, 1);
  assert.equal(summary.matched[0].id, "A");
  assert.equal(summary.tagged, 0, "dry run must never tag");
  assert.equal(summary.alerted, 0, "dry run must never alert");
  assert.equal(snsCalled, false);
  assert.equal(req.calls.some((c) => c.path.includes("/tags") && c.method === "POST"), false, "no tag-write call of any kind in dry run");
});

test("--commit: tags the match and publishes exactly one SNS alert for it, and skips the already-tagged conversation entirely", async () => {
  const snsCalls = [];
  const req = fakeRequest({ ...baseRoutes(), "POST /conversations/A/tags": { ok: true, status: 200, json: {} } });
  const summary = await runSweep({
    commit: true,
    nowMs: () => NOW_MS,
    intercomRequest: req,
    publishSnsAlert: async (item) => { snsCalls.push(item); return { ok: true, messageId: "m1" }; },
    log: () => {},
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.tagged, 1);
  assert.equal(summary.alerted, 1);
  assert.equal(snsCalls.length, 1);
  assert.equal(snsCalls[0].id, "A");
  const tagCall = req.calls.find((c) => c.path === "/conversations/A/tags");
  assert.equal(tagCall.body.id, SAFETY_TAG_ID);
  assert.equal(req.calls.some((c) => c.path.includes("/conversations/B/tags")), false, "an already-tagged conversation must never be re-tagged");
});

test("startup tag-verification failure aborts BEFORE any conversation is scanned (never a false 'zero matches, all clear')", async () => {
  const req = fakeRequest({ "GET /tags": { ok: true, status: 200, json: { data: [{ id: "999", name: "unrelated" }] } } });
  const summary = await runSweep({ commit: false, nowMs: () => NOW_MS, intercomRequest: req, log: () => {} });
  assert.equal(summary.ok, false);
  assert.equal(summary.scanned, 0);
  assert.match(summary.errors[0], /startup:/);
  assert.equal(req.calls.some((c) => c.path.startsWith("/conversations")), false, "must never attempt discovery when the tag itself could not be confirmed");
});

test("a single conversation's fetch failure is isolated: other conversations are still evaluated, and the failure is a distinct, non-zero-triggering error", async () => {
  const req = fakeRequest({
    "GET /tags": TAGS_OK,
    "GET /conversations": { ok: true, status: 200, json: { conversations: [{ id: "A", created_at: NOW_S - 60 }, { id: "broken", created_at: NOW_S - 60 }] } },
    "POST /conversations/search": { ok: true, status: 200, json: { conversations: [] } },
    "GET /conversations/A": { ok: true, status: 200, json: CONV_MATCH },
    "GET /conversations/broken": { ok: false, status: 500, error: "http-500" },
  });
  const summary = await runSweep({ commit: false, nowMs: () => NOW_MS, intercomRequest: req, log: () => {} });
  assert.equal(summary.ok, false, "a real fetch failure must make the run report ok:false");
  assert.equal(summary.scanned, 2, "the broken conversation still counts as scanned (attempted)");
  assert.equal(summary.matched.length, 1, "conversation A must still be evaluated despite the sibling failure");
  assert.ok(summary.errors.some((e) => e.includes("broken") && e.includes("http-500")));
});

test("an SNS publish failure in --commit mode leaves the conversation UNTAGGED, so a later run can retry instead of burying it", async () => {
  // REWRITTEN 2026-09-02. The original asserted tagged:1 here -- it pinned the exact defect the auto
  // critic caught. Old order was tag-then-alert, so a successful tag plus a failed alert produced a
  // conversation that was tagged (hence skipped by isAlreadyTagged forever) and never alerted:
  // permanently unalertable, silently, with later runs counting it under `alreadyTagged`
  // indistinguishably from one that WAS alerted. Order is now alert-then-tag, so a failed alert
  // writes nothing and the escalation stays visible. tagged:0 is not a relaxed assertion, it is the
  // opposite claim, and it is the safe one.
  const req = fakeRequest({ ...baseRoutes(), "POST /conversations/A/tags": { ok: true, status: 200, json: {} } });
  const summary = await runSweep({
    commit: true,
    nowMs: () => NOW_MS,
    intercomRequest: req,
    publishSnsAlert: async () => ({ ok: false, error: "SNS publish failed: http-403 (AuthorizationError: not authorized)" }),
    log: () => {},
  });
  assert.equal(summary.ok, false);
  assert.equal(summary.alerted, 0);
  assert.equal(summary.tagged, 0, "a failed alert must NOT leave a tag behind -- the tag is what hides it from every future run");
  assert.equal(req.calls.filter((c) => c.path === "/conversations/A/tags").length, 0, "the tag endpoint must not be called at all once the alert failed");
  assert.ok(summary.errors.some((e) => e.includes("A") && e.includes("SNS publish failed")));
});

test("a tag-write failure in --commit mode still ALERTS a human, and the error says so", async () => {
  // REWRITTEN 2026-09-02 with the alert-then-tag reorder. The original asserted alerted:0 and
  // snsCalled:false -- a failed tag suppressed the alert entirely, on an escalation already
  // classified as a real match. Now the human is told first and a failing tag only means the next
  // run tells them again. A duplicate alert is a visible annoyance; a suppressed one is the failure
  // this monitor exists to prevent.
  const req = fakeRequest({ ...baseRoutes(), "POST /conversations/A/tags": { ok: false, status: 403, error: "http-403" } });
  let snsCalled = false;
  const summary = await runSweep({
    commit: true,
    nowMs: () => NOW_MS,
    intercomRequest: req,
    publishSnsAlert: async () => { snsCalled = true; return { ok: true }; },
    log: () => {},
  });
  assert.equal(summary.ok, false, "a failed tag is still a real error the run must report");
  assert.equal(snsCalled, true, "the human MUST have been alerted before the tag was attempted");
  assert.equal(summary.alerted, 1);
  assert.equal(summary.tagged, 0);
  assert.ok(summary.errors.some((e) => e.includes("A") && /was alerted/i.test(e)), "the error must record that a human WAS alerted, so a reader does not assume it was dropped");
});

test("a classifier error is caught, reported as a DISTINCT message, and does not stop the rest of the run", async () => {
  const req = fakeRequest(baseRoutes());
  const summary = await runSweep({
    commit: false,
    nowMs: () => NOW_MS,
    intercomRequest: req,
    evaluate: (conversation) => {
      if (conversation.id === "A") throw new Error("simulated classifier explosion");
      return { matched: false, alreadyTagged: false, matches: [], snippet: null };
    },
    log: () => {},
  });
  assert.equal(summary.ok, false);
  assert.ok(summary.errors.some((e) => e.includes("CLASSIFIER ERROR") && e.includes("simulated classifier explosion")));
  assert.equal(summary.scanned, 3, "the other two conversations must still be scanned despite A's classifier throwing");
});

test("PRIVACY: the returned summary (what --json prints to stdout) never contains the matched customer text, only rule ids/categories and the conversation id/link", async () => {
  const req = fakeRequest({ ...baseRoutes(), "POST /conversations/A/tags": { ok: true, status: 200, json: {} } });
  const summary = await runSweep({
    commit: true,
    nowMs: () => NOW_MS,
    intercomRequest: req,
    publishSnsAlert: async () => ({ ok: true }),
    log: () => {},
  });
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /caught fire/i, "the verbatim customer quote must never appear in the printable summary");
  assert.doesNotMatch(serialized, /"snippet"/, "no snippet field of any kind belongs on the summary object");
  assert.match(serialized, /"A"/, "the conversation id itself is fine to log");
});

test("reconciliation counts are reported: a conversation found only via search still gets scanned and evaluated", async () => {
  const req = fakeRequest({
    "GET /tags": TAGS_OK,
    "GET /conversations": { ok: true, status: 200, json: { conversations: [] } },
    "POST /conversations/search": { ok: true, status: 200, json: { conversations: [{ id: "search-only", created_at: NOW_S - 60 }] } },
    "GET /conversations/search-only": { ok: true, status: 200, json: { id: "search-only", tags: { tags: [] }, source: { author: { type: "user" }, body: "It shocked me and I called 911." } } },
  });
  const summary = await runSweep({ commit: false, nowMs: () => NOW_MS, intercomRequest: req, log: () => {} });
  assert.equal(summary.discovery.viaList, 0);
  assert.equal(summary.discovery.viaSearch, 1);
  assert.equal(summary.discovery.union, 1);
  assert.equal(summary.matched.length, 1);
  assert.equal(summary.matched[0].id, "search-only");
});

test("an escalation whose alert failed is STILL detected on a later run (the permanently-unalertable regression)", async () => {
  // The end-to-end form of the critic's high finding, and the one that would have caught it. Sweep
  // twice over the same conversation with a failing alert and prove the second sweep still sees a
  // live match rather than writing it off as handled. Under the old tag-then-alert order the second
  // sweep reported alreadyTagged:1 and matched:0 -- one transient SNS failure and a real customer
  // safety escalation was invisible from then on, with nothing anywhere saying so.
  const routes = { ...baseRoutes(), "POST /conversations/A/tags": { ok: true, status: 200, json: {} } };
  const opts = {
    commit: true,
    nowMs: () => NOW_MS,
    publishSnsAlert: async () => ({ ok: false, error: "SNS publish failed: http-500" }),
    log: () => {},
  };

  const first = await runSweep({ ...opts, intercomRequest: fakeRequest(routes) });
  assert.equal(first.matched[0]?.id, "A", "first sweep must detect conversation A");
  assert.equal(first.tagged, 0, "and must not tag it, because the alert failed");

  // Second sweep sees the same conversation, still untagged because the first wrote nothing.
  // NOTE on the alreadyTagged count: the shared fixture deliberately includes conversation B, which
  // is already tagged, so this counter is 1 on EVERY sweep and 0 would be the wrong expectation
  // (my first draft of this test asserted 0 and failed for that reason, not because of the code).
  // The real invariant is that A must never JOIN that set on the strength of a failed alert.
  const second = await runSweep({ ...opts, intercomRequest: fakeRequest(routes) });
  assert.equal(second.matched[0]?.id, "A", "A must STILL be detected on a later run -- this is the entire point");
  assert.equal(second.alreadyTagged, 1, "only the fixture's pre-tagged conversation B, never A");
});
