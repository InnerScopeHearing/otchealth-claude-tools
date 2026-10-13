import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { assessCapabilityProbe, classifyToolBinding } from "../setup/capability-check.mjs";

const observedAt = "2026-10-13T23:34:00Z";

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
