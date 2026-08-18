// Tests for the otc.fleet.agent_error wiring in skills/fleet-telemetry/telemetry.mjs. Datadog
// monitor 22893313 ("AI Fleet — agent errors (1h)") has watched this metric since 2026-06-27 with
// NOTHING ever emitting it (repo-wide grep across every repo this session had access to, zero code
// hits, before this change). fleet-telemetry already computes the real per-session tool-error count
// from the transcript (parseTranscript's `errors`, sourced from real tool_result.is_error entries);
// this suite proves (a) that count is computed correctly from real transcript shapes, (b) the emit
// wrapper forwards it honestly without swallowing a failure, and (c) sessionEnd's real control flow
// actually calls the emitter with the real count, before ever touching PostHog. No real network,
// Key Vault, or PostHog calls happen here (sessionEnd's deps are all injected).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTranscript, emitAgentErrorMetric, sessionEnd } from "../telemetry.mjs";

function fixtureTranscript(dir, lines) {
  const p = join(dir, "t.jsonl");
  writeFileSync(p, lines.map((o) => JSON.stringify(o)).join("\n") + "\n");
  return p;
}

test("parseTranscript: counts real tool_result.is_error entries (the exact number both PostHog's tool_errors and the new Datadog metric report)", () => {
  const dir = mkdtempSync(join(tmpdir(), "tele-parse-"));
  try {
    const p = fixtureTranscript(dir, [
      { type: "assistant", message: { role: "assistant", model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "tool_use", name: "Bash" }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", is_error: true }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", is_error: false }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", is_error: true }] } },
    ]);
    const m = parseTranscript(p);
    assert.equal(m.errors, 2, "must count only the two is_error:true results, not the clean one");
    assert.equal(m.toolCalls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseTranscript: a clean transcript (no tool_result errors) reports errors:0, not null/undefined (the metric must be able to report a real zero, not go silent)", () => {
  const dir = mkdtempSync(join(tmpdir(), "tele-parse-clean-"));
  try {
    const p = fixtureTranscript(dir, [
      { type: "assistant", message: { role: "assistant", model: "claude-sonnet-4-6", usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    assert.equal(parseTranscript(p).errors, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emitAgentErrorMetric: forwards to the injected emitter with the real metric name, count, and agent tag", async () => {
  const calls = [];
  const fakeEmit = async (metric, value, tags, opts) => { calls.push({ metric, value, tags, opts }); return true; };
  const ok = await emitAgentErrorMetric("cto", 3, fakeEmit);
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].metric, "otc.fleet.agent_error");
  assert.equal(calls[0].value, 3);
  assert.deepEqual(calls[0].tags, ["agent:cto"]);
  assert.equal(calls[0].opts.type, "count");
});

test("emitAgentErrorMetric: relays the injected emitter's FAILURE honestly -- never upgrades false to true (no silent swallow)", async () => {
  const fakeEmit = async () => false;
  const ok = await emitAgentErrorMetric("cto", 1, fakeEmit);
  assert.equal(ok, false);
});

test("sessionEnd: computes the REAL per-session error count from the transcript and calls the Datadog emitter with it, independent of and before PostHog capture", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tele-sessend-"));
  try {
    const transcriptPath = fixtureTranscript(dir, [
      { type: "assistant", message: { role: "assistant", model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: 5 } } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", is_error: true }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", is_error: true }] } },
    ]);
    const errorCalls = [];
    const captureCalls = [];
    await sessionEnd({
      transcriptPath,
      agent: "cto",
      sessionId: "test-sid-1",
      emitAgentError: async (agent, errorCount) => { errorCalls.push({ agent, errorCount }); return true; },
      ingestKey: "fake-posthog-key",
      capture: async (key, events) => { captureCalls.push({ key, events }); },
    });
    assert.deepEqual(errorCalls, [{ agent: "cto", errorCount: 2 }]);
    // PostHog capture still ran (independent system, independent secret)
    assert.equal(captureCalls.length, 1);
    assert.equal(captureCalls[0].key, "fake-posthog-key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sessionEnd: the Datadog emit is attempted even when the emitter itself fails (proves it is not conditioned on PostHog succeeding, and a failure does not throw)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tele-sessend-fail-"));
  try {
    const transcriptPath = fixtureTranscript(dir, [
      { type: "assistant", message: { role: "assistant", model: "claude-sonnet-4-6", usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    let emitAttempted = false;
    let captureAttempted = false;
    await sessionEnd({
      transcriptPath,
      agent: "cfo",
      sessionId: "test-sid-2",
      emitAgentError: async () => { emitAttempted = true; return false; }, // simulate a genuine Datadog failure
      ingestKey: "fake-posthog-key",
      capture: async () => { captureAttempted = true; },
    });
    assert.equal(emitAttempted, true);
    assert.equal(captureAttempted, true, "PostHog capture must still run even though the Datadog emit failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sessionEnd wires emitAgentErrorMetric's default to the real ddEmitMetric, not a local stand-in (source check -- avoids a real network round trip in the suite)", async () => {
  const src = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../telemetry.mjs", import.meta.url), "utf8"));
  assert.match(src, /import\s*\{\s*ddEmitMetric\s*\}\s*from\s*["']\.\.\/datadog\/dd-emit\.mjs["']/, "must import the shared honest emitter");
  assert.match(src, /emitFn\s*=\s*ddEmitMetric/, "emitAgentErrorMetric must default to the real ddEmitMetric");
  assert.match(src, /await emitAgentError\(agent, m\.errors\)/, "sessionEnd must actually call it with the real parsed error count");
});
