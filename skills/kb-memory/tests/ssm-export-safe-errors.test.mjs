import { test } from "node:test";
import assert from "node:assert/strict";
import { ssmGetParametersByPathAllWithValues } from "../aws-secret.mjs";

// Fake credentials and a fake fetch: no provider call or real secret is used.
delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
process.env.AWS_ACCESS_KEY_ID = "TEST_ACCESS_KEY";
process.env.AWS_SECRET_ACCESS_KEY = "TEST_SECRET_KEY";
delete process.env.AWS_SESSION_TOKEN;

const originalFetch = globalThis.fetch;
async function withPages(pages, action) {
  let i = 0;
  globalThis.fetch = async () => {
    assert.ok(i < pages.length, "unexpected provider request");
    const p = pages[i++];
    return new Response(p.text ?? JSON.stringify(p.json ?? {}), { status: p.status });
  };
  try { return await action(); } finally { globalThis.fetch = originalFetch; }
}
const first = { status: 200, json: { Parameters: [{ Name: "/otchealth/test-name", Value: "test-value", Type: "SecureString" }], NextToken: "fake-next-token" } };
test("complete pagination returns all values", async () => {
  const result = await withPages([first, { status: 200, json: { Parameters: [{ Name: "/otchealth/second", Value: "test-two" }] } }], () => ssmGetParametersByPathAllWithValues());
  assert.equal(result.length, 2);
  assert.equal(result[1].name, "second");
});
test("first-page failure keeps the existing empty result", async () => {
  assert.deepEqual(await withPages([{ status: 403 }], () => ssmGetParametersByPathAllWithValues()), []);
});
test("mid-page known AWS error includes only a safe category and remains fail-closed", async () => {
  await withPages([first, { status: 400, json: { __type: "com.amazon.coral.service#AccessDeniedException", message: "test-value fake-next-token secret-details" } }], async () => {
    await assert.rejects(ssmGetParametersByPathAllWithValues(), e => {
      assert.match(e.message, /page 2 after 1 parameters \(HTTP 400\)/);
      assert.match(e.message, /AWS error AccessDeniedException/);
      assert.match(e.message, /refusing to return a partial export/);
      assert.doesNotMatch(e.message, /test-value|fake-next-token|secret-details/);
      return true;
    });
  });
});
test("unexpected error fields and raw text never enter the failure message", async () => {
  for (const failure of [
    { status: 400, json: { __type: "private-name-or-secret-value", message: "sensitive error details" } },
    { status: 502, text: "sensitive error details" },
  ]) {
    await withPages([first, failure], async () => {
      await assert.rejects(ssmGetParametersByPathAllWithValues(), e => {
        assert.match(e.message, /AWS error unclassified/);
        assert.doesNotMatch(e.message, /private-name|secret-value|sensitive|fake-next-token|test-value/);
        return true;
      });
    });
  }
});
