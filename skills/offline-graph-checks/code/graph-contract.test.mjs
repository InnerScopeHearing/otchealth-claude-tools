import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateArtifactReuse, evaluateGraphFixture } from './graph-contract.mjs';

const edge = (id, from, to, extras = {}) => ({
  id, from, to, type: 'supports', sourceId: `src-${id}`, sourceVersion: 1, ...extras,
});

test('T13: finds deterministic typed path with link-level evidence and prunes cycles', () => {
  const result = evaluateGraphFixture({
    query: { from: 'X', to: 'Z', maxHops: 3 },
    edges: [edge('xy', 'X', 'Y'), edge('yz', 'Y', 'Z'), edge('yx', 'Y', 'X')],
  });
  assert.equal(result.supported, true);
  assert.equal(result.status, 'supported');
  assert.deepEqual(result.pathEdgeIds, ['xy', 'yz']);
  assert.deepEqual(result.citedEdgeIds, ['xy', 'yz']);
  assert.deepEqual(result.paths[0].links.map((link) => [link.edgeId, link.type, link.sourceId, link.sourceVersion]), [
    ['xy', 'supports', 'src-xy', 1], ['yz', 'supports', 'src-yz', 1],
  ]);
  assert.ok(result.reasonCodes.includes('cycle_pruned'));
  assert.ok(!result.paths[0].nodeIds.includes('X', 1));
});

test('T13: hop bound and unsupported edge evidence fail closed', () => {
  const limited = evaluateGraphFixture({
    query: { from: 'X', to: 'Z', maxHops: 1 },
    edges: [edge('xy', 'X', 'Y'), edge('yz', 'Y', 'Z')],
  });
  assert.equal(limited.supported, false);
  assert.deepEqual(limited.reasonCodes, ['hop_limit_exceeded']);

  const missingEvidence = evaluateGraphFixture({
    query: { from: 'X', to: 'Z' },
    edges: [edge('xy', 'X', 'Y'), { id: 'yz', from: 'Y', to: 'Z', type: 'supports' }],
  });
  assert.equal(missingEvidence.supported, false);
  assert.ok(missingEvidence.reasonCodes.includes('missing_link_evidence'));
  assert.deepEqual(missingEvidence.pathEdgeIds, []);
});

test('T13: stale and deleted source links cannot support a path', () => {
  const result = evaluateGraphFixture({
    query: { from: 'X', to: 'Z', maxHops: 2 },
    edges: [
      edge('xy-old', 'X', 'Y', { sourceVersion: 1, expectedSourceVersion: 2, status: 'stale' }),
      edge('yz-deleted', 'Y', 'Z', { status: 'deleted' }),
    ],
  });
  assert.equal(result.supported, false);
  assert.deepEqual(result.reasonCodes, ['stale_source_version', 'deleted_source']);
  assert.deepEqual(result.pathEdgeIds, []);
});

test('T14: aliases resolve to one entity and allegations are never findings', () => {
  const result = evaluateGraphFixture({
    query: { subject: 'A. Lee', asOf: '2025-03-01' },
    nodes: [
      { id: 'person-1', canonicalName: 'Alex Lee', aliases: [{ value: 'A. Lee', validFrom: '2024-01-01' }] },
      { id: 'person-2', canonicalName: 'Avery Lee', aliases: [{ value: 'A. Lee', validFrom: '2025-01-01' }] },
    ],
    records: [{ id: 'allegation-1', subjectEntityId: 'person-1', predicate: 'misconduct', label: 'allegation', sourceId: 'minutes-1', sourceVersion: 1, validAt: '2025-03-01' }],
  });
  assert.equal(result.supported, false);
  assert.equal(result.status, 'abstain');
  assert.ok(result.reasonCodes.includes('ambiguous_entity_identity'));
  assert.deepEqual(result.citedRecordIds, []);
});

test('T14: opposing dated findings are both retained; allegation is separately labeled', () => {
  const result = evaluateGraphFixture({
    query: { entityId: 'committee-q', asOf: '2025-02-10' },
    nodes: [{ id: 'committee-q', canonicalName: 'Committee Q' }],
    records: [
      { id: 'finding-a', subjectEntityId: 'committee-q', predicate: 'approved', label: 'official finding', sourceId: 'm1', sourceVersion: 2, validAt: '2025-02-10' },
      { id: 'finding-b', subjectEntityId: 'committee-q', predicate: 'deferred', label: 'finding', sourceId: 'm2', sourceVersion: 1, validAt: '2025-02-10', status: 'opposing', opposes: 'finding-a' },
      { id: 'allegation-c', subjectEntityId: 'committee-q', predicate: 'pressure', label: 'allegation', sourceId: 'm3', sourceVersion: 1, validAt: '2025-02-10' },
    ],
  });
  assert.equal(result.status, 'conflicting');
  assert.equal(result.supported, false);
  assert.deepEqual(result.citedRecordIds, ['finding-a', 'finding-b']);
  assert.deepEqual(result.opposingRecordIds, ['finding-b']);
  assert.ok(result.reasonCodes.includes('conflicting_findings'));
  assert.ok(result.reasonCodes.includes('allegation_not_finding'));
  assert.ok(result.claims.every((claim) => claim.validAt === '2025-02-10'));
});

const reuse = (patch = {}) => {
  const snapshot = {
    sourceVersion: 4, sourceHash: 'hash-v4', deleted: false,
    scopeFingerprint: 'scope-a', identityFingerprint: 'identity-a',
    retrievalRelease: 'release-1', embeddingDigest: 'embed-4',
  };
  return {
    artifactType: 'embedding', immutable: true,
    current: { ...snapshot }, cached: { ...snapshot }, ...patch,
  };
};

test('T62: unchanged immutable source artifact can be reused', () => {
  assert.deepEqual(evaluateArtifactReuse(reuse()), { reusable: true, reasonCodes: [] });
});

test('T62: changed/deleted version, scope, identity, or generated answers invalidate reuse', () => {
  const version = reuse({ cached: { ...reuse().current, sourceVersion: 3, sourceHash: 'hash-v3' } });
  assert.ok(evaluateArtifactReuse(version).reasonCodes.includes('stale_source_version'));
  const deleted = reuse({ current: { ...reuse().current, deleted: true } });
  assert.ok(evaluateArtifactReuse(deleted).reasonCodes.includes('deleted_source'));
  const scope = reuse({ cached: { ...reuse().current, scopeFingerprint: 'scope-b' } });
  assert.ok(evaluateArtifactReuse(scope).reasonCodes.includes('scope_fingerprint_mismatch'));
  const identity = reuse({ cached: { ...reuse().current, identityFingerprint: 'identity-b' } });
  assert.ok(evaluateArtifactReuse(identity).reasonCodes.includes('identity_fingerprint_mismatch'));
  const answer = evaluateArtifactReuse({ artifactType: 'generated_answer', generatedAnswer: true, immutable: true });
  assert.deepEqual(answer, { reusable: false, reasonCodes: ['generated_answer_not_reusable'] });
});
