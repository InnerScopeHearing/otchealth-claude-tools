// Unit tests for monitor.mjs's individual I/O-shaped helpers, each exercised with an injected fake
// `intercomRequest` (or fake conversation fixtures for the pure evaluation functions) -- no network,
// no real credentials, fully hermetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

// ---- CLI contract, review round 2 (2026-09-02) ---------------------------------------------------

test("the CLI routes progress logs to stderr under --json, so stdout carries only the JSON document", () => {
  // Pinned by source shape rather than by a live run: a --json sweep against real Intercom data
  // (29 conversations, 7-day window) produced parseable JSON, but with no matches and no
  // list/search disagreement the log callback never fired, so that run could not distinguish a
  // working redirect from a quiet one. Asserting the wiring is the non-vacuous check available
  // here; the live run is recorded in the PR as corroboration, not as the proof.
  const src = readFileSync(new URL("../monitor.mjs", import.meta.url), "utf8");
  const cliCall = src.slice(src.indexOf("summary = await runSweep({"));
  assert.match(
    cliCall.slice(0, 400),
    /json \? \{ log: \(msg\) => console\.error\(msg\) \}/,
    "under --json the CLI must pass a log that writes to stderr; without it runSweep's default logs to stdout and corrupts the JSON",
  );
});

// ---- pagination cap: both discovery paths must fail LOUD, and neither may cry wolf ---------------

test("searchConversationIds reports an error when the page cap cuts discovery short", async () => {
  // This warning did not exist. listConversationIds had one and search did not, so a truncated
  // search discovery produced a clean, successful sweep -- incomplete discovery on a customer-safety
  // monitor, reported as a good run. Both paths must fail loud for their union to mean anything.
  const page = { ok: true, status: 200, json: { conversations: [{ id: "z" }], pages: { next: { starting_after: "MORE" } } } };
  const req = async () => page; // every page claims another page follows
  const res = await searchConversationIds({ intercomRequest: req, sinceEpochSeconds: 0, maxPages: 3 });
  assert.equal(res.pages, 3, "must stop at the cap");
  assert.ok(
    res.errors.some((e) => /INCOMPLETE/.test(e) && /safety cap/.test(e)),
    `a capped search must report incompleteness, got: ${JSON.stringify(res.errors)}`,
  );
});

test("neither discovery path cries wolf when history is exhausted exactly ON the last allowed page", async () => {
  // The old listConversationIds condition was `pages >= maxPages`, which fired even when the final
  // allowed page had no next cursor -- a COMPLETE result set that happened to end on the limit was
  // reported as a failure, and on this monitor any error makes the whole run exit non-zero.
  const now = Math.floor(Date.now() / 1000);
  let n = 0;
  const listReq = async () => {
    n++;
    const last = n === 2;
    return { ok: true, status: 200, json: { conversations: [{ id: `c${n}`, created_at: now }], pages: last ? {} : { next: { starting_after: "MORE" } } } };
  };
  const list = await listConversationIds({ intercomRequest: listReq, sinceEpochSeconds: now - 3600, maxPages: 2, perPage: 1 });
  assert.equal(list.pages, 2, "used exactly the allowed pages");
  assert.deepEqual(list.errors, [], "history was exhausted on the last allowed page, so there is nothing to warn about");

  let m = 0;
  const searchReq = async () => {
    m++;
    const last = m === 2;
    return { ok: true, status: 200, json: { conversations: [{ id: `s${m}` }], pages: last ? {} : { next: { starting_after: "MORE" } } } };
  };
  const search = await searchConversationIds({ intercomRequest: searchReq, sinceEpochSeconds: 0, maxPages: 2 });
  assert.deepEqual(search.errors, [], "same rule for the search path");
});

test("both discovery paths scan the IDENTICAL window: a conversation created in exactly the boundary second is found by list AND by search", async () => {
  // Intercom's search API has no >= operator, so the search body has to compensate. It did not:
  // list filtered client-side with `created_at >= since` (inclusive) while search sent
  // `operator: ">", value: since` (exclusive). A conversation created in exactly the boundary
  // second was therefore visible to one path and invisible to the other.
  //
  // That asymmetry is only harmless if you assume both paths always work. The two exist precisely
  // because they don't (FND-20260817-64f5) -- search is the cover for list's misses and vice versa.
  // A boundary conversation was uncovered exactly when list was the path that failed.
  //
  // This is deliberately a SEMANTIC test, not an assertion that the body literally says
  // `since - 1`: the fake below actually evaluates the query it is sent against a shared corpus,
  // so it fails for any body whose effective window excludes the boundary second, and passes for
  // any body that includes it. A future rewrite that switches operators is free to pass.
  const since = 1_900_000_000;
  const corpus = [
    { id: "before", created_at: since - 1 }, // strictly outside the window -- neither path may return it
    { id: "boundary", created_at: since },   // exactly ON the boundary -- BOTH paths must return it
    { id: "after", created_at: since + 60 }, // comfortably inside
  ];

  const listReq = async () => ({ ok: true, status: 200, json: { conversations: corpus, pages: {} } });
  const list = await listConversationIds({ intercomRequest: listReq, sinceEpochSeconds: since, perPage: 50 });

  // The fake search endpoint honours the query it receives rather than returning a canned answer.
  const searchReq = async (_path, opts = {}) => {
    const q = opts.body?.query || {};
    assert.equal(q.field, "created_at", "the search must filter on created_at");
    const ops = { ">": (a, b) => a > b, ">=": (a, b) => a >= b };
    const cmp = ops[q.operator];
    assert.ok(cmp, `unsupported search operator ${q.operator}`);
    return { ok: true, status: 200, json: { conversations: corpus.filter((c) => cmp(c.created_at, q.value)), pages: {} } };
  };
  const search = await searchConversationIds({ intercomRequest: searchReq, sinceEpochSeconds: since });

  assert.deepEqual([...list.ids].sort(), ["after", "boundary"], "list is inclusive of the boundary second");
  assert.deepEqual([...search.ids].sort(), ["after", "boundary"], "search must cover the SAME window, boundary second included");
  assert.equal(search.ids.has("before"), false, "and must not widen the window either -- the second before it stays out");
});

test("the search path requests the caller's perPage on EVERY page, first page included -- and discovery passes it through", async () => {
  // Before: pagination was attached only when a cursor already existed, and hardcoded
  // DEFAULT_PER_PAGE when it was. So page one silently used Intercom's own smaller search default,
  // and --per-page changed the list path's reach while leaving this one untouched. Both effects cut
  // how far search gets before the page cap, on the path whose whole purpose is to cover what the
  // list path misses -- so under-reach here is invisible by construction.
  const seen = [];
  const req = fakeRequest({
    "POST /conversations/search": (_p, opts, n) => {
      seen.push(opts.body?.pagination);
      return { ok: true, status: 200, json: { conversations: [{ id: `s${n}` }], pages: n === 1 ? { next: { starting_after: "CUR" } } : {} } };
    },
  });
  await searchConversationIds({ intercomRequest: req, sinceEpochSeconds: 0, perPage: 7, maxPages: 5 });
  assert.equal(seen.length, 2, "two pages were served");
  assert.equal(seen[0]?.per_page, 7, "the FIRST page must carry per_page, not fall back to the API default");
  assert.equal(seen[0]?.starting_after, undefined, "and must not send a cursor it does not have");
  assert.equal(seen[1]?.per_page, 7, "later pages must use the caller's value, not a hardcoded constant");
  assert.equal(seen[1]?.starting_after, "CUR");

  // And the value has to actually reach here from discovery, which previously dropped it.
  const seen2 = [];
  const req2 = fakeRequest({
    "GET /conversations": { ok: true, status: 200, json: { conversations: [], pages: {} } },
    "POST /conversations/search": (_p, opts) => {
      seen2.push(opts.body?.pagination?.per_page);
      return { ok: true, status: 200, json: { conversations: [], pages: {} } };
    },
  });
  await discoverConversationIds({ intercomRequest: req2, sinceEpochSeconds: 0, perPage: 11, maxPages: 3, log: () => {} });
  assert.deepEqual(seen2, [11], "discoverConversationIds must forward perPage to the search path too");
});
