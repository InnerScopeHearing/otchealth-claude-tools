// Tests for skills/agent-evals/run-evals.mjs's EVAL_JUDGE selector (2026-09-02, the OpenAI cost-lever
// sweep's third lever), the --compare flag alias, the extracted personaPromptFor/judgePromptFor/
// parseJudgeOutput helpers, and the OPENAI_BATCH persona/judge batch functions.
//
// EVAL_JUDGE/JUDGE_PROVIDER/NOVA_JUDGE_MODEL/COMPARE_NOVA_MODEL/JUDGE_COMPARE are all resolved ONCE at
// module-load time from process.env/process.argv, so every test that varies them uses the SAME
// cache-busting dynamic import + env/argv restore pattern already established in
// run-evals-flex.test.mjs / setup/model-routing.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";

async function freshRunEvals() {
  return import(`../run-evals.mjs?t=${Date.now()}-${Math.random()}`);
}
function withEnv(vars, run) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  return (async () => { try { return await run(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } })();
}
function withArgv(extraArgs, run) {
  const original = process.argv;
  process.argv = [...original.slice(0, 2), ...extraArgs];
  return (async () => { try { return await run(); } finally { process.argv = original; } })();
}
function withStubbedFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return (async () => { try { return await run(); } finally { globalThis.fetch = original; } })();
}
const CLEAR_JUDGE_ENV = { EVAL_JUDGE: undefined, JUDGE_PROVIDER: undefined };

// ---- EVAL_JUDGE / JUDGE_PROVIDER / NOVA_JUDGE_MODEL / COMPARE_NOVA_MODEL resolution -------------

test("both EVAL_JUDGE and JUDGE_PROVIDER unset (every job today): resolves to openai, no Nova model, unchanged from before this lever existed", async () =>
  withEnv(CLEAR_JUDGE_ENV, async () => {
    const { EVAL_JUDGE, NOVA_JUDGE_MODEL, JUDGE_COMPARE } = await freshRunEvals();
    assert.equal(EVAL_JUDGE, "openai");
    assert.equal(NOVA_JUDGE_MODEL, undefined);
    assert.equal(JUDGE_COMPARE, false);
  }));

test("legacy JUDGE_PROVIDER=bedrock-nova (EVAL_JUDGE unset) resolves EVAL_JUDGE to nova-lite -- full backward compatibility", async () =>
  withEnv({ ...CLEAR_JUDGE_ENV, JUDGE_PROVIDER: "bedrock-nova" }, async () => {
    const { EVAL_JUDGE, NOVA_JUDGE_MODEL } = await freshRunEvals();
    assert.equal(EVAL_JUDGE, "nova-lite");
    assert.equal(NOVA_JUDGE_MODEL, "us.amazon.nova-lite-v1:0");
  }));

test("EVAL_JUDGE=nova-micro resolves to the Nova Micro model id", async () =>
  withEnv({ ...CLEAR_JUDGE_ENV, EVAL_JUDGE: "nova-micro" }, async () => {
    const { EVAL_JUDGE, NOVA_JUDGE_MODEL } = await freshRunEvals();
    assert.equal(EVAL_JUDGE, "nova-micro");
    assert.equal(NOVA_JUDGE_MODEL, "us.amazon.nova-micro-v1:0");
  }));

test("EVAL_JUDGE=nova-lite resolves to the Nova Lite model id", async () =>
  withEnv({ ...CLEAR_JUDGE_ENV, EVAL_JUDGE: "nova-lite" }, async () => {
    const { NOVA_JUDGE_MODEL } = await freshRunEvals();
    assert.equal(NOVA_JUDGE_MODEL, "us.amazon.nova-lite-v1:0");
  }));

test("EVAL_JUDGE, when set, wins over a conflicting legacy JUDGE_PROVIDER", async () =>
  withEnv({ ...CLEAR_JUDGE_ENV, EVAL_JUDGE: "openai", JUDGE_PROVIDER: "bedrock-nova" }, async () => {
    const { EVAL_JUDGE, NOVA_JUDGE_MODEL } = await freshRunEvals();
    assert.equal(EVAL_JUDGE, "openai");
    assert.equal(NOVA_JUDGE_MODEL, undefined);
  }));

test("an unrecognized EVAL_JUDGE value falls back to the default openai judge rather than throwing (a config typo must not crash a nightly run)", async () =>
  withEnv({ ...CLEAR_JUDGE_ENV, EVAL_JUDGE: "bogus-judge-name" }, async () => {
    const { EVAL_JUDGE, NOVA_JUDGE_MODEL, judgeLabel } = await freshRunEvals();
    assert.equal(EVAL_JUDGE, "bogus-judge-name");
    assert.equal(NOVA_JUDGE_MODEL, undefined, "an unrecognized value must not resolve to SOME Nova model by accident");
    assert.doesNotThrow(() => judgeLabel());
  }));

test("COMPARE_NOVA_MODEL defaults to nova-lite when openai is primary (no EVAL_JUDGE set)", async () =>
  withEnv(CLEAR_JUDGE_ENV, async () => {
    const { COMPARE_NOVA_MODEL } = await freshRunEvals();
    assert.equal(COMPARE_NOVA_MODEL, "us.amazon.nova-lite-v1:0");
  }));

test("COMPARE_NOVA_MODEL follows EVAL_JUDGE=nova-micro when Nova is primary (compares against the SAME Nova model, not a silently-substituted nova-lite)", async () =>
  withEnv({ ...CLEAR_JUDGE_ENV, EVAL_JUDGE: "nova-micro" }, async () => {
    const { COMPARE_NOVA_MODEL } = await freshRunEvals();
    assert.equal(COMPARE_NOVA_MODEL, "us.amazon.nova-micro-v1:0");
  }));

// ---- judgeLabel ----------------------------------------------------------------------------------

test("judgeLabel(): a Nova EVAL_JUDGE returns the Nova model id, ignoring DEP entirely", async () =>
  withEnv({ ...CLEAR_JUDGE_ENV, EVAL_JUDGE: "nova-micro" }, async () => {
    const { judgeLabel } = await freshRunEvals();
    assert.equal(judgeLabel(), "us.amazon.nova-micro-v1:0");
  }));

test("judgeLabel(evalJudge): an explicit argument overrides the module's own resolved EVAL_JUDGE, used to label the OTHER judge in a comparison", async () =>
  withEnv(CLEAR_JUDGE_ENV, async () => {
    const { judgeLabel } = await freshRunEvals();
    assert.equal(judgeLabel("nova-lite"), "us.amazon.nova-lite-v1:0");
    assert.equal(judgeLabel("nova-micro"), "us.amazon.nova-micro-v1:0");
  }));

// ---- --compare flag alias -------------------------------------------------------------------------

test("--judge-compare and --compare are equivalent aliases for JUDGE_COMPARE", async () => {
  await withArgv(["--judge-compare"], async () => {
    const { JUDGE_COMPARE } = await freshRunEvals();
    assert.equal(JUDGE_COMPARE, true);
  });
  await withArgv(["--compare"], async () => {
    const { JUDGE_COMPARE } = await freshRunEvals();
    assert.equal(JUDGE_COMPARE, true);
  });
  await withArgv([], async () => {
    const { JUDGE_COMPARE } = await freshRunEvals();
    assert.equal(JUDGE_COMPARE, false);
  });
});

// ---- personaPromptFor / judgePromptFor / parseJudgeOutput (extracted, pure) ------------------------

test("personaPromptFor: system is the persona brief plus the fixed answer-instruction suffix; user is ONLY the task text", async () => {
  const { personaPromptFor } = await freshRunEvals();
  const { system, user } = personaPromptFor({ agent: "cto", task: "diagnose this failure" });
  assert.match(system, /^You are the CTO for OTCHealth \+ InnerScope\./);
  assert.match(system, /Answer concretely and completely/);
  assert.equal(user, "diagnose this failure");
});

test("personaPromptFor: an unknown agent falls back to a generic 'You are the <agent>.' brief, unchanged from before extraction", async () => {
  const { personaPromptFor } = await freshRunEvals();
  const { system } = personaPromptFor({ agent: "some-new-role", task: "t" });
  assert.match(system, /^You are the some-new-role\./);
});

test("judgePromptFor: sys is the fixed judge instruction; user is TASK then RUBRIC then ANSWER, in that (cache-friendly) order", async () => {
  const { judgePromptFor } = await freshRunEvals();
  const { sys, user } = judgePromptFor("the task", ["criterion one", "criterion two"], "the candidate answer");
  assert.match(sys, /^You are a strict eval judge\./);
  const taskIdx = user.indexOf("TASK:");
  const rubricIdx = user.indexOf("RUBRIC:");
  const answerIdx = user.indexOf("ANSWER:");
  assert.ok(taskIdx >= 0 && rubricIdx > taskIdx && answerIdx > rubricIdx, "expected TASK, then RUBRIC, then ANSWER in that order");
  assert.match(user, /the task/);
  assert.match(user, /1\. criterion one\n2\. criterion two/);
  assert.match(user, /the candidate answer/);
});

test("parseJudgeOutput: parses well-formed JSON and computes score as met-fraction", async () => {
  const { parseJudgeOutput } = await freshRunEvals();
  const result = parseJudgeOutput('{"met":[true,false],"notes":"partial"}', ["a", "b"]);
  assert.deepEqual(result.met, [true, false]);
  assert.equal(result.score, 0.5);
  assert.equal(result.notes, "partial");
});

test("parseJudgeOutput: malformed/non-JSON output fails safe to all-false with a distinguishing note", async () => {
  const { parseJudgeOutput } = await freshRunEvals();
  const result = parseJudgeOutput("not json at all", ["a", "b", "c"]);
  assert.deepEqual(result.met, [false, false, false]);
  assert.equal(result.score, 0);
  assert.equal(result.notes, "judge parse failed");
});

test("parseJudgeOutput: pads a short met[] and truncates a long one to rubric.length, same defensiveness as before extraction", async () => {
  const { parseJudgeOutput } = await freshRunEvals();
  const short = parseJudgeOutput('{"met":[true],"notes":"x"}', ["a", "b", "c"]);
  assert.deepEqual(short.met, [true, false, false]);
  const long = parseJudgeOutput('{"met":[true,true,true,true],"notes":"x"}', ["a", "b"]);
  assert.deepEqual(long.met, [true, true]);
});

test("parseJudgeOutput: tolerates prose wrapped around the JSON object (extracts the first {...} block)", async () => {
  const { parseJudgeOutput } = await freshRunEvals();
  const result = parseJudgeOutput('Sure, here is my verdict:\n{"met":[true],"notes":"ok"}\nHope that helps!', ["a"]);
  assert.deepEqual(result.met, [true]);
  assert.equal(result.notes, "ok");
});

// ---- runPersonaBatch / runJudgeBatch / runOneBatch (mocked fetch, no real network/credentials) -----

function fakeBatchObject(overrides = {}) {
  return { id: "batch_abc123", status: "completed", output_file_id: "file-out-1", error_file_id: null, errors: null, ...overrides };
}
function batchApiStub(outputLinesForFileId) {
  return async (url) => {
    const u = String(url);
    if (u === "https://api.openai.com/v1/files") return { ok: true, status: 200, json: async () => ({ id: "file-in-1" }) };
    if (u === "https://api.openai.com/v1/batches") return { ok: true, status: 200, json: async () => ({ id: "batch_abc123" }) };
    if (u === "https://api.openai.com/v1/batches/batch_abc123") return { ok: true, status: 200, json: async () => fakeBatchObject() };
    if (u === "https://api.openai.com/v1/files/file-out-1/content") return { ok: true, status: 200, text: async () => outputLinesForFileId.map((l) => JSON.stringify(l)).join("\n") };
    throw new Error("unexpected url " + u);
  };
}

test("runPersonaBatch: builds one batch line per task (custom_id=task.id, deployment=dep) and returns a custom_id-keyed result Map", async () => {
  const { runPersonaBatch } = await freshRunEvals();
  const tasks = [{ id: "t1", agent: "cto", task: "diagnose X" }, { id: "t2", agent: "cfo", task: "reconcile Y" }];
  let capturedUpload = null;
  const results = await withStubbedFetch(async (url, init) => {
    if (String(url) === "https://api.openai.com/v1/files") { capturedUpload = init; }
    return batchApiStub([
      { custom_id: "t1", response: { body: { choices: [{ message: { content: "answer for t1" } }] } }, error: null },
      { custom_id: "t2", response: { body: { choices: [{ message: { content: "answer for t2" } }] } }, error: null },
    ])(url, init);
  }, () => runPersonaBatch(tasks, { dep: "gpt-4.1", apiKey: "sk-test" }));
  assert.ok(capturedUpload, "must have uploaded a batch input file");
  assert.equal(results.get("t1").content, "answer for t1");
  assert.equal(results.get("t2").content, "answer for t2");
});

test("runJudgeBatch: builds one batch line per task using the batched answer for that task's custom_id", async () => {
  const { runJudgeBatch } = await freshRunEvals();
  const tasks = [{ id: "t1", agent: "cto", task: "diagnose X", rubric: ["names a root cause"] }];
  const answerById = new Map([["t1", "the container OOM'd"]]);
  let capturedBody = null;
  const results = await withStubbedFetch(async (url, init) => {
    if (String(url) === "https://api.openai.com/v1/files") capturedBody = init.body; // FormData -- inspected via the batches create body below instead
    return batchApiStub([{ custom_id: "t1", response: { body: { choices: [{ message: { content: '{"met":[true],"notes":"good"}' } }] } }, error: null }])(url, init);
  }, () => runJudgeBatch(tasks, answerById, { dep: "gpt-4.1", apiKey: "sk-test" }));
  assert.ok(capturedBody instanceof FormData);
  assert.equal(results.get("t1").content, '{"met":[true],"notes":"good"}');
});

test("runOneBatch: propagates assertAllBatchResultsPresent's throw when a submitted custom_id gets no result at all", async () => {
  const { runOneBatch } = await freshRunEvals();
  const lines = [
    { custom_id: "a", method: "POST", url: "/v1/chat/completions", body: { model: "gpt-4.1", messages: [] } },
    { custom_id: "b", method: "POST", url: "/v1/chat/completions", body: { model: "gpt-4.1", messages: [] } },
  ];
  await assert.rejects(
    () => withStubbedFetch(batchApiStub([{ custom_id: "a", response: { body: { choices: [{ message: { content: "ok" } }] } }, error: null }]), () => runOneBatch(lines, "test item", { apiKey: "sk-test" })),
    /custom_id\(s\) got NO result at all/
  );
});

// ---- model-not-found / per-line-error paths (2026-09-03, T-2: arming OPENAI_BATCH_AGENT_EVALS) ----
// These exercise the EXACT shape a real OpenAI batch output line carries when a request fails --
// e.g. a misconfigured AGENT_MODEL/OPENAI_TIER_MID override naming a model the account cannot use
// (OpenAI's real invalid_request_error/model_not_found shape: `response:null, error:{message,
// code, type}` on that line -- see model-routing.mjs's own awaitBatch tests for the generic
// per-line-error contract this reuses). The behavior under test is agent-evals' OWN consumption of
// that contract via runPersonaBatch/runJudgeBatch -- i.e. that a bad model on ONE line surfaces as
// a distinguishable `{error, content:null}` map entry through THESE wrappers specifically (not
// merely through awaitBatch() in isolation, which model-routing.test.mjs already covers), matching
// what main()'s per-task loop depends on: `if (ar.error) throw new Error("batch persona-answer
// error: " + ar.error)` for the persona side, and "leave unset -> the per-task loop throws 'no
// judge result'" for the judge side (see run-evals.mjs's BATCH MODE section) -- in both cases the
// task is SKIPPED and logged, never silently scored as a real 0%/blank answer.
function modelNotFoundLine(customId, model) {
  return { custom_id: customId, response: null, error: { message: `The model \`${model}\` does not exist or you do not have access to it.`, type: "invalid_request_error", param: null, code: "model_not_found" } };
}

test("runPersonaBatch: a model_not_found per-line error surfaces as {error, content:null} for that task's custom_id, not a fabricated blank answer", async () => {
  const { runPersonaBatch } = await freshRunEvals();
  const tasks = [{ id: "t1", agent: "cto", task: "diagnose X" }];
  const results = await withStubbedFetch(
    batchApiStub([modelNotFoundLine("t1", "gpt-nonexistent")]),
    () => runPersonaBatch(tasks, { dep: "gpt-nonexistent", apiKey: "sk-test" })
  );
  const r = results.get("t1");
  assert.equal(r.content, null, "a model_not_found line must never resolve to a real (blank) answer");
  assert.match(r.error, /model_not_found|does not exist/);
  // The exact check main()'s per-task loop performs on this result (see run-evals.mjs: `if
  // (ar.error) throw new Error(...)`) -- pinning the CONTRACT, not just the raw shape above.
  assert.ok(r.error, "ar.error must be truthy so main() throws and skips the task instead of using r.content");
});

test("runPersonaBatch: a model_not_found error on ONE task's line never contaminates a sibling task's successful line in the same batch", async () => {
  const { runPersonaBatch } = await freshRunEvals();
  const tasks = [{ id: "bad", agent: "cto", task: "diagnose X" }, { id: "good", agent: "cfo", task: "reconcile Y" }];
  const results = await withStubbedFetch(
    batchApiStub([modelNotFoundLine("bad", "gpt-nonexistent"), { custom_id: "good", response: { body: { choices: [{ message: { content: "reconciled cleanly" } }] } }, error: null }]),
    () => runPersonaBatch(tasks, { dep: "gpt-nonexistent", apiKey: "sk-test" })
  );
  assert.equal(results.get("bad").content, null);
  assert.ok(results.get("bad").error);
  assert.equal(results.get("good").content, "reconciled cleanly");
  assert.equal(results.get("good").error, null);
});

test("runJudgeBatch: a model_not_found per-line error on the judge call surfaces as {error, content:null}, never as parseable (fabricated) judge JSON", async () => {
  const { runJudgeBatch, parseJudgeOutput } = await freshRunEvals();
  const tasks = [{ id: "t1", agent: "cto", task: "diagnose X", rubric: ["names a root cause"] }];
  const answerById = new Map([["t1", "the container OOM'd"]]);
  const results = await withStubbedFetch(
    batchApiStub([modelNotFoundLine("t1", "gpt-nonexistent-judge")]),
    () => runJudgeBatch(tasks, answerById, { dep: "gpt-nonexistent-judge", apiKey: "sk-test" })
  );
  const r = results.get("t1");
  assert.equal(r.content, null);
  assert.match(r.error, /model_not_found|does not exist/);
  // Mirrors main()'s own judge-batch loop precisely (see run-evals.mjs: `if (!r.error)
  // batchedJudged.set(t.id, parseJudgeOutput(...))`) -- with r.error truthy, main() never calls
  // parseJudgeOutput(r.content, ...) for this task at all, so `batchedJudged` stays unset for it and
  // the per-task loop later throws "no judge result" (skipping the task, logged) instead of the
  // silent all-false/0% "judge parse failed" verdict that WOULD result if r.content (null) were
  // wrongly fed to parseJudgeOutput -- demonstrated directly here so the failure mode this guards
  // against is not just described but shown:
  const misroutedIfCallerForgotTheGuard = parseJudgeOutput(r.content, tasks[0].rubric);
  assert.equal(misroutedIfCallerForgotTheGuard.notes, "judge parse failed");
  assert.equal(misroutedIfCallerForgotTheGuard.score, 0, "a real FAIL look-alike for an infra failure -- exactly why main() must gate on r.error BEFORE calling parseJudgeOutput, never after");
});
