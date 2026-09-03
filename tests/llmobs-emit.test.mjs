// Tests for skills/datadog/llmobs-emit.mjs (the toolkit's port of the gateway's
// otchealth-mcp-server/src/telemetry/llmobs.ts -- see that file's own test suite,
// src/telemetry/llmobs.test.ts, for the sibling coverage this mirrors). Co-located at the repo-root
// tests/ directory to match this exact skill's existing sibling, tests/dd-emit.test.mjs, rather than
// skills/doc-indexer/tests/ (bedrock-client.test.mjs's home) -- different skill, different
// established location.
//
// CREDENTIAL-LOOKUP SAFETY: this sandbox's own ambient environment carries REAL AWS credentials
// (AWS_ACCESS_KEY_ID / OTC_AWS_ACCESS_KEY_ID etc, confirmed present at authoring time), so any test
// that lets emitLlmObsSpan's real credential resolution run unstubbed with DD_API_KEY absent would
// reach live AWS SSM using those real credentials and could pull the fleet's actual
// `datadog-api-key` secret value into this test process. Every test below therefore either (a) sets
// DD_API_KEY explicitly, which short-circuits resolveDdCreds() before _secretGetter is ever called
// (proven by source inspection: `process.env.DD_API_KEY || (await _secretGetter(...))` never
// evaluates the right-hand side once the left is truthy), or (b) uses _setSecretGetterForTests() to
// force a deterministic, network-free stub -- mirroring dd-emit.mjs's own tests/dd-emit.test.mjs,
// which established this exact pattern for this exact problem. No test in this file relies on
// ambient-env-clearing as proof of "unreachable" (unlike dd-emit.test.mjs's withNoAmbientCreds
// helper for ITS "missing key" test) -- the explicit stub is strictly safer and was preferred here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLlmObsSpan,
  buildLlmObsPayload,
  emitLlmObsSpan,
  generateSpanId,
  nowNs,
  _resetForTests,
  _setSecretGetterForTests,
} from "../skills/datadog/llmobs-emit.mjs";

const ENV_KEYS = ["DD_LLMOBS_ENABLED", "DD_LLMOBS_CAPTURE_CONTENT", "DD_LLMOBS_ML_APP", "DD_API_KEY", "DD_SITE"];

/** Clears every env var this module reads, then applies `overrides`, restoring afterward
 *  regardless of outcome -- mirrors the gateway llmobs.test.ts's withEnv exactly, so a real
 *  DD_LLMOBS_ENABLED/DD_API_KEY hydrated into this agent's own session (this toolkit's
 *  session-start.sh hydrates fleet secrets into many sessions) can never leak into an assertion. */
function withEnv(overrides, fn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

async function withStubbedFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** emitLlmObsSpan is deliberately synchronous-from-the-caller's-view (fire-and-forget): it never
 *  returns a promise the caller is expected to await. A test still needs to let its internal
 *  unawaited async chain (emitLlmObsSpanAsync) actually run before asserting on a stubbed fetch --
 *  a couple of microtask/macrotask turns is enough since no real network latency is involved once
 *  fetch itself is stubbed. */
function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("generateSpanId: 16 lowercase hex characters, not constant", () => {
  const id = generateSpanId();
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.notEqual(id, generateSpanId());
});

test("nowNs: millisecond-scaled nanoseconds (Date.now() * 1e6)", () => {
  const before = Date.now() * 1e6;
  const n = nowNs();
  const after = Date.now() * 1e6;
  assert.ok(n >= before && n <= after, "nowNs must fall within a Date.now()*1e6 window taken around the call");
});

// ---------------------------------------------------------------------------------------------
// Payload shape (buildLlmObsSpan / buildLlmObsPayload) -- pure, no env/network/secret lookup.
// Mirrors the gateway's llmobs.test.ts field-for-field so the two ports stay provably in sync.
// ---------------------------------------------------------------------------------------------

test("buildLlmObsSpan: an ok span carries ids/name/timing/kind/model/provider/tokens, no error", () => {
  const span = buildLlmObsSpan(
    {
      name: "bedrock.converse",
      kind: "llm",
      startNs: 1_000_000_000,
      durationNs: 500_000_000,
      ok: true,
      model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      provider: "bedrock",
      inputTokens: 500,
      outputTokens: 60,
      metadata: { stop_reason: "tool_use", tool_name: "emit_metadata" },
    },
    { spanId: "aaaa000000000000", traceId: "bbbb000000000000" },
  );
  assert.equal(span.span_id, "aaaa000000000000");
  assert.equal(span.trace_id, "bbbb000000000000");
  assert.equal(span.parent_id, "undefined");
  assert.equal(span.name, "bedrock.converse");
  assert.equal(span.start_ns, 1_000_000_000);
  assert.equal(span.duration, 500_000_000);
  assert.equal(span.status, "ok");
  assert.equal(span.meta.kind, "llm");
  assert.equal(span.meta.model_name, "us.anthropic.claude-haiku-4-5-20251001-v1:0");
  assert.equal(span.meta.model_provider, "bedrock");
  assert.deepEqual(span.meta.metadata, { stop_reason: "tool_use", tool_name: "emit_metadata" });
  assert.equal(span.meta.error, undefined, "no error field on a successful span");
  assert.equal(span.metrics.input_tokens, 500);
  assert.equal(span.metrics.output_tokens, 60);
  assert.equal(span.metrics.total_tokens, 560, "total_tokens derives from input+output when not supplied");
});

test("buildLlmObsSpan: content-off DEFAULT -- inputText/outputText never appear when DD_LLMOBS_CAPTURE_CONTENT is unset", () => {
  withEnv({}, () => {
    const span = buildLlmObsSpan(
      { name: "x", kind: "llm", startNs: 0, durationNs: 0, ok: true, inputText: "the full document text", outputText: "the full model completion" },
      { spanId: "s", traceId: "t" },
    );
    assert.equal(span.meta.input, undefined, "content must not leak by default");
    assert.equal(span.meta.output, undefined, "content must not leak by default");
  });
});

test("buildLlmObsSpan: content-off holds for an explicit falsy DD_LLMOBS_CAPTURE_CONTENT value too", () => {
  withEnv({ DD_LLMOBS_CAPTURE_CONTENT: "false" }, () => {
    const span = buildLlmObsSpan({ name: "x", kind: "llm", startNs: 0, durationNs: 0, ok: true, inputText: "secret" }, { spanId: "s", traceId: "t" });
    assert.equal(span.meta.input, undefined);
  });
});

test("buildLlmObsSpan: DD_LLMOBS_CAPTURE_CONTENT=1 opts caller-supplied content IN, bounded to 4000 chars", () => {
  withEnv({ DD_LLMOBS_CAPTURE_CONTENT: "1" }, () => {
    const span = buildLlmObsSpan(
      { name: "x", kind: "llm", startNs: 0, durationNs: 0, ok: true, inputText: "a".repeat(5000), outputText: "hi" },
      { spanId: "s", traceId: "t" },
    );
    assert.equal(span.meta.input.value.length, 4000, "content is bounded, never sent unbounded");
    assert.equal(span.meta.output.value, "hi");
  });
});

test("buildLlmObsSpan: an error span sets status=error and a truncated meta.error, never a fake ok", () => {
  const span = buildLlmObsSpan({ name: "x", kind: "llm", startNs: 0, durationNs: 1, ok: false, errorMessage: "z".repeat(1000) }, { spanId: "s", traceId: "t" });
  assert.equal(span.status, "error");
  assert.equal(span.meta.error.message.length, 500, "error message is bounded");
});

test("buildLlmObsSpan: non-finite/absent token counts are dropped; metrics omitted entirely when none finite", () => {
  const span = buildLlmObsSpan({ name: "x", kind: "llm", startNs: 0, durationNs: 0, ok: true, inputTokens: Number.NaN }, { spanId: "s", traceId: "t" });
  assert.equal(span.metrics, undefined);
});

test("buildLlmObsPayload: wraps spans under data.type=span with ml_app + tags attributes", () => {
  const span = buildLlmObsSpan({ name: "x", kind: "llm", startNs: 0, durationNs: 0, ok: true }, { spanId: "s", traceId: "t" });
  const payload = buildLlmObsPayload([span], "otchealth-toolkit", ["env:test"]);
  assert.ok(payload);
  assert.equal(payload.data.type, "span");
  assert.equal(payload.data.attributes.ml_app, "otchealth-toolkit");
  assert.deepEqual(payload.data.attributes.tags, ["env:test"]);
  assert.equal(payload.data.attributes.spans.length, 1);
});

test("buildLlmObsPayload: returns null for an empty span list", () => {
  assert.equal(buildLlmObsPayload([]), null);
});

// ---------------------------------------------------------------------------------------------
// Gating (emitLlmObsSpan) -- the INERT-BY-DEFAULT safety contract, proven with a stubbed fetch.
// Every scenario here sets DD_API_KEY explicitly (or uses _setSecretGetterForTests) so the real
// _secretGetter/kvSecret path is never reached -- see this file's header for why that matters on
// this sandbox specifically.
// ---------------------------------------------------------------------------------------------

test("emitLlmObsSpan: inert (no fetch call) when DD_LLMOBS_ENABLED is unset, even with a real-looking key present", async () => {
  await withEnv({ DD_API_KEY: "dd-test-key" }, async () => {
    let calls = 0;
    await withStubbedFetch(
      async () => {
        calls++;
        return new Response("{}", { status: 202 });
      },
      async () => {
        emitLlmObsSpan({ name: "x", kind: "llm", startNs: nowNs(), durationNs: 1, ok: true });
        await flushMicrotasks();
      },
    );
    assert.equal(calls, 0, "must not call fetch at all while DD_LLMOBS_ENABLED is unset");
  });
});

test("emitLlmObsSpan: inert (no fetch call) when DD_LLMOBS_ENABLED=1 but no Datadog key resolves (stubbed secret getter, no live SSM touched)", async () => {
  await withEnv({ DD_LLMOBS_ENABLED: "1" }, async () => {
    _setSecretGetterForTests(async () => null);
    try {
      let calls = 0;
      await withStubbedFetch(
        async () => {
          calls++;
          return new Response("{}", { status: 202 });
        },
        async () => {
          emitLlmObsSpan({ name: "x", kind: "llm", startNs: nowNs(), durationNs: 1, ok: true });
          await flushMicrotasks();
        },
      );
      assert.equal(calls, 0, "flag on but no key resolved -> still no network call");
    } finally {
      _resetForTests();
    }
  });
});

test("emitLlmObsSpan: enabled + DD_API_KEY present -> posts to the LLM Observability Spans intake with DD-API-KEY and the right body (env short-circuits before any secret-store lookup)", async () => {
  await withEnv({ DD_LLMOBS_ENABLED: "1", DD_API_KEY: "dd-test-key", DD_SITE: "us3.datadoghq.com" }, async () => {
    let calls = 0;
    let capturedUrl = "";
    let capturedInit;
    await withStubbedFetch(
      async (url, init) => {
        calls++;
        capturedUrl = String(url);
        capturedInit = init;
        return new Response("{}", { status: 202 });
      },
      async () => {
        emitLlmObsSpan({
          name: "bedrock.converse",
          kind: "llm",
          startNs: nowNs(),
          durationNs: 1_000_000,
          ok: true,
          model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
          provider: "bedrock",
          inputTokens: 500,
          outputTokens: 60,
          metadata: { stop_reason: "tool_use" },
        });
        await flushMicrotasks();
      },
    );
    assert.equal(calls, 1);
    assert.equal(capturedUrl, "https://api.us3.datadoghq.com/api/intake/llm-obs/v1/trace/spans");
    assert.equal(capturedInit.headers["DD-API-KEY"], "dd-test-key");
    const body = JSON.parse(capturedInit.body);
    assert.equal(body.data.type, "span");
    assert.equal(body.data.attributes.ml_app, "otchealth-toolkit");
    assert.equal(body.data.attributes.spans[0].name, "bedrock.converse");
    assert.equal(body.data.attributes.spans[0].meta.metadata.stop_reason, "tool_use");
  });
});

test("emitLlmObsSpan: DD_API_KEY set means the real secret-store lookup is never reached -- proven by an intentionally-throwing stub never firing", async () => {
  await withEnv({ DD_LLMOBS_ENABLED: "1", DD_API_KEY: "dd-test-key", DD_SITE: "us3.datadoghq.com" }, async () => {
    _setSecretGetterForTests(async () => {
      throw new Error("this must never be called -- DD_API_KEY was set, so the || short-circuits before this stub");
    });
    try {
      let calls = 0;
      await withStubbedFetch(
        async () => {
          calls++;
          return new Response("{}", { status: 202 });
        },
        async () => {
          emitLlmObsSpan({ name: "x", kind: "llm", startNs: nowNs(), durationNs: 1, ok: true });
          await flushMicrotasks();
        },
      );
      assert.equal(calls, 1, "the real request must still go out -- env alone was enough to resolve a key");
    } finally {
      _resetForTests();
    }
  });
});

test("emitLlmObsSpan: falls back to the secret-store lookup when DD_API_KEY is unset (stubbed getter, no live SSM touched)", async () => {
  await withEnv({ DD_LLMOBS_ENABLED: "1" }, async () => {
    const seenNames = [];
    _setSecretGetterForTests(async (name) => {
      seenNames.push(name);
      if (name === "datadog-api-key") return "recovered-from-secret-store";
      if (name === "datadog-site") return "us3.datadoghq.com";
      return null;
    });
    try {
      let capturedInit;
      await withStubbedFetch(
        async (_url, init) => {
          capturedInit = init;
          return new Response("{}", { status: 202 });
        },
        async () => {
          emitLlmObsSpan({ name: "x", kind: "llm", startNs: nowNs(), durationNs: 1, ok: true });
          await flushMicrotasks();
        },
      );
      assert.equal(capturedInit.headers["DD-API-KEY"], "recovered-from-secret-store");
      assert.ok(seenNames.includes("datadog-api-key"));
    } finally {
      _resetForTests();
    }
  });
});

test("emitLlmObsSpan: a THROWING secret-store lookup is swallowed -- no fetch call, never surfaces to the caller", async () => {
  await withEnv({ DD_LLMOBS_ENABLED: "1" }, async () => {
    _setSecretGetterForTests(async () => {
      throw new Error("SSM ThrottlingException: Rate exceeded");
    });
    try {
      let calls = 0;
      await withStubbedFetch(
        async () => {
          calls++;
          return new Response("{}", { status: 202 });
        },
        async () => {
          assert.doesNotThrow(() => emitLlmObsSpan({ name: "x", kind: "llm", startNs: nowNs(), durationNs: 1, ok: true }));
          await flushMicrotasks();
        },
      );
      assert.equal(calls, 0);
    } finally {
      _resetForTests();
    }
  });
});

test("emitLlmObsSpan: never throws, even if fetch itself throws synchronously", async () => {
  // Both DD_API_KEY and DD_SITE are set explicitly (not just DD_API_KEY) -- resolveDdCreds()
  // resolves `key` and `site` on two INDEPENDENT env-then-secret-store lines; leaving DD_SITE
  // unset here would fall through to the real _secretGetter("datadog-site") (unstubbed in this
  // test), the exact live-credential risk this file's header describes. Caught by review before
  // landing: an earlier draft of this test omitted DD_SITE and relied on the fetch stub below
  // ALSO intercepting that accidental real lookup (aws-secret.mjs's SSM call goes through the
  // same globalThis.fetch) -- true this time, but incidental, not a guarantee (a different auth
  // path in that module shells out via execFileSync instead, which no fetch stub would catch).
  await withEnv({ DD_LLMOBS_ENABLED: "1", DD_API_KEY: "dd-test-key", DD_SITE: "us3.datadoghq.com" }, async () => {
    await withStubbedFetch(
      () => {
        throw new Error("boom");
      },
      async () => {
        assert.doesNotThrow(() => emitLlmObsSpan({ name: "x", kind: "llm", startNs: nowNs(), durationNs: 1, ok: true }));
        await flushMicrotasks();
      },
    );
  });
});
