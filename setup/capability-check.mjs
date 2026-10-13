#!/usr/bin/env node
/** Build a per-surface CapabilitySnapshotV1 from explicit runtime evidence.
 * Tool names from a gateway catalog are discovery evidence only. A surface binding
 * and operation result must be supplied separately and are never inferred from it.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SNAPSHOT_LAYERS = Object.freeze([
  "client", "skill_discovery", "executor_binding", "tunnel_transport",
  "connector_authentication", "authorization", "read_operation",
  "reversible_write", "administration",
]);

const VALID_SKILL_STATES = new Set(["available", "unavailable", "unobserved"]);
const VALID_OPERATION_STATES = new Set(["succeeded", "failed", "auth_failed", "unobserved"]);

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : null;
}

export function classifyToolBinding({
  expectedSeat,
  authenticatedSeat,
  requiredTool,
  surfaceToolNames,
  boundToolNames,
  gatewayCatalogNames,
  operationStatus = "unobserved",
} = {}) {
  const surfaceNames = stringList(surfaceToolNames);
  const boundNames = stringList(boundToolNames);
  const catalogNames = stringList(gatewayCatalogNames) ?? [];
  const catalogPresent = Boolean(requiredTool && catalogNames.includes(requiredTool));
  let status;

  if (typeof authenticatedSeat !== "string" || !authenticatedSeat) status = "unknown";
  else if (typeof expectedSeat === "string" && expectedSeat && authenticatedSeat !== expectedSeat) status = "wrong_role";
  else if (!surfaceNames) status = "unknown";
  else if (!requiredTool || !surfaceNames.includes(requiredTool)) status = catalogPresent ? "missing_tool" : "discovery_gap";
  else if (boundNames && !boundNames.includes(requiredTool)) status = "missing_handler";
  else if (operationStatus === "succeeded") status = "operation_succeeded";
  else if (operationStatus === "auth_failed") status = "auth_failure";
  else if (operationStatus === "failed") status = "operation_failed";
  else status = "tool_visible_operation_unverified";

  return {
    status,
    expectedSeat: typeof expectedSeat === "string" ? expectedSeat : null,
    authenticatedSeat: typeof authenticatedSeat === "string" ? authenticatedSeat : null,
    requiredTool: typeof requiredTool === "string" ? requiredTool : null,
    catalogPresent,
    surfaceToolPresent: Boolean(requiredTool && surfaceNames?.includes(requiredTool)),
    handlerBound: boundNames ? Boolean(requiredTool && boundNames.includes(requiredTool)) : null,
    refreshNeeded: status !== "operation_succeeded",
  };
}

function layer(state, observedAt, evidenceRef = null, failureClass = null) {
  return { state, observed_at: observedAt, evidence_ref: evidenceRef, failure_class: failureClass };
}

export function assessCapabilityProbe(probe = {}) {
  const observedAt = typeof probe.observedAt === "string" ? probe.observedAt : new Date().toISOString();
  const skillStatus = VALID_SKILL_STATES.has(probe.skillCatalogStatus) ? probe.skillCatalogStatus : "unobserved";
  const operationStatus = VALID_OPERATION_STATES.has(probe.operationStatus) ? probe.operationStatus : "unobserved";
  const surfaceToolNames = stringList(probe.surfaceToolNames);
  const authenticatedSeat = typeof probe.authenticatedSeat === "string" && probe.authenticatedSeat
    ? probe.authenticatedSeat : null;
  const expectedSeat = typeof probe.expectedSeat === "string" && probe.expectedSeat
    ? probe.expectedSeat : null;
  const binding = classifyToolBinding({
    expectedSeat,
    authenticatedSeat,
    requiredTool: probe.requiredTool,
    surfaceToolNames,
    boundToolNames: probe.boundToolNames,
    gatewayCatalogNames: probe.gatewayCatalogNames,
    operationStatus,
  });
  const evidenceRef = typeof probe.operationEvidenceRef === "string" ? probe.operationEvidenceRef : null;
  const surfaceObserved = typeof probe.surface === "string" && probe.surface.length > 0 && surfaceToolNames !== null;
  const identityObserved = authenticatedSeat !== null;
  const roleMatches = identityObserved && (!expectedSeat || authenticatedSeat === expectedSeat);
  const operationSucceeded = binding.status === "operation_succeeded" && roleMatches;
  const connectorSurface = probe.connectorSurface === true;
  const layerEvidence = operationSucceeded ? evidenceRef : null;
  const actorRef = authenticatedSeat ?? "unknown";
  const seat = authenticatedSeat ?? expectedSeat ?? "unknown";
  const toolObservation = surfaceObserved ? "surface_tool_metadata_observed" : null;
  const clientState = operationSucceeded ? "healthy" : (surfaceObserved ? "degraded" : "unknown");
  const executorState = operationSucceeded ? "healthy" : "unknown";
  const authState = identityObserved && connectorSurface ? "healthy" : "unknown";
  const authorizationState = operationSucceeded
    ? "healthy"
    : (operationStatus === "auth_failed" && roleMatches ? "failed" : "unknown");
  const readState = operationSucceeded ? "healthy" : (operationStatus === "failed" ? "failed" : "unknown");

  const metadata = {
    snapshot_id: typeof probe.snapshotId === "string" ? probe.snapshotId : `capability-check-${observedAt.replace(/[^0-9TZ]/g, "")}`,
    observed_at: observedAt,
    actor_ref: actorRef,
    seat,
    surface: typeof probe.surface === "string" && probe.surface ? probe.surface : "unknown",
    host_ref: typeof probe.hostRef === "string" ? probe.hostRef : null,
    project_ref: typeof probe.projectRef === "string" ? probe.projectRef : null,
    environment_ref: typeof probe.environmentRef === "string" ? probe.environmentRef : null,
    source_revision: typeof probe.sourceRevision === "string" ? probe.sourceRevision : null,
    catalog_version: typeof probe.catalogVersion === "string" ? probe.catalogVersion : null,
    skill_refs: stringList(probe.skillRefs) ?? [],
    layers: {
      client: layer(clientState, observedAt, operationSucceeded ? evidenceRef : null, clientState === "degraded" ? "operation_unverified" : null),
      skill_discovery: layer(skillStatus === "available" ? "healthy" : "unknown", observedAt, null,
        skillStatus === "unavailable" ? "skill_catalog_unavailable" : null),
      executor_binding: layer(executorState, observedAt, layerEvidence,
        executorState === "unknown" ? binding.status : null),
      tunnel_transport: layer("unknown", observedAt),
      connector_authentication: layer(authState, observedAt, identityObserved && connectorSurface ? evidenceRef : null),
      authorization: layer(authorizationState, observedAt, operationSucceeded ? evidenceRef : null,
        authorizationState === "failed" ? "auth_rejected" : null),
      read_operation: layer(readState, observedAt, operationSucceeded || readState === "failed" ? evidenceRef : null,
        readState === "failed" ? "operation_failed" : null),
      reversible_write: layer("unknown", observedAt),
      administration: layer("unknown", observedAt),
    },
    probe_receipts: stringList(probe.probeReceiptRefs) ?? [],
  };
  const childSurfaceObserved = probe.childSurfaceObserved === true;

  return {
    metadata,
    binding,
    probeStatus: operationSucceeded && childSurfaceObserved && skillStatus === "available" ? "complete" : "partial",
    observed: { surface: surfaceObserved, identity: identityObserved, skillCatalog: skillStatus, toolMetadata: toolObservation },
  };
}

function option(name, fallback = null) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] ?? fallback : fallback;
}

function readProbe(path) {
  const source = path ? readFileSync(path, "utf8") : readFileSync(0, "utf8");
  return JSON.parse(source);
}

function runPython(python, script, args) {
  const result = spawnSync(python, [script, ...args], { encoding: "utf8", timeout: 20_000 });
  if (result.error || result.status !== 0) {
    throw new Error("python capability command failed");
  }
}

export function main() {
  const registry = option("--registry");
  const freshness = option("--freshness");
  const probePath = option("--probe");
  const python = option("--python", process.env.PYTHON || "python3");
  if (!registry || !freshness) {
    process.stderr.write("usage: capability-check.mjs --registry <registry.py> --freshness <freshness.py> [--probe <json>] [--python <command>]\n");
    return 2;
  }

  let temp = null;
  try {
    const probe = readProbe(probePath);
    const producer = assessCapabilityProbe(probe);
    temp = mkdtempSync(join(tmpdir(), "aios-capability-check-"));
    const metadataPath = join(temp, "metadata.json");
    const snapshotPath = join(temp, "snapshot.json");
    const validationPath = join(temp, "validation.json");
    writeFileSync(metadataPath, `${JSON.stringify(producer.metadata)}\n`, { mode: 0o600, flag: "wx" });
    runPython(python, resolve(registry), ["snapshot", "build", "--metadata", metadataPath, "--output", snapshotPath]);
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    runPython(python, resolve(registry), ["snapshot", "validate", "--input", snapshotPath, "--output", validationPath]);
    const validation = JSON.parse(readFileSync(validationPath, "utf8"));
    if (validation.valid !== true || validation.subject_snapshot_sha256 !== snapshot.content_sha256) {
      throw new Error("snapshot validator did not accept produced snapshot");
    }

    const consumerArgs = [resolve(freshness), snapshotPath, "--seat", snapshot.seat, "--layer", "read_operation"];
    if (snapshot.source_revision) consumerArgs.push("--source", snapshot.source_revision);
    const consumerRun = spawnSync(python, consumerArgs, { encoding: "utf8", timeout: 20_000 });
    if (consumerRun.error || consumerRun.status !== 0) throw new Error("freshness consumer failed");
    const consumer = JSON.parse(consumerRun.stdout.trim().split("\n").at(-1));

    process.stdout.write(`${JSON.stringify({
      schema: "aios-capability-check-result/v1",
      probe_status: producer.probeStatus,
      binding: producer.binding,
      observed: producer.observed,
      producer: { status: "built", snapshot_id: snapshot.snapshot_id, content_sha256: snapshot.content_sha256 },
      validator: { status: "valid", schema: validation.schema, subject_snapshot_sha256: validation.subject_snapshot_sha256 },
      consumer: { status: consumer.freshness_state, refresh_needed: consumer.refresh_needed, reasons: consumer.reasons, max_age_seconds: consumer.max_age_seconds },
      snapshot,
    })}\n`);
    return 0;
  } catch {
    process.stdout.write(`${JSON.stringify({
      schema: "aios-capability-check-result/v1",
      probe_status: "partial",
      binding: { status: "unknown", refreshNeeded: true },
      producer: { status: "unavailable" },
      validator: { status: "unavailable" },
      consumer: { status: "unknown", refresh_needed: true, reasons: ["unknown"] },
    })}\n`);
    return 0;
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
