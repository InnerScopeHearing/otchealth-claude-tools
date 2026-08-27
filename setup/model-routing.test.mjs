// Tests for setup/model-routing.mjs, focused on the OPENAI_TIERS lane added 2026-08-27 (the Azure
// Foundry retirement port: critic-pass, agent-evals, focus-group-loop, recall-evals all resolve their
// OpenAI model id through resolveTier(tier, "openai") instead of a hardcoded literal). Pure module, no
// network, no secrets -- every assertion here is a plain function call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TIERS, OPENAI_TIERS, LEGACY_STANDARD, resolveTier, modelFamilyOf, chatBody } from "./model-routing.mjs";

test("resolveTier default (no provider arg) is byte-for-byte unchanged: azure/Foundry tiers", () => {
  assert.equal(resolveTier("standard").deployment, TIERS.standard.deployment);
  assert.equal(resolveTier("quality").deployment, TIERS.quality.deployment);
  assert.equal(resolveTier("cheap").deployment, TIERS.cheap.deployment);
});

test("resolveTier('azure'/'foundry') explicitly matches the implicit default", () => {
  assert.equal(resolveTier("standard", "azure").deployment, TIERS.standard.deployment);
  assert.equal(resolveTier("standard", "foundry").deployment, TIERS.standard.deployment);
});

test("resolveTier(tier, 'openai') resolves against OPENAI_TIERS, not TIERS", () => {
  const std = resolveTier("standard", "openai");
  assert.equal(std.deployment, OPENAI_TIERS.standard.deployment);
  assert.equal(std.deployment, "gpt-4.1");
  const q = resolveTier("quality", "openai");
  assert.equal(q.deployment, OPENAI_TIERS.quality.deployment);
  assert.equal(q.deployment, "gpt-5.1");
});

test("OPENAI_TIERS.cheap is a real OpenAI mini-class model, not the Azure deployment name", () => {
  assert.equal(OPENAI_TIERS.cheap.deployment, "gpt-4o-mini");
  assert.notEqual(OPENAI_TIERS.cheap.deployment, TIERS.cheap.deployment);
});

test("neither quality nor standard OpenAI tier is a mini-class model (the quality-summarization ban)", () => {
  for (const t of ["quality", "standard"]) {
    assert.ok(!/mini/i.test(OPENAI_TIERS[t].deployment), `${t} must not be mini-class: got ${OPENAI_TIERS[t].deployment}`);
  }
});

test("an explicit deployment override still passes through untouched for either provider", () => {
  assert.equal(resolveTier("some-custom-deployment").deployment, "some-custom-deployment");
  assert.equal(resolveTier("some-custom-deployment", "openai").deployment, "some-custom-deployment");
});

test("modelFamilyOf and chatBody are provider-agnostic (OpenAI shares the Azure request-body shape)", () => {
  assert.equal(modelFamilyOf(OPENAI_TIERS.quality.deployment), "reasoning"); // gpt-5.1
  assert.equal(modelFamilyOf(OPENAI_TIERS.standard.deployment), "chat");     // gpt-4.1
  const body = chatBody(OPENAI_TIERS.standard.deployment, { messages: [{ role: "user", content: "hi" }], maxTokens: 10, jsonMode: true });
  assert.equal(body.max_tokens, 10);
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("LEGACY_STANDARD is untouched by the OpenAI lane", () => {
  assert.equal(LEGACY_STANDARD.deployment, "gpt-4o");
});
