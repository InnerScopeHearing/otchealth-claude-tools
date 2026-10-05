import test from 'node:test';
import assert from 'node:assert/strict';
import { selectEntitlement, validateFollowUp } from './entitlement.mjs';

// All values below are deliberately synthetic contract fixtures. The dates and
// promise strings test interval mechanics only; they are not policy assertions.
const NOW = '2026-10-05T08:00:00.000Z';
const PURCHASE_AT = '2026-06-15T12:00:00.000Z';
const dims = {
  entity: 'synthetic-entity-a', seller: 'synthetic-seller-a',
  channel: 'synthetic-retail-channel', brand: 'synthetic-brand-a',
  model_revision: 'synthetic-model-r1',
};
const purchase = () => ({
  ...dims, purchase_at: PURCHASE_AT,
  original_promise: 'synthetic-promise-v1',
});
const pack = (overrides = {}) => ({
  status: 'approved', pack_id: 'synthetic-pack-a', terms_version: 'synthetic-terms-v1',
  approval_receipt: 'synthetic-approval-receipt', source_version: 'synthetic-source-v1',
  source_receipt: 'synthetic-source-receipt', native_receipt: 'synthetic-native-receipt',
  effective_at: '2026-01-01T00:00:00.000Z', expires_at: '2027-01-01T00:00:00.000Z',
  scope: { ...dims },
  purchase_valid_from: '2026-01-01T00:00:00.000Z',
  purchase_valid_until: '2027-01-01T00:00:00.000Z',
  original_promises: ['synthetic-promise-v1'], current_source_version: 'synthetic-source-v1',
  approved_claims: ['synthetic-approved-claim'], approved_content_ids: ['synthetic-content-a'],
  ...overrides,
});
const select = (p = purchase(), packs = [pack()], now = NOW) => selectEntitlement(p, packs, now);
const expectHold = (result) => {
  assert.equal(result.status, 'hold', `expected hold, got ${JSON.stringify(result)}`);
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0, 'hold must explain its reason');
};

test('selects one approved historical terms pack and preserves the purchase promise', () => {
  const p = purchase();
  const before = structuredClone(p);
  const packs = [pack()];
  const packsBefore = structuredClone(packs);
  const result = selectEntitlement(p, packs, NOW);
  assert.equal(result.status, 'eligible');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.selection, {
    pack_id: 'synthetic-pack-a', terms_version: 'synthetic-terms-v1',
    original_promise: 'synthetic-promise-v1',
  });
  assert.deepEqual(p, before, 'selector must not mutate purchase input');
  assert.deepEqual(packs, packsBefore, 'selector must not mutate pack inputs');
});

test('holds if any immutable purchase dimension or purchase date/promise is missing', () => {
  for (const key of [...Object.keys(dims), 'purchase_at', 'original_promise']) {
    const p = purchase();
    delete p[key];
    expectHold(select(p));
  }
  for (const value of ['', null, 'UNKNOWN', false, {}]) {
    const p = purchase(); p.seller = value;
    expectHold(select(p));
  }
  expectHold(select(purchase(), [pack()], 'not-a-date'));
  expectHold(select(purchase(), [pack()], '2026-01-01T00:00:00.000Z'));
  const futurePurchase = purchase(); futurePurchase.purchase_at = '2026-10-05T08:00:00.001Z';
  expectHold(select(futurePurchase));
});

test('holds for any entity, seller, channel, brand, or model revision mismatch', () => {
  for (const key of Object.keys(dims)) {
    const wrongPack = pack({ scope: { ...dims, [key]: `other-${key}` } });
    expectHold(select(purchase(), [wrongPack]));
    const wrongPurchase = purchase(); wrongPurchase[key] = `other-${key}`;
    expectHold(select(wrongPurchase, [pack()]));
  }
});

test('purchase terms use inclusive start and exclusive end boundaries', () => {
  const p = purchase();
  assert.equal(select(p, [pack({ purchase_valid_from: PURCHASE_AT })]).status, 'eligible');
  assert.equal(select(p, [pack({ purchase_valid_until: PURCHASE_AT })]).status, 'hold');
  assert.equal(select(p, [pack({ purchase_valid_from: '2026-06-15T12:00:00.001Z' })]).status, 'hold');
});

test('knowledge pack uses inclusive effective time and exclusive expiry boundaries', () => {
  assert.equal(select(purchase(), [pack({ effective_at: NOW })], NOW).status, 'eligible');
  assert.equal(select(purchase(), [pack({ expires_at: NOW })], NOW).status, 'hold');
  assert.equal(select(purchase(), [pack({ effective_at: '2026-10-05T08:00:00.001Z' })], NOW).status, 'hold');
});

test('holds for invalid/future dates, unapproved terms, absent receipts, and stale source knowledge', () => {
  const invalidCases = [
    { effective_at: 'not-a-date' }, { expires_at: 'not-a-date' },
    { purchase_valid_from: 'not-a-date' }, { purchase_valid_until: 'not-a-date' },
    { effective_at: '2027-01-01T00:00:00.000Z' },
    { status: 'draft' }, { approval_receipt: 'UNKNOWN' }, { source_receipt: false },
    { native_receipt: {} }, { source_version: 'synthetic-source-v2' },
    { current_source_version: 'synthetic-source-v2' },
    { original_promises: ['a different promise'] },
  ];
  for (const change of invalidCases) expectHold(select(purchase(), [pack(change)]));
  for (const key of ['approval_receipt', 'source_receipt', 'native_receipt']) {
    for (const falseEvidence of [undefined, null, '', 'UNKNOWN', false, {}, { accepted: true }]) {
      const candidate = pack();
      candidate[key] = falseEvidence;
      expectHold(select(purchase(), [candidate]));
    }
  }
});

test('holds when no matching pack or multiple applicable terms packs remain', () => {
  expectHold(select(purchase(), []));
  expectHold(select(purchase(), [pack(), pack({ pack_id: 'synthetic-pack-b', terms_version: 'synthetic-terms-v2' })]));
});

const followUp = () => ({
  purpose: 'aftercare',
  recipient_id: 'synthetic-recipient',
  consent: {
    status: 'granted', scope: 'aftercare', recipient_id: 'synthetic-recipient',
    channel: 'synthetic-email-channel', receipt: 'synthetic-consent-receipt',
    effective_at: '2026-01-01T00:00:00.000Z', expires_at: '2027-01-01T00:00:00.000Z', revoked: false,
  },
  contact_channel: 'synthetic-email-channel',
  model_revision: dims.model_revision, pack_id: 'synthetic-pack-a',
  terms_version: 'synthetic-terms-v1', source_version: 'synthetic-source-v1',
  native_case_link: 'synthetic://case/17',
  owner: { actor_id: 'synthetic-owner', accepted: true, available: true, coverage_receipt: 'synthetic-owner-coverage' },
  backup: { actor_id: 'synthetic-backup', accepted: true, available: true, coverage_receipt: 'synthetic-backup-coverage' },
  due_at: '2026-10-06T08:00:00.000Z',
  setup_unresolved: false, warning_unresolved: false, human_request_unresolved: false,
  status: 'open',
});
const context = (p = purchase(), pk = pack(), currentSource = 'synthetic-source-v1') => ({
  purchase: p,
  packs: [pk],
  selected: { pack_id: pk.pack_id, terms_version: pk.terms_version, original_promise: p.original_promise },
  pack: pk,
  current_source_version: currentSource,
});
const validate = (f = followUp(), c = context(), now = NOW) => validateFollowUp(f, c, now);

test('accepts an open follow-up with explicit consent, accepted coverage, native link, and due time', () => {
  const f = followUp(); const c = context();
  const fBefore = structuredClone(f); const cBefore = structuredClone(c);
  const result = validateFollowUp(f, c, NOW);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(f, fBefore, 'validator must not mutate follow-up input');
  assert.deepEqual(c, cBefore, 'validator must not mutate context input');
});

test('holds for absent, false, or UNKNOWN consent and mismatched model/source/scope', () => {
  const mutations = [
    (f) => { delete f.consent; },
    (f) => { f.consent.status = 'UNKNOWN'; },
    (f) => { f.consent.status = false; },
    (f) => { f.consent.scope = 'UNKNOWN'; },
    (f) => { f.consent.recipient_id = 'other-recipient'; },
    (f) => { f.recipient_id = 'other-recipient'; },
    (f) => { f.consent.channel = 'other-channel'; },
    (f) => { f.contact_channel = 'other-channel'; },
    (f) => { f.consent.receipt = {}; },
    (f) => { f.consent.effective_at = '2026-10-05T08:00:00.001Z'; },
    (f) => { f.consent.expires_at = NOW; },
    (f) => { f.consent.revoked = true; },
    (f) => { f.model_revision = 'other-model'; },
    (f) => { f.source_version = 'other-source'; },
    (f) => { f.terms_version = 'other-terms'; },
    (f) => { f.pack_id = 'other-pack'; },
  ];
  for (const mutate of mutations) { const f = followUp(); mutate(f); expectHold(validate(f)); }
  expectHold(validate(followUp(), context(purchase(), pack(), 'other-source')));
});

test('holds unsupported or unsourced claims and content not present in the approved pack', () => {
  const unsupported = followUp(); unsupported.claim = 'synthetic-unapproved-claim';
  unsupported.claim_source_version = 'synthetic-source-v1';
  expectHold(validate(unsupported));
  const unsourced = followUp(); unsourced.claim = 'synthetic-approved-claim';
  unsourced.claim_source_version = 'stale-source';
  expectHold(validate(unsourced));
  const supported = followUp(); supported.claim = 'synthetic-approved-claim';
  supported.claim_source_version = 'synthetic-source-v1';
  assert.equal(validate(supported).status, 'ready');
  const wrongContent = followUp(); wrongContent.content_id = 'synthetic-unapproved-content';
  expectHold(validate(wrongContent));
  const approvedContent = followUp(); approvedContent.content_id = 'synthetic-content-a';
  assert.equal(validate(approvedContent).status, 'ready');
});

test('holds without a native case link, valid due date, accepted owner, backup, and current coverage', () => {
  const mutations = [
    (f) => { f.native_case_link = 'UNKNOWN'; }, (f) => { f.native_case_link = false; },
    (f) => { f.due_at = 'not-a-date'; },
    (f) => { f.owner.accepted = false; }, (f) => { f.owner.available = false; },
    (f) => { f.owner.coverage_receipt = {}; },
    (f) => { f.backup.accepted = false; }, (f) => { f.backup.available = false; },
    (f) => { f.backup.coverage_receipt = 'UNKNOWN'; },
  ];
  for (const mutate of mutations) { const f = followUp(); mutate(f); expectHold(validate(f)); }
  const sameActor = followUp(); sameActor.backup.actor_id = sameActor.owner.actor_id;
  expectHold(validate(sameActor));
  const overdue = followUp(); overdue.due_at = '2026-10-04T00:00:00Z';
  assert.equal(validate(overdue).status, 'ready', 'overdue owned work remains actionable');
  assert.equal(overdue.due_at, '2026-10-04T00:00:00Z', 'validation preserves original due time');
});

test('human requests, unresolved setup, or warnings require a staffed native human path', () => {
  for (const flag of ['human_request_unresolved', 'setup_unresolved', 'warning_unresolved']) {
    const f = followUp(); f[flag] = true;
    expectHold(validate(f));
    f.human_path = {
      native_link: 'synthetic://case/17/human',
      owner: { actor_id: 'synthetic-human-owner', accepted: true, available: true, coverage_receipt: 'synthetic-human-coverage' },
    };
    assert.equal(validate(f).status, 'ready', `${flag} should pass only with staffed human path`);
    f.human_path.owner.available = false;
    expectHold(validate(f));
  }
});

test('board-only closure is rejected; closed cases require native terminal and recipient receipts', () => {
  const f = followUp(); f.status = 'closed'; f.board_only_closure = true;
  f.closure = { native_terminal_receipt: 'synthetic-native-terminal', recipient_receipt: 'synthetic-recipient' };
  expectHold(validate(f));
  f.board_only_closure = false;
  assert.equal(validate(f).status, 'ready');
  f.closure.native_terminal_receipt = 'UNKNOWN';
  f.closure.recipient_receipt = false;
  expectHold(validate(f));
  f.closure = { native_terminal_receipt: 'synthetic-native-terminal', recipient_receipt: 'synthetic-recipient' };
  assert.equal(validate(f).status, 'ready');
  f.warning_unresolved = true;
  expectHold(validate(f));
});

test('opaque UNKNOWN/false objects do not satisfy human-path or closure evidence', () => {
  const f = followUp(); f.warning_unresolved = true;
  f.human_path = { native_link: {}, owner: { actor_id: {}, accepted: true, available: true, coverage_receipt: { accepted: true } } };
  expectHold(validate(f));
  f.warning_unresolved = false; f.status = 'closed';
  f.closure = { native_terminal_receipt: { status: 'accepted' }, recipient_receipt: 'UNKNOWN' };
  expectHold(validate(f));
});

test('follow-up cannot forge a selected pack or bypass current source revalidation', () => {
  const forged = context(); forged.selected.pack_id = 'synthetic-forged-pack';
  expectHold(validate(followUp(), forged));
  const stalePack = pack({ source_version: 'synthetic-old-source', current_source_version: 'synthetic-old-source' });
  expectHold(validate(followUp(), context(purchase(), stalePack, 'synthetic-source-v1')));
  const contextWithoutNativeSource = context(); contextWithoutNativeSource.current_source_version = 'UNKNOWN';
  expectHold(validate(followUp(), contextWithoutNativeSource));
});

// Added after the two allotted worker test attempts for root's final review.
// Root will include these in its combined verification; this worker did not run them.
test('follow-up rejects a same-id context pack clone with altered scope or claim allowlist', () => {
  const alteredScope = context();
  alteredScope.pack = structuredClone(alteredScope.pack);
  alteredScope.pack.scope.brand = 'synthetic-other-brand';
  expectHold(validate(followUp(), alteredScope));

  const alteredAllowlist = context();
  alteredAllowlist.pack = structuredClone(alteredAllowlist.pack);
  alteredAllowlist.pack.approved_claims = ['synthetic-unapproved-claim'];
  const claim = followUp(); claim.claim = 'synthetic-unapproved-claim';
  claim.claim_source_version = 'synthetic-source-v1';
  expectHold(validate(claim, alteredAllowlist));
});

test('nonboolean unresolved flags and simultaneous singular/plural claims fail closed', () => {
  const unknownFlag = followUp(); unknownFlag.warning_unresolved = 'UNKNOWN';
  expectHold(validate(unknownFlag));
  const conflictingClaims = followUp();
  conflictingClaims.claim = 'synthetic-approved-claim';
  conflictingClaims.claims = ['synthetic-approved-claim'];
  conflictingClaims.claim_source_version = 'synthetic-source-v1';
  expectHold(validate(conflictingClaims));
});
