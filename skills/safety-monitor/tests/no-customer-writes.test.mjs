// Tests for the constraint #1 pin: "it must never contact a customer." This test file greps
// monitor.mjs's OWN source (and, for defense in depth, classify.mjs's) for the endpoint/helper-name
// shapes that would let it reply, message, or otherwise write to a customer, and fails the build if
// any appear. It also proves the scanner itself is not vacuous: each forbidden pattern is checked
// against a synthetic snippet built specifically to trip it, so a scanner that always returned []
// (silently passing everything) would be caught here, not just assumed correct because monitor.mjs
// happens to be clean today.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scanForbiddenCustomerWrites, FORBIDDEN_CUSTOMER_WRITE_PATTERNS } from "../monitor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MONITOR_SRC = readFileSync(join(HERE, "..", "monitor.mjs"), "utf8");
const CLASSIFY_SRC = readFileSync(join(HERE, "..", "classify.mjs"), "utf8");

test("monitor.mjs's own source contains NO customer-write endpoint or helper shape", () => {
  const hits = scanForbiddenCustomerWrites(MONITOR_SRC);
  assert.deepEqual(hits, [], `monitor.mjs must never import/construct a customer-write call; found: ${JSON.stringify(hits)}`);
});

test("classify.mjs's own source contains NO customer-write endpoint or helper shape (defense in depth)", () => {
  const hits = scanForbiddenCustomerWrites(CLASSIFY_SRC);
  assert.deepEqual(hits, []);
});

test("the scanner is NOT vacuous -- each forbidden pattern really does fire on a snippet built to trip it", () => {
  const synthetic = {
    "reply-path": 'await intercomRequest(`/conversations/${id}/reply`, { method: "POST", body });',
    "reply-fn-name": "function replyConversation(id, text) { /* ... */ }",
    "new-message-path": 'await intercomRequest("/messages", { method: "POST", body });',
    "new-conversation-helper": "async function createConversation(payload) { /* ... */ }",
    "outbound-message-helper": "async function sendMessage(to, text) { /* ... */ }",
  };
  // Every id declared in the real pattern table must have a synthetic fixture exercising it, and
  // vice versa -- so this test itself cannot silently go stale if a pattern is added or renamed
  // without an accompanying fixture.
  const declaredIds = FORBIDDEN_CUSTOMER_WRITE_PATTERNS.map((p) => p.id).sort();
  assert.deepEqual(Object.keys(synthetic).sort(), declaredIds, "every declared forbidden pattern needs exactly one non-vacuity fixture, and vice versa");

  for (const [id, snippet] of Object.entries(synthetic)) {
    const hits = scanForbiddenCustomerWrites(snippet);
    assert.ok(hits.some((h) => h.id === id), `pattern "${id}" must fire on its own trigger snippet: ${snippet}`);
  }
});

test("ordinary English descriptions of the concept do NOT trip the scanner (it is a code-shape check, not a topic ban)", () => {
  // This is what makes it safe for THIS FILE to even discuss what it must never do, in its own
  // header comment, without tripping itself.
  const prose =
    "This monitor never contacts a customer: it does not reply to a conversation, does not send a " +
    "message, and does not create a new conversation on a customer's behalf.";
  assert.deepEqual(scanForbiddenCustomerWrites(prose), []);
});
