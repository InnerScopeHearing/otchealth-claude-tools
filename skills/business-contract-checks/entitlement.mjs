const known = (value) => typeof value === 'string' && value.trim() !== '' && value.trim().toUpperCase() !== 'UNKNOWN';

function timestamp(value) {
  if (!known(value)) return null;
  const normalized = value.trim();
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  const dateTimeMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(normalized);
  if (!dateMatch && !dateTimeMatch) return null;
  const match = dateMatch || dateTimeMatch;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(0);
  calendarDate.setUTCFullYear(year, month - 1, day);
  calendarDate.setUTCHours(0, 0, 0, 0);
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day) return null;
  if (dateTimeMatch) {
    const hour = Number(dateTimeMatch[4]);
    const minute = Number(dateTimeMatch[5]);
    const second = Number(dateTimeMatch[6]);
    const offsetHour = dateTimeMatch[8] === undefined ? 0 : Number(dateTimeMatch[8]);
    const offsetMinute = dateTimeMatch[9] === undefined ? 0 : Number(dateTimeMatch[9]);
    if (hour > 23 || minute > 59 || second > 59 || offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return null;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function nowTimestamp(now) {
  if (now === undefined) return Date.now();
  if (typeof now === 'number') return Number.isFinite(now) ? now : null;
  return timestamp(now);
}

const purchaseDimensions = ['entity', 'seller', 'channel', 'brand', 'model_revision'];

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function packErrors(pack, purchase, currentSourceVersion, nowMs) {
  const errors = [];
  if (!known(pack?.pack_id) || !known(pack?.terms_version) || pack?.status !== 'approved') errors.push('TERMS_NOT_APPROVED_OR_IDENTIFIED');
  for (const key of ['approval_receipt', 'source_version', 'source_receipt', 'native_receipt']) {
    if (!known(pack?.[key])) errors.push(`TERMS_RECEIPT_OR_SOURCE_MISSING:${key}`);
  }
  if (!known(currentSourceVersion) || pack?.source_version !== currentSourceVersion) errors.push('SOURCE_VERSION_NOT_CURRENT');

  const effectiveAt = timestamp(pack?.effective_at);
  const expiresAt = timestamp(pack?.expires_at);
  if (effectiveAt === null || expiresAt === null || effectiveAt > nowMs || expiresAt <= nowMs) errors.push('KNOWLEDGE_PACK_NOT_CURRENT');

  const scope = pack?.scope;
  for (const key of purchaseDimensions) {
    if (!known(scope?.[key])) errors.push(`TERMS_SCOPE_MISSING:${key}`);
    else if (scope[key] !== purchase?.[key]) errors.push(`TERMS_SCOPE_MISMATCH:${key}`);
  }

  const purchasedAt = timestamp(purchase?.purchase_at);
  const validFrom = timestamp(pack?.purchase_valid_from);
  const validUntil = timestamp(pack?.purchase_valid_until);
  if (purchasedAt === null || validFrom === null || validUntil === null) errors.push('PURCHASE_OR_TERMS_DATE_INVALID');
  else if (purchasedAt < validFrom || purchasedAt >= validUntil) errors.push('PURCHASE_OUTSIDE_TERMS_VALIDITY');

  if (!Array.isArray(pack?.original_promises) || !pack.original_promises.includes(purchase?.original_promise)) errors.push('ORIGINAL_PROMISE_NOT_COVERED');
  return errors;
}

/**
 * Selects a matching, currently approved synthetic entitlement pack.
 * Pack approval/receipt values are fixture assertions only, never live evidence.
 */
export function selectEntitlement(purchase, packs, now = Date.now()) {
  const errors = [];
  if (!purchase || typeof purchase !== 'object') errors.push('PURCHASE_MISSING');
  for (const key of [...purchaseDimensions, 'purchase_at', 'original_promise']) {
    if (!known(purchase?.[key])) errors.push(`PURCHASE_FIELD_MISSING:${key}`);
  }
  if (known(purchase?.purchase_at) && timestamp(purchase.purchase_at) === null) errors.push('PURCHASE_DATE_INVALID');
  else if (timestamp(purchase?.purchase_at) !== null && timestamp(purchase.purchase_at) > nowTimestamp(now)) errors.push('PURCHASE_DATE_IN_FUTURE');
  if (nowTimestamp(now) === null) errors.push('VALIDATION_TIME_INVALID');
  if (errors.length) return { status: 'hold', errors, selection: null };
  if (!Array.isArray(packs)) return { status: 'hold', errors: ['TERMS_PACKS_MISSING'], selection: null };

  const nowMs = nowTimestamp(now);
  const valid = [];
  const diagnosed = [];
  for (const pack of packs) {
    const packIssues = packErrors(pack, purchase, pack?.current_source_version, nowMs);
    // The current source version is supplied on each pack only when no context is
    // available; normal callers can set current_source_version on the pack fixture.
    if (packIssues.length === 0) valid.push(pack);
    else diagnosed.push(packIssues);
  }
  if (nowMs === null) return { status: 'hold', errors: ['VALIDATION_TIME_INVALID'], selection: null };
  if (valid.length > 1) return { status: 'hold', errors: ['ENTITLEMENT_AMBIGUOUS'], selection: null };
  if (valid.length === 1) {
    const pack = valid[0];
    return {
      status: 'eligible',
      errors: [],
      selection: { pack_id: pack.pack_id, terms_version: pack.terms_version, original_promise: purchase.original_promise },
    };
  }
  const flattened = [...new Set(diagnosed.flat())];
  if (!flattened.length) flattened.push('NO_MATCHING_ENTITLEMENT');
  return { status: 'hold', errors: flattened, selection: null };
}

function hasAcceptedCoverage(person) {
  return known(person?.actor_id) && person?.accepted === true && person?.available === true && known(person?.coverage_receipt);
}

/** Validates a draft follow-up contract; it never sends or closes a customer case. */
export function validateFollowUp(followUp, context, now = Date.now()) {
  const errors = [];
  const purchase = context?.purchase;
  const selected = context?.selected;
  const pack = context?.pack;
  const nowMs = nowTimestamp(now);
  if (nowMs === null) errors.push('VALIDATION_TIME_INVALID');

  if (!followUp || typeof followUp !== 'object') errors.push('FOLLOW_UP_MISSING');
  if (!purchase || typeof purchase !== 'object') errors.push('PURCHASE_CONTEXT_MISSING');
  if (!selected || !known(selected.pack_id) || !known(selected.terms_version)) errors.push('ENTITLEMENT_SELECTION_MISSING');
  if (!pack || pack.pack_id !== selected?.pack_id || pack.terms_version !== selected?.terms_version) errors.push('SELECTED_PACK_MISMATCH');
  if (selected && selected.original_promise !== purchase?.original_promise) errors.push('ORIGINAL_PROMISE_CHANGED');
  const rechecked = selectEntitlement(purchase, context?.packs, now);
  if (rechecked.status !== 'eligible' || rechecked.selection?.pack_id !== selected?.pack_id ||
      rechecked.selection?.terms_version !== selected?.terms_version ||
      rechecked.selection?.original_promise !== selected?.original_promise) errors.push('ENTITLEMENT_SELECTION_NOT_VALID');
  const packIsInContext = Array.isArray(context?.packs) && context.packs.some((item) => sameValue(item, pack));
  if (!packIsInContext) errors.push('SELECTED_PACK_NOT_IN_CONTEXT');
  if (pack && (pack.status !== 'approved' || !known(pack.approval_receipt) || !known(pack.source_receipt) || !known(pack.native_receipt))) errors.push('TERMS_NOT_APPROVED_OR_RECEIPTED');
  if (pack) {
    const expiresAt = timestamp(pack.expires_at);
    const effectiveAt = timestamp(pack.effective_at);
    if (effectiveAt === null || expiresAt === null || effectiveAt > nowMs || expiresAt <= nowMs) errors.push('KNOWLEDGE_PACK_NOT_CURRENT');
  }

  if (!['onboarding', 'aftercare', 'return'].includes(followUp?.purpose) ||
      followUp?.consent?.status !== 'granted' || followUp?.consent?.scope !== followUp?.purpose ||
      !known(followUp?.recipient_id) || followUp?.consent?.recipient_id !== followUp?.recipient_id ||
      !known(followUp?.contact_channel) || followUp?.consent?.channel !== followUp?.contact_channel ||
      !known(followUp?.consent?.receipt) || followUp?.consent?.revoked === true) {
    errors.push('CONSENT_SCOPE_OR_RECIPIENT_MISSING_OR_MISMATCHED');
  }
  const consentFrom = timestamp(followUp?.consent?.effective_at);
  const consentUntil = timestamp(followUp?.consent?.expires_at);
  if (consentFrom === null || consentUntil === null || consentFrom > nowMs || consentUntil <= nowMs) errors.push('CONSENT_NOT_CURRENT');
  if (followUp?.model_revision !== purchase?.model_revision) errors.push('MODEL_REVISION_MISMATCH');
  if (followUp?.pack_id !== selected?.pack_id || followUp?.terms_version !== selected?.terms_version) errors.push('FOLLOW_UP_SELECTION_MISMATCH');
  if (!known(context?.current_source_version) || followUp?.source_version !== context?.current_source_version || pack?.source_version !== context?.current_source_version) errors.push('FOLLOW_UP_SOURCE_VERSION_MISMATCH');
  if (followUp?.claim !== undefined || followUp?.claims !== undefined) {
    const claims = followUp.claims === undefined ? [followUp.claim] : followUp.claims;
    if (!Array.isArray(claims) || !Array.isArray(pack?.approved_claims) ||
        claims.some((claim) => !known(claim) || !pack.approved_claims.includes(claim)) ||
        !known(followUp.claim_source_version) || followUp.claim_source_version !== context?.current_source_version ||
        (followUp.claim !== undefined && followUp.claims !== undefined)) {
      errors.push('FOLLOW_UP_CLAIM_UNSUPPORTED_OR_UNSOURCED');
    }
  }
  if (followUp?.content_id !== undefined && (!known(followUp.content_id) || !Array.isArray(pack?.approved_content_ids) || !pack.approved_content_ids.includes(followUp.content_id))) {
    errors.push('FOLLOW_UP_CONTENT_UNAPPROVED');
  }

  if (!known(followUp?.native_case_link)) errors.push('NATIVE_CASE_LINK_MISSING');
  if (!hasAcceptedCoverage(followUp?.owner)) errors.push('FOLLOW_UP_OWNER_UNACCEPTED_OR_UNCOVERED');
  if (!hasAcceptedCoverage(followUp?.backup)) errors.push('FOLLOW_UP_BACKUP_UNACCEPTED_OR_UNCOVERED');
  if (known(followUp?.owner?.actor_id) && followUp.owner.actor_id === followUp?.backup?.actor_id) errors.push('FOLLOW_UP_BACKUP_MUST_BE_DISTINCT');
  if (!known(followUp?.due_at) || timestamp(followUp?.due_at) === null) errors.push('FOLLOW_UP_DUE_DATE_INVALID');

  const unresolvedKeys = ['setup_unresolved', 'warning_unresolved', 'human_request_unresolved'];
  for (const key of unresolvedKeys) if (typeof followUp?.[key] !== 'boolean') errors.push(`UNRESOLVED_FLAG_INVALID:${key}`);
  const unresolvedNeedsHuman = unresolvedKeys.some((key) => followUp?.[key] === true);
  if (unresolvedNeedsHuman && (!known(followUp?.human_path?.native_link) || !hasAcceptedCoverage(followUp?.human_path?.owner))) {
    errors.push('HUMAN_PATH_REQUIRED');
  }

  if (!['open', 'closed'].includes(followUp?.status)) errors.push('FOLLOW_UP_STATUS_INVALID');
  if (followUp?.closed === true && followUp?.status !== 'closed') errors.push('FOLLOW_UP_STATUS_MISMATCH');
  const closed = followUp?.status === 'closed';
  if (closed && unresolvedNeedsHuman) errors.push('UNRESOLVED_EXCEPTION_CANNOT_BE_CLOSED');
  if (closed) {
    if (followUp?.board_only_closure === true || !known(followUp?.closure?.native_terminal_receipt) || !known(followUp?.closure?.recipient_receipt)) {
      errors.push('CLOSURE_REQUIRES_NATIVE_TERMINAL_AND_RECIPIENT_RECEIPTS');
    }
  } else if (followUp?.board_only_closure === true) {
    errors.push('BOARD_ONLY_CLOSURE_FORBIDDEN');
  }

  return { status: errors.length ? 'hold' : 'ready', errors: [...new Set(errors)] };
}
