// Tests for skills/agent-evals/selfrepair.mjs's reasoning-truncation handling (2026-08-30,
// FND-20260830-e927 -- the sibling sweep following critic-pass's own fix for the SAME failure shape,
// FND-20260830-e7c1), and a real, pre-existing dead-code bug found while implementing it.
//
// PART 1 -- defaultRewriteLLM: resolveTier('quality','openai') is gpt-5.6-sol, reasoning-family.
// Live-tested this exact rewrite-a-prompt-hunk shape 4 times at the existing 1200-token budget with no
// truncation, so the budget itself is left unchanged; the fix adds a truncatedEmpty() check so a rare
// exhaustion THROWS a precise, tagged error instead of silently returning "". defaultRewriteLLM's
// maxTokens is read from process.env AT CALL TIME (unlike this file's sibling fixes in
// company-brain.mjs/the signal-radar detectors, whose budgets are module-top-level constants), so a
// plain static import + per-test env mutation works here without a cache-busting dynamic import.
//
// PART 2 -- rewriteCmd()'s abstain_reason override: `if (llmErr && !proposal.abstain_reason)` was DEAD
// CODE -- proposeRewrite()'s own Guard 3 ALWAYS populates a non-empty abstain_reason ("no LLM caller
// injected...") whenever `llm` is not a function, which is exactly the case whenever `llmErr` is set
// (rewriteCmd sets `llm = undefined` on any defaultRewriteLLM() failure). So `!proposal.abstain_reason`
// was always false, and EVERY real failure (missing creds, network error, and now a reasoning-budget
// exhaustion) surfaced the generic "no LLM caller injected; rewrite hunk not synthesized (report-only
// offline path)" instead of the actual, more useful `llmErr.message` -- defeating the very purpose of
// giving defaultRewriteLLM a precise truncation message in Part 1. rewriteCmd() itself is impractical
// to invoke directly here (file reads, argv parsing, process.exit), so this is proven at the level that
// actually matters: (a) a live call to the real, exported proposeRewrite() proves Guard 3's abstain_reason
// is ALWAYS non-empty when `llm` is undefined (the precondition that made the old condition dead), and
// (b) a source-level counterfactual proves the dead condition is gone and the fix is in place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { proposeRewrite, defaultRewriteLLM } from "./selfrepair.mjs";

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
const BASE_ENV = { LLM_PROVIDER: undefined, OPENAI_API_KEY: "sk-test-fake-not-real", SELFREPAIR_REWRITE_MODEL: undefined, SELFREPAIR_REWRITE_MAX_TOKENS: undefined };

test("defaultRewriteLLM: the default budget (1200) is unchanged (live-verified sufficient; not bumped speculatively)", async () =>
  withEnv(BASE_ENV, async () => {
    let sentBody = null;
    await withStubbedFetch(async (url, init) => { sentBody = JSON.parse(init.body); return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "the rewritten hunk" }, finish_reason: "stop" }] }) }; },
      () => defaultRewriteLLM("rewrite this prompt hunk"));
    assert.equal(sentBody.max_completion_tokens, 1200);
  }));

test("defaultRewriteLLM: SELFREPAIR_REWRITE_MAX_TOKENS is honored as an override", async () =>
  withEnv({ ...BASE_ENV, SELFREPAIR_REWRITE_MAX_TOKENS: "2500" }, async () => {
    let sentBody = null;
    await withStubbedFetch(async (url, init) => { sentBody = JSON.parse(init.body); return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "hunk" }, finish_reason: "stop" }] }) }; },
      () => defaultRewriteLLM("rewrite this prompt hunk"));
    assert.equal(sentBody.max_completion_tokens, 2500);
  }));

test("defaultRewriteLLM: TRUNCATED-EMPTY (finish_reason:length, empty content) THROWS a distinct, tagged error instead of returning ''", async () =>
  withEnv(BASE_ENV, async () => {
    const stub = async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "", refusal: null }, finish_reason: "length" }], usage: { completion_tokens: 1200, completion_tokens_details: { reasoning_tokens: 1200 } } }) });
    const checkErr = (e) => {
      assert.match(e.message, /^reasoning model "gpt-5\.6-sol" exhausted its token budget \(1200\) on hidden reasoning with no visible output \(finish_reason=length\)$/);
      assert.equal(e.reasoningExhausted, true);
      return true;
    };
    await assert.rejects(() => withStubbedFetch(stub, () => defaultRewriteLLM("rewrite this prompt hunk")), checkErr);
  }));

test("defaultRewriteLLM: a normal, non-empty response is returned unchanged", async () =>
  withEnv(BASE_ENV, async () => {
    const content = await withStubbedFetch(async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: "a real rewritten hunk" }, finish_reason: "stop" }] }) }),
      () => defaultRewriteLLM("rewrite this prompt hunk"));
    assert.equal(content, "a real rewritten hunk");
  }));

// ---- PART 2: the rewriteCmd() abstain_reason dead-code fix ----

test("PROVES THE BUG WAS REAL: proposeRewrite's Guard 3 ALWAYS sets a non-empty abstain_reason when llm is not a function -- the exact precondition that made `!proposal.abstain_reason` in rewriteCmd() dead code", () => {
  const regression = { prompt_file: "skills/company-brain/brain.mjs", id: "t", task_ids: ["t"], agent: "company-brain" };
  const rubric = ["cites sources"];
  const proposal = proposeRewrite({ regression, basePromptText: "base", headPromptText: "head", failedRubric: rubric }, { llm: undefined });
  assert.equal(proposal.abstained, true);
  assert.ok(proposal.abstain_reason && proposal.abstain_reason.length > 0, "Guard 3 must populate a non-empty abstain_reason");
  assert.match(proposal.abstain_reason, /no LLM caller injected/, "this is the generic reason a REAL llmErr used to be silently replaced by");
});

test("counterfactual: rewriteCmd() no longer guards the abstain_reason override behind the dead `!proposal.abstain_reason` condition", () => {
  const src = readFileSync(new URL("./selfrepair.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /if \(llmErr && !proposal\.abstain_reason\)/, "the dead-code condition (always false, since Guard 3 always pre-populates a reason) must be gone");
  assert.match(src, /if \(llmErr\) proposal\.abstain_reason = `rewrite model call failed: \$\{llmErr\.message\}`;/, "a real error must now ALWAYS override the generic Guard-3 reason with the actual cause");
});
