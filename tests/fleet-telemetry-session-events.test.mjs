import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSessionEvent, parseTranscriptText } from "../skills/fleet-telemetry/telemetry.mjs";

function line(type, timestamp, message) {
  return JSON.stringify({ type, timestamp, message });
}

test("parseTranscriptText keeps per-session token/cache totals and mixed model counts", () => {
  const transcript = [
    line("user", "2026-09-25T10:00:00.000Z", { role: "user", content: "synthetic request" }),
    line("assistant", "2026-09-25T10:00:01.000Z", {
      role: "assistant", model: "claude-sonnet-4-5", usage: {
        input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 10, cache_read_input_tokens: 50,
      }, content: [{ type: "tool_use", name: "brain_search" }],
    }),
    line("assistant", "2026-09-25T10:00:05.000Z", {
      role: "assistant", model: "claude-haiku-4-5", usage: { input_tokens: 30, output_tokens: 5 },
      content: [{ type: "text", text: "synthetic private text must not be exported" }],
    }),
    line("user", "2026-09-25T10:00:06.000Z", {
      role: "user", content: [{ type: "tool_result", is_error: true, content: "synthetic tool result" }],
    }),
    "not-json",
  ].join("\n");

  const metrics = parseTranscriptText(transcript);
  assert.equal(metrics.inTok, 130);
  assert.equal(metrics.outTok, 25);
  assert.equal(metrics.cacheW, 10);
  assert.equal(metrics.cacheR, 50);
  assert.equal(metrics.totalTok, 215);
  assert.equal(metrics.model, "mixed");
  assert.deepEqual(metrics.modelCounts, { "claude-sonnet-4-5": 1, "claude-haiku-4-5": 1 });
  assert.equal(metrics.modelCalls, 2);
  assert.equal(metrics.toolCalls, 1);
  assert.equal(metrics.errors, 1);
  assert.equal(metrics.durMs, 6000);
});

test("buildSessionEvent emits one metadata-only session aggregate, without inferred billing", () => {
  const metrics = parseTranscriptText(line("assistant", "2026-09-25T10:00:01.000Z", {
    role: "assistant", model: "claude-sonnet-4-5", usage: { input_tokens: 2, output_tokens: 1 },
    content: [{ type: "text", text: "sensitive response must not leave this runtime" }],
  }));
  const event = buildSessionEvent(metrics, {
    agent: "cto", callsiteId: "cto_task", sessionId: "synthetic-session", timestamp: "2026-09-25T10:00:02.000Z",
  });

  assert.equal(event.event, "agent_session");
  assert.equal(event.distinct_id, "cto");
  assert.equal(event.timestamp, "2026-09-25T10:00:02.000Z");
  assert.equal(event.properties.telemetry_schema_version, 2);
  assert.equal(event.properties.cost_basis, "not_observed");
  assert.equal(event.properties.model_call_count, 1);
  assert.equal(event.properties.input_tokens, 2);
  assert.equal(event.properties.output_tokens, 1);
  assert.equal(event.properties.total_tokens, 3);
  assert.equal(event.properties.$ai_total_cost_usd, undefined);
  assert.equal(event.properties.est_cost_usd, undefined);
  assert.equal(JSON.stringify(event).includes("sensitive response"), false);
  assert.equal(JSON.stringify(event).includes("synthetic request"), false);
});

test("parseTranscriptText clamps malformed token counts and timestamps to safe zeroes", () => {
  const metrics = parseTranscriptText(line("assistant", "not-a-timestamp", {
    role: "assistant", model: "claude-sonnet-4-5", usage: {
      input_tokens: "bad", output_tokens: -1, cache_creation_input_tokens: null, cache_read_input_tokens: 4.8,
    }, content: [],
  }));
  assert.equal(metrics.inTok, 0);
  assert.equal(metrics.outTok, 0);
  assert.equal(metrics.cacheW, 0);
  assert.equal(metrics.cacheR, 4);
  assert.equal(metrics.totalTok, 4);
  assert.equal(metrics.durMs, 0);
});
