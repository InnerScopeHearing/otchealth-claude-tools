// Regression tests for the prompt self-repair REWRITE mode (skills/agent-evals/selfrepair.mjs),
// north-star self-improving-loop item #3 (graduate the fix from a blunt REVERT to a gpt-5.1 REWRITE
// PROPOSAL, still DRAFT-ONLY). Guards the SAFETY-relevant invariants of the pure rewrite core:
//   - a regressed task WITH a prompt_file and a failedRubric gets a rewrite proposal (via an INJECTED
//     fake LLM, so no live network); the proposal carries the rewritten hunk and the target file;
//   - the proposal is ALWAYS clearly labeled draft-only (draft_only:true, mode:"rewrite");
//   - it ABSTAINS (no rewritten_hunk, abstained:true, with a reason) when there is no failedRubric,
//     when there is no prompt_file, or when no LLM caller is injected (offline/CI path) - abstention is
//     a first-class safe outcome, never a silent drop;
//   - the injected LLM is fed a MINIMAL, criteria-recovering, intent-preserving instruction that carries
//     the base + head prompt text and the failed rubric (buildRewritePrompt);
//   - reRunFullSuiteCmd returns the EXACT full-suite re-run command the draft path must clear first
//     (design risk #1: a rewrite can overfit one task while breaking another);
//   - the rendered markdown ALWAYS shows the mandatory full-suite gate and never presents an auto-apply
//     path, and renders abstentions explicitly.
// No live network anywhere: the model call is always an injected fake. selfrepair.mjs is required, so
// this suite is inherently fail-on-old-code (it cannot run without the item-#3 exports).
import { test } from "node:test";
import assert from "node:assert";
import { proposeRewrite, buildRewritePrompt, reRunFullSuiteCmd, renderRewriteMarkdown } from "./selfrepair.mjs";

const regression = (over = {}) => ({ prompt_file: "skills/company-brain/brain.mjs", id: "brain-cite-and-abstain", task_ids: ["brain-cite-and-abstain"], agent: "company-brain", ...over });
const rubric = ["Cites the source rooms it drew from", "Abstains when there is no grounding rather than inventing an answer"];

test("proposes a rewrite for a regressed task with a prompt_file and a failed rubric (injected LLM)", () => {
  let seenPrompt = null;
  const fakeLLM = (p) => { seenPrompt = p; return "REWRITTEN HUNK: always cite the source rooms, and abstain if no grounding."; };
  const p = proposeRewrite({ regression: regression(), basePromptText: "BASE prompt text", headPromptText: "HEAD prompt text", failedRubric: rubric }, { llm: fakeLLM });
  assert.equal(p.abstained, false);
  assert.equal(p.prompt_file, "skills/company-brain/brain.mjs");
  assert.equal(p.mode, "rewrite");
  assert.ok(p.rewritten_hunk && p.rewritten_hunk.includes("REWRITTEN HUNK"), "carries the model's rewritten hunk");
  assert.deepEqual(p.failed_rubric, rubric);
  // the injected LLM was actually called with a prompt that carries the base/head text + the rubric.
  assert.ok(seenPrompt.includes("BASE prompt text"));
  assert.ok(seenPrompt.includes("HEAD prompt text"));
  assert.ok(seenPrompt.includes(rubric[0]));
});

test("the rewrite proposal is clearly labeled DRAFT-ONLY", () => {
  const p = proposeRewrite({ regression: regression(), basePromptText: "B", headPromptText: "H", failedRubric: rubric }, { llm: () => "hunk" });
  assert.equal(p.draft_only, true, "draft_only is structural, not cosmetic");
  assert.equal(p.mode, "rewrite");
  // the rationale explicitly frames it as a proposal a human reviews + the mandatory full-suite re-run.
  assert.match(p.rationale, /proposal only|a human reviews/i);
  assert.match(p.rationale, /full agent eval suite|full-suite|no NEW regression/i);
});

test("ABSTAINS when there is no failedRubric (nothing to recover toward), never fabricates a hunk", () => {
  const p = proposeRewrite({ regression: regression(), basePromptText: "B", headPromptText: "H", failedRubric: [] }, { llm: () => "SHOULD NOT BE CALLED" });
  assert.equal(p.abstained, true);
  assert.equal(p.rewritten_hunk, undefined);
  assert.match(p.abstain_reason, /no failedRubric|nothing to recover/i);
  assert.equal(p.draft_only, true);
});

test("ABSTAINS when there is no prompt_file (no target surface for a rewrite)", () => {
  const p = proposeRewrite({ regression: regression({ prompt_file: null, head: null, base: null }), basePromptText: "B", headPromptText: "H", failedRubric: rubric }, { llm: () => "x" });
  assert.equal(p.abstained, true);
  assert.equal(p.rewritten_hunk, undefined);
  assert.match(p.abstain_reason, /no prompt_file/i);
});

test("ABSTAINS (offline/CI path) when no LLM caller is injected, but stays well-formed", () => {
  const p = proposeRewrite({ regression: regression(), basePromptText: "B", headPromptText: "H", failedRubric: rubric });
  assert.equal(p.abstained, true);
  assert.equal(p.rewritten_hunk, undefined);
  assert.match(p.abstain_reason, /no LLM caller/i);
  assert.equal(p.prompt_file, "skills/company-brain/brain.mjs");
  assert.deepEqual(p.failed_rubric, rubric, "still records the criteria a human should recover toward");
});

test("ABSTAINS safely when the injected LLM throws (no crash, no hunk)", () => {
  const p = proposeRewrite({ regression: regression(), basePromptText: "B", headPromptText: "H", failedRubric: rubric }, { llm: () => { throw new Error("boom"); } });
  assert.equal(p.abstained, true);
  assert.equal(p.rewritten_hunk, undefined);
  assert.match(p.abstain_reason, /threw|boom/i);
});

test("ABSTAINS when the injected LLM returns empty/non-string", () => {
  const empty = proposeRewrite({ regression: regression(), basePromptText: "B", headPromptText: "H", failedRubric: rubric }, { llm: () => "   " });
  assert.equal(empty.abstained, true);
  const nonstr = proposeRewrite({ regression: regression(), basePromptText: "B", headPromptText: "H", failedRubric: rubric }, { llm: () => 42 });
  assert.equal(nonstr.abstained, true);
});

test("buildRewritePrompt frames a MINIMAL, criteria-recovering, intent-preserving edit", () => {
  const p = buildRewritePrompt({ prompt_file: "skills/x/SKILL.md", basePromptText: "BASE", headPromptText: "HEAD", rubric });
  assert.match(p, /MINIMAL/);
  assert.match(p, /keeping the improvement the PR intended|KEEPING the improvement/i);
  assert.match(p, /Do not revert the PR wholesale/i);
  assert.match(p, /skills\/x\/SKILL\.md/);
  assert.match(p, /BASE/);
  assert.match(p, /HEAD/);
  assert.match(p, new RegExp(rubric[0].slice(0, 12)));
  // must instruct output-only-hunk (no fences/commentary) so the applied edit is clean.
  assert.match(p, /ONLY the replacement text|no commentary|no code fences/i);
});

test("reRunFullSuiteCmd returns the exact full-suite re-run command (the mandatory pre-draft gate)", () => {
  assert.equal(reRunFullSuiteCmd("cfo"), "node run-evals.mjs --agent cfo --json /tmp/selfrepair-fullsuite.json");
  // no agent -> full fleet suite (still the WHOLE suite, not one task).
  assert.equal(reRunFullSuiteCmd(""), "node run-evals.mjs --json /tmp/selfrepair-fullsuite.json");
  // it is the FULL suite, never a single --task (design risk #1: overfitting one task).
  assert.doesNotMatch(reRunFullSuiteCmd("cto"), /--task/);
  // a hostile agent string is dropped rather than shell-injected.
  assert.doesNotMatch(reRunFullSuiteCmd("cto; rm -rf /"), /rm -rf/);
});

test("rendered rewrite markdown ALWAYS shows the mandatory full-suite gate and never an auto-apply path", () => {
  const p = proposeRewrite({ regression: regression(), basePromptText: "B", headPromptText: "H", failedRubric: rubric }, { llm: () => "the rewritten hunk" });
  const md = renderRewriteMarkdown(p);
  assert.match(md, /draft-only|never auto-applies|never auto-merges/i);
  assert.match(md, /Before any draft PR \(mandatory\)/);
  assert.match(md, /node run-evals\.mjs --agent company-brain --json/);
  assert.match(md, /NO NEW regression/i);
  assert.match(md, /the rewritten hunk/, "shows the proposed hunk for human review");
  // never claims it applied the edit itself.
  assert.match(md, /does NOT edit files|a human reviews/i);
});

test("rendered markdown renders an abstention explicitly (never nothing), still shows the gate", () => {
  const p = proposeRewrite({ regression: regression(), basePromptText: "B", headPromptText: "H", failedRubric: [] }, { llm: () => "x" });
  const md = renderRewriteMarkdown(p);
  assert.match(md, /Abstained/i);
  assert.match(md, /Before any draft PR \(mandatory\)/);
});

test("rendered markdown handles the no-primary-regression case cleanly", () => {
  const md = renderRewriteMarkdown(null);
  assert.match(md, /No primary regression to rewrite/i);
  assert.match(md, /report-only/i);
});
