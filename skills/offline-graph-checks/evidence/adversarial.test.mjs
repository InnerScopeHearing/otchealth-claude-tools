import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { evaluateArtifactReuse, evaluateGraphFixture } from '../code/graph-contract.mjs';

const fixtureSet = JSON.parse(await readFile(new URL('../fixtures/graph-fixtures.json', import.meta.url), 'utf8'));

function assertExpected(actual, expected, label) {
  for (const [field, value] of Object.entries(expected)) {
    assert.deepEqual(actual[field], value, `${label}: ${field}`);
  }
}

test('fixture inventory is deterministic, uniquely named, and synthetic only', () => {
  assert.equal(fixtureSet.fixtureSet, 'typed-graph-and-artifact-reuse-v1');
  assert.equal(fixtureSet.dataClassification, 'invented_ids_only_no_source_text');
  const allIds = [
    ...fixtureSet.graphFixtures.map((item) => item.caseId),
    ...fixtureSet.artifactReuseFixtures.map((item) => item.caseId),
  ];
  assert.equal(new Set(allIds).size, allIds.length, 'case IDs must be unique');
  assert.ok(fixtureSet.graphFixtures.length >= 8, 'all graph adversarial classes remain represented');
  assert.ok(fixtureSet.artifactReuseFixtures.length >= 6, 'all artifact invalidation classes remain represented');
  const serialized = JSON.stringify(fixtureSet);
  for (const forbidden of ['sourceText', 'sourceBody', 'customerName', 'patient', 'credential', 'protectedPersonal']) {
    assert.equal(serialized.includes(forbidden), false, `fixture must not contain ${forbidden}`);
  }
});

for (const fixture of fixtureSet.graphFixtures) {
  test(`graph fixture: ${fixture.caseId}`, () => {
    assertExpected(evaluateGraphFixture(fixture), fixture.expected, fixture.caseId);
  });
}

for (const fixture of fixtureSet.artifactReuseFixtures) {
  test(`artifact reuse fixture: ${fixture.caseId}`, () => {
    assertExpected(evaluateArtifactReuse(fixture.candidate), fixture.expected, fixture.caseId);
  });
}

test('source-less typed edge cannot support a positive path', () => {
  const fixture = structuredClone(fixtureSet.graphFixtures.find((item) => item.caseId === 'supported-three-hop-path'));
  delete fixture.edges[1].sourceId;
  const result = evaluateGraphFixture(fixture);
  assert.equal(result.supported, false);
  assert.equal(result.status, 'abstain');
  assert.ok(result.reasonCodes.includes('missing_link_evidence'));
  assert.deepEqual(result.pathEdgeIds, []);
});

test('scope or identity changes fail closed even when source version is unchanged', () => {
  const base = structuredClone(fixtureSet.artifactReuseFixtures[0].candidate);
  const scopeChanged = structuredClone(base);
  scopeChanged.current.scopeFingerprint = 'scope-new';
  assert.deepEqual(evaluateArtifactReuse(scopeChanged), {
    reusable: false,
    reasonCodes: ['scope_fingerprint_mismatch'],
  });
  const identityChanged = structuredClone(base);
  identityChanged.current.identityFingerprint = 'identity-new';
  assert.deepEqual(evaluateArtifactReuse(identityChanged), {
    reusable: false,
    reasonCodes: ['identity_fingerprint_mismatch'],
  });
});
