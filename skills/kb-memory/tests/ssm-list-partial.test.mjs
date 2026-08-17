// A PARTIAL SSM enumeration must never be returned as a complete one.
//
// Caught by an automated reviewer on PR #446 (HIGH). The original loop did `if (res.status !== 200)
// break;`, which converts "I could not finish enumerating" into "here is the complete answer". With
// ~450 parameters at MaxResults 50 that is ~9 pages, so one transient failure on page 2 returns 50
// of 450 -- and vault-registry's caller treats any non-empty array as success, so it would publish a
// credential registry claiming 50 credentials exist and the brain would index the other 400 as
// nonexistent. Silently under-reporting a credential inventory is worse than failing to build one.
//
// These tests pin the DISTINCTION the fix rests on, because it is the part a future edit would most
// plausibly flatten back into a bare `break`:
//   page 1 fails        -> [] (the store is simply not reachable from this seat; caller falls back)
//   page 2+ fails       -> THROW (a genuine truncation; caller must not publish)
import { test } from "node:test";
import assert from "node:assert/strict";

// Exercised through injected fakes rather than the network: the contract under test is the loop's
// error handling, not SigV4. Mirrors the shipped loop exactly; the source-shape assertion at the
// bottom fails if the real implementation drifts from it.
function makeLister(pages) {
  return async function ssmListDetailed() {
    const out = [];
    let token = null;
    let page = 0;
    do {
      const res = pages[page] ?? { status: 500 };
      if (res.status !== 200) {
        if (page === 0) return [];
        throw new Error(`ssmListDetailed: pagination failed on page ${page + 1} after ${out.length} parameters (HTTP ${res.status}) -- refusing to return a partial inventory`);
      }
      page += 1;
      for (const p of res.json.Parameters) out.push({ id: p.Name.replace("/otchealth/", ""), created: "" });
      token = res.json.NextToken || null;
    } while (token);
    return out.sort((a, b) => a.id.localeCompare(b.id));
  };
}
const okPage = (names, next) => ({ status: 200, json: { Parameters: names.map((n) => ({ Name: `/otchealth/${n}` })), ...(next ? { NextToken: next } : {}) } });

test("a mid-pagination failure THROWS rather than returning the pages it already had", async () => {
  const list = makeLister([okPage(["a", "b"], "tok1"), { status: 500 }]);
  await assert.rejects(list, /refusing to return a partial inventory/, "page-2 failure must not silently yield a 2-item 'complete' list");
});

test("the throw names how far it got, so the failure is diagnosable", async () => {
  const list = makeLister([okPage(["a", "b"], "tok1"), { status: 503 }]);
  await assert.rejects(list, (e) => /page 2/.test(e.message) && /after 2 parameters/.test(e.message) && /HTTP 503/.test(e.message));
});

test("a FIRST-page failure returns empty, not a throw: unreachable is not truncated", async () => {
  // The ordinary case on a seat with no AWS credentials. The caller must be free to fall through to
  // Key Vault; turning this into an exception would break every non-AWS seat.
  const list = makeLister([{ status: 400 }]);
  assert.deepEqual(await list(), []);
});

test("a complete multi-page enumeration still returns every page, sorted", async () => {
  const list = makeLister([okPage(["b", "a"], "tok1"), okPage(["d", "c"], "tok2"), okPage(["e"])]);
  assert.deepEqual((await list()).map((r) => r.id), ["a", "b", "c", "d", "e"]);
});

test("the SHIPPED aws-secret.mjs has no bare `break` left in either enumerator", async () => {
  // The counterfactual guard: this is the exact line that caused the bug, and the one a future edit
  // is most likely to reintroduce while "simplifying" the error handling.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../aws-secret.mjs", import.meta.url), "utf8");
  // STRIP COMMENTS FIRST. Without this the scan matches the fix's own doc comment, which quotes the
  // offending line verbatim in order to explain why it is wrong -- so the guard failed identically
  // on fixed and broken code, making it a check that discriminates nothing. Caught by running the
  // counterfactual (restore the bug, confirm the test flips) rather than by trusting a red result.
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  for (const fn of ["ssmListDetailed", "ssmList"]) {
    const start = code.indexOf(`export async function ${fn}(`);
    assert.ok(start > -1, `${fn} must exist`);
    const body = code.slice(start, code.indexOf("\n}", start));
    assert.doesNotMatch(body, /if \(res\.status !== 200\) break;/, `${fn} must not silently break out of pagination`);
    assert.match(body, /refusing to return a partial/, `${fn} must throw on a genuine truncation`);
    assert.match(body, /if \(page === 0\) return \[\];/, `${fn} must still return empty on a first-page failure`);
  }
});
