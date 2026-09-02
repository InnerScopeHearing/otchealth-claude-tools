// Tests for setup/prompt-shape.mjs — the shared prompt-caching hygiene helper (2026-09-02 OpenAI
// cost-lever sweep). Pure module, no network, no env reads: every assertion here is a plain function
// call.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CACHE_TOKEN_THRESHOLD,
  cacheableTokensEstimate,
  staticFirst,
  logPrefixShape,
  logPrefixForText,
} from "./prompt-shape.mjs";

test("CACHE_TOKEN_THRESHOLD matches OpenAI's documented GPT-5.6+ minimum cacheable prefix length", () => {
  assert.equal(CACHE_TOKEN_THRESHOLD, 1024);
});

// ---- cacheableTokensEstimate ------------------------------------------------------------------

test("cacheableTokensEstimate: empty/nullish input is 0 tokens", () => {
  assert.equal(cacheableTokensEstimate(""), 0);
  assert.equal(cacheableTokensEstimate(null), 0);
  assert.equal(cacheableTokensEstimate(undefined), 0);
});

test("cacheableTokensEstimate: chars/4 rounded up, the documented rule-of-thumb ratio", () => {
  assert.equal(cacheableTokensEstimate("abcd"), 1); // 4 chars -> 1 token
  assert.equal(cacheableTokensEstimate("abcde"), 2); // 5 chars -> ceil(5/4) = 2
  assert.equal(cacheableTokensEstimate("a".repeat(4096)), 1024); // exactly at the threshold
});

test("cacheableTokensEstimate: a real ~1024-token-class string crosses the threshold, a short one does not", () => {
  const long = "x".repeat(4100); // > 4096 chars -> > 1024 estimated tokens
  const short = "You are a strict eval judge.";
  assert.ok(cacheableTokensEstimate(long) >= CACHE_TOKEN_THRESHOLD);
  assert.ok(cacheableTokensEstimate(short) < CACHE_TOKEN_THRESHOLD);
});

// ---- staticFirst -------------------------------------------------------------------------------

test("staticFirst: system-only + variable -> exactly two messages, system first, variable last, byte-identical system text", () => {
  const { messages } = staticFirst({ system: "You are a critic.", variable: "review this draft" });
  assert.deepEqual(messages, [
    { role: "system", content: "You are a critic." },
    { role: "user", content: "review this draft" },
  ]);
});

test("staticFirst: omitting variable produces a system-only messages array (no empty user message)", () => {
  const { messages } = staticFirst({ system: "static only" });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "system");
});

test("staticFirst: omitting system (only rubric/variable given) produces no blank system message", () => {
  const { messages } = staticFirst({ rubric: ["a", "b"], variable: "answer text" });
  assert.equal(messages[0].role, "system");
  assert.equal(messages[0].content, "RUBRIC:\n1. a\n2. b");
  assert.equal(messages[1].content, "answer text");
});

test("staticFirst: rubric renders as a numbered list matching the fleet's existing judge-prompt convention", () => {
  const { messages } = staticFirst({ system: "sys", rubric: ["first criterion", "second criterion"], variable: "ans" });
  assert.equal(messages[0].content, "sys\n\nRUBRIC:\n1. first criterion\n2. second criterion");
});

test("staticFirst: rubric accepts a single string as well as an array", () => {
  const { messages } = staticFirst({ system: "sys", rubric: "only one criterion", variable: "ans" });
  assert.equal(messages[0].content, "sys\n\nRUBRIC:\n1. only one criterion");
});

test("staticFirst: examples render after the rubric, both before the variable content", () => {
  const { messages } = staticFirst({ system: "sys", rubric: ["r1"], examples: ["ex1", "ex2"], variable: "ans" });
  assert.equal(messages[0].content, "sys\n\nRUBRIC:\n1. r1\n\nEXAMPLES:\n1. ex1\n2. ex2");
  assert.equal(messages[0].role, "system");
  assert.equal(messages[1].content, "ans");
});

test("staticFirst: an empty-string/empty-array rubric or examples value is skipped, not rendered as an empty block", () => {
  const { messages } = staticFirst({ system: "sys", rubric: [], examples: "", variable: "ans" });
  assert.equal(messages[0].content, "sys");
});

test("staticFirst: trims incidental leading/trailing whitespace on the system string only (never touches variable content)", () => {
  const { messages } = staticFirst({ system: "  sys with padding  ", variable: "  ans with padding  " });
  assert.equal(messages[0].content, "sys with padding");
  assert.equal(messages[1].content, "  ans with padding  ");
});

test("staticFirst: returns prefixText/prefixTokensEstimate/cacheable consistent with cacheableTokensEstimate", () => {
  const system = "x".repeat(4100);
  const { prefixText, prefixTokensEstimate, cacheable } = staticFirst({ system, variable: "v" });
  assert.equal(prefixText, system);
  assert.equal(prefixTokensEstimate, cacheableTokensEstimate(system));
  assert.equal(cacheable, true);
});

test("staticFirst: a short static prefix is correctly flagged NOT cacheable", () => {
  const { cacheable, prefixTokensEstimate } = staticFirst({ system: "short", variable: "v" });
  assert.equal(cacheable, false);
  assert.ok(prefixTokensEstimate < CACHE_TOKEN_THRESHOLD);
});

test("staticFirst: with nothing at all given, returns an empty messages array rather than throwing", () => {
  const { messages, prefixText, cacheable } = staticFirst({});
  assert.deepEqual(messages, []);
  assert.equal(prefixText, "");
  assert.equal(cacheable, false);
});

test("staticFirst: a numeric/non-string variable is coerced to a string (never sent as a non-string content value)", () => {
  const { messages } = staticFirst({ system: "sys", variable: 42 });
  assert.equal(messages[1].content, "42");
});

// ---- logPrefixShape / logPrefixForText ---------------------------------------------------------

function withCapturedStderr(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

test("logPrefixShape: emits the exact 'prefix~N tokens (cacheable: yes/no)' shape, one line", () => {
  const lines = withCapturedStderr(() => logPrefixShape("my-caller", 1200, true));
  assert.equal(lines.length, 1);
  assert.equal(lines[0], "[my-caller] prefix~1200 tokens (cacheable: yes)");
});

test("logPrefixShape: cacheable:false renders when the boolean is false", () => {
  const lines = withCapturedStderr(() => logPrefixShape("my-caller", 50, false));
  assert.equal(lines[0], "[my-caller] prefix~50 tokens (cacheable: no)");
});

test("logPrefixForText: computes the estimate AND logs it in one call, returning the same number", () => {
  const text = "x".repeat(4100);
  let n;
  const lines = withCapturedStderr(() => { n = logPrefixForText("enrich", text); });
  assert.equal(n, cacheableTokensEstimate(text));
  assert.equal(lines[0], `[enrich] prefix~${n} tokens (cacheable: yes)`);
});

test("logPrefixForText: never throws on nullish input, logs a 0-token, not-cacheable line", () => {
  const lines = withCapturedStderr(() => logPrefixForText("caller", null));
  assert.equal(lines[0], "[caller] prefix~0 tokens (cacheable: no)");
});
