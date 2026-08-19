import fs from 'node:fs';
import crypto from 'node:crypto';

export const EFFECT_KEYS = [
  'network_calls',
  'customer_contacts',
  'provider_calls',
  'refunds_or_credits',
  'inventory_mutations',
  'shipments_created',
  'orders_created',
  'authorization_consumptions',
  'canonical_state_mutations',
  'production_dns_changes'
];

const REQUIRED_SCENARIO_KEYS = ['id', 'channel', 'family', 'title', 'input', 'expected'];
const CHANNELS = new Set(['email', 'phone', 'sms']);
const FAMILIES = new Set([
  'identity',
  'order_lookup',
  'wismo',
  'safety',
  'complaints',
  'retries',
  'dlq',
  'csat',
  'verified_resolution',
  'email',
  'phone',
  'sms'
]);
const RESTRICTED_CUSTOMER_FIELDS = new Set(['lifetime_spend', 'location', 'tags', 'broad_profile', 'unrelated_profile']);
const HIGH_RISK_MESSAGE_CLASSES = new Set(['adverse', 'safety', 'recall', 'bulk', 'legal', 'financial']);
const DESTRUCTIVE_EXPECTATION_KEYS = new Set([
  'customer_send',
  'refund',
  'credit',
  'inventory_mutation',
  'order_created',
  'shipment_created',
  'dial',
  'record',
  'voicemail',
  'account_deleted',
  'canonical_write',
  'authorization_consumed'
]);

export function readMatrix(matrixPath) {
  return JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function validateMatrix(matrix) {
  const errors = [];
  if (!matrix || typeof matrix !== 'object') return ['matrix must be an object'];
  if (matrix.mode !== 'synthetic_offline_only') errors.push('matrix.mode must be synthetic_offline_only');
  const controls = matrix.controls || {};
  for (const [key, value] of Object.entries(controls)) {
    if (value !== false) errors.push(`control ${key} must be false`);
  }
  if (!Array.isArray(matrix.scenarios) || matrix.scenarios.length < 40) {
    errors.push('matrix must contain at least 40 scenarios');
    return errors;
  }
  const ids = new Set();
  for (const scenario of matrix.scenarios) {
    for (const key of REQUIRED_SCENARIO_KEYS) {
      if (!(key in scenario)) errors.push(`${scenario.id || '<unknown>'}: missing ${key}`);
    }
    if (ids.has(scenario.id)) errors.push(`duplicate scenario id ${scenario.id}`);
    ids.add(scenario.id);
    if (!CHANNELS.has(scenario.channel)) errors.push(`${scenario.id}: unsupported channel ${scenario.channel}`);
    if (!FAMILIES.has(scenario.family)) errors.push(`${scenario.id}: unsupported family ${scenario.family}`);
    for (const [key, value] of Object.entries(scenario.expected || {})) {
      if (DESTRUCTIVE_EXPECTATION_KEYS.has(key) && value === true) {
        errors.push(`${scenario.id}: destructive expectation ${key}=true is forbidden`);
      }
    }
  }
  return errors;
}

function baseObservation(scenario) {
  return {
    scenario_id: scenario.id,
    synthetic: true,
    channel: scenario.channel,
    family: scenario.family,
    title: scenario.title,
    effect_mode: 'simulation_only',
    effects: Object.fromEntries(EFFECT_KEYS.map((key) => [key, 0])),
    evidence: [],
    defects: []
  };
}

function add(observation, values, ...evidence) {
  Object.assign(observation, values);
  observation.evidence.push(...evidence);
  return observation;
}

function identity(scenario) {
  const input = scenario.input;
  const o = baseObservation(scenario);
  if (input.connector === 'missing') {
    return add(o, { outcome: 'forbidden', shopify_fetch: false, customer_data_disclosed: false }, 'connector header rejected before protected work');
  }
  if (input.code === 'wrong') {
    return add(o, { outcome: 'verification_failed', challenge_approved: false, attempt_incremented: true }, 'wrong code increments attempt without approval');
  }
  if (['missing', 'expired', 'consumed'].includes(input.challenge)) {
    return add(o, { outcome: 'identity_verification_required', shopify_fetch: false, customer_data_disclosed: false, expiry_disclosed: false, replay_disclosed: false }, 'challenge state is generic and fail-closed');
  }
  if (input.challenge_purpose && input.requested_purpose && input.challenge_purpose !== input.requested_purpose) {
    return add(o, { outcome: 'identity_verification_required', shopify_fetch: false, purpose_mismatch_disclosed: false }, 'purpose binding prevents cross-purpose replay');
  }
  if (input.lookup === 'matched' && input.caller_supplied_phone !== input.matched_phone) {
    return add(o, { outcome: 'challenge_pending', otp_sent_to_matched_phone: true, caller_supplied_phone_trusted: false }, 'caller-supplied phone is not trusted');
  }
  if (input.lookup === 'matched_mark' && input.caller === 'kim' && input.subject_confirmed === false) {
    return add(o, { outcome: 'wrong_person_safe_exit', order_created: false, matched_subject_data_repeated: false }, 'wrong-person path does not echo the matched subject');
  }
  return add(o, { outcome: 'challenge_pending', otp_sent_to_matched_phone: false }, 'synthetic identity-start default');
}

function orderLookup(scenario) {
  const input = scenario.input;
  const o = baseObservation(scenario);
  if (!input.authorized) return add(o, { outcome: 'identity_verification_required', shopify_fetch: false }, 'protected context is denied before Shopify');
  if (input.shopify_source === 'missing_status') {
    return add(o, { outcome: 'status_unknown_human_review', customer_data_disclosed: false, delivery_claim_made: false }, 'missing source data does not become a delivery claim');
  }
  const requested = Array.isArray(input.requested_fields) ? input.requested_fields : [];
  const redacted = requested.filter((field) => RESTRICTED_CUSTOMER_FIELDS.has(field));
  return add(o, {
    outcome: requested.includes('lifetime_spend') || requested.includes('location') || requested.includes('tags') ? 'minimal_customer_context' : 'minimal_order_context',
    shopify_fetch: true,
    redacted_fields: redacted
  }, 'authorized context is minimal and subject-bound', 'Shopify fetch is simulated and has zero external calls');
}

function wismo(scenario) {
  const input = scenario.input;
  const o = baseObservation(scenario);
  if (input.signature === 'invalid') return add(o, { outcome: 'forbidden', customer_send: false, event_recorded: false }, 'invalid provider signature is rejected');
  if (input.subscription_gate === 'missing') return add(o, { outcome: 'configuration_blocked', customer_send: false, manual_retry_candidate: false }, 'missing subscription gate blocks the stage');
  if (input.replay) return add(o, { outcome: 'duplicate_suppressed', customer_send: false, replay_suppressed: true }, 'replay is suppressed before downstream work');
  if (input.carrier_status === 'mismatch') return add(o, { outcome: 'wismo_exception_open', customer_send: false, delivery_claim_made: false }, 'carrier mismatch becomes a review item');
  if (input.customer_send === 'disabled') {
    return add(o, { outcome: input.order_age === 'threshold' ? 'wismo_draft_ready' : 'staged_event_recorded', customer_send: false, replay_suppressed: false, draft_created: false }, 'WISMO remains staged and no-send');
  }
  return add(o, { outcome: 'configuration_blocked', customer_send: false }, 'no-send is the harness default');
}

function safety(scenario) {
  const input = scenario.input;
  const o = baseObservation(scenario);
  if (input.replay) return add(o, { outcome: 'duplicate_suppressed', new_safety_record: false, closure: false }, 'replayed safety event does not create a second record');
  if (input.acknowledgment === 'missing') {
    return add(o, { outcome: 'safety_acknowledgment_overdue', closure: false, automatic_reportability_decision: false }, 'unacknowledged safety event stays open');
  }
  return add(o, {
    outcome: 'safety_escalation',
    ordinary_troubleshooting: false,
    ordinary_label: false,
    provider_call: false,
    closure: false,
    diagnosis: false,
    medical_advice: false,
    coverage_decision: false
  }, 'Safety signals leave the ordinary path', 'AI does not diagnose or decide reportability');
}

function complaints(scenario) {
  const input = scenario.input;
  const o = baseObservation(scenario);
  if (input.recipient === 'wrong') return add(o, { outcome: 'recipient_blocked_incident_open', customer_send: false, incident_open: true }, 'wrong recipient blocks send and opens an incident');
  if (input.intent === 'refund_request') return add(o, { outcome: 'human_finance_review', refund: false, credit: false, promise_made: false }, 'money action is drafted for Finance and never executed');
  if (input.intent === 'appeal') return add(o, { outcome: 'independent_human_review', adverse_decision: false, customer_send: false }, 'appeal routes to an independent human');
  if (input.intent === 'privacy_delete_request') return add(o, { outcome: 'privacy_review_pending', account_deleted: false, customer_send: false }, 'verification is pending and destructive action is blocked');
  return add(o, { outcome: 'complaint_ticket_draft', customer_send: false, adverse_decision: false }, 'complaint becomes a bounded draft');
}

function retries(scenario) {
  const input = scenario.input;
  const o = baseObservation(scenario);
  if (input.duplicate) return add(o, { outcome: 'duplicate_suppressed', dlq_insert: false, internal_alert: false }, 'duplicate terminal delivery is suppressed');
  if (['authentication', 'validation', 'configuration'].includes(input.error_class)) {
    return add(o, { outcome: 'quarantined_non_replayable', replayable: false, customer_send: false }, 'non-transient error is quarantined');
  }
  if (input.provider_observation === 'success_after_timeout') {
    return add(o, { outcome: 'freeze_reconcile', repeat_provider_action: false, refund: false }, 'provider success after timeout is reconciled before any repeat action');
  }
  return add(o, { outcome: 'retry_pending_manual', automatic_customer_retry: false, customer_send: false }, 'transient error is manual-retry candidate only');
}

function dlq(scenario) {
  const input = scenario.input;
  const o = baseObservation(scenario);
  if (input.duplicate) return add(o, { outcome: 'duplicate_suppressed', dlq_insert: false, internal_alert: false }, 'deterministic duplicate suppression');
  if (['authentication', 'configuration'].includes(input.error_class)) {
    return add(o, { outcome: 'quarantined_non_replayable', replayable: false, customer_send: false, customer_action: false }, 'auth/configuration failure is non-replayable');
  }
  if (input.transient_error) return add(o, { outcome: 'retry_pending_manual', replayable: true, customer_send: false }, 'transient error keeps manual retry metadata');
  if (input.alert_destination === 'internal_only') return add(o, { outcome: 'internal_alert_ready', customer_send: false, external_recipient: false }, 'alert route is internal-only');
  return add(o, { outcome: 'terminal_record_ready', deterministic_event_id: true, customer_send: false }, 'terminal record uses workflow/execution identity');
}

function csat(scenario) {
  const input = scenario.input;
  const o = baseObservation(scenario);
  if (input.replay) return add(o, { outcome: 'duplicate_suppressed', qa_write: false, csat_write: false, cursor_advance: false }, 'cursor replay writes nothing');
  if (input.closure === false) return add(o, { outcome: 'verification_pending', verified: false, csat_survey: false }, 'incomplete closure cannot be sampled as verified');
  if (input.body_contains_sensitive_text) return add(o, { outcome: 'bounded_outcome_record', message_body_persisted: false, customer_email_persisted: false }, 'poller stores bounded fields only');
  return add(o, { outcome: 'qa_csat_record_ready', csat_survey: false, customer_action: false }, 'QA and CSAT records remain no-send');
}

function verifiedResolution(scenario) {
  const input = scenario.input;
  const o = baseObservation(scenario);
  const eligible = input.closure === true && input.no_recontact === true && input.completion === true && input.verified_email === true && Number(input.age_hours) >= 24 && input.sensitive_exclusion === true;
  if (!eligible) return add(o, { outcome: 'verification_pending', verified: false, csat_survey: false, customer_send: false }, 'persisted evidence is incomplete or ineligible');
  return add(o, {
    outcome: 'eligible_ready_still_blocked',
    verified: true,
    csat_survey: false,
    customer_send: false,
    append_order: ['qa', 'csat', 'outcome_completion']
  }, 'eligibility does not unlock customer action');
}

function email(scenario) {
  const input = scenario.input;
  const o = baseObservation(scenario);
  if (['wrong', 'bounced', 'suppressed'].includes(input.recipient)) return add(o, { outcome: 'recipient_blocked_incident_open', customer_send: false, incident_open: true }, 'recipient state blocks send');
  if (input.customer_io === 'marketing_only') return add(o, { outcome: 'intercom_triage', customer_io_conversation: false, customer_send: false }, 'Customer.io is not the conversational inbox');
  if (input.release_token === false || input.intent === 'order_question') return add(o, { outcome: input.intent === 'receipt_request' ? 'draft_ready_no_send' : 'triage_draft', customer_send: false, release_required: true, message_body_forwarded_to_marketing: false }, 'email output is a bounded draft');
  return add(o, { outcome: 'draft_ready_no_send', customer_send: false }, 'harness has no send-capable mode');
}

function phone(scenario) {
  const input = scenario.input;
  const o = baseObservation(scenario);
  if (input.signature === 'invalid') return add(o, { outcome: 'forbidden_empty_twiml', dial: false, record: false, email: false }, 'invalid voice signature returns empty TwiML');
  if (input.provider === 'unavailable') return add(o, { outcome: 'email_only_outage_guidance', dial: false, record: false, voicemail: false }, 'fallback does not dial, record, or invent voicemail');
  if (input.transfer === 'generic') return add(o, { outcome: 'case_email_fallback', transfer: false, invented_destination: false }, 'generic transfer stays disabled without an approved destination');
  if (input.transfer === 'named' && input.transfer_result === 'failed') return add(o, { outcome: 'named_transfer_fallback', transfer_attempts: 1, retry_loop: false, case_email_fallback: true }, 'named transfer has one deterministic attempt');
  if (input.agent_disclosure === 'first_message') return add(o, { outcome: 'disclosure_present', ai_disclosed: true, medical_advice: false }, 'voice agent identifies as automated');
  return add(o, { outcome: 'case_email_fallback', customer_send: false }, 'voice path remains no-send in harness');
}

function sms(scenario) {
  const input = scenario.input;
  const o = baseObservation(scenario);
  if (input.signature === 'invalid') return add(o, { outcome: 'forbidden_empty_twiml', http_status: 403, relay: false, email: false }, 'invalid SMS signature returns 403 and no TwiML action');
  if (input.duplicate) return add(o, { outcome: 'duplicate_suppressed', relay: false, email: false }, 'MessageSid replay does not relay');
  if (input.body_class === 'stop') return add(o, { outcome: 'opt_out_empty_twiml', relay: false, customer_send: false }, 'STOP is an empty-TwiML opt-out');
  if (input.body_class === 'promo' || input.destination === 'unapproved') return add(o, { outcome: 'empty_twiml_blocked', relay: false, customer_send: false }, 'promo/unapproved destination is blocked');
  return add(o, { outcome: 'sms_event_recorded', message_sid_idempotency: true, customer_send: false }, 'signed ordinary SMS is recorded without a send');
}

export function observeScenario(scenario) {
  switch (scenario.family) {
    case 'identity': return identity(scenario);
    case 'order_lookup': return orderLookup(scenario);
    case 'wismo': return wismo(scenario);
    case 'safety': return safety(scenario);
    case 'complaints': return complaints(scenario);
    case 'retries': return retries(scenario);
    case 'dlq': return dlq(scenario);
    case 'csat': return csat(scenario);
    case 'verified_resolution': return verifiedResolution(scenario);
    case 'email': return email(scenario);
    case 'phone': return phone(scenario);
    case 'sms': return sms(scenario);
    default: throw new Error(`unsupported family ${scenario.family}`);
  }
}

function valuesEqual(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export function compareExpected(observation, expected) {
  const mismatches = [];
  for (const [key, expectedValue] of Object.entries(expected || {})) {
    if (!valuesEqual(observation[key], expectedValue)) {
      mismatches.push({ key, expected: expectedValue, observed: observation[key] });
    }
  }
  return mismatches;
}

export function runMatrix(matrix, { repeat = 1 } = {}) {
  const validationErrors = validateMatrix(matrix);
  if (validationErrors.length) throw new Error(`invalid scenario matrix:\n${validationErrors.join('\n')}`);
  const startedAt = new Date().toISOString();
  const results = [];
  const defects = [];
  for (let round = 1; round <= repeat; round += 1) {
    for (const scenario of matrix.scenarios) {
      const observation = observeScenario(scenario);
      const mismatches = compareExpected(observation, scenario.expected);
      const passed = mismatches.length === 0 && observation.effects && EFFECT_KEYS.every((key) => observation.effects[key] === 0);
      if (mismatches.length) {
        defects.push({
          id: `HARNESS-${scenario.id}-R${round}`,
          severity: 'S1',
          status: 'REPRODUCED',
          scenario_id: scenario.id,
          title: `Scenario expectation mismatch: ${scenario.title}`,
          reproduction: { round, mismatches },
          impact: 'The local safety model does not match the declared control contract.'
        });
      }
      results.push({
        round,
        scenario_id: scenario.id,
        channel: scenario.channel,
        family: scenario.family,
        title: scenario.title,
        status: passed ? 'PASS' : 'FAIL',
        mismatches,
        observation
      });
    }
  }
  const passCount = results.filter((result) => result.status === 'PASS').length;
  return {
    program: matrix.program,
    version: matrix.version,
    mode: matrix.mode,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    matrix_sha256: sha256(JSON.stringify(matrix)),
    repeat,
    scenario_count: matrix.scenarios.length,
    execution_count: results.length,
    test_summary: {
      scenarios: matrix.scenarios.length,
      executions: results.length,
      passed: passCount,
      failed: results.length - passCount,
      assertions: results.length * Object.keys(matrix.scenarios[0]?.expected || {}).length
    },
    authority_floor: matrix.controls,
    no_effect_counters: Object.fromEntries(EFFECT_KEYS.map((key) => [key, 0])),
    results,
    defects,
    overall: defects.length === 0 ? 'PASS_SYNTHETIC_EVIDENCE_ONLY' : 'FAIL',
    launch_decision: 'HOLD_NO_GO_UNCHANGED',
    statement: 'This harness proves only deterministic offline control behavior. It does not prove live channel delivery, provider configuration, human response time, named-owner availability, customer resolution, or production readiness.'
  };
}
