/**
 * Source-free typed graph and artifact-reuse contract.
 * This module is deliberately deterministic and has no I/O or provider bindings.
 */

const text = (v) => typeof v === 'string' && v.trim().length > 0;
const number = (v) => Number.isFinite(v) && v >= 0;
const validVersion = (v) => number(v) || text(v);
const unique = (values) => [...new Set(values)];

function activeAt(item, at) {
  if (!at) return true;
  if (item.validFrom && item.validFrom > at) return false;
  if (item.validTo && item.validTo < at) return false;
  return true;
}

function edgeIsSupported(edge, at) {
  const source = edge?.source && typeof edge.source === 'object' ? edge.source : {};
  const sourceVersion = edge?.sourceVersion ?? source.version;
  return text(edge?.id) && text(edge?.from) && text(edge?.to) &&
    text(edge?.type ?? edge?.relation) && text(edge?.sourceId ?? edge?.source?.id) &&
    validVersion(sourceVersion) && activeAt(edge, at) &&
    edge.deleted !== true && edge.status !== 'deleted' && edge.status !== 'stale' &&
    source.deleted !== true && source.status !== 'deleted' && source.status !== 'stale' &&
    (edge.expectedSourceVersion == null || sourceVersion === edge.expectedSourceVersion) &&
    edge.from !== edge.to;
}

function edgeInvalidReasons(edge) {
  const reasons = [];
  const source = edge?.source && typeof edge.source === 'object' ? edge.source : {};
  const sourceVersion = edge?.sourceVersion ?? source.version;
  if (edge?.deleted === true || edge?.status === 'deleted' || source.deleted === true || source.status === 'deleted') reasons.push('deleted_source');
  if (edge?.status === 'stale' || source.status === 'stale' ||
      (edge?.expectedSourceVersion != null && sourceVersion !== edge.expectedSourceVersion)) reasons.push('stale_source_version');
  return reasons;
}

function recordEvidenceReasons(record) {
  const reasons = [];
  const source = record?.source && typeof record.source === 'object' ? record.source : {};
  const sourceId = record?.sourceId ?? (typeof record?.source === 'string' ? record.source : source.id);
  const sourceVersion = record?.sourceVersion ?? source.version;
  if (!text(record?.id) || !text(record?.predicate) || !text(sourceId) || !validVersion(sourceVersion)) {
    reasons.push('missing_record_evidence');
  }
  if (record?.deleted === true || record?.status === 'deleted' || source.deleted === true || source.status === 'deleted') {
    reasons.push('deleted_source');
  }
  if (record?.status === 'stale' || source.status === 'stale' ||
      (record?.expectedSourceVersion != null && sourceVersion !== record.expectedSourceVersion)) {
    reasons.push('stale_source_version');
  }
  return unique(reasons);
}

function normalizeLink(edge) {
  return {
    edgeId: edge.id,
    type: edge.type ?? edge.relation,
    sourceId: edge.sourceId ?? edge.source.id,
    sourceVersion: edge.sourceVersion ?? edge.source.version,
    evidenceId: edge.evidenceId ?? edge.evidence?.id ?? null,
  };
}

function searchPaths(query, edges) {
  const maxHops = Number.isInteger(query.maxHops) && query.maxHops >= 0
    ? Math.min(query.maxHops, 32) : 4;
  const at = query.asOf ?? null;
  const supported = edges.filter((e) => edgeIsSupported(e, at));
  const byFrom = new Map();
  for (const edge of supported) {
    const group = byFrom.get(edge.from) ?? [];
    group.push(edge);
    byFrom.set(edge.from, group);
  }
  for (const group of byFrom.values()) group.sort((a, b) => a.id.localeCompare(b.id));

  const paths = [];
  const cited = [];
  const reasons = [];
  const queue = [{ node: query.from, nodes: [query.from], links: [] }];
  let hitLimit = false;
  let cyclePruned = false;
  while (queue.length) {
    const current = queue.shift();
    if (current.node === query.to) {
      paths.push({ nodeIds: current.nodes, links: current.links });
      cited.push(...current.links.map((link) => link.edgeId));
      continue;
    }
    const outgoing = byFrom.get(current.node) ?? [];
    if (current.links.length >= maxHops) {
      if (outgoing.length) hitLimit = true;
      continue;
    }
    for (const edge of outgoing) {
      if (current.nodes.includes(edge.to)) {
        cyclePruned = true;
        continue;
      }
      queue.push({
        node: edge.to,
        nodes: [...current.nodes, edge.to],
        links: [...current.links, normalizeLink(edge)],
      });
    }
  }
  if (paths.length) {
    if (cyclePruned) reasons.push('cycle_pruned');
    if (hitLimit) reasons.push('hop_limit_exceeded');
    return { supported: true, status: 'supported', paths, pathEdgeIds: unique(paths.flatMap((path) => path.links.map((link) => link.edgeId))), citedEdgeIds: unique(cited), citedRecordIds: [], opposingRecordIds: [], reasonCodes: reasons };
  }
  const partial = [];
  // Return only valid, source-grounded edges from a bounded reachable prefix.
  const seen = new Set([query.from]);
  const frontier = [{ node: query.from, depth: 0 }];
  while (frontier.length) {
    const { node, depth } = frontier.shift();
    if (depth >= maxHops) continue;
    for (const edge of byFrom.get(node) ?? []) {
      partial.push(edge.id);
      if (!seen.has(edge.to)) {
        seen.add(edge.to);
        frontier.push({ node: edge.to, depth: depth + 1 });
      }
    }
  }
  const invalidReasons = unique(edges.flatMap(edgeInvalidReasons));
  if (invalidReasons.length) return { supported: false, status: 'abstain', paths: [], pathEdgeIds: [], citedEdgeIds: [], citedRecordIds: [], opposingRecordIds: [], reasonCodes: invalidReasons };
  if (hitLimit || (maxHops === 0 && (byFrom.get(query.from) ?? []).length)) reasons.push('hop_limit_exceeded');
  if (cyclePruned) reasons.push('cycle_pruned');
  if (!hitLimit) reasons.push('missing_link');
  if (edges.some((e) => e?.from && !edgeIsSupported(e, at))) reasons.push('missing_link_evidence');
  return { supported: false, status: 'abstain', paths: [], pathEdgeIds: [], citedEdgeIds: unique(partial), citedRecordIds: [], opposingRecordIds: [], reasonCodes: unique(reasons) };
}

function resolveEntity(subject, entities, at, queryAliases = []) {
  if (!text(subject)) return { entityId: null, ambiguous: false };
  const matches = new Set();
  for (const entity of entities) {
    if (entity.id === subject || entity.canonicalName === subject) matches.add(entity.id);
    for (const alias of entity.aliases ?? []) {
      const value = typeof alias === 'string' ? alias : alias.value;
      if (value === subject && (typeof alias === 'string' || activeAt(alias, at))) matches.add(entity.id);
    }
  }
  for (const alias of queryAliases) {
    const value = typeof alias === 'string' ? alias : alias.value;
    if (value === subject && (typeof alias === 'string' || activeAt(alias, at))) {
      for (const entity of entities) {
        if (entity.id === alias.entityId || entity.id === alias.targetEntityId) matches.add(entity.id);
      }
    }
  }
  return { entityId: matches.size === 1 ? [...matches][0] : null, ambiguous: matches.size > 1 };
}

function evaluateClaims(fixture) {
  const query = fixture.query ?? {};
  const at = query.asOf ?? query.validAt ?? null;
  const querySubject = query.subject ?? query.entityId ?? query.entity;
  const resolved = resolveEntity(querySubject, fixture.nodes ?? fixture.entities ?? [], at, query.aliases ?? []);
  const reasons = [];
  if (resolved.ambiguous) {
    return { supported: false, status: 'abstain', reasonCodes: ['ambiguous_entity_identity'], resolvedEntityId: null, claims: [], opposingEvidence: [], citedRecordIds: [], opposingRecordIds: [] };
  }
  const records = (fixture.records ?? []).filter((record) => {
    if (!activeAt(record, at)) return false;
    if (record.validAt && at && record.validAt !== at) return false;
    if (resolved.entityId) return record.subjectEntityId === resolved.entityId || record.entityId === resolved.entityId || record.subject === resolved.entityId;
    return record.subject === querySubject || record.entityId === querySubject;
  }).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const claims = records.map((record) => ({
    recordId: record.id,
    predicate: record.predicate,
    label: record.label ?? 'unknown',
    sourceId: record.sourceId ?? record.source ?? null,
    sourceVersion: record.sourceVersion ?? null,
    validAt: record.validAt ?? record.validFrom ?? null,
    status: record.status ?? 'unknown',
    opposes: record.opposes ?? null,
  }));
  const evidenceReasonsByRecord = new Map(records.map((record) => [record.id, recordEvidenceReasons(record)]));
  const evidenceReasons = unique([...evidenceReasonsByRecord.values()].flat());
  reasons.push(...evidenceReasons);
  const findings = claims.filter((claim) =>
    (claim.label === 'official finding' || claim.label === 'finding') &&
    (evidenceReasonsByRecord.get(claim.recordId) ?? []).length === 0);
  if (claims.some((claim) => claim.label === 'allegation')) reasons.push('allegation_not_finding');
  const predicates = unique(findings.map((claim) => claim.predicate).filter(text));
  const opposing = findings.filter((claim) =>
    claim.status === 'opposed' || claim.status === 'opposing' ||
    claim.opposes);
  const conflicting = predicates.length > 1 || opposing.length > 0 || findings.some((claim) => claim.status === 'adverse');
  if (conflicting) reasons.push('conflicting_findings');
  return {
    supported: !conflicting && findings.length > 0,
    status: conflicting ? 'conflicting' : findings.length ? 'supported' : 'abstain',
    reasonCodes: reasons,
    resolvedEntityId: resolved.entityId,
    claims,
    opposingEvidence: conflicting ? findings : [],
    citedRecordIds: findings.map((claim) => claim.recordId),
    opposingRecordIds: opposing.map((claim) => claim.recordId),
  };
}

/** Evaluate a synthetic graph fixture. Never asserts a path without typed, versioned source evidence. */
export function evaluateGraphFixture(fixture) {
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) {
    return { supported: false, status: 'abstain', reasonCodes: ['invalid_fixture'], paths: [], pathEdgeIds: [], citedEdgeIds: [], citedRecordIds: [], opposingRecordIds: [] };
  }
  const query = fixture.query ?? {};
  if (text(query.from) && text(query.to)) return searchPaths(query, Array.isArray(fixture.edges) ? fixture.edges : []);
  if (text(query.subject ?? query.entityId ?? query.entity)) return evaluateClaims(fixture);
  return { supported: false, status: 'abstain', reasonCodes: ['invalid_fixture'], paths: [], pathEdgeIds: [], citedEdgeIds: [], citedRecordIds: [], opposingRecordIds: [] };
}

/** Reuse is permitted only for immutable source artifacts under identical version, identity and scope. */
export function evaluateArtifactReuse(candidate) {
  const reasons = [];
  if (!candidate || typeof candidate !== 'object') return { reusable: false, reasonCodes: ['invalid_candidate'] };
  const current = candidate.current ?? candidate;
  const cached = candidate.cached ?? candidate;
  const declaredKinds = unique([candidate.kind, candidate.artifactType].filter(text));
  const kind = candidate.artifactType ?? candidate.kind;
  if (declaredKinds.some((value) => value === 'generated_answer' || value === 'answer') ||
      candidate.generatedAnswer === true) {
    return { reusable: false, reasonCodes: ['generated_answer_not_reusable'] };
  }
  if (declaredKinds.length > 1) reasons.push('conflicting_artifact_type');
  if (!['document', 'embedding', 'retrieval'].includes(kind) || candidate.immutable !== true) {
    reasons.push('artifact_not_immutable_source');
  }
  if (typeof current.deleted !== 'boolean' || typeof cached.deleted !== 'boolean') reasons.push('deleted_state_unverified');
  if (current.deleted === true || cached.deleted === true) reasons.push('deleted_source');
  if (candidate.stale === true || current.stale === true || cached.stale === true ||
      (validVersion(current.sourceVersion) && validVersion(cached.sourceVersion) &&
       current.sourceVersion !== cached.sourceVersion) ||
      (text(current.sourceHash) && text(cached.sourceHash) && current.sourceHash !== cached.sourceHash)) {
    reasons.push('stale_source_version');
  }
  if (!text(current.identityFingerprint) || current.identityFingerprint !== cached.identityFingerprint) {
    reasons.push('identity_fingerprint_mismatch');
  }
  if (!text(current.scopeFingerprint) || current.scopeFingerprint !== cached.scopeFingerprint) {
    reasons.push('scope_fingerprint_mismatch');
  }
  if (!validVersion(current.sourceVersion) || !validVersion(cached.sourceVersion)) reasons.push('missing_source_version');
  if (!text(current.sourceHash) || !text(cached.sourceHash)) reasons.push('missing_source_hash');
  for (const field of ['retrievalRelease', 'embeddingDigest']) {
    const currentPresent = text(current[field]);
    const cachedPresent = text(cached[field]);
    if (currentPresent !== cachedPresent) reasons.push('artifact_fingerprint_incomplete');
    else if (currentPresent && current[field] !== cached[field]) reasons.push('artifact_fingerprint_mismatch');
  }
  if (kind === 'embedding' && (!text(current.embeddingDigest) || !text(cached.embeddingDigest))) reasons.push('embedding_fingerprint_missing');
  if (kind === 'retrieval' && (!text(current.retrievalRelease) || !text(cached.retrievalRelease))) reasons.push('retrieval_release_missing');
  return { reusable: reasons.length === 0, reasonCodes: unique(reasons) };
}
