// Tests for skills/agent-evals/run-evals.mjs's reasoning-exhaustion BATCH recovery
// (2026-09-03, FND-20260903-8c23).
//
// THE FINDING: OPENAI_BATCH mode has no retry-within-the-batch mechanism. When a reasoning-family
// model burns its whole max_completion_tokens budget on hidden reasoning (finish_reason=length,
// empty visible content), awaitBatch() (setup/model-routing.mjs) correctly classifies this as an
// infra failure rather than a real blank answer -- but main()'s per-task loop then simply SKIPS the
// task (see run-evals-eval-judge.test.mjs's own model_not_found tests for that existing, correct,
// skip-and-log behavior for OTHER batch-error classes). One golden task is genuinely LOST per
// occurrence (observed live: nightly run 33775653832, 2026-09-03, task "lifecycle-reactivation").
//
// THE FIX: recoverReasoningExhaustedBatchAnswers() re-runs ONLY the reasoning-exhausted task(s)
// through a single synchronous retry (callChatOpenAI, which already retries+escalates internally,
// with a throttle-triggered fallback to the fallback model mirroring chat()'s own try/catch), and
// mutates the batchedAnswers Map in place so the recovered answer is indistinguishable from a batch
// line that succeeded the first time -- flowing into whichever judge path (OpenAI batch judge, or
// the synchronous Nova judge dispatch) main() takes next.
//
// isReasoningExhaustedBatchResult()/recoverReasoningExhaustedBatchAnswers() both take every value as
// an explicit parameter (dep/apiKey/fbDep/fbApiKey), never module-level state set by initModel() --
// same established convention as runPersonaBatch/runJudgeBatch/runOneBatch in this same file (see
// their own header comment), so this is directly testable with a mocked global.fetch and fake
// credentials, no real network/credentials ever touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

async function freshRunEvals() {
  return import(`../run-evals.mjs?t=${Date.now()}-${Math.random()}`);
}
function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return (async () => { try { return await run(); } finally { globalThis.fetch = original; } })();
}
function withEnv(vars, run) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  return (async () => { try { return await run(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } })();
}
function withStubbedConsoleError(run) {
  const original = console.error;
  const calls = [];
  console.error = (...args) => { calls.push(args.join(" ")); };
  return (async () => { try { await run(calls); } finally { console.error = original; } })();
}
// Cleared for every test that reaches callChatOpenAI (directly or via recovery), mirroring
// run-evals-truncation.test.mjs's own CLEAR_TIER_ENV -- keeps the flex-lane floor (tries/timeout)
// from silently activating just because an ambient env var happens to be set in the test runner.
const CLEAR_TIER_ENV = { OPENAI_SERVICE_TIER: undefined, OPENAI_SERVICE_TIER_AGENT_EVALS: undefined };

// ---- shared batch-API fixtures (mirrors run-evals-eval-judge.test.mjs's own fixtures exactly) ----
function fakeBatchObject(overrides = {}) {
  return { id: "batch_abc123", status: "completed", output_file_id: "file-out-1", error_file_id: null, errors: null, ...overrides };
}
function modelNotFoundLine(customId, model) {
  return { custom_id: customId, response: null, error: { message: `The model \`${model}\` does not exist or you do not have access to it.`, type: "invalid_request_error", param: null, code: "model_not_found" } };
}
function reasoningExhaustedLine(customId) {
  return { custom_id: customId, response: { body: { choices: [{ message: { content: "" }, finish_reason: "length" }] } }, error: null };
}
function okLine(customId, content) {
  return { custom_id: customId, response: { body: { choices: [{ message: { content }, finish_reason: "stop" }] } }, error: null };
}
function emptyButNotTruncatedLine(customId) {
  // A GENUINE (bad) empty answer: finish_reason:"stop", not "length" -- must be judged as-is, never
  // recovered (requirement: "do not treat 'empty content' alone as the trigger").
  return { custom_id: customId, response: { body: { choices: [{ message: { content: "" }, finish_reason: "stop" }] } }, error: null };
}

// okChatResponse/truncatedChatResponse are RESPONSES to the SYNCHRONOUS recovery call
// (POST https://api.openai.com/v1/chat/completions), not batch-API responses.
function okChatResponse(content) {
  return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
}
function truncatedChatResponse() {
  return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "" }, finish_reason: "length" }], usage: { completion_tokens: 4000, completion_tokens_details: { reasoning_tokens: 4000 } } }) };
}

/**
 * combinedStub({ batchOutputLines, chatQueue }) -> { stub, chatBodies, chatCallCount }
 * Handles BOTH the batch-submission endpoints (files/batches, so runPersonaBatch's OWN awaitBatch()
 * call produces a REAL Map -- not a hand-guessed approximation of its shape) AND the synchronous
 * chat-completions endpoint the recovery path calls. `chatQueue` is consumed in order, one response
 * per POST to /v1/chat/completions; the last entry repeats once exhausted (lets a single fixture
 * cover callChatOpenAI's own internal retries without pre-computing the exact attempt count).
 */
function combinedStub({ batchOutputLines, chatQueue = [] }) {
  const chatBodies = [];
  let chatCall = 0;
  const stub = async (url, init) => {
    const u = String(url);
    if (u === "https://api.openai.com/v1/files") return { ok: true, status: 200, json: async () => ({ id: "file-in-1" }) };
    if (u === "https://api.openai.com/v1/batches") return { ok: true, status: 200, json: async () => ({ id: "batch_abc123" }) };
    if (u === "https://api.openai.com/v1/batches/batch_abc123") return { ok: true, status: 200, json: async () => fakeBatchObject() };
    if (u === "https://api.openai.com/v1/files/file-out-1/content") return { ok: true, status: 200, text: async () => batchOutputLines.map((l) => JSON.stringify(l)).join("\n") };
    if (u === "https://api.openai.com/v1/chat/completions") {
      chatBodies.push(JSON.parse(init.body));
      const resp = chatQueue[Math.min(chatCall, chatQueue.length - 1)];
      chatCall++;
      if (!resp) throw new Error("combinedStub: no chat response configured but chat-completions was called");
      return resp;
    }
    throw new Error("combinedStub: unexpected url " + u);
  };
  return { stub, chatBodies, chatCallCount: () => chatCall };
}

// =====================================================================================
// isReasoningExhaustedBatchResult -- the narrow detection predicate
// =====================================================================================

test("isReasoningExhaustedBatchResult: true for the exact finish_reason=length + empty-content shape awaitBatch() produces", async () => {
  const { isReasoningExhaustedBatchResult } = await freshRunEvals();
  const r = { error: "batch line \"t1\": reasoning model exhausted its token budget on hidden reasoning with no visible output (finish_reason=length) -- an infra failure, not a real (blank) answer", content: null, raw: reasoningExhaustedLine("t1") };
  assert.equal(isReasoningExhaustedBatchResult(r), true);
});

test("isReasoningExhaustedBatchResult: false for a GENUINE empty answer (finish_reason=stop) -- empty content alone is never the trigger", async () => {
  const { isReasoningExhaustedBatchResult } = await freshRunEvals();
  const r = { error: null, content: "", raw: emptyButNotTruncatedLine("t1") };
  assert.equal(isReasoningExhaustedBatchResult(r), false);
});

test("isReasoningExhaustedBatchResult: false for a non-exhaustion per-line API error (model_not_found)", async () => {
  const { isReasoningExhaustedBatchResult } = await freshRunEvals();
  const r = { error: "model_not_found: The model `gpt-nonexistent` does not exist or you do not have access to it.", content: null, raw: modelNotFoundLine("t1", "gpt-nonexistent") };
  assert.equal(isReasoningExhaustedBatchResult(r), false);
});

test("isReasoningExhaustedBatchResult: false for a healthy (non-empty) answer", async () => {
  const { isReasoningExhaustedBatchResult } = await freshRunEvals();
  const r = { error: null, content: "a real answer", raw: okLine("t1", "a real answer") };
  assert.equal(isReasoningExhaustedBatchResult(r), false);
});

test("isReasoningExhaustedBatchResult: false/defensive when the entry or its raw is missing entirely", async () => {
  const { isReasoningExhaustedBatchResult } = await freshRunEvals();
  assert.equal(isReasoningExhaustedBatchResult(undefined), false);
  assert.equal(isReasoningExhaustedBatchResult({ error: "x", content: null }), false); // no `raw`
});

// =====================================================================================
// recoverReasoningExhaustedBatchAnswers -- (a) recovered, reaches the judge
// =====================================================================================

test("(a) a reasoning-exhausted batch result IS recovered via the synchronous path, and the recovered answer reaches the judge (answerById derivation)", async () =>
  withEnv(CLEAR_TIER_ENV, async () => {
    const { runPersonaBatch, recoverReasoningExhaustedBatchAnswers } = await freshRunEvals();
    const tasks = [{ id: "lifecycle-reactivation", agent: "cro", task: "win back a lapsed customer" }];

    // Step 1: a REAL batchedAnswers Map, produced by the REAL runPersonaBatch()/awaitBatch() code --
    // not a hand-guessed approximation of what that code produces.
    const { stub: batchStub } = combinedStub({ batchOutputLines: [reasoningExhaustedLine("lifecycle-reactivation")] });
    const batchedAnswers = await withStubbedFetch(batchStub, () => runPersonaBatch(tasks, { dep: "gpt-5.6-terra", apiKey: "sk-test" }));
    assert.equal(batchedAnswers.get("lifecycle-reactivation").content, null, "sanity: the batch line itself is the exhaustion class before any recovery");
    assert.ok(batchedAnswers.get("lifecycle-reactivation").error);

    // Step 2: recovery, against a FRESH stub (a real run would reuse the OpenAI-batch stub for the
    // batch endpoints too, but only the chat-completions leg matters for this call).
    const { stub: recoveryStub, chatBodies, chatCallCount } = combinedStub({ batchOutputLines: [], chatQueue: [okChatResponse("Send a 15% win-back offer via email and SMS within 48 hours.")] });
    const { calls: errLines } = await (async () => { const calls = []; const original = console.error; console.error = (...a) => calls.push(a.join(" ")); try { await withStubbedFetch(recoveryStub, () => recoverReasoningExhaustedBatchAnswers(tasks, batchedAnswers, { apiKey: "sk-test", dep: "gpt-5.6-terra", fbApiKey: "sk-test-fb", fbDep: "gpt-4o" })); } finally { console.error = original; } return { calls }; })();

    const recovered = batchedAnswers.get("lifecycle-reactivation");
    assert.equal(recovered.error, null, "a successfully recovered task must clear the original infra-failure error");
    assert.equal(recovered.content, "Send a 15% win-back offer via email and SMS within 48 hours.");

    // The exact call shape: ONE synchronous chat-completions call, against the PRIMARY model/key, at
    // the same 4000-token budget chat() itself defaults to.
    assert.equal(chatCallCount(), 1);
    assert.equal(chatBodies[0].model, "gpt-5.6-terra");
    assert.equal(chatBodies[0].max_completion_tokens ?? chatBodies[0].max_tokens, 4000);

    // "reaches the judge": replicate the EXACT answerById derivation main() uses (see the
    // counterfactual pinning that exact line below) -- it must now yield the RECOVERED content, not
    // the "" a lost/errored task would silently feed the judge with.
    const r = batchedAnswers.get("lifecycle-reactivation");
    const answerForJudge = r && !r.error ? r.content : "";
    assert.equal(answerForJudge, "Send a 15% win-back offer via email and SMS within 48 hours.");

    // Requirement 6: log it -- one summary line naming the recovered task id. (personaPromptFor()'s
    // own incidental cache-prefix log line, an existing unrelated side effect shared by every persona
    // prompt build in this file, may also appear here -- filter to THIS function's own summary line.)
    const summaryLines = errLines.filter((l) => l.includes("reasoning-exhaustion recovery"));
    assert.equal(summaryLines.length, 1, "exactly one summary line from recoverReasoningExhaustedBatchAnswers itself");
    assert.match(summaryLines[0], /lifecycle-reactivation/);
    assert.match(summaryLines[0], /recovered via synchronous retry/);
  }));

// =====================================================================================
// (b) a GENUINE empty answer (finish_reason:"stop") is NOT recovered, judged as-is
// =====================================================================================

test("(b) a genuine empty answer (finish_reason=stop) is left completely untouched -- no recovery attempt, no network call, judged as a real (bad) answer", async () =>
  withEnv(CLEAR_TIER_ENV, async () => {
    const { runPersonaBatch, recoverReasoningExhaustedBatchAnswers } = await freshRunEvals();
    const tasks = [{ id: "t1", agent: "cto", task: "diagnose X" }];
    const { stub: batchStub } = combinedStub({ batchOutputLines: [emptyButNotTruncatedLine("t1")] });
    const batchedAnswers = await withStubbedFetch(batchStub, () => runPersonaBatch(tasks, { dep: "gpt-5.6-terra", apiKey: "sk-test" }));
    const before = batchedAnswers.get("t1");
    assert.equal(before.error, null);
    assert.equal(before.content, "", "a genuine finish_reason:stop empty answer is NOT an error -- it is a real (bad) answer");

    const { stub: recoveryStub, chatCallCount } = combinedStub({ batchOutputLines: [], chatQueue: [okChatResponse("should never be used")] });
    await withStubbedFetch(recoveryStub, () => recoverReasoningExhaustedBatchAnswers(tasks, batchedAnswers, { apiKey: "sk-test", dep: "gpt-5.6-terra", fbApiKey: "sk-test-fb", fbDep: "gpt-4o" }));

    assert.equal(chatCallCount(), 0, "must never call chat-completions for a non-exhausted result");
    assert.deepEqual(batchedAnswers.get("t1"), before, "the Map entry must be byte-identical -- untouched");
  }));

// =====================================================================================
// (c) a non-exhaustion batch error (model_not_found) is NOT recovered, still reports as today
// =====================================================================================

test("(c) a non-exhaustion batch error (model_not_found) is left completely untouched -- no recovery attempt, no network call, still reports its existing failure", async () =>
  withEnv(CLEAR_TIER_ENV, async () => {
    const { runPersonaBatch, recoverReasoningExhaustedBatchAnswers } = await freshRunEvals();
    const tasks = [{ id: "t1", agent: "cto", task: "diagnose X" }];
    const { stub: batchStub } = combinedStub({ batchOutputLines: [modelNotFoundLine("t1", "gpt-nonexistent")] });
    const batchedAnswers = await withStubbedFetch(batchStub, () => runPersonaBatch(tasks, { dep: "gpt-nonexistent", apiKey: "sk-test" }));
    const before = batchedAnswers.get("t1");
    assert.ok(before.error);
    assert.equal(before.content, null);

    const { stub: recoveryStub, chatCallCount } = combinedStub({ batchOutputLines: [], chatQueue: [okChatResponse("should never be used")] });
    await withStubbedFetch(recoveryStub, () => recoverReasoningExhaustedBatchAnswers(tasks, batchedAnswers, { apiKey: "sk-test", dep: "gpt-nonexistent", fbApiKey: "sk-test-fb", fbDep: "gpt-4o" }));

    assert.equal(chatCallCount(), 0, "must never call chat-completions for a non-exhaustion error class");
    assert.deepEqual(batchedAnswers.get("t1"), before, "the Map entry must be byte-identical -- untouched, same message main() will report");
  }));

// =====================================================================================
// (d) synchronous recovery ALSO fails -> the ORIGINAL honest infra-failure is preserved
// =====================================================================================

test("(d) when the synchronous recovery attempt ALSO fails (still truncated-empty after its own internal retries), the ORIGINAL infra-failure entry is left exactly as it was -- never masked as success", async () =>
  withEnv(CLEAR_TIER_ENV, async () => {
    const { runPersonaBatch, recoverReasoningExhaustedBatchAnswers } = await freshRunEvals();
    const tasks = [{ id: "t1", agent: "cto", task: "diagnose X" }];
    const { stub: batchStub } = combinedStub({ batchOutputLines: [reasoningExhaustedLine("t1")] });
    const batchedAnswers = await withStubbedFetch(batchStub, () => runPersonaBatch(tasks, { dep: "gpt-5.6-terra", apiKey: "sk-test" }));
    const before = batchedAnswers.get("t1");
    assert.ok(before.error);
    assert.equal(before.content, null);

    // The synchronous recovery's OWN callChatOpenAI retries internally (up to 4 tries) -- feed it an
    // unbroken run of truncated-empty responses so it exhausts and throws .reasoningExhausted, then
    // (since it is not .throttled) recoverReasoningExhaustedBatchAnswers must not attempt the
    // fallback model either, and must leave `before` completely untouched.
    const { stub: recoveryStub, chatCallCount } = combinedStub({ batchOutputLines: [], chatQueue: [truncatedChatResponse()] });
    const { calls: errLines } = await (async () => { const calls = []; const original = console.error; console.error = (...a) => calls.push(a.join(" ")); try { await withStubbedFetch(recoveryStub, () => recoverReasoningExhaustedBatchAnswers(tasks, batchedAnswers, { apiKey: "sk-test", dep: "gpt-5.6-terra", fbApiKey: "sk-test-fb", fbDep: "gpt-4o" })); } finally { console.error = original; } return { calls }; })();

    assert.deepEqual(batchedAnswers.get("t1"), before, "a second failure must NEVER overwrite the original honest infra-failure entry");
    assert.ok(chatCallCount() >= 1, "a recovery attempt must actually have been made");
    const summaryLines = errLines.filter((l) => l.includes("reasoning-exhaustion recovery"));
    assert.equal(summaryLines.length, 1, "exactly one summary line from recoverReasoningExhaustedBatchAnswers itself");
    assert.match(summaryLines[0], /still failed after synchronous retry/);
    assert.match(summaryLines[0], /recovered via synchronous retry: \[none\]/);
  }));

// =====================================================================================
// (e) zero exhausted tasks -> zero extra calls, zero log output (byte-equivalent to before)
// =====================================================================================

test("(e) zero exhausted tasks means zero extra network calls and zero log output -- byte-equivalent to before this fix existed", async () =>
  withEnv(CLEAR_TIER_ENV, async () => {
    const { runPersonaBatch, recoverReasoningExhaustedBatchAnswers } = await freshRunEvals();
    const tasks = [{ id: "t1", agent: "cto", task: "diagnose X" }, { id: "t2", agent: "cfo", task: "reconcile Y" }];
    const { stub: batchStub } = combinedStub({ batchOutputLines: [okLine("t1", "answer 1"), okLine("t2", "answer 2")] });
    const batchedAnswers = await withStubbedFetch(batchStub, () => runPersonaBatch(tasks, { dep: "gpt-5.6-terra", apiKey: "sk-test" }));
    const beforeT1 = batchedAnswers.get("t1");
    const beforeT2 = batchedAnswers.get("t2");

    let fetchCalled = false;
    const guardStub = async () => { fetchCalled = true; throw new Error("must not be called"); };
    const { calls: errLines } = await (async () => { const calls = []; const original = console.error; console.error = (...a) => calls.push(a.join(" ")); try { await withStubbedFetch(guardStub, () => recoverReasoningExhaustedBatchAnswers(tasks, batchedAnswers, { apiKey: "sk-test", dep: "gpt-5.6-terra", fbApiKey: "sk-test-fb", fbDep: "gpt-4o" })); } finally { console.error = original; } return { calls }; })();

    assert.equal(fetchCalled, false, "no exhausted tasks -> zero network calls, not even an attempt");
    assert.equal(errLines.length, 0, "no exhausted tasks -> zero log output");
    assert.deepEqual(batchedAnswers.get("t1"), beforeT1);
    assert.deepEqual(batchedAnswers.get("t2"), beforeT2);
  }));

// =====================================================================================
// Mixed batch: exhausted + healthy + non-exhaustion-error in the SAME run -- only the exhausted
// task is touched; the other two are provably untouched (extra confidence beyond a-e in isolation).
// =====================================================================================

test("mixed batch: only the reasoning-exhausted task is recovered; a healthy answer and a model_not_found error in the SAME batch are both left untouched", async () =>
  withEnv(CLEAR_TIER_ENV, async () => {
    const { runPersonaBatch, recoverReasoningExhaustedBatchAnswers } = await freshRunEvals();
    const tasks = [
      { id: "exhausted", agent: "cto", task: "diagnose X" },
      { id: "healthy", agent: "cfo", task: "reconcile Y" },
      { id: "bad-model", agent: "clo", task: "review Z" },
    ];
    const { stub: batchStub } = combinedStub({
      batchOutputLines: [reasoningExhaustedLine("exhausted"), okLine("healthy", "reconciled cleanly"), modelNotFoundLine("bad-model", "gpt-nonexistent")],
    });
    const batchedAnswers = await withStubbedFetch(batchStub, () => runPersonaBatch(tasks, { dep: "gpt-5.6-terra", apiKey: "sk-test" }));
    const beforeHealthy = batchedAnswers.get("healthy");
    const beforeBadModel = batchedAnswers.get("bad-model");

    const { stub: recoveryStub, chatCallCount, chatBodies } = combinedStub({ batchOutputLines: [], chatQueue: [okChatResponse("the container OOM'd, add a guard")] });
    await withStubbedFetch(recoveryStub, () => recoverReasoningExhaustedBatchAnswers(tasks, batchedAnswers, { apiKey: "sk-test", dep: "gpt-5.6-terra", fbApiKey: "sk-test-fb", fbDep: "gpt-4o" }));

    assert.equal(chatCallCount(), 1, "exactly one recovery call -- only for the exhausted task");
    assert.match(chatBodies[0].messages.at(-1).content, /diagnose X/);
    assert.equal(batchedAnswers.get("exhausted").content, "the container OOM'd, add a guard");
    assert.equal(batchedAnswers.get("exhausted").error, null);
    assert.deepEqual(batchedAnswers.get("healthy"), beforeHealthy);
    assert.deepEqual(batchedAnswers.get("bad-model"), beforeBadModel);
  }));

// =====================================================================================
// Fallback-model-on-throttle mirrors chat()'s own try/catch (bonus: full parity with the
// synchronous path, not just its escalation)
// =====================================================================================

test("recovery falls back to the fallback model on a THROTTLED primary, mirroring chat()'s own fallback-on-throttle exactly", async () =>
  withEnv(CLEAR_TIER_ENV, async () => {
    const { runPersonaBatch, recoverReasoningExhaustedBatchAnswers } = await freshRunEvals();
    const tasks = [{ id: "t1", agent: "cto", task: "diagnose X" }];
    const { stub: batchStub } = combinedStub({ batchOutputLines: [reasoningExhaustedLine("t1")] });
    const batchedAnswers = await withStubbedFetch(batchStub, () => runPersonaBatch(tasks, { dep: "gpt-5.6-terra", apiKey: "sk-test" }));

    // 4 attempts on the primary model all 429 (exhausts callChatOpenAI's own tries=4 loop and
    // throws .throttled), then the fallback model succeeds on its first attempt.
    let call = 0;
    const bodies = [];
    const stub = async (url, init) => {
      const u = String(url);
      if (u !== "https://api.openai.com/v1/chat/completions") throw new Error("unexpected url " + u);
      call++; const body = JSON.parse(init.body); bodies.push(body);
      if (body.model === "gpt-5.6-terra") return { ok: false, status: 429, headers: new Map([["retry-after", "0.01"]]), text: async () => "no capacity" };
      return okChatResponse("recovered via the fallback model");
    };
    await withStubbedFetch(stub, () => recoverReasoningExhaustedBatchAnswers(tasks, batchedAnswers, { apiKey: "sk-test", dep: "gpt-5.6-terra", fbApiKey: "sk-test-fb", fbDep: "gpt-4o" }));

    assert.equal(batchedAnswers.get("t1").content, "recovered via the fallback model");
    assert.equal(batchedAnswers.get("t1").error, null);
    assert.equal(bodies.filter((b) => b.model === "gpt-5.6-terra").length, 4, "primary exhausts its own 4-try budget before falling back, same as chat()");
    assert.equal(bodies.filter((b) => b.model === "gpt-4o").length, 1);
  }));

// =====================================================================================
// Counterfactual: ORDERING IS LOAD-BEARING -- the recovery call must textually precede the
// judge-batch construction in main(), never follow it.
// =====================================================================================

test("counterfactual: recoverReasoningExhaustedBatchAnswers() is called BEFORE answerById/the judge batch are built in main()'s BATCH MODE block", () => {
  const src = readFileSync(new URL("../run-evals.mjs", import.meta.url), "utf8");
  const runPersonaBatchIdx = src.indexOf("batchedAnswers = await runPersonaBatch(tasks,");
  const recoverIdx = src.indexOf("await recoverReasoningExhaustedBatchAnswers(tasks, batchedAnswers,");
  const answerByIdIdx = src.indexOf("const answerById = new Map(tasks.map((t) => {");
  const judgeBatchIdx = src.indexOf("const judgeResults = await runJudgeBatch(tasks, answerById,");
  assert.ok(runPersonaBatchIdx >= 0 && recoverIdx >= 0 && answerByIdIdx >= 0 && judgeBatchIdx >= 0, "all four anchors must exist in the source");
  assert.ok(runPersonaBatchIdx < recoverIdx, "recovery must run AFTER batchedAnswers is populated");
  assert.ok(recoverIdx < answerByIdIdx, "recovery must run BEFORE answerById is derived from batchedAnswers");
  assert.ok(recoverIdx < judgeBatchIdx, "recovery must run BEFORE the judge batch is submitted -- a recovery landing after this point can never reach the judge");
});

test("counterfactual: main()'s answerById derivation is the exact one-line ternary this suite's 'reaches the judge' assertions replicate", () => {
  const src = readFileSync(new URL("../run-evals.mjs", import.meta.url), "utf8");
  assert.match(src, /return \[t\.id, r && !r\.error \? r\.content : ""\];/, "if this line changes, the 'reaches the judge' tests above must be updated to match");
});

test("counterfactual: the recovery function signature stays explicit-parameter (apiKey/dep/fbApiKey/fbDep), never reading module-level KEY/DEP directly -- what keeps this file's whole batch section testable without initModel()", () => {
  const src = readFileSync(new URL("../run-evals.mjs", import.meta.url), "utf8");
  assert.match(src, /export async function recoverReasoningExhaustedBatchAnswers\(tasks, batchedAnswers, \{ apiKey, dep, fbApiKey, fbDep \} = \{\}\)/);
});
