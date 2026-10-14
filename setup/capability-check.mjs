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

/** Convert one native Codex catalog-probe response into the adapter's narrow input.
 * Callable surface metadata must be supplied independently; gateway names only
 * populate discovery evidence and never create a binding.
 */
export function probeFromNativeCatalogReceipt({
  expectedSeat,
  observedAt,
  toolName,
  surfaceToolNames,
  receipt,
  catalogCompleteness,
  namedSkillRefs,
  skillReaderReceipts,
} = {}) {
  const result = receipt?.structuredContent?.result;
  const context = result?.request_context;
  const correlationId = receipt?.structuredContent?.correlation_id;
  const correlation = typeof correlationId === "string" && /^[A-Za-z0-9-]{1,128}$/.test(correlationId)
    ? `receipt:${correlationId}` : null;
  const caller = typeof context?.caller_agent === "string"
    && /^[a-z][a-z0-9-]{0,31}$/.test(context.caller_agent) ? context.caller_agent : null;
  const callerNamespace = caller === "cfo" ? "cfo_brain" : caller;
  const exactCatalogTool = toolName === "catalog_probe"
    || (callerNamespace !== null && toolName === `mcp__codex_apps__otchealth_${callerNamespace}_catalog_probe`);
  // A non-error wrapper or caller-shaped object is not a successful operation.
  // Require the actual catalog receipt shape and bind it only to that caller's
  // catalog operation; never promote missing/error-only evidence to healthy.
  const hasResult = Boolean(receipt?.isError === false && result && !Array.isArray(result)
    && typeof result === "object" && (result.error === undefined || result.error === null)
    && typeof result.build_tag === "string" && result.build_tag.startsWith("catalog-probe-")
    && Number.isSafeInteger(result.tool_registry_count) && result.tool_registry_count > 0
    && result.known_tools_present?.catalog_probe === true && caller !== null
    && context.is_connector_surface === true && context.is_m365_static_auth !== true
    && correlation !== null && exactCatalogTool);
  const gatewayCatalogNames = hasResult
    ? Object.entries(result.known_tools_present).filter(([, present]) => present === true).map(([name]) => name)
    : [];
  // Native gateway catalogs use the operation alias, while the client surface
  // exposes its namespaced MCP tool. Keep both names as discovery-only metadata.
  if (typeof toolName === "string" && toolName.endsWith("_catalog_probe") && gatewayCatalogNames.includes("catalog_probe")) {
    gatewayCatalogNames.push(toolName);
  }

  // Listing completeness and named reads are independent evidence. Empty but
  // explicitly complete listings establish absence; truncated/malformed ones
  // remain unknown. A named read needs exact resource, nonempty content, role,
  // and an original timestamp no more than five minutes old (never future).
  const freshTimestamp = (value) => {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return false;
    const ageMs = Date.now() - Date.parse(value);
    return ageMs >= 0 && ageMs <= 300_000;
  };
  const completeEmptyListing = catalogCompleteness && Array.isArray(catalogCompleteness.skills)
    && catalogCompleteness.skills.length === 0 && catalogCompleteness.complete === true
    && catalogCompleteness.truncated === false && catalogCompleteness.warning_present === false
    && catalogCompleteness.cursor_present === false && catalogCompleteness.caller_agent === caller
    && caller === expectedSeat && freshTimestamp(catalogCompleteness.observed_at);
  const requestedRefs = Array.isArray(namedSkillRefs)
    ? [...new Set(namedSkillRefs.filter((ref) => typeof ref === "string" && ref.startsWith("skill://")))] : [];
  const validSkillReceipts = requestedRefs.flatMap((resource) => {
    const match = Array.isArray(skillReaderReceipts) ? skillReaderReceipts.find((candidate) =>
      candidate && typeof candidate === "object" && !Array.isArray(candidate)
      && candidate.resource === resource && typeof candidate.content === "string" && candidate.content.trim().length > 0
      && candidate.caller_agent === caller && caller === expectedSeat && freshTimestamp(candidate.observed_at)) : null;
    return match ? [{ resource, observed_at: match.observed_at,
      evidence_ref: typeof match.correlation_id === "string" && /^[A-Za-z0-9-]{1,128}$/.test(match.correlation_id)
        ? `receipt:${match.correlation_id}` : null }] : [];
  });
  const skillCatalogStatus = validSkillReceipts.length > 0 ? "available"
    : (completeEmptyListing ? "unavailable" : "unobserved");
  const skillObservedAt = validSkillReceipts.length
    // A newer read must not extend the freshness of an older required reference.
    ? validSkillReceipts.map((item) => item.observed_at)
      .sort((left, right) => Date.parse(left) - Date.parse(right)).at(0)
    : (completeEmptyListing ? catalogCompleteness.observed_at : observedAt);

  return {
    expectedSeat,
    authenticatedSeat: caller,
    observedAt,
    surface: "codex_apps_connector",
    surfaceToolNames,
    requiredTool: toolName,
    // The exact successful call itself demonstrates that this named handler ran.
    boundToolNames: hasResult ? [toolName] : null,
    gatewayCatalogNames,
    operationStatus: hasResult ? "succeeded" : (receipt?.isError === true ? "failed" : "unobserved"),
    operationEvidenceRef: correlation,
    connectorSurface: hasResult,
    skillCatalogStatus,
    skillRefs: validSkillReceipts.map((item) => item.resource),
    unresolvedSkillRefs: requestedRefs.filter((resource) => !validSkillReceipts.some((item) => item.resource === resource)),
    skillEvidenceComplete: requestedRefs.length > 0 && validSkillReceipts.length === requestedRefs.length,
    skillObservedAt,
    skillReceiptRefs: validSkillReceipts.map((item) => item.evidence_ref).filter(Boolean),
    // The probe build tag is fixed, and its image tag is not a verified source SHA.
    catalogVersion: null,
    sourceRevision: null,
    probeReceiptRefs: correlation ? [correlation] : [],
  };
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
      skill_discovery: layer(skillStatus === "available" ? "healthy" : "unknown",
        typeof probe.skillObservedAt === "string" ? probe.skillObservedAt : observedAt,
        null,
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
    probe_receipts: [...(stringList(probe.probeReceiptRefs) ?? []), ...(stringList(probe.skillReceiptRefs) ?? [])],
  };
  const childSurfaceObserved = probe.childSurfaceObserved === true;
  const skillEvidenceComplete = probe.skillEvidenceComplete !== false;

  return {
    metadata,
    binding,
    probeStatus: operationSucceeded && childSurfaceObserved && skillStatus === "available" && skillEvidenceComplete ? "complete" : "partial",
    observed: { surface: surfaceObserved, identity: identityObserved, skillCatalog: skillStatus, toolMetadata: toolObservation,
      skillEvidenceComplete, unresolvedSkillRefs: stringList(probe.unresolvedSkillRefs) ?? [] },
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

function readNativeProbe(path, expectedSeat) {
  const input = readProbe(path);
  if (!input || typeof input !== "object" || Array.isArray(input)
    || typeof input.observed_at !== "string" || !input.observed_at
    || !Number.isFinite(Date.parse(input.observed_at))
    || typeof input.tool_name !== "string" || !input.tool_name
    || !Array.isArray(input.surface_tool_names)
    || input.surface_tool_names.length === 0
    || !input.surface_tool_names.every((name) => typeof name === "string")
    || !input.receipt || typeof input.receipt !== "object" || Array.isArray(input.receipt)
    || typeof expectedSeat !== "string" || !expectedSeat) {
    throw new Error("invalid native catalog receipt input");
  }
  return probeFromNativeCatalogReceipt({
    expectedSeat,
    observedAt: input.observed_at,
    toolName: input.tool_name,
    surfaceToolNames: input.surface_tool_names,
    receipt: input.receipt,
    catalogCompleteness: input.catalog_completeness,
    namedSkillRefs: input.named_skill_refs,
    skillReaderReceipts: input.skill_reader_receipts,
  });
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
  const nativeReceiptPath = option("--native-receipt");
  const seat = option("--seat");
  const python = option("--python", process.env.PYTHON || "python3");
  if (!registry || !freshness) {
    process.stderr.write("usage: capability-check.mjs --registry <registry.py> --freshness <freshness.py> [--probe <json> | --native-receipt <json> --seat <seat>] [--python <command>]\n");
    return 2;
  }

  let temp = null;
  try {
    if (probePath && nativeReceiptPath) throw new Error("choose one probe input");
    const probe = nativeReceiptPath ? readNativeProbe(nativeReceiptPath, seat) : readProbe(probePath);
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
