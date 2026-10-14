import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { assessCapabilityProbe, classifyToolBinding, probeFromNativeCatalogReceipt } from "../setup/capability-check.mjs";

const observedAt = "2026-10-13T23:34:00Z";

test("native catalog receipt maps only exact caller and operation evidence", () => {
  const probe = probeFromNativeCatalogReceipt({
    expectedSeat: "cto",
    observedAt,
    toolName: "mcp__codex_apps__otchealth_cto_catalog_probe",
    surfaceToolNames: ["mcp__codex_apps__otchealth_cto_catalog_probe"],
    receipt: {
      isError: false,
      structuredContent: {
        correlation_id: "test-correlation-1",
        result: {
          build_tag: "catalog-probe-2026-07-26.1",
          tool_registry_count: 1046,
          revision: { image_tag: "gateway-test", image_digest: "sha256:abc" },
          known_tools_present: { catalog_probe: true },
          request_context: { caller_agent: "cto", is_connector_surface: true },
        },
      },
    },
  });
  const assessed = assessCapabilityProbe(probe);
  assert.equal(assessed.binding.status, "operation_succeeded");
  assert.equal(assessed.metadata.layers.executor_binding.state, "healthy");
  assert.equal(assessed.metadata.layers.skill_discovery.state, "unknown");
  assert.deepEqual(probe.gatewayCatalogNames, ["catalog_probe", "mcp__codex_apps__otchealth_cto_catalog_probe"]);
  assert.equal(assessed.binding.catalogPresent, true);
  assert.equal(probe.operationEvidenceRef, "receipt:test-correlation-1");
  assert.equal(probe.catalogVersion, null, "fixed build tags do not identify the catalog fingerprint");
  assert.equal(probe.sourceRevision, null, "an image tag is not a verified source revision");
});

function nativeCatalogFixture() {
  return {
    isError: false,
    structuredContent: {
      correlation_id: "native-shape-test-1",
      result: {
        build_tag: "catalog-probe-test",
        tool_registry_count: 1046,
        known_tools_present: { catalog_probe: true },
        request_context: { caller_agent: "cto", is_connector_surface: true,
                           is_m365_static_auth: false },
      },
    },
  };
}

function assessNative(receipt, toolName = "mcp__codex_apps__otchealth_cto_catalog_probe") {
  return assessCapabilityProbe(probeFromNativeCatalogReceipt({
    expectedSeat: "cto", observedAt, toolName, surfaceToolNames: [toolName], receipt,
  }));
}

test("native result-only and error-only receipts cannot prove handler success", () => {
  for (const result of [
    { request_context: { caller_agent: "cto", is_connector_surface: true } },
    { error: "denied", request_context: { caller_agent: "cto", is_connector_surface: true } },
    [],
  ]) {
    const receipt = nativeCatalogFixture();
    receipt.structuredContent.result = result;
    const assessed = assessNative(receipt);
    assert.notEqual(assessed.binding.status, "operation_succeeded");
    assert.notEqual(assessed.binding.handlerBound, true);
    assert.notEqual(assessed.metadata.layers.read_operation.state, "healthy");
    assert.notEqual(assessed.metadata.layers.connector_authentication.state, "healthy");
    assert.equal(assessed.binding.refreshNeeded, true);
  }
});

test("native catalog success requires its exact shape and usable receipt correlation", () => {
  for (const mutate of [
    r => delete r.structuredContent.correlation_id,
    r => { r.structuredContent.correlation_id = "unsafe receipt"; },
    r => { r.structuredContent.result.error = "denied"; },
    r => { r.structuredContent.result.known_tools_present.catalog_probe = false; },
    r => { r.structuredContent.result.tool_registry_count = 0; },
    r => { r.structuredContent.result.tool_registry_count = "1046"; },
    r => { r.structuredContent.result.request_context.is_connector_surface = false; },
    r => { r.isError = true; },
  ]) {
    const receipt = nativeCatalogFixture();
    mutate(receipt);
    const assessed = assessNative(receipt);
    assert.notEqual(assessed.binding.status, "operation_succeeded");
    assert.notEqual(assessed.metadata.layers.read_operation.state, "healthy");
    assert.equal(assessed.binding.refreshNeeded, true);
  }
});

test("a catalog receipt cannot be relabeled as a different operation or seat binding", () => {
  for (const toolName of ["mcp__codex_apps__otchealth_cto_memory_write",
                         "mcp__codex_apps__otchealth_coo_catalog_probe"]) {
    const assessed = assessNative(nativeCatalogFixture(), toolName);
    assert.notEqual(assessed.binding.status, "operation_succeeded");
    assert.notEqual(assessed.binding.handlerBound, true);
    assert.notEqual(assessed.metadata.layers.read_operation.state, "healthy");
  }
});

test("named skill reads survive an incomplete catalog only with exact fresh same-role content", () => {
  const now = new Date().toISOString();
  const ref = "skill://plugins_6abf33c797808191b49fb8059d921caa/swarm/SKILL.md";
  const otherRef = "skill://plugins_6abf33c797808191b49fb8059d921caa/context-continuity/SKILL.md";
  const input = {
    expectedSeat: "developer",
    observedAt: now,
    toolName: "mcp__codex_apps__otchealth_developer_catalog_probe",
    surfaceToolNames: ["mcp__codex_apps__otchealth_developer_catalog_probe"],
    receipt: { ...nativeCatalogFixture(), structuredContent: {
      ...nativeCatalogFixture().structuredContent,
      result: { ...nativeCatalogFixture().structuredContent.result,
        request_context: { ...nativeCatalogFixture().structuredContent.result.request_context, caller_agent: "developer" } },
    } },
    catalogCompleteness: { complete: false, truncated: true, warning_present: true, cursor_present: true, caller_agent: "developer", observed_at: now },
    namedSkillRefs: [ref],
    skillReaderReceipts: [{ resource: ref, content: "# Swarm\nInstructions", observed_at: now, caller_agent: "developer" }],
  };
  const result = probeFromNativeCatalogReceipt(input);
  const assessed = assessCapabilityProbe(result);
  assert.equal(result.skillCatalogStatus, "available");
  assert.deepEqual(result.skillRefs, [ref]);
  assert.equal(result.skillEvidenceComplete, true);
  assert.deepEqual(result.unresolvedSkillRefs, []);
  assert.equal(assessed.metadata.layers.skill_discovery.observed_at, now);
  assert.equal(assessed.metadata.layers.skill_discovery.evidence_ref, null);

  const partial = probeFromNativeCatalogReceipt({ ...input, namedSkillRefs: [ref, otherRef] });
  const partialAssessment = assessCapabilityProbe({ ...partial, childSurfaceObserved: true });
  assert.equal(partial.skillCatalogStatus, "available", "status covers the exact refs present in skillRefs");
  assert.deepEqual(partial.skillRefs, [ref]);
  assert.deepEqual(partial.unresolvedSkillRefs, [otherRef]);
  assert.equal(partialAssessment.probeStatus, "partial", "one successful read cannot complete all requested refs");
});

test("aggregate skill freshness uses the oldest successfully read reference", () => {
  const now = new Date().toISOString();
  const older = new Date(Date.now() - 240_000).toISOString();
  const refs = ["skill://test/older/SKILL.md", "skill://test/newer/SKILL.md"];
  const result = probeFromNativeCatalogReceipt({
    expectedSeat: "cto", observedAt: now,
    toolName: "mcp__codex_apps__otchealth_cto_catalog_probe",
    surfaceToolNames: ["mcp__codex_apps__otchealth_cto_catalog_probe"],
    receipt: nativeCatalogFixture(), namedSkillRefs: refs,
    skillReaderReceipts: refs.map((resource, index) => ({
      resource, content: "# Exact skill read", caller_agent: "cto",
      observed_at: index === 0 ? older : now,
    })),
  });
  assert.deepEqual(result.skillRefs, refs);
  assert.equal(result.skillObservedAt, older);
  assert.equal(assessCapabilityProbe(result).metadata.layers.skill_discovery.observed_at, older);
});

test("empty complete catalog is unavailable, while empty truncated or ambiguous catalogs stay unknown", () => {
  const now = new Date().toISOString();
  for (const [catalogCompleteness, expected] of [
    [{ complete: true, truncated: false, warning_present: false, cursor_present: false, caller_agent: "developer", skills: [], observed_at: now }, "unavailable"],
    [{ complete: false, truncated: true, warning_present: true, cursor_present: true, caller_agent: "developer", observed_at: now }, "unobserved"],
    [{ complete: false, truncated: false, warning_present: false, cursor_present: true, caller_agent: "developer", observed_at: now }, "unobserved"],
    [{ complete: true, truncated: false, warning_present: false, cursor_present: false, caller_agent: "cto", skills: [], observed_at: now }, "unobserved"],
    [{ complete: true, truncated: false, warning_present: false, cursor_present: false, caller_agent: "developer", skills: ["skill://example/skill"], observed_at: now }, "unobserved"],
    [{ complete: true, truncated: true, warning_present: false, cursor_present: false, caller_agent: "developer", skills: [], observed_at: now }, "unobserved"],
    [{ complete: true, truncated: false, warning_present: true, cursor_present: false, caller_agent: "developer", skills: [], observed_at: now }, "unobserved"],
    [{ complete: true, truncated: false, warning_present: false, cursor_present: true, caller_agent: "developer", skills: [], observed_at: now }, "unobserved"],
    [{ complete: true, truncated: false, warning_present: false, cursor_present: false, caller_agent: "developer", skills: [], observed_at: "2020-01-01T00:00:00Z" }, "unobserved"],
    [{ complete: true, truncated: false, warning_present: false, cursor_present: false, caller_agent: "developer", skills: [], observed_at: new Date(Date.now() + 60_000).toISOString() }, "unobserved"],
    [{ complete: true, truncated: false, warning_present: false, cursor_present: false, caller_agent: "developer", observed_at: now }, "unobserved"],
    [undefined, "unobserved"],
  ]) {
    const result = probeFromNativeCatalogReceipt({ expectedSeat: "developer", observedAt: now,
      toolName: "mcp__codex_apps__otchealth_developer_catalog_probe",
      surfaceToolNames: ["mcp__codex_apps__otchealth_developer_catalog_probe"],
      receipt: { ...nativeCatalogFixture(), structuredContent: { ...nativeCatalogFixture().structuredContent,
        result: { ...nativeCatalogFixture().structuredContent.result, request_context: { caller_agent: "developer", is_connector_surface: true, is_m365_static_auth: false } } } },
      catalogCompleteness, namedSkillRefs: ["skill://example/skill/SKILL.md"], skillReaderReceipts: [] });
    assert.equal(result.skillCatalogStatus, expected);
  }
});

test("malformed, wrong-resource, stale, future, and wrong-role skill receipts cannot establish availability", () => {
  const now = new Date().toISOString();
  const ref = "skill://plugins_6abf33c797808191b49fb8059d921caa/swarm/SKILL.md";
  const invalidReceipts = [
    [{ resource: ref, available: true, observed_at: now, caller_agent: "developer" }],
    [{ resource: `${ref}.other`, content: "# Skill", observed_at: now, caller_agent: "developer" }],
    [{ resource: ref, content: "# Skill", observed_at: "2020-01-01T00:00:00Z", caller_agent: "developer" }],
    [{ resource: ref, content: "# Skill", observed_at: new Date(Date.now() + 60_000).toISOString(), caller_agent: "developer" }],
    [{ resource: ref, content: "# Skill", observed_at: now, caller_agent: "cto" }],
    [{ resource: ref, content: " ", observed_at: now, caller_agent: "developer" }],
  ];
  for (const skillReaderReceipts of invalidReceipts) {
    const result = probeFromNativeCatalogReceipt({ expectedSeat: "developer", observedAt: now,
      toolName: "mcp__codex_apps__otchealth_developer_catalog_probe",
      surfaceToolNames: ["mcp__codex_apps__otchealth_developer_catalog_probe"],
      receipt: { ...nativeCatalogFixture(), structuredContent: { ...nativeCatalogFixture().structuredContent,
        result: { ...nativeCatalogFixture().structuredContent.result, request_context: { caller_agent: "developer", is_connector_surface: true, is_m365_static_auth: false } } } },
      catalogCompleteness: { complete: false, truncated: true, warning_present: true, cursor_present: true, caller_agent: "developer", observed_at: now },
      namedSkillRefs: [ref], skillReaderReceipts });
    assert.equal(result.skillCatalogStatus, "unobserved");
    assert.deepEqual(result.skillRefs, []);
  }
});

test("parent tool can be proven while a child-missing tool stays a distinct gap", () => {
  const parent = classifyToolBinding({
    expectedSeat: "cto",
    authenticatedSeat: "cto",
    requiredTool: "mcp__codex_apps__otchealth_cto_catalog_probe",
    surfaceToolNames: ["mcp__codex_apps__otchealth_cto_catalog_probe"],
    gatewayCatalogNames: ["catalog_probe", "developer_wake_lite"],
    operationStatus: "succeeded",
  });
  const child = classifyToolBinding({
    expectedSeat: "developer",
    authenticatedSeat: "developer",
    requiredTool: "developer_wake_lite",
    surfaceToolNames: [],
    gatewayCatalogNames: ["developer_wake_lite"],
    operationStatus: "unobserved",
  });

  assert.equal(parent.status, "operation_succeeded");
  assert.equal(child.status, "missing_tool");
  assert.equal(child.catalogPresent, true, "gateway catalog presence is not a surface binding");
});

test("wrong-role evidence is explicit even when the requested tool is visible", () => {
  const result = classifyToolBinding({
    expectedSeat: "developer",
    authenticatedSeat: "cto",
    requiredTool: "developer_wake_lite",
    surfaceToolNames: ["developer_wake_lite"],
    gatewayCatalogNames: ["developer_wake_lite"],
    operationStatus: "succeeded",
  });
  assert.equal(result.status, "wrong_role");
  assert.equal(result.refreshNeeded, true);
});

test("missing cloud skill catalog does not erase independently observed tool and auth evidence", () => {
  const result = assessCapabilityProbe({
    observedAt,
    expectedSeat: "cto",
    authenticatedSeat: "cto",
    surface: "codex_apps_connector",
    surfaceToolNames: ["mcp__codex_apps__otchealth_cto_catalog_probe"],
    requiredTool: "mcp__codex_apps__otchealth_cto_catalog_probe",
    operationStatus: "succeeded",
    operationEvidenceRef: "receipt:test-own-catalog-probe",
    connectorSurface: true,
    skillCatalogStatus: "unavailable",
    childSurfaceObserved: false,
  });

  assert.equal(result.binding.status, "operation_succeeded");
  assert.equal(result.metadata.layers.skill_discovery.state, "unknown");
  assert.equal(result.metadata.layers.connector_authentication.state, "healthy");
  assert.equal(result.metadata.layers.read_operation.state, "healthy");
  assert.equal(result.metadata.layers.administration.state, "unknown");
});

test("missing actual tool metadata yields a partial probe with unknown capability layers", () => {
  const result = assessCapabilityProbe({
    observedAt,
    expectedSeat: "cto",
    surface: "codex_apps_connector",
    requiredTool: "mcp__codex_apps__otchealth_cto_catalog_probe",
    skillCatalogStatus: "unobserved",
  });

  assert.equal(result.probeStatus, "partial");
  assert.equal(result.binding.status, "unknown");
  assert.equal(result.metadata.actor_ref, "unknown");
  assert.equal(result.metadata.layers.executor_binding.state, "unknown");
  assert.equal(result.metadata.layers.connector_authentication.state, "unknown");
  assert.equal(result.metadata.layers.read_operation.state, "unknown");
});

test("a prior successful probe cannot override missing current handler binding or wrong role", () => {
  const base = {
    observedAt,
    surface: "codex_apps_connector",
    surfaceToolNames: ["catalog_probe"],
    requiredTool: "catalog_probe",
    operationStatus: "succeeded",
    operationEvidenceRef: "receipt:test-probe",
    connectorSurface: true,
    skillCatalogStatus: "available",
    childSurfaceObserved: true,
  };
  const missingHandler = assessCapabilityProbe({
    ...base,
    expectedSeat: "cto",
    authenticatedSeat: "cto",
    boundToolNames: [],
  });
  const wrongRole = assessCapabilityProbe({
    ...base,
    expectedSeat: "cto",
    authenticatedSeat: "developer",
    boundToolNames: ["catalog_probe"],
  });

  for (const result of [missingHandler, wrongRole]) {
    assert.notEqual(result.binding.status, "operation_succeeded");
    assert.equal(result.probeStatus, "partial");
    assert.notEqual(result.metadata.layers.executor_binding.state, "healthy");
    assert.notEqual(result.metadata.layers.authorization.state, "healthy");
    assert.notEqual(result.metadata.layers.read_operation.state, "healthy");
  }
  assert.equal(missingHandler.binding.status, "missing_handler");
  assert.equal(wrongRole.binding.status, "wrong_role");
});

test("CLI main guard works when its script path contains spaces and a hash", () => {
  const dir = mkdtempSync(join(tmpdir(), "capability check # "));
  try {
    const scriptPath = join(dir, "capability check # adapter.mjs");
    copyFileSync(new URL("../setup/capability-check.mjs", import.meta.url), scriptPath);
    const result = spawnSync(process.execPath, [scriptPath, "--registry", join(dir, "missing registry.py"), "--freshness", join(dir, "missing freshness.py")], {
      encoding: "utf8",
      input: "{}\n",
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.probe_status, "partial");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI accepts a native receipt directly and preserves its observation time", () => {
  const dir = mkdtempSync(join(tmpdir(), "native receipt cli "));
  try {
    const registry = join(dir, "registry.py");
    const freshness = join(dir, "freshness.py");
    const receiptPath = join(dir, "receipt.json");
    writeFileSync(registry, `
import json, pathlib, sys
args = sys.argv[1:]
if args[:2] == ["snapshot", "build"]:
    metadata = pathlib.Path(args[args.index("--metadata") + 1])
    output = pathlib.Path(args[args.index("--output") + 1])
    value = json.loads(metadata.read_text())
    output.write_text(json.dumps({**value, "content_sha256": "test-sha"}))
elif args[:2] == ["snapshot", "validate"]:
    output = pathlib.Path(args[args.index("--output") + 1])
    output.write_text(json.dumps({"valid": True, "subject_snapshot_sha256": "test-sha", "schema": "test"}))
`);
    writeFileSync(freshness, `import json\nprint(json.dumps({"freshness_state": "stale", "refresh_needed": True, "reasons": ["expired"], "max_age_seconds": 10}))\n`);
    const observedAt = new Date().toISOString();
    const skillRef = "skill://plugins_6a8f9d0180648191a781fc7d2351bf34/swarm/SKILL.md";
    writeFileSync(receiptPath, JSON.stringify({
      observed_at: observedAt,
      tool_name: "mcp__codex_apps__otchealth_cto_catalog_probe",
      surface_tool_names: ["mcp__codex_apps__otchealth_cto_catalog_probe"],
      receipt: nativeCatalogFixture(),
      catalog_completeness: { complete: false, truncated: true, warning_present: true, cursor_present: true, caller_agent: "cto", observed_at: observedAt },
      named_skill_refs: [skillRef],
      skill_reader_receipts: [{ resource: skillRef, content: "# Swarm\nValid skill content", observed_at: observedAt, caller_agent: "cto" }],
    }));
    const cli = new URL("../setup/capability-check.mjs", import.meta.url);
    const result = spawnSync(process.execPath, [cli.pathname, "--registry", registry, "--freshness", freshness,
      "--native-receipt", receiptPath, "--seat", "cto", "--python", "python3"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.schema, "aios-capability-check-result/v1");
    assert.equal(payload.binding.status, "operation_succeeded");
    assert.equal(payload.snapshot.observed_at, observedAt);
    assert.equal(payload.snapshot.layers.skill_discovery.state, "healthy");
    assert.equal(payload.snapshot.layers.skill_discovery.observed_at, observedAt);
    assert.deepEqual(payload.snapshot.skill_refs, [skillRef]);
    assert.equal(payload.consumer.status, "stale");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
