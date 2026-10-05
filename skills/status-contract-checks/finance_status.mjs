/* Pure source-free validation of controller-owned finance status metadata. */
const CURRENT_KEYS = new Set(['kind','tenant_id','entity_id','source_version','current_scope_ref','exporter_concept_ref','controller_acceptance','status_as_of','prepared_by','reviewed_by','native_sources','exceptions']);
const ACCEPTANCE_KEYS = new Set(['accepted','accepted_by','accepted_at','tenant_id','entity_id','source_version','scope_ref']);
const SOURCE_KEYS = new Set(['native_ref','tenant_id','entity_id','source_version','status','owner','accepted_by_controller','observed_at','pagination_complete','settlement_complete','duplicates_absent','missing_span_absent']);
const EXCEPTION_KEYS = new Set(['native_ref','reason','owner','backup','due_at']);
const PLAN_KEYS = new Set(['kind','tenant_id','entity_id','source_version','owner','backup','priority','period_start','period_end','periods','populations','time_cap_days','cost_cap_units','cost_cap_unit','stages','current_close_included','missing_evidence_disposition','inference_allowed','controller_approval','correction_requested','correction_authority']);
const POPULATION_KEYS = new Set(['population_ref','periods','pagination_status','settlement_status','duplicate_status','missing_span_status','evidence_refs']);
const APPROVAL_KEYS = new Set(['approved','approved_by','approved_at','tenant_id','entity_id','source_version','backup','priority','period_start','period_end','periods','populations','stages','time_cap_days','cost_cap_units','cost_cap_unit','missing_evidence_disposition']);
const AUTHORITY_KEYS = new Set(['authority_ref','approved_by','approved_at','tenant_id','entity_id','source_version','period','stage']);
const EXPECTED_KEYS = new Set(['tenantId','entityId','sourceVersion','evaluatedAt','currentScopeRef','exporterConceptRef']);
const DANGEROUS_KEY = /amount|balance|account|bank|payee|transaction|tax|ledger_line|record_body|payload|credential|secret|write|replay|exporter_action|implement_exporter|live_close|close_claim|provider|mutation|correction_body/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,179}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_AGE_MS = 86400000;

function fail(message, errors) { errors.push(message); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function dataValue(value,key) { const descriptor=value&&Object.getOwnPropertyDescriptor(value,key); return descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:undefined; }
function checkKeys(value, allowed, path, errors) {
  if (!object(value)) { fail(`${path}: must be a plain data object`, errors); return false; }
  let safe=true;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') { fail(`${path}: symbol keys are unsupported`, errors); safe=false; continue; }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) { fail(`${path}.${key}: accessor/non-enumerable fields are unsupported`, errors); safe=false; continue; }
    if (DANGEROUS_KEY.test(key)) { fail(`${path}.${key}: restricted or operational field`, errors); safe=false; }
    else if (!allowed.has(key)) { fail(`${path}.${key}: unsupported field`, errors); safe=false; }
  }
  return safe;
}
function checkShape(value, allowed, required, path, errors) {
  if (!checkKeys(value, allowed, path, errors)) return false;
  let safe = true;
  for (const key of required) if (!Object.hasOwn(value, key)) { fail(`${path}.${key}: required own data field`, errors); safe = false; }
  return safe;
}
function denseArray(value, path, errors, min, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max) {
    fail(`${path}: must be a dense bounded array`, errors); return false;
  }
  const keys = Reflect.ownKeys(value);
  let safe=true;
  if (keys.some(key => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)))) { fail(`${path}: symbol or non-index array properties are unsupported`, errors); safe=false; }
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) { fail(`${path}[${i}]: sparse/accessor array entries are unsupported`, errors); safe=false; }
  }
  return safe;
}
function id(value, path, errors) { if (typeof value !== 'string' || !ID.test(value)) fail(`${path}: must be a bounded opaque identifier`, errors); }
function timestamp(value, path, errors) {
  if (typeof value !== 'string' || !ISO_TIME.test(value)) { fail(`${path}: must be a canonical UTC ISO timestamp`, errors); return null; }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) { fail(`${path}: invalid timestamp`, errors); return null; }
  const normalized = new Date(ms).toISOString();
  if (value !== normalized && value !== normalized.replace('.000Z', 'Z')) { fail(`${path}: invalid or normalized timestamp`, errors); return null; }
  return ms;
}
function scope(value, expected, errors) {
  if (!checkShape(expected, EXPECTED_KEYS, ['tenantId','entityId','sourceVersion','evaluatedAt'], 'expected', errors)) return NaN;
  for (const [key, field] of [['tenantId','tenant_id'],['entityId','entity_id'],['sourceVersion','source_version']]) {
    const expectedValue=dataValue(expected,key);
    id(expectedValue, `expected.${key}`, errors);
    if (value[field] !== expectedValue) fail(`${field}: scope mismatch`, errors);
  }
  return timestamp(dataValue(expected,'evaluatedAt'), 'expected.evaluatedAt', errors) ?? NaN;
}
function result(errors) { return { ok: errors.length === 0, errors }; }
function checkBoundScope(value, tenant, entity, version, path, errors) {
  if (value.tenant_id !== tenant || value.entity_id !== entity || value.source_version !== version) fail(`${path}: tenant/entity/source_version mismatch`, errors);
}
function monthIndex(value) {
  if (typeof value !== 'string' || !MONTH.test(value)) return null;
  const [year, month] = value.split('-').map(Number); return year * 12 + month - 1;
}
function monthList(value, start, end, path, errors) {
  if (!denseArray(value, path, errors, 1, 24)) return false;
  const indexes = Array.from(value, monthIndex);
  if (indexes.some(item => item === null) || new Set(value).size !== value.length) { fail(`${path}: invalid or duplicate YYYY-MM values`, errors); return false; }
  const required = Array.from({length:end-start+1}, (_, index) => start+index);
  if (end < start || required.length > 24 || indexes.slice().sort((a,b)=>a-b).some((v,i)=>v!==required[i]) || indexes.length!==required.length) {
    fail(`${path}: must exactly cover the inclusive finite period span`, errors); return false;
  }
  return true;
}
function safeArrayShape(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value)!==Array.prototype) return false;
  const keys=Reflect.ownKeys(value);
  if (keys.some(key=>typeof key!=='string'||(key!=='length'&&!/^(0|[1-9]\d*)$/.test(key)))) return false;
  for(let i=0;i<value.length;i++) { const d=Object.getOwnPropertyDescriptor(value,String(i)); if(!d||!d.enumerable||!Object.hasOwn(d,'value')) return false; }
  return true;
}
function sameArray(a,b) { return safeArrayShape(a) && safeArrayShape(b) && a.length===b.length && a.every((value,index)=>value===b[index]); }
function samePopulations(a,b) {
  return Array.isArray(a) && Array.isArray(b) && a.length===b.length && a.every((p,i) => {
    const q=b[i];
    return object(p) && object(q) && Reflect.ownKeys(q).length===POPULATION_KEYS.size && Reflect.ownKeys(q).every(key=>typeof key==='string'&&POPULATION_KEYS.has(key)&&Object.getOwnPropertyDescriptor(q,key)?.enumerable&&Object.hasOwn(Object.getOwnPropertyDescriptor(q,key),'value')) && p.population_ref===q.population_ref && sameArray(p.periods,q.periods) && p.pagination_status===q.pagination_status && p.settlement_status===q.settlement_status && p.duplicate_status===q.duplicate_status && p.missing_span_status===q.missing_span_status && sameArray(p.evidence_refs,q.evidence_refs);
  });
}
function validatePopulations(populations,start,end,path,errors) {
  if (!denseArray(populations,path,errors,1,100)) return false;
  let safe=true; const seen=new Set();
  for(let i=0;i<populations.length;i++) {
    const p=populations[i], itemPath=`${path}[${i}]`;
    if(!checkShape(p,POPULATION_KEYS,POPULATION_KEYS,itemPath,errors)) { safe=false; continue; }
    id(p.population_ref,`${itemPath}.population_ref`,errors);
    if(seen.has(p.population_ref)) fail(`${itemPath}: duplicate population_ref`,errors); seen.add(p.population_ref);
    if(!monthList(p.periods,start,end,`${itemPath}.periods`,errors)) safe=false;
    for(const [key,allowed] of [['pagination_status',['complete','incomplete','unknown']],['settlement_status',['complete','incomplete','unknown']],['duplicate_status',['clear','present','unknown']],['missing_span_status',['clear','present','unknown']]]) if(!allowed.includes(p[key])) fail(`${itemPath}.${key}: unsupported scope status`,errors);
    if(!denseArray(p.evidence_refs,`${itemPath}.evidence_refs`,errors,1,100)) { safe=false; continue; }
    const refs=new Set(); for(const ref of p.evidence_refs) { id(ref,`${itemPath}.evidence_refs`,errors); if(refs.has(ref)) fail(`${itemPath}.evidence_refs: duplicate reference`,errors); refs.add(ref); }
  }
  return safe;
}

/** Validate status-only current close metadata against a pinned controller scope. */
export function validateCurrentClosePacket(packet, expected) {
  const errors=[];
  if (!checkShape(packet,CURRENT_KEYS,CURRENT_KEYS,'packet',errors)) return result(errors);
  const evaluated=scope(packet,expected,errors);
  if (packet.kind!=='current-close-packet') fail('kind: must be current-close-packet',errors);
  const currentScopeRef=dataValue(expected,'currentScopeRef'), exporterConceptRef=dataValue(expected,'exporterConceptRef');
  id(currentScopeRef,'expected.currentScopeRef',errors); id(exporterConceptRef,'expected.exporterConceptRef',errors);
  if (packet.current_scope_ref!==currentScopeRef) fail('current_scope_ref: expected current scope mismatch',errors);
  if (packet.exporter_concept_ref!==exporterConceptRef) fail('exporter_concept_ref: must match the pinned existing exporter concept',errors);
  id(packet.prepared_by,'prepared_by',errors); id(packet.reviewed_by,'reviewed_by',errors);
  if (packet.prepared_by===packet.reviewed_by) fail('prepared_by and reviewed_by must be distinct',errors);
  const asOf=timestamp(packet.status_as_of,'status_as_of',errors);
  if (Number.isFinite(evaluated) && Number.isFinite(asOf) && (asOf>evaluated || evaluated-asOf>MAX_AGE_MS)) fail('status_as_of: stale or future status',errors);
  const acceptance=packet.controller_acceptance;
  if (checkShape(acceptance,ACCEPTANCE_KEYS,ACCEPTANCE_KEYS,'controller_acceptance',errors)) {
    if (acceptance.accepted!==true) fail('controller_acceptance.accepted: must be true',errors);
    checkBoundScope(acceptance,packet.tenant_id,packet.entity_id,packet.source_version,'controller_acceptance',errors);
    id(acceptance.scope_ref,'controller_acceptance.scope_ref',errors);
    if (acceptance.scope_ref!==expected?.currentScopeRef) fail('controller_acceptance.scope_ref: must bind the exact current scope',errors);
    id(acceptance.accepted_by,'controller_acceptance.accepted_by',errors);
    if ([packet.prepared_by,packet.reviewed_by].includes(acceptance.accepted_by)) fail('controller acceptance must be independent of preparer and reviewer',errors);
    const acceptedAt=timestamp(acceptance.accepted_at,'controller_acceptance.accepted_at',errors);
    if (Number.isFinite(evaluated) && Number.isFinite(acceptedAt) && (acceptedAt>evaluated||evaluated-acceptedAt>MAX_AGE_MS)) fail('controller_acceptance.accepted_at: stale or future acceptance',errors);
  }
  const sourcesOK=denseArray(packet.native_sources,'native_sources',errors,1,100);
  const exceptionsOK=denseArray(packet.exceptions,'exceptions',errors,0,100);
  const exceptions=new Map();
  if (exceptionsOK) for (let i=0;i<packet.exceptions.length;i++) {
    const item=packet.exceptions[i], path=`exceptions[${i}]`;
    if (!checkShape(item,EXCEPTION_KEYS,EXCEPTION_KEYS,path,errors)) continue;
    id(item.native_ref,`${path}.native_ref`,errors);
    if (!['missing','stale','blocked'].includes(item.reason)) fail(`${path}.reason: unsupported exception status`,errors);
    id(item.owner,`${path}.owner`,errors); id(item.backup,`${path}.backup`,errors);
    if (item.owner===item.backup) fail(`${path}: owner and backup must be distinct`,errors);
    const due=timestamp(item.due_at,`${path}.due_at`,errors);
    if (Number.isFinite(evaluated) && Number.isFinite(due) && due<=evaluated) fail(`${path}.due_at: must be after evaluation time`,errors);
    if (exceptions.has(item.native_ref)) fail(`${path}: duplicate exception native_ref`,errors);
    exceptions.set(item.native_ref,item);
  }
  const seen=new Set();
  if (sourcesOK) for (let i=0;i<packet.native_sources.length;i++) {
    const source=packet.native_sources[i], path=`native_sources[${i}]`;
    if (!checkShape(source,SOURCE_KEYS,SOURCE_KEYS,path,errors)) continue;
    id(source.native_ref,`${path}.native_ref`,errors); id(source.owner,`${path}.owner`,errors);
    checkBoundScope(source,packet.tenant_id,packet.entity_id,packet.source_version,path,errors);
    const observed=timestamp(source.observed_at,`${path}.observed_at`,errors);
    if (Number.isFinite(evaluated) && Number.isFinite(observed) && (observed>evaluated || evaluated-observed>MAX_AGE_MS)) fail(`${path}.observed_at: stale or future source status`,errors);
    if (seen.has(source.native_ref)) fail(`${path}: duplicate native_ref`,errors); seen.add(source.native_ref);
    if (!['accepted','missing','stale','blocked'].includes(source.status)) fail(`${path}.status: unsupported status`,errors);
    if (typeof source.accepted_by_controller!=='boolean') fail(`${path}.accepted_by_controller: must be boolean`,errors);
    for (const key of ['pagination_complete','settlement_complete','duplicates_absent','missing_span_absent']) if (typeof source[key]!=='boolean') fail(`${path}.${key}: must be boolean`,errors);
    const complete=['pagination_complete','settlement_complete','duplicates_absent','missing_span_absent'].every(key=>source[key]===true);
    if (source.status==='accepted' && (!complete || source.accepted_by_controller!==true)) fail(`${path}: accepted source lacks controller-accepted completeness`,errors);
    if (source.status!=='accepted' && source.accepted_by_controller===true) fail(`${path}: incomplete source cannot be accepted`,errors);
    const exception=exceptions.get(source.native_ref);
    if (source.status!=='accepted') {
      if (!exception) fail(`${path}: missing controller exception`,errors);
      else if (exception.reason!==source.status) fail(`${path}: exception reason does not match source status`,errors);
    } else if (exception) fail(`${path}: accepted source has an unnecessary exception`,errors);
  }
  for (const ref of exceptions.keys()) if (!seen.has(ref)) fail(`exceptions: orphan native_ref ${ref}`,errors);
  return result(errors);
}

/** Validate a finite, controller/owner-approved historical reconstruction plan. */
export function validateHistoricalReconstructionPlan(plan, expected) {
  const errors=[];
  const planRequired=[...PLAN_KEYS].filter(key=>!['correction_requested','correction_authority'].includes(key));
  if (!checkShape(plan,PLAN_KEYS,planRequired,'plan',errors)) return result(errors);
  scope(plan,expected,errors);
  if (plan.kind!=='historical-reconstruction-plan') fail('kind: must be historical-reconstruction-plan',errors);
  id(plan.owner,'owner',errors); id(plan.backup,'backup',errors);
  if (plan.owner===plan.backup) fail('owner and backup must be distinct',errors);
  id(plan.priority,'priority',errors); // Current policy value is supplied as an opaque token.
  const start=monthIndex(plan.period_start), end=monthIndex(plan.period_end);
  if (start===null || end===null || end<start || end-start+1>24) fail('period_start/period_end: finite span must cover 1..24 months',errors);
  const periodsValid=monthList(plan.periods,start??0,end??-1,'periods',errors);
  validatePopulations(plan.populations,start??0,end??-1,'populations',errors);
  if (!Number.isInteger(plan.time_cap_days)||plan.time_cap_days<1||plan.time_cap_days>365) fail('time_cap_days: integer must be 1..365',errors);
  if (!Number.isInteger(plan.cost_cap_units)||plan.cost_cap_units<1||plan.cost_cap_units>100000) fail('cost_cap_units: integer must be 1..100000',errors);
  if (plan.cost_cap_unit!=='budget_units') fail('cost_cap_unit: must be budget_units, not currency or transaction value',errors);
  const stages=['manifest','extract','explain','correct','close_archive'];
  if (!denseArray(plan.stages,'stages',errors,5,5) || stages.some((stage,i)=>plan.stages[i]!==stage)) fail('stages: must be finite ordered manifest/extract/explain/correct/close_archive',errors);
  if (plan.current_close_included!==false) fail('current_close_included: must be false',errors);
  if (plan.inference_allowed!==false) fail('inference_allowed: must be false',errors);
  if (plan.missing_evidence_disposition!=='stop_and_record_missing_evidence') fail('missing_evidence_disposition: terminal stop disposition required',errors);
  const approval=plan.controller_approval;
  if (checkShape(approval,APPROVAL_KEYS,APPROVAL_KEYS,'controller_approval',errors)) {
    if (approval.approved!==true) fail('controller_approval.approved: must be true',errors);
    checkBoundScope(approval,plan.tenant_id,plan.entity_id,plan.source_version,'controller_approval',errors);
    id(approval.approved_by,'controller_approval.approved_by',errors);
    if (approval.approved_by!==plan.owner) fail('controller_approval.approved_by: must be the plan owner',errors);
    const approved=timestamp(approval.approved_at,'controller_approval.approved_at',errors);
    const evaluated=object(expected)?Date.parse(dataValue(expected,'evaluatedAt')):NaN;
    if (Number.isFinite(evaluated)&&Number.isFinite(approved)&&(approved>evaluated||evaluated-approved>MAX_AGE_MS)) fail('controller_approval.approved_at: stale or future approval',errors);
    const approvalPeriodsOK=monthList(approval.periods,start??0,end??-1,'controller_approval.periods',errors);
    const approvalPopulationsOK=validatePopulations(approval.populations,start??0,end??-1,'controller_approval.populations',errors);
    const approvalStagesOK=denseArray(approval.stages,'controller_approval.stages',errors,5,5);
    if (!approvalStagesOK) fail('controller_approval.stages: invalid stage array',errors);
    else if (stages.some((stage,i)=>approval.stages[i]!==stage)) fail('controller_approval.stages: stage mismatch',errors);
    const exactReceipt=approvalPeriodsOK&&approvalPopulationsOK&&approvalStagesOK&&approval.backup===plan.backup&&approval.priority===plan.priority&&approval.period_start===plan.period_start&&approval.period_end===plan.period_end&&sameArray(approval.periods,plan.periods)&&samePopulations(approval.populations,plan.populations)&&sameArray(approval.stages,plan.stages)&&approval.time_cap_days===plan.time_cap_days&&approval.cost_cap_units===plan.cost_cap_units&&approval.cost_cap_unit===plan.cost_cap_unit&&approval.missing_evidence_disposition===plan.missing_evidence_disposition;
    if (!exactReceipt) fail('controller_approval: receipt must exactly bind owner, backup, priority, span, populations, stages, caps, and terminal disposition',errors);
  }
  const correctionRequested=dataValue(plan,'correction_requested'), correctionAuthority=dataValue(plan,'correction_authority');
  if (correctionRequested===true) {
    const authority=correctionAuthority;
    if (Array.isArray(plan.populations) && plan.populations.some(p=>p.pagination_status!=='complete'||p.settlement_status!=='complete'||p.duplicate_status!=='clear'||p.missing_span_status!=='clear')) fail('correction_requested: all populations must be complete, reconciled, and span-clear before correction',errors);
    if (checkShape(authority,AUTHORITY_KEYS,AUTHORITY_KEYS,'correction_authority',errors)) {
      id(authority.authority_ref,'correction_authority.authority_ref',errors); id(authority.approved_by,'correction_authority.approved_by',errors);
      checkBoundScope(authority,plan.tenant_id,plan.entity_id,plan.source_version,'correction_authority',errors);
      if (authority.approved_by!==plan.owner) fail('correction_authority.approved_by: must be the plan owner/controller',errors);
      if (authority.stage!=='correct') fail('correction_authority.stage: must be exact correct stage',errors);
      const at=timestamp(authority.approved_at,'correction_authority.approved_at',errors), evaluated=object(expected)?Date.parse(dataValue(expected,'evaluatedAt')):NaN;
      if (Number.isFinite(evaluated)&&Number.isFinite(at)&&at>evaluated) fail('correction_authority.approved_at: future authority',errors);
      const ix=monthIndex(authority.period); if(ix===null||start===null||end===null||ix<start||ix>end) fail('correction_authority.period: exact in-scope YYYY-MM period required',errors);
    }
  } else {
    if (correctionRequested!==undefined&&correctionRequested!==false) fail('correction_requested: must be boolean',errors);
    if (correctionAuthority!==undefined) fail('correction_authority: only allowed for requested correction',errors);
  }
  return result(errors);
}
