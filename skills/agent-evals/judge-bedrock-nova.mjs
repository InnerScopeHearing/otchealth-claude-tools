// judge-bedrock-nova.mjs — an ALTERNATIVE judge provider for agent-evals: scores a (task, rubric,
// answer) triple using Amazon Bedrock's Nova Lite model via the Converse API, instead of the fleet's
// default OpenAI/Foundry judge (run-evals.mjs's judge()). Opt-in only, via JUDGE_PROVIDER=bedrock-nova
// -- the default judge path in run-evals.mjs is completely unchanged by this file's existence, and this
// module is never imported unless that flag (or --judge-compare) selects it.
//
// WHY A SECOND, INDEPENDENT JUDGE MODEL: run-evals.mjs's own header already flags that the run (agent
// persona) and judge default to the SAME model family (an OpenAI gpt-5.x-class model per
// setup/model-routing.mjs) -- a judge scoring its own model family's output is a real correlated-bias
// risk (shared blind spots, shared stylistic preferences read as "quality"). Nova Lite is a genuinely
// different model family, cheap, fast, and lives in the fleet's own AWS account (900915535335), so it
// also removes a cross-cloud dependency for anyone who wants an OpenAI-outage-independent judge signal.
// --judge-compare (in run-evals.mjs) runs BOTH judges on the same answer so the CTO can decide the swap
// on evidence, not a guess.
//
// SIGV4 + CONVERSE MECHANICS: reuses skills/doc-indexer/bedrock-client.mjs's converseJson() (built
// 2026-08-28 for deep-pass.mjs's own Bedrock port) rather than a fresh SigV4 implementation -- see that
// file's header for the exact double-percent-encoding mechanics (a Bedrock inference-profile id like
// "us.amazon.nova-lite-v1:0" contains a ':' that must be SINGLY percent-encoded on the wire but DOUBLY
// percent-encoded inside the signed canonical request; getting this backwards is a guaranteed
// SignatureDoesNotMatch 403 on the very first call, before any judge logic even runs).
//
// LIVE-VERIFIED 2026-08-29 against the fleet's real AWS account (900915535335, us-east-1), independent
// of and in addition to bedrock-client.mjs's own (mocked) test suite:
//   1. `GET /inference-profiles` on the bedrock (control-plane) host confirmed "us.amazon.nova-lite-v1:0"
//      is a real, ACTIVE, SYSTEM_DEFINED inference profile in this account (alongside nova-micro,
//      nova-pro, nova-premier, and a newer "nova-2-lite" generation -- NOT used as the default here;
//      swapping to it is a deliberate future decision, not a silent upgrade).
//   2. A real `POST /model/us.amazon.nova-lite-v1%3A0/converse` call (plain text, no tools) returned
//      HTTP 200 with the expected wire path (single-encoded colon) and a real "OK" completion.
//   3. A real FORCED TOOL-USE Converse call (the exact shape converseJson()/this file uses) against the
//      same model returned HTTP 200 with a correctly-populated `toolUse.input` block matching the
//      requested JSON schema -- confirming Nova Lite supports forced tool-choice via Converse (the same
//      JSON-mode strategy converseJson() already uses for Claude on Bedrock), so this file is a thin,
//      low-risk wrapper around an already-proven code path, not a new provider integration.
//
// Model id is env-overridable (BEDROCK_NOVA_JUDGE_MODEL) for a future rotation without a code change.

import { converseJson } from "../doc-indexer/bedrock-client.mjs";

export const BEDROCK_NOVA_JUDGE_MODEL = process.env.BEDROCK_NOVA_JUDGE_MODEL || "us.amazon.nova-lite-v1:0";
const BEDROCK_JUDGE_REGION = process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-east-1";

const JUDGE_TOOL_NAME = "record_verdict";
const JUDGE_TOOL_SCHEMA = {
  type: "object",
  properties: {
    met: {
      type: "array",
      items: { type: "boolean" },
      description: "one boolean per rubric criterion, IN THE SAME ORDER as given, true if the answer satisfies that criterion",
    },
    notes: { type: "string", description: "one line explaining the verdict" },
  },
  required: ["met", "notes"],
};

/**
 * judgeBedrockNova(task, rubric, answer, opts?) -> Promise<{met, score, notes}>
 * SAME return shape as run-evals.mjs's default judge() (met: bool[] aligned to rubric, score: fraction
 * met, notes: one line) so it is a drop-in for the JUDGE_PROVIDER dispatch and for --judge-compare's
 * side-by-side comparison. opts: { model, region } override the module defaults (mainly for tests).
 *
 * FAIL-SAFE vs FAIL-LOUD, deliberately split exactly like the default judge and like this toolkit's
 * other 2026-08 "fail loud" ports (reflect.mjs, critic-pass/run.mjs): a CONTENT failure (the model
 * answered but produced no usable tool call -- converseJson() returns `obj: null` for this, never a
 * throw) degrades to a defensive all-false verdict with a distinguishing note, exactly matching the
 * default judge's own "judge parse failed" degradation. A TRANSPORT failure (no AWS credentials, a
 * non-retryable HTTP status, or retries exhausted on a retryable one) PROPAGATES as a throw --
 * converseJson() already makes this distinction (see its own header); this function does not collapse
 * it back into a fake low score. A judge that silently could not run must never look identical to a
 * judge that ran and found the answer wanting.
 */
export async function judgeBedrockNova(task, rubric, answer, { model = BEDROCK_NOVA_JUDGE_MODEL, region = BEDROCK_JUDGE_REGION } = {}) {
  const system = "You are a strict eval judge. Given a task, a rubric (list of criteria), and a candidate answer, decide for EACH criterion whether the answer satisfies it.";
  const user = `TASK:\n${task}\n\nRUBRIC:\n${rubric.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\nANSWER:\n${answer}`;
  const { obj } = await converseJson({
    modelId: model,
    region,
    system,
    userContent: [{ text: user }],
    toolName: JUDGE_TOOL_NAME,
    toolSchema: JUDGE_TOOL_SCHEMA,
    maxTokens: 400,
    temperature: 0,
  });
  const j = obj || { met: [], notes: "judge parse failed (Nova produced no usable tool call)" };
  const met = (Array.isArray(j.met) ? j.met : []).slice(0, rubric.length);
  while (met.length < rubric.length) met.push(false);
  const score = rubric.length ? met.filter(Boolean).length / rubric.length : 0;
  return { met, score, notes: typeof j.notes === "string" ? j.notes : "" };
}

export default { judgeBedrockNova, BEDROCK_NOVA_JUDGE_MODEL };
