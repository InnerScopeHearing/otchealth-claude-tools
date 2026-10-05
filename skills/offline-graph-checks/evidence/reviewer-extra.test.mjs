import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateArtifactReuse, evaluateGraphFixture } from '../code/graph-contract.mjs';

// Independent, bounded, invented-ID-only counterexamples. Production files stay frozen.
const edge = (id, from, to, patch = {}) => ({
  id, from, to, type: 'supports', sourceId: `source-${id}`, sourceVersion: 1, ...patch,
});
const finding = (patch = {}) => ({
  id: 'finding-review', subjectEntityId: 'entity-review', predicate: 'approved',
  label: 'finding', sourceId: 'source-review', sourceVersion: 1,
  validAt: '2026-01-01', ...patch,
});
const claims = (records, query = {}) => ({
  query: { entityId: 'entity-review', asOf: '2026-01-01', ...query },
  nodes: [{ id: 'entity-review', canonicalName: 'Invented Review Entity' }], records,
});
const reuse = (patch = {}) => {
  const snapshot = {
    sourceVersion: 1, sourceHash: 'invented-hash-1', deleted: false,
    scopeFingerprint: 'invented-scope', identityFingerprint: 'invented-identity',
    retrievalRelease: 'invented-release-1', embeddingDigest: 'invented-embedding-1',
  };
  return { artifactType: 'embedding', immutable: true,
    current: { ...snapshot }, cached: { ...snapshot }, ...patch };
};

test('review control: cycle-only graph cannot manufacture a target path', () => {
  const result = evaluateGraphFixture({ query: { from: 'A', to: 'C', maxHops: 3 },
    edges: [edge('ab', 'A', 'B'), edge('ba', 'B', 'A')] });
  assert.equal(result.supported, false);
  assert.ok(result.reasonCodes.includes('cycle_pruned'));
  assert.deepEqual(result.pathEdgeIds, []);
});

test('review control: zero maxHops cannot traverse a supported edge', () => {
  const result = evaluateGraphFixture({ query: { from: 'A', to: 'B', maxHops: 0 },
    edges: [edge('ab', 'A', 'B')] });
  assert.equal(result.supported, false);
  assert.ok(result.reasonCodes.includes('hop_limit_exceeded'));
});

test('review control: missing edge type or version cannot support a path', () => {
  for (const field of ['type', 'sourceVersion']) {
    const link = edge('ab', 'A', 'B');
    delete link[field];
    const result = evaluateGraphFixture({ query: { from: 'A', to: 'B' }, edges: [link] });
    assert.equal(result.supported, false, `missing ${field}`);
  }
});

test('review: finding without source identity cannot be positive evidence', () => {
  const record = finding();
  delete record.sourceId;
  assert.equal(evaluateGraphFixture(claims([record])).supported, false);
});

test('review: finding without source version cannot be positive evidence', () => {
  const record = finding();
  delete record.sourceVersion;
  assert.equal(evaluateGraphFixture(claims([record])).supported, false);
});

test('review: deleted finding cannot support a current claim', () => {
  assert.equal(evaluateGraphFixture(claims([finding({ deleted: true, status: 'deleted' })])).supported, false);
});

test('review: stale finding version cannot support a current claim', () => {
  assert.equal(evaluateGraphFixture(claims([finding({ status: 'stale', expectedSourceVersion: 2 })])).supported, false);
});

test('review: status-only opposing finding remains adverse and prevents positive support', () => {
  const result = evaluateGraphFixture(claims([finding({ status: 'opposing' })]));
  assert.equal(result.supported, false);
  assert.equal(result.status, 'conflicting');
  assert.deepEqual(result.opposingRecordIds, ['finding-review']);
});

test('review: future query-local alias cannot resolve identity before validFrom', () => {
  const fixture = claims([finding()], {
    entityId: 'future-review-alias',
    aliases: [{ value: 'future-review-alias', entityId: 'entity-review', validFrom: '2027-01-01' }],
  });
  const result = evaluateGraphFixture(fixture);
  assert.equal(result.supported, false);
  assert.equal(result.resolvedEntityId, null);
});

test('review: nested deleted source cannot support a graph link', () => {
  const link = edge('ab', 'A', 'B');
  delete link.sourceId;
  delete link.sourceVersion;
  link.source = { id: 'source-ab', version: 1, deleted: true };
  assert.equal(evaluateGraphFixture({ query: { from: 'A', to: 'B' }, edges: [link] }).supported, false);
});

test('review: generated_answer artifactType is never reusable even with conflicting kind', () => {
  assert.equal(evaluateArtifactReuse(reuse({ kind: 'document', artifactType: 'generated_answer' })).reusable, false);
});

test('review: current snapshot stale marker prevents reuse', () => {
  const candidate = reuse();
  candidate.current.stale = true;
  assert.equal(evaluateArtifactReuse(candidate).reusable, false);
});

test('review: incomplete source fingerprint cannot establish exact unchanged reuse', () => {
  const candidate = reuse();
  delete candidate.cached.sourceHash;
  assert.equal(evaluateArtifactReuse(candidate).reusable, false);
});

test('review: incomplete embedding fingerprint cannot establish exact embedding reuse', () => {
  const candidate = reuse();
  delete candidate.cached.embeddingDigest;
  assert.equal(evaluateArtifactReuse(candidate).reusable, false);
});

test('review: invalid source version cannot establish unchanged source reuse', () => {
  const candidate = reuse();
  candidate.current.sourceVersion = '';
  candidate.cached.sourceVersion = '';
  assert.equal(evaluateArtifactReuse(candidate).reusable, false);
});

test('review control: mutable artifacts remain non-reusable', () => {
  assert.equal(evaluateArtifactReuse(reuse({ immutable: false })).reusable, false);
});
