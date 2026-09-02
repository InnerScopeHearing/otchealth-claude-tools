// Unit tests for monitor.mjs's individual I/O-shaped helpers, each exercised with an injected fake
// `intercomRequest` (or fake conversation fixtures for the pure evaluation functions) -- no network,
// no real credentials, fully hermetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verifySafetyTag,
  applyTag,
  listConversationIds,
  searchConversationIds,
  discoverConversationIds,
  isCustomerAuthor,
  isAlreadyTagged,
  customerTexts,
  evaluateConversation,
  buildAlertMessage,
  intercomConversationLink,
  SAFETY_TAG_ID,
} from "../monitor.mjs";

// A tiny fake Intercom transport: a map of "METHOD path" -> response (or an array of responses,
// consumed in order, for endpoints called more than once with different bodies e.g. pagination).
function fakeRequest(routes) {
  const calls = [];
  const counters = {};
  const fn = async (path, opts = {}) => {
    const method = opts.method || "GET";
    calls.push({ path, method, body: opts.body });
    const key = `${method} ${path.split("?")[0]}`; // ignore query for routing; handlers inspect it themselves
    const handler = routes[key];
    if (!handler) throw new Error(`fakeRequest: no route for ${key}`);
    if (typeof handler === "function") return handler(path, opts, calls.length);
    return handler;
  };
  fn.calls = calls;
  return fn;
}

// ---- verifySafetyTag -------------------------------------------------------------------------------

test("verifySafetyTag passes when the tag id resolves to the expected name", async () => {
  const req = fakeRequest({ "GET /tags": { ok: true, status: 200, json: { data: [{ id: SAFETY_TAG_ID, name: "safety-escalation" }] } } });
  const res = await verifySafetyTag(req);
  assert.equal(res.ok, true);
});

test("verifySafetyTag fails loud when the tag id is missing entirely", async () => {
  const req = fakeRequest({ "GET /tags": { ok: true, status: 200, json: { data: [{ id: "999", name: "unrelated" }] } } });
  const res = await verifySafetyTag(req);
  assert.equal(res.ok, false);
  assert.match(res.error, /not found/);
});

test("verifySafetyTag fails loud when the id now resolves to a DIFFERENT name (refuses to tag under a repurposed id)", async () => {
  const req = fakeRequest({ "GET /tags": { ok: true, status: 200, json: { data: [{ id: SAFETY_TAG_ID, name: "totally-different-meaning" }] } } });
  const res = await verifySafetyTag(req);
  assert.equal(res.ok, false);
  assert.match(res.error, /repurposed/);
});

test("verifySafetyTag fails loud, distinctly, on a transport/HTTP failure", async () => {
  const req = fakeRequest({ "GET /tags": { ok: false, status: 500, error: "http-500" } });
  const res = await verifySafetyTag(req);
  assert.equal(res.ok, false);
  assert.match(res.error, /GET \/tags failed/);
});

// ---- applyTag --------------------------------------------------------------------------------------

test("applyTag posts the exact tag id to the conversation's tags endpoint", async () => {
  const req = fakeRequest({ "POST /conversations/42/tags": { ok: true, status: 200, json: {} } });
  const res = await applyTag(req, "42");
  assert.equal(res.ok, true);
  assert.equal(req.calls[0].body.id, SAFETY_TAG_ID);
});

test("applyTag fails loud on an HTTP error", async () => {
  const req = fakeRequest({ "POST /conversations/42/tags": { ok: false, status: 403, error: "http-403" } });
  const res = await applyTag(req, "42");
  assert.equal(res.ok, false);
  assert.match(res.error, /tagging conversation 42 failed/);
});

// ---- listConversationIds: pagination, client-side date filtering, and the early-stop optimization -

test("listConversationIds filters by created_at and stops early once a page is fully below the window while order has stayed descending -- never fetching a page beyond that", async () => {
  const since = 1_000_000;
  let page3Called = false;
  const req = fakeRequest({
    "GET /conversations": (path) => {
      const qs = new URLSearchParams(path.split("?")[1]);
      const cursor = qs.get("starting_after");
      if (!cursor) {
        // page 1: two conversations inside the window, descending, with a next cursor
        return { ok: true, status: 200, json: { conversations: [{ id: "A", created_at: since + 200 }, { id: "B", created_at: since + 100 }], pages: { next: { starting_after: "p2" } } } };
      }
      if (cursor === "p2") {
        // page 2: entirely BELOW the window -- this is where early-stop should kick in
        return { ok: true, status: 200, json: { conversations: [{ id: "C", created_at: since - 500 }], pages: { next: { starting_after: "p3" } } } };
      }
      if (cursor === "p3") {
        page3Called = true;
        return { ok: true, status: 200, json: { conversations: [{ id: "D", created_at: since - 999 }] } };
      }
      throw new Error("unexpected cursor");
    },
  });
  const result = await listConversationIds({ intercomRequest: req, sinceEpochSeconds: since, maxPages: 20, perPage: 50 });
  assert.deepEqual([...result.ids].sort(), ["A", "B"], "only in-window ids from pages 1 and 2 survive the filter");
  assert.equal(page3Called, false, "page 3 must never be fetched once early-stop conditions are met on page 2");
  assert.equal(result.errors.length, 0);
});

test("listConversationIds does NOT early-stop if order is not descending (correctness over speed)", async () => {
  const since = 1_000_000;
  let page2Called = false;
  const req = fakeRequest({
    "GET /conversations": (path) => {
      const qs = new URLSearchParams(path.split("?")[1]);
      const cursor = qs.get("starting_after");
      if (!cursor) {
        // page 1 looks fully below the window, BUT is out of order (100 < 200 then back up) --
        // must not be trusted to mean "nothing more recent could follow"
        return { ok: true, status: 200, json: { conversations: [{ id: "X", created_at: since - 500 }, { id: "Y", created_at: since - 100 }], pages: { next: { starting_after: "p2" } } } };
      }
      page2Called = true;
      return { ok: true, status: 200, json: { conversations: [{ id: "Z", created_at: since + 50 }] } };
    },
  });
  const result = await listConversationIds({ intercomRequest: req, sinceEpochSeconds: since, maxPages: 20, perPage: 50 });
  assert.equal(page2Called, true, "must keep paging when descending order cannot be trusted");
  assert.deepEqual([...result.ids], ["Z"]);
});

test("listConversationIds reports a distinct error and stops when a page request fails", async () => {
  const req = fakeRequest({ "GET /conversations": { ok: false, status: 500, error: "http-500" } });
  const result = await listConversationIds({ intercomRequest: req, sinceEpochSeconds: 0, maxPages: 5, perPage: 50 });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /http-500/);
});

// ---- searchConversationIds + the list/search reconciliation union ---------------------------------

test("discoverConversationIds unions list-only and search-only ids, and logs the asymmetry both ways", async () => {
  const since = 1_000_000;
  const req = fakeRequest({
    "GET /conversations": { ok: true, status: 200, json: { conversations: [{ id: "list-only", created_at: since + 10 }] } },
    "POST /conversations/search": { ok: true, status: 200, json: { conversations: [{ id: "search-only", created_at: since + 10 }] } },
  });
  const logs = [];
  const result = await discoverConversationIds({ intercomRequest: req, sinceEpochSeconds: since, maxPages: 5, perPage: 50, log: (m) => logs.push(m) });
  assert.deepEqual([...result.ids].sort(), ["list-only", "search-only"], "the union must include ids found by EITHER path, per the locked reconciliation requirement");
  assert.equal(result.viaList, 1);
  assert.equal(result.viaSearch, 1);
  assert.ok(logs.some((l) => l.includes("search only") && l.includes("search-only")));
  assert.ok(logs.some((l) => l.includes("direct list only") && l.includes("list-only")));
});

// ---- pure evaluation: customer-only authorship, already-tagged skip -------------------------------

test("isCustomerAuthor accepts user/lead/contact and rejects admin/bot", () => {
  for (const t of ["user", "lead", "contact"]) assert.equal(isCustomerAuthor({ type: t }), true, t);
  for (const t of ["admin", "bot", "team"]) assert.equal(isCustomerAuthor({ type: t }), false, t);
  assert.equal(isCustomerAuthor(null), false);
  assert.equal(isCustomerAuthor(undefined), false);
});

test("isAlreadyTagged checks the exact configured tag id, tolerating string/number id shapes", () => {
  assert.equal(isAlreadyTagged({ tags: { tags: [{ id: SAFETY_TAG_ID }] } }), true);
  assert.equal(isAlreadyTagged({ tags: { tags: [{ id: Number(SAFETY_TAG_ID) }] } }), true, "numeric id must still match the string constant");
  assert.equal(isAlreadyTagged({ tags: { tags: [{ id: "999999" }] } }), false);
  assert.equal(isAlreadyTagged({ tags: { tags: [] } }), false);
  assert.equal(isAlreadyTagged({}), false, "a conversation with no tags field at all must not throw");
});

test("customerTexts includes source + customer-authored parts, excludes admin/bot parts, and strips HTML", () => {
  const conversation = {
    source: { author: { type: "lead" }, body: "<p>Hello there</p>" },
    conversation_parts: {
      conversation_parts: [
        { author: { type: "admin" }, body: "<p>Sorry to hear that, looking into it</p>" },
        { author: { type: "user" }, body: "<p>It caught fire!</p>" },
        { author: { type: "bot" }, body: "" },
      ],
    },
  };
  const texts = customerTexts(conversation);
  assert.deepEqual(texts, ["Hello there", "It caught fire!"]);
});

test("evaluateConversation skips an already-tagged conversation WITHOUT even looking at its text", () => {
  const conversation = {
    tags: { tags: [{ id: SAFETY_TAG_ID }] },
    source: { author: { type: "user" }, body: "the device caught fire and burned my hand" },
  };
  const r = evaluateConversation(conversation);
  assert.equal(r.matched, false);
  assert.equal(r.alreadyTagged, true);
});

test("evaluateConversation ignores harmful-sounding ADMIN language and only fires on customer text", () => {
  const conversation = {
    tags: { tags: [] },
    source: { author: { type: "admin" }, body: "So sorry you were hurt and burned by this, we take safety hazards seriously." },
    conversation_parts: { conversation_parts: [{ author: { type: "user" }, body: "Actually never mind, my order just shipped late, thanks!" }] },
  };
  const r = evaluateConversation(conversation);
  assert.equal(r.matched, false, "admin apology boilerplate must never be the trigger");
});

test("evaluateConversation returns a truncated snippet and the matched rules for a genuine customer report", () => {
  const conversation = {
    tags: { tags: [] },
    source: { author: { type: "user" }, body: "The earbud shocked me and I had to go to the emergency room." },
  };
  const r = evaluateConversation(conversation);
  assert.equal(r.matched, true);
  assert.ok(r.matches.length >= 1);
  assert.ok(r.snippet.length <= 121);
});

// ---- SNS message shape (never leaks more than the 120-char snippet; contains the required fields) -

test("buildAlertMessage names the conversation, the matched rules, the snippet, and a direct Intercom link", () => {
  const msg = buildAlertMessage({
    id: "999",
    matches: [{ id: "bleeding", category: "injury", why: "bleeding" }],
    snippet: "my ear started bleeding",
    link: intercomConversationLink("999"),
  });
  assert.match(msg, /Conversation ID: 999/);
  assert.match(msg, /bleeding \(injury\): bleeding/);
  assert.match(msg, /my ear started bleeding/);
  assert.match(msg, /999\/conversations\/999|conversations\/999/);
  assert.match(msg, /No reply or other customer-facing action was taken/i);
});
