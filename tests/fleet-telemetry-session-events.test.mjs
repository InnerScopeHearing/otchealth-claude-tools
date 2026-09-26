import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPANY_TELEMETRY_AGENTS, buildSessionEvent, parseTranscriptText, sessionEnd } from "../skills/fleet-telemetry/telemetry.mjs";

const QUERY_CONTRACT = JSON.parse(readFileSync(new URL("../skills/fleet-telemetry/query-contract-v1.json", import.meta.url), "utf8"));
const EXPECTED_COMPANY_TELEMETRY_AGENTS = ["cto", "cfo", "clo", "coo", "cpo", "cro", "cco", "developer"];

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
  assert.equal(metrics.modelUsageEntries, 2);
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
    agent: "cto", callsiteId: "cto_task", sessionId: "123e4567-e89b-12d3-a456-426614174000", timestamp: "2026-09-25T10:00:02.000Z",
  });

  assert.equal(event.event, "agent_session");
  assert.equal(event.distinct_id, "cto");
  assert.equal(event.timestamp, "2026-09-25T10:00:02.000Z");
  assert.equal(event.properties.telemetry_schema_version, 2);
  assert.equal(event.properties.cost_basis, "not_observed");
  assert.deepEqual(event.properties.model_counts, { "claude-sonnet-4-5": 1 });
  assert.equal(event.properties.model_call_count, 1);
  assert.equal(event.properties.input_tokens, 2);
  assert.equal(event.properties.output_tokens, 1);
  assert.equal(event.properties.total_tokens, 3);
  for (const property of QUERY_CONTRACT.current_cost_analysis.forbidden_properties) {
    assert.equal(event.properties[property], undefined, `${property} is not observed by this source`);
  }
  assert.equal(JSON.stringify(event).includes("sensitive response"), false);
  assert.equal(JSON.stringify(event).includes("synthetic request"), false);
});

test("buildSessionEvent allows only company seats and excludes personal, PHI/service, and unknown lanes", () => {
  const metrics = parseTranscriptText(line("assistant", "2026-09-25T10:00:01.000Z", {
    role: "assistant", model: "claude-sonnet-4-5", usage: { input_tokens: 2, output_tokens: 1 }, content: [],
  }));
  const options = { callsiteId: "synthetic", sessionId: "synthetic-session", timestamp: "2026-09-25T10:00:02.000Z" };

  assert.deepEqual([...COMPANY_TELEMETRY_AGENTS], EXPECTED_COMPANY_TELEMETRY_AGENTS);
  for (const agent of COMPANY_TELEMETRY_AGENTS) {
    assert.equal(buildSessionEvent(metrics, { ...options, agent })?.event, "agent_session", `${agent} is a company lane`);
  }
  for (const agent of ["clo-personal", "medreview", "companion", "unknown", ""]) {
    assert.equal(buildSessionEvent(metrics, { ...options, agent }), null, `${agent || "empty"} is excluded`);
  }
});

test("buildSessionEvent exports only bounded opaque identifiers", () => {
  const metrics = parseTranscriptText(line("assistant", "2026-09-25T10:00:01.000Z", {
    role: "assistant", model: "claude-sonnet-4-5", usage: { input_tokens: 2, output_tokens: 1 }, content: [],
  }));
  const event = buildSessionEvent(metrics, {
    agent: "cto",
    callsiteId: "synthetic prompt text",
    sessionId: "synthetic session identifier with text",
    timestamp: "2026-09-25T10:00:02.000Z",
  });

  assert.equal(event.properties.callsite_id, "cto");
  assert.match(event.properties.session_id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  assert.doesNotMatch(JSON.stringify(event), /synthetic prompt text|synthetic session identifier with text/);

  const validIds = buildSessionEvent(metrics, {
    agent: "cto", callsiteId: "persona.cto", sessionId: "123e4567-e89b-12d3-a456-426614174000",
  });
  assert.equal(validIds.properties.callsite_id, "persona.cto");
  assert.equal(validIds.properties.session_id, "123e4567-e89b-12d3-a456-426614174000");
});

test("query contract v1 filters only schema-v2 company sessions and excludes unsupported analysis", () => {
  const expectedWhere = [
    "event = 'agent_session'",
    "properties.telemetry_schema_version = 2",
    "properties.cost_basis = 'not_observed'",
    `properties.agent IN (${EXPECTED_COMPANY_TELEMETRY_AGENTS.map((agent) => `'${agent}'`).join(", ")})`,
  ].join(" AND ");

  assert.equal(QUERY_CONTRACT.contract_version, 1);
  assert.equal(QUERY_CONTRACT.telemetry_event, "agent_session");
  assert.equal(QUERY_CONTRACT.telemetry_schema_version, 2);
  assert.deepEqual(QUERY_CONTRACT.company_agent_allowlist, EXPECTED_COMPANY_TELEMETRY_AGENTS);
  assert.deepEqual([...COMPANY_TELEMETRY_AGENTS], QUERY_CONTRACT.company_agent_allowlist);
  assert.deepEqual(QUERY_CONTRACT.excluded_agent_examples, ["clo-personal", "medreview", "companion", "unknown", ""]);
  assert.deepEqual(QUERY_CONTRACT.excluded_legacy_session_event_names, ["$ai_generation"]);
  assert.equal(QUERY_CONTRACT.hogql_where, expectedWhere);
  assert.doesNotMatch(QUERY_CONTRACT.hogql_where, /\$ai_generation/);
  assert.match(QUERY_CONTRACT.model_counts_semantics, /including entries without a usage object/i);
  assert.match(QUERY_CONTRACT.model_call_count_semantics, /does not prove provider API calls/i);
  assert.equal(QUERY_CONTRACT.current_cost_analysis.session_event_supported, false);
  assert.equal(QUERY_CONTRACT.current_cost_analysis.cost_basis, "not_observed");
  assert.equal(QUERY_CONTRACT.current_cost_analysis.actual_cost_source, "provider billing artifacts only");
  assert.equal(QUERY_CONTRACT.routing_analysis.provider_call_count_supported, false);
  assert.equal(QUERY_CONTRACT.routing_analysis.cost_per_token_supported, false);
  assert.equal(QUERY_CONTRACT.routing_analysis.quality_join_key, "callsite_id");
  assert.deepEqual(QUERY_CONTRACT.cache_analysis.allowed_properties, ["cache_read_tokens", "cache_write_tokens"]);
});

test("session-end skips a protected lane before reading its transcript or resolving telemetry secrets", () => {
  const script = fileURLToPath(new URL("../skills/fleet-telemetry/telemetry.mjs", import.meta.url));
  const missingTranscript = join(tmpdir(), `synthetic-missing-${process.pid}-${Date.now()}.jsonl`);
  const home = mkdtempSync(join(tmpdir(), "tele-protected-home-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".kb-agent"), "clo-personal\n");
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: home };
  delete env.KB_AGENT;

  let result;
  try {
    result = spawnSync(process.execPath, [script, "session-end", "--transcript", missingTranscript, "--agent", "cto"], {
      encoding: "utf8", env, input: "{}",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /skipped non-company or segregated lane/);
  assert.doesNotMatch(result.stderr, /parse:|BLACKOUT-RISK|secret store/);
});

test("session-end fails closed when KB_AGENT conflicts with a protected marker before transcript, SSM, or PostHog access", async () => {
  const home = mkdtempSync(join(tmpdir(), "tele-conflict-home-"));
  const project = join(home, "project");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(home, ".claude", ".kb-agent"), "clo-personal\n");

  const keys = ["KB_AGENT", "HOME", "USERPROFILE", "CLAUDE_PROJECT_DIR"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const calls = [];
  const logs = [];
  try {
    process.env.KB_AGENT = "cto";
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CLAUDE_PROJECT_DIR = project;

    const result = await sessionEnd({
      inputText: JSON.stringify({ transcript_path: join(project, "synthetic-transcript.jsonl"), session_id: "123e4567-e89b-12d3-a456-426614174000" }),
      args: [],
      transcriptReader: () => { calls.push("transcript"); return parseTranscriptText(""); },
      secretResolver: async () => { calls.push("ssm"); return null; },
      eventSender: async () => { calls.push("posthog"); },
      logger: { error: (message) => logs.push(message), log: () => {} },
    });

    assert.deepEqual(result, { status: "skipped", reason: "protected-marker-conflict" });
    assert.deepEqual(calls, []);
    assert.match(logs.join("\n"), /skipped conflicting company seat pin and protected marker/);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(home, { recursive: true, force: true });
  }
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

test("parseTranscriptText preserves model mix when an assistant entry has no usage object", () => {
  const transcript = [
    line("assistant", "2026-09-25T10:00:01.000Z", {
      role: "assistant", model: "claude-sonnet-4-5", usage: { input_tokens: 10, output_tokens: 2 }, content: [],
    }),
    line("assistant", "2026-09-25T10:00:02.000Z", {
      role: "assistant", model: "claude-haiku-4-5", content: [],
    }),
  ].join("\n");

  const metrics = parseTranscriptText(transcript);
  assert.equal(metrics.model, "mixed");
  assert.deepEqual(metrics.modelCounts, { "claude-sonnet-4-5": 1, "claude-haiku-4-5": 1 });
  assert.equal(metrics.modelUsageEntries, 1);
  assert.equal(metrics.inTok, 10);
  assert.equal(metrics.outTok, 2);

  const event = buildSessionEvent(metrics, { agent: "cto", callsiteId: "cto_task", sessionId: "synthetic-session" });
  assert.deepEqual(event.properties.model_counts, metrics.modelCounts);
  assert.equal(event.properties.model_call_count, metrics.modelUsageEntries);
});

test("parseTranscriptText uses valid timestamps when malformed timestamps are also present", () => {
  const transcript = [
    line("assistant", "not-a-timestamp", { role: "assistant", model: "claude-sonnet-4-5", content: [] }),
    line("user", "2026-09-25T10:00:00.000Z", { role: "user", content: "synthetic" }),
    line("assistant", "2026-09-25T10:00:05.000Z", { role: "assistant", model: "claude-sonnet-4-5", content: [] }),
    line("user", "also-not-a-timestamp", { role: "user", content: "synthetic" }),
  ].join("\n");

  const metrics = parseTranscriptText(transcript);
  assert.equal(metrics.durMs, 5000);
});
