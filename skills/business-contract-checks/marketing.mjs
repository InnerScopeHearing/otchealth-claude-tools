import { opaqueReference, strictTimestamp, metadataErrors } from './metadata-only.mjs';
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasRef = opaqueReference;
const timestamp = strictTimestamp;

/** Validate supplied synthetic metadata only; no policy thresholds or owners are inferred. */
function validateMarketingDraft(draft, context, now) {
  const errors = metadataErrors({ draft, context, now });
  const envelope = { readiness_scope: 'draft_review_only', activation: 'disabled', live_authorization: false };
  if (errors.length) return { status: 'hold', errors, ...envelope };
  const add = (ok, message) => { if (!ok) errors.push(message); };
  const ref = (obj, key, path) => add(isRecord(obj) && hasRef(obj[key]), `${path}.${key} is required`);
  const nowMs = Date.parse(now);
  add(isRecord(draft), 'marketing_draft must be an object');
  add(isRecord(context), 'context must supply current review policy metadata');
  add(timestamp(now) && Number.isFinite(nowMs), 'now must be a strict timestamp');
  if (!isRecord(draft) || !isRecord(context) || !Number.isFinite(nowMs)) return { status: 'hold', errors, ...envelope };

  ref(draft, 'draft_id', 'marketing_draft');
  ref(draft, 'version', 'marketing_draft');
  ref(draft, 'channel', 'marketing_draft');
  add(draft.purpose === 'marketing', 'draft purpose must explicitly be marketing; care workflows are out of scope');
  ref(draft, 'consent_ref', 'marketing_draft');
  add(isRecord(draft.scope), 'marketing_draft.scope is required');
  add(Array.isArray(draft.claims) && draft.claims.length > 0, 'marketing_draft.claims must contain at least one claim reference');

  const consent = draft.consent;
  add(isRecord(consent), 'consent evidence is required');
  if (isRecord(consent)) {
    add(consent.status === 'active', 'consent must be active; absent, revoked, expired, or other states hold');
    add(consent.status !== 'revoked' && consent.status !== 'expired' && consent.status !== 'withdrawn', 'consent is revoked or expired');
    add(consent.channel === draft.channel, 'consent channel must exactly match the draft channel');
    add(isRecord(consent.scope) && isRecord(draft.scope), 'consent and draft scopes are required');
    if (isRecord(consent.scope) && isRecord(draft.scope)) {
      const requiredKeys = Array.isArray(context.scope_keys) ? context.scope_keys : [];
      add(requiredKeys.length > 0 && requiredKeys.every((key) => typeof key === 'string' && key.length > 0), 'context.scope_keys must supply the applicable scope dimensions');
      for (const key of requiredKeys) {
        add(hasRef(draft.scope[key]) && consent.scope[key] === draft.scope[key], `consent scope must exactly match draft scope for ${key}`);
      }
    }
    add(timestamp(consent.effective_at) && Date.parse(consent.effective_at) <= nowMs, 'consent effective_at must be current');
    add(timestamp(consent.expires_at) && nowMs < Date.parse(consent.expires_at), 'consent expires_at must be in the future');
    ref(consent, 'native_receipt', 'consent');
    ref(consent, 'source_version', 'consent');
  }
  add(draft.consent_ref === consent?.native_receipt, 'draft consent_ref must match the native consent receipt');

  const approvedClaims = new Map();
  add(Array.isArray(context.approved_claims), 'context.approved_claims must supply current approved-claim metadata');
  for (const claim of (Array.isArray(context.approved_claims) ? context.approved_claims : [])) {
    if (!isRecord(claim) || !hasRef(claim.claim_id)) { add(false, 'approved claim ID is required'); continue; }
    if (approvedClaims.has(claim.claim_id)) add(false, 'duplicate approved claim ID');
    else approvedClaims.set(claim.claim_id, claim);
  }
  const sources = new Map();
  add(Array.isArray(context.sources), 'context.sources must supply current source-version metadata');
  for (const source of (Array.isArray(context.sources) ? context.sources : [])) {
    if (!isRecord(source) || !hasRef(source.source_id)) { add(false, 'source ID is required'); continue; }
    if (sources.has(source.source_id)) add(false, 'duplicate source ID');
    else sources.set(source.source_id, source);
  }
  const usedClaims = Array.isArray(draft.claims) ? draft.claims : [];
  for (const use of usedClaims) {
    add(isRecord(use) && hasRef(use.claim_id) && hasRef(use.source_id) && hasRef(use.source_version), 'each draft claim must identify claim_id, source_id, and source_version');
    if (!isRecord(use)) continue;
    const claim = approvedClaims.get(use.claim_id);
    add(isRecord(claim) && claim.status === 'approved', `claim ${use.claim_id ?? '(missing)'} lacks current approved status`);
    if (isRecord(claim)) {
      add(claim.source_id === use.source_id && claim.source_version === use.source_version, `claim ${use.claim_id} source provenance must match the approved claim`);
      ref(claim, 'approval_ref', `approved_claims.${use.claim_id}`);
      ref(claim, 'native_receipt', `approved_claims.${use.claim_id}`);
    }
    const source = sources.get(use.source_id);
    add(isRecord(source) && source.current === true, `source ${use.source_id ?? '(missing)'} must be explicitly current`);
    if (isRecord(source)) {
      add(source.version === use.source_version, `source ${use.source_id} version does not match the current source version`);
      ref(source, 'native_receipt', `sources.${use.source_id}`);
      ref(source, 'source_ref', `sources.${use.source_id}`);
    }
  }

  const ack = draft.reviewer_ack;
  const requiredRoles = context.required_reviewer_roles;
  add(Array.isArray(requiredRoles) && requiredRoles.length > 0 && requiredRoles.every(hasRef), 'context.required_reviewer_roles must supply the applicable reviewer roles');
  add(isRecord(ack), 'reviewer acknowledgment is required');
  if (isRecord(ack)) {
    add(ack.acknowledged === true, 'reviewer acknowledgment must be explicit');
    add(Array.isArray(requiredRoles) && requiredRoles.includes(ack.role), 'reviewer role must match a supplied required reviewer role');
    add(ack.draft_version === draft.version, 'reviewer acknowledgment must match the current draft version');
    add(timestamp(ack.acknowledged_at) && Date.parse(ack.acknowledged_at) <= nowMs, 'reviewer acknowledgment timestamp must be current');
    ref(ack, 'reviewer_ref', 'reviewer_ack');
    ref(ack, 'native_receipt', 'reviewer_ack');
    ref(ack, 'outcome_ref', 'reviewer_ack');
  }

  return {
    status: errors.length === 0 ? 'ready' : 'hold',
    errors,
    provenance: {
      consent_native_receipt: consent?.native_receipt ?? null,
      consent_source_version: consent?.source_version ?? null,
      claim_native_receipts: usedClaims.map((use) => approvedClaims.get(use?.claim_id)?.native_receipt ?? null),
      source_native_receipts: usedClaims.map((use) => sources.get(use?.source_id)?.native_receipt ?? null),
      source_refs: usedClaims.map((use) => sources.get(use?.source_id)?.source_ref ?? null),
      reviewer_native_receipt: ack?.native_receipt ?? null,
      reviewer_ref: ack?.reviewer_ref ?? null,
      outcome_ref: ack?.outcome_ref ?? null,
    },
    ...envelope,
  };
}

export { validateMarketingDraft };
